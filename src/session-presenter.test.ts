import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { renderOperationBlock, renderPlanLines } from "./markdown.ts";
import {
    abbreviatedCount,
    addDecimal,
    compactTarget,
    extractRawString,
    extractScopeToken,
    extractTitleAside,
    extractTitleTarget,
    formatDuration,
    formatLiveWait,
    formatModelRoute,
    formatUsdSpend,
    lifecycleGlyphFor,
    operationGlyphFor,
    receiptCountFor,
    SessionPresenter,
    spanLength,
} from "./session-presenter.ts";
import { TailText } from "./tui-surface.ts";

test("{§cli-rendering} {§cli-session-status} {§cli-model-selection}: SessionPresenter formatting helpers, disconnection state, and frame projection", () => {
    assert.equal(formatDuration(50), "50ms");
    assert.equal(formatDuration(2500), "2.5s");
    assert.equal(formatDuration(125_000), "2m05s");
    assert.equal(formatDuration(3_720_000), "1h02m");

    assert.equal(abbreviatedCount(42), "42");
    assert.equal(abbreviatedCount(1500), "1.5k");
    assert.equal(abbreviatedCount(25_000), "25k");
    assert.equal(abbreviatedCount(2_500_000), "2.5M");

    assert.equal(formatUsdSpend(null), null);
    assert.equal(formatUsdSpend("0"), null);
    assert.equal(formatUsdSpend("1.25"), "$1.2500");
    assert.equal(addDecimal("0.0125", "0.0075"), "0.02");

    assert.equal(formatModelRoute("fast", "high", "explicit"), "fast[high]");
    assert.equal(formatModelRoute("fast", "low", "default"), "fast(low)");
    assert.equal(formatModelRoute("fast", null, null), "fast");
    assert.equal(formatModelRoute("none", "medium", "default"), "none");

    assert.equal(operationGlyphFor("NOTE"), "🗒️");
    assert.equal(operationGlyphFor("COPY"), "🖨️");
    assert.equal(lifecycleGlyphFor("requires_action"), "💤");

    const presenter = new SessionPresenter({
        workspaceName: "ws",
        sessionName: "main",
        model: "fast",
        yolo: false,
    });
    assert.equal(presenter.buildStatusBar().formattedStatusLine, "idle · fast · ↓0 ↑0");

    presenter.markTurnStart(1000);
    assert.equal(presenter.lifecycle, "running");
    assert.equal(presenter.disconnected, false);

    // Problem notice marks presenter disconnected with 🔌 in status line ({§cli-session-status})
    const problemFrames = presenter.apply({
        sessionUpdate: "notice",
        severity: "error",
        title: "Service stopping",
        description: "problem:Service stopping — The PLURNK service is shutting down.",
        _meta: {
            plurnk: {
                problem: {
                    type: "https://problems.plurnk.xyz/acp/service-stopping",
                    title: "Service stopping",
                    status: 503,
                    detail: "The PLURNK service is shutting down.",
                },
            },
        },
    });
    assert.equal(problemFrames[0]?.kind, "notice");
    if (problemFrames[0]?.kind === "notice") {
        assert.equal(problemFrames[0].formatted, "❌ problem:Service stopping — The PLURNK service is shutting down.");
    }
    assert.equal(presenter.disconnected, true);
    assert.match(presenter.lastStatusLine, /^🔌 /u);

    // Next turn start clears disconnected state
    presenter.markTurnStart(2000);
    assert.equal(presenter.disconnected, false);
    assert.doesNotMatch(presenter.buildStatusBar().formattedStatusLine, /🔌/u);

    // Explicit markDisconnected sets 🔌
    const discBar = presenter.markDisconnected();
    assert.equal(presenter.disconnected, true);
    assert.equal(discBar.lifecycleGlyph, "🔌");
    assert.match(discBar.formattedStatusLine, /^🔌 /u);

    // State update clears disconnected state and emits status_bar on idle
    const idleFrames = presenter.apply({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        _meta: {
            plurnk: {
                terminal: {
                    status: 200,
                    turnCount: 2,
                    usage: {
                        curationWeight: 100,
                        curationBudget: 1000,
                        contextTokens: 200,
                        contextCapacity: 2000,
                        accounting: {
                            usage: { inputTokens: 50, outputTokens: 25 },
                            costUsd: "0.005",
                        },
                    },
                },
            },
        },
    });
    assert.equal(presenter.disconnected, false);
    assert.equal(idleFrames[0]?.kind, "status_bar");
    if (idleFrames[0]?.kind === "status_bar") {
        assert.equal(idleFrames[0].turns, 2);
        assert.equal(idleFrames[0].statusCode, 200);
        assert.equal(idleFrames[0].loopInputTokens, 50);
        assert.equal(idleFrames[0].loopOutputTokens, 25);
    }

    // Cancelled loop with uncalibrated terminal usage preserves the last known curation gauge
    presenter.markTurnStart(3000);
    const cancelFrames = presenter.apply({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
        _meta: {
            plurnk: {
                terminal: {
                    status: 499,
                    turnCount: 0,
                    usage: {
                        curationWeight: null,
                        curationBudget: null,
                        contextTokens: null,
                        contextCapacity: null,
                    },
                    problem: {
                        type: "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled",
                        title: "Session scope cancelled",
                        status: 499,
                        detail: "The session scope was cancelled: Cancelled by ACP client.",
                    },
                },
            },
        },
    });
    assert.equal(cancelFrames[0]?.kind, "status_bar");
    if (cancelFrames[0]?.kind === "status_bar") {
        assert.equal(cancelFrames[0].statusCode, 499);
        assert.equal(cancelFrames[0].turns, 0);
        assert.equal(cancelFrames[0].status.curationWeight, 100);
        assert.equal(cancelFrames[0].status.curationBudget, 1000);
        assert.equal(
            cancelFrames[0].terminalDetail,
            "The session scope was cancelled: Cancelled by ACP client.",
        );
    }

    // status.inbox only counts messages held by a live loop and clears on publish or idle ({§cli-session-status})
    presenter.ingestMeta({
        plurnk: {
            status: {
                inbox: [
                    { path: "message://main/1", loopId: 1, lifecycle: "cancelled" },
                    { path: "message://main/2", loopId: 2, lifecycle: "failed" },
                    { path: "message://main/3", loopId: 3, lifecycle: "running" },
                    { path: "message://main/4", loopId: 3, lifecycle: "queued" },
                ],
            },
        },
    });
    assert.equal(presenter.inboxCount, 2);
    assert.match(presenter.buildStatusBar().formattedStatusLine, /📨 2/u);

    presenter.apply({
        sessionUpdate: "user_message_chunk",
        messageId: "m-3",
        content: { type: "text", text: "published at turn boundary" },
    });
    assert.equal(presenter.inboxCount, 1);

    presenter.apply({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
    });
    assert.equal(presenter.inboxCount, 0);
    assert.doesNotMatch(presenter.buildStatusBar().formattedStatusLine, /📨/u);
});

