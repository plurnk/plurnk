import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// {§cli-prompt-open-paths} — @file refs (#260) → forwardedProps.plurnk.openPaths. The daemon
// foists turn-0 READs of these paths; the client sends paths, never bytes. The
// `@` must start a token so an email's `user@host` isn't mistaken for a ref.
// Trailing sentence punctuation is trimmed ("see @a.ts." → "a.ts"); deduped.
// A token opens only when it names an existing file under the project root at
// send time; `@someone` stays prose (#853).
// ENOTDIR (`@file.ts/x`) means absent, exactly like ENOENT.
const isFile = (path: string): boolean => {
    try { return statSync(path, { throwIfNoEntry: false })?.isFile() === true; }
    catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOTDIR") return false;
        throw cause;
    }
};

export const projectRelativePath = (path: string, projectRoot: string): string | null => {
    const inside = relative(projectRoot, resolve(projectRoot, path));
    return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? null : inside;
};

export const extractOpenPaths = (prompt: string, projectRoot: string | null): string[] => {
    if (projectRoot === null) return [];
    const seen = new Set<string>();
    for (const m of prompt.matchAll(/(?:^|\s)@(\S+)/g)) {
        const path = m[1].replace(/[.,;:!?)]+$/, "");
        if (path.length === 0) continue;
        const inside = projectRelativePath(path, projectRoot);
        if (inside === null || !isFile(resolve(projectRoot, inside))) continue;
        seen.add(inside.split(sep).join("/"));
    }
    return [...seen];
};
