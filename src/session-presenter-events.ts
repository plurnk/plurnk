// Engine telemetry notices, reasoning window, message projection, and loop settlement
// for SessionPresenter ({§cli-session-status}, {§cli-rendering}, {§cli-markdown-projection}, {§cli-problems-and-notices}).

import { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { contentBlockToText, type MetaRecord } from "./acp-session.ts";
import {
    addDecimal,
    extractCoordinateSeqs,
    extractMessageActor,
} from "./presenter-formatters.ts";
import {
    buildPresenterStatusBar,
    consumePresenterHistoryLostFrame,
    ingestPresenterMeta,
    promoteSurvivingStreams,
    resetLoopTurns,
    retireReasoning,
    syncLoopAndTurn,
    type PresenterInternals,
    type PresenterState,
} from "./session-presenter-meta.ts";
import { projectToolCallUpdate } from "./session-presenter-tools.ts";
import type { PresentationFrame } from "./session-presenter-types.ts";

export const flushPendingHistoryLost = (
    internals: PresenterInternals,
    frames: PresentationFrame[],
): void => {
    const lost = consumePresenterHistoryLostFrame(internals);
    if (lost !== null) {
        frames.push(lost);
    }
};

export const applyEngineNoticeMeta = (
    state: PresenterState,
    internals: PresenterInternals,
    meta: unknown,
    frames: PresentationFrame[],
    legacyTitle?: string,
): boolean => {
    const plurnkMeta = (
        meta as { plurnk?: { notice?: Record<string, unknown> } } | undefined
    )?.plurnk;
    const rawNotice = plurnkMeta?.notice;

    if (rawNotice?.source === "engine:turn" || legacyTitle?.startsWith("engine:turn:")) {
        if (rawNotice?.kind === "turn_queued" || legacyTitle === "engine:turn:turn_queued") {
            retireReasoning(internals, frames);
            if (internals.loopConcluded) {
                resetLoopTurns(state, internals);
            }
            state.lastLoopStatus = null;
            state.lifecycle = "queued";
            const queuePosition = typeof rawNotice?.queuePosition === "number" ? rawNotice.queuePosition : null;
            const queueDepth = typeof rawNotice?.queueDepth === "number" ? rawNotice.queueDepth : null;
            state.doing = {
                phase: "queued",
                since: state.doing?.phase === "queued" ? state.doing.since : Date.now(),
                op: null,
                target: null,
                queuePosition,
                queueDepth,
            };
            frames.push({
                kind: "status_update",
                status: buildPresenterStatusBar(state, internals),
            });
            return true;
        }
        if (rawNotice?.kind === "turn_awaiting_model" || legacyTitle === "engine:turn:turn_awaiting_model") {
            retireReasoning(internals, frames);
            if (internals.loopConcluded) {
                resetLoopTurns(state, internals);
            }
            state.lastLoopStatus = null;
            internals.awaitingTurnCount += 1;
            state.turns = Math.max(state.turns, internals.awaitingTurnCount);
            promoteSurvivingStreams(state, internals, state.turns, true);
            state.lifecycle = "running";
            state.doing = { phase: "awaiting", since: Date.now(), op: null, target: null };
            frames.push({
                kind: "status_update",
                status: buildPresenterStatusBar(state, internals),
                newTurn: true,
            });
            return true;
        }
        if (rawNotice?.kind === "turn_generated" || legacyTitle === "engine:turn:turn_generated") {
            retireReasoning(internals, frames);
            state.lastLoopStatus = null;
            state.lifecycle = "running";
            state.doing = { phase: "working", since: Date.now(), op: null, target: null };
            const acc = rawNotice?.accounting as
                | {
                      requests?: number;
                      inputTokens?: number;
                      outputTokens?: number;
                      knownInputTokens?: number;
                      knownOutputTokens?: number;
                      usage?: { inputTokens?: number; outputTokens?: number };
                      knownUsage?: { inputTokens?: number; outputTokens?: number };
                      costUsd?: string | null;
                      knownCostUsd?: string | null;
                  }
                | undefined;
            const inTok =
                typeof acc?.inputTokens === "number"
                    ? acc.inputTokens
                    : typeof acc?.knownInputTokens === "number"
                      ? acc.knownInputTokens
                      : typeof acc?.usage?.inputTokens === "number"
                        ? acc.usage.inputTokens
                        : typeof acc?.knownUsage?.inputTokens === "number"
                          ? acc.knownUsage.inputTokens
                          : 0;
            const outTok =
                typeof acc?.outputTokens === "number"
                    ? acc.outputTokens
                    : typeof acc?.knownOutputTokens === "number"
                      ? acc.knownOutputTokens
                      : typeof acc?.usage?.outputTokens === "number"
                        ? acc.usage.outputTokens
                        : typeof acc?.knownUsage?.outputTokens === "number"
                          ? acc.knownUsage.outputTokens
                          : 0;
            state.inputTokens += inTok;
            state.outputTokens += outTok;
            const turnCost =
                typeof acc?.costUsd === "string"
                    ? acc.costUsd
                    : typeof acc?.knownCostUsd === "string"
                      ? acc.knownCostUsd
                      : null;
            if (turnCost !== null) {
                state.costUsd = addDecimal(state.costUsd, turnCost);
                internals.loopCostUsd = addDecimal(internals.loopCostUsd, turnCost);
            }
            if (
                acc !== undefined &&
                acc.costUsd === null &&
                (typeof acc.knownCostUsd === "string" || (typeof acc.requests === "number" && acc.requests > 0))
            ) {
                state.hasUnknownCost = true;
            }
            frames.push({
                kind: "status_update",
                status: buildPresenterStatusBar(state, internals),
            });
            return true;
        }
        if (rawNotice?.kind === "results_pending" || legacyTitle === "engine:turn:results_pending") {
            state.lastLoopStatus = null;
            state.lifecycle = "running";
            state.doing = { phase: "working", since: Date.now(), op: null, target: null };
            frames.push({
                kind: "status_update",
                status: buildPresenterStatusBar(state, internals),
            });
            return true;
        }
    }

    if (rawNotice?.kind === "loop_status") {
        if (typeof rawNotice.loopSeq === "number") {
            if (
                (state.loopSeq !== null && state.loopSeq !== rawNotice.loopSeq) ||
                ((rawNotice.status === 100 || rawNotice.status === 102) && internals.loopConcluded)
            ) {
                resetLoopTurns(state, internals);
            }
            state.loopSeq = rawNotice.loopSeq;
            internals.bindingsWithLoops.add(`${state.workspaceName}#${state.sessionName}`);
        }
        if (typeof rawNotice.packetCount === "number" && rawNotice.packetCount > 0) {
            state.turns = Math.max(state.turns, rawNotice.packetCount);
        } else if (rawNotice.status === 102 && state.turns === 0) {
            state.turns = 1;
        }
        if (rawNotice.status === 202) {
            retireReasoning(internals, frames);
            promoteSurvivingStreams(state, internals, state.turns, true);
            state.lastLoopStatus = null;
            state.lifecycle = "parked";
            state.doing = null;
            state.waitUntil = typeof rawNotice.waitUntil === "number" ? rawNotice.waitUntil : null;
            frames.push({
                kind: "status_update",
                status: buildPresenterStatusBar(state, internals),
            });
            return true;
        }
        if (rawNotice.status === 100 || rawNotice.status === 102) {
            state.lastLoopStatus = null;
            state.waitUntil = null;
            state.lifecycle = rawNotice.status === 102 ? "running" : "queued";
            state.doing =
                rawNotice.status === 102
                    ? { phase: "working", since: Date.now(), op: null, target: null }
                    : null;
            frames.push({
                kind: "status_update",
                status: buildPresenterStatusBar(state, internals),
            });
            return true;
        }
    }

    if (
        rawNotice?.kind === "search_progress" ||
        (typeof rawNotice?.source === "string" &&
            rawNotice.source.startsWith("exec:") &&
            typeof rawNotice.percent === "number")
    ) {
        const pct = typeof rawNotice.percent === "number" ? rawNotice.percent : undefined;
        if (pct !== undefined && pct >= 100) {
            state.activity = null;
        } else {
            state.activity = {
                phase: typeof rawNotice?.phase === "string" ? rawNotice.phase : "search",
                ...(pct !== undefined ? { percent: pct } : {}),
            };
        }
        frames.push({
            kind: "status_update",
            status: buildPresenterStatusBar(state, internals),
        });
        return true;
    }

    // Over-budget curation moment ({§cli-rendering}): render green/dim as `📌 — curating context`.
    if (
        (rawNotice?.source === "engine:capacity" && rawNotice?.kind === "budget_exceeded") ||
        legacyTitle === "engine:capacity:budget_exceeded"
    ) {
        flushPendingHistoryLost(internals, frames);
        frames.push({
            kind: "tool_call",
            toolCallId: `notice-budget-exceeded-${++internals.budgetNoticeSeq}`,
            glyph: "📌",
            op: "info",
            origin: "_plurnk",
            title: "📌 — curating context",
            target: null,
            scope: null,
            destination: null,
            pattern: null,
            fields: null,
            count: null,
            aside: null,
            noteBody: null,
            status: "completed",
            statusCode: 200,
            outcome: "curating context",
            contentLines: [],
            outputLines: [],
        });
        return true;
    }

    return false;
};

export const projectSessionInfoUpdate = (
    state: PresenterState,
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "session_info_update" }>,
    frames: PresentationFrame[],
): void => {
    ingestPresenterMeta(state, internals, update._meta as MetaRecord | undefined);
    if (typeof update.title === "string" && update.title.length > 0) {
        const hashIdx = update.title.indexOf("#");
        if (hashIdx > 0 && hashIdx < update.title.length - 1) {
            const ws = update.title.slice(0, hashIdx).trim();
            const sess = update.title.slice(hashIdx + 1).trim();
            if (ws.length > 0) state.workspaceName = ws;
            if (sess.length > 0) state.sessionName = sess;
        } else {
            state.sessionName = update.title;
        }
    }
    if (applyEngineNoticeMeta(state, internals, update._meta, frames)) {
        return;
    }
    flushPendingHistoryLost(internals, frames);
    frames.push({
        kind: "status_update",
        status: buildPresenterStatusBar(state, internals),
    });
};

