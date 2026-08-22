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
