// TUI mode — interactive REPL with glyph waterfall. Vanilla ANSI + readline.
// Per TUI.md §3.

import readline from "node:readline";
import type Rpc from "./rpc.ts";
import { renderLogEntry, renderSummary } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { reviewProposal } from "./proposal.ts";
import type { ProposalParams } from "./proposal.ts";
import { renderTelemetryEvent } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";

interface LoopRunResult {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
}

interface SessionResult { id: number; name: string }

export const runTui = async (rpc: Rpc, session: SessionResult, opts: { modelAlias?: string; persona?: string; yolo: boolean }): Promise<void> => {
    // Subscribe to log/entry notifications — render each as a waterfall line.
    // `\r\x1b[2K` wipes any readline-redrawn prompt sitting on the current line
    // before our output, otherwise the first trace line lands beside `> `.
    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire };
        process.stdout.write(`\r\x1b[2K${renderLogEntry(p.entry)}\n`);
    });

    // telemetry/event — interleaved with the trace waterfall. Same line-wipe
    // dance as log/entry so the rendered event doesn't collide with the
    // readline prompt.
    rpc.onNotification("telemetry/event", (params) => {
        const p = params as { loopId: number; event: TelemetryEvent };
        process.stdout.write(`\r\x1b[2K${renderTelemetryEvent(p.event)}\n`);
    });

    process.stdout.write(`\x1b[2mplurnk v0.1.0 · ctrl-c to quit · session: ${session.name}\x1b[0m\n\n`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\x1b[1m> \x1b[0m",
    });

    // Proposal lifecycle: --yolo auto-accepts locally; otherwise pause readline,
    // review, resolve, resume.
    rpc.onNotification("loop/proposal", (params) => {
        const p = params as ProposalParams;
        void (async () => {
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
            let tokenCount = 0;
            let turnCount = 0;
            let finalStatus = 0;
            let hitMaxTurns = false;

            try {
                if (trimmed.startsWith("<<")) {
                    // Raw DSL: send to op.parse
                    const result = await rpc.call("op.parse", { text: trimmed }) as { results: Array<{ status: number }> };
                    finalStatus = result.results[result.results.length - 1]?.status ?? 0;
                } else {
                    // Prompt: send to loop.run
                    const loopParams: { prompt: string; alias?: string; persona?: string } = { prompt: trimmed };
                    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;
                    if (opts.persona !== undefined) loopParams.persona = opts.persona;
                    const result = await rpc.call("loop.run", loopParams) as LoopRunResult;
                    finalStatus = result.finalStatus;
                    hitMaxTurns = result.hitMaxTurns;
                    turnCount = result.turnIds.length;
                    // Token count would come from log.read; for now we just don't have it
                }
                const wallMs = Date.now() - start;
                process.stdout.write(`${renderSummary(turnCount, wallMs, tokenCount, finalStatus, hitMaxTurns)}\n`);
            } catch (cause) {
                const msg = cause instanceof Error ? cause.message : String(cause);
                process.stdout.write(`  \x1b[31merror: ${msg}\x1b[0m\n`);
            } finally {
                inFlight = false;
                rl.prompt();
            }
        });

        rl.on("close", () => {
            process.stdout.write("\n");
            resolve();
        });

        rl.on("SIGINT", () => {
            // Ctrl-C: exit cleanly. Future: cancel in-flight run via SEND[499].
            rl.close();
        });
    });
};
