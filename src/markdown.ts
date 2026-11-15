// Markdown, Mermaid diagram, operation block, and loop summary rendering
// ({§cli-markdown-projection}, {§cli-rendering}, {§cli-color-policy}).

import { existsSync, readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { Script } from "node:vm";
import { Markdown, type MarkdownOptions, type MarkdownTheme } from "@earendil-works/pi-tui";
import { renderMermaidASCII, type AsciiRenderOptions } from "beautiful-mermaid";
import stringWidth from "string-width";
import { colorEnabled, hyperlink, ModelText, paint, styled } from "./color.ts";
import { CLIENT_DEFAULTS_PATH, parseDefaults } from "./envdefaults.ts";
import { formatActiveOperationLead, formatDuration } from "./presenter-formatters.ts";
import type { ActiveLiveEntry } from "./session-presenter.ts";

export const displayWidth = (text: string): number => stringWidth(text);

export const markdownTheme: MarkdownTheme = {
    heading: (text) => paint(text, "bold"),
    link: (text) => paint(text, "reference"),
    linkUrl: (text) => paint(text, "dim"),
    code: (text) => paint(text, "reference"),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => paint(text, "dim"),
    quote: (text) => paint(text, "dim", "italic"),
    quoteBorder: (text) => paint(text, "dim"),
    hr: (text) => paint(text, "dim"),
    listBullet: (text) => paint(text, "dim"),
    bold: (text) => paint(text, "bold"),
    italic: (text) => paint(text, "italic"),
    strikethrough: (text) => paint(text, "strike"),
    underline: (text) => text,
};

const MARKDOWN_OPTIONS: MarkdownOptions = {
    preserveOrderedListMarkers: true,
    renderLatex: true,
};

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

class MermaidTimeoutKnobError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = "MermaidTimeoutKnobError";
    }
}

let packagedMermaidTimeoutRaw: string | undefined;
const defaultMermaidTimeoutRaw = (): string => {
    if (packagedMermaidTimeoutRaw === undefined) {
        const defaults = existsSync(CLIENT_DEFAULTS_PATH)
            ? parseDefaults(readFileSync(CLIENT_DEFAULTS_PATH, "utf8"))
            : {};
        packagedMermaidTimeoutRaw = defaults.PLURNK_CLIENT_MERMAID_TIMEOUT_MS ?? "";
    }
    return packagedMermaidTimeoutRaw;
};

const resolveMermaidTimeoutMs = (override?: number | string): number => {
    if (typeof override === "number") {
        if (!Number.isInteger(override) || override < 1) {
            throw new MermaidTimeoutKnobError("PLURNK_CLIENT_MERMAID_TIMEOUT_MS must be a positive integer.");
        }
        return override;
    }
    const raw =
        override !== undefined
            ? override
            : process.env.PLURNK_CLIENT_MERMAID_TIMEOUT_MS !== undefined
              ? process.env.PLURNK_CLIENT_MERMAID_TIMEOUT_MS
              : defaultMermaidTimeoutRaw();
    const trimmed = raw.trim();
    if (!/^\d+$/u.test(trimmed)) {
        throw new MermaidTimeoutKnobError("PLURNK_CLIENT_MERMAID_TIMEOUT_MS must be a positive integer.");
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new MermaidTimeoutKnobError("PLURNK_CLIENT_MERMAID_TIMEOUT_MS must be a positive integer.");
    }
    return parsed;
};

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
        `${prefix}${/^(?:LR|RL)$/iu.test(direction) ? "TD" : "LR"}`;
    return source
        .replace(/^([ \t]*(?:graph|flowchart)[ \t]+)(TD|TB|BT|LR|RL)(?=[ \t]*(?:;|\r?$))/imu, transpose)
        .replace(/^([ \t]*direction[ \t]+)(TD|TB|BT|LR|RL)(?=[ \t]*\r?$)/gimu, transpose);
};

const widestLine = (lines: readonly string[]): number =>
    Math.max(0, ...lines.map(displayWidth));

