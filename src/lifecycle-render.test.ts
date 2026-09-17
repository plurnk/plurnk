import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { extractSendBody, isResponseMessage, type LogEntryWire } from "./render.ts";
import { renderLogEntry } from "./render-message.ts";

const row = (op: string, body: string | null, status: number, delivered = false): LogEntryWire => ({
    id: 1, loop_seq: 1, turn_seq: 2, sequence: 1, op, origin: "model", signal: null,
    scheme: null, hostname: null, pathname: null, fragment: null, lineMarker: null,
    tx: { op, body, target: null, aside: null },
    rx: { status, ...(delivered ? { answers: [] } : {}) }, status_rx: status, tags: [],
});

test("an addressed answer is rendered from successful delivery, not targetlessness or a terminal verb", () => {
    const entry = row("SEND", "**Authored response.**", 200, true);
    entry.scheme = "agui";
    entry.pathname = "/threads/conversation/messages/m1";
    entry.rx = { answers: ["agui://anonymous/threads/conversation/messages/m1"] };
    assert.equal(isResponseMessage(entry, "conversation"), true);
    assert.equal(isResponseMessage(entry, "other"), false);
    assert.equal(extractSendBody(entry.tx), "**Authored response.**");
    assert.match(stripVTControlCharacters(renderLogEntry(entry, 80)), /Authored response\./);
    assert.equal(isResponseMessage({ ...entry, inherited_history: 1 }), false);
    assert.equal(isResponseMessage({ ...entry, status_rx: 409 }), false);
    assert.equal(isResponseMessage({ ...entry, rx: { answers: ["worker://child/?message=01234567"] } }), false);
    assert.equal(isResponseMessage({ ...entry, source: "worker://another" }), false);
    assert.equal(isResponseMessage({ ...entry, source: "worker://another", origin: "_plurnk", attrs: { kind: "reply" } }), true);
    assert.equal(isResponseMessage(row("SEND", "Not delivered", 200)), false);
});

for (const op of ["NOTE", "WAIT"]) test(`${op} is an operation, not speech or a task inventory`, () => {
    const entry = row(op, "Working memory, not a response.", 200);
    assert.equal(isResponseMessage(entry), false);
    const rendered = stripVTControlCharacters(renderLogEntry(entry, 80));
    assert.equal(rendered, op);
});

test("an empty WAIT displays its actual continuation detail without manufacturing speech", () => {
    const entry = row("WAIT", null, 102);
    entry.rx = { status: 102, detail: "Nothing is in flight. Continuing." };
    assert.equal(isResponseMessage(entry), false);
    assert.match(stripVTControlCharacters(renderLogEntry(entry)), /WAIT.*Nothing is in flight\. Continuing\./);
});