export const projectUsageUpdate = (
    state: PresenterState,
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "usage_update" }>,
    frames: PresentationFrame[],
): void => {
    const hasMetaBudget =
        typeof (update._meta as { plurnk?: { budget?: unknown } } | undefined)?.plurnk?.budget === "object" &&
        (update._meta as { plurnk?: { budget?: unknown } }).plurnk?.budget !== null;
    ingestPresenterMeta(state, internals, update._meta as MetaRecord | undefined);
    if (!hasMetaBudget) {
        state.curationWeight = update.used;
        state.curationBudget = update.size;
    } else {
        if (state.contextTokens === null && state.curationWeight === 0) {
            state.curationWeight = update.used;
        }
        if (state.contextCapacity === null && state.curationBudget === 0) {
            state.curationBudget = update.size;
        }
    }
    const hasMetaSpend =
        typeof (update._meta as { plurnk?: { status?: { spend?: unknown } } } | undefined)?.plurnk?.status
            ?.spend === "object" &&
        (update._meta as { plurnk?: { status?: { spend?: unknown } } }).plurnk?.status?.spend !== null;
    if (
        !hasMetaSpend &&
        update.cost &&
        typeof update.cost.amount === "number" &&
        Number.isFinite(update.cost.amount)
    ) {
        state.costUsd = String(update.cost.amount);
    }
    flushPendingHistoryLost(internals, frames);
};

