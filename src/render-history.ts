import type { WorkerHistory } from "./transport.ts";
import ModelText from "./model-text.ts";
import { paint } from "./color.ts";
import { extractSendBody, isArrivalEntry, isEmission, isEntryMaterialization, isOwnArrival, isResponseMessage, renderOperationRow, type LogEntryWire } from "./render.ts";
import { renderLogEntry, renderSubmittedInput } from "./render-message.ts";
import { operationLabel } from "./operation-glyphs.ts";

// {§cli-worker-history} {§cli-loops}: rows in log order, each carrying its own words, drawn quietly; the person's own
// prompts among them when `ownArrivals` says the screen does not hold them already. Reasoning is never replayed.
export const renderRows = (entries: readonly LogEntryWire[], threadId: string, columns: number, ownArrivals: boolean): string[] => {
    const blocks: string[] = [];
    for (const entry of entries) {
        if (isEntryMaterialization(entry) || isEmission(entry)) continue;
        if (isArrivalEntry(entry)) {
            if (!ownArrivals && isOwnArrival(entry, threadId)) continue;
            const content = ModelText.plain(extractSendBody(entry.tx));
            if (isOwnArrival(entry, threadId)) blocks.push(renderSubmittedInput(content));
            else blocks.push(`${paint(`${operationLabel("SEND")}${entry.source == null ? "" : ` (${ModelText.plain(entry.source)})`}`, "dim")}\n${content}`);
        } else if (isResponseMessage(entry)) {
            blocks.push(renderLogEntry(entry, columns));
        } else {
            blocks.push(paint(renderOperationRow(entry), "dim"));
        }
    }
    return blocks;
};

// {§cli-worker-history}: the snapshot's rows; on attach, the screen holds none of the person's prompts yet, and the
// footer names where the loops before the window are ({§cli-loops}).
export const renderHistory = (history: WorkerHistory, threadId: string, columns: number): string[] => {
    const blocks = renderRows(history.entries, threadId, columns, history.attachment);
    if (history.attachment && (history.entries[0]?.loop_seq ?? 1) > 1) blocks.push(paint("— earlier loops: /loops —", "dim"));
    return blocks;
};
