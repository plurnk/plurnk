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
import { extractOpenPaths } from "./openpaths.ts";
import { pathPartial, completePath, dslOpPartial, completeOps } from "./completion.ts";
import type Rpc from "./rpc.ts";
import { renderLogEntry, renderSummary, isPromptEntry, coordLabel } from "./render.ts";
import type { LoopUsage } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { renderProposalMenu, keyToResolution, isServerResolved } from "./proposal.ts";
import type { ProposalParams, Resolution } from "./proposal.ts";
import { renderTelemetryEvent, report, clientSubcommandUnknownVerb } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { inlineable, renderInline } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import { runModels, runSessionList, runSessionRuns, runLogRead } from "./subcommands.ts";

// loop.run is fire-and-forget (svc 0.45.0+ "Model 3"): it ACKS immediately
// with {loopId, finalStatus:100, action} and the loop drains async — the real
// outcome rides loop/terminated. `status`/`error` appear only on a synchronous
// failure (e.g. 501 no provider). LoopTerminated is the loop/terminated payload.
interface LoopAck {
    loopId?: number;
    finalStatus?: number;
    status?: number;
    error?: string;
}

interface LoopTerminated {
    finalStatus: number;
    hitMaxTurns: boolean;
    turnIds: number[];
    usage?: LoopUsage;
}

interface SessionResult { id: number; name: string }

// One verb vocabulary across nvim's :AI/, the TUI, and (where they exist)
// the argv subcommands. Convergence is policy: divergence needs a reason.
// Singular = CREATE, plural = LIST: /session makes a new session, /sessions
// lists them; /run forks a new run, /runs lists them. The old /new was
// ambiguous (session or run?) and is gone. /rename retargets the current
// session's mutable handle (a run's name is immutable — no /rename for runs).
export const VERBS = [
    "help", "models", "sessions", "runs", "log", "model",
    "yolo", "session", "rename", "run", "stop", "quit",
    "pick", "hide", "view", "repo", "drop", "members", "import", "script",
    "accept", "reject", "cancel", "edit",
] as const;

export const TUI_HELP = [
    "  /models /sessions /runs /log [n]   inspect",
    "  /model <alias>                     model for subsequent loops",
    "  /yolo                              toggle local auto-accept",
    "  /session [name]                    new session",
    "  /rename <name>                     rename this session (a mutable handle)",
    "  /run [name]                        create a new run (session>run>loop>turn>op)",
    "  /pick <glob>                       membership: track file(s) in manifest",
    "  /hide <glob>                       membership: block file(s) from manifest",
    "  /view <glob>                       membership: track file(s) in manifest (read-only)",
    "  /repo <glob>                       membership: track a git repo folder",
    "  /drop <glob>                       membership: remove tracking rules for file(s), remove git tracking for folder",
    "  /members                           the model's resolved file universe (+ rules)",
    "  /import <path>                     dump a local file's content into the prompt",
    "  /script <path>                     run a .plk file (its DSL → op.parse)",
    "  /accept /reject /cancel /edit      resolve a pending proposal (or keys a/e/r/c)",
    "  /stop                              cancel the running loop",
    "  /quit                              exit",
    "  << raw DSL    ! cmd (exec)    ... inject    ? ask    : act",
    "  Ctrl-J / Alt-Enter                 insert a ↵ newline (editable); Enter submits",
    "  Alt-m/s · Alt-R/L/Y/N/M · Alt-x    quick verbs (nvim case): models sessions runs",
    "                                     log yolo session members stop · Alt-h help",
].join("\n") + "\n";

// The non-submitting newline keys, by their raw byte sequence (post paste
// filter): Ctrl-J is LF (`\n`, a distinct byte from Enter's CR — works on every
// terminal); Alt-Enter is Meta+Return (ESC then CR/LF). Enter itself is CR
// (`\r`) and is NOT matched here, so it still submits. Shift-Enter is absent by
// design (it can't be distinguished without the kitty/modifyOtherKeys protocol).
export const isNewlineKey = (forward: string): boolean =>
    forward === "\n" || forward === "\x1b\r" || forward === "\x1b\n";

