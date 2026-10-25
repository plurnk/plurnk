// Reads semantic Markdown from stdin, writes one width-bounded plain-Unicode
// projection to stdout. No model work, no network, no ANSI, no daemon.

import stringWidth from "string-width";

const DEFAULT_WIDTH = 60;

// ─── Inline Markdown → plain text ───────────────────────────────────────────

const stripInline = (text: string): string => {
    return text
        // Images: keep alt text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        // Links: keep label
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        // Bold + italic
        .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/___([^_]+)___/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        // Strikethrough
        .replace(/~~([^~]+)~~/g, "$1")
        // Inline code: keep content
        .replace(/`([^`]+)`/g, "$1")
        // HTML tags
        .replace(/<[^>]+>/g, "")
        // Collapse whitespace
        .replace(/[ \t]+/g, " ")
        .trim();
};

// ─── Block-level Markdown → plain text lines ───────────────────────────────

interface Block {
    kind: "heading" | "paragraph" | "list" | "code" | "mermaid" | "blockquote" | "table" | "hr" | "blank";
    level?: number;
    indent?: number;
    ordered?: boolean;
    text: string;
    lang?: string;
}

const parseBlocks = (md: string): Block[] => {
    const lines = md.split("\n");
    const blocks: Block[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i]!;

        // Fenced code / mermaid
        const fence = /^(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
        if (fence) {
            const marker = fence[1]!;
            const lang = fence[2] ?? "";
            const body: string[] = [];
            i++;
            while (i < lines.length && !lines[i]!.startsWith(marker)) {
                body.push(lines[i]!);
                i++;
            }
            i++; // skip closing fence
            blocks.push({ kind: lang === "mermaid" ? "mermaid" : "code", text: body.join("\n"), lang });
            continue;
        }

        // Heading
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            blocks.push({ kind: "heading", level: heading[1]!.length, text: stripInline(heading[2]!) });
            i++;
            continue;
        }

        // HR
        if (/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            blocks.push({ kind: "hr", text: "" });
            i++;
            continue;
        }

        // Blockquote
        if (/^>\s?/.test(line)) {
            const body: string[] = [];
            while (i < lines.length && /^>\s?/.test(lines[i]!)) {
                body.push(lines[i]!.replace(/^>\s?/, ""));
                i++;
            }
            blocks.push({ kind: "blockquote", text: body.join("\n") });
            continue;
        }

        // Table
        if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1]!)) {
            const rows: string[] = [];
            while (i < lines.length && lines[i]!.includes("|")) {
                if (!/^\s*\|?[\s:-]+\|\s*$/.test(lines[i]!)) {
                    rows.push(lines[i]!);
                }
                i++;
            }
            blocks.push({ kind: "table", text: rows.join("\n") });
            continue;
        }

        // List (unordered or ordered)
        const ul = /^(\s*)([-*+])\s+(.*)$/.exec(line);
        const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
        if (ul || ol) {
            const ordered = !!ol;
            const baseIndent = (ul?.[1] ?? ol?.[1] ?? "").length;
            const items: Array<{ indent: number; text: string }> = [];
            while (i < lines.length) {
                const ulm = /^(\s*)([-*+])\s+(.*)$/.exec(lines[i]!);
                const olm = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i]!);
                if (ulm) {
                    items.push({ indent: ulm[1]!.length - baseIndent, text: stripInline(ulm[3]!) });
                    i++;
                } else if (olm) {
                    items.push({ indent: olm[1]!.length - baseIndent, text: stripInline(olm[3]!) });
                    i++;
                } else if (lines[i]!.trim() === "") {
                    break;
                } else if (/^\s+\S/.test(lines[i]!)) {
                    // continuation
                    const last = items[items.length - 1];
                    if (last) last.text += " " + stripInline(lines[i]!.trim());
                    i++;
                } else {
                    break;
                }
            }
            blocks.push({ kind: "list", ordered, text: JSON.stringify(items) });
            continue;
        }

        // Blank
        if (line.trim() === "") {
            blocks.push({ kind: "blank", text: "" });
            i++;
            continue;
        }

        // Paragraph (accumulate until blank or structural)
        const para: string[] = [line];
        i++;
        while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,6}\s|>|`{3,}|~{3,}|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]!)) {
            para.push(lines[i]!);
            i++;
        }
        blocks.push({ kind: "paragraph", text: stripInline(para.join(" ")) });
    }

    return blocks;
};

