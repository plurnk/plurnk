// plurnk client entrypoint. Dispatches argv to CLI mode (positional args or
// piped stdin) or TUI REPL mode (no positionals, TTY stdin). Per SPEC.md
// §2 (CLI mode) and §3 (TUI mode).

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildJsonError } from "./cli.ts";
import { loadFloor, retiredKey } from "./envdefaults.ts";
import Knobs, { KnobError } from "./knobs.ts";
import { isColorMode } from "./color.ts";
import { runCliViaBridge, runScriptViaBridge } from "./agui_cli.ts";
import { BridgeTransport } from "./transport.ts";
import { actionViaBridge, resolveWorld } from "./agui.ts";
import { handleMcp } from "./mcp.ts";
import { formatRouteIdentity } from "./status.ts";
import {
    formatWorkerEffort,
    readWorkerEffort,
    setWorkerEffort,
} from "./effort.ts";
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
import { userConfigFile } from "./paths.ts";
import { RENDER_USAGE, renderDocument, resolveRenderWidth } from "./render-command.ts";
import { launchWeb } from "./web.ts";
import Backend from "./backend.ts";
import Lifetime from "./lifetime.ts";
import { extractOpenPaths } from "./openpaths.ts";
import { formatShare, shareFolder, type ShareResult } from "./share.ts";
import {
    Validator,
    type CapabilityPolicy,
    type LoopPolicyRequest,
    type ModelRoute,
} from "@plurnk/plurnk-contracts";
import {
    formatCapabilityProjection,
    parseCapabilityPolicy,
    promptPolicy,
    statedLoopPolicy,
} from "./policy.ts";

// Read all of stdin to EOF. Called when stdin is piped (not a TTY) — never
// blocks an interactive workspace because we gate on isTTY upstream.
const readStdin = async (): Promise<string> => {
    let buf = "";
    for await (const chunk of process.stdin) buf += chunk;
    return buf;
};

// An optional knob its user set: unset or empty means nobody said.
const stated = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw.length === 0 ? undefined : raw;
};

// A switch resolved from its knob; a value that is neither on nor off is a flag Problem by name.
const switchOf = (name: string, declared: "live" | "optional", env: NodeJS.ProcessEnv = process.env): boolean => {
    try {
        return Knobs.flag(name, declared, env);
    } catch (cause) {
        if (cause instanceof KnobError) throw new ProblemError(clientFlagInvalid(cause.knob, cause.value, cause.message));
        throw cause;
    }
};

export const resolveLoopPolicy = (proposals: string | undefined, auto = false): LoopPolicyRequest => {
    try {
        return statedLoopPolicy(proposals, auto);
    } catch (cause) {
        throw new ProblemError(clientFlagInvalid("--proposals", proposals ?? "", cause instanceof Error ? cause.message : String(cause)));
    }
};

const MCP_CONFIGURATION_PREFIX = "PLURNK_MCP_";

// {§cli-workspace-mcp-controls} — carried whole: which of these names are the daemon's own controls
// is the daemon's fact, and its parser skips them.
export const collectMcpConfiguration = (
    env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
    const configuration: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || !key.startsWith(MCP_CONFIGURATION_PREFIX)) continue;
        configuration[key] = value;
    }
    return configuration;
};

// projectRoot resolution: empty string = explicit headless (null on wire);
// otherwise must be an absolute path. Caller passes cwd as default.
export const resolveProjectRoot = (raw: string | undefined): string | null => {
    if (raw === undefined) return process.cwd();
    if (raw.length === 0) return null;
    if (!isAbsolute(raw)) throw new ProblemError(clientFlagInvalid("--project-root", raw, "must be an absolute path"));
    return raw;
};

