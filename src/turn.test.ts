import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Script } from "node:vm";
import { visibleWidth } from "@earendil-works/pi-tui";
import TurnDisplay from "./turn.ts";
import type { LogEntryWire } from "./render.ts";

const row = (loop: number, turn: number, op = "READ"): LogEntryWire => ({
    id: 1, loop_seq: loop, turn_seq: turn, sequence: 1, op, origin: "model", signal: null, scheme: null, pathname: null,
    hostname: null, fragment: null, lineMarker: null, tx: {}, rx: { status: 200, answers: [] }, status_rx: 200, tags: [],
});

test("[§cli-response-order] deliberate and addressed SEND responses retain delivery order", () => {
    const view = new TurnDisplay();
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "Here is the response.", json: null } } });
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "Finished." } }, rx: { status: 200, answers: ["agui://anonymous/threads/t/messages/m1"] } });
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

test("[§cli-response-order] response lines fit the viewport after render and resize without truncation", () => {
    const content = "abcdefghijklmnopqrstuvwxyz".repeat(8);
    for (const body of [
        { raw: content, json: null },
        { raw: JSON.stringify({ content }), json: { content } },
        { raw: `\`\`\`text\n${content}\n\`\`\``, json: null },
    ]) {
        const view = new TurnDisplay();
        view.addResponse({ ...row(1, 1, "SEND"), tx: { body } });
        for (const width of [135, 40, 80]) {
            const lines = view.render(width);
            assert.ok(lines.every((line) => visibleWidth(line) <= width), `every response line must fit ${width} columns`);
            // A fenced body carries its gutter on every wrapped row, so the value is read past it.
            const visible = lines.map(stripVTControlCharacters).map((line) => line.replace(/^│ /u, "")).join("");
            assert.ok(visible.includes(content), "the complete response value remains visible");
        }
    }
});

test("{§cli-response-order} unchanged responses reuse their projection across refreshes and archival", (t) => {
    const bounded = t.mock.method(Script.prototype, "runInNewContext");
    const view = new TurnDisplay();
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "```mermaid\ngraph TD\nA-->B\n```" } } });
    const first = view.render(80);
    assert.match(first.join("\n"), /┌/);
    assert.equal(bounded.mock.callCount(), 1);
    assert.deepEqual(view.render(80), first);
    view.addResponse({ ...row(1, 1, "SEND"), tx: { body: { raw: "A new response." } } });
    assert.match(view.render(80).join("\n"), /A new response/);
    const archived = view.take();
    assert.match(archived.render(80).join("\n"), /A new response/);
    assert.equal(bounded.mock.callCount(), 1, "status changes and archival do not repeat layout");
    archived.render(40);
    assert.equal(bounded.mock.callCount(), 2, "resize rerenders at the new width");
    archived.invalidate();
    archived.render(40);
    assert.equal(bounded.mock.callCount(), 3, "presentation changes can invalidate the projection");
});
