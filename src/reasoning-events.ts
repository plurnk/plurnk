import type { AcpEvent } from "./acp.ts";

export type ReasoningUpdate =
    | { phase: "start"; messageId: string }
    | { phase: "content"; messageId: string; delta: string; content: string }
    | { phase: "end"; messageId: string; content: string };

export interface ReasoningEventResult {
    handled: boolean;
    update?: ReasoningUpdate;
}

// Preserve ACP's live delta lifecycle while maintaining the accumulated value
// needed by terminal and editor presentation. Shape validation belongs to
// HttpAgent; lifecycle integrity belongs here, at the client projection boundary.
// plurnk-service {§acp-reasoning-link}: the client negotiates reasoning by link, so a turn's text arrives as the
// `plurnk.reasoning` preview of the message it belongs to, and a message that names its link draws no preview: its
// turn's reasoning folded onto the message the client streamed, or one it never streamed. ACP's own content stays a
// preview source, for a daemon that sends the text on the message itself.
export default class ReasoningEvents {
    #messages = new Map<string, string>();
    #linked = new Set<string>();

    consume(event: AcpEvent): ReasoningEventResult {
        if (event.type === "REASONING_START" || event.type === "REASONING_END") {
            return { handled: true };
        }
        if (event.type === "REASONING_MESSAGE_START") {
            if (ReasoningEvents.#linkOf(event.metadata)) {
                this.#linked.add(event.messageId);
                return { handled: true };
            }
            if (this.#messages.has(event.messageId)) {
                throw new TypeError(`Reasoning message '${event.messageId}' started twice.`);
            }
            this.#messages.set(event.messageId, "");
            return { handled: true, update: { phase: "start", messageId: event.messageId } };
        }
        if (event.type === "REASONING_MESSAGE_CONTENT") return this.#content(event.messageId, event.delta);
        if (event.type === "CUSTOM" && event.name === "plurnk.reasoning") {
            const value = event.value as { messageId?: unknown; delta?: unknown } | null;
            if (typeof value?.messageId !== "string" || typeof value.delta !== "string") {
                throw new TypeError("A reasoning preview names its message and carries its delta.");
            }
            return this.#content(value.messageId, value.delta);
        }
        if (event.type === "REASONING_MESSAGE_END") {
            if (this.#linked.delete(event.messageId)) return { handled: true };
            const content = this.#messages.get(event.messageId);
            if (content === undefined) {
                throw new TypeError(`Reasoning message '${event.messageId}' ended before its start.`);
            }
            this.#messages.delete(event.messageId);
            return { handled: true, update: { phase: "end", messageId: event.messageId, content } };
        }
        return { handled: false };
    }

    #content(messageId: string, delta: string): ReasoningEventResult {
        const prior = this.#messages.get(messageId);
        if (prior === undefined) {
            throw new TypeError(`Reasoning content for '${messageId}' arrived before its start.`);
        }
        const content = prior + delta;
        this.#messages.set(messageId, content);
        return { handled: true, update: { phase: "content", messageId, delta, content } };
    }

    // plurnk-service {§acp-reasoning-link}: the reasoning's address, which a message built from its row names.
    static #linkOf(metadata: unknown): boolean {
        const body = (metadata as { plurnk?: { body?: { url?: unknown } } } | undefined)?.plurnk?.body;
        return typeof body?.url === "string";
    }
}