export const projectThoughtUpdate = (
    state: PresenterState,
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "agent_thought_chunk" | "agent_thought" }>,
    frames: PresentationFrame[],
): void => {
    const thoughtPlurnk = (
        update._meta as
            | {
                  plurnk?: {
                      op?: string;
                      status?: number;
                      loopSeq?: number;
                      turnSeq?: number;
                      turn?: number;
                  };
              }
            | undefined
    )?.plurnk;
    const thoughtCoord = extractCoordinateSeqs(update.messageId);
    syncLoopAndTurn(
        state,
        internals,
        thoughtPlurnk?.loopSeq ?? thoughtCoord.loopSeq,
        (typeof thoughtPlurnk?.turnSeq === "number" ? thoughtPlurnk.turnSeq : thoughtPlurnk?.turn) ??
            thoughtCoord.turnSeq,
    );
    const deltaText = SessionUpdate.isAgentThoughtChunk(update)
        ? contentBlockToText(update.content)
        : (update.content ?? []).map(contentBlockToText).join("");
    if (SessionUpdate.isAgentThought(update)) {
        internals.reasoningBuffer = deltaText;
    } else {
        internals.reasoningBuffer += deltaText;
    }
    const allLines = internals.reasoningBuffer.split(/\r?\n/u).filter((l) => l.length > 0);
    internals.reasoningLines = allLines.slice(-state.maxReasoningLines);
    frames.push({
        kind: "reasoning_tail",
        lines: [...internals.reasoningLines],
        deltaText,
    });
};

