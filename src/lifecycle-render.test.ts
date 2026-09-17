import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { extractSendBody, isResponseMessage, renderLogEntry, type LogEntryWire } from "./render.ts";

const row = (op: string, body: string | null, status: number, delivered = false): LogEntryWire => ({
    id: 1, loop_seq: 1, turn_seq: 2, sequence: 1, op, origin: "model", signal: null,
    scheme: null, hostname: null, pathname: null, fragment: null, lineMarker: null,
    tx: { op, body, target: null, aside: null },
    rx: { status, ...(delivered ? { recipients: [] } : {}) }, status_rx: status, tags: [],
});

for (const [op, status] of [["DONE", 200], ["DONE", 102], ["DONE", 202], ["FAIL", 499], ["FAIL", 102]] as const) {
    test(`delivered ${op} at ${status} is a response independently of lifecycle settlement`, () => {
        const entry = row(op, "**Authored response.**", status, true);
        assert.equal(isResponseMessage(entry), true);
        assert.equal(extractSendBody(entry.tx, false), "**Authored response.**");
        assert.match(stripVTControlCharacters(renderLogEntry(entry, 80)), /Authored response\./);
        assert.equal(isResponseMessage({ ...entry, origin: "_plurnk" }), false);
        assert.equal(isResponseMessage({ ...entry, inherited_history: 1 }), false);
        assert.equal(isResponseMessage({ ...entry, source: "worker://another" }), false);
        assert.equal(isResponseMessage(row(op, "Not delivered", status)), false);
        assert.equal(isResponseMessage(row(op, null, status, true)), false);
    });
}

for (const op of ["NOTE", "WAIT"]) test(`${op} is an operation, not speech or a task inventory`, () => {
    const entry = row(op, "Working memory, not a response.", 200);
    assert.equal(isResponseMessage(entry), false);
    const rendered = stripVTControlCharacters(renderLogEntry(entry, 80));
    assert.equal(rendered, op);
});

test("a deferred blank DONE displays the actual barrier without manufacturing speech", () => {
    const entry = row("DONE", null, 102);
    entry.rx = { status: 102, detail: "Completion deferred: results await observation." };
    assert.equal(isResponseMessage(entry), false);
    assert.match(stripVTControlCharacters(renderLogEntry(entry)), /DONE.*Completion deferred: results await observation\./);
});
