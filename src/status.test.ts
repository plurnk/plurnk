import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import TerminalStatusLine, { changedElsewhere, disconnection, historyLost, observedClockStart, turnAccountingFromNotice, accrueTurnAccounting, EMPTY_TALLY, projectStatusGauge, reduceStatusGauge, formatRouteIdentity, renderStatusLine, tallyOutcome, unreadMessages, type ClientStatus, type StatusContext } from "./status.ts";
import { ProblemError } from "./diagnostics.ts";

const CONTEXT: StatusContext = { workspace: "k3Zp9", worker: "model-1", child: null, tally: EMPTY_TALLY, runningSince: 1_000, now: 4_200 };

// A whole gauge as the daemon sends it; each test overrides the fields it is about.
const GAUGE = {
    lifecycle: "idle", model: null, loopId: null, packetCount: 0, waitUntil: null, descendants: [], inbox: [], streams: [],
    spend: { requests: 0, usage: null, knownUsage: null, costUsd: "0", knownCostUsd: "0" }, claimedAt: null, terminatedAt: null,
};
// The bound workspace as the daemon sends it: no folder, nothing preparing or indexing.
const PLACE = { preparation: [], activity: null };

const running: ClientStatus = {
    lifecycle: "running",
    model: "deepdumb",
    loopId: null,
    packetCount: 2,
    activity: null,
    children: null,
    gated: null,
};

test("[§cli-status-wait] the parked countdown uses the daemon deadline and clears on wake", () => {
    const gauge = { ...GAUGE, lifecycle: "parked", model: null, loopId: 1, packetCount: 2, waitUntil: 304_200 };
    const status = projectStatusGauge(gauge, PLACE);
    assert.match(renderStatusLine(status, CONTEXT), /updates in 5m00s/);
    assert.match(renderStatusLine(status, { ...CONTEXT, now: 5_200 }), /updates in 4m59s/);
    assert.match(renderStatusLine(status, { ...CONTEXT, now: 304_201 }), /updates due/);
    assert.doesNotMatch(renderStatusLine(projectStatusGauge({ ...gauge, lifecycle: "queued", waitUntil: null }, PLACE), CONTEXT), /updates/);
    assert.doesNotMatch(renderStatusLine(projectStatusGauge({ ...gauge, waitUntil: null }, PLACE), CONTEXT), /updates/,
        "provider recovery and review have no invented observation deadline");
    assert.doesNotMatch(renderStatusLine({ ...status, lifecycle: "completed" }, CONTEXT), /updates/);
    for (const waitUntil of [-1, Infinity, NaN, "soon"]) {
        assert.throws(() => projectStatusGauge({ ...gauge, waitUntil }, PLACE), /Invalid runtime wait deadline/);
    }
});

test("[§cli-status-preparation] preparation names the capability and advances its clock before inference", () => {
    const base = { ...GAUGE, lifecycle: "queued", model: null, loopId: 1, packetCount: 0 };
    const preparation = [{ family: "mcp", alias: "search", phase: "preparing", since: new Date(1_000).toISOString() }];
    const status = projectStatusGauge(base, { ...PLACE, preparation });
    assert.match(renderStatusLine(status, CONTEXT), /preparing mcp\/search 3\.2s/);
    assert.match(renderStatusLine(status, { ...CONTEXT, now: 11_000 }), /preparing mcp\/search 10\.0s/);
    assert.doesNotMatch(renderStatusLine(status, CONTEXT), /awaiting model|🧮/);
    const idle = projectStatusGauge({ ...base, lifecycle: "idle" }, { ...PLACE, preparation });
    assert.match(renderStatusLine(idle, CONTEXT), /preparing mcp\/search/);
    const settled = projectStatusGauge(base, PLACE);
    assert.doesNotMatch(renderStatusLine(settled, CONTEXT), /preparing mcp/);
    for (const invalid of [null, {}, [{}], [{ ...preparation[0], since: "yesterday" }], [{ ...preparation[0], phase: "ready" }]]) {
        assert.throws(() => projectStatusGauge(base, { ...PLACE, preparation: invalid }), /Invalid workspace preparation/);
    }
});

