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
import { runModels, runWorkspaceList, runWorkspaceWorkers, runWorkspaceRename, runLogRead, runRead } from "./subcommands.ts";
import type { LogReadFilters, Caller } from "./subcommands.ts";
import {
    ProblemError,
    report,
    clientConnectionRefused,
    isUnreachable,
    clientProblem,
    clientFlagInvalid,
    clientFlagMissingDependency,
    clientRuntimeError,
    clientSubcommandMissingArgument,
    clientSubcommandWorkspaceNotFound,
    clientSubcommandWorkspaceAmbiguous,
    clientSubcommandUnknownVerb,
    clientWorkerNotFound,
} from "./diagnostics.ts";
import type { ProblemDetails } from "./diagnostics.ts";
import { formatBuildInfo, getBuildInfo } from "./build-info.ts";

// Read all of stdin to EOF. Called when stdin is piped (not a TTY) — never
// blocks an interactive workspace because we gate on isTTY upstream.
const readStdin = async (): Promise<string> => {
    let buf = "";
    for await (const chunk of process.stdin) buf += chunk;
    return buf;
};

// LoopFlags resolution: --flags takes raw JSON (the generic passthrough —
// any flag the daemon wires lands without a client release). Mode is NOT a
// flag here: ask/act ride the prompt-prefix habit (`? text` / `: text`),
// converged across nvim, TUI, and the one-shot CLI.
export const resolveLoopFlags = (rawJson: string | undefined, auto = false): Record<string, unknown> | undefined => {
    if (rawJson === undefined) return auto ? { auto: true } : undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(rawJson); } catch {
        throw new ProblemError(clientFlagInvalid("--flags", rawJson, "must be valid JSON"));
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ProblemError(clientFlagInvalid("--flags", rawJson, "must be a JSON object"));
    }
    return { ...(parsed as Record<string, unknown>), ...(auto ? { auto: true } : {}) };
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

// #132 — the client's per-workspace exec-policy layer: forward the PLURNK_EXECS_*
// enable/disable grammar (PLURNK_EXECS_ONLY, PLURNK_EXECS_<TAG>=0|false) so the
// daemon intersects it with its own ceiling (service ∧ client — subtractive,
// can never re-enable a service-disabled tag). Forwarded VERBATIM: the daemon's
// execs Policy is the single interpreter (pull-don't-copy). EXCLUDES
// PLURNK_EXECS_MCP_* — those are MCP SERVER configs (URLs, header bearer tokens),
// not policy, and must never ride the wire. The bare PLURNK_EXECS_MCP tag toggle
// (no trailing `_`) stays. Workspace-scoped: a per-workspace .env carries its own.
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
    if (!isAbsolute(raw)) throw new ProblemError(clientFlagInvalid("--project-root", raw, "must be an absolute path"));
    return raw;
};

