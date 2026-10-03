import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import TerminalStatusLine, { conversationLost, turnAccountingFromNotice, accrueTurnAccounting, EMPTY_TALLY, projectStatusGauge, formatRouteIdentity, renderStatusLine, tallyOutcome, type ClientStatus, type StatusContext } from "./status.ts";

const CONTEXT: StatusContext = { workspace: "k3Zp9", worker: "model-1", child: null, tally: EMPTY_TALLY, runningSince: 1_000, now: 4_200 };

const running: ClientStatus = {
    lifecycle: "running",
    model: "deepdumb",
    loopId: null,
    packetCount: 2,
    activity: null,
    children: null,
};

test("[§cli-status-wait] the parked countdown uses the daemon deadline and clears on wake", () => {
    const gauge = { lifecycle: "parked", model: null, loopId: 1, packetCount: 2, activity: null, waitUntil: 304_200 };
    const status = projectStatusGauge(gauge);
    assert.match(renderStatusLine(status, CONTEXT), /updates in 5m00s/);
    assert.match(renderStatusLine(status, { ...CONTEXT, now: 5_200 }), /updates in 4m59s/);
    assert.match(renderStatusLine(status, { ...CONTEXT, now: 304_201 }), /updates due/);
    assert.doesNotMatch(renderStatusLine(projectStatusGauge({ ...gauge, lifecycle: "queued", waitUntil: null }), CONTEXT), /updates/);
    assert.doesNotMatch(renderStatusLine(projectStatusGauge({ ...gauge, waitUntil: null }), CONTEXT), /updates/,
        "provider recovery and review have no invented observation deadline");
    assert.doesNotMatch(renderStatusLine({ ...status, lifecycle: "completed" }, CONTEXT), /updates/);
    for (const waitUntil of [-1, Infinity, NaN, "soon"]) {
        assert.throws(() => projectStatusGauge({ ...gauge, waitUntil }), /Invalid runtime wait deadline/);
    }
});

test("[§cli-status-preparation] preparation names the capability and advances its clock before inference", () => {
    const base = { lifecycle: "queued", model: null, loopId: 1, packetCount: 0, activity: null };
    const preparation = [{ family: "mcp", alias: "search", phase: "preparing", since: new Date(1_000).toISOString() }];
    const status = projectStatusGauge({ ...base, preparation });
    assert.match(renderStatusLine(status, CONTEXT), /preparing mcp\/search 3\.2s/);
    assert.match(renderStatusLine(status, { ...CONTEXT, now: 11_000 }), /preparing mcp\/search 10\.0s/);
    assert.doesNotMatch(renderStatusLine(status, CONTEXT), /awaiting model|🧮/);
    const idle = projectStatusGauge({ ...base, lifecycle: "idle", preparation });
    assert.match(renderStatusLine(idle, CONTEXT), /preparing mcp\/search/);
    const settled = projectStatusGauge({ ...base, preparation: [] });
    assert.doesNotMatch(renderStatusLine(settled, CONTEXT), /preparing mcp/);
    for (const invalid of [null, {}, [{}], [{ ...preparation[0], since: "yesterday" }], [{ ...preparation[0], phase: "ready" }]]) {
        assert.throws(() => projectStatusGauge({ ...base, preparation: invalid }), /Invalid runtime preparation/);
    }
});

