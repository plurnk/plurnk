// Daemon-free local Markdown & Mermaid projection filter ({§cli-markdown-projection}, {§cli-rendering}, {§cli-color-policy}).
// Dynamically loads the presentation adapter only when `plurnk render` runs so help/version and
// non-rendering subcommands never initialize pi-tui or beautiful-mermaid.

import { stripVTControlCharacters } from "node:util";

export const RENDER_HELP = `usage: plurnk render [--width <columns>] [--mermaid-timeout-ms <n>]

Reads semantic Markdown from stdin and writes one width-bounded plain-Unicode
projection to stdout. Daemon-free; no model work, network, or ANSI styling.

Options:
      --width <columns>         Output width in columns (default: stdout width when available, otherwise 80)
      --mermaid-timeout-ms <n>  Positive Mermaid rendering deadline per diagram in milliseconds
  -h, --help                    Print this help (capability probe)
`;

export const renderMarkdown = async (
    markdown: string,
    width: number,
    mermaidTimeoutMs?: number | string,
): Promise<string> => {
    const { renderMarkdownDocument } = await import("./markdown.ts");
    const rendered = stripVTControlCharacters(renderMarkdownDocument(markdown, width, mermaidTimeoutMs));
    return rendered.length > 0 ? `${rendered}\n` : "";
};

export const runRender = async (
    width: number,
    mermaidTimeoutMs?: number | string,
): Promise<number> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const markdown = Buffer.concat(chunks).toString("utf8");
    const output = await renderMarkdown(markdown, width, mermaidTimeoutMs);
    if (output.length > 0) {
        process.stdout.write(output);
    }
    return 0;
};
