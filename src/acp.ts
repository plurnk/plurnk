// The Node consumer of the daemon's ACP endpoint. Terminal clients POST a run
// to it and consume the ACP SSE projection. This module mirrors the
// standard ACP HTTP/SSE transport: POST /acp for runs, including interrupt
// resolution through RunAgentInput.resume.
//
// The ACP stream parser validates each event frame at the transport boundary — a
// malformed event fails the stream here instead of rendering as if it were real.
// This adapter otherwise only preserves the client's async-iterator surface;
// rendering (waterfall, proposals, gauge) stays local. Plurnk fidelity rides standard metadata where ACP holds
// the fact (a Run's end, the parts a row builds: plurnk-service {§acp-plurnk-metadata}) and CUSTOM plurnk.* events
// for what has no standard subject (a row outside the conversation rides plurnk.ambient whole).

import type { ClientCapabilities } from "./client-capabilities.ts";
import type { ClientCredential } from "./credential.ts";
import {
    Validator,
    type EntryReadResult,
    type OperationResult,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import {
    clientActionResultInvalid,
    clientActionResultMissing,
    clientTransportProblemInvalid,
    clientTransportResultInvalid,
    ProblemError,
} from "./diagnostics.ts";
import { objectOf } from "./render.ts";

export const EventType = {
    TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
    TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
    TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
    TEXT_MESSAGE_CHUNK: "TEXT_MESSAGE_CHUNK",
    TOOL_CALL_START: "TOOL_CALL_START",
    TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
    TOOL_CALL_END: "TOOL_CALL_END",
    TOOL_CALL_CHUNK: "TOOL_CALL_CHUNK",
    TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
    STATE_SNAPSHOT: "STATE_SNAPSHOT",
    STATE_DELTA: "STATE_DELTA",
    MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
    ACTIVITY_SNAPSHOT: "ACTIVITY_SNAPSHOT",
    ACTIVITY_DELTA: "ACTIVITY_DELTA",
    RAW: "RAW",
    CUSTOM: "CUSTOM",
    RUN_STARTED: "RUN_STARTED",
    RUN_FINISHED: "RUN_FINISHED",
    RUN_ERROR: "RUN_ERROR",
    STEP_STARTED: "STEP_STARTED",
    STEP_FINISHED: "STEP_FINISHED",
    REASONING_START: "REASONING_START",
    REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
    REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
    REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
    REASONING_MESSAGE_CHUNK: "REASONING_MESSAGE_CHUNK",
    REASONING_END: "REASONING_END",
    REASONING_ENCRYPTED_VALUE: "REASONING_ENCRYPTED_VALUE",
    SUBAGENT_STARTED: "SUBAGENT_STARTED",
    SUBAGENT_FINISHED: "SUBAGENT_FINISHED",
    SUBAGENT_ERROR: "SUBAGENT_ERROR",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export declare namespace EventType {
    export type TEXT_MESSAGE_START = typeof EventType.TEXT_MESSAGE_START;
    export type TEXT_MESSAGE_CONTENT = typeof EventType.TEXT_MESSAGE_CONTENT;
    export type TEXT_MESSAGE_END = typeof EventType.TEXT_MESSAGE_END;
    export type TEXT_MESSAGE_CHUNK = typeof EventType.TEXT_MESSAGE_CHUNK;
    export type TOOL_CALL_START = typeof EventType.TOOL_CALL_START;
    export type TOOL_CALL_ARGS = typeof EventType.TOOL_CALL_ARGS;
    export type TOOL_CALL_END = typeof EventType.TOOL_CALL_END;
    export type TOOL_CALL_CHUNK = typeof EventType.TOOL_CALL_CHUNK;
    export type TOOL_CALL_RESULT = typeof EventType.TOOL_CALL_RESULT;
    export type STATE_SNAPSHOT = typeof EventType.STATE_SNAPSHOT;
    export type STATE_DELTA = typeof EventType.STATE_DELTA;
    export type MESSAGES_SNAPSHOT = typeof EventType.MESSAGES_SNAPSHOT;
    export type ACTIVITY_SNAPSHOT = typeof EventType.ACTIVITY_SNAPSHOT;
    export type ACTIVITY_DELTA = typeof EventType.ACTIVITY_DELTA;
    export type RAW = typeof EventType.RAW;
    export type CUSTOM = typeof EventType.CUSTOM;
    export type RUN_STARTED = typeof EventType.RUN_STARTED;
    export type RUN_FINISHED = typeof EventType.RUN_FINISHED;
    export type RUN_ERROR = typeof EventType.RUN_ERROR;
    export type STEP_STARTED = typeof EventType.STEP_STARTED;
    export type STEP_FINISHED = typeof EventType.STEP_FINISHED;
    export type REASONING_START = typeof EventType.REASONING_START;
    export type REASONING_MESSAGE_START = typeof EventType.REASONING_MESSAGE_START;
    export type REASONING_MESSAGE_CONTENT = typeof EventType.REASONING_MESSAGE_CONTENT;
    export type REASONING_MESSAGE_END = typeof EventType.REASONING_MESSAGE_END;
    export type REASONING_MESSAGE_CHUNK = typeof EventType.REASONING_MESSAGE_CHUNK;
    export type REASONING_END = typeof EventType.REASONING_END;
    export type REASONING_ENCRYPTED_VALUE = typeof EventType.REASONING_ENCRYPTED_VALUE;
    export type SUBAGENT_STARTED = typeof EventType.SUBAGENT_STARTED;
    export type SUBAGENT_FINISHED = typeof EventType.SUBAGENT_FINISHED;
    export type SUBAGENT_ERROR = typeof EventType.SUBAGENT_ERROR;
}

export type Metadata = Record<string, unknown>;

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
    metadata?: Metadata;
}

export interface BaseMessage {
    id: string;
    role: string;
    content?: unknown;
    name?: string;
    metadata?: Metadata;
    subagentRunId?: string | null;
}

export interface AssistantMessage extends BaseMessage {
    role: "assistant";
    content?: unknown;
    toolCalls?: ToolCall[];
}

export interface UserMessage extends BaseMessage {
    role: "user";
    content: unknown;
}

export interface ToolMessage extends BaseMessage {
    role: "tool";
    content: unknown;
    toolCallId: string;
    error?: string;
}

export interface ReasoningMessage extends BaseMessage {
    role: "reasoning";
    content: string;
    encryptedValue?: string;
}

export interface SystemMessage extends BaseMessage {
    role: "system";
    content: string;
}

export interface DeveloperMessage extends BaseMessage {
    role: "developer";
    content: string;
}

export interface ActivityMessage extends BaseMessage {
    role: "activity";
    activityType: string;
    content: Record<string, unknown>;
}

export type Message =
    | AssistantMessage
    | UserMessage
    | ToolMessage
    | ReasoningMessage
    | SystemMessage
    | DeveloperMessage
    | ActivityMessage;

export interface Context {
    description: string;
    value: string;
}

export interface Tool {
    name: string;
    description: string;
    parameters: unknown;
    metadata?: Metadata;
}

export interface Interrupt {
    id: string;
    type?: string;
    toolCallId?: string;
    reason?: string;
    message?: string;
    responseSchema?: Record<string, unknown>;
    payload?: unknown;
    metadata?: Metadata;
    subagentRunId?: string | null;
    [key: string]: unknown;
}

export interface ResumeEntry {
    interruptId: string;
    status: "resolved" | "cancelled";
    payload?: unknown;
    metadata?: Metadata;
}

export interface RunAgentInput {
    threadId: string;
    runId: string;
    parentRunId?: string;
    state?: unknown;
    messages: Message[];
    tools: Tool[];
    context: Context[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    forwardedProps?: any;
    resume?: ResumeEntry[];
    [key: string]: unknown;
}

export interface BaseEvent {
    type: EventType;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: string | null;
    [key: string]: unknown;
}

export interface TextMessageStartEvent extends BaseEvent {
    type: typeof EventType.TEXT_MESSAGE_START;
    messageId: string;
    role?: "developer" | "system" | "assistant" | "user";
    name?: string;
}

export interface TextMessageContentEvent extends BaseEvent {
    type: typeof EventType.TEXT_MESSAGE_CONTENT;
    messageId: string;
    delta: string;
}

export interface TextMessageEndEvent extends BaseEvent {
    type: typeof EventType.TEXT_MESSAGE_END;
    messageId: string;
}

export interface TextMessageChunkEvent extends BaseEvent {
    type: typeof EventType.TEXT_MESSAGE_CHUNK;
    messageId?: string;
    role?: "developer" | "system" | "assistant" | "user";
    delta?: string;
    name?: string;
}

export interface ToolCallStartEvent extends BaseEvent {
    type: typeof EventType.TOOL_CALL_START;
    toolCallId: string;
    toolCallName: string;
    parentMessageId?: string;
}

export interface ToolCallArgsEvent extends BaseEvent {
    type: typeof EventType.TOOL_CALL_ARGS;
    toolCallId: string;
    delta: string;
}

export interface ToolCallEndEvent extends BaseEvent {
    type: typeof EventType.TOOL_CALL_END;
    toolCallId: string;
}

export interface ToolCallChunkEvent extends BaseEvent {
    type: typeof EventType.TOOL_CALL_CHUNK;
    toolCallId?: string;
    toolCallName?: string;
    parentMessageId?: string;
    delta?: string;
}

export interface ToolCallResultEvent extends BaseEvent {
    type: typeof EventType.TOOL_CALL_RESULT;
    messageId: string;
    toolCallId: string;
    content: unknown;
    role?: "tool";
}

export interface StateSnapshotEvent extends BaseEvent {
    type: typeof EventType.STATE_SNAPSHOT;
    snapshot: unknown;
}

export interface StateDeltaEvent extends BaseEvent {
    type: typeof EventType.STATE_DELTA;
    delta: unknown[];
}

export interface MessagesSnapshotEvent extends Omit<BaseEvent, "subagentRunId"> {
    type: typeof EventType.MESSAGES_SNAPSHOT;
    messages: Message[];
}

export interface ActivitySnapshotEvent extends BaseEvent {
    type: typeof EventType.ACTIVITY_SNAPSHOT;
    messageId: string;
    activityType: string;
    content: Record<string, unknown>;
    replace?: boolean;
}

export interface ActivityDeltaEvent extends BaseEvent {
    type: typeof EventType.ACTIVITY_DELTA;
    messageId: string;
    activityType: string;
    patch: unknown[];
}

export interface RawEvent extends BaseEvent {
    type: typeof EventType.RAW;
    event: unknown;
    source?: string;
}

export interface CustomEvent extends BaseEvent {
    type: typeof EventType.CUSTOM;
    name: string;
    value: unknown;
}

export interface RunStartedEvent extends BaseEvent {
    type: typeof EventType.RUN_STARTED;
    threadId: string;
    runId: string;
    parentRunId?: string;
    input?: RunAgentInput;
}

export type RunOutcome =
    | { type: "success"; pendingToolCallIds?: string[] }
    | { type: "interrupt"; interrupts: Interrupt[] }
    | { type: "cancelled" };

export interface RunFinishedEvent extends BaseEvent {
    type: typeof EventType.RUN_FINISHED;
    threadId: string;
    runId: string;
    result?: unknown;
    outcome?: RunOutcome;
    usage?: unknown;
}

export interface RunErrorEvent extends BaseEvent {
    type: typeof EventType.RUN_ERROR;
    message: string;
    code?: string;
    usage?: unknown;
}

export interface StepStartedEvent extends BaseEvent {
    type: typeof EventType.STEP_STARTED;
    stepName: string;
}

export interface StepFinishedEvent extends BaseEvent {
    type: typeof EventType.STEP_FINISHED;
    stepName: string;
}

export interface ReasoningStartEvent extends BaseEvent {
    type: typeof EventType.REASONING_START;
    messageId: string;
}

export interface ReasoningMessageStartEvent extends BaseEvent {
    type: typeof EventType.REASONING_MESSAGE_START;
    messageId: string;
    role: "reasoning";
}

export interface ReasoningMessageContentEvent extends BaseEvent {
    type: typeof EventType.REASONING_MESSAGE_CONTENT;
    messageId: string;
    delta: string;
}

export interface ReasoningMessageEndEvent extends BaseEvent {
    type: typeof EventType.REASONING_MESSAGE_END;
    messageId: string;
}

export interface ReasoningMessageChunkEvent extends BaseEvent {
    type: typeof EventType.REASONING_MESSAGE_CHUNK;
    messageId?: string;
    delta?: string;
}

export interface ReasoningEndEvent extends BaseEvent {
    type: typeof EventType.REASONING_END;
    messageId: string;
}

export interface ReasoningEncryptedValueEvent extends BaseEvent {
    type: typeof EventType.REASONING_ENCRYPTED_VALUE;
    subtype: "tool-call" | "message";
    entityId: string;
    encryptedValue: string;
}

export interface SubagentStartedEvent extends BaseEvent {
    type: typeof EventType.SUBAGENT_STARTED;
    subagentRunId: string;
    name: string;
    description?: string;
    parentToolCallId?: string;
    input?: unknown;
}

export interface SubagentFinishedEvent extends BaseEvent {
    type: typeof EventType.SUBAGENT_FINISHED;
    subagentRunId: string;
    outcome: "completed" | "cancelled";
    result?: unknown;
    usage?: unknown;
}

export interface SubagentErrorEvent extends BaseEvent {
    type: typeof EventType.SUBAGENT_ERROR;
    subagentRunId: string;
    message: string;
    code?: string;
    usage?: unknown;
}

export type AcpEvent =
    | TextMessageStartEvent
    | TextMessageContentEvent
    | TextMessageEndEvent
    | TextMessageChunkEvent
    | ToolCallStartEvent
    | ToolCallArgsEvent
    | ToolCallEndEvent
    | ToolCallChunkEvent
    | ToolCallResultEvent
    | StateSnapshotEvent
    | StateDeltaEvent
    | MessagesSnapshotEvent
    | ActivitySnapshotEvent
    | ActivityDeltaEvent
    | RawEvent
    | CustomEvent
    | RunStartedEvent
    | RunFinishedEvent
    | RunErrorEvent
    | StepStartedEvent
    | StepFinishedEvent
    | ReasoningStartEvent
    | ReasoningMessageStartEvent
    | ReasoningMessageContentEvent
    | ReasoningMessageEndEvent
    | ReasoningMessageChunkEvent
    | ReasoningEndEvent
    | ReasoningEncryptedValueEvent
    | SubagentStartedEvent
    | SubagentFinishedEvent
    | SubagentErrorEvent;

export const RunAgentInputSchema = {
    parse(value: unknown): RunAgentInput {
        const obj = objectOf(value);
        if (obj === null || typeof obj.threadId !== "string" || typeof obj.runId !== "string" || !Array.isArray(obj.messages)) {
            throw new TypeError("Invalid RunAgentInput");
        }
        return {
            ...obj,
            threadId: obj.threadId,
            runId: obj.runId,
            messages: obj.messages as Message[],
            tools: Array.isArray(obj.tools) ? (obj.tools as Tool[]) : [],
            context: Array.isArray(obj.context) ? (obj.context as Context[]) : [],
            ...(Array.isArray(obj.resume) ? { resume: obj.resume as ResumeEntry[] } : {}),
            ...(objectOf(obj.forwardedProps) !== null ? { forwardedProps: obj.forwardedProps as Record<string, unknown> } : {}),
        };
    },
};

export interface AcpTarget { acpUrl: string; credential?: ClientCredential }
export interface WorkspaceHandle { readonly id: number; readonly name: string }
export interface WorkerBinding { readonly workspaceId: number; readonly worker: string }

// {§cli-workspaces-and-workers}: display labels never participate in a bound thread's identity.
export const workerThreadId = ({ workspaceId, worker }: WorkerBinding): string => {
    if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
        throw new ProblemError(clientTransportResultInvalid("A worker binding requires a daemon-returned workspace ID."));
    }
    return `${workspaceId}#${worker}`;
};

// The worker a bound thread names after its workspace ID, or null for a thread that binds none.
export const threadWorker = (threadId: string): string | null => {
    const at = threadId.indexOf("#");
    return at < 0 ? null : threadId.slice(at + 1);
};

export type ActionOutcome<T = unknown> =
    | { kind: string; ok: true; result?: T }
    | { kind: string; ok: false; problem: ProblemDetails };

export const problemDetails = (value: unknown): ProblemDetails => {
    try {
        return Validator.assertProblemDetails(value as ProblemDetails);
    } catch (cause) {
        throw new ProblemError(clientTransportProblemInvalid(cause));
    }
};

export const operationResult = (value: unknown): OperationResult => {
    try {
        return Validator.assertOperationResult(value as OperationResult);
    } catch (cause) {
        throw new ProblemError(clientTransportResultInvalid(cause));
    }
};

export const entryReadResult = (value: unknown): EntryReadResult => {
    try {
        return Validator.assertEntryReadResult(value as EntryReadResult);
    } catch (cause) {
        throw new ProblemError(clientTransportResultInvalid(cause));
    }
};

export const acpDiscovery = (value: unknown): { actions: Record<string, unknown>; notifications: Record<string, unknown> } => {
    const obj = objectOf(value);
    const actions = objectOf(obj?.actions);
    const notifications = objectOf(obj?.notifications);
    if (obj?.schemaVersion !== 1 || actions === null || notifications === null) {
        throw new ProblemError(clientTransportResultInvalid("Invalid ACP discovery payload."));
    }
    return { actions, notifications };
};

const problemFetch = async (url: string, requestInit: RequestInit): Promise<Response> => {
    const response = await fetch(url, requestInit);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (!response.ok && mediaType === "application/problem+json") {
        const problem = problemDetails(await response.clone().json());
        throw new ProblemError(problem);
    }
    return response;
};

export const actionOutcome = <T>(value: unknown): ActionOutcome<T> => {
    if (value === null || typeof value !== "object") {
        throw new ProblemError(clientActionResultInvalid("The outcome is not an object."));
    }
    const outcome = value as { kind?: unknown; ok?: unknown; result?: T; problem?: unknown };
    if (typeof outcome.kind !== "string" || outcome.kind.length === 0) {
        throw new ProblemError(clientActionResultInvalid("The outcome does not contain a non-empty kind."));
    }
    if (outcome.ok === true) return { kind: outcome.kind, ok: true, result: outcome.result };
    if (outcome.ok === false) {
        return {
            kind: outcome.kind,
            ok: false,
            problem: problemDetails(outcome.problem),
        };
    }
    throw new ProblemError(clientActionResultInvalid("The outcome does not contain a boolean ok."));
};

// What a Run's end carries beyond its outcome (plurnk-service {§acp-plurnk-metadata}): the bound loop's terminal record,
// the exact Problem of a Run that failed without one, and an action Run's outcome as its result. Null for any other event.
export interface RunEnd { readonly terminal?: unknown; readonly problem?: unknown; readonly result?: unknown }
export const runEnd = (e: AcpEvent): RunEnd | null => {
    if (e.type !== "RUN_FINISHED" && e.type !== "RUN_ERROR") return null;
    const plurnk = (e.metadata as { plurnk?: { terminal?: unknown; problem?: unknown } } | undefined)?.plurnk;
    return {
        ...(plurnk?.terminal === undefined ? {} : { terminal: plurnk.terminal }),
        ...(plurnk?.problem === undefined ? {} : { problem: plurnk.problem }),
        ...(e.type === "RUN_FINISHED" && e.result !== undefined ? { result: e.result } : {}),
    };
};

// Run one turn through the ACP endpoint, async-yielding each ACP event until
// the daemon ends the stream. Disconnecting, from any Run, ends only this delivery; the work
// runs on until `loop.cancel` or its own end ({§acp-run-disconnect}).
export async function* runViaAcp(
    target: AcpTarget,
    run: { threadId: string; workspace?: string; prompt?: string; messages?: RunAgentInput["messages"]; capabilities?: ClientCapabilities; connect?: boolean; resume?: ResumeEntry[]; runId?: string; forwardedProps?: Record<string, unknown> },
    signal?: AbortSignal,
): AsyncGenerator<AcpEvent> {
    const messages: RunAgentInput["messages"] = run.messages
        ?? (run.prompt !== undefined ? [{ id: crypto.randomUUID(), role: "user", content: run.prompt }] : []);
    const url = run.connect === true ? `${target.acpUrl.replace(/\/$/, "")}/connect` : target.acpUrl;
    const input: RunAgentInput = {
        threadId: run.threadId,
        runId: run.runId ?? crypto.randomUUID(),
        state: {},
        messages,
        tools: run.capabilities?.tools ?? [],
        context: [],
        ...(run.resume !== undefined ? { resume: run.resume } : {}),
        // This client's workspace-qualified binding; workspace selection is a Plurnk extension.
        // {§cli-worker-ownership} A Run that declares capabilities also states whether a person attends.
        forwardedProps: { plurnk: {
            ...(run.workspace === undefined ? {} : { workspace: run.workspace }),
            ...(run.capabilities === undefined ? {} : { interactive: run.capabilities.interactive }),
            ...(run.forwardedProps ?? {}),
        } },
    };
    for (let attempt = 0; ; attempt += 1) {
        // {§cli-credential} — the credential presents an access token, acquired on first use.
        const headers = target.credential === undefined ? {} : await target.credential.headers(target.acpUrl);
        let yielded = false;
        try {
            for await (const event of consumeRun(url, headers, input, signal)) {
                yielded = true;
                yield await withWords(event, target, signal);
            }
            return;
        } catch (error) {
            // A lapsed or revoked token is renewed once, before any event was seen, and a daemon's first
            // demand for a credential is answered once by the credential ({§cli-sign-in}); anything else is the caller's.
            if (attempt === 0 && !yielded && target.credential !== undefined
                && error instanceof ProblemError && /\/bearer-token-(?:invalid|required)$/u.test(error.problem.type)) {
                target.credential.invalidate();
                continue;
            }
            throw error;
        }
    }
}

// plurnk-service {§acp-words-by-reference}: a sender's words past the ceiling travel as one document part at the address
// that serves them. They are the message's words, so the client reads them there before anything draws the message; a
// result's body beside its receipt stays where it is (plurnk-service {§acp-body-reference}).
const wordsAddress = (content: unknown): string | null => {
    if (!Array.isArray(content) || content.length !== 1) return null;
    const part = objectOf(content[0]);
    const source = objectOf(part?.source);
    return part?.type === "document" && source?.type === "url" && typeof source.value === "string"
        && (source.mimeType === "text/plain" || source.mimeType === "text/markdown") ? source.value : null;
};

// {§cli-credential} What a daemon serves beside its Runs is read as a Run is posted: with the credential's access token,
// renewed once when the daemon says it lapsed. A refusal is the daemon's Problem.
const readServed = async (target: AcpTarget, url: string, what: string, signal?: AbortSignal): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
        const headers = target.credential === undefined ? {} : await target.credential.headers(target.acpUrl);
        try {
            const response = await problemFetch(url, { headers, ...(signal === undefined ? {} : { signal }) });
            if (!response.ok) throw new ProblemError(clientTransportResultInvalid(`${what} at ${url} answered HTTP ${response.status}.`));
            return response;
        } catch (error) {
            if (attempt === 0 && target.credential !== undefined
                && error instanceof ProblemError && /\/bearer-token-(?:invalid|required)$/u.test(error.problem.type)) {
                target.credential.invalidate();
                continue;
            }
            throw error;
        }
    }
};