export const USAGE = `usage: plurnk [--json] [--workspace <name>] [--worker <name>] [--model <selector>] [--effort <level>] [prompt...]
       <piped stdin> | plurnk [options] [prompt...]
       plurnk models [search...] [--provider <name>] [--all] [--offset <n>] [--limit <n>] [--json]
       plurnk workspace list [--json]
       plurnk workspace workers <name> [--json]
       plurnk workspace rename <name> <newname> [--json]
       plurnk log read --workspace <name> [--worker <name>]
                       [--loop <id>] [--turn <id>] [--since <id>] [--limit <n>] [--json]
       plurnk read <loop>/<turn>/<seq> --workspace <name> [--worker <name>] [--json]
       plurnk effort [level] --workspace <name> [--worker <name>] [--json]
       plurnk capabilities [json] --workspace <name> [--worker <name>] [--json]
       plurnk script <file.plk> [options]
       plurnk web [options]
       plurnk completion <bash|zsh|fish>
       <markdown stdin> | plurnk render [--width <columns>]
       plurnk mcp [add <alias> <target> [options.json] | enable <alias> [options.json]
                   | disable|remove <alias> | oauth <alias> <callback-url>]

Connects to plurnk-service, starting an installed private backend if the default
local listener is absent. The private process stops on exit; saved data remains.
Run a single prompt one-shot
(positional args, piped stdin, or both — positionals come first, stdin
is appended after a blank line). With no positionals and a TTY stdin,
enters the scrollback-native interactive terminal. Read-only subcommands (models / workspace list /
log read / read <coord>) inspect daemon state without running a loop.

env (cascade, low → high: packaged .env.defaults < $XDG_CONFIG_HOME/plurnk/.env
     < ./.env < repeated --env-file flags (last wins) < shell):
                        Works with no config at all.
  PLURNK_CLIENT_*       every option below is one knob's spelling for one invocation:
                        --max-turns is PLURNK_CLIENT_MAX_TURNS, --no-git is
                        PLURNK_CLIENT_NO_GIT. The packaged .env.defaults declares and
                        documents them all; the option wins when both are given.
  PLURNK_HOST, PLURNK_PORT
                        the daemon's address, under the daemon's own key names.
  PLURNK_AGUI_URL       the whole URL instead, when the daemon is reached through a
                        remote AG-UI portal. PLURNK_AGUI_TOKEN is its bearer.
  PLURNK_CLIENT_AUTOSTART
                        1 (default): start a private installed backend on local
                        connection refusal. 0: attach only. Explicit AG-UI URLs
                        and remote hosts are always attach-only.
  PLURNK_MCP_*          raw server declarations accompany MCP list and enable.
                        The daemon owns parsing, activation, persistence, and
                        credential expansion.

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
                          Requires --workspace except in web mode, which resolves
                          the workspace before applying this constraint. Overrides
                          PLURNK_CLIENT_WORKER.
      --model <selector>  persistently select the conversation worker's model
                          before the first loop (worker.model.set). A selector is
                          a declared alias or exact provider/model route. Without
                          this, the worker's durable model or the daemon's
                          boot-time default runs.
      --effort <level>    persistently select the conversation worker's effort before
                          the first loop; with --model, the two are chosen together.
                          The daemon validates it against the parent and child models.
      --autostart <0|1>   start a private installed backend if the local listener is
                          absent (1), or require attachment (0).
      --daemon-timeout-ms <n> positive connection/startup deadline in milliseconds.
      --daemon-stop-timeout-ms <n> positive private-backend shutdown grace in milliseconds.
      --service-bin <p>   select an installed service entrypoint instead of discovery.
      --project-root <p>  absolute path. Sent on workspace.create only; ignored
                          on --workspace attach (daemon preserves stored value).
                          Default: cwd. Empty string = headless. Overrides
                          PLURNK_CLIENT_PROJECT_ROOT.
      --yolo              auto-accept every proposal locally without prompting.
                          On by default; Shift-Tab toggles it for the session.
                          Overrides PLURNK_CLIENT_YOLO.
      --auto              nobody is attending: the daemon offers no human-in-the-loop
                          surface rather than one nothing could answer, and settles
                          proposals inside the loop as its panel says.
                          Overrides PLURNK_CLIENT_AUTO.
      --proposals <p>     what every loop does with a proposal: review, accept or
                          reject. Unstated, the daemon's panel decides; '?' states
                          review for that prompt. Overrides PLURNK_CLIENT_PROPOSALS.
      --capabilities <json>
                          CapabilityPolicy JSON applied when creating the workspace.
      --env-file <p>      load env from <p> (errors if missing). Repeatable.
      --env-file-if-exists <p>  same, but silently skip a missing file. Repeatable.
      --max-turns <n>     model-call budget for the prompt's worker tree: its turns, its
                          descendants' turns and every BARE call (else the daemon's ceiling).
      --timeout <s>       cancel each prompt loop (loop.cancel) after <s> seconds;
                          CLI exits 3 with "timedOut":true. Web retains the Worker.
      --files-items <n>   turn-0 tracked-file preview: -1 full / 0 off / N first-N.
                          Create-time workspace setting.
      --preview-lines <n> lines of each operation body and execution output shown
                          beneath its row; the rest is named for /look. Overrides
                          PLURNK_CLIENT_PREVIEW_LINES.
      --history-entries <n> recent entries restored when opening or switching TUI
                          conversations; 0 hides history. Overrides PLURNK_CLIENT_HISTORY_ENTRIES.
      --color <when>      style terminal output: always, auto, or never. Overrides
                          PLURNK_CLIENT_COLOR; always/never override color env preferences.
      --max-commands <n>  ceiling on ops per emission for the workspace (min with the
                          daemon's PLURNK_SERVICE_MAX_COMMANDS — can only tighten). Create-time.
      --status-stream     also print one greppable accounting row per turn on stderr.
      --share <folder>    when the prompt or session ends, write the workspace's share for
                          a bug report into <folder>, unredacted. A leading ~/
                          expands; a relative folder is this directory's. Overrides
                          PLURNK_CLIENT_SHARE.
      --no-git            deny git membership + working-tree status for the workspace (never
                          re-enables past the operator lockout). Create-time.
      --loop <id>         (log read) filter to a single loop id
      --turn <id>         (log read) filter to a single turn id
      --since <id>        (log read) return entries with id > <id>
      --limit <n>         (models / log read) page limit (log read default 100)
      --provider <name>   (models) restrict the catalog to one provider
      --all               (models) include unconfigured models with readiness causes
      --offset <n>        (models) catalog page offset (default 0)
      --width <n>         (render) output width in terminal columns (default: stdout
                          width when available, otherwise 80)
      --host <host>       (web) local browser portal host (otherwise PLURNK_WEB_HOST)
      --port <n>          (web) local browser portal port (otherwise PLURNK_WEB_PORT)

subcommands:
  models [search...]      list the bounded daemon model catalog (models.list)
  workspace list            list workspaces on the daemon (workspace.list)
  workspace workers <name>  list workers in the named workspace (workspace.workers)
  workspace rename <a> <b>  rename workspace <a> to <b> (workspace.rename — a workspace's
                          name is a mutable handle; workers are immutable)
  log read --workspace ...  read log entries from the named workspace's worker
  read <loop/turn/op>     inspect one log row; requires --workspace, optional --worker
  effort [level]          inspect or set a worker's effort
  capabilities [json]    inspect the capability cascade or set the workspace policy
  render                  project Markdown stdin as width-bounded plain Unicode;
                          local only: no daemon, config cascade, or startup output
  completion <shell>      print the packaged Bash, Zsh, or Fish completion script;
                          local only: writes stdout, never installs files
  web [options]           serve the optional browser client using this invocation's
                          resolved configuration and optional workspace/Worker
                          constraints; each tab is URL-addressed as /workspace/threadId;
                          performs no package install or daemon startup
  mcp ...                 list and manage MCP servers for --workspace
  script <file.plk>       run a .plk file: feed its DSL to op.parse, render the
                          trace, exit by worst op status. Honors --workspace/--yolo
                          /--project-root + workspace-open settings. The daemon owns the
                          grammar; the client just feeds the file.
`;

