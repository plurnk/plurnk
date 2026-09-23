// The waterfall's stable alignment contract is its left edge: every row begins at column
// zero with the operation as written, no glyph column, no protocol code. Reasoning opens with 💭;
// a model NOTE and a final answer open with a blank row (plurnk#104).

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReasoning } from "./render.ts";
import { renderLogEntry } from "./render-message.ts";
import type { LogEntryWire } from "./render.ts";
import StreamTrace from "./stream.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const entry = (over: Partial<LogEntryWire>): LogEntryWire => ({
    id: 1, loop_seq: 1, turn_seq: 1, sequence: 5, op: "READ", origin: "model",
    signal: null, scheme: "file", pathname: "/x", hostname: null, fragment: null,
    lineMarker: null, tx: { target: { raw: "/x" } }, rx: { status: 200 }, status_rx: 200, tags: [],
    ...over,
});

test("[§cli-rendering] [§cli-log-entry-line-format] every waterfall row shares the left edge and reads as the operation written", () => {
    const streams = new StreamTrace();
    streams.launch(entry({ op: "sh", scheme: null, pathname: null, sequence: 8, status_rx: 200, rx: { status: 200, outcome: "started" }, tx: { runtime: "sh", aside: "list the files" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" } }));
    const rows: Array<[string, string]> = [
        ["operation", renderLogEntry(entry({}))],
        ["operation failure", renderLogEntry(entry({ op: "FIND", status_rx: 404, rx: { status: 404, problem: { type: "x", title: "Entry not found", status: 404 } } }))],
        ["NOTE", renderLogEntry(entry({ op: "NOTE", scheme: null, pathname: null, signal: 102, status_rx: 102, tx: { body: "Inspect." } }))],
        ["reasoning", renderReasoning("Inspect the contract.")],
        ["model SEND 200", renderLogEntry(entry({ op: "SEND", origin: "model", scheme: null, pathname: null, signal: 200, status_rx: 200, tx: { body: { raw: "done" } } }))],
        ["client SEND", renderLogEntry(entry({ op: "SEND", origin: "client", scheme: null, pathname: null, signal: 201, status_rx: 201, tx: { body: { raw: "hello" } } }))],
        ["directed SEND failure", renderLogEntry(entry({ op: "SEND", origin: "model", scheme: "worker", pathname: "/gone", signal: 410, status_rx: 410, tx: { target: { raw: "worker:///gone" } }, rx: { status: 410, problem: { type: "x", title: "Worker gone", status: 410 } } }))],
        ["execution", streams.concluded({ entryId: 8, workerId: 7, target: "sh:///1a2b3c4d", subscriptionId: 1, scheme: "sh", result: { status: 200 }, summary: "sh:///1a2b3c4d completed (exit 0)", wakeAction: "no-op-active-loop" })],
    ];

    for (const [label, value] of rows) {
        const first = stripAnsi(value).split("\n")[0];
        assert.doesNotMatch(first, /^\s/, `${label} did not begin at column zero: ${JSON.stringify(first)}`);
        if (label !== "reasoning" && label !== "NOTE") assert.doesNotMatch(first, /^[^\p{L}]/u, `${label} begins with the operation's name, not a glyph: ${JSON.stringify(first)}`);
    }

    assert.equal(stripAnsi(rows[0][1]), "READ (/x)");
    assert.equal(stripAnsi(rows[1][1]), "FIND (/x) — Entry not found", "a failure carries its title, not a numeric code");
    assert.equal(stripAnsi(rows[2][1]), "\n    Inspect.\n", "a model NOTE is a blank row, its body four columns in, and a blank row");
    assert.equal(stripAnsi(rows[4][1]), "\ndone", "a delivered message is its body under a blank line");
    assert.equal(stripAnsi(rows[6][1]), "SEND (worker:///gone) — Worker gone");
    assert.equal(stripAnsi(rows[7][1]), "sh list the files", "an execution is its fence, once, at its conclusion");
    assert.equal(streams.event({ entryId: 8, workerId: 7, target: "sh:///1a2b3c4d", channel: "stdout", state: "active", contentLength: 0 }), null);
});
