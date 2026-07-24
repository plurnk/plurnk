// CLI one-shot through the plurnk-agui bridge (plurnk-agui#1, migration slice 2):
// text mode. The bridge owns the WS + workspace; we POST the run and render the
// AG-UI SSE projection. A FAMILY client renders from CUSTOM plurnk.row (the full
// wire row) for full fidelity — the generic AG-UI events (TEXT_MESSAGE/…) are for
// third-party frontends — so this reuses runCli's exact text-mode rendering:
// stdout = the terminal broadcast body (the answer), stderr = the per-row trace.
//
// json mode is NOT routed here yet: the Translator's terminated projection drops
// costPico/loopId, so a faithful json record needs bridge-side enrichment (mine
// to add as owner) — until then json rides the daemon (dual-surface, per charter).

import process from "node:process";
import { formatPlain, isTerminalBroadcast, exitCodeForLoop, buildJsonRecord } from "./cli.ts";
import { extractSendBody } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { reviewProposal, type Resolution, type ProposalParams } from "./proposal.ts";
import { report } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { type StreamConcludedPayload, type StreamEventPayload } from "./stream.ts";
import { runViaBridge, type AguiEvent, type BridgeTarget } from "./agui.ts";

type BridgeProposal = ProposalParams & { staleClobberRisk?: boolean };

// The plurnk.terminated custom payload (plurnk-agui 0.2.1): the loop/terminated
// notification + the daemon workspaceId, so a bridge-run json record matches the
// WS-run schema exactly.
interface TerminatedValue {
    workspaceId: number | null;
    loopId: number;
    finalStatus: number;
    hitMaxTurns: boolean;
    turnIds: number[];
    usage: { promptTokens: number; completionTokens: number; costPico: number; contextTokens: number; promptBudget: number | null; meta: Record<string, unknown> };
}

export interface CliRunResult {
    exitCode: number;
    // Terminate-resume: set when the segment ended on a client-owned proposal
    // tool-call — the caller POSTs this as the resume run's tool-result.
    pendingResume: { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string } | null;
    entries: LogEntryWire[];
    telemetry: TelemetryEvent[];
    response: string;
    terminated: TerminatedValue | null;
    modelWorkerId: number | null;
}

export interface CliRunSinks {
    out: (s: string) => void;   // stdout — the answer (text mode)
    err: (s: string) => void;   // stderr — the trace (text mode)
    telemetry: (e: TelemetryEvent) => void;
    json: boolean;              // json mode: stay silent, accumulate; the caller emits ONE doc
    yolo: boolean;
    noReviewChannel: boolean;
    review: (p: ProposalParams) => Promise<Resolution>;
    onActionResult?: (v: { kind: string; ok: boolean; result?: unknown; error?: string }) => void;
}

// Decide a stopped-world proposal (AG-UI+ terminate-resume): the run segment ended
// on the tool-call; the decision returns as the resume run's tool-result. A
// tool-call strictly means client-owned (the module filters server-yolo/noProposals).
const decideProposal = async (p: BridgeProposal, io: CliRunSinks): Promise<{ logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string }> => {
    if (io.yolo) return { logEntryId: p.logEntryId, decision: "accept" };
    if (io.noReviewChannel) return { logEntryId: p.logEntryId, decision: "reject" };
    const resolution = await io.review(p);
    return { logEntryId: p.logEntryId, decision: resolution.decision, ...(resolution.body !== undefined ? { body: resolution.body } : {}) };
};

