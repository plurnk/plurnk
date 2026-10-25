// Unified ACP v2 SessionPresenter pipeline ({§cli-rendering}, {§cli-worker-status}, {§cli-provider-reasoning}).
// Single state machine between AcpSession and any rendering viewport (CLI stdout/stderr or pi-tui)
// so that TUI is a pure perspective of the CLI and never makes an independent presentation decision.

import {
    SessionConfigOption,
    SessionUpdate,
    ToolCallContent,
    type SessionConfigOption as SessionConfigOptionType,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { contentBlockToText, type MetaRecord } from "./acp-session.ts";

const OPERATION_GLYPH_MAP: Readonly<Record<string, string>> = {
    NOTE: "🗒️",
    FIND: "🔎",
    READ: "📖",
    EDIT: "📝",
    COPY: "🖨️",
    MOVE: "📦",
    KILL: "🗑️",
    WORK: "🐜",
    FORK: "🔱",
    BARE: "☁️",
    WAIT: "⏳",
    SEND: "✉️",
    WARN: "⚠️",
    FAIL: "⛔",
    ERROR: "⛔",
    INFO: "📌",
    FACT: "📊",
    IDEA: "💡",
    PLAN: "🚧",
};

export const operationGlyphFor = (op: string | undefined, aside?: string | null): string => {
    if (op === "NOTE" && typeof aside === "string") {
        const clean = aside.trim().toUpperCase();
        if (clean === "FACT" || clean === "IDEA" || clean === "PLAN") {
            return OPERATION_GLYPH_MAP[clean]!;
        }
    }
    if (typeof op === "string" && op in OPERATION_GLYPH_MAP) {
        return OPERATION_GLYPH_MAP[op]!;
    }
    if (typeof op === "string" && op.length > 0) {
        return `⚙️ ${op}`;
    }
    return "⚙️";
};

export const lifecycleGlyphFor = (lifecycle: string | undefined, status?: number): string => {
    if (typeof status === "number" && status >= 400) {
        return status === 499 ? "🛑" : "❌";
    }
    switch (lifecycle) {
        case "queued":
            return "⏳";
        case "running":
            return "⌛︎";
        case "parked":
        case "requires_action":
            return "💤";
        case "cancelled":
            return "🛑";
        case "failed":
        case "error":
            return "❌";
        default:
            return "⏹️";
    }
};

export interface StatusBarModel {
    readonly workspaceName: string;
    readonly workerName: string;
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
          readonly title: string;
          readonly status: string;
          readonly contentLines: readonly string[];
      }
    | {
          readonly kind: "terminal_output";
          readonly terminalId: string;
          readonly target: string;
          readonly rawData: string;
          readonly decodedText: string;
          readonly parkedWaitHint?: string;
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
          readonly parkedWaitHint?: string;
      }
    | {
          readonly kind: "notice";
          readonly severity: string;
          readonly title: string;
          readonly description?: string | null;
          readonly formatted: string;
      }
    | {
          readonly kind: "status_bar";
          readonly status: StatusBarModel;
          readonly terminalDetail?: string;
          readonly turns: number;
      };

export interface SessionPresenterOptions {
    readonly workspaceName?: string;
    readonly workerName?: string;
    readonly model?: string;
    readonly yolo?: boolean;
    readonly maxReasoningLines?: number;
    readonly initialMeta?: MetaRecord;
    readonly initialConfigOptions?: readonly SessionConfigOptionType[];
}

export class SessionPresenter {
    workspaceName: string;
    workerName: string;
    projectLabel: string | null = null;
    lifecycle: string = "idle";
    lifecycleGlyph: string = "⏹️";
    yolo: boolean;
    model: string;
    effort: string | null = null;
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
    lastStatusLine = "";

    readonly maxReasoningLines: number;
    #reasoningBuffer = "";
    #reasoningLines: string[] = [];
    #lastStreamTarget = "";
    #parkedInWait = false;
    #turnStartedAt = Date.now();

    constructor(options: SessionPresenterOptions = {}) {
        this.workspaceName = options.workspaceName ?? "default";
        this.workerName = options.workerName ?? "user";
        this.model = options.model ?? "default";
        this.yolo = options.yolo ?? true;
        this.maxReasoningLines = options.maxReasoningLines ?? 8;

        if (options.initialConfigOptions) {
            this.#applyConfigOptions(options.initialConfigOptions);
        }
        if (options.initialMeta) {
            this.ingestMeta(options.initialMeta);
        }
    }

    get reasoningLines(): readonly string[] {
        return this.#reasoningLines;
    }

    markTurnStart(now = Date.now()): void {
        this.#turnStartedAt = now;
        this.lifecycle = "running";
        this.lifecycleGlyph = "⌛︎";
    }

    ingestMeta(meta: MetaRecord | undefined): void {
        if (!meta) return;
        const plurnk = meta.plurnk as Record<string, unknown> | undefined;
        if (!plurnk) return;

        const ws = plurnk.workspace as Record<string, unknown> | undefined;
        if (typeof ws?.name === "string" && ws.name.length > 0) {
            this.workspaceName = ws.name;
        }
        if (typeof ws?.projectLabel === "string") {
            this.projectLabel = ws.projectLabel;
        }
        if (typeof plurnk.workerName === "string" && plurnk.workerName.length > 0) {
            this.workerName = plurnk.workerName;
        }

        const status = plurnk.status as Record<string, unknown> | undefined;
        if (status) {
            if (typeof status.lifecycle === "string") {
                this.lifecycle = status.lifecycle;
            }
            if (typeof status.loopSeq === "number") {
                this.loopSeq = status.loopSeq;
            }
            if (typeof status.waitUntil === "number" || status.waitUntil === null) {
                this.waitUntil = status.waitUntil as number | null;
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
                this.inboxCount = status.inbox.length;
            }
            if (Array.isArray(status.streams)) {
                this.openStreams = status.streams.length;
            }
            const spend = status.spend as Record<string, unknown> | undefined;
            if (spend) {
                const usage = spend.usage as Record<string, unknown> | undefined;
                if (typeof usage?.inputTokens === "number") this.inputTokens = usage.inputTokens;
                if (typeof usage?.outputTokens === "number") this.outputTokens = usage.outputTokens;
                if (typeof spend.costUsd === "string") this.costUsd = spend.costUsd;
            }
        }

        const budget = plurnk.budget as Record<string, unknown> | undefined;
        if (budget) {
            if (typeof budget.curationWeight === "number") this.curationWeight = budget.curationWeight;
            if (typeof budget.curationBudget === "number") this.curationBudget = budget.curationBudget;
            if (typeof budget.contextTokens === "number" || budget.contextTokens === null) {
                this.contextTokens = budget.contextTokens as number | null;
            }
            if (typeof budget.contextCapacity === "number" || budget.contextCapacity === null) {
                this.contextCapacity = budget.contextCapacity as number | null;
            }
        }
    }

    #applyConfigOptions(options: readonly SessionConfigOptionType[]): void {
        for (const opt of options) {
            if (opt.configId === "model" && SessionConfigOption.isSelect(opt) && opt.currentValue.length > 0) {
                this.model = opt.currentValue;
            } else if (opt.configId === "thought_level" && SessionConfigOption.isSelect(opt)) {
                this.effort = opt.currentValue;
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
        const glyph = lifecycleGlyphFor(this.lifecycle, statusCodeOverride);
        this.lifecycleGlyph = glyph;
        const elapsedMs = elapsedMsOverride ?? Math.max(1, Date.now() - this.#turnStartedAt);
        const used = this.contextTokens ?? this.curationWeight;
        const capacity = this.contextCapacity ?? this.curationBudget;
        const budgetPercent = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : null;

        const formattedStatusLine =
            typeof statusCodeOverride === "number" && statusCodeOverride >= 400
                ? `${glyph}  · 🎲 ${this.model} · ${elapsedMs}ms`
                : `${glyph}  · 🎲 ${this.model} · ${elapsedMs}ms · ↓${this.inputTokens} ↑${this.outputTokens}`;
        this.lastStatusLine = formattedStatusLine;

        return {
            workspaceName: this.workspaceName,
            workerName: this.workerName,
            projectLabel: this.projectLabel,
            lifecycle: this.lifecycle,
            lifecycleGlyph: glyph,
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

    apply(update: SessionUpdate): PresentationFrame[] {
        const frames: PresentationFrame[] = [];

        if (SessionUpdate.isConfigOptionUpdate(update)) {
            this.#applyConfigOptions(update.configOptions);
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
            this.#retireReasoning(frames);
            const metaPlurnk = (update._meta as { plurnk?: { op?: string; attrs?: { aside?: string } } } | undefined)?.plurnk;
            const opName = metaPlurnk?.op ?? update.title ?? update.name ?? undefined;
            const glyph = operationGlyphFor(opName, metaPlurnk?.attrs?.aside);
            const contentLines: string[] = [];
            for (const c of update.content ?? []) {
                if (ToolCallContent.isContent(c)) {
                    contentLines.push(contentBlockToText(c.content));
                }
            }
            frames.push({
                kind: "tool_call",
                toolCallId: update.toolCallId,
                glyph,
                title: update.title ?? update.name ?? update.toolCallId,
                status: update.status ?? "in_progress",
                contentLines,
            });
            return frames;
        }

        if (SessionUpdate.isTerminalOutputChunk(update)) {
            const metaPlurnk = (update._meta as { plurnk?: { target?: string } } | undefined)?.plurnk;
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
                ...(this.#parkedInWait && target.length > 0 ? { parkedWaitHint: `updates in ${target}` } : {}),
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

        if (SessionUpdate.isAgentMessageChunk(update)) {
            this.#retireReasoning(frames);
            const text = contentBlockToText(update.content);
            const metaOp = (update._meta as { plurnk?: { op?: string } } | undefined)?.plurnk?.op;
            let parkedWaitHint: string | undefined;
            if (metaOp === "WAIT") {
                this.#parkedInWait = true;
                if (this.#lastStreamTarget.length > 0) {
                    parkedWaitHint = `updates in ${this.#lastStreamTarget}`;
                }
            }
            frames.push({
                kind: "reply_chunk",
                messageId: update.messageId,
                text,
                ...(parkedWaitHint !== undefined ? { parkedWaitHint } : {}),
            });
            return frames;
        }

        if (SessionUpdate.isNotice(update)) {
            const formatted = `${update.title}${update.description ? `: ${update.description}` : ""}`;
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
            if (update.state === "running") {
                this.lifecycle = "running";
                this.lifecycleGlyph = "⌛︎";
                return frames;
            }
            if (update.state === "requires_action") {
                this.lifecycle = "requires_action";
                this.lifecycleGlyph = "💤";
                return frames;
            }
            if (update.state === "idle") {
                this.#retireReasoning(frames);
                this.#parkedInWait = false;
                this.#lastStreamTarget = "";
                const termMeta = (
                    update._meta as
                        | {
                              plurnk?: {
                                  terminal?: {
                                      status?: number;
                                      turns?: number;
                                      problem?: { detail?: string };
                                      usage?: {
                                          accounting?: {
                                              usage?: { inputTokens?: number; outputTokens?: number };
                                              costUsd?: string;
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
                this.lifecycle = status >= 400 ? (status === 499 ? "cancelled" : "failed") : "idle";
                const usage = termMeta?.usage?.accounting?.usage;
                if (typeof usage?.inputTokens === "number") this.inputTokens = usage.inputTokens;
                if (typeof usage?.outputTokens === "number") this.outputTokens = usage.outputTokens;
                if (typeof termMeta?.usage?.accounting?.costUsd === "string") {
                    this.costUsd = termMeta.usage.accounting.costUsd;
                }
                const elapsedMs = Math.max(1, Date.now() - this.#turnStartedAt);
                const statusBar = this.buildStatusBar(elapsedMs, status);
                const turns = typeof termMeta?.turns === "number" && termMeta.turns > 0 ? termMeta.turns : 1;
                const terminalDetail =
                    typeof termMeta?.problem?.detail === "string" && termMeta.problem.detail.length > 0
                        ? termMeta.problem.detail
                        : undefined;
                frames.push({
                    kind: "status_bar",
                    status: statusBar,
                    ...(terminalDetail !== undefined ? { terminalDetail } : {}),
                    turns,
                });
            }
        }

        return frames;
    }
}
