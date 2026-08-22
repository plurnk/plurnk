import type { AguiEvent } from "./agui.ts";

export type ReasoningUpdate =
    | { phase: "start"; messageId: string }
    | { phase: "content"; messageId: string; delta: string; content: string }
    | { phase: "end"; messageId: string; content: string };

export interface ReasoningEventResult {
    handled: boolean;
    update?: ReasoningUpdate;
}

// Preserve AG-UI's live delta lifecycle while maintaining the accumulated value
// needed by terminal and editor presentation. Shape validation belongs to
// HttpAgent; lifecycle integrity belongs here, at the client projection boundary.
export default class ReasoningEvents {
    #messages = new Map<string, string>();

    consume(event: AguiEvent): ReasoningEventResult {
        if (event.type === "REASONING_START" || event.type === "REASONING_END") {
            return { handled: true };
        }
        if (event.type === "REASONING_MESSAGE_START") {
            if (this.#messages.has(event.messageId)) {
                throw new TypeError(`Reasoning message '${event.messageId}' started twice.`);
            }
            this.#messages.set(event.messageId, "");
            return { handled: true, update: { phase: "start", messageId: event.messageId } };
        }
        if (event.type === "REASONING_MESSAGE_CONTENT") {
            const prior = this.#messages.get(event.messageId);
            if (prior === undefined) {
                throw new TypeError(`Reasoning content for '${event.messageId}' arrived before its start.`);
            }
            const content = prior + event.delta;
            this.#messages.set(event.messageId, content);
            return {
                handled: true,
                update: { phase: "content", messageId: event.messageId, delta: event.delta, content },
            };
        }
        if (event.type === "REASONING_MESSAGE_END") {
            const content = this.#messages.get(event.messageId);
            if (content === undefined) {
                throw new TypeError(`Reasoning message '${event.messageId}' ended before its start.`);
            }
            this.#messages.delete(event.messageId);
            return { handled: true, update: { phase: "end", messageId: event.messageId, content } };
        }
        return { handled: false };
    }
}
