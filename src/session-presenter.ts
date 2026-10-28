// Unified ACP v2 SessionPresenter pipeline ({§cli-rendering}, {§cli-session-status}, {§cli-markdown-projection}, {§cli-workspaces-and-sessions}).
// Single state machine between AcpSession and any rendering viewport (CLI stdout/stderr or pi-tui)
// so that TUI is a pure perspective of the CLI and never makes an independent presentation decision.

import {
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
    extractRawString,
    extractScopeToken,
    extractTitleAside,
    extractTitleTarget,
    formatDuration,
    formatLiveWait,
    formatModelRoute,
    formatUsdSpend,
    lifecycleGlyphFor,
    NO_PREVIEW_VERBS,
    normalizeNoteHeading,
    OPERATION_GLYPH_MAP,
    operationGlyphFor,
    receiptCountFor,
    SCRIPT_RUNTIMES,
    spanLength,
} from "./presenter-formatters.ts";

export {
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
    NO_PREVIEW_VERBS,
    normalizeNoteHeading,
    OPERATION_GLYPH_MAP,
    operationGlyphFor,
    receiptCountFor,
    SCRIPT_RUNTIMES,
    spanLength,
};

export interface WorkerDoing {
    readonly phase: "awaiting" | "working";
    readonly since: number;
    readonly op: string | null;
    readonly target: string | null;
}

export interface WorkspacePreparationState {
    readonly state?: string;
    readonly phase?: string;
    readonly percent?: number;
}

export interface SearchActivityState {
    readonly phase: string;
    readonly percent?: number;
}

export interface StatusBarModel {
    readonly workspaceName: string;
    readonly sessionName: string;
    readonly projectLabel: string | null;
    readonly lifecycle: string;
    readonly lifecycleGlyph: string;
    readonly yolo: boolean;
    readonly model: string;
    readonly effort: string | null;
    readonly loopSeq: number | null;
    readonly waitUntil: number | null;
    readonly curationWeight: number;
    readonly curationBudget: number;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
    readonly budgetPercent: number | null;
    readonly activeChildren: number;
    readonly gatedCount: number;
    readonly inboxCount: number;
    readonly openStreams: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: string | null;
    readonly formattedStatusLine: string;
}

export type PresentationFrame =
    | {
          readonly kind: "reasoning_tail";
          readonly lines: readonly string[];
          readonly deltaText: string;
      }
    | {
          readonly kind: "reasoning_retired";
      }
    | {
          readonly kind: "tool_call";
          readonly toolCallId: string;
          readonly glyph: string;
          readonly op: string;
          readonly origin: string;
          readonly title: string;
          readonly target: string | null;
          readonly scope: string | null;
          readonly destination: string | null;
          readonly pattern: string | null;
          readonly count: number | null;
          readonly aside: string | null;
          readonly noteBody: string | null;
          readonly status: string;
          readonly statusCode: number;
          readonly outcome: string | null;
          readonly contentLines: readonly string[];
          readonly outputLines: readonly string[];
      }
    | {
          readonly kind: "terminal_output";
          readonly terminalId: string;
          readonly target: string;
          readonly rawData: string;
          readonly decodedText: string;
      }
    | {
          readonly kind: "subagent";
          readonly sessionId: string;
          readonly title: string;
          readonly state: string;
          readonly description?: string | null;
      }
    | {
          readonly kind: "session_message";
          readonly messageId: string;
          readonly senderSessionId: string;
          readonly recipientSessionId: string;
          readonly text: string;
      }
    | {
          readonly kind: "reply_chunk";
          readonly messageId?: string | null;
          readonly text: string;
          readonly op: string;
          readonly status: number;
          readonly aside: string | null;
      }
    | {
          readonly kind: "notice";
          readonly severity: string;
          readonly title: string;
          readonly description?: string | null;
          readonly formatted: string;
      }
    | {
          readonly kind: "status_update";
          readonly status: StatusBarModel;
          readonly newTurn?: boolean;
      }
    | {
          readonly kind: "status_bar";
          readonly status: StatusBarModel;
          readonly statusCode: number;
          readonly elapsedMs: number;
          readonly hitMaxTurns: boolean;
          readonly terminalDetail?: string;
          readonly turns: number;
          readonly loopInputTokens?: number;
          readonly loopOutputTokens?: number;
          readonly loopCostUsd?: string | null;
      };

export interface SessionPresenterOptions {
    readonly workspaceName?: string;
    readonly sessionName?: string;
    readonly model?: string;
    readonly yolo?: boolean;
    readonly maxReasoningLines?: number;
    readonly initialMeta?: MetaRecord;
    readonly initialConfigOptions?: readonly SessionConfigOptionType[];
}

