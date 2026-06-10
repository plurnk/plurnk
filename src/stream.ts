// Stream notification renderers for plurnk-service's stream/event and
// stream/concluded broadcasts (plurnk-service SPEC §7.1 / §13.6).
//
// Same `📡` glyph as TelemetryEvent (SPEC §8) — these are daemon-pushed
// metadata events the user should see, in the same channel posture
// (stderr in CLI, inline in TUI), distinguished by the discriminator.
//
// Content fetching (entry.read) is NOT done here — the CLI is a trace
// viewer. plurnk.nvim does in-buffer content rendering.

import process from "node:process";

const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";
const code = (n: string): string => useColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");

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

export const renderStreamEvent = (ev: StreamEventPayload): string => {
    const parts = [
        STREAM_GLYPH,
        "stream/event",
        ev.target,
        `channel=${ev.channel}`,
        `state=${ev.state}`,
        `len=${ev.contentLength}`,
    ];
    return `  ${parts.join(" ")}`;
};

export const renderStreamConcluded = (ev: StreamConcludedPayload): string => {
    const parts = [
        STREAM_GLYPH,
        "stream/concluded",
        ev.target,
        `status=${ev.closeStatus}`,
        `wake=${ev.wakeAction}`,
    ];
    let line = `  ${parts.join(" ")}`;
    if (ev.summary && ev.summary.length > 0) {
        line += ` ${DIM}"${ev.summary}"${RESET}`;
    }
    return line;
};

// Write a stream event to stderr. Used by CLI mode; TUI mode renders
// inline in the waterfall with the readline-prompt-wipe prefix.
export const reportStream = (line: string): void => {
    process.stderr.write(`${line}\n`);
};