// A soft-enter inserts this single-width glyph into readline's ONE line, so the
// whole multi-line buffer stays natively editable (backspace deletes the ↵ to
// rejoin; arrows/history cross it; readline owns the wrapping). On submit it
// expands back to a real newline. A pasted literal ↵ is preserved — expansion
// runs on the typed line BEFORE paste markers expand, so paste content is
// untouched.
export const NL_MARK = "↵";
export const expandNewlines = (line: string): string => line.replaceAll(NL_MARK, "\n");

// Muscle-memory quick-keys, converged with plurnk.nvim's `<leader>a<letter>`
// mnemonics — SAME CASE as nvim (lowercase m/s/x, capital R/L/Y/N/M), which
// Alt-<letter> can carry (Alt-m = `ESC m`, Alt-M = `ESC M` — distinct bytes).
// Delivered as Alt not Ctrl because Ctrl-<letter> collides with terminal/
// readline control codes: Ctrl-m IS Enter, Ctrl-Shift-m is ALSO Enter (Shift
// doesn't change a control code), Ctrl-s is XOFF, Ctrl-i is Tab, and readline
// owns a/e/n/p/u/w/k/l. Alt-b/f/d are skipped (readline word-ops).
export const ALT_SHORTCUTS: Readonly<Record<string, string>> = Object.freeze({
    m: "/models", s: "/sessions", R: "/runs", L: "/log",
    Y: "/yolo", N: "/session", M: "/members", x: "/stop", h: "/help",
});

// An Alt-<letter> keypress (ESC then a single letter, no `[`/`O` → not an arrow
// or function key) mapped to its verb, or null. Case-sensitive (mirrors nvim).
// Reassembled by the paste filter whether it arrives in one chunk or split.
export const altShortcut = (forward: string): string | null => {
    const m = forward.match(/^\x1b([a-zA-Z])$/);
    return m ? (ALT_SHORTCUTS[m[1]] ?? null) : null;
};

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
    versionNotice?: string; sessionName: string; modelAlias?: string; activeAlias?: string; yolo?: boolean;
}): string => {
    const head = opts.versionNotice ?? "plurnk";
    const modelLabel = opts.modelAlias ?? opts.activeAlias ?? "(daemon default)";
    const yolo = opts.yolo ? " · yolo: on" : "";
    return `${head} · session: ${opts.sessionName} · model: ${modelLabel}${yolo} · /help`;
};