const spent = (requests: number, input: number, output: number, cost: string) => ({
    requests, usage: { inputTokens: input, outputTokens: output }, knownUsage: { inputTokens: input, outputTokens: output }, costUsd: cost, knownCostUsd: cost,
});

test("[§cli-status-clock] an attached loop runs from when the daemon first ran it, else from the attachment; malformed stamps are refused", () => {
    const attached = projectStatusGauge({ ...GAUGE, lifecycle: "running", loopId: 4, packetCount: 2, claimedAt: 1_792_008_000_000, terminatedAt: null }, PLACE);
    assert.equal(observedClockStart(attached, 1_792_008_090_000), 1_792_008_000_000, "ninety seconds in, the clock shows ninety seconds");
    const queued = projectStatusGauge({ ...GAUGE, lifecycle: "queued", loopId: 5, claimedAt: null, terminatedAt: null }, PLACE);
    assert.equal(observedClockStart(queued, 1_792_008_090_000), 1_792_008_090_000, "a loop that has not run starts at the attachment");
    for (const stamps of [{ claimedAt: -1 }, { claimedAt: 1.5 }, { terminatedAt: "2026-10-14T20:00:00Z" }, { claimedAt: undefined }]) {
        assert.throws(() => projectStatusGauge({ ...GAUGE, ...stamps }, PLACE), /Invalid runtime loop timing/);
    }
});

test("[§cli-status-spend] the line shows the worker's spend since it began as the daemon projects it; nothing adds to it", () => {
    const gauge = { ...GAUGE, lifecycle: "running", model: null, loopId: 2, packetCount: 1, spend: spent(3, 300, 30, "0.0300") };
    const first = renderStatusLine(projectStatusGauge(gauge, PLACE), CONTEXT);
    assert.match(first, /↓300 ↑30 · \$0\.0300/);
    assert.equal(renderStatusLine(projectStatusGauge(gauge, PLACE), CONTEXT), first, "a repeated snapshot adds no spend");
    const later = projectStatusGauge({ ...gauge, spend: spent(7, 700, 70, "0.0700") }, PLACE);
    assert.match(renderStatusLine(later, CONTEXT), /↓700 ↑70 · \$0\.0700/, "a later projection replaces the figure");
    const tally = tallyOutcome(EMPTY_TALLY, { turns: 1, wallMs: 5000 });
    assert.match(renderStatusLine({ ...later, lifecycle: "completed" }, { ...CONTEXT, tally, runningSince: null }), /↓700 ↑70 · \$0\.0700/,
        "a settled loop charges nothing again");
    assert.match(renderStatusLine(projectStatusGauge({ ...gauge, spend: spent(9, 1_234_567, 9_876, "1.2") }, PLACE), CONTEXT), /↓1\.2M ↑10k/u,
        "token counts are abbreviated: 582k, 1.2M");
});

test("[§cli-status-spend] an unknown total shows the highest cost that is not incorrect; nothing spent shows nothing; malformed spend is refused", () => {
    const base = { ...GAUGE, lifecycle: "running", model: null, loopId: 1, packetCount: 0 };
    const partial = projectStatusGauge({ ...base, spend: { requests: 2, usage: null, knownUsage: { inputTokens: 100, outputTokens: 20 }, costUsd: null, knownCostUsd: "0.25" } }, PLACE);
    assert.match(renderStatusLine(partial, CONTEXT), /↓100\+\? ↑20\+\? · \$0\.2500 \+ \?/);
    assert.equal(projectStatusGauge(base, PLACE).spend, null, "nothing spent is no figure");
    assert.doesNotMatch(renderStatusLine(projectStatusGauge(base, PLACE), CONTEXT), /↓|\$/);
    for (const spend of [null, {}, { requests: -1, usage: null, knownUsage: null, costUsd: null, knownCostUsd: null },
        { requests: 1, usage: { inputTokens: -1 }, knownUsage: { inputTokens: -1 }, costUsd: null, knownCostUsd: null }, { requests: 1, usage: null, knownUsage: null, costUsd: "NaN", knownCostUsd: "NaN" }]) {
        assert.throws(() => projectStatusGauge({ ...base, spend }, PLACE), /Invalid runtime spend/);
    }
});

