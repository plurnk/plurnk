import type { WorkerHistory } from "./transport.ts";
import ModelText from "./model-text.ts";
import { paint } from "./color.ts";
import { extractSendBody, isArrivalEntry, isEmission, isEntryMaterialization, isOwnArrival, isResponseMessage, markDescendant, renderOperationRow, type Descendant, type LogEntryWire } from "./render.ts";
import { renderLogEntry, renderSubmittedInput } from "./render-message.ts";
import { operationLabel } from "./operation-glyphs.ts";

// Another sender's arrival, drawn quietly: its sender, then its words.
const arrivalBlock = (entry: LogEntryWire): string =>
    `${paint(`${operationLabel("SEND")}${entry.source == null ? "" : ` (${ModelText.plain(entry.source)})`}`, "dim")}\n${ModelText.plain(extractSendBody(entry.tx))}`;

// A descendant's row, drawn as quietly as the bound worker's: a message or reply with its words whole, any other
// operation as its heading.
const descendantBlock = (entry: LogEntryWire): string => {
    if (isArrivalEntry(entry)) return arrivalBlock(entry);
    const heading = paint(renderOperationRow(entry), "dim");
    const words = entry.op === "SEND" || entry.op === "KILL" ? ModelText.plain(extractSendBody(entry.tx)) : "";
    return words.trim().length === 0 ? heading : `${heading}\n${words}`;
};

// {§cli-worker-history} {§cli-loops}: rows in log order, each carrying its own words, drawn quietly; the person's own
// prompts among them when `ownArrivals` says the screen does not hold them already. A descendant's row, one of the
// bound worker's `tree` beneath it, is marked and stepped in as the live view marks it. Reasoning is never replayed.
export const renderRows = (entries: readonly LogEntryWire[], threadId: string, columns: number, ownArrivals: boolean,
    tree: ReadonlyMap<number, Descendant> = new Map()): string[] => {
    const blocks: string[] = [];
    for (const entry of entries) {
        if (isEntryMaterialization(entry) || isEmission(entry)) continue;
        const descendant = tree.get(entry.worker_id ?? -1);
        if (descendant !== undefined) {
            blocks.push(markDescendant(descendantBlock(entry), descendant.name, descendant.depth));
        } else if (isArrivalEntry(entry)) {
            if (!ownArrivals && isOwnArrival(entry, threadId)) continue;
            if (isOwnArrival(entry, threadId)) blocks.push(renderSubmittedInput(ModelText.plain(extractSendBody(entry.tx))));
            else blocks.push(arrivalBlock(entry));
        } else if (isResponseMessage(entry)) {
            blocks.push(renderLogEntry(entry, columns));
        } else {
            blocks.push(paint(renderOperationRow(entry), "dim"));
        }
    }
    return blocks;
};

// {§cli-worker-history}: the snapshot's rows; on attach, the screen holds none of the person's prompts yet.
export const renderHistory = (history: WorkerHistory, threadId: string, columns: number, tree: ReadonlyMap<number, Descendant> = new Map()): string[] =>
    renderRows(history.entries, threadId, columns, history.attachment, tree);
