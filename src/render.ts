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
};

export const ORIGIN_GLYPHS: Record<string, string> = {
    model: "🤖",
    client: "👤",
    plurnk: "🧰",   // the runtime actor (§14.7)
    plugin: "🔌",
};

export const sendSubGlyph = (status: number): string => {
    if (status === 410) return "💥";
    if (status === 499) return "✋";
    if (status === 102) return "⏳";
    if (status >= 200 && status < 300) return "✅";
    // Single failure glyph for 4xx/5xx — converged with plurnk.nvim:
    // one signal in the alignment column; the colored status carries class.
    if (status >= 400 && status < 600) return "❌";
    return "";
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
    if (status === 102 || (status >= 300 && status < 400)) return YELLOW;
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
            const results = rx !== null && typeof rx.results === "string" ? rx.results : "";
            const count = results.length === 0 ? 0 : results.split("\n").filter((l) => l.length > 0).length;
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
    // Logical coordinate (the model's log://L/T/S address) — every wire
    // log entry carries it (loops⋈turns JOIN, plurnk-service #208).
    loop_seq: number;
    turn_seq: number;
    sequence: number;
}

// `01/02/03 ` coordinate label — zero-padded to two digits minimum for
// alignment zen, growing naturally past 99. Every waterfall line carries
// one (log entries from the wire, the prompt and stream lines from their
// own coordinates — §5.1). DB ids are NOT the user's loop/turn numbers.
export const coordLabel = (loopSeq: number, turnSeq: number, sequence: number): string => {
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${DIM}${p(loopSeq)}/${p(turnSeq)}/${p(sequence)}${RESET} `;
};
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

// Conversation stripes (TUI). The true user↔model dialogue must stand
// out against operation-record lines: model speech (broadcast SEND —
// §5.4) renders on a dark-blue full-width band; the user's prompt (the
// engine writes it as a system-origin EDIT to plurnk://prompt/<loop>/<turn>,
// service SPEC §15) on dark green. 256-color picks with an explicit
// near-white foreground so the bands read on any terminal theme;
// `\x1b[K` (background-color-erase) paints each line to the right edge
// without needing the terminal width.
const MODEL_STRIPE = code("48;5;17") + code("38;5;254");
const USER_STRIPE = code("48;5;22") + code("38;5;254");
const ERASE_EOL = useColor ? "\x1b[K" : "";

// Re-arm the stripe after every inner RESET (status colors, markdown
// styling) so a styled span can't cut the band mid-line.
const stripeLines = (lines: string[], stripe: string): string => {
    if (stripe.length === 0) return lines.join("\n");
    return lines
        .map((l) => `${stripe}${l.split(RESET).join(RESET + stripe)}${ERASE_EOL}${RESET}`)
        .join("\n");
};

// Broadcast SEND (model → user) — multi-line block, content not telemetry.
// Per TUI.md §3.4.1 / SPEC.md §5.4. Header column-aligns with trace lines (2-space indent);
// body indents further (5 spaces) so it visually nests under the speaker.
const renderBroadcast = (entry: LogEntryWire): string => {
    const origin = ORIGIN_GLYPHS[entry.origin] ?? "?";
    const opGlyph = OP_GLYPHS.SEND;
    const subGlyph = typeof entry.signal === "number" ? sendSubGlyph(entry.signal) : "";
    const statusColor = colorForStatus(entry.status_rx);
    const statusText = `${statusColor}${entry.status_rx}${RESET}`;

    const headerParts = [origin, opGlyph];
    if (subGlyph.length > 0) headerParts.push(subGlyph);
    headerParts.push(statusText);
    const header = `  ${coordPrefix(entry)}${headerParts.join(" ")}`;

    const body = extractSendBody(entry.tx, /* prettify */ true);
    const multiLine = body.includes("\n");
    // Short single-line replies inline after the header (nvim's
    // BROADCAST_INLINE_LIMIT convergence); longer/multi-line bodies
    // start on the next line, indented under the speaker.
    const lines = body.length === 0 ? [header]
        : !multiLine && body.length <= 80 ? [`${header}  ${body}`]
        : [header, ...body.split("\n").map((l) => `     ${l}`)];

    const stripe = entry.origin === "model" ? MODEL_STRIPE
        : entry.origin === "client" ? USER_STRIPE : "";
    // No surrounding blank lines: the stripe (full-width background color)
    // is the standout — a broadcast reads as conversation whether single-
    // or multi-line. Blank-wrapping every turn-terminator SEND (the model
    // SENDs once per turn, 102 to continue) just padded the waterfall with
    // empty lines between operations.
    return stripeLines(lines, stripe);
};

// The prompt entry (system-origin EDIT against plurnk://prompt/<loop>/<turn>,
// service SPEC §15). The TUI SKIPS these in the live waterfall: the line the
// user typed at the readline prompt is already their record, and rendering
// the broadcast too duplicated every prompt (#198 made it arrive live).
// Erasing the typed echo instead would mean terminal-width math over
// emoji/nerdfont prompts — the rabbit hole this client refuses to enter.
export const isPromptEntry = (entry: LogEntryWire): boolean =>
    entry.op === "EDIT" && entry.scheme === "plurnk" && (entry.pathname ?? "").startsWith("prompt/");

// Render a log entry as one waterfall line.
// Returns the full ANSI-formatted line(s) WITHOUT trailing newline. A
// broadcast SEND returns one striped line (single-line body) or a striped
// block (multi-line body) — no surrounding blank lines; the stripe's
// background color is the standout.
export const renderLogEntry = (entry: LogEntryWire): string => {
    // Broadcast SEND has no path at all (both scheme AND pathname null).
    // A SEND directed at file:// would have scheme=null but pathname set —
    // not a broadcast.
    if (entry.op === "SEND" && entry.scheme === null && entry.pathname === null) return renderBroadcast(entry);

    const origin = ORIGIN_GLYPHS[entry.origin] ?? "?";
    const opGlyph = OP_GLYPHS[entry.op] ?? "?";
    // Universal status glyph — every line gets one (rummy f20c4a0 / nvim
    // convergence; a check that exists only sometimes is dissonant).
    // SENDs glyph their signal (✋/💥/⏳ carry meaning); everything else
    // glyphs the outcome status.
    const subGlyph = entry.op === "SEND" && typeof entry.signal === "number"
        ? sendSubGlyph(entry.signal)
        : sendSubGlyph(entry.status_rx);

    const statusColor = colorForStatus(entry.status_rx);
    const statusText = `${statusColor}${entry.status_rx}${RESET}`;

    // Render whatever target the daemon supplied — no synthesis. If scheme
    // is null but pathname is set, that's the daemon's choice (e.g. file://
    // shortcut) and we render the bare path.
    let pathText = "";
    if (entry.pathname !== null) {
        const path = entry.scheme !== null
            ? `${entry.scheme}://${entry.hostname ?? ""}${entry.pathname}${entry.fragment !== null ? `#${entry.fragment}` : ""}`
            : entry.pathname;
        pathText = `${CYAN}${path}${RESET}`;
    }

    const extra = buildExtra(entry);

    const parts = [origin, opGlyph];
    if (subGlyph.length > 0) parts.push(subGlyph);
    parts.push(statusText);
    if (pathText.length > 0) parts.push(pathText);
    if (extra.length > 0) parts.push(extra);

    return `  ${coordPrefix(entry)}${parts.join(" ")}`;
};

export interface LoopUsage {
    promptTokens: number;
    completionTokens: number;
    costPico: number;
}

// usage is absent for non-model ops (op.exec / op.parse have no provider
// call) — those render no token part. It is NOT a fallback for missing
// data: a model loop always carries real usage (plurnk-service #197).
export const renderSummary = (turns: number, wallMs: number, finalStatus: number, hitMaxTurns: boolean, usage?: LoopUsage): string => {
    const tag = hitMaxTurns ? "maxTurns" : finalStatus === 200 ? "done" : `final ${finalStatus}`;
    const ms = wallMs >= 1000 ? `${(wallMs / 1000).toFixed(2)}s` : `${wallMs}ms`;
    let tokenPart = "";
    if (usage !== undefined) {
        tokenPart = ` · ↑${usage.promptTokens} ↓${usage.completionTokens}`;
        if (usage.costPico > 0) tokenPart += ` · $${(usage.costPico / 1e12).toFixed(4)}`;
    }
    return `${DIM}  ${tag} · ${turns} turn${turns === 1 ? "" : "s"} · ${ms}${tokenPart}${RESET}`;
};
