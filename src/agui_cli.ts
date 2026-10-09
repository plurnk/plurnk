// CLI one-shot through the daemon's AG-UI endpoint: we POST the run and render the
// AG-UI SSE projection. A FAMILY client renders operations from CUSTOM
// plurnk.row for full fidelity and provider reasoning from AG-UI's standard
// reasoning lifecycle. Generic TEXT_MESSAGE events remain third-party speech.
// Text mode: stdout = delivered response messages, stderr = the per-row trace.
//
// JSON mode uses the terminal projection's complete loop identity and usage.

import process from "node:process";
import type { ResumeEntry } from "@ag-ui/core";
import { formatPlain, exitCodeForLoop, buildJsonRecord } from "./cli.ts";
import { extractSendBody, isEmission, isResponseMessage } from "./render.ts";
import type { LogEntryWire, LoopUsage, OutsideText } from "./render.ts";
import { proposalResume, reviewProposal, type Resolution, type ProposalParams } from "./proposal.ts";
import ToolAcceptance from "./tool-acceptance.ts";
import {
    ProblemError,
    clientActionResultMissing,
    clientTransportInterruptMismatch,
    clientTransportProblemMissing,
    clientTransportProposalInvalid,
    clientTransportTerminalMissing,
    renderDiagnostic,
    report,
} from "./diagnostics.ts";
import type { Notice } from "./diagnostics.ts";
import StreamTrace, { inlineable, renderInline, streamAddress, type StreamConcludedPayload, type StreamEventPayload } from "./stream.ts";
import { clientCapabilities } from "./client-capabilities.ts";
import { actionViaAgui, runViaAgui, type AguiEvent, type AguiTarget } from "./agui.ts";
import { actionOutcome, entryReadResult, operationResult, problemDetails, type ActionOutcome } from "./agui.ts";
import type { EntryReadResult, OperationResult, ProblemDetails } from "@plurnk/plurnk-contracts";
import ReasoningEvents from "./reasoning-events.ts";
import TerminalStatusLine, { accrueTurnAccounting, turnAccountingFromNotice, type TurnAccounting, EMPTY_TALLY, projectStatusGauge, reduceStatusGauge, type ClientStatus, type StatusGaugeEnvelope } from "./status.ts";
import { renderSummary } from "./render.ts";
import { withColorOutput } from "./color.ts";
import type Lifetime from "./lifetime.ts";
import { signalExitCode } from "./lifetime.ts";

// The plurnk.terminated custom payload: the loop/terminated notification plus the
// daemon workspaceId.
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
    review: (p: ProposalParams) => Promise<Resolution>;
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

// Decide a stopped-world proposal: the AG-UI run ended
// on the tool-call; the decision returns as the next run's resume payload. A
// A projected proposal tool-call is client-owned; loop-owned dispositions settle
// before the AG-UI boundary.
const decideProposal = async (p: ProposalParams, io: CliRunSinks): Promise<Resolution & { logEntryId: number }> => {
    const resolution = io.acceptance.resolve(p, io) ?? await io.review(p);
    return { logEntryId: p.logEntryId, ...resolution };
};

const readStream = async (
    target: AguiTarget,
    binding: { threadId: string; workspace?: string },
    concluded: StreamConcludedPayload,
    signal?: AbortSignal,
): Promise<Readonly<Record<string, { content: string }>>> => {
    const result = entryReadResult(await actionViaAgui(target, {
        threadId: binding.threadId, workspace: binding.workspace,
        kind: "entry.read", params: { target: concluded.target, workerId: concluded.workerId },
    }, signal));
    if (result.entry === null) throw new ProblemError(result.problem);
    return result.entry.channels;
};

