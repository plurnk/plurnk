// CLI mode — single loop.run, plain text, no glyphs. Unix-tool posture
// per SPEC.md §2 / TUI.md §2. Subscribes to log/entry notifications and
// prints each op as a plain trace line on stderr; only the terminal SEND
// body lands on stdout (§5.4). Suitable for piping to grep / awk / head / jq.

import type Rpc from "./rpc.ts";
import type { LogEntryWire, LoopUsage } from "./render.ts";
import { extractSendBody } from "./render.ts";
import { reviewProposal, isServerResolved } from "./proposal.ts";
import type { ProposalParams } from "./proposal.ts";
import { report, clientProposalEditsBlocked } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { inlineable, renderInline, reportStream } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";

interface LoopRunResult {
    loopId: number;
    modelRunId?: number;   // the conversation's run (live on loop.run, svc 0.44.0)
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
    reason?: string;
    usage?: LoopUsage;
}

interface SessionResult { id: number; name: string }

// Exit-code honesty (SPEC §4): a 4xx/5xx loop death is a FAILURE (4), not a
// user cancellation (3) — benchmark stats must distinguish them.
export const exitCodeForLoop = (finalStatus: number, hitMaxTurns: boolean): number => {
    if (finalStatus === 200) return 0;
    if (hitMaxTurns) return 2;
    if (finalStatus >= 400 && finalStatus !== 499) return 4;
    return 3;
};

// `--json` / `PLURNK_JSON` is a distinct OUTPUT MODE, not a flag on the text
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

