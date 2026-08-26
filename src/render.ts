// Glyph palette + line formatting for the TUI log waterfall.
// Glyphs per TUI.md §4 (canonical for the constellation).

import { colorEnabled } from "./color.ts";
import { stripVTControlCharacters } from "node:util";
import { displayWidth, looksLikeMarkdown, renderMarkdownDocument } from "./markdown.ts";
import type { OperationResult } from "@plurnk/plurnk-contracts";
import { presentPlan } from "./plan.ts";

// Operation glyphs are plain East-Asian-Wide so their secondary fields align.
// SEND lifecycle glyphs are left-anchored append-only output and may use a
// standard variation sequence: no cursor or shared-column arithmetic follows.
export const OP_GLYPHS: Record<string, string> = {
    FIND: "🔍",
    READ: "📖",
    EDIT: "📝",
    COPY: "📋",
    MOVE: "📦",
    SHOW: "➕",
    HIDE: "➖",
    OPEN: "➕",
    FOLD: "➖",
    SEND: "💬",
    EXEC: "🔧",
    BARE: "🔮",
};

export const ORIGIN_GLYPHS: Record<string, string> = {
    model: "🤖",
    client: "❯",
    _plurnk: "🧰",
    plugin: "🔌",
};

// Status → sub-glyph, aligned to the grammar's terminal SEND set
// [102, 200, 202, 300, 499] (plurnk-grammar plurnk.md) plus the directed-SEND
// and error families. Specific codes before ranges. Every glyph is EAW width-2,
// VS16-free (column-stable). The COLOR (colorForStatus) carries the class; the
// glyph carries the state. Converged with plurnk.nvim's STATUS_GLYPHS.
// A SEND's lifecycle is its one human-facing identity. Numeric SEND codes
// remain wire truth but do not repeat beside these glyphs in the waterfall.
export const sendLifecycleGlyph = (status: number): string => {
    if (status === 102) return "▶️";
    if (status === 202) return "💤";
    if (status === 300) return "🤔";
    if (status === 499) return "✋";
    if (status >= 200 && status < 300) return "⏹️";
    if (status >= 400 && status < 600) return "❌";
    return "⏹️";
};

export const sendSubGlyph = (status: number): string => {
    if (status === 102) return "⏳";   // continuing — more turns coming
    if (status === 202) return "💤";   // parked/waiting on an external event
    if (status === 300) return "🤔";   // needs a decision (multiple choices)
    if (status === 410) return "💥";   // directed SEND to a gone resource
    if (status === 499) return "✋";   // failed / aborted / cancelled
    // Routine success (2xx) badges NOTHING — a check on every row is noise; leave
    // the slot empty. Two blanks keep the width-2 column so `code` stays aligned.
    if (status >= 200 && status < 300) return "  ";
    // Single failure glyph for 4xx/5xx — the colored status carries 4xx vs 5xx.
    if (status >= 400 && status < 600) return "❌";
    return "  ";   // reserve the slot — never a bare, width-shifting empty string
};

// ANSI escape codes. NO_COLOR support per Unix convention.
const useColor = colorEnabled();

const code = (n: string): string => useColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const CYAN = code("36");
const GREEN = code("32");
const YELLOW = code("33");
const RED = code("31");
const BRIGHT_RED = code("1;31");

const colorForStatus = (status: number): string => {
    // In-progress / parked / needs-decision share yellow (attention, not done);
    // 202 is explicitly NOT green — parked ≠ success (aligns with the 💤 glyph).
    if (status === 102 || status === 202 || (status >= 300 && status < 400)) return YELLOW;
    if (status >= 200 && status < 300) return GREEN;
    if (status >= 400 && status < 500) return RED;
    if (status >= 500 && status < 600) return BRIGHT_RED;
    return "";
};

const ellipsize = (s: string, max: number): string => {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
};