interface PendingToolCallState {
    readonly name?: string;
    readonly title?: string;
    readonly locations?: ReadonlyArray<{ readonly path: string }>;
    readonly rawInput?: Record<string, unknown>;
    readonly metaPlurnk?: Record<string, unknown>;
    readonly terminalIds?: readonly string[];
}

export class SessionPresenter {
    workspaceName: string;
    sessionName: string;
    projectLabel: string | null = null;
    lifecycle: string = "idle";
    lifecycleGlyph: string = "⏹️";
    yolo: boolean;
    model: string;
    effort: string | null = null;
    effortSource: "default" | "explicit" | null = null;
    supportedEfforts: readonly string[] = [];
    spawnModel: string | null = null;
    loopId: number | null = null;
    loopSeq: number | null = null;
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
    doing: WorkerDoing | null = null;
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
    readonly #pendingToolCalls = new Map<string, PendingToolCallState>();
    readonly #renderedToolCalls = new Set<string>();
    readonly #terminalOutputs = new Map<string, string>();
    readonly #bindingsWithLoops = new Set<string>();
    #pendingHistoryLost = false;

    constructor(options: SessionPresenterOptions = {}) {
        this.workspaceName = options.workspaceName ?? "default";
        this.sessionName = options.sessionName ?? "user";
        this.model = options.model ?? "default";
        this.yolo = options.yolo ?? true;
        this.maxReasoningLines = options.maxReasoningLines ?? 8;

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

    get reasoningLines(): readonly string[] {
        return this.#reasoningLines;
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

    markTurnStart(now = Date.now()): void {
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

        const status = plurnk.status as Record<string, unknown> | undefined;
        if (status) {
            const bindingKey = `${this.workspaceName}#${this.sessionName}`;
            if (typeof status.lifecycle === "string") {
                this.lifecycle = status.lifecycle;
            }
            if (typeof status.loopId === "number") {
                this.loopId = status.loopId;
                this.#bindingsWithLoops.add(bindingKey);
            } else if (status.loopId === null) {
                if (this.#bindingsWithLoops.has(bindingKey)) {
                    this.#bindingsWithLoops.delete(bindingKey);
                    this.#pendingHistoryLost = true;
                }
                this.loopId = null;
            }
            if (typeof status.loopSeq === "number") {
                this.loopSeq = status.loopSeq;
                this.#bindingsWithLoops.add(bindingKey);
            } else if (status.loopSeq === null) {
                if (!("loopId" in status) && this.#bindingsWithLoops.has(bindingKey)) {
                    this.#bindingsWithLoops.delete(bindingKey);
                    this.#pendingHistoryLost = true;
                }
                this.loopSeq = null;
            }
            if (typeof status.waitUntil === "number" || status.waitUntil === null) {
                this.waitUntil = status.waitUntil as number | null;
            }
            if (status.model && typeof status.model === "object") {
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
                    return rec.lifecycle === "running" || rec.lifecycle === "queued" || rec.lifecycle === "parked";
                }).length;
                this.gatedCount = status.descendants.reduce((acc: number, d) => {
                    const rec = d as Record<string, unknown>;
                    return acc + (typeof rec.gates === "number" ? rec.gates : 0);
                }, 0);
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
                if (cost !== null) this.costUsd = cost;
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
                this.yolo = opt.currentValue === "allow";
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
        const effectiveStatus = statusCodeOverride ?? this.lastLoopStatus ?? undefined;
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
        const baseParts: string[] = [lead, modelLabel, formatDuration(elapsedMs)];
        if (!(typeof effectiveStatus === "number" && effectiveStatus >= 400)) {
            baseParts.push(`↓${abbreviatedCount(this.inputTokens)} ↑${abbreviatedCount(this.outputTokens)}`);
            const usd = formatUsdSpend(this.costUsd);
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

    apply(update: SessionUpdate): PresentationFrame[] {
        const frames: PresentationFrame[] = [];

        if (SessionUpdate.isConfigOptionUpdate(update)) {
            this.#applyConfigOptions(update.configOptions, true);
            this.ingestMeta(update._meta as MetaRecord | undefined);
            this.#flushPendingHistoryLost(frames);
            return frames;
        }

        if (SessionUpdate.isUsageUpdate(update)) {
            this.ingestMeta(update._meta as MetaRecord | undefined);
            if (this.contextTokens === null && this.curationWeight === 0) {
                this.curationWeight = update.used;
            }
            if (this.contextCapacity === null && this.curationBudget === 0) {
                this.curationBudget = update.size;
            }
            this.#flushPendingHistoryLost(frames);
            return frames;
        }

        if (SessionUpdate.isAgentThoughtChunk(update)) {
            const deltaText = contentBlockToText(update.content);
            this.#reasoningBuffer += deltaText;
            const allLines = this.#reasoningBuffer.split(/\r?\n/u).filter((l) => l.length > 0);
            this.#reasoningLines = allLines.slice(-this.maxReasoningLines);
            frames.push({
                kind: "reasoning_tail",
                lines: [...this.#reasoningLines],
                deltaText,
            });
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
                              attrs?: { aside?: string; kind?: string; stream?: string };
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
                attrs?: { aside?: string; kind?: string; stream?: string };
            };
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
                opName === "COPY" || opName === "MOVE"
                    ? extractRawString(rawInput?.source)
                    : extractRawString(rawInput?.target);
            const target =
                authoredTarget ?? effectiveLocations?.[0]?.path ?? extractTitleTarget(effectiveTitle);

            // Suppress internal _plurnk emission announcements and entry materializations ({§cli-rendering}).
            if (
                metaPlurnk.origin === "_plurnk" &&
                opName === "READ" &&
                (metaPlurnk.attrs?.kind === "emission" ||
                    (typeof target === "string" && target.startsWith("ops://")))
            ) {
                return frames;
            }
            if (
                metaPlurnk.origin === "_plurnk" &&
                opName === "EDIT" &&
                metaPlurnk.attrs?.kind === "entry_materialized"
            ) {
                return frames;
            }

            this.#retireReasoning(frames);

            if (update.status === "in_progress" || update.status === "pending") {
                this.#pendingToolCalls.set(update.toolCallId, {
                    ...(effectiveName !== undefined ? { name: effectiveName } : {}),
                    ...(effectiveTitle !== undefined ? { title: effectiveTitle } : {}),
                    ...(effectiveLocations !== undefined ? { locations: effectiveLocations } : {}),
                    ...(rawInput !== undefined ? { rawInput } : {}),
                    metaPlurnk: metaPlurnk as Record<string, unknown>,
                    ...(terminalIds.length > 0 ? { terminalIds } : {}),
                });
                if (this.lifecycle === "running") {
                    this.doing = {
                        phase: "working",
                        since: Date.now(),
                        op: opName,
                        target,
                    };
                    frames.push({
                        kind: "status_update",
                        status: this.buildStatusBar(),
                    });
                }
                return frames;
            }
            this.#pendingToolCalls.delete(update.toolCallId);
            this.#renderedToolCalls.add(update.toolCallId);

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
                (opName === "error" || opName === "ERROR" || opName === "FAIL") &&
                problemRec?.type === "https://problems.plurnk.xyz/engine/context/packet-exceeds-budget"
            ) {
                frames.push({
                    kind: "tool_call",
                    toolCallId: update.toolCallId,
                    glyph: "📌",
                    op: "INFO",
                    origin,
                    title: "INFO — curating context",
                    target: null,
                    scope: null,
                    destination: null,
                    pattern: null,
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
            const { glyph, aside } = normalizeNoteHeading(opName, rawAside);
            const scope = extractScopeToken(rawInput?.lineMarker);
            const destination =
                opName === "COPY" || opName === "MOVE"
                    ? extractRawString(rawInput?.destination)
                    : null;
            const pattern =
                extractRawString(rawInput?.matcher) ?? extractRawString(rawInput?.pattern);
            const count = receiptCountFor(opName, rawOutput);

            const receiptLines: string[] = [];
            for (const c of update.content ?? []) {
                if (ToolCallContent.isContent(c)) {
                    receiptLines.push(contentBlockToText(c.content));
                } else if (ToolCallContent.isDiff(c) && typeof c.patch?.text === "string") {
                    receiptLines.push(c.patch.text);
                }
            }

            const authoredBody = extractRawString(rawInput?.body);
            let noteBody: string | null = null;
            if (opName === "NOTE") {
                if (authoredBody !== null) {
                    noteBody = authoredBody;
                } else if (receiptLines.length > 0) {
                    noteBody = receiptLines.join("\n");
                } else {
                    noteBody = "";
                }
            }

            // Authored request bodies (EDIT, WORK, FORK, undelivered SEND, script runtimes, harness NOTEs)
            // and concluded runtime execution stream outputs receive a preview beneath the row
            // ({§cli-rendering}). MCP tool request bodies are not shown.
            const isRuntimeExec = !(opName in OPERATION_GLYPH_MAP);
            const contentLines: string[] = [];
            if (opName === "NOTE" && origin !== "model" && noteBody !== null && noteBody.length > 0) {
                contentLines.push(noteBody);
            } else if (
                !NO_PREVIEW_VERBS.has(opName) &&
                (!isRuntimeExec || SCRIPT_RUNTIMES.has(opName)) &&
                authoredBody !== null
            ) {
                contentLines.push(authoredBody);
            }

            const outputLines: string[] = [];
            if (isRuntimeExec) {
                const streamed = terminalIds
                    .map((id) => this.#terminalOutputs.get(id) ?? "")
                    .join("")
                    .trimEnd();
                if (streamed.length > 0) {
                    outputLines.push(streamed);
                }
            }

            const statusCode =
                typeof metaPlurnk.status === "number"
                    ? metaPlurnk.status
                    : update.status === "failed"
                      ? 500
                      : 200;
            const failed = statusCode >= 400 || update.status === "failed";
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
                  : null;

            if (this.lifecycle === "running") {
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
                count,
                aside,
                noteBody,
                status: update.status ?? "completed",
                statusCode,
                outcome,
                contentLines,
                outputLines,
            });
            return frames;
        }

        if (SessionUpdate.isTerminalUpdate(update)) {
            if (update.output !== undefined) {
                const text =
                    update.output === null
                        ? ""
                        : Buffer.from(update.output.data, "base64").toString("utf8");
                this.#terminalOutputs.set(update.terminalId, text);
                const opId = (update._meta as { plurnk?: { opId?: number } } | undefined)?.plurnk?.opId;
                if (typeof opId === "number") {
                    this.#terminalOutputs.set(`term:${String(opId)}`, text);
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
            const nextText = (this.#terminalOutputs.get(update.terminalId) ?? "") + decodedText;
            this.#terminalOutputs.set(update.terminalId, nextText);
            if (typeof metaPlurnk?.opId === "number") {
                this.#terminalOutputs.set(`term:${String(metaPlurnk.opId)}`, nextText);
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
            frames.push({
                kind: "subagent",
                sessionId: update.sessionId,
                title: update.title ?? update.sessionId,
                state: subState,
                description: update.description,
            });
            return frames;
        }

        if (SessionUpdate.isSessionMessage(update)) {
            const text = (update.content ?? []).map(contentBlockToText).join("\n");
            frames.push({
                kind: "session_message",
                messageId: update.messageId,
                senderSessionId: update.senderSessionId ?? "",
                recipientSessionId: update.recipientSessionId ?? "",
                text,
            });
            return frames;
        }

        if (update.sessionUpdate === "user_message_chunk") {
            const published = (update._meta as { plurnk?: { published?: boolean } } | undefined)?.plurnk?.published;
            if (published !== false && this.inboxCount > 0) {
                this.inboxCount = Math.max(0, this.inboxCount - 1);
                frames.push({ kind: "status_update", status: this.buildStatusBar(), newTurn: false });
            }
            return frames;
        }

        if (SessionUpdate.isAgentMessageChunk(update)) {
            this.#retireReasoning(frames);
            const metaPlurnk = (
                update._meta as
                    | {
                          plurnk?: {
                              op?: string;
                              status?: number;
                              attrs?: { aside?: string };
                              outside?: unknown;
                          };
                      }
                    | undefined
            )?.plurnk;
            const text = contentBlockToText(update.content);
            const isOutside =
                (typeof update.messageId === "string" && update.messageId.startsWith("outside-")) ||
                metaPlurnk?.op === "outside-" ||
                metaPlurnk?.outside !== undefined;
            frames.push({
                kind: "reply_chunk",
                messageId: update.messageId,
                text,
                op: isOutside ? "outside-" : (metaPlurnk?.op ?? "SEND"),
                status: typeof metaPlurnk?.status === "number" ? metaPlurnk.status : 200,
                aside: metaPlurnk?.attrs?.aside ?? null,
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

            const plurnkMeta = (
                update._meta as
                    | { plurnk?: { notice?: Record<string, unknown>; problem?: Record<string, unknown> } }
                    | undefined
            )?.plurnk;
            const rawNotice = plurnkMeta?.notice;

            if (rawNotice?.source === "engine:turn" || update.title?.startsWith("engine:turn:")) {
                if (rawNotice?.kind === "turn_awaiting_model" || update.title === "engine:turn:turn_awaiting_model") {
                    this.lifecycle = "running";
                    this.doing = { phase: "awaiting", since: Date.now(), op: null, target: null };
                    frames.push({
                        kind: "status_update",
                        status: this.buildStatusBar(),
                        newTurn: true,
                    });
                    return frames;
                }
                if (rawNotice?.kind === "turn_generated" || update.title === "engine:turn:turn_generated") {
                    this.lifecycle = "running";
                    this.doing = { phase: "working", since: Date.now(), op: null, target: null };
                    const acc = rawNotice?.accounting as
                        | {
                              inputTokens?: number;
                              outputTokens?: number;
                              knownInputTokens?: number;
                              knownOutputTokens?: number;
                              usage?: { inputTokens?: number; outputTokens?: number };
                              knownUsage?: { inputTokens?: number; outputTokens?: number };
                              costUsd?: string;
                              knownCostUsd?: string;
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
                    }
                    frames.push({
                        kind: "status_update",
                        status: this.buildStatusBar(),
                    });
                    return frames;
                }
                if (rawNotice?.kind === "results_pending" || update.title === "engine:turn:results_pending") {
                    this.lifecycle = "running";
                    this.doing = { phase: "working", since: Date.now(), op: null, target: null };
                    frames.push({
                        kind: "status_update",
                        status: this.buildStatusBar(),
                    });
                    return frames;
                }
            }

            if (rawNotice?.kind === "loop_status") {
                if (typeof rawNotice.loopSeq === "number") {
                    this.loopSeq = rawNotice.loopSeq;
                    this.#bindingsWithLoops.add(`${this.workspaceName}#${this.sessionName}`);
                }
                if (rawNotice.status === 202) {
                    this.lifecycle = "parked";
                    this.doing = null;
                    this.waitUntil = typeof rawNotice.waitUntil === "number" ? rawNotice.waitUntil : null;
                    frames.push({
                        kind: "status_update",
                        status: this.buildStatusBar(),
                    });
                    return frames;
                }
                if (rawNotice.status === 100 || rawNotice.status === 102) {
                    this.waitUntil = null;
                    this.lifecycle = rawNotice.status === 102 ? "running" : "queued";
                    frames.push({
                        kind: "status_update",
                        status: this.buildStatusBar(),
                    });
                    return frames;
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
                return frames;
            }

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
            if (update.state === "running") {
                this.lifecycle = "running";
                this.lifecycleGlyph = "⌛︎";
                if (this.doing === null) {
                    this.doing = { phase: "working", since: Date.now(), op: null, target: null };
                }
                frames.push({
                    kind: "status_update",
                    status: this.buildStatusBar(),
                });
                return frames;
            }
            if (update.state === "requires_action") {
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
                                              usage?: { inputTokens?: number; outputTokens?: number };
                                              knownUsage?: { inputTokens?: number; outputTokens?: number };
                                              costUsd?: string;
                                              knownCostUsd?: string;
                                          };
                                      };
                                  };
                              };
                          }
                        | undefined
                )?.plurnk?.terminal;
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
                const usage = termMeta?.usage?.accounting?.usage ?? termMeta?.usage?.accounting?.knownUsage;
                const loopIn = typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;
                const loopOut = typeof usage?.outputTokens === "number" ? usage.outputTokens : undefined;
                if (loopIn !== undefined) this.inputTokens = this.#turnBaseInputTokens + loopIn;
                if (loopOut !== undefined) this.outputTokens = this.#turnBaseOutputTokens + loopOut;
                const costStr = termMeta?.usage?.accounting?.costUsd ?? termMeta?.usage?.accounting?.knownCostUsd;
                if (typeof costStr === "string") {
                    this.costUsd = addDecimal(this.#turnBaseCostUsd, costStr);
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
                const turns = typeof rawTurns === "number" && rawTurns >= 0 ? rawTurns : 1;
                const hitMaxTurns = update.stopReason === "max_turn_requests" || status === 429;
                const terminalDetail =
                    typeof termMeta?.problem?.detail === "string" && termMeta.problem.detail.length > 0
                        ? termMeta.problem.detail
                        : undefined;
                const effectiveLoopIn = loopIn ?? Math.max(0, this.inputTokens - this.#turnBaseInputTokens);
                const effectiveLoopOut = loopOut ?? Math.max(0, this.outputTokens - this.#turnBaseOutputTokens);
                const effectiveLoopCost = typeof costStr === "string" ? costStr : this.costUsd;
                this.#turnBaseInputTokens = this.inputTokens;
                this.#turnBaseOutputTokens = this.outputTokens;
                this.#turnBaseCostUsd = this.costUsd;
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
