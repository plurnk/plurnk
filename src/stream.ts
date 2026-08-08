// Stream trace rendering for plurnk-service's stream/event and
// plurnk.stream events projected by the AG-UI+ interface.
//
// Optics discipline (v0.12.0): a 12-byte exec used to produce four raw
// metadata lines and never show its output. Now: ONE start line per
// stream (first event; growth ticks and close transitions are silent),
// one conclusion line in the waterfall grammar (📡 in the origin slot,
// status glyph, status, target), and tiny concluded outputs are inlined
// by the caller via entry.read — the single, bounded exception to "the
// TUI doesn't fetch content" (SPEC §5.3), because the content IS the
// optics when it's two lines long.

import process from "node:process";
import type { OperationResult } from "@plurnk/plurnk-contracts";
import { coordLabel } from "./render.ts";

const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";
const code = (n: string): string => useColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const GREEN = code("32");
const RED = code("31");

const STREAM_GLYPH = "📡";

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
    target: string;         // entry URI (scheme://pathname)
    channel: string;
    state: string;          // static | active | closed | errored
    contentLength: number;
}

export interface StreamConcludedPayload extends StreamCoord {
    entryId: number;
    workerId: number;
    target: string;         // entry URI (scheme://pathname)
    subscriptionId: number;
    scheme: string;
    result: OperationResult;
    summary: string;
    wakeAction: string;     // resumed-loop | no-op-active-loop | no-loop | skipped-aborted | skipped-cancelled
    wakeLoopId?: number;
}

// The coordinate label from a stream payload, or "" when the stream
// carries none (non-coordinate-bearing scheme).
const streamCoord = (ev: StreamCoord): string =>
    typeof ev.loop_seq === "number" && typeof ev.turn_seq === "number" && typeof ev.sequence === "number"
        ? coordLabel(ev.loop_seq, ev.turn_seq, ev.sequence)
        : "";

const statusGlyph = (status: number): string => {
    if (status === 200) return "  ";   // routine success — empty slot, not a check on every conclusion
    if (status === 499) return "✋";
    return "❌";
};

const statusColor = (status: number): string => status === 200 ? GREEN : RED;

// Per-connection coalescing state: which streams have announced their
// start. Cleared per entry on conclusion; plain Map, no timers.
export default class StreamTrace {
    #started = new Set<number>();

    // First event for an entry announces the stream; every later tick
    // (growth, per-channel close) is silent — a line-oriented view has
    // nothing actionable to say about len changing.
    // Column discipline: the waterfall grammar is `origin op status code target`.
    // A stream has no op and (while open) no code — those slots render as
    // width-matched blanks ("  " for the op glyph, "   " for the code) so the
    // status/code/target columns line up with the op rows instead of drifting left.
    event(ev: StreamEventPayload): string | null {
        if (this.#started.has(ev.entryId)) return null;
        this.#started.add(ev.entryId);
        // TWO lanes (identity · status) like every waterfall row; the in-flight line
        // has no status CODE yet, so the code column holds a reserved 3-blank.
        return `  ${streamCoord(ev)}${STREAM_GLYPH} ⏳ ${DIM}...${RESET} ${ev.target}`;
    }

    // One conclusion line in the waterfall grammar. The daemon's summary
    // leads with the target we already printed — strip the echo. Wake is
    // engine bookkeeping except when it resumed the parked loop.
    concluded(ev: StreamConcludedPayload): string {
        this.#started.delete(ev.entryId);
        const status = ev.result.status;
        let summary = ev.summary ?? "";
        if (summary.startsWith(ev.target)) summary = summary.slice(ev.target.length).replace(/^\s+/, "");
        const wake = ev.wakeAction === "resumed-loop" ? " → resumed loop" : "";
        const parts = [
            STREAM_GLYPH,   // lane 1: identity (the stream)
            statusGlyph(status),   // lane 2: status (reserved blank on 2xx)
            `${statusColor(status)}${status}${RESET}`,
            ev.target,
        ];
        let line = `  ${streamCoord(ev)}${parts.join(" ")}`;
        if (summary.length > 0) line += ` ${DIM}"${summary}"${RESET}`;
        return line + wake;
    }
}

// Inline-worthiness for concluded channel content: short enough that the
// content IS the better optics. Anything larger stays behind the summary.
export const inlineable = (content: string): boolean => {
    if (content.length === 0 || content.length > 160) return false;
    return content.trimEnd().split("\n").length <= 2;
};

// Render a concluded channel's content as indented lines under the
// conclusion; stderr is marked and tinted.
export const renderInline = (channel: string, content: string): string =>
    content.trimEnd().split("\n")
        .map((l) => channel === "stderr" ? `     ${RED}!${RESET} ${l}` : `     ${l}`)
        .join("\n");

// Write a stream line to stderr. Used by CLI mode; TUI writes inline in
// the waterfall with the readline-prompt-wipe prefix.
export const reportStream = (line: string): void => {
    process.stderr.write(`${line}\n`);
};
