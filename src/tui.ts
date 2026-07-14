// TUI mode — interactive REPL with glyph waterfall. Vanilla ANSI + readline.
// Per TUI.md §3.
//
// Line language (converged with plurnk.nvim — one vocabulary, two surfaces):
//   /verb [args]   command verbs (see VERBS); never call loop.run
//   << raw DSL     op.parse
//   << LOOK(uri)   off-run READ — inspect a uri's content for ME, not the model
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
// The verb wire: a structural caller (AG-UI+ actions underneath).
export interface VerbCaller { call(method: string, params?: object): Promise<unknown> }
import { renderLogEntry, renderSummary, isPromptEntry, coordLabel, entryTarget } from "./render.ts";
import type { LoopUsage } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { renderProposalMenu, keyToResolution, isServerResolved, questionFromProposal, renderQuestionMenu, answerForLine } from "./proposal.ts";
import { BridgeTransport, RunAckError, type Transport } from "./transport.ts";
import type { ProposalParams, Resolution } from "./proposal.ts";
import { renderTelemetryEvent, report, clientSubcommandUnknownVerb, NO_MODEL_HINT } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import StreamTrace, { inlineable, renderInline } from "./stream.ts";
import { runOAuth } from "./auth.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import { runModels, runSessionList, runSessionRuns, runLogRead } from "./subcommands.ts";

// The loop.run ack/terminated bridge (fire-and-forget: ACK {finalStatus:100} then
// the outcome on loop/terminated; a synchronous 501/error surfaces immediately)
// now lives in the Transport (WsTransport's loopId-keyed done, TerminatedInfo).

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
    "auth", "accept", "reject", "cancel", "edit",
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
    "  /auth <target>                     OAuth an auth-protected exec (e.g. notion) via device code",
    "  /accept /reject /cancel /edit      resolve a pending proposal (or keys a/e/r/c)",
    "  /stop                              cancel the running loop",
    "  /quit                              exit",
    "  << raw DSL    ! cmd (exec)    ... inject    ? ask    : act",
    "  << LOOK(uri)                       off-run READ — inspect a uri for you, not the model",
    "  Alt-p / Alt-n                      cycle <<LOOK through prior operations' targets",
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

// `<<LOOK…::LOOK` is a CLIENT pseudo-op — "READ, but for me instead of the model".
// The grammar (plurnk-grammar plurnk.md §Operations) terminates a statement with its
// own op name (`<<OP…:body:OP`), so a faithful rewrite swaps BOTH ends LOOK→READ and passes
// [signal](target)<sel>:body through untouched — the daemon only ever sees a real
// READ. `\b` keeps `<<LOOKUP` from matching. null when the line isn't a LOOK.
export const lookRewrite = (line: string): string | null =>
    /^<<LOOK\b/i.test(line)
        ? line.replace(/^<<LOOK\b/i, "<<READ").replace(/:LOOK(\s*)$/i, ":READ$1")
        : null;

// §2.0 prompt prefixes (converged with nvim's :AI ? / :AI :): `? ` puts mode:"ask"
// on the wire flags, `: ` forces act, both overriding a --flags base mode; `...`
// (injection) strips without minting flags. Mode is a per-line habit, never --ask.
export const lineMode = (trimmed: string, base?: Record<string, unknown>): { flags?: Record<string, unknown>; prompt: string } => {
    const prefix = trimmed[0];
    const flags = prefix === "?" || prefix === ":"
        ? { ...(base ?? {}), mode: prefix === "?" ? "ask" : "act" }
        : base;
    return { ...(flags !== undefined ? { flags } : {}), prompt: trimmed.replace(/^(\.\.\.|[?:]+)\s*/, "") };
};

// Alt-p / Alt-n cycle the <<LOOK target through prior operations (prev/next op).
// Alt-<letter> (`ESC<letter>`) survives the input pipeline intact — the paste
// filter always holds a lone ESC and reassembles `ESC<letter>`, the same path the
// Alt verb shortcuts use — whereas a Shift-Up CSI (`ESC[1;2A`) fragments at `ESC[1`
// and leaks to readline as history-prev. Caught before altShortcut (which has no
// lowercase p/n binding). null = not a cycle key.
export const cycleKey = (forward: string): "up" | "down" | null =>
    forward === "\x1bp" ? "up" : forward === "\x1bn" ? "down" : null;