// {§cli-markdown-projection} — Preserve authored layout whenever it fits the viewport; retry
// once with transposed flowchart orientation; otherwise return labeled dim source.
export const renderMermaid = (
    source: string,
    viewport: number = process.stdout.columns ?? 80,
    timeoutMs?: number | string,
): string[] => {
    const cleanSource = ModelText.plain(source).replaceAll("\r\n", "\n");
    const width = Math.max(1, Math.trunc(viewport));
    let failure: string;
    try {
        const timeout = resolveMermaidTimeoutMs(timeoutMs);
        const projected = mermaidProjection.runInNewContext(
            {
                project: () => {
                    const authored = renderMermaidLines(cleanSource);
                    if (widestLine(authored) <= width) return authored;
                    const alternateSource = transposeFlowchart(cleanSource);
                    const alternate = alternateSource === cleanSource ? null : renderMermaidLines(alternateSource);
                    if (alternate !== null && widestLine(alternate) <= width) return alternate;
                    return Math.min(
                        widestLine(authored),
                        alternate === null ? Number.POSITIVE_INFINITY : widestLine(alternate),
                    );
                },
            },
            { timeout },
        ) as string[] | number;
        if (Array.isArray(projected)) return projected;
        failure = ` — rendered width ${String(projected)} exceeds ${String(width)}`;
    } catch (cause) {
        failure = " — diagram failed to render";
        if (cause instanceof MermaidTimeoutKnobError) failure += `: ${cause.message}`;
    }
    return [
        styled("dim")(`💻 mermaid${failure}`),
        ...cleanSource.split("\n").map((line) => styled("dim")(`│ ${line}`)),
    ];
};

type NativeToken = { type: string };
type NativeCode = NativeToken & { type: "code"; lang?: string; text: string };
type NativeLink = NativeToken & { type: "link"; text: string; href: string; tokens?: NativeToken[] };
type NativeHooks = {
    renderToken(token: NativeToken, width: number, nextTokenType?: string, styleContext?: unknown): string[];
    renderInlineTokens(tokens: NativeToken[], styleContext?: unknown): string;
};

// {§cli-markdown-projection}, {§cli-color-policy} — Instance-local adapter hooks for nested
// Mermaid block widths and color-policy-governed OSC 8 hyperlinks; never mutates Markdown.prototype.
const customize = (markdown: Markdown, mermaidTimeoutMs?: number | string): Markdown => {
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
                return [
                    ...renderMermaid(code.text, width, mermaidTimeoutMs),
                    ...(nextTokenType && nextTokenType !== "space" ? [""] : []),
                ];
            }
        }
        return renderToken(token, width, nextTokenType, styleContext);
    };
    hooks.renderInlineTokens = (tokens, styleContext) =>
        renderInlineTokens(
            tokens.map((token) => {
                if (token.type !== "link") return token;
                const link = token as NativeLink;
                const text = renderInlineTokens(link.tokens ?? [], styleContext);
                const label = hyperlink(link.href, styled("reference")(text));
                const hrefForComparison = link.href.startsWith("mailto:") ? link.href.slice(7) : link.href;
                const sameTarget = link.text === link.href || link.text === hrefForComparison;
                return {
                    type: "text",
                    text: sameTarget ? label : `${label} ${styled("dim")(`(${link.href})`)}`,
                };
            }),
            styleContext,
        );
    return markdown;
};

// {§cli-markdown-projection} — Terminal Markdown projection via pi-tui Markdown + Mermaid.
export const renderMarkdownDocument = (
    markdown: string,
    viewport: number = process.stdout.columns ?? 80,
    mermaidTimeoutMs?: number | string,
): string => {
    const clean = ModelText.plain(markdown).replaceAll("\r\n", "\n");
    if (clean.trim().length === 0) return "";
    const width = Math.max(1, Math.trunc(viewport));
    const md = customize(new Markdown(clean, 0, 0, markdownTheme, undefined, MARKDOWN_OPTIONS), mermaidTimeoutMs);
    const rendered = md
        .render(width)
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd();
    return colorEnabled() ? rendered : stripVTControlCharacters(rendered);
};

