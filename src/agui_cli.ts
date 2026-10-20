// CLI one-shot through the daemon's AG-UI endpoint: we POST the run and render the
// AG-UI SSE projection. Operations render from the standard parts their rows build,
// with the rows' facts as metadata ({§cli-row-sources}), and provider reasoning from
// AG-UI's standard reasoning lifecycle.
// Text mode: stdout = delivered response messages, stderr = the per-row trace.
//
// JSON mode uses the terminal projection's complete loop identity and usage.

import Knobs from "./knobs.ts";
import process from "node:process";
import type { ResumeEntry } from "@ag-ui/core";
import { formatPlain, exitCodeForLoop, buildJsonRecord } from "./cli.ts";
import { extractSendBody, isEmission, isResponseMessage } from "./render.ts";
import type { LogEntryWire, LoopUsage, OutsideText } from "./render.ts";
import { isUnpending, proposalOf, proposalResume, reviewProposal, type Resolution, type ProposalParams } from "./proposal.ts";
import ToolAcceptance from "./tool-acceptance.ts";
import {
    ProblemError,
    clientAguiError,
    clientActionResultMissing,
    clientTransportInterruptMismatch,
    clientTransportProblemMissing,
    clientTransportTerminalMissing,
    renderDiagnostic,
    report,
} from "./diagnostics.ts";
import type { Notice } from "./diagnostics.ts";
import StreamTrace, { inlineable, renderInline, streamAddress, type StreamConcludedPayload, type StreamEventPayload } from "./stream.ts";
import { clientCapabilities } from "./client-capabilities.ts";
import { actionViaAgui, runViaAgui, type AguiEvent, type AguiTarget, type WorkspaceHandle } from "./agui.ts";
import { actionOutcome, entryReadResult, operationResult, problemDetails, runEnd, type ActionOutcome } from "./agui.ts";
import type { EntryReadResult, OperationResult, ProblemDetails } from "@plurnk/plurnk-contracts";
import ReasoningEvents from "./reasoning-events.ts";
import RowAssembler, { snapshotRows, wholeRow } from "./rows.ts";
import TerminalStatusLine, { accrueTurnAccounting, turnAccountingFromNotice, type TurnAccounting, EMPTY_TALLY, isWorkerGauge, projectStatusGauge, reduceStatusGauge, type ClientStatus, type StatusGaugeEnvelope } from "./status.ts";
import { renderSummary } from "./render.ts";
import { withColorOutput } from "./color.ts";
import type Lifetime from "./lifetime.ts";
import { signalExitCode } from "./lifetime.ts";

// The terminal record a Run's end carries (plurnk-service {§agui-plurnk-metadata}): the loop/terminated
// notification plus the daemon workspaceId.
interface TerminatedValue {
    workspaceId: number | null;
    workerId: number;
    loopId: number;
    hitMaxTurns: boolean;
    turnIds: number[];
    usage: LoopUsage;
    result: OperationResult;
}

export interface CliRunResult {
    exitCode: number;
    // Terminate-resume: set when the segment ended on a client-owned proposal
    // tool-call — the caller POSTs this as the next run's standard resume.
    pendingResume: ResumeEntry | null;
    // The proposal the segment ended on: decided already when pendingResume is set, otherwise the person's to review.
    gate: { readonly interruptId: string; readonly proposal: ProposalParams } | null;
    // The segment saw its Run finish with an outcome other than an interrupt.
    observedEnd: boolean;
    entries: LogEntryWire[];
    notices: Notice[];
    response: string;
    terminated: TerminatedValue | null;
    modelWorkerId: number | null;
    problem: ProblemDetails | null;
}

export interface CliRunSinks {
    out: (s: string) => void;   // stdout — the answer (text mode)
    err: (s: string) => void;   // stderr — the trace (text mode)
    notice: (notice: Notice) => void;
    json: boolean;              // json mode: stay silent, accumulate; the caller emits ONE doc
    yolo: boolean;
    noReviewChannel: boolean;
    acceptance: ToolAcceptance;
    reviewRequested?: boolean;
    // plurnk-service {§agui-held-interrupts}: null when `signal` withdraws the review, its gate settled elsewhere.
    review: (p: ProposalParams, signal: AbortSignal) => Promise<Resolution | null>;
    onActionResult?: (v: ActionOutcome) => void;
    onRow?: (entry: LogEntryWire) => void;
    onStreamConcluded?: (concluded: StreamConcludedPayload) => void;
    readStream?: (concluded: StreamConcludedPayload) => Promise<Readonly<Record<string, { content: string }>>>;
    onTurnAccounting?: (turn: TurnAccounting) => void;
    onStatus?: (status: ClientStatus) => void;
    onProgress?: (result: CliRunResult) => void;
}

