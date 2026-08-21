import type { AguiEvent } from "./agui.ts";

export interface ReasoningMessage {
    messageId: string;
    content: string;
}

export interface ReasoningEventResult {
    handled: boolean;
    message?: ReasoningMessage;
}

// Fold AG-UI's delta lifecycle into the one completed value a text client can
// render. Shape validation belongs to HttpAgent; lifecycle integrity belongs
// here, at the client projection boundary.
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
            return { handled: true };
        }
        if (event.type === "REASONING_MESSAGE_CONTENT") {
            const prior = this.#messages.get(event.messageId);
            if (prior === undefined) {
                throw new TypeError(`Reasoning content for '${event.messageId}' arrived before its start.`);
            }
            this.#messages.set(event.messageId, prior + event.delta);
            return { handled: true };
        }
        if (event.type === "REASONING_MESSAGE_END") {
            const content = this.#messages.get(event.messageId);
            if (content === undefined) {
                throw new TypeError(`Reasoning message '${event.messageId}' ended before its start.`);
            }
            this.#messages.delete(event.messageId);
            return content.length === 0
                ? { handled: true }
                : { handled: true, message: { messageId: event.messageId, content } };
        }
        return { handled: false };
    }
}
