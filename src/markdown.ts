// Client-side Markdown projection for the TUI (plurnk#15, under the #21
// contract): the wire carries semantic/raw Markdown and Mermaid source; this
// module projects it for the current terminal, capped at the 80-column
// ergonomic target. Vanilla ANSI, no framework, no wire channel. The one-shot
// CLI never uses this — raw stays raw for pipes.

import { stripVTControlCharacters } from "node:util";
import { renderMermaidASCII, type AsciiRenderOptions } from "beautiful-mermaid";

import { colorEnabled } from "./color.ts";

const supportsColor = colorEnabled() && process.stdout.isTTY === true;
const code = (n: string): string => supportsColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const BOLD = code("1");
const ITALIC = code("3");

export const WIDTH_TARGET = 80;

export const displayWidth = (s: string): number => {
    let w = 0;
    for (const ch of stripVTControlCharacters(s)) {
        const cp = ch.codePointAt(0) ?? 0;
        w += (cp >= 0x1100 && (
            cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
            || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x1f000 && cp <= 0x1ffff)
        )) ? 2 : 1;
    }
    return w;
};

const truncate = (s: string, max: number): string => {
    if (displayWidth(s) <= max) return s;
    let out = "";
    for (const ch of s) {
        if (displayWidth(out + ch) > max - 1) break;
        out += ch;
    }
    return `${out}…`;
};

const pad = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - displayWidth(s)));

// A common model-authored inline-math spelling with an exact terminal glyph.
const normalizeProse = (s: string): string => s.replaceAll("$\\rightarrow$", "→");

const renderInline = (s: string): string => {
    let out = s;
    out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => `${BOLD}${t}${RESET}`);
    out = out.replace(/(^|[^*_])[*_]([^*_\n]+)[*_](?!\*)/g, (_m, pre, t) => `${pre}${ITALIC}${t}${RESET}`);
    out = out.replace(/`([^`\n]+)`/g, (_m, t) => `${DIM}${t}${RESET}`);
    return out;
};

// ─── GFM pipe tables ─────────────────────────────────────────────────

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isTableRule = (line: string): boolean => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);

const splitRow = (line: string): string[] =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

// Project a pipe table as aligned columns within the width budget: compute
// natural widths, then shrink the widest columns until the row fits, with a
// per-cell … truncation. 80 columns is the ergonomic target, not a wire fact.
export const renderTable = (lines: string[], width: number = WIDTH_TARGET): string[] => {
    const rows = lines.filter((line) => !isTableRule(line)).map(splitRow);
    const columns = Math.max(...rows.map((row) => row.length));
    const widths = Array.from({ length: columns }, (_v, index) =>
        Math.max(1, ...rows.map((row) => displayWidth(renderInline(row[index] ?? "")))));
    // Overhead: "│ " + " │ ".repeat + " │" → 3 per column + 1.
    const budget = () => widths.reduce((sum, w) => sum + w + 3, 1);
    while (budget() > width && Math.max(...widths) > 4) {
        widths[widths.indexOf(Math.max(...widths))] -= 1;
    }
    const line = (left: string, mid: string, right: string): string =>
        `${DIM}${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}${RESET}`;
    const cells = (row: string[], emphasize: boolean): string =>
        `${DIM}│${RESET} ${row.length === 0 ? "" : widths.map((w, index) => {
            const projected = renderInline(row[index] ?? "");
            const cell = displayWidth(projected) > w
                ? truncate(stripVTControlCharacters(projected), w)
                : projected;
            const aligned = pad(cell, w);
            return emphasize ? `${BOLD}${aligned}${RESET}` : aligned;
        }).join(` ${DIM}│${RESET} `)} ${DIM}│${RESET}`;
    const out = [line("┌", "┬", "┐"), cells(rows[0] ?? [], true)];
    if (rows.length > 1) out.push(line("├", "┼", "┤"));
    for (const row of rows.slice(1)) out.push(cells(row, false));
    out.push(line("└", "┴", "┘"));
    return out;
};

// ─── Mermaid ─────────────────────────────────────────────────────────

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

const verticalizeWideFlowchart = (source: string): string =>
    source.replace(/^(\s*(?:graph|flowchart)\s+)(?:LR|RL)(?=\s*(?:;|$))/im, "$1TD");

// Preserve the author's layout when it fits. Wide horizontal flowcharts are
// projected vertically for the terminal; unsupported or still-overwide input
// remains visible as its honest Mermaid source.
export const renderMermaid = (source: string, width: number = WIDTH_TARGET): string[] => {
    const fallback = (): string[] => [
        `${DIM}◇ mermaid${RESET}`,
        ...source.split("\n").map((line) => `${DIM}│ ${line}${RESET}`),
    ];
    const authored = renderMermaidLines(source);
    if (authored?.every((line) => displayWidth(line) <= width)) return authored;
    const vertical = verticalizeWideFlowchart(source);
    if (vertical !== source) {
        const projected = renderMermaidLines(vertical);
        if (projected?.every((line) => displayWidth(line) <= width)) return projected;
    }
    return fallback();
};

// ─── Fenced blocks ───────────────────────────────────────────────────

const renderFence = (language: string, body: string[], width: number): string[] => {
    if (language === "mermaid") return renderMermaid(body.join("\n"), width);
    const header = language.length === 0 ? `${DIM}◇${RESET}` : `${DIM}◇ ${language}${RESET}`;
    return [header, ...body.map((line) => `${DIM}│${RESET} ${line}`)];
};

// ─── The document projector ──────────────────────────────────────────

// Heuristic: body looks like markdown if it carries structural markers.
export const looksLikeMarkdown = (s: string): boolean =>
    /(^|\n)#{1,6}\s/.test(s) ||
    /\*\*[^*\n]+\*\*/.test(s) ||
    /(^|\n)[-*+]\s/.test(s) ||
    /```/.test(s) ||
    /(^|\n)\s*\|.*\|/.test(s) ||
    /\[[^\]]+\]\([^)]+\)/.test(s);

export const renderMarkdownDocument = (raw: string, width: number = WIDTH_TARGET): string => {
    const source = normalizeProse(raw);
    const lines = source.split("\n");
    const out: string[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index]!;
        const fence = /^\s*```(\S*)\s*$/.exec(line);
        if (fence !== null) {
            const body: string[] = [];
            index += 1;
            while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
                body.push(lines[index]!);
                index += 1;
            }
            index += 1; // closing fence (or end)
            out.push(...renderFence(fence[1] ?? "", body, width));
            continue;
        }
        if (isTableRow(line) && index + 1 < lines.length && isTableRule(lines[index + 1]!)) {
            const table: string[] = [];
            while (index < lines.length && (isTableRow(lines[index]!) || isTableRule(lines[index]!))) {
                table.push(lines[index]!);
                index += 1;
            }
            out.push(...renderTable(table, width));
            continue;
        }
        let prose = line;
        prose = prose.replace(/^(#{1,6})\s+(.*)$/, (_m, _h, text: string) => `${BOLD}${text}${RESET}`);
        prose = prose.replace(/^[-*+]\s/, "• ");
        out.push(renderInline(prose));
        index += 1;
    }
    return out.join("\n");
};
