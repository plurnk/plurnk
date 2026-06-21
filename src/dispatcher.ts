// plurnk client entrypoint. Dispatches argv to CLI mode (positional args or
// piped stdin) or TUI REPL mode (no positionals, TTY stdin). Per SPEC.md
// §2 (CLI mode) and §3 (TUI mode).

import { parseArgs } from "node:util";
import { readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import Rpc, { RpcError } from "./rpc.ts";
import { runCli, buildJsonError } from "./cli.ts";
import { runTui } from "./tui.ts";
import { runModels, runSessionList, runSessionRuns, runSessionRename, runLogRead, runRead } from "./subcommands.ts";
import type { LogReadFilters } from "./subcommands.ts";
import {
    TelemetryError,
    report,
    clientConnectionRefused,
    clientDaemonStale,
    clientFlagInvalid,
    clientFlagMissingDependency,
    clientRpcError,
    clientRuntimeError,
    clientSubcommandMissingArgument,
    clientSubcommandSessionNotFound,
    clientSubcommandSessionAmbiguous,
    clientSubcommandUnknownVerb,
} from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";

// Read all of stdin to EOF. Called when stdin is piped (not a TTY) — never
// blocks an interactive session because we gate on isTTY upstream.
const readStdin = async (): Promise<string> => {
    let buf = "";
    for await (const chunk of process.stdin) buf += chunk;
    return buf;
};

// LoopFlags resolution: --flags takes raw JSON (the generic passthrough —
// any flag the daemon wires lands without a client release). Mode is NOT a
// flag here: ask/act ride the prompt-prefix habit (`? text` / `: text`),
// converged across nvim, TUI, and the one-shot CLI.
export const resolveLoopFlags = (rawJson: string | undefined): Record<string, unknown> | undefined => {
    if (rawJson === undefined) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(rawJson); } catch {
        throw new TelemetryError(clientFlagInvalid("--flags", rawJson, "must be valid JSON"));
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TelemetryError(clientFlagInvalid("--flags", rawJson, "must be a JSON object"));
    }
    return parsed as Record<string, unknown>;
};

// projectRoot resolution: empty string = explicit headless (null on wire);
// otherwise must be an absolute path. Caller passes cwd as default.
export const resolveProjectRoot = (raw: string | undefined): string | null => {
    if (raw === undefined) return process.cwd();
    if (raw.length === 0) return null;
    if (!isAbsolute(raw)) throw new TelemetryError(clientFlagInvalid("--project-root", raw, "must be an absolute path"));
    return raw;
};

