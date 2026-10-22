// The Node consumer of the daemon's AG-UI endpoint. Terminal clients POST a run
// to it and consume the AG-UI SSE projection. This module mirrors the
// standard AG-UI HTTP/SSE transport: POST /agui for runs, including interrupt
// resolution through RunAgentInput.resume.
//
// The official HttpAgent owns HTTP/SSE parsing. AG-UI 1.0 made event validation
// opt-in, so the run is piped through the SDK's own enforceEvents operator — a
// malformed event fails the stream here instead of rendering as if it were real.
// This adapter otherwise only preserves the client's async-iterator surface;
// rendering (waterfall, proposals, gauge) stays local. Plurnk fidelity rides standard metadata where AG-UI holds
// the fact (a Run's end, the parts a row builds: plurnk-service {§agui-plurnk-metadata}) and CUSTOM plurnk.* events
// for what has no standard subject (a row outside the conversation rides plurnk.ambient whole).

import type { ClientCapabilities } from "./client-capabilities.ts";
import type { ClientCredential } from "./credential.ts";
import { enforceEvents, HttpAgent } from "@ag-ui/client";
import type { AGUIEvent, ResumeEntry, RunAgentInput } from "@ag-ui/core";
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

export type AguiEvent = AGUIEvent;

export interface AguiTarget { aguiUrl: string; credential?: ClientCredential }
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

const problemFetch = async (url: string, requestInit: RequestInit): Promise<Response> => {
    const response = await fetch(url, requestInit);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (!response.ok && mediaType === "application/problem+json") {
        const problem = problemDetails(await response.clone().json());
        throw new ProblemError(problem);
    }
    if (mediaType !== "text/event-stream" || response.body === null) return response;

    // The SSE line grammar admits CRLF, LF, and CR. @ag-ui/client currently
    // accepts the first two but silently drops CR-only frames, so normalize only
    // line-ending bytes before its otherwise-authoritative event parser. Track a
    // trailing CR across chunks to avoid turning a split CRLF into two newlines.
    let pendingCr = false;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            const normalized: number[] = [];
            for (const byte of chunk) {
                if (pendingCr) {
                    normalized.push(0x0a);
                    pendingCr = false;
                    if (byte === 0x0a) continue;
                }
                if (byte === 0x0d) pendingCr = true;
                else normalized.push(byte);
            }
            if (normalized.length > 0) controller.enqueue(Uint8Array.from(normalized));
        },
        flush(controller) {
            if (pendingCr) controller.enqueue(Uint8Array.of(0x0a));
        },
    }));
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
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

// What a Run's end carries beyond its outcome (plurnk-service {§agui-plurnk-metadata}): the bound loop's terminal record,
// the exact Problem of a Run that failed without one, and an action Run's outcome as its result. Null for any other event.
export interface RunEnd { readonly terminal?: unknown; readonly problem?: unknown; readonly result?: unknown }
export const runEnd = (e: AguiEvent): RunEnd | null => {
    if (e.type !== "RUN_FINISHED" && e.type !== "RUN_ERROR") return null;
    const plurnk = (e.metadata as { plurnk?: { terminal?: unknown; problem?: unknown } } | undefined)?.plurnk;
    return {
        ...(plurnk?.terminal === undefined ? {} : { terminal: plurnk.terminal }),
        ...(plurnk?.problem === undefined ? {} : { problem: plurnk.problem }),
        ...(e.type === "RUN_FINISHED" && e.result !== undefined ? { result: e.result } : {}),
    };
};

