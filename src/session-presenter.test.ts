import test from "node:test";
import assert from "node:assert/strict";
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
    normalizeNoteHeading,
    operationGlyphFor,
    receiptCountFor,
    SessionPresenter,
    spanLength,
} from "./session-presenter.ts";

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

    assert.deepEqual(normalizeNoteHeading("NOTE", "FACT: summary"), { glyph: "📊", aside: "summary" });
    assert.deepEqual(normalizeNoteHeading("NOTE", "plan"), { glyph: "🚧", aside: null });
    assert.equal(operationGlyphFor("COPY"), "🖨️");
    assert.equal(lifecycleGlyphFor("requires_action"), "💤");

    const presenter = new SessionPresenter({
        workspaceName: "ws",
        sessionName: "main",
        model: "fast",
        yolo: false,
    });

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
        assert.deepEqual(replaySh[0].outputLines, ["replayed"]);
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
});
