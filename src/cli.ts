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
import { renderStreamEvent, renderStreamConcluded, reportStream } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";

interface LoopRunResult {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
}

interface SessionResult { id: number; name: string }

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

export const runCli = async (rpc: Rpc, prompt: string, session: SessionResult, opts: { json: boolean; modelAlias?: string; persona?: string; yolo: boolean }): Promise<number> => {
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

    // stream/event + stream/concluded — daemon-pushed channel-growth and
    // closure metadata per plurnk-service SPEC §13.6. Rendered as a one-
    // line trace on stderr; content fetching is not done here (CLI is a
    // trace viewer; plurnk.nvim does in-buffer content rendering).
    rpc.onNotification("stream/event", (params) => {
        reportStream(renderStreamEvent(params as StreamEventPayload));
    });
    rpc.onNotification("stream/concluded", (params) => {
        reportStream(renderStreamConcluded(params as StreamConcludedPayload));
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

    const start = Date.now();
    const loopParams: { prompt: string; alias?: string; persona?: string } = { prompt };
    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;
    if (opts.persona !== undefined) loopParams.persona = opts.persona;

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

    let result: LoopRunResult;
    try {
        result = await rpc.call("loop.run", loopParams) as LoopRunResult;
    } finally {
        process.removeListener("SIGINT", onSigint);
    }
    const wallMs = Date.now() - start;

    process.stderr.write(`\nfinal status: ${result.finalStatus}${result.hitMaxTurns ? " (maxTurns reached)" : ""}\n`);
    const tokenPart = loopTokens > 0 ? `, tokens: ${loopTokens}` : "";
    process.stderr.write(`turns: ${result.turnIds.length}, wall: ${(wallMs / 1000).toFixed(2)}s${tokenPart}\n`);

    if (result.finalStatus === 200) return 0;
    if (result.hitMaxTurns) return 2;
    return 3;
};
