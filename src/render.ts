// Glyph palette + line formatting for the TUI log waterfall.
// Glyphs per TUI.md §4 (canonical for the constellation).

// Width-stable glyph palette — EVERY glyph is plain East-Asian-Wide
// (width 2 in node and every major terminal); VS16 variation-selector
// sequences (✉️ ✏️ ⚙️ ⚠️ 🗑) are banned from the palette entirely after
// two rounds of cursor-drift and column-gap forensics. No pad-space
// hacks needed: stable widths give true column alignment.
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
    PLAN: "🧠",   // the model's per-turn reasoning (grammar 0.70 leads every turn with PLAN)
};

export const ORIGIN_GLYPHS: Record<string, string> = {
    model: "🤖",
    client: "🐹",   // the user/client — the brand head (was the generic 👤)
    plurnk: "🧰",   // the runtime actor (§14.7)
    plugin: "🔌",
};

// Status → sub-glyph, aligned to the grammar's terminal SEND set
// [102, 200, 202, 300, 499] (plurnk-grammar plurnk.md) plus the directed-SEND
// and error families. Specific codes before ranges. Every glyph is EAW width-2,
// VS16-free (column-stable). The COLOR (colorForStatus) carries the class; the
// glyph carries the state. Converged with plurnk.nvim's STATUS_GLYPHS.
// Model-SEND lane-1 (operator ruling 2026-07-10): the STATE is the identity — the
// constant 🤖 retired. 102 thinking-on, 200 the answer, 202 parked, 300 a question;
// failures keep the shared error glyphs. All plane-1/EAW-wide, VS16-free.
export const modelSendGlyph = (status: number): string => {
    if (status === 102) return "💭";
    if (status === 202) return "💤";
    if (status === 300) return "🤔";
    if (status === 499) return "✋";
    if (status >= 200 && status < 300) return "💡";
    if (status >= 400 && status < 600) return "❌";
    return "💡";
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
const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";

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
    op: string;
    suffix: string;
    origin: string;
    signal: unknown;
    scheme: string | null;
    pathname: string | null;
    hostname: string | null;
    fragment: string | null;
    status_rx: number;
    tx: unknown;
    rx: unknown;
    attrs?: unknown;
    // Logical coordinate (the model's log://L/T/S address) — every wire
    // log entry carries it (loops⋈turns JOIN, plurnk-service #208).
    loop_seq: number;
    turn_seq: number;
    sequence: number;
}

// Machine acquisition is durable ambience, not a live action trace. It remains
// available through log/replay; interactive clients collapse it into the
// producer's aggregate progress signal instead of redrawing once per page.
export const isEntryMaterialization = (entry: LogEntryWire): boolean => {
    const attrs = typeof entry.attrs === "string"
        ? (() => { try { return JSON.parse(entry.attrs) as unknown; } catch { return null; } })()
        : entry.attrs;
    return entry.origin === "plurnk"
        && entry.op === "EDIT"
        && (attrs as { kind?: unknown } | null)?.kind === "entry_materialized";
};

// `01/02/03 ` coordinate label — zero-padded to two digits minimum for
// alignment zen, growing naturally past 99. Every waterfall line carries
// one (log entries from the wire, the prompt and stream lines from their
// own coordinates — §5.1). DB ids are NOT the user's loop/turn numbers.
export const coordLabel = (loopSeq: number, turnSeq: number, sequence: number): string => {
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${DIM}${p(loopSeq)}/${p(turnSeq)}/${p(sequence)}${RESET} `;
};

// The active prompt temporarily uses its fixed-width coordinate slot as an
// indexing gauge. Eight visible cells exactly match `01/01/01`; the trailing
// separator remains identical, so readline's cursor math never shifts.
export const progressLabel = (percent: number): string =>
    `${DIM}${`${Math.max(0, Math.min(100, Math.trunc(percent)))}%`.padStart(8, " ")}${RESET} `;
const coordPrefix = (entry: LogEntryWire): string =>
    coordLabel(entry.loop_seq, entry.turn_seq, entry.sequence);

const BOLD = code("1");
const ITALIC = code("3");

// Heuristic: body looks like markdown if it carries any of the structural markers.
// False positives on plain text containing isolated `*` or `_` are avoided by requiring
// paired markers or line-anchored constructs.
const looksLikeMarkdown = (s: string): boolean =>
    /(^|\n)#{1,6}\s/.test(s) ||
    /\*\*[^*\n]+\*\*/.test(s) ||
    /(^|\n)[-*+]\s/.test(s) ||
    /```/.test(s) ||
    /\[[^\]]+\]\([^)]+\)/.test(s);