// Verb dispatch, extracted from runTui so the handlers are unit-testable
// (stub rpc, collect writes, fake session/import). Verbs never call loop.run —
// they're run-tab furniture. Returns "quit" to close the REPL.
export interface VerbContext {
    rpc: Rpc;
    opts: { modelAlias?: string; yolo: boolean; projectRoot?: string | null; client?: string; autoReadAgents?: boolean };
    getSession: () => SessionResult;
    setSession: (s: SessionResult) => void;
    write: (s: string) => void;
    importFile: (path: string) => Promise<void>;
    // Resolve the pending proposal (no-op if none) — the typed no-modifier
    // fallback for the a/e/r/c review keys. `edit` opens $EDITOR.
    resolveProposal: (action: "accept" | "reject" | "cancel" | "edit") => Promise<void>;
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
        case "session": {
            // New session — a fresh world. Rebind in place (service
            // §13.5-rebind), no reconnect. Name is optional (auto-named if
            // omitted) and is a mutable handle (/rename retargets it later).
            const params: { name?: string; projectRoot?: string | null; settings?: { client?: string; autoReadAgents?: boolean } } = {};
            if (rest.length > 0) params.name = rest;
            if (opts.projectRoot !== undefined) params.projectRoot = opts.projectRoot;
            // #249 client id + #268 AGENTS-auto-load override, carried onto the fresh session.
            if (opts.client !== undefined || opts.autoReadAgents !== undefined) {
                params.settings = {};
                if (opts.client !== undefined) params.settings.client = opts.client;
                if (opts.autoReadAgents !== undefined) params.settings.autoReadAgents = opts.autoReadAgents;
            }
            ctx.setSession(await rpc.call("session.create", params) as SessionResult);
            write(`  session: ${ctx.getSession().name} (new)\n`);
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
        case "run": {
            // New run — run.fork (svc#248) branches this conversation, optionally
            // named at instantiation (immutable after). Bind to the fork so the
            // next prompt speaks there. The session (the world) is unchanged.
            const forked = await rpc.call("run.fork", rest.length > 0 ? { name: rest } : {}) as { runId: number; runName: string };
            await rpc.call("session.attach", { id: ctx.getSession().id, runId: forked.runId });
            write(`  run: ${forked.runName} (new)\n`);
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
        case "script": {
            // Run a .plk file: read its bytes, feed the DSL to op.parse. The op
            // traces broadcast via log/entry (rendered above the prompt by the
            // global handler); side-effecting ops pause for review like any client
            // op. The client never parses the file — the daemon owns the grammar.
            if (rest.length === 0) { write("  usage: /script <path>\n"); return; }
            const text = await readFile(resolve(rest), "utf8");   // fail-hard on a missing file
            const { results } = await rpc.call("op.parse", { text }) as { results: Array<{ status: number }> };
            const worst = results.reduce((w, r) => (r.status > w ? r.status : w), 0);
            write(`  script: ${results.length} op${results.length === 1 ? "" : "s"}${worst >= 400 ? `, worst status ${worst}` : " ok"}\n`);
            return;
        }
        case "accept":
        case "reject":
        case "cancel":
        case "edit":
            // Typed no-modifier fallback for the a/e/r/c proposal review keys.
            await ctx.resolveProposal(verb as "accept" | "reject" | "cancel" | "edit");
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
    client?: string;            // #249 — frontend id, carried onto /session-created sessions
    autoReadAgents?: boolean;   // #268 — AGENTS auto-load override, carried onto /session
}): Promise<void> => {
    let current = session;
    // Highest loop_seq the waterfall has shown — the next prompt is one beyond.
    let lastLoopSeq = 0;
    // Loop state, hoisted so buildPrompt can show a steer prompt while a loop
    // runs and the line handler / SIGINT can share it.
    let inFlight = false;
    let cancelRequested = false;

    // Print a line ABOVE the live readline prompt without eating the user's
    // in-progress input. The canonical "log while prompting" idiom: wipe the
    // prompt row, write the line, then re-render the prompt + current buffer on
    // the row below (rl.prompt(true) preserves what's typed). This is what lets a
    // loop stream traces AND keep a steer prompt the user can inject into — no
    // cursor/width math, readline owns the redraw. Reassigned to the real impl
    // once rl exists; until then (no loop can be running yet) it just appends.
    let printAbove: (text: string) => void = (text) => { process.stdout.write(`${text}\n`); };

    // Subscribe to log/entry notifications — render each as a waterfall line,
    // printed above the prompt so a running loop's trace never clobbers it.
    rpc.onNotification("log/entry", (params) => {
        const p = params as { entry: LogEntryWire };
        if (p.entry.loop_seq > lastLoopSeq) lastLoopSeq = p.entry.loop_seq;
        // The typed line at the prompt is the user's record — rendering the
        // prompt broadcast too would duplicate it (see isPromptEntry).
        if (isPromptEntry(p.entry)) return;
        printAbove(renderLogEntry(p.entry));
    });

    // telemetry/event — interleaved with the trace waterfall.
    rpc.onNotification("telemetry/event", (params) => {
        const p = params as { loopId: number; event: TelemetryEvent };
        printAbove(renderTelemetryEvent(p.event));
    });

    // Streams, coalesced: one start line, one conclusion line, and tiny
    // concluded outputs inlined (the single bounded content fetch the TUI
    // makes — SPEC §5.3; the content IS the optics at two lines).
    const streams = new StreamTrace();
    rpc.onNotification("stream/event", (params) => {
        const line = streams.event(params as StreamEventPayload);
        if (line !== null) printAbove(line);
    });
    rpc.onNotification("stream/concluded", (params) => {
        const p = params as StreamConcludedPayload;
        printAbove(streams.concluded(p));
        void rpc.call("entry.read", { target: p.target }).then((r) => {
            const channels = (r as { entry?: { channels?: Record<string, { content?: string }> } | null }).entry?.channels ?? {};
            for (const name of ["stdout", "stderr"]) {
                const content = channels[name]?.content;
                if (typeof content === "string" && inlineable(content)) {
                    printAbove(renderInline(name, content));
                }
            }
        }).catch(() => { /* peek is best-effort */ });
    });

    // loop.run→loop/terminated bridge. loop.run only ACKS now (status 100); the
    // outcome arrives later on loop/terminated. A fresh loop awaits its own
    // termination by loopId. The buffer covers the race where a fast loop
    // terminates BEFORE loop.run's own response lands (we don't yet know the
    // loopId to register a waiter), so the event is held until the awaiter asks.
    const terminatedBuffer = new Map<number, LoopTerminated>();
    const terminatedWaiters = new Map<number, (t: LoopTerminated) => void>();
    rpc.onNotification("loop/terminated", (params) => {
        const { loopId, ...t } = params as { loopId: number } & LoopTerminated;
        const waiter = terminatedWaiters.get(loopId);
        if (waiter !== undefined) { terminatedWaiters.delete(loopId); waiter(t); return; }
        terminatedBuffer.set(loopId, t);
    });
    const awaitTermination = (loopId: number): Promise<LoopTerminated> => {
        const buffered = terminatedBuffer.get(loopId);
        if (buffered !== undefined) { terminatedBuffer.delete(loopId); return Promise.resolve(buffered); }
        return new Promise((res) => terminatedWaiters.set(loopId, res));
    };

    // Alias cache for /model completion + the active alias for the header —
    // one cheap RPC, refreshed never (aliases are daemon-boot-time config).
    // Awaited before the banner so the header can name the model the daemon
    // will actually use when --model/PLURNK_MODEL is unset (providers.list
    // marks the boot-time default `active`).
    let aliasCache: string[] = [];
    let activeAlias: string | undefined;
    // The active model's context window (svc#263) — the context-gauge denominator,
    // null when the provider can't report it. Fetched once with the alias list;
    // the gauge is approximate if /model later switches off the active default.
    let activeContextSize: number | null | undefined;
    try {
        const r = await rpc.call("providers.list") as { aliases?: Array<{ alias: string; active?: boolean; contextSize?: number | null }> };
        if (Array.isArray(r.aliases)) {
            aliasCache = r.aliases.map((a) => a.alias);
            const active = r.aliases.find((a) => a.active);
            activeAlias = active?.alias;
            activeContextSize = active?.contextSize;
        }
    } catch { /* completion stays empty; header falls back to (daemon default) */ }

    // One header line: version · session · model · help (see buildHeader).
    const header = buildHeader({
        versionNotice: opts.versionNotice, sessionName: current.name,
        modelAlias: opts.modelAlias, activeAlias, yolo: opts.yolo,
    });
    process.stdout.write(`\x1b[2m${header}\x1b[0m\n\n`);

    // The prompt is the user's row, restricted to WIDTH-STABLE glyphs —
    // settled empirically in two rounds. Round 1 (`  👤 ✉️  ✅ 201 : `)
    // drifted by exactly one column: ✉️ is U+2709+VS16, the variation-
    // selector class terminals genuinely cell-count differently; readline
    // repositions the cursor at its own computed width on every
    // history-nav/backspace/completion refresh, so the disagreement shows
    // as text shift. Round 2 (bare `  : `) fixed the drift but destroyed
    // the row identity. 🐹 (U+1F439, the brand head — was the generic 👤
    // U+1F464) and ✅ (U+2705) are plain East-Asian-Wide single code points —
    // width 2 in node AND every major terminal, no VS16 — so they stay; the
    // 201 is the contract constant (the prompt row is always a 201 EDIT);
    // 💬 (U+1F4AC, stable-wide) fills the op slot the toxic ✉️ vacated.
    // Policy: VS16/ambiguous glyphs are banned from the ENTIRE palette
    // (render.ts) — stable widths are also what make columns align.
    // The prompt is the user's row, coordinate-prefixed like every other
    // waterfall line (§5.1). The coordinate is the one the typed line will
    // get: the prompt becomes the next loop's foist EDIT at <next>/01/01.
    // lastLoopSeq tracks the highest loop the waterfall has shown; the next
    // prompt is one beyond it. Plain-ASCII coordinate — width-safe.
    // The prompt is the SAME whether or not a loop is running — kept alive above
    // the streaming traces by printAbove. The user just types; a line submitted
    // while a loop is in flight is folded into it (loop.inject), else it starts
    // the next loop. The user never has to know which — both continue the same
    // conversation. The yolo badge FILLS the prompt's 2-col indent — 🔥 (U+1F525) is width-2,
    // exactly the indent — so toggling yolo never shifts the prompt and the
    // coordinate stays column-aligned with the waterfall. 🔥 is plane-1 (width-
    // stable), NOT the BMP ⚡ (U+26A1) which a font may render width-1 and drift
    // the readline cursor (the ❓ U+2753 lesson).
    const buildPrompt = (): string => {
        const yolo = opts.yolo ? "🔥" : "  ";
        return `${yolo}${coordLabel(lastLoopSeq + 1, 1, 1)}🐹 💬 ✅ \x1b[32m201\x1b[0m \x1b[1m: \x1b[0m`;
    };
    // Bracketed-paste buffering (paste.ts): a multi-line paste must become ONE
    // prompt, not one loop.run per line. readline reads a PassThrough we feed
    // filtered stdin into; since the input is no longer the TTY directly, raw
    // mode and ?2004 are ours to manage (terminal:true keeps readline's
    // keypress decoding). Stream plumbing only — no cursor/width math.
    const paste = new PasteFilter();
    const input = new PassThrough();
    process.stdin.setRawMode?.(true);
    process.stdout.write("\x1b[?2004h");
    const rl = readline.createInterface({
        input,
        output: process.stdout,
        terminal: true,
        prompt: buildPrompt(),
        completer: makeCompleter(() => aliasCache, process.cwd()),
    });
    const reprompt = (): void => {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        rl.setPrompt(buildPrompt());
        rl.prompt();
    };
    // Now that rl exists, printAbove can re-render the prompt after each line.
    printAbove = (text: string): void => {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`${text}\n`);
        rl.prompt(true);
    };

