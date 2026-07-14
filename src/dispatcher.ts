// plurnk client entrypoint. Dispatches argv to CLI mode (positional args or
// piped stdin) or TUI REPL mode (no positionals, TTY stdin). Per SPEC.md
// §2 (CLI mode) and §3 (TUI mode).

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { parseAliasesFromEnv } from "@plurnk/plurnk-aliases";
import { buildJsonError } from "./cli.ts";
import { loadFloor } from "./envdefaults.ts";
import { runCliViaBridge, runScriptViaBridge } from "./agui_cli.ts";
import { BridgeTransport } from "./transport.ts";
import { actionViaBridge, resolveWorld } from "./agui.ts";
import { runTui } from "./tui.ts";
import { runModels, runSessionList, runSessionRuns, runSessionRename, runLogRead, runRead } from "./subcommands.ts";
import type { LogReadFilters, Caller } from "./subcommands.ts";
import {
    TelemetryError,
    report,
    clientConnectionRefused,
    clientDaemonStale,
    clientFlagInvalid,
    clientFlagMissingDependency,
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

// #90 — resolve a model alias to a concrete "<provider>/<model>" from the CLIENT's
// (always-fresh) env, so a long-lived daemon launched before the user set
// PLURNK_MODEL_<alias> doesn't reject loop.run with "unknown alias" (the daemon's
// launch env is frozen; ours isn't). First-slash split is lossless — provider is
// before the first "/", the model id is the rest (may itself contain "/"). baseUrl
// stays daemon-side. null → send bare {alias} and let the daemon resolve or fail.
// parseAliasesFromEnv is fail-hard on a duplicate/dangling env config — let it throw.
export const resolveModelSpec = (alias: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined => {
    if (alias === undefined) return undefined;
    const match = parseAliasesFromEnv(env).find((a) => a.alias === alias.toLowerCase());
    return match !== undefined ? `${match.provider}/${match.model}` : undefined;
};

// #132 — the client's per-session exec-policy layer: forward the PLURNK_EXECS_*
// enable/disable grammar (PLURNK_EXECS_ONLY, PLURNK_EXECS_<TAG>=0|false) so the
// daemon intersects it with its own ceiling (service ∧ client — subtractive,
// can never re-enable a service-disabled tag). Forwarded VERBATIM: the daemon's
// execs Policy is the single interpreter (pull-don't-copy). EXCLUDES
// PLURNK_EXECS_MCP_* — those are MCP SERVER configs (URLs, header bearer tokens),
// not policy, and must never ride the wire. The bare PLURNK_EXECS_MCP tag toggle
// (no trailing `_`) stays. Session-scoped: a per-session .env carries its own.
export const collectExecsPolicy = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) continue;
        if (!k.startsWith("PLURNK_EXECS_") || k.startsWith("PLURNK_EXECS_MCP_")) continue;
        out[k] = v;
    }
    return out;
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

