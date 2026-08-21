import { test } from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
import ReasoningEvents from "./reasoning-events.ts";

test("[§cli-provider-reasoning] standard reasoning deltas become one completed message", () => {
    const events = new ReasoningEvents();
    assert.deepEqual(events.consume({ type: EventType.REASONING_START, messageId: "r" }), { handled: true });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning" }), { handled: true });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r", delta: "one " }), { handled: true });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r", delta: "two" }), { handled: true });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_END, messageId: "r" }), {
        handled: true,
        message: { messageId: "r", content: "one two" },
    });
    assert.deepEqual(events.consume({ type: EventType.REASONING_END, messageId: "r" }), { handled: true });
});

test("empty reasoning invents no readable message", () => {
    const events = new ReasoningEvents();
    events.consume({ type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning" });
    assert.deepEqual(events.consume({ type: EventType.REASONING_MESSAGE_END, messageId: "r" }), { handled: true });
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