// Run one turn through the AG-UI endpoint, async-yielding each AG-UI event until
// the daemon ends the stream. Disconnecting, from any Run, ends only this delivery; the work
// runs on until `loop.cancel` or its own end ({§agui-run-disconnect}).
export async function* runViaAgui(
    target: AguiTarget,
    run: { threadId: string; workspace?: string; prompt?: string; messages?: RunAgentInput["messages"]; capabilities?: ClientCapabilities; connect?: boolean; resume?: ResumeEntry[]; runId?: string; forwardedProps?: Record<string, unknown> },
    signal?: AbortSignal,
): AsyncGenerator<AguiEvent> {
    const messages: RunAgentInput["messages"] = run.messages
        ?? (run.prompt !== undefined ? [{ id: crypto.randomUUID(), role: "user", content: run.prompt }] : []);
    const url = run.connect === true ? `${target.aguiUrl.replace(/\/$/, "")}/connect` : target.aguiUrl;
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
        const headers = target.credential === undefined ? {} : await target.credential.headers(target.aguiUrl);
        const agent = new HttpAgent({ url, fetch: problemFetch, headers });
        let yielded = false;
        try {
            for await (const event of consumeRun(agent, input, signal)) {
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

// plurnk-service {§agui-words-by-reference}: a sender's words past the ceiling travel as one document part at the address
// that serves them. They are the message's words, so the client reads them there before anything draws the message; a
// result's body beside its receipt stays where it is (plurnk-service {§agui-body-reference}).
const wordsAddress = (content: unknown): string | null => {
    if (!Array.isArray(content) || content.length !== 1) return null;
    const part = objectOf(content[0]);
    const source = objectOf(part?.source);
    return part?.type === "document" && source?.type === "url" && typeof source.value === "string"
        && (source.mimeType === "text/plain" || source.mimeType === "text/markdown") ? source.value : null;
};

// {§cli-credential} What a daemon serves beside its Runs is read as a Run is posted: with the credential's access token,
// renewed once when the daemon says it lapsed. A refusal is the daemon's Problem.
const readServed = async (target: AguiTarget, url: string, what: string, signal?: AbortSignal): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
        const headers = target.credential === undefined ? {} : await target.credential.headers(target.aguiUrl);
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

const readWords = async (target: AguiTarget, url: string, signal?: AbortSignal): Promise<string> =>
    (await readServed(target, url, "The words", signal)).text();

const contentWithWords = async (content: unknown, target: AguiTarget, signal?: AbortSignal): Promise<unknown> => {
    const url = wordsAddress(content);
    return url === null ? content : readWords(target, url, signal);
};

// Messages whose words travel by reference, with their words in their place.
const messagesWithWords = <T>(messages: readonly T[], target: AguiTarget, signal?: AbortSignal): Promise<T[]> =>
    Promise.all(messages.map(async (message) => {
        const content = await contentWithWords(objectOf(message)?.content, target, signal);
        return content === objectOf(message)?.content ? message : { ...message, content };
    }));

// An event whose words travel by reference, with its words in their place: a reply's result, or a snapshot's messages.
const withWords = async (event: AguiEvent, target: AguiTarget, signal?: AbortSignal): Promise<AguiEvent> => {
    if (event.type === "TOOL_CALL_RESULT") {
        const content = await contentWithWords(event.content, target, signal);
        return content === event.content ? event : { ...event, content } as AguiEvent;
    }
    if (event.type !== "MESSAGES_SNAPSHOT") return event;
    return { ...event, messages: await messagesWithWords(event.messages, target, signal) } as AguiEvent;
};

// plurnk-service {§agui-loop-page}: one loop of a worker's conversation, whole, under the view this session's Runs
// negotiate ({§cli-provider-reasoning}), each sender's words past the ceiling read in their place.
export const readLoopPage = async (target: AguiTarget, page: { readonly workspaceId: number; readonly workerId: number; readonly threadId: string;
    readonly descendants: boolean; readonly sequence: number }, signal?: AbortSignal): Promise<unknown[]> => {
    const url = new URL(`${target.aguiUrl.replace(/\/$/, "")}/${page.workspaceId}/${page.workerId}/messages`);
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

async function* consumeRun(agent: HttpAgent, input: RunAgentInput, signal?: AbortSignal): AsyncGenerator<AguiEvent> {
    type QueueItem =
        | { kind: "event"; event: AguiEvent }
        | { kind: "error"; error: unknown }
        | { kind: "done" };
    const queue: QueueItem[] = [];
    let wake: (() => void) | null = null;
    const push = (item: QueueItem) => {
        queue.push(item);
        wake?.();
        wake = null;
    };
    const onAbort = () => agent.abortRun();
    signal?.addEventListener("abort", onAbort, { once: true });
    const subscription = agent.run(input).pipe(enforceEvents()).subscribe({
        // enforceEvents parses each BaseEvent against the standard schema; AGUIEvent
        // is @ag-ui/core's narrower discriminated view of that validated value.
        next: (event) => push({ kind: "event", event: event as AguiEvent }),
        error: (error) => push({ kind: "error", error }),
        complete: () => push({ kind: "done" }),
    });
    if (signal?.aborted) onAbort();
    try {
        for (;;) {
            if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            const item = queue.shift()!;
            if (item.kind === "event") {
                yield item.event;
                continue;
            }
            if (item.kind === "error") {
                throw item.error instanceof Error ? item.error : new Error(String(item.error));
            }
            return;
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        subscription.unsubscribe();
        agent.abortRun();
    }
}

// AG-UI+ verb surface (§3): a management action rides its own run —
// forwardedProps.plurnk.action in, its outcome out as RUN_FINISHED's result.
// The run envelope is the interface.
export const actionViaAgui = async <T = unknown>(
    target: AguiTarget,
    req: {
        threadId: string;
        workspace?: string;
        workspaceOptions?: Record<string, unknown>;
        kind: string;
        params?: object;
    },
    signal?: AbortSignal,
): Promise<T> => {
    for await (const e of runViaAgui(target, {
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