test("[§cli-status-descendants] cumulative child snapshots replace their prior value and settle once", () => {
    const gauge = { lifecycle: "parked", model: null, loopId: 2, packetCount: 1, activity: null, descendants: {
        requests: 1, usage: { inputTokens: 200, outputTokens: 20 }, knownUsage: { inputTokens: 200, outputTokens: 20 }, costUsd: "0.0200", knownCostUsd: "0.0200",
    } };
    const status = projectStatusGauge(gauge);
    const own = { inputTokens: 100, outputTokens: 10, costUsd: "0.0100", knownCostUsd: "0.0100", knownInputTokens: 100, knownOutputTokens: 10 };
    const context = { ...CONTEXT, accrued: own };
    const first = renderStatusLine(status, context);
    assert.match(first, /↓300 ↑30 · \$0\.0300/);
    assert.equal(renderStatusLine(projectStatusGauge(gauge), context), first, "a repeated snapshot adds no spend");
    const updated = projectStatusGauge({ ...gauge, descendants: {
        requests: 2, usage: { inputTokens: 600, outputTokens: 60 }, knownUsage: { inputTokens: 600, outputTokens: 60 }, costUsd: "0.0600", knownCostUsd: "0.0600",
    } });
    assert.match(renderStatusLine(updated, context), /↓700 ↑70 · \$0\.0700/);
    const tally = tallyOutcome(EMPTY_TALLY, {
        turns: 1, wallMs: 5000, usage: { accounting: { usage: { inputTokens: 100, outputTokens: 10 }, knownUsage: { inputTokens: 100, outputTokens: 10 }, costUsd: own.costUsd, knownCostUsd: own.costUsd } } as never,
        descendants: updated.descendants,
    });
    assert.deepEqual(tally, { turns: 1, wallMs: 5000, accounting: { inputTokens: 700, outputTokens: 70, costUsd: "0.0700", knownCostUsd: "0.0700", knownInputTokens: 700, knownOutputTokens: 70 } });
    assert.match(renderStatusLine({ ...updated, lifecycle: "completed" }, { ...context, tally, runningSince: null }), /↓700 ↑70 · \$0\.0700/);
    assert.match(renderStatusLine({ ...updated, loopId: 3, lifecycle: "running", descendants: null }, {
        ...context, tally, accrued: own,
    }), /↓800 ↑80 · \$0\.0800/, "the following loop does not charge last loop's children again");
});

test("[§cli-status-descendants] absent evidence is not zero and malformed evidence is rejected", () => {
    const base = { lifecycle: "running", model: null, loopId: 1, packetCount: 0, activity: null };
    const unknown = projectStatusGauge({ ...base, descendants: { requests: 1, usage: null, knownUsage: null, costUsd: null, knownCostUsd: null } });
    assert.deepEqual(unknown.descendants, { inputTokens: null, outputTokens: null, costUsd: null, knownCostUsd: null, knownInputTokens: null, knownOutputTokens: null });
    assert.equal(projectStatusGauge({ ...base, descendants: { requests: 0, usage: null, knownUsage: null, costUsd: null, knownCostUsd: null } }).descendants, null);
    for (const descendants of [null, {}, { requests: -1, usage: null, knownUsage: null, costUsd: null, knownCostUsd: null },
        { requests: 1, usage: { inputTokens: -1 }, knownUsage: { inputTokens: -1 }, costUsd: null, knownCostUsd: null }, { requests: 1, usage: null, knownUsage: null, costUsd: "NaN", knownCostUsd: "NaN" }]) {
        assert.throws(() => projectStatusGauge({ ...base, descendants }), /Invalid runtime descendant accounting/);
    }
});

test("[§cli-status-descendants] one-shot human status retains the child subtotal at settlement", () => {
    const writes: string[] = [];
    const line = new TerminalStatusLine((text) => writes.push(text), true, {
        ...running, descendants: { inputTokens: 200, outputTokens: 20, costUsd: "0.02", knownCostUsd: "0.02", knownInputTokens: 200, knownOutputTokens: 20 },
    }, CONTEXT);
    line.accrue({ inputTokens: 100, outputTokens: 10, costUsd: "0.01", knownCostUsd: "0.01", knownInputTokens: 100, knownOutputTokens: 10 });
    assert.match(writes.at(-1)!, /↓300 ↑30 · \$0\.0300/);
    line.update({ lifecycle: "completed" });
    line.settle({ turns: 1, wallMs: 3200, usage: {
        accounting: { usage: { inputTokens: 100, outputTokens: 10 }, knownUsage: { inputTokens: 100, outputTokens: 10 }, costUsd: "0.01", knownCostUsd: "0.01" },
    } as never });
    assert.match(writes.at(-2)!, /⏹️[^\r\n]*↓300 ↑30 · \$0\.0300/);
});

