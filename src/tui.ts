// TUI mode — interactive REPL with glyph waterfall. Vanilla ANSI + readline.
// Per TUI.md §3.
//
// Line language (converged with plurnk.nvim — one vocabulary, two surfaces):
//   /verb [args]   command verbs (see VERBS); never call loop.run
//   << raw DSL     op.parse
//   ! cmd          op.exec via the daemon
//   ? text         ask — loop.run with flags.mode="ask"
//   : text         act (the default)
//   text           prompt
// The readline prompt is `: ` — it rhymes with nvim's cmdline; when an
// ask-default toggle exists (nvim first), the prompt char flips to `? `.

import readline from "node:readline";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type Rpc from "./rpc.ts";
import { renderLogEntry, renderSummary, isPromptEntry } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { reviewProposal, isServerResolved } from "./proposal.ts";
import type { ProposalParams } from "./proposal.ts";
import { renderTelemetryEvent, report, clientSubcommandUnknownVerb } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { renderStreamEvent, renderStreamConcluded } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import { runModels, runSessionList, runSessionRuns, runLogRead } from "./subcommands.ts";

interface LoopRunResult {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
    usage?: { promptTokens?: number; completionTokens?: number; costPico?: number };
}

interface SessionResult { id: number; name: string }

// One verb vocabulary across nvim's :AI/, the TUI, and (where they exist)
// the argv subcommands. Convergence is policy: divergence needs a reason.
export const VERBS = [
    "help", "models", "sessions", "runs", "log", "model",
    "persona", "yolo", "new", "stop", "quit",
] as const;

export const TUI_HELP = [
    "  /models /sessions /runs /log [n]   inspect (same tables as the CLI)",
    "  /model <alias>                     model for subsequent loops",
    "  /persona <path>                    persona file for subsequent loops",
    "  /yolo                              toggle local auto-accept",
    "  /new [name]                        new session (reconnects)",
    "  /stop                              cancel the running loop",
    "  /quit                              exit",
    "  << raw DSL    ! cmd (exec)    ? text (ask)    : text (act)",
].join("\n") + "\n";

export const parseSlash = (line: string): { verb: string; rest: string } => {
    const m = line.match(/^\/(\S*)\s*(.*)$/);
    return { verb: m?.[1] ?? "", rest: (m?.[2] ?? "").trim() };
};

// readline completer — verbs after `/`, model aliases after `/model `.
// Plain readline machinery only; no screen takeover, no terminal hell.
export const makeCompleter = (getAliases: () => string[]) =>
    (line: string): [string[], string] => {
        const verbFrag = line.match(/^\/(\w*)$/);
        if (verbFrag) {
            const hits = VERBS.map((v) => `/${v}`).filter((v) => v.startsWith(line));
            return [hits, line];
        }
        const aliasFrag = line.match(/^\/model\s+(\S*)$/);
        if (aliasFrag) {
            const hits = getAliases().filter((a) => a.startsWith(aliasFrag[1]));
            return [hits, aliasFrag[1]];
        }
        return [[], line];
    };

