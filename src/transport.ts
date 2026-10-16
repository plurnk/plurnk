// The TUI's AG-UI transport. Model and action runs share presentation handlers,
// not stream state or interrupt ownership ({§cli-active-command-admission}).

import type { Descendant, OutsideText } from "./render.ts";
import type { LogEntryWire, LoopUsage } from "./render.ts";
import { proposalOf, proposalResume, type ProposalParams, type Resolution } from "./proposal.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import type { Notice } from "./diagnostics.ts";
import {
    ProblemError,
    isAbsentWorker,
    clientTransportCancelled,
    clientTransportInterruptMismatch,
    clientTransportProblemMissing,
    clientTransportInteractionInvalid,
    clientTransportTerminalMissing,
    clientActionResultMissing,
    clientTransportResultInvalid,
    type ProblemDetails,
} from "./diagnostics.ts";
import type { OperationResult } from "@plurnk/plurnk-contracts";
import { clientCapabilities } from "./client-capabilities.ts";
import { createHash } from "node:crypto";
import { runViaAgui, actionOutcome, operationResult, problemDetails, runEnd, type AguiEvent, type AguiTarget } from "./agui.ts";
import ReasoningEvents, { type ReasoningUpdate } from "./reasoning-events.ts";
import RowAssembler, { snapshotRows, wholeRow } from "./rows.ts";
import { isWorkerGauge, reduceStatusGauge, type StatusGaugeEnvelope, type WorkerGauge, type WorkspaceState } from "./status.ts";

// The terminal outcome a Run's end carries (plurnk-service {§agui-plurnk-metadata}).
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
    onHistory?: (history: WorkerHistory) => void;
    onReasoning: (reasoning: ReasoningUpdate) => void;
    onProposal: (p: ProposalParams) => void;
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
    // The bound worker's gauge; a Run that binds no worker reports none.
    onStatus?: (gauge: WorkerGauge) => void;
    // {§cli-status-preparation} The bound workspace's state, which every Run bound to it carries.
    onWorkspace?: (workspace: WorkspaceState) => void;
    onTerminated: (t: TerminatedInfo) => void;
}

export interface RunHandle { done: Promise<TerminatedInfo>; ready: Promise<void>; cancel: () => void }

// A subagent's worker as its start names it, or null for a start that names none.
const descendantOf = (metadata: unknown): Descendant | null => {
    const plurnk = (metadata as { plurnk?: unknown } | undefined)?.plurnk;
    if (plurnk === undefined) return null;
    const { workerId, name, parentWorkerId, depth } = (plurnk ?? {}) as Partial<Descendant>;
    if (!Number.isSafeInteger(workerId) || typeof name !== "string" || !Number.isSafeInteger(parentWorkerId) || !Number.isSafeInteger(depth)) {
        throw new ProblemError(clientTransportResultInvalid("A subagent's start does not name its worker as { workerId, name, parentWorkerId, depth }."));
    }
    return { workerId: workerId!, name, parentWorkerId: parentWorkerId!, depth: depth! };
};
export interface ObservationHandle { done: Promise<TerminatedInfo | null>; ready: Promise<void>; cancel: () => void }
// {§cli-worker-history} The rows a sync Run's snapshot held that this session had not drawn, in log order.
export interface WorkerHistory {
    entries: LogEntryWire[];
    attachment: boolean;
}
export interface ObserveOpts { historyLimit: number }
// What loop.inject answers: the admission of the prompt and the loop it landed on.
export type LoopAdmission = OperationResult & {
    readonly action: "injected_next_turn" | "enqueued_new_loop";
    readonly loopId: number;
    readonly turnSeq?: number;
};