test("[§cli-worker-status] status presentation uses only client-owned facts", () => {
    assert.equal(renderStatusLine(running, CONTEXT), "⌛︎  · 🎲 deepdumb · 3.2s");
    assert.equal(renderStatusLine(running, { ...CONTEXT, child: "rtx5070" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 rtx5070", "a spawn override rides beside the model");
    const concluded = tallyOutcome(tallyOutcome(EMPTY_TALLY, { turns: 1, wallMs: 5_000 }), {
        turns: 2, wallMs: 60_000,
        usage: { accounting: { usage: { inputTokens: 1200, outputTokens: 345 }, knownUsage: { inputTokens: 1200, outputTokens: 345 }, costUsd: "0.024", knownCostUsd: "0.024" } } as never,
    });
    assert.deepEqual(concluded, { turns: 3, wallMs: 65_000, accounting: { inputTokens: null, outputTokens: null, costUsd: null, knownCostUsd: "0.024", knownInputTokens: 1200, knownOutputTokens: 345 } });
    const later = tallyOutcome(concluded, { turns: 1, wallMs: 1, usage: { accounting: { usage: { inputTokens: 10, outputTokens: 5 }, knownUsage: { inputTokens: 10, outputTokens: 5 }, costUsd: "0.0125", knownCostUsd: "0.0125" } } as never });
    assert.equal(later.accounting?.costUsd, null);
    assert.equal(later.accounting?.knownCostUsd, "0.0365");
    assert.equal(
        renderStatusLine({ ...running, lifecycle: "completed", activity: { label: "indexing", percent: 55 } }, { ...CONTEXT, tally: concluded, runningSince: null }),
        "⏹️  · 🎲 deepdumb · 1m05s · ↓1k+? ↑345+? · $0.0240 + ? · 🧮 55%",
    );
    assert.equal(renderStatusLine({ lifecycle: "idle", model: null, loopId: null, packetCount: null, activity: null, children: null }, { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, runningSince: null }, { yolo: true }), "🔥");
    assert.equal(renderStatusLine(running, CONTEXT, { yolo: true }), "🔥 ⌛︎  · 🎲 deepdumb · 3.2s", "{plurnk#104} YOLO is a fireball at the left edge, and the model sits ahead of what ticks");
});

test("[§cli-status-project-root] status displays the bound workspace folder without inventing a local root", () => {
    const gauge = { lifecycle: "idle", model: null, loopId: null, packetCount: 0, activity: null };
    const path = "/projects/client work/日本語";
    const status = projectStatusGauge(gauge, path);
    assert.equal(status.projectRoot, path);
    assert.equal(renderStatusLine(status, CONTEXT), `${path} idle`);
    assert.equal(renderStatusLine(projectStatusGauge(gauge, null), CONTEXT), "idle", "headless is not the client cwd");
    assert.equal(renderStatusLine(projectStatusGauge(gauge), CONTEXT), "idle", "no workspace projection means no known root");
    assert.throws(() => projectStatusGauge(gauge, 42 as never), /Invalid workspace project root/u);
    assert.equal(renderStatusLine({ ...status, projectRoot: "/repo\n\t\x1b]2;not-a-title\x07name" }, CONTEXT), "/repo\\n\\tname idle",
        "path controls cannot change the terminal title or create status rows");
    for (const place of ["[work/1/9:main]", "[work/100/1000:main]"]) {
        assert.equal(renderStatusLine({ ...running, projectRoot: path }, { ...CONTEXT, place }, { yolo: true }),
            `${path} ${place} 🔥 ⌛︎  · 🎲 deepdumb · 3.2s`,
            "the folder starts the complete footer, before even the changing turn coordinates");
    }
});

// {§cli-status-children} {§cli-workers-topology} — the ant is the daemon's alive-children count, the
// child model rides beside it, and the worker segment carries the sibling position.
test("[§cli-status-project-root] the TUI omits a redundant folder and shortens other home paths", () => {
    const root = join(homedir(), "projects", "client");
    const status = { ...running, projectRoot: root };
    const activity = renderStatusLine(running, CONTEXT);
    const place = "[~/projects/client/~user]";
    for (const workspace of ["~/projects/client", root]) {
        assert.equal(renderStatusLine(status, { ...CONTEXT, workspace, place }), `${place} ${activity}`);
    }
    assert.equal(renderStatusLine(status, { ...CONTEXT, workspace: "named", place: "[named/~user]" }),
        `~/projects/client [named/~user] ${activity}`);
    assert.equal(renderStatusLine(status, { ...CONTEXT, workspace: "~/projects/client" }),
        `~/projects/client ${activity}`, "the CLI has no workspace label to replace the folder");
    assert.equal(renderStatusLine({ ...status, projectRoot: null }, { ...CONTEXT, place }), `${place} ${activity}`);
});

test("[§cli-status-children] the ant counts children from the gauge and the worker segment carries the sibling position", () => {
    assert.equal(renderStatusLine({ ...running, children: 0 }, CONTEXT), "⌛︎  · 🎲 deepdumb · 3.2s");
    assert.equal(renderStatusLine({ ...running, children: 0 }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s", "a configured child model is not active child work");
    assert.equal(renderStatusLine({ ...running, children: 2 }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 2 dumbox");
    assert.equal(renderStatusLine({ ...running, children: null }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 dumbox", "no gauge, no count: the bare child model");
    assert.equal(renderStatusLine({ ...running, children: 1 }, { ...CONTEXT, worker: "recheck", position: { index: 2, count: 3 } }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 1", "the place is the prompt prefix's, not the status line's");
    assert.equal(projectStatusGauge({ lifecycle: "parked", model: null, loopId: 4, packetCount: 1, activity: null, children: 3 }).children, 3);
    assert.equal(projectStatusGauge({ lifecycle: "parked", model: null, loopId: 4, packetCount: 1, activity: null }).children, null, "an older daemon states no count");
    assert.throws(() => projectStatusGauge({ lifecycle: "parked", model: null, loopId: 4, packetCount: 1, activity: null, children: -1 }), /Invalid runtime children count/u);
});

test("[§cli-status-children] the live child indicator disappears when the last child concludes", () => {
    const writes: string[] = [];
    const line = new TerminalStatusLine((value) => writes.push(value), true, running, { ...CONTEXT, child: "dumbox" });
    line.update({ children: 2 });
    assert.match(writes.at(-1)!, /🐜 2 dumbox/);
    line.update({ children: 0 });
    assert.doesNotMatch(writes.at(-1)!, /🐜|dumbox/);
});

test("the authoritative status gauge projects indexing phases without a Notice reducer", () => {
    const gauge = { lifecycle: "running", model: null, loopId: 1, packetCount: 0, activity: null as unknown };
    for (const [phase, label] of [["preparing", "preparing"], ["indexing", "indexing"], ["failed", "indexing failed"]]) {
        assert.deepEqual(projectStatusGauge({ ...gauge, activity: { kind: "derivation", phase, percent: 30 } }).activity, { label, percent: 30 });
    }
    assert.equal(projectStatusGauge(gauge).activity, null);
});

test("[§cli-worker-status] queued work retains its lifecycle while elapsed wall time accrues", () => {
    const projected = projectStatusGauge({ lifecycle: "queued", model: null, loopId: 7, packetCount: 0, activity: null });
    assert.equal(projected.lifecycle, "queued");
    assert.equal(renderStatusLine(projected, { ...CONTEXT, workspace: null, worker: null }), "⏳  · 3.2s");
});

test("[§cli-worker-status] waiting and resumption preserve one continuous wall clock", () => {
    const tally = { ...EMPTY_TALLY, turns: 2, wallMs: 362_000 };
    for (const lifecycle of ["queued", "running", "parked"] as const) {
        const status = { ...running, lifecycle };
        const context = { ...CONTEXT, tally, now: 62_000 };
        assert.match(renderStatusLine(status, context), / · 7m03s(?: ·|$)/u, lifecycle);
        assert.match(renderStatusLine(status, { ...context, now: 63_000 }), / · 7m04s(?: ·|$)/u, `${lifecycle} advances without an event`);
    }
    for (const lifecycle of ["idle", "completed", "cancelled", "failed"] as const) {
        assert.match(renderStatusLine({ ...running, lifecycle }, { ...CONTEXT, tally }), / · 6m02s(?: ·|$)/u,
            `${lifecycle} excludes any stale running clock`);
    }
    assert.doesNotMatch(renderStatusLine({ ...running, lifecycle: "parked" }, { ...CONTEXT, runningSince: null }), /\d(?:ms|s|m)/u,
        "an observation without a known start must not invent elapsed time");
});

test("TerminalStatusLine coalesces routine progress and leaves non-TTY output silent", () => {
    const writes: string[] = [];
    let now = 0;
    const line = new TerminalStatusLine((value) => writes.push(value), true, running, CONTEXT, {
        intervalMs: 15_000,
        now: () => now,
    });
    line.update({ activity: { label: "indexing", percent: 1 } });
    now = 5_000;
    line.update({ activity: { label: "indexing", percent: 20 } });
    now = 15_000;
    line.update({ activity: { label: "indexing", percent: 60 } });
    line.update({ activity: null });
    line.settle();
    assert.equal(writes.length, 4, "start, one 15-second heartbeat, terminal clear, and settle");
    assert.match(writes[0] ?? "", /🧮 1%/);
    assert.match(writes[1] ?? "", /🧮 60%/);
    assert.doesNotMatch(writes.join(""), /🧮 20%/);

    const quiet: string[] = [];
    const nonTty = new TerminalStatusLine((value) => quiet.push(value), false, running, CONTEXT);
    nonTty.update({ activity: { label: "indexing", percent: 25 } });
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
    assert.equal(formatRouteIdentity({ alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash", effort: "low" }), "deepdumb[low]");
    assert.equal(formatRouteIdentity({ provider: "cloudflare", model: "@cf/zai-org/glm-5.3-flash", effort: "low" }), "cloudflare/@cf/zai-org/glm-5.3-flash[low]");
    assert.equal(formatRouteIdentity({ alias: "fireox", provider: "fireworks", model: "accounts/fireworks/models/glm-5p3-flash", effort: "off" }), "fireox[off]");
    assert.equal(formatRouteIdentity({ alias: "plain", provider: "p", model: "m" }), "plain", "no reasoning dimension - no brackets");
});

test("[§cli-identity-effort] brackets read as chosen, parentheses as given (plurnk#41 ask 2, service#528)", () => {
    const route = { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash", effort: "low" };
    assert.equal(formatRouteIdentity({ ...route, effortSource: "explicit" }), "deepdumb[low]", "an /effort selection");
    assert.equal(formatRouteIdentity({ ...route, effortSource: "default" }), "deepdumb(low)", "the daemon seeded it from the alias");
    assert.equal(formatRouteIdentity(route), "deepdumb[low]", "an older daemon that states no source renders as before");
    assert.equal(formatRouteIdentity({ alias: "plain", provider: "p", model: "m", effortSource: "default" }), "plain", "no policy, no marker");
});

test("#465: turn accounting parses, accrues decimal-exact, and rides the running status line", () => {
    const turn = turnAccountingFromNotice({ source: "engine:turn", kind: "turn_generated", accounting: { costUsd: "0.01", knownCostUsd: "0.01", inputTokens: 100, outputTokens: 20, knownInputTokens: 100, knownOutputTokens: 20 } });
    assert.deepEqual(turn, { costUsd: "0.01", knownCostUsd: "0.01", inputTokens: 100, outputTokens: 20, knownInputTokens: 100, knownOutputTokens: 20 });
    assert.equal(turnAccountingFromNotice({ source: "engine:turn", kind: "turn_awaiting_model" }), null);
    assert.equal(turnAccountingFromNotice({ source: "engine:provider", kind: "turn_generated", accounting: {} }), null);
    const accrued = accrueTurnAccounting(turn!, { costUsd: "0.005", knownCostUsd: "0.005", inputTokens: 50, outputTokens: 5, knownInputTokens: 50, knownOutputTokens: 5 });
    assert.deepEqual(accrued, { costUsd: "0.015", knownCostUsd: "0.015", inputTokens: 150, outputTokens: 25, knownInputTokens: 150, knownOutputTokens: 25 });
    const line = renderStatusLine(
        { lifecycle: "running", model: null, loopId: null, packetCount: 2, activity: null, children: null },
        { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, accrued, runningSince: 1000, now: 3000 },
    );
    assert.match(line, /↓150 ↑25/);
    assert.match(renderStatusLine(
        { lifecycle: "running", model: null, loopId: null, packetCount: 2, activity: null, children: null },
        { workspace: null, worker: null, child: null, tally: { ...EMPTY_TALLY, accounting: { ...accrued, inputTokens: 1234567, outputTokens: 9876 } }, runningSince: null },
    ), /↓1\.2M ↑10k/u, "token counts are abbreviated: 582k, 1.2M");
    assert.match(line, /\$0\.0150/, "spend to the hundredth of a cent");
    const idle = renderStatusLine(
        { lifecycle: "completed", model: null, loopId: null, packetCount: null, activity: null, children: null },
        { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, accrued, runningSince: null },
    );
    assert.doesNotMatch(idle, /\$0\.0150/, "a concluded line shows only the concluded tally");
    assert.match(renderStatusLine(
        { lifecycle: "parked", model: null, loopId: 1, packetCount: 2, activity: null, children: null },
        { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, accrued, runningSince: null },
    ), /↓150 ↑25.*\$0\.0150/, "parking does not hide already-settled spend");
});

// {plurnk#91} — a busy turn must not look like a hang.
test("the status line names what the worker is doing, and nothing when it is idle", () => {
    const awaiting = { phase: "awaiting" as const, since: 1_200, op: null, target: null };
    assert.equal(renderStatusLine(running, { ...CONTEXT, doing: awaiting }), "⌛︎  · 🎲 deepdumb · 3.2s · awaiting model 3.0s",
        "the quiet part is named, with how long it has been quiet");
    const reading = { phase: "working" as const, since: 3_000, op: "READ", target: "plurnk-contracts/SPEC.md" };
    assert.equal(renderStatusLine(running, { ...CONTEXT, doing: reading }), "⌛︎  · 🎲 deepdumb · 3.2s · READ plurnk-contracts/SPEC.md");
    const deep = { ...reading, target: "worker:///_plurnk/plurnk/very/deeply/nested/path/to/some/file.md" };
    assert.match(renderStatusLine(running, { ...CONTEXT, doing: deep }), /READ …[^ ]*some\/file\.md$/u,
        "a long address keeps its end, which is the part that tells files apart");
    assert.equal(renderStatusLine({ ...running, lifecycle: "idle" }, { ...CONTEXT, doing: reading }).includes("READ"), false,
        "an idle worker is doing nothing, whatever the last operation was");
});

test("[§cli-conversation-lost] a gauge without a loop after one with a loop marks the conversation new", () => {
    assert.equal(conversationLost(37, null), true, "history seen, then none: the daemon minted the conversation anew");
    assert.equal(conversationLost(null, null), false, "a first gauge without a loop is the new conversation the client expects");
    assert.equal(conversationLost(37, 38), false, "a later loop is the same conversation continuing");
    assert.equal(conversationLost(null, 1), false, "the first loop arriving is not a loss");
});