const subcommandNames = new Set([...USAGE.slice(USAGE.indexOf("\nsubcommands:")).matchAll(/^  ([a-z]+)\b/gm)].map((match) => match[1]));

const commandHelp = (name: string | undefined): string => {
    if (name === "render") return RENDER_USAGE;
    if (name === undefined || !subcommandNames.has(name)) return USAGE;
    const synopsis = USAGE.slice(0, USAGE.indexOf("\n\n"));
    const forms = synopsis.match(new RegExp(`^ {7}plurnk ${name}\\b[^\\n]*(?:\\n {8,}[^\\n]*)*`, "gm"));
    const descriptions = USAGE.slice(USAGE.indexOf("\nsubcommands:")).match(new RegExp(`^  ${name}\\b[^\\n]*(?:\\n {3,}[^\\n]*)*`, "gm"));
    if (forms === null || descriptions === null) throw new Error(`Missing CLI help for ${name}`);
    return `usage: ${forms[0].trimStart()}${forms.slice(1).map((form) => `\n${form}`).join("")}\n\n${descriptions.join("\n")}\n\nSee plurnk --help for shared options and environment configuration.\n`;
};

class ClientExit extends Error {
    readonly code: number;
    constructor(code: number) { super("Client invocation ended."); this.code = code; }
}

// Unwind through the invocation owner before exiting; owned services must be stopped.
const dieWith = (code: number, problem: ProblemDetails): never => {
    report(problem);
    throw new ClientExit(code);
};

// JSON mode embeds the exact RFC 9457 Problem document rendered in text mode.
const dieJson = (code: number, problem: ProblemDetails): never => {
    process.stdout.write(`${JSON.stringify(buildJsonError(problem))}\n`);
    throw new ClientExit(code);
};

// Env cascade, aligned with plurnk-service's XDG config so the two share one
// file. process.loadEnvFile only fills UNSET vars, so loading
// highest-precedence-first yields:
//   shell > --env-file > --env-file-if-exists > ./.env
//   > $XDG_CONFIG_HOME/plurnk/.env
//   > the client's OWN packaged .env.defaults (#141 — the self-serve floor:
//     the client is the one member the daemon cannot assemble).
export interface ExplicitEnvFile {
    readonly path: string;
    readonly required: boolean;
}

export const orderedEnvFiles = (args: readonly string[]): ExplicitEnvFile[] => {
    const files: ExplicitEnvFile[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--") break;
        for (const [flag, required] of [["--env-file", true], ["--env-file-if-exists", false]] as const) {
            if (arg === flag) {
                const path = args[index + 1];
                if (path !== undefined) files.push({ path, required });
                index += 1;
                break;
            }
            if (arg.startsWith(`${flag}=`)) files.push({ path: arg.slice(flag.length + 1), required });
        }
    }
    return files;
};

export const loadEnvCascade = (
    explicitFiles: readonly ExplicitEnvFile[],
    userConfig: string = userConfigFile(),
): void => {
    const ifExists = (p: string): void => { try { process.loadEnvFile(p); } catch { /* optional layer */ } };
    for (const { path, required } of explicitFiles.toReversed()) {
        if (!required) {
            ifExists(path);
            continue;
        }
        try { process.loadEnvFile(path); }
        catch { dieWith(64, clientFlagInvalid("--env-file", path, "file not found")); }
    }
    ifExists(".env");
    ifExists(userConfig);
    loadFloor();
    const retired = retiredKey();
    if (retired !== null) {
        dieWith(64, clientFlagInvalid(retired.name, process.env[retired.name] ?? "", `${retired.name} was retired; use ${retired.successor}`));
    }
};

interface WorkspaceResult { id: number; name: string }

// Resolve the workspace by name (via workspace.list filter) or create a fresh one.
// Names are the user-facing handle — ids are internals, not exposed via flags.
// Workspace-open settings. Open-context: filesItems replaces PLURNK_SERVICE_FILES_ITEMS
// (it only ever capped the tracked-file list; memory always foists full).
// The mdDocs channel is retired — operator reference material is skills under
// the workspace .agents/skills tree ({§skills-functionality} in the service SPEC).
// Ceilings (svc#232, most-restrictive-wins): maxCommands min()s
// PLURNK_SERVICE_MAX_COMMANDS; git:false ANDs PLURNK_SERVICE_GIT_ALLOWED (deny-only).
export interface Settings {
    filesItems?: number;
    maxCommands?: number;
    git?: boolean;
    client?: string;          // #249 — frontend id, set on every workspace.create
    capabilities?: CapabilityPolicy;
}