env (cascade, highest first: shell < --env-file < ./.env < ~/.plurnk/.env
     < ~/.plurnk/.env.defaults < the client's packaged .env.defaults floor):
                        Works with no config at all.
  PLURNK_CLIENT_SESSION        resume/create a session by name. UNSET = the daemon
                        mints a fresh, uniquely-named session per invocation.
  PLURNK_CLIENT_RUN            resume (or create) a named run within that session
  PLURNK_MODEL          model alias to use for every loop.run on this invocation.
                        Shared with the daemon (user-level preference). --model
                        overrides for this invocation only.
  PLURNK_CLIENT_PROJECT_ROOT   absolute path passed to session.create as the session's
                        project_root (workspace for file ops). Default: cwd.
                        Empty string = headless (no project_root, file ops 400).
  PLURNK_CLIENT_YOLO           when truthy, auto-accept every proposal without prompting.
                        Client-side only — proposals still go through the wire.
  PLURNK_CLIENT_JSON           when truthy, same as --json for one-shot runs.
  PLURNK_QUESTIONS      when truthy, let the model ask you via SEND[300] (shared
                        intent — the daemon reads it too). --questions overrides.
  PLURNK_AGUI_URL       plurnk-agui bridge URL (e.g. http://127.0.0.1:8787). When
                        set, a one-shot (text AND --json) runs THROUGH the bridge
                        instead of raw daemon WS (the exclusive-portal path).
                        PLURNK_AGUI_TOKEN is the bearer if the bridge requires one.
                        Scripts + subcommands stay on the daemon.
  PLURNK_EXECS_*        per-session exec-runtime policy, sent to the daemon at
                        session.create (PLURNK_EXECS_ONLY=a,b allowlist;
                        PLURNK_EXECS_<tag>=0 kill one). Subtractive only — the
                        daemon intersects with its ceiling; the client can narrow,
                        never re-enable. Shares the daemon's grammar; a session's
                        .env carries its own. (MCP server configs are NOT sent.)

options:
  -h, --help              print this message and exit
      --json              json OUTPUT MODE: one complete structured document on
                          stdout (the whole client-observed record — turns/ops,
                          telemetry, the answer at .response, usage), stderr
                          silent, errors emitted as {"error":…}. Drill into one
                          op's content with: plurnk read <coord> --json. CLI only.
      --session <name>    resume the named session, or create it under that name
                          if none exists (attach-or-create). Without it, a fresh
                          auto-named session is created. Overrides PLURNK_CLIENT_SESSION.
      --run <name>        resume (or create) the named run within the session.
                          Requires --session. Overrides PLURNK_CLIENT_RUN.
      --model <alias>     model alias to pass on every loop.run. Resolved
                          server-side against PLURNK_MODEL_<alias>. Without
                          this (and PLURNK_MODEL unset), the daemon uses its
                          own boot-time PLURNK_MODEL.
      --project-root <p>  absolute path. Sent on session.create only; ignored
                          on --session attach (daemon preserves stored value).
                          Default: cwd. Empty string = headless. Overrides
                          PLURNK_CLIENT_PROJECT_ROOT.
      --yolo              auto-accept every proposal locally without prompting.
                          Overrides PLURNK_CLIENT_YOLO.
      --flags <json>      raw LoopFlags JSON passthrough on every loop.run
                          (e.g. '{"yolo":true}' for server-side YOLO in
                          benchmark/automation runs).
      --questions         let the model ask you (SEND[300]) when it needs a
                          decision — multiple choice with a free-response escape,
                          or an open question. Off by default. Overrides
                          PLURNK_QUESTIONS. (Requires a daemon that emits SEND[300].)
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
      --files-items <n>   session-open preview of the TRACKED-FILE list
                          (FIND(file:///**)): -1 full / 0 off / N first-N. Memory
                          (known/unknown/run/plurnk) always foists full. Create-time.
      --md <name=path>    pin a markdown doc into the session (read at turn 0);
                          merges with operator PLURNK_MD_*. Repeatable. Create-time.
      --max-commands <n>  ceiling on ops per emission for the session (min with the
                          daemon's PLURNK_MAX_COMMANDS — can only tighten). Create-time.
      --no-git            deny git membership + telemetry for the session (never
                          re-enables past the operator lockout). Create-time.
      --no-agents-md      turn off the service's AGENTS.md auto-load for this
                          session (overrides PLURNK_AGENTS_AUTO). Create-time.
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
  script <file.plk>       run a .plk file: feed its DSL to op.parse, render the
                          trace, exit by worst op status. Honors --session/--yolo
                          /--project-root + membership flags. The daemon owns the
                          grammar; the client just feeds the file.
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
//   shell > --env-file > --env-file-if-exists > ./.env > ~/.plurnk/.env
//   > ~/.plurnk/.env.defaults (the daemon family's rendered catalog)
//   > the client's OWN packaged .env.defaults (#141 — the self-serve floor:
//     the client is the one member the daemon cannot assemble).
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
    ifExists(join(home, ".env.defaults"));
    loadFloor();
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

// Session-open settings. Open-context (svc#231/#286): filesItems REPLACES
// PLURNK_FILES_ITEMS (renamed from manifestItems/PLURNK_MANIFEST_ITEMS — it only
// ever capped the tracked-file list, FIND(file:///**); memory always foists
// full); mdDocs UNIONS with the operator's PLURNK_MD_* (client wins a collision;
// content read from the LOCAL fs — co-location law). Ceilings (svc#232,
// most-restrictive-wins): maxCommands min()s PLURNK_MAX_COMMANDS; git:false ANDs
// PLURNK_GIT_ALLOWED (deny-only, never re-enables).
export interface Settings {
    filesItems?: number;
    mdDocs?: Array<{ alias: string; content: string }>;
    maxCommands?: number;
    git?: boolean;
    client?: string;          // #249 — frontend id, set on every session.create
    autoReadAgents?: boolean; // #268 — per-session override of the service AGENTS auto-load
    execs?: Record<string, string>; // #132 — per-session exec-policy layer (PLURNK_EXECS_* forwarded)
    questions?: boolean;      // svc#346 — enable model→user SEND[300] questions for the session (+ questions.md teaching)
}

export const buildSettings = async (
    values: { "files-items"?: string; md?: string[]; "max-commands"?: string; "no-git"?: boolean; "no-agents-md"?: boolean; questions?: boolean },
    cwd: string,
): Promise<Settings> => {
    const settings: Settings = {};
    // svc#346 — enable model→user SEND[300] questions (per-session; the daemon
    // injects questions.md teaching + intersects its PLURNK_QUESTIONS ceiling).
    // Flag or bare env (shared user intent). The daemon owns refusal when off.
    if (values.questions === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_QUESTIONS ?? "").toLowerCase())) settings.questions = true;
    const mc = values["max-commands"];
    if (mc !== undefined) {
        const n = Number(mc);
        if (!Number.isInteger(n) || n < 1) {
            throw new TelemetryError(clientFlagInvalid("--max-commands", mc, "must be a positive integer"));
        }
        settings.maxCommands = n;
    }
    if (values["no-git"] === true) settings.git = false;
    // #268 — pure passthrough of the per-session AGENTS auto-load override (the
    // service does the picking + reading; the client just forces it off here).
    if (values["no-agents-md"] === true) settings.autoReadAgents = false;
    const fi = values["files-items"];
    if (fi !== undefined) {
        const n = Number(fi);
        if (!Number.isInteger(n) || n < -1) {
            throw new TelemetryError(clientFlagInvalid("--files-items", fi, "must be -1 (full), 0 (off), or a positive integer"));
        }
        settings.filesItems = n;
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

// #249 — session-stable frontend id, passed on session.create and forwarded by
// the daemon to the plurnk provider as the Plurnk-Client header (dropped by
// every other provider). The 'plurnk.nvim/1.4.0' shape; nvim sends its own.
// #71 — one id per FRONTEND, name/version form, session-stable. CLI and TUI are
// distinct frontends of this package (nvim self-ids separately as plurnk.nvim);
// splitting them lets service telemetry attribute usage per surface.
export const CLIENT_ID_CLI = `@plurnk/plurnk-cli/${CLIENT_VERSION}`;
export const CLIENT_ID_TUI = `@plurnk/plurnk-tui/${CLIENT_VERSION}`;

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

// Resolve --run <name> to its id over the action surface (session.runs is scoped
// to the caller's thread/session). Undefined runName = the module's model-run default.
export const resolveRunId = async (rpc: Caller, runName: string | undefined): Promise<number | undefined> => {
    if (runName === undefined) return undefined;
    const { runs } = await rpc.call("session.runs") as { runs: Array<{ id: number; name: string }> };
    const hit = runs.find((r) => r.name === runName);
    if (hit === undefined) throw new Error(`--run ${runName}: no such run in the session`);
    return hit.id;
};

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

// Dispatch a positional-driven subcommand over the action surface. Returns the
// exit code the dispatcher should propagate.
const runSubcommand = async (rpc: Caller, positionals: string[], opts: SubcommandOpts): Promise<number> => {
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
            throw new TelemetryError(clientFlagMissingDependency("plurnk log read", "--session (or PLURNK_CLIENT_SESSION)"));
        }
        // The caller's threadId (--session) scopes the action to that session; the
        // module defaults reads to the conversation (model run); --run pins by name.
        const filters: LogReadFilters = { ...(await resolveRunId(rpc, opts.runName) !== undefined ? { runId: await resolveRunId(rpc, opts.runName) } : {}) };
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
            throw new TelemetryError(clientFlagMissingDependency("plurnk read", "--session (or PLURNK_CLIENT_SESSION)"));
        }
        // The coordinate is run-relative; the module defaults to the conversation
        // (model run) — --run pins by name via params, no connection state.
        return await runRead(rpc, coord, { json: opts.json, runId: await resolveRunId(rpc, opts.runName) });
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
            questions: { type: "boolean" },   // --questions: allow the model to ask via SEND[300]
            "max-turns": { type: "string" },
            timeout: { type: "string" },
            // membership overlay (svc#200/#242) — repeatable globs; service vocabulary
            pick: { type: "string", multiple: true },
            hide: { type: "string", multiple: true },
            view: { type: "string", multiple: true },
            repo: { type: "string", multiple: true },
            // session-open settings (svc#231) + tighten-only ceilings (svc#232)
            "files-items": { type: "string" },
            md: { type: "string", multiple: true },
            "max-commands": { type: "string" },
            "no-git": { type: "boolean" },
            "no-agents-md": { type: "boolean" },   // #268 — override: AGENTS auto-load off for this session
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
    const json = values.json === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_CLIENT_JSON ?? "").toLowerCase());

    // Subcommand routing happens BEFORE prompt assembly: if positionals[0] is
    // a known read-only subcommand (models / session / log), we skip stdin
    // reading and prompt construction entirely.
    const SUBCOMMANDS = ["models", "session", "log", "read", "script"] as const;
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
            // PLURNK_CLIENT_JSON with no prompt is the interactive TUI — env shouldn't force CLI mode.
        }
    }

    // CLI flag overrides env; env overrides nothing.
    const sessionName = values.session ?? process.env.PLURNK_CLIENT_SESSION;
    const runName = values.run ?? process.env.PLURNK_CLIENT_RUN;
    const modelAlias = values.model ?? process.env.PLURNK_MODEL;
    const yolo = values.yolo === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_CLIENT_YOLO ?? "").toLowerCase());
    if (runName !== undefined && sessionName === undefined) {
        dieWith(64, clientFlagMissingDependency("--run (or PLURNK_CLIENT_RUN)", "--session (or PLURNK_CLIENT_SESSION)"));
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

    // --questions / PLURNK_QUESTIONS is a SESSION setting (settings.questions in
    // buildSettings), NOT a loop flag — svc#346 ruled it session-scoped (it also
    // gates the questions.md teaching, so capability + teaching arrive together).

    const projectRootRaw = values["project-root"] ?? process.env.PLURNK_CLIENT_PROJECT_ROOT;
    const projectRoot: string | null = (() => {
        try { return resolveProjectRoot(projectRootRaw); }
        catch (cause) {
            if (cause instanceof TelemetryError) return dieWith(cause.exitCode, cause.event);
            return dieWith(64, clientRuntimeError(cause));
        }
    })();

    // plurnk-agui#1 — CLI one-shot through the exclusive-portal bridge: when
    // PLURNK_AGUI_URL is set, a prompt run rides the bridge (which owns the WS +
    // session) instead of raw daemon WS. Both text and --json route here now
    // (plurnk-agui 0.2.1's plurnk.terminated carries sessionId/loopId/turnIds/cost,
    // so the json record matches the WS schema). Scripts + subcommands stay on the
    // daemon. Dual-surface, per the charter.
    // AG-UI+ IS the client surface (service 0.81.0): PLURNK_HOST/PLURNK_PORT point at
    // the daemon's in-process module. PLURNK_AGUI_URL remains an explicit override
    // (a remote portal); otherwise the canonical legend is the default — the WS path
    // below is legacy awaiting deletion.
    const aguiOverride = process.env.PLURNK_AGUI_URL ?? "";
    const bridgeUrl = aguiOverride.length > 0 ? aguiOverride : `http://${process.env.PLURNK_HOST ?? "127.0.0.1"}:${process.env.PLURNK_PORT ?? "3044"}`;

    // THE WORLD (session) name. An explicit --session/PLURNK_CLIENT_SESSION names it;
    // otherwise the daemon mints a fresh, uniquely-named session (resolveWorld) —
    // never a literal "tui"/"cli". Resolved once, lazily, only when a conversation
    // needs a world. Minted WITH its options so creation is atomic with the root.
    let resolvedWorld: string | undefined;
    const world = async (): Promise<string> => {
        if (resolvedWorld !== undefined) return resolvedWorld;
        const constraints = buildConstraints(values as { pick?: string[]; hide?: string[]; view?: string[]; repo?: string[] });
        const settings = await buildSettings(values as { "files-items"?: string; md?: string[]; "max-commands"?: string; "no-git"?: boolean; "no-agents-md"?: boolean; questions?: boolean }, process.cwd());
        resolvedWorld = await resolveWorld({ bridgeUrl, token: process.env.PLURNK_AGUI_TOKEN }, sessionName, {
            ...(projectRoot !== null ? { projectRoot } : {}),
            ...(constraints.length > 0 ? { constraints } : {}),
            ...(Object.keys(settings).length > 0 ? { settings } : {}),
        });
        return resolvedWorld;
    };
    if (bridgeUrl !== undefined && bridgeUrl.length > 0 && !isSubcommand && subcommand !== "script" && prompt.length > 0) {
        try {
            // Thread-per-run (svc#366): --run names the CONVERSATION (the threadId);
            // the world is --session, else a fresh daemon-minted session. Without --run,
            // thread == world (the model run).
            const w = await world();
            const code = await runCliViaBridge({ bridgeUrl, token: process.env.PLURNK_AGUI_TOKEN }, prompt, { threadId: runName ?? w, session: w, ...(modelAlias !== undefined ? { alias: modelAlias } : {}), ...(resolveModelSpec(modelAlias) !== undefined ? { model: resolveModelSpec(modelAlias) } : {}), yolo, json, projectRoot });
            process.exit(code);
        } catch (cause) {
            // The bridge is reachable-but-erroring OR unreachable — surface the real
            // cause (runViaBridge already says "bridge run failed: NNN — …" / "fetch
            // failed"), NOT the daemon's "no daemon running" boilerplate. json mode
            // still emits ONE valid document on stdout.
            const detail = cause instanceof Error ? cause.message : String(cause);
            if (json) dieJson(1, "bridge_error", detail, { bridge: bridgeUrl });
            dieWith(1, clientRuntimeError(new Error(`plurnk-agui bridge (${bridgeUrl}) — ${detail}`)));
        }
    }

    // TUI through the bridge (no prompt): skip the WS connect + session.create — a
    // pure-bridge client has no direct daemon WS. The bridge owns the session; we
    // pass a threadId-named stub (the daemon session id is bridge-created). projectRoot
    // rides forwardedProps; PLURNK_AGUI_QUESTIONS gates questions bridge-side.
    // (Per-session constraints/settings over the bridge are a follow-up.)
    if (bridgeUrl !== undefined && bridgeUrl.length > 0 && !isSubcommand && subcommand !== "script" && prompt.length === 0) {
        const w = await world();
        const threadId = runName ?? w;
        // Session options ride the thread's first run (forwardedProps.plurnk): the
        // same constraints (--pick/hide/view/repo) + settings the WS path sends on
        // session.create, so a bridge TUI is configured identically. (When the world
        // was daemon-minted above, it was created WITH these already; a re-send on the
        // first run is idempotent — the session exists, options apply at creation only.)
        const transport = new BridgeTransport({ bridgeUrl, token: process.env.PLURNK_AGUI_TOKEN }, threadId, {
            session: w,
            projectRoot,
            constraints: buildConstraints(values as { pick?: string[]; hide?: string[]; view?: string[]; repo?: string[] }),
            settings: await buildSettings(values as { "files-items"?: string; md?: string[]; "max-commands"?: string; "no-git"?: boolean; "no-agents-md"?: boolean; questions?: boolean }, process.cwd()),
        });
        const autoReadAgents = values["no-agents-md"] === true ? false : undefined;
        await runTui(transport, { id: 0, name: threadId }, { modelAlias, model: resolveModelSpec(modelAlias), resolveModel: (a: string) => resolveModelSpec(a), yolo, loopFlags, maxTurns, projectRoot, client: CLIENT_ID_TUI, autoReadAgents });
        process.exit(0);
    }

    // AG-UI+ is the ONLY wire (the WS transport is deleted). Subcommands + script
    // speak the action surface through a structural Caller.
    const target = { bridgeUrl, token: process.env.PLURNK_AGUI_TOKEN };
    const callerThread = sessionName ?? "cli";
    const caller = { call: (method: string, params?: object) => actionViaBridge<unknown>(target, { threadId: callerThread, kind: method, params }) };

    try {
        // `plurnk script foo.plk` — feed a .plk file to op.parse over the action
        // surface. The client never parses the file; the module owns the grammar.
        if (subcommand === "script") {
            const filePath = positionals[1];
            if (filePath === undefined) {
                throw new TelemetryError(clientSubcommandMissingArgument("plurnk script", "<file.plk>"));
            }
            if (positionals.length > 2) {
                throw new TelemetryError(clientSubcommandUnknownVerb(`script ${positionals.slice(2).join(" ")}`));
            }
            const text = await readFile(resolve(filePath), "utf8");   // fail-hard on a missing file
            const exitCode = await runScriptViaBridge(target, text, { threadId: callerThread, yolo, json, projectRoot });
            process.exit(exitCode);
        }

        if (isSubcommand) {
            const exitCode = await runSubcommand(caller, positionals, {
                json, sessionName, runName, projectRoot, values,
            });
            process.exit(exitCode);
        }

        // Reaching here is a dispatcher bug: prompts + the TUI ride the bridge
        // branches above; script + subcommands returned above. Fail hard.
        throw new Error("dispatcher fell through every AG-UI+ path — unreachable");
    } catch (cause) {
        // json mode: a structured error document on stdout (valid JSON even on
        // failure), paired with the right exit code. Text mode narrates to stderr.
        if (json) {
            const kind = cause instanceof TelemetryError ? cause.event.kind : "runtime_error";
            const extra = undefined;
            const code = cause instanceof TelemetryError ? cause.exitCode : 1;
            dieJson(code, kind, cause instanceof Error ? cause.message : String(cause), extra);
        }
        if (cause instanceof TelemetryError) {
            report(cause.event);
            process.exit(cause.exitCode);
        }
        // A daemon-rejected RPC arrives as a typed RpcError carrying the failed
        // method and the daemon's code/message — surface it as client:rpc:error.
        // Anything else is a genuine non-RPC throw: the generic runtime fallback.
        report(clientRuntimeError(cause));
        process.exit(1);
    }
};
