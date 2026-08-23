// Client-side Markdown projection for the TUI (plurnk#15, under the #21
// contract): the wire carries semantic/raw Markdown and Mermaid source; this
// module projects it for the current terminal, capped at the 80-column
// ergonomic target. Vanilla ANSI, no framework, no wire channel. The one-shot
// CLI never uses this — raw stays raw for pipes.

const supportsColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const code = (n: string): string => supportsColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const BOLD = code("1");
const ITALIC = code("3");
const CYAN = code("36");

export const WIDTH_TARGET = 80;

const displayWidth = (s: string): number => {
    let w = 0;
    for (const ch of s) {
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
        Math.max(1, ...rows.map((row) => displayWidth(row[index] ?? ""))));
    // Overhead: "│ " + " │ ".repeat + " │" → 3 per column + 1.
    const budget = () => widths.reduce((sum, w) => sum + w + 3, 1);
    while (budget() > width && Math.max(...widths) > 4) {
        widths[widths.indexOf(Math.max(...widths))] -= 1;
    }
    const line = (left: string, mid: string, right: string): string =>
        `${DIM}${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}${RESET}`;
    const cells = (row: string[], emphasize: boolean): string =>
        `${DIM}│${RESET} ${row.length === 0 ? "" : widths.map((w, index) => {
            const cell = pad(truncate(row[index] ?? "", w), w);
            return emphasize ? `${BOLD}${cell}${RESET}` : renderInline(cell);
        }).join(` ${DIM}│${RESET} `)} ${DIM}│${RESET}`;
    const out = [line("┌", "┬", "┐"), cells(rows[0] ?? [], true)];
    if (rows.length > 1) out.push(line("├", "┼", "┤"));
    for (const row of rows.slice(1)) out.push(cells(row, false));
    out.push(line("└", "┴", "┘"));
    return out;
};

// ─── Mermaid (flowchart subset) ──────────────────────────────────────

interface MermaidGraph {
    labels: Map<string, string>;
    edges: Array<{ from: string; to: string; label: string | null }>;
    order: string[];
}

const NODE = /([A-Za-z0-9_.-]+)(?:\[([^\]]*)\]|\(\(([^)]*)\)\)|\(([^)]*)\)|\{([^}]*)\})?/y;

// Parse the common flowchart subset: `graph TD` / `flowchart LR`, node
// definitions with [..] (..) {{..}} labels, and `A --> B`, `A -->|label| B`,
// including chains. Anything unrecognized returns null and the source shows.
export const parseMermaidFlowchart = (source: string): MermaidGraph | null => {
    const lines = source.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("%%"));
    if (lines.length === 0) return null;
    if (!/^(graph|flowchart)\s+(TD|TB|LR|RL|BT)$/.test(lines[0])) return null;
    const labels = new Map<string, string>();
    const order: string[] = [];
    const edges: MermaidGraph["edges"] = [];
    const see = (id: string, label: string | undefined): string => {
        if (!labels.has(id)) {
            labels.set(id, label ?? id);
            order.push(id);
        } else if (label !== undefined) {
            labels.set(id, label);
        }
        return id;
    };
    for (const line of lines.slice(1)) {
        let cursor = 0;
        let previous: string | null = null;
        for (;;) {
            NODE.lastIndex = cursor;
            const node = NODE.exec(line);
            if (node === null || node[0].length === 0) return null;
            const id = see(node[1], node[2] ?? node[3] ?? node[4] ?? node[5]);
            cursor = NODE.lastIndex;
            // The edge that led here was pushed with a placeholder target.
            if (previous !== null) edges[edges.length - 1] = { ...edges[edges.length - 1]!, to: id };
            const rest = line.slice(cursor);
            const edge = /^\s*(?:-{2,3}>|={2,3}>)(?:\|([^|]*)\|)?\s*/.exec(rest);
            if (edge === null) {
                if (rest.trim().length !== 0) return null;
                break; // this line is done; the next statement line continues the graph
            }
            edges.push({ from: id, to: id, label: edge[1]?.trim() ?? null });
            cursor += edge[0].length;
            previous = id;
        }
    }
    return { labels, edges, order };
};

const box = (label: string, width: number): string[] => {
    const text = truncate(label, width - 4);
    const inner = displayWidth(text) + 2;
    return [
        `┌${"─".repeat(inner)}┐`,
        `│ ${text} │`,
        `└${"─".repeat(inner)}┘`,
    ];
};

// Project the parsed flowchart: a simple chain becomes vertical boxes joined
// by labeled arrows; anything with branching or joining becomes a legible
// labeled edge list under the node inventory. Deterministic, width-bounded,
// honest — never a half-drawn diagram.
export const renderMermaid = (source: string, width: number = WIDTH_TARGET): string[] => {
    const graph = parseMermaidFlowchart(source);
    const fallback = (): string[] => [
        `${DIM}◇ mermaid${RESET}`,
        ...source.split("\n").map((line) => `${DIM}│ ${line}${RESET}`),
    ];
    if (graph === null) return fallback();
    const { labels, edges, order } = graph;
    const out = new Map<string, number>();
    const into = new Map<string, number>();
    for (const { from, to } of edges) {
        out.set(from, (out.get(from) ?? 0) + 1);
        into.set(to, (into.get(to) ?? 0) + 1);
    }
    const isChain = order.length > 0
        && edges.length === order.length - 1
        && order.every((id) => (out.get(id) ?? 0) <= 1 && (into.get(id) ?? 0) <= 1);
    if (isChain && edges.length > 0) {
        const lines: string[] = [];
        let id: string | undefined = order.find((candidate) => (into.get(candidate) ?? 0) === 0);
        while (id !== undefined) {
            const b = box(labels.get(id) ?? id, width);
            const boxWidth = displayWidth(b[0]!);
            lines.push(...b);
            const edge = edges.find((candidate) => candidate.from === id);
            if (edge === undefined) break;
            const stem = " ".repeat(Math.max(0, Math.floor(boxWidth / 2)));
            lines.push(`${stem}│${edge.label === null ? "" : ` ${DIM}${truncate(edge.label, width - stem.length - 2)}${RESET}`}`);
            lines.push(`${stem}▼`);
            id = edge.to;
        }
        return lines;
    }
    const lines = [`${DIM}◇ mermaid graph${RESET}`];
    for (const { from, to, label } of edges) {
        const arrow = `  ${truncate(labels.get(from) ?? from, 30)} ${CYAN}─▶${RESET} ${truncate(labels.get(to) ?? to, 30)}`;
        lines.push(label === null ? arrow : `${arrow} ${DIM}(${truncate(label, 20)})${RESET}`);
    }
    for (const id of order) {
        if ((out.get(id) ?? 0) === 0 && (into.get(id) ?? 0) === 0) lines.push(`  ${truncate(labels.get(id) ?? id, 60)}`);
    }
    return lines;
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
