// Executions in the waterfall ({§cli-what-is-not-rendered}): no start row, no growth ticks,
// no byte counts. An execution appears once, when its outcome is known, as the operation row
// of the fence that launched it, colored by that outcome. Activity while it runs is the
// status line's business, not the transcript's.

import ModelText from "./model-text.ts";
import { paint } from "./color.ts";
import process from "node:process";
import { operationLabel } from "./operation-glyphs.ts";
import type { OperationResult } from "@plurnk/plurnk-contracts";
import { PREVIEW_OFFSET, fitRow, lineageWorker, objectOf, previewLine, previewLines, problemSummary, renderOperationBlock, renderOperationRow, type LogEntryWire } from "./render.ts";

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

// {§cli-stream-event-and-stream-concluded} An address may precede admission.
// Only a started or queued receipt promises a producer and its conclusion.
export const streamAddress = (entry: LogEntryWire): string | null => {
    if (entry.status_rx !== 200 && entry.status_rx !== 202) return null;
    const stream = objectOf(entry.attrs)?.stream;
    return typeof stream === "string" && stream.length > 0 ? stream : null;
};

// The daemon's summary leads with the target; the remainder is the outcome in its words.
const summaryTail = (ev: StreamConcludedPayload): string => {
    const summary = ev.summary ?? "";
    return (summary.startsWith(ev.target) ? summary.slice(ev.target.length) : summary).replace(/^\s+/, "");
};

// {§cli-status-streams} — the rows of a history that launched a stream the bound worker still holds open.
export const openLaunches = (entries: readonly LogEntryWire[], open: readonly string[]): LogEntryWire[] =>
    entries.filter((entry) => { const address = streamAddress(entry); return address !== null && open.includes(address); });

// Launched executions awaiting their conclusion, and conclusions awaiting their settled row, keyed by stream address.
// Plain Maps, no timers.
export default class StreamTrace {
    #launched = new Map<string, LogEntryWire>();
    #greyed = new Set<string>();
    #held = new Map<string, StreamConcludedPayload>();

    // A started execution has no outcome yet; its row waits for its stream's conclusion.
    // False for any other row, including an execution the daemon refused to start.
    launch(entry: LogEntryWire): boolean {
        const address = streamAddress(entry);
        if (address === null) return false;
        // {plurnk#108} — a child's execution concludes in the child's Run; its lineage row renders now.
        if (lineageWorker(entry) !== null) return false;
        this.#launched.set(address, entry);
        return true;
    }

    // The fence that launched a stream, while its conclusion is still awaited.
    launchedBy(target: string): LogEntryWire | undefined {
        return this.#launched.get(target);
    }

    // Executions launched before the given turn and still open: each is returned once, for the
    // grey row that says the model moved on while it runs ({§cli-what-is-not-rendered}).
    staleBefore(loopSeq: number, turnSeq: number, workerId?: number): LogEntryWire[] {
        const stale: LogEntryWire[] = [];
        for (const [address, launch] of this.#launched) {
            if (this.#greyed.has(address)) continue;
            // {plurnk#108} — a turn advance is one worker's; an observed descendant's execution keeps its own clock.
            if (workerId !== undefined && launch.worker_id !== workerId) continue;
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
    // fence when it is known, the stream's own scheme and address otherwise. A conclusion whose call still awaits its
    // settled row waits for that row ({§cli-stream-event-and-stream-concluded}): nothing now, and the row renders it.
    concluded(ev: StreamConcludedPayload, columns: number): string;
    concluded(ev: StreamConcludedPayload, columns: number, awaitingReceipt: boolean): string | null;
    concluded(ev: StreamConcludedPayload, columns: number, awaitingReceipt = false): string | null {
        const launch = this.#launched.get(ev.target);
        if (launch === undefined && awaitingReceipt) {
            this.#held.set(ev.target, ev);
            return null;
        }
        this.#launched.delete(ev.target);
        this.#greyed.delete(ev.target);
        return StreamTrace.#render(launch, ev, columns);
    }

    // The conclusion that arrived before this row's settlement, consumed once the row arrives.
    settled(entry: LogEntryWire): StreamConcludedPayload | null {
        const address = objectOf(entry.attrs)?.stream;
        const held = typeof address === "string" ? this.#held.get(address) : undefined;
        if (held === undefined) return null;
        this.#held.delete(held.target);
        return held;
    }

    // An execution that concluded before its call settled: the settled row, rendered with that conclusion.
    renderSettled(entry: LogEntryWire, ev: StreamConcludedPayload, columns: number): string {
        return StreamTrace.#render(entry, ev, columns);
    }

    // A result succeeds below 400; a failure names its Problem's title, else the daemon's summary.
    static #render(launch: LogEntryWire | undefined, ev: StreamConcludedPayload, columns: number): string {
        const status = ev.result.status ?? 0;
        const failed = status >= 400;
        const failure = !failed ? null : problemSummary(ev.result.problem) ?? (summaryTail(ev) || String(status));
        if (launch !== undefined) return renderOperationBlock(launch, { failed, failure }, false, columns);
        const parts = [paint(operationLabel(ModelText.plain(ev.scheme)), "bold", failed ? "failure" : "success"), `(${ModelText.plain(ev.target)})`];
        if (failure !== null) parts.push(`— ${paint(ModelText.plain(failure), "failure")}`);
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

// Render a concluded channel's content as indented lines under the conclusion, previewed
// ({plurnk#107}): the knob's line count, each line one row ({plurnk#162}). stderr is marked and tinted.
export const renderInline = (channel: string, content: string, columns: number): string =>
    previewLines(ModelText.plain(content).trimEnd().split("\n"), (remaining) => `… +${remaining} lines`)
        .map((l) => channel === "stderr"
            ? `${PREVIEW_OFFSET}${paint("!", "failure")} ${paint(fitRow(l, Math.max(2, columns - PREVIEW_OFFSET.length - 2)), "dim")}`
            : previewLine(l, columns))
        .join("\n");

// {§cli-what-is-not-rendered} An execution's inline preview in the waterfall: each channel that has output, then one
// blank line to separate it from what follows. An execution with no output adds nothing (#182).
export const inlineOutput = (
    channels: Readonly<Record<string, { readonly content?: string } | undefined>>,
    render: (channel: string, content: string) => string,
): string[] => {
    const previews = ["stdout", "stderr"].flatMap((name) => {
        const content = channels[name]?.content;
        return typeof content === "string" && content.trim().length > 0 ? [render(name, content)] : [];
    });
    return previews.length === 0 ? [] : [...previews, ""];
};

// Write a stream line to stderr. Used by CLI mode; TUI writes inline in
// the waterfall through the terminal surface.
export const reportStream = (line: string): void => {
    process.stderr.write(`${line}\n`);
};