const USAGE = `usage: plurnk [--json] [--workspace <name>] [--worker <name>] [--model <alias>] [prompt...]
       <piped stdin> | plurnk [options] [prompt...]
       plurnk models [--json]
       plurnk workspace list [--json]
       plurnk workspace workers <name> [--json]
       plurnk workspace rename <name> <newname> [--json]
       plurnk log read --workspace <name> [--worker <name>]
                       [--loop <id>] [--turn <id>] [--since <id>] [--limit <n>] [--json]
       plurnk read <loop>/<turn>/<seq> --workspace <name> [--worker <name>] [--json]

Connects to the plurnk-service daemon. Run a single prompt one-shot
(positional args, piped stdin, or both — positionals come first, stdin
is appended after a blank line). With no positionals and a TTY stdin,
enters the interactive REPL. Read-only subcommands (models / workspace list /
log read / read <coord>) inspect daemon state without running a loop.

env (cascade, highest first: shell < --env-file < ./.env < ~/.plurnk/.env
     < ~/.plurnk/.env.defaults < the client's packaged .env.defaults floor):
                        Works with no config at all.
  PLURNK_CLIENT_WORKSPACE        resume/create a workspace by name. UNSET = the daemon
                        mints a fresh, uniquely-named workspace per invocation.
  PLURNK_CLIENT_WORKER            resume (or create) a named worker within that workspace
  PLURNK_MODEL          model alias to use for every loop.run on this invocation.
                        Shared with the daemon (user-level preference). --model
                        overrides for this invocation only.
  PLURNK_CLIENT_PROJECT_ROOT   absolute path passed to workspace.create as the workspace's
                        project_root (workspace for file ops). Default: cwd.
                        Empty string = headless (no project_root, file ops 400).
  PLURNK_CLIENT_YOLO           when truthy, auto-accept every proposal without prompting.
  PLURNK_AUTO                  when truthy, keep proposal authority inside the loop.
                        Client-side only — proposals still go through the wire.
  PLURNK_CLIENT_JSON           when truthy, same as --json for one-shot runs.
  PLURNK_QUESTIONS      when truthy, let the model ask you via SEND[300] (shared
                        intent — the daemon reads it too). --questions overrides.
  PLURNK_AGUI_URL       plurnk-agui bridge URL (e.g. http://127.0.0.1:8787). When
                        set, a one-shot (text AND --json) runs THROUGH the bridge
                        instead of raw daemon WS (the exclusive-portal path).
                        PLURNK_AGUI_TOKEN is the bearer if the bridge requires one.
                        Scripts + subcommands stay on the daemon.
  PLURNK_EXECS_*        per-workspace exec-runtime policy, sent to the daemon at
                        workspace.create (PLURNK_EXECS_ONLY=a,b allowlist;
                        PLURNK_EXECS_<tag>=0 kill one). Subtractive only — the
                        daemon intersects with its ceiling; the client can narrow,
                        never re-enable. Shares the daemon's grammar; a workspace's
                        .env carries its own. (MCP server configs are NOT sent.)

options:
  -h, --help              print this message and exit
  -v, --version           print executable provenance and exit
      --json              json OUTPUT MODE: one complete structured document on
                          stdout (the whole client-observed record — turns/ops,
                          notices, the answer at .response, usage), stderr
                          silent, Problems emitted under "problem". Drill into one
                          op's content with: plurnk read <coord> --json. CLI only.
      --workspace <name>    resume the named workspace, or create it under that name
                          if none exists (attach-or-create). Without it, a fresh
                          auto-named workspace is created. Overrides PLURNK_CLIENT_WORKSPACE.
      --worker <name>        resume (or create) the named worker within the workspace.
                          Requires --workspace. Overrides PLURNK_CLIENT_WORKER.
      --model <alias>     model alias to pass on every loop.run. Resolved
                          server-side against PLURNK_MODEL_<alias>. Without
                          this (and PLURNK_MODEL unset), the daemon uses its
                          own boot-time PLURNK_MODEL.
      --project-root <p>  absolute path. Sent on workspace.create only; ignored
                          on --workspace attach (daemon preserves stored value).
                          Default: cwd. Empty string = headless. Overrides
                          PLURNK_CLIENT_PROJECT_ROOT.
      --yolo              auto-accept every proposal locally without prompting.
                          Overrides PLURNK_CLIENT_YOLO.
      --auto              keep proposal authority inside the loop; proposals
                          resolve automatically without a client review round-trip.
      --flags <json>      raw LoopFlags JSON passthrough on every loop.run
                          (e.g. '{"auto":true}' for unattended
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
      --files-items <n>   workspace-open preview of the TRACKED-FILE list
                          (FIND(file:///**)): -1 full / 0 off / N first-N. Memory
                          (known/unknown/worker/plurnk) always foists full. Create-time.
      --md <name=path>    pin a markdown doc into the workspace (read at turn 0);
                          merges with operator PLURNK_MD_*. Repeatable. Create-time.
      --max-commands <n>  ceiling on ops per emission for the workspace (min with the
                          daemon's PLURNK_MAX_COMMANDS — can only tighten). Create-time.
      --no-git            deny git membership + working-tree status for the workspace (never
                          re-enables past the operator lockout). Create-time.
      --no-agents-md      turn off the service's AGENTS.md auto-load for this
                          workspace (overrides PLURNK_AGENTS_AUTO). Create-time.
      --loop <id>         (log read) filter to a single loop id
      --turn <id>         (log read) filter to a single turn id
      --since <id>        (log read) return entries with id > <id>
      --limit <n>         (log read) max entries to return (default 100)

subcommands:
  models                  list configured model aliases (providers.list)
  workspace list            list workspaces on the daemon (workspace.list)
  workspace workers <name>  list workers in the named workspace (workspace.workers)
  workspace rename <a> <b>  rename workspace <a> to <b> (workspace.rename — a workspace's
                          name is a mutable handle; workers are immutable)
  log read --workspace ...  read log entries from the named workspace's worker
  script <file.plk>       run a .plk file: feed its DSL to op.parse, render the
                          trace, exit by worst op status. Honors --workspace/--yolo
                          /--project-root + membership flags. The daemon owns the
                          grammar; the client just feeds the file.
`;