const USAGE = `usage: plurnk [--json] [--session <name>] [--run <name>] [--model <alias>] [prompt...]
       <piped stdin> | plurnk [options] [prompt...]
       plurnk models [--json]
       plurnk session list [--json]
       plurnk session runs <name> [--json]
       plurnk session rename <name> <newname> [--json]
       plurnk log read --session <name> [--run <name>]
                       [--loop <id>] [--turn <id>] [--since <id>] [--limit <n>] [--json]
       plurnk read <loop>/<turn>/<seq> --session <name> [--run <name>] [--json]

Connects to the plurnk-service daemon. Run a single prompt one-shot
(positional args, piped stdin, or both — positionals come first, stdin
is appended after a blank line). With no positionals and a TTY stdin,
enters the interactive REPL. Read-only subcommands (models / session list /
log read / read <coord>) inspect daemon state without running a loop.

env (shared ~/.plurnk cascade: ~/.plurnk/.env.example < ~/.plurnk/.env < ./.env
     < --env-file < shell — same layering as plurnk-service):
  PLURNK_WS             daemon WebSocket URL (default ws://127.0.0.1:3044) — the
                        ONE knob the client needs; everything else in ~/.plurnk
                        is the daemon's. Works with no config at all.
  PLURNK_SESSION        resume an existing session by name
  PLURNK_RUN            resume (or create) a named run within that session
  PLURNK_MODEL          model alias to use for every loop.run on this invocation.
                        Shared with the daemon (user-level preference). --model
                        overrides for this invocation only.
  PLURNK_PROJECT_ROOT   absolute path passed to session.create as the session's
                        project_root (workspace for file ops). Default: cwd.
                        Empty string = headless (no project_root, file ops 400).
  PLURNK_YOLO           when truthy, auto-accept every proposal without prompting.
                        Client-side only — proposals still go through the wire.
  PLURNK_JSON           when truthy, same as --json for one-shot runs.

options:
  -h, --help              print this message and exit
      --json              json OUTPUT MODE: one complete structured document on
                          stdout (the whole client-observed record — turns/ops,
                          telemetry, the answer at .response, usage), stderr
                          silent, errors emitted as {"error":…}. Drill into one
                          op's content with: plurnk read <coord> --json. CLI only.
      --session <name>    resume the named session; without it, a fresh session
                          is created. Overrides PLURNK_SESSION.
      --run <name>        resume (or create) the named run within the session.
                          Requires --session. Overrides PLURNK_RUN.
      --model <alias>     model alias to pass on every loop.run. Resolved
                          server-side against PLURNK_MODEL_<alias>. Without
                          this (and PLURNK_MODEL unset), the daemon uses its
                          own boot-time PLURNK_MODEL.
      --project-root <p>  absolute path. Sent on session.create only; ignored
                          on --session attach (daemon preserves stored value).
                          Default: cwd. Empty string = headless. Overrides
                          PLURNK_PROJECT_ROOT.
      --yolo              auto-accept every proposal locally without prompting.
                          Overrides PLURNK_YOLO.
      --flags <json>      raw LoopFlags JSON passthrough on every loop.run
                          (e.g. '{"yolo":true}' for server-side YOLO in
                          benchmark/automation runs).
      --env-file <p>      load env from <p> (errors if missing). Repeatable.
      --env-file-if-exists <p>  same, but silently skip a missing file. Repeatable.
      --max-turns <n>     per-loop turn cap (daemon default PLURNK_MAX_TURNS).
      --timeout <s>       CLI mode: cancel the loop (loop.cancel) after <s>
                          seconds; exits 3 with "timedOut":true in the result.
      --pick <glob>       membership: track file(s) in manifest (the sole
                          source when headless). Repeatable.
      --hide <glob>       membership: block file(s) from manifest. Repeatable.
      --view <glob>       membership: track file(s) in manifest (read-only). Repeatable.
      --repo <glob>       membership: track a git repo folder (its ls-files join
                          the manifest), relative to project root. Repeatable.
      --manifest-items <n>  session-open preview: -1 full / 0 off / N first-N
                          items of plurnk://manifest.json at turn 0. Create-time.
      --md <name=path>    pin a markdown doc into the session (read at turn 0);
                          merges with operator PLURNK_MD_*. Repeatable. Create-time.
      --max-commands <n>  ceiling on ops per emission for the session (min with the
                          daemon's PLURNK_MAX_COMMANDS — can only tighten). Create-time.
      --no-git            deny git membership + telemetry for the session (never
                          re-enables past the operator lockout). Create-time.
      --no-agents         opt out of AGENTS.md auto-load (default: a local AGENTS.md
                          is picked + read into the first model turn). Create-time.
      --loop <id>         (log read) filter to a single loop id
      --turn <id>         (log read) filter to a single turn id
      --since <id>        (log read) return entries with id > <id>
      --limit <n>         (log read) max entries to return (default 100)

subcommands:
  models                  list configured model aliases (providers.list)
  session list            list sessions on the daemon (session.list)
  session runs <name>     list runs in the named session (session.runs)
  session rename <a> <b>  rename session <a> to <b> (session.rename — a session's
                          name is a mutable handle; runs are immutable)
  log read --session ...  read log entries from the named session's run
`;

// Render a telemetry event to stderr and exit. Single egress point so every
// fatal client signal uses the unified shape from telemetry.ts.
const dieWith = (code: number, event: TelemetryEvent): never => {
    report(event);
    process.exit(code);
};

