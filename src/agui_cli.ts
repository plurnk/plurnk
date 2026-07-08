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
import { formatPlain, isTerminalBroadcast, exitCodeForLoop } from "./cli.ts";
import { extractSendBody } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { reviewProposal, isServerResolved, type Resolution, type ProposalParams } from "./proposal.ts";
import { report } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { type StreamConcludedPayload } from "./stream.ts";
import { runViaBridge, resolveViaBridge, type AguiEvent, type BridgeTarget } from "./agui.ts";

type BridgeProposal = ProposalParams & { staleClobberRisk?: boolean };

export interface CliRunSinks {
    out: (s: string) => void;   // stdout — the answer
    err: (s: string) => void;   // stderr — the trace
    telemetry: (e: TelemetryEvent) => void;
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

// Drive a bridge run's AG-UI event stream to the CLI text-mode sinks; return the
// loop exit code. Event source injected so it's testable without a live bridge.
export const consumeCliRun = async (events: AsyncIterable<AguiEvent>, io: CliRunSinks): Promise<number> => {
    let finalStatus = 200;
    let hitMaxTurns = false;
    const streams = new StreamTrace();
    for await (const e of events) {
        if (e.type === "RUN_ERROR") {
            const code = Number((e as { code?: string }).code);
            finalStatus = Number.isFinite(code) && code > 0 ? code : 500;
            const message = String((e as { message?: string }).message ?? "");
            hitMaxTurns = /maxTurns/.test(message);
            io.err(`${message}\n`);
            continue;
        }
        if (e.type !== "CUSTOM") continue;   // generic vocab is for third-party frontends
        const name = (e as { name?: string }).name;
        const value = (e as { value?: unknown }).value;
        if (name === "plurnk.row") {
            const entry = value as LogEntryWire;
            io.err(`${formatPlain(entry)}\n`);
            if (isTerminalBroadcast(entry)) {
                const body = extractSendBody(entry.tx, false);
                if (body.length > 0) io.out(`${body}\n`);
            }
        } else if (name === "plurnk.telemetry") {
            io.telemetry(value as TelemetryEvent);
        } else if (name === "plurnk.stream") {
            io.err(`${streams.concluded(value as StreamConcludedPayload)}\n`);
        } else if (name === "plurnk.proposal") {
            await settleProposal(value as BridgeProposal, io);
        }
    }
    return exitCodeForLoop(finalStatus, hitMaxTurns);
};

// Wire the live bridge + terminal for one CLI prompt (text mode).
export const runCliViaBridge = async (
    target: BridgeTarget,
    prompt: string,
    opts: { threadId: string; yolo: boolean; projectRoot?: string | null },
): Promise<number> => {
    const noReviewChannel = !opts.yolo && process.stdin.isTTY !== true;
    process.stderr.write(`bridge: ${target.bridgeUrl}\nprompt: ${prompt}\n\n`);
    const forwardedProps = opts.projectRoot !== undefined && opts.projectRoot !== null ? { projectRoot: opts.projectRoot } : undefined;
    return consumeCliRun(runViaBridge(target, { threadId: opts.threadId, prompt, forwardedProps }), {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        telemetry: (e) => report(e),
        yolo: opts.yolo,
        noReviewChannel,
        review: reviewProposal,
        resolve: (r) => resolveViaBridge(target, { threadId: opts.threadId, ...r }),
    });
};
