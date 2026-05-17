// TUI mode — interactive REPL with glyph waterfall. Vanilla ANSI + readline.
// Per TUI.md §3.

import readline from "node:readline";
import type Rpc from "./rpc.ts";
import { renderLogEntry, renderSummary } from "./render.ts";
import type { LogEntryWire } from "./render.ts";

interface LoopRunResult {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
}

interface SessionResult { id: number; name: string }

const BANNER = "plurnk v0.1.0 · type a prompt, hit enter · ctrl-c to quit · type <<OP...:OP for raw DSL\n\n";

export const runTui = async (rpc: Rpc): Promise<void> => {
    const session = await rpc.call("session.create") as SessionResult;

    // Subscribe to log/entry notifications — render each as a waterfall line.
    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire };
        process.stdout.write(`${renderLogEntry(p.entry)}\n`);
    });

    process.stdout.write(`\x1b[2m${BANNER}session: ${session.name} (id=${session.id})\n\x1b[0m`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\x1b[1m> \x1b[0m",
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
                    const result = await rpc.call("loop.run", { prompt: trimmed }) as LoopRunResult;
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
