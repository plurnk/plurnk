import type { ConversationHistory } from "./transport.ts";
import ModelText from "./model-text.ts";
import { paint } from "./color.ts";
import { extractSendBody, isArrivalEntry, isEntryMaterialization, isOwnArrival, isResponseMessage, renderOperationRow } from "./render.ts";
import { renderSendBody, renderSubmittedInput } from "./render-message.ts";

// {§cli-conversation-history}: rows supply order and operation outcomes; the
// standard snapshot supplies speech. A row committed after the snapshot still
// carries its own complete body. Neither source's reasoning is replayed.
export const renderHistory = (history: ConversationHistory, threadId: string, columns: number): string[] => {
    const speech = new Map(history.messages.filter((message) => message.role === "assistant").map((message) => [message.id, message]));
    const arrivals = new Map(history.messages.filter((message) => message.role === "user").map((message) => [message.name, message]));
    const blocks: string[] = [];
    for (const entry of history.entries) {
        if (typeof entry.op !== "string" || isEntryMaterialization(entry)) continue;
        if (isArrivalEntry(entry)) {
            if (!history.attachment && isOwnArrival(entry, threadId)) continue;
            const message = typeof entry.source === "string" ? arrivals.get(entry.source) : undefined;
            const content = typeof message?.content === "string" ? message.content : extractSendBody(entry.tx);
            if (isOwnArrival(entry, threadId)) blocks.push(renderSubmittedInput(ModelText.plain(content)));
            else blocks.push(`${paint(ModelText.plain(entry.source ?? "SEND"), "dim")}\n${ModelText.plain(content)}`);
        } else if (isResponseMessage(entry, threadId)) {
            const message = speech.get(entry.coordinate ?? String(entry.id));
            blocks.push(renderSendBody(typeof message?.content === "string" ? { body: { raw: message.content } } : entry.tx, columns));
        } else {
            blocks.push(paint(renderOperationRow(entry), "dim"));
        }
    }
    if (history.attachment && blocks.length > 0) blocks.push(paint(`— ${blocks.length} earlier entries · /log for more —`, "dim"));
    return blocks;
};