const mergeRunSegments = (prior: CliRunResult, segment: CliRunResult): CliRunResult => ({
    ...segment,
    entries: [...prior.entries, ...segment.entries],
    notices: [...prior.notices, ...segment.notices],
    response: segment.response.length > 0 ? segment.response : prior.response,
    modelWorkerId: prior.modelWorkerId ?? segment.modelWorkerId,
    problem: segment.problem ?? prior.problem,
});

const runOutcome = (result: CliRunResult): OperationResult => {
    if (result.terminated !== null) return result.terminated.result;
    const problem = result.problem ?? clientTransportTerminalMissing();
    return { status: problem.status, problem };
};

// A row as this invocation drew it: a later version of the same row is drawn again.
const drawnKey = (entry: LogEntryWire): string => `${entry.id}/${String(entry.status_rx ?? "")}`;

// plurnk-service {§agui-sync}: an observation of the work that follows a gate draws, from its snapshot, the rows from that
// gate's row on that this invocation has not drawn.
export interface CliObservation {
    readonly since: number;
    readonly drawn: ReadonlySet<string>;
}

const readStream = async (
    target: AguiTarget,
    binding: { threadId: string },
    concluded: StreamConcludedPayload,
    signal?: AbortSignal,
): Promise<Readonly<Record<string, { content: string }>>> => {
    const result = entryReadResult(await actionViaAgui(target, {
        threadId: binding.threadId,
        kind: "entry.read", params: { target: concluded.target, workerId: concluded.workerId },
    }, signal));
    if (result.entry === null) throw new ProblemError(result.problem);
    return result.entry.channels;
};