// json-mode failure: a valid JSON error document on stdout (the consumer's
// parser never chokes), paired with a non-zero exit. The json counterpart of
// dieWith — text mode narrates errors to stderr, json mode emits structured.
const dieJson = (code: number, kind: string, message: string, extra?: Record<string, unknown>): never => {
    process.stdout.write(`${JSON.stringify(buildJsonError(kind, message, extra))}\n`);
    process.exit(code);
};

// Env cascade, aligned with plurnk-service's ~/.plurnk layering so the two share
// one config home. process.loadEnvFile only fills UNSET vars, so loading
// highest-precedence-first yields:
//   shell > --env-file > --env-file-if-exists > ./.env > ~/.plurnk/.env > ~/.plurnk/.env.example
// The client reads exactly ONE knob from this shared file — PLURNK_WS (which
// daemon to reach) — and defaults it sanely when nothing is set. Everything else
// in ~/.plurnk is the daemon's; the client doesn't ship its own .env.example.
const loadEnvCascade = (envFiles: string[], envFilesIfExists: string[]): void => {
    const ifExists = (p: string): void => { try { process.loadEnvFile(p); } catch { /* optional layer */ } };
    for (const f of envFiles) {
        try { process.loadEnvFile(f); }
        catch { dieWith(64, clientFlagInvalid("--env-file", f, "file not found")); }
    }
    for (const f of envFilesIfExists) ifExists(f);
    ifExists(".env");
    const home = join(homedir(), ".plurnk");
    ifExists(join(home, ".env"));
    ifExists(join(home, ".env.example"));
};

interface SessionResult { id: number; name: string }

// Resolve the session by name (via session.list filter) or create a fresh one.
// Names are the user-facing handle — ids are internals, not exposed via flags.
// projectRoot is sent on creation only; attach inherits the daemon-stored value.
// A membership-overlay constraint (svc#200), service vocabulary: `pick` admits
// a file git misses (the sole source when headless), `hide` drops a tracked
// match, `view` admits a member read-only.
export interface Constraint { effect: "pick" | "hide" | "view" | "repo"; glob: string }

// Map the repeatable membership flags (--pick/--hide/--view/--repo) to
// constraints. repo (svc#242) declares a git repo folder (its ls-files join
// membership), addressed relative to the project root.
export const buildConstraints = (values: {
    pick?: string[]; hide?: string[]; view?: string[]; repo?: string[];
}): Constraint[] => [
    ...(values.pick ?? []).map((glob): Constraint => ({ effect: "pick", glob })),
    ...(values.hide ?? []).map((glob): Constraint => ({ effect: "hide", glob })),
    ...(values.view ?? []).map((glob): Constraint => ({ effect: "view", glob })),
    ...(values.repo ?? []).map((glob): Constraint => ({ effect: "repo", glob })),
];

// Session-open settings. Open-context (svc#231): manifestItems REPLACES
// PLURNK_MANIFEST_ITEMS; mdDocs UNIONS with the operator's PLURNK_MD_* (client
// wins a collision; content read from the LOCAL fs — co-location law). Ceilings
// (svc#232, most-restrictive-wins): maxCommands min()s PLURNK_MAX_COMMANDS;
// git:false ANDs PLURNK_GIT_ALLOWED (deny-only, never re-enables).
export interface Settings {
    manifestItems?: number;
    mdDocs?: Array<{ alias: string; content: string }>;
    maxCommands?: number;
    git?: boolean;
    autoReadAgents?: boolean;
}

// #250 — auto-load the project's AGENTS.md scratchpad into the first model turn.
// Default ON when a local AGENTS.md exists (co-location: the client shares the
// daemon's fs, so it just checks); --no-agents opts out. Activating takes BOTH
// halves: PICK AGENTS.md into membership (it's gitignored by convention → not a
// git member) AND settings.autoReadAgents so the engine READs it at turn-0. The
// setting has no live setter (svc#231), so this is CREATE-only — callers skip it
// on --session attach. Returns null when off or no local AGENTS.md exists.
export const agentsAutoload = async (
    optOut: boolean,
    cwd: string,
): Promise<{ pick: Constraint; autoReadAgents: true } | null> => {
    if (optOut) return null;
    try { await access(resolve(cwd, "AGENTS.md"), fsConstants.R_OK); }
    catch { return null; }
    return { pick: { effect: "pick", glob: "AGENTS.md" }, autoReadAgents: true };
};

