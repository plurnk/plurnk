// TUI mode — interactive REPL with glyph waterfall. Vanilla ANSI + readline.
// Per TUI.md §3.

import readline from "node:readline";
import type Rpc from "./rpc.ts";
import { renderLogEntry, renderSummary } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { reviewProposal, isServerResolved } from "./proposal.ts";
import type { ProposalParams } from "./proposal.ts";
import { renderTelemetryEvent } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { renderStreamEvent, renderStreamConcluded } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";

interface LoopRunResult {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
}

interface SessionResult { id: number; name: string }

export const runTui = async (rpc: Rpc, session: SessionResult, opts: {
    modelAlias?: string; persona?: string; yolo: boolean;
    loopFlags?: Record<string, unknown>; maxTurns?: number;
}): Promise<void> => {
    // Tokens for the summary line: summed from each dispatch's log/entry
    // rows (log_entries.tokens). Reset per dispatch in the line handler.
    let dispatchTokens = 0;

    // Subscribe to log/entry notifications — render each as a waterfall line.
    // `\r\x1b[2K` wipes any readline-redrawn prompt sitting on the current line
    // before our output, otherwise the first trace line lands beside `> `.
    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire & { tokens?: number } };
        if (typeof p.entry.tokens === "number") dispatchTokens += p.entry.tokens;
        process.stdout.write(`\r\x1b[2K${renderLogEntry(p.entry)}\n`);
    });

    // telemetry/event — interleaved with the trace waterfall. Same line-wipe
    // dance as log/entry so the rendered event doesn't collide with the
    // readline prompt.
    rpc.onNotification("telemetry/event", (params) => {
        const p = params as { loopId: number; event: TelemetryEvent };
        process.stdout.write(`\r\x1b[2K${renderTelemetryEvent(p.event)}\n`);
    });

    // stream/event + stream/concluded — daemon-pushed channel-growth and
    // closure metadata. Inline in the waterfall with the same prompt-wipe.
    rpc.onNotification("stream/event", (params) => {
        process.stdout.write(`\r\x1b[2K${renderStreamEvent(params as StreamEventPayload)}\n`);
    });
    rpc.onNotification("stream/concluded", (params) => {
        process.stdout.write(`\r\x1b[2K${renderStreamConcluded(params as StreamConcludedPayload)}\n`);
    });

    process.stdout.write(`\x1b[2mplurnk v0.1.0 · ctrl-c to quit · session: ${session.name}\x1b[0m\n\n`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\x1b[1m> \x1b[0m",
    });

    // Proposal lifecycle: server-resolved proposals (flags.yolo/noProposals)
    // settle in-process — skip; --yolo auto-accepts locally; otherwise pause
    // readline, review, resolve, resume.
    rpc.onNotification("loop/proposal", (params) => {
        const p = params as ProposalParams;
        void (async () => {
            if (isServerResolved(p)) return;
            if (opts.yolo) {
                await rpc.call("loop.resolve", { logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" });
                return;
            }
            rl.pause();
            try {
                const resolution = await reviewProposal(p);
                await rpc.call("loop.resolve", { logEntryId: p.logEntryId, ...resolution });
            } finally {
                rl.resume();
                rl.prompt(true);
            }
        })();
    });

    rl.prompt();

    return new Promise<void>((resolve) => {
        let inFlight = false;
        let cancelRequested = false;

        rl.on("line", async (line) => {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                rl.prompt();
                return;
            }

            if (inFlight) {
                process.stdout.write("  \x1b[2m(busy; wait for current dispatch to finish)\x1b[0m\n");
                rl.prompt();
                return;
            }

            inFlight = true;
            const start = Date.now();
            dispatchTokens = 0;
            let turnCount = 0;
            let finalStatus = 0;
            let hitMaxTurns = false;

            try {
                if (trimmed.startsWith("<<")) {
                    // Raw DSL: send to op.parse
                    const result = await rpc.call("op.parse", { text: trimmed }) as { results: Array<{ status: number }> };
                    finalStatus = result.results[result.results.length - 1]?.status ?? 0;
                } else if (trimmed.startsWith("!")) {
                    // `! cmd` — exec via the daemon (proposal-gated like any
                    // side effect; output streams as stream/event traces).
                    const command = trimmed.replace(/^!+\s*/, "");
                    const result = await rpc.call("op.exec", { command }) as { status: number };
                    finalStatus = result.status;
                } else {
                    // Prompt. `? ` = ask (read-only loop, flags.mode="ask");
                    // `: ` = act. Per-line prefix overrides a global --ask.
                    let lineFlags = opts.loopFlags;
                    const prefix = trimmed[0];
                    if (prefix === "?" || prefix === ":") {
                        lineFlags = { ...(opts.loopFlags ?? {}), mode: prefix === "?" ? "ask" : "act" };
                    }
                    const promptText = trimmed.replace(/^[?:]+\s*/, "");
                    const loopParams: { prompt: string; alias?: string; persona?: string; flags?: Record<string, unknown>; maxTurns?: number } = { prompt: promptText };
                    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;
                    if (opts.persona !== undefined) loopParams.persona = opts.persona;
                    if (lineFlags !== undefined && Object.keys(lineFlags).length > 0) loopParams.flags = lineFlags;
                    if (opts.maxTurns !== undefined) loopParams.maxTurns = opts.maxTurns;
                    const result = await rpc.call("loop.run", loopParams) as LoopRunResult;
                    finalStatus = result.finalStatus;
                    hitMaxTurns = result.hitMaxTurns;
                    turnCount = result.turnIds.length;
                }
                const wallMs = Date.now() - start;
                process.stdout.write(`${renderSummary(turnCount, wallMs, dispatchTokens, finalStatus, hitMaxTurns)}\n`);
            } catch (cause) {
                const msg = cause instanceof Error ? cause.message : String(cause);
                process.stdout.write(`  \x1b[31merror: ${msg}\x1b[0m\n`);
            } finally {
                inFlight = false;
                cancelRequested = false;
                rl.prompt();
            }
        });

        rl.on("close", () => {
            process.stdout.write("\n");
            resolve();
        });

        rl.on("SIGINT", () => {
            // First Ctrl-C with a dispatch in flight: cancel the run's active
            // drain via loop.cancel (plurnk-service §13.5); the pending
            // loop.run resolves with finalStatus 499 and the REPL continues.
            // Second Ctrl-C (or idle Ctrl-C) exits — escape hatch for
            // dispatches a drain-cancel can't unblock (op.parse).
            if (inFlight && !cancelRequested) {
                cancelRequested = true;
                process.stdout.write("\r\x1b[2K  \x1b[2mcancelling… (ctrl-c again to quit)\x1b[0m\n");
                void rpc.call("loop.cancel", { reason: "user_sigint" });
                return;
            }
            rl.close();
        });
    });
};
