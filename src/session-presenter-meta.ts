// State container, snapshot `_meta.plurnk` ingestion, config option sync, and status gauge
// assembly for SessionPresenter ({§cli-workspaces-and-sessions}, {§cli-model-selection}, {§cli-session-status}).

import {
    SessionConfigOption,
    type SessionConfigOption as SessionConfigOptionType,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { MetaRecord } from "./acp-session.ts";
import {
    abbreviatedCount,
    compactTarget,
    formatDuration,
    formatLiveWait,
    formatModelRoute,
    formatUsdSpend,
    lifecycleGlyphFor,
    normalizeWorkerKey,
    OPERATION_GLYPH_MAP,
} from "./presenter-formatters.ts";
import {
    createPresenterInternals,
    type PresentationFrame,
    type PresenterInternals,
    type PresenterState,
    type StatusBarModel,
    type WorkspacePreparationState,
} from "./session-presenter-types.ts";

export { createPresenterInternals, type PresenterInternals, type PresenterState };

export const promoteSurvivingStreams = (
    state: PresenterState,
    internals: PresenterInternals,
    currentTurn = state.turns,
    forceAll = false,
): void => {
    for (const [k, st] of internals.activeStreams.entries()) {
        if (!st.survivedTurn && (forceAll || currentTurn > st.openedTurn)) {
            internals.activeStreams.set(k, { ...st, survivedTurn: true });
        }
    }
};

// {§cli-workspaces-and-sessions} — Emits a warning Notice frame when loopId/loopSeq becomes null
// after a gauge on the same binding previously carried a loop.
export const consumePresenterHistoryLostFrame = (
    internals: PresenterInternals,
): Extract<PresentationFrame, { kind: "notice" }> | null => {
    if (!internals.pendingHistoryLost) return null;
    internals.pendingHistoryLost = false;
    const description = "The daemon holds no history for this session.";
    return {
        kind: "notice",
        severity: "warning",
        title: "client:session:history_lost",
        description,
        formatted: `⚠️  ${description}`,
    };
};

export const resetLoopTurns = (state: PresenterState, internals: PresenterInternals): void => {
    state.turns = 0;
    internals.awaitingTurnCount = 0;
    internals.loopConcluded = false;
    state.lastLoopStatus = null;
    internals.loopCostUsd = null;
    internals.seededElapsedMs = null;
};

export const syncLoopAndTurn = (
    state: PresenterState,
    internals: PresenterInternals,
    loopSeq: unknown,
    turnSeq?: unknown,
): void => {
    if (typeof loopSeq === "number") {
        if (state.loopSeq !== null && state.loopSeq !== loopSeq) {
            resetLoopTurns(state, internals);
        }
        state.loopSeq = loopSeq;
        internals.bindingsWithLoops.add(`${state.workspaceName}#${state.sessionName}`);
    }
    if (typeof turnSeq === "number" && turnSeq > 0) {
        if (internals.loopConcluded && typeof loopSeq !== "number") {
            resetLoopTurns(state, internals);
        }
        if (turnSeq > state.turns) {
            internals.loopConcluded = false;
        }
        state.turns = Math.max(state.turns, turnSeq);
        promoteSurvivingStreams(state, internals, state.turns);
    }
};

export const retireReasoning = (
    internals: PresenterInternals,
    frames: PresentationFrame[],
): void => {
    if (internals.reasoningLines.length > 0 || internals.reasoningBuffer.length > 0) {
        internals.reasoningBuffer = "";
        internals.reasoningLines = [];
        frames.push({ kind: "reasoning_retired" });
    }
};

export const applyPresenterConfigOptions = (
    state: PresenterState,
    options: readonly SessionConfigOptionType[],
    fromUpdate = false,
): void => {
    for (const opt of options) {
        if (opt.configId === "model" && SessionConfigOption.isSelect(opt) && opt.currentValue.length > 0) {
            state.model = opt.currentValue;
        } else if (opt.configId === "thought_level" && SessionConfigOption.isSelect(opt)) {
            const nextEffort = opt.currentValue.length > 0 ? opt.currentValue : null;
            if (fromUpdate && nextEffort !== null && nextEffort !== state.effort) {
                state.effortSource = "explicit";
            } else if (state.effortSource === null && nextEffort !== null) {
                state.effortSource = "default";
            }
            state.effort = nextEffort;
            const vals: string[] = [];
            for (const item of opt.options) {
                if ("options" in item) {
                    for (const sub of item.options) vals.push(sub.value);
                } else {
                    vals.push(item.value);
                }
            }
            state.supportedEfforts = vals;
        } else if (opt.configId === "child" && SessionConfigOption.isSelect(opt)) {
            state.childModel = opt.currentValue.length > 0 && opt.currentValue !== "inherit" ? opt.currentValue : null;
        } else if (opt.configId === "mode" && SessionConfigOption.isSelect(opt)) {
            if (opt.currentValue.length > 0) {
                state.mode = opt.currentValue;
            }
        }
    }
};

const parseTimestampMs = (raw: unknown): number | null => {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.length > 0) {
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const extractPreparationState = (raw: unknown): WorkspacePreparationState | null => {
    if (!raw || typeof raw !== "object") return null;
    const prep = raw as Record<string, unknown>;
    return {
        ...(typeof prep.state === "string" ? { state: prep.state } : {}),
        ...(typeof prep.phase === "string" ? { phase: prep.phase } : {}),
        ...(typeof prep.percent === "number" ? { percent: prep.percent } : {}),
    };
};

export const ingestPresenterMeta = (
    state: PresenterState,
    internals: PresenterInternals,
    meta: MetaRecord | undefined,
): void => {
    if (!meta) return;
    const plurnk = meta.plurnk as Record<string, unknown> | undefined;
    if (!plurnk) return;
    state.disconnected = false;

    const ws = plurnk.workspace as Record<string, unknown> | undefined;
    if (typeof ws?.name === "string" && ws.name.length > 0) {
        state.workspaceName = ws.name;
    }
    if (typeof ws?.projectLabel === "string") {
        state.projectLabel = ws.projectLabel;
    }
    const wsPrep = extractPreparationState(ws?.preparation);
    if (wsPrep !== null) state.preparation = wsPrep;
    const topPrep = extractPreparationState(plurnk.preparation);
    if (topPrep !== null) state.preparation = topPrep;

    if (typeof plurnk.sessionName === "string" && plurnk.sessionName.length > 0) {
        state.sessionName = plurnk.sessionName;
    }
    syncLoopAndTurn(state, internals, plurnk.loopSeq, plurnk.turn);

    const status = plurnk.status as Record<string, unknown> | undefined;
    if (status) {
        const bindingKey = `${state.workspaceName}#${state.sessionName}`;
        if (typeof status.lifecycle === "string") {
            state.lifecycle = status.lifecycle;
            if (
                status.lifecycle === "running" ||
                status.lifecycle === "queued" ||
                status.lifecycle === "parked" ||
                status.lifecycle === "requires_action"
            ) {
                state.lastLoopStatus = null;
            }
        }
        if (typeof status.loopId === "number") {
            if (state.loopId !== null && state.loopId !== status.loopId) {
                resetLoopTurns(state, internals);
            }
            state.loopId = status.loopId;
            internals.bindingsWithLoops.add(bindingKey);
        } else if (status.loopId === null) {
            if (internals.bindingsWithLoops.has(bindingKey)) {
                internals.bindingsWithLoops.delete(bindingKey);
                internals.pendingHistoryLost = true;
            }
            state.loopId = null;
            resetLoopTurns(state, internals);
        }
        if (typeof status.loopSeq === "number") {
            if (
                (state.loopSeq !== null && state.loopSeq !== status.loopSeq) ||
                ((status.lifecycle === "queued" || status.lifecycle === "running") && internals.loopConcluded)
            ) {
                resetLoopTurns(state, internals);
            }
            state.loopSeq = status.loopSeq;
            internals.bindingsWithLoops.add(bindingKey);
        } else if (status.loopSeq === null) {
            if (!("loopId" in status) && internals.bindingsWithLoops.has(bindingKey)) {
                internals.bindingsWithLoops.delete(bindingKey);
                internals.pendingHistoryLost = true;
            }
            state.loopSeq = null;
            resetLoopTurns(state, internals);
        }
        if (typeof status.packetCount === "number" && status.packetCount > 0) {
            state.turns = Math.max(state.turns, status.packetCount);
        }
        if (
            (status.lifecycle === "idle" ||
                status.lifecycle === "completed" ||
                status.lifecycle === "cancelled" ||
                status.lifecycle === "failed") &&
            (state.loopId !== null || state.loopSeq !== null)
        ) {
            internals.loopConcluded = true;
        }
        if (typeof status.waitUntil === "number" || status.waitUntil === null) {
            state.waitUntil = status.waitUntil as number | null;
        }
        const claimedMs = parseTimestampMs(status.claimedAt);
        const terminatedMs = parseTimestampMs(status.terminatedAt);
        if (claimedMs !== null) {
            if (terminatedMs !== null && terminatedMs >= claimedMs) {
                internals.seededElapsedMs = Math.max(1, terminatedMs - claimedMs);
            } else if (
                state.lifecycle === "running" ||
                state.lifecycle === "queued" ||
                state.lifecycle === "parked" ||
                state.lifecycle === "requires_action"
            ) {
                internals.turnStartedAt = claimedMs;
                internals.seededElapsedMs = null;
            }
        }
        if (status.model === null) {
            const activeProvider = Array.isArray(plurnk.providers)
                ? (plurnk.providers as unknown[]).find(
                      (p): p is Record<string, unknown> =>
                          Boolean(p) && typeof p === "object" && (p as Record<string, unknown>).active === true,
                  )
                : undefined;
            if (activeProvider !== undefined) {
                if (typeof activeProvider.alias === "string" && activeProvider.alias.length > 0) {
                    state.model = activeProvider.alias;
                } else if (
                    typeof activeProvider.provider === "string" &&
                    typeof activeProvider.model === "string"
                ) {
                    state.model = `${activeProvider.provider}/${activeProvider.model}`;
                }
                state.effort =
                    typeof activeProvider.effort === "string" && activeProvider.effort.length > 0
                        ? activeProvider.effort
                        : null;
                state.effortSource =
                    activeProvider.effortSource === "default" || activeProvider.effortSource === "explicit"
                        ? activeProvider.effortSource
                        : state.effort !== null
                          ? "default"
                          : null;
            } else {
                state.model = "none";
                state.effort = null;
                state.effortSource = null;
            }
        } else if (status.model && typeof status.model === "object") {
            const m = status.model as Record<string, unknown>;
            if (typeof m.alias === "string" && m.alias.length > 0) {
                state.model = m.alias;
            } else if (typeof m.provider === "string" && typeof m.model === "string") {
                state.model = `${m.provider}/${m.model}`;
            }
            if (typeof m.effort === "string" && m.effort.length > 0) {
                state.effort = m.effort;
            } else if (m.effort === undefined || m.effort === null) {
                state.effort = null;
            }
            if (m.effortSource === "default" || m.effortSource === "explicit") {
                state.effortSource = m.effortSource;
            }
        }
        if (status.childModel === null) {
            state.childModel = null;
        } else if (status.childModel && typeof status.childModel === "object") {
            const cm = status.childModel as Record<string, unknown>;
            const base =
                typeof cm.alias === "string" && cm.alias.length > 0
                    ? cm.alias
                    : typeof cm.provider === "string" && typeof cm.model === "string"
                      ? `${cm.provider}/${cm.model}`
                      : null;
            const eff = typeof cm.effort === "string" && cm.effort.length > 0 ? cm.effort : null;
            const src = cm.effortSource === "explicit" ? "explicit" : "default";
            state.childModel = base !== null ? formatModelRoute(base, eff, src) : null;
        }
        if (Array.isArray(status.descendants)) {
            const isAliveLifecycle = (lc: unknown): boolean =>
                lc === "running" || lc === "queued" || lc === "parked" || lc === "requires_action";
            state.activeChildren = status.descendants.filter((d) =>
                isAliveLifecycle((d as Record<string, unknown>)?.lifecycle),
            ).length;
            state.gatedCount = status.descendants.reduce((acc: number, d) => {
                const rec = d as Record<string, unknown>;
                return acc + (typeof rec.gates === "number" ? rec.gates : 0);
            }, 0);
            const seenActiveWorkers = new Set<string>();
            for (const d of status.descendants) {
                if (!d || typeof d !== "object") continue;
                const rec = d as Record<string, unknown>;
                const rawName =
                    typeof rec.name === "string" && rec.name.length > 0
                        ? rec.name
                        : typeof rec.session === "string" && rec.session.length > 0
                          ? rec.session
                          : null;
                if (rawName === null) continue;
                const workerKey = normalizeWorkerKey(rawName);
                if (isAliveLifecycle(rec.lifecycle)) {
                    seenActiveWorkers.add(workerKey);
                    const existing = internals.activeWorkers.get(workerKey);
                    internals.activeWorkers.set(workerKey, {
                        key: workerKey,
                        glyph: existing?.glyph ?? "🐜",
                        op: existing?.op ?? "work",
                        target: existing?.target ?? `session:///${workerKey}`,
                        startedAt: existing?.startedAt ?? Date.now(),
                    });
                } else {
                    internals.activeWorkers.delete(workerKey);
                }
            }
            for (const key of [...internals.activeWorkers.keys()]) {
                if (!seenActiveWorkers.has(key)) {
                    internals.activeWorkers.delete(key);
                }
            }
        }
        if (Array.isArray(status.inbox)) {
            state.inboxCount = status.inbox.filter((item) => {
                const rec = item as Record<string, unknown> | null;
                const lc = rec && typeof rec === "object" ? rec.lifecycle : undefined;
                return lc === undefined || lc === "running" || lc === "queued" || lc === "parked";
            }).length;
        }
        if (Array.isArray(status.streams)) {
            ingestStatusStreams(state, internals, status.streams);
        }
        const spend = status.spend as Record<string, unknown> | undefined;
        if (spend) {
            const usage = (spend.usage ?? spend.knownUsage) as Record<string, unknown> | undefined;
            if (typeof usage?.inputTokens === "number") state.inputTokens = usage.inputTokens;
            if (typeof usage?.outputTokens === "number") state.outputTokens = usage.outputTokens;
            state.costUsd =
                typeof spend.costUsd === "string"
                    ? spend.costUsd
                    : typeof spend.knownCostUsd === "string"
                      ? spend.knownCostUsd
                      : null;
            state.hasUnknownCost =
                spend.costUsd === null &&
                (typeof spend.knownCostUsd === "string" ||
                    (typeof spend.requests === "number" && spend.requests > 0));
            if (
                state.lifecycle !== "running" ||
                (internals.turnBaseInputTokens === 0 &&
                    internals.turnBaseOutputTokens === 0 &&
                    internals.turnBaseCostUsd === null)
            ) {
                internals.turnBaseInputTokens = state.inputTokens;
                internals.turnBaseOutputTokens = state.outputTokens;
                internals.turnBaseCostUsd = state.costUsd;
            }
        }
    }

    const budget = plurnk.budget as Record<string, unknown> | undefined;
    if (budget) {
        if (typeof budget.curationBudget === "number" && budget.curationBudget > 0) {
            state.curationBudget = budget.curationBudget;
            if (typeof budget.curationWeight === "number") {
                state.curationWeight = budget.curationWeight;
            }
        }
        if (typeof budget.contextTokens === "number" || budget.contextTokens === null) {
            state.contextTokens = budget.contextTokens as number | null;
        }
        if (typeof budget.contextCapacity === "number" || budget.contextCapacity === null) {
            state.contextCapacity = budget.contextCapacity as number | null;
        }
    }
};

const ingestStatusStreams = (
    state: PresenterState,
    internals: PresenterInternals,
    streams: readonly unknown[],
): void => {
    state.openStreams = streams.length;
    internals.openStreamKeys.clear();
    const seenStreamKeys = new Set<string>();
    const seenStreamTargets = new Set<string>();
    const seenStreamEntryIds = new Set<number>();
    for (const item of streams) {
        if (!item || typeof item !== "object") continue;
        const s = item as Record<string, unknown>;
        const sTarget =
            typeof s.target === "string" && s.target.length > 0
                ? s.target
                : typeof s.id === "string" && s.id.length > 0
                  ? s.id
                  : null;
        const sEntryId =
            typeof s.entryId === "number"
                ? s.entryId
                : typeof s.id === "number"
                  ? s.id
                  : null;
        const coord =
            typeof s.loopSeq === "number" &&
            typeof s.turnSeq === "number" &&
            typeof s.sequence === "number"
                ? `${String(s.loopSeq)}/${String(s.turnSeq)}/${String(s.sequence)}`
                : null;
        const alreadyConcluded =
            (sTarget !== null && internals.concludedStreams.has(sTarget)) ||
            (sEntryId !== null && internals.concludedStreams.has(`term:${String(sEntryId)}`));
        if (alreadyConcluded) {
            continue;
        }
        if (typeof s.target === "string" && s.target.length > 0) {
            internals.openStreamKeys.add(s.target);
            seenStreamTargets.add(s.target);
        }
        if (typeof s.id === "string" && s.id.length > 0) {
            internals.openStreamKeys.add(s.id);
            seenStreamTargets.add(s.id);
        }
        if (sEntryId !== null) {
            seenStreamEntryIds.add(sEntryId);
        }
        if (coord !== null) {
            internals.openStreamKeys.add(coord);
            seenStreamKeys.add(coord);
        }
        const streamKey = coord ?? sTarget ?? (sEntryId !== null ? `term:${String(sEntryId)}` : null);
        if (streamKey !== null) {
            seenStreamKeys.add(streamKey);
            const derivedOp =
                typeof s.op === "string" && s.op.length > 0
                    ? s.op
                    : sTarget !== null && sTarget.includes("://")
                      ? sTarget.slice(0, sTarget.indexOf("://"))
                      : "sh";
            if (!(derivedOp.toLowerCase() in OPERATION_GLYPH_MAP)) {
                const existing =
                    internals.activeStreams.get(streamKey) ??
                    [...internals.activeStreams.values()].find(
                        (st) =>
                            (sTarget !== null && st.target === sTarget) ||
                            (sEntryId !== null && st.entryId === sEntryId),
                    );
                if (existing !== undefined && existing.key !== streamKey) {
                    internals.activeStreams.delete(existing.key);
                }
                const sAside =
                    typeof s.aside === "string" && s.aside.trim().length > 0
                        ? s.aside.trim()
                        : null;
                const parsedOpenedAt =
                    typeof s.openedAt === "string" && s.openedAt.length > 0
                        ? Date.parse(s.openedAt)
                        : Number.NaN;
                const sOpenedAtMs = Number.isFinite(parsedOpenedAt) ? parsedOpenedAt : null;
                internals.activeStreams.set(streamKey, {
                    key: streamKey,
                    entryId: sEntryId ?? existing?.entryId ?? null,
                    terminalIds:
                        existing?.terminalIds ??
                        (sEntryId !== null ? [`term:${String(sEntryId)}`] : []),
                    op:
                        typeof s.op === "string" && s.op.length > 0
                            ? s.op
                            : (existing?.op ?? derivedOp),
                    target: sTarget ?? existing?.target ?? streamKey,
                    aside: sAside ?? existing?.aside ?? null,
                    startedAt: existing?.startedAt ?? sOpenedAtMs ?? Date.now(),
                    openedTurn:
                        typeof s.turnSeq === "number"
                            ? s.turnSeq
                            : (existing?.openedTurn ?? state.turns),
                    survivedTurn: true,
                });
            }
        }
    }
    for (const [k, st] of [...internals.activeStreams.entries()]) {
        const matched =
            seenStreamKeys.has(k) ||
            seenStreamTargets.has(st.target) ||
            (st.entryId !== null && seenStreamEntryIds.has(st.entryId));
        if (!matched) {
            internals.activeStreams.delete(k);
        }
    }
};

export const buildPresenterStatusBar = (
    state: PresenterState,
    internals: PresenterInternals,
    elapsedMsOverride?: number,
    statusCodeOverride?: number,
): StatusBarModel => {
    const isActiveLifecycle =
        state.lifecycle === "running" ||
        state.lifecycle === "queued" ||
        state.lifecycle === "parked" ||
        state.lifecycle === "requires_action";
    const effectiveStatus =
        statusCodeOverride ?? (isActiveLifecycle ? undefined : (state.lastLoopStatus ?? undefined));
    const glyph = state.disconnected
        ? "🔌"
        : state.lifecycle === "idle" && effectiveStatus === undefined
          ? "idle"
          : lifecycleGlyphFor(state.lifecycle, effectiveStatus);
    state.lifecycleGlyph = glyph === "idle" ? "⏹️" : glyph;
    const elapsedMs =
        elapsedMsOverride ?? internals.seededElapsedMs ?? Math.max(1, Date.now() - internals.turnStartedAt);
    const used = state.contextTokens ?? state.curationWeight;
    const capacity = state.contextCapacity ?? state.curationBudget;
    const budgetPercent = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : null;

    const lead = glyph === "idle" ? "idle" : `${glyph} `;
    const modelLabel = formatModelRoute(state.model, state.effort, state.effortSource);
    const hasElapsed =
        elapsedMsOverride !== undefined ||
        isActiveLifecycle ||
        effectiveStatus !== undefined ||
        state.turns > 0 ||
        state.loopSeq !== null;
    const baseParts: string[] = [
        lead,
        modelLabel,
        ...(hasElapsed ? [formatDuration(elapsedMs)] : []),
    ];
    const usd = formatUsdSpend(state.costUsd, { hasUnknownCost: state.hasUnknownCost });
    if (
        !(typeof effectiveStatus === "number" && effectiveStatus >= 400) ||
        state.inputTokens > 0 ||
        state.outputTokens > 0 ||
        usd !== null
    ) {
        baseParts.push(`↓${abbreviatedCount(state.inputTokens)} ↑${abbreviatedCount(state.outputTokens)}`);
        if (usd !== null) {
            baseParts.push(usd);
        }
    }

    // Right-of-status-line live activity indicators ({§cli-session-status})
    if ((state.lifecycle === "running" || state.lifecycle === "queued") && state.doing !== null) {
        if (state.doing.phase === "queued") {
            const pos = state.doing.queuePosition;
            const depth = state.doing.queueDepth;
            const queueTag =
                typeof pos === "number" && pos > 0
                    ? typeof depth === "number" && depth >= pos
                        ? `queued (#${String(pos)}/${String(depth)})`
                        : `queued (#${String(pos)})`
                    : "queued";
            baseParts.push(`${queueTag} ${formatLiveWait(Math.max(0, Date.now() - state.doing.since))}`);
        } else if (state.doing.phase === "awaiting") {
            baseParts.push(`awaiting model ${formatLiveWait(Math.max(0, Date.now() - state.doing.since))}`);
        } else if (state.doing.op !== null) {
            baseParts.push(
                state.doing.target !== null
                    ? `${state.doing.op} ${compactTarget(state.doing.target)}`
                    : state.doing.op,
            );
        } else {
            baseParts.push("working");
        }
    } else if (state.lifecycle === "parked") {
        const remainingSec =
            state.waitUntil !== null ? Math.ceil((state.waitUntil - Date.now()) / 1000) : null;
        const waitSuffix =
            remainingSec !== null
                ? remainingSec > 0
                    ? `updates in ${String(remainingSec)}s`
                    : "updates due"
                : `updates in ${internals.lastStreamTarget || "stream"}`;
        baseParts.push(waitSuffix);
    }

    if (state.activeChildren > 0) baseParts.push(`🐜 ${String(state.activeChildren)}`);
    if (state.gatedCount > 0) baseParts.push(`🚦 ${String(state.gatedCount)}`);
    if (state.inboxCount > 0) baseParts.push(`📨 ${String(state.inboxCount)}`);
    if (state.openStreams > 0) baseParts.push(`📡 ${String(state.openStreams)}`);

    if (state.preparation && state.preparation.state && state.preparation.state !== "ready") {
        const label = state.preparation.phase ?? state.preparation.state;
        const pct =
            typeof state.preparation.percent === "number"
                ? ` ${String(Math.round(state.preparation.percent))}%`
                : "";
        baseParts.push(`🧮 ${label}${pct}`);
    }
    if (state.activity !== null) {
        const pct =
            typeof state.activity.percent === "number"
                ? ` ${String(Math.round(state.activity.percent))}%`
                : "";
        baseParts.push(`🔎 ${state.activity.phase}${pct}`);
    }

    const formattedStatusLine = baseParts.join(" · ");
    state.lastStatusLine = formattedStatusLine;

    return {
        workspaceName: state.workspaceName,
        sessionName: state.sessionName,
        projectLabel: state.projectLabel,
        lifecycle: state.lifecycle,
        lifecycleGlyph: state.lifecycleGlyph,
        yolo: state.yolo,
        model: state.model,
        effort: state.effort,
        loopSeq: state.loopSeq,
        waitUntil: state.waitUntil,
        curationWeight: state.curationWeight,
        curationBudget: state.curationBudget,
        contextTokens: state.contextTokens,
        contextCapacity: state.contextCapacity,
        budgetPercent,
        activeChildren: state.activeChildren,
        gatedCount: state.gatedCount,
        inboxCount: state.inboxCount,
        openStreams: state.openStreams,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        costUsd: state.costUsd,
        formattedStatusLine,
    };
};