// Minimal vanilla-ANSI markdown: enough to make a reply readable, not a full parser.
const renderMarkdown = (s: string): string => {
    let out = s;
    out = out.replace(/^(#{1,6})\s+(.*)$/gm, (_m, _h, text) => `${BOLD}${text}${RESET}`);
    out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => `${BOLD}${t}${RESET}`);
    out = out.replace(/(^|[^*_])[*_]([^*_\n]+)[*_](?!\*)/g, (_m, pre, t) => `${pre}${ITALIC}${t}${RESET}`);
    out = out.replace(/`([^`\n]+)`/g, (_m, t) => `${DIM}${t}${RESET}`);
    out = out.replace(/^[-*+]\s/gm, "• ");
    return out;
};

// Read a SEND body off a log_entry.tx, dispatching by content type.
// Per plurnk-grammar/schema/SendBody.json: tx.body is { raw, json } | null.
//
// prettify=true (TUI): json → pretty-print, markdown → ANSI, else raw.
// prettify=false (CLI): always raw verbatim — pretty-printing is a TUI convenience,
// not something a downstream pipe consumer should have to undo.
export const extractSendBody = (txUnknown: unknown, prettify: boolean): string => {
    const tx = txUnknown as { body?: { raw?: unknown; json?: unknown } | null } | null;
    if (tx === null || tx === undefined) return "";
    const sendBody = tx.body;
    if (sendBody === null || sendBody === undefined) return "";
    const { raw, json } = sendBody;
    if (!prettify) return typeof raw === "string" ? raw : "";
    if (json !== null && json !== undefined) return JSON.stringify(json, null, 2);
    if (typeof raw !== "string") return "";
    if (looksLikeMarkdown(raw)) return renderMarkdown(raw);
    return raw;
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

// Broadcast SEND (model → user) — multi-line block, content not telemetry.
// Per TUI.md §3.4.1 / SPEC.md §5.4. Header column-aligns with trace lines (2-space indent);
// body indents further (5 spaces) so it visually nests under the speaker.
const renderBroadcast = (entry: LogEntryWire): string => {
    // TWO lanes. The user speaking keeps the 🐹 identity + a status lane; the MODEL
    // speaking carries its state AS lane 1 (💭 102 / 💡 200 / 💤 202 / 🤔 300 —
    // operator ruling) with lane 2 held as a reserved blank.
    const signal = typeof entry.signal === "number" ? entry.signal : entry.status_rx;
    const idGlyph = entry.origin === "model" ? modelSendGlyph(signal) : (ORIGIN_GLYPHS[entry.origin] ?? "?");
    const subGlyph = entry.origin === "model" ? "  " : sendSubGlyph(signal);
    const statusText = `${colorForStatus(entry.status_rx)}${entry.status_rx}${RESET}`;

    const header = `  ${coordPrefix(entry)}${[idGlyph, subGlyph, statusText].join(" ")}`;

    const body = extractSendBody(entry.tx, /* prettify */ true);
    const multiLine = body.includes("\n");
    // Short single-line replies inline after the header (nvim's
    // BROADCAST_INLINE_LIMIT convergence); longer/multi-line bodies
    // start on the next line, indented under the speaker.
    // Single space before the body — the same separator op rows use before their
    // target, so inline SEND bodies sit in the target column, not one right of it.
    const lines = body.length === 0 ? [header]
        : !multiLine && body.length <= 80 ? [`${header} ${body}`]
        : [header, ...body.split("\n").map((l) => `     ${l}`)];

    // The model's answer (terminal SEND) is bold; everything else plain. No
    // surrounding blank lines — the bold body is the standout on its own.
    const isAnswer = entry.origin === "model" && (entry.signal === 200 || entry.signal === 499);
    return emphasizeLines(lines, isAnswer);
};

// The prompt entry (system-origin EDIT against prompt:///loop/N — the actor-
// addressing epic retired plurnk:// and closed the last id-in-pathname, svc#527;
// self-only, no authority slot). The TUI SKIPS these in the live waterfall: the
// line the user typed at the readline prompt is already their record, and rendering
// the broadcast too duplicated every prompt (#198 made it arrive live).
// Erasing the typed echo instead would mean terminal-width math over
// emoji/nerdfont prompts — the rabbit hole this client refuses to enter.
export const isPromptEntry = (entry: LogEntryWire): boolean =>
    entry.op === "EDIT" && entry.scheme === "prompt";
    // The prompt scheme is self-identifying — svc#527 gave the frame its OWN scheme
    // (prompt:///<loop>/<turn>, self-only, empty authority; verified on the wire as
    // pathname "/1/1" — "loop/N" in the docs is the loop NUMBER, not a literal). The
    // foisted user-prompt EDIT is skipped live; the readline echo is the record.

// Render a log entry as one waterfall line.
// Returns the full ANSI-formatted line(s) WITHOUT trailing newline. A
// broadcast SEND returns one striped line (single-line body) or a striped
// block (multi-line body) — no surrounding blank lines; the stripe's
// background color is the standout.
// The target URI a log entry addressed — `scheme://host/pathname#fragment`, or
// the bare pathname when scheme is null (the daemon's file:// shortcut). null
// when the entry has no path at all (a broadcast SEND). One source for both the
// waterfall render and the <<LOOK cycler — no synthesis, render what the daemon sent.
export const entryTarget = (entry: LogEntryWire): string | null => {
    if (entry.pathname === null) return null;
    return entry.scheme !== null
        ? `${entry.scheme}://${entry.hostname ?? ""}${entry.pathname}${entry.fragment !== null ? `#${entry.fragment}` : ""}`
        : entry.pathname;
};

export const renderLogEntry = (entry: LogEntryWire): string => {
    // Broadcast SEND has no path at all (both scheme AND pathname null).
    // A SEND directed at file:// would have scheme=null but pathname set —
    // not a broadcast.
    if (entry.op === "SEND" && entry.scheme === null && entry.pathname === null) return renderBroadcast(entry);

    // ONE identity/action glyph, not origin+op (they were redundant on SEND and
    // cluttered elsewhere). A SEND shows its ACTOR (🐹 you / 🤖 model — the "who's
    // speaking"); any other op shows its OP glyph (🧠/🔍/📖/📝/🔧 — self-evidently
    // the agent working). The 💬 and the origin column are both gone.
    const idGlyph = entry.op === "SEND"
        ? (entry.origin === "model" ? modelSendGlyph(typeof entry.signal === "number" ? entry.signal : entry.status_rx) : (ORIGIN_GLYPHS[entry.origin] ?? "?"))
        : (OP_GLYPHS[entry.op] ?? "?");
    // Status glyph: SENDs glyph their signal, others the outcome. Routine 2xx →
    // "  " (a width-2 blank exactly matching a glyph) so the code column NEVER
    // shifts — the status slot is always present, glyph or reserved blank.
    const subGlyph = entry.op === "SEND" && typeof entry.signal === "number"
        ? sendSubGlyph(entry.signal)
        : sendSubGlyph(entry.status_rx);

    const statusColor = colorForStatus(entry.status_rx);
    const statusText = `${statusColor}${entry.status_rx}${RESET}`;

    // Render whatever target the daemon supplied — no synthesis. If scheme
    // is null but pathname is set, that's the daemon's choice (e.g. file://
    // shortcut) and we render the bare path.
    const target = entryTarget(entry);
    const pathText = target !== null ? `${CYAN}${target}${RESET}` : "";

    const extra = buildExtra(entry);

    // Fixed columns: idGlyph · status (always present — glyph or reserved blank) ·
    // code · target · extra. subGlyph is ALWAYS pushed so the code column is stable.
    const parts = [idGlyph, subGlyph, statusText];
    if (pathText.length > 0) parts.push(pathText);
    if (extra.length > 0) parts.push(extra);

    // PLAN carries the model's reasoning as a plain string in tx.body (NOT the
    // SEND {raw,json} shape) — surface it dimmed, newlines collapsed, so the
    // waterfall shows what the model planned instead of a bare glyph.
    if (entry.op === "PLAN") {
        const planBody = (entry.tx as { body?: unknown } | null)?.body;
        if (typeof planBody === "string" && planBody.trim().length > 0) {
            parts.push(`${DIM}${planBody.replace(/\s*\n\s*/g, " ").trim()}${RESET}`);
        }
    }

    return `  ${coordPrefix(entry)}${parts.join(" ")}`;
};

export interface LoopUsage {
    promptTokens: number;
    completionTokens: number;
    costPico: number;
    // Workspace lifetime total in pico-USD — the DAEMON's authoritative cascade
    // (svc#254), pushed on the wire. The client renders it, never aggregates it
    // (runs fork + multiple clients ⇒ no client sees every turn). Staged slot.
    sessionCostPico?: number;
    // Account balance in pico-USD, when the provider reports it (svc#252). Staged.
    balancePico?: number;
    // Context-window occupancy + window, BOTH the daemon's per-loop figures. Under the
    // model-agnostic ruler (§tokenomics-agnostic-ruler, the chars/2 count that lets one
    // workspace serve many models) the daemon owns the whole budget narrative: contextTokens
    // is the agnostic occupancy, promptBudget is THIS loop's effective window (ctx capped by
    // the model's real limit). The client renders both from loop/terminated — it does NOT
    // re-derive the window per-alias (a switched model reports its own window here).
    contextTokens?: number;
    promptBudget?: number | null;
}

// Compact token count: 49152 → "49k", 980 → "980". The gauge stays terse.
const formatK = (n: number): string => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

// Context-% gauge (svc#263): `ctx 15%/49k`. Both figures are the daemon's per-loop
// usage — numerator contextTokens (agnostic occupancy), denominator promptBudget (this
// loop's effective window). Omitted — never guessed — when either is absent (a loop
// whose window the daemon can't report returns promptBudget null).
export const contextGauge = (contextTokens?: number, promptBudget?: number | null): string => {
    if (contextTokens === undefined || promptBudget === undefined || promptBudget === null || promptBudget <= 0) return "";
    const pct = Math.round((contextTokens / promptBudget) * 100);
    return ` · ctx ${pct}%/${formatK(promptBudget)}`;
};

// usage is absent for non-model ops (op.exec / op.parse have no provider
// call) — those render no token part. It is NOT a fallback for missing
// data: a model loop always carries real usage (plurnk-service #197).
// Terminal loop status → label. plurnk-service 0.42.0 split the flat 499 into
// distinct verdicts (#70): 499 is the model/actor give-up or external KILL/cancel;
// 413/429/500/508 are ENGINE verdicts the model never emits. Labelled so a
// ceiling (413/429) reads differently from an abandonment (500/508), not "final N".
export const terminalStatusLabel = (status: number): string =>
    status === 200 ? "done"
        : status === 413 ? "budget overflow"
            : status === 429 ? "turn ceiling"
                : status === 499 ? "cancelled"
                    : status === 500 ? "strike-out"
                        : status === 508 ? "loop detected"
                            : `final ${status}`;

export const renderSummary = (turns: number, wallMs: number, finalStatus: number, hitMaxTurns: boolean, usage?: LoopUsage, promptBudget?: number | null): string => {
    const tag = hitMaxTurns ? "maxTurns" : terminalStatusLabel(finalStatus);
    const ms = wallMs >= 1000 ? `${(wallMs / 1000).toFixed(2)}s` : `${wallMs}ms`;
    let tokenPart = "";
    if (usage !== undefined) {
        tokenPart = ` · ↑${usage.promptTokens} ↓${usage.completionTokens}`;
        tokenPart += contextGauge(usage.contextTokens, promptBudget);
        // Money: loop (this loop's cost) | workspace (daemon total, svc#254) |
        // remaining (account balance, svc#252). Each only when available — the
        // client renders all three, aggregates none.
        if (usage.costPico > 0) tokenPart += ` · loop $${(usage.costPico / 1e12).toFixed(4)}`;
        if (usage.sessionCostPico !== undefined) tokenPart += ` · workspace $${(usage.sessionCostPico / 1e12).toFixed(2)}`;
        if (usage.balancePico !== undefined) tokenPart += ` · remaining $${(usage.balancePico / 1e12).toFixed(2)}`;
    }
    return `${DIM}  ${tag} · ${turns} turn${turns === 1 ? "" : "s"} · ${ms}${tokenPart}${RESET}`;
};
