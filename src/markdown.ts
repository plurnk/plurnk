// Client-side GFM projection for the TUI (plurnk#15, under the #21
// contract). The wire carries semantic Markdown and Mermaid source. Maintained
// parser and layout packages own GFM, wrapping, width, and table mechanics;
// this module composes them with the live viewport and Mermaid projection.
// One-shot output stays raw.

import { renderMermaidASCII, type AsciiRenderOptions } from "beautiful-mermaid";
import Table from "cli-table3";
import { Marked, type RendererObject, type Tokens } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

import { colorEnabled } from "./color.ts";

const supportsColor = colorEnabled() && process.stdout.isTTY === true;
const code = (n: string): string => supportsColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const BOLD = code("1");
const ITALIC = code("3");
const STRIKE = code("9");
const CYAN = code("36");

export const displayWidth = (text: string): number => stringWidth(text);

const styled = (style: string) => (text: string): string =>
    style.length === 0 ? text : `${style}${text}${RESET}`;
const fitTableWidths = (
    rows: string[][],
    viewport: number,
): number[] => {
    const columns = Math.max(...rows.map((row) => row.length));
    const widths = Array.from({ length: columns }, (_value, index) =>
        Math.max(3, ...rows.map((row) => displayWidth(row[index] ?? "") + 2)));
    const contentBudget = Math.max(columns * 3, viewport - columns - 1);
    while (widths.reduce((sum, width) => sum + width, 0) > contentBudget) {
        const reducible = widths
            .map((width, index) => ({ width, index }))
            .filter(({ width }) => width > 3)
            .sort((left, right) => right.width - left.width)[0];
        if (reducible === undefined) break;
        widths[reducible.index] -= 1;
    }
    return widths;
};

const MERMAID_OPTIONS = {
    useAscii: false,
    paddingX: 1,
    paddingY: 1,
    boxBorderPadding: 0,
    colorMode: "none",
} satisfies AsciiRenderOptions;

const renderMermaidLines = (source: string): string[] | null => {
    try {
        const lines = renderMermaidASCII(source, MERMAID_OPTIONS)
            .replaceAll("\r\n", "\n")
            .split("\n")
            .map((line) => line.trimEnd());
        while (lines[0]?.length === 0) lines.shift();
        while (lines.at(-1)?.length === 0) lines.pop();
        return lines.length === 0 ? null : lines;
    } catch {
        return null;
    }
};

const verticalizeFlowchart = (source: string): string => source
    .replace(/^(\s*(?:graph|flowchart)\s+)(?:LR|RL)(?=\s*(?:;|$))/im, "$1TD")
    .replace(/^(\s*direction\s+)(?:LR|RL)(\s*)$/gim, "$1TB$2");

const widestLine = (lines: string[]): number =>
    Math.max(0, ...lines.map(displayWidth));

// Preserve the authored layout whenever it fits the current viewport. A
// vertical projection is the one bounded alternative; invalid, unsupported,
// or still-overwide diagrams remain inspectable as labeled source.
export const renderMermaid = (
    source: string,
    viewport: number = process.stdout.columns ?? 80,
): string[] => {
    const width = Math.max(1, Math.trunc(viewport));
    const authored = renderMermaidLines(source);
    if (authored !== null && widestLine(authored) <= width) return authored;

    const verticalSource = verticalizeFlowchart(source);
    const vertical = verticalSource === source ? null : renderMermaidLines(verticalSource);
    if (vertical !== null && widestLine(vertical) <= width) return vertical;

    const attemptedWidths = [authored, vertical]
        .filter((lines): lines is string[] => lines !== null)
        .map(widestLine);
    const reason = attemptedWidths.length === 0
        ? "unsupported or invalid"
        : `rendered width ${Math.min(...attemptedWidths)} exceeds ${width}`;
    return [
        `${DIM}◇ mermaid source — ${reason}${RESET}`,
        ...source.split("\n").map((line) => `${DIM}│ ${line}${RESET}`),
    ];
};

