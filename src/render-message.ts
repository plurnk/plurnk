import { TurnDisposition } from "@plurnk/plurnk-contracts";
import { ansi as code } from "./color.ts";
import { looksLikeMarkdown, renderMarkdownDocument } from "./markdown.ts";
import ModelText from "./model-text.ts";
import {
    entryAside, extractSendBody, isArrivalEntry, isResponseMessage,
    objectOf, outcomeTitle, renderOperationRow,
    type LogEntryWire, type RowOverride,
} from "./render.ts";

const RESET = code("0");
const BOLD = code("1");
const DIM = code("2");
const ITALIC = code("3");
const GREEN = code("32");
const PINK = code("95");

// Rich interpretation belongs to the TUI, never shared CLI extraction.
export const renderSendBody = (txUnknown: unknown, viewport = process.stdout.columns ?? 80): string => {
    const tx = txUnknown as { body?: string | { json?: unknown } | null } | null;
    const json = typeof tx?.body === "object" ? tx.body?.json : undefined;
    if (json !== null && json !== undefined) return JSON.stringify(json, null, 2);
    const prose = ModelText.plain(extractSendBody(txUnknown)).replaceAll("$\\rightarrow$", "→");
    return looksLikeMarkdown(prose) ? renderMarkdownDocument(prose, viewport) : prose;
};

// Bold delivered model response messages; other operation records stay plain.
// Re-arm BOLD after every inner
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

// The lead line of a delivered response block: no keyword. A blank line stands where the keyword
// was; a failure puts its Problem title there in pink, a deferred or joined completion its
// `detail`; the sanitized aside follows either.
const leadLine = (entry: LogEntryWire, detail: boolean): string => {
    const parts: string[] = [];
    const rx = objectOf(entry.rx);
    if (entry.status_rx >= 400 && !(isResponseMessage(entry) && rx?.problem == null)) parts.push(`${PINK}${ModelText.plain(outcomeTitle(entry) ?? String(entry.status_rx))}${RESET}`);
    else if (detail && entry.status_rx !== 200 && typeof rx?.detail === "string" && rx.detail.length > 0) parts.push(ModelText.plain(rx.detail));
    const aside = entryAside(entry);
    if (aside !== null) parts.push(`${DIM}${ITALIC}${aside}${RESET}`);
    return parts.join(" ");
};

// Targetless SEND: the message block. The lead line, then the body with its Markdown at
// column zero ({§cli-broadcast-send-rendering}); a delivered response is bold.
const renderBroadcast = (entry: LogEntryWire, columns: number, body = renderSendBody(entry.tx, Math.max(1, columns))): string => {
    const lead = leadLine(entry, TurnDisposition.isOp(entry.op));
    const lines = body.length === 0 ? [lead] : [lead, ...body.split("\n")];
    return emphasizeLines(lines, isResponseMessage(entry));
};

// An arrival from another actor: SEND with the sender where a target would sit, then the
// body block, never emphasized (emphasis marks this worker's own delivered responses).
const renderArrival = (entry: LogEntryWire, columns: number): string => {
    const sender = typeof entry.source === "string" ? ` (${ModelText.plain(entry.source)})` : "";
    const lead = `${BOLD}${GREEN}SEND${RESET}${sender}`;
    const body = renderSendBody(entry.tx, Math.max(1, columns));
    return body.length === 0 ? lead : `${lead}\n${body}`;
};

// Render a log entry for the waterfall WITHOUT a trailing newline. A disposition renders
// its outcome, an arrival its sender and block, a conversation reply its block, every other
// operation one literal row.
export const renderLogEntry = (
    entry: LogEntryWire,
    columns: number = process.stdout.columns ?? 80,
    override?: RowOverride,
): string => {
    if (isResponseMessage(entry)) return renderBroadcast(entry, columns);
    if (TurnDisposition.isOp(entry.op)) {
        const rx = objectOf(entry.rx);
        const detail = typeof rx?.detail === "string" ? rx.detail : null;
        return renderOperationRow(entry, { failure: rx?.problem == null ? detail : outcomeTitle(entry) });
    }
    if (isArrivalEntry(entry)) return renderArrival(entry, columns);
    if (entry.op === "SEND" && entry.scheme === null && entry.pathname === null) return renderBroadcast(entry, columns);
    return renderOperationRow(entry, override);
};