// Build the EXTRA segment based on the op + entry shape.
const buildExtra = (entry: LogEntryWire): string => {
    const tx = entry.tx as { op?: string; body?: unknown; signal?: unknown; path?: unknown } | null;
    const rx = entry.rx as Record<string, unknown> | null;
    if (tx === null) return "";

    switch (entry.op) {
        case "EDIT": {
            const body = typeof tx.body === "string" ? tx.body : "";
            return body.length > 0 ? `${DIM}"${ellipsize(body.replace(/\n/g, " "), 40)}"${RESET}` : "";
        }
        case "COPY":
        case "MOVE": {
            const body = tx.body as { raw?: string } | null;
            if (body === null) return `${DIM}(deleted)${RESET}`;
            return `${DIM}→ ${body.raw ?? ""}${RESET}`;
        }
        case "FIND": {
            // rx.results is an ARRAY of matches on the current wire (uniform
            // matcher, svc#286; client #129 — the old string read printed
            // "0 results" against a 33-item rx). Older stored rows replayed via
            // log hydration still carry the newline-joined string — count both
            // known shapes, never re-derive from content.
            const raw = rx?.results;
            const count = Array.isArray(raw) ? raw.length
                : typeof raw === "string" && raw.length > 0 ? raw.split("\n").filter((l) => l.length > 0).length
                : 0;
            return `${DIM}→ ${count} result${count === 1 ? "" : "s"}${RESET}`;
        }
        case "READ": {
            const content = rx !== null && typeof rx.content === "string" ? rx.content : "";
            return content.length > 0 ? `${DIM}"${ellipsize(content.replace(/\n/g, " "), 40)}"${RESET}` : "";
        }
        case "SEND": {
            // Broadcast (scheme === null) is handled by renderBroadcast — not reached here.
            return `${DIM}→ ${entry.scheme}://${entry.pathname ?? ""}${RESET}`;
        }
        case "EXEC": {
            const body = typeof tx.body === "string" ? tx.body : "";
            return body.length > 0 ? `${DIM}"${ellipsize(body.replace(/\n/g, " "), 40)}"${RESET}` : "";
        }
        default:
            return "";
    }
};

export interface LogEntryWire {
    id: number;
    worker_id?: number;
    op: string;
    suffix: string;
    origin: string;
    signal: unknown;
    scheme: string | null;
    pathname: string | null;
    hostname: string | null;
    fragment: string | null;
    lineMarker: { marks: Array<number | string> } | null;
    status_rx: number;
    tx: unknown;
    rx: unknown;
    attrs?: unknown;
    tags: string[];
    // Logical coordinate (the model's log://L/T/S address) — every wire
    // log entry carries it (loops⋈turns JOIN, plurnk-service #208).
    loop_seq: number;
    turn_seq: number;
    sequence: number;
}

export const entryAnnotation = (entry: LogEntryWire): string | null => {
    const tx = typeof entry.tx === "string"
        ? (() => { try { return JSON.parse(entry.tx) as unknown; } catch { return null; } })()
        : entry.tx;
    const raw = tx !== null && typeof tx === "object"
        ? (tx as { annotation?: unknown }).annotation
        : null;
    if (typeof raw !== "string") return null;
    const plain = stripVTControlCharacters(raw)
        .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    return plain.length === 0 ? null : plain;
};

// Machine acquisition is durable ambience, not a live action trace. It remains
// available through log/replay; interactive clients collapse it into the
// producer's aggregate progress signal instead of redrawing once per page.
export const isEntryMaterialization = (entry: LogEntryWire): boolean => {
    const attrs = typeof entry.attrs === "string"
        ? (() => { try { return JSON.parse(entry.attrs) as unknown; } catch { return null; } })()
        : entry.attrs;
    return entry.origin === "_plurnk"
        && entry.op === "EDIT"
        && (attrs as { kind?: unknown } | null)?.kind === "entry_materialized";
};