const terminalRenderer = (viewport: number): Marked => {
    let blockIndent = 0;
    const availableWidth = (): number => Math.max(1, viewport - blockIndent);
    const withBlockIndent = <T>(columns: number, project: () => T): T => {
        blockIndent += columns;
        try {
            return project();
        } finally {
            blockIndent -= columns;
        }
    };
    const wrap = (text: string): string => wrapAnsi(text, availableWidth(), {
        hard: true,
        trim: true,
        wordWrap: true,
    });
    const renderer: RendererObject = {
        space() {
            return "";
        },
        code(token: Tokens.Code) {
            if (token.lang?.trim().toLowerCase() === "mermaid") {
                return `${renderMermaid(token.text, viewport).join("\n")}\n\n`;
            }
            const language = token.lang?.trim() ?? "";
            const header = language.length === 0 ? "◇" : `◇ ${language}`;
            return [
                styled(DIM)(header),
                ...token.text.split("\n").map((line) => `${styled(DIM)("│")} ${line}`),
                "",
                "",
            ].join("\n");
        },
        blockquote(token: Tokens.Blockquote) {
            const body = withBlockIndent(2, () => this.parser.parse(token.tokens).trimEnd());
            return `${body.split("\n").map((line) => `${styled(DIM)("│")} ${line}`).join("\n")}\n\n`;
        },
        html(token: Tokens.HTML | Tokens.Tag) {
            return styled(DIM)(token.text);
        },
        def() {
            return "";
        },
        heading(token: Tokens.Heading) {
            return `${wrap(styled(BOLD)(this.parser.parseInline(token.tokens)))}\n\n`;
        },
        hr() {
            return `${styled(DIM)("─".repeat(viewport))}\n\n`;
        },
        list(token: Tokens.List) {
            const start = typeof token.start === "number" ? token.start : 1;
            const rows = token.items.map((item, index) => {
                const marker = token.ordered ? `${start + index}. ` : "* ";
                const prefix = marker;
                const body = withBlockIndent(displayWidth(prefix), () => item.tokens.map((itemToken) => {
                    const rendered = this.parser.parse([itemToken]);
                    return itemToken.type === "text" ? wrap(rendered) : rendered;
                }).join("").trim());
                const lines = body.split("\n");
                return [
                    `${prefix}${lines[0] ?? ""}`,
                    ...lines.slice(1).map((line) => `${" ".repeat(displayWidth(prefix))}${line}`),
                ].join("\n");
            });
            return `${rows.join("\n")}\n\n`;
        },
        checkbox(token: Tokens.Checkbox) {
            return `[${token.checked ? "x" : " "}] `;
        },
        paragraph(token: Tokens.Paragraph) {
            return `${wrap(this.parser.parseInline(token.tokens))}\n\n`;
        },
        table(token: Tokens.Table) {
            const header = token.header.map((cell) => this.parser.parseInline(cell.tokens));
            const rows = token.rows.map((row) => row.map((cell) => this.parser.parseInline(cell.tokens)));
            const colWidths = fitTableWidths([header, ...rows], viewport);
            const wrapCell = (cell: string, index: number): string => wrapAnsi(
                cell,
                Math.max(1, (colWidths[index] ?? 3) - 2),
                { hard: true, trim: true, wordWrap: true },
            );
            const table = new Table({
                colAligns: token.align.map((align) => align ?? "left"),
                colWidths,
                head: header.map((cell, index) => wrapCell(styled(BOLD)(cell), index)),
                wordWrap: true,
                wrapOnWordBoundary: true,
                style: {
                    border: [],
                    compact: false,
                    head: [],
                    "padding-left": 1,
                    "padding-right": 1,
                },
            });
            table.push(...rows.map((row) => row.map(wrapCell)));
            return `${table.toString()}\n\n`;
        },
        strong(token: Tokens.Strong) {
            return styled(BOLD)(this.parser.parseInline(token.tokens));
        },
        em(token: Tokens.Em) {
            return styled(ITALIC)(this.parser.parseInline(token.tokens));
        },
        codespan(token: Tokens.Codespan) {
            return styled(DIM)(token.text);
        },
        br() {
            return "\n";
        },
        del(token: Tokens.Del) {
            return styled(STRIKE)(this.parser.parseInline(token.tokens));
        },
        link(token: Tokens.Link) {
            const label = this.parser.parseInline(token.tokens);
            return token.href === token.text
                ? styled(CYAN)(label)
                : `${styled(CYAN)(label)} ${styled(DIM)(`(${token.href})`)}`;
        },
        image(token: Tokens.Image) {
            return `${token.text} ${styled(DIM)(`(${token.href})`)}`;
        },
        text(token: Tokens.Text | Tokens.Escape) {
            return "tokens" in token && token.tokens !== undefined
                ? this.parser.parseInline(token.tokens)
                : token.text;
        },
    };
    return new Marked({ breaks: false, gfm: true, renderer });
};

// A common model-authored inline-math spelling with an exact terminal glyph.
const normalizeProse = (text: string): string => text.replaceAll("$\\rightarrow$", "→");

export const renderMarkdownDocument = (
    raw: string,
    viewport: number = process.stdout.columns ?? 80,
): string => {
    const width = Math.max(1, Math.trunc(viewport));
    const rendered = terminalRenderer(width).parse(normalizeProse(raw));
    if (typeof rendered !== "string") throw new TypeError("Terminal Markdown rendering became asynchronous.");
    return rendered.trimEnd();
};

// Heuristic: ordinary speech remains ordinary speech; structurally marked GFM
// enters the terminal renderer.
export const looksLikeMarkdown = (text: string): boolean =>
    /(^|\n)#{1,6}\s/.test(text)
    || /\*\*[^*\n]+\*\*/.test(text)
    || /(^|\n)[-*+]\s/.test(text)
    || /```/.test(text)
    || /(^|\n)\s*\|.*\|/.test(text)
    || /\[[^\]]+\]\([^)]+\)/.test(text);
