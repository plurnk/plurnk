import { stripVTControlCharacters } from "node:util";

import { renderMarkdownDocument } from "./markdown.ts";

export const RENDER_USAGE = `usage: plurnk render [--width <columns>]

Reads semantic Markdown from stdin and writes one width-bounded plain-Unicode
projection to stdout. This local filter never starts or contacts a daemon.
`;

export const resolveRenderWidth = (
    raw: string | undefined,
    fallback: number = process.stdout.columns ?? 80,
): number => {
    const width = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(width) || width < 1) {
        throw new TypeError("--width must be a positive integer");
    }
    return width;
};

// Public local presentation boundary: semantic Markdown in, width-bounded
// plain Unicode out. It cannot carry terminal state into another client.
export const renderDocument = (source: string, width: number): string =>
    stripVTControlCharacters(renderMarkdownDocument(source, width));
