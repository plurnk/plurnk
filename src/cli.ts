// CLI mode — single loop.run, plain text, no glyphs. Unix-tool posture
// per SPEC.md §2 / TUI.md §2. Subscribes to log/entry notifications and
// prints each op as a plain trace line on stderr; only the terminal SEND
// body lands on stdout (§5.4). Suitable for piping to grep / awk / head / jq.

import type Rpc from "./rpc.ts";
import type { LogEntryWire } from "./render.ts";
import { extractSendBody } from "./render.ts";
import { reviewProposal, isServerResolved } from "./proposal.ts";
import type { ProposalParams } from "./proposal.ts";
import { report, clientProposalNoTtyReview } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { inlineable, renderInline, reportStream } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";

interface LoopRunResult {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
    reason?: string;
    usage?: { promptTokens?: number; completionTokens?: number; costPico?: number };
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

// Machine-readable result envelope: one `result: {json}` line on stderr —
// stdout stays the pure answer; harnesses grep `^result: `.
export const formatResultLine = (r: {
    loopId: number; finalStatus: number; turns: number; wallMs: number;
    tokens: number; hitMaxTurns: boolean; timedOut: boolean; reason?: string;
    usage?: { promptTokens?: number; completionTokens?: number; costPico?: number };
}): string => {
    const payload: Record<string, unknown> = {
        loopId: r.loopId, finalStatus: r.finalStatus, turns: r.turns,
        wallMs: r.wallMs, tokens: r.tokens, hitMaxTurns: r.hitMaxTurns,
        timedOut: r.timedOut,
    };
    if (r.reason !== undefined) payload.reason = r.reason;
    // Real provider usage when the daemon sends it (plurnk-service #197).
    if (typeof r.usage?.promptTokens === "number") payload.promptTokens = r.usage.promptTokens;
    if (typeof r.usage?.completionTokens === "number") payload.completionTokens = r.usage.completionTokens;
    if (typeof r.usage?.costPico === "number") payload.costPico = r.usage.costPico;
    return `result: ${JSON.stringify(payload)}`;
};

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

export const formatJsonReply = (txUnknown: unknown): string => {
    const tx = txUnknown as { body?: { raw?: unknown; json?: unknown } | null } | null;
    if (tx === null || tx === undefined || tx.body === null || tx.body === undefined) return "";
    const { raw, json } = tx.body;
    if (json !== null && json !== undefined) return JSON.stringify(json);
    if (typeof raw !== "string") return "";
    return JSON.stringify(raw);
};

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
    json: boolean; modelAlias?: string; persona?: string; yolo: boolean;
    loopFlags?: Record<string, unknown>; maxTurns?: number; timeoutSec?: number;
}): Promise<number> => {
    // stdout is the program's product (the terminal answer); stderr is its narration.
    // Per SPEC.md §2: `plurnk "X" > answer.txt` captures just the terminal broadcast body.
    process.stderr.write(`session: ${session.name}\n`);
    process.stderr.write(`prompt: ${prompt}\n\n`);

    // Tokens for the summary: summed from the loop's log/entry rows
    // (log_entries.tokens — write-time content counts; provider usage is
    // not on the wire yet, plurnk-service#197).
    let loopTokens = 0;

    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire & { tokens?: number } };
        if (typeof p.entry.tokens === "number") loopTokens += p.entry.tokens;
        process.stderr.write(`${formatPlain(p.entry)}\n`);
        if (!isTerminalBroadcast(p.entry)) return;
        const out = opts.json ? formatJsonReply(p.entry.tx) : extractSendBody(p.entry.tx, /* prettify */ false);
        if (out.length > 0) process.stdout.write(`${out}\n`);
    });

    // telemetry/event — parse errors, engine rail signals, scheme/provider
    // failures. Routed through the unified renderer per SPEC.md §8.
    rpc.onNotification("telemetry/event", (params) => {
        const p = params as { loopId: number; event: TelemetryEvent };
        report(p.event);
    });



    // Proposal lifecycle (plurnk-service #42): pause-and-review for side-effecting
    // ops. Four paths:
    // - server-resolved (flags.yolo / flags.noProposals): the daemon settles the
    //   entry in-process; a client loop.resolve would race it. Skip entirely.
    // - --yolo: auto-accept locally without prompting (server still sends the notification).
    // - TTY: interactive review.
    // - no TTY, no yolo: fail closed (reject) so the daemon doesn't hang for 5 minutes.
    rpc.onNotification("loop/proposal", (params) => {
        const p = params as ProposalParams;
        void (async () => {
            if (isServerResolved(p)) return;
            if (opts.yolo) {
                await rpc.call("loop.resolve", { logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" });
                return;
            }
            if (process.stdin.isTTY !== true) {
                report(clientProposalNoTtyReview(p.logEntryId));
                await rpc.call("loop.resolve", {
                    logEntryId: p.logEntryId,
                    decision: "reject",
                    outcome: "no_tty_review",
                });
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
    const streams = new StreamTrace();
    rpc.onNotification("stream/event", (params) => {
        const line = streams.event(params as StreamEventPayload);
        if (line !== null) reportStream(line);
    });
    rpc.onNotification("stream/concluded", (params) => {
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

    const start = Date.now();
    const loopParams: { prompt: string; alias?: string; persona?: string; flags?: Record<string, unknown>; maxTurns?: number } = { prompt };
    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;
    if (opts.persona !== undefined) loopParams.persona = opts.persona;
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

    process.stderr.write(`\nfinal status: ${result.finalStatus}${result.hitMaxTurns ? " (maxTurns reached)" : ""}\n`);
    let tokenPart = loopTokens > 0 ? `, tokens: ${loopTokens}` : "";
    if (typeof result.usage?.promptTokens === "number" && typeof result.usage.completionTokens === "number") {
        tokenPart = `, tokens: ↑${result.usage.promptTokens} ↓${result.usage.completionTokens}`;
        if (typeof result.usage.costPico === "number" && result.usage.costPico > 0) {
            tokenPart += `, cost: $${(result.usage.costPico / 1e12).toFixed(4)}`;
        }
    }
    process.stderr.write(`turns: ${result.turnIds.length}, wall: ${(wallMs / 1000).toFixed(2)}s${tokenPart}\n`);
    process.stderr.write(`${formatResultLine({
        loopId: result.loopId, finalStatus: result.finalStatus,
        turns: result.turnIds.length, wallMs, tokens: loopTokens,
        hitMaxTurns: result.hitMaxTurns, timedOut, reason: result.reason,
        usage: result.usage,
    })}\n`);

    return exitCodeForLoop(result.finalStatus, result.hitMaxTurns);
};