const readWords = async (target: AcpTarget, url: string, signal?: AbortSignal): Promise<string> =>
    (await readServed(target, url, "The words", signal)).text();

const contentWithWords = async (content: unknown, target: AcpTarget, signal?: AbortSignal): Promise<unknown> => {
    const url = wordsAddress(content);
    return url === null ? content : readWords(target, url, signal);
};

// Messages whose words travel by reference, with their words in their place.
const messagesWithWords = <T>(messages: readonly T[], target: AcpTarget, signal?: AbortSignal): Promise<T[]> =>
    Promise.all(messages.map(async (message) => {
        const content = await contentWithWords(objectOf(message)?.content, target, signal);
        return content === objectOf(message)?.content ? message : { ...message, content };
    }));

// An event whose words travel by reference, with its words in their place: a reply's result, or a snapshot's messages.
const withWords = async (event: AcpEvent, target: AcpTarget, signal?: AbortSignal): Promise<AcpEvent> => {
    if (event.type === "TOOL_CALL_RESULT") {
        const content = await contentWithWords(event.content, target, signal);
        return content === event.content ? event : { ...event, content } as AcpEvent;
    }
    if (event.type !== "MESSAGES_SNAPSHOT") return event;
    return { ...event, messages: await messagesWithWords(event.messages, target, signal) } as AcpEvent;
};

