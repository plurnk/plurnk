// The TUI's AG-UI transport. Model and action runs share presentation handlers,
// not stream state or interrupt ownership ({§cli-active-command-admission}).

import type { Descendant, OutsideText } from "./render.ts";
import type { LogEntryWire, LoopUsage } from "./render.ts";
import { proposalResume, type ProposalParams, type Resolution } from "./proposal.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import type { Notice } from "./diagnostics.ts";
import {
    ProblemError,
    clientTransportCancelled,
    clientTransportInterruptMismatch,
    clientTransportProblemMissing,
    clientTransportProposalInvalid,
    clientTransportTerminalMissing,
    clientActionResultMissing,
    clientTransportResultInvalid,
    type ProblemDetails,
} from "./diagnostics.ts";
import type { ApplicationPort, OperationResult } from "@plurnk/plurnk-contracts";
import { clientCapabilities } from "./client-capabilities.ts";
import type { Message } from "@ag-ui/core";
import { createHash } from "node:crypto";
import { runViaAgui, actionOutcome, operationResult, problemDetails, type AguiEvent, type AguiTarget } from "./agui.ts";
import ReasoningEvents, { type ReasoningUpdate } from "./reasoning-events.ts";
import { reduceStatusGauge, type StatusGaugeEnvelope } from "./status.ts";

// The terminal outcome projected by plurnk.terminated.
export interface TerminatedInfo {
    loopId?: number;
    workerId?: number;
    finalStatus: number;
    hitMaxTurns: boolean;
    turnIds?: number[];
    usage?: LoopUsage;
    workspaceId?: number | null;
    result: OperationResult;
}


// The run's status gauge — the AG-UI state the daemon snapshots on RUN_STARTED and
// patches per packet, termination, and derivation (plurnk-agui SPEC, `loop/packet`).
export type StatusGauge = StatusGaugeEnvelope;

// Run-plane events projected into the client's presentation shapes.
export interface RunHandlers {
    onEntry: (entry: LogEntryWire) => void;
    onHistory?: (history: ConversationHistory) => void;
    onReasoning: (reasoning: ReasoningUpdate) => void;
    onProposal: (p: ProposalParams, source?: "model" | "action") => void;
    onInterruptEnd?: (id: string) => void;
    onInteraction?: (i: {
        interactionId: number;
        toolName: string;
        arguments: Record<string, unknown>;
        message: string;
        responseSchema: Record<string, unknown>;
    }) => void;
    onStream: (payload: StreamEventPayload | StreamConcludedPayload) => void;
    onDescendant?: (descendant: Descendant) => void;   // {plurnk#108} — a delegation observation's introduction
    onOutside: (outside: OutsideText) => void;   // {§cli-outside-text} — the turn's prose outside its fences
    onNotice: (notice: Notice) => void;
    onProblem?: (problem: ProblemDetails) => void;
    onStatus?: (gauge: StatusGauge) => void;
    onTerminated: (t: TerminatedInfo) => void;
}

export interface RunHandle { done: Promise<TerminatedInfo>; ready: Promise<void>; cancel: () => void }
export interface ObservationHandle { done: Promise<TerminatedInfo | null>; ready: Promise<void>; cancel: () => void }
export interface ConversationHistory {
    entries: LogEntryWire[];
    messages: Message[];
    attachment: boolean;
}
export interface ObserveOpts { historyLimit: number }
export type LoopAdmission = Awaited<ReturnType<ApplicationPort["runLoop"]>>;

type ProposalResolution = Resolution & { logEntryId: number };
type InteractionResolution = Record<string, unknown> | "cancel";
type StreamProjection = { gauge: StatusGauge | null; reasoning: ReasoningEvents };
interface PendingInterrupt<T> {
    readonly signal: AbortSignal;
    readonly settle: (value: T | undefined) => void;
    readonly release: () => void;
    decided: boolean;
}

