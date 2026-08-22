// The TUI's transport seam. The AG-UI bridge un-projects `plurnk.*` custom
// events into the daemon-notification shapes the TUI already renders and folds
// the standard reasoning lifecycle into one completed display value.
//
// Handlers are PERSISTENT (subscribe once): the WS TUI renders a shared workspace's
// activity — a worker's rows, a second client's loop — even while this REPL is
// idle, so the notification handlers can't be scoped per-run. run() drives one
// loop and its `done` resolves with that loop's outcome (for the summary).

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
    type ProblemDetails,
} from "./diagnostics.ts";
import type { OperationResult } from "@plurnk/plurnk-contracts";
import { runViaBridge, actionViaBridge, actionOutcome, operationResult, problemDetails, type AguiEvent, type BridgeTarget } from "./agui.ts";
import ReasoningEvents, { type ReasoningUpdate } from "./reasoning-events.ts";

// The terminal outcome, unified across transports (WS loop/terminated ≈ bridge
// plurnk.terminated + workspaceId).
export interface TerminatedInfo {
    loopId?: number;
    finalStatus: number;
    hitMaxTurns: boolean;
    turnIds?: number[];
    usage?: LoopUsage;
    workspaceId?: number | null;
    result: OperationResult;
}

export interface BranchBatchEvent {
    workspaceId?: number;
    batchId: number;
    state: "queued" | "running" | "completed" | "failed" | "recovery_required";
    branch?: string;
    completed?: number;
    total?: number;
    problem?: { detail?: string };
}

// Run-plane events in daemon-notification shapes — the SAME shapes the TUI's
// existing handlers consume, so they work unchanged under either transport.
export interface RunHandlers {
    onEntry: (entry: LogEntryWire) => void;
    onReasoning: (reasoning: ReasoningUpdate) => void;
    onProposal: (p: ProposalParams) => void;
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
    onBranchBatch: (event: BranchBatchEvent) => void;
    onQuiesced?: (payload: unknown) => void;
    onTerminated: (t: TerminatedInfo) => void;
}

export interface RunHandle { done: Promise<TerminatedInfo>; cancel: () => void }

// loop.run knobs. Model and child-model selection are durable worker policy,
// changed through worker.model.set / worker.child.set rather than reasserted on
// individual runs.
export interface RunOpts { flags?: Record<string, unknown>; maxTurns?: number; openPaths?: string[]; requestUserInput?: boolean }

export interface Transport {
    rpc<T = unknown>(method: string, params?: object): Promise<T>;
    subscribe(handlers: RunHandlers): void;
    run(prompt: string, opts: RunOpts): RunHandle;
    inject(prompt: string): Promise<void>;
    resolve(r: { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string; outcome?: string }): Promise<void>;
    resolveInteraction(interactionId: number, payload: Record<string, unknown> | "cancel"): Promise<void>;
    onClose(handler: () => void): void;   // WS: the daemon socket dropped. Bridge: no-op (each run is its own SSE).
    shutdown(): void;   // suppress the connection-lost reject on an intentional quit
    // Switch to (or create) a named workspace. WS rebinds the connection via
    // workspace.create; the bridge re-maps its threadId (the bridge lazy-creates the
    // workspace on the next run). Returns the workspace handle for the header.
    useSession(name: string | undefined, params: { projectRoot?: string | null; client?: string }): Promise<{ id: number; name: string }>;
}

// ── Bridge transport — the AG-UI exclusive portal. run() consumes the SSE, feeds
// the persistent handlers via un-projection, and `done` resolves with the outcome
// from plurnk.terminated. inject rides an action run on the same thread (reaching
// the active loop); cancel aborts the SSE (the bridge cancels).
// Workspace options that ride forwardedProps.plurnk on the thread's FIRST run
// (§agui-forwarded-props) — the bridge applies them at workspace.create.
export interface BridgeSessionOpts { workspace?: string; projectRoot?: string | null; constraints?: unknown[]; settings?: object }