export const buildSettings = async (
    values: { "files-items"?: string; "max-commands"?: string; "no-git"?: boolean; capabilities?: string },
    env: NodeJS.ProcessEnv = process.env,
    client?: string,
): Promise<Settings> => {
    const settings: Settings = { ...(client === undefined ? {} : { client }) };
    const rawCapabilities = values.capabilities ?? env.PLURNK_CLIENT_CAPABILITIES;
    if (rawCapabilities !== undefined) {
        try {
            settings.capabilities = parseCapabilityPolicy("--capabilities", rawCapabilities);
        } catch {
            throw new ProblemError(clientFlagInvalid(
                "--capabilities",
                rawCapabilities,
                "must be a valid CapabilityPolicy JSON object",
            ));
        }
    }
    const mc = values["max-commands"] ?? stated("PLURNK_CLIENT_MAX_COMMANDS", env);
    if (mc !== undefined) {
        const n = Number(mc);
        if (!Number.isInteger(n) || n < 1) {
            throw new ProblemError(clientFlagInvalid("--max-commands", mc, "must be a positive integer"));
        }
        settings.maxCommands = n;
    }
    if (values["no-git"] === true || switchOf("PLURNK_CLIENT_NO_GIT", "optional", env)) settings.git = false;
    const fi = values["files-items"] ?? stated("PLURNK_CLIENT_FILES_ITEMS", env);
    if (fi !== undefined) {
        const n = Number(fi);
        if (!Number.isInteger(n) || n < -1) {
            throw new ProblemError(clientFlagInvalid("--files-items", fi, "must be -1 (full), 0 (off), or a positive integer"));
        }
        settings.filesItems = n;
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
// every other provider).
// #71 — one id per FRONTEND, name/version form, workspace-stable. CLI and TUI are
// distinct frontends of this package;
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
    mcpConfiguration: Readonly<Record<string, string>>;
}

// Dispatch a positional-driven subcommand over the action surface. Returns the
// exit code the dispatcher should propagate.
const runSubcommand = async (rpc: Caller, positionals: string[], opts: SubcommandOpts): Promise<number> => {
    const verb = positionals[0];
    const sub = positionals[1];

    if (verb === "models") {
        const offset = parseIntFlag(opts.values.offset as string | undefined, "--offset");
        const limit = parseIntFlag(opts.values.limit as string | undefined, "--limit");
        if (limit !== undefined && (limit < 1 || limit > 100)) {
            throw new ProblemError(clientFlagInvalid("--limit", String(limit), "must be between 1 and 100 for models"));
        }
        const search = positionals.slice(1).join(" ").trim();
        return await runModels(rpc, {
            json: opts.json,
            query: {
                ...(typeof opts.values.provider === "string" ? { provider: opts.values.provider } : {}),
                ...(search.length > 0 ? { search } : {}),
                ...(opts.values.all === true ? { availability: "all" as const } : {}),
                ...(offset !== undefined ? { offset } : {}),
                ...(limit !== undefined ? { limit } : {}),
            },
        });
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

    if (verb === "mcp") {
        if (opts.workspaceName === undefined) {
            throw new ProblemError(clientFlagMissingDependency(
                "plurnk mcp",
                "--workspace (or PLURNK_CLIENT_WORKSPACE)",
            ));
        }
        const result = await handleMcp(
            positionals.slice(1),
            rpc,
            opts.json ? () => undefined : (text) => process.stdout.write(text),
            { overlay: opts.mcpConfiguration },
        );
        if (result === null) return 64;
        if (opts.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    }

    if (verb === "effort") {
        if (opts.workspaceName === undefined) {
            throw new ProblemError(clientFlagMissingDependency(
                "plurnk effort",
                "--workspace (or PLURNK_CLIENT_WORKSPACE)",
            ));
        }
        if (positionals.length > 2) {
            throw new ProblemError(clientSubcommandUnknownVerb(`effort ${positionals.slice(1).join(" ")}`));
        }
        const effort = sub === undefined
            ? await readWorkerEffort(rpc)
            : await setWorkerEffort(rpc, sub);
        process.stdout.write(opts.json
            ? `${JSON.stringify(effort)}\n`
            : formatWorkerEffort(effort));
        return 0;
    }

    if (verb === "capabilities") {
        if (opts.workspaceName === undefined) {
            throw new ProblemError(clientFlagMissingDependency(
                "plurnk capabilities",
                "--workspace (or PLURNK_CLIENT_WORKSPACE)",
            ));
        }
        if (positionals.length > 2) {
            throw new ProblemError(clientSubcommandUnknownVerb(`capabilities ${positionals.slice(1).join(" ")}`));
        }
        const projection = sub === undefined
            ? await rpc.call("workspace.capabilities.get") as Record<string, CapabilityPolicy>
            : await rpc.call("workspace.capabilities.set", {
                policy: parseCapabilityPolicy("capabilities", sub),
            }) as Record<string, CapabilityPolicy>;
        process.stdout.write(opts.json
            ? `${JSON.stringify(projection)}\n`
            : formatCapabilityProjection(projection));
        return 0;
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
        const workerId = await resolveWorkerId(rpc, opts.workerName);
        const filters: LogReadFilters = { ...(workerId === undefined ? {} : { workerId }) };
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
    const lifetime = new Lifetime();
    try { await dispatch(argv, lifetime); }
    catch (cause) {
        if (lifetime.interrupted) return;
        if (!(cause instanceof ClientExit)) throw cause;
        process.exitCode = cause.code;
    } finally { await lifetime.close(); }
};

const dispatch = async (argv: string[], lifetime: Lifetime): Promise<void> => {
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
            effort: { type: "string" },
            autostart: { type: "string" },
            "daemon-timeout-ms": { type: "string" },
            "daemon-stop-timeout-ms": { type: "string" },
            "service-bin": { type: "string" },
            "project-root": { type: "string" },
            yolo: { type: "boolean" },
            auto: { type: "boolean" },
            proposals: { type: "string" },
            // Retired; parsed only to be refused with its successors named.
            policy: { type: "string" },
            reasoning: { type: "string" },
            capabilities: { type: "string" },
            "max-turns": { type: "string" },
            timeout: { type: "string" },
            // workspace-open settings (svc#231) + tighten-only ceilings (svc#232)
            "files-items": { type: "string" },
            "preview-lines": { type: "string" },
            "history-entries": { type: "string" },
            color: { type: "string" },

            "max-commands": { type: "string" },
            "no-git": { type: "boolean" },
            "status-stream": { type: "boolean" },
            share: { type: "string" },
            // log read filters
            loop: { type: "string" },
            turn: { type: "string" },
            since: { type: "string" },
            limit: { type: "string" },
            provider: { type: "string" },
            all: { type: "boolean" },
            offset: { type: "string" },
            width: { type: "string" },
            // Browser-portal listener options. All session and loop options above
            // retain this client's canonical interpretation in `plurnk web`.
            host: { type: "string" },
            port: { type: "string" },
        },
    });

    // Apply an explicit presentation choice before any invocation diagnostic can render.
    if (values.color !== undefined) process.env.PLURNK_CLIENT_COLOR = values.color;
    if (values["history-entries"] !== undefined) process.env.PLURNK_CLIENT_HISTORY_ENTRIES = values["history-entries"];
    if (values.autostart !== undefined) process.env.PLURNK_CLIENT_AUTOSTART = values.autostart;
    if (values["daemon-timeout-ms"] !== undefined) process.env.PLURNK_CLIENT_DAEMON_TIMEOUT_MS = values["daemon-timeout-ms"];
    if (values["daemon-stop-timeout-ms"] !== undefined) process.env.PLURNK_CLIENT_DAEMON_STOP_TIMEOUT_MS = values["daemon-stop-timeout-ms"];
    if (values["service-bin"] !== undefined) process.env.PLURNK_CLIENT_SERVICE_BIN = values["service-bin"];
    const web = positionals[0] === "web";
    if (values.help) {
        process.stdout.write(commandHelp(positionals[0]));
        return;
    }
    if (positionals[0] === "completion") {
        try {
            const files = new Map([["bash", "plurnk.bash"], ["zsh", "_plurnk"], ["fish", "plurnk.fish"]]);
            const file = files.get(positionals[1] ?? "");
            if (positionals.length !== 2 || file === undefined) {
                throw new ProblemError(clientSubcommandUnknownVerb(positionals.join(" "), ["completion bash", "completion zsh", "completion fish"]));
            }
            process.stdout.write(await readFile(new URL(`../completions/${file}`, import.meta.url), "utf8"));
            return;
        } catch (cause) {
            if (cause instanceof ProblemError) dieWith(cause.exitCode, cause.problem);
            dieWith(1, clientRuntimeError(cause));
        }
    }
    if (positionals[0] === "render") {
        try {
            if (positionals.length > 1) {
                throw new ProblemError(clientSubcommandUnknownVerb(`render ${positionals.slice(1).join(" ")}`));
            }
            const source = await readStdin();
            const rendered = await renderDocument(source, resolveRenderWidth(values.width));
            if (rendered.length > 0) process.stdout.write(`${rendered}\n`);
            process.exitCode = 0;
            return;
        } catch (cause) {
            if (cause instanceof ProblemError) dieWith(cause.exitCode, cause.problem);
            dieWith(1, clientRuntimeError(cause));
        }
    }
    const buildInfo = await getBuildInfo();
    if (values.version) {
        process.stdout.write(`${formatBuildInfo(buildInfo)}\n`);
        return;
    }

    // Shared XDG user env cascade (after parse so --env-file flags participate).
    loadEnvCascade(orderedEnvFiles(argv.slice(2)));
    // {§cli-env-defaults} — a flag is a knob's spelling for one invocation: the resolved preview
    // count is written back to its knob, the one place every renderer reads it ({plurnk#107}).
    const previewLinesRaw = values["preview-lines"] ?? stated("PLURNK_CLIENT_PREVIEW_LINES") ?? "";
    const previewLines = Number(previewLinesRaw);
    if (previewLinesRaw.length === 0 || !Number.isInteger(previewLines) || previewLines < 0) {
        dieWith(64, clientFlagInvalid("--preview-lines", previewLinesRaw, "must be a non-negative integer"));
    }
    process.env.PLURNK_CLIENT_PREVIEW_LINES = String(previewLines);
    const mcpConfiguration = collectMcpConfiguration(process.env);

    // json OUTPUT MODE — flag or env (user-level, same name client+daemon would
    // read). One complete document on stdout, stderr silent, structured errors.
    const json = values.json === true || switchOf("PLURNK_CLIENT_JSON", "optional");
    try {
        Knobs.count("PLURNK_CLIENT_HISTORY_ENTRIES");
    } catch (cause) {
        if (!(cause instanceof KnobError)) throw cause;
        const problem = clientFlagInvalid(values["history-entries"] === undefined ? cause.knob : "--history-entries", cause.value, cause.message);
        if (json) dieJson(64, problem);
        dieWith(64, problem);
    }
    const color = Knobs.text("PLURNK_CLIENT_COLOR");
    if (!isColorMode(color)) {
        const problem = clientFlagInvalid(values.color === undefined ? "PLURNK_CLIENT_COLOR" : "--color", color, "must be always, auto, or never");
        if (json) dieJson(64, problem);
        dieWith(64, problem);
    }
    if (!web && (values.host !== undefined || values.port !== undefined)) {
        const flag = values.host !== undefined ? "--host" : "--port";
        const problem = clientFlagMissingDependency(flag, "the web subcommand");
        if (json) dieJson(64, problem);
        dieWith(64, problem);
    }
    if (!json && !web) process.stderr.write(`plurnk: ${formatBuildInfo(buildInfo)}\n`);

    // State-command routing happens BEFORE prompt assembly, so inspection and
    // deliberate configuration never consume stdin or become model prompts.
    const subcommand = positionals[0];
    const isSubcommand = subcommand !== undefined && subcommandNames.has(subcommand);

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
        if (prompt.length === 0 && process.stdin.isTTY !== true) {
            const problem = clientProblem("usage", "prompt-required", 400, "Provide a prompt or use an interactive terminal.");
            if (json) dieJson(64, problem);
            dieWith(64, problem);
        }
    }

    // Client flags select client behavior. Provider defaults remain daemon-owned.
    const workspaceName = values.workspace ?? process.env.PLURNK_CLIENT_WORKSPACE;
    const workerName = values.worker ?? process.env.PLURNK_CLIENT_WORKER;
    const modelSelector = values.model ?? stated("PLURNK_CLIENT_MODEL");
    const effort = values.effort ?? stated("PLURNK_CLIENT_EFFORT");
    const yolo = values.yolo === true || switchOf("PLURNK_CLIENT_YOLO", "live");
    const shareRaw = values.share ?? stated("PLURNK_CLIENT_SHARE");
    const shareTarget = shareRaw === undefined ? undefined : shareFolder(shareRaw);
    if (!web && workerName !== undefined && workspaceName === undefined) {
        dieWith(64, clientFlagMissingDependency("--worker (or PLURNK_CLIENT_WORKER)", "--workspace (or PLURNK_CLIENT_WORKSPACE)"));
    }

    // {§cli-loop-policy} — one flag per choice; a prompt prefix states review immediately before its run.
    let loopPolicy!: LoopPolicyRequest;
    let maxTurns: number | undefined;
    let timeoutSec: number | undefined;
    try {
        if (values.policy !== undefined) {
            throw new ProblemError(clientFlagInvalid("--policy", values.policy, "--policy was retired; state --proposals <review|accept|reject> and --auto"));
        }
        if (values.reasoning !== undefined) {
            throw new ProblemError(clientFlagInvalid("--reasoning", values.reasoning, "--reasoning was renamed to --effort"));
        }
        const auto = values.auto === true || switchOf("PLURNK_CLIENT_AUTO", "live");
        loopPolicy = resolveLoopPolicy(values.proposals ?? process.env.PLURNK_CLIENT_PROPOSALS, auto);
        maxTurns = parseIntFlag(values["max-turns"] ?? stated("PLURNK_CLIENT_MAX_TURNS"), "--max-turns");
        timeoutSec = parseIntFlag(values.timeout ?? stated("PLURNK_CLIENT_TIMEOUT"), "--timeout");
    } catch (cause) {
        if (cause instanceof ProblemError) dieWith(cause.exitCode, cause.problem);
        dieWith(64, clientRuntimeError(cause));
    }

    const projectRootRaw = values["project-root"] ?? process.env.PLURNK_CLIENT_PROJECT_ROOT;
    const projectRoot: string | null = (() => {
        try { return resolveProjectRoot(projectRootRaw); }
        catch (cause) {
            if (cause instanceof ProblemError) return dieWith(cause.exitCode, cause.problem);
            return dieWith(64, clientRuntimeError(cause));
        }
    })();

    const configuredUrl = stated("PLURNK_AGUI_URL") ?? `http://${Knobs.text("PLURNK_HOST")}:${Knobs.text("PLURNK_PORT")}`;
    let backend: Backend;
    try {
        backend = await lifetime.own(Backend.open({ bridgeUrl: configuredUrl, token: process.env.PLURNK_AGUI_TOKEN }));
    } catch (cause) {
        if (lifetime.interrupted) return;
        const flag = cause instanceof KnobError ? cause.knob.replace(/^PLURNK_CLIENT_/u, "").toLowerCase().replaceAll("_", "-") : "";
        const problem = cause instanceof ProblemError ? cause.problem : cause instanceof KnobError
            ? clientFlagInvalid(Object.hasOwn(values, flag) ? `--${flag}` : cause.knob, cause.value, cause.message)
            : clientRuntimeError(cause);
        const code = cause instanceof ProblemError ? cause.exitCode : cause instanceof KnobError ? 64 : 1;
        if (json) dieJson(code, problem);
        return dieWith(code, problem);
    }
    const { bridgeUrl, token } = backend.target;
    if (backend.database !== null && !json) {
        report({
            source: "client:daemon", kind: "started", level: "info",
            message: `Private backend; data retained at ${backend.database}`,
            ...(backend.allocatedStorage && !isSubcommand && prompt.length === 0 ? {
                hints: [
                    "Use the resume command printed on exit to return to this session.",
                    "https://github.com/plurnk/plurnk#service",
                ],
            } : {}),
        });
    }
    let workspaceOptionsPromise: Promise<{ projectRoot: string | null; settings: Settings }> | undefined;
    const workspaceOptions = (): Promise<{ projectRoot: string | null; settings: Settings }> => {
        workspaceOptionsPromise ??= (async () => ({
            projectRoot,
            settings: await buildSettings(values as {
                "files-items"?: string;
                "max-commands"?: string;
                "no-git"?: boolean;
                capabilities?: string;
            }, process.env, web
                ? undefined
                : !isSubcommand && prompt.length === 0
                    ? CLIENT_ID_TUI
                    : CLIENT_ID_CLI),
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
        resolvedWorld = await resolveWorld(
            { bridgeUrl, token }, workspaceName, await workspaceOptions(),
        );
        return resolvedWorld;
    };
    if (web) {
        try {
            if (positionals.length > 1) {
                throw new ProblemError(clientSubcommandUnknownVerb(`web ${positionals.slice(1).join(" ")}`));
            }
            const workspaceProperties = await workspaceOptions();
            const target = { bridgeUrl, token };
            const prepared = new Map<string, Promise<void>>();
            const prepareSession = (
                session: { workspace: string; threadId: string },
                preparedWorkspaceProperties: Readonly<Record<string, unknown>>,
            ): Promise<void> => {
                const key = JSON.stringify([session.workspace, session.threadId]);
                const existing = prepared.get(key);
                if (existing !== undefined) return existing;
                const pending = (async () => {
                    // {§cli-effort} — a model and its effort are chosen together, so the daemon validates the pair once.
                    if (modelSelector !== undefined) {
                        await actionViaBridge(target, {
                            threadId: session.threadId,
                            workspace: session.workspace,
                            workspaceOptions: preparedWorkspaceProperties,
                            kind: "worker.model.set",
                            params: { selector: modelSelector, ...(effort === undefined ? {} : { effort }) },
                        });
                    } else if (effort !== undefined) {
                        await actionViaBridge(target, {
                            threadId: session.threadId,
                            workspace: session.workspace,
                            workspaceOptions: preparedWorkspaceProperties,
                            kind: "worker.effort.set",
                            params: { effort },
                        });
                    }
                })().catch((cause) => {
                    prepared.delete(key);
                    throw cause;
                });
                prepared.set(key, pending);
                return pending;
            };
            process.exitCode = await launchWeb({
                ...(typeof values.host === "string" ? { host: values.host } : {}),
                ...(typeof values.port === "string" ? { port: values.port } : {}),
                upstream: new URL(bridgeUrl),
                ...(token === undefined ? {} : { token }),
                constraints: {
                    ...(workspaceName === undefined ? {} : { workspace: workspaceName }),
                    ...(workerName === undefined ? {} : { threadId: workerName }),
                },
                workspaceProperties,
                runProperties: {
                    ...workspaceProperties,
                    policy: loopPolicy,
                    ...(maxTurns === undefined ? {} : { maxTurns }),
                },
                prepareSession,
                projectPrompt: (value) => {
                    const projected = promptPolicy(value, loopPolicy);
                    return {
                        prompt: projected.prompt,
                        runProperties: {
                            policy: projected.policy,
                            openPaths: extractOpenPaths(projected.prompt, projectRoot),
                        },
                    };
                },
                ...(timeoutSec === undefined ? {} : { timeoutSec }),
                mcpConfiguration,
                autoAcceptProposals: yolo,
            }, {
                announce: (origin) => process.stderr.write(`plurnk web: ${origin}\n`),
                wait: () => new Promise<void>((resolve) => {
                    const release = lifetime.handleSignals(() => { release(); resolve(); });
                }),
            });
        } catch (cause) {
            if (cause instanceof ProblemError) {
                report(cause.problem);
                process.exitCode = cause.exitCode;
            } else if (isUnreachable(cause)) {
                report(clientConnectionRefused(bridgeUrl, cause));
                process.exitCode = 1;
            } else {
                report(clientRuntimeError(cause));
                process.exitCode = 1;
            }
        }
        return;
    }
    if (bridgeUrl !== undefined && bridgeUrl.length > 0 && !isSubcommand && subcommand !== "script" && prompt.length > 0) {
        try {
            // Thread-per-worker (svc#366): --worker names the CONVERSATION (the threadId);
            // the world is --workspace, else a fresh daemon-minted workspace. Without --worker,
            // thread == world (the model worker).
            const w = await world();
            const controlWorkspaceOptions = await workspaceOptions();
            const { settings } = controlWorkspaceOptions;
            // {§worker-model-selection} — an explicit --model is a durable selection:
            // persist it onto the conversation worker before the run, then run WITHOUT
            // a per-loop model selector (the worker owns the model).
            let activeModel: ModelRoute | null;
            if (values.model !== undefined && modelSelector !== undefined) {
                activeModel = Validator.assertModelRoute(await actionViaBridge(
                    { bridgeUrl, token },
                    {
                        threadId: workerName ?? w,
                        workspace: w,
                        workspaceOptions: controlWorkspaceOptions,
                        kind: "worker.model.set",
                        params: { selector: modelSelector, ...(effort === undefined ? {} : { effort }) },
                    },
                ));
            } else {
                const projection = await actionViaBridge<{ model: unknown }>(
                    { bridgeUrl, token },
                    {
                        threadId: workerName ?? w,
                        workspace: w,
                        workspaceOptions: controlWorkspaceOptions,
                        kind: "worker.model.get",
                    },
                );
                activeModel = projection.model === null ? null : Validator.assertModelRoute(projection.model);
            }
            if (effort !== undefined && values.model === undefined) {
                await actionViaBridge({ bridgeUrl, token }, {
                    threadId: workerName ?? w,
                    workspace: w,
                    workspaceOptions: controlWorkspaceOptions,
                    kind: "worker.effort.set",
                    params: { effort },
                });
            }
            const projected = promptPolicy(prompt, loopPolicy);
            const openPaths = extractOpenPaths(projected.prompt, projectRoot);
            // A `?` prompt asks for review of this run; the request outranks the standing yolo setting.
            const reviewRequested = /^\s*\?/u.test(prompt);
            const code = await runCliViaBridge({ bridgeUrl, token }, projected.prompt, {
                lifetime,
                threadId: workerName ?? w,
                workspace: w,
                ...(activeModel === null ? {} : { modelLabel: formatRouteIdentity(activeModel) }),
                policy: projected.policy,
                ...(maxTurns !== undefined ? { maxTurns } : {}),
                ...(openPaths.length === 0 ? {} : { openPaths }),
                ...(timeoutSec !== undefined ? { timeoutSec } : {}),
                yolo: yolo && !reviewRequested,
                json,
                statusStream: values["status-stream"] === true || switchOf("PLURNK_CLIENT_STATUS_STREAM", "optional"),
                projectRoot,
                settings,
            });
            if (shareTarget !== undefined) {
                const shared = await actionViaBridge<ShareResult>({ bridgeUrl, token }, {
                    threadId: workerName ?? w,
                    workspace: w,
                    kind: "workspace.share",
                    params: { folder: shareTarget },
                });
                if (!json) process.stderr.write(`${formatShare(shared)}\n`);
            }
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

    // The transport owns the workspace binding; the TUI receives its name, not a fabricated database ID.
    if (bridgeUrl !== undefined && bridgeUrl.length > 0 && !isSubcommand && subcommand !== "script" && prompt.length === 0) {
        let transport: BridgeTransport | undefined;
        try {
            const w = await world();
            const threadId = workerName ?? w;
            const { settings } = await workspaceOptions();
            // Creation options are idempotent on an existing workspace; the
            // same public envelope is used whether the daemon named it or we did.
            transport = new BridgeTransport({ bridgeUrl, token }, threadId, {
                workspace: w,
                projectRoot,
                settings,
                descendants: true,   // {plurnk#108} — the TUI observes its delegation
            });
            const { runTui } = await import("./tui.ts");
            await runTui(transport, { name: w }, {
                lifetime,
                resumeEnv: backend.resumeEnv,
                modelSelector,
                modelExplicit: values.model !== undefined,
                effort,
                effortExplicit: effort !== undefined,
                yolo,
                loopPolicy,
                maxTurns,
                projectRoot,
                workerName,
                client: CLIENT_ID_TUI,
                mcpConfiguration,
            });
            if (shareTarget !== undefined) {
                const shared = await actionViaBridge<ShareResult>({ bridgeUrl, token }, {
                    threadId,
                    workspace: w,
                    kind: "workspace.share",
                    params: { folder: shareTarget },
                });
                process.stderr.write(`${formatShare(shared)}\n`);
            }
            process.exitCode = 0;
            return;
        } catch (cause) {
            transport?.shutdown();
            if (cause instanceof ProblemError) dieWith(cause.exitCode, cause.problem);
            if (isUnreachable(cause)) dieWith(1, clientConnectionRefused(bridgeUrl, cause));
            dieWith(1, clientRuntimeError(cause));
        }
    }

    // AG-UI+ is the ONLY wire (the WS transport is deleted). Subcommands + script
    // speak the action surface through a structural Caller.
    const target = { bridgeUrl, token };
    const callerThread = workerName ?? workspaceName ?? "cli";
    const caller = {
        call: (method: string, params?: object) => actionViaBridge<unknown>(target, {
            threadId: callerThread,
            ...(workspaceName !== undefined ? { workspace: workspaceName } : {}),
            kind: method,
            params,
        }),
    };

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
            const workspace = await world();
            const exitCode = await runScriptViaBridge(target, text, {
                threadId: workerName ?? workspace,
                workspace,
                yolo,
                json,
                ...await workspaceOptions(),
            });
            process.exitCode = exitCode;
            return;
        }

        if (isSubcommand) {
            const exitCode = await runSubcommand(caller, positionals, {
                json, workspaceName, workerName, projectRoot, values, mcpConfiguration,
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
            dieWith(cause.exitCode, cause.problem);
        }
        // A daemon-rejected RPC arrives as a typed RpcError carrying the failed
        // method and the daemon's code/message — surface it as client:rpc:error.
        // Nothing listening at all (subcommands, the TUI boot) gets the onboarding
        // block; any other genuine throw is the generic runtime fallback.
        if (isUnreachable(cause)) dieWith(1, clientConnectionRefused(bridgeUrl, cause));
        dieWith(1, clientRuntimeError(cause));
    }
};