test("{§cli-session-status} {§cli-workspaces-and-sessions} {§cli-rendering}: parked wait countdown, history_lost notice on reset loop gauge, and presenter-formatters", () => {
    assert.equal(extractTitleAside("READ src/a.ts — 12 lines"), "12 lines");
    assert.equal(extractTitleTarget("READ src/a.ts — 12 lines"), "src/a.ts");
    assert.equal(compactTarget("file:///repo/src/a.ts"), "…/src/a.ts");
    assert.equal(formatLiveWait(45), "45ms");
    assert.equal(formatLiveWait(1250), "1.3s");
    assert.equal(extractRawString({ raw: "echo hi" }), "echo hi");
    assert.equal(extractScopeToken({ marks: [10, 20] }), "<10,20>");
    assert.equal(spanLength([10, 20]), 11);
    assert.equal(receiptCountFor("READ", { range: { returned: [1, 2] } }), 2);

    const presenter = new SessionPresenter({
        workspaceName: "ws",
        sessionName: "main",
        model: "fast",
        yolo: false,
    });
    assert.equal(presenter.buildStatusBar().formattedStatusLine, "idle · fast · ↓0 ↑0");

    // Parked wait countdown shows "updates in <remaining>" while future, then "updates due" once expired ({§cli-session-status})
    presenter.ingestMeta({
        plurnk: {
            status: {
                lifecycle: "parked",
                waitUntil: Date.now() + 20_000,
            },
        },
    });
    const futureBar = presenter.buildStatusBar();
    assert.match(futureBar.formattedStatusLine, /updates in (?:19|20)s/u);

    presenter.ingestMeta({
        plurnk: {
            status: {
                lifecycle: "parked",
                waitUntil: Date.now() - 5_000,
            },
        },
    });
    const dueBar = presenter.buildStatusBar();
    assert.match(dueBar.formattedStatusLine, /updates due/u);

    // Gauge carrying loopId/loopSeq followed by null on the same binding emits history_lost warning notice ({§cli-workspaces-and-sessions})
    presenter.ingestMeta({
        plurnk: {
            status: {
                loopId: 7,
                loopSeq: 3,
            },
        },
    });
    assert.equal(presenter.consumeHistoryLostFrame(), null);

    const lostFrames = presenter.apply({
        sessionUpdate: "usage_update",
        used: 0,
        size: 1000,
        _meta: {
            plurnk: {
                status: {
                    loopId: null,
                    loopSeq: null,
                },
            },
        },
    });
    assert.equal(lostFrames.length, 1);
    assert.equal(lostFrames[0]?.kind, "notice");
    if (lostFrames[0]?.kind === "notice") {
        assert.equal(lostFrames[0].severity, "warning");
        assert.equal(lostFrames[0].title, "client:session:history_lost");
        assert.match(lostFrames[0].formatted, /⚠️  The daemon holds no history for this session\./u);
    }

    // Starting a new loop resets turns from the previous loop's turnCount and advances per turn ({§cli-session-status})
    presenter.apply({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        _meta: {
            plurnk: {
                loopSeq: 32,
                terminal: {
                    status: 200,
                    turnCount: 14,
                },
            },
        },
    });
    assert.equal(presenter.loopSeq, 32);
    assert.equal(presenter.turns, 14);

    presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:lifecycle:loop_status",
        _meta: {
            plurnk: {
                notice: {
                    source: "engine:lifecycle",
                    kind: "loop_status",
                    status: 102,
                    loopSeq: 33,
                    packetCount: 0,
                },
            },
        },
    });
    assert.equal(presenter.loopSeq, 33);
    assert.equal(presenter.turns, 1);

    presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:turn:turn_awaiting_model",
        _meta: {
            plurnk: {
                notice: {
                    source: "engine:turn",
                    kind: "turn_awaiting_model",
                },
            },
        },
    });
    assert.equal(presenter.turns, 1);

    presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:turn:turn_awaiting_model",
        _meta: {
            plurnk: {
                notice: {
                    source: "engine:turn",
                    kind: "turn_awaiting_model",
                },
            },
        },
    });
    assert.equal(presenter.turns, 2);

    // WAIT outcome renders attrs.waiting ("30s") and 102 rawOutput.detail ({§cli-rendering})
    const wait202 = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "33/2/1",
        name: "WAIT",
        title: "WAIT",
        status: "completed",
        _meta: {
            plurnk: {
                op: "WAIT",
                status: 202,
                attrs: { waiting: 30 },
            },
        },
    });
    assert.equal(wait202[0]?.kind, "tool_call");
    if (wait202[0]?.kind === "tool_call") {
        assert.equal(wait202[0].glyph, "⏳");
        assert.equal(wait202[0].outcome, "30s");
    }

    const wait102 = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "33/2/2",
        name: "WAIT",
        title: "WAIT",
        status: "completed",
        rawOutput: { status: 102, detail: "Nothing is in flight. Continuing." },
        _meta: {
            plurnk: {
                op: "WAIT",
                status: 102,
            },
        },
    });
    assert.equal(wait102[0]?.kind, "tool_call");
    if (wait102[0]?.kind === "tool_call") {
        assert.equal(wait102[0].outcome, "Nothing is in flight. Continuing.");
    }
    assert.equal(presenter.doing, null, "WAIT must clear presenter.doing instead of lingering in the status bar");
    assert.doesNotMatch(presenter.lastStatusLine, /\bWAIT\b/u);

    // Unnamed WORK/FORK falls back to attrs.session, and replay sh falls back to receipt content ({§cli-rendering})
    const unnamedWork = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "33/2/3",
        name: "WORK",
        title: "WORK",
        status: "completed",
        rawInput: { body: "Check tests" },
        _meta: {
            plurnk: {
                op: "WORK",
                status: 200,
                attrs: { session: "work-1" },
            },
        },
    });
    assert.equal(unnamedWork[0]?.kind, "tool_call");
    if (unnamedWork[0]?.kind === "tool_call") {
        assert.equal(unnamedWork[0].target, "session://work-1");
        assert.deepEqual(unnamedWork[0].contentLines, ["Check tests"]);
    }

    const replaySh = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "33/2/4",
        name: "sh",
        title: "sh",
        status: "completed",
        rawInput: { body: "echo replayed" },
        content: [{ type: "content", content: { type: "text", text: "replayed\n" } }],
        _meta: {
            plurnk: {
                op: "sh",
                status: 200,
            },
        },
    });
    assert.equal(replaySh[0]?.kind, "tool_call");
    if (replaySh[0]?.kind === "tool_call") {
        assert.deepEqual(replaySh[0].contentLines, []);
        assert.deepEqual(replaySh[0].outputLines, []);
    }

    // resetSessionHistory clears rendered coordinates so switching sessions or /loop renders 33/2/4 again ({§cli-sessions-topology})
    assert.equal(
        presenter.apply({
            sessionUpdate: "tool_call_update",
            toolCallId: "33/2/4",
            name: "sh",
            status: "completed",
        }).length,
        0,
    );
    presenter.resetSessionHistory();
    assert.equal(
        presenter.apply({
            sessionUpdate: "tool_call_update",
            toolCallId: "33/2/4",
            name: "sh",
            status: "completed",
        })[0]?.kind,
        "tool_call",
    );

    // Unfinished in_progress tool calls flush before status_bar when loop terminates early ({§cli-rendering})
    presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "33/2/5",
        name: "sh",
        title: "sh",
        status: "in_progress",
        rawInput: { body: "sleep 60" },
        _meta: {
            plurnk: {
                id: 99,
                op: "sh",
                status: 202,
            },
        },
    });
    const abortedIdle = presenter.apply({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
        _meta: {
            plurnk: {
                terminal: { status: 499, turnCount: 2 },
            },
        },
    });
    assert.equal(abortedIdle[0]?.kind, "tool_call");
    if (abortedIdle[0]?.kind === "tool_call") {
        assert.equal(abortedIdle[0].toolCallId, "33/2/5");
        assert.equal(abortedIdle[0].status, "failed");
        assert.equal(abortedIdle[0].statusCode, 499);
    }
    assert.equal(abortedIdle[1]?.kind, "status_bar");
});