export const projectAgentMessageUpdate = (
    state: PresenterState,
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "agent_message_chunk" | "agent_message" }>,
    frames: PresentationFrame[],
): void => {
    retireReasoning(internals, frames);
    const metaPlurnk = (
        update._meta as
            | {
                  plurnk?: {
                      op?: string;
                      status?: number;
                      loopSeq?: number;
                      turnSeq?: number;
                      actor?: string;
                      source?: string;
                      address?: string;
                      target?: string;
                      attrs?: { aside?: string };
                      receipt?: {
                          repliedTo?: readonly string[];
                          repliedToSources?: readonly string[];
                      };
                  };
              }
            | undefined
    )?.plurnk;
    const msgCoord = extractCoordinateSeqs(update.messageId);
    syncLoopAndTurn(
        state,
        internals,
        metaPlurnk?.loopSeq ?? msgCoord.loopSeq,
        metaPlurnk?.turnSeq ?? msgCoord.turnSeq,
    );
    internals.loopConcluded = false;
    const text = SessionUpdate.isAgentMessageChunk(update)
        ? contentBlockToText(update.content)
        : (update.content ?? []).map(contentBlockToText).join("");
    const effectiveOp = metaPlurnk?.op ?? "send";
    const actor = effectiveOp === "wait" ? null : extractMessageActor(metaPlurnk);
    if (effectiveOp === "wait") {
        state.doing = null;
        buildPresenterStatusBar(state, internals);
    }
    frames.push({
        kind: "reply_chunk",
        messageId: update.messageId,
        text,
        op: effectiveOp,
        status: typeof metaPlurnk?.status === "number" ? metaPlurnk.status : 200,
        aside: metaPlurnk?.attrs?.aside ?? null,
        ...(actor !== null ? { actor } : {}),
    });
};

export const projectNoticeUpdate = (
    state: PresenterState,
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "notice" }>,
    frames: PresentationFrame[],
): void => {
    // Route workspace state/preparation, engine turn progress, loop status, and search progress
    // to the right of the status line instead of the waterfall ({§cli-session-status}, {§cli-rendering}).
    if (update.title === "workspace:state" || update.title === "workspace:preparation") {
        ingestPresenterMeta(state, internals, update._meta as MetaRecord | undefined);
        flushPendingHistoryLost(internals, frames);
        frames.push({
            kind: "status_update",
            status: buildPresenterStatusBar(state, internals),
        });
        return;
    }

    if (applyEngineNoticeMeta(state, internals, update._meta, frames, update.title)) {
        return;
    }

    const plurnkMeta = (
        update._meta as
            | { plurnk?: { notice?: Record<string, unknown>; problem?: Record<string, unknown> } }
            | undefined
    )?.plurnk;

    if (plurnkMeta?.problem !== undefined) {
        state.disconnected = true;
        state.lifecycle = "idle";
        state.doing = null;
        buildPresenterStatusBar(state, internals);
    }
    const noticeGlyph =
        plurnkMeta?.problem !== undefined
            ? "❌"
            : update.severity === "error"
              ? "⛔"
              : update.severity === "warning"
                ? "⚠️ "
                : "📌";
    const noticeText =
        typeof update.description === "string" && update.description.trim().length > 0
            ? update.description.trim()
            : update.title;
    frames.push({
        kind: "notice",
        severity: update.severity,
        title: update.title,
        description: update.description,
        formatted: `${noticeGlyph} ${noticeText}`,
    });
};