// {§cli-markdown-projection} — Live 3-line rolling reasoning formatting with 💭 lead and 3-space indent.
export const renderReasoning = (content: string): string => {
    const clean = ModelText.plain(content).replace(/\r\n/gu, "\n").replace(/\n$/u, "");
    if (clean.length === 0) return "";
    const allLines = clean.split("\n");
    const visible = allLines.length <= 3 ? allLines : allLines.slice(allLines.length - 3);
    return visible
        .map((line, i) => paint(`${i === 0 ? "💭 " : "   "}${line}`, "dim"))
        .join("\n");
};

// {§cli-rendering}, {§cli-markdown-projection} — Model response rendering.
export const renderModelReply = (
    text: string,
    columns: number = 80,
    opts?: {
        readonly op?: string | null;
        readonly status?: number | null;
        readonly aside?: string | null;
        readonly voice?: string | null;
        readonly mermaidTimeoutMs?: number | string;
    },
): string => {
    const op = opts?.op ?? "send";
    if (op === "outside-") {
        return renderMarkdownDocument(text, columns, opts?.mermaidTimeoutMs);
    }
    const status = opts?.status ?? 200;
    const failed = status >= 400 || op === "fail";
    const trimmedVoice =
        typeof opts?.voice === "string" && opts.voice.trim().length > 0
            ? ModelText.plain(opts.voice.trim())
            : null;
    const glyph =
        op === "wait"
            ? failed
                ? "❌"
                : "⏳"
            : trimmedVoice !== null
              ? failed
                  ? `❌ [${trimmedVoice}]`
                  : `[${trimmedVoice}]`
              : failed
                ? "❌"
                : "🐹";
    const cleanAside =
        (op === "wait" || failed) && opts?.aside ? ModelText.plain(opts.aside).trim() : "";
    const lead = `${paint(glyph, failed ? "failure" : "dim")}${
        cleanAside.length > 0 ? ` ${paint(cleanAside, "dim", "italic")}` : ""
    }`;
    const body = renderMarkdownDocument(text, columns, opts?.mermaidTimeoutMs);
    return body.length > 0 ? `${lead}\n${body}` : lead;
};

// {§cli-rendering} — Full dimmed Markdown rendering for note.
export const renderNoteBlock = (opts: {
    readonly glyph: string;
    readonly aside?: string | null;
    readonly body: string;
    readonly columns?: number;
    readonly mermaidTimeoutMs?: number | string;
}): string => {
    const cleanAside = opts.aside ? ModelText.plain(opts.aside).trim() : "";
    const sep = opts.glyph.endsWith("\uFE0F") ? "  " : " ";
    const lead = `${paint(opts.glyph, "dim")}${
        cleanAside.length > 0 ? `${sep}${paint(cleanAside, "dim", "italic")}` : ""
    }`;
    const rendered = renderMarkdownDocument(opts.body, opts.columns ?? 80, opts.mermaidTimeoutMs);
    if (rendered.trim().length === 0) {
        return lead;
    }
    const dimmedBody = stripVTControlCharacters(rendered)
        .split("\n")
        .map((line) => paint(line, "dim"))
        .join("\n");
    return `${lead}\n${dimmedBody}`;
};

const truncateToColumns = (line: string, maxCols: number): string => {
    if (stringWidth(line) <= maxCols) return line;
    let out = "";
    let width = 0;
    for (const ch of line) {
        const w = stringWidth(ch);
        if (width + w + 1 > maxCols) break;
        out += ch;
        width += w;
    }
    return `${out}…`;
};

