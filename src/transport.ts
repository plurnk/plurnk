// The TUI's AG-UI transport. Model and action runs share presentation handlers,
// not stream state or interrupt ownership ({§cli-active-command-admission}).

import { objectOf, type Descendant, type OutsideText } from "./render.ts";
import type { LogEntryWire, LoopUsage } from "./render.ts";
import { isUnpending, proposalOf, proposalResume, type ProposalParams, type Resolution } from "./proposal.ts";
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
import { runViaAgui, actionOutcome, operationResult, problemDetails, runEnd, workerThreadId, type AguiEvent, type AguiTarget, type WorkerBinding, type WorkspaceHandle } from "./agui.ts";
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
    // `awaitingReceipt`: the gated call that launched this stream has not settled yet ({§cli-stream-event-and-stream-concluded}).
    onStream: (payload: StreamEventPayload | StreamConcludedPayload, awaitingReceipt: boolean) => void;
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

// `streaming` is true while a Run segment's event stream is open: a run paused on a client-side interrupt
// (a review, a question) has no stream that could carry the daemon's terminal record ({§cli-cancellation}).
export interface RunHandle { done: Promise<TerminatedInfo>; ready: Promise<void>; cancel: () => void; streaming: () => boolean; failure: () => ProblemDetails | null }

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
// {§cli-summary-line-per-loop} `done` resolves a loop terminal, or null when the observation ended without one;
// `failure` then names the Problem that ended it (the daemon stopping, a revoked credential, a dead wire, this
// client's own cancellation), or null for a sync Run that simply completed.
export interface ObservationHandle { done: Promise<TerminatedInfo | null>; ready: Promise<void>; cancel: () => void; streaming: () => boolean; failure: () => ProblemDetails | null }
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
    // plurnk-service {§agui-held-interrupts}: the gate settled elsewhere; the review retires without an answer of ours.
    readonly withdraw: () => void;
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
    // Acquire before replacing the binding: a failed selection leaves the current conversation intact.
    useWorkspace(name: string | undefined, params: { projectRoot?: string | null; worker: string }): Promise<WorkspaceHandle>;
    // Rebind this session's thread to a worker by name, keeping the workspace:
    // the daemon binds an existing worker or mints a new one on the next
    // run — the same path `--worker` takes at invocation ({§cli-workers-topology}).
    useWorker(name: string): void;
    // The thread this transport speaks for: the AG-UI threadId the daemon sources this
    // client's arrivals to (plurnk-service #706), so the TUI can tell its own messages apart.
    threadId(): string;
}

// Model and sync Runs share event projection and interrupt handling. An idle sync
// can finish without a loop terminal; it cannot manufacture accounting evidence.
// Settings apply to explicit workspace creation, not to already-bound Runs.
export interface AguiTransportOpts { settings?: object; descendants?: boolean; auto?: boolean }

export class AguiTransport implements Transport {
    #target: AguiTarget;
    #binding: WorkerBinding;
    #workspace: AguiTransportOpts;
    #h: RunHandlers | null = null;
    #modelProjection: StreamProjection | null = null;
    #pendingProposals = new Map<number, PendingInterrupt<ProposalResolution>>();
    #pendingInteractions = new Map<number, PendingInterrupt<InteractionResolution>>();
    #controllers = new Set<AbortController>();
    #closed = false;
    #seenRows = new Map<number, string>();
    #lastLoopId: number | null = null;

    constructor(target: AguiTarget, binding: WorkerBinding, workspace: AguiTransportOpts = {}) {
        this.#target = target;
        this.#binding = binding;
        this.#workspace = workspace;
    }

