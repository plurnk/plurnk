// The waterfall's stable alignment contract is its left edge. Glyph-bearing
// rows begin at column zero; SEND lifecycle glyphs replace redundant human
// protocol codes, while non-SEND failures retain useful diagnostic codes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLogEntry, renderReasoning } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import StreamTrace from "./stream.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const entry = (over: Partial<LogEntryWire>): LogEntryWire => ({
    id: 1, loop_seq: 1, turn_seq: 1, sequence: 5, op: "READ", suffix: "", origin: "model",
    signal: null, scheme: "file", pathname: "/x", hostname: null, fragment: null,
    lineMarker: null, tx: { body: "b" }, rx: "ok", status_rx: 200, tags: [],
    ...over,
});

test("[§cli-rendering] glyph-bearing waterfall rows share the left edge and SENDs are codeless", () => {
    const streams = new StreamTrace();
    const rows: Array<[string, string]> = [
        ["operation", renderLogEntry(entry({}))],
        ["operation failure", renderLogEntry(entry({ op: "FIND", status_rx: 404 }))],
        ["PLAN", renderLogEntry(entry({ op: "PLAN", tx: { body: { entries: [{ content: "Inspect.", priority: "medium", status: "in_progress" }] } } }))],
        ["reasoning", renderReasoning("Inspect the contract.")],
        ["model SEND 102", renderLogEntry(entry({ op: "SEND", origin: "model", scheme: null, pathname: null, signal: 102, status_rx: 102, tx: { body: { raw: "continuing" } } }))],
        ["model SEND 200", renderLogEntry(entry({ op: "SEND", origin: "model", scheme: null, pathname: null, signal: 200, status_rx: 200, tx: { body: { raw: "done" } } }))],
        ["client SEND", renderLogEntry(entry({ op: "SEND", origin: "client", scheme: null, pathname: null, signal: 201, status_rx: 201, tx: { body: { raw: "hello" } } }))],
        ["directed SEND failure", renderLogEntry(entry({ op: "SEND", origin: "model", scheme: "worker", pathname: "/gone", signal: 410, status_rx: 410 }))],
        ["stream event", streams.event({ entryId: 8, workerId: 7, target: "sh:///1/1/8", channel: "stdout", state: "active", contentLength: 0 }) ?? ""],
        ["stream conclusion", streams.concluded({ entryId: 8, workerId: 7, target: "sh:///1/1/8", subscriptionId: 1, scheme: "sh", result: { status: 200 }, summary: "done", wakeAction: "no-loop" })],
    ];

    for (const [label, value] of rows) {
        const first = stripAnsi(value).split("\n")[0];
        assert.doesNotMatch(first, /^\s/, `${label} did not begin at column zero: ${JSON.stringify(first)}`);
    }

    const continuing = stripAnsi(rows[4][1]);
    const complete = stripAnsi(rows[5][1]);
    assert.match(continuing, /^▶️/);
    assert.doesNotMatch(continuing, /(?:^|\s)102(?:\s|$)/);
    assert.match(complete, /^⏹️/);
    assert.doesNotMatch(complete, /(?:^|\s)200(?:\s|$)/);
    assert.match(stripAnsi(rows[1][1]), /❌ 404/, "non-SEND failures retain their exact diagnostic code");
    assert.match(stripAnsi(rows[7][1]), /❌ 410/, "a directed SEND failure remains diagnosable");
});
