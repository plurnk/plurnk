// Unified ACP v2 SessionPresenter pipeline ({§cli-rendering}, {§cli-session-status}, {§cli-markdown-projection}).
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
        if (clean === "FACT" || clean === "IDEA" || clean === "PLAN" || clean === "NOTE") {
            return OPERATION_GLYPH_MAP[clean]!;
        }
    }
    if (typeof op === "string" && op in OPERATION_GLYPH_MAP) {
        return OPERATION_GLYPH_MAP[op]!;
    }
    if (typeof op === "string" && op.length > 0) {
        return `⚙️  ${op}`;
    }
    return "⚙️";
};

export const normalizeNoteHeading = (
    op: string,
    rawAside: string | null,
): { readonly glyph: string; readonly aside: string | null } => {
    if (op === "NOTE" && typeof rawAside === "string") {
        const trimmed = rawAside.trim();
        const upper = trimmed.toUpperCase();
        if (upper === "FACT" || upper === "IDEA" || upper === "PLAN" || upper === "NOTE") {
            return { glyph: OPERATION_GLYPH_MAP[upper]!, aside: null };
        }
        const prefixed = trimmed.match(/^(FACT|IDEA|PLAN|NOTE)\s*[:—-]\s*(.+)$/iu);
        if (prefixed?.[1] && prefixed[2]) {
            const cat = prefixed[1].toUpperCase();
            return { glyph: OPERATION_GLYPH_MAP[cat] ?? "🗒️", aside: prefixed[2].trim() };
        }
    }
    return { glyph: operationGlyphFor(op, rawAside), aside: rawAside };
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

const extractTitleAside = (title: string | null | undefined): string | null => {
    if (typeof title !== "string") return null;
    const sepIdx = title.indexOf(" — ");
    if (sepIdx < 0) return null;
    const aside = title.slice(sepIdx + 3).trim();
    return aside.length > 0 ? aside : null;
};

const extractTitleTarget = (title: string | null | undefined): string | null => {
    if (typeof title !== "string") return null;
    const head = title.includes(" — ") ? title.slice(0, title.indexOf(" — ")) : title;
    const parenMatch = head.match(/^\S+\s+\((.+)\)$/u);
    if (parenMatch?.[1]) return parenMatch[1];
    const spaceMatch = head.match(/^(?:READ|EDIT|FIND|COPY|MOVE|KILL|OPEN|SHUT|VIEW|KEEP|DROP|FOLD)\s+(.+)$/u);
    return spaceMatch?.[1]?.trim() ?? null;
};

const compactTarget = (target: string): string => {
    const clean = target.replace(/^file:\/\//u, "");
    const parts = clean.split("/").filter(Boolean);
    if (parts.length <= 2) return clean;
    return `…/${parts.slice(-2).join("/")}`;
};

const formatLiveWait = (ms: number): string => {
    if (ms < 1000) return `${String(Math.max(1, Math.round(ms)))}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
};

export const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${String(Math.max(1, Math.round(ms)))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) {
        const m = Math.floor(ms / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        return `${String(m)}m${String(s).padStart(2, "0")}s`;
    }
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${String(h)}h${String(m).padStart(2, "0")}m`;
};

export const abbreviatedCount = (n: number): string => {
    if (n < 1000) return String(n);
    if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/u, "")}k`;
    if (n < 1_000_000) return `${String(Math.round(n / 1000))}k`;
    if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
    if (n < 1_000_000_000) return `${String(Math.round(n / 1_000_000))}M`;
    return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/u, "")}B`;
};