type ProposalResolution = Resolution & { logEntryId: number };
type InteractionResolution = Record<string, unknown> | "cancel";
type StreamProjection = { gauge: StatusGauge | null; reasoning: ReasoningEvents; rows: RowAssembler };
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
    // Rebind this session's thread to a worker by name, keeping the world:
    // the daemon binds an existing worker or mints a new one on the next
    // run — the same path `--worker` takes at invocation ({§cli-workers-topology}).
    useWorker(name: string, world: string): void;
    // The attached workspace now carries `name` (workspace.rename): later Runs name it, and the thread
    // keeps naming its worker.
    renameWorkspace(name: string): void;
    // The thread this transport speaks for: the AG-UI threadId the daemon sources this
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
    #closed = false;
    #seenRows = new Map<number, string>();
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
    // persistent handlers a run uses (e.g. /attach completion harvests worker
    // references from onEntry).
    async rpc<T>(method: string, params?: object): Promise<T> {
        const ac = this.#controller();
        try {
            return await this.#action<T>(method, params, ac.signal);
        } finally {
            ac.abort();
            this.#controllers.delete(ac);
        }
    }

    // An action answers on its own Run and presents no interrupt: a client operation is the person's own
    // decision, never routed for review (plurnk/plurnk-service {§agui-client-operation}).
    async #action<T>(method: string, params: object | undefined, signal: AbortSignal): Promise<T> {
        const projection: StreamProjection = { gauge: null, reasoning: new ReasoningEvents(), rows: new RowAssembler() };
        let result: T | undefined;
        let problem: ProblemDetails | undefined;
        let sawResult = false;
        for await (const e of runViaAgui(this.#target, {
            threadId: this.#threadId,
            workspace: this.#world,
            messages: [],
            forwardedProps: { ...this.#workspaceOpts(), action: { kind: method, ...(params ?? {}) } },
            capabilities: clientCapabilities(this.#workspace.auto !== true),
        }, signal)) {
            const end = runEnd(e);
            if (end?.problem !== undefined) problem = problemDetails(end.problem);
            if (end?.result !== undefined) {
                const v = actionOutcome<T>(end.result);
                sawResult = true;
                if (v.ok) result = v.result; else problem = v.problem;
            }
            this.#dispatch(e, projection);
        }
        if (problem !== undefined) throw new ProblemError(problem);
        if (!sawResult) throw new ProblemError(clientActionResultMissing(method));
        return result as T;
    }
    subscribe(handlers: RunHandlers): void { this.#h = handlers; }
    shutdown(): void {
        this.#closed = true;
        for (const ac of this.#controllers) ac.abort();
    }
    async [Symbol.asyncDispose](): Promise<void> { this.shutdown(); }

    #controller(): AbortController {
        if (this.#closed) throw new DOMException("The client transport is closed.", "AbortError");
        const ac = new AbortController();
        this.#controllers.add(ac);
        return ac;
    }

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
        const ac = this.#controller();
        const projection: StreamProjection = { gauge: null, reasoning: new ReasoningEvents(), rows: new RowAssembler() };
        this.#modelProjection = projection;
        const ready = Promise.withResolvers<void>();
        // Both promises report the same failed run. Consumers that only await done
        // must not acquire an unhandled rejection from the readiness view.
        void ready.promise.catch(() => {});
        // Every request carries workspace options (#workspaceOpts — see #140); every
        // run forwards per-run knobs.
        const fwd: Record<string, unknown> = {
            ...this.#workspaceOpts(),
            // {plurnk#108} — a session that observes its delegation asks on every message and sync Run.
            ...(this.#workspace.descendants === true ? { descendants: true } : {}),
            control: true,
            ...(opts?.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
            ...(opts?.openPaths !== undefined ? { openPaths: opts.openPaths } : {}),
        };
        const forwardedProps = Object.keys(fwd).length > 0 ? fwd : undefined;
        // AG-UI interrupt/resume: a stopped-world ends the run with an interrupt, a proposal's
        // carrying the daemon's projection, an interaction's naming its request_user_input
        // TOOL_CALL (the loop stays paused in-engine). resolve() supplies the decision; we POST a
        // standard resume as the resume run and keep consuming — done spans the whole pause/resume
        // chain, so the TUI's seam contract never changes.
        const done = (async (): Promise<TerminatedInfo | null> => {
            let terminated: TerminatedInfo | null = null;
            let sawRunError = false;
            let runProblem: ProblemDetails | null = null;
            let next: { prompt?: string; resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }> } = { prompt };
            let fp = forwardedProps;
            // plurnk-service {§agui-run-input}: a Run that carries nothing new synchronizes.
            let observing = prompt === undefined;
            for (;;) {
                let pausedProp: number | null = null;
                let pausedInteraction: number | null = null;
                let proposalResolution: Promise<ProposalResolution | undefined> | null = null;
                let interactionResolution: Promise<InteractionResolution | undefined> | null = null;
                let joined: AbortSignal | undefined;
                let interruptId: string | undefined;
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
                    const synchronized = observing ? this.#synchronize(events, observation, ready.resolve, projection.rows) : events;
                    for await (const e of synchronized) {
                        if (!observing) ready.resolve();
                        const ended = this.#ended(e);
                        if (ended.terminated !== null) terminated = ended.terminated;
                        if (ended.problem !== null) runProblem = ended.problem;
                        if (e.type === "RUN_ERROR") {
                            sawRunError = true;
                        } else if (e.type === "RUN_FINISHED") {
                            const outcome = e.outcome;
                            observed = outcome?.type === "success";
                            const interrupts = outcome?.type === "interrupt" ? outcome.interrupts : [];
                            // plurnk-service {§agui-proposal-resolve}: a proposal is its interrupt, carrying the daemon's projection.
                            let gate: { readonly interrupt: (typeof interrupts)[number]; readonly proposal: ProposalParams } | undefined;
                            try {
                                for (const candidate of interrupts) {
                                    const proposal = proposalOf(candidate);
                                    if (proposal !== null) { gate = { interrupt: candidate, proposal }; break; }
                                }
                            } catch (cause) {
                                if (!(cause instanceof ProblemError)) throw cause;
                                this.#h?.onProblem?.(cause.problem);
                                return { finalStatus: cause.problem.status, hitMaxTurns: false, result: operationResult({ status: cause.problem.status, problem: cause.problem }) };
                            }
                            if (gate !== undefined) {
                                pausedProp = gate.proposal.logEntryId;
                                interruptId = gate.interrupt.id;
                                joined = this.#pendingProposals.get(pausedProp)?.signal;
                                if (joined !== undefined) continue;
                                proposalResolution = this.#interrupt(this.#pendingProposals, pausedProp, ac.signal, "Proposal");
                                this.#h?.onProposal(gate.proposal);
                                continue;
                            }
                            const interrupt = interrupts.find((candidate) => (candidate.toolCallId ?? candidate.id) === toolId);
                            interruptId = interrupt?.id;
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
                            this.#dispatch(e, projection);
                        } else if (e.type === "TOOL_CALL_ARGS" && toolId.startsWith("int:")) {
                            toolArgs += String((e as { delta?: unknown }).delta ?? "");
                        } else if (e.type === "TOOL_CALL_END" && toolId.startsWith("int:")) {
                            pausedInteraction = Number(toolId.slice(4));
                            try {
                                interactionArguments = JSON.parse(toolArgs.length > 0 ? toolArgs : "{}") as Record<string, unknown>;
                            } catch (cause) {
                                const problem = clientTransportInteractionInvalid(pausedInteraction, cause);
                                this.#h?.onProblem?.(problem);
                                return {
                                    finalStatus: problem.status,
                                    hitMaxTurns: false,
                                    result: operationResult({ status: problem.status, problem }),
                                };
                            }
                        } else {
                            this.#dispatch(e, projection);
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
                if (pausedInteraction !== null && interruptId === undefined) {
                    const problem = clientTransportInterruptMismatch(`int:${pausedInteraction}`);
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
                    fp = forwardedProps;
                    observing = true;
                    continue;
                }
                if (proposalResolution === null && interactionResolution === null) throw new Error("paused run ended without a resolution channel");
                if (interruptId === undefined) throw new Error("paused run ended without an interrupt identity");
                if (interactionResolution !== null && pausedInteraction !== null) {
                    const a = await interactionResolution;
                    ac.signal.throwIfAborted();
                    if (a === undefined) throw new Error("interaction ended without a resolution");
                    next = a === "cancel"
                        ? { resume: [{ interruptId, status: "cancelled" }] }
                        : { resume: [{ interruptId, status: "resolved", payload: a }] };
                    fp = undefined;
                    observing = false;
                    continue;
                }
                if (proposalResolution === null) throw new Error("proposal ended without a resolution channel");
                // Paused: hold done open until the client resolves, then resume the interrupt.
                const r = await proposalResolution;
                ac.signal.throwIfAborted();
                if (r === undefined) throw new Error("proposal ended without a resolution");
                next = { resume: [proposalResume(interruptId, r)] };
                fp = undefined;
                observing = false;
            }
        })().then((terminal) => {
            ready.resolve();
            return terminal;
        }).catch((cause: unknown): TerminatedInfo => {
            // plurnk-service {§agui-action-binding}: the binding stands when its worker, or its world, does not
            // exist yet; only the observation fails.
            if (prompt === undefined && isAbsentWorker(cause)) ready.resolve();
            else ready.reject(cause);
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

    // {§cli-worker-history}: establish the historical prefix before releasing
    // live events. The snapshot owns no lifecycle or accounting.
    async *#synchronize(events: AsyncIterable<AguiEvent>, opts: ObserveOpts | undefined, ready: () => void, rows: RowAssembler): AsyncGenerator<AguiEvent> {
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
            // The snapshot is the worker's whole conversation; an attachment draws its newest rows.
            const entries = snapshotRows(event.messages, rows).filter((entry) => this.#seenRows.get(entry.id) !== this.#rowVersion(entry));
            for (const entry of entries) this.#seenRows.set(entry.id, this.#rowVersion(entry));
            const limit = opts?.historyLimit;
            this.#h?.onHistory?.({ entries: limit === undefined ? entries : entries.slice(Math.max(0, entries.length - limit)), attachment: opts !== undefined });
            restored = true;
            ready();
            yield* pending;
            pending.length = 0;
        }
        if (!restored) {
            yield* pending;
            if (pending.some((event) => event.type === "RUN_FINISHED" && event.outcome?.type === "success")) {
                throw new ProblemError(clientTransportResultInvalid("The sync Run omitted MESSAGES_SNAPSHOT."));
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
                this.#h?.onInterruptEnd?.(`${kind === "Proposal" ? "proposal" : "int"}:${id}`);
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
        // switch is a new world, where the TUI then names its worker; a split thread comes from
        // --worker at invocation, not from this verb). Lazy-created on the next run.
        const threadId = name ?? `tui-${crypto.randomUUID().slice(0, 8)}`;
        this.#workspace = {
            ...this.#workspace,
            ...(params.projectRoot === undefined ? {} : { projectRoot: params.projectRoot }),
        };
        this.#threadId = threadId;
        this.#world = undefined;   // thread == world again
        this.#seenRows.clear();
        this.#lastLoopId = null;
        return { name: threadId };
    }
    renameWorkspace(name: string): void {
        this.#world = name;
    }
    useWorker(name: string, world: string): void {
        this.#threadId = name;
        this.#world = world;
        this.#seenRows.clear();
        this.#lastLoopId = null;
    }

    #row(entry: LogEntryWire): void {
        // plurnk-service {§agui-proposal-resolve}: a proposal is settled when its row is.
        if (entry.state !== "proposed") this.#pendingProposals.get(entry.id)?.release();
        const version = this.#rowVersion(entry);
        if (this.#seenRows.get(entry.id) === version) return;
        this.#seenRows.set(entry.id, version);
        this.#h?.onEntry(entry);
    }

    #rowVersion(entry: LogEntryWire): string {
        // {§cli-worker-history} A durable receipt can settle after attachment: its status, signal and attributes are
        // the version a row's part and its whole row both carry, without retaining bodies.
        return createHash("sha256").update(JSON.stringify([entry.op, entry.status_rx, entry.signal, entry.attrs ?? null])).digest("hex");
    }

    // A Run's end: the bound loop's terminal record, or the exact Problem of a Run that failed without one
    // (plurnk-service {§agui-plurnk-metadata}).
    #ended(e: AguiEvent): { terminated: TerminatedInfo | null; problem: ProblemDetails | null } {
        const end = runEnd(e);
        if (end?.terminal !== undefined) {
            const raw = end.terminal as Omit<TerminatedInfo, "finalStatus"> & { finalStatus?: unknown };
            const result = operationResult(raw.result);
            const t: TerminatedInfo = { ...raw, result, finalStatus: result.status };
            if (t.result.problem !== undefined) this.#h?.onProblem?.(t.result.problem);
            this.#h?.onTerminated(t);
            return { terminated: t, problem: null };
        }
        if (end?.problem !== undefined) {
            const problem = problemDetails(end.problem);
            this.#h?.onProblem?.(problem);
            return { terminated: null, problem };
        }
        return { terminated: null, problem: null };
    }

    // Project one standard reasoning, state or conversation event, or un-project one CUSTOM plurnk.* event, into the
    // family handlers.
    #dispatch(e: AguiEvent, projection: StreamProjection): void {
        if (e.type === "TOOL_CALL_RESULT") {
            const interaction = /^int:(\d+)$/u.exec(e.toolCallId);
            if (interaction !== null) this.#pendingInteractions.get(Number(interaction[1]))?.release();
        }
        // {§cli-workers-topology} The session renders its delegation from the descendants' rows: a subagent's reasoning is
        // not this worker's.
        if (e.type.startsWith("REASONING") && (e as { subagentRunId?: unknown }).subagentRunId !== undefined) return;
        const reasoning = projection.reasoning.consume(e);
        if (reasoning.handled) {
            if (reasoning.update !== undefined) this.#h?.onReasoning(reasoning.update);
            return;
        }
        const state = reduceStatusGauge(projection.gauge, e);
        if (state.handled) {
            const gauge = projection.gauge = state.gauge;
            this.#h?.onWorkspace?.(structuredClone(gauge.plurnk.workspace));
            if (isWorkerGauge(gauge) && (this.#modelProjection === null || this.#modelProjection === projection)) {
                // {§cli-history-lost}: a recreated worker cannot reuse the old database's row identities.
                if (this.#lastLoopId !== null && gauge.plurnk.status.loopId === null) this.#seenRows.clear();
                this.#lastLoopId = gauge.plurnk.status.loopId;
                this.#h?.onStatus?.(structuredClone(gauge));
            }
            return;
        }
        // {§cli-row-sources} A row arrives as the part it built, or whole when it built none.
        for (const row of projection.rows.consume(e)) this.#row(row);
        // {§cli-workers-topology} A subagent's start introduces its worker (plurnk-service `{§agui-delegation-observation}`).
        if (e.type === "SUBAGENT_STARTED") {
            const descendant = descendantOf(e.metadata);
            if (descendant !== null) this.#h?.onDescendant?.(descendant);
            return;
        }
        if (e.type !== "CUSTOM") return;
        const name = (e as { name?: string }).name;
        const value = (e as { value?: unknown }).value;
        if (name === "plurnk.ambient") {
            const row = wholeRow(value);
            if (row !== null) this.#row(row);
        } else if (name === "plurnk.stream") this.#h?.onStream(value as StreamEventPayload | StreamConcludedPayload);
        else if (name === "plurnk.notice") this.#h?.onNotice(value as Notice);
        else if (name === "plurnk.descendant") this.#h?.onDescendant?.(value as Descendant);
        else if (name === "plurnk.outside") this.#h?.onOutside(value as OutsideText);
        // A Problem that ends no Run, such as an unavailable provider catalog, stays its own event.
        else if (name === "plurnk.problem") this.#h?.onProblem?.(problemDetails(value));
    }
}
