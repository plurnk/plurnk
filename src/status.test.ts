import { test } from "node:test";
import assert from "node:assert/strict";
import TerminalStatusLine, { turnAccountingFromNotice, accrueTurnAccounting, EMPTY_TALLY, derivationActivity, formatRouteIdentity, renderStatusLine, tallyOutcome, type ClientStatus, type StatusContext } from "./status.ts";

const CONTEXT: StatusContext = { workspace: "k3Zp9", worker: "model-1", child: null, tally: EMPTY_TALLY, runningSince: 1_000, now: 4_200 };

const running: ClientStatus = {
    lifecycle: "running",
    model: "deepdumb",
    packetCount: 2,
    activity: null,
};

test("[§cli-worker-status] status presentation uses only client-owned facts", () => {
    assert.equal(renderStatusLine(running, CONTEXT), "⌛︎ running · 2 turns · 3.2s · 🎲 deepdumb · k3Zp9 · worker://model-1/");
    assert.equal(renderStatusLine(running, { ...CONTEXT, child: "rtx5070" }), "⌛︎ running · 2 turns · 3.2s · 🎲 deepdumb · 🐜 rtx5070 · k3Zp9 · worker://model-1/", "a spawn override rides beside the model");
    const concluded = tallyOutcome(tallyOutcome(EMPTY_TALLY, { turns: 1, wallMs: 5_000 }), {
        turns: 2, wallMs: 60_000,
        usage: { accounting: { usage: { inputTokens: 1200, outputTokens: 345 }, costUsd: "0.024" } } as never,
    });
    assert.deepEqual(concluded, { turns: 3, wallMs: 65_000, inputTokens: 1200, outputTokens: 345, costUsd: "0.024" });
    assert.equal(tallyOutcome(concluded, { turns: 1, wallMs: 1, usage: { accounting: { usage: { inputTokens: 10, outputTokens: 5 }, costUsd: "0.0125" } } as never }).costUsd, "0.0365");
    assert.equal(
        renderStatusLine({ ...running, lifecycle: "completed", activity: { label: "indexing", percent: 55 } }, { ...CONTEXT, tally: concluded, runningSince: null }),
        "⏹️ completed · 3 turns · 1m05s · ↓1200 ↑345 · $0.024 · 🎲 deepdumb · k3Zp9 · worker://model-1/ · 🧮 55%",
    );
    assert.equal(renderStatusLine({ lifecycle: "idle", model: null, packetCount: null, activity: null }, { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, runningSince: null }, { idleGlyph: "🔥" }), "🔥 idle");
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
    const line = new TerminalStatusLine((value) => writes.push(value), true, running, CONTEXT, {
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
    assert.match(writes[0] ?? "", /🧮 1%/);
    assert.match(writes[1] ?? "", /🧮 60%/);
    assert.doesNotMatch(writes.join(""), /🧮 20%/);

    const quiet: string[] = [];
    const nonTty = new TerminalStatusLine((value) => quiet.push(value), false, running, CONTEXT);
    nonTty.update({ activity: { label: "indexing", percent: 25 } }, { routine: true });
    assert.deepEqual(quiet, []);
});

test("TerminalStatusLine clears and restores its row around stdout on a shared terminal", () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const line = new TerminalStatusLine((value) => stderr.push(value), true, running, CONTEXT);
    line.update({});
    line.product("answer\n", (value) => stdout.push(value), true);
    assert.deepEqual(stdout, ["answer\n"]);
    assert.equal(stderr[1], "\r\x1b[2K");
    assert.match(stderr[2] ?? "", /deepdumb/);
});

test("formatRouteIdentity renders effort with the identity and stays bare without it (plurnk#41)", () => {
    assert.equal(formatRouteIdentity({ alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash", reasoningPolicy: "low" }), "deepdumb[low]");
    assert.equal(formatRouteIdentity({ provider: "cloudflare", model: "@cf/zai-org/glm-5.3-flash", reasoningPolicy: "low" }), "cloudflare/@cf/zai-org/glm-5.3-flash[low]");
    assert.equal(formatRouteIdentity({ alias: "fireox", provider: "fireworks", model: "accounts/fireworks/models/glm-5p3-flash", reasoningPolicy: "off" }), "fireox[off]");
    assert.equal(formatRouteIdentity({ alias: "plain", provider: "p", model: "m" }), "plain", "no reasoning dimension - no brackets");
});

test("#465: turn accounting parses, accrues decimal-exact, and rides the running status line", () => {
    const turn = turnAccountingFromNotice({ source: "engine:turn", kind: "turn_generated", accounting: { costUsd: "0.01", inputTokens: 100, outputTokens: 20 } });
    assert.deepEqual(turn, { costUsd: "0.01", inputTokens: 100, outputTokens: 20 });
    assert.equal(turnAccountingFromNotice({ source: "engine:turn", kind: "turn_awaiting_model" }), null);
    assert.equal(turnAccountingFromNotice({ source: "engine:provider", kind: "turn_generated", accounting: {} }), null);
    const accrued = accrueTurnAccounting(turn!, { costUsd: "0.005", inputTokens: 50, outputTokens: 5 });
    assert.deepEqual(accrued, { costUsd: "0.015", inputTokens: 150, outputTokens: 25 });
    const line = renderStatusLine(
        { lifecycle: "running", model: null, packetCount: 2, activity: null },
        { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, accrued, runningSince: 1000, now: 3000 },
    );
    assert.match(line, /↓150 ↑25/);
    assert.match(line, /\$0\.015/);
    const idle = renderStatusLine(
        { lifecycle: "completed", model: null, packetCount: null, activity: null },
        { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, accrued, runningSince: null },
    );
    assert.doesNotMatch(idle, /\$0\.015/, "a concluded line shows only the concluded tally");
});