// Drive one AG-UI run's event stream. Text mode renders to the sinks
// (stdout = answer, stderr = trace); json mode stays silent and accumulates the
// full record (entries/notices/response/terminated/modelWorkerId) for the caller
// to emit as ONE document. The Run end's terminal record is the authoritative outcome (its
// result.status/hitMaxTurns win over the RUN_ERROR-inferred code). Event source
// injected so it's testable without a live daemon.
export const consumeCliRun = (events: AsyncIterable<AguiEvent>, io: CliRunSinks, observation?: CliObservation): Promise<CliRunResult> => withColorOutput(process.stderr, async () => {
    let finalStatus = 200;
    let hitMaxTurns = false;
    let response = "";
    let terminated: TerminatedValue | null = null;
    let modelWorkerId: number | null = null;
    let pendingResume: CliRunResult["pendingResume"] = null;
    let gate: CliRunResult["gate"] = null;
    let observedEnd = false;
    let problem: ProblemDetails | null = null;
    let problemReported = false;
    const reportProblem = (reported: ProblemDetails): void => {
        problem = reported;
        finalStatus = reported.status;
        if (!io.json) {
            io.err(`${renderDiagnostic(reported)}\n`);
            problemReported = true;
        }
    };
    let sawRunError = false;
    let sawActionResult = false;
    let toolId = "";
    // Each interrupt by its own id and by the call it names.
    const interrupts = new Map<string, string>();
    const entries: LogEntryWire[] = [];
    const notices: Notice[] = [];
    const streams = new StreamTrace();
    const reasoning = new ReasoningEvents();
    const rows = new RowAssembler();
    const presentRow = (entry: LogEntryWire): void => {
        io.onRow?.(entry);
        const workerId = entry.worker_id;
        if (modelWorkerId === null && entry.origin === "model" && typeof workerId === "number") modelWorkerId = workerId;
        const belongsToRun = typeof workerId !== "number" || modelWorkerId === null || workerId === modelWorkerId;
        const message = belongsToRun && isResponseMessage(entry) ? extractSendBody(entry.tx) : "";
        const separator = response.length > 0 ? "\n\n" : "";
        if (message.length > 0) response += separator + message;
        if (io.json) { entries.push(entry); return; }
        if (isEmission(entry)) return;
        io.err(`${formatPlain(entry)}\n`);
        if (message.length > 0) io.out(`${separator.length > 0 ? "\n" : ""}${message}\n`);
    };
    // {§cli-stream-event-and-stream-concluded} An execution's conclusion line, then a preview of its output.
    const presentConclusion = async (payload: StreamConcludedPayload, line: string): Promise<void> => {
        io.err(`${line}\n`);
        if (io.readStream === undefined) return;
        try {
            const channels = await io.readStream(payload);
            for (const name of ["stdout", "stderr"]) {
                const content = channels[name]?.content;
                if (content !== undefined && inlineable(content)) io.err(`${renderInline(name, content, process.stderr.columns ?? Number.POSITIVE_INFINITY)}\n`);
            }
        } catch (cause) {
            if (cause instanceof ProblemError) io.err(`${renderDiagnostic(cause.problem)}\n`);
            else io.notice({ source: "client:stream", kind: "preview_unavailable", level: "warn",
                message: `Stream output unavailable: ${cause instanceof Error ? cause.message : String(cause)}` });
        }
    };
    // A row, then the conclusion that arrived before it settled, if one did.
    const presentWithConclusion = async (entry: LogEntryWire): Promise<void> => {
        presentRow(entry);
        if (io.json) return;
        const concluded = streams.settled(entry);
        if (concluded === null) return;
        await presentConclusion(concluded, streams.concluded(concluded, process.stderr.columns ?? Number.POSITIVE_INFINITY));
    };
    const visibleReasoning = new Map<string, { atLineStart: boolean }>();
    let statusGauge: StatusGaugeEnvelope | null = null;
    const snapshot = (): CliRunResult => ({
        exitCode: exitCodeForLoop(finalStatus, hitMaxTurns), entries, notices, response,
        terminated, modelWorkerId, pendingResume, gate, observedEnd, problem,
    });
    io.onProgress?.(snapshot());
    for await (const e of events) {
        try {
            if (e.type === "RUN_STARTED") continue;
            // A Run's end carries the bound loop's terminal record, the Problem of a Run that failed without one, or an
            // action's outcome (plurnk-service {§agui-plurnk-metadata}).
            const end = runEnd(e);
            if (end !== null) {
                if (e.type === "RUN_ERROR") sawRunError = true;
                if (e.type === "RUN_FINISHED" && e.outcome?.type !== "interrupt") observedEnd = true;
                if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
                    for (const interrupt of e.outcome.interrupts) {
                        interrupts.set(interrupt.id, interrupt.id);
                        if (interrupt.toolCallId !== undefined) interrupts.set(interrupt.toolCallId, interrupt.id);
                        // plurnk-service {§agui-proposal-resolve}: a proposal is its interrupt, carrying the daemon's projection.
                        let proposal: ProposalParams | null;
                        try {
                            proposal = proposalOf(interrupt);
                        } catch (cause) {
                            if (!(cause instanceof ProblemError)) throw cause;
                            problem = cause.problem;
                            finalStatus = problem.status;
                            continue;
                        }
                        if (proposal === null) continue;
                        // A proposal reaching the client is client-owned. A decision no person makes resumes it at once; a
                        // person's review is the caller's, held meanwhile (plurnk-service {§agui-held-interrupts}).
                        gate = { interruptId: interrupt.id, proposal };
                        const automatic = io.acceptance.resolve(proposal, io);
                        if (automatic !== null) pendingResume = proposalResume(interrupt.id, automatic);
                    }
                }
                if (end.terminal !== undefined) {
                    const raw = end.terminal as TerminatedValue;
                    terminated = { ...raw, result: operationResult(raw.result) };
                    finalStatus = terminated.result.status;
                    hitMaxTurns = terminated.hitMaxTurns;
                    problem = terminated.result.problem ?? problem;
                    if (!io.json && terminated.result.problem !== undefined && !problemReported) {
                        io.err(`${renderDiagnostic(terminated.result.problem)}\n`);
                        problemReported = true;
                    }
                }
                if (end.problem !== undefined) reportProblem(problemDetails(end.problem));
                if (end.result !== undefined) {
                    sawActionResult = true;
                    io.onActionResult?.(actionOutcome(end.result));
                }
                continue;
            }
            // plurnk-service {§agui-sync}: a snapshot seeds the calls this Run's live events fold onto; an observation of the
            // work after a gate draws the rows from that gate's on that this invocation has not drawn.
            if (e.type === "MESSAGES_SNAPSHOT") {
                for (const entry of snapshotRows(e.messages, rows)) {
                    if (observation !== undefined && entry.id >= observation.since && !observation.drawn.has(drawnKey(entry))) await presentWithConclusion(entry);
                }
                continue;
            }
            // {§cli-row-sources} A row arrives as the part it built, or whole when it built none.
            for (const entry of rows.consume(e)) await presentWithConclusion(entry);
            if (e.type === "TOOL_CALL_START") { toolId = String((e as { toolCallId?: unknown }).toolCallId ?? ""); continue; }
            if (e.type === "TOOL_CALL_END" && /^int:[1-9]\d*$/.test(toolId)) {
                pendingResume = { interruptId: toolId, status: "cancelled" };
                continue;
            }
            const state = reduceStatusGauge(statusGauge, e);
            if (state.handled) {
                statusGauge = state.gauge;
                // A Run that binds no worker reports no gauge.
                if (!io.json && isWorkerGauge(state.gauge)) io.onStatus?.(projectStatusGauge(state.gauge.plurnk.status, state.gauge.plurnk.workspace));
                continue;
            }
            const reasoningEvent = reasoning.consume(e);
            if (reasoningEvent.handled) {
                const update = reasoningEvent.update;
                if (!io.json && update?.phase === "content" && update.delta.length > 0) {
                    const prior = visibleReasoning.get(update.messageId);
                    const prefix = prior === undefined ? "💭 " : prior.atLineStart ? "   " : "";
                    const body = update.delta.replace(/\n(?=.)/g, "\n   ");
                    visibleReasoning.set(update.messageId, { atLineStart: update.delta.endsWith("\n") });
                    io.err(`${prefix}${body}`);
                } else if (!io.json && update?.phase === "end") {
                    const prior = visibleReasoning.get(update.messageId);
                    visibleReasoning.delete(update.messageId);
                    if (prior !== undefined && !prior.atLineStart) io.err("\n");
                }
                continue;
            }
            if (e.type !== "CUSTOM") continue;   // generic vocab is for third-party frontends
            const name = (e as { name?: string }).name;
            const value = (e as { value?: unknown }).value;
            if (name === "plurnk.ambient") {
                const entry = wholeRow(value);
                if (entry !== null) await presentWithConclusion(entry);
            } else if (name === "plurnk.problem") {
                // A Problem that ends no Run, such as an unavailable provider catalog, stays its own event.
                reportProblem(problemDetails(value));
            } else if (name === "plurnk.notice") {
                const notice = value as Notice;
                // (#465) turn_generated carries the turn's settled wire accounting in
                // every mode — the accrual hook runs before display routing so json
                // (the benchlet surface) still streams running cost.
                const turn = turnAccountingFromNotice(notice);
                if (turn !== null) io.onTurnAccounting?.(turn);
                if (io.json) notices.push(notice);
                else io.notice(notice);
            } else if (name === "plurnk.outside") {
                // {§cli-outside-text} — the turn's prose outside its fences is trace, never the answer.
                if (!io.json) io.err(`${(value as OutsideText).text}\n`);
            } else if (name === "plurnk.stream") {
                // plurnk.stream carries the whole lifecycle: a concluded payload has
                // its exact result; a start/event payload has state. (json: streams aren't in
                // the record — content is fetched on demand via `read L/T/S`.)
                const concluded = typeof (value as { result?: { status?: unknown } }).result?.status === "number";
                if (concluded) io.onStreamConcluded?.(value as StreamConcludedPayload);
                if (!io.json) {
                    if (concluded) {
                        const payload = value as StreamConcludedPayload;
                        const line = streams.concluded(payload, process.stderr.columns ?? Number.POSITIVE_INFINITY, rows.awaitsReceipt(payload.target));
                        if (line !== null) await presentConclusion(payload, line);
                    } else {
                        const line = streams.event(value as StreamEventPayload);
                        if (line !== null) io.err(`${line}\n`);
                    }
                }
            }
        } finally {
            io.onProgress?.(snapshot());
        }
    }
    if (pendingResume !== null) {
        const interruptId = interrupts.get(pendingResume.interruptId);
        if (interruptId === undefined) {
            problem = clientTransportInterruptMismatch(pendingResume.interruptId);
            pendingResume = null;
            finalStatus = problem.status;
        } else {
            pendingResume = { ...pendingResume, interruptId };
        }
    }
    // A stream that ended with NO terminal truth (no terminated, no RUN_ERROR, no
    // pending resume) is a DEAD stream — 502, never the initialized 200. An observation's Run may finish without a loop's
    // terminal: it saw what it observed end.
    if (terminated === null && pendingResume === null && gate === null && problem === null && !sawActionResult && !(observation !== undefined && observedEnd)) {
        problem = sawRunError ? clientTransportProblemMissing() : clientTransportTerminalMissing();
        finalStatus = problem.status;
    }
    if (!io.json && problem !== null && !problemReported) {
        io.err(`${renderDiagnostic(problem)}\n`);
    }
    return snapshot();
});