// plurnk-service {§acp-loop-page}: one loop of a worker's conversation, whole, under the view this session's Runs
// negotiate ({§cli-provider-reasoning}), each sender's words past the ceiling read in their place.
export const readLoopPage = async (target: AcpTarget, page: { readonly workspaceId: number; readonly workerId: number; readonly threadId: string;
    readonly descendants: boolean; readonly sequence: number }, signal?: AbortSignal): Promise<unknown[]> => {
    const url = new URL(`${target.acpUrl.replace(/\/$/, "")}/${page.workspaceId}/${page.workerId}/messages`);
    url.searchParams.set("thread", page.threadId);
    if (page.descendants) url.searchParams.set("descendants", "true");
    url.searchParams.set("reasoning", "link");
    url.searchParams.set("loop", String(page.sequence));
    const body = objectOf(await (await readServed(target, url.href, "The loop page", signal)).json().catch(() => null));
    if (body === null || typeof body.final !== "boolean" || !(body.older === null || typeof body.older === "string")
        || !Array.isArray(body.messages) || !body.messages.every((message) => objectOf(message) !== null)) {
        throw new ProblemError(clientTransportResultInvalid(`The loop page at ${url.href} is not { final, messages, older }.`));
    }
    return messagesWithWords(body.messages as unknown[], target, signal);
};

