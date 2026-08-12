// The waterfall alignment GAUGE (operator, 2026-07-10): every rendered line species
// carries exactly TWO emoji lanes (identity · status — blanks reserved, never
// omitted), and the status-code column sits at ONE display column across all of
// them. Measured, not eyeballed: strip ANSI, count display cells (the repo's glyph
// convention is plane-1/EAW width-2, VS16-free), find the code token, compare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLogEntry } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import StreamTrace from "./stream.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// Display width under the repo convention: wide (EAW W/F — emoji, CJK) = 2 cells.
const cells = (s: string): number => {
    let w = 0;
    for (const ch of s) {
        const cp = ch.codePointAt(0) ?? 0;
        w += (cp >= 0x1100 && (
            cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
            || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
            || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
            || (cp >= 0x1f000 && cp <= 0x1ffff) || (cp >= 0x20000 && cp <= 0x3fffd)
            || cp === 0x2705 || cp === 0x274c || cp === 0x2753 || cp === 0x270b || (cp >= 0x231a && cp <= 0x23ff)
        )) ? 2 : 1;
    }
    return w;
};

// The display column where the 3-digit status code begins.
const codeColumn = (line: string): number => {
    const plain = stripAnsi(line);
    const m = /(?:^|\s)(\d{3})(?:\s|$)/.exec(plain);
    assert.ok(m !== null, `no status code in: ${JSON.stringify(plain)}`);
    return cells(plain.slice(0, m.index + (m[0].startsWith(" ") ? 1 : 0)));
};

const entry = (over: Partial<LogEntryWire>): LogEntryWire => ({
    id: 1, loop_seq: 1, turn_seq: 1, sequence: 5, op: "READ", suffix: "", origin: "model",
    signal: null, scheme: "file", pathname: "/x", hostname: null, fragment: null,
    tx: { body: "b" }, rx: "ok", status_rx: 200, tags: [],
    ...over,
});

test("[§cli-rendering] every line species puts the status code in ONE display column (two glyph lanes, blanks reserved)", () => {
    const streams = new StreamTrace();
    const lines: Array<[string, string]> = [
        ["op 200 (blank status lane)", renderLogEntry(entry({}))],
        ["op 404 (glyph status lane)", renderLogEntry(entry({ op: "FIND", status_rx: 404 }))],
        ["exec 202 (parked)", renderLogEntry(entry({ op: "EXEC", status_rx: 202, signal: 202 }))],
        ["model SEND 102", renderLogEntry(entry({ op: "SEND", origin: "model", signal: 102, status_rx: 102, tx: { body: { raw: "thinking on" } } }))],
        ["model SEND 200 (answer)", renderLogEntry(entry({ op: "SEND", origin: "model", signal: 200, status_rx: 200, tx: { body: { raw: "pong" } } }))],
        ["user SEND 201 (prompt row)", renderLogEntry(entry({ op: "SEND", origin: "client", signal: 201, status_rx: 201, tx: { body: { raw: "hi" } } }))],
        ["stream concluded 200", streams.concluded({ entryId: 9, workerId: 7, target: "sh:///1/1/9", subscriptionId: 1, scheme: "sh", result: { status: 200 }, summary: "done", wakeAction: "no-op-active-loop", loop_seq: 1, turn_seq: 1, sequence: 9 })],
        ["stream concluded 499", streams.concluded({ entryId: 9, workerId: 7, target: "sh:///1/1/9", subscriptionId: 1, scheme: "sh", result: { status: 499, problem: { type: "https://problems.plurnk.dev/client/stream/cancelled", title: "Cancelled", status: 499, detail: "The stream was cancelled." } }, summary: "cancelled", wakeAction: "no-op-active-loop", loop_seq: 1, turn_seq: 1, sequence: 9 })],
    ];
    const cols = lines.map(([label, line]) => {
        const first = stripAnsi(line).split("\n")[0];
        return [label, codeColumn(first)] as const;
    });
    const want = cols[0][1];
    for (const [label, col] of cols) {
        assert.equal(col, want, `status column drift: "${label}" at cell ${col}, expected ${want}\n${cols.map(([l, c]) => `  ${c}  ${l}`).join("\n")}`);
    }
});