export const formatUsdSpend = (costUsd: string | null): string | null => {
    if (costUsd === null || costUsd.length === 0) return null;
    const num = Number(costUsd);
    if (!Number.isFinite(num) || num <= 0) return null;
    return `$${num.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
};

export const addDecimal = (a: string | null, b: string): string => {
    if (a === null || a.length === 0) return b;
    if (b.length === 0) return a;
    const [aInt = "0", aFrac = ""] = a.split(".");
    const [bInt = "0", bFrac = ""] = b.split(".");
    const scale = Math.max(aFrac.length, bFrac.length);
    const aScaled = BigInt(aInt + aFrac.padEnd(scale, "0"));
    const bScaled = BigInt(bInt + bFrac.padEnd(scale, "0"));
    const sum = (aScaled + bScaled).toString().padStart(scale + 1, "0");
    if (scale === 0) return sum;
    const intPart = sum.slice(0, sum.length - scale);
    const fracPart = sum.slice(sum.length - scale).replace(/0+$/u, "");
    return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
};

export const formatModelRoute = (
    model: string,
    effort: string | null,
    effortSource: "default" | "explicit" | null,
): string => {
    if (
        effort !== null &&
        effort.length > 0 &&
        !model.endsWith(`(${effort})`) &&
        !model.endsWith(`[${effort}]`)
    ) {
        return effortSource === "default" ? `${model}(${effort})` : `${model}[${effort}]`;
    }
    return model;
};

const extractRawString = (val: unknown): string | null => {
    if (typeof val === "string" && val.length > 0) return val;
    if (val && typeof val === "object" && typeof (val as { raw?: unknown }).raw === "string") {
        const raw = (val as { raw: string }).raw;
        return raw.length > 0 ? raw : null;
    }
    return null;
};

const extractScopeToken = (lineMarker: unknown): string | null => {
    if (!lineMarker || typeof lineMarker !== "object") return null;
    const marks = (lineMarker as { marks?: unknown }).marks;
    if (!Array.isArray(marks) || marks.length === 0) return null;
    const tokens = marks.filter((m): m is number | string => typeof m === "number" || typeof m === "string");
    return tokens.length > 0 ? `<${tokens.map(String).join(",")}>` : null;
};

const spanLength = (span: unknown): number | null => {
    if (!Array.isArray(span) || span.length !== 2) return null;
    const [start, end] = span;
    if (typeof start !== "number" || typeof end !== "number") return null;
    return Math.max(0, end - start + 1);
};

const receiptCountFor = (op: string, rawOutput: Record<string, unknown> | undefined): number | null => {
    if (!rawOutput) return null;
    const range =
        rawOutput.range && typeof rawOutput.range === "object"
            ? (rawOutput.range as { returned?: unknown; total?: unknown })
            : undefined;
    if (op === "READ") {
        if (Array.isArray(rawOutput.lineOrdinals)) {
            return rawOutput.lineOrdinals.length;
        }
        return (
            spanLength(range?.returned) ??
            (typeof rawOutput.count === "number" ? rawOutput.count : null)
        );
    }
    if (op === "FIND") {
        return (
            spanLength(range?.returned) ??
            (typeof range?.total === "number" ? range.total : null) ??
            (typeof rawOutput.count === "number" ? rawOutput.count : null) ??
            (typeof rawOutput.matches === "number" ? rawOutput.matches : null)
        );
    }
    return typeof rawOutput.count === "number"
        ? rawOutput.count
        : typeof rawOutput.matches === "number"
          ? rawOutput.matches
          : null;
};

const NO_PREVIEW_VERBS = new Set([
    "READ",
    "FIND",
    "COPY",
    "MOVE",
    "KILL",
    "BARE",
    "WAIT",
    "NOTE",
    "KEEP",
    "DROP",
    "FOLD",
    "OPEN",
    "SHUT",
    "VIEW",
    "META",
]);

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
            if (typeof status.lifecycle === "string") {
                this.lifecycle = status.lifecycle;
            }
            if (typeof status.loopSeq === "number") {
                this.loopSeq = status.loopSeq;
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

        // Right-of-status-line live activity indicators ({§cli-session-status}, {§cli-session-status}, {§cli-session-status})
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
            const waitSuffix =
                this.waitUntil !== null
                    ? `updates in ${String(Math.max(1, Math.ceil((this.waitUntil - Date.now()) / 1000)))}s`
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

    apply(update: SessionUpdate): PresentationFrame[] {
        const frames: PresentationFrame[] = [];

        if (SessionUpdate.isConfigOptionUpdate(update)) {
            this.#applyConfigOptions(update.configOptions, true);
            this.ingestMeta(update._meta as MetaRecord | undefined);
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

            // Authored request bodies (EDIT, WORK, FORK, undelivered SEND, runtime execs, harness NOTEs)
            // and concluded runtime execution stream outputs receive a preview beneath the row
            // ({§cli-rendering}, {§cli-rendering}).
            const contentLines: string[] = [];
            if (opName === "NOTE" && origin !== "model" && noteBody !== null && noteBody.length > 0) {
                contentLines.push(noteBody);
            } else if (!NO_PREVIEW_VERBS.has(opName) && authoredBody !== null) {
                contentLines.push(authoredBody);
            }

            const outputLines: string[] = [];
            const isRuntimeExec = !(opName in OPERATION_GLYPH_MAP);
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