// Wire the live AG-UI endpoint + terminal for one CLI prompt. text: stdout=answer,
// stderr=trace. json: silent, then ONE buildJsonRecord document on stdout —
// identical schema in both CLI modes (the terminal record carries workspaceId/loopId/
// turnIds/cost; modelWorkerId derived from the rows).
export const runCliViaAgui = async (
    target: AguiTarget,
    prompt: string,
    opts: { lifetime: Lifetime; threadId: string; workspace: WorkspaceHandle; modelLabel?: string; maxTurns?: number; openPaths?: string[]; timeoutSec?: number; yolo: boolean; auto: boolean; reviewRequested?: boolean; json: boolean; statusStream: boolean },
): Promise<number> => {
    // {§cli-fail-closed-no-review-channel} With no local acceptance or review channel,
    // reject locally. A submitted message cannot change the worker's authority.
    const diagnostics: Notice[] = [];
    const acceptance = new ToolAcceptance((notice) => { diagnostics.push(notice); if (!opts.json) report(notice); });
    // {§cli-worker-ownership} A person attends an interactive terminal unless `--auto` says nobody does.
    const capabilities = clientCapabilities(!opts.auto && process.stdin.isTTY === true);
    const noReviewChannel = !capabilities.interactive;
    // Only per-run controls ride this bound Run. Workspace creation and durable worker
    // model selection have already completed ({§cli-workspaces-and-workers}, {§worker-model-selection}).
    const fp: Record<string, unknown> = {
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.openPaths !== undefined ? { openPaths: opts.openPaths } : {}),
    };
    const forwardedProps = Object.keys(fp).length > 0 ? fp : undefined;
    const started = Date.now();
    let result: CliRunResult = {
        exitCode: 4, pendingResume: null, gate: null, observedEnd: false, entries: [], notices: diagnostics, response: "",
        terminated: null, modelWorkerId: null, problem: null,
    };
    // The rows this invocation drew, so an observation after a gate draws only what it has not.
    const drawn = new Set<string>();
    let activeSegment: CliRunResult | null = null;
    let accruedStream: TurnAccounting | null = null;
    const ac = new AbortController();
    const statusLine = new TerminalStatusLine(
        (value) => process.stderr.write(value),
        !opts.json && process.stderr.isTTY === true,
        { lifecycle: "running", model: opts.modelLabel ?? null, loopId: null, packetCount: null, activity: null, children: null, gated: null },
        { workspace: opts.workspace.name, worker: null, child: null, tally: EMPTY_TALLY, runningSince: started },
    );
    statusLine.update({});
    const io = {
        out: (s: string) => statusLine.product(
            s,
            (value) => process.stdout.write(value),
            process.stdout.isTTY === true,
        ),
        err: (s: string) => statusLine.durable(s),
        notice: (notice: Parameters<typeof report>[0]) => statusLine.durable(`${renderDiagnostic(notice)}\n`),
        // (#465) accrue running loop cost; --status-stream also prints a
        // greppable plain row per turn (stderr), the benchlet's live price feed.
        onTurnAccounting: (turn: TurnAccounting) => {
            if (opts.statusStream) {
                accruedStream = accrueTurnAccounting(accruedStream, turn);
                process.stderr.write(`status-stream: turn \u2193${turn.inputTokens ?? "?"} \u2191${turn.outputTokens ?? "?"} $${turn.costUsd ?? "?"} \u00b7 loop \u2193${accruedStream.inputTokens ?? "?"} \u2191${accruedStream.outputTokens ?? "?"} $${accruedStream.costUsd ?? "?"}\n`);
            }
        },
        onStatus: (status: ClientStatus) => statusLine.update(status),
        onProgress: (progress: CliRunResult) => { activeSegment = progress; },
        readStream: (concluded: StreamConcludedPayload) => readStream(target, opts, concluded, ac.signal),
        json: opts.json,
        yolo: opts.yolo,
        noReviewChannel,
        acceptance,
        reviewRequested: opts.reviewRequested,
        review: reviewProposal,
        onRow: (entry: LogEntryWire) => { drawn.add(drawnKey(entry)); },
    };
    // --timeout <s>: at the deadline, fire loop.cancel at the daemon (the loop
    // resolves 499) and, if the stream still hasn't ended after a grace, abort the
    // SSE locally: that ends delivery only, the cancel was already sent
    // ({§agui-run-disconnect}). Exit 3 with timedOut:true in the record, per SPEC §1.
    let timedOut = false;
    const cancellationGraceMs = Knobs.cancelGraceMs();
    const cancelLoop = (reason: string, signal: AbortSignal): Promise<unknown> => actionViaAgui(target, {
        threadId: opts.threadId,
        kind: "loop.cancel", params: { reason },
    }, signal);
    let graceTimer: NodeJS.Timeout | undefined;
    const deadline = opts.timeoutSec !== undefined && opts.timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            void cancelLoop("client_timeout", ac.signal).catch((cause) => {
                if (!ac.signal.aborted) process.stderr.write(`Cancellation could not be confirmed: ${String(cause)}\n`);
            });
            graceTimer = setTimeout(() => ac.abort(), cancellationGraceMs);
        }, opts.timeoutSec * 1000)
        : undefined;

    // One record, emitted exactly once — the normal path, the timeout path, and a
    // signal flush (a killed client must not lose its --json record) all funnel here.
    let emission: Promise<void> | undefined;
    const emitRecord = (r: CliRunResult): Promise<void> => {
        if (!opts.json) return Promise.resolve();
        if (emission !== undefined) return emission;
        const t = r.terminated;
        const outcome = runOutcome(r);
        const doc = buildJsonRecord({
            workspace: opts.workspace,
            prompt,
            response: r.response,
            entries: r.entries,
            notices: r.notices,
            result: {
                loopId: t?.loopId ?? 0,
                modelWorkerId: t?.workerId ?? r.modelWorkerId ?? undefined,
                turnIds: t?.turnIds ?? [],
                finalStatus: outcome.status,
                hitMaxTurns: t?.hitMaxTurns ?? false,
                usage: t?.usage,
                problem: outcome.problem,
            },
            wallMs: Date.now() - started,
            timedOut,
        });
        emission = new Promise((resolve, reject) => {
            process.stdout.write(`${JSON.stringify(doc)}\n`, (error) => error ? reject(error) : resolve());
        });
        return emission;
    };

    // Terminate-resume segments: a client-owned proposal ends the segment as a
    // tool-call; the decision POSTs as the next segment's resume. Accumulate
    // across segments — one logical run, one record.
    let next: { prompt?: string; resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>; forwardedProps?: Record<string, unknown> } = { prompt, forwardedProps };
    const cancellation = new AbortController();
    let interruption: Promise<void> | undefined;
    const interrupt = (reason: string, exitCode: number): void => {
        if (interruption !== undefined) {
            cancellation.abort(new Error("Interrupted again while cancelling."));
            return;
        }
        if (!opts.json) statusLine.durable("Cancelling… (interrupt again to stop waiting)\n");
        const partial = activeSegment === null ? result : mergeRunSegments(result, activeSegment);
        interruption = Promise.allSettled([
            emitRecord(partial),
            cancelLoop(reason, AbortSignal.any([cancellation.signal, AbortSignal.timeout(cancellationGraceMs)])),
        ]).then(async ([flushed, cancelled]) => {
            if (flushed.status === "rejected") process.stderr.write(`Could not flush interrupted CLI record: ${String(flushed.reason)}\n`);
            if (cancelled.status === "rejected") process.stderr.write(`Cancellation could not be confirmed: ${String(cancelled.reason)}\n`);
            // Close our response before stopping an owned backend. Deliberate cancellation
            // must not leave the SSE reader to discover a severed socket during shutdown.
            ac.abort();
            await opts.lifetime.exit(exitCode);
        });
    };
    const releaseSignals = opts.lifetime.handleSignals((signal) => interrupt(`user_${signal.toLowerCase()}`, signalExitCode(signal)));
    const statusTick = !opts.json && process.stderr.isTTY === true
        ? setInterval(() => statusLine.update({}), 1_000)
        : undefined;
    statusTick?.unref();
    try {
        try {
            const segment = async (input: typeof next, observation?: CliObservation): Promise<CliRunResult> => {
                const run = await consumeCliRun(runViaAgui(target, { threadId: opts.threadId, capabilities, ...input }, ac.signal), io, observation);
                activeSegment = null;
                return run;
            };
            // plurnk-service {§agui-held-interrupts}: the person reviews a proposal while a connection holds its interrupt. When
            // another client's answer or the daemon settles it first, the menu withdraws, a decision already under way (an
            // editor) finishes and is not sent, and what the hold observed stands.
            const heldReview = async (gate: NonNullable<CliRunResult["gate"]>, observation: CliObservation): Promise<{ readonly resume: ResumeEntry } | { readonly held: CliRunResult }> => {
                const menu = new AbortController();
                const hold = new AbortController();
                const reviewing = io.review(gate.proposal, menu.signal);
                const holding = consumeCliRun(runViaAgui(target, {
                    threadId: opts.threadId, capabilities, forwardedProps: { ...forwardedProps, interrupts: [gate.interruptId] },
                }, AbortSignal.any([ac.signal, hold.signal])), io, observation).then(
                    (held) => held.observedEnd || held.terminated !== null ? held : null,
                    () => null,
                );
                const first = await Promise.race([reviewing.then(() => null), holding]);
                activeSegment = null;
                if (first === null) {
                    // Answered here, or the hold ended with the gate still pending: the person's decision resumes it.
                    hold.abort();
                    const resolution = await reviewing;
                    if (resolution === null) throw new Error("A review withdrew while its gate was still pending.");
                    return { resume: proposalResume(gate.interruptId, resolution) };
                }
                menu.abort();
                await reviewing;
                return { held: first };
            };
            result = mergeRunSegments(result, await segment(next));
            for (;;) {
                const gate = result.gate;
                const following = gate === null ? undefined : { since: gate.proposal.logEntryId, drawn };
                if (result.pendingResume !== null) {
                    const resumed = await segment({ resume: [result.pendingResume] });
                    // plurnk-service {§agui-held-interrupts}: an answer refused because its gate no longer waits ends nothing:
                    // the refusal stands as a notice, and the CLI follows the work.
                    const refused = resumed.terminated === null ? resumed.problem : null;
                    if (refused !== null && isUnpending(refused)) {
                        result = mergeRunSegments(result, { ...resumed, problem: null,
                            notices: [...resumed.notices, { source: "client:agui", kind: "refused", level: "warn", message: refused.detail, problem: refused }] });
                        result = mergeRunSegments(result, await segment({}, following));
                    } else result = mergeRunSegments(result, resumed);
                    continue;
                }
                if (gate !== null && following !== undefined) {
                    const reviewed = await heldReview(gate, following);
                    if ("resume" in reviewed) {
                        result = { ...result, pendingResume: reviewed.resume };
                        continue;
                    }
                    result = mergeRunSegments(result, reviewed.held);
                    if (result.terminated === null && result.gate === null) result = mergeRunSegments(result, await segment({}, following));
                    continue;
                }
                break;
            }
            // An observation that saw its Run end without the loop's terminal leaves the loop's outcome unobserved.
            if (result.terminated === null && result.problem === null) {
                const unobserved = clientTransportTerminalMissing();
                result = { ...result, problem: unobserved, exitCode: exitCodeForLoop(unobserved.status, false) };
            }
        } catch (cause) {
            // {§cli-partial-record} The invocation owns received evidence even when
            // its event iterator throws. Neither a retry nor a fabricated terminal.
            const problem = clientAguiError(target.aguiUrl, cause);
            const partial = activeSegment === null ? result : mergeRunSegments(result, activeSegment);
            result = {
                ...partial,
                pendingResume: null,
                gate: null,
                exitCode: cause instanceof ProblemError ? cause.exitCode : 1,
                problem: partial.problem ?? problem,
                notices: partial.terminated === null && partial.problem === null ? partial.notices : [
                    ...partial.notices,
                    { source: "client:agui", kind: "error", level: "error", message: problem.detail, problem },
                ],
            };
            if (!opts.json && interruption === undefined) io.err(`${renderDiagnostic(problem)}\n`);
        }
        await emitRecord(result);
    } finally {
        if (statusTick !== undefined) clearInterval(statusTick);
        if (interruption !== undefined) await interruption;
        releaseSignals();
        if (deadline !== undefined) clearTimeout(deadline);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
    if (!opts.json) {
        const outcome = runOutcome(result);
        const finalStatus = outcome.status;
        statusLine.update({
            lifecycle: finalStatus === 202 ? "parked"
                : finalStatus === 499 ? "cancelled"
                : finalStatus >= 400 ? "failed"
                    : "completed",
            activity: null,
        });
        const terminated = result.terminated;
        statusLine.settle({ turns: terminated?.turnIds.length ?? 0, wallMs: Date.now() - started });
        // {§cli-cancellation} Without the daemon's terminal record the turn count is unknown, never zero.
        process.stderr.write(withColorOutput(process.stderr, () => `${renderSummary(
            terminated?.turnIds.length ?? null,
            Date.now() - started,
            outcome,
            terminated?.hitMaxTurns ?? false,
            terminated?.usage,
        )}\n`));
    }
    return timedOut ? 3 : result.exitCode;
};

