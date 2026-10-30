// Markdown, Mermaid diagram, operation block, and loop summary rendering
// ({§cli-markdown-projection}, {§cli-rendering}).

import { stripVTControlCharacters } from "node:util";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { renderMermaidASCII } from "beautiful-mermaid";
import stringWidth from "string-width";
import { ModelText, paint } from "./color.ts";

export const markdownTheme: MarkdownTheme = {
    heading: (text) => paint(text, "bold"),
    link: (text) => paint(text, "reference"),
    linkUrl: () => "",
    code: (text) => paint(text, "reference"),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => paint(text, "dim"),
    quote: (text) => paint(text, "dim", "italic"),
    quoteBorder: () => paint("│", "dim"),
    hr: () => paint("─", "dim"),
    listBullet: (text) => paint(text, "dim"),
    bold: (text) => paint(text, "bold"),
    italic: (text) => paint(text, "italic"),
    strikethrough: (text) => paint(text, "strike"),
    underline: (text) => text,
};

// {§cli-markdown-projection} — Mermaid ASCII diagram projection.
export const renderMermaid = (source: string, width: number = 80): string | null => {
    const trimmed = source.trim();
    if (trimmed.length === 0) return null;
    try {
        const rendered = renderMermaidASCII(trimmed, { colorMode: "none" }).trimEnd();
        if (rendered.length === 0) return null;
        const lines = rendered.split("\n");
        if (lines.some((line) => stringWidth(line) + 2 > width)) return null;
        return lines.map((line) => `  ${line}`).join("\n");
    } catch {
        return null;
    }
};

// {§cli-markdown-projection} — Terminal Markdown projection via pi-tui Markdown + Mermaid.
export const renderMarkdownDocument = (markdown: string, width: number = 80): string => {
    const clean = ModelText.plain(markdown).replace(/\r\n/gu, "\n");
    if (clean.trim().length === 0) return "";
    const withMermaid = clean.replace(
        /^(`{3,}|~{3,})mermaid[ \t]*\n([\s\S]*?)^\1[ \t]*$/gmu,
        (full, _fence: string, body: string) => renderMermaid(body, width) ?? full,
    );
    const md = new Markdown(withMermaid, 0, 0, markdownTheme);
    const lines = md.render(Math.max(20, width));
    return lines.join("\n").replace(/\n+$/u, "");
};

// {§cli-markdown-projection} — Live 1/3-screen reasoning formatting with 💭 lead and 3-space indent.
export const renderReasoning = (content: string): string => {
    const clean = ModelText.plain(content).replace(/\r\n/gu, "\n").replace(/\n$/u, "");
    if (clean.length === 0) return "";
    return clean
        .split("\n")
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
    },
): string => {
    const op = opts?.op ?? "SEND";
    if (op === "outside-") {
        return renderMarkdownDocument(text, columns);
    }
    const status = opts?.status ?? 200;
    const failed = status >= 400;
    const glyph = op === "WAIT" ? (failed ? "❌" : "⏳") : failed ? "❌" : "🐹";
    const cleanAside =
        (op === "WAIT" || failed) && opts?.aside ? ModelText.plain(opts.aside).trim() : "";
    const lead = `${paint(glyph, failed ? "failure" : "dim")}${
        cleanAside.length > 0 ? ` ${paint(cleanAside, "dim", "italic")}` : ""
    }`;
    const body = renderMarkdownDocument(text, columns);
    return body.length > 0 ? `${lead}\n${body}` : lead;
};

// {§cli-rendering} — Full dimmed Markdown rendering for NOTE / FACT / IDEA / PLAN.
export const renderNoteBlock = (opts: {
    readonly glyph: string;
    readonly aside?: string | null;
    readonly body: string;
    readonly columns?: number;
}): string => {
    const cleanAside = opts.aside ? ModelText.plain(opts.aside).trim() : "";
    const sep = opts.glyph.endsWith("\uFE0F") ? "  " : " ";
    const lead = `${paint(opts.glyph, "dim")}${
        cleanAside.length > 0 ? `${sep}${paint(cleanAside, "dim", "italic")}` : ""
    }`;
    const rendered = renderMarkdownDocument(opts.body, opts.columns ?? 80);
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
        op === "NOTE" ? Number.MAX_SAFE_INTEGER : limit,
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
