import { test } from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
import ReasoningEvents from "./reasoning-events.ts";

test("[§cli-provider-reasoning] standard reasoning deltas remain live and accumulate exactly", () => {
    const events = new ReasoningEvents();
    assert.deepEqual(events.consume({ type: EventType.REASONING_START, messageId: "r" }), { handled: true });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning" }), {
        handled: true, update: { phase: "start", messageId: "r" },
    });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r", delta: "one " }), {
        handled: true, update: { phase: "content", messageId: "r", delta: "one ", content: "one " },
    });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r", delta: "two" }), {
        handled: true, update: { phase: "content", messageId: "r", delta: "two", content: "one two" },
    });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_END, messageId: "r" }), {
        handled: true,
        update: { phase: "end", messageId: "r", content: "one two" },
    });
    assert.deepEqual(events.consume({ type: EventType.REASONING_END, messageId: "r" }), { handled: true });
});

test("empty reasoning has a balanced lifecycle without inventing content", () => {
    const events = new ReasoningEvents();
    events.consume({ type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning" });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_END, messageId: "r" }), {
        handled: true, update: { phase: "end", messageId: "r", content: "" },
    });
});

test("a broken reasoning lifecycle fails at the projection boundary", () => {
    const events = new ReasoningEvents();
    assert.throws(
        () => events.consume({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r", delta: "orphan" }),
        /before its start/,
    );
    assert.throws(
        () => events.consume({ type: EventType.REASONING_MESSAGE_END, messageId: "r" }),
        /before its start/,
    );
});

test("[§cli-provider-reasoning] a negotiated preview accumulates as the message's live text, and a message that names its link draws nothing", () => {
    const events = new ReasoningEvents();
    const link = { plurnk: { body: { url: "http://agui.test/agui/3/7/reasoning/1/2", mimeType: "text/plain" } } };
    events.consume({ type: EventType.REASONING_START, messageId: "r" });
    events.consume({ type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning" });
    assert.deepEqual(events.consume({ type: EventType.CUSTOM, name: "plurnk.reasoning", value: { messageId: "r", delta: "one " } }), {
        handled: true, update: { phase: "content", messageId: "r", delta: "one ", content: "one " },
    });
    assert.deepEqual(events.consume({ type: EventType.CUSTOM, name: "plurnk.reasoning", value: { messageId: "r", delta: "two" } }), {
        handled: true, update: { phase: "content", messageId: "r", delta: "two", content: "one two" },
    });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_END, messageId: "r" }), {
        handled: true, update: { phase: "end", messageId: "r", content: "one two" },
    });
    events.consume({ type: EventType.REASONING_END, messageId: "r" });
    // The turn's row folds the link onto the message the client streamed: no second preview.
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning", metadata: link }), { handled: true });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_END, messageId: "r" }), { handled: true });
    // Reasoning the client never streamed arrives whole, by its link: nothing to preview.
    for (const event of [
        { type: EventType.REASONING_START, messageId: "late" },
        { type: EventType.REASONING_MESSAGE_START, messageId: "late", role: "reasoning", metadata: link },
        { type: EventType.REASONING_MESSAGE_END, messageId: "late" },
        { type: EventType.REASONING_END, messageId: "late" },
    ] as const) assert.deepEqual(events.consume(event), { handled: true });
    assert.deepEqual(events.consume({ type: EventType.CUSTOM, name: "plurnk.ambient", value: {} }), { handled: false }, "other extensions are not reasoning");
    assert.throws(() => events.consume({ type: EventType.CUSTOM, name: "plurnk.reasoning", value: { messageId: "r" } }), /names its message and carries its delta/);
    assert.throws(() => events.consume({ type: EventType.CUSTOM, name: "plurnk.reasoning", value: { messageId: "gone", delta: "x" } }), /before its start/);
});
