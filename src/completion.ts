// Client-local file-path completion for the readline TUI.
//
// Co-location law: the client and daemon share one filesystem, so "what files
// exist" is the CLIENT's question — completion reads the local fs directly, no
// daemon round-trip. Feeds readline's native completer; no cursor math, no deps.

import { readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// Detect a path-seeking partial in the line up to the cursor; null if the
// cursor isn't in a path position. One case per call site: membership globs,
// definition files, `@file`, and PLURNK targets all remain client-local paths.
export const pathPartial = (line: string): string | null => {
    const verb = line.match(/^\/(?:pick|hide|view|drop|import|script)\s+(\S*)$/);
    if (verb) return verb[1];
    const mcpDefinition = line.match(/^\/mcp\s+replace\s+(\S*)$/);
    if (mcpDefinition) return mcpDefinition[1];
    // @file: a path reference anywhere in a prompt (word-boundary @ to dodge
    // emails). The leading @ stays; only the path part completes.
    const at = line.match(/(?:^|\s)@(\S*)$/);
    if (at) return at[1];
    // DSL target path inside an unclosed `## OP0 (...`: strip a leading scheme://
    // and complete the path part. Bare/file:// resolve against the fs; other
    // schemes (worker://, log://, …) simply find nothing — harmless.
    const target = line.match(DSL_TARGET_PARTIAL);
    if (target) return target[1].replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    return null;
};

// The model-facing H2 operations. PLAN owns H1 and is deliberately separate.
const OPS = ["FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "KILL", "EXEC", "BARE", "WORK", "FORK", "SEND"] as const;

// Client pseudo-op: `## LOOK0 (target)` rewrites to READ on a side run
// for off-conversation inspection ("READ, but for me instead of the model"). The
// daemon never sees "LOOK" — but it completes like a real op so the surface rhymes.
const CLIENT_OPS = ["LOOK"] as const;
const H2_OPS = [...OPS, ...CLIENT_OPS] as const;
const H2_OP_ALTERNATION = H2_OPS.join("|");
const H2_DSL_PREFIX = new RegExp(`^## (?:${H2_OP_ALTERNATION})`);
const DSL_TARGET_PARTIAL = new RegExp(
    `^## (?:${H2_OP_ALTERNATION})[A-Za-z0-9_]*(?: \\[[^\\]\\n]*\\])? \\(([^)\\n]*)$`,
);

// Coarse dispatch classification only. The daemon remains the grammar owner
// and returns exact diagnostics for malformed headings/modifiers/bodies.
export const dslStatement = (text: string): string | null =>
    text.startsWith("# PLAN") || H2_DSL_PREFIX.test(text) ? text : null;

export interface DslOpPartial {
    level: 1 | 2;
    typed: string;
}

// A heading whose operation name is still being typed. The completion surface
// emits the taught lane (`0`); arbitrary suffixes remain the daemon parser's
// tolerance and do not need a completion matrix.
export const dslOpPartial = (line: string): DslOpPartial | null => {
    const h1 = line.match(/^# ([A-Za-z]*)$/);
    if (h1) return { level: 1, typed: h1[1] };
    const h2 = line.match(/^## ([A-Za-z]*)$/);
    return h2 ? { level: 2, typed: h2[1] } : null;
};

// Complete a partially typed heading into the canonical lane-0 form.
export const completeOps = ({ level, typed }: DslOpPartial): [string[], string] => {
    const up = typed.toUpperCase();
    const prefix = level === 1 ? "# " : "## ";
    const operations: readonly string[] = level === 1 ? ["PLAN"] : H2_OPS;
    return [
        operations.filter((operation) => operation.startsWith(up)).map((operation) => `${prefix}${operation}0`),
        `${prefix}${typed}`,
    ];
};

// Complete a filesystem path partial against the local fs. Returns
// [completions, partial] for readline: full-path tokens (directories suffixed
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
