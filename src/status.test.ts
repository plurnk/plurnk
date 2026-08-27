import { test } from "node:test";
import assert from "node:assert/strict";
import TerminalStatusLine, { derivationActivity, renderStatusLine, type ClientStatus } from "./status.ts";

const running: ClientStatus = {
    lifecycle: "running",
    model: "deepdumb",
    packetCount: 2,
    activity: null,
};

test("[§cli-worker-status] status presentation uses only client-owned facts", () => {
    assert.equal(renderStatusLine(running), "⌛︎ · 🤖 deepdumb · P2");
    assert.equal(renderStatusLine({ ...running, lifecycle: "completed", activity: { label: "indexing", percent: 55 } }), "⏹️ · 🤖 deepdumb · P2 · indexing 55%");
    assert.equal(renderStatusLine({ lifecycle: "idle", model: null, packetCount: null, activity: null }, { idleGlyph: "🔥" }), "🔥");
});

test("derivationActivity recognizes progress, terminal clear, and failure", () => {
    assert.deepEqual(derivationActivity({
        source: "engine:derivation", kind: "embed_progress", level: "info",
        phase: "indexing", completed: 3, total: 10,
    }), { label: "indexing", percent: 30 });
    assert.equal(derivationActivity({
        source: "engine:derivation", kind: "embed_progress", level: "info",
        phase: "complete", completed: 10, total: 10,
    }), null);
    assert.deepEqual(derivationActivity({
        source: "engine:derivation", kind: "embed_progress", level: "warn",
        phase: "failed",
    }), { label: "indexing failed", percent: null });
    assert.equal(derivationActivity({ source: "engine", kind: "note", level: "info" }), undefined);
});

test("TerminalStatusLine coalesces routine progress and leaves non-TTY output silent", () => {
    const writes: string[] = [];
    let now = 0;
    const line = new TerminalStatusLine((value) => writes.push(value), true, running, {
        intervalMs: 15_000,
        now: () => now,
    });
    line.update({ activity: { label: "indexing", percent: 1 } }, { routine: true });
    now = 5_000;
    line.update({ activity: { label: "indexing", percent: 20 } }, { routine: true });
    now = 15_000;
    line.update({ activity: { label: "indexing", percent: 60 } }, { routine: true });
    line.update({ activity: null }, { routine: true });
    line.settle();
    assert.equal(writes.length, 4, "start, one 15-second heartbeat, terminal clear, and settle");
    assert.match(writes[0] ?? "", /indexing 1%/);
    assert.match(writes[1] ?? "", /indexing 60%/);
    assert.doesNotMatch(writes.join(""), /indexing 20%/);

    const quiet: string[] = [];
    const nonTty = new TerminalStatusLine((value) => quiet.push(value), false, running);
    nonTty.update({ activity: { label: "indexing", percent: 25 } }, { routine: true });
    assert.deepEqual(quiet, []);
});

test("TerminalStatusLine clears and restores its row around stdout on a shared terminal", () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const line = new TerminalStatusLine((value) => stderr.push(value), true, running);
    line.update({});
    line.product("answer\n", (value) => stdout.push(value), true);
    assert.deepEqual(stdout, ["answer\n"]);
    assert.equal(stderr[1], "\r\x1b[2K");
    assert.match(stderr[2] ?? "", /deepdumb/);
});
