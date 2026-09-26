import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { extractSendBody, isResponseMessage, type LogEntryWire } from "./render.ts";
import { renderDescendantBlock, renderLogEntry, renderSendBody } from "./render-message.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

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

test("[§cli-note-rendering] a model NOTE renders as full Markdown without becoming a delivered message", () => {
    const note = row("NOTE", "Working memory, not a response.", 200);
    assert.equal(isResponseMessage(note), false, "it is not speech");
    assert.equal(stripVTControlCharacters(renderLogEntry(note, 80)), "\nWorking memory, not a response.", "model text uses the conversation column");
    const answer = row("KILL", "Working memory, not a response.", 200, true);
    assert.equal(stripVTControlCharacters(renderLogEntry(answer, 80)), "\nWorking memory, not a response.", "the delivered answer keeps its blank lead and is whole");
    assert.equal(stripVTControlCharacters(renderLogEntry({ ...note, origin: "_plurnk" }, 80)), "NOTE\n    Working memory, not a response.\n", "a harness NOTE keeps its heading, its body whole beneath, a blank row under it");
});

for (const columns of [24, 80]) test(`[§cli-note-rendering] model notes use the existing Markdown projection at ${columns} columns without truncation`, () => {
    const body = "# Findings\n\n**Important** result.\n\n- first item\n- second item\n\n```js\nconsole.log(42);\n```\n\n" + "Full notes stay visible.\n\n".repeat(20) + "End of note.";
    const note = row("NOTE", body, 200);
    const rendered = renderLogEntry(note, columns);
    assert.equal(rendered, `\n${renderSendBody(note.tx, columns)}`, "one shared Markdown projection, no preview or NOTE keyword");
    const plain = stripVTControlCharacters(rendered);
    assert.doesNotMatch(plain, /\*\*Important\*\*|```js|\/look/u);
    assert.match(plain, /console\.log\(42\);/u);
    assert.match(plain, /End of note\./u);
    assert.ok(rendered.split("\n").every((line) => visibleWidth(line) <= columns), "the existing renderer respects the viewport");
    assert.equal(isResponseMessage(note), false);
});

test("[§cli-note-rendering] model notes retain asides and failure visibility; runtime notes remain literal", () => {
    const note = row("NOTE", "**Result**", 200);
    note.tx = { ...note.tx as object, aside: "Investigation" };
    assert.match(stripVTControlCharacters(renderLogEntry(note, 80)), /^Investigation\nResult/u);
    const failure = { ...note, status_rx: 403, rx: { problem: { title: "Operation denied", status: 403 } } };
    assert.match(stripVTControlCharacters(renderLogEntry(failure, 80)), /Operation denied/u);
    assert.equal(isResponseMessage(failure), false);
    assert.equal(stripVTControlCharacters(renderLogEntry({ ...note, origin: "_plurnk" }, 80)), "NOTE Investigation\n    **Result**\n");
});

test("[§cli-note-rendering] observed child notes retain Markdown within their lineage indentation", () => {
    const note = row("NOTE", "**Child finding**\n\nA paragraph that wraps inside the child's available column width.", 200);
    const rendered = renderDescendantBlock(note, "alice", 2, undefined, 32);
    assert.match(stripVTControlCharacters(rendered), /^    🐜 alice \n    Child finding/u);
    assert.doesNotMatch(rendered, /\*\*Child finding\*\*/u);
    assert.ok(rendered.split("\n").every((line) => visibleWidth(line) <= 32));
});

for (const op of ["WAIT", "KILL"]) test(`${op} without delivery is an operation, not speech or a task inventory`, () => {
    const entry = row(op, "Working memory, not a response.", 200);
    assert.equal(isResponseMessage(entry), false);
    const rendered = stripVTControlCharacters(renderLogEntry(entry, 80));
    assert.equal(rendered, `${op}\n    Working memory, not a response.\n`, "{plurnk#104} the row, its body whole beneath, a blank row under it");
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
    assert.equal(stripVTControlCharacters(renderLogEntry(long, 80)).split("\n").length, 41, "the delivered answer is whole");
});

test("an empty WAIT displays its actual continuation detail without manufacturing speech", () => {
    const entry = row("WAIT", null, 102);
    entry.rx = { status: 102, detail: "Nothing is in flight. Continuing." };
    assert.equal(isResponseMessage(entry), false);
    assert.match(stripVTControlCharacters(renderLogEntry(entry)), /WAIT.*Nothing is in flight\. Continuing\./);
});
