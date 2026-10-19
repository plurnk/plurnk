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
// or still-overwide diagrams remain inspectable as source, labeled with what happened.
export const renderMermaid = (
    source: string,
    viewport: number = process.stdout.columns ?? 80,
): string[] => {
    const width = Math.max(1, Math.trunc(viewport));
    let failure: string;
    try {
        const timeout = Knobs.count("PLURNK_CLIENT_MERMAID_TIMEOUT_MS");
        if (timeout === 0) throw new KnobError("PLURNK_CLIENT_MERMAID_TIMEOUT_MS", String(timeout), "must be positive.");
        // The first layout that fits, else the narrower width the attempts drew.
        const projected = mermaidProjection.runInNewContext({ project: () => {
            const authored = renderMermaidLines(source);
            if (widestLine(authored) <= width) return authored;
            const alternateSource = transposeFlowchart(source);
            const alternate = alternateSource === source ? null : renderMermaidLines(alternateSource);
            if (alternate !== null && widestLine(alternate) <= width) return alternate;
            return Math.min(widestLine(authored), alternate === null ? Number.POSITIVE_INFINITY : widestLine(alternate));
        } }, { timeout }) as string[] | number;
        if (Array.isArray(projected)) return projected;
        failure = ` — rendered width ${projected} exceeds ${width}`;
    } catch (cause) {
        failure = " — diagram failed to render";
        if (cause instanceof KnobError) failure += `: ${cause.message}`;
    }
    return [
        styled("dim")(`💻 mermaid${failure}`),
        ...source.split("\n").map((line) => styled("dim")(`│ ${line}`)),
    ];
};

type NativeToken = { type: string };
type NativeCode = NativeToken & { type: "code"; lang?: string; text: string };
type NativeLink = NativeToken & { type: "link"; text: string; href: string; tokens?: NativeToken[] };
type NativeHooks = {
    renderToken(token: NativeToken, width: number, nextTokenType?: string, styleContext?: unknown): string[];
    renderInlineTokens(tokens: NativeToken[], styleContext?: unknown): string;
};

// {§cli-markdown-adapter}: private hooks are necessary for nested block widths and label+URL
// rendering, neither exposed by highlightCode/theme. Patch only this instance, not the library;
// keep the dependency boundary here and exercise it through the native-renderer matrix.
const customize = (markdown: Markdown): Markdown => {
    const hooks = markdown as unknown as NativeHooks;
    if (typeof hooks.renderToken !== "function" || typeof hooks.renderInlineTokens !== "function") {
        throw new TypeError("pi-tui Markdown rendering hooks are unavailable.");
    }
    const renderToken = hooks.renderToken.bind(markdown);
    const renderInlineTokens = hooks.renderInlineTokens.bind(markdown);
    hooks.renderToken = (token, width, nextTokenType, styleContext) => {
        if (token.type === "code") {
            const code = token as NativeCode;
            if (code.lang?.trim().toLowerCase() === "mermaid") {
                return [...renderMermaid(code.text, width), ...(nextTokenType && nextTokenType !== "space" ? [""] : [])];
            }
        }
        return renderToken(token, width, nextTokenType, styleContext);
    };
    hooks.renderInlineTokens = (tokens, styleContext) => renderInlineTokens(tokens.map((token) => {
        if (token.type !== "link") return token;
        const link = token as NativeLink;
        const text = renderInlineTokens(link.tokens ?? [], styleContext);
        const label = hyperlink(styled("reference")(text), link.href);
        return { type: "text", text: link.href === link.text ? label : `${label} ${styled("dim")(`(${link.href})`)}` };
    }), styleContext);
    return markdown;
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
    const width = Math.max(1, Math.trunc(viewport));
    const md = customize(new Markdown(raw, 0, 0, theme, undefined, MARKDOWN_OPTIONS));
    const rendered = md.render(width).map((line) => line.trimEnd()).join("\n").trimEnd();
    return colorEnabled() ? rendered : stripVTControlCharacters(rendered);
};
