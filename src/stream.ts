// Stream trace rendering for plurnk-service's stream/event and
// stream/concluded broadcasts (plurnk-service SPEC §7.1 / §13.6).
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

const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";
const code = (n: string): string => useColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const GREEN = code("32");
const RED = code("31");

const STREAM_GLYPH = "📡";

export interface StreamEventPayload {
    entryId: number;
    target: string;         // entry URI (scheme://pathname) — plurnk-service #179
    channel: string;
    state: string;          // static | active | closed | errored
    contentLength: number;
}

export interface StreamConcludedPayload {
    entryId: number;
    target: string;         // entry URI (scheme://pathname) — plurnk-service #179
    subscriptionId: number;
    scheme: string;
    closeStatus: number;
    summary: string;
    wakeAction: string;     // no-op-active-loop | opened-loop | skipped-aborted | skipped-no-provider
    wakeLoopId?: number;
}

const statusGlyph = (status: number): string => {
    if (status === 200) return "✅";
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
    event(ev: StreamEventPayload): string | null {
        if (this.#started.has(ev.entryId)) return null;
        this.#started.add(ev.entryId);
        // No coordinate: stream notifications don't carry loop_seq/turn_seq
        // (plurnk-service#224). Not reconstructed from the URI — that's the
        // daemon's value to surface, not the client's to decode.
        return `  ${STREAM_GLYPH} ⏳ ${ev.target}`;
    }

    // One conclusion line in the waterfall grammar. The daemon's summary
    // leads with the target we already printed — strip the echo. Wake is
    // engine bookkeeping except when it actually opened a loop.
    concluded(ev: StreamConcludedPayload): string {
        this.#started.delete(ev.entryId);
        let summary = ev.summary ?? "";
        if (summary.startsWith(ev.target)) summary = summary.slice(ev.target.length).replace(/^\s+/, "");
        const wake = ev.wakeAction === "opened-loop" ? " → woke loop" : "";
        const parts = [
            STREAM_GLYPH,
            statusGlyph(ev.closeStatus),
            `${statusColor(ev.closeStatus)}${ev.closeStatus}${RESET}`,
            ev.target,
        ];
        let line = `  ${parts.join(" ")}`;
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
