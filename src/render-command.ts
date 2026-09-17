import { stripVTControlCharacters } from "node:util";
import { clientFlagInvalid, ProblemError } from "./diagnostics.ts";

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
        throw new ProblemError(clientFlagInvalid("--width", raw ?? String(fallback), "must be a positive integer"));
    }
    return width;
};

// Public local presentation boundary: semantic Markdown in, width-bounded
// plain Unicode out. It cannot carry terminal state into another client.
export const renderDocument = async (source: string, width: number): Promise<string> => {
    const { renderMarkdownDocument } = await import("./markdown.ts");
    return stripVTControlCharacters(renderMarkdownDocument(source, width));
};
