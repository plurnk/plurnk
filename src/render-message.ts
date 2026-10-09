import { stripVTControlCharacters } from "node:util";
import { TurnDisposition } from "@plurnk/plurnk-contracts";
import { paint } from "./color.ts";
import { looksLikeMarkdown, renderMarkdownDocument } from "./markdown.ts";
import ModelText from "./model-text.ts";
import {
    entryAside, extractSendBody, isArrivalEntry, isResponseMessage,
    LINEAGE_OFFSET, lineageWorker, markDescendant, objectOf, outcomeTitle, previewLine, previewLines, previewMore, renderOperationBlock,
    type LogEntryWire, type OutsideText, type RowOverride,
} from "./render.ts";

export const renderSubmittedInput = (text: string): string => text.split("\n")
    .map((line, index) => paint(`${index === 0 ? "› " : "  "}${line}`, "bold", "human"))
    .join("\n");

// Rich interpretation belongs to the TUI, never shared CLI extraction.
export const renderSendBody = (txUnknown: unknown, viewport = process.stdout.columns ?? 80): string => {
    const tx = txUnknown as { body?: string | { json?: unknown } | null } | null;
    const json = typeof tx?.body === "object" ? tx.body?.json : undefined;
    if (json !== null && json !== undefined) return JSON.stringify(json, null, 2);
    const prose = ModelText.plain(extractSendBody(txUnknown)).replaceAll("$\\rightarrow$", "→");
    return looksLikeMarkdown(prose) ? renderMarkdownDocument(prose, viewport) : prose;
};

// The lead line of a block: no keyword and no glyph (plurnk#104); a final answer's, a NOTE's and
// a SEND's stand blank where the keyword was. A failure puts its Problem title there in red, a
// deferred or joined completion its `detail`; the sanitized aside follows either.
const leadLine = (entry: LogEntryWire, detail: boolean): string => {
    const parts: string[] = [];
    const rx = objectOf(entry.rx);
    if (entry.status_rx >= 400 && !(isResponseMessage(entry) && rx?.problem == null)) parts.push(paint(ModelText.plain(outcomeTitle(entry) ?? String(entry.status_rx)), "failure"));
    else if (detail && entry.status_rx !== 200 && typeof rx?.detail === "string" && rx.detail.length > 0) parts.push(ModelText.plain(rx.detail));
    const aside = entryAside(entry);
    if (aside !== null) parts.push(paint(aside, "dim", "italic"));
    return parts.join(" ");
};

// Full model text of a delivered reply. Presentation does not imply delivery: reply accounting
// remains isResponseMessage's responsibility.
const modelBlock = (lead: string, body: string): string => body.length === 0 ? lead : `${lead}\n${body}`;
const renderModelText = (entry: LogEntryWire, columns: number, body = renderSendBody(entry.tx, Math.max(1, columns))): string =>
    modelBlock(leadLine(entry, TurnDisposition.isOp(entry.op)), body);

// A model NOTE ({§cli-note-rendering}): a reply's blank lead and aside, then its body whole in the
// Markdown layout at the width, stripped of every weight and painted dim — the status line's
// weight — so bearings never read as an answer.
const renderNoteText = (entry: LogEntryWire, columns: number): string => {
    const body = stripVTControlCharacters(renderSendBody(entry.tx, Math.max(1, columns)));
    return modelBlock(leadLine(entry, false), body.length === 0 ? "" : body.split("\n").map((line) => paint(line, "dim")).join("\n"));
};

// Outside text ({§cli-outside-text}): the turn's prose outside its fences, one block with a
// reply's layout — blank lead, full Markdown at the width — and never speech.
export const renderOutsideText = ({ text }: OutsideText, columns: number): string =>
    modelBlock("", renderSendBody({ body: { raw: text } }, Math.max(1, columns)));

// A block's body previewed ({plurnk#107}): the plain text, four columns in and dim, the knob's
// line count. No Markdown pass: a preview is quiet by construction.
const previewBlock = (entry: LogEntryWire, columns: number): string =>
    previewLines(ModelText.plain(extractSendBody(entry.tx)).trimEnd().split("\n"), (remaining) => previewMore(entry, remaining)).map((line) => previewLine(line, columns)).join("\n");

// An arrival from another actor: SEND with the sender where a target would sit, then the
// same plain body block, previewed.
const renderArrival = (entry: LogEntryWire, columns: number): string => {
    const sender = typeof entry.source === "string" ? ` (${ModelText.plain(entry.source)})` : "";
    const lead = `${paint("SEND", "bold", "success")}${sender}`;
    return extractSendBody(entry.tx).length === 0 ? lead : `${lead}\n${previewBlock(entry, columns)}\n`;
};

// A descendant's row ({plurnk#108}): the child's name marks it, the block sits one step in per
// generation. Model NOTEs stay plain and dim within that indentation. A lineage row is the
// direct child's, at depth one ({§cli-workers-topology}).
export const renderDescendantBlock = (entry: LogEntryWire, name: string, depth: number, override?: RowOverride, columns = process.stdout.columns ?? 80): string =>
    markDescendant(entry.op === "NOTE" && entry.origin === "model"
        ? renderNoteText(entry, Math.max(1, columns - LINEAGE_OFFSET.length * depth))
        : renderOperationBlock(entry, override, true, Math.max(1, columns - LINEAGE_OFFSET.length * depth)), name, depth);

// Render a log entry for the waterfall WITHOUT a trailing newline. A disposition renders
// its outcome, an arrival its sender and block, a delivered conversation reply its whole block
// ({§cli-broadcast-send-rendering}), every other operation, an undelivered SEND included, its literal row with its body previewed beneath ({plurnk#104}). Model
// NOTEs render plain and dim ({§cli-note-rendering}) without becoming delivered messages.
export const renderLogEntry = (
    entry: LogEntryWire,
    columns: number = process.stdout.columns ?? 80,
    override?: RowOverride,
): string => {
    if (isResponseMessage(entry)) return renderModelText(entry, columns);
    // A model WAIT that carries a body speaks it (plurnk-service {§agui-projection}, plurnk#161): the
    // lead line keeps the wait's detail and aside, the body renders as model text at full paint.
    // A bodiless WAIT stays the lifecycle row it is.
    if (entry.op === "WAIT" && entry.origin === "model" && ModelText.plain(extractSendBody(entry.tx)).trim().length > 0) return renderModelText(entry, columns);
    const lineage = lineageWorker(entry);
    if (lineage !== null) return renderDescendantBlock(entry, lineage, 1, override, columns);
    if (entry.op === "NOTE" && entry.origin === "model") return renderNoteText(entry, columns);
    if (TurnDisposition.isOp(entry.op)) {
        const rx = objectOf(entry.rx);
        const detail = typeof rx?.detail === "string" ? rx.detail : null;
        return renderOperationBlock(entry, { failure: rx?.problem == null ? detail : outcomeTitle(entry) }, true, columns);
    }
    if (isArrivalEntry(entry)) return renderArrival(entry, columns);
    return renderOperationBlock(entry, override, true, columns);
};