// Drive one AG-UI run's event stream. Text mode renders to the sinks
// (stdout = answer, stderr = trace); json mode stays silent and accumulates the
// full record (entries/notices/response/terminated/modelWorkerId) for the caller
// to emit as ONE document. plurnk.terminated is the authoritative outcome (its
// result.status/hitMaxTurns win over the RUN_ERROR-inferred code). Event source
// injected so it's testable without a live daemon.
export const consumeCliRun = (events: AsyncIterable<AguiEvent>, io: CliRunSinks): Promise<CliRunResult> => withColorOutput(process.stderr, async () => {
    let finalStatus = 200;
    let hitMaxTurns = false;
    let response = "";
    let terminated: TerminatedValue | null = null;
    let modelWorkerId: number | null = null;
    let threadId: string | undefined;
    let pendingResume: CliRunResult["pendingResume"] = null;
    let problem: ProblemDetails | null = null;
    let problemReported = false;
    let sawRunError = false;
    let sawActionResult = false;
    let toolId = "";
    let toolArgs = "";
    const interrupts = new Set<string>();
    const entries: LogEntryWire[] = [];
    const notices: Notice[] = [];
    const streams = new StreamTrace();
    const reasoning = new ReasoningEvents();
    const visibleReasoning = new Map<string, { atLineStart: boolean }>();
    let statusGauge: StatusGaugeEnvelope | null = null;
    const snapshot = (): CliRunResult => ({
        exitCode: exitCodeForLoop(finalStatus, hitMaxTurns), entries, notices, response,
        terminated, modelWorkerId, pendingResume, problem,
    });
    io.onProgress?.(snapshot());
    for await (const e of events) {
        try {
            if (e.type === "RUN_STARTED") {
                threadId = e.threadId;
                continue;
            }
            if (e.type === "RUN_ERROR") {
                sawRunError = true;
                continue;
            }
            if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
                for (const interrupt of e.outcome.interrupts) {
                    interrupts.add(interrupt.id);
                    if (interrupt.toolCallId !== undefined) interrupts.add(interrupt.toolCallId);
                }
                continue;
            }
            if (e.type === "TOOL_CALL_START") { toolId = String((e as { toolCallId?: unknown }).toolCallId ?? ""); toolArgs = ""; continue; }
            if (e.type === "TOOL_CALL_ARGS" && toolId.startsWith("prop:")) { toolArgs += String((e as { delta?: unknown }).delta ?? ""); continue; }
            if (e.type === "TOOL_CALL_END" && toolId.startsWith("prop:")) {
                const logEntryId = Number(toolId.slice(5));
                let a: Record<string, unknown>;
                try {
                    a = JSON.parse(toolArgs.length > 0 ? toolArgs : "{}") as Record<string, unknown>;
                } catch (cause) {
                    problem = clientTransportProposalInvalid(logEntryId, cause);
                    finalStatus = problem.status;
                    continue;
                }
                const r = await decideProposal({ logEntryId, ...a } as unknown as ProposalParams, io);
                pendingResume = proposalResume(logEntryId, r);
                continue;
            }
            if (e.type === "TOOL_CALL_END" && /^int:[1-9]\d*$/.test(toolId)) {
                pendingResume = { interruptId: toolId, status: "cancelled" };
                continue;
            }
            const state = reduceStatusGauge(statusGauge, e);
            if (state.handled) {
                statusGauge = state.gauge;
                if (!io.json) io.onStatus?.(projectStatusGauge(state.gauge.plurnk.status, state.gauge.plurnk.workspace?.projectRoot));
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
            if (name === "plurnk.row") {
                const entry = value as LogEntryWire;
                io.onRow?.(entry);
                const workerId = (entry as { worker_id?: number }).worker_id;
                if (modelWorkerId === null && entry.origin === "model" && typeof workerId === "number") modelWorkerId = workerId;
                const belongsToRun = typeof workerId !== "number" || modelWorkerId === null || workerId === modelWorkerId;
                const message = belongsToRun && isResponseMessage(entry, threadId) ? extractSendBody(entry.tx) : "";
                const separator = response.length > 0 ? "\n\n" : "";
                if (message.length > 0) response += separator + message;
                if (io.json) { entries.push(entry); continue; }
                if (isEmission(entry)) continue;
                io.err(`${formatPlain(entry)}\n`);
                if (message.length > 0) io.out(`${separator.length > 0 ? "\n" : ""}${message}\n`);
            } else if (name === "plurnk.terminated") {
                const raw = value as TerminatedValue;
                terminated = { ...raw, result: operationResult(raw.result) };
                finalStatus = terminated.result.status;
                hitMaxTurns = terminated.hitMaxTurns;
                problem = terminated.result.problem ?? problem;
                if (!io.json && terminated.result.problem !== undefined && !problemReported) {
                    io.err(`${renderDiagnostic(terminated.result.problem)}\n`);
                    problemReported = true;
                }
            } else if (name === "plurnk.action.result") {
                sawActionResult = true;
                io.onActionResult?.(actionOutcome(value));
            } else if (name === "plurnk.problem") {
                problem = problemDetails(value);
                finalStatus = problem.status;
                if (!io.json) {
                    io.err(`${renderDiagnostic(problem)}\n`);
                    problemReported = true;
                }
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
                        io.err(`${streams.concluded(value as StreamConcludedPayload, process.stderr.columns ?? Number.POSITIVE_INFINITY)}\n`);
                        if (io.readStream !== undefined) {
                            try {
                                const channels = await io.readStream(value as StreamConcludedPayload);
                                for (const name of ["stdout", "stderr"]) {
                                    const content = channels[name]?.content;
                                    if (content !== undefined && inlineable(content)) io.err(`${renderInline(name, content, process.stderr.columns ?? Number.POSITIVE_INFINITY)}\n`);
                                }
                            } catch (cause) {
                                if (cause instanceof ProblemError) io.err(`${renderDiagnostic(cause.problem)}\n`);
                                else io.notice({ source: "client:stream", kind: "preview_unavailable", level: "warn",
                                    message: `Stream output unavailable: ${cause instanceof Error ? cause.message : String(cause)}` });
                            }
                        }
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
    if (pendingResume !== null && !interrupts.has(pendingResume.interruptId)) {
        problem = clientTransportInterruptMismatch(pendingResume.interruptId);
        pendingResume = null;
        finalStatus = problem.status;
    }
    // A stream that ended with NO terminal truth (no terminated, no RUN_ERROR, no
    // pending resume) is a DEAD stream — 502, never the initialized 200.
    if (terminated === null && pendingResume === null && problem === null && !sawActionResult) {
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
// identical schema in both CLI modes (plurnk.terminated carries workspaceId/loopId/
// turnIds/cost; modelWorkerId derived from the rows).
export const runCliViaAgui = async (
    target: AguiTarget,
    prompt: string,
    opts: { lifetime: Lifetime; threadId: string; workspace?: string; modelLabel?: string; maxTurns?: number; openPaths?: string[]; timeoutSec?: number; yolo: boolean; auto: boolean; reviewRequested?: boolean; json: boolean; statusStream: boolean; projectRoot?: string | null; settings?: object },
): Promise<number> => {
    // {§cli-fail-closed-no-review-channel} With no local acceptance or review channel,
    // reject locally. A submitted message cannot change the worker's authority.
    const diagnostics: Notice[] = [];
    const acceptance = new ToolAcceptance((notice) => { diagnostics.push(notice); if (!opts.json) report(notice); });
    // {§cli-worker-ownership} A person attends an interactive terminal unless `--auto` says nobody does.
    const capabilities = clientCapabilities(!opts.auto && process.stdin.isTTY === true);
    const noReviewChannel = !capabilities.interactive;
    // Workspace options ride forwardedProps.plurnk — the model must NOT: the
    // worker owns the model ({§worker-model-selection}), and an explicit --model
    // was already persisted by the dispatcher before this run.
    const fp: Record<string, unknown> = {
        ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
        ...(opts.settings !== undefined && Object.keys(opts.settings).length > 0 ? { settings: opts.settings } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.openPaths !== undefined ? { openPaths: opts.openPaths } : {}),
    };
    const forwardedProps = Object.keys(fp).length > 0 ? fp : undefined;
    const started = Date.now();
    let result: CliRunResult = {
        exitCode: 4, pendingResume: null, entries: [], notices: diagnostics, response: "",
        terminated: null, modelWorkerId: null, problem: null,
    };
    let activeSegment: CliRunResult | null = null;
    let accruedStream: TurnAccounting | null = null;
    const ac = new AbortController();
    const statusLine = new TerminalStatusLine(
        (value) => process.stderr.write(value),
        !opts.json && process.stderr.isTTY === true,
        { lifecycle: "running", model: opts.modelLabel ?? null, loopId: null, packetCount: null, activity: null, children: null },
        { workspace: opts.workspace ?? null, worker: null, child: null, tally: EMPTY_TALLY, runningSince: started },
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
            statusLine.accrue(turn);
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
    };
    // --timeout <s>: at the deadline, fire loop.cancel at the daemon (the loop
    // resolves 499) and, if the stream still hasn't ended after a grace, abort the
    // SSE locally (hangup is the abort). Exit 3 with timedOut:true in the record,
    // per SPEC §1.
    let timedOut = false;
    const cancellationGraceMs = 15_000;
    const cancelLoop = (reason: string, signal: AbortSignal): Promise<unknown> => actionViaAgui(target, {
        threadId: opts.threadId,
        ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
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
            workspace: { id: t?.workspaceId ?? 0, name: opts.workspace ?? opts.threadId },
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
        result = mergeRunSegments(result, await consumeCliRun(runViaAgui(target, { threadId: opts.threadId, capabilities, ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}), ...next }, ac.signal), io));
        activeSegment = null;
        while (result.pendingResume !== null) {
            next = { resume: [result.pendingResume] };
            const seg = await consumeCliRun(runViaAgui(target, { threadId: opts.threadId, capabilities, ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}), ...next }, ac.signal), io);
            result = mergeRunSegments(result, seg);
            activeSegment = null;
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
        statusLine.settle({ turns: terminated?.turnIds.length ?? 0, wallMs: Date.now() - started, usage: terminated?.usage });
        process.stderr.write(withColorOutput(process.stderr, () => `${renderSummary(
            terminated?.turnIds.length ?? 0,
            Date.now() - started,
            outcome,
            terminated?.hitMaxTurns ?? false,
            terminated?.usage,
        )}\n`));
    }
    return timedOut ? 3 : result.exitCode;
};

// Script mode over AG-UI+ (one op.parse action; gated ops pause/resume like any run).
// Exit honesty: worst op status ≥400 → 4, else 0.
export const runScriptViaAgui = async (
    target: AguiTarget,
    text: string,
    opts: { threadId: string; workspace: string; yolo: boolean; auto: boolean; json: boolean; projectRoot?: string | null; settings?: object },
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
        ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
        ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
    };
    let next: { resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>; forwardedProps?: Record<string, unknown> } = { forwardedProps };
    let result = await consumeCliRun(runViaAgui(target, { threadId: opts.threadId, workspace: opts.workspace, capabilities, ...next }), io);
    while (result.pendingResume !== null) {
        next = { resume: [result.pendingResume] };
        result = await consumeCliRun(runViaAgui(target, { threadId: opts.threadId, workspace: opts.workspace, capabilities, ...next }), io);
    }
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
export const exitCodeForExec = (status: number): number => status === 200 ? 0 : status === 499 ? 3 : 4;

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

// One-shot `! command`. op.exec rides its own action Run: the daemon binds that Run before it
// dispatches, delivers the execution's row and stream lifecycle on it, and holds the result until the
// stream concludes ({§agui-broadcast-fan}), so a command cannot conclude unseen. A gated execution
// resumes on the same thread without resubmitting the command, like a script.
export const runExecViaAgui = async (
    target: AguiTarget,
    command: string,
    opts: { threadId: string; workspace: string; yolo: boolean; auto: boolean; projectRoot?: string | null; settings?: object },
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
    const binding = { threadId: opts.threadId, workspace: opts.workspace, capabilities };
    let run = await consumeCliRun(runViaAgui(target, { ...binding, forwardedProps: {
        action: { kind: "op.exec", command },
        ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
        ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
    } }), io);
    while (run.pendingResume !== null) {
        run = await consumeCliRun(runViaAgui(target, { ...binding, resume: [run.pendingResume] }), io);
    }
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
            threadId: opts.threadId, workspace: opts.workspace,
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
    return exitCodeForExec(conclusion.result.status);
};