// Pure cursor math for the LOOK coordinate cycler over `count` seen coordinates
// (oldest→newest). Up walks toward older (start at newest), down toward newer.
// Returns the next index, or null when there's nothing to cycle.
export const cycleCoord = (count: number, cursor: number | null, dir: "up" | "down"): number | null => {
    if (count === 0) return null;
    if (cursor === null) return dir === "up" ? count - 1 : null;
    return dir === "up" ? Math.max(0, cursor - 1) : Math.min(count - 1, cursor + 1);
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
export const seedPromptHistory = async (rpc: VerbCaller, sessionId: number, rl: readline.Interface): Promise<void> => {
    try {
        // Bridge mode has no client-known session id → omit it (the connection's
        // attached session answers); WS passes the real id.
        const params = sessionId > 0 ? { id: sessionId, limit: 100 } : { limit: 100 };
        const { prompts } = await rpc.call("session.prompts", params) as { prompts?: string[] };
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
    rpc: VerbCaller;
    opts: { modelAlias?: string; model?: string; yolo: boolean; projectRoot?: string | null; client?: string; autoReadAgents?: boolean };
    // Resolve an alias to its client-side "<provider>/<model>" routing spec (#90), so
    // /model retargets ROUTING, not just the display label. Injected to avoid a cycle
    // with dispatcher (which owns resolveModelSpec).
    resolveModel?: (alias: string) => string | undefined;
    getSession: () => SessionResult;
    setSession: (s: SessionResult) => void;
    // Switch to (or create) a named session — transport-agnostic (WS rebind /
    // bridge threadId re-map). Returns the new session handle.
    switchSession: (name: string | undefined) => Promise<SessionResult>;
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
            // Retarget ROUTING too, not just the label: without this the next loop
            // keeps sending the BOOT model's resolved spec (which the daemon prefers
            // over the alias, #90) — the switch would be cosmetic.
            opts.model = ctx.resolveModel?.(rest);
            write(`  model: ${rest}\n`);
            return;
        case "yolo":
            opts.yolo = !opts.yolo;
            write(`  yolo: ${opts.yolo ? "ON" : "OFF"}\n`);
            return;
        case "session": {
            // New session — a fresh world. Transport-agnostic: WS rebinds the
            // connection in place (service §13.5-rebind); the bridge re-maps its
            // threadId. Name is optional (auto-named/generated) and is a mutable
            // handle (/rename retargets it). client id (#249) + AGENTS override
            // (#268) ride the switch.
            ctx.setSession(await ctx.switchSession(rest.length > 0 ? rest : undefined));
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
        case "auth": {
            // #116 — the OAuth device-grant leg: authorize → print URL + code →
            // poll to authorized. Blocks the REPL while polling (Ctrl-C exits); the
            // service half is stateless, we own the poll loop + expiry bound.
            const target = rest.trim();
            if (target.length === 0) { write("  \x1b[2musage: /auth <target>  (the exec needing auth, e.g. notion)\x1b[0m"); return; }
            const r = await runOAuth(rpc, target, { print: write });
            write(`  ${r.ok ? "✅" : "❌"} ${r.message}`);
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

export const runTui = async (transport: Transport, session: SessionResult, opts: {
    modelAlias?: string; model?: string; resolveModel?: (alias: string) => string | undefined; yolo: boolean;
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
    // Prompt status gutter (#114, refined): two reserved slots — 🧮 while
    // embeddings warm, and a busy glyph (⏳ working / 💤 hibernating) whenever a
    // loop OR embedding is active. Glyphs when active, blanks when not, so the
    // prompt never shifts. Pure state, no timer — repainted on state change.
    let embedding = false;
    let hibernating = false;   // the loop parked on a SEND[202] (awaiting streams/workers)
    // <<LOOK off-run inspection: the REAL target URIs of prior operations the
    // waterfall has shown (oldest→newest, e.g. known:///plan.md) feed the Alt-p/
    // Alt-n cycler — not synthesized log-entry coordinates. lookCursor walks them.
    const priorTargets: string[] = [];
    let lookCursor: number | null = null;

    // Print a line ABOVE the live readline prompt without eating the user's
    // in-progress input. The canonical "log while prompting" idiom: wipe the
    // prompt row, write the line, then re-render the prompt + current buffer on
    // the row below (rl.prompt(true) preserves what's typed). This is what lets a
    // loop stream traces AND keep a steer prompt the user can inject into — no
    // cursor/width math, readline owns the redraw. Reassigned to the real impl
    // once rl exists; until then (no loop can be running yet) it just appends.
    let printAbove: (text: string) => void = (text) => { process.stdout.write(`${text}\n`); };

    // Streams, coalesced: one start line, one conclusion line, and tiny concluded
    // outputs inlined (the single bounded content fetch the TUI makes — SPEC §5.3).
    const streams = new StreamTrace();

    // A dropped connection can't carry a pending question's answer. shuttingDown
    // (set on an intentional quit) tells the transport to suppress its reject.
    let shuttingDown = false;
    transport.onClose(() => { if (!shuttingDown) pendingQuestion = null; });

    // Alias cache for /model completion + the active alias for the header —
    // one cheap RPC, refreshed never (aliases are daemon-boot-time config).
    // Awaited before the banner so the header can name the model the daemon
    // will actually use when --model/PLURNK_MODEL is unset (providers.list
    // marks the boot-time default `active`).
    let aliasCache: string[] = [];
    let activeAlias: string | undefined;
    // Alias list for completion + the header's active default. The context-gauge WINDOW
    // is NOT derived here — it rides each loop's usage.contextSize from the daemon (which
    // owns the budget narrative under the agnostic ruler; a switched model reports its own
    // window there). Re-deriving per-alias here was the wrong layer and mis-rendered a
    // model whose provider window is null but whose effective window is the ctx cap.
    try {
        const r = await transport.rpc("providers.list") as { aliases?: Array<{ alias: string; active?: boolean }> };
        if (Array.isArray(r.aliases)) {
            aliasCache = r.aliases.map((a) => a.alias);
            activeAlias = r.aliases.find((a) => a.active)?.alias;
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
        // Status rides the prompt's OWN glyphs — no prepended gutter, so the row
        // never shifts and stays column-aligned with the waterfall. The origin
        // 🐹→🧮 while embeddings warm; the status lane shows ⏳ (💤 if the loop is
        // parked on a SEND[202]) while busy, and holds a RESERVED BLANK when idle —
        // TWO lanes exactly, same as every waterfall row (identity · status), so the
        // prompt sits flush in the ladder. All glyphs are same-width palette members;
        // swapping in place keeps the columns and the readline cursor stable.
        const busy = inFlight || embedding;
        const origin = embedding ? "🧮" : "🐹";
        const status = busy ? (inFlight && hibernating ? "💤" : "⏳") : "  ";
        const yolo = opts.yolo ? "🔥" : "  ";
        return `${yolo}${coordLabel(lastLoopSeq + 1, 1, 1)}${origin} ${status} \x1b[32m201\x1b[0m \x1b[1m: \x1b[0m`;
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
    // Repaint the prompt preserving a typed-in inject (rl.prompt(true)) — used
    // when the status gutter changes (embedding starts/stops) mid-typing. The
    // printAbove idiom; readline owns the redraw, no cursor/width math.
    const repromptPreserving = (): void => {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        rl.setPrompt(buildPrompt());
        rl.prompt(true);
    };
    // Now that rl exists, printAbove can re-render the prompt after each line.
    printAbove = (text: string): void => {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`${text}\n`);
        rl.prompt(true);
    };

    // Replace the whole readline buffer with `text`, public-API only: Ctrl-U kills
    // to line start, Ctrl-K from there to the end (clearing whatever was typed),
    // then type the new text. No private fields, no cursor/width math.
    const setLine = (text: string): void => {
        rl.write(null, { ctrl: true, name: "u" });
        rl.write(null, { ctrl: true, name: "k" });
        rl.write(text);
    };

    // Alt-p/Alt-n: walk the REAL target URIs of prior operations and template a
    // `<<LOOK(<that uri>)::LOOK` line into the buffer — an editable starting point
    // (hand-edit before Enter). Nothing to cycle → leave the line be.
    const cycleLook = (dir: "up" | "down"): void => {
        lookCursor = cycleCoord(priorTargets.length, lookCursor, dir);
        if (lookCursor === null) return;
        setLine(`<<LOOK(${priorTargets[lookCursor]})::LOOK`);
    };

    // `<<LOOK(uri)` already rewritten (op token LOOK→READ) to a READ statement.
    // LOOK is a PURE QUERY: op.look (plurnk-service#283, shipped v0.57.0) runs READ's
    // full resolver but writes NO log entry — so the model never sees it and there's no
    // run to manage. Run on the main connection (the conversation run, so log:/// resolves
    // run-relative against the right run). Render the content; no op, no harvest. Trust
    // the contract: status is required, content is `string | null` (svc ReadResult).
    const runLook = async (readText: string): Promise<number> => {
        const r = await transport.rpc("op.look", { text: readText }) as { status: number; content: string | null };
        const content = r.content ?? "";
        printAbove(content.length > 0 ? content : `  \x1b[2m(look ${r.status}: no content)\x1b[0m`);
        return r.status;
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
    // A pending SEND[300] question (#346): answered by TYPING (a number picks a
    // choice; anything else is free response), NOT the a/e/r/c keypress path —
    // free response needs text. The line handler intercepts while this is set.
    let pendingQuestion: { logEntryId: number; choices: string[] } | null = null;
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
        const dir = cycleKey(forward);
        if (dir !== null) { cycleLook(dir); return; }
        const verb = altShortcut(forward);
        if (verb !== null) { dispatchShortcut(verb); return; }
        input.write(forward);
    };
    process.stdin.on("data", onStdin);
    // Cross-restart up/down history from the daemon (svc#238) — non-blocking.
    void seedPromptHistory({ call: (m, p) => transport.rpc(m, p) }, current.id, rl);

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
            await transport.resolve({ logEntryId: p.logEntryId, ...resolution });
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
    // The persistent run-plane handlers — one set, wired once, driven by whichever
    // transport is live. Same bodies as the old inline rpc.onNotification handlers;
    // they render the shared session's activity whether this REPL started the loop
    // or a worker/second client did (multi-client observability).
    transport.subscribe({
        onEntry: (entry) => {
            if (entry.loop_seq > lastLoopSeq) lastLoopSeq = entry.loop_seq;
            // The typed line at the prompt is the user's record — rendering the
            // prompt broadcast too would duplicate it (see isPromptEntry).
            if (isPromptEntry(entry)) return;
            // Record this op's REAL target URI for the Alt-p/Alt-n <<LOOK cycler.
            const target = entryTarget(entry);
            if (target !== null) priorTargets.push(target);
            // A model SEND[202] parks the loop → 💤; anything else → ⏳.
            hibernating = entry.op === "SEND" && entry.signal === 202;
            printAbove(renderLogEntry(entry));
        },
        onTelemetry: (event) => {
            // engine:turn liveness is the ⏳ gutter (inFlight), not a waterfall line.
            if (event.source === "engine:turn") return;
            // embed_progress toggles the 🧮 slot; repaint only on the edge.
            if (event.source === "engine:derivation" && event.kind === "embed_progress") {
                const active = Number(event.completed) < Number(event.total);
                if (active !== embedding) { embedding = active; repromptPreserving(); }
                return;
            }
            printAbove(renderTelemetryEvent(event));
        },
        onStream: (payload) => {
            // One channel for the lifecycle: concluded carries closeStatus, a start
            // event carries state. One start line, one conclusion line, tiny outputs inlined.
            if (typeof (payload as { closeStatus?: unknown }).closeStatus === "number") {
                const p = payload as StreamConcludedPayload;
                printAbove(streams.concluded(p));
                // #116 — a 401 close offers the device-grant flow (run /auth <scheme>).
                if (p.closeStatus === 401) printAbove(`  🔒 ${p.scheme} needs authorization — run \x1b[1m/auth ${p.scheme}\x1b[0m`);
                void transport.rpc("entry.read", { target: p.target }).then((r) => {
                    const channels = (r as { entry?: { channels?: Record<string, { content?: string }> } | null }).entry?.channels ?? {};
                    for (const name of ["stdout", "stderr"]) {
                        const content = channels[name]?.content;
                        if (typeof content === "string" && inlineable(content)) printAbove(renderInline(name, content));
                    }
                }).catch(() => { /* peek is best-effort */ });
            } else {
                const line = streams.event(payload as StreamEventPayload);
                if (line !== null) printAbove(line);
            }
        },
        onProposal: (p) => {
            // SEND[300] question FIRST — even a yolo loop stops the world for a human;
            // the line handler resolves it from the next typed line.
            const q = questionFromProposal(p);
            if (q !== null) {
                pendingQuestion = { logEntryId: p.logEntryId, choices: q.choices };
                printAbove(renderQuestionMenu(q.question, q.choices));
                reprompt();
                return;
            }
            if (isServerResolved(p)) return;
            if (opts.yolo) { void transport.resolve({ logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" }).catch(() => {}); return; }
            proposalQueue.push(p);
            showNextProposal();
        },
        // A loop terminating just clears the parked glyph; the summary is rendered
        // from the run's own done (below).
        onTerminated: () => { hibernating = false; },
    });

    // Verbs + read-only subcommands call rpc.call(...) only; route that through the
    // live transport (WS, or the bridge's management plane over /plurnk/rpc). A
    // .call-only adapter — no verb/subcommand here subscribes, so the other Rpc
    // methods are never reached.
    const verbRpc = { call: (method: string, params?: object): Promise<unknown> => transport.rpc(method, params) } as VerbCaller;

    // Verb dispatch runs through the testable module-level handleVerb; this
    // context injects the live session / opts / stdout / import glue.
    const verbCtx: VerbContext = {
        rpc: verbRpc, opts, resolveModel: opts.resolveModel,
        getSession: () => current,
        setSession: (s) => { current = s; },
        switchSession: (name) => transport.useSession(name, { projectRoot: opts.projectRoot, client: opts.client, autoReadAgents: opts.autoReadAgents }),
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
            // A pending SEND[300] question consumes the typed line as its answer,
            // BEFORE any verb/prompt/inject handling (#346): a number picks a
            // choice, anything else is free response. Empty → re-ask (don't
            // resolve with nothing). Resolves the world-stopped proposal via body.
            if (pendingQuestion !== null) {
                const body = answerForLine(line, pendingQuestion.choices);
                if (body === null) { reprompt(); return; }
                const { logEntryId } = pendingQuestion;
                pendingQuestion = null;
                await transport.resolve({ logEntryId, decision: "accept", body })
                    .catch((e) => printAbove(`  \x1b[31manswer failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`));
                reprompt();
                return;
            }
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
                // /quit is the universal escape: NEVER "busy"-blocked, so a wedged
                // or disconnected loop is always exitable (the daemon owns the loop;
                // quitting the client just drops the connection — resumable).
                const PASS = new Set(["stop", "help", "", "accept", "reject", "cancel", "edit", "quit"]);
                if (inFlight && !PASS.has(verb)) {
                    printAbove("  \x1b[2m(busy; /stop to cancel, /quit to exit, /help for the language)\x1b[0m");
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
                void transport.inject(inject)
                    .then(() => printAbove("  \x1b[2m↳ added to the run\x1b[0m"))
                    .catch((cause) => printAbove(`  \x1b[31minject failed: ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m`));
                reprompt();
                return;
            }

            inFlight = true;
            hibernating = false;   // fresh loop — the ⏳ busy glyph lights the whole run
            // Keep a live steer prompt for the duration of the loop — a stable row
            // to type an inject into (traces print above it); the gutter's ⏳ shows
            // the loop is active (#114). Still editable.
            reprompt();
            const start = Date.now();
            let turnCount = 0;
            let finalStatus = 0;
            let hitMaxTurns = false;
            let usage: LoopUsage | undefined;

            try {
                const lookText = trimmed.startsWith("<<") ? lookRewrite(trimmed) : null;
                if (lookText !== null) {
                    // <<LOOK: off-run READ on the side connection — for me, not the model.
                    finalStatus = await runLook(lookText);
                } else if (trimmed.startsWith("<<")) {
                    // Raw DSL: send to op.parse
                    const result = await transport.rpc("op.parse", { text: trimmed }) as { results: Array<{ status: number }> };
                    finalStatus = result.results[result.results.length - 1]?.status ?? 0;
                } else if (trimmed.startsWith("!")) {
                    // `! cmd` — exec via the daemon (proposal-gated like any
                    // side effect; output streams as stream/event traces).
                    const command = trimmed.replace(/^!+\s*/, "");
                    const result = await transport.rpc("op.exec", { command }) as { status: number };
                    finalStatus = result.status;
                } else {
                    // Prompt. `? ` = ask (read-only loop, flags.mode="ask");
                    // `: ` = act. Per-line prefix overrides --flags mode.
                    const { flags: lineFlags, prompt: promptText } = lineMode(trimmed, opts.loopFlags);
                    const loopParams: { prompt: string; alias?: string; model?: string; flags?: Record<string, unknown>; maxTurns?: number; openPaths?: string[] } = { prompt: promptText };
                    if (opts.modelAlias !== undefined) loopParams.alias = opts.modelAlias;   // display label
                    if (opts.model !== undefined) loopParams.model = opts.model;             // #90 client-resolved routing (precedence)
                    if (lineFlags !== undefined && Object.keys(lineFlags).length > 0) loopParams.flags = lineFlags;
                    if (opts.maxTurns !== undefined) loopParams.maxTurns = opts.maxTurns;
                    const openPaths = extractOpenPaths(promptText);   // @file refs → daemon turn-0 READs (#260)
                    if (openPaths.length > 0) loopParams.openPaths = openPaths;
                    // The transport owns the ack→terminated bridge; done resolves
                    // with the loop's outcome. A synchronous ACK failure surfaces as
                    // RunAckError (caught below; 501 gets the .env pointer, #120).
                    const t = await transport.run(promptText, loopParams).done;
                    finalStatus = t.finalStatus;
                    hitMaxTurns = t.hitMaxTurns;
                    turnCount = t.turnIds?.length ?? 0;
                    usage = t.usage;
                }
                const wallMs = Date.now() - start;
                printAbove(renderSummary(turnCount, wallMs, finalStatus, hitMaxTurns, usage, usage?.contextSize));
            } catch (cause) {
                const msg = cause instanceof RunAckError && cause.status === 501
                    ? cause.message + NO_MODEL_HINT
                    : cause instanceof Error ? cause.message : String(cause);
                printAbove(`  \x1b[31merror: ${msg}\x1b[0m`);
            } finally {
                inFlight = false;
                cancelRequested = false;
                pendingQuestion = null;   // loop ended (incl. cancel) → drop any unanswered question
                reprompt();   // loop over → the busy glyph clears from the gutter
            }
        });

        rl.on("close", () => {
            shuttingDown = true;   // intentional teardown — the rpc.close that follows isn't a "lost connection"
            transport.shutdown();  // suppress the transport's connection-lost reject on an intentional quit
            process.stdout.write("\x1b[?2004l");
            process.stdin.off("data", onStdin);
            process.stdin.setRawMode?.(false);
            // Steal pi's nicety: hand back the one-liner to pick this session up.
            process.stdout.write(`\n  \x1b[2mresume this session:  plurnk --session ${current.name}\x1b[0m\n`);
            resolve();
        });

        rl.on("SIGINT", () => {
            // First Ctrl-C with a dispatch in flight: cancel the run's active
            // drain via the loop.cancel action; the pending loop resolves with
            // finalStatus 499 and the REPL continues. Second Ctrl-C (or idle
            // Ctrl-C) exits — escape hatch for dispatches a drain-cancel can't
            // unblock (op.parse). A failed cancel SURFACES — a stop button that
            // silently does nothing is the worst kind of broken.
            if (inFlight && !cancelRequested) {
                cancelRequested = true;
                process.stdout.write("\r\x1b[2K  \x1b[2mcancelling… (ctrl-c again to quit)\x1b[0m\n");
                void transport.rpc("loop.cancel", { reason: "user_sigint" }).catch((err: unknown) => {
                    process.stdout.write(`\r\x1b[2K  \x1b[31mcancel failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
                });
                return;
            }
            rl.close();
        });
    });
};