// ─── Width-bounded wrapping ─────────────────────────────────────────────────

const wrapLine = (text: string, width: number, indent = ""): string[] => {
    if (text.length === 0) return [indent];
    const effective = width - indent.length;
    if (effective <= 0) return [indent];

    const words = text.split(" ");
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        const candidate = current === "" ? word : `${current} ${word}`;
        if (stringWidth(candidate) <= effective) {
            current = candidate;
        } else {
            if (current !== "") lines.push(indent + current);
            // Word itself is too wide: hard-break
            if (stringWidth(word) > effective) {
                let remaining = word;
                while (stringWidth(remaining) > effective) {
                    let cut = 0;
                    while (cut < remaining.length && stringWidth(remaining.slice(0, cut + 1)) <= effective) cut++;
                    lines.push(indent + remaining.slice(0, cut));
                    remaining = remaining.slice(cut);
                }
                current = remaining;
            } else {
                current = word;
            }
        }
    }
    if (current !== "") lines.push(indent + current);
    return lines;
};

// ─── Main projection ───────────────────────────────────────────────────────

export const renderMarkdown = (markdown: string, width: number = DEFAULT_WIDTH): string => {
    const blocks = parseBlocks(markdown);
    const out: string[] = [];

    for (const block of blocks) {
        switch (block.kind) {
            case "blank":
                out.push("");
                break;

            case "heading": {
                const text = block.text;
                const level = block.level ?? 1;
                // Plain-Unicode heading: underline with = or -
                const underline = level === 1 ? "=" : "-";
                out.push(...wrapLine(text, width));
                out.push(...wrapLine(underline.repeat(Math.min(text.length, width)), width));
                break;
            }

            case "paragraph":
                out.push(...wrapLine(block.text, width));
                break;

            case "list": {
                const items: Array<{ indent: number; text: string }> = JSON.parse(block.text);
                for (const item of items) {
                    const marker = block.ordered ? `${String(items.indexOf(item) + 1)}.` : "•";
                    const indent = "  ".repeat(item.indent) + marker + " ";
                    out.push(...wrapLine(item.text, width, indent));
                }
                break;
            }

            case "code":
                out.push(...block.text.split("\n").map((l) => "  " + l));
                break;

            case "mermaid":
                out.push("  [diagram]");
                out.push(...block.text.split("\n").map((l) => "  " + l));
                break;

            case "blockquote":
                for (const line of block.text.split("\n")) {
                    const wrapped = wrapLine(line, width - 2, "  ");
                    out.push(...wrapped.map((l) => "│ " + l.slice(2)));
                }
                break;

            case "table": {
                const rows = block.text.split("\n");
                const cells = rows.map((r) => r.split("|").map((c) => c.trim()).filter((c) => c !== ""));
                if (cells.length === 0) break;
                const cols = Math.max(...cells.map((r) => r.length));
                for (const row of cells) {
                    const parts = row.map((cell, ci) => cell.padEnd(ci === row.length - 1 ? 0 : Math.max(4, ...cells.map((r) => r[ci]?.length ?? 0))));
                    out.push(...wrapLine(parts.join(" ").replace(/\s+/g, " ").trim(), width));
                }
                break;
            }

            case "hr":
                out.push("─".repeat(width));
                break;
        }
    }

    return out.join("\n") + "\n";
};

// ─── CLI entrypoint for `plurnk render` ────────────────────────────────────

export const RENDER_HELP = `plurnk render --width <columns>

Reads semantic Markdown from stdin and writes a width-bounded plain-Unicode
projection to stdout. Daemon-free; no model work, network, or ANSI styling.

Options:
  -w, --width <columns>  Output width in columns (default: ${DEFAULT_WIDTH})
  -h, --help             Print this help (capability probe)
`;

export const runRender = async (width: number): Promise<number> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const markdown = Buffer.concat(chunks).toString("utf8");
    const output = renderMarkdown(markdown, width);
    process.stdout.write(output);
    return 0;
};