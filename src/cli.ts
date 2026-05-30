// CLI mode — single loop.run, plain text, no glyphs. Unix-tool posture
// per SPEC.md §2 / TUI.md §2. Subscribes to log/entry notifications and
// prints each op as a plain trace line on stderr; only the terminal SEND
// body lands on stdout (§5.4). Suitable for piping to grep / awk / head / jq.

import type Rpc from "./rpc.ts";
import type { LogEntryWire } from "./render.ts";
import { extractSendBody } from "./render.ts";
import { reviewProposal } from "./proposal.ts";
import type { ProposalParams } from "./proposal.ts";
import { report, clientProposalNoTtyReview } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";

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

    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire };
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
    // ops. Three paths:
    // - --yolo: auto-accept locally without prompting (server still sends the notification).
    // - TTY: interactive review.
    // - no TTY, no yolo: fail closed (reject) so the daemon doesn't hang for 5 minutes.
    rpc.onNotification("loop/proposal", (params) => {
        const p = params as ProposalParams;
        void (async () => {
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
    const result = await rpc.call("loop.run", loopParams) as LoopRunResult;
    const wallMs = Date.now() - start;

    process.stderr.write(`\nfinal status: ${result.finalStatus}${result.hitMaxTurns ? " (maxTurns reached)" : ""}\n`);
    process.stderr.write(`turns: ${result.turnIds.length}, wall: ${(wallMs / 1000).toFixed(2)}s\n`);

    if (result.finalStatus === 200) return 0;
    if (result.hitMaxTurns) return 2;
    return 3;
};