// Human output carries no coordinate gutter. Coordinates remain forensic
// truth on the wire and in --json; this label survives for machine-adjacent
// surfaces that still want one.
export const coordLabel = (loopSeq: number, turnSeq: number, sequence: number): string => {
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${DIM}${p(loopSeq)}/${p(turnSeq)}/${p(sequence)}${RESET} `;
};

// The active prompt only represents progress below completion in three cells.
export const progressLabel = (percent: number): string =>
    `${DIM}${`${Math.max(0, Math.min(99, Math.trunc(percent)))}%`.padStart(3, " ")}${RESET}`;

// SEND lifecycle glyphs carry the human state without repeating protocol codes.
// Non-SEND failures retain their exact code because it remains useful diagnosis.
// Every status remains exact on the wire and in JSON.
export const statusCodeVisible = (entry: Pick<LogEntryWire, "op" | "status_rx" | "scheme" | "pathname">): boolean =>
    entry.status_rx >= 400
    && (entry.op !== "SEND" || entry.scheme !== null || entry.pathname !== null);

const BOLD = code("1");
const ITALIC = code("3");
void ITALIC;

// A common model-authored inline-math spelling with an exact terminal glyph.
// This is typographic normalization, not a claim of general LaTeX support.
const normalizeProse = (s: string): string => s.replaceAll("$\\rightarrow$", "→");

// Read a SEND body off a log_entry.tx, dispatching by content type.
// Per plurnk-grammar/schema/SendBody.json: tx.body is { raw, json } | null.
//
// prettify=true (TUI): json → pretty-print, markdown → ANSI, else raw.
// prettify=false (CLI): always raw verbatim — pretty-printing is a TUI convenience,
// not something a downstream pipe consumer should have to undo.
export const extractSendBody = (
    txUnknown: unknown,
    prettify: boolean,
    viewport: number = process.stdout.columns ?? 80,
): string => {
    const tx = txUnknown as { body?: { raw?: unknown; json?: unknown } | null } | null;
    if (tx === null || tx === undefined) return "";
    const sendBody = tx.body;
    if (sendBody === null || sendBody === undefined) return "";
    const { raw, json } = sendBody;
    if (!prettify) return typeof raw === "string" ? raw : "";
    if (json !== null && json !== undefined) return JSON.stringify(json, null, 2);
    if (typeof raw !== "string") return "";
    const prose = normalizeProse(raw);
    // GFM and Mermaid project through the terminal renderer at the caller's
    // current available width (plurnk#15).
    if (looksLikeMarkdown(prose)) return renderMarkdownDocument(prose, viewport);
    return prose;
};

// Provider reasoning is neither PLAN nor speech. Give it one quiet visual lane
// without inventing a log coordinate or status it does not own.
export const renderReasoning = (content: string): string => content
    .split("\n")
    .map((line, index) => `${index === 0 ? "💭 " : "   "}${DIM}${line}${RESET}`)
    .join("\n");

export interface ReasoningFrame {
    committed: string[];
    tail: string | null;
}

// A growing reasoning transcript without multiline cursor ownership. Explicit
// newlines and terminal-width rows become immutable scrollback; only the final
// incomplete row remains replaceable above readline's prompt. Keep two spare
// terminal cells so a tail never triggers an implicit wrap that readline cannot
// account for.
export const renderReasoningFrame = (content: string, columns: number = 80): ReasoningFrame => {
    if (content.length === 0) return { committed: [], tail: null };
    const capacity = Math.max(8, columns - 5);
    const rows: string[] = [];
    let row = "";
    let width = 0;
    for (const ch of content) {
        if (ch === "\n") {
            rows.push(row);
            row = "";
            width = 0;
            continue;
        }
        const nextWidth = displayWidth(ch);
        if (row.length > 0 && width + nextWidth > capacity) {
            rows.push(row);
            row = "";
            width = 0;
        }
        row += ch;
        width += nextWidth;
    }
    const hasTail = !content.endsWith("\n");
    const format = (value: string, index: number): string =>
        `${index === 0 ? "💭 " : "   "}${DIM}${value}${RESET}`;
    const committed = rows.map(format);
    return {
        committed,
        tail: hasTail ? format(row, rows.length) : null,
    };
};

// Bold the model's ANSWER. The model's terminal SEND (200 done / 499 cancelled
// — a signal, not a directed target) is its reply to the user; its body renders
// BOLD so it stands out against the operation-record grid. Intermediate 102
// "continue" pings and non-model SENDs stay plain. Re-arm BOLD after every inner
// RESET (markdown spans, status color) so a styled span can't cut the bold
// mid-line. No background band: background-color-erase (\x1b[K) isn't universal,
// so a full-width green stripe rendered jagged on terminals without it — bold is
// width-independent and works on every terminal.
const emphasizeLines = (lines: string[], on: boolean): string => {
    if (!on || BOLD.length === 0) return lines.join("\n");
    return lines
        .map((l) => `${BOLD}${l.split(RESET).join(RESET + BOLD)}${RESET}`)
        .join("\n");
};

// Broadcast SEND (model → user) — multi-line block, content rather than a Notice.
// Per TUI.md §3.4.1 / SPEC.md §5.4. The lifecycle glyph begins at column zero;
// continuation body lines nest under its following separator.
const renderBroadcast = (entry: LogEntryWire, columns: number): string => {
    const signal = typeof entry.signal === "number" ? entry.signal : entry.status_rx;
    const idGlyph = sendLifecycleGlyph(signal);

    const annotation = entryAnnotation(entry);
    const header = idGlyph
        + (annotation === null ? "" : ` ${DIM}— ${annotation}${RESET}`);

    const body = extractSendBody(entry.tx, /* prettify */ true, Math.max(1, columns - 3));
    const multiLine = body.includes("\n");
    // Short single-line replies inline after the header (nvim's
    // BROADCAST_INLINE_LIMIT convergence); longer/multi-line bodies
    // start on the next line, indented under the speaker.
    // Single space before the body — the same separator op rows use before their
    // target, so inline SEND bodies sit in the target column, not one right of it.
    const inlineCapacity = Math.max(0, columns - displayWidth(header) - 1);
    const lines = body.length === 0 ? [header]
        : !multiLine && displayWidth(body) <= inlineCapacity ? [`${header} ${body}`]
        : [header, ...body.split("\n").map((l) => `   ${l}`)];

    // The model's answer (terminal SEND) is bold; everything else plain. No
    // surrounding blank lines — the bold body is the standout on its own.
    const isAnswer = entry.origin === "model" && (entry.signal === 200 || entry.signal === 499);
    return emphasizeLines(lines, isAnswer);
};

const renderPlan = (entry: LogEntryWire): string => {
    // A routine PLAN carries no status code (plurnk#21); a failed one keeps
    // its error code and glyph on the first row.
    const status = String(entry.status_rx);
    const failed = entry.status_rx >= 400;
    const firstSlot = failed ? `${sendSubGlyph(entry.status_rx)} ${colorForStatus(entry.status_rx)}${status}${RESET} ` : "";
    const laterSlot = failed ? `${" ".repeat(3 + status.length + 1)}` : "";
    const note = entryAnnotation(entry);
    const presented = presentPlan(entry.tx);
    const rows = presented.length === 0
        ? [{ glyph: "📭", text: "no entries" }]
        : presented;

    return rows.map(({ glyph, text }, index) => {
        const prefix = index === 0
            ? `${glyph} ${firstSlot}`
            : `${glyph} ${laterSlot}`;
        const annotation = index === 0 && note !== null ? ` ${DIM}— ${note}${RESET}` : "";
        return `${prefix}${DIM}${text}${RESET}${annotation}`;
    }).join("\n");
};

// The TUI skips actionless prompt rows in the live waterfall: the line the
// user typed at the readline prompt is already their record, and rendering
// the broadcast too would duplicate every prompt.
// Erasing the typed echo instead would mean terminal-width math over
// emoji/nerdfont prompts — the rabbit hole this client refuses to enter.
export const isPromptEntry = (entry: LogEntryWire): boolean =>
    entry.op === "prompt" && entry.scheme === "prompt";

// Render a log entry as one waterfall line.
// Returns the full ANSI-formatted line(s) WITHOUT trailing newline. A
// broadcast SEND returns one striped line (single-line body) or a striped
// block (multi-line body) — no surrounding blank lines; the stripe's
// background color is the standout.
// The target URI a log entry addressed — `scheme://host/pathname#fragment`, or
// the bare pathname when scheme is null (the daemon's file:// shortcut). null
// when the entry has no path at all (a broadcast SEND). One source for both the
// waterfall render and the LOOK cycler — no synthesis, render what the daemon sent.
export const entryTarget = (entry: LogEntryWire): string | null => {
    if (entry.pathname === null) return null;
    return entry.scheme !== null
        ? `${entry.scheme}://${entry.hostname ?? ""}${entry.pathname}${entry.fragment !== null ? `#${entry.fragment}` : ""}`
        : entry.pathname;
};

export const entryScope = (entry: LogEntryWire): string | null =>
    entry.lineMarker === null ? null : `<${entry.lineMarker.marks.join(",")}>`;

export const renderLogEntry = (
    entry: LogEntryWire,
    columns: number = process.stdout.columns ?? 80,
): string => {
    // Broadcast SEND has no path at all (both scheme AND pathname null).
    // A SEND directed at file:// would have scheme=null but pathname set —
    // not a broadcast.
    if (entry.op === "SEND" && entry.scheme === null && entry.pathname === null) return renderBroadcast(entry, columns);
    if (entry.op === "PLAN") return renderPlan(entry);

    // ONE identity/action glyph, not origin+op (they were redundant on SEND and
    // cluttered elsewhere). A SEND shows its lifecycle; any other op shows its
    // OP glyph (🧠/🔍/📖/📝/🔧 — self-evidently
    // the agent working). The 💬 and the origin column are both gone.
    const idGlyph = entry.op === "SEND"
        ? sendLifecycleGlyph(typeof entry.signal === "number" ? entry.signal : entry.status_rx)
        : (OP_GLYPHS[entry.op] ?? "?");
    // Operation rows retain an outcome slot. SEND rows use only their lifecycle
    // glyph: adding a second state and numeric code repeats one fact.
    const subGlyph = sendSubGlyph(entry.status_rx);

    const statusColor = colorForStatus(entry.status_rx);
    const statusText = statusCodeVisible(entry) ? `${statusColor}${entry.status_rx}${RESET}` : "";

    // Render whatever target the daemon supplied — no synthesis. If scheme
    // is null but pathname is set, that's the daemon's choice (e.g. file://
    // shortcut) and we render the bare path.
    const target = entryTarget(entry);
    const pathText = target !== null ? `${CYAN}${target}${RESET}` : "";
    const scope = entryScope(entry);
    const scopeText = scope !== null ? `${CYAN}${scope}${RESET}` : "";

    const extra = buildExtra(entry);

    const parts = entry.op === "SEND" ? [idGlyph] : [idGlyph, subGlyph];
    if (statusText.length > 0) parts.push(statusText);
    if (pathText.length > 0) parts.push(pathText);
    if (scopeText.length > 0) parts.push(scopeText);
    if (extra.length > 0) parts.push(extra);
    const annotation = entryAnnotation(entry);
    if (annotation !== null) parts.push(`${DIM}— ${annotation}${RESET}`);

    return parts.join(" ");
};

export interface LoopUsage {
    // A deliberately narrow projection of the contracts-owned accounting schema.
    // This client renders aggregate input/output and exact USD without becoming a
    // second schema or accounting implementation; JSON output preserves the whole
    // envelope received from plurnk.terminated.
    accounting: {
        requests: readonly unknown[];
        usage: {
            inputTokens?: number;
            outputTokens?: number;
        } | null;
        costUsd: string | null;
    };
    // The daemon reports curation pressure and physical request occupancy as two
    // independent gauges. The client renders them verbatim and never compares
    // model-independent weight with provider tokens.
    curationWeight: number | null;
    curationBudget: number | null;
    contextTokens: number | null;
    contextCapacity: number | null;
    meta: Record<string, unknown>;
}

// Compact token count: 49152 → "49k", 980 → "980". The gauge stays terse.
const formatK = (n: number): string => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

const gauge = (label: "cur" | "ctx", used?: number | null, capacity?: number | null): string => {
    if (used === undefined || used === null
        || capacity === undefined || capacity === null || capacity <= 0) return "";
    const pct = Math.round((used / capacity) * 100);
    return ` · ${label} ${pct}%/${formatK(capacity)}`;
};

export const curationGauge = (weight?: number | null, budget?: number | null): string =>
    gauge("cur", weight, budget);

export const contextGauge = (tokens?: number | null, capacity?: number | null): string =>
    gauge("ctx", tokens, capacity);

// usage is absent for non-model ops (op.exec / op.parse have no provider
// call) — those render no token part. It is NOT a fallback for missing
// data: a model loop always carries real usage (plurnk-service #197).
const STRIKE_THRESHOLD = "https://problems.plurnk.xyz/engine/rails/strike-threshold";
const INVALID_EMISSION_EXHAUSTED = "https://problems.plurnk.xyz/engine/generation/invalid-emission-exhausted";

// The status class is not the verdict. Preserve the exact terminal Problem so
// unrelated engine failures do not masquerade as rail strike-outs.
export const terminalStatusLabel = (result: OperationResult): string => {
    const status = result.status ?? 0;
    if (status === 500) {
        if (result.problem?.type === STRIKE_THRESHOLD) return "strike-out";
        if (result.problem?.type === INVALID_EMISSION_EXHAUSTED) return "invalid emission";
        return "failed";
    }
    return status === 200 ? "done"
        : status === 413 ? "budget overflow"
            : status === 429 ? "turn ceiling"
                : status === 499 ? "cancelled"
                    : status === 508 ? "loop detected"
                        : `final ${status}`;
};

const isZeroDecimal = (value: string): boolean => /^0(?:\.0+)?$/.test(value);

export const renderSummary = (turns: number, wallMs: number, result: OperationResult, hitMaxTurns: boolean, usage?: LoopUsage): string => {
    const tag = hitMaxTurns ? "maxTurns" : terminalStatusLabel(result);
    const ms = wallMs >= 1000 ? `${(wallMs / 1000).toFixed(2)}s` : `${wallMs}ms`;
    let tokenPart = "";
    if (usage !== undefined) {
        const aggregate = usage.accounting.usage;
        tokenPart = ` · ↑${aggregate?.inputTokens ?? "?"} ↓${aggregate?.outputTokens ?? "?"}`;
        tokenPart += curationGauge(usage.curationWeight, usage.curationBudget);
        tokenPart += contextGauge(usage.contextTokens, usage.contextCapacity);
        const costUsd = usage.accounting.costUsd;
        if (costUsd !== null && !isZeroDecimal(costUsd)) {
            tokenPart += ` · loop $${costUsd}`;
        }
    }
    return `${DIM}  ${tag} · ${turns} turn${turns === 1 ? "" : "s"} · ${ms}${tokenPart}${RESET}`;
};