    // Multi-line composition. The non-submitting newline keys insert a single ↵
    // marker into readline's ONE line; Enter submits, expanding ↵→\n. Keeping it
    // one readline line means backspace/arrows/history edit across newlines
    // natively — no second buffer, no cursor/width math, the same idiom as
    // paste. Two keys, one behavior (see isNewlineKey): Ctrl-J (LF) on every
    // terminal, Alt-Enter (Meta+CR) on most; Shift-Enter is unhandled by design
    // (needs the kitty/modifyOtherKeys protocols). Interposing on stdin
    // (paste.ts feeds readline a PassThrough) is where we catch the keys, so the
    // suppressed bytes never reach readline — which would otherwise submit on
    // `\n`. Each interactive keypress is its own chunk, so an exact match holds.
    // onStdin is the single keyboard dispatcher: pending-proposal key, paste,
    // the newline keys, the Alt-shortcuts, else readline. The proposal/shortcut
    // handlers are forward-declared (assigned once verbCtx exists).
    let pendingProposal: ProposalParams | null = null;
    let onProposalKey: (key: string) => void = () => {};
    let dispatchShortcut: (verb: string) => void = () => {};
    const onStdin = (chunk: Buffer): void => {
        const forward = paste.feed(chunk.toString("utf8"));
        if (forward.length === 0) return;
        // A pending proposal + an EMPTY prompt line: a single review key
        // (a/e/r/c) resolves it. Anything else — including typing `/accept` —
        // falls through to readline, so the no-modifier verb fallback works.
        if (pendingProposal !== null && rl.line.length === 0 && /^[aerc]$/i.test(forward)) {
            onProposalKey(forward);
            return;
        }
        if (isNewlineKey(forward)) { rl.write(NL_MARK); return; }
        const verb = altShortcut(forward);
        if (verb !== null) { dispatchShortcut(verb); return; }
        input.write(forward);
    };
    process.stdin.on("data", onStdin);
    // Cross-restart up/down history from the daemon (svc#238) — non-blocking.
    void seedPromptHistory(rpc, current.id, rl);

