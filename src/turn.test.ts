import { test } from "node:test";
import assert from "node:assert/strict";
import TurnDisplay from "./turn.ts";
import type { LogEntryWire } from "./render.ts";

const row = (loop: number, turn: number, op = "READ"): LogEntryWire => ({
    id: 1, loop_seq: loop, turn_seq: turn, sequence: 1, op, origin: "model", signal: null, scheme: null, pathname: null,
    hostname: null, fragment: null, lineMarker: null, tx: {}, rx: { status: 200 }, status_rx: 200, tags: [],
});

test("[§cli-response-order] deliberate SEND and lifecycle responses retain delivery order", () => {
    const view = new TurnDisplay();
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "Here is the response.", json: null } } });
    view.addResponse({ ...row(1, 1, "DONE"), tx: { body: "Finished." }, rx: { status: 200, recipients: [] } });
    const rendered = view.render(100).join("\n");
    assert.match(rendered, /Here is the response\.[\s\S]*Finished\./);
});

test("[§cli-response-order] advancing archives all delivered messages without losing or replacing them", () => {
    const view = new TurnDisplay();
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "Progress message.", json: null } } });
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "Second message.", json: null } } });
    const messages = view.take();
    assert.match(messages.render(80).join("\n"), /Progress message\.[\s\S]*Second message\./);
    assert.equal(view.empty, true);
    view.addResponse({ ...row(2, 1, "SEND"), tx: { body: { raw: "Next interaction.", json: null } } });
    assert.doesNotMatch(messages.render(80).join("\n"), /Next interaction/);
    assert.match(view.render(80).join("\n"), /Next interaction/);
});