// {§cli-rendering} — 4-space indented dim preview lines with log:/// coordinate hint.
export const previewLines = (
    content: string,
    limit: number = 5,
    columns: number = 80,
    coordinate?: string | null,
    op?: string | null,
): string[] => {
    const normalized = ModelText.plain(content).replace(/\r\n/gu, "\n").trimEnd();
    if (normalized.length === 0 || limit <= 0) return [];
    const allLines = normalized.split("\n");
    const maxLineCols = Math.max(20, columns - 6);
    const shown = allLines
        .slice(0, limit)
        .map((line) => paint(`    ${truncateToColumns(line.replace(/\t/gu, "    "), maxLineCols)}`, "dim"));
    if (allLines.length > limit) {
        const remaining = allLines.length - limit;
        const cleanCoord = coordinate ? ModelText.plain(coordinate) : "";
        const cleanOp = op ? ModelText.plain(op) : "";
        const addr =
            cleanCoord.length === 0
                ? ""
                : cleanCoord.startsWith("log://")
                  ? ` · ${cleanCoord}`
                  : cleanOp.length > 0
                    ? ` · log:///${cleanCoord}/${cleanOp}`
                    : ` · log:///${cleanCoord}`;
        shown.push(
            paint(
                `    … +${String(remaining)} ${remaining === 1 ? "line" : "lines"}${addr}`,
                "dim",
            ),
        );
    }
    return shown;
};

// {§cli-rendering} — Operation row + preview block.
export const renderOperationBlock = (opts: {
    readonly glyph: string;
    readonly op?: string | null;
    readonly title?: string | null;
    readonly target?: string | null;
    readonly scope?: string | null;
    readonly destination?: string | null;
    readonly pattern?: string | null;
    readonly fields?: string | null;
    readonly count?: number | null;
    readonly aside?: string | null;
    readonly status?: string | null;
    readonly statusCode?: number | null;
    readonly outcome?: string | null;
    readonly contentLines?: readonly string[];
    readonly outputLines?: readonly string[];
    readonly coordinate?: string | null;
    readonly previewLimit?: number;
    readonly columns?: number;
}): string => {
    const op = opts.op ?? "";
    const failed =
        opts.status === "failed" || (typeof opts.statusCode === "number" && opts.statusCode >= 400);
    const headParts: string[] = [paint(opts.glyph, "bold", failed ? "failure" : "success")];
    if (opts.target) {
        headParts.push(`(${ModelText.plain(opts.target)})`);
    } else if (!op && opts.title) {
        headParts.push(ModelText.plain(opts.title));
    }
    if (opts.scope) {
        headParts.push(ModelText.plain(opts.scope));
    }
    if (opts.destination) {
        headParts.push(`(${ModelText.plain(opts.destination)})`);
    }
    if (opts.pattern) {
        const cleanPat = ModelText.plain(opts.pattern);
        headParts.push(/^[~/&=!]/u.test(cleanPat) ? cleanPat : `/${cleanPat}/`);
    }
    if (opts.fields) {
        headParts.push(ModelText.plain(opts.fields));
    }
    if (typeof opts.count === "number") {
        headParts.push(`{${String(opts.count)}}`);
    }
    if (opts.aside) {
        headParts.push(paint(ModelText.plain(opts.aside), "dim", "italic"));
    }
    if (opts.outcome) {
        headParts.push(`— ${paint(ModelText.plain(opts.outcome), failed ? "failure" : "dim")}`);
    }

    const cols = opts.columns ?? 80;
    const limit = opts.previewLimit ?? 5;
    const bodyText = (opts.contentLines ?? []).join("\n");
    const bodyPreview = previewLines(
        bodyText,
        op === "note" ? Number.MAX_SAFE_INTEGER : limit,
        cols,
        opts.coordinate,
        op,
    );
    const outText = (opts.outputLines ?? []).join("\n");
    const outPreview = previewLines(outText, limit, cols);
    const headLine =
        headParts.length > 1 && opts.glyph.endsWith("\uFE0F")
            ? `${headParts[0]!}  ${headParts.slice(1).join(" ")}`
            : headParts.join(" ");
    return [headLine, ...bodyPreview, ...outPreview].join("\n");
};

export const formatCompactCount = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
    if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
    return String(n);
};

export const formatDurationSummary = (ms: number): string => {
    if (ms < 1000) return `${String(Math.max(1, Math.round(ms)))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${String(mins)}m ${String(secs)}s`;
};