export const buildSettings = async (
    values: { "manifest-items"?: string; md?: string[]; "max-commands"?: string; "no-git"?: boolean },
    cwd: string,
): Promise<Settings> => {
    const settings: Settings = {};
    const mc = values["max-commands"];
    if (mc !== undefined) {
        const n = Number(mc);
        if (!Number.isInteger(n) || n < 1) {
            throw new TelemetryError(clientFlagInvalid("--max-commands", mc, "must be a positive integer"));
        }
        settings.maxCommands = n;
    }
    if (values["no-git"] === true) settings.git = false;
    const mi = values["manifest-items"];
    if (mi !== undefined) {
        const n = Number(mi);
        if (!Number.isInteger(n) || n < -1) {
            throw new TelemetryError(clientFlagInvalid("--manifest-items", mi, "must be -1 (full), 0 (off), or a positive integer"));
        }
        settings.manifestItems = n;
    }
    const mdSpecs = values.md ?? [];
    if (mdSpecs.length > 0) {
        const mdDocs: Array<{ alias: string; content: string }> = [];
        for (const spec of mdSpecs) {
            const eq = spec.indexOf("=");
            if (eq <= 0) throw new TelemetryError(clientFlagInvalid("--md", spec, "must be NAME=path"));
            const alias = spec.slice(0, eq);
            const raw = spec.slice(eq + 1);
            const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
            try {
                mdDocs.push({ alias, content: await readFile(abs, "utf8") });
            } catch (cause) {
                throw new TelemetryError(clientFlagInvalid("--md", spec, `file not readable: ${cause instanceof Error ? cause.message : String(cause)}`));
            }
        }
        settings.mdDocs = mdDocs;
    }
    return settings;
};

// svc#235: discover.versions { service:{installed, latest?}, client:{latest?} }.
// The daemon polls npm; the client compares its OWN installed version against
// the advertised latest and renders both lines + an "(update available)"
// marker. The client never does registry IO — it just reads what discover says.
export const CLIENT_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

interface DiscoverVersions { service?: { installed?: string; latest?: string }; client?: { latest?: string } }

const isOlder = (a: string, b: string): boolean => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const x = pa[i] ?? 0, y = pb[i] ?? 0;
        if (x < y) return true;
        if (x > y) return false;
    }
    return false;
};

export const buildVersionNotice = (versions: DiscoverVersions | undefined, clientInstalled: string): string | undefined => {
    if (versions === undefined) return undefined;
    const svc = versions.service?.installed;
    const parts = [`plurnk client v${clientInstalled}`];
    if (svc !== undefined) parts.push(`plurnk-service v${svc}`);
    const stale = (versions.client?.latest !== undefined && isOlder(clientInstalled, versions.client.latest))
        || (svc !== undefined && versions.service?.latest !== undefined && isOlder(svc, versions.service.latest));
    return parts.join(", ") + (stale ? " (update available)" : "");
};