const parseSseFrame = (frame: string): AcpEvent | null => {
    if (!frame.trim()) return null;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /u, ""));
        }
    }
    if (dataLines.length === 0) return null;
    const parsed: unknown = JSON.parse(dataLines.join("\n"));
    const obj = objectOf(parsed);
    if (obj === null || typeof obj.type !== "string" || obj.type.length === 0) {
        throw new Error("Invalid ACP event: frame must be a JSON object with a non-empty type.");
    }
    if ((obj.type === EventType.RUN_STARTED || obj.type === EventType.RUN_FINISHED)
        && (typeof obj.threadId !== "string" || typeof obj.runId !== "string")) {
        throw new Error("Invalid ACP event: RUN_STARTED and RUN_FINISHED require threadId and runId.");
    }
    return obj as unknown as AcpEvent;
};

async function* consumeRun(url: string, headers: Record<string, string>, input: RunAgentInput, signal?: AbortSignal): AsyncGenerator<AcpEvent> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
        let response: Response;
        try {
            response = await problemFetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "text/event-stream",
                    ...headers,
                },
                body: JSON.stringify(input),
                signal: controller.signal,
            });
        } catch (error) {
            if (objectOf(error)?.name === "AbortError") {
                yield {
                    type: EventType.RUN_ERROR,
                    message: error instanceof Error && error.message.length > 0 ? error.message : "Request aborted",
                    code: "abort",
                    rawEvent: error,
                };
                return;
            }
            throw error;
        }
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${response.statusText} - ${text}`);
        }
        if (!response.body) {
            throw new Error("Response body is empty");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: false });
        let buffer = "";
        let pendingCr = false;
        let finishedReading = false;
        const normalizeChunk = (text: string): string => {
            if (text.length === 0) return "";
            let s = text;
            if (pendingCr) {
                pendingCr = false;
                s = s.startsWith("\n") ? `\n${s.slice(1)}` : `\n${s}`;
            }
            if (s.endsWith("\r")) {
                pendingCr = true;
                s = s.slice(0, -1);
            }
            return s.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
        };
        try {
            for (;;) {
                let readResult: { done: boolean; value?: Uint8Array };
                try {
                    readResult = await reader.read();
                } catch (error) {
                    finishedReading = true;
                    if (objectOf(error)?.name === "AbortError") {
                        yield {
                            type: EventType.RUN_ERROR,
                            message: error instanceof Error && error.message.length > 0 ? error.message : "Request aborted",
                            code: "abort",
                            rawEvent: error,
                        };
                        return;
                    }
                    throw error;
                }
                const { done, value } = readResult;
                if (done) {
                    finishedReading = true;
                    buffer += normalizeChunk(decoder.decode());
                    if (pendingCr) {
                        buffer += "\n";
                        pendingCr = false;
                    }
                    if (buffer.length > 0) {
                        const trailing = parseSseFrame(buffer);
                        if (trailing !== null) yield trailing;
                    }
                    return;
                }
                if (value) {
                    buffer += normalizeChunk(decoder.decode(value, { stream: true }));
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop() ?? "";
                    for (const part of parts) {
                        const ev = parseSseFrame(part);
                        if (ev !== null) yield ev;
                    }
                }
            }
        } finally {
            if (!finishedReading) {
                void reader.cancel().catch(() => {});
            }
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        controller.abort();
    }
}

// ACP+ verb surface (§3): a management action rides its own run —
// forwardedProps.plurnk.action in, its outcome out as RUN_FINISHED's result.
// The run envelope is the interface.
export const actionViaAcp = async <T = unknown>(
    target: AcpTarget,
    req: {
        threadId: string;
        workspace?: string;
        workspaceOptions?: Record<string, unknown>;
        kind: string;
        params?: object;
    },
    signal?: AbortSignal,
): Promise<T> => {
    for await (const e of runViaAcp(target, {
        threadId: req.threadId,
        ...(req.workspace !== undefined ? { workspace: req.workspace } : {}),
        messages: [],
        forwardedProps: {
            ...(req.workspaceOptions ?? {}),
            action: { kind: req.kind, ...(req.params ?? {}) },
        },
    }, signal)) {
        const end = runEnd(e);
        if (end?.problem !== undefined) throw new ProblemError(problemDetails(end.problem));
        if (end?.result !== undefined) {
            const v = actionOutcome<T>(end.result);
            if (!v.ok) throw new ProblemError(v.problem);
            return v.result as T;
        }
    }
    throw new ProblemError(clientActionResultMissing(req.kind));
};
