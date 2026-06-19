// TUI mode — interactive REPL with glyph waterfall. Vanilla ANSI + readline.
// Per TUI.md §3.
//
// Line language (converged with plurnk.nvim — one vocabulary, two surfaces):
//   /verb [args]   command verbs (see VERBS); never call loop.run
//   << raw DSL     op.parse
//   ! cmd          op.exec via the daemon
//   ... msg         loop.inject — speak into the running model loop
//   ? text         ask — loop.run with flags.mode="ask"
//   : text         act (the default)
//   text           prompt
// The readline prompt is `: ` — it rhymes with nvim's cmdline; when an
// ask-default toggle exists (nvim first), the prompt char flips to `? `.

import readline from "node:readline";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import PasteFilter from "./paste.ts";
import { pathPartial, completePath, dslOpPartial, completeOps } from "./completion.ts";
import type Rpc from "./rpc.ts";
import { renderLogEntry, renderSummary, isPromptEntry, coordLabel } from "./render.ts";
import type { LoopUsage } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { reviewProposal, isServerResolved } from "./proposal.ts";
import type { ProposalParams } from "./proposal.ts";
import { renderTelemetryEvent, report, clientSubcommandUnknownVerb } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { inlineable, renderInline } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import { runModels, runSessionList, runSessionRuns, runLogRead } from "./subcommands.ts";

interface LoopRunResult {
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
    usage?: LoopUsage;
}

interface SessionResult { id: number; name: string }

// One verb vocabulary across nvim's :AI/, the TUI, and (where they exist)
// the argv subcommands. Convergence is policy: divergence needs a reason.
export const VERBS = [
    "help", "models", "sessions", "runs", "log", "model",
    "yolo", "new", "rename", "fork", "stop", "quit",
    "pick", "hide", "view", "repo", "drop", "members", "import",
] as const;

export const TUI_HELP = [
    "  /models /sessions /runs /log [n]   inspect (same tables as the CLI)",
    "  /model <alias>                     model for subsequent loops",
    "  /yolo                              toggle local auto-accept",
    "  /new [name]                        new session (reconnects)",
    "  /rename <name>                     rename this session (a mutable handle)",
    "  /fork [name]                       branch this conversation into a new run",
    "  /pick <glob>                       membership: admit files git misses",
    "  /hide <glob>                       membership: drop a tracked match",
    "  /view <glob>                       membership: admit read-only",
    "  /repo <glob>                       membership: declare a git repo folder",
    "  /drop <glob>                       membership: remove a constraint",
    "  /members                           the model's resolved file universe (+ rules)",
    "  /import <path>                     dump a local file's content into the prompt",
    "  /stop                              cancel the running loop",
    "  /quit                              exit",
    "  << raw DSL    ! cmd (exec)    ... inject    ? ask    : act",
].join("\n") + "\n";

export const parseSlash = (line: string): { verb: string; rest: string } => {
    const m = line.match(/^\/(\S*)\s*(.*)$/);
    return { verb: m?.[1] ?? "", rest: (m?.[2] ?? "").trim() };
};

// readline completer — verbs after `/`, model aliases after `/model `.
// Plain readline machinery only; no screen takeover, no terminal hell.
// readline's async completer form (arity 2 → async). Verb/alias completion
// answers synchronously; path positions read the local fs (co-location law)
// and answer once readdir resolves.
export const makeCompleter = (getAliases: () => string[], cwd: string) =>
    (line: string, callback: (err: null, result: [string[], string]) => void): void => {
        const verbFrag = line.match(/^\/(\w*)$/);
        if (verbFrag) {
            callback(null, [VERBS.map((v) => `/${v}`).filter((v) => v.startsWith(line)), line]);
            return;
        }
        const aliasFrag = line.match(/^\/model\s+(\S*)$/);
        if (aliasFrag) {
            callback(null, [getAliases().filter((a) => a.startsWith(aliasFrag[1])), aliasFrag[1]]);
            return;
        }
        const op = dslOpPartial(line);
        if (op !== null) {
            callback(null, completeOps(op));
            return;
        }
        const partial = pathPartial(line);
        if (partial !== null) {
            void completePath(partial, cwd).then((result) => callback(null, result));
            return;
        }
        callback(null, [[], line]);
    };