// The knobs one prompt's loop carries. Model and child-model selection are durable
// worker policy, changed through worker.model.set / worker.child.set rather than
// reasserted on individual runs.
export interface RunOpts { maxTurns?: number; openPaths?: string[] }

export interface Transport {
    rpc<T = unknown>(method: string, params?: object): Promise<T>;
    subscribe(handlers: RunHandlers): void;
    run(prompt: string, opts: RunOpts): RunHandle;
    observe(opts?: ObserveOpts): ObservationHandle;
    inject(prompt: string): Promise<LoopAdmission>;
    resolve(r: { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string; outcome?: string }): Promise<void>;
    resolveInteraction(interactionId: number, payload: Record<string, unknown> | "cancel"): Promise<void>;
    shutdown(): void;   // abort every in-flight request on an intentional quit
    // Switch to (or create) a named workspace by re-mapping the threadId; the daemon
    // creates the workspace on the next run. Returns the workspace handle for the header.
    useWorkspace(name: string | undefined, params: { projectRoot?: string | null }): Promise<{ name: string }>;
    // Rebind this session's conversation to a worker by name, keeping the world:
    // the daemon binds an existing conversation or mints a fresh one on the next
    // run — the same path `--worker` takes at invocation ({§cli-workers-topology}).
    useWorker(name: string, world: string): void;
    // The conversation this transport speaks for: the AG-UI threadId the daemon sources this
    // client's arrivals to (plurnk-service #706), so the TUI can tell its own messages apart.
    threadId(): string;
}

// Model and sync Runs share event projection and interrupt handling. An idle sync
// can finish without a loop terminal; it cannot manufacture accounting evidence.
// Workspace options that ride forwardedProps.plurnk on the thread's FIRST run
// (§agui-forwarded-props) — the daemon applies them at workspace creation.
export interface AguiTransportOpts { workspace?: string; projectRoot?: string | null; settings?: object; descendants?: boolean; auto?: boolean }

export class AguiTransport implements Transport {
    #target: AguiTarget;
    #threadId: string;
    #world: string | undefined;   // the workspace name when it differs from the thread (--worker)
    #workspace: AguiTransportOpts;
    #h: RunHandlers | null = null;
    #modelProjection: StreamProjection | null = null;
    #pendingProposals = new Map<number, PendingInterrupt<ProposalResolution>>();
    #pendingInteractions = new Map<number, PendingInterrupt<InteractionResolution>>();
    #controllers = new Set<AbortController>();
    #seenRows = new Map<number, string>();
    #lastConversationRowId = 0;
    #lastLoopId: number | null = null;

    constructor(target: AguiTarget, threadId: string, workspace: AguiTransportOpts = {}) {
        this.#target = target;
        this.#threadId = threadId;
        this.#world = workspace.workspace;
        this.#workspace = workspace;
    }

