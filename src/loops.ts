// {§cli-loops} A worker's loops as the daemon lists them (plurnk-service `{§agui-worker-loops}`), and one loop read
// whole: the list a person navigates a conversation by, and the loop it names, printed as history is.

import { paint } from "./color.ts";
import { clientTransportResultInvalid, ProblemError } from "./diagnostics.ts";
import ModelText from "./model-text.ts";
import { fitRow, type LogEntryWire } from "./render.ts";
import { renderRows } from "./render-history.ts";
import { lifecycleMark, type StatusLifecycle } from "./status.ts";

export interface LoopEntry {
    readonly id: number;
    readonly sequence: number;
    readonly lifecycle: StatusLifecycle;
    readonly source: string | null;
    readonly opening: string;
    readonly continued: boolean;
}

interface Caller { call: (method: string, params?: object) => Promise<unknown> }

const LIFECYCLES: ReadonlySet<string> = new Set(["idle", "queued", "running", "parked", "completed", "cancelled", "failed"]);

// The id of the worker by this name; null while no act has created it.
export const workerIdNamed = async (rpc: Caller, name: string | null): Promise<number | null> => {
    if (name === null) return null;
    const { workers } = await rpc.call("workspace.workers") as { workers: Array<{ id: number; name: string }> };
    return workers.find((worker) => worker.name === name)?.id ?? null;
};

// The daemon's list of the worker's loops, every entry readable or a broken wire.
export const readLoops = async (rpc: Caller, workerId: number): Promise<LoopEntry[]> => {
    const result = await rpc.call("worker.loops", { workerId });
    const loops = (result as { loops?: unknown } | null)?.loops;
    if (!Array.isArray(loops)) throw new ProblemError(clientTransportResultInvalid("worker.loops returned no loops."));
    return loops.map((value: unknown) => {
        const loop = value as Partial<Record<keyof LoopEntry, unknown>> | null;
        if (loop === null || typeof loop !== "object" || !Number.isSafeInteger(loop.id) || !Number.isSafeInteger(loop.sequence)
            || typeof loop.lifecycle !== "string" || !LIFECYCLES.has(loop.lifecycle) || !(loop.source === null || typeof loop.source === "string")
            || typeof loop.opening !== "string" || typeof loop.continued !== "boolean") {
            throw new ProblemError(clientTransportResultInvalid("A worker.loops entry is not { id, sequence, lifecycle, source, opening, continued }."));
        }
        return loop as unknown as LoopEntry;
    });
};

// A person's message reaches a worker through a client's thread; any other sender, a worker, a schedule, a peer, is named.
const sender = (source: string | null): string | null =>
    source === null || /^agui:\/\/[^/]*\/threads\//u.test(source) ? null : ModelText.plain(source);

// One line per loop, oldest first: its number, the sender when it was no person, its opening line, and a mark for a
// loop under way or ended early; each line fits the terminal's width.
export const renderLoopList = (loops: readonly LoopEntry[], columns: number): string => {
    if (loops.length === 0) return "  (no loops yet)\n";
    return `${loops.map((loop) => {
        const from = sender(loop.source);
        const mark = lifecycleMark(loop.lifecycle);
        const text = `${loop.sequence}: ${from === null ? "" : `${from}: `}${ModelText.plain(loop.opening)}${loop.continued ? "…" : ""}${mark === "" ? "" : ` ${mark}`}`;
        return `  ${fitRow(text, Math.max(8, columns - 2))}`;
    }).join("\n")}\n`;
};

// The loop as history draws it, headed by its number, the person's own prompts included.
export const renderLoop = (loop: LoopEntry, rows: readonly LogEntryWire[], threadId: string, columns: number): string => {
    const blocks = renderRows(rows, threadId, columns, true);
    return `${[paint(`── loop ${loop.sequence} ──`, "dim"), ...(blocks.length === 0 ? [paint("(no rows)", "dim")] : blocks)].join("\n")}\n`;
};
