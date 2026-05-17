// One-shot CLI mode. Plain text, no glyphs (per TUI.md §2 — Unix tool posture).
// Subscribes to log/entry notifications and prints each op as a plain line.
// Suitable for piping to grep / awk / head.

import type Rpc from "./rpc.ts";
import type { LogEntryWire } from "./render.ts";

interface LoopRunResult {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
}

interface SessionResult { id: number; name: string }

const formatPlain = (entry: LogEntryWire): string => {
    const path = entry.target_scheme !== null
        ? `${entry.target_scheme}://${entry.target_hostname ?? ""}${entry.target_pathname ?? ""}${entry.target_fragment !== null ? `#${entry.target_fragment}` : ""}`
        : "";
    const sub = entry.op === "SEND" && typeof entry.signal === "number" ? `[${entry.signal}]` : "";
    return `[${entry.status_rx}] ${entry.origin} ${entry.op}${sub} ${path}`.trim();
};

export const runOneShot = async (rpc: Rpc, prompt: string): Promise<number> => {
    const session = await rpc.call("session.create") as SessionResult;
    process.stdout.write(`session: ${session.name} (id=${session.id})\n`);
    process.stdout.write(`prompt: ${prompt}\n\n`);

    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire };
        process.stdout.write(`${formatPlain(p.entry)}\n`);
    });

    const start = Date.now();
    const result = await rpc.call("loop.run", { prompt }) as LoopRunResult;
    const wallMs = Date.now() - start;

    process.stdout.write(`\nfinal status: ${result.finalStatus}${result.hitMaxTurns ? " (maxTurns reached)" : ""}\n`);
    process.stdout.write(`turns: ${result.turnIds.length}, wall: ${(wallMs / 1000).toFixed(2)}s\n`);

    if (result.finalStatus === 200) return 0;
    if (result.hitMaxTurns) return 2;
    return 3;
};
