// Executions in the waterfall ({§cli-what-is-not-rendered}): no start row, no growth ticks,
// no byte counts. An execution appears once, when its outcome is known, as the operation row
// of the fence that launched it, colored by that outcome. Activity while it runs is the
// status line's business, not the transcript's.

import ModelText from "./model-text.ts";
import { colorEnabled } from "./color.ts";
import process from "node:process";
import type { OperationResult } from "@plurnk/plurnk-contracts";
import { renderOperationRow, objectOf, type LogEntryWire } from "./render.ts";

const useColor = colorEnabled();
const code = (n: string): string => useColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const BOLD = code("1");
const DIM = code("2");
const GREEN = code("32");
const PINK = code("95");
const RED = code("31");

// loop_seq/turn_seq/sequence: the entry's coordinate, on the wire for
// coordinate-bearing streams (exec) — plurnk-service #224. Optional: a
// stream without a coordinate renders without one (no URI parsing).
interface StreamCoord {
    loop_seq?: number;
    turn_seq?: number;
    sequence?: number;
}

export interface StreamEventPayload extends StreamCoord {
    entryId: number;
    workerId: number;       // owning worker and entry.read perspective
    target: string;         // the stream address stamped on the launching row (attrs.stream)
    channel: string;
    state: string;          // static | active | closed | errored
    contentLength: number;
}

export interface StreamConcludedPayload extends StreamCoord {
    entryId: number;
    workerId: number;
    target: string;         // the stream address stamped on the launching row (attrs.stream)
    subscriptionId: number;
    scheme: string;
    result: OperationResult;
    summary: string;
    wakeAction: string;     // wake-pending | no-op-active-loop | no-loop | skipped-aborted | skipped-cancelled
}

// A started execution's row carries its stream address: the daemon stamps `attrs.stream` on the
// execution row it started (status 200, outcome `started`), and every stream/event and stream/concluded
// for that execution names the same address as `target`. Opaque to the client, never composed.
export const streamAddress = (entry: LogEntryWire): string | null => {
    const stream = objectOf(entry.attrs)?.stream;
    return typeof stream === "string" && stream.length > 0 ? stream : null;
};

// The daemon's summary leads with the target; the remainder is the outcome in its words.
const summaryTail = (ev: StreamConcludedPayload): string => {
    const summary = ev.summary ?? "";
    return (summary.startsWith(ev.target) ? summary.slice(ev.target.length) : summary).replace(/^\s+/, "");
};

// Launched executions awaiting their conclusion, keyed by stream address. Plain Map, no timers.
export default class StreamTrace {
    #launched = new Map<string, LogEntryWire>();
    #greyed = new Set<string>();

    // A started execution has no outcome yet; its row waits for its stream's conclusion.
    // False for any other row, including an execution the daemon refused to start.
    launch(entry: LogEntryWire): boolean {
        const address = streamAddress(entry);
        if (address === null) return false;
        this.#launched.set(address, entry);
        return true;
    }

    // The fence that launched a stream, while its conclusion is still awaited.
    launchedBy(target: string): LogEntryWire | undefined {
        return this.#launched.get(target);
    }

    // Executions launched before the given turn and still open: each is returned once, for the
    // grey row that says the model moved on while it runs ({§cli-what-is-not-rendered}).
    staleBefore(loopSeq: number, turnSeq: number): LogEntryWire[] {
        const stale: LogEntryWire[] = [];
        for (const [address, launch] of this.#launched) {
            if (this.#greyed.has(address)) continue;
            if (launch.loop_seq > loopSeq || (launch.loop_seq === loopSeq && launch.turn_seq >= turnSeq)) continue;
            this.#greyed.add(address);
            stale.push(launch);
        }
        return stale;
    }

    // Growth and per-channel close carry nothing a line-oriented view should say.
    event(_ev: StreamEventPayload): string | null {
        return null;
    }

    // One row per execution, at its conclusion, in the operation grammar: the launching
    // fence when it is known, the stream's own scheme and address otherwise.
    concluded(ev: StreamConcludedPayload): string {
        const launch = this.#launched.get(ev.target);
        this.#launched.delete(ev.target);
        this.#greyed.delete(ev.target);
        const status = ev.result.status ?? 0;
        const failed = status !== 200;
        const title = ev.result.problem?.title;
        const failure = !failed ? null : typeof title === "string" && title.length > 0 ? title : summaryTail(ev) || String(status);
        if (launch !== undefined) return renderOperationRow(launch, { failed, failure });
        const parts = [`${BOLD}${failed ? PINK : GREEN}${ModelText.plain(ev.scheme)}${RESET}`, `(${ModelText.plain(ev.target)})`];
        if (failure !== null) parts.push(`— ${PINK}${ModelText.plain(failure)}${RESET}`);
        return parts.join(" ");
    }
}

// Inline-worthiness for concluded channel content: short enough that the
// content IS the better optics. Anything larger stays behind the summary.
// The one-shot CLI trace keeps this bounded exception; the waterfall does not.
export const inlineable = (content: string): boolean => {
    if (content.length === 0 || content.length > 160) return false;
    return content.trimEnd().split("\n").length <= 2;
};

// Render a concluded channel's content as indented lines under the
// conclusion; stderr is marked and tinted.
export const renderInline = (channel: string, content: string): string =>
    ModelText.plain(content).trimEnd().split("\n")
        .map((l) => channel === "stderr" ? `   ${RED}!${RESET} ${l}` : `   ${DIM}${l}${RESET}`)
        .join("\n");

// Write a stream line to stderr. Used by CLI mode; TUI writes inline in
// the waterfall through the terminal surface.
export const reportStream = (line: string): void => {
    process.stderr.write(`${line}\n`);
};