// Drive a bridge run's AG-UI event stream. Text mode renders to the sinks
// (stdout = answer, stderr = trace); json mode stays silent and accumulates the
// full record (entries/telemetry/response/terminated/modelWorkerId) for the caller
// to emit as ONE document. plurnk.terminated is the authoritative outcome (its
// finalStatus/hitMaxTurns win over the RUN_ERROR-inferred code). Event source
// injected so it's testable without a live bridge.
export const consumeCliRun = async (events: AsyncIterable<AguiEvent>, io: CliRunSinks): Promise<CliRunResult> => {
    let finalStatus = 200;
    let hitMaxTurns = false;
    let response = "";
    let terminated: TerminatedValue | null = null;
    let modelWorkerId: number | null = null;
    let pendingResume: CliRunResult["pendingResume"] = null;
    let toolId = "";
    let toolArgs = "";
    const entries: LogEntryWire[] = [];
    const telemetry: TelemetryEvent[] = [];
    const streams = new StreamTrace();
    for await (const e of events) {
        if (e.type === "RUN_ERROR") {
            const code = Number((e as { code?: string }).code);
            finalStatus = Number.isFinite(code) && code > 0 ? code : 500;
            hitMaxTurns = /maxTurns/.test(String((e as { message?: string }).message ?? ""));
            if (!io.json) io.err(`${String((e as { message?: string }).message ?? "")}\n`);
            continue;
        }
        if (e.type === "TOOL_CALL_START") { toolId = String((e as { toolCallId?: unknown }).toolCallId ?? ""); toolArgs = ""; continue; }
        if (e.type === "TOOL_CALL_ARGS" && toolId.startsWith("prop:")) { toolArgs += String((e as { delta?: unknown }).delta ?? ""); continue; }
        if (e.type === "TOOL_CALL_END" && toolId.startsWith("prop:")) {
            const a = JSON.parse(toolArgs.length > 0 ? toolArgs : "{}") as Record<string, unknown>;
            pendingResume = await decideProposal({ logEntryId: Number(toolId.slice(5)), ...a } as unknown as BridgeProposal, io);
            continue;
        }
        if (e.type !== "CUSTOM") continue;   // generic vocab is for third-party frontends
        const name = (e as { name?: string }).name;
        const value = (e as { value?: unknown }).value;
        if (name === "plurnk.row") {
            const entry = value as LogEntryWire;
            const workerId = (entry as { worker_id?: number }).worker_id;
            if (modelWorkerId === null && entry.origin === "model" && typeof workerId === "number") modelWorkerId = workerId;
            if (isTerminalBroadcast(entry)) response = extractSendBody(entry.tx, false);
            if (io.json) { entries.push(entry); continue; }
            io.err(`${formatPlain(entry)}\n`);
            if (isTerminalBroadcast(entry) && response.length > 0) io.out(`${response}\n`);
        } else if (name === "plurnk.terminated") {
            terminated = value as TerminatedValue;
            finalStatus = terminated.finalStatus;   // authoritative outcome
            hitMaxTurns = terminated.hitMaxTurns;
        } else if (name === "plurnk.action.result") {
            io.onActionResult?.(value as { kind: string; ok: boolean; result?: unknown; error?: string });
        } else if (name === "plurnk.telemetry") {
            if (io.json) telemetry.push(value as TelemetryEvent); else io.telemetry(value as TelemetryEvent);
        } else if (name === "plurnk.stream") {
            // plurnk.stream carries the whole lifecycle: a concluded payload has
            // closeStatus; a start/event payload has state. (json: streams aren't in
            // the record — content is fetched on demand via `read L/T/S`.)
            if (!io.json) {
                if (typeof (value as { closeStatus?: unknown }).closeStatus === "number") {
                    io.err(`${streams.concluded(value as StreamConcludedPayload)}\n`);
                } else {
                    const line = streams.event(value as StreamEventPayload);
                    if (line !== null) io.err(`${line}\n`);
                }
            }
        }
    }
    // A stream that ended with NO terminal truth (no terminated, no RUN_ERROR, no
    // pending resume) is a DEAD stream — 502, never the initialized 200 (svc#478:
    // the fabricated-success default made a killed run exit 0 with an empty record).
    if (terminated === null && pendingResume === null && finalStatus === 200) finalStatus = 502;
    return { exitCode: exitCodeForLoop(finalStatus, hitMaxTurns), entries, telemetry, response, terminated, modelWorkerId, pendingResume };
};

