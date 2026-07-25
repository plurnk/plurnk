// CLI mode — single loop.run, plain text, no glyphs. Unix-tool posture
// per SPEC.md §2 / TUI.md §2. Subscribes to log/entry notifications and
// prints each op as a plain trace line on stderr; only the terminal SEND
// body lands on stdout (§5.4). Suitable for piping to grep / awk / head / jq.

import type { LogEntryWire, LoopUsage } from "./render.ts";
import { extractSendBody, contextGauge } from "./render.ts";
import { reviewProposal, isServerResolved } from "./proposal.ts";
import type { ProposalParams } from "./proposal.ts";
import { report, clientProposalEditsBlocked, NO_MODEL_HINT } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { inlineable, renderInline, reportStream } from "./stream.ts";
import { extractOpenPaths } from "./openpaths.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";

// The assembled loop outcome — loopId/modelWorkerId from the loop.run ACK,
// the rest from the loop/terminated event (svc 0.45.0+ split, see below).
interface LoopRunResult {
    loopId: number;
    modelWorkerId?: number;   // the conversation's run (live on loop.run, svc 0.44.0)
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
    reason?: string;
    usage?: LoopUsage;
}

// loop.run is fire-and-forget (svc 0.45.0+): it ACKS {loopId, modelWorkerId,
// finalStatus:100} and the loop drains async — the outcome rides loop/terminated.
// `status`/`error` appear only on a synchronous failure (501 no provider, etc.).
interface LoopAck {
    loopId?: number;
    modelWorkerId?: number;
    finalStatus?: number;
    status?: number;
    error?: string;
}
interface LoopTerminated {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
    usage?: LoopUsage;
}

interface WorkspaceResult { id: number; name: string }

// Exit-code honesty (SPEC §4): a 4xx/5xx loop death is a FAILURE (4), not a
// user cancellation (3) — benchmark stats must distinguish them.
export const exitCodeForLoop = (finalStatus: number, hitMaxTurns: boolean): number => {
    if (finalStatus === 200) return 0;
    if (hitMaxTurns) return 2;
    if (finalStatus >= 400 && finalStatus !== 499) return 4;
    return 3;
};

// `--json` / `PLURNK_CLIENT_JSON` is a distinct OUTPUT MODE, not a flag on the text
// output: stdout carries ONE complete structured document and nothing else,
// stderr stays silent. The CLI becomes the integration layer — shell out,
// parse, no third-party client needed. The document is the complete
// CLIENT-OBSERVED record (every turn's ops with target/status, telemetry, the
// answer, usage) — NOT op CONTENT: under co-location the consumer is on the
// same filesystem and can `plurnk read L/T/S` any entry on demand, the same
// OPEN/FOLD discipline the engine runs on. Bump on any breaking schema change.
export const JSON_SCHEMA_VERSION = 1;

const entryTarget = (e: LogEntryWire): string | null => {
    if (e.pathname === null) return null;
    return e.scheme !== null
        ? `${e.scheme}://${e.hostname ?? ""}${e.pathname}${e.fragment !== null ? `#${e.fragment}` : ""}`
        : e.pathname;
};

