// Unified ACP v2 SessionPresenter pipeline ({§cli-rendering}, {§cli-session-status}, {§cli-markdown-projection}, {§cli-workspaces-and-sessions}).
// Single state machine between AcpSession and any rendering viewport (CLI stdout/stderr or pi-tui)
// so that TUI is a pure perspective of the CLI and never makes an independent presentation decision.

import {
    ContentBlock,
    SessionConfigOption,
    SessionUpdate,
    ToolCallContent,
    type SessionConfigOption as SessionConfigOptionType,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { contentBlockToText, type MetaRecord } from "./acp-session.ts";
import {
    abbreviatedCount,
    addDecimal,
    compactTarget,
    extractCoordinateSeqs,
    extractMessageVoice,
    extractRawString,
    extractScopeToken,
    extractTitleAside,
    extractTitleTarget,
    extractToolFields,
    formatActiveOperationLead,
    formatDuration,
    formatLiveWait,
    formatModelRoute,
    formatUsdSpend,
    lifecycleGlyphFor,
    NO_PREVIEW_VERBS,
    normalizeWorkerKey,
    OPERATION_GLYPH_MAP,
    operationGlyphFor,
    receiptCountFor,
    spanLength,
    WORKER_OPS,
} from "./presenter-formatters.ts";
import {
    CONTENT_BLOCK_GUARDS,
    SESSION_CONFIG_OPTION_GUARDS,
    SESSION_UPDATE_GUARDS,
    TOOL_CALL_CONTENT_GUARDS,
    type ActiveLiveEntry,
    type ActiveStreamState,
    type ActiveWorkerState,
    type PendingToolCallState,
    type PresentationFrame,
    type SearchActivityState,
    type SessionDoing,
    type SessionPresenterOptions,
    type StatusBarModel,
    type WorkspacePreparationState,
} from "./session-presenter-types.ts";

export {
    abbreviatedCount,
    addDecimal,
    compactTarget,
    CONTENT_BLOCK_GUARDS,
    extractMessageVoice,
    extractRawString,
    extractScopeToken,
    extractTitleAside,
    extractTitleTarget,
    extractToolFields,
    formatActiveOperationLead,
    formatDuration,
    formatLiveWait,
    formatModelRoute,
    formatUsdSpend,
    lifecycleGlyphFor,
    NO_PREVIEW_VERBS,
    normalizeWorkerKey,
    OPERATION_GLYPH_MAP,
    operationGlyphFor,
    receiptCountFor,
    SESSION_CONFIG_OPTION_GUARDS,
    SESSION_UPDATE_GUARDS,
    spanLength,
    TOOL_CALL_CONTENT_GUARDS,
    WORKER_OPS,
    type ActiveLiveEntry,
    type PresentationFrame,
    type SearchActivityState,
    type SessionDoing,
    type SessionPresenterOptions,
    type StatusBarModel,
    type WorkspacePreparationState,
};

export class SessionPresenter {
    workspaceName: string;
    sessionName: string;
    projectLabel: string | null = null;
    lifecycle: string = "idle";
    lifecycleGlyph: string = "⏹️";
    #localYolo: boolean;
    #serverAllowMode = false;
    model: string;
    effort: string | null = null;
    effortSource: "default" | "explicit" | null = null;
    supportedEfforts: readonly string[] = [];
    spawnModel: string | null = null;
    loopId: number | null = null;
    loopSeq: number | null = null;
    turns = 0;
    waitUntil: number | null = null;
    curationWeight = 0;
    curationBudget = 0;
    contextTokens: number | null = null;
    contextCapacity: number | null = null;
    activeChildren = 0;
    gatedCount = 0;
    inboxCount = 0;
    openStreams = 0;
    inputTokens = 0;
    outputTokens = 0;
    costUsd: string | null = null;
    hasUnknownCost = false;
    doing: SessionDoing | null = null;
    preparation: WorkspacePreparationState | null = null;
    activity: SearchActivityState | null = null;
    disconnected = false;
    lastLoopStatus: number | null = null;
    lastStatusLine = "";

    readonly maxReasoningLines: number;
    #reasoningBuffer = "";
    #reasoningLines: string[] = [];
    #lastStreamTarget = "";
    #turnStartedAt = Date.now();
    #turnBaseInputTokens = 0;
    #turnBaseOutputTokens = 0;
    #turnBaseCostUsd: string | null = null;
    #loopCostUsd: string | null = null;
    readonly #pendingToolCalls = new Map<string, PendingToolCallState>();
    readonly #renderedToolCalls = new Set<string>();
    readonly #concludedStreams = new Map<string, number>();
    readonly #openStreamKeys = new Set<string>();
    readonly #activeStreams = new Map<string, ActiveStreamState>();
    readonly #activeWorkers = new Map<string, ActiveWorkerState>();
    readonly #bindingsWithLoops = new Set<string>();
    #replayingHistory = false;
    #pendingHistoryLost = false;
    #awaitingTurnCount = 0;
    #loopConcluded = false;

    constructor(options: SessionPresenterOptions = {}) {
        this.workspaceName = options.workspaceName ?? "default";
        this.sessionName = options.sessionName ?? "user";
        this.model = options.model ?? "default";
        this.#localYolo = options.yolo ?? false;
        this.maxReasoningLines = options.maxReasoningLines ?? 3;

        if (options.initialConfigOptions) {
            this.#applyConfigOptions(options.initialConfigOptions);
        }
        if (options.initialMeta) {
            this.ingestMeta(options.initialMeta);
        }
        this.#turnBaseInputTokens = this.inputTokens;
        this.#turnBaseOutputTokens = this.outputTokens;
        this.#turnBaseCostUsd = this.costUsd;
    }

    get yolo(): boolean {
        return this.#localYolo || this.#serverAllowMode;
    }

    set yolo(value: boolean) {
        this.#localYolo = value;
    }

    get reasoningLines(): readonly string[] {
        return this.#reasoningLines;
    }

    get activeLiveEntries(): readonly ActiveLiveEntry[] {
        const entries: ActiveLiveEntry[] = [];
        for (const stream of this.#activeStreams.values()) {
            if (!stream.survivedTurn) continue;
            entries.push({
                key: stream.key,
                kind: "stream",
                glyph: "⚙️",
                op: stream.op,
                target: stream.target,
                startedAt: stream.startedAt,
            });
        }
        for (const worker of this.#activeWorkers.values()) {
            entries.push({
                key: worker.key,
                kind: "worker",
                glyph: worker.glyph,
                op: worker.op,
                target: worker.target,
                startedAt: worker.startedAt,
            });
        }
        return entries;
    }

    #promoteSurvivingStreams(currentTurn = this.turns, forceAll = false): void {
        for (const [k, st] of this.#activeStreams.entries()) {
            if (!st.survivedTurn && (forceAll || currentTurn > st.openedTurn)) {
                this.#activeStreams.set(k, { ...st, survivedTurn: true });
            }
        }
    }

    setHistoryReplay(replaying: boolean): void {
        this.#replayingHistory = replaying;
    }

    // {§cli-workspaces-and-sessions} — Emits a warning Notice frame when loopId/loopSeq becomes null
    // after a gauge on the same binding previously carried a loop.
    consumeHistoryLostFrame(): Extract<PresentationFrame, { kind: "notice" }> | null {
        if (!this.#pendingHistoryLost) return null;
        this.#pendingHistoryLost = false;
        const description = "The daemon holds no history for this session.";
        return {
            kind: "notice",
            severity: "warning",
            title: "client:session:history_lost",
            description,
            formatted: `⚠️  ${description}`,
        };
    }

    resetSessionHistory(): void {
        this.#pendingToolCalls.clear();
        this.#renderedToolCalls.clear();
        this.#concludedStreams.clear();
        this.#activeStreams.clear();
        this.#activeWorkers.clear();
    }

    isOpenStream(toolCallId: string, streamTarget?: string | null): boolean {
        if (this.#openStreamKeys.has(toolCallId)) return true;
        if (typeof streamTarget === "string" && streamTarget.length > 0 && this.#openStreamKeys.has(streamTarget)) {
            return true;
        }
        return false;
    }

    #resetLoopTurns(): void {
        this.turns = 0;
        this.#awaitingTurnCount = 0;
        this.#loopConcluded = false;
        this.lastLoopStatus = null;
        this.#loopCostUsd = null;
    }

    #syncLoopAndTurn(loopSeq: unknown, turnSeq?: unknown): void {
        if (typeof loopSeq === "number") {
            if (this.loopSeq !== null && this.loopSeq !== loopSeq) {
                this.#resetLoopTurns();
            }
            this.loopSeq = loopSeq;
            this.#bindingsWithLoops.add(`${this.workspaceName}#${this.sessionName}`);
        }
        if (typeof turnSeq === "number" && turnSeq > 0) {
            if (this.#loopConcluded && typeof loopSeq !== "number") {
                this.#resetLoopTurns();
            }
            if (turnSeq > this.turns) {
                this.#loopConcluded = false;
            }
            this.turns = Math.max(this.turns, turnSeq);
            this.#promoteSurvivingStreams(this.turns);
        }
    }

    markTurnStart(now = Date.now()): void {
        if (this.#loopConcluded) {
            this.#resetLoopTurns();
        }
        this.lastLoopStatus = null;
        this.#loopCostUsd = null;
        this.#turnStartedAt = now;
        this.#turnBaseInputTokens = this.inputTokens;
        this.#turnBaseOutputTokens = this.outputTokens;
        this.#turnBaseCostUsd = this.costUsd;
        this.disconnected = false;
        this.lifecycle = "running";
        this.lifecycleGlyph = "⌛︎";
        this.doing = { phase: "awaiting", since: now, op: null, target: null };
    }

    markDisconnected(): StatusBarModel {
        this.disconnected = true;
        this.lifecycle = "idle";
        this.doing = null;
        this.#activeStreams.clear();
        this.#activeWorkers.clear();
        return this.buildStatusBar();
    }

    ingestMeta(meta: MetaRecord | undefined): void {
        if (!meta) return;
        const plurnk = meta.plurnk as Record<string, unknown> | undefined;
        if (!plurnk) return;
        this.disconnected = false;

        const ws = plurnk.workspace as Record<string, unknown> | undefined;
        if (typeof ws?.name === "string" && ws.name.length > 0) {
            this.workspaceName = ws.name;
        }
        if (typeof ws?.projectLabel === "string") {
            this.projectLabel = ws.projectLabel;
        }
        if (ws?.preparation && typeof ws.preparation === "object") {
            const prep = ws.preparation as Record<string, unknown>;
            this.preparation = {
                ...(typeof prep.state === "string" ? { state: prep.state } : {}),
                ...(typeof prep.phase === "string" ? { phase: prep.phase } : {}),
                ...(typeof prep.percent === "number" ? { percent: prep.percent } : {}),
            };
        }
        if (plurnk.preparation && typeof plurnk.preparation === "object") {
            const prep = plurnk.preparation as Record<string, unknown>;
            this.preparation = {
                ...(typeof prep.state === "string" ? { state: prep.state } : {}),
                ...(typeof prep.phase === "string" ? { phase: prep.phase } : {}),
                ...(typeof prep.percent === "number" ? { percent: prep.percent } : {}),
            };
        }
        if (typeof plurnk.sessionName === "string" && plurnk.sessionName.length > 0) {
            this.sessionName = plurnk.sessionName;
        }
        this.#syncLoopAndTurn(plurnk.loopSeq, plurnk.turn);

        const status = plurnk.status as Record<string, unknown> | undefined;
        if (status) {
            const bindingKey = `${this.workspaceName}#${this.sessionName}`;
            if (typeof status.lifecycle === "string") {
                this.lifecycle = status.lifecycle;
                if (
                    status.lifecycle === "running" ||
                    status.lifecycle === "queued" ||
                    status.lifecycle === "parked" ||
                    status.lifecycle === "requires_action"
                ) {
                    this.lastLoopStatus = null;
                }
            }
            if (typeof status.loopId === "number") {
                if (this.loopId !== null && this.loopId !== status.loopId) {
                    this.#resetLoopTurns();
                }
                this.loopId = status.loopId;
                this.#bindingsWithLoops.add(bindingKey);
            } else if (status.loopId === null) {
                if (this.#bindingsWithLoops.has(bindingKey)) {
                    this.#bindingsWithLoops.delete(bindingKey);
                    this.#pendingHistoryLost = true;
                }
                this.loopId = null;
                this.#resetLoopTurns();
            }
            if (typeof status.loopSeq === "number") {
                if (
                    (this.loopSeq !== null && this.loopSeq !== status.loopSeq) ||
                    ((status.lifecycle === "queued" || status.lifecycle === "running") && this.#loopConcluded)
                ) {
                    this.#resetLoopTurns();
                }
                this.loopSeq = status.loopSeq;
                this.#bindingsWithLoops.add(bindingKey);
            } else if (status.loopSeq === null) {
                if (!("loopId" in status) && this.#bindingsWithLoops.has(bindingKey)) {
                    this.#bindingsWithLoops.delete(bindingKey);
                    this.#pendingHistoryLost = true;
                }
                this.loopSeq = null;
                this.#resetLoopTurns();
            }
            if (typeof status.packetCount === "number" && status.packetCount > 0) {
                this.turns = Math.max(this.turns, status.packetCount);
            }
            if (
                (status.lifecycle === "idle" ||
                    status.lifecycle === "completed" ||
                    status.lifecycle === "cancelled" ||
                    status.lifecycle === "failed") &&
                (this.loopId !== null || this.loopSeq !== null)
            ) {
                this.#loopConcluded = true;
            }
            if (typeof status.waitUntil === "number" || status.waitUntil === null) {
                this.waitUntil = status.waitUntil as number | null;
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
                        this.model = activeProvider.alias;
                    } else if (
                        typeof activeProvider.provider === "string" &&
                        typeof activeProvider.model === "string"
                    ) {
                        this.model = `${activeProvider.provider}/${activeProvider.model}`;
                    }
                    if (typeof activeProvider.effort === "string" && activeProvider.effort.length > 0) {
                        this.effort = activeProvider.effort;
                    } else {
                        this.effort = null;
                    }
                    if (
                        activeProvider.effortSource === "default" ||
                        activeProvider.effortSource === "explicit"
                    ) {
                        this.effortSource = activeProvider.effortSource;
                    } else {
                        this.effortSource = this.effort !== null ? "default" : null;
                    }
                } else {
                    this.model = "none";
                    this.effort = null;
                    this.effortSource = null;
                }
            } else if (status.model && typeof status.model === "object") {
                const m = status.model as Record<string, unknown>;
                if (typeof m.alias === "string" && m.alias.length > 0) {
                    this.model = m.alias;
                } else if (typeof m.provider === "string" && typeof m.model === "string") {
                    this.model = `${m.provider}/${m.model}`;
                }
                if (typeof m.effort === "string" && m.effort.length > 0) {
                    this.effort = m.effort;
                } else if (m.effort === undefined || m.effort === null) {
                    this.effort = null;
                }
                if (m.effortSource === "default" || m.effortSource === "explicit") {
                    this.effortSource = m.effortSource;
                }
            }
            if (status.spawnModel === null) {
                this.spawnModel = null;
            } else if (status.spawnModel && typeof status.spawnModel === "object") {
                const sm = status.spawnModel as Record<string, unknown>;
                const base =
                    typeof sm.alias === "string" && sm.alias.length > 0
                        ? sm.alias
                        : typeof sm.provider === "string" && typeof sm.model === "string"
                          ? `${sm.provider}/${sm.model}`
                          : null;
                const eff = typeof sm.effort === "string" && sm.effort.length > 0 ? sm.effort : null;
                const src = sm.effortSource === "explicit" ? "explicit" : "default";
                this.spawnModel = base !== null ? formatModelRoute(base, eff, src) : null;
            }
            if (Array.isArray(status.descendants)) {
                this.activeChildren = status.descendants.filter((d) => {
                    const rec = d as Record<string, unknown>;
                    return (
                        rec.lifecycle === "running" ||
                        rec.lifecycle === "queued" ||
                        rec.lifecycle === "parked" ||
                        rec.lifecycle === "requires_action"
                    );
                }).length;
                this.gatedCount = status.descendants.reduce((acc: number, d) => {
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
                    const isAlive =
                        rec.lifecycle === "running" ||
                        rec.lifecycle === "queued" ||
                        rec.lifecycle === "parked" ||
                        rec.lifecycle === "requires_action";
                    if (isAlive) {
                        seenActiveWorkers.add(workerKey);
                        const existing = this.#activeWorkers.get(workerKey);
                        this.#activeWorkers.set(workerKey, {
                            key: workerKey,
                            glyph: existing?.glyph ?? "🐜",
                            op: existing?.op ?? "work",
                            target: existing?.target ?? `session:///${workerKey}`,
                            startedAt: existing?.startedAt ?? Date.now(),
                        });
                    } else {
                        this.#activeWorkers.delete(workerKey);
                    }
                }
                for (const key of [...this.#activeWorkers.keys()]) {
                    if (!seenActiveWorkers.has(key)) {
                        this.#activeWorkers.delete(key);
                    }
                }
            }
            if (Array.isArray(status.inbox)) {
                this.inboxCount = status.inbox.filter((item) => {
                    const rec = item as Record<string, unknown> | null;
                    const lc = rec && typeof rec === "object" ? rec.lifecycle : undefined;
                    return lc === undefined || lc === "running" || lc === "queued" || lc === "parked";
                }).length;
            }
            if (Array.isArray(status.streams)) {
                this.openStreams = status.streams.length;
                this.#openStreamKeys.clear();
                const seenStreamKeys = new Set<string>();
                const seenStreamTargets = new Set<string>();
                const seenStreamEntryIds = new Set<number>();
                for (const item of status.streams) {
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
                        typeof s.loop_seq === "number" &&
                        typeof s.turn_seq === "number" &&
                        typeof s.sequence === "number"
                            ? `${String(s.loop_seq)}/${String(s.turn_seq)}/${String(s.sequence)}`
                            : null;
                    const alreadyConcluded =
                        (sTarget !== null && this.#concludedStreams.has(sTarget)) ||
                        (sEntryId !== null && this.#concludedStreams.has(`term:${String(sEntryId)}`));
                    if (alreadyConcluded) {
                        continue;
                    }
                    if (typeof s.target === "string" && s.target.length > 0) {
                        this.#openStreamKeys.add(s.target);
                        seenStreamTargets.add(s.target);
                    }
                    if (typeof s.id === "string" && s.id.length > 0) {
                        this.#openStreamKeys.add(s.id);
                        seenStreamTargets.add(s.id);
                    }
                    if (sEntryId !== null) {
                        seenStreamEntryIds.add(sEntryId);
                    }
                    if (coord !== null) {
                        this.#openStreamKeys.add(coord);
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
                                this.#activeStreams.get(streamKey) ??
                                [...this.#activeStreams.values()].find(
                                    (st) =>
                                        (sTarget !== null && st.target === sTarget) ||
                                        (sEntryId !== null && st.entryId === sEntryId),
                                );
                            if (existing !== undefined && existing.key !== streamKey) {
                                this.#activeStreams.delete(existing.key);
                            }
                            this.#activeStreams.set(streamKey, {
                                key: streamKey,
                                entryId: sEntryId ?? existing?.entryId ?? null,
                                terminalIds:
                                    existing?.terminalIds ??
                                    (sEntryId !== null ? [`term:${String(sEntryId)}`] : []),
                                op: existing?.op ?? derivedOp,
                                target: sTarget ?? existing?.target ?? streamKey,
                                startedAt: existing?.startedAt ?? Date.now(),
                                openedTurn:
                                    typeof s.turn_seq === "number"
                                        ? s.turn_seq
                                        : (existing?.openedTurn ?? this.turns),
                                survivedTurn: true,
                            });
                        }
                    }
                }
                for (const [k, st] of [...this.#activeStreams.entries()]) {
                    const matched =
                        seenStreamKeys.has(k) ||
                        seenStreamTargets.has(st.target) ||
                        (st.entryId !== null && seenStreamEntryIds.has(st.entryId));
                    if (!matched) {
                        this.#activeStreams.delete(k);
                    }
                }
            }
            const spend = status.spend as Record<string, unknown> | undefined;
            if (spend) {
                const usage = (spend.usage ?? spend.knownUsage) as Record<string, unknown> | undefined;
                if (typeof usage?.inputTokens === "number") this.inputTokens = usage.inputTokens;
                if (typeof usage?.outputTokens === "number") this.outputTokens = usage.outputTokens;
                const cost =
                    typeof spend.costUsd === "string"
                        ? spend.costUsd
                        : typeof spend.knownCostUsd === "string"
                          ? spend.knownCostUsd
                          : null;
                this.costUsd = cost;
                this.hasUnknownCost =
                    spend.costUsd === null &&
                    (typeof spend.knownCostUsd === "string" ||
                        (typeof spend.requests === "number" && spend.requests > 0));
                if (
                    this.lifecycle !== "running" ||
                    (this.#turnBaseInputTokens === 0 &&
                        this.#turnBaseOutputTokens === 0 &&
                        this.#turnBaseCostUsd === null)
                ) {
                    this.#turnBaseInputTokens = this.inputTokens;
                    this.#turnBaseOutputTokens = this.outputTokens;
                    this.#turnBaseCostUsd = this.costUsd;
                }
            }
        }

        const budget = plurnk.budget as Record<string, unknown> | undefined;
        if (budget) {
            if (typeof budget.curationBudget === "number" && budget.curationBudget > 0) {
                this.curationBudget = budget.curationBudget;
                if (typeof budget.curationWeight === "number") {
                    this.curationWeight = budget.curationWeight;
                }
            }
            if (typeof budget.contextTokens === "number" || budget.contextTokens === null) {
                this.contextTokens = budget.contextTokens as number | null;
            }
            if (typeof budget.contextCapacity === "number" || budget.contextCapacity === null) {
                this.contextCapacity = budget.contextCapacity as number | null;
            }
        }
    }

    #applyConfigOptions(options: readonly SessionConfigOptionType[], fromUpdate = false): void {
        for (const opt of options) {
            if (opt.configId === "model" && SessionConfigOption.isSelect(opt) && opt.currentValue.length > 0) {
                this.model = opt.currentValue;
            } else if (opt.configId === "thought_level" && SessionConfigOption.isSelect(opt)) {
                const nextEffort = opt.currentValue.length > 0 ? opt.currentValue : null;
                if (fromUpdate && nextEffort !== null && nextEffort !== this.effort) {
                    this.effortSource = "explicit";
                } else if (this.effortSource === null && nextEffort !== null) {
                    this.effortSource = "default";
                }
                this.effort = nextEffort;
                const vals: string[] = [];
                for (const item of opt.options) {
                    if ("options" in item) {
                        for (const sub of item.options) vals.push(sub.value);
                    } else {
                        vals.push(item.value);
                    }
                }
                this.supportedEfforts = vals;
            } else if (opt.configId === "spawn_model" && SessionConfigOption.isSelect(opt)) {
                this.spawnModel = opt.currentValue.length > 0 && opt.currentValue !== "inherit" ? opt.currentValue : null;
            } else if (opt.configId === "mode" && SessionConfigOption.isSelect(opt)) {
                this.#serverAllowMode = opt.currentValue === "allow";
            }
        }
    }

    #retireReasoning(frames: PresentationFrame[]): void {
        if (this.#reasoningLines.length > 0 || this.#reasoningBuffer.length > 0) {
            this.#reasoningBuffer = "";
            this.#reasoningLines = [];
            frames.push({ kind: "reasoning_retired" });
        }
    }

    buildStatusBar(elapsedMsOverride?: number, statusCodeOverride?: number): StatusBarModel {
        const isActiveLifecycle =
            this.lifecycle === "running" ||
            this.lifecycle === "queued" ||
            this.lifecycle === "parked" ||
            this.lifecycle === "requires_action";
        const effectiveStatus =
            statusCodeOverride ?? (isActiveLifecycle ? undefined : (this.lastLoopStatus ?? undefined));
        const glyph = this.disconnected
            ? "🔌"
            : this.lifecycle === "idle" && effectiveStatus === undefined
              ? "idle"
              : lifecycleGlyphFor(this.lifecycle, effectiveStatus);
        this.lifecycleGlyph = glyph === "idle" ? "⏹️" : glyph;
        const elapsedMs = elapsedMsOverride ?? Math.max(1, Date.now() - this.#turnStartedAt);
        const used = this.contextTokens ?? this.curationWeight;
        const capacity = this.contextCapacity ?? this.curationBudget;
        const budgetPercent = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : null;

        const lead = glyph === "idle" ? "idle" : `${glyph} `;
        const modelLabel = formatModelRoute(this.model, this.effort, this.effortSource);
        const hasElapsed =
            elapsedMsOverride !== undefined ||
            isActiveLifecycle ||
            effectiveStatus !== undefined ||
            this.turns > 0 ||
            this.loopSeq !== null;
        const baseParts: string[] = [
            lead,
            modelLabel,
            ...(hasElapsed ? [formatDuration(elapsedMs)] : []),
        ];
        const usd = formatUsdSpend(this.costUsd, { hasUnknownCost: this.hasUnknownCost });
        if (
            !(typeof effectiveStatus === "number" && effectiveStatus >= 400) ||
            this.inputTokens > 0 ||
            this.outputTokens > 0 ||
            usd !== null
        ) {
            baseParts.push(`↓${abbreviatedCount(this.inputTokens)} ↑${abbreviatedCount(this.outputTokens)}`);
            if (usd !== null) {
                baseParts.push(usd);
            }
        }

        // Right-of-status-line live activity indicators ({§cli-session-status})
        if (this.lifecycle === "running" && this.doing !== null) {
            if (this.doing.phase === "awaiting") {
                baseParts.push(`awaiting model ${formatLiveWait(Math.max(0, Date.now() - this.doing.since))}`);
            } else if (this.doing.op !== null) {
                baseParts.push(
                    this.doing.target !== null
                        ? `${this.doing.op} ${compactTarget(this.doing.target)}`
                        : this.doing.op,
                );
            } else {
                baseParts.push("working");
            }
        } else if (this.lifecycle === "parked") {
            const remainingSec =
                this.waitUntil !== null ? Math.ceil((this.waitUntil - Date.now()) / 1000) : null;
            const waitSuffix =
                remainingSec !== null
                    ? remainingSec > 0
                        ? `updates in ${String(remainingSec)}s`
                        : "updates due"
                    : `updates in ${this.#lastStreamTarget || "stream"}`;
            baseParts.push(waitSuffix);
        }

        if (this.activeChildren > 0) {
            baseParts.push(`🐜 ${String(this.activeChildren)}`);
        }
        if (this.gatedCount > 0) {
            baseParts.push(`🚦 ${String(this.gatedCount)}`);
        }
        if (this.inboxCount > 0) {
            baseParts.push(`📨 ${String(this.inboxCount)}`);
        }
        if (this.openStreams > 0) {
            baseParts.push(`📡 ${String(this.openStreams)}`);
        }
        if (this.preparation && this.preparation.state && this.preparation.state !== "ready") {
            const label = this.preparation.phase ?? this.preparation.state;
            const pct =
                typeof this.preparation.percent === "number"
                    ? ` ${String(Math.round(this.preparation.percent))}%`
                    : "";
            baseParts.push(`🧮 ${label}${pct}`);
        }
        if (this.activity !== null) {
            const pct =
                typeof this.activity.percent === "number"
                    ? ` ${String(Math.round(this.activity.percent))}%`
                    : "";
            baseParts.push(`🔎 ${this.activity.phase}${pct}`);
        }

        const formattedStatusLine = baseParts.join(" · ");
        this.lastStatusLine = formattedStatusLine;

        return {
            workspaceName: this.workspaceName,
            sessionName: this.sessionName,
            projectLabel: this.projectLabel,
            lifecycle: this.lifecycle,
            lifecycleGlyph: this.lifecycleGlyph,
            yolo: this.yolo,
            model: this.model,
            effort: this.effort,
            loopSeq: this.loopSeq,
            waitUntil: this.waitUntil,
            curationWeight: this.curationWeight,
            curationBudget: this.curationBudget,
            contextTokens: this.contextTokens,
            contextCapacity: this.contextCapacity,
            budgetPercent,
            activeChildren: this.activeChildren,
            gatedCount: this.gatedCount,
            inboxCount: this.inboxCount,
            openStreams: this.openStreams,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            costUsd: this.costUsd,
            formattedStatusLine,
        };
    }

    #flushPendingHistoryLost(frames: PresentationFrame[]): void {
        const lost = this.consumeHistoryLostFrame();
        if (lost !== null) {
            frames.push(lost);
        }
    }

    #applyEngineNoticeMeta(
        meta: unknown,
        frames: PresentationFrame[],
        legacyTitle?: string,
    ): boolean {
        const plurnkMeta = (
            meta as
                | { plurnk?: { notice?: Record<string, unknown> } }
                | undefined
        )?.plurnk;
        const rawNotice = plurnkMeta?.notice;

        if (rawNotice?.source === "engine:turn" || legacyTitle?.startsWith("engine:turn:")) {
            if (rawNotice?.kind === "turn_awaiting_model" || legacyTitle === "engine:turn:turn_awaiting_model") {
                this.#retireReasoning(frames);
                if (this.#loopConcluded) {
                    this.#resetLoopTurns();
                }
                this.lastLoopStatus = null;
                this.#awaitingTurnCount += 1;
                this.turns = Math.max(this.turns, this.#awaitingTurnCount);
                this.#promoteSurvivingStreams(this.turns, true);
                this.lifecycle = "running";
                this.doing = { phase: "awaiting", since: Date.now(), op: null, target: null };
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                    newTurn: true,
                });
                return true;
            }
            if (rawNotice?.kind === "turn_generated" || legacyTitle === "engine:turn:turn_generated") {
                this.#retireReasoning(frames);
                this.lastLoopStatus = null;
                this.lifecycle = "running";
                this.doing = { phase: "working", since: Date.now(), op: null, target: null };
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
                this.inputTokens += inTok;
                this.outputTokens += outTok;
                const turnCost =
                    typeof acc?.costUsd === "string"
                        ? acc.costUsd
                        : typeof acc?.knownCostUsd === "string"
                          ? acc.knownCostUsd
                          : null;
                if (turnCost !== null) {
                    this.costUsd = addDecimal(this.costUsd, turnCost);
                    this.#loopCostUsd = addDecimal(this.#loopCostUsd, turnCost);
                }
                if (
                    acc !== undefined &&
                    acc.costUsd === null &&
                    (typeof acc.knownCostUsd === "string" || (typeof acc.requests === "number" && acc.requests > 0))
                ) {
                    this.hasUnknownCost = true;
                }
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                });
                return true;
            }
            if (rawNotice?.kind === "results_pending" || legacyTitle === "engine:turn:results_pending") {
                this.lastLoopStatus = null;
                this.lifecycle = "running";
                this.doing = { phase: "working", since: Date.now(), op: null, target: null };
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                });
                return true;
            }
        }

        if (rawNotice?.kind === "loop_status") {
            if (typeof rawNotice.loopSeq === "number") {
                if (
                    (this.loopSeq !== null && this.loopSeq !== rawNotice.loopSeq) ||
                    ((rawNotice.status === 100 || rawNotice.status === 102) && this.#loopConcluded)
                ) {
                    this.#resetLoopTurns();
                }
                this.loopSeq = rawNotice.loopSeq;
                this.#bindingsWithLoops.add(`${this.workspaceName}#${this.sessionName}`);
            }
            if (typeof rawNotice.packetCount === "number" && rawNotice.packetCount > 0) {
                this.turns = Math.max(this.turns, rawNotice.packetCount);
            } else if (rawNotice.status === 102 && this.turns === 0) {
                this.turns = 1;
            }
            if (rawNotice.status === 202) {
                this.#retireReasoning(frames);
                this.#promoteSurvivingStreams(this.turns, true);
                this.lastLoopStatus = null;
                this.lifecycle = "parked";
                this.doing = null;
                this.waitUntil = typeof rawNotice.waitUntil === "number" ? rawNotice.waitUntil : null;
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                });
                return true;
            }
            if (rawNotice.status === 100 || rawNotice.status === 102) {
                this.lastLoopStatus = null;
                this.waitUntil = null;
                this.lifecycle = rawNotice.status === 102 ? "running" : "queued";
                this.doing =
                    rawNotice.status === 102
                        ? { phase: "working", since: Date.now(), op: null, target: null }
                        : null;
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
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
                this.activity = null;
            } else {
                this.activity = {
                    phase: typeof rawNotice?.phase === "string" ? rawNotice.phase : "search",
                    ...(pct !== undefined ? { percent: pct } : {}),
                };
            }
            frames.push({
                kind: "status_update",
                status: this.buildStatusBar(),
            });
            return true;
        }

        return false;
    }

    apply(update: SessionUpdate): PresentationFrame[] {
        const frames: PresentationFrame[] = [];

        if (SessionUpdate.isSessionInfoUpdate(update)) {
            this.ingestMeta(update._meta as MetaRecord | undefined);
            if (typeof update.title === "string" && update.title.length > 0) {
                const hashIdx = update.title.indexOf("#");
                if (hashIdx > 0 && hashIdx < update.title.length - 1) {
                    const ws = update.title.slice(0, hashIdx).trim();
                    const sess = update.title.slice(hashIdx + 1).trim();
                    if (ws.length > 0) this.workspaceName = ws;
                    if (sess.length > 0) this.sessionName = sess;
                } else {
                    this.sessionName = update.title;
                }
            }
            if (this.#applyEngineNoticeMeta(update._meta, frames)) {
                return frames;
            }
            this.#flushPendingHistoryLost(frames);
            frames.push({
                kind: "status_update",
                status: this.buildStatusBar(),
            });
            return frames;
        }

        if (SessionUpdate.isCustom(update)) {
            if (update.sessionUpdate === "_plurnk_telemetry") {
                this.ingestMeta(update._meta as MetaRecord | undefined);
                if (this.#applyEngineNoticeMeta(update._meta, frames)) {
                    return frames;
                }
                this.#flushPendingHistoryLost(frames);
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                });
            }
            return frames;
        }

        if (SessionUpdate.isConfigOptionUpdate(update)) {
            this.ingestMeta(update._meta as MetaRecord | undefined);
            this.#applyConfigOptions(update.configOptions, true);
            this.#flushPendingHistoryLost(frames);
            return frames;
        }

        if (SessionUpdate.isUsageUpdate(update)) {
            const hasMetaBudget =
                typeof (update._meta as { plurnk?: { budget?: unknown } } | undefined)?.plurnk?.budget === "object" &&
                (update._meta as { plurnk?: { budget?: unknown } }).plurnk?.budget !== null;
            this.ingestMeta(update._meta as MetaRecord | undefined);
            if (!hasMetaBudget) {
                this.curationWeight = update.used;
                this.curationBudget = update.size;
            } else {
                if (this.contextTokens === null && this.curationWeight === 0) {
                    this.curationWeight = update.used;
                }
                if (this.contextCapacity === null && this.curationBudget === 0) {
                    this.curationBudget = update.size;
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
                this.costUsd = String(update.cost.amount);
            }
            this.#flushPendingHistoryLost(frames);
            return frames;
        }

        if (SessionUpdate.isAgentThoughtChunk(update) || SessionUpdate.isAgentThought(update)) {
            const thoughtPlurnk = (
                update._meta as
                    | {
                          plurnk?: {
                              op?: string;
                              status?: number;
                              loopSeq?: number;
                              turnSeq?: number;
                              turn?: number;
                              outside?: unknown;
                          };
                      }
                    | undefined
            )?.plurnk;
            const thoughtCoord = extractCoordinateSeqs(update.messageId);
            this.#syncLoopAndTurn(
                thoughtPlurnk?.loopSeq ?? thoughtCoord.loopSeq,
                (typeof thoughtPlurnk?.turnSeq === "number" ? thoughtPlurnk.turnSeq : thoughtPlurnk?.turn) ??
                    thoughtCoord.turnSeq,
            );
            const deltaText = SessionUpdate.isAgentThoughtChunk(update)
                ? contentBlockToText(update.content)
                : (update.content ?? []).map(contentBlockToText).join("");
            const isOutside =
                (typeof update.messageId === "string" && update.messageId.startsWith("outside-")) ||
                thoughtPlurnk?.op === "outside-" ||
                thoughtPlurnk?.outside !== undefined;
            if (isOutside) {
                this.#retireReasoning(frames);
                this.#loopConcluded = false;
                frames.push({
                    kind: "reply_chunk",
                    messageId: update.messageId,
                    text: deltaText,
                    op: "outside-",
                    status: typeof thoughtPlurnk?.status === "number" ? thoughtPlurnk.status : 200,
                    aside: null,
                });
                return frames;
            }
            if (SessionUpdate.isAgentThought(update)) {
                this.#reasoningBuffer = deltaText;
            } else {
                this.#reasoningBuffer += deltaText;
            }
            const allLines = this.#reasoningBuffer.split(/\r?\n/u).filter((l) => l.length > 0);
            this.#reasoningLines = allLines.slice(-this.maxReasoningLines);
            frames.push({
                kind: "reasoning_tail",
                lines: [...this.#reasoningLines],
                deltaText,
            });
            return frames;
        }

        if (SessionUpdate.isPlanUpdate(update) || SessionUpdate.isPlanRemoved(update)) {
            return frames;
        }

        if (SessionUpdate.isToolCallUpdate(update)) {
            const incomingMetaPlurnk = (
                update._meta as
                    | {
                          plurnk?: {
                              id?: number;
                              op?: string;
                              origin?: string;
                              status?: number;
                              attrs?: {
                                  aside?: string;
                                  kind?: string;
                                  stream?: string;
                                  distilled?: string;
                              };
                          };
                      }
                    | undefined
            )?.plurnk;
            const prior = this.#pendingToolCalls.get(update.toolCallId);
            if (
                this.#renderedToolCalls.has(update.toolCallId) &&
                update.status !== "in_progress" &&
                update.status !== "pending"
            ) {
                return frames;
            }
            const metaPlurnk = {
                ...(prior?.metaPlurnk ?? {}),
                ...(incomingMetaPlurnk ?? {}),
            } as {
                id?: number;
                op?: string;
                origin?: string;
                status?: number;
                loopSeq?: number;
                turnSeq?: number;
                attrs?: {
                    aside?: string;
                    kind?: string;
                    stream?: string;
                    session?: string;
                    to?: string;
                    waiting?: number;
                    distilled?: string;
                };
            };
            const toolCoord = extractCoordinateSeqs(update.toolCallId);
            this.#syncLoopAndTurn(
                metaPlurnk.loopSeq ?? toolCoord.loopSeq,
                metaPlurnk.turnSeq ?? toolCoord.turnSeq,
            );
            const incomingRawInput =
                update.rawInput && typeof update.rawInput === "object"
                    ? (update.rawInput as Record<string, unknown>)
                    : undefined;
            const rawInput = incomingRawInput ?? prior?.rawInput;
            const rawOutput =
                update.rawOutput && typeof update.rawOutput === "object"
                    ? (update.rawOutput as Record<string, unknown>)
                    : undefined;
            const effectiveName = update.name ?? prior?.name;
            const effectiveTitle = update.title ?? prior?.title;
            const effectiveLocations = update.locations ?? prior?.locations;
            const opName =
                metaPlurnk.op ?? effectiveName ?? effectiveTitle?.split(/[\s(—]/u)[0] ?? "tool";
            const origin = metaPlurnk.origin ?? "model";

            const incomingTerminalIds = (update.content ?? [])
                .filter(
                    (c): c is { readonly type: "terminal"; readonly terminalId: string } =>
                        c.type === "terminal" && typeof (c as { terminalId?: unknown }).terminalId === "string",
                )
                .map((c) => c.terminalId);
            const terminalIds =
                incomingTerminalIds.length > 0
                    ? incomingTerminalIds
                    : prior?.terminalIds && prior.terminalIds.length > 0
                      ? prior.terminalIds
                      : typeof metaPlurnk.id === "number"
                        ? [`term:${String(metaPlurnk.id)}`]
                        : [];

            const authoredTarget =
                opName === "copy" || opName === "move"
                    ? extractRawString(rawInput?.source)
                    : extractRawString(rawInput?.target);
            const attrSessionTarget =
                typeof metaPlurnk.attrs?.session === "string" && metaPlurnk.attrs.session.length > 0
                    ? metaPlurnk.attrs.session.includes("://")
                        ? metaPlurnk.attrs.session
                        : `session://${metaPlurnk.attrs.session}`
                    : typeof metaPlurnk.attrs?.to === "string" && metaPlurnk.attrs.to.length > 0
                      ? metaPlurnk.attrs.to
                      : null;
            const target =
                authoredTarget ??
                effectiveLocations?.[0]?.path ??
                attrSessionTarget ??
                extractTitleTarget(effectiveTitle);

            // Suppress internal _plurnk emission announcements, entry materializations,
            // and synthesized kill distillation notes ({§cli-rendering}).
            if (
                metaPlurnk.origin === "_plurnk" &&
                opName === "read" &&
                (metaPlurnk.attrs?.kind === "emission" ||
                    (typeof target === "string" && target.startsWith("ops://")))
            ) {
                return frames;
            }
            if (
                metaPlurnk.origin === "_plurnk" &&
                opName === "edit" &&
                metaPlurnk.attrs?.kind === "entry_materialized"
            ) {
                return frames;
            }
            if (
                opName === "note" &&
                typeof metaPlurnk.attrs?.distilled === "string" &&
                metaPlurnk.attrs.distilled.trim().length > 0
            ) {
                return frames;
            }

            this.#retireReasoning(frames);

            const streamTarget =
                typeof metaPlurnk.attrs?.stream === "string" && metaPlurnk.attrs.stream.length > 0
                    ? metaPlurnk.attrs.stream
                    : target ?? update.toolCallId;
            const entryId = typeof metaPlurnk.id === "number" ? metaPlurnk.id : null;
            const concludedStreamCode =
                (typeof metaPlurnk.attrs?.stream === "string" && metaPlurnk.attrs.stream > ""
                    ? this.#concludedStreams.get(metaPlurnk.attrs.stream)
                    : undefined) ??
                (entryId !== null ? this.#concludedStreams.get(`term:${String(entryId)}`) : undefined) ??
                terminalIds.map((id) => this.#concludedStreams.get(id)).find((code) => code !== undefined);
            const effectiveStatus =
                (update.status === "in_progress" || update.status === "pending") &&
                concludedStreamCode !== undefined
                    ? concludedStreamCode >= 400
                        ? "failed"
                        : "completed"
                    : update.status;

            if (effectiveStatus === "in_progress" || effectiveStatus === "pending") {
                this.#pendingToolCalls.set(update.toolCallId, {
                    ...(effectiveName !== undefined ? { name: effectiveName } : {}),
                    ...(effectiveTitle !== undefined ? { title: effectiveTitle } : {}),
                    ...(effectiveLocations !== undefined ? { locations: effectiveLocations } : {}),
                    ...(rawInput !== undefined ? { rawInput } : {}),
                    metaPlurnk: metaPlurnk as Record<string, unknown>,
                    ...(terminalIds.length > 0 ? { terminalIds } : {}),
                });
                // {§cli-rendering}, {§cli-session-status} — Only open runtime streams (never synchronous verbs in OPERATION_GLYPH_MAP)
                // enter #activeStreams while in_progress.
                if (effectiveStatus === "in_progress" && !(opName.toLowerCase() in OPERATION_GLYPH_MAP)) {
                    const existing =
                        this.#activeStreams.get(update.toolCallId) ??
                        [...this.#activeStreams.values()].find(
                            (st) =>
                                st.target === streamTarget ||
                                (entryId !== null && st.entryId === entryId),
                        );
                    if (existing !== undefined && existing.key !== update.toolCallId) {
                        this.#activeStreams.delete(existing.key);
                    }
                    const openedTurn =
                        typeof metaPlurnk.turnSeq === "number" && metaPlurnk.turnSeq > 0
                            ? metaPlurnk.turnSeq
                            : Math.max(1, this.turns);
                    this.#activeStreams.set(update.toolCallId, {
                        key: update.toolCallId,
                        entryId: entryId ?? existing?.entryId ?? null,
                        terminalIds: terminalIds.length > 0 ? terminalIds : (existing?.terminalIds ?? []),
                        op: opName,
                        target: streamTarget,
                        startedAt: existing?.startedAt ?? Date.now(),
                        openedTurn: existing?.openedTurn ?? openedTurn,
                        survivedTurn:
                            existing?.survivedTurn ??
                            (this.#replayingHistory || this.turns > openedTurn),
                    });
                }
                if (opName === "wait") {
                    this.doing = null;
                } else if (this.lifecycle === "running") {
                    this.doing = {
                        phase: "working",
                        since: Date.now(),
                        op: opName,
                        target,
                    };
                }
                if (this.lifecycle === "running" || opName === "wait") {
                    frames.push({
                        kind: "status_update",
                        status: this.buildStatusBar(),
                    });
                }
                return frames;
            }
            this.#pendingToolCalls.delete(update.toolCallId);
            this.#renderedToolCalls.add(update.toolCallId);
            this.#activeStreams.delete(update.toolCallId);
            if (typeof metaPlurnk.attrs?.stream === "string" && metaPlurnk.attrs.stream.length > 0) {
                for (const [k, st] of [...this.#activeStreams.entries()]) {
                    if (st.target === metaPlurnk.attrs.stream) {
                        this.#activeStreams.delete(k);
                    }
                }
            }

            const problemRec =
                rawOutput?.problem && typeof rawOutput.problem === "object"
                    ? (rawOutput.problem as {
                          type?: unknown;
                          detail?: unknown;
                          title?: unknown;
                          diagnostic?: unknown;
                      })
                    : undefined;

            // Over-budget curation moment ({§cli-rendering}): render as `📌 — curating context`.
            if (
                (opName === "error" || opName === "fail") &&
                problemRec?.type === "https://problems.plurnk.xyz/engine/context/packet-exceeds-budget"
            ) {
                frames.push({
                    kind: "tool_call",
                    toolCallId: update.toolCallId,
                    glyph: "📌",
                    op: "info",
                    origin,
                    title: "info — curating context",
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
                return frames;
            }

            const rawAside =
                typeof rawInput?.aside === "string" && rawInput.aside.trim().length > 0
                    ? rawInput.aside.trim()
                    : typeof rawInput?.comment === "string" && rawInput.comment.trim().length > 0
                      ? rawInput.comment.trim()
                      : typeof metaPlurnk.attrs?.aside === "string" && metaPlurnk.attrs.aside.trim().length > 0
                        ? metaPlurnk.attrs.aside.trim()
                        : extractTitleAside(effectiveTitle);
            const glyph = operationGlyphFor(opName);
            const aside = rawAside;
            const scope = extractScopeToken(rawInput?.lineMarker);
            const destination =
                opName === "copy" || opName === "move"
                    ? extractRawString(rawInput?.destination)
                    : null;
            const pattern =
                extractRawString(rawInput?.matcher) ?? extractRawString(rawInput?.pattern);
            const fields = extractToolFields(opName, rawInput);
            const count = receiptCountFor(opName, rawOutput);

            const receiptLines: string[] = [];
            const textReceiptLines: string[] = [];
            for (const c of update.content ?? []) {
                if (ToolCallContent.isContent(c)) {
                    const txt = contentBlockToText(c.content);
                    receiptLines.push(txt);
                    if (!ContentBlock.isResourceLink(c.content)) {
                        textReceiptLines.push(txt);
                    }
                } else if (ToolCallContent.isDiff(c) && typeof c.patch?.text === "string") {
                    receiptLines.push(c.patch.text);
                } else if (ToolCallContent.isSession(c)) {
                    receiptLines.push(`[session] ${c.sessionId}`);
                }
            }

            const authoredBody = extractRawString(rawInput?.body);
            let noteBody: string | null = null;
            if (opName === "note") {
                if (authoredBody !== null) {
                    noteBody = authoredBody;
                } else if (textReceiptLines.length > 0) {
                    noteBody = textReceiptLines.join("\n");
                } else if (receiptLines.length > 0) {
                    noteBody = receiptLines.join("\n");
                } else {
                    noteBody = "";
                }
            }

            // Authored request bodies (edit, work, fork, kill, and undelivered send)
            // receive a preview beneath the row ({§cli-rendering}). Runtime executions render as
            // single-line receipts without request-body or stream-output previews.
            const isRuntimeExec = !(opName in OPERATION_GLYPH_MAP);
            const previewBody =
                authoredBody ?? (textReceiptLines.length > 0 ? textReceiptLines.join("\n") : null);
            const contentLines: string[] = [];
            if (
                !isRuntimeExec &&
                !NO_PREVIEW_VERBS.has(opName) &&
                previewBody !== null &&
                previewBody.trim().length > 0
            ) {
                contentLines.push(previewBody);
            }

            const outputLines: string[] = [];

            const statusCode =
                typeof metaPlurnk.status === "number" &&
                (concludedStreamCode === undefined || metaPlurnk.status !== 202)
                    ? metaPlurnk.status
                    : concludedStreamCode !== undefined
                      ? concludedStreamCode
                      : effectiveStatus === "failed"
                        ? 500
                        : 200;
            const failed = statusCode >= 400 || effectiveStatus === "failed";
            const problemTitle =
                typeof problemRec?.title === "string" && problemRec.title.length > 0
                    ? problemRec.title
                    : typeof problemRec?.detail === "string" && problemRec.detail.length > 0
                      ? problemRec.detail
                      : null;
            const problemDiagnostic =
                typeof problemRec?.diagnostic === "string" &&
                problemRec.diagnostic.trim().length > 0 &&
                problemRec.diagnostic.trim() !== problemTitle
                    ? problemRec.diagnostic.trim()
                    : null;
            const outcome = failed
                ? problemTitle !== null
                    ? problemDiagnostic !== null
                        ? `${problemTitle}: ${problemDiagnostic}`
                        : problemTitle
                    : typeof rawOutput?.detail === "string" && rawOutput.detail.length > 0
                      ? rawOutput.detail
                      : typeof rawOutput?.message === "string" && rawOutput.message.length > 0
                        ? rawOutput.message
                        : String(statusCode)
                : statusCode === 204 &&
                    count === null &&
                    typeof rawOutput?.detail === "string" &&
                    rawOutput.detail.length > 0
                  ? rawOutput.detail
                  : opName === "wait"
                    ? typeof rawOutput?.detail === "string" && rawOutput.detail.length > 0
                        ? rawOutput.detail
                        : typeof metaPlurnk.attrs?.waiting === "number"
                          ? `${String(metaPlurnk.attrs.waiting)}s`
                          : typeof rawInput?.seconds === "number"
                            ? `${String(rawInput.seconds)}s`
                            : null
                    : null;

            if (
                !this.#replayingHistory &&
                WORKER_OPS.has(opName) &&
                !failed
            ) {
                const rawWorkerRef =
                    target ??
                    (typeof metaPlurnk.attrs?.session === "string" && metaPlurnk.attrs.session.length > 0
                        ? metaPlurnk.attrs.session
                        : update.toolCallId);
                const workerKey = normalizeWorkerKey(rawWorkerRef);
                const existing = this.#activeWorkers.get(workerKey);
                this.#activeWorkers.set(workerKey, {
                    key: workerKey,
                    glyph: OPERATION_GLYPH_MAP[opName] ?? "🐜",
                    op: opName,
                    target: target ?? existing?.target ?? `session:///${workerKey}`,
                    startedAt: existing?.startedAt ?? Date.now(),
                });
            }

            if (opName === "wait") {
                this.doing = null;
                this.buildStatusBar();
            } else if (this.lifecycle === "running") {
                this.doing = {
                    phase: "working",
                    since: Date.now(),
                    op: opName,
                    target,
                };
                this.buildStatusBar();
            }

            frames.push({
                kind: "tool_call",
                toolCallId: update.toolCallId,
                glyph,
                op: opName,
                origin,
                title: effectiveTitle ?? effectiveName ?? update.toolCallId,
                target,
                scope,
                destination,
                pattern,
                fields,
                count,
                aside,
                noteBody,
                status: effectiveStatus ?? "completed",
                statusCode,
                outcome,
                contentLines,
                outputLines,
            });
            return frames;
        }

        if (SessionUpdate.isTerminalUpdate(update)) {
            if (update.exitStatus !== undefined) {
                const metaPlurnk = (
                    update._meta as { plurnk?: { target?: string; opId?: number } } | undefined
                )?.plurnk;
                const concludedTarget = metaPlurnk?.target;
                const opId = metaPlurnk?.opId;
                const exitCode = update.exitStatus?.exitCode;
                const concludedCode =
                    typeof exitCode === "number"
                        ? exitCode === 0
                            ? 200
                            : exitCode >= 400
                              ? exitCode
                              : 500
                        : (update as { status?: unknown }).status === "failed"
                          ? 500
                          : 200;
                this.#concludedStreams.set(update.terminalId, concludedCode);
                if (typeof opId === "number") {
                    this.#concludedStreams.set(`term:${String(opId)}`, concludedCode);
                }
                if (typeof concludedTarget === "string" && concludedTarget.length > 0) {
                    this.#concludedStreams.set(concludedTarget, concludedCode);
                    this.#openStreamKeys.delete(concludedTarget);
                }
                for (const [k, st] of [...this.#activeStreams.entries()]) {
                    if (
                        st.terminalIds.includes(update.terminalId) ||
                        (st.entryId !== null && `term:${String(st.entryId)}` === update.terminalId) ||
                        (typeof opId === "number" && st.entryId === opId) ||
                        (typeof concludedTarget === "string" &&
                            concludedTarget.length > 0 &&
                            st.target === concludedTarget)
                    ) {
                        this.#activeStreams.delete(k);
                    }
                }
            }
            return frames;
        }

        if (SessionUpdate.isTerminalOutputChunk(update)) {
            const metaPlurnk = (update._meta as { plurnk?: { target?: string; opId?: number } } | undefined)?.plurnk;
            const target = metaPlurnk?.target ?? update.terminalId;
            this.#lastStreamTarget = target;
            let decodedText = update.data;
            try {
                decodedText = Buffer.from(update.data, "base64").toString("utf8");
            } catch {
                decodedText = update.data;
            }
            frames.push({
                kind: "terminal_output",
                terminalId: update.terminalId,
                target,
                rawData: update.data,
                decodedText,
            });
            return frames;
        }

        if (SessionUpdate.isSubagentUpdate(update)) {
            const subState =
                update.state && typeof update.state === "object" && "state" in update.state
                    ? String(update.state.state)
                    : "running";
            const workerKey = normalizeWorkerKey(update.title ?? update.sessionId);
            if (
                subState === "running" ||
                subState === "queued" ||
                subState === "parked" ||
                subState === "requires_action"
            ) {
                const existing = this.#activeWorkers.get(workerKey);
                this.#activeWorkers.set(workerKey, {
                    key: workerKey,
                    glyph: existing?.glyph ?? "🐜",
                    op: existing?.op ?? "work",
                    target: existing?.target ?? `session:///${workerKey}`,
                    startedAt: existing?.startedAt ?? Date.now(),
                });
            } else {
                this.#activeWorkers.delete(workerKey);
            }
            frames.push({
                kind: "subagent",
                sessionId: update.sessionId,
                title: update.title ?? update.sessionId,
                state: subState,
                description: update.description,
            });
            return frames;
        }

        if (SessionUpdate.isSessionMessage(update) || SessionUpdate.isSessionMessageChunk(update)) {
            const text = SessionUpdate.isSessionMessageChunk(update)
                ? contentBlockToText(update.content)
                : (update.content ?? []).map(contentBlockToText).join("\n");
            frames.push({
                kind: "session_message",
                messageId: update.messageId,
                senderSessionId: SessionUpdate.isSessionMessage(update) ? (update.senderSessionId ?? "") : "",
                recipientSessionId: SessionUpdate.isSessionMessage(update) ? (update.recipientSessionId ?? "") : "",
                text,
            });
            return frames;
        }

        if (SessionUpdate.isUserMessageChunk(update) || SessionUpdate.isUserMessage(update)) {
            const published = (update._meta as { plurnk?: { published?: boolean } } | undefined)?.plurnk?.published;
            if (published !== false && this.inboxCount > 0) {
                this.inboxCount = Math.max(0, this.inboxCount - 1);
                frames.push({ kind: "status_update", status: this.buildStatusBar(), newTurn: false });
            }
            return frames;
        }

        if (SessionUpdate.isAgentMessageChunk(update) || SessionUpdate.isAgentMessage(update)) {
            this.#retireReasoning(frames);
            const metaPlurnk = (
                update._meta as
                    | {
                          plurnk?: {
                              op?: string;
                              status?: number;
                              loopSeq?: number;
                              turnSeq?: number;
                              voice?: string;
                              source?: string;
                              address?: string;
                              target?: string;
                              attrs?: { aside?: string };
                              receipt?: {
                                  repliedTo?: readonly string[];
                                  repliedToSources?: readonly string[];
                              };
                              outside?: unknown;
                          };
                      }
                    | undefined
            )?.plurnk;
            const msgCoord = extractCoordinateSeqs(update.messageId);
            this.#syncLoopAndTurn(
                metaPlurnk?.loopSeq ?? msgCoord.loopSeq,
                metaPlurnk?.turnSeq ?? msgCoord.turnSeq,
            );
            this.#loopConcluded = false;
            const text = SessionUpdate.isAgentMessageChunk(update)
                ? contentBlockToText(update.content)
                : (update.content ?? []).map(contentBlockToText).join("");
            const isOutside =
                (typeof update.messageId === "string" && update.messageId.startsWith("outside-")) ||
                metaPlurnk?.op === "outside-" ||
                metaPlurnk?.outside !== undefined;
            const effectiveOp = isOutside ? "outside-" : (metaPlurnk?.op ?? "send");
            const voice = isOutside || effectiveOp === "wait" ? null : extractMessageVoice(metaPlurnk);
            if (effectiveOp === "wait") {
                this.doing = null;
                this.buildStatusBar();
            }
            frames.push({
                kind: "reply_chunk",
                messageId: update.messageId,
                text,
                op: effectiveOp,
                status: typeof metaPlurnk?.status === "number" ? metaPlurnk.status : 200,
                aside: metaPlurnk?.attrs?.aside ?? null,
                ...(voice !== null ? { voice } : {}),
            });
            return frames;
        }

        if (SessionUpdate.isNotice(update)) {
            // Route workspace state/preparation, engine turn progress, loop status, and search progress
            // to the right of the status line instead of the waterfall ({§cli-session-status}, {§cli-rendering}).
            if (update.title === "workspace:state" || update.title === "workspace:preparation") {
                this.ingestMeta(update._meta as MetaRecord | undefined);
                this.#flushPendingHistoryLost(frames);
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                });
                return frames;
            }

            if (this.#applyEngineNoticeMeta(update._meta, frames, update.title)) {
                return frames;
            }

            const plurnkMeta = (
                update._meta as
                    | { plurnk?: { notice?: Record<string, unknown>; problem?: Record<string, unknown> } }
                    | undefined
            )?.plurnk;

            if (plurnkMeta?.problem !== undefined) {
                this.disconnected = true;
                this.lifecycle = "idle";
                this.doing = null;
                this.buildStatusBar();
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
            const formatted = `${noticeGlyph} ${noticeText}`;
            frames.push({
                kind: "notice",
                severity: update.severity,
                title: update.title,
                description: update.description,
                formatted,
            });
            return frames;
        }

        if (SessionUpdate.isStateUpdate(update)) {
            this.disconnected = false;
            const priorBaseInputTokens = this.#turnBaseInputTokens;
            const priorBaseOutputTokens = this.#turnBaseOutputTokens;
            const priorBaseCostUsd = this.#turnBaseCostUsd;
            this.ingestMeta(update._meta as MetaRecord | undefined);
            if (this.#applyEngineNoticeMeta(update._meta, frames)) {
                return frames;
            }
            const metaLifecycle = (
                update._meta as { plurnk?: { status?: { lifecycle?: unknown } } } | undefined
            )?.plurnk?.status?.lifecycle;
            if (update.state === "running") {
                if (this.#loopConcluded) {
                    this.#resetLoopTurns();
                }
                this.lastLoopStatus = null;
                if (this.turns === 0) {
                    this.turns = 1;
                }
                if (metaLifecycle === "parked") {
                    this.lifecycle = "parked";
                    this.lifecycleGlyph = "💤";
                    this.doing = null;
                } else {
                    this.lifecycle = "running";
                    this.lifecycleGlyph = "⌛︎";
                    if (this.doing === null) {
                        this.doing = { phase: "working", since: Date.now(), op: null, target: null };
                    }
                }
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                });
                return frames;
            }
            if (update.state === "requires_action") {
                this.#retireReasoning(frames);
                this.lastLoopStatus = null;
                this.lifecycle = "requires_action";
                this.lifecycleGlyph = "💤";
                this.doing = null;
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                });
                return frames;
            }
            if (update.state === "idle") {
                this.#retireReasoning(frames);
                this.#lastStreamTarget = "";
                this.doing = null;
                this.activity = null;
                this.waitUntil = null;
                this.inboxCount = 0;
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
                if (termMeta === undefined && (this.#loopConcluded || (this.lifecycle === "idle" && this.turns === 0))) {
                    frames.push({
                        kind: "status_update",
                        status: this.buildStatusBar(),
                    });
                    return frames;
                }
                const status =
                    typeof termMeta?.status === "number"
                        ? termMeta.status
                        : update.stopReason === "error" || update.stopReason === "refusal"
                          ? 500
                          : update.stopReason === "cancelled"
                            ? 499
                            : 200;
                this.lastLoopStatus = status;
                this.lifecycle = status >= 400 ? (status === 499 ? "cancelled" : "failed") : "idle";
                // {§cli-session-status} {§cli-rendering} — Only abort in-flight calls when the loop
                // terminates with failure/cancellation (status >= 400). On 200/202, open streams
                // hold their historical launch row until stream/concluded arrives.
                if (status >= 400) {
                    this.#activeStreams.clear();
                    for (const [pendingId] of [...this.#pendingToolCalls.entries()]) {
                        const flushed = this.apply({
                            sessionUpdate: "tool_call_update",
                            toolCallId: pendingId,
                            status: "failed",
                            _meta: {
                                plurnk: {
                                    status,
                                },
                            },
                        });
                        for (const f of flushed) {
                            if (f.kind === "tool_call") {
                                frames.push(f);
                            }
                        }
                    }
                } else {
                    this.#promoteSurvivingStreams(this.turns, true);
                }
                if (this.activeChildren === 0) {
                    this.#activeWorkers.clear();
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
                        this.inputTokens = Math.max(this.inputTokens, priorBaseInputTokens + loopIn);
                    }
                    if (loopOut !== undefined) {
                        this.outputTokens = Math.max(this.outputTokens, priorBaseOutputTokens + loopOut);
                    }
                    if (typeof costStr === "string") {
                        const candidateCost = addDecimal(priorBaseCostUsd, costStr);
                        if (this.costUsd === null || Number(candidateCost) >= Number(this.costUsd)) {
                            this.costUsd = candidateCost;
                        }
                    }
                    if (
                        acc !== undefined &&
                        acc.costUsd === null &&
                        (typeof acc.knownCostUsd === "string" ||
                            (typeof acc.requests === "number" && acc.requests > 0))
                    ) {
                        this.hasUnknownCost = true;
                    }
                }
                if (typeof termMeta?.usage?.curationBudget === "number" && termMeta.usage.curationBudget > 0) {
                    this.curationBudget = termMeta.usage.curationBudget;
                    if (typeof termMeta?.usage?.curationWeight === "number") {
                        this.curationWeight = termMeta.usage.curationWeight;
                    }
                }
                if (typeof termMeta?.usage?.contextTokens === "number") {
                    this.contextTokens = termMeta.usage.contextTokens;
                }
                if (typeof termMeta?.usage?.contextCapacity === "number") {
                    this.contextCapacity = termMeta.usage.contextCapacity;
                }
                const elapsedMs = Math.max(1, Date.now() - this.#turnStartedAt);
                const statusBar = this.buildStatusBar(elapsedMs, status);
                const rawTurns = termMeta?.turnCount;
                const turns = typeof rawTurns === "number" && rawTurns >= 0 ? rawTurns : Math.max(1, this.turns);
                this.turns = turns;
                this.#loopConcluded = true;
                const hitMaxTurns = update.stopReason === "max_turn_requests" || status === 429;
                const terminalDetail =
                    typeof termMeta?.problem?.detail === "string" && termMeta.problem.detail.length > 0
                        ? termMeta.problem.detail
                        : undefined;
                const effectiveLoopIn = loopIn ?? Math.max(0, this.inputTokens - priorBaseInputTokens);
                const effectiveLoopOut = loopOut ?? Math.max(0, this.outputTokens - priorBaseOutputTokens);
                const effectiveLoopCost =
                    typeof costStr === "string"
                        ? costStr
                        : this.#loopCostUsd ?? (hasAuthoritativeSpend ? null : this.costUsd);
                this.#turnBaseInputTokens = this.inputTokens;
                this.#turnBaseOutputTokens = this.outputTokens;
                this.#turnBaseCostUsd = this.costUsd;
                this.#loopCostUsd = null;
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
        }

        return frames;
    }
}
