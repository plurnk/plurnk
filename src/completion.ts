// Client-local file-path completion for the readline TUI.
//
// Co-location law: the client and daemon share one filesystem, so "what files
// exist" is the CLIENT's question — completion reads the local fs directly, no
// daemon round-trip. Feeds readline's native completer; no cursor math, no deps.

import { readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// Detect a path-seeking partial in the line up to the cursor; null if the
// cursor isn't in a path position. One case per call site — membership-verb
// globs today; `@file` / `/import` / `/md` paths slot in here as they land.
export const pathPartial = (line: string): string | null => {
    const verb = line.match(/^\/(?:pick|hide|view|repo|drop|import|script)\s+(\S*)$/);
    if (verb) return verb[1];
    // @file: a path reference anywhere in a prompt (word-boundary @ to dodge
    // emails). The leading @ stays; only the path part completes.
    const at = line.match(/(?:^|\s)@(\S*)$/);
    if (at) return at[1];
    // DSL target path inside an unclosed `<<OP(...`: strip a leading scheme://
    // and complete the path part. Bare/file:// resolve against the fs; other
    // schemes (known://, log://, …) simply find nothing — harmless.
    const target = line.match(/^<<\w+(?:\[[^\]]*\])?\(([^)]*)$/);
    if (target) return target[1].replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    return null;
};

// The plurnk DSL operations (plurnk-grammar plurnk.md §Operations).
const OPS = ["PLAN", "FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "KILL", "EXEC", "SEND"] as const;

// DSL op-name completion: a raw `<<` line with the op being typed; null
// otherwise. (Target-path completion inside `<<OP(...)` is future work.)
export const dslOpPartial = (line: string): string | null => {
    const m = line.match(/^<<(\w*)$/);
    return m ? m[1] : null;
};

// Complete a partially-typed op into `<<OP` tokens (case-insensitive input).
export const completeOps = (typed: string): [string[], string] => {
    const up = typed.toUpperCase();
    return [OPS.filter((o) => o.startsWith(up)).map((o) => `<<${o}`), `<<${typed}`];
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
