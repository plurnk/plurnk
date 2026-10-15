import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import TerminalStatusLine, { historyLost, observedClockStart, turnAccountingFromNotice, accrueTurnAccounting, EMPTY_TALLY, projectStatusGauge, reduceStatusGauge, formatRouteIdentity, renderStatusLine, tallyOutcome, type ClientStatus, type StatusContext } from "./status.ts";
import { ProblemError } from "./diagnostics.ts";

const CONTEXT: StatusContext = { workspace: "k3Zp9", worker: "model-1", child: null, tally: EMPTY_TALLY, runningSince: 1_000, now: 4_200 };

// A whole gauge as the daemon sends it; each test overrides the fields it is about.
const GAUGE = {
    lifecycle: "idle", model: null, loopId: null, packetCount: 0, waitUntil: null, children: 0,
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
    assert.equal(renderStatusLine({ lifecycle: "idle", model: null, loopId: null, packetCount: null, activity: null, children: null }, { workspace: null, worker: null, child: null, tally: EMPTY_TALLY, runningSince: null }, { yolo: true }), "🔥");
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

// {§cli-status-children} {§cli-workers-topology} — the ant is the daemon's alive-children count, the
// child model rides beside it, and the worker segment carries the sibling position.
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

test("[§cli-status-children] the ant counts children from the gauge and the worker segment carries the sibling position", () => {
    assert.equal(renderStatusLine({ ...running, children: 0 }, CONTEXT), "⌛︎  · 🎲 deepdumb · 3.2s");
    assert.equal(renderStatusLine({ ...running, children: 0 }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s", "a configured child model is not active child work");
    assert.equal(renderStatusLine({ ...running, children: 2 }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 2 dumbox");
    assert.equal(renderStatusLine({ ...running, children: null }, { ...CONTEXT, child: "dumbox" }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 dumbox", "no gauge, no count: the bare child model");
    assert.equal(renderStatusLine({ ...running, children: 1 }, { ...CONTEXT, worker: "recheck", position: { index: 2, count: 3 } }), "⌛︎  · 🎲 deepdumb · 3.2s · 🐜 1", "the place is the prompt prefix's, not the status line's");
    assert.equal(projectStatusGauge({ ...GAUGE, lifecycle: "parked", model: null, loopId: 4, packetCount: 1, children: 3 }, PLACE).children, 3);
    assert.throws(() => projectStatusGauge({ ...GAUGE, lifecycle: "parked", model: null, loopId: 4, packetCount: 1, children: -1 }, PLACE), /Invalid runtime children count/u);
});

test("[§cli-status-children] the live child indicator disappears when the last child concludes", () => {
    const writes: string[] = [];
    const line = new TerminalStatusLine((value) => writes.push(value), true, running, { ...CONTEXT, child: "dumbox" });
    line.update({ children: 2 });
    assert.match(writes.at(-1)!, /🐜 2 dumbox/);
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