test("{§cli-session-status} {§cli-markdown-projection}: aggregate spend preservation across 499/parked loops, unknown spend markers, and turn-boundary reasoning retirement", () => {
    // Active lifecycles outrank a prior terminal status code ({§cli-session-status})
    assert.equal(lifecycleGlyphFor("running", 499), "⌛︎");
    assert.equal(lifecycleGlyphFor("parked", 499), "💤");
    assert.equal(lifecycleGlyphFor("queued", 500), "⏳");
    assert.equal(lifecycleGlyphFor("requires_action", 499), "💤");
    assert.equal(lifecycleGlyphFor("cancelled", 499), "🛑");
    assert.equal(lifecycleGlyphFor("failed", 500), "❌");

    // Partial and wholly unknown spend markers ({§cli-session-status})
    assert.equal(formatUsdSpend("1.25", { hasUnknownCost: true }), "$1.2500 + ?");
    assert.equal(formatUsdSpend(null, { hasUnknownCost: true }), "$?");
    assert.equal(formatUsdSpend("0", { hasUnknownCost: true }), "$?");
    assert.equal(formatUsdSpend("0", { hasUnknownCost: false }), null);

    const presenter = new SessionPresenter({
        workspaceName: "plurnk-service",
        sessionName: "service",
        model: "argon",
    });

    // Attach to a session with existing spend ($5.0000, 10k in / 2k out)
    presenter.ingestMeta({
        plurnk: {
            status: {
                lifecycle: "idle",
                loopSeq: 4,
                model: { alias: "argon", effort: "adaptive", effortSource: "default" },
                spend: {
                    requests: 5,
                    usage: { inputTokens: 10_000, outputTokens: 2_000 },
                    costUsd: "5",
                    knownCostUsd: "5",
                },
            },
        },
    });
    assert.equal(presenter.inputTokens, 10_000);
    assert.equal(presenter.outputTokens, 2_000);
    assert.equal(presenter.costUsd, "5");

    // Loop 5 runs and is cancelled (499) after accruing $0.5000: session spend is preserved on the 499 bar
    presenter.apply({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
        _meta: {
            plurnk: {
                loopSeq: 5,
                terminal: {
                    status: 499,
                    turnCount: 1,
                    usage: {
                        accounting: {
                            requests: 1,
                            usage: { inputTokens: 2_000, outputTokens: 500 },
                            costUsd: "0.5",
                        },
                    },
                },
            },
        },
    });
    assert.equal(presenter.lastLoopStatus, 499);
    assert.equal(presenter.inputTokens, 12_000);
    assert.equal(presenter.outputTokens, 2_500);
    assert.equal(presenter.costUsd, "5.5");
    const cancelledBar = presenter.buildStatusBar(1000);
    assert.equal(cancelledBar.lifecycleGlyph, "🛑");
    assert.match(cancelledBar.formattedStatusLine, /^🛑 {2}· argon\(adaptive\) · 1\.0s · ↓12k ↑2\.5k · \$5\.5000/u);

    // Loop 6 starts and streams reasoning on Turn 1, then parks on WAIT (status 202):
    // lastLoopStatus (499) is cleared, glyph becomes ⌛︎ then 💤, reasoning retires, and spend remains visible
    presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:turn:turn_awaiting_model",
        _meta: {
            plurnk: {
                notice: { source: "engine:turn", kind: "turn_awaiting_model" },
            },
        },
    });
    assert.equal(presenter.lastLoopStatus, null);
    assert.match(presenter.buildStatusBar(2000).formattedStatusLine, /^⌛︎ {2}· argon\(adaptive\) · 2\.0s · ↓12k ↑2\.5k · \$5\.5000 · awaiting model/u);

    presenter.apply({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "Thinking on turn 1" },
    });
    assert.equal(presenter.reasoningLines.length, 1);

    const genFrames = presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:turn:turn_generated",
        _meta: {
            plurnk: {
                notice: {
                    source: "engine:turn",
                    kind: "turn_generated",
                    accounting: {
                        requests: 1,
                        inputTokens: 3_000,
                        outputTokens: 500,
                        costUsd: "0.75",
                    },
                },
            },
        },
    });
    assert.equal(genFrames[0]?.kind, "reasoning_retired");
    assert.equal(presenter.reasoningLines.length, 0);

    const parkFrames = presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:lifecycle:loop_status",
        _meta: {
            plurnk: {
                notice: {
                    source: "engine:lifecycle",
                    kind: "loop_status",
                    status: 202,
                    loopSeq: 6,
                    packetCount: 1,
                    waitUntil: Date.now() + 11_000,
                },
            },
        },
    });
    assert.equal(parkFrames[0]?.kind, "status_update");
    if (parkFrames[0]?.kind === "status_update") {
        assert.equal(parkFrames[0].status.lifecycle, "parked");
        assert.equal(parkFrames[0].status.lifecycleGlyph, "💤");
        assert.match(
            parkFrames[0].status.formattedStatusLine,
            /^💤 {2}· argon\(adaptive\) · [^·]+ · ↓15k ↑3k · \$6\.2500 · updates in (?:10|11)s/u,
        );
    }

    // Partial unknown spend from an unpriced subagent turn appends "+ ?" to the known USD total
    presenter.ingestMeta({
        plurnk: {
            status: {
                streams: [
                    {
                        entryId: 605,
                        sessionId: 1,
                        target: "sh://605",
                        lifetime: "loop",
                        loop_seq: 6,
                        turn_seq: 1,
                        sequence: 5,
                        channels: [],
                    },
                ],
                spend: {
                    requests: 7,
                    usage: { inputTokens: 18_000, outputTokens: 4_000 },
                    costUsd: null,
                    knownCostUsd: "6.25",
                },
            },
        },
    });
    assert.match(presenter.buildStatusBar(5000).formattedStatusLine, /↓18k ↑4k · \$6\.2500 \+ \?/u);
    assert.equal(presenter.isOpenStream("6/1/5"), true);
    assert.equal(presenter.isOpenStream("6/1/9", "sh://605"), true);
    assert.equal(presenter.isOpenStream("6/1/9", "sh://other"), false);

    // An open stream (status: "in_progress") is NOT fabricated as completed when state_update: "idle" (status 200/202) arrives;
    // it renders once when stream/concluded (status: "completed") arrives ({§cli-session-status}, {§cli-problems-and-notices}).
    presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "6/1/5",
        name: "sh",
        title: "sh",
        status: "in_progress",
        rawInput: { body: "echo stream-body" },
        _meta: {
            plurnk: {
                id: 605,
                op: "sh",
                status: 200,
                attrs: { stream: "sh://605" },
            },
        },
    });
    const okIdleFrames = presenter.apply({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        _meta: {
            plurnk: {
                loopSeq: 6,
                terminal: { status: 200, turnCount: 2 },
            },
        },
    });
    assert.equal(
        okIdleFrames.some((f) => f.kind === "tool_call"),
        false,
        "state_update: idle (status 200) must never fabricate completions for unsettled in_progress calls",
    );
    const concludedFrames = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "6/1/5",
        name: "sh",
        title: "sh",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "stream-body\n" } }],
        _meta: {
            plurnk: {
                id: 605,
                op: "sh",
                status: 200,
            },
        },
    });
    assert.equal(concludedFrames.length, 1);
    assert.equal(concludedFrames[0]?.kind, "tool_call");
    if (concludedFrames[0]?.kind === "tool_call") {
        assert.equal(concludedFrames[0].toolCallId, "6/1/5");
        assert.deepEqual(concludedFrames[0].contentLines, []);
        assert.deepEqual(concludedFrames[0].outputLines, []);
    }

    // Out-of-order terminal_update (exitStatus) arriving before tool_call_update (in_progress) settles the stream immediately
    // and prevents it from loitering in activeLiveEntries or being resurrected by a stale status.streams gauge ({§cli-rendering}, {§cli-session-status}, #240).
    presenter.apply({
        sessionUpdate: "terminal_update",
        terminalId: "term:701",
        status: "completed",
        exitStatus: { exitCode: 0, signal: null },
        _meta: {
            plurnk: {
                opId: 701,
                target: "gitea://1",
            },
        },
    });
    const racedFrames = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "6/2/1",
        name: "gitea",
        title: "gitea (list_my_repos) — List my Gitea repositories",
        status: "in_progress",
        rawInput: { target: { raw: "list_my_repos" }, body: '{"page":1}', aside: "List my Gitea repositories" },
        _meta: {
            plurnk: {
                id: 702,
                op: "gitea",
                status: 202,
                turnSeq: 2,
                attrs: { stream: "gitea://1", aside: "List my Gitea repositories" },
            },
        },
    });
    assert.equal(racedFrames.length, 1);
    assert.equal(racedFrames[0]?.kind, "tool_call");
    if (racedFrames[0]?.kind === "tool_call") {
        assert.equal(racedFrames[0].toolCallId, "6/2/1");
        assert.equal(racedFrames[0].status, "completed");
        assert.equal(racedFrames[0].statusCode, 200);
        assert.deepEqual(racedFrames[0].contentLines, []);
        assert.deepEqual(racedFrames[0].outputLines, []);
    }
    presenter.ingestMeta({
        plurnk: {
            status: {
                streams: [
                    {
                        entryId: 701,
                        sessionId: 1,
                        target: "gitea://1",
                        lifetime: "loop",
                        loop_seq: 6,
                        turn_seq: 2,
                        sequence: 1,
                        channels: [],
                    },
                ],
            },
        },
    });
    assert.equal(
        presenter.activeLiveEntries.some((e) => e.target === "gitea://1"),
        false,
        "concluded stream must not loiter in activeLiveEntries or be resurrected by a stale gauge",
    );

    // Trailing state_update: running with status.lifecycle: "parked" preserves parked state and clears doing ({§cli-session-status}, #240).
    presenter.doing = { phase: "working", since: Date.now(), op: "WAIT", target: null };
    presenter.lifecycle = "requires_action";
    presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "6/2/2",
        name: "WAIT",
        title: "WAIT",
        status: "completed",
        rawInput: { seconds: 15 },
        _meta: { plurnk: { op: "WAIT", status: 200, attrs: { waiting: 15 } } },
    });
    assert.equal(presenter.doing, null, "WAIT must clear doing even when lifecycle was requires_action");
    const parkedStateFrames = presenter.apply({
        sessionUpdate: "state_update",
        state: "running",
        _meta: {
            plurnk: {
                status: {
                    lifecycle: "parked",
                    waitUntil: Date.now() + 15_000,
                },
            },
        },
    });
    assert.equal(parkedStateFrames[0]?.kind, "status_update");
    if (parkedStateFrames[0]?.kind === "status_update") {
        assert.equal(parkedStateFrames[0].status.lifecycle, "parked");
        assert.equal(parkedStateFrames[0].status.lifecycleGlyph, "💤");
        assert.equal(presenter.doing, null);
        assert.match(parkedStateFrames[0].status.formattedStatusLine, /updates in (?:14|15)s/u);
    }

    // Model NOTE rows render with 🗒️ and preserve asides ({§cli-rendering}).
    const noteFrames = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "6/2/note-1",
        name: "NOTE",
        title: "NOTE — observation",
        status: "completed",
        rawInput: { aside: "observation", body: "Body for note" },
        _meta: { plurnk: { op: "NOTE", status: 200, attrs: { aside: "observation" } } },
    });
    assert.equal(noteFrames[0]?.kind, "tool_call");
    if (noteFrames[0]?.kind === "tool_call") {
        assert.equal(noteFrames[0].glyph, "🗒️");
        assert.equal(noteFrames[0].aside, "observation");
        assert.equal(noteFrames[0].noteBody, "Body for note");
    }

    // TODO tool_call_update rows are suppressed from the waterfall; plan_update projects the per-turn diff
    // (newly closed 🗹 + newly opened ☐ items) at the end of the turn in the waterfall ({§cli-rendering}, {§cli-session-status}).
    const todoFrames = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "6/2/todo-1",
        name: "TODO",
        title: "TODO",
        status: "completed",
        rawInput: { aside: null, body: "- Step 1\n- Step 2" },
        _meta: { plurnk: { op: "TODO", status: 200 } },
    });
    assert.equal(todoFrames.length, 0);

    const planFrames = presenter.apply({
        sessionUpdate: "plan_update",
        plan: {
            type: "items",
            planId: "plan",
            entries: [
                { content: "Step 1", priority: "medium", status: "completed" },
                { content: "Step 2", priority: "medium", status: "pending" },
            ],
        },
        _meta: { plurnk: { loopSeq: 6, turnSeq: 2 } },
    });
    assert.equal(planFrames[0]?.kind, "plan_update");
    if (planFrames[0]?.kind === "plan_update") {
        assert.equal(planFrames[0].toolCallId, `6/2/${String(Number.MAX_SAFE_INTEGER)}`);
    }
    assert.deepEqual(presenter.planEntries, [
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "pending" },
    ]);
    const renderedPlan = stripVTControlCharacters(renderPlanLines(presenter.planEntries, 80));
    assert.equal(renderedPlan, "🗹 Step 1\n☐ Step 2");

    // #live reserves strictly 3 reasoning lines + 1 activity line ({§cli-rendering}, {§cli-session-status}).
    const tail = new TailText(() => 3);
    tail.setReserved(true);
    tail.setText("💭 Thinking...");
    tail.setActivity("⚙️  sh (stream://1) 2s");
    const liveLines = tail.render(80).map((l) => stripVTControlCharacters(l));
    assert.deepEqual(liveLines, [
        "💭 Thinking...",
        "",
        "",
        "⚙️  sh (stream://1) 2s",
    ]);

    const removedFrames = presenter.apply({
        sessionUpdate: "plan_removed",
        planId: "plan",
    });
    assert.equal(removedFrames[0]?.kind, "plan_update");
    if (removedFrames[0]?.kind === "plan_update") {
        assert.equal(removedFrames[0].toolCallId, `6/2/${String(Number.MAX_SAFE_INTEGER)}`);
        assert.deepEqual(removedFrames[0].entries, []);
    }
    assert.deepEqual(presenter.planEntries, []);

    // Per-turn diff across turns: only newly completed (🗹) and newly added (☐) items are emitted for each turn;
    // previously completed items and unchanged pending items are never reprinted ({§cli-rendering}, {§cli-session-status}).
    const diffPresenter = new SessionPresenter({
        workspaceName: "ws",
        sessionName: "main",
        model: "fast",
    });
    // Turn 1 (e.g. initialization turn with opening and closing TODO):
    diffPresenter.apply({
        sessionUpdate: "plan_update",
        plan: {
            type: "items",
            planId: "plan",
            entries: [
                { content: "Survey the environment.", priority: "medium", status: "pending" },
                { content: "Resolve all Open Work.", priority: "medium", status: "pending" },
            ],
        },
        _meta: { plurnk: { loopSeq: 1, turnSeq: 1 } },
    });
    const t1Final = diffPresenter.apply({
        sessionUpdate: "plan_update",
        plan: {
            type: "items",
            planId: "plan",
            entries: [
                { content: "Survey the environment.", priority: "medium", status: "completed" },
                { content: "Resolve all Open Work.", priority: "medium", status: "pending" },
            ],
        },
        _meta: { plurnk: { loopSeq: 1, turnSeq: 1 } },
    });
    assert.equal(t1Final[0]?.kind, "plan_update");
    if (t1Final[0]?.kind === "plan_update") {
        assert.equal(t1Final[0].toolCallId, `1/1/${String(Number.MAX_SAFE_INTEGER)}`);
        assert.deepEqual(t1Final[0].entries, [
            { content: "Survey the environment.", status: "completed" },
            { content: "Resolve all Open Work.", status: "pending" },
        ]);
    }

    // Turn 2: model replaces TODO with Step A and Step B -> "Resolve all Open Work." is newly completed,
    // "Survey the environment." was already completed in Turn 1 (not reprinted), Step A & Step B are newly opened.
    const t2Frames = diffPresenter.apply({
        sessionUpdate: "plan_update",
        plan: {
            type: "items",
            planId: "plan",
            entries: [
                { content: "Survey the environment.", priority: "medium", status: "completed" },
                { content: "Resolve all Open Work.", priority: "medium", status: "completed" },
                { content: "Step A", priority: "medium", status: "pending" },
                { content: "Step B", priority: "medium", status: "pending" },
            ],
        },
        _meta: { plurnk: { loopSeq: 1, turnSeq: 2 } },
    });
    assert.equal(t2Frames[0]?.kind, "plan_update");
    if (t2Frames[0]?.kind === "plan_update") {
        assert.equal(t2Frames[0].toolCallId, `1/2/${String(Number.MAX_SAFE_INTEGER)}`);
        assert.deepEqual(t2Frames[0].entries, [
            { content: "Resolve all Open Work.", status: "completed" },
            { content: "Step A", status: "pending" },
            { content: "Step B", status: "pending" },
        ]);
    }

    // Turn 3: Step A is completed, Step B remains pending (unchanged -> not reprinted), Step C is newly opened.
    const t3Frames = diffPresenter.apply({
        sessionUpdate: "plan_update",
        plan: {
            type: "items",
            planId: "plan",
            entries: [
                { content: "Survey the environment.", priority: "medium", status: "completed" },
                { content: "Resolve all Open Work.", priority: "medium", status: "completed" },
                { content: "Step A", priority: "medium", status: "completed" },
                { content: "Step B", priority: "medium", status: "pending" },
                { content: "Step C", priority: "medium", status: "pending" },
            ],
        },
        _meta: { plurnk: { loopSeq: 1, turnSeq: 3 } },
    });
    assert.equal(t3Frames[0]?.kind, "plan_update");
    if (t3Frames[0]?.kind === "plan_update") {
        assert.equal(t3Frames[0].toolCallId, `1/3/${String(Number.MAX_SAFE_INTEGER)}`);
        assert.deepEqual(t3Frames[0].entries, [
            { content: "Step A", status: "completed" },
            { content: "Step C", status: "pending" },
        ]);
    }

    // Turn 4: All items completed before DONE -> only Step B and Step C are newly completed.
    const t4Frames = diffPresenter.apply({
        sessionUpdate: "plan_update",
        plan: {
            type: "items",
            planId: "plan",
            entries: [
                { content: "Survey the environment.", priority: "medium", status: "completed" },
                { content: "Resolve all Open Work.", priority: "medium", status: "completed" },
                { content: "Step A", priority: "medium", status: "completed" },
                { content: "Step B", priority: "medium", status: "completed" },
                { content: "Step C", priority: "medium", status: "completed" },
            ],
        },
        _meta: { plurnk: { loopSeq: 1, turnSeq: 4 } },
    });
    assert.equal(t4Frames[0]?.kind, "plan_update");
    if (t4Frames[0]?.kind === "plan_update") {
        assert.equal(t4Frames[0].toolCallId, `1/4/${String(Number.MAX_SAFE_INTEGER)}`);
        assert.deepEqual(t4Frames[0].entries, [
            { content: "Step B", status: "completed" },
            { content: "Step C", status: "completed" },
        ]);
    }

    // Fresh session with status.model === null falls back to active provider in _meta.plurnk.providers
    // and preserves configOptions model on config_option_update ({§cli-model-selection}, #243).
    const freshPresenter = new SessionPresenter({
        workspaceName: "sqlrite",
        sessionName: "user",
        model: "default",
    });
    freshPresenter.ingestMeta({
        plurnk: {
            status: {
                model: null,
                spawnModel: null,
            },
            providers: [
                {
                    alias: "rtx5070",
                    provider: "vllm",
                    model: "qwen3-coder",
                    effort: "medium",
                    effortSource: "default",
                    active: true,
                },
            ],
        },
    });
    assert.equal(freshPresenter.model, "rtx5070");
    assert.equal(freshPresenter.effort, "medium");
    assert.equal(freshPresenter.effortSource, "default");
    assert.match(freshPresenter.buildStatusBar().formattedStatusLine, /idle · rtx5070\(medium\) · ↓0 ↑0/u);

    freshPresenter.apply({
        sessionUpdate: "config_option_update",
        configOptions: [
            {
                configId: "model",
                name: "Model",
                type: "select",
                currentValue: "rtx5070",
                options: [{ value: "rtx5070", name: "rtx5070" }],
            },
            {
                configId: "mode",
                name: "Approval Policy",
                type: "select",
                currentValue: "allow",
                options: [{ value: "allow", name: "Allow" }],
            },
        ],
        _meta: {
            plurnk: {
                status: {
                    model: null,
                    spawnModel: null,
                },
            },
        },
    });
    assert.equal(freshPresenter.model, "rtx5070");
    assert.equal(freshPresenter.yolo, true);

    freshPresenter.ingestMeta({
        plurnk: {
            status: {
                model: null,
                spawnModel: null,
            },
            providers: [
                {
                    alias: "rtx5070",
                    provider: "vllm",
                    model: "qwen3-coder",
                    active: false,
                },
            ],
        },
    });
    assert.equal(freshPresenter.model, "none");
    assert.equal(freshPresenter.effort, null);
    assert.equal(freshPresenter.effortSource, null);

    // KILL with distillation body previews beneath 🗑️ and suppresses synthesized NOTE with attrs.distilled ({§cli-rendering}, #244).
    const killTarget = "log:///67/[1-2]/*/{READ,gitea,sh,emission,reasoning}";
    const killBody =
        "Verified open issues and git status across plurnk-service (#1392, #1391, #1390, #1381), plurnk (0 open), and plurnk-web (#98).";
    const killFrames = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "67/2/6",
        name: "KILL",
        title: `KILL (${killTarget}) — retire loop 67 status check transcripts`,
        status: "completed",
        locations: [{ path: killTarget }],
        rawInput: {
            target: { raw: killTarget },
            aside: "retire loop 67 status check transcripts",
            body: killBody,
        },
        _meta: {
            plurnk: {
                id: 6706,
                coordinate: "67/2/6",
                op: "KILL",
                origin: "model",
                status: 200,
            },
        },
    });
    assert.equal(killFrames.length, 1);
    assert.equal(killFrames[0]?.kind, "tool_call");
    if (killFrames[0]?.kind === "tool_call") {
        assert.equal(killFrames[0].glyph, "🗑️");
        assert.equal(killFrames[0].op, "KILL");
        assert.equal(killFrames[0].target, killTarget);
        assert.equal(killFrames[0].aside, "retire loop 67 status check transcripts");
        assert.deepEqual(killFrames[0].contentLines, [killBody]);
        const renderedKill = stripVTControlCharacters(
            renderOperationBlock({
                glyph: killFrames[0].glyph,
                op: killFrames[0].op,
                title: killFrames[0].title,
                target: killFrames[0].target,
                scope: killFrames[0].scope,
                destination: killFrames[0].destination,
                pattern: killFrames[0].pattern,
                count: killFrames[0].count,
                aside: killFrames[0].aside,
                status: killFrames[0].status,
                statusCode: killFrames[0].statusCode,
                outcome: killFrames[0].outcome,
                contentLines: killFrames[0].contentLines,
                outputLines: killFrames[0].outputLines,
                coordinate: killFrames[0].toolCallId,
                columns: 160,
            }),
        );
        assert.equal(
            renderedKill,
            `🗑️  (${killTarget}) retire loop 67 status check transcripts\n    ${killBody}`,
        );
    }

    const distilledNoteFrames = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "67/2/7",
        name: "NOTE",
        title: "NOTE",
        status: "completed",
        rawInput: {
            aside: null,
            target: null,
            body: killBody,
        },
        _meta: {
            plurnk: {
                id: 6707,
                coordinate: "67/2/7",
                op: "NOTE",
                origin: "model",
                status: 200,
                attrs: {
                    distilled: killTarget,
                },
            },
        },
    });
    assert.equal(
        distilledNoteFrames.length,
        0,
        "synthesized NOTE carrying attrs.distilled must be suppressed so it does not render an orphan 🗒️ block",
    );

    const bodilessKillFrames = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "67/2/8",
        name: "KILL",
        title: "KILL (workspace:///old.ts)",
        status: "completed",
        rawInput: { target: { raw: "workspace:///old.ts" }, body: null },
        _meta: {
            plurnk: {
                id: 6708,
                coordinate: "67/2/8",
                op: "KILL",
                origin: "model",
                status: 200,
            },
        },
    });
    assert.equal(bodilessKillFrames[0]?.kind, "tool_call");
    if (bodilessKillFrames[0]?.kind === "tool_call") {
        assert.deepEqual(bodilessKillFrames[0].contentLines, []);
    }
});