// Seed readline history from the session's prior prompts (svc#238) so up/down
// recalls them across restarts. One clean RPC — newest-first, exactly what
// rl.history wants. Best-effort: a fresh session has none, failures are silent.
export const seedPromptHistory = async (rpc: Rpc, sessionId: number, rl: readline.Interface): Promise<void> => {
    try {
        const { prompts } = await rpc.call("session.prompts", { id: sessionId, limit: 100 }) as { prompts?: string[] };
        if (Array.isArray(prompts) && prompts.length > 0) (rl as unknown as { history: string[] }).history = prompts;
    } catch { /* history is a convenience; never block the REPL */ }
};

// The one-line startup banner: version · session · model · help. Pure so the
// model-label resolution is unit-testable. modelLabel = the client's
// --model/PLURNK_MODEL when set, else the daemon's active default
// (providers.list `active`), else an honest fallback.
export const buildHeader = (opts: {
    versionNotice?: string; sessionName: string; modelAlias?: string; activeAlias?: string;
}): string => {
    const head = opts.versionNotice ?? "plurnk";
    const modelLabel = opts.modelAlias ?? opts.activeAlias ?? "(daemon default)";
    return `${head} · session: ${opts.sessionName} · model: ${modelLabel} · /help`;
};

// Verb dispatch, extracted from runTui so the handlers are unit-testable
// (stub rpc, collect writes, fake session/import). Verbs never call loop.run —
// they're run-tab furniture. Returns "quit" to close the REPL.
export interface VerbContext {
    rpc: Rpc;
    opts: { modelAlias?: string; yolo: boolean; projectRoot?: string | null };
    getSession: () => SessionResult;
    setSession: (s: SessionResult) => void;
    write: (s: string) => void;
    importFile: (path: string) => Promise<void>;
}

