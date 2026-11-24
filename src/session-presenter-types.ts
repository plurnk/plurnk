// SessionPresenter public frame/status/options types, internal state interfaces, and SDK exhaustiveness guards
// ({§cli-conformance}, {§cli-rendering}, {§cli-session-status}, #232).

import {
    AvailableCommand,
    ContentBlock,
    PlanUpdateContent,
    SessionConfigOption,
    SessionUpdate,
    ToolCallContent,
    type SessionConfigOption as SessionConfigOptionType,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { MetaRecord } from "./acp-session.ts";

// Compile-time exhaustiveness guards over `@agentclientprotocol/sdk/experimental/v2/unstable` ({§cli-conformance}, #232).
// Any addition or rename in the SDK union guards fails `tsc --noEmit` immediately.
export const SESSION_UPDATE_GUARDS = {
    isUserMessageChunk: true,
    isUserMessage: true,
    isAgentMessageChunk: true,
    isAgentMessage: true,
    isAgentThoughtChunk: true,
    isAgentThought: true,
    isStateUpdate: true,
    isToolCallContentChunk: true,
    isToolCallUpdate: true,
    isTerminalUpdate: true,
    isTerminalOutputChunk: true,
    isPlanUpdate: true,
    isPlanRemoved: true,
    isAvailableCommandsUpdate: true,
    isConfigOptionUpdate: true,
    isSessionInfoUpdate: true,
    isUsageUpdate: true,
    isNotice: true,
    isCompactionUpdate: true,
    isCompactionSummaryChunk: true,
    isSubagentUpdate: true,
    isSessionMessage: true,
    isSessionMessageChunk: true,
    isReplayComplete: true,
    isPromptSuggestionsUpdate: true,
    isCursorUpdate: true,
    isCustom: true,
} as const satisfies Record<keyof typeof SessionUpdate, true>;

export const CONTENT_BLOCK_GUARDS = {
    isText: true,
    isImage: true,
    isAudio: true,
    isResourceLink: true,
    isResource: true,
    isSkill: true,
    isCustom: true,
} as const satisfies Record<keyof typeof ContentBlock, true>;

export const AVAILABLE_COMMAND_GUARDS = {
    isCommand: true,
    isSkill: true,
    isCustom: true,
} as const satisfies Record<keyof typeof AvailableCommand, true>;

export const PLAN_UPDATE_CONTENT_GUARDS = {
    isItems: true,
    isMarkdown: true,
    isCustom: true,
} as const satisfies Record<keyof typeof PlanUpdateContent, true>;

export const TOOL_CALL_CONTENT_GUARDS = {
    isContent: true,
    isDiff: true,
    isTerminal: true,
    isSession: true,
    isCustom: true,
} as const satisfies Record<keyof typeof ToolCallContent, true>;

export const SESSION_CONFIG_OPTION_GUARDS = {
    isSelect: true,
    isBoolean: true,
    isCustom: true,
} as const satisfies Record<keyof typeof SessionConfigOption, true>;

export interface ActiveLiveEntry {
    readonly key: string;
    readonly kind: "stream" | "worker";
    readonly glyph: string;
    readonly op: string;
    readonly target: string;
    readonly aside?: string | null;
    readonly startedAt: number;
}

export interface SessionDoing {
    readonly phase: "queued" | "awaiting" | "working";
    readonly since: number;
    readonly op: string | null;
    readonly target: string | null;
    readonly queuePosition?: number | null;
    readonly queueDepth?: number | null;
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
          readonly fields?: string | null;
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
          readonly actor?: string | null;
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
      }
    | {
          readonly kind: "prompt_suggestions";
          readonly suggestions: readonly string[];
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

export interface PendingToolCallState {
    readonly name?: string;
    readonly title?: string;
    readonly locations?: ReadonlyArray<{ readonly path: string }>;
    readonly rawInput?: Record<string, unknown>;
    readonly metaPlurnk?: Record<string, unknown>;
    readonly terminalIds?: readonly string[];
}

export interface ActiveStreamState {
    readonly key: string;
    readonly entryId: number | null;
    readonly terminalIds: readonly string[];
    readonly op: string;
    readonly target: string;
    readonly aside: string | null;
    readonly startedAt: number;
    readonly openedTurn: number;
    readonly survivedTurn: boolean;
}

export interface ActiveWorkerState {
    readonly key: string;
    readonly glyph: string;
    readonly op: string;
    readonly target: string;
    readonly startedAt: number;
}

export interface PresenterState {
    workspaceName: string;
    sessionName: string;
    projectLabel: string | null;
    lifecycle: string;
    lifecycleGlyph: string;
    mode: string;
    model: string;
    effort: string | null;
    effortSource: "default" | "explicit" | null;
    supportedEfforts: readonly string[];
    childModel: string | null;
    loopId: number | null;
    loopSeq: number | null;
    turns: number;
    waitUntil: number | null;
    curationWeight: number;
    curationBudget: number;
    contextTokens: number | null;
    contextCapacity: number | null;
    activeChildren: number;
    gatedCount: number;
    inboxCount: number;
    openStreams: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: string | null;
    hasUnknownCost: boolean;
    doing: SessionDoing | null;
    preparation: WorkspacePreparationState | null;
    activity: SearchActivityState | null;
    disconnected: boolean;
    lastLoopStatus: number | null;
    lastStatusLine: string;
    readonly maxReasoningLines: number;
    readonly yolo: boolean;
}

export interface PresenterInternals {
    reasoningBuffer: string;
    reasoningLines: string[];
    lastStreamTarget: string;
    turnStartedAt: number;
    seededElapsedMs: number | null;
    turnBaseInputTokens: number;
    turnBaseOutputTokens: number;
    turnBaseCostUsd: string | null;
    loopCostUsd: string | null;
    readonly pendingToolCalls: Map<string, PendingToolCallState>;
    readonly renderedToolCalls: Set<string>;
    readonly concludedStreams: Map<string, number>;
    readonly openStreamKeys: Set<string>;
    readonly activeStreams: Map<string, ActiveStreamState>;
    readonly activeWorkers: Map<string, ActiveWorkerState>;
    readonly bindingsWithLoops: Set<string>;
    replayingHistory: boolean;
    pendingHistoryLost: boolean;
    awaitingTurnCount: number;
    budgetNoticeSeq: number;
    loopConcluded: boolean;
    promptSuggestions: readonly string[];
}

export const createPresenterInternals = (): PresenterInternals => ({
    reasoningBuffer: "",
    reasoningLines: [],
    lastStreamTarget: "",
    turnStartedAt: Date.now(),
    seededElapsedMs: null,
    turnBaseInputTokens: 0,
    turnBaseOutputTokens: 0,
    turnBaseCostUsd: null,
    loopCostUsd: null,
    pendingToolCalls: new Map<string, PendingToolCallState>(),
    renderedToolCalls: new Set<string>(),
    concludedStreams: new Map<string, number>(),
    openStreamKeys: new Set<string>(),
    activeStreams: new Map<string, ActiveStreamState>(),
    activeWorkers: new Map<string, ActiveWorkerState>(),
    bindingsWithLoops: new Set<string>(),
    replayingHistory: false,
    pendingHistoryLost: false,
    awaitingTurnCount: 0,
    budgetNoticeSeq: 0,
    loopConcluded: false,
    promptSuggestions: [],
});