test("[§cli-worker-status] status presentation uses only client-owned facts", () => {
    assert.equal(renderStatusLine(running, CONTEXT), "⌛︎  · 🎲 deepdumb · 3.2s");
    assert.equal(renderStatusLine(running, { ...CONTEXT, child: "rtx5070" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 rtx5070", "a spawn override rides beside the model");
    const concluded = tallyOutcome(tallyOutcome(EMPTY_TALLY, { turns: 1, wallMs: 5_000 }), { turns: 2, wallMs: 60_000 });
    assert.deepEqual(concluded, { turns: 3, wallMs: 65_000 });
    assert.equal(
        renderStatusLine({ ...running, lifecycle: "completed", activity: { label: "indexing", percent: 55 } }, { ...CONTEXT, tally: concluded, runningSince: null }),
        "⏹️  · 🎲 deepdumb · 1m05s · 🧮 55%",
    );
    assert.equal(renderStatusLine({ lifecycle: "idle", model: null, loopId: null, packetCount: null, activity: null, children: null, gated: null }, { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, runningSince: null }, { yolo: true }), "🔥");
    assert.equal(renderStatusLine(running, CONTEXT, { yolo: true }), "🔥 ⌛︎  · 🎲 deepdumb · 3.2s", "{plurnk#104} YOLO is a fireball at the left edge, and the model sits ahead of what ticks");
});

test("[§cli-status-project-root] status shows the daemon's label for the bound folder, never a local root", () => {
    const gauge = { ...GAUGE, lifecycle: "idle", model: null, loopId: null, packetCount: 0 };
    const path = "/projects/client work/日本語";
    const status = projectStatusGauge(gauge, { ...PLACE, projectRoot: path, projectLabel: path });
    assert.equal(status.projectRoot, path);
    assert.equal(renderStatusLine(status, CONTEXT), `${path} idle`);
    assert.equal(renderStatusLine(projectStatusGauge(gauge, { ...PLACE, projectRoot: null, projectLabel: null }), CONTEXT), "idle", "headless is not the client cwd");
    assert.equal(renderStatusLine(projectStatusGauge(gauge, PLACE), CONTEXT), "idle", "no folder in the workspace projection means no known root");
    assert.throws(() => projectStatusGauge(gauge, { ...PLACE, projectRoot: 42 as never }), /Invalid workspace project root/u);
    assert.throws(() => projectStatusGauge(gauge, { ...PLACE, projectRoot: path, projectLabel: 42 as never }), /Invalid workspace project label/u);
    assert.equal(renderStatusLine({ ...status, projectLabel: "/repo\n\t\x1b]2;not-a-title\x07name" }, CONTEXT), "/repo\\n\\tname idle",
        "path controls cannot change the terminal title or create status rows");
    for (const place of ["[work/1/9:main]", "[work/100/1000:main]"]) {
        assert.equal(renderStatusLine({ ...running, projectRoot: path, projectLabel: path }, { ...CONTEXT, place }, { yolo: true }),
            `${path} ${place} 🔥 ⌛︎  · 🎲 deepdumb · 3.2s`,
            "the folder starts the complete footer, before even the changing turn coordinates");
    }
});

test("[§cli-status-project-root] the folder is the daemon's label as given, omitted where it repeats the workspace name", () => {
    // A daemon on another host spells the folder from its own home; the client shows that spelling.
    const status = { ...running, projectRoot: "/srv/daemon-home/projects/client", projectLabel: "~/projects/client" };
    const activity = renderStatusLine(running, CONTEXT);
    const place = "[~/projects/client/~user]";
    assert.equal(renderStatusLine(status, { ...CONTEXT, workspace: "~/projects/client", place }), `${place} ${activity}`, "a default name repeats its label");
    assert.equal(renderStatusLine(status, { ...CONTEXT, workspace: "named", place: "[named/~user]" }),
        `~/projects/client [named/~user] ${activity}`);
    assert.equal(renderStatusLine(status, { ...CONTEXT, workspace: "~/projects/client" }),
        `~/projects/client ${activity}`, "the CLI has no workspace label to replace the folder");
    assert.equal(renderStatusLine({ ...running, projectRoot: join(homedir(), "projects", "client") }, { ...CONTEXT, workspace: "named", place: "[named/~user]" }),
        `[named/~user] ${activity}`, "without the daemon's label the client shortens nothing and shows nothing");
    assert.equal(renderStatusLine({ ...status, projectRoot: null, projectLabel: null }, { ...CONTEXT, place }), `${place} ${activity}`);
});

// {§cli-status-children} {§cli-status-gated} — plurnk-service {§agui-status-descendants}: one worker of the tree
// beneath the bound worker (here worker 1), as the gauge carries it.
const descendant = (id: number, parentWorkerId: number, lifecycle: string, gates = 0) =>
    ({ id, name: `worker-${id}`, parentWorkerId, kind: "work", lifecycle, gates });
const treeCounts = (descendants: unknown): Pick<ClientStatus, "children" | "gated"> => {
    const { children, gated } = projectStatusGauge({ ...GAUGE, descendants }, PLACE);
    return { children, gated };
};

// {§cli-status-children} — the ant is the tree's alive direct children, and the child model rides beside it.
test("[§cli-status-children] the ant counts children from the gauge, the child model beside them", () => {
    assert.equal(renderStatusLine({ ...running, children: 0 }, CONTEXT), "⌛︎  · 🎲 deepdumb · 3.2s");
    assert.equal(renderStatusLine({ ...running, children: 0 }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s", "a configured child model is not active child work");
    assert.equal(renderStatusLine({ ...running, children: 2 }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 2 dumbox");
    assert.equal(renderStatusLine({ ...running, children: null }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 dumbox", "no gauge, no count: the bare child model");
});

test("[§cli-status-children] the ant counts the tree's direct children that owe a result: every lifecycle, at every depth", () => {
    assert.deepEqual(treeCounts([]), { children: 0, gated: 0 }, "an empty tree");
    for (const lifecycle of ["queued", "running", "parked"]) {
        assert.deepEqual(treeCounts([descendant(2, 1, lifecycle)]), { children: 1, gated: 0 }, `a ${lifecycle} child still owes its result`);
        assert.deepEqual(treeCounts([descendant(2, 1, "completed"), descendant(3, 2, lifecycle)]), { children: 0, gated: 0 }, `a ${lifecycle} grandchild is not a child`);
    }
    for (const lifecycle of ["idle", "completed", "cancelled", "failed"]) {
        assert.deepEqual(treeCounts([descendant(2, 1, lifecycle)]), { children: 0, gated: 0 }, `a ${lifecycle} child owes nothing`);
    }
    assert.deepEqual(treeCounts([descendant(2, 1, "running"), descendant(3, 2, "running"), descendant(4, 1, "parked"), descendant(5, 4, "queued"), descendant(6, 1, "completed")]),
        { children: 2, gated: 0 }, "two generations: the bound worker's own children alone");
});

test("[§cli-status-gated] the traffic light counts the workers anywhere in the tree that wait on a gate", () => {
    assert.deepEqual(treeCounts([descendant(2, 1, "running", 1)]), { children: 1, gated: 1 }, "a child waits");
    assert.deepEqual(treeCounts([descendant(2, 1, "completed"), descendant(3, 2, "running", 2)]), { children: 0, gated: 1 },
        "a grandchild beneath a concluded child, waiting on two gates, is one worker waiting");
    assert.deepEqual(treeCounts([descendant(2, 1, "running", 1), descendant(3, 2, "running", 1), descendant(4, 3, "running", 1), descendant(5, 1, "parked")]),
        { children: 2, gated: 3 }, "every depth counts");
    assert.equal(renderStatusLine({ ...running, children: 2, gated: 15 }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 2 dumbox · 🚦 15");
    assert.equal(renderStatusLine({ ...running, children: 0, gated: 3 }, CONTEXT), "⌛︎  · 🎲 deepdumb · 3.2s · 🚦 3", "waiting work without an alive child still shows");
    assert.equal(renderStatusLine({ ...running, children: 2, gated: 0 }, CONTEXT), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 2", "none waiting shows nothing");
    assert.equal(renderStatusLine({ ...running, children: null, gated: null }, CONTEXT), "⌛︎  · 🎲 deepdumb · 3.2s", "no gauge shows nothing");
});

test("[§cli-status-children] a gauge whose tree is not one worker's tree is refused", () => {
    const valid = descendant(2, 1, "running");
    for (const descendants of [
        undefined, null, 3, {}, [null], [[]], [{ ...valid, id: "2" }], [{ ...valid, parentWorkerId: null }], [{ ...valid, name: 2 }],
        [{ ...valid, kind: null }], [{ ...valid, lifecycle: "asleep" }], [{ ...valid, gates: -1 }], [{ ...valid, gates: 1.5 }],
        [valid, valid], [valid, descendant(3, 9, "running")],
    ]) {
        assert.throws(() => treeCounts(descendants), /Invalid runtime descendants/u, JSON.stringify(descendants) ?? "undefined");
    }
});

test("[§cli-status-children] [§cli-status-gated] the live indicators disappear when the last child concludes and the last gate settles", () => {
    const writes: string[] = [];
    const line = new TerminalStatusLine((value) => writes.push(value), true, running, { ...CONTEXT, child: "dumbox" });
    line.update({ children: 2, gated: 1 });
    assert.match(writes.at(-1)!, /🐜 2 dumbox · 🚦 1/);
    line.update({ gated: 0 });
    assert.doesNotMatch(writes.at(-1)!, /🚦/);
    line.update({ children: 0 });
    assert.doesNotMatch(writes.at(-1)!, /🐜|dumbox/);
});

test("{§cli-agui-conformance} the worker's gauge is its status and budget together, or neither, beside an ever-present workspace", () => {
    const workspace = { id: 1, name: "w", projectRoot: null, projectLabel: null, ...PLACE };
    const snapshot = (plurnk: object, budget?: object) => ({ type: "STATE_SNAPSHOT", snapshot: { plurnk, ...(budget === undefined ? {} : { budget }) } });
    assert.equal(reduceStatusGauge(null, snapshot({ workspace })).handled, true, "a Run that binds no worker");
    assert.equal(reduceStatusGauge(null, snapshot({ workspace, status: GAUGE }, {})).handled, true, "a Run that binds one");
    for (const invalid of [snapshot({ workspace, status: GAUGE }), snapshot({ workspace }, {}), snapshot({ status: GAUGE }, {})]) {
        assert.throws(() => reduceStatusGauge(null, invalid), (error: unknown) => error instanceof ProblemError && error.problem.kind === "state-invalid");
    }
});

test("the authoritative workspace state projects indexing phases without a Notice reducer", () => {
    const gauge = { ...GAUGE, lifecycle: "running", model: null, loopId: 1, packetCount: 0 };
    for (const [phase, label] of [["preparing", "preparing"], ["indexing", "indexing"], ["failed", "indexing failed"]]) {
        assert.deepEqual(projectStatusGauge(gauge, { ...PLACE, activity: { kind: "derivation", phase, percent: 30 } }).activity, { label, percent: 30 });
    }
    assert.equal(projectStatusGauge(gauge, PLACE).activity, null);
});

test("[§cli-worker-status] queued work retains its lifecycle while elapsed wall time accrues", () => {
    const projected = projectStatusGauge({ ...GAUGE, lifecycle: "queued", model: null, loopId: 7, packetCount: 0 }, PLACE);
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
    assert.equal(formatRouteIdentity({ alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash", effort: "low", effortSource: "explicit" }), "deepdumb[low]");
    assert.equal(formatRouteIdentity({ provider: "cloudflare", model: "@cf/zai-org/glm-5.3-flash", effort: "low", effortSource: "explicit" }), "cloudflare/@cf/zai-org/glm-5.3-flash[low]");
    assert.equal(formatRouteIdentity({ alias: "fireox", provider: "fireworks", model: "accounts/fireworks/models/glm-5p3-flash", effort: "off", effortSource: "explicit" }), "fireox[off]");
    assert.equal(formatRouteIdentity({ alias: "plain", provider: "p", model: "m" }), "plain", "no reasoning dimension - no brackets");
});

test("[§cli-identity-effort] brackets read as chosen, parentheses as given (plurnk#41 ask 2)", () => {
    const route = { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash", effort: "low" } as const;
    assert.equal(formatRouteIdentity({ ...route, effortSource: "explicit" }), "deepdumb[low]", "an /effort selection");
    assert.equal(formatRouteIdentity({ ...route, effortSource: "default" }), "deepdumb(low)", "the daemon seeded it from the alias");
    assert.equal(formatRouteIdentity({ alias: "plain", provider: "p", model: "m", effortSource: "default" }), "plain", "no policy, no marker");
});

test("#465: turn accounting parses and accrues decimal-exact for the status stream", () => {
    const turn = turnAccountingFromNotice({ source: "engine:turn", kind: "turn_generated", accounting: { costUsd: "0.01", knownCostUsd: "0.01", inputTokens: 100, outputTokens: 20, knownInputTokens: 100, knownOutputTokens: 20 } });
    assert.deepEqual(turn, { costUsd: "0.01", knownCostUsd: "0.01", inputTokens: 100, outputTokens: 20, knownInputTokens: 100, knownOutputTokens: 20 });
    assert.equal(turnAccountingFromNotice({ source: "engine:turn", kind: "turn_awaiting_model" }), null);
    assert.equal(turnAccountingFromNotice({ source: "engine:provider", kind: "turn_generated", accounting: {} }), null);
    const accrued = accrueTurnAccounting(turn!, { costUsd: "0.005", knownCostUsd: "0.005", inputTokens: 50, outputTokens: 5, knownInputTokens: 50, knownOutputTokens: 5 });
    assert.deepEqual(accrued, { costUsd: "0.015", knownCostUsd: "0.015", inputTokens: 150, outputTokens: 25, knownInputTokens: 150, knownOutputTokens: 25 });
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

test("[§cli-history-lost] a gauge without a loop after one with a loop marks the worker new", () => {
    assert.equal(historyLost(37, null), true, "history seen, then none: the daemon minted the worker anew");
    assert.equal(historyLost(null, null), false, "a first gauge without a loop is the new worker the client expects");
    assert.equal(historyLost(37, 38), false, "a later loop is the same worker continuing");
    assert.equal(historyLost(null, 1), false, "the first loop arriving is not a loss");
});

// {§cli-status-inbox} — plurnk-service {§agui-message-acceptance}: the accepted messages the bound worker has not read.
test("[§cli-status-inbox] the status line counts the messages waiting to be read; a concluded loop's unread ones are said, never counted", () => {
    const message = (lifecycle: string, n: number) => ({ path: `agui://anonymous/threads/t/messages/m${n}`, id: `m${n}`, loopId: 3, lifecycle });
    const inbox = [message("running", 1), message("queued", 2), message("parked", 3), message("cancelled", 4), message("completed", 5), message("failed", 6)];
    const status = projectStatusGauge({ ...GAUGE, lifecycle: "running", inbox }, PLACE);
    assert.match(renderStatusLine(status, CONTEXT), / · 📨 3(?: ·|$)/u, "the three a live loop holds are waiting");
    assert.deepEqual(unreadMessages(status.inbox).map(({ id }) => id), ["m4", "m5", "m6"], "nothing will read the ones a concluded loop held");
    assert.doesNotMatch(renderStatusLine(projectStatusGauge({ ...GAUGE, inbox: [message("cancelled", 4)] }, PLACE), CONTEXT), /📨/u, "none waiting shows nothing");
    assert.doesNotMatch(renderStatusLine(projectStatusGauge(GAUGE, PLACE), CONTEXT), /📨/u);
    for (const invalid of [null, {}, [{ ...message("running", 1), path: 7 }], [{ ...message("running", 1), id: 1 }], [{ ...message("running", 1), loopId: "3" }], [{ ...message("running", 1), lifecycle: "lost" }], [null]]) {
        assert.throws(() => projectStatusGauge({ ...GAUGE, inbox: invalid }, PLACE), /Invalid runtime inbox/u, JSON.stringify(invalid));
    }
});

// {§cli-status-streams} — plurnk-service {§agui-status-streams}: the streams the bound worker holds open, by address.
test("[§cli-status-streams] the gauge names the streams the worker holds open by address; an unreadable census is a broken gauge", () => {
    const stream = (target: string) => ({ entryId: 9, workerId: 1, target, lifetime: null, channels: [{ channel: 1, state: "open", mimetype: "text/plain" }] });
    assert.deepEqual(projectStatusGauge({ ...GAUGE, streams: [stream("sh:///ab3d5678"), stream("node:///c0ffee00")] }, PLACE).openStreams, ["sh:///ab3d5678", "node:///c0ffee00"]);
    assert.deepEqual(projectStatusGauge(GAUGE, PLACE).openStreams, []);
    for (const invalid of [null, {}, [{ ...stream("sh:///ab3d5678"), target: 1 }], [null]]) {
        assert.throws(() => projectStatusGauge({ ...GAUGE, streams: invalid }, PLACE), /Invalid runtime streams/u, JSON.stringify(invalid));
    }
});

// {§cli-identity-effort} {§cli-workspaces-and-workers} — a Run's state never supplies the identity; a value it newly
// carries prompts the readback that does.
test("[§cli-identity-effort] only a route the gauge newly carries, unlike the one last read, is a change made elsewhere", () => {
    const rows: Array<[string | null, string | null, string | null, boolean, string]> = [
        ["kimi[high]", "deepdumb", "deepdumb", true, "another client chose a model"],
        ["deepdumb[low]", "deepdumb", "deepdumb", true, "another client chose an effort"],
        ["deepdumb", null, "deepdumb", false, "the first gauge agrees with the readback"],
        ["kimi", null, "deepdumb", true, "the first gauge carries a route the readback has not"],
        ["kimi", "deepdumb", "kimi", false, "this client's own change, already read back"],
        ["kimi", "kimi", "deepdumb", false, "a route the gauge already carried prompts nothing again"],
        [null, null, null, false, "a modelless worker"],
    ];
    for (const [carried, previous, read, changed, why] of rows) assert.equal(changedElsewhere(carried, previous, read), changed, why);
});

// {§cli-workspaces-and-workers} — plurnk-service {§agui-workspace-state}: a Run's workspace state is its start's.
test("[§cli-workspaces-and-workers] a name the workspace state newly carries prompts a readback; the session's own rename outlasts a stale one", () => {
    assert.equal(changedElsewhere("journal", "notes", "notes"), true, "another client renamed it");
    assert.equal(changedElsewhere("notes", "notes", "journal"), false, "a Run that began before this session's own rename");
    assert.equal(changedElsewhere("journal", "notes", "journal"), false, "this session's own rename, now in the state");
    assert.equal(changedElsewhere("notes", null, "notes"), false, "the first state agrees");
});

// {§cli-status-disconnected} — plurnk-web shows its disconnection the same way.
test("[§cli-status-disconnected] 🔌 leads the line while a failure has ended the observation; the client's own cancellation is none", () => {
    assert.match(renderStatusLine(running, CONTEXT, { disconnected: true }), /^🔌 ⌛︎  · /u);
    assert.match(renderStatusLine(running, CONTEXT, { disconnected: true, yolo: true }), /^🔌 🔥 ⌛︎  · /u, "beside YOLO, ahead of it");
    assert.doesNotMatch(renderStatusLine(running, CONTEXT), /🔌/u);
    const problem = (path: string) => ({ type: `https://problems.plurnk.xyz/${path}` });
    assert.equal(disconnection(null), false, "an observation that simply completed");
    assert.equal(disconnection(problem("client/transport/cancelled")), false, "the client's own cancellation");
    assert.equal(disconnection(problem("agui/http/service-stopping")), true, "the daemon stopping");
    assert.equal(disconnection(problem("agui/http/credential-revoked")), true, "a revoked credential");
    assert.equal(disconnection(problem("client/connection/refused")), true, "a lost connection");
});
