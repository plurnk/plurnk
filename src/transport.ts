// The TUI's AG-UI transport. Model and action runs share presentation handlers,
// not stream state or interrupt ownership ({§cli-active-command-admission}).

import type { LogEntryWire, LoopUsage } from "./render.ts";
import type { ProposalParams } from "./proposal.ts";
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
import type { ApplicationPort, LoopPolicy, OperationResult } from "@plurnk/plurnk-contracts";
import { runViaBridge, actionOutcome, operationResult, problemDetails, type AguiEvent, type BridgeTarget } from "./agui.ts";
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


// The run's status gauge — the AG-UI state the bridge snapshots on RUN_STARTED and
// patches per packet, termination, and derivation (plurnk-agui SPEC, `loop/packet`).
export type StatusGauge = StatusGaugeEnvelope;

// Run-plane events projected into the client's presentation shapes.
export interface RunHandlers {
    onEntry: (entry: LogEntryWire) => void;
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
    onNotice: (notice: Notice) => void;
    onProblem?: (problem: ProblemDetails) => void;
    onQuiesced?: (payload: unknown) => void;
    onStatus?: (gauge: StatusGauge) => void;
    onTerminated: (t: TerminatedInfo) => void;
}

export interface RunHandle { done: Promise<TerminatedInfo>; cancel: () => void }
export interface ObservationHandle { done: Promise<TerminatedInfo | null>; cancel: () => void }
export type LoopAdmission = Awaited<ReturnType<ApplicationPort["runLoop"]>>;

type ProposalResolution = { logEntryId: number; decision: string; body?: string };
type InteractionResolution = Record<string, unknown> | "cancel";
type StreamProjection = { gauge: StatusGauge | null; reasoning: ReasoningEvents };

// loop.run knobs. Model and child-model selection are durable worker policy,
// changed through worker.model.set / worker.child.set rather than reasserted on
// individual runs.
export interface RunOpts { policy: LoopPolicy; maxTurns?: number; openPaths?: string[] }

export interface Transport {
    rpc<T = unknown>(method: string, params?: object): Promise<T>;
    subscribe(handlers: RunHandlers): void;
    run(prompt: string, opts: RunOpts): RunHandle;
    observe(): ObservationHandle;
    inject(prompt: string): Promise<LoopAdmission>;
    resolve(r: { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string; outcome?: string }): Promise<void>;
    resolveInteraction(interactionId: number, payload: Record<string, unknown> | "cancel"): Promise<void>;
    onClose(handler: () => void): void;   // WS: the daemon socket dropped. Bridge: no-op (each run is its own SSE).
    shutdown(): void;   // suppress the connection-lost reject on an intentional quit
    // Switch to (or create) a named workspace. WS rebinds the connection via
    // workspace.create; the bridge re-maps its threadId (the bridge lazy-creates the
    // workspace on the next run). Returns the workspace handle for the header.
    useSession(name: string | undefined, params: { projectRoot?: string | null; client?: string }): Promise<{ name: string }>;
    // Rebind this session's conversation to a worker by name, keeping the world:
    // the daemon binds an existing conversation or mints a fresh one on the next
    // run — the same path `--worker` takes at invocation ({§cli-workers-topology}).
    useWorker(name: string, world: string): void;
}

// Model and sync Runs share event projection and interrupt handling. An idle sync
// can finish without a loop terminal; it cannot manufacture accounting evidence.
// Workspace options that ride forwardedProps.plurnk on the thread's FIRST run
// (§agui-forwarded-props) — the bridge applies them at workspace.create.
export interface BridgeSessionOpts { workspace?: string; projectRoot?: string | null; settings?: object }

export class BridgeTransport implements Transport {
    #target: BridgeTarget;
    #threadId: string;
    #world: string | undefined;   // the workspace name when it differs from the thread (--worker)
    #workspace: BridgeSessionOpts;
    #h: RunHandlers | null = null;
    #modelProjection: StreamProjection | null = null;
    #pendingProposals = new Map<number, (r: ProposalResolution | undefined) => void>();
    #pendingInteractions = new Map<number, (r: InteractionResolution | undefined) => void>();
    #controllers = new Set<AbortController>();
    #seenRows = new Set<number>();
    #lastConversationRowId = 0;