export class BridgeTransport implements Transport {
    #target: BridgeTarget;
    #threadId: string;
    #world: string | undefined;   // the workspace name when it differs from the thread (--worker)
    #workspace: BridgeSessionOpts;
    #h: RunHandlers | null = null;
    #pendingResolve: ((r: { logEntryId: number; decision: string; body?: string }) => void) | null = null;
    #pendingInteractionResolve: ((r: Record<string, unknown> | "cancel") => void) | null = null;
    #reasoning = new ReasoningEvents();

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
        let result: T | undefined;
        let problem: ProblemDetails | undefined;
        let sawResult = false;
        let next: { messages?: []; forwardedProps?: Record<string, unknown>; resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }> } = {
            messages: [],
            forwardedProps: { ...this.#workspaceOpts(), action: { kind: method, ...(params ?? {}) } },
        };
        for (;;) {
            let pausedProp: number | null = null;
            let proposalResolution: Promise<{ logEntryId: number; decision: string; body?: string }> | null = null;
            let interrupted = false;
            let toolId = "";
            let toolArgs = "";
            for await (const e of runViaBridge(this.#target, {
                threadId: this.#threadId,
                ...(this.#world !== undefined ? { workspace: this.#world } : {}),
                ...next,
            })) {
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
                    proposalResolution = new Promise((resolve) => { this.#pendingResolve = resolve; });
                    this.#h?.onProposal({ logEntryId: pausedProp, op: args.op, target: args.target, body: args.body, attrs: args.attrs, staleClobberRisk: args.staleClobberRisk } as unknown as ProposalParams);
                    continue;
                }
                if (e.type === "RUN_FINISHED") {
                    interrupted = e.outcome?.type === "interrupt"
                        && e.outcome.interrupts.some((interrupt) => interrupt.id === toolId || interrupt.toolCallId === toolId);
                    continue;
                }
                this.#dispatch(e);
            }
            if (problem !== undefined) throw new ProblemError(problem);
            if (sawResult) return result as T;
            if (pausedProp === null) throw new ProblemError(clientActionResultMissing(method));
            if (!interrupted) throw new ProblemError(clientTransportInterruptMismatch(pausedProp));
            if (proposalResolution === null) throw new Error("proposal ended without a resolution channel");
            const resolution = await proposalResolution;
            next = resolution.decision === "cancel"
                ? { resume: [{ interruptId: `prop:${resolution.logEntryId}`, status: "cancelled" }] }
                : { resume: [{ interruptId: `prop:${resolution.logEntryId}`, status: "resolved", payload: { decision: resolution.decision, ...(resolution.body !== undefined ? { body: resolution.body } : {}) } }] };
        }
    }
    subscribe(handlers: RunHandlers): void { this.#h = handlers; }
    shutdown(): void { /* the SSE is aborted per-run; nothing persistent to suppress */ }

    // Workspace options on every request (#140): workspace creation and
    // its projectRoot are ATOMIC — the module creates from whichever request arrives
    // first, so every request carries the options (applied at creation, ignored after).
    // No consumed-once flag, no race: a headless workspace can only be one on purpose,
    // and it stays headless forever (root changes are unimplemented by design).
    #workspaceOpts(): Record<string, unknown> {
        return {
            ...(this.#workspace.projectRoot !== undefined && this.#workspace.projectRoot !== null ? { projectRoot: this.#workspace.projectRoot } : {}),
            ...(this.#workspace.constraints !== undefined && this.#workspace.constraints.length > 0 ? { constraints: this.#workspace.constraints } : {}),
            ...(this.#workspace.settings !== undefined && Object.keys(this.#workspace.settings).length > 0 ? { settings: this.#workspace.settings } : {}),
        };
    }

    run(prompt: string, opts: RunOpts): RunHandle {
        const ac = new AbortController();
        // Every request carries workspace options (#workspaceOpts — see #140); every
        // run forwards per-run knobs.
        const fwd: Record<string, unknown> = {
            ...this.#workspaceOpts(),
            ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
            ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
            ...(opts.requestUserInput !== undefined ? { requestUserInput: opts.requestUserInput } : {}),
        };
        const forwardedProps = Object.keys(fwd).length > 0 ? fwd : undefined;
        // AG-UI interrupt/resume: a stopped-world ends the run as a
        // request_approval/request_user_input TOOL_CALL (the loop stays paused
        // in-engine). resolve() supplies the decision; we POST a standard resume as the
        // resume run and keep consuming — done spans the whole pause/resume chain, so
        // the TUI's seam contract never changes.
        const done = (async (): Promise<TerminatedInfo> => {
            let terminated: TerminatedInfo | null = null;
            let sawRunError = false;
            let runProblem: ProblemDetails | null = null;
            let next: { prompt?: string; resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }> } = { prompt };
            let fp = forwardedProps;
            for (;;) {
                let pausedProp: number | null = null;
                let pausedInteraction: number | null = null;
                let proposalResolution: Promise<{ logEntryId: number; decision: string; body?: string }> | null = null;
                let interactionResolution: Promise<Record<string, unknown> | "cancel"> | null = null;
                let interrupted = false;
                let toolId = "";
                let toolName = "";
                let toolArgs = "";
                let interactionArguments: Record<string, unknown> | null = null;
                try {
                    for await (const e of runViaBridge(this.#target, { threadId: this.#threadId, ...(this.#world !== undefined ? { workspace: this.#world } : {}), ...next, forwardedProps: fp }, ac.signal)) {
                        if (e.type === "RUN_ERROR") {
                            sawRunError = true;
                        } else if (e.type === "RUN_FINISHED") {
                            const outcome = e.outcome;
                            const interrupt = outcome?.type === "interrupt"
                                ? outcome.interrupts.find((candidate) => candidate.id === toolId || candidate.toolCallId === toolId)
                                : undefined;
                            interrupted = interrupt !== undefined;
                            if (pausedInteraction !== null && interrupt !== undefined && interactionArguments !== null) {
                                interactionResolution = new Promise((resolve) => { this.#pendingInteractionResolve = resolve; });
                                this.#h?.onInteraction?.({
                                    interactionId: pausedInteraction,
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
                            proposalResolution = new Promise((resolve) => { this.#pendingResolve = resolve; });
                            this.#h?.onProposal({ logEntryId: pausedProp, op: a.op, target: a.target, body: a.body, attrs: a.attrs, staleClobberRisk: a.staleClobberRisk } as unknown as ProposalParams);
                        } else {
                            const t = this.#dispatch(e);
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
                    const problem = clientTransportInterruptMismatch(pausedProp ?? pausedInteraction ?? -1);
                    this.#h?.onProblem?.(problem);
                    return {
                        finalStatus: problem.status,
                        hitMaxTurns: false,
                        result: operationResult({ status: problem.status, problem }),
                    };
                }
                if (pausedProp === null && pausedInteraction === null) {
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
                    next = a === "cancel"
                        ? { resume: [{ interruptId: `int:${pausedInteraction}`, status: "cancelled" }] }
                        : { resume: [{ interruptId: `int:${pausedInteraction}`, status: "resolved", payload: a }] };
                    fp = undefined;
                    continue;
                }
                if (proposalResolution === null) throw new Error("proposal ended without a resolution channel");
                // Paused: hold done open until the client resolves, then resume the interrupt.
                const r = await proposalResolution;
                next = r.decision === "cancel"
                    ? { resume: [{ interruptId: `prop:${r.logEntryId}`, status: "cancelled" }] }
                    : { resume: [{ interruptId: `prop:${r.logEntryId}`, status: "resolved", payload: { decision: r.decision, ...(r.body !== undefined ? { body: r.body } : {}) } }] };
                fp = undefined;
            }
        })();
        return { done, cancel: () => ac.abort() };
    }

    // §4 — inject rides the action surface; the steered effect streams on the
    // original run's open SSE (the ack rides this action run).
    async inject(prompt: string): Promise<void> {
        await actionViaBridge(this.#target, { threadId: this.#threadId, kind: "loop.inject", params: { prompt } });
    }
    async resolve(r: Parameters<Transport["resolve"]>[0]): Promise<void> {
        // Terminate-resume: the decision releases the paused run loop, which POSTs the
        // standard resume. No paused run = a contract violation — fail hard.
        const pending = this.#pendingResolve;
        if (pending === null) throw new Error("resolve without a delivered AG-UI interrupt");
        this.#pendingResolve = null;
        pending(r);
    }
    async resolveInteraction(interactionId: number, payload: Record<string, unknown> | "cancel"): Promise<void> {
        const pending = this.#pendingInteractionResolve;
        if (pending === null) throw new Error("resolveInteraction without a delivered interaction interrupt");
        this.#pendingInteractionResolve = null;
        pending(payload);
    }
    onClose(_handler: () => void): void { /* each run is its own SSE — no persistent socket to watch */ }
    async useSession(name: string | undefined, _params: Parameters<Transport["useSession"]>[1]): Promise<{ id: number; name: string }> {
        // Re-map to a fresh WORLD: the thread and the workspace move together (a /workspace
        // switch is a new world + its default conversation; a split thread comes from
        // --worker at invocation, not from this verb). Lazy-created on the next run.
        const threadId = name ?? `tui-${crypto.randomUUID().slice(0, 8)}`;
        this.#threadId = threadId;
        this.#world = undefined;   // thread == world again
        return { id: 0, name: threadId };
    }

    // Project one standard reasoning event or un-project one CUSTOM plurnk.*
    // event into the family handlers; returns terminal truth when present.
    #dispatch(e: AguiEvent): TerminatedInfo | null {
        const reasoning = this.#reasoning.consume(e);
        if (reasoning.handled) {
            if (reasoning.update !== undefined) this.#h?.onReasoning(reasoning.update);
            return null;
        }
        if (e.type !== "CUSTOM") return null;
        const name = (e as { name?: string }).name;
        const value = (e as { value?: unknown }).value;
        if (name === "plurnk.row") this.#h?.onEntry(value as LogEntryWire);
        else if (name === "plurnk.stream") this.#h?.onStream(value as StreamEventPayload | StreamConcludedPayload);
        else if (name === "plurnk.notice") this.#h?.onNotice(value as Notice);
        else if (name === "plurnk.problem") this.#h?.onProblem?.(problemDetails(value));
        else if (name === "plurnk.branch_batch") this.#h?.onBranchBatch(value as BranchBatchEvent);
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