// Wire the live bridge + terminal for one CLI prompt. text: stdout=answer,
// stderr=trace. json: silent, then ONE buildJsonRecord document on stdout —
// identical schema in both CLI modes (plurnk.terminated carries workspaceId/loopId/
// turnIds/cost; modelWorkerId derived from the rows).
export const runCliViaBridge = async (
    target: BridgeTarget,
    prompt: string,
    opts: { threadId: string; workspace?: string; alias?: string; model?: string; flags?: Record<string, unknown>; maxTurns?: number; timeoutSec?: number; yolo: boolean; json: boolean; projectRoot?: string | null; constraints?: unknown[]; settings?: object },
): Promise<number> => {
    const noReviewChannel = !opts.yolo && process.stdin.isTTY !== true;
    if (!opts.json) process.stderr.write(`bridge: ${target.bridgeUrl}\nprompt: ${prompt}\n\n`);
    // Per-run knobs ride forwardedProps.plurnk — the model must reach the wire (one-shot
    // used to DROP --model/PLURNK_MODEL and silently run the daemon default).
    const fp: Record<string, unknown> = {
        ...(opts.projectRoot !== undefined && opts.projectRoot !== null ? { projectRoot: opts.projectRoot } : {}),
        ...(opts.constraints !== undefined && opts.constraints.length > 0 ? { constraints: opts.constraints } : {}),
        ...(opts.settings !== undefined && Object.keys(opts.settings).length > 0 ? { settings: opts.settings } : {}),
        ...(opts.alias !== undefined ? { alias: opts.alias } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    };
    const forwardedProps = Object.keys(fp).length > 0 ? fp : undefined;
    const started = Date.now();
    const io = {
        out: (s: string) => process.stdout.write(s),
        err: (s: string) => process.stderr.write(s),
        telemetry: (e: Parameters<typeof report>[0]) => report(e),
        json: opts.json,
        yolo: opts.yolo,
        noReviewChannel,
        review: reviewProposal,
    };
    // --timeout <s> (svc#478 — the flag was parsed-and-dead since the agui migration):
    // at the deadline, fire loop.cancel at the daemon (the loop resolves 499) and, if the
    // stream still hasn't ended after a grace, abort the SSE locally (hangup is the abort).
    // Exit 3 with timedOut:true in the record, per SPEC §1.
    let timedOut = false;
    const ac = new AbortController();
    const cancelLoop = async (): Promise<void> => {
        for await (const e of runViaBridge(target, { threadId: opts.threadId, ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}), messages: [], forwardedProps: { action: { kind: "loop.cancel", reason: "client_timeout" } } })) void e;
    };
    let graceTimer: NodeJS.Timeout | undefined;
    const deadline = opts.timeoutSec !== undefined && opts.timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            void cancelLoop().catch(() => { /* the abort below is the backstop */ });
            graceTimer = setTimeout(() => ac.abort(), 15_000);
        }, opts.timeoutSec * 1000)
        : undefined;

    // One record, emitted exactly once — the normal path, the timeout path, and a
    // SIGTERM flush (a killed client must not lose its --json record) all funnel here.
    let emitted = false;
    const emitRecord = (r: CliRunResult): void => {
        if (!opts.json || emitted) return;
        emitted = true;
        const t = r.terminated;
        const doc = buildJsonRecord({
            workspace: { id: t?.workspaceId ?? 0, name: opts.threadId },
            prompt,
            response: r.response,
            entries: r.entries,
            telemetry: r.telemetry,
            result: {
                loopId: t?.loopId ?? 0,
                modelWorkerId: r.modelWorkerId ?? undefined,
                turnIds: t?.turnIds ?? [],
                // NEVER a fabricated 200: a stream that died without terminal truth is 502.
                finalStatus: t?.finalStatus ?? 502,
                hitMaxTurns: t?.hitMaxTurns ?? false,
                usage: t?.usage,
            },
            wallMs: Date.now() - started,
            timedOut,
        });
        process.stdout.write(`${JSON.stringify(doc)}\n`);
    };

    // Terminate-resume segments: a client-owned proposal ends the segment as a
    // tool-call; the decision POSTs as the next segment's tool-result. Accumulate
    // across segments — one logical run, one record.
    let next: { prompt?: string; messages?: Array<Record<string, unknown>>; forwardedProps?: Record<string, unknown> } = { prompt, forwardedProps };
    let result = await consumeCliRun(runViaBridge(target, { threadId: opts.threadId, ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}), ...next }, ac.signal), io);
    // A hard kill mid-run must still leave the record behind (svc#478: Harbor's axe
    // erased the whole document). Best-effort flush of what accumulated so far.
    const onTerm = (): void => { emitRecord(result); process.exit(143); };
    process.once("SIGTERM", onTerm);
    try {
        while (result.pendingResume !== null) {
            const r = result.pendingResume;
            next = { messages: [{ role: "tool", toolCallId: `prop:${r.logEntryId}`, content: JSON.stringify({ decision: r.decision, ...(r.body !== undefined ? { body: r.body } : {}) }) }] };
            const seg = await consumeCliRun(runViaBridge(target, { threadId: opts.threadId, ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}), ...next }, ac.signal), io);
            result = {
                ...seg,
                entries: [...result.entries, ...seg.entries],
                telemetry: [...result.telemetry, ...seg.telemetry],
                response: seg.response.length > 0 ? seg.response : result.response,
                modelWorkerId: result.modelWorkerId ?? seg.modelWorkerId,
            };
        }
    } finally {
        process.removeListener("SIGTERM", onTerm);
        if (deadline !== undefined) clearTimeout(deadline);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
    }
    emitRecord(result);
    return timedOut ? 3 : result.exitCode;
};