const attachOrCreateSession = async (
    rpc: Rpc,
    opts: { sessionName?: string; runName?: string; projectRoot: string | null; constraints?: Constraint[]; settings?: Settings },
): Promise<SessionResult> => {
    const constraints = opts.constraints ?? [];
    const settings = opts.settings ?? {};
    if (opts.sessionName === undefined) {
        // Seed overlay + open-context settings atomically at creation so turn-1's
        // manifest/preview/docs are right with no follow-up RPC.
        const params: { projectRoot: string | null; constraints?: Constraint[]; settings?: Settings } = { projectRoot: opts.projectRoot };
        if (constraints.length > 0) params.constraints = constraints;
        if (Object.keys(settings).length > 0) params.settings = settings;
        return await rpc.call("session.create", params) as SessionResult;
    }
    const { sessions } = await rpc.call("session.list") as { sessions: SessionResult[] };
    const matches = sessions.filter((s) => s.name === opts.sessionName);
    if (matches.length === 0) {
        const ev = clientSubcommandSessionNotFound(opts.sessionName);
        ev.hints = ["run without --session to create a fresh session"];
        throw new TelemetryError(ev);
    }
    if (matches.length > 1) {
        throw new TelemetryError(clientSubcommandSessionAmbiguous(opts.sessionName, matches.length));
    }
    const attachParams: { id: number; runName?: string } = { id: matches[0].id };
    if (opts.runName !== undefined) attachParams.runName = opts.runName;
    const session = await rpc.call("session.attach", attachParams) as SessionResult;
    // An existing session takes the overlay flags live (session.create only
    // seeds at birth). Settings (--manifest-items/--md) are session-create-only
    // per svc#231 — there's no live setter, so flag-and-skip on attach.
    for (const c of constraints) await rpc.call("session.constrain", c);
    if (Object.keys(settings).length > 0) {
        process.stderr.write("  \x1b[2m--manifest-items/--md apply at session creation only; ignored on --session attach\x1b[0m\n");
    }
    return session;
};

// Read-only subcommands (read / log read) inspect the CONVERSATION, which lives
// in the session's model run — but a bare attach binds a fresh CLIENT run
// (run-split). When the user didn't pin --run, re-attach the most-recent
// origin="model" run so `read <coord> --session X` targets the conversation
// instead of an empty client run. No model run yet (fresh session) → no-op.
const attachConversationRun = async (rpc: Rpc, sessionId: number): Promise<void> => {
    const { runs } = await rpc.call("session.runs", { id: sessionId }) as {
        runs: Array<{ id: number; origin: string }>;
    };
    const model = runs.find((r) => r.origin === "model");   // session.runs is newest-first
    if (model !== undefined) await rpc.call("session.attach", { id: sessionId, runId: model.id });
};

// Parse a string-valued integer flag, throwing if non-numeric. Used for
// log.read filter flags (--loop / --turn / --since / --limit) since
// parseArgs stores their raw string values regardless of intent.
const parseIntFlag = (raw: string | undefined, name: string): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new TelemetryError(clientFlagInvalid(name, raw, "must be a non-negative integer"));
    return n;
};

interface SubcommandOpts {
    json: boolean;
    sessionName?: string;
    runName?: string;
    projectRoot: string | null;
    values: Record<string, string | boolean | string[] | undefined>;
}