// Render a Problem to stderr and exit.
const dieWith = (code: number, problem: ProblemDetails): never => {
    report(problem);
    process.exit(code);
};

// JSON mode embeds the exact RFC 9457 Problem document rendered in text mode.
const dieJson = (code: number, problem: ProblemDetails): never => {
    process.stdout.write(`${JSON.stringify(buildJsonError(problem))}\n`);
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

interface WorkspaceResult { id: number; name: string }

// Resolve the workspace by name (via workspace.list filter) or create a fresh one.
// Names are the user-facing handle — ids are internals, not exposed via flags.
// projectRoot is sent on creation only; attach inherits the daemon-stored value.
// A membership-overlay constraint (svc#200), service vocabulary: `pick` admits
// a file git misses (the sole source when headless), `hide` drops a tracked
// match, `view` admits a member read-only.
export interface Constraint { effect: "pick" | "hide" | "view"; glob: string }

// Map repeatable membership flags to workspace constraints.
export const buildConstraints = (values: {
    pick?: string[]; hide?: string[]; view?: string[];
}): Constraint[] => [
    ...(values.pick ?? []).map((glob): Constraint => ({ effect: "pick", glob })),
    ...(values.hide ?? []).map((glob): Constraint => ({ effect: "hide", glob })),
    ...(values.view ?? []).map((glob): Constraint => ({ effect: "view", glob })),
];

// Workspace-open settings. Open-context (svc#231/#286): filesItems REPLACES
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
    client?: string;          // #249 — frontend id, set on every workspace.create
    autoReadAgents?: boolean; // #268 — per-workspace override of the service AGENTS auto-load
    execs?: Record<string, string>; // #132 — per-workspace exec-policy layer (PLURNK_EXECS_* forwarded)
    questions?: boolean;      // svc#346 — enable model→user SEND[300] questions for the workspace (+ questions.md teaching)
}

