// Client-side GFM and LaTeX projection for the TUI (plurnk#15, plurnk#177).
// The wire carries semantic Markdown and Mermaid source. Delegates GFM parsing,
// tables, and LaTeX math rendering to @earendil-works/pi-tui; this module composes
// them with the live viewport and Mermaid diagram projection.
// One-shot CLI output stays raw verbatim.

import { Script } from "node:vm";
import { stripVTControlCharacters } from "node:util";
import { renderMermaidASCII, type AsciiRenderOptions } from "beautiful-mermaid";
import { Markdown, type MarkdownTheme, type MarkdownOptions } from "@earendil-works/pi-tui";
import stringWidth from "string-width";

import { colorEnabled, hyperlink, paint, type Role } from "./color.ts";
import Knobs, { KnobError } from "./knobs.ts";

export const displayWidth = (text: string): number => stringWidth(text);
const styled = (role: Role) => (text: string): string => paint(text, role);

const MERMAID_OPTIONS = {
    useAscii: false,
    paddingX: 1,
    paddingY: 1,
    boxBorderPadding: 0,
    colorMode: "none",
} satisfies AsciiRenderOptions;

// {§cli-markdown-projection}: a JS timer cannot interrupt synchronous layout.
// Only this fixed call executes as code; Mermaid remains data passed to the renderer.
const mermaidProjection = new Script("project()", { filename: "plurnk-mermaid-render" });

const renderMermaidLines = (source: string): string[] => {
    const lines = renderMermaidASCII(source, MERMAID_OPTIONS)
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => line.trimEnd());
    while (lines[0]?.length === 0) lines.shift();
    while (lines.at(-1)?.length === 0) lines.pop();
    if (lines.length === 0) throw new Error("Mermaid produced no diagram.");
    return lines;
};

const transposeFlowchart = (source: string): string => {
    const transpose = (_match: string, prefix: string, direction: string): string =>
        `${prefix}${/^(?:LR|RL)$/i.test(direction) ? "TD" : "LR"}`;
    return source
        .replace(/^([ \t]*(?:graph|flowchart)[ \t]+)(TD|TB|BT|LR|RL)(?=[ \t]*(?:;|\r?$))/im, transpose)
        .replace(/^([ \t]*direction[ \t]+)(TD|TB|BT|LR|RL)(?=[ \t]*\r?$)/gim, transpose);
};

const widestLine = (lines: string[]): number =>
    Math.max(0, ...lines.map(displayWidth));

// Preserve the authored layout whenever it fits the current viewport. A
// transposed projection is the one bounded alternative; invalid, unsupported,
// or still-overwide diagrams remain inspectable as labeled source.
export const renderMermaid = (
    source: string,
    viewport: number = process.stdout.columns ?? 80,
): string[] => {
    const width = Math.max(1, Math.trunc(viewport));
    let failure = "";
    try {
        const timeout = Knobs.count("PLURNK_CLIENT_MERMAID_TIMEOUT_MS");
        if (timeout === 0) throw new KnobError("PLURNK_CLIENT_MERMAID_TIMEOUT_MS", String(timeout), "must be positive.");
        const lines = mermaidProjection.runInNewContext({ project: () => {
            const authored = renderMermaidLines(source);
            if (widestLine(authored) <= width) return authored;
            const alternateSource = transposeFlowchart(source);
            const alternate = alternateSource === source ? null : renderMermaidLines(alternateSource);
            return alternate !== null && widestLine(alternate) <= width ? alternate : null;
        } }, { timeout }) as string[] | null;
        if (lines !== null) return lines;
    } catch (cause) {
        failure = " — diagram failed to render";
        if (cause instanceof KnobError) failure += `: ${cause.message}`;
    }
    return [
        styled("dim")(`💻 mermaid${failure}`),
        ...source.split("\n").map((line) => styled("dim")(`│ ${line}`)),
    ];
};