// Dispatch a positional-driven subcommand. Caller has already connected the
// Rpc. Returns the exit code the dispatcher should propagate.
const runSubcommand = async (rpc: Rpc, positionals: string[], opts: SubcommandOpts): Promise<number> => {
    const verb = positionals[0];
    const sub = positionals[1];

    if (verb === "models") {
        if (positionals.length > 1) {
            throw new TelemetryError(clientSubcommandUnknownVerb(`models ${positionals.slice(1).join(" ")}`));
        }
        return await runModels(rpc, { json: opts.json });
    }

    if (verb === "session") {
        if (sub === "list") {
            if (positionals.length > 2) {
                throw new TelemetryError(clientSubcommandUnknownVerb(`session list ${positionals.slice(2).join(" ")}`));
            }
            return await runSessionList(rpc, { json: opts.json });
        }
        if (sub === "runs") {
            const name = positionals[2];
            if (name === undefined) {
                throw new TelemetryError(clientSubcommandMissingArgument("plurnk session runs", "<name>"));
            }
            if (positionals.length > 3) {
                throw new TelemetryError(clientSubcommandUnknownVerb(`session runs ${positionals.slice(3).join(" ")}`));
            }
            return await runSessionRuns(rpc, name, { json: opts.json });
        }
        if (sub === "rename") {
            const name = positionals[2];
            const newName = positionals[3];
            if (name === undefined || newName === undefined) {
                throw new TelemetryError(clientSubcommandMissingArgument("plurnk session rename", "<name> <newname>"));
            }
            if (positionals.length > 4) {
                throw new TelemetryError(clientSubcommandUnknownVerb(`session rename ${positionals.slice(4).join(" ")}`));
            }
            return await runSessionRename(rpc, name, newName, { json: opts.json });
        }
        throw new TelemetryError(clientSubcommandUnknownVerb(`session ${sub ?? "(missing)"}`, ["list", "runs", "rename"]));
    }

    if (verb === "log") {
        if (sub !== "read") {
            throw new TelemetryError(clientSubcommandUnknownVerb(`log ${sub ?? "(missing)"}`, ["read"]));
        }
        if (opts.sessionName === undefined) {
            throw new TelemetryError(clientFlagMissingDependency("plurnk log read", "--session (or PLURNK_SESSION)"));
        }
        // log.read requires an attached session — same resolution as the loop flows.
        const attached = await attachOrCreateSession(rpc, {
            sessionName: opts.sessionName,
            runName: opts.runName,
            projectRoot: opts.projectRoot,
        });
        // Default to the conversation (model run) unless --run pins one.
        if (opts.runName === undefined) await attachConversationRun(rpc, attached.id);
        const filters: LogReadFilters = {};
        const loopId = parseIntFlag(opts.values.loop as string | undefined, "--loop");
        const turnId = parseIntFlag(opts.values.turn as string | undefined, "--turn");
        const sinceId = parseIntFlag(opts.values.since as string | undefined, "--since");
        const limit = parseIntFlag(opts.values.limit as string | undefined, "--limit");
        if (loopId !== undefined) filters.loopId = loopId;
        if (turnId !== undefined) filters.turnId = turnId;
        if (sinceId !== undefined) filters.sinceId = sinceId;
        if (limit !== undefined) filters.limit = limit;
        return await runLogRead(rpc, { json: opts.json, filters });
    }

    if (verb === "read") {
        const coord = positionals[1];
        if (coord === undefined) {
            throw new TelemetryError(clientSubcommandMissingArgument("plurnk read", "<loop>/<turn>/<seq>"));
        }
        if (positionals.length > 2) {
            throw new TelemetryError(clientSubcommandUnknownVerb(`read ${positionals.slice(2).join(" ")}`));
        }
        if (opts.sessionName === undefined) {
            throw new TelemetryError(clientFlagMissingDependency("plurnk read", "--session (or PLURNK_SESSION)"));
        }
        // The coordinate is run-relative — attach the same way log read does,
        // defaulting to the conversation (model run) unless --run pins one.
        const attached = await attachOrCreateSession(rpc, {
            sessionName: opts.sessionName,
            runName: opts.runName,
            projectRoot: opts.projectRoot,
        });
        if (opts.runName === undefined) await attachConversationRun(rpc, attached.id);
        return await runRead(rpc, coord, { json: opts.json });
    }

    throw new TelemetryError(clientSubcommandUnknownVerb(verb ?? "(missing)"));
};