// The complete client-observed record of one loop run, as a plain object ready
// to JSON.stringify. Pure → unit-testable without a daemon.
export const buildJsonRecord = (input: {
    session: SessionResult; prompt: string; response: string;
    entries: LogEntryWire[]; telemetry: TelemetryEvent[];
    result: { loopId: number; modelRunId?: number; turnIds: number[]; finalStatus: number; hitMaxTurns: boolean; reason?: string; usage?: LoopUsage };
    wallMs: number; timedOut: boolean;
}): Record<string, unknown> => {
    // Group ops by turn (turn_seq), preserving wire order within each turn, so
    // each turn/op stays a standalone object — NDJSON-able later without rework.
    const byTurn = new Map<number, Array<Record<string, unknown>>>();
    for (const e of input.entries) {
        const ops = byTurn.get(e.turn_seq) ?? [];
        ops.push({
            coord: entryCoord(e), op: e.op, origin: e.origin,
            target: entryTarget(e), status: e.status_rx,
            signal: typeof e.signal === "number" ? e.signal : null,
        });
        byTurn.set(e.turn_seq, ops);
    }
    const turns = [...byTurn.entries()].sort((a, b) => a[0] - b[0]).map(([turn, ops]) => ({ turn, ops }));
    const doc: Record<string, unknown> = {
        schemaVersion: JSON_SCHEMA_VERSION,
        session: { id: input.session.id, name: input.session.name },
        prompt: input.prompt,
        response: input.response,
        finalStatus: input.result.finalStatus,
        hitMaxTurns: input.result.hitMaxTurns,
        timedOut: input.timedOut,
        loopId: input.result.loopId,
        runId: input.result.modelRunId ?? null,   // the conversation's run, for correlation / `read --run`
        turnCount: input.result.turnIds.length,
        wallMs: input.wallMs,
        usage: input.result.usage !== undefined
            ? { promptTokens: input.result.usage.promptTokens, completionTokens: input.result.usage.completionTokens, costPico: input.result.usage.costPico }
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
    return `[${entry.status_rx}] ${entry.origin} ${entry.op}${sub} ${path}`.trim();
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
// conclusion, exec stdout→stdout / stderr→stderr, exit by closeStatus.
const runCliExec = async (rpc: Rpc, command: string): Promise<number> => {
    const concluded = new Promise<StreamConcludedPayload>((res) => {
        rpc.onNotification("stream/concluded", (p) => res(p as StreamConcludedPayload));
    });
    const result = await rpc.call("op.exec", { command }) as { status: number };
    if (result.status >= 400) {
        process.stderr.write(`exec rejected: ${result.status}\n`);
        return 4;
    }
    const fin = await concluded;
    const read = await rpc.call("entry.read", { target: fin.target }) as {
        entry?: { channels?: Record<string, { content?: string }> } | null;
    };
    const channels = read.entry?.channels ?? {};
    const out = channels.stdout?.content;
    const err = channels.stderr?.content;
    if (typeof out === "string" && out.length > 0) process.stdout.write(out);
    if (typeof err === "string" && err.length > 0) process.stderr.write(err);
    process.stderr.write(`exec: ${fin.closeStatus}\n`);
    return fin.closeStatus === 200 ? 0 : fin.closeStatus === 499 ? 3 : 4;
};

export const runCli = async (rpc: Rpc, prompt: string, session: SessionResult, opts: {
    json: boolean; modelAlias?: string; yolo: boolean;
    loopFlags?: Record<string, unknown>; maxTurns?: number; timeoutSec?: number;
}): Promise<number> => {
    // Two output modes. text (default): stdout = the answer, stderr = the human
    // trace (`plurnk "X" > answer.txt` captures just the broadcast body, SPEC §2).
    // json: accumulate everything, stay SILENT on both streams until the end,
    // then emit ONE complete document on stdout (buildJsonRecord).
    const json = opts.json;
    const entries: LogEntryWire[] = [];
    const telemetryEvents: TelemetryEvent[] = [];
    let response = "";

    if (!json) {
        process.stderr.write(`session: ${session.name}\n`);
        process.stderr.write(`prompt: ${prompt}\n\n`);
    }

    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire };
        if (json) {
            entries.push(p.entry);
            if (isTerminalBroadcast(p.entry)) response = extractSendBody(p.entry.tx, /* prettify */ false);
            return;
        }
        process.stderr.write(`${formatPlain(p.entry)}\n`);
        if (!isTerminalBroadcast(p.entry)) return;
        const out = extractSendBody(p.entry.tx, /* prettify */ false);
        if (out.length > 0) process.stdout.write(`${out}\n`);
    });

    // telemetry/event — parse errors, engine rail signals, scheme/provider
    // failures. Per SPEC.md §8. json mode folds them into the record's telemetry[].
    rpc.onNotification("telemetry/event", (params) => {
        const p = params as { loopId: number; event: TelemetryEvent };
        if (json) { telemetryEvents.push(p.event); return; }
        report(p.event);
    });



    // No review channel (non-TTY, no --yolo): the loop runs with
    // flags.noProposals (set below), so the SERVER auto-rejects
    // side-effecting ops in-process — fail-closed without a per-proposal
    // client roundtrip, no 5-minute hang. The proposal still broadcasts;
    // isServerResolved suppresses the handler. plurnk #24 (#169 client half).
    const noReviewChannel = !opts.yolo && process.stdin.isTTY !== true;

    // Proposal lifecycle (plurnk-service #42): pause-and-review for side-effecting
    // ops. Three paths:
    // - server-resolved (flags.yolo / flags.noProposals): the daemon settles the
    //   entry in-process; a client loop.resolve would race it. Skip entirely.
    // - --yolo: auto-accept locally without prompting (server still sends the notification).
    // - TTY: interactive review.
    rpc.onNotification("loop/proposal", (params) => {
        const p = params as ProposalParams;
        void (async () => {
            if (isServerResolved(p)) return;
            if (opts.yolo) {
                await rpc.call("loop.resolve", { logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" });
                return;
            }
            const resolution = await reviewProposal(p);
            await rpc.call("loop.resolve", { logEntryId: p.logEntryId, ...resolution });
        })();
    });

    // Prompt prefixes — the same habits as nvim and the TUI: `! cmd` execs,
    // `? text` asks (read-only loop), `: text` acts. Prefix wins over a
    // --flags mode.
    if (prompt.startsWith("!")) {
        const command = prompt.replace(/^!+\s*/, "");
        if (command.length === 0) {
            process.stderr.write("usage: plurnk \"! <command>\"\n");
            return 64;
        }
        return await runCliExec(rpc, command);
    }

    // Streams, coalesced (loop mode only — exec one-shot prints its own
    // output above): one start line, one conclusion line, tiny concluded
    // outputs inlined via the single bounded content fetch (SPEC §5.3).
    // Stream traces are content/progress narration → stderr, text mode only.
    // In json mode the EXEC/stream op already appears in turns[].ops; its output
    // is content, fetched on demand via `plurnk read L/T/S` (not inlined).
    const streams = new StreamTrace();
    rpc.onNotification("stream/event", (params) => {
        if (json) return;
        const line = streams.event(params as StreamEventPayload);
        if (line !== null) reportStream(line);
    });
    rpc.onNotification("stream/concluded", (params) => {
        if (json) return;
        const p = params as StreamConcludedPayload;
        reportStream(streams.concluded(p));
        void rpc.call("entry.read", { target: p.target }).then((r) => {
            const channels = (r as { entry?: { channels?: Record<string, { content?: string }> } | null }).entry?.channels ?? {};
            for (const name of ["stdout", "stderr"]) {
                const content = channels[name]?.content;
                if (typeof content === "string" && inlineable(content)) {
                    reportStream(renderInline(name, content));
                }
            }
        }).catch(() => { /* best-effort */ });
    });
    let effectiveFlags = opts.loopFlags;
    const p0 = prompt[0];
    if (p0 === "?" || p0 === ":") {
        effectiveFlags = { ...(opts.loopFlags ?? {}), mode: p0 === "?" ? "ask" : "act" };
        prompt = prompt.replace(/^[?:]+\s*/, "");
    }
    // No review channel → run with noProposals and own the explanation (text
    // mode; in json mode the server-rejected proposals show in turns[].ops).
    if (noReviewChannel) {
        effectiveFlags = { ...(effectiveFlags ?? {}), noProposals: true };
        if (!json) report(clientProposalEditsBlocked());
    }

    const start = Date.now();
    const loopParams: { prompt: string; alias?: string; flags?: Record<string, unknown>; maxTurns?: number } = { prompt };
    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;
    if (effectiveFlags !== undefined && Object.keys(effectiveFlags).length > 0) loopParams.flags = effectiveFlags;
    if (opts.maxTurns !== undefined) loopParams.maxTurns = opts.maxTurns;

    // First Ctrl-C cancels the run's active drain via loop.cancel
    // (plurnk-service §13.5) — the pending loop.run resolves with
    // finalStatus 499 and the normal exit-code path (3) applies. A second
    // Ctrl-C force-exits in case the daemon never comes back.
    let cancelRequested = false;
    const onSigint = (): void => {
        if (cancelRequested) process.exit(3);
        cancelRequested = true;
        process.stderr.write("cancelling… (ctrl-c again to force quit)\n");
        void rpc.call("loop.cancel", { reason: "user_sigint" });
    };
    process.on("SIGINT", onSigint);

    // --timeout: wall-clock cap. A wedged loop must not wedge the harness;
    // cancel via the wire and let the normal 499 path resolve.
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutSec !== undefined && opts.timeoutSec > 0) {
        timer = setTimeout(() => {
            timedOut = true;
            process.stderr.write(`timeout: ${opts.timeoutSec}s — cancelling\n`);
            void rpc.call("loop.cancel", { reason: "client_timeout" });
        }, opts.timeoutSec * 1000);
    }

    let result: LoopRunResult;
    try {
        result = await rpc.call("loop.run", loopParams) as LoopRunResult;
    } finally {
        process.removeListener("SIGINT", onSigint);
        if (timer !== undefined) clearTimeout(timer);
    }
    const wallMs = Date.now() - start;

    if (json) {
        // ONE complete document on stdout; stderr stayed silent throughout.
        const doc = buildJsonRecord({ session, prompt, response, entries, telemetry: telemetryEvents, result, wallMs, timedOut });
        process.stdout.write(`${JSON.stringify(doc)}\n`);
        return exitCodeForLoop(result.finalStatus, result.hitMaxTurns);
    }

    process.stderr.write(`\nfinal status: ${result.finalStatus}${result.hitMaxTurns ? " (maxTurns reached)" : ""}\n`);
    // Real provider usage (plurnk-service #197) — a model loop always carries it.
    let tokenPart = "";
    if (result.usage !== undefined) {
        tokenPart = `, tokens: ↑${result.usage.promptTokens} ↓${result.usage.completionTokens}`;
        if (result.usage.costPico > 0) tokenPart += `, cost: $${(result.usage.costPico / 1e12).toFixed(4)}`;
    }
    process.stderr.write(`turns: ${result.turnIds.length}, wall: ${(wallMs / 1000).toFixed(2)}s${tokenPart}\n`);

    return exitCodeForLoop(result.finalStatus, result.hitMaxTurns);
};