    constructor(target: BridgeTarget, threadId: string, workspace: BridgeSessionOpts = {}) {
        this.#target = target;
        this.#threadId = threadId;
        this.#world = workspace.workspace;
        this.#workspace = workspace;
    }

    // PLURNK verbs ride namespaced actions inside standard AG-UI runs.
    // A verb is a §3 action run — and its stream ALSO carries whatever the dispatch
    // emitted (a raw-DSL op's rows, notices, streams). Feed those through the same
    // persistent handlers a run uses (the WS socket delivered every workspace row;
    // parity demands the action stream does too — e.g. the Alt-p cycler harvests
    // targets from onEntry).
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
            for await (const e of runViaBridge(this.#target, {
                ...binding,
                ...next,
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
                    this.#h?.onProposal({ logEntryId: pausedProp, op: args.op, target: args.target, body: args.body, attrs: args.attrs } as unknown as ProposalParams, "action");
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
            next = resolution.decision === "cancel"
                ? { resume: [{ interruptId: `prop:${resolution.logEntryId}`, status: "cancelled" }] }
                : { resume: [{ interruptId: `prop:${resolution.logEntryId}`, status: "resolved", payload: { decision: resolution.decision, ...(resolution.body !== undefined ? { body: resolution.body } : {}) } }] };
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
            ...(this.#workspace.projectRoot !== undefined && this.#workspace.projectRoot !== null ? { projectRoot: this.#workspace.projectRoot } : {}),
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

    observe(): ObservationHandle { return this.#run(); }

    #run(prompt?: string, opts?: RunOpts): ObservationHandle {
        const binding = { threadId: this.#threadId, workspace: this.#world };
        const sinceId = this.#lastConversationRowId;
        const ac = new AbortController();
        this.#controllers.add(ac);
        const projection: StreamProjection = { gauge: null, reasoning: new ReasoningEvents() };
        this.#modelProjection = projection;
        // Every request carries workspace options (#workspaceOpts — see #140); every
        // run forwards per-run knobs.
        const fwd: Record<string, unknown> = {
            ...this.#workspaceOpts(),
            ...(opts === undefined ? { mode: "sync" } : {
                policy: opts.policy,
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
                let interrupted = false;
                let observed = false;
                let toolId = "";
                let toolName = "";
                let toolArgs = "";
                let interactionArguments: Record<string, unknown> | null = null;
                try {
                    for await (const e of runViaBridge(this.#target, { ...binding, ...next, forwardedProps: fp }, ac.signal)) {
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
                            proposalResolution = this.#interrupt(this.#pendingProposals, pausedProp, ac.signal, "Proposal");
                            this.#h?.onProposal({ logEntryId: pausedProp, op: a.op, target: a.target, body: a.body, attrs: a.attrs } as unknown as ProposalParams, "model");
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
                next = r.decision === "cancel"
                    ? { resume: [{ interruptId: `prop:${r.logEntryId}`, status: "cancelled" }] }
                    : { resume: [{ interruptId: `prop:${r.logEntryId}`, status: "resolved", payload: { decision: r.decision, ...(r.body !== undefined ? { body: r.body } : {}) } }] };
                fp = undefined;
            }
        })().then(async (terminal) => {
            if (prompt === undefined && !ac.signal.aborted && (terminal === null || terminal.loopId !== undefined)) {
                const history = await this.#action<{ entries: LogEntryWire[] }>("log.read", { sinceId, limit: 1000 }, ac.signal, binding);
                if (history === null || !Array.isArray(history.entries) || history.entries.length >= 1000
                    || history.entries.some((entry) => !Number.isSafeInteger(entry?.id) || entry.id <= sinceId)) {
                    throw new ProblemError(clientTransportResultInvalid("log.read did not supply a complete bounded history window."));
                }
                for (const entry of history.entries.toSorted((a, b) => a.id - b.id)) {
                    if (!this.#seenRows.has(entry.id)) this.#row(entry, true);
                }
            }
            return terminal;
        }).catch((cause: unknown): TerminatedInfo => {
            if (!ac.signal.aborted) throw cause;
            const problem = clientTransportCancelled();
            return { finalStatus: problem.status, hitMaxTurns: false, result: operationResult({ status: problem.status, problem }) };
        }).finally(() => {
            ac.abort();
            this.#controllers.delete(ac);
            if (this.#modelProjection === projection) this.#modelProjection = null;
        });
        return { done, cancel: () => ac.abort() };
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
        if (pending === undefined) throw new Error(`Proposal ${r.logEntryId} has no pending AG-UI interrupt.`);
        pending(r);
    }
    #interrupt<T>(pending: Map<number, (value: T | undefined) => void>, id: number, signal: AbortSignal, kind: string): Promise<T | undefined> {
        if (pending.has(id)) throw new Error(`${kind} ${id} already has a pending AG-UI interrupt.`);
        return new Promise((resolve) => {
            const settle = (value: T | undefined): void => {
                pending.delete(id);
                signal.removeEventListener("abort", cancel);
                resolve(value);
                this.#h?.onInterruptEnd?.(`${kind === "Proposal" ? "prop" : "int"}:${id}`);
            };
            const cancel = (): void => settle(undefined);
            pending.set(id, settle);
            if (signal.aborted) cancel();
            else signal.addEventListener("abort", cancel, { once: true });
        });
    }
    async resolveInteraction(interactionId: number, payload: Record<string, unknown> | "cancel"): Promise<void> {
        const pending = this.#pendingInteractions.get(interactionId);
        if (pending === undefined) throw new Error(`Interaction ${interactionId} has no pending AG-UI interrupt.`);
        pending(payload);
    }
    onClose(_handler: () => void): void { /* each run is its own SSE — no persistent socket to watch */ }
    async useSession(name: string | undefined, _params: Parameters<Transport["useSession"]>[1]): Promise<{ name: string }> {
        // Re-map to a fresh WORLD: the thread and the workspace move together (a /workspace
        // switch is a new world + its default conversation; a split thread comes from
        // --worker at invocation, not from this verb). Lazy-created on the next run.
        const threadId = name ?? `tui-${crypto.randomUUID().slice(0, 8)}`;
        this.#threadId = threadId;
        this.#world = undefined;   // thread == world again
        this.#seenRows.clear();
        this.#lastConversationRowId = 0;
        return { name: threadId };
    }
    useWorker(name: string, world: string): void {
        this.#threadId = name;
        this.#world = world;
        this.#seenRows.clear();
        this.#lastConversationRowId = 0;
    }

    #row(entry: LogEntryWire, conversation: boolean): void {
        this.#seenRows.add(entry.id);
        if (conversation) this.#lastConversationRowId = Math.max(this.#lastConversationRowId, entry.id);
        this.#h?.onEntry(entry);
    }

    // Project one standard reasoning event or un-project one CUSTOM plurnk.*
    // event into the family handlers; returns terminal truth when present.
    #dispatch(e: AguiEvent, projection: StreamProjection): TerminatedInfo | null {
        const reasoning = projection.reasoning.consume(e);
        if (reasoning.handled) {
            if (reasoning.update !== undefined) this.#h?.onReasoning(reasoning.update);
            return null;
        }
        const state = reduceStatusGauge(projection.gauge, e);
        if (state.handled) {
            projection.gauge = state.gauge;
            if (this.#modelProjection === null || this.#modelProjection === projection) {
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
        else if (name === "plurnk.problem") this.#h?.onProblem?.(problemDetails(value));
        else if (name === "plurnk.quiesced") this.#h?.onQuiesced?.(value);
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
