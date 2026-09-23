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

test("[§cli-note-rendering] a model NOTE is displayed as a final answer is, under a blank row and with one after it, and is never a delivered message", () => {
    const note = row("NOTE", "Working memory, not a response.", 200);
    assert.equal(isResponseMessage(note), false, "displayed alike, it is not speech");
    assert.equal(stripVTControlCharacters(renderLogEntry(note, 80)), "\n    Working memory, not a response.\n");
    const answer = row("KILL", "Working memory, not a response.", 200, true);
    assert.equal(stripVTControlCharacters(renderLogEntry(answer, 80)), "\nWorking memory, not a response.", "{plurnk#104} no glyph on either; only the note's trailing row differs");
    assert.equal(stripVTControlCharacters(renderLogEntry({ ...note, origin: "_plurnk" }, 80)), "NOTE\n    Working memory, not a response.\n", "a harness NOTE keeps its heading, its body previewed beneath, a blank row under it");
});

for (const op of ["WAIT", "KILL"]) test(`${op} without delivery is an operation, not speech or a task inventory`, () => {
    const entry = row(op, "Working memory, not a response.", 200);
    assert.equal(isResponseMessage(entry), false);
    const rendered = stripVTControlCharacters(renderLogEntry(entry, 80));
    assert.equal(rendered, `${op}\n    Working memory, not a response.\n`, "{plurnk#104} the row, its body previewed beneath, a blank row under it");
});

test("{§cli-broadcast-send-rendering} a final KILL is speech only when its answer was delivered", () => {
    const delivered = row("KILL", "Verified answer.", 200, true);
    assert.equal(isResponseMessage(delivered), true);
    assert.equal(stripVTControlCharacters(renderLogEntry(delivered)), "\nVerified answer.");
    for (const status of [102, 202]) {
        const deferred = row("KILL", "Not delivered.", status);
        deferred.rx = { status, detail: "Results await review before completion." };
        assert.equal(isResponseMessage(deferred), false);
        assert.equal(stripVTControlCharacters(renderLogEntry(deferred)), "KILL — Results await review before completion.\n    Not delivered.\n");
    }
    // {plurnk#104} — the delivered answer is the one block that is never previewed.
    const long = row("KILL", Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), 200, true);
    assert.equal(stripVTControlCharacters(renderLogEntry(long, 80, undefined, 24)).split("\n").length, 41, "the delivered answer is whole");
});

test("an empty WAIT displays its actual continuation detail without manufacturing speech", () => {
    const entry = row("WAIT", null, 102);
    entry.rx = { status: 102, detail: "Nothing is in flight. Continuing." };
    assert.equal(isResponseMessage(entry), false);
    assert.match(stripVTControlCharacters(renderLogEntry(entry)), /WAIT.*Nothing is in flight\. Continuing\./);
});
