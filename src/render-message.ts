import { TurnDisposition } from "@plurnk/plurnk-contracts";
import { paint } from "./color.ts";
import { looksLikeMarkdown, renderMarkdownDocument } from "./markdown.ts";
import ModelText from "./model-text.ts";
import {
    entryAside, extractSendBody, isArrivalEntry, isResponseMessage,
    objectOf, outcomeTitle, renderOperationRow,
    type LogEntryWire, type RowOverride,
} from "./render.ts";

// Rich interpretation belongs to the TUI, never shared CLI extraction.
export const renderSendBody = (txUnknown: unknown, viewport = process.stdout.columns ?? 80): string => {
    const tx = txUnknown as { body?: string | { json?: unknown } | null } | null;
    const json = typeof tx?.body === "object" ? tx.body?.json : undefined;
    if (json !== null && json !== undefined) return JSON.stringify(json, null, 2);
    const prose = ModelText.plain(extractSendBody(txUnknown)).replaceAll("$\\rightarrow$", "→");
    return looksLikeMarkdown(prose) ? renderMarkdownDocument(prose, viewport) : prose;
};

// The lead line of a delivered response block: no keyword. A blank line stands where the keyword
// was; a failure puts its Problem title there in red, a deferred or joined completion its
// `detail`; the sanitized aside follows either.
const leadLine = (entry: LogEntryWire, detail: boolean): string => {
    const parts: string[] = [];
    const rx = objectOf(entry.rx);
    if (entry.status_rx >= 400 && !(isResponseMessage(entry) && rx?.problem == null)) parts.push(paint(ModelText.plain(outcomeTitle(entry) ?? String(entry.status_rx)), "failure"));
    else if (detail && entry.status_rx !== 200 && typeof rx?.detail === "string" && rx.detail.length > 0) parts.push(ModelText.plain(rx.detail));
    const aside = entryAside(entry);
    if (aside !== null) parts.push(paint(aside, "dim", "italic"));
    return parts.join(" ");
};

// Targetless SEND: the message block. The lead line, then the body with its Markdown at
// column zero ({§cli-broadcast-send-rendering}). The block is plain: its Markdown carries the
// only emphasis, and the human's own line is what sets the two voices apart.
const renderBroadcast = (entry: LogEntryWire, columns: number, body = renderSendBody(entry.tx, Math.max(1, columns))): string => {
    const lead = leadLine(entry, TurnDisposition.isOp(entry.op));
    return body.length === 0 ? lead : `${lead}\n${body}`;
};

// An arrival from another actor: SEND with the sender where a target would sit, then the
// same plain body block.
const renderArrival = (entry: LogEntryWire, columns: number): string => {
    const sender = typeof entry.source === "string" ? ` (${ModelText.plain(entry.source)})` : "";
    const lead = `${paint("SEND", "bold", "success")}${sender}`;
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
    if (TurnDisposition.isOp(entry.op) || entry.op === "KILL" && objectOf(entry.tx)?.target === null) {
        const rx = objectOf(entry.rx);
        const detail = typeof rx?.detail === "string" ? rx.detail : null;
        return renderOperationRow(entry, { failure: rx?.problem == null ? detail : outcomeTitle(entry) });
    }
    if (isArrivalEntry(entry)) return renderArrival(entry, columns);
    if (entry.op === "SEND" && entry.scheme === null && entry.pathname === null) return renderBroadcast(entry, columns);
    return renderOperationRow(entry, override);
};
