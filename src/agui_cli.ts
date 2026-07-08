// CLI one-shot through the plurnk-agui bridge (plurnk-agui#1, migration slice 2):
// text mode. The bridge owns the WS + session; we POST the run and render the
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
import { reviewProposal, isServerResolved, type Resolution, type ProposalParams } from "./proposal.ts";
import { report } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { type StreamConcludedPayload } from "./stream.ts";
import { runViaBridge, resolveViaBridge, type AguiEvent, type BridgeTarget } from "./agui.ts";

type BridgeProposal = ProposalParams & { staleClobberRisk?: boolean };

// The plurnk.terminated custom payload (plurnk-agui 0.2.1): the loop/terminated
// notification + the daemon sessionId, so a bridge-run json record matches the
// WS-run schema exactly.
interface TerminatedValue {
    sessionId: number | null;
    loopId: number;
    finalStatus: number;
    hitMaxTurns: boolean;
    turnIds: number[];
    usage: { promptTokens: number; completionTokens: number; costPico: number; contextTokens: number; contextSize: number | null; meta: Record<string, unknown> };
}

export interface CliRunResult {
    exitCode: number;
    entries: LogEntryWire[];
    telemetry: TelemetryEvent[];
    response: string;
    terminated: TerminatedValue | null;
    modelRunId: number | null;
}

export interface CliRunSinks {
    out: (s: string) => void;   // stdout — the answer (text mode)
    err: (s: string) => void;   // stderr — the trace (text mode)
    telemetry: (e: TelemetryEvent) => void;
    json: boolean;              // json mode: stay silent, accumulate; the caller emits ONE doc
    yolo: boolean;
    noReviewChannel: boolean;
    review: (p: ProposalParams) => Promise<Resolution>;
    resolve: (r: { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string }) => Promise<void>;
}

// Settle a stopped-world proposal that arrived over the bridge, mirroring the WS
// CLI's three paths — but the answer rides POST /resolve, not loop.resolve.
const settleProposal = async (p: BridgeProposal, io: CliRunSinks): Promise<void> => {
    if (isServerResolved(p)) return;   // the daemon settled it in-process (bridge flags.yolo); a client resolve would race
    if (io.yolo) { await io.resolve({ logEntryId: p.logEntryId, decision: "accept" }); return; }
    if (io.noReviewChannel) { await io.resolve({ logEntryId: p.logEntryId, decision: "reject" }); return; }
    const resolution = await io.review(p);
    await io.resolve({ logEntryId: p.logEntryId, decision: resolution.decision, ...(resolution.body !== undefined ? { body: resolution.body } : {}) });
};

// Drive a bridge run's AG-UI event stream. Text mode renders to the sinks
// (stdout = answer, stderr = trace); json mode stays silent and accumulates the
// full record (entries/telemetry/response/terminated/modelRunId) for the caller
// to emit as ONE document. plurnk.terminated is the authoritative outcome (its
// finalStatus/hitMaxTurns win over the RUN_ERROR-inferred code). Event source
// injected so it's testable without a live bridge.
export const consumeCliRun = async (events: AsyncIterable<AguiEvent>, io: CliRunSinks): Promise<CliRunResult> => {
    let finalStatus = 200;
    let hitMaxTurns = false;
    let response = "";
    let terminated: TerminatedValue | null = null;
    let modelRunId: number | null = null;
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
        if (e.type !== "CUSTOM") continue;   // generic vocab is for third-party frontends
        const name = (e as { name?: string }).name;
        const value = (e as { value?: unknown }).value;
        if (name === "plurnk.row") {
            const entry = value as LogEntryWire;
            const runId = (entry as { run_id?: number }).run_id;
            if (modelRunId === null && entry.origin === "model" && typeof runId === "number") modelRunId = runId;
            if (isTerminalBroadcast(entry)) response = extractSendBody(entry.tx, false);
            if (io.json) { entries.push(entry); continue; }
            io.err(`${formatPlain(entry)}\n`);
            if (isTerminalBroadcast(entry) && response.length > 0) io.out(`${response}\n`);
        } else if (name === "plurnk.terminated") {
            terminated = value as TerminatedValue;
            finalStatus = terminated.finalStatus;   // authoritative outcome
            hitMaxTurns = terminated.hitMaxTurns;
        } else if (name === "plurnk.telemetry") {
            if (io.json) telemetry.push(value as TelemetryEvent); else io.telemetry(value as TelemetryEvent);
        } else if (name === "plurnk.stream") {
            if (!io.json) io.err(`${streams.concluded(value as StreamConcludedPayload)}\n`);
        } else if (name === "plurnk.proposal") {
            await settleProposal(value as BridgeProposal, io);
        }
    }
    return { exitCode: exitCodeForLoop(finalStatus, hitMaxTurns), entries, telemetry, response, terminated, modelRunId };
};

// Wire the live bridge + terminal for one CLI prompt. text: stdout=answer,
// stderr=trace. json: silent, then ONE buildJsonRecord document on stdout —
// identical schema to the WS path (plurnk.terminated carries sessionId/loopId/
// turnIds/cost; modelRunId derived from the rows).
export const runCliViaBridge = async (
    target: BridgeTarget,
    prompt: string,
    opts: { threadId: string; yolo: boolean; json: boolean; projectRoot?: string | null },
): Promise<number> => {
    const noReviewChannel = !opts.yolo && process.stdin.isTTY !== true;
    if (!opts.json) process.stderr.write(`bridge: ${target.bridgeUrl}\nprompt: ${prompt}\n\n`);
    const forwardedProps = opts.projectRoot !== undefined && opts.projectRoot !== null ? { projectRoot: opts.projectRoot } : undefined;
    const started = Date.now();
    const result = await consumeCliRun(runViaBridge(target, { threadId: opts.threadId, prompt, forwardedProps }), {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        telemetry: (e) => report(e),
        json: opts.json,
        yolo: opts.yolo,
        noReviewChannel,
        review: reviewProposal,
        resolve: (r) => resolveViaBridge(target, { threadId: opts.threadId, ...r }),
    });
    if (opts.json) {
        const t = result.terminated;
        const doc = buildJsonRecord({
            session: { id: t?.sessionId ?? 0, name: opts.threadId },
            prompt,
            response: result.response,
            entries: result.entries,
            telemetry: result.telemetry,
            result: {
                loopId: t?.loopId ?? 0,
                modelRunId: result.modelRunId ?? undefined,
                turnIds: t?.turnIds ?? [],
                finalStatus: t?.finalStatus ?? 200,
                hitMaxTurns: t?.hitMaxTurns ?? false,
                usage: t?.usage,
            },
            wallMs: Date.now() - started,
            timedOut: false,
        });
        process.stdout.write(`${JSON.stringify(doc)}\n`);
    }
    return result.exitCode;
};