export const handleVerb = async (line: string, ctx: VerbContext): Promise<"quit" | undefined> => {
    const { verb, rest } = parseSlash(line);
    const { rpc, opts, write } = ctx;
    switch (verb) {
        case "":
        case "help":
            write(TUI_HELP);
            return;
        case "models": await runModels(rpc, { json: false }); return;
        case "sessions": await runSessionList(rpc, { json: false }); return;
        case "runs": await runSessionRuns(rpc, ctx.getSession().name, { json: false }); return;
        case "log": {
            const limit = rest.length > 0 ? Number(rest) : undefined;
            const filters = Number.isInteger(limit) && (limit as number) > 0 ? { limit: limit as number } : {};
            await runLogRead(rpc, { json: false, filters });
            return;
        }
        case "model":
            if (rest.length === 0) { write(`  model: ${opts.modelAlias ?? "(daemon default)"}\n`); return; }
            opts.modelAlias = rest;
            write(`  model: ${rest}\n`);
            return;
        case "yolo":
            opts.yolo = !opts.yolo;
            write(`  yolo: ${opts.yolo ? "ON" : "OFF"}\n`);
            return;
        case "new": {
            // Rebind in place (service §13.5-rebind) — no reconnect.
            const params: { name?: string; projectRoot?: string | null } = {};
            if (rest.length > 0) params.name = rest;
            if (opts.projectRoot !== undefined) params.projectRoot = opts.projectRoot;
            ctx.setSession(await rpc.call("session.create", params) as SessionResult);
            write(`  session: ${ctx.getSession().name}\n`);
            return;
        }
        case "rename": {
            // session.rename — a session's name is a mutable handle on the world
            // (a run's is not). Mutates the attached session in place. svc#248.
            if (rest.length === 0) { write("  usage: /rename <name>\n"); return; }
            const renamed = await rpc.call("session.rename", { name: rest }) as SessionResult;
            ctx.setSession(renamed);
            write(`  session: ${renamed.name}\n`);
            return;
        }
        case "fork": {
            // run.fork (svc#248) — branch this conversation into a new run,
            // optionally named at instantiation (immutable after). Bind to the
            // fork so the next prompt speaks there. The session is unchanged.
            const forked = await rpc.call("run.fork", rest.length > 0 ? { name: rest } : {}) as { runId: number; runName: string };
            await rpc.call("session.attach", { id: ctx.getSession().id, runId: forked.runId });
            write(`  forked → ${forked.runName}\n`);
            return;
        }
        case "pick":
        case "hide":
        case "view":
        case "repo": {
            // Membership overlay (svc#200/#242) — service vocabulary, live via
            // session.constrain (session-scoped, re-resolved immediately).
            if (rest.length === 0) { write(`  usage: /${verb} <glob>\n`); return; }
            await rpc.call("session.constrain", { effect: verb, glob: rest });
            write(`  ${verb}: ${rest}\n`);
            return;
        }
        case "drop": {
            if (rest.length === 0) { write("  usage: /drop <glob>\n"); return; }
            const { constraints } = await rpc.call("session.constraints") as { constraints: Array<{ effect: string; glob: string }> };
            const matches = constraints.filter((c) => c.glob === rest);
            if (matches.length === 0) { write(`  no constraint matching ${JSON.stringify(rest)}\n`); return; }
            for (const c of matches) await rpc.call("session.unconstrain", c);
            write(`  dropped ${matches.length} constraint${matches.length === 1 ? "" : "s"} (${rest})\n`);
            return;
        }
        case "members": {
            // The model's RESOLVED universe (svc#243) — daemon-resolved
            // (ls-files ∪ pick) − hide, never the client's rule globs. Showing
            // the rules here (the old behavior) misinforms: rules are deltas,
            // not the universe. The constraint list rides along as a footer —
            // it's what /drop targets, but it is NOT "what the model sees".
            const { members, hidden } = await rpc.call("session.members") as {
                members: Array<{ path: string; effect: string }>; hidden: string[];
            };
            const editable = members.filter((m) => m.effect === "member");
            const view = members.filter((m) => m.effect === "view");
            if (members.length === 0 && hidden.length === 0) {
                write("  the model's universe is empty — no members (/pick a file or /repo a folder)\n");
            } else {
                write(`  the model's universe: ${members.length} file${members.length === 1 ? "" : "s"}`
                    + ` — ${editable.length} editable, ${view.length} read-only`
                    + `${hidden.length ? `, ${hidden.length} hidden` : ""}\n`);
                for (const m of view) write(`  view    ${m.path}\n`);
                for (const p of hidden) write(`  hidden  ${p}\n`);
                if (editable.length <= 40) for (const m of editable) write(`  member  ${m.path}\n`);
                else write(`  member  …${editable.length} editable files (git-tracked); listing suppressed\n`);
            }
            const { constraints } = await rpc.call("session.constraints") as { constraints: Array<{ effect: string; glob: string }> };
            write(constraints.length === 0
                ? "  rules: none (git-tracked files only)\n"
                : `  rules: ${constraints.map((c) => `${c.effect} ${c.glob}`).join(", ")}\n`);
            return;
        }
        case "import":
            // Dump a LOCAL file's content into the prompt (co-location law),
            // via the paste machinery. The rl/paste glue lives in ctx.importFile.
            if (rest.length === 0) { write("  usage: /import <path>\n"); return; }
            await ctx.importFile(rest);
            return;
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

export const runTui = async (rpc: Rpc, session: SessionResult, opts: {
    modelAlias?: string; yolo: boolean;
    loopFlags?: Record<string, unknown>; maxTurns?: number;
    projectRoot?: string | null; versionNotice?: string;
}): Promise<void> => {
    let current = session;
    // Highest loop_seq the waterfall has shown — the next prompt is one beyond.
    let lastLoopSeq = 0;

    // Subscribe to log/entry notifications — render each as a waterfall line.
    // `\r\x1b[2K` wipes any readline-redrawn prompt sitting on the current line
    // before our output, otherwise the first trace line lands beside the prompt.
    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire };
        if (p.entry.loop_seq > lastLoopSeq) lastLoopSeq = p.entry.loop_seq;
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

    // Streams, coalesced: one start line, one conclusion line, and tiny
    // concluded outputs inlined (the single bounded content fetch the TUI
    // makes — SPEC §5.3; the content IS the optics at two lines).
    const streams = new StreamTrace();
    rpc.onNotification("stream/event", (params) => {
        const line = streams.event(params as StreamEventPayload);
        if (line !== null) process.stdout.write(`\r\x1b[2K${line}\n`);
    });
    rpc.onNotification("stream/concluded", (params) => {
        const p = params as StreamConcludedPayload;
        process.stdout.write(`\r\x1b[2K${streams.concluded(p)}\n`);
        void rpc.call("entry.read", { target: p.target }).then((r) => {
            const channels = (r as { entry?: { channels?: Record<string, { content?: string }> } | null }).entry?.channels ?? {};
            for (const name of ["stdout", "stderr"]) {
                const content = channels[name]?.content;
                if (typeof content === "string" && inlineable(content)) {
                    process.stdout.write(`\r\x1b[2K${renderInline(name, content)}\n`);
                }
            }
        }).catch(() => { /* peek is best-effort */ });
    });

    // Alias cache for /model completion + the active alias for the header —
    // one cheap RPC, refreshed never (aliases are daemon-boot-time config).
    // Awaited before the banner so the header can name the model the daemon
    // will actually use when --model/PLURNK_MODEL is unset (providers.list
    // marks the boot-time default `active`).
    let aliasCache: string[] = [];
    let activeAlias: string | undefined;
    try {
        const r = await rpc.call("providers.list") as { aliases?: Array<{ alias: string; active?: boolean }> };
        if (Array.isArray(r.aliases)) {
            aliasCache = r.aliases.map((a) => a.alias);
            activeAlias = r.aliases.find((a) => a.active)?.alias;
        }
    } catch { /* completion stays empty; header falls back to (daemon default) */ }

    // One header line: version · session · model · help (see buildHeader).
    const header = buildHeader({
        versionNotice: opts.versionNotice, sessionName: current.name,
        modelAlias: opts.modelAlias, activeAlias,
    });
    process.stdout.write(`\x1b[2m${header}\x1b[0m\n\n`);

    // The prompt is the user's row, restricted to WIDTH-STABLE glyphs —
    // settled empirically in two rounds. Round 1 (`  👤 ✉️  ✅ 201 : `)
    // drifted by exactly one column: ✉️ is U+2709+VS16, the variation-
    // selector class terminals genuinely cell-count differently; readline
    // repositions the cursor at its own computed width on every
    // history-nav/backspace/completion refresh, so the disagreement shows
    // as text shift. Round 2 (bare `  : `) fixed the drift but destroyed
    // the row identity. 👤 (U+1F464) and ✅ (U+2705) are plain East-Asian-
    // Wide — width 2 in node AND every major terminal — so they stay; the
    // 201 is the contract constant (the prompt row is always a 201 EDIT);
    // 💬 (U+1F4AC, stable-wide) fills the op slot the toxic ✉️ vacated.
    // Policy: VS16/ambiguous glyphs are banned from the ENTIRE palette
    // (render.ts) — stable widths are also what make columns align.
    // The prompt is the user's row, coordinate-prefixed like every other
    // waterfall line (§5.1). The coordinate is the one the typed line will
    // get: the prompt becomes the next loop's foist EDIT at <next>/01/01.
    // lastLoopSeq tracks the highest loop the waterfall has shown; the next
    // prompt is one beyond it. Plain-ASCII coordinate — width-safe.
    const buildPrompt = (): string =>
        `  ${coordLabel(lastLoopSeq + 1, 1, 1)}👤 💬 ✅ \x1b[32m201\x1b[0m \x1b[1m: \x1b[0m`;
    // Bracketed-paste buffering (paste.ts): a multi-line paste must become ONE
    // prompt, not one loop.run per line. readline reads a PassThrough we feed
    // filtered stdin into; since the input is no longer the TTY directly, raw
    // mode and ?2004 are ours to manage (terminal:true keeps readline's
    // keypress decoding). Stream plumbing only — no cursor/width math.
    const paste = new PasteFilter();
    const input = new PassThrough();
    const onStdin = (chunk: Buffer): void => {
        const forward = paste.feed(chunk.toString("utf8"));
        if (forward.length > 0) input.write(forward);
    };
    process.stdin.setRawMode?.(true);
    process.stdin.on("data", onStdin);
    process.stdout.write("\x1b[?2004h");
    const rl = readline.createInterface({
        input,
        output: process.stdout,
        terminal: true,
        prompt: buildPrompt(),
        completer: makeCompleter(() => aliasCache, process.cwd()),
    });
    const reprompt = (): void => { rl.setPrompt(buildPrompt()); rl.prompt(); };
    // Cross-restart up/down history from the daemon (svc#238) — non-blocking.
    void seedPromptHistory(rpc, current.id, rl);

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

    // Verb dispatch runs through the testable module-level handleVerb; this
    // context injects the live session / opts / stdout / import glue.
    const verbCtx: VerbContext = {
        rpc, opts,
        getSession: () => current,
        setSession: (s) => { current = s; },
        write: (text) => { process.stdout.write(text); },
        importFile: async (rest) => {
            const abs = isAbsolute(rest) ? rest : resolve(process.cwd(), rest);
            let content: string;
            try { content = await readFile(abs, "utf8"); }
            catch (cause) { process.stdout.write(`  not readable: ${cause instanceof Error ? cause.message : String(cause)}\n`); return; }
            rl.write(paste.stash(content));
        },
    };

    reprompt();

    return new Promise<void>((resolve) => {
        let inFlight = false;
        let cancelRequested = false;

        rl.on("line", async (line) => {
            // Expand any paste markers back to the raw multi-line text.
            const trimmed = paste.expand(line).trim();
            if (trimmed.length === 0) {
                reprompt();
                return;
            }

            // Verbs: /stop and /help stay reachable while a loop is in
            // flight — /stop is precisely the mid-loop verb.
            if (trimmed.startsWith("/")) {
                const { verb } = parseSlash(trimmed);
                if (inFlight && verb !== "stop" && verb !== "help" && verb !== "") {
                    process.stdout.write("  \x1b[2m(busy; /stop to cancel, /help for the language)\x1b[0m\n");
                    reprompt();
                    return;
                }
                try {
                    if (await handleVerb(trimmed, verbCtx) === "quit") { rl.close(); return; }
                } catch (cause) {
                    const msg = cause instanceof Error ? cause.message : String(cause);
                    process.stdout.write(`  \x1b[31merror: ${msg}\x1b[0m\n`);
                }
                reprompt();
                return;
            }

            if (inFlight) {
                // A model loop is running. A prompt typed now is the "btw"
                // steering case (loop.inject, #193), NOT a conflict — inject it
                // into the live loop. (Raw DSL / exec are separate client-run
                // ops; keep them out of a running conversation for now.)
                if (trimmed.startsWith("<<") || trimmed.startsWith("!")) {
                    process.stdout.write("  \x1b[2m(loop running — /stop before a client op)\x1b[0m\n");
                    reprompt();
                    return;
                }
                const inject = trimmed.replace(/^(\.\.\.|[?:])\s*/, "");
                void rpc.call("loop.inject", { prompt: inject })
                    .then(() => process.stdout.write("  \x1b[2m↳ injected\x1b[0m\n"))
                    .catch((cause) => process.stdout.write(`  \x1b[31minject failed: ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m\n`));
                reprompt();
                return;
            }

            inFlight = true;
            const start = Date.now();
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
                    const promptText = trimmed.replace(/^(\.\.\.|[?:]+)\s*/, "");
                    const loopParams: { prompt: string; alias?: string; flags?: Record<string, unknown>; maxTurns?: number } = { prompt: promptText };
                    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;
                    if (lineFlags !== undefined && Object.keys(lineFlags).length > 0) loopParams.flags = lineFlags;
                    if (opts.maxTurns !== undefined) loopParams.maxTurns = opts.maxTurns;
                    const result = await rpc.call("loop.run", loopParams) as LoopRunResult;
                    finalStatus = result.finalStatus;
                    hitMaxTurns = result.hitMaxTurns;
                    turnCount = result.turnIds.length;
                    usage = result.usage;
                }
                const wallMs = Date.now() - start;
                process.stdout.write(`${renderSummary(turnCount, wallMs, finalStatus, hitMaxTurns, usage)}\n`);
            } catch (cause) {
                const msg = cause instanceof Error ? cause.message : String(cause);
                process.stdout.write(`  \x1b[31merror: ${msg}\x1b[0m\n`);
            } finally {
                inFlight = false;
                cancelRequested = false;
                reprompt();
            }
        });

        rl.on("close", () => {
            process.stdout.write("\x1b[?2004l");
            process.stdin.off("data", onStdin);
            process.stdin.setRawMode?.(false);
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
