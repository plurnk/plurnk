import { test } from "node:test";
import assert from "node:assert/strict";
import TurnDisplay from "./turn.ts";
import type { LogEntryWire } from "./render.ts";

const row = (loop: number, turn: number, op = "READ"): LogEntryWire => ({
    id: 1, loop_seq: loop, turn_seq: turn, sequence: 1, op, origin: "model", signal: null, scheme: null, pathname: null,
    hostname: null, fragment: null, lineMarker: null, tx: {}, rx: { status: 200 }, status_rx: 200, tags: [],
});

const task = (content: string, status = "in_progress"): LogEntryWire => ({
    ...row(1, 1, "TASK"), tx: { body: { entries: [{ content, status, priority: "medium" }] } },
});

test("[§cli-plan-rendering] the live inventory replaces itself above deliberate SEND messages", () => {
    const view = new TurnDisplay();
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "Here is the response.", json: null } } });
    view.setTask(task("Old task"));
    view.setTask(task("Current task", "completed"));
    const rendered = view.render(100).join("\n");
    assert.doesNotMatch(rendered, /Old task/);
    assert.ok(rendered.indexOf("Current task") < rendered.indexOf("Here is the response."));
});

test("[§cli-plan-rendering] advancing archives messages without losing the current inventory; a new interaction archives both", () => {
    const view = new TurnDisplay();
    view.setTask(task("Still working"));
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "Progress message.", json: null } } });
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "Second message.", json: null } } });
    const messages = view.takeResponses();
    assert.match(messages.render(80).join("\n"), /Progress message\.[\s\S]*Second message\./);
    assert.doesNotMatch(messages.render(80).join("\n"), /Still working/);
    assert.match(view.render(80).join("\n"), /Still working/);
    assert.doesNotMatch(view.render(80).join("\n"), /Progress message/);
    const previous = view.take();
    assert.equal(view.empty, true);
    view.setTask(task("Next interaction"));
    assert.doesNotMatch(previous.render(80).join("\n"), /Next interaction/);
    assert.match(previous.render(80).join("\n"), /Still working/);
});
