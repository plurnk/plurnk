// Client-local file-path completion for the terminal editor.
//
// Co-location law: the client and daemon share one filesystem, so "what files
// exist" is the CLIENT's question — completion reads the local fs directly, no
// daemon round-trip. Feeds the editor completion provider.

import { readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// Detect a path-seeking partial in the line up to the cursor; null if the
// cursor isn't in a path position. One case per call site: membership globs,
// MCP option files, `@file`, and PLURNK targets all remain client-local paths.
export const pathPartial = (line: string): string | null => {
    const verb = line.match(/^\/(?:import|script)\s+(\S*)$/);
    if (verb) return verb[1];
    const members = line.match(/^\/members\s+(?:discover|add\s+\S+)\s+(\S*)$/);
    if (members) return members[1];
    const mcpOptions = line.match(/^\/mcp\s+add\s+\S+\s+\S+\s+(\S*)$/);
    if (mcpOptions) return mcpOptions[1];
    // @file: a path reference anywhere in a prompt (word-boundary @ to dodge
    // emails). The leading @ stays; only the path part completes.
    const at = line.match(/(?:^|\s)@(\S*)$/);
    if (at) return at[1];
    // DSL target path on an opening fence: strip a leading scheme://
    // and complete the path part. Bare/file:// resolve against the fs; other
    // schemes (worker://, log://, …) simply find nothing — harmless.
    const target = line.match(DSL_TARGET_PARTIAL);
    if (target) return target[1].replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    return null;
};

const OPS = ["PLAN", "FIND", "READ", "EDIT", "COPY", "MOVE", "KILL", "EXEC", "BARE", "WORK", "FORK", "SEND", "NEXT", "WAIT", "DONE", "FAIL", "LOOK"] as const;
const DSL_TARGET_PARTIAL = /^`{3,}[A-Za-z0-9_.+-]+[ \t]*\(([^)\n]*)$/;

// Coarse dispatch classification only. The daemon remains the grammar owner
// and owns name registration and diagnostics for malformed fences/modifiers/bodies.
export const dslStatement = (text: string): string | null =>
    /^`{3,}[A-Za-z0-9_.+-]+/.test(text) ? text : null;

export interface DslOpPartial {
    fence: string;
    typed: string;
}

// Complete native names without guessing the available runtime/tool registry.
export const dslOpPartial = (line: string): DslOpPartial | null => {
    const match = line.match(/^(`{3,})([A-Za-z]*)$/);
    return match ? { fence: match[1], typed: match[2] } : null;
};

export const completeOps = ({ fence, typed }: DslOpPartial): [string[], string] => {
    const up = typed.toUpperCase();
    return [
        OPS.filter((operation) => operation.startsWith(up)).map((operation) => `${fence}${operation}`),
        `${fence}${typed}`,
    ];
};

// Complete a filesystem path partial against the local fs. Returns
// [completions, partial] for the completion adapter: full-path tokens (directories suffixed
// with `/`), and the partial they replace. Unreadable directory → no hits.
// Dotfiles are hidden unless the prefix itself starts with `.` (shell habit).
export const completePath = async (partial: string, cwd: string): Promise<[string[], string]> => {
    const slash = partial.lastIndexOf("/");
    const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : "";
    const prefix = slash >= 0 ? partial.slice(slash + 1) : partial;
    const dirAbs = isAbsolute(dirPart || ".") ? (dirPart || "/") : resolve(cwd, dirPart || ".");
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
        entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
        return [[], partial];
    }
    const hits = entries
        .filter((e) => e.name.startsWith(prefix) && (prefix.startsWith(".") || !e.name.startsWith(".")))
        .map((e) => `${dirPart}${e.name}${e.isDirectory() ? "/" : ""}`)
        .sort();
    return [hits, partial];
};