    threadId(): string { return workerThreadId(this.#binding); }

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
            threadId: this.threadId(),
            messages: [],
            forwardedProps: { action: { kind: method, ...(params ?? {}) } },
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

    run(prompt: string, opts: RunOpts): RunHandle {
        const handle = this.#run(prompt, opts);
        return { ...handle, done: handle.done.then((terminal) => {
            if (terminal === null) throw new ProblemError(clientTransportTerminalMissing());
            return terminal;
        }) };
    }

    observe(opts?: ObserveOpts): ObservationHandle { return this.#run(undefined, undefined, opts); }

    #run(prompt?: string, opts?: RunOpts, observation?: ObserveOpts): ObservationHandle {
        const binding = { threadId: this.threadId() };
        const ac = this.#controller();
        const projection: StreamProjection = { gauge: null, reasoning: new ReasoningEvents(), rows: new RowAssembler() };
        this.#modelProjection = projection;
        const ready = Promise.withResolvers<void>();
        // Both promises report the same failed run. Consumers that only await done
        // must not acquire an unhandled rejection from the readiness view.
        void ready.promise.catch(() => {});
        // {§cli-resume-observation} A resume continues the Run it answers: it carries that Run's observation and claim, never
        // a message's own parameters. {plurnk#108} — a session that observes its delegation asks on every Run that observes.
        // {§cli-provider-reasoning} Every Run negotiates reasoning by link.
        const resumeProps: Record<string, unknown> = { ...(this.#workspace.descendants === true ? { descendants: true } : {}), control: true, reasoning: "link" };
        const fwd: Record<string, unknown> = {
            ...resumeProps,
            ...(opts?.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
            ...(opts?.openPaths !== undefined ? { openPaths: opts.openPaths } : {}),
        };
        const forwardedProps = Object.keys(fwd).length > 0 ? fwd : undefined;
        // AG-UI interrupt/resume: a stopped-world ends the run with an interrupt, a proposal's
        // carrying the daemon's projection, an interaction's naming its request_user_input
        // TOOL_CALL (the loop stays paused in-engine). resolve() supplies the decision; we POST a
        // standard resume as the resume run and keep consuming — done spans the whole pause/resume
        // chain, so the TUI's seam contract never changes.
        let streaming = false;
        let ending: ProblemDetails | null = null;
        // {§cli-summary-line-per-loop} A Problem that ends a Run: a prompt's Run reports it as its outcome (a broken
        // wire is never a success); an observation reports no loop outcome at all and names it through `failure`.
        const failed = (problem: ProblemDetails): TerminatedInfo | null => {
            ending = problem;
            return prompt === undefined ? null : { finalStatus: problem.status, hitMaxTurns: false, result: operationResult({ status: problem.status, problem }) };
        };
        const done = (async (): Promise<TerminatedInfo | null> => {
            let terminated: TerminatedInfo | null = null;
            let sawRunError = false;
            let runProblem: ProblemDetails | null = null;
            let next: { prompt?: string; resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }> } = { prompt };
            let fp = forwardedProps;
            // plurnk-service {§agui-run-input}: a Run that carries nothing new synchronizes.
            let observing = prompt === undefined;
            // {§cli-gate-answer-lifetime} The gate whose answer the next Run carries, held until that Run ends.
            let answered: { readonly release: () => void } | undefined;
            const letGo = (): void => { answered?.release(); answered = undefined; };
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
                    streaming = true;
                    for await (const e of synchronized) {
                        if (!observing) ready.resolve();
                        // Applied, refused or lost, the answer's Run is over before what it presents is reviewed.
                        if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") letGo();
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
                                return failed(cause.problem);
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
                                return failed(problem);
                            }
                        } else {
                            this.#dispatch(e, projection);
                        }
                    }
                    streaming = false;
                } catch (err) {
                    streaming = false;
                    if (ac.signal.aborted) return terminated ?? failed(clientTransportCancelled());
                    throw err;
                } finally {
                    letGo();
                }
                // HttpAgent reports abort through the event stream and then completes;
                // cancellation is therefore observed here rather than necessarily in
                // the catch path. The transport contract remains a clean 499 outcome.
                if (ac.signal.aborted) return terminated ?? failed(clientTransportCancelled());
                if (terminated !== null) return terminated;
                if (pausedInteraction !== null && interruptId === undefined) {
                    const problem = clientTransportInterruptMismatch(`int:${pausedInteraction}`);
                    this.#h?.onProblem?.(problem);
                    return failed(problem);
                }
                if (pausedProp === null && pausedInteraction === null) {
                    // plurnk-service {§agui-held-interrupts}: an answer refused because its gate no longer waits, settled by
                    // another client or the daemon, ends nothing: the refusal is shown and the work is followed.
                    if (next.resume !== undefined && runProblem !== null && isUnpending(runProblem)) {
                        sawRunError = false;
                        runProblem = null;
                        // The refused call still awaits its decision here; the observation's snapshot rebuilds it settled.
                        projection.rows = new RowAssembler();
                        next = {};
                        fp = forwardedProps;
                        observing = true;
                        continue;
                    }
                    if (prompt === undefined && observed && !sawRunError && runProblem === null) return null;
                    // NO fabricated success (fabrication audit, 2026-07-11): a stream that
                    // ends without terminal truth is a broken wire — 502, never 200. The daemon's own
                    // Problem was already diagnosed by #ended; a synthesized one is diagnosed here.
                    if (runProblem === null) {
                        const synthesized = sawRunError ? clientTransportProblemMissing() : clientTransportTerminalMissing();
                        this.#h?.onProblem?.(synthesized);
                        return failed(synthesized);
                    }
                    return failed(runProblem);
                }
                if (joined !== undefined) {
                    // {§cli-gate-answer-lifetime} One resolver per interrupt in this client: a gate another of its Runs holds is
                    // held here on a connection too, until it settles or that Run lets it go; then the work is followed.
                    const ended = AbortSignal.any([joined, ac.signal]);
                    const letGoThere = new Promise<void>((resolve) => {
                        if (ended.aborted) resolve();
                        else ended.addEventListener("abort", () => resolve(), { once: true });
                    });
                    const held = interruptId === undefined ? undefined : await this.#hold(binding, forwardedProps, interruptId, ac.signal, letGoThere);
                    if (held === undefined) await letGoThere;
                    ac.signal.throwIfAborted();
                    if (held !== undefined && held.terminated !== null) return held.terminated;
                    // The held call was folded on the hold; the observation's snapshot rebuilds the conversation's calls.
                    projection.rows = new RowAssembler();
                    next = {};
                    fp = forwardedProps;
                    observing = true;
                    continue;
                }
                const decision = interactionResolution ?? proposalResolution;
                if (decision === null) throw new Error("paused run ended without a resolution channel");
                if (interruptId === undefined) throw new Error("paused run ended without an interrupt identity");
                // plurnk-service {§agui-held-interrupts}: while the review is open, a connection holding its interrupt observes
                // the worker; a gate another client's answer or the daemon settles withdraws the review, and the work that
                // continues is followed.
                const review = pausedInteraction !== null ? this.#pendingInteractions.get(pausedInteraction)
                    : pausedProp === null ? undefined : this.#pendingProposals.get(pausedProp);
                const settledElsewhere = review === undefined ? undefined
                    : await this.#holdReview(binding, forwardedProps, interruptId, ac.signal, review, decision);
                ac.signal.throwIfAborted();
                if (settledElsewhere !== undefined) {
                    if (settledElsewhere !== null) return settledElsewhere;
                    // The settled call was folded on the hold; the observation's snapshot rebuilds the conversation's calls.
                    projection.rows = new RowAssembler();
                    next = {};
                    fp = forwardedProps;
                    observing = true;
                    continue;
                }
                if (interactionResolution !== null && pausedInteraction !== null) {
                    const a = await interactionResolution;
                    ac.signal.throwIfAborted();
                    if (a === undefined) throw new Error("interaction ended without a resolution");
                    next = a === "cancel"
                        ? { resume: [{ interruptId, status: "cancelled" }] }
                        : { resume: [{ interruptId, status: "resolved", payload: a }] };
                    answered = review;
                    fp = resumeProps;
                    observing = false;
                    continue;
                }
                if (proposalResolution === null) throw new Error("proposal ended without a resolution channel");
                // Paused: hold done open until the client resolves, then resume the interrupt.
                const r = await proposalResolution;
                ac.signal.throwIfAborted();
                if (r === undefined) throw new Error("proposal ended without a resolution");
                next = { resume: [proposalResume(interruptId, r)] };
                answered = review;
                fp = resumeProps;
                observing = false;
            }
        })().then((terminal) => {
            ready.resolve();
            return terminal;
        }).catch((cause: unknown): TerminatedInfo => {
            // plurnk-service {§agui-action-binding}: the binding stands when its worker, or its workspace, does not
            // exist yet; only the observation fails.
            if (prompt === undefined && isAbsentWorker(cause)) ready.resolve();
            else ready.reject(cause);
            if (!ac.signal.aborted) throw cause;
            return failed(clientTransportCancelled()) as TerminatedInfo;
        }).finally(() => {
            ac.abort();
            this.#controllers.delete(ac);
            if (this.#modelProjection === projection) this.#modelProjection = null;
        });
        return { done, ready: ready.promise, cancel: () => ac.abort(), streaming: () => streaming, failure: () => ending };
    }

    // plurnk-service {§agui-held-interrupts}: while this client's review of a gate is open, a connection holds its interrupt.
    // Undefined when the review is answered here first, or the hold ends without the gate settling; otherwise the gate
    // settled elsewhere and the review is withdrawn: the loop's terminal when the hold carried it, else null.
    async #holdReview(binding: { threadId: string }, forwardedProps: Record<string, unknown> | undefined, interruptId: string,
        signal: AbortSignal, review: { readonly decided: boolean; readonly withdraw: () => void },
        decision: Promise<unknown>): Promise<TerminatedInfo | null | undefined> {
        if (review.decided) return undefined;
        const held = await this.#hold(binding, forwardedProps, interruptId, signal, decision);
        if (held === undefined) return undefined;
        review.withdraw();
        return held.terminated;
    }

