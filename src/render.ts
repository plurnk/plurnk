// Glyph palette + line formatting for the TUI log waterfall.
// Glyphs per TUI.md §4 (canonical for the constellation).

export const OP_GLYPHS: Record<string, string> = {
    FIND: "🔍",
    READ: "📖",
    EDIT: "✏️ ",
    COPY: "📋",
    MOVE: "📦",
    SHOW: "➕",
    HIDE: "➖",
    SEND: "✉️ ",
    EXEC: "⚙️ ",
};

export const ORIGIN_GLYPHS: Record<string, string> = {
    model: "🤖",
    client: "👤",
    system: "⚙️ ",
    plugin: "🔌",
};

export const sendSubGlyph = (status: number): string => {
    if (status === 410) return "🗑";
    if (status === 499) return "✋";
    if (status === 102) return "⏳";
    if (status >= 200 && status < 300) return "✅";
    if (status >= 400 && status < 500) return "⚠️ ";
    if (status >= 500 && status < 600) return "🔥";
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
            if (entry.target_scheme === null) {
                return `${DIM}(broadcast)${RESET}`;
            }
            return `${DIM}→ ${entry.target_scheme}://${entry.target_pathname ?? ""}${RESET}`;
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
    target_scheme: string | null;
    target_pathname: string | null;
    target_hostname: string | null;
    target_fragment: string | null;
    status_rx: number;
    tx: unknown;
    rx: unknown;
}

// Render a log entry as one waterfall line.
// Returns the full ANSI-formatted line WITHOUT trailing newline.
export const renderLogEntry = (entry: LogEntryWire): string => {
    const origin = ORIGIN_GLYPHS[entry.origin] ?? "?";
    const opGlyph = OP_GLYPHS[entry.op] ?? "?";
    const subGlyph = entry.op === "SEND" && typeof entry.signal === "number" ? sendSubGlyph(entry.signal) : "";

    const statusColor = colorForStatus(entry.status_rx);
    const statusText = `${statusColor}${entry.status_rx}${RESET}`;

    let pathText = "";
    if (entry.target_scheme !== null) {
        const path = `${entry.target_scheme}://${entry.target_hostname ?? ""}${entry.target_pathname ?? ""}${entry.target_fragment !== null ? `#${entry.target_fragment}` : ""}`;
        pathText = `${CYAN}${path}${RESET}`;
    }

    const extra = buildExtra(entry);

    const parts = [origin, opGlyph];
    if (subGlyph.length > 0) parts.push(subGlyph);
    parts.push(statusText);
    if (pathText.length > 0) parts.push(pathText);
    if (extra.length > 0) parts.push(extra);

    return `  ${parts.join(" ")}`;
};

export const renderSummary = (turns: number, wallMs: number, tokens: number, finalStatus: number, hitMaxTurns: boolean): string => {
    const tag = hitMaxTurns ? "maxTurns" : finalStatus === 200 ? "done" : `final ${finalStatus}`;
    const ms = wallMs >= 1000 ? `${(wallMs / 1000).toFixed(2)}s` : `${wallMs}ms`;
    return `${DIM}  ${tag} · ${turns} turn${turns === 1 ? "" : "s"} · ${ms} · ${tokens} tokens${RESET}`;
};