export const projectStateUpdate = (
    state: PresenterState,
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "state_update" }>,
    frames: PresentationFrame[],
): void => {
    state.disconnected = false;
    const priorBaseInputTokens = internals.turnBaseInputTokens;
    const priorBaseOutputTokens = internals.turnBaseOutputTokens;
    const priorBaseCostUsd = internals.turnBaseCostUsd;
    ingestPresenterMeta(state, internals, update._meta as MetaRecord | undefined);
    if (applyEngineNoticeMeta(state, internals, update._meta, frames)) {
        return;
    }
    const metaLifecycle = (
        update._meta as { plurnk?: { status?: { lifecycle?: unknown } } } | undefined
    )?.plurnk?.status?.lifecycle;
    if (update.state === "running") {
        internals.promptSuggestions = [];
        if (internals.loopConcluded) {
            resetLoopTurns(state, internals);
        }
        state.lastLoopStatus = null;
        if (state.turns === 0) {
            state.turns = 1;
        }
        if (metaLifecycle === "parked") {
            state.lifecycle = "parked";
            state.lifecycleGlyph = "💤";
            state.doing = null;
        } else {
            state.lifecycle = "running";
            state.lifecycleGlyph = "⌛︎";
            if (state.doing === null) {
                state.doing = { phase: "working", since: Date.now(), op: null, target: null };
            }
        }
        frames.push({
            kind: "status_update",
            status: buildPresenterStatusBar(state, internals),
        });
        return;
    }
    if (update.state === "requires_action") {
        retireReasoning(internals, frames);
        state.lastLoopStatus = null;
        state.lifecycle = "requires_action";
        state.lifecycleGlyph = "💤";
        state.doing = null;
        frames.push({
            kind: "status_update",
            status: buildPresenterStatusBar(state, internals),
        });
        return;
    }
    if (update.state === "idle") {
        retireReasoning(internals, frames);
        internals.lastStreamTarget = "";
        state.doing = null;
        state.activity = null;
        state.waitUntil = null;
        state.inboxCount = 0;
        const termMeta = (
            update._meta as
                | {
                      plurnk?: {
                          terminal?: {
                              status?: number;
                              turnCount?: number;
                              problem?: { detail?: string };
                              usage?: {
                                  curationWeight?: number;
                                  curationBudget?: number;
                                  contextTokens?: number | null;
                                  contextCapacity?: number | null;
                                  accounting?: {
                                      requests?: number;
                                      usage?: { inputTokens?: number; outputTokens?: number };
                                      knownUsage?: { inputTokens?: number; outputTokens?: number };
                                      costUsd?: string | null;
                                      knownCostUsd?: string | null;
                                  };
                              };
                          };
                      };
                  }
                | undefined
        )?.plurnk?.terminal;
        if (termMeta === undefined && (internals.loopConcluded || (state.lifecycle === "idle" && state.turns === 0))) {
            frames.push({
                kind: "status_update",
                status: buildPresenterStatusBar(state, internals),
            });
            return;
        }
        const status =
            typeof termMeta?.status === "number"
                ? termMeta.status
                : update.stopReason === "error" || update.stopReason === "refusal"
                  ? 500
                  : update.stopReason === "cancelled"
                    ? 499
                    : 200;
        state.lastLoopStatus = status;
        state.lifecycle = status >= 400 ? (status === 499 ? "cancelled" : "failed") : "idle";
        // {§cli-session-status} {§cli-rendering} — Only abort in-flight calls when the loop
        // terminates with failure/cancellation (status >= 400). On 200/202, open streams
        // hold their historical launch row until stream/concluded arrives.
        if (status >= 400) {
            internals.activeStreams.clear();
            for (const [pendingId] of [...internals.pendingToolCalls.entries()]) {
                const flushed: PresentationFrame[] = [];
                projectToolCallUpdate(
                    state,
                    internals,
                    {
                        sessionUpdate: "tool_call_update",
                        toolCallId: pendingId,
                        status: "failed",
                        _meta: { plurnk: { status } },
                    },
                    flushed,
                );
                for (const f of flushed) {
                    if (f.kind === "tool_call") {
                        frames.push(f);
                    }
                }
            }
        } else {
            promoteSurvivingStreams(state, internals, state.turns, true);
        }
        if (state.activeChildren === 0) {
            internals.activeWorkers.clear();
        }
        const hasAuthoritativeSpend =
            ((update._meta as { plurnk?: { status?: { spend?: unknown } } } | undefined)?.plurnk?.status
                ?.spend ?? null) !== null;
        const stdUsage = (update as { usage?: { inputTokens?: unknown; outputTokens?: unknown } }).usage;
        const acc = termMeta?.usage?.accounting;
        const usage = acc?.usage ?? acc?.knownUsage;
        const loopIn =
            typeof usage?.inputTokens === "number"
                ? usage.inputTokens
                : typeof stdUsage?.inputTokens === "number"
                  ? stdUsage.inputTokens
                  : undefined;
        const loopOut =
            typeof usage?.outputTokens === "number"
                ? usage.outputTokens
                : typeof stdUsage?.outputTokens === "number"
                  ? stdUsage.outputTokens
                  : undefined;
        const costStr = acc?.costUsd ?? acc?.knownCostUsd;
        if (!hasAuthoritativeSpend) {
            if (loopIn !== undefined) {
                state.inputTokens = Math.max(state.inputTokens, priorBaseInputTokens + loopIn);
            }
            if (loopOut !== undefined) {
                state.outputTokens = Math.max(state.outputTokens, priorBaseOutputTokens + loopOut);
            }
            if (typeof costStr === "string") {
                const candidateCost = addDecimal(priorBaseCostUsd, costStr);
                if (state.costUsd === null || Number(candidateCost) >= Number(state.costUsd)) {
                    state.costUsd = candidateCost;
                }
            }
            if (
                acc !== undefined &&
                acc.costUsd === null &&
                (typeof acc.knownCostUsd === "string" ||
                    (typeof acc.requests === "number" && acc.requests > 0))
            ) {
                state.hasUnknownCost = true;
            }
        }
        if (typeof termMeta?.usage?.curationBudget === "number" && termMeta.usage.curationBudget > 0) {
            state.curationBudget = termMeta.usage.curationBudget;
            if (typeof termMeta?.usage?.curationWeight === "number") {
                state.curationWeight = termMeta.usage.curationWeight;
            }
        }
        if (typeof termMeta?.usage?.contextTokens === "number") {
            state.contextTokens = termMeta.usage.contextTokens;
        }
        if (typeof termMeta?.usage?.contextCapacity === "number") {
            state.contextCapacity = termMeta.usage.contextCapacity;
        }
        const elapsedMs = Math.max(1, Date.now() - internals.turnStartedAt);
        const statusBar = buildPresenterStatusBar(state, internals, elapsedMs, status);
        const rawTurns = termMeta?.turnCount;
        const turns = typeof rawTurns === "number" && rawTurns >= 0 ? rawTurns : Math.max(1, state.turns);
        state.turns = turns;
        internals.loopConcluded = true;
        const hitMaxTurns = update.stopReason === "max_turn_requests" || status === 429;
        const terminalDetail =
            typeof termMeta?.problem?.detail === "string" && termMeta.problem.detail.length > 0
                ? termMeta.problem.detail
                : undefined;
        const effectiveLoopIn = loopIn ?? Math.max(0, state.inputTokens - priorBaseInputTokens);
        const effectiveLoopOut = loopOut ?? Math.max(0, state.outputTokens - priorBaseOutputTokens);
        const effectiveLoopCost =
            typeof costStr === "string"
                ? costStr
                : internals.loopCostUsd ?? (hasAuthoritativeSpend ? null : state.costUsd);
        internals.turnBaseInputTokens = state.inputTokens;
        internals.turnBaseOutputTokens = state.outputTokens;
        internals.turnBaseCostUsd = state.costUsd;
        internals.loopCostUsd = null;
        frames.push({
            kind: "status_bar",
            status: statusBar,
            statusCode: status,
            elapsedMs,
            hitMaxTurns,
            ...(terminalDetail !== undefined ? { terminalDetail } : {}),
            turns,
            loopInputTokens: effectiveLoopIn,
            loopOutputTokens: effectiveLoopOut,
            loopCostUsd: effectiveLoopCost,
        });
    }
};