// Script mode over AG-UI+: one op.parse action, the person's own operation, never paused for review.
// Exit honesty: worst op status ≥400 → 4, else 0.
export const runScriptViaAgui = async (
    target: AguiTarget,
    text: string,
    opts: { threadId: string; yolo: boolean; auto: boolean; json: boolean },
): Promise<number> => {
    // {§cli-worker-ownership} A person attends an interactive terminal unless `--auto` says nobody does.
    const capabilities = clientCapabilities(!opts.auto && process.stdin.isTTY === true);
    const noReviewChannel = !capabilities.interactive;
    const acceptance = new ToolAcceptance(report);
    let parse: { results: Array<{ status: number }> } | null = null;
    const io: CliRunSinks = {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        notice: (notice) => report(notice),
        json: opts.json, yolo: opts.yolo, noReviewChannel, acceptance,
        readStream: (concluded) => readStream(target, opts, concluded),
        review: reviewProposal,
        onActionResult: (v) => {
            if (v.kind !== "op.parse") return;
            if (!v.ok) throw new ProblemError(v.problem);
            parse = v.result as { results: Array<{ status: number }> };
        },
    };
    const started = Date.now();
    const forwardedProps: Record<string, unknown> = {
        action: { kind: "op.parse", text },
    };
    await consumeCliRun(runViaAgui(target, { threadId: opts.threadId, capabilities, forwardedProps }), io);
    // NO fabricated success (fabrication audit, 2026-07-11): a script whose parse
    // result never arrived did NOT succeed — fail hard, loudly.
    if (parse === null) throw new ProblemError(clientActionResultMissing("op.parse"));
    const results = (parse as { results: Array<{ status: number }> }).results;
    const worst = results.reduce((w, r) => (r.status > w ? r.status : w), 0);
    const exitCode = worst >= 400 ? 4 : 0;
    if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, script: true, results, worst, exitCode, wallMs: Date.now() - started })}\n`);
        return exitCode;
    }
    process.stderr.write(`\n${results.length} op${results.length === 1 ? "" : "s"}, ${Date.now() - started}ms${worst >= 400 ? `, worst status ${worst}` : ""}\n`);
    return exitCode;
};

// {§cli-prompt-prefixes} A `! command` exits by its execution's conclusion.
export const exitCodeForExec = (status: number, exitCode?: number): number =>
    status === 200 ? (exitCode === undefined || exitCode === 0 ? 0 : 4) : status === 499 ? 3 : 4;

// What a `! command`'s op.exec Run chain settled. A failed action result is the daemon refusing the
// execution. An admitted execution settles with the conclusion of the stream its started row
// announced, which the Run carries before its result ({§agui-broadcast-fan}). Without that
// conclusion the Run failed: with its own Problem when it reported one.
export const settleExec = (run: {
    result: ActionOutcome | null;
    stream: string | null;
    conclusions: ReadonlyMap<string, StreamConcludedPayload>;
    problem: ProblemDetails | null;
}): { conclusion: StreamConcludedPayload } | { problem: ProblemDetails } => {
    if (run.result !== null && !run.result.ok) return { problem: run.result.problem };
    const conclusion = run.result === null || run.stream === null ? undefined : run.conclusions.get(run.stream);
    if (conclusion !== undefined) return { conclusion };
    return { problem: run.problem ?? (run.result === null ? clientActionResultMissing("op.exec") : clientTransportTerminalMissing()) };
};

// One-shot `! command`. op.exec rides its own action Run: the daemon binds that Run to the operation it
// dispatches, delivers the execution's row and stream lifecycle on it, and holds the result until the
// stream concludes ({§agui-broadcast-fan}), so a command cannot conclude unseen. It is the person's own
// operation, so nothing pauses it for review.
export const runExecViaAgui = async (
    target: AguiTarget,
    command: string,
    opts: { threadId: string; yolo: boolean; auto: boolean },
): Promise<number> => {
    // {§cli-worker-ownership} A person attends an interactive terminal unless `--auto` says nobody does.
    const capabilities = clientCapabilities(!opts.auto && process.stdin.isTTY === true);
    const seen = { result: null as ActionOutcome | null, stream: null as string | null, conclusions: new Map<string, StreamConcludedPayload>() };
    const io: CliRunSinks = {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        notice: (notice) => report(notice),
        json: false, yolo: opts.yolo, noReviewChannel: !capabilities.interactive,
        acceptance: new ToolAcceptance(report),
        review: reviewProposal,
        onActionResult: (outcome) => { if (outcome.kind === "op.exec") seen.result = outcome; },
        // A started or queued receipt owns its stream; a refused one's proposed address opens nothing.
        onRow: (entry) => {
            if (seen.stream === null) seen.stream = streamAddress(entry);
        },
        onStreamConcluded: (concluded) => { seen.conclusions.set(concluded.target, { ...concluded, result: operationResult(concluded.result) }); },
    };
    const binding = { threadId: opts.threadId, capabilities };
    const run = await consumeCliRun(runViaAgui(target, { ...binding, forwardedProps: {
        action: { kind: "op.exec", command },
    } }), io);
    const settled = settleExec({ ...seen, problem: run.problem });
    if ("problem" in settled) {
        // consumeCliRun has already rendered the Run's own failure.
        if (settled.problem !== run.problem) report(settled.problem);
        return 4;
    }
    const { conclusion } = settled;
    // The channels are the command's product: written whole and verbatim, never previewed.
    let read: EntryReadResult;
    try {
        read = entryReadResult(await actionViaAgui(target, {
            threadId: opts.threadId,
            kind: "entry.read", params: { target: conclusion.target, workerId: conclusion.workerId },
        }));
    } catch (cause) {
        if (!(cause instanceof ProblemError)) throw cause;
        report(cause.problem);
        return 1;
    }
    if (read.entry === null) {
        report(read.problem);
        return 1;
    }
    const { stdout, stderr } = read.entry.channels;
    if (stdout !== undefined && stdout.content.length > 0) process.stdout.write(stdout.content);
    if (stderr !== undefined && stderr.content.length > 0) process.stderr.write(stderr.content);
    const { status, exitCode } = conclusion.result as { status: number; exitCode?: number };
    return exitCodeForExec(status, exitCode);
};