// Script mode over AG-UI+ (one op.parse action; gated ops pause/resume like any run).
// Exit honesty matches the WS runScript: worst op status ≥400 → 4, else 0.
export const runScriptViaBridge = async (
    target: BridgeTarget,
    text: string,
    opts: { threadId: string; workspace?: string; yolo: boolean; json: boolean; projectRoot?: string | null },
): Promise<number> => {
    const noReviewChannel = !opts.yolo && process.stdin.isTTY !== true;
    let parse: { results: Array<{ status: number }> } | null = null;
    const io: CliRunSinks = {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        telemetry: (e) => report(e),
        json: opts.json, yolo: opts.yolo, noReviewChannel,
        review: reviewProposal,
        onActionResult: (v) => {
            if (v.kind !== "op.parse") return;
            if (!v.ok) throw new Error(`op.parse failed: ${v.error ?? "unknown"}`);
            parse = v.result as { results: Array<{ status: number }> };
        },
    };
    const started = Date.now();
    const forwardedProps: Record<string, unknown> = {
        action: { kind: "op.parse", text },
        ...(opts.projectRoot !== undefined && opts.projectRoot !== null ? { projectRoot: opts.projectRoot } : {}),
    };
    let next: { messages?: Array<Record<string, unknown>>; forwardedProps?: Record<string, unknown> } = { messages: [], forwardedProps };
    let result = await consumeCliRun(runViaBridge(target, { threadId: opts.threadId, ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}), ...next }), io);
    while (result.pendingResume !== null) {
        const r = result.pendingResume;
        next = { messages: [{ role: "tool", toolCallId: `prop:${r.logEntryId}`, content: JSON.stringify({ decision: r.decision, ...(r.body !== undefined ? { body: r.body } : {}) }) }] };
        result = await consumeCliRun(runViaBridge(target, { threadId: opts.threadId, ...next }), io);
    }
    // NO fabricated success (fabrication audit, 2026-07-11): a script whose parse
    // result never arrived did NOT succeed — fail hard, loudly.
    if (parse === null) throw new Error("script: the op.parse result never arrived — the run ended without it");
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