    // plurnk-service {§agui-held-interrupts}: a connection naming a gate's interrupt observes the worker, drawing what it brings
    // as live rows, until the gate settles or `until` does. The settlement, with the loop's terminal when the hold carried
    // it; undefined when `until` came first or the hold ended without the gate settling.
    async #hold(binding: { threadId: string }, forwardedProps: Record<string, unknown> | undefined, interruptId: string,
        signal: AbortSignal, until: Promise<unknown>): Promise<{ readonly terminated: TerminatedInfo | null } | undefined> {
        const hold = new AbortController();
        // The hold's own conversation: its snapshot rebuilds the calls, the held one among them, that its settlement folds onto.
        const projection: StreamProjection = { gauge: null, reasoning: new ReasoningEvents(), rows: new RowAssembler() };
        const observed = (async (): Promise<{ readonly terminated: TerminatedInfo | null } | undefined> => {
            let settled = false;
            let terminated: TerminatedInfo | null = null;
            for await (const e of runViaAgui(this.#target, {
                ...binding, forwardedProps: { ...forwardedProps, interrupts: [interruptId] },
                capabilities: clientCapabilities(this.#workspace.auto !== true), connect: true,
            }, AbortSignal.any([signal, hold.signal]))) {
                const ended = this.#ended(e);
                if (ended.terminated !== null) terminated = ended.terminated;
                if (e.type === "RUN_FINISHED") settled = e.outcome?.type !== "interrupt";
                else if (e.type === "MESSAGES_SNAPSHOT") {
                    for (const entry of snapshotRows(e.messages, projection.rows)) if (this.#seenRows.get(entry.id) !== this.#rowVersion(entry)) this.#row(entry);
                } else if (e.type !== "RUN_ERROR") this.#dispatch(e, projection);
            }
            return settled || terminated !== null ? { terminated } : undefined;
        })().catch((cause: unknown) => {
            if (!hold.signal.aborted && !signal.aborted && cause instanceof ProblemError) this.#h?.onProblem?.(cause.problem);
            return undefined;
        });
        const first = await Promise.race([until.then(() => undefined), observed]);
        if (first === undefined) hold.abort();
        return first;
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
                if (pending.get(id) === entry) pending.delete(id);
                signal.removeEventListener("abort", cancel);
                completed.abort();
            };
            const withdraw = (): void => {
                if (entry.decided) return;
                entry.decided = true;
                resolve(undefined);
                release();
                this.#h?.onInterruptEnd?.(`${kind === "Proposal" ? "proposal" : "int"}:${id}`);
            };
            const entry = { signal: completed.signal, settle, release, withdraw, decided: false };
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
    async useWorkspace(name: string | undefined, params: Parameters<Transport["useWorkspace"]>[1]): Promise<WorkspaceHandle> {
        const workspace = await this.rpc<WorkspaceHandle>("workspace.create", {
            ...(name === undefined ? {} : { name }),
            ...(params.projectRoot === undefined ? {} : { projectRoot: params.projectRoot }),
            ...(this.#workspace.settings === undefined ? {} : { settings: this.#workspace.settings }),
        });
        if (!Number.isSafeInteger(workspace.id) || workspace.id <= 0 || typeof workspace.name !== "string" || workspace.name.length === 0) {
            throw new ProblemError(clientTransportResultInvalid("workspace.create omitted its workspace identity."));
        }
        this.#binding = { workspaceId: workspace.id, worker: params.worker };
        this.#resetHistory();
        return workspace;
    }
    useWorker(name: string): void {
        this.#binding = { ...this.#binding, worker: name };
        this.#resetHistory();
    }
    #resetHistory(): void {
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
        } else if (name === "plurnk.stream") {
            const target = objectOf(value)?.target;
            this.#h?.onStream(value as StreamEventPayload | StreamConcludedPayload, typeof target === "string" && projection.rows.awaitsReceipt(target));
        }
        else if (name === "plurnk.notice") this.#h?.onNotice(value as Notice);
        else if (name === "plurnk.descendant") this.#h?.onDescendant?.(value as Descendant);
        else if (name === "plurnk.outside") this.#h?.onOutside(value as OutsideText);
        // A Problem that ends no Run, such as an unavailable provider catalog, stays its own event.
        else if (name === "plurnk.problem") this.#h?.onProblem?.(problemDetails(value));
    }
}
