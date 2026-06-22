// @file refs (#260) → loop.run.openPaths. The daemon foists turn-0 READs of
// these workspace paths so their content sits in front of the model — daemon-
// foist, NO client-side byte inlining (co-location: the daemon shares the fs).
// The @ref stays in the prompt (the user's natural phrasing "explain @src/a.ts");
// openPaths carries just the path. The `@` must start a token (preceded by
// whitespace or the line start) so an email's `user@host` isn't mistaken for a
// ref. Trailing sentence punctuation is trimmed ("see @a.ts." → "a.ts"); deduped.
export const extractOpenPaths = (prompt: string): string[] => {
    const seen = new Set<string>();
    for (const m of prompt.matchAll(/(?:^|\s)@(\S+)/g)) {
        const path = m[1].replace(/[.,;:!?)]+$/, "");
        if (path.length > 0) seen.add(path);
    }
    return [...seen];
};