export const formatLoopMetrics = (opts: {
    readonly turns: number;
    readonly elapsedMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly curationWeight: number;
    readonly curationBudget: number;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
    readonly costUsd: string | null;
}): string => {
    const turnLabel = `${String(opts.turns)} ${opts.turns === 1 ? "turn" : "turns"}`;
    const parts: string[] = [turnLabel, formatDurationSummary(opts.elapsedMs)];
    if (opts.inputTokens > 0 || opts.outputTokens > 0) {
        parts.push(`↓${formatCompactCount(opts.inputTokens)} ↑${formatCompactCount(opts.outputTokens)}`);
    }
    if (opts.curationBudget > 0) {
        const curPct = Math.min(100, Math.round((opts.curationWeight / opts.curationBudget) * 100));
        parts.push(`cur ${String(curPct)}%/${formatCompactCount(opts.curationBudget)}`);
    }
    if (opts.contextTokens !== null && opts.contextCapacity !== null && opts.contextCapacity > 0) {
        const ctxPct = Math.min(100, Math.round((opts.contextTokens / opts.contextCapacity) * 100));
        parts.push(`ctx ${String(ctxPct)}%/${formatCompactCount(opts.contextCapacity)}`);
    }
    if (opts.costUsd !== null && Number(opts.costUsd) > 0) {
        const num = Number(opts.costUsd);
        const formattedUsd = num < 0.01 ? `$${num.toFixed(4)}` : `$${num.toFixed(2)}`;
        parts.push(`loop ${formattedUsd}`);
    }
    return parts.join(" · ");
};

// {§cli-rendering} — Loop conclusion summary line.
export const renderLoopSummary = (opts: {
    readonly status: number;
    readonly hitMaxTurns?: boolean;
    readonly turns: number;
    readonly elapsedMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly curationWeight: number;
    readonly curationBudget: number;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
    readonly costUsd: string | null;
}): string => {
    const state =
        opts.status === 200 && !opts.hitMaxTurns
            ? "🎯 done"
            : opts.status === 499
              ? "🛑 cancelled (final 499)"
              : opts.hitMaxTurns
                ? "⏸️ paused at turn limit"
                : "❌ failed";
    return paint(`${state} · ${formatLoopMetrics(opts)}`, "dim");
};

// {§cli-rendering}, {§cli-session-status} — Single-line active streams and workers strip above the composer.
export const renderActiveLiveLine = (
    entries: readonly ActiveLiveEntry[],
    columns: number = 80,
    now: number = Date.now(),
): string => {
    if (entries.length === 0) return "";
    const maxCols = Math.max(20, columns);
    const formatted = entries.map((entry) => {
        const lead = formatActiveOperationLead(entry.op);
        const target = ModelText.plain(entry.target);
        const elapsed = formatDuration(Math.max(1, now - entry.startedAt));
        return `${lead} (${target}) ${elapsed}`;
    });
    const joined = formatted.join(" · ");
    if (stringWidth(joined) <= maxCols) {
        return paint(joined, "dim");
    }
    const fit: string[] = [];
    for (let i = 0; i < formatted.length; i += 1) {
        const remaining = formatted.length - (i + 1);
        const suffix = remaining > 0 ? ` · +${String(remaining)} more` : "";
        const candidate = [...fit, formatted[i]!].join(" · ") + suffix;
        if (stringWidth(candidate) <= maxCols) {
            fit.push(formatted[i]!);
        } else {
            if (fit.length === 0) {
                return paint(truncateToColumns(formatted[i]!, maxCols), "dim");
            }
            const overflowSuffix = ` · +${String(formatted.length - fit.length)} more`;
            const withOverflow = fit.join(" · ") + overflowSuffix;
            return paint(
                stringWidth(withOverflow) <= maxCols
                    ? withOverflow
                    : truncateToColumns(fit.join(" · "), maxCols),
                "dim",
            );
        }
    }
    return paint(truncateToColumns(fit.join(" · "), maxCols), "dim");
};