export const main = async (argv: string[]): Promise<void> => {
    const { positionals, values } = parseArgs({
        args: argv.slice(2),
        allowPositionals: true,
        options: {
            help: { type: "boolean", short: "h" },
            json: { type: "boolean" },
            // Node-native env layering (mirrors plurnk-service): --env-file
            // requires the file, --env-file-if-exists skips a missing one.
            "env-file": { type: "string", multiple: true },
            "env-file-if-exists": { type: "string", multiple: true },
            session: { type: "string" },
            run: { type: "string" },
            model: { type: "string" },
            "project-root": { type: "string" },
            yolo: { type: "boolean" },
            flags: { type: "string" },
            "max-turns": { type: "string" },
            timeout: { type: "string" },
            // membership overlay (svc#200/#242) — repeatable globs; service vocabulary
            pick: { type: "string", multiple: true },
            hide: { type: "string", multiple: true },
            view: { type: "string", multiple: true },
            repo: { type: "string", multiple: true },
            // session-open settings (svc#231) + tighten-only ceilings (svc#232)
            "manifest-items": { type: "string" },
            md: { type: "string", multiple: true },
            "max-commands": { type: "string" },
            "no-git": { type: "boolean" },
            "no-agents": { type: "boolean" },   // #250 — opt out of AGENTS.md auto-load
            // log read filters
            loop: { type: "string" },
            turn: { type: "string" },
            since: { type: "string" },
            limit: { type: "string" },
        },
    });

    if (values.help) { process.stdout.write(USAGE); process.exit(0); }

    // Shared ~/.plurnk env cascade (after parse so --env-file flags participate).
    loadEnvCascade((values["env-file"] as string[] | undefined) ?? [], (values["env-file-if-exists"] as string[] | undefined) ?? []);

    // json OUTPUT MODE — flag or env (user-level, same name client+daemon would
    // read). One complete document on stdout, stderr silent, structured errors.
    const json = values.json === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_JSON ?? "").toLowerCase());

    // Subcommand routing happens BEFORE prompt assembly: if positionals[0] is
    // a known read-only subcommand (models / session / log), we skip stdin
    // reading and prompt construction entirely.
    const SUBCOMMANDS = ["models", "session", "log", "read"] as const;
    const subcommand = positionals[0];
    const isSubcommand = subcommand !== undefined && (SUBCOMMANDS as readonly string[]).includes(subcommand);

    // Assemble the prompt only if we're NOT running a subcommand.
    let prompt = "";
    if (!isSubcommand) {
        const positionalPrompt = positionals.join(" ");
        const stdinPrompt = process.stdin.isTTY === true ? "" : (await readStdin()).trim();
        prompt = positionalPrompt.length > 0 && stdinPrompt.length > 0
            ? `${positionalPrompt}\n\n${stdinPrompt}`
            : positionalPrompt || stdinPrompt;
        if (json && prompt.length === 0) {
            if (values.json === true) dieJson(64, "usage", "--json needs a prompt (CLI mode only)", { flag: "--json" });
            // PLURNK_JSON with no prompt is the interactive TUI — env shouldn't force CLI mode.
        }
    }

    // CLI flag overrides env; env overrides nothing.
    const sessionName = values.session ?? process.env.PLURNK_SESSION;
    const runName = values.run ?? process.env.PLURNK_RUN;
    const modelAlias = values.model ?? process.env.PLURNK_MODEL;
    const yolo = values.yolo === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_YOLO ?? "").toLowerCase());
    if (runName !== undefined && sessionName === undefined) {
        dieWith(64, clientFlagMissingDependency("--run (or PLURNK_RUN)", "--session (or PLURNK_SESSION)"));
    }

    // Loop knobs (benchmark surface): --flags JSON passthrough, --ask sugar,
    // --max-turns, --timeout. All validated up front, usage errors exit 64.
    let loopFlags: Record<string, unknown> | undefined;
    let maxTurns: number | undefined;
    let timeoutSec: number | undefined;
    try {
        loopFlags = resolveLoopFlags(values.flags);
        maxTurns = parseIntFlag(values["max-turns"], "--max-turns");
        timeoutSec = parseIntFlag(values.timeout, "--timeout");
    } catch (cause) {
        if (cause instanceof TelemetryError) dieWith(cause.exitCode, cause.event);
        dieWith(64, clientRuntimeError(cause));
    }

    const projectRootRaw = values["project-root"] ?? process.env.PLURNK_PROJECT_ROOT;
    const projectRoot: string | null = (() => {
        try { return resolveProjectRoot(projectRootRaw); }
        catch (cause) {
            if (cause instanceof TelemetryError) return dieWith(cause.exitCode, cause.event);
            return dieWith(64, clientRuntimeError(cause));
        }
    })();

    const url = process.env.PLURNK_WS ?? "ws://127.0.0.1:3044";
    const rpc = new Rpc({ url });

    try {
        await rpc.connect();
    } catch (cause) {
        if (json) dieJson(1, "connection_refused", cause instanceof Error ? cause.message : String(cause), { url });
        dieWith(1, clientConnectionRefused(url, cause));
    }

    // Daemon staleness check (clients track HEAD, service SPEC §13.9): probe
    // discover for wire markers this client depends on; warn bluntly when
    // missing. One local round-trip; never fatal.
    let versionNotice: string | undefined;
    try {
        const catalog = await rpc.call("discover") as { methods?: Record<string, unknown>; notifications?: Record<string, unknown>; versions?: DiscoverVersions };
        const missing: string[] = [];
        for (const m of ["loop.cancel", "op.exec"]) {
            if (catalog.methods?.[m] === undefined) missing.push(m);
        }
        if (catalog.notifications?.["stream/concluded"] === undefined) missing.push("stream/concluded");
        if (missing.length > 0) report(clientDaemonStale(missing));
        versionNotice = buildVersionNotice(catalog.versions, CLIENT_VERSION);  // svc#235
    } catch { /* discover failing will surface on the real call anyway */ }

    try {
        if (isSubcommand) {
            const exitCode = await runSubcommand(rpc, positionals, {
                json, sessionName, runName, projectRoot, values,
            });
            process.exit(exitCode);
        }

        const constraints = buildConstraints(values as { pick?: string[]; hide?: string[]; view?: string[]; repo?: string[] });
        const settings = await buildSettings(values as { "manifest-items"?: string; md?: string[]; "max-commands"?: string; "no-git"?: boolean }, process.cwd());
        // #250 — AGENTS.md auto-load, CREATE-only (the setting can't be set on
        // attach). Compute once: cwd doesn't move for the process, so the same
        // decision applies to a /session-created session mid-TUI.
        const autoAgents = await agentsAutoload(values["no-agents"] === true, process.cwd());
        if (autoAgents !== null && sessionName === undefined) {
            constraints.push(autoAgents.pick);
            settings.autoReadAgents = autoAgents.autoReadAgents;
        }
        const session = await attachOrCreateSession(rpc, { sessionName, runName, projectRoot, constraints, settings });
        if (prompt.length === 0) {
            await runTui(rpc, session, { modelAlias, yolo, loopFlags, maxTurns, projectRoot, versionNotice, autoReadAgents: autoAgents !== null });
            process.exit(0);
        }
        // CLI: the version notice is narration → stderr (never pollutes stdout/--json).
        if (versionNotice !== undefined && json === false) process.stderr.write(`\x1b[2m${versionNotice}\x1b[0m\n`);
        const exitCode = await runCli(rpc, prompt, session, { json, modelAlias, yolo, loopFlags, maxTurns, timeoutSec });
        process.exit(exitCode);
    } catch (cause) {
        // json mode: a structured error document on stdout (valid JSON even on
        // failure), paired with the right exit code. Text mode narrates to stderr.
        if (json) {
            const kind = cause instanceof RpcError ? "rpc_error"
                : cause instanceof TelemetryError ? cause.event.kind : "runtime_error";
            const extra = cause instanceof RpcError ? { method: cause.method } : undefined;
            const code = cause instanceof TelemetryError ? cause.exitCode : 1;
            await rpc.close();
            dieJson(code, kind, cause instanceof Error ? cause.message : String(cause), extra);
        }
        if (cause instanceof TelemetryError) {
            report(cause.event);
            await rpc.close();
            process.exit(cause.exitCode);
        }
        // A daemon-rejected RPC arrives as a typed RpcError carrying the failed
        // method and the daemon's code/message — surface it as client:rpc:error.
        // Anything else is a genuine non-RPC throw: the generic runtime fallback.
        report(cause instanceof RpcError ? clientRpcError(cause.method, cause) : clientRuntimeError(cause));
        await rpc.close();
        process.exit(1);
    } finally {
        // Idempotent close — the catch paths already closed; this finally
        // covers the success paths where we returned via process.exit() but
        // the await on the runX call already completed.
        await rpc.close();
    }
};