export const runTui = async (rpc: Rpc, session: SessionResult, opts: {
    modelAlias?: string; persona?: string; yolo: boolean;
    loopFlags?: Record<string, unknown>; maxTurns?: number;
    projectRoot?: string | null;
}): Promise<void> => {
    let current = session;

    // Tokens for the summary line: summed from each dispatch's log/entry
    // rows (log_entries.tokens). Reset per dispatch in the line handler.
    let dispatchTokens = 0;

    // Subscribe to log/entry notifications — render each as a waterfall line.
    // `\r\x1b[2K` wipes any readline-redrawn prompt sitting on the current line
    // before our output, otherwise the first trace line lands beside the prompt.
    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire & { tokens?: number } };
        if (typeof p.entry.tokens === "number") dispatchTokens += p.entry.tokens;
        // The typed line at the prompt is the user's record — rendering the
        // prompt broadcast too would duplicate it (see isPromptEntry).
        if (isPromptEntry(p.entry)) return;
        process.stdout.write(`\r\x1b[2K${renderLogEntry(p.entry)}\n`);
    });

    // telemetry/event — interleaved with the trace waterfall.
    rpc.onNotification("telemetry/event", (params) => {
        const p = params as { loopId: number; event: TelemetryEvent };
        process.stdout.write(`\r\x1b[2K${renderTelemetryEvent(p.event)}\n`);
    });

    // stream/event + stream/concluded — daemon-pushed channel metadata.
    rpc.onNotification("stream/event", (params) => {
        process.stdout.write(`\r\x1b[2K${renderStreamEvent(params as StreamEventPayload)}\n`);
    });
    rpc.onNotification("stream/concluded", (params) => {
        process.stdout.write(`\r\x1b[2K${renderStreamConcluded(params as StreamConcludedPayload)}\n`);
    });

    process.stdout.write(`\x1b[2mplurnk · /help for the language · ctrl-c to quit · session: ${current.name}\x1b[0m\n\n`);

    // Alias cache for /model completion — one cheap RPC, refreshed never
    // (aliases are daemon-boot-time config).
    let aliasCache: string[] = [];
    void rpc.call("providers.list").then((r) => {
        const aliases = (r as { aliases?: Array<{ alias: string }> }).aliases;
        if (Array.isArray(aliases)) aliasCache = aliases.map((a) => a.alias);
    }).catch(() => { /* completion just stays empty */ });

    // ASCII-only prompt — settled EMPIRICALLY. The glyphful pre-rendered
    // row (`  👤 ✉️  ✅ 201 : `) shifted the text after the colon in real
    // terminals: the prompt string is static, but readline re-renders the
    // line on history-nav/backspace/completion and repositions the cursor
    // at ITS computed prompt width; emoji cell-width disagreement between
    // node and the terminal lands as visible drift on every refresh. Emoji
    // are therefore banned from the PROMPT specifically (output lines are
    // safe — no cursor positioning happens there). Bold-only ANSI is fine:
    // readline strips VT codes before width math.
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "  \x1b[1m: \x1b[0m",
        completer: makeCompleter(() => aliasCache),
    });

    // Proposal lifecycle: server-resolved proposals (flags.yolo/noProposals)
    // settle in-process — skip; --yolo auto-accepts locally; otherwise pause
    // readline, review, resolve, resume.
    rpc.onNotification("loop/proposal", (params) => {
        const p = params as ProposalParams;
        void (async () => {
            if (isServerResolved(p)) return;
            if (opts.yolo) {
                await rpc.call("loop.resolve", { logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" });
                return;
            }
            rl.pause();
            try {
                const resolution = await reviewProposal(p);
                await rpc.call("loop.resolve", { logEntryId: p.logEntryId, ...resolution });
            } finally {
                rl.resume();
                rl.prompt(true);
            }
        })();
    });

    // Verbs never call loop.run; they are run-tab furniture, not conversation.
    // Returns once the verb is fully rendered.
    const handleVerb = async (line: string): Promise<"quit" | undefined> => {
        const { verb, rest } = parseSlash(line);
        switch (verb) {
            case "":
            case "help":
                process.stdout.write(TUI_HELP);
                return;
            case "models": await runModels(rpc, { json: false }); return;
            case "sessions": await runSessionList(rpc, { json: false }); return;
            case "runs": await runSessionRuns(rpc, current.name, { json: false }); return;
            case "log": {
                const limit = rest.length > 0 ? Number(rest) : undefined;
                const filters = Number.isInteger(limit) && (limit as number) > 0 ? { limit: limit as number } : {};
                await runLogRead(rpc, { json: false, filters });
                return;
            }
            case "model":
                if (rest.length === 0) {
                    process.stdout.write(`  model: ${opts.modelAlias ?? "(daemon default)"}\n`);
                    return;
                }
                opts.modelAlias = rest;
                process.stdout.write(`  model: ${rest}\n`);
                return;
            case "persona": {
                if (rest.length === 0) { process.stdout.write("  usage: /persona <path>\n"); return; }
                const abs = isAbsolute(rest) ? rest : resolve(process.cwd(), rest);
                try {
                    opts.persona = await readFile(abs, "utf8");
                    process.stdout.write(`  persona: ${abs}\n`);
                } catch {
                    process.stdout.write(`  persona file not readable: ${abs}\n`);
                }
                return;
            }
            case "yolo":
                opts.yolo = !opts.yolo;
                process.stdout.write(`  yolo: ${opts.yolo ? "ON" : "OFF"}\n`);
                return;
            case "new": {
                // One session per connection (service §13.5) — a new session
                // means a fresh socket, same as plurnk.nvim's reconnect dance.
                await rpc.close();
                await rpc.connect();
                const params: { name?: string; projectRoot?: string | null } = {};
                if (rest.length > 0) params.name = rest;
                if (opts.projectRoot !== undefined) params.projectRoot = opts.projectRoot;
                current = await rpc.call("session.create", params) as SessionResult;
                process.stdout.write(`  session: ${current.name}\n`);
                return;
            }
            case "stop":
                await rpc.call("loop.cancel", { reason: "user_stop" });
                return;
            case "quit":
                return "quit";
            default:
                report(clientSubcommandUnknownVerb(`/${verb}`, [...VERBS]));
                return;
        }
    };

    rl.prompt();

    return new Promise<void>((resolve) => {
        let inFlight = false;
        let cancelRequested = false;

        rl.on("line", async (line) => {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                rl.prompt();
                return;
            }

            // Verbs: /stop and /help stay reachable while a loop is in
            // flight — /stop is precisely the mid-loop verb.
            if (trimmed.startsWith("/")) {
                const { verb } = parseSlash(trimmed);
                if (inFlight && verb !== "stop" && verb !== "help" && verb !== "") {
                    process.stdout.write("  \x1b[2m(busy; /stop to cancel, /help for the language)\x1b[0m\n");
                    rl.prompt();
                    return;
                }
                try {
                    if (await handleVerb(trimmed) === "quit") { rl.close(); return; }
                } catch (cause) {
                    const msg = cause instanceof Error ? cause.message : String(cause);
                    process.stdout.write(`  \x1b[31merror: ${msg}\x1b[0m\n`);
                }
                rl.prompt();
                return;
            }

            if (inFlight) {
                process.stdout.write("  \x1b[2m(busy; /stop to cancel)\x1b[0m\n");
                rl.prompt();
                return;
            }

            inFlight = true;
            const start = Date.now();
            dispatchTokens = 0;
            let turnCount = 0;
            let finalStatus = 0;
            let hitMaxTurns = false;
            let usage: LoopRunResult["usage"];

            try {
                if (trimmed.startsWith("<<")) {
                    // Raw DSL: send to op.parse
                    const result = await rpc.call("op.parse", { text: trimmed }) as { results: Array<{ status: number }> };
                    finalStatus = result.results[result.results.length - 1]?.status ?? 0;
                } else if (trimmed.startsWith("!")) {
                    // `! cmd` — exec via the daemon (proposal-gated like any
                    // side effect; output streams as stream/event traces).
                    const command = trimmed.replace(/^!+\s*/, "");
                    const result = await rpc.call("op.exec", { command }) as { status: number };
                    finalStatus = result.status;
                } else {
                    // Prompt. `? ` = ask (read-only loop, flags.mode="ask");
                    // `: ` = act. Per-line prefix overrides --flags mode.
                    let lineFlags = opts.loopFlags;
                    const prefix = trimmed[0];
                    if (prefix === "?" || prefix === ":") {
                        lineFlags = { ...(opts.loopFlags ?? {}), mode: prefix === "?" ? "ask" : "act" };
                    }
                    const promptText = trimmed.replace(/^[?:]+\s*/, "");
                    const loopParams: { prompt: string; alias?: string; persona?: string; flags?: Record<string, unknown>; maxTurns?: number } = { prompt: promptText };
                    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;
                    if (opts.persona !== undefined) loopParams.persona = opts.persona;
                    if (lineFlags !== undefined && Object.keys(lineFlags).length > 0) loopParams.flags = lineFlags;
                    if (opts.maxTurns !== undefined) loopParams.maxTurns = opts.maxTurns;
                    const result = await rpc.call("loop.run", loopParams) as LoopRunResult;
                    finalStatus = result.finalStatus;
                    hitMaxTurns = result.hitMaxTurns;
                    turnCount = result.turnIds.length;
                    usage = result.usage;
                }
                const wallMs = Date.now() - start;
                process.stdout.write(`${renderSummary(turnCount, wallMs, dispatchTokens, finalStatus, hitMaxTurns, usage)}\n`);
            } catch (cause) {
                const msg = cause instanceof Error ? cause.message : String(cause);
                process.stdout.write(`  \x1b[31merror: ${msg}\x1b[0m\n`);
            } finally {
                inFlight = false;
                cancelRequested = false;
                rl.prompt();
            }
        });

        rl.on("close", () => {
            process.stdout.write("\n");
            resolve();
        });

        rl.on("SIGINT", () => {
            // First Ctrl-C with a dispatch in flight: cancel the run's active
            // drain via loop.cancel (plurnk-service §13.5); the pending
            // loop.run resolves with finalStatus 499 and the REPL continues.
            // Second Ctrl-C (or idle Ctrl-C) exits — escape hatch for
            // dispatches a drain-cancel can't unblock (op.parse).
            if (inFlight && !cancelRequested) {
                cancelRequested = true;
                process.stdout.write("\r\x1b[2K  \x1b[2mcancelling… (ctrl-c again to quit)\x1b[0m\n");
                void rpc.call("loop.cancel", { reason: "user_sigint" });
                return;
            }
            rl.close();
        });
    });
};