export const buildSettings = async (
    values: { "files-items"?: string; md?: string[]; "max-commands"?: string; "no-git"?: boolean; "no-agents-md"?: boolean; questions?: boolean },
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<Settings> => {
    const settings: Settings = {};
    const execs = collectExecsPolicy(env);
    if (Object.keys(execs).length > 0) settings.execs = execs;
    // svc#346 — enable model→user SEND[300] questions (per-workspace; the daemon
    // injects questions.md teaching + intersects its PLURNK_QUESTIONS ceiling).
    // Flag or bare env (shared user intent). The daemon owns refusal when off.
    if (values.questions === true || ["1", "true", "yes", "on"].includes((env.PLURNK_QUESTIONS ?? "").toLowerCase())) settings.questions = true;
    const mc = values["max-commands"];
    if (mc !== undefined) {
        const n = Number(mc);
        if (!Number.isInteger(n) || n < 1) {
            throw new ProblemError(clientFlagInvalid("--max-commands", mc, "must be a positive integer"));
        }
        settings.maxCommands = n;
    }
    if (values["no-git"] === true) settings.git = false;
    // #268 — pure passthrough of the per-workspace AGENTS auto-load override (the
    // service does the picking + reading; the client just forces it off here).
    if (values["no-agents-md"] === true) settings.autoReadAgents = false;
    const fi = values["files-items"];
    if (fi !== undefined) {
        const n = Number(fi);
        if (!Number.isInteger(n) || n < -1) {
            throw new ProblemError(clientFlagInvalid("--files-items", fi, "must be -1 (full), 0 (off), or a positive integer"));
        }
        settings.filesItems = n;
    }
    const mdSpecs = values.md ?? [];
    if (mdSpecs.length > 0) {
        const mdDocs: Array<{ alias: string; content: string }> = [];
        for (const spec of mdSpecs) {
            const eq = spec.indexOf("=");
            if (eq <= 0) throw new ProblemError(clientFlagInvalid("--md", spec, "must be NAME=path"));
            const alias = spec.slice(0, eq);
            const raw = spec.slice(eq + 1);
            const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
            try {
                mdDocs.push({ alias, content: await readFile(abs, "utf8") });
            } catch (cause) {
                throw new ProblemError(clientFlagInvalid("--md", spec, `file not readable: ${cause instanceof Error ? cause.message : String(cause)}`));
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

// #249 — workspace-stable frontend id, passed on workspace.create and forwarded by
// the daemon to the plurnk provider as the Plurnk-Client header (dropped by
// every other provider). The 'plurnk.nvim/1.4.0' shape; nvim sends its own.
// #71 — one id per FRONTEND, name/version form, workspace-stable. CLI and TUI are
// distinct frontends of this package (nvim self-ids separately as plurnk.nvim);
// splitting them lets the service attribute usage per surface.
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

// Resolve --worker <name> to its id over the action surface (workspace.workers is scoped
// to the caller's thread/workspace). Undefined workerName = the module's model-worker default.
export const resolveWorkerId = async (rpc: Caller, workerName: string | undefined): Promise<number | undefined> => {
    if (workerName === undefined) return undefined;
    const { workers } = await rpc.call("workspace.workers") as { workers: Array<{ id: number; name: string }> };
    const hit = workers.find((r) => r.name === workerName);
    if (hit === undefined) throw new ProblemError(clientWorkerNotFound(workerName));
    return hit.id;
};

const parseIntFlag = (raw: string | undefined, name: string): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new ProblemError(clientFlagInvalid(name, raw, "must be a non-negative integer"));
    return n;
};
interface SubcommandOpts {
    json: boolean;
    workspaceName?: string;
    workerName?: string;
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
            throw new ProblemError(clientSubcommandUnknownVerb(`models ${positionals.slice(1).join(" ")}`));
        }
        return await runModels(rpc, { json: opts.json });
    }

    if (verb === "workspace") {
        if (sub === "list") {
            if (positionals.length > 2) {
                throw new ProblemError(clientSubcommandUnknownVerb(`workspace list ${positionals.slice(2).join(" ")}`));
            }
            return await runWorkspaceList(rpc, { json: opts.json });
        }
        if (sub === "workers") {
            const name = positionals[2];
            if (name === undefined) {
                throw new ProblemError(clientSubcommandMissingArgument("plurnk workspace workers", "<name>"));
            }
            if (positionals.length > 3) {
                throw new ProblemError(clientSubcommandUnknownVerb(`workspace workers ${positionals.slice(3).join(" ")}`));
            }
            return await runWorkspaceWorkers(rpc, name, { json: opts.json });
        }
        if (sub === "rename") {
            const name = positionals[2];
            const newName = positionals[3];
            if (name === undefined || newName === undefined) {
                throw new ProblemError(clientSubcommandMissingArgument("plurnk workspace rename", "<name> <newname>"));
            }
            if (positionals.length > 4) {
                throw new ProblemError(clientSubcommandUnknownVerb(`workspace rename ${positionals.slice(4).join(" ")}`));
            }
            return await runWorkspaceRename(rpc, name, newName, { json: opts.json });
        }
        throw new ProblemError(clientSubcommandUnknownVerb(`workspace ${sub ?? "(missing)"}`, ["list", "workers", "rename"]));
    }

    if (verb === "log") {
        if (sub !== "read") {
            throw new ProblemError(clientSubcommandUnknownVerb(`log ${sub ?? "(missing)"}`, ["read"]));
        }
        if (opts.workspaceName === undefined) {
            throw new ProblemError(clientFlagMissingDependency("plurnk log read", "--workspace (or PLURNK_CLIENT_WORKSPACE)"));
        }
        // The caller's threadId (--workspace) scopes the action to that workspace; the
        // module defaults reads to the conversation (model worker); --worker pins by name.
        const filters: LogReadFilters = { ...(await resolveWorkerId(rpc, opts.workerName) !== undefined ? { workerId: await resolveWorkerId(rpc, opts.workerName) } : {}) };
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
            throw new ProblemError(clientSubcommandMissingArgument("plurnk read", "<loop>/<turn>/<seq>"));
        }
        if (positionals.length > 2) {
            throw new ProblemError(clientSubcommandUnknownVerb(`read ${positionals.slice(2).join(" ")}`));
        }
        if (opts.workspaceName === undefined) {
            throw new ProblemError(clientFlagMissingDependency("plurnk read", "--workspace (or PLURNK_CLIENT_WORKSPACE)"));
        }
        // The coordinate is worker-relative; the module defaults to the conversation
        // (model worker) — --worker pins by name via params, no connection state.
        return await runRead(rpc, coord, { json: opts.json, workerId: await resolveWorkerId(rpc, opts.workerName) });
    }

    throw new ProblemError(clientSubcommandUnknownVerb(verb ?? "(missing)"));
};

export const main = async (argv: string[]): Promise<void> => {
    const { positionals, values } = parseArgs({
        args: argv.slice(2),
        allowPositionals: true,
        options: {
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "v" },
            json: { type: "boolean" },
            // Node-native env layering (mirrors plurnk-service): --env-file
            // requires the file, --env-file-if-exists skips a missing one.
            "env-file": { type: "string", multiple: true },
            "env-file-if-exists": { type: "string", multiple: true },
            workspace: { type: "string" },
            worker: { type: "string" },
            model: { type: "string" },
            "project-root": { type: "string" },
            yolo: { type: "boolean" },
            auto: { type: "boolean" },
            flags: { type: "string" },
            questions: { type: "boolean" },   // --questions: allow the model to ask via SEND[300]
            "max-turns": { type: "string" },
            timeout: { type: "string" },
            // membership overlay — repeatable globs; service vocabulary
            pick: { type: "string", multiple: true },
            hide: { type: "string", multiple: true },
            view: { type: "string", multiple: true },
            // workspace-open settings (svc#231) + tighten-only ceilings (svc#232)
            "files-items": { type: "string" },
            md: { type: "string", multiple: true },
            "max-commands": { type: "string" },
            "no-git": { type: "boolean" },
            "no-agents-md": { type: "boolean" },   // #268 — override: AGENTS auto-load off for this workspace
            // log read filters
            loop: { type: "string" },
            turn: { type: "string" },
            since: { type: "string" },
            limit: { type: "string" },
        },
    });

    if (values.help) { process.stdout.write(USAGE); process.exit(0); }
    const buildInfo = await getBuildInfo();
    if (values.version) {
        process.stdout.write(`${formatBuildInfo(buildInfo)}\n`);
        process.exit(0);
    }

    // Shared ~/.plurnk env cascade (after parse so --env-file flags participate).
    loadEnvCascade((values["env-file"] as string[] | undefined) ?? [], (values["env-file-if-exists"] as string[] | undefined) ?? []);

    // json OUTPUT MODE — flag or env (user-level, same name client+daemon would
    // read). One complete document on stdout, stderr silent, structured errors.
    const json = values.json === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_CLIENT_JSON ?? "").toLowerCase());
    if (!json) process.stderr.write(`plurnk: ${formatBuildInfo(buildInfo)}\n`);

    // Subcommand routing happens BEFORE prompt assembly: if positionals[0] is
    // a known read-only subcommand (models / workspace / log), we skip stdin
    // reading and prompt construction entirely.
    const SUBCOMMANDS = ["models", "workspace", "log", "read", "script"] as const;
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
            if (values.json === true) {
                dieJson(64, clientProblem("usage", "prompt-required", 400, "--json needs a prompt (CLI mode only)", { flag: "--json" }));
            }
            // PLURNK_CLIENT_JSON with no prompt is the interactive TUI — env shouldn't force CLI mode.
        }
    }

    // CLI flag overrides env; env overrides nothing.
    const workspaceName = values.workspace ?? process.env.PLURNK_CLIENT_WORKSPACE;
    const workerName = values.worker ?? process.env.PLURNK_CLIENT_WORKER;
    const modelAlias = values.model ?? process.env.PLURNK_MODEL;
    const yolo = values.yolo === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_CLIENT_YOLO ?? "").toLowerCase());
    if (workerName !== undefined && workspaceName === undefined) {
        dieWith(64, clientFlagMissingDependency("--worker (or PLURNK_CLIENT_WORKER)", "--workspace (or PLURNK_CLIENT_WORKSPACE)"));
    }

    // Loop knobs (benchmark surface): --flags JSON passthrough, --ask sugar,
    // --max-turns, --timeout. All validated up front, usage errors exit 64.
    let loopFlags: Record<string, unknown> | undefined;
    let maxTurns: number | undefined;
    let timeoutSec: number | undefined;
    try {
        const auto = values.auto === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_AUTO ?? "").toLowerCase());
        loopFlags = resolveLoopFlags(values.flags, auto);
        maxTurns = parseIntFlag(values["max-turns"], "--max-turns");
        timeoutSec = parseIntFlag(values.timeout, "--timeout");
    } catch (cause) {
        if (cause instanceof ProblemError) dieWith(cause.exitCode, cause.problem);
        dieWith(64, clientRuntimeError(cause));
    }

    // --questions / PLURNK_QUESTIONS is a SESSION setting (settings.questions in
    // buildSettings), NOT a loop flag — svc#346 ruled it workspace-scoped (it also
    // gates the questions.md teaching, so capability + teaching arrive together).

    const projectRootRaw = values["project-root"] ?? process.env.PLURNK_CLIENT_PROJECT_ROOT;
    const projectRoot: string | null = (() => {
        try { return resolveProjectRoot(projectRootRaw); }
        catch (cause) {
            if (cause instanceof ProblemError) return dieWith(cause.exitCode, cause.problem);
            return dieWith(64, clientRuntimeError(cause));
        }
    })();

    // plurnk-agui#1 — CLI one-shot through the exclusive-portal bridge: when
    // PLURNK_AGUI_URL is set, a prompt run rides the bridge (which owns the WS +
    // workspace) instead of raw daemon WS. Both text and --json route here now
    // (plurnk-agui 0.2.1's plurnk.terminated carries workspaceId/loopId/turnIds/cost,
    // so the json record matches the WS schema). Scripts + subcommands stay on the
    // daemon. Dual-surface, per the charter.
    // AG-UI+ IS the client surface (service 0.81.0): PLURNK_HOST/PLURNK_PORT point at
    // the daemon's in-process module. PLURNK_AGUI_URL remains an explicit override
    // (a remote portal); otherwise the canonical legend is the default — ordinary AG-UI+
    // below is legacy awaiting deletion.
    const aguiOverride = process.env.PLURNK_AGUI_URL ?? "";
    const bridgeUrl = aguiOverride.length > 0 ? aguiOverride : `http://${process.env.PLURNK_HOST ?? "127.0.0.1"}:${process.env.PLURNK_PORT ?? "3044"}`;
    let workspaceOptionsPromise: Promise<{ constraints: Constraint[]; settings: Settings }> | undefined;
    const workspaceOptions = (): Promise<{ constraints: Constraint[]; settings: Settings }> => {
        workspaceOptionsPromise ??= (async () => ({
            constraints: buildConstraints(values as { pick?: string[]; hide?: string[]; view?: string[] }),
            settings: await buildSettings(values as { "files-items"?: string; md?: string[]; "max-commands"?: string; "no-git"?: boolean; "no-agents-md"?: boolean; questions?: boolean }, process.cwd()),
        }))();
        return workspaceOptionsPromise;
    };

    // THE WORLD (workspace) name. An explicit --workspace/PLURNK_CLIENT_WORKSPACE names it;
    // otherwise the daemon mints a fresh, uniquely-named workspace (resolveWorld) —
    // never a literal "tui"/"cli". Resolved once, lazily, only when a conversation
    // needs a world. Minted WITH its options so creation is atomic with the root.
    let resolvedWorld: string | undefined;
    const world = async (): Promise<string> => {
        if (resolvedWorld !== undefined) return resolvedWorld;
        const { constraints, settings } = await workspaceOptions();
        resolvedWorld = await resolveWorld({ bridgeUrl, token: process.env.PLURNK_AGUI_TOKEN }, workspaceName, {
            ...(projectRoot !== null ? { projectRoot } : {}),
            ...(constraints.length > 0 ? { constraints } : {}),
            ...(Object.keys(settings).length > 0 ? { settings } : {}),
        });
        return resolvedWorld;
    };
    if (bridgeUrl !== undefined && bridgeUrl.length > 0 && !isSubcommand && subcommand !== "script" && prompt.length > 0) {
        try {
            // Thread-per-worker (svc#366): --worker names the CONVERSATION (the threadId);
            // the world is --workspace, else a fresh daemon-minted workspace. Without --worker,
            // thread == world (the model worker).
            const w = await world();
            const { constraints, settings } = await workspaceOptions();
            const code = await runCliViaBridge({ bridgeUrl, token: process.env.PLURNK_AGUI_TOKEN }, prompt, { threadId: workerName ?? w, workspace: w, ...(modelAlias !== undefined ? { alias: modelAlias } : {}), ...(resolveModelSpec(modelAlias) !== undefined ? { model: resolveModelSpec(modelAlias) } : {}), ...(loopFlags !== undefined ? { flags: loopFlags } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}), ...(timeoutSec !== undefined ? { timeoutSec } : {}), yolo, json, projectRoot, constraints, settings });
            // Let Node drain stdout before termination. A forced exit truncated large
            // --json records mid-string when notices made the pipe exceed its buffer.
            process.exitCode = code;
            return;
        } catch (cause) {
            // Two distinct failures, two distinct messages: NOTHING LISTENING gets the
            // onboarding block (no daemon is a first-run moment, not a stack trace);
            // a bridge that ANSWERED with an error surfaces its real cause — claiming
            // "no daemon running" over a 500 would lie. json mode still emits ONE
            // valid document on stdout either way.
            if (cause instanceof ProblemError) {
                if (json) dieJson(cause.exitCode, cause.problem);
                dieWith(cause.exitCode, cause.problem);
            }
            const detail = cause instanceof Error ? cause.message : String(cause);
            if (json) {
                const problem = isUnreachable(cause)
                    ? clientConnectionRefused(bridgeUrl, cause)
                    : clientProblem("bridge", "error", 502, detail, { bridge: bridgeUrl });
                dieJson(1, problem);
            }
            if (isUnreachable(cause)) dieWith(1, clientConnectionRefused(bridgeUrl, cause));
            dieWith(1, clientRuntimeError(new Error(`plurnk-agui bridge (${bridgeUrl}) — ${detail}`)));
        }
    }

    // TUI through the bridge (no prompt): skip the WS connect + workspace.create — a
    // pure-bridge client has no direct daemon WS. The bridge owns the workspace; we
    // pass a threadId-named stub (the daemon workspace id is bridge-created). projectRoot
    // rides forwardedProps; PLURNK_AGUI_QUESTIONS gates questions bridge-side.
    // (Per-workspace constraints/settings over the bridge are a follow-up.)
    if (bridgeUrl !== undefined && bridgeUrl.length > 0 && !isSubcommand && subcommand !== "script" && prompt.length === 0) {
        const w = await world();
        const threadId = workerName ?? w;
        const { constraints, settings } = await workspaceOptions();
        // Workspace options ride the thread's first run (forwardedProps.plurnk): the
        // Same constraints (--pick/hide/view) + settings every AG-UI+ run sends on
        // workspace.create, so a bridge TUI is configured identically. (When the world
        // was daemon-minted above, it was created WITH these already; a re-send on the
        // first run is idempotent — the workspace exists, options apply at creation only.)
        const transport = new BridgeTransport({ bridgeUrl, token: process.env.PLURNK_AGUI_TOKEN }, threadId, {
            workspace: w,
            projectRoot,
            constraints,
            settings,
        });
        const autoReadAgents = values["no-agents-md"] === true ? false : undefined;
        await runTui(transport, { id: 0, name: w }, { modelAlias, model: resolveModelSpec(modelAlias), resolveModel: (a: string) => resolveModelSpec(a), yolo, loopFlags, maxTurns, projectRoot, workerName, client: CLIENT_ID_TUI, autoReadAgents });
        process.exitCode = 0;
        return;
    }

    // AG-UI+ is the ONLY wire (the WS transport is deleted). Subcommands + script
    // speak the action surface through a structural Caller.
    const target = { bridgeUrl, token: process.env.PLURNK_AGUI_TOKEN };
    const callerThread = workspaceName ?? "cli";
    const caller = { call: (method: string, params?: object) => actionViaBridge<unknown>(target, { threadId: callerThread, kind: method, params }) };

    try {
        // `plurnk script foo.plk` — feed a .plk file to op.parse over the action
        // surface. The client never parses the file; the module owns the grammar.
        if (subcommand === "script") {
            const filePath = positionals[1];
            if (filePath === undefined) {
                throw new ProblemError(clientSubcommandMissingArgument("plurnk script", "<file.plk>"));
            }
            if (positionals.length > 2) {
                throw new ProblemError(clientSubcommandUnknownVerb(`script ${positionals.slice(2).join(" ")}`));
            }
            const text = await readFile(resolve(filePath), "utf8");   // fail-hard on a missing file
            const exitCode = await runScriptViaBridge(target, text, { threadId: callerThread, yolo, json, projectRoot });
            process.exitCode = exitCode;
            return;
        }

        if (isSubcommand) {
            const exitCode = await runSubcommand(caller, positionals, {
                json, workspaceName, workerName, projectRoot, values,
            });
            process.exitCode = exitCode;
            return;
        }

        // Reaching here is a dispatcher bug: prompts + the TUI ride the bridge
        // branches above; script + subcommands returned above. Fail hard.
        throw new Error("dispatcher fell through every AG-UI+ path — unreachable");
    } catch (cause) {
        // json mode: a structured error document on stdout (valid JSON even on
        // failure), paired with the right exit code. Text mode narrates to stderr.
        if (json) {
            const problem = cause instanceof ProblemError ? cause.problem : clientRuntimeError(cause);
            const code = cause instanceof ProblemError ? cause.exitCode : 1;
            dieJson(code, problem);
        }
        if (cause instanceof ProblemError) {
            report(cause.problem);
            process.exit(cause.exitCode);
        }
        // A daemon-rejected RPC arrives as a typed RpcError carrying the failed
        // method and the daemon's code/message — surface it as client:rpc:error.
        // Nothing listening at all (subcommands, the TUI boot) gets the onboarding
        // block; any other genuine throw is the generic runtime fallback.
        if (isUnreachable(cause)) { report(clientConnectionRefused(bridgeUrl ?? "the daemon", cause)); process.exit(1); }
        report(clientRuntimeError(cause));
        process.exit(1);
    }
};