    threadId(): string { return this.#threadId; }

    // PLURNK verbs ride namespaced actions inside standard AG-UI runs.
    // A verb is a §3 action run — and its stream ALSO carries whatever the dispatch
    // emitted (a raw-DSL op's rows, notices, streams). Feed those through the same
    // persistent handlers a run uses (e.g. the Alt-p cycler harvests targets from
    // onEntry).
    async rpc<T>(method: string, params?: object): Promise<T> {
        const ac = new AbortController();
        this.#controllers.add(ac);
        try {
            return await this.#action<T>(method, params, ac.signal);
        } finally {
            ac.abort();
            this.#controllers.delete(ac);
        }
    }

    async #action<T>(method: string, params: object | undefined, signal: AbortSignal,
        binding = { threadId: this.#threadId, workspace: this.#world }): Promise<T> {
        const projection: StreamProjection = { gauge: null, reasoning: new ReasoningEvents() };
        let result: T | undefined;
        let problem: ProblemDetails | undefined;
        let sawResult = false;
        let next: { messages?: []; forwardedProps?: Record<string, unknown>; resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }> } = {
            messages: [],
            forwardedProps: { ...this.#workspaceOpts(), action: { kind: method, ...(params ?? {}) } },
        };
        for (;;) {
            let pausedProp: number | null = null;
            let proposalResolution: Promise<ProposalResolution | undefined> | null = null;
            let interrupted = false;
            let toolId = "";
            let toolArgs = "";
            for await (const e of runViaAgui(this.#target, {
                ...binding,
                ...next,
                capabilities: clientCapabilities(this.#workspace.auto !== true),
            }, signal)) {
                if (e.type === "CUSTOM" && (e as { name?: unknown }).name === "plurnk.action.result") {
                    const v = actionOutcome<T>((e as { value?: unknown }).value);
                    sawResult = true;
                    if (v.ok) result = v.result; else problem = v.problem;
                    continue;
                }
                if (e.type === "TOOL_CALL_START") {
                    toolId = String((e as { toolCallId?: unknown }).toolCallId ?? "");
                    toolArgs = "";
                    continue;
                }
                if (e.type === "TOOL_CALL_ARGS" && toolId.startsWith("prop:")) {
                    toolArgs += String((e as { delta?: unknown }).delta ?? "");
                    continue;
                }
                if (e.type === "TOOL_CALL_END" && toolId.startsWith("prop:")) {
                    pausedProp = Number(toolId.slice(5));
                    let args: Record<string, unknown>;
                    try {
                        args = JSON.parse(toolArgs.length > 0 ? toolArgs : "{}") as Record<string, unknown>;
                    } catch (cause) {
                        const invalid = clientTransportProposalInvalid(pausedProp, cause);
                        this.#h?.onProblem?.(invalid);
                        throw new ProblemError(invalid);
                    }
                    proposalResolution = this.#interrupt(this.#pendingProposals, pausedProp, signal, "Proposal");
                    this.#h?.onProposal({ ...args, logEntryId: pausedProp } as unknown as ProposalParams, "action");
                    continue;
                }
                if (e.type === "RUN_FINISHED") {
                    interrupted = e.outcome?.type === "interrupt"
                        && e.outcome.interrupts.some((interrupt) => interrupt.id === toolId || interrupt.toolCallId === toolId);
                    continue;
                }
                this.#dispatch(e, projection);
            }
            if (problem !== undefined) throw new ProblemError(problem);
            if (sawResult) return result as T;
            if (pausedProp === null) throw new ProblemError(clientActionResultMissing(method));
            if (!interrupted) throw new ProblemError(clientTransportInterruptMismatch(`prop:${pausedProp}`));
            if (proposalResolution === null) throw new Error("proposal ended without a resolution channel");
            const resolution = await proposalResolution;
            signal.throwIfAborted();
            if (resolution === undefined) throw new Error("proposal ended without a resolution");
            next = { resume: [proposalResume(resolution.logEntryId, resolution)] };
        }
    }
    subscribe(handlers: RunHandlers): void { this.#h = handlers; }
    shutdown(): void { for (const ac of this.#controllers) ac.abort(); }

    // Workspace options on every request (#140): workspace creation and
    // its projectRoot are ATOMIC — the module creates from whichever request arrives
    // first, so every request carries the options (applied at creation, ignored after).
    // No consumed-once flag, no race: a headless workspace can only be one on purpose,
    // and it stays headless forever (root changes are unimplemented by design).
    #workspaceOpts(): Record<string, unknown> {
        return {
            ...(this.#workspace.projectRoot !== undefined ? { projectRoot: this.#workspace.projectRoot } : {}),
            ...(this.#workspace.settings !== undefined && Object.keys(this.#workspace.settings).length > 0 ? { settings: this.#workspace.settings } : {}),
        };
    }

    run(prompt: string, opts: RunOpts): RunHandle {
        const handle = this.#run(prompt, opts);
        return { ...handle, done: handle.done.then((terminal) => {
            if (terminal === null) throw new ProblemError(clientTransportTerminalMissing());
            return terminal;
        }) };
    }

    observe(opts?: ObserveOpts): ObservationHandle { return this.#run(undefined, undefined, opts); }

    #run(prompt?: string, opts?: RunOpts, observation?: ObserveOpts): ObservationHandle {
        const binding = { threadId: this.#threadId, workspace: this.#world };
        const sinceId = this.#lastConversationRowId;
        const ac = new AbortController();
        this.#controllers.add(ac);
        const projection: StreamProjection = { gauge: null, reasoning: new ReasoningEvents() };
        this.#modelProjection = projection;
        const ready = Promise.withResolvers<void>();
        // Both promises report the same failed run. Consumers that only await done
        // must not acquire an unhandled rejection from the readiness view.
        void ready.promise.catch(() => {});
        // Every request carries workspace options (#workspaceOpts — see #140); every
        // run forwards per-run knobs.
        const fwd: Record<string, unknown> = {
            ...this.#workspaceOpts(),
            // {plurnk#108} — a session that observes its delegation asks on every conversation run.
            ...(this.#workspace.descendants === true ? { descendants: true } : {}),
            control: true,
            ...(opts === undefined ? { mode: "sync" } : {
                ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
                ...(opts.openPaths !== undefined ? { openPaths: opts.openPaths } : {}),
            }),
        };
        const forwardedProps = Object.keys(fwd).length > 0 ? fwd : undefined;
        // AG-UI interrupt/resume: a stopped-world ends the run as a
        // request_approval/request_user_input TOOL_CALL (the loop stays paused
        // in-engine). resolve() supplies the decision; we POST a standard resume as the
        // resume run and keep consuming — done spans the whole pause/resume chain, so
        // the TUI's seam contract never changes.
        const done = (async (): Promise<TerminatedInfo | null> => {
            let terminated: TerminatedInfo | null = null;
            let sawRunError = false;
            let runProblem: ProblemDetails | null = null;
            let next: { prompt?: string; resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }> } = { prompt };
            let fp = forwardedProps;
            for (;;) {
                let pausedProp: number | null = null;
                let pausedInteraction: number | null = null;
                let proposalResolution: Promise<ProposalResolution | undefined> | null = null;
                let interactionResolution: Promise<InteractionResolution | undefined> | null = null;
                let joined: AbortSignal | undefined;
                let interrupted = false;
                let observed = false;
                let toolId = "";
                let toolName = "";
                let toolArgs = "";
                let interactionArguments: Record<string, unknown> | null = null;
                try {
                    const events = runViaAgui(this.#target, {
                        ...binding, ...next, forwardedProps: fp, capabilities: clientCapabilities(this.#workspace.auto !== true),
                        connect: prompt === undefined && next.resume === undefined,
                    }, ac.signal);
                    const synchronized = fp?.mode === "sync"
                        ? this.#synchronize(events, binding, ac.signal, sinceId, observation, ready.resolve)
                        : events;
                    for await (const e of synchronized) {
                        if (fp?.mode !== "sync") ready.resolve();
                        if (e.type === "RUN_ERROR") {
                            sawRunError = true;
                        } else if (e.type === "RUN_FINISHED") {
                            const outcome = e.outcome;
                            observed = outcome?.type === "success";
                            const interrupt = outcome?.type === "interrupt"
                                ? outcome.interrupts.find((candidate) => candidate.id === toolId || candidate.toolCallId === toolId)
                                : undefined;
                            interrupted = interrupt !== undefined;
                            if (pausedInteraction !== null && interrupt !== undefined && interactionArguments !== null) {
                                const interactionId = pausedInteraction;
                                joined = this.#pendingInteractions.get(interactionId)?.signal;
                                if (joined !== undefined) continue;
                                interactionResolution = this.#interrupt(this.#pendingInteractions, interactionId, ac.signal, "Interaction");
                                this.#h?.onInteraction?.({
                                    interactionId,
                                    toolName,
                                    arguments: interactionArguments,
                                    message: typeof interrupt.message === "string"
                                        ? interrupt.message
                                        : "Provide the requested input.",
                                    responseSchema: interrupt.responseSchema ?? {},
                                });
                            }
                        } else if (e.type === "TOOL_CALL_START") {
                            toolId = String((e as { toolCallId?: unknown }).toolCallId ?? "");
                            toolName = String((e as { toolCallName?: unknown }).toolCallName ?? "");
                            toolArgs = "";
                        } else if (e.type === "TOOL_CALL_ARGS" && (toolId.startsWith("prop:") || toolId.startsWith("int:"))) {
                            toolArgs += String((e as { delta?: unknown }).delta ?? "");
                        } else if (e.type === "TOOL_CALL_END" && toolId.startsWith("int:")) {
                            pausedInteraction = Number(toolId.slice(4));
                            try {
                                interactionArguments = JSON.parse(toolArgs.length > 0 ? toolArgs : "{}") as Record<string, unknown>;
                            } catch (cause) {
                                const problem = clientTransportProposalInvalid(pausedInteraction, cause);
                                this.#h?.onProblem?.(problem);
                                return {
                                    finalStatus: problem.status,
                                    hitMaxTurns: false,
                                    result: operationResult({ status: problem.status, problem }),
                                };
                            }
                        } else if (e.type === "TOOL_CALL_END" && toolId.startsWith("prop:")) {
                            pausedProp = Number(toolId.slice(5));
                            let a: Record<string, unknown>;
                            try {
                                a = JSON.parse(toolArgs.length > 0 ? toolArgs : "{}") as Record<string, unknown>;
                            } catch (cause) {
                                const problem = clientTransportProposalInvalid(pausedProp, cause);
                                this.#h?.onProblem?.(problem);
                                return {
                                    finalStatus: problem.status,
                                    hitMaxTurns: false,
                                    result: operationResult({ status: problem.status, problem }),
                                };
                            }
                            joined = this.#pendingProposals.get(pausedProp)?.signal;
                            if (joined !== undefined) continue;
                            proposalResolution = this.#interrupt(this.#pendingProposals, pausedProp, ac.signal, "Proposal");
                            this.#h?.onProposal({ ...a, logEntryId: pausedProp } as unknown as ProposalParams, "model");
                        } else {
                            const t = this.#dispatch(e, projection);
                            if (t !== null) terminated = t;
                            if ((e as { name?: unknown }).name === "plurnk.problem") {
                                runProblem = problemDetails((e as { value?: unknown }).value);
                            }
                        }
                    }
                } catch (err) {
                    if (ac.signal.aborted) {
                        const problem = clientTransportCancelled();
                        return terminated ?? {
                            finalStatus: problem.status,
                            hitMaxTurns: false,
                            result: operationResult({ status: problem.status, problem }),
                        };
                    }
                    throw err;
                }
                // HttpAgent reports abort through the event stream and then completes;
                // cancellation is therefore observed here rather than necessarily in
                // the catch path. The transport contract remains a clean 499 outcome.
                if (ac.signal.aborted) {
                    const problem = clientTransportCancelled();
                    return terminated ?? {
                        finalStatus: problem.status,
                        hitMaxTurns: false,
                        result: operationResult({ status: problem.status, problem }),
                    };
                }
                if (terminated !== null) return terminated;
                if ((pausedProp !== null || pausedInteraction !== null) && !interrupted) {
                    const problem = clientTransportInterruptMismatch(pausedProp === null ? `int:${pausedInteraction}` : `prop:${pausedProp}`);
                    this.#h?.onProblem?.(problem);
                    return {
                        finalStatus: problem.status,
                        hitMaxTurns: false,
                        result: operationResult({ status: problem.status, problem }),
                    };
                }
                if (pausedProp === null && pausedInteraction === null) {
                    if (prompt === undefined && observed && !sawRunError && runProblem === null) return null;
                    // NO fabricated success (fabrication audit, 2026-07-11): a stream that
                    // ends without terminal truth is a broken wire — 502, never 200.
                    const problem = runProblem
                        ?? (sawRunError ? clientTransportProblemMissing() : clientTransportTerminalMissing());
                    return {
                        finalStatus: problem.status,
                        hitMaxTurns: false,
                        result: operationResult({ status: problem.status, problem }),
                    };
                }
                if (joined !== undefined) {
                    // One resolver per interrupt in this client; a reconnect may
                    // resurface a gate already held by a concurrent action Run.
                    const completed = AbortSignal.any([joined, ac.signal]);
                    if (!completed.aborted) await new Promise<void>((resolve) => completed.addEventListener("abort", () => resolve(), { once: true }));
                    ac.signal.throwIfAborted();
                    next = {};
                    fp = { ...forwardedProps, mode: "sync" };
                    continue;
                }
                if (proposalResolution === null && interactionResolution === null) throw new Error("paused run ended without a resolution channel");
                if (interactionResolution !== null && pausedInteraction !== null) {
                    const a = await interactionResolution;
                    ac.signal.throwIfAborted();
                    if (a === undefined) throw new Error("interaction ended without a resolution");
                    next = a === "cancel"
                        ? { resume: [{ interruptId: `int:${pausedInteraction}`, status: "cancelled" }] }
                        : { resume: [{ interruptId: `int:${pausedInteraction}`, status: "resolved", payload: a }] };
                    fp = undefined;
                    continue;
                }
                if (proposalResolution === null) throw new Error("proposal ended without a resolution channel");
                // Paused: hold done open until the client resolves, then resume the interrupt.
                const r = await proposalResolution;
                ac.signal.throwIfAborted();
                if (r === undefined) throw new Error("proposal ended without a resolution");
                next = { resume: [proposalResume(r.logEntryId, r)] };
                fp = undefined;
            }
        })().then((terminal) => {
            ready.resolve();
            return terminal;
        }).catch((cause: unknown): TerminatedInfo => {
            ready.reject(cause);
            if (!ac.signal.aborted) throw cause;
            const problem = clientTransportCancelled();
            return { finalStatus: problem.status, hitMaxTurns: false, result: operationResult({ status: problem.status, problem }) };
        }).finally(() => {
            ac.abort();
            this.#controllers.delete(ac);
            if (this.#modelProjection === projection) this.#modelProjection = null;
        });
        return { done, ready: ready.promise, cancel: () => ac.abort() };
    }

    // {§cli-conversation-history}: establish the historical prefix before releasing
    // live events. Neither replay nor its action run owns lifecycle/accounting.
    async *#synchronize(events: AsyncIterable<AguiEvent>, binding: { threadId: string; workspace: string | undefined },
        signal: AbortSignal, sinceId: number, opts: ObserveOpts | undefined, ready: () => void): AsyncGenerator<AguiEvent> {
        let restored = false;
        const pending: AguiEvent[] = [];
        for await (const event of events) {
            if (restored || event.type === "RUN_STARTED" || event.type === "STATE_SNAPSHOT") {
                yield event;
                continue;
            }
            if (event.type !== "MESSAGES_SNAPSHOT") {
                pending.push(event);
                continue;
            }
            const limit = Math.max(1, opts?.historyLimit ?? 1000);
            const afterId = Math.min(sinceId, this.#lastConversationRowId);
            const history = await this.#action<{ entries: LogEntryWire[] }>("log.read", {
                ...(opts === undefined ? { sinceId: afterId } : {}), limit,
            }, signal, binding);
            if (history === null || !Array.isArray(history.entries) || history.entries.length > limit
                || opts === undefined && history.entries.length === limit
                || history.entries.some((entry) => !Number.isSafeInteger(entry?.id) || entry.id <= (opts === undefined ? afterId : 0))) {
                throw new ProblemError(clientTransportResultInvalid("log.read did not supply a complete bounded history window."));
            }
            const entries = history.entries.toSorted((a, b) => a.id - b.id)
                .filter((entry) => this.#seenRows.get(entry.id) !== this.#rowVersion(entry));
            for (const entry of entries) {
                this.#seenRows.set(entry.id, this.#rowVersion(entry));
                this.#lastConversationRowId = Math.max(this.#lastConversationRowId, entry.id);
            }
            this.#h?.onHistory?.({ entries: opts?.historyLimit === 0 ? [] : entries, messages: event.messages, attachment: opts !== undefined });
            restored = true;
            ready();
            yield* pending;
            pending.length = 0;
        }
        if (!restored) {
            yield* pending;
            if (pending.some((event) => event.type === "RUN_FINISHED" && event.outcome?.type === "success")) {
                throw new ProblemError(clientTransportResultInvalid("Conversation synchronization omitted MESSAGES_SNAPSHOT."));
            }
        }
    }

    async inject(prompt: string): Promise<LoopAdmission> {
        const admission = await this.rpc<LoopAdmission>("loop.inject", { prompt });
        operationResult(admission);
        if (!Number.isSafeInteger(admission.loopId) || admission.loopId <= 0
            || !["injected_next_turn", "enqueued_new_loop"].includes(admission.action)) {
            throw new ProblemError(clientTransportResultInvalid("loop.inject omitted its loop identity or admission disposition."));
        }
        return admission;
    }
    async resolve(r: Parameters<Transport["resolve"]>[0]): Promise<void> {
        // Terminate-resume: the decision releases the paused run loop, which POSTs the
        // standard resume. No paused run = a contract violation — fail hard.
        const pending = this.#pendingProposals.get(r.logEntryId);
        if (pending === undefined || pending.decided) throw new Error(`Proposal ${r.logEntryId} has no pending AG-UI interrupt.`);
        pending.settle(r);
    }
    #interrupt<T>(pending: Map<number, PendingInterrupt<T>>, id: number, signal: AbortSignal, kind: string): Promise<T | undefined> {
        if (pending.has(id)) throw new Error(`${kind} ${id} already has a pending AG-UI interrupt.`);
        return new Promise((resolve) => {
            const completed = new AbortController();
            const settle = (value: T | undefined): void => {
                if (entry.decided) return;
                entry.decided = true;
                resolve(value);
                this.#h?.onInterruptEnd?.(`${kind === "Proposal" ? "prop" : "int"}:${id}`);
            };
            const release = (): void => {
                pending.delete(id);
                signal.removeEventListener("abort", cancel);
                completed.abort();
            };
            const entry = { signal: completed.signal, settle, release, decided: false };
            const cancel = (): void => { settle(undefined); release(); };
            pending.set(id, entry);
            if (signal.aborted) cancel();
            else signal.addEventListener("abort", cancel, { once: true });
        });
    }
    async resolveInteraction(interactionId: number, payload: Record<string, unknown> | "cancel"): Promise<void> {
        const pending = this.#pendingInteractions.get(interactionId);
        if (pending === undefined || pending.decided) throw new Error(`Interaction ${interactionId} has no pending AG-UI interrupt.`);
        pending.settle(payload);
    }
    async useWorkspace(name: string | undefined, params: Parameters<Transport["useWorkspace"]>[1]): Promise<{ name: string }> {
        // Re-map to a fresh WORLD: the thread and the workspace move together (a /workspace
        // switch is a new world + its default conversation; a split thread comes from
        // --worker at invocation, not from this verb). Lazy-created on the next run.
        const threadId = name ?? `tui-${crypto.randomUUID().slice(0, 8)}`;
        this.#workspace = {
            ...this.#workspace,
            ...(params.projectRoot === undefined ? {} : { projectRoot: params.projectRoot }),
        };
        this.#threadId = threadId;
        this.#world = undefined;   // thread == world again
        this.#seenRows.clear();
        this.#lastConversationRowId = 0;
        this.#lastLoopId = null;
        return { name: threadId };
    }
    useWorker(name: string, world: string): void {
        this.#threadId = name;
        this.#world = world;
        this.#seenRows.clear();
        this.#lastConversationRowId = 0;
        this.#lastLoopId = null;
    }

    #row(entry: LogEntryWire, conversation: boolean): void {
        const version = this.#rowVersion(entry);
        if (this.#seenRows.get(entry.id) === version) return;
        this.#seenRows.set(entry.id, version);
        if (conversation) this.#lastConversationRowId = Math.max(this.#lastConversationRowId, entry.id);
        this.#h?.onEntry(entry);
    }

    #rowVersion(entry: LogEntryWire): string {
        // A durable receipt can settle after attachment. Compare its full wire
        // value, excluding the projection-only coordinate, without retaining bodies.
        const fields = Object.entries(entry).filter(([key]) => key !== "coordinate")
            .sort(([a], [b]) => a.localeCompare(b));
        return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    }

    // Project one standard reasoning event or un-project one CUSTOM plurnk.*
    // event into the family handlers; returns terminal truth when present.
    #dispatch(e: AguiEvent, projection: StreamProjection): TerminatedInfo | null {
        if (e.type === "TOOL_CALL_RESULT") {
            const proposal = /^prop:(\d+)$/u.exec(e.toolCallId);
            const interaction = /^int:(\d+)$/u.exec(e.toolCallId);
            if (proposal !== null) this.#pendingProposals.get(Number(proposal[1]))?.release();
            if (interaction !== null) this.#pendingInteractions.get(Number(interaction[1]))?.release();
        }
        const reasoning = projection.reasoning.consume(e);
        if (reasoning.handled) {
            if (reasoning.update !== undefined) this.#h?.onReasoning(reasoning.update);
            return null;
        }
        const state = reduceStatusGauge(projection.gauge, e);
        if (state.handled) {
            projection.gauge = state.gauge;
            if (this.#modelProjection === null || this.#modelProjection === projection) {
                // {§cli-conversation-lost}: a recreated conversation cannot reuse
                // the old database's row identities or replay cursor.
                if (this.#lastLoopId !== null && projection.gauge.plurnk.status.loopId === null) {
                    this.#seenRows.clear();
                    this.#lastConversationRowId = 0;
                }
                this.#lastLoopId = projection.gauge.plurnk.status.loopId;
                this.#h?.onStatus?.(structuredClone(projection.gauge));
            }
            return null;
        }
        if (e.type !== "CUSTOM") return null;
        const name = (e as { name?: string }).name;
        const value = (e as { value?: unknown }).value;
        if (name === "plurnk.row") this.#row(value as LogEntryWire, projection === this.#modelProjection);
        else if (name === "plurnk.stream") this.#h?.onStream(value as StreamEventPayload | StreamConcludedPayload);
        else if (name === "plurnk.notice") this.#h?.onNotice(value as Notice);
        else if (name === "plurnk.descendant") this.#h?.onDescendant?.(value as Descendant);
        else if (name === "plurnk.outside") this.#h?.onOutside(value as OutsideText);
        else if (name === "plurnk.problem") this.#h?.onProblem?.(problemDetails(value));
        else if (name === "plurnk.terminated") {
            const raw = value as Omit<TerminatedInfo, "finalStatus"> & { finalStatus?: unknown };
            const result = operationResult(raw.result);
            const t: TerminatedInfo = { ...raw, result, finalStatus: result.status };
            if (t.result.problem !== undefined) this.#h?.onProblem?.(t.result.problem);
            this.#h?.onTerminated(t);
            return t;
        }
        return null;
    }
}
