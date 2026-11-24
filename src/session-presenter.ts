// Unified ACP v2 SessionPresenter pipeline ({§cli-rendering}, {§cli-session-status}, {§cli-markdown-projection}, {§cli-workspaces-and-sessions}).
// Single state machine between AcpSession and any rendering viewport (CLI stdout/stderr or pi-tui)
// so that Term is a pure perspective of the CLI and never makes an independent presentation decision.

import { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { contentBlockToText, type MetaRecord } from "./acp-session.ts";
import {
    abbreviatedCount,
    addDecimal,
    compactTarget,
    extractMessageActor,
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
    applyEngineNoticeMeta,
    flushPendingHistoryLost,
    projectAgentMessageUpdate,
    projectNoticeUpdate,
    projectSessionInfoUpdate,
    projectStateUpdate,
    projectThoughtUpdate,
    projectUsageUpdate,
} from "./session-presenter-events.ts";
import {
    applyPresenterConfigOptions,
    buildPresenterStatusBar,
    consumePresenterHistoryLostFrame,
    createPresenterInternals,
    ingestPresenterMeta,
    resetLoopTurns,
    type PresenterInternals,
} from "./session-presenter-meta.ts";
import {
    projectSubagentUpdate,
    projectTerminalOutputChunk,
    projectTerminalUpdate,
    projectToolCallUpdate,
} from "./session-presenter-tools.ts";
import {
    AVAILABLE_COMMAND_GUARDS,
    CONTENT_BLOCK_GUARDS,
    PLAN_UPDATE_CONTENT_GUARDS,
    SESSION_CONFIG_OPTION_GUARDS,
    SESSION_UPDATE_GUARDS,
    TOOL_CALL_CONTENT_GUARDS,
    type ActiveLiveEntry,
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
    AVAILABLE_COMMAND_GUARDS,
    compactTarget,
    CONTENT_BLOCK_GUARDS,
    extractMessageActor,
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
    PLAN_UPDATE_CONTENT_GUARDS,
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
    mode: string;
    model: string;
    effort: string | null = null;
    effortSource: "default" | "explicit" | null = null;
    supportedEfforts: readonly string[] = [];
    childModel: string | null = null;
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
    readonly #internals: PresenterInternals = createPresenterInternals();

    constructor(options: SessionPresenterOptions = {}) {
        this.workspaceName = options.workspaceName ?? "default";
        this.sessionName = options.sessionName ?? "session1";
        this.model = options.model ?? "default";
        this.mode = options.yolo === true ? "accept" : "review";
        this.maxReasoningLines = options.maxReasoningLines ?? 3;

        if (options.initialConfigOptions) {
            applyPresenterConfigOptions(this, options.initialConfigOptions);
        }
        if (options.initialMeta) {
            this.ingestMeta(options.initialMeta);
        }
        this.#internals.turnBaseInputTokens = this.inputTokens;
        this.#internals.turnBaseOutputTokens = this.outputTokens;
        this.#internals.turnBaseCostUsd = this.costUsd;
    }

    get yolo(): boolean {
        return this.mode === "accept";
    }

    set yolo(value: boolean) {
        this.mode = value ? "accept" : "review";
    }

    get reasoningLines(): readonly string[] {
        return this.#internals.reasoningLines;
    }

    get promptSuggestions(): readonly string[] {
        return this.#internals.promptSuggestions;
    }

    setPromptSuggestions(suggestions: readonly string[]): void {
        this.#internals.promptSuggestions = suggestions.filter((t) => t.trim().length > 0);
    }

    get activeLiveEntries(): readonly ActiveLiveEntry[] {
        const entries: ActiveLiveEntry[] = [];
        for (const stream of this.#internals.activeStreams.values()) {
            if (!stream.survivedTurn) continue;
            entries.push({
                key: stream.key,
                kind: "stream",
                glyph: "⚙️",
                op: stream.op,
                target: stream.target,
                ...(stream.aside !== null ? { aside: stream.aside } : {}),
                startedAt: stream.startedAt,
            });
        }
        for (const worker of this.#internals.activeWorkers.values()) {
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

    setHistoryReplay(replaying: boolean): void {
        this.#internals.replayingHistory = replaying;
    }

    consumeHistoryLostFrame(): Extract<PresentationFrame, { kind: "notice" }> | null {
        return consumePresenterHistoryLostFrame(this.#internals);
    }

    resetSessionHistory(): void {
        this.#internals.pendingToolCalls.clear();
        this.#internals.renderedToolCalls.clear();
        this.#internals.concludedStreams.clear();
        this.#internals.activeStreams.clear();
        this.#internals.activeWorkers.clear();
        this.#internals.promptSuggestions = [];
    }

    isOpenStream(toolCallId: string, streamTarget?: string | null): boolean {
        if (this.#internals.openStreamKeys.has(toolCallId)) return true;
        if (typeof streamTarget === "string" && streamTarget.length > 0 && this.#internals.openStreamKeys.has(streamTarget)) {
            return true;
        }
        return false;
    }

    markTurnStart(now = Date.now()): void {
        if (this.#internals.loopConcluded) {
            resetLoopTurns(this, this.#internals);
        }
        this.#internals.promptSuggestions = [];
        this.lastLoopStatus = null;
        this.#internals.loopCostUsd = null;
        this.#internals.seededElapsedMs = null;
        this.#internals.turnStartedAt = now;
        this.#internals.turnBaseInputTokens = this.inputTokens;
        this.#internals.turnBaseOutputTokens = this.outputTokens;
        this.#internals.turnBaseCostUsd = this.costUsd;
        this.disconnected = false;
        this.lifecycle = "running";
        this.lifecycleGlyph = "⌛︎";
        this.doing = { phase: "awaiting", since: now, op: null, target: null };
    }

    markDisconnected(): StatusBarModel {
        this.disconnected = true;
        this.lifecycle = "idle";
        this.doing = null;
        this.#internals.activeStreams.clear();
        this.#internals.activeWorkers.clear();
        return this.buildStatusBar();
    }

    ingestMeta(meta: MetaRecord | undefined): void {
        ingestPresenterMeta(this, this.#internals, meta);
    }

    buildStatusBar(elapsedMsOverride?: number, statusCodeOverride?: number): StatusBarModel {
        return buildPresenterStatusBar(this, this.#internals, elapsedMsOverride, statusCodeOverride);
    }

    apply(update: SessionUpdate): PresentationFrame[] {
        const frames: PresentationFrame[] = [];

        if (SessionUpdate.isReplayComplete(update)) {
            this.#internals.replayingHistory = false;
            return frames;
        }

        if (SessionUpdate.isCursorUpdate(update)) {
            return frames;
        }

        if (SessionUpdate.isPromptSuggestionsUpdate(update)) {
            if (this.#internals.replayingHistory) {
                return frames;
            }
            const next = update.suggestions
                .map((s) => (s.prompt ?? []).map(contentBlockToText).join(""))
                .filter((t) => t.trim().length > 0);
            this.#internals.promptSuggestions = next;
            frames.push({ kind: "prompt_suggestions", suggestions: next });
            return frames;
        }

        if (SessionUpdate.isSessionInfoUpdate(update)) {
            projectSessionInfoUpdate(this, this.#internals, update, frames);
            return frames;
        }

        if (SessionUpdate.isCustom(update)) {
            if (update.sessionUpdate === "_plurnk_telemetry") {
                this.ingestMeta(update._meta as MetaRecord | undefined);
                if (!applyEngineNoticeMeta(this, this.#internals, update._meta, frames)) {
                    flushPendingHistoryLost(this.#internals, frames);
                    frames.push({ kind: "status_update", status: this.buildStatusBar() });
                }
            }
            return frames;
        }

        if (SessionUpdate.isConfigOptionUpdate(update)) {
            this.ingestMeta(update._meta as MetaRecord | undefined);
            applyPresenterConfigOptions(this, update.configOptions, true);
            flushPendingHistoryLost(this.#internals, frames);
            return frames;
        }

        if (SessionUpdate.isUsageUpdate(update)) {
            projectUsageUpdate(this, this.#internals, update, frames);
            return frames;
        }

        if (SessionUpdate.isAgentThoughtChunk(update) || SessionUpdate.isAgentThought(update)) {
            projectThoughtUpdate(this, this.#internals, update, frames);
            return frames;
        }

        if (SessionUpdate.isPlanUpdate(update) || SessionUpdate.isPlanRemoved(update)) {
            return frames;
        }

        if (SessionUpdate.isToolCallUpdate(update)) {
            projectToolCallUpdate(this, this.#internals, update, frames);
            return frames;
        }

        if (SessionUpdate.isTerminalUpdate(update)) {
            projectTerminalUpdate(this.#internals, update);
            return frames;
        }

        if (SessionUpdate.isTerminalOutputChunk(update)) {
            projectTerminalOutputChunk(this.#internals, update, frames);
            return frames;
        }

        if (SessionUpdate.isSubagentUpdate(update)) {
            projectSubagentUpdate(this.#internals, update, frames);
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
            projectAgentMessageUpdate(this, this.#internals, update, frames);
            return frames;
        }

        if (SessionUpdate.isNotice(update)) {
            projectNoticeUpdate(this, this.#internals, update, frames);
            return frames;
        }

        if (SessionUpdate.isStateUpdate(update)) {
            projectStateUpdate(this, this.#internals, update, frames);
            return frames;
        }

        if (
            SessionUpdate.isToolCallContentChunk(update) ||
            SessionUpdate.isAvailableCommandsUpdate(update) ||
            SessionUpdate.isCompactionUpdate(update) ||
            SessionUpdate.isCompactionSummaryChunk(update)
        ) {
            return frames;
        }

        return frames;
    }
}