// Intercept pi-tui code block and link rendering:
// Mermaid diagrams project to ASCII topologies; links adhere to {§cli-hyperlinks}
// showing OSC 8 label plus visible destination. All other code blocks, tables,
// lists, LaTeX math, and typography are rendered natively by pi-tui.
const originalRenderToken = (Markdown.prototype as any).renderToken;
const originalRenderInlineTokens = (Markdown.prototype as any).renderInlineTokens;
let patched = false;
const ensurePatched = () => {
    if (patched) return;
    patched = true;
    (Markdown.prototype as any).renderToken = function (
        token: any,
        width: number,
        nextTokenType?: string,
        styleContext?: any,
    ): string[] {
        if (token.type === "code" && token.lang?.trim().toLowerCase() === "mermaid") {
            const drawn = renderMermaid(token.text, width);
            return [
                ...drawn,
                ...(nextTokenType && nextTokenType !== "space" ? [""] : []),
            ];
        }
        return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
    };
    (Markdown.prototype as any).renderInlineTokens = function (
        tokens: any[],
        styleContext: any,
    ): string {
        let result = "";
        for (const token of tokens) {
            if (token.type === "link") {
                const linkText = originalRenderInlineTokens.call(this, token.tokens || [], styleContext);
                const label = hyperlink(styled("reference")(linkText), token.href);
                result += token.href === token.text ? label : `${label} ${styled("dim")(`(${token.href})`)}`;
            } else {
                result += originalRenderInlineTokens.call(this, [token], styleContext);
            }
        }
        return result;
    };
};

const theme: MarkdownTheme = {
    heading: (t: string) => styled("bold")(t),
    link: (t: string) => styled("reference")(t),
    linkUrl: (t: string) => styled("dim")(t),
    code: (t: string) => styled("dim")(t),
    codeBlock: (t: string) => t,
    codeBlockBorder: (t: string) => styled("dim")(t),
    quote: (t: string) => styled("italic")(t),
    quoteBorder: (t: string) => styled("dim")("│ "),
    hr: () => styled("dim")("---"),
    listBullet: (t: string) => t,
    bold: (t: string) => styled("bold")(t),
    italic: (t: string) => styled("italic")(t),
    strikethrough: (t: string) => styled("strike")(t),
    underline: (t: string) => t,
};

const MARKDOWN_OPTIONS: MarkdownOptions = {
    preserveOrderedListMarkers: true,
    renderLatex: true,
};

export const renderMarkdownDocument = (
    raw: string,
    viewport: number = process.stdout.columns ?? 80,
): string => {
    ensurePatched();
    const width = Math.max(1, Math.trunc(viewport));
    const md = new Markdown(raw, 0, 0, theme, undefined, MARKDOWN_OPTIONS);
    const rendered = md.render(width).map((line) => line.trimEnd()).join("\n").trimEnd();
    return colorEnabled() ? rendered : stripVTControlCharacters(rendered);
};

// Heuristic: ordinary speech remains ordinary speech; structurally marked GFM
// or LaTeX math enters the terminal renderer.
export const looksLikeMarkdown = (text: string): boolean =>
    /(^|\n)#{1,6}\s/.test(text)
    || /\*\*[^*\n]+\*\*/.test(text)
    || /(^|\n)[-*+]\s/.test(text)
    || /(^|\n)\s*\d+[.)]\s/.test(text)
    || /```|~~~/.test(text)
    || /(^|\n)\s*\|.*\|/.test(text)
    || /\[[^\]]+\]\([^)]+\)/.test(text)
    || /(?:^|[^\\])\$[^$\n\s]+(?:[ \t]+[^$\n\s]+)*\$/.test(text)
    || /(?:^|\n)[ \t]*(?:\$\$|\\\[)/.test(text)
    || /(?:^|[^\\])`[^`\n]+`/.test(text)
    || /(^|\n)[ \t]*>\s/.test(text);