    // Proposal lifecycle — NON-BLOCKING. Server-resolved (flags.yolo/noProposals)
    // settle in-process → skip. --yolo auto-accepts. A real
    // proposal renders its menu and parks as `pendingProposal` (queue beyond),
    // WITHOUT pausing readline or grabbing stdin: resolve via a single key
    // (onStdin, above) OR the typed `/accept`/`/reject`/`/cancel`/`/edit` verbs.
    // Only the `$EDITOR` path hands the terminal off — and only for its spawn.
    const proposalQueue: ProposalParams[] = [];
    const showNextProposal = (): void => {
        if (pendingProposal !== null || proposalQueue.length === 0) return;
        pendingProposal = proposalQueue.shift() as ProposalParams;
        process.stdout.write(`\r\x1b[2K${renderProposalMenu(pendingProposal)}\n`
            + `\x1b[2m  resolve: a/e/r/c  or  /accept /reject /cancel /edit\x1b[0m\n`);
        reprompt();
    };
    const resolvePending = async (resolution: Resolution): Promise<void> => {
        const p = pendingProposal;
        if (p === null) return;
        pendingProposal = null;
        try {
            await rpc.call("loop.resolve", { logEntryId: p.logEntryId, ...resolution });
        } catch (cause) {
            process.stdout.write(`  \x1b[31mresolve failed: ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m\n`);
        }
        showNextProposal();
        reprompt();
    };
    // `e`/`/edit` → $EDITOR. It needs the terminal: detach onStdin + raw-off for
    // the spawn, restore after. The ONE place the non-blocking design still hands
    // off — bounded to the editor's lifetime.
    const editAndResolve = async (): Promise<void> => {
        const p = pendingProposal;
        if (p === null) return;
        process.stdin.off("data", onStdin);
        process.stdin.setRawMode?.(false);
        let resolution: Resolution;
        try {
            resolution = (await keyToResolution("e", p)) ?? { decision: "cancel", outcome: "edit_failed" };
        } catch (cause) {
            process.stdout.write(`  \x1b[31medit failed: ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m\n`);
            resolution = { decision: "cancel", outcome: "edit_error" };
        } finally {
            process.stdin.setRawMode?.(true);
            process.stdin.resume();
            process.stdin.on("data", onStdin);
        }
        await resolvePending(resolution);
    };
    // Single review key (from onStdin): a/r/c resolve directly, e edits.
    onProposalKey = (key: string): void => {
        if (key.toLowerCase() === "e") { void editAndResolve(); return; }
        void keyToResolution(key, pendingProposal as ProposalParams)
            .then((r) => { if (r !== null) return resolvePending(r); });
    };
    rpc.onNotification("loop/proposal", (params) => {
        const p = params as ProposalParams;
        if (isServerResolved(p)) return;
        if (opts.yolo) {
            void rpc.call("loop.resolve", { logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" })
                .catch(() => { /* idem */ });
            return;
        }
        proposalQueue.push(p);
        showNextProposal();
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
        resolveProposal: async (action) => {
            if (pendingProposal === null) { process.stdout.write("  (no pending proposal)\n"); return; }
            if (action === "edit") { await editAndResolve(); return; }
            await resolvePending({ decision: action });
        },
    };

    // Alt-<letter> shortcut → run the verb. Wipe the prompt line, dispatch
    // through the same handleVerb the typed `/verb` uses (the partial prompt in
    // readline's buffer survives), then reprompt. Print-above pattern; no math.
    dispatchShortcut = (verb: string): void => {
        process.stdout.write("\r\x1b[2K");
        void (async () => {
            try {
                if (await handleVerb(verb, verbCtx) === "quit") { rl.close(); return; }
            } catch (cause) {
                process.stdout.write(`  \x1b[31merror: ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m\n`);
            }
            reprompt();
        })();
    };

    reprompt();

    return new Promise<void>((resolve) => {
        rl.on("line", async (line) => {
            // Expand typed ↵ markers (Ctrl-J / Alt-Enter newlines) FIRST, then
            // paste markers — so a pasted literal ↵ stays literal.
            const trimmed = paste.expand(expandNewlines(line)).trim();
            if (trimmed.length === 0) {
                reprompt();
                return;
            }

            // Verbs: /stop and /help stay reachable while a loop is in
            // flight — /stop is precisely the mid-loop verb.
            if (trimmed.startsWith("/")) {
                const { verb } = parseSlash(trimmed);
                // /stop, /help, and the proposal verbs stay reachable mid-loop —
                // a proposal pauses the loop and must be resolvable by typing.
                const PASS = new Set(["stop", "help", "", "accept", "reject", "cancel", "edit"]);
                if (inFlight && !PASS.has(verb)) {
                    printAbove("  \x1b[2m(busy; /stop to cancel, /help for the language)\x1b[0m");
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
                    printAbove("  \x1b[2m(loop running — /stop before a client op)\x1b[0m");
                    return;
                }
                const inject = trimmed.replace(/^(\.\.\.|[?:])\s*/, "");
                void rpc.call("loop.inject", { prompt: inject })
                    .then(() => printAbove("  \x1b[2m↳ added to the run\x1b[0m"))
                    .catch((cause) => printAbove(`  \x1b[31minject failed: ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m`));
                reprompt();
                return;
            }

            inFlight = true;
            // Surface a live steer prompt for the duration of the loop, so the
            // user has a stable row to type an inject into (the traces print
            // above it). buildPrompt switches to its steer form while inFlight.
            reprompt();
            const start = Date.now();
            let turnCount = 0;
            let finalStatus = 0;
            let hitMaxTurns = false;
            let usage: LoopUsage | undefined;

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
                    const loopParams: { prompt: string; alias?: string; flags?: Record<string, unknown>; maxTurns?: number; openPaths?: string[] } = { prompt: promptText };
                    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;
                    if (lineFlags !== undefined && Object.keys(lineFlags).length > 0) loopParams.flags = lineFlags;
                    if (opts.maxTurns !== undefined) loopParams.maxTurns = opts.maxTurns;
                    const openPaths = extractOpenPaths(promptText);   // @file refs → daemon turn-0 READs (#260)
                    if (openPaths.length > 0) loopParams.openPaths = openPaths;
                    const ack = await rpc.call("loop.run", loopParams) as LoopAck;
                    // Synchronous failure (501 no provider, etc.) carries `error`.
                    if (ack.error !== undefined) throw new Error(ack.error);
                    // Normal path: status 100 ack → block on loop/terminated for
                    // the real outcome. Any non-100 status is already terminal.
                    if (ack.finalStatus === 100 && ack.loopId !== undefined) {
                        const t = await awaitTermination(ack.loopId);
                        finalStatus = t.finalStatus;
                        hitMaxTurns = t.hitMaxTurns;
                        turnCount = t.turnIds.length;
                        usage = t.usage;
                    } else {
                        finalStatus = ack.finalStatus ?? ack.status ?? 0;
                    }
                }
                const wallMs = Date.now() - start;
                printAbove(renderSummary(turnCount, wallMs, finalStatus, hitMaxTurns, usage, activeContextSize));
            } catch (cause) {
                const msg = cause instanceof Error ? cause.message : String(cause);
                printAbove(`  \x1b[31merror: ${msg}\x1b[0m`);
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
            // Steal pi's nicety: hand back the one-liner to pick this session up.
            process.stdout.write(`\n  \x1b[2mresume this session:  plurnk --session ${current.name}\x1b[0m\n`);
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
