import type { WorkerHistory } from "./transport.ts";
import ModelText from "./model-text.ts";
import { paint } from "./color.ts";
import { extractSendBody, isArrivalEntry, isEmission, isEntryMaterialization, isOwnArrival, isResponseMessage, renderOperationRow } from "./render.ts";
import { renderLogEntry, renderSubmittedInput } from "./render-message.ts";
import { operationLabel } from "./operation-glyphs.ts";

// {§cli-worker-history}: the snapshot's rows in log order, each carrying its own words, drawn quietly. Reasoning
// is never replayed.
export const renderHistory = (history: WorkerHistory, threadId: string, columns: number): string[] => {
    const blocks: string[] = [];
    for (const entry of history.entries) {
        if (isEntryMaterialization(entry) || isEmission(entry)) continue;
        if (isArrivalEntry(entry)) {
            if (!history.attachment && isOwnArrival(entry, threadId)) continue;
            const content = ModelText.plain(extractSendBody(entry.tx));
            if (isOwnArrival(entry, threadId)) blocks.push(renderSubmittedInput(content));
            else blocks.push(`${paint(`${operationLabel("SEND")}${entry.source == null ? "" : ` (${ModelText.plain(entry.source)})`}`, "dim")}\n${content}`);
        } else if (isResponseMessage(entry)) {
            blocks.push(renderLogEntry(entry, columns));
        } else {
            blocks.push(paint(renderOperationRow(entry), "dim"));
        }
    }
    if (history.attachment && blocks.length > 0) blocks.push(paint(`— ${blocks.length} earlier entries · /log for more —`, "dim"));
    return blocks;
};
