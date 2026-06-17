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
    const m = line.match(/^\/(?:pick|hide|view|drop|import)\s+(\S*)$/);
    return m ? m[1] : null;
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
