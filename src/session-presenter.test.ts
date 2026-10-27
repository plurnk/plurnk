import test from "node:test";
import assert from "node:assert/strict";
import {
    abbreviatedCount,
    addDecimal,
    formatDuration,
    formatModelRoute,
    formatUsdSpend,
    lifecycleGlyphFor,
    normalizeNoteHeading,
    operationGlyphFor,
    SessionPresenter,
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
});