// The logical L/T/S coordinate — the address `plurnk read` takes.
const entryCoord = (e: LogEntryWire): string => {
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(e.loop_seq)}/${p(e.turn_seq)}/${p(e.sequence)}`;
};

// Group ops by turn (turn_seq), preserving wire order within each turn, so each
// turn/op stays a standalone object — NDJSON-able later without rework. Shared
// by the loop record and the script record.
const groupOpsByTurn = (entries: LogEntryWire[]): Array<{ turn: number; ops: Array<Record<string, unknown>> }> => {
    const byTurn = new Map<number, Array<Record<string, unknown>>>();
    for (const e of entries) {
        const ops = byTurn.get(e.turn_seq) ?? [];
        ops.push({
            coord: entryCoord(e), op: e.op, origin: e.origin,
            target: entryTarget(e), status: e.status_rx,
            signal: typeof e.signal === "number" ? e.signal : null,
        });
        byTurn.set(e.turn_seq, ops);
    }
    return [...byTurn.entries()].sort((a, b) => a[0] - b[0]).map(([turn, ops]) => ({ turn, ops }));
};

// The complete client-observed record of one loop run, as a plain object ready
// to JSON.stringify. Pure → unit-testable without a daemon.
export const buildJsonRecord = (input: {
    workspace: WorkspaceResult; prompt: string; response: string;
    entries: LogEntryWire[]; telemetry: TelemetryEvent[];
    result: { loopId: number; modelWorkerId?: number; turnIds: number[]; finalStatus: number; hitMaxTurns: boolean; reason?: string; usage?: LoopUsage };
    wallMs: number; timedOut: boolean;
}): Record<string, unknown> => {
    const entries = input.result.modelWorkerId === undefined
        ? input.entries
        : input.entries.filter((entry) => (entry as { worker_id?: unknown }).worker_id === input.result.modelWorkerId);
    const turns = groupOpsByTurn(entries);
    const doc: Record<string, unknown> = {
        schemaVersion: JSON_SCHEMA_VERSION,
        workspace: { id: input.workspace.id, name: input.workspace.name },
        prompt: input.prompt,
        response: input.response,
        finalStatus: input.result.finalStatus,
        hitMaxTurns: input.result.hitMaxTurns,
        timedOut: input.timedOut,
        loopId: input.result.loopId,
        workerId: input.result.modelWorkerId ?? null,   // the conversation's worker, for correlation / `read --worker`
        turnCount: input.result.turnIds.length,
        wallMs: input.wallMs,
        usage: input.result.usage !== undefined
            ? { promptTokens: input.result.usage.promptTokens, completionTokens: input.result.usage.completionTokens, costPico: input.result.usage.costPico, contextTokens: input.result.usage.contextTokens ?? null }
            : null,
        turns,
        telemetry: input.telemetry,
    };
    if (input.result.reason !== undefined) doc.reason = input.result.reason;
    return doc;
};

// In json mode, even a failure emits valid JSON on stdout — the consumer's
// parser never chokes. Pairs with a non-zero exit code (both channels).
export const buildJsonError = (kind: string, message: string, extra?: Record<string, unknown>): Record<string, unknown> => ({
    schemaVersion: JSON_SCHEMA_VERSION,
    error: { kind, message, ...(extra ?? {}) },
});

export const formatPlain = (entry: LogEntryWire): string => {
    // Render what the wire says — no synthesis. Bare pathname when scheme
    // is null; full URI when scheme is present.
    let path = "";
    if (entry.pathname !== null) {
        path = entry.scheme !== null
            ? `${entry.scheme}://${entry.hostname ?? ""}${entry.pathname}${entry.fragment !== null ? `#${entry.fragment}` : ""}`
            : entry.pathname;
    }
    const sub = entry.op === "SEND" && typeof entry.signal === "number" ? `[${entry.signal}]` : "";
    let line = `[${entry.status_rx}] ${entry.origin} ${entry.op}${sub} ${path}`.trim();
    // PLAN's reasoning rides tx.body (a plain string) — surface it like the TUI/nvim
    // do, so a one-shot run shows what the model planned, not a bare op name.
    if (entry.op === "PLAN") {
        const planBody = (entry.tx as { body?: unknown } | null)?.body;
        if (typeof planBody === "string" && planBody.trim().length > 0) {
            line += `  ${planBody.replace(/\s*\n\s*/g, " ").trim()}`;
        }
    }
    return line;
};

// Per plurnk-service Engine.ts, only SEND[200] and SEND[499] terminate a loop.
// Intermediate broadcasts (SEND[102] etc.) are protocol mechanics, not the answer.
// Broadcast = no target at all (both scheme AND pathname null), to distinguish
// from a SEND directed at file:// which has scheme=null but pathname set.
export const isTerminalBroadcast = (entry: LogEntryWire): boolean =>
    entry.op === "SEND"
    && entry.scheme === null
    && entry.pathname === null
    && typeof entry.signal === "number"
    && (entry.signal === 200 || entry.signal === 499);

// One-shot exec: `plurnk "! make test"` — op.exec via the daemon, stream to
export const buildScriptJsonRecord = (input: {
    workspace: WorkspaceResult; results: Array<{ status: number }>;
    entries: LogEntryWire[]; telemetry: TelemetryEvent[]; wallMs: number;
}): Record<string, unknown> => ({
    schemaVersion: JSON_SCHEMA_VERSION,
    workspace: { id: input.workspace.id, name: input.workspace.name },
    results: input.results,
    turns: groupOpsByTurn(input.entries),
    telemetry: input.telemetry,
    wallMs: input.wallMs,
});

// `plurnk script foo.plk` — feed a .plk file's DSL to op.parse and render the
// trace. The client is a dumb feeder: read bytes, hand the text to the daemon
// (which owns the grammar + dispatch), render the log/entry broadcasts, exit by
// worst op status. What's IN the file — flat ops today, richer topologies later
