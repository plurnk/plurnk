// CLI entrypoint, option catalog, USAGE authority, and subcommand dispatcher ({§cli-invocation}, {§cli-env-defaults}).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
    runCliCapabilities,
    runCliCompletion,
    runCliConfig,
    runCliDeleteSession,
    runCliFamily,
    runCliForkSession,
    runCliListSessions,
    runCliLogRead,
    runCliModels,
    runCliNewSession,
    runCliPrompt,
    runCliReadCoord,
    runCliResumeSession,
    runCliScript,
    runCliWorkspace,
    runInteractiveSession,
    type CliCommonOptions,
} from "./cli-runner.ts";
import Credential from "./credential.ts";
import { assembleClientEnv, type CascadeFileSpec } from "./envdefaults.ts";
import { runRender } from "./render-filter.ts";

export const CLIENT_OPTIONS = {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    json: { type: "boolean" },
    workspace: { type: "string" },
    worker: { type: "string" },
    "tui-worker": { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    env: { type: "string", multiple: true },
    "env-inherit": { type: "string" },
    "env-exclude": { type: "string" },
    autostart: { type: "string" },
    "daemon-timeout-ms": { type: "string" },
    "oauth-timeout-ms": { type: "string" },
    "cancel-grace-ms": { type: "string" },
    "service-bin": { type: "string" },
    "project-root": { type: "string" },
    yolo: { type: "boolean" },
    auto: { type: "boolean" },
    bell: { type: "boolean" },
    capabilities: { type: "string" },
    "env-file": { type: "string", multiple: true },
    "env-file-if-exists": { type: "string", multiple: true },
    "max-turns": { type: "string" },
    timeout: { type: "string" },
    "files-items": { type: "string" },
    "preview-lines": { type: "string" },
    "history-entries": { type: "string" },
    "mermaid-timeout-ms": { type: "string" },
    color: { type: "string" },
    "max-commands": { type: "string" },
    "status-stream": { type: "boolean" },
    share: { type: "string" },
    "no-git": { type: "boolean" },
    loop: { type: "string" },
    turn: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
    provider: { type: "string" },
    all: { type: "boolean" },
    offset: { type: "string" },
    width: { type: "string" },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

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
       plurnk completion <bash|zsh|fish>
       <markdown stdin> | plurnk render [--width <columns>]
       plurnk mcp [subcommand]
       plurnk skills [subcommand]
       plurnk members [subcommand]
       plurnk env [--scope worker|workspace] [subcommand]
       plurnk schedule [subcommand]

Connects to plurnk-service at its configured address, starting the installed service there when nothing listens; it keeps running after this client (plurnk-service stop ends it). Run a single prompt one-shot (positional args, piped stdin, or both — positionals come first, stdin is appended after a blank line). With no positionals and a TTY stdin, enters the scrollback-native interactive terminal. Read-only subcommands (models / workspace list / log read / read <coord>) inspect daemon state without running a loop.

env (cascade, low → high: packaged .env.defaults < $XDG_CONFIG_HOME/plurnk/.env
     < repeated --env-file flags (last wins) < shell):
                        Works with no config at all.
  PLURNK_CLIENT_*       every option below is one knob's spelling for one invocation:
                        --max-turns is PLURNK_CLIENT_MAX_TURNS, --no-git is
                        PLURNK_CLIENT_NO_GIT. The packaged .env.defaults declares and
                        documents them all; the option wins when both are given.
  PLURNK_HOST, PLURNK_PORT
                        the daemon's address, under the daemon's own key names.
  PLURNK_ACP_URL       the whole URL instead, when the daemon is reached through a
                        remote ACP portal.
  PLURNK_SECRET         the operator's client secret, exchanged at the daemon for access
                        tokens; unset, the client reads the secret a daemon running as
                        you minted beside its database, or signs in through the browser.
  PLURNK_CLIENT_AUTOSTART
                        1 (default): start the installed service on local
                        connection refusal and leave it running. 0: attach only.
                        Explicit ACP URLs and remote hosts are always attach-only.

options:
  -h, --help              print this message and exit
  -v, --version           print executable provenance and exit
      --json              json OUTPUT MODE: one complete structured document on
                          stdout (the whole client-observed record — turns/ops,
                          notices, the answer at .response, usage), Problems emitted
                          under "problem". Interactive OAuth instructions go to stderr. Drill into one
                          op's content with: plurnk read <coord> --json. CLI only.
      --workspace <name>    resume the named workspace, or create it under that name
                          if none exists (attach-or-create). Defaults to the launch
                          directory, home-shortened with ~.
                          Overrides PLURNK_CLIENT_WORKSPACE.
      --worker <name>        resume (or create) the named worker within the workspace.
                          Overrides PLURNK_CLIENT_WORKER. Unset, the TUI binds
                          --tui-worker and a one-shot a new worker of its own.
      --tui-worker <name>  the worker the TUI binds when no worker is selected.
                          Overrides PLURNK_CLIENT_TUI_WORKER (user).
      --model <selector>  persistently select the worker's model
                          before the first loop (session/set_config_option). A selector is
                          a declared alias or exact provider/model route. Without
                          this, the worker's durable model or the daemon's
                          boot-time default runs.
      --effort <level>    persistently select the worker's effort before
                          the first loop; with --model, the two are chosen together.
                          The daemon validates it against the parent and child models.
      --env <NAME>[=<value>]
                          persistently set <NAME> on the worker before the first loop
                          (worker.env.replace); without =, carry <NAME> from this
                          environment when set. Repeatable. Overrides
                          PLURNK_CLIENT_ENV_<NAME>.
      --env-inherit <list>
                          comma-separated variable names or trailing-* prefix globs
                          carried from this environment onto the worker before the
                          first loop. Overrides PLURNK_CLIENT_ENV_INHERIT.
      --env-exclude <list>
                          comma-separated variable names or trailing-* prefix globs
                          removed from what --env-inherit carries. Overrides
                          PLURNK_CLIENT_ENV_EXCLUDE.
      --autostart <0|1>   start the installed service when nothing listens at the
                          configured address (1), or require attachment (0).
      --daemon-timeout-ms <n> positive connection/startup deadline in milliseconds.
      --oauth-timeout-ms <n> positive browser OAuth callback deadline in milliseconds.
      --cancel-grace-ms <n> positive grace after session/cancel before hanging up on the run, in milliseconds.
      --service-bin <p>   select an installed service entrypoint instead of discovery.
      --project-root <p>  absolute path. Sent on workspace.create only; ignored
                          on --workspace attach (daemon preserves stored value).
                          Default: cwd (asks when home). Without --workspace the
                          daemon names the workspace after it. Empty string =
                          headless and needs --workspace. Overrides
                          PLURNK_CLIENT_PROJECT_ROOT.
      --yolo              auto-accept every proposal locally without prompting.
                          On by default; Shift-Tab toggles it for the session.
                          Overrides PLURNK_CLIENT_YOLO.
      --auto              nobody is attending: the daemon asks nothing, and a loop
                          that would wait for a person concludes instead. Approval
                          stays local (--yolo). Overrides PLURNK_CLIENT_AUTO.
      --bell              ring the terminal bell when you are needed: the bound
                          worker's loop replies, stops or fails, or a review or
                          question waits for you. Overrides PLURNK_CLIENT_BELL.
      --capabilities <json>
                          CapabilityPolicy JSON applied when creating the workspace.
      --env-file <p>      load env from <p> (errors if missing). Repeatable.
      --env-file-if-exists <p>  same, but silently skip a missing file. Repeatable.
      --max-turns <n>     model-call budget for the prompt's worker tree: its turns, its
                          descendants' turns and every BARE call (else the daemon's ceiling).
      --timeout <s>       cancel each prompt loop (session/cancel) after <s> seconds;
                          CLI exits 3 with "timedOut":true.
      --files-items <n>   turn-0 tracked-file preview: -1 full / 0 off / N first-N.
                          Create-time workspace setting.
      --preview-lines <n> lines of each operation body and execution output shown
                          beneath its row; the rest is named by its address. Overrides
                          PLURNK_CLIENT_PREVIEW_LINES.
      --history-entries <n> recent entries restored when the TUI opens or switches a
                          workspace or worker; 0 hides history. Overrides PLURNK_CLIENT_HISTORY_ENTRIES.
      --mermaid-timeout-ms <n> total positive rendering deadline per diagram in milliseconds.
                          Overrides PLURNK_CLIENT_MERMAID_TIMEOUT_MS.
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

subcommands:
  models [search...]      list the bounded daemon model catalog (models.list)
  workspace list            list workspaces on the daemon (workspace.list)
  workspace workers <name>  list workers in the named workspace (workspace.workers)
  workspace rename <a> <b>  rename workspace <a> to <b> (workspace.rename — a workspace's
                          name is a mutable handle; workers are immutable)
  log read --workspace ...  read log entries from the named workspace's worker
  read <loop/turn/op>     inspect one log row in the selected workspace/worker
  effort [level]          inspect or set a worker's effort
  capabilities [json]    inspect the capability cascade or set the workspace policy
  render                  project Markdown stdin as width-bounded plain Unicode;
                          local only: no daemon, config cascade, or startup output
  completion <shell>      print the packaged Bash, Zsh, or Fish completion script;
                          local only: writes stdout, never installs files
  login                   sign in to the daemon through the browser and keep the grant
                          under $XDG_STATE_HOME/plurnk; a kept grant renews itself
  logout                  revoke the kept grant at the daemon and forget it
  mcp ...                   List or manage this workspace's MCP servers.
  skills ...                List or manage this workspace's Agent Skills.
  members ...               List or manage this workspace's file members.
  env ...                   Manage worker overrides or shared workspace environment defaults.
  schedule ...              List or manage this workspace's scheduled messages.
                          For family commands, put client options before the family name;
                          everything after it belongs to the family, including server flags.
  script <file.plk>       run a .plk file: feed its DSL to op.parse, render the
                          trace, exit by worst op status. Honors --workspace/--yolo
                          /--project-root + workspace-open settings. The daemon owns the
                          grammar; the client just feeds the file.
`;

const FAMILY_COMMANDS = new Set(["mcp", "skills", "members", "env", "schedule"]);

const readVersion = (): string => {
    try {
        const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        const buildInfoPath = resolve(root, "dist", "build-info.json");
        try {
            const info = JSON.parse(readFileSync(buildInfoPath, "utf8")) as {
                version?: string;
                revision?: string;
            };
            if (info.version) {
                return info.revision ? `${info.version} (${info.revision.slice(0, 7)})` : info.version;
            }
        } catch {
            // fallback to package.json
        }
        const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
            version?: string;
        };
        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
};

const readStdinAll = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
};

const isTruthyEnv = (val: string | undefined): boolean =>
    val === "1" || val === "true" || val === "yes" || val === "on";

const collectWorkerEnv = (
    env: Record<string, string>,
    flagEnvs: readonly string[],
    inheritSpec: string | undefined,
    excludeSpec: string | undefined,
): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(env)) {
        if (key.startsWith("PLURNK_CLIENT_ENV_") && key !== "PLURNK_CLIENT_ENV_INHERIT" && key !== "PLURNK_CLIENT_ENV_EXCLUDE") {
            const targetKey = key.slice("PLURNK_CLIENT_ENV_".length);
            if (targetKey.length > 0) out[targetKey] = val;
        }
    }
    const matchesPattern = (name: string, pattern: string): boolean => {
        if (pattern.endsWith("*")) {
            return name.startsWith(pattern.slice(0, -1));
        }
        return name === pattern;
    };
    if (inheritSpec && inheritSpec.trim().length > 0) {
        const includePatterns = inheritSpec.split(",").map((s) => s.trim()).filter(Boolean);
        const excludePatterns = (excludeSpec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        for (const [k, v] of Object.entries(env)) {
            if (includePatterns.some((p) => matchesPattern(k, p)) && !excludePatterns.some((p) => matchesPattern(k, p))) {
                out[k] = v;
            }
        }
    }
    for (const entry of flagEnvs) {
        const eq = entry.indexOf("=");
        if (eq > 0) {
            out[entry.slice(0, eq)] = entry.slice(eq + 1);
        } else if (entry.length > 0 && env[entry] !== undefined) {
            out[entry] = env[entry]!;
        }
    }
    return out;
};

export const main = async (argv: readonly string[] = process.argv): Promise<void> => {
    const rawArgs = argv.slice(2);

    // Split before family command if present ({§cli-family-arguments})
    let clientArgs = [...rawArgs];
    let familyName: string | undefined;
    let familyArgs: string[] = [];

    for (let i = 0; i < rawArgs.length; i += 1) {
        const token = rawArgs[i]!;
        if (token === "--") break;
        if (token.startsWith("-")) {
            if (
                !token.includes("=") &&
                token !== "-h" &&
                token !== "--help" &&
                token !== "-v" &&
                token !== "--version" &&
                token !== "--json" &&
                token !== "--yolo" &&
                token !== "--no-yolo" &&
                token !== "--auto" &&
                token !== "--bell" &&
                token !== "--status-stream" &&
                token !== "--no-git" &&
                token !== "--all"
            ) {
                i += 1;
            }
            continue;
        }
        if (FAMILY_COMMANDS.has(token)) {
            clientArgs = rawArgs.slice(0, i);
            familyName = token;
            familyArgs = rawArgs.slice(i + 1);
        }
        break;
    }

    const parsed = parseArgs({
        args: clientArgs,
        allowPositionals: true,
        allowNegative: true,
        strict: false,
        options: CLIENT_OPTIONS,
    });

    if (parsed.values.help === true && familyName === undefined) {
        process.stdout.write(USAGE);
        return;
    }

    if (parsed.values.version === true && familyName === undefined) {
        process.stdout.write(`${readVersion()}\n`);
        return;
    }

    const positionals = parsed.positionals;
    const first = familyName ?? positionals[0];

    // Local-only subcommands require no daemon or env cascade ({§cli-render-filter})
    if (first === "render") {
        const defaultWidth = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
        const width = typeof parsed.values.width === "string"
            ? Number.parseInt(parsed.values.width, 10)
            : defaultWidth;
        if (!Number.isInteger(width) || width < 1) {
            process.stderr.write("plurnk render: --width must be a positive integer.\n");
            process.exitCode = 64;
            return;
        }
        process.exitCode = await runRender(width);
        return;
    }

    if (first === "completion") {
        process.exitCode = runCliCompletion(positionals[1]);
        return;
    }

    const cascadeFiles: CascadeFileSpec[] = [];
    const envFiles = Array.isArray(parsed.values["env-file"]) ? parsed.values["env-file"] : [];
    for (const f of envFiles) {
        if (typeof f === "string") cascadeFiles.push({ path: f, required: true });
    }
    const optionalEnvFiles = Array.isArray(parsed.values["env-file-if-exists"])
        ? parsed.values["env-file-if-exists"]
        : [];
    for (const f of optionalEnvFiles) {
        if (typeof f === "string") cascadeFiles.push({ path: f, required: false });
    }

    const env = assembleClientEnv(process.env, cascadeFiles);

    const host = env.PLURNK_HOST;
    const port = Number.parseInt(env.PLURNK_PORT, 10);
    const configuredAcpUrl = env.PLURNK_ACP_URL;
    const explicitAcpUrl = typeof configuredAcpUrl === "string" && configuredAcpUrl.trim().length > 0;
    const url = explicitAcpUrl ? configuredAcpUrl!.trim() : `http://${host}:${String(port)}/acp`;

    const workspace = typeof parsed.values.workspace === "string"
        ? parsed.values.workspace
        : env.PLURNK_CLIENT_WORKSPACE;
    const sessionId = typeof parsed.values.worker === "string"
        ? parsed.values.worker
        : env.PLURNK_CLIENT_WORKER;
    const tuiWorker = typeof parsed.values["tui-worker"] === "string"
        ? parsed.values["tui-worker"]
        : env.PLURNK_CLIENT_TUI_WORKER;
    const model = typeof parsed.values.model === "string"
        ? parsed.values.model
        : env.PLURNK_CLIENT_MODEL;
    const effort = typeof parsed.values.effort === "string"
        ? parsed.values.effort
        : env.PLURNK_CLIENT_EFFORT;
    const projectRoot = typeof parsed.values["project-root"] === "string"
        ? parsed.values["project-root"]
        : env.PLURNK_CLIENT_PROJECT_ROOT;
    const capabilitiesRaw = typeof parsed.values.capabilities === "string"
        ? parsed.values.capabilities
        : env.PLURNK_CLIENT_CAPABILITIES;
    const filesItemsRaw = typeof parsed.values["files-items"] === "string"
        ? parsed.values["files-items"]
        : env.PLURNK_CLIENT_FILES_ITEMS;
    const maxCommandsRaw = typeof parsed.values["max-commands"] === "string"
        ? parsed.values["max-commands"]
        : env.PLURNK_CLIENT_MAX_COMMANDS;
    const noGit = parsed.values["no-git"] === true || isTruthyEnv(env.PLURNK_CLIENT_NO_GIT);

    const workspaceSettings: Record<string, unknown> = {};
    if (capabilitiesRaw !== undefined && capabilitiesRaw.trim().length > 0) {
        try {
            workspaceSettings.capabilities = JSON.parse(capabilitiesRaw);
        } catch {
            // ignore invalid JSON here; server validates if needed
        }
    }
    if (filesItemsRaw !== undefined && filesItemsRaw.trim().length > 0) {
        workspaceSettings.filesItems = Number.parseInt(filesItemsRaw, 10);
    }
    if (maxCommandsRaw !== undefined && maxCommandsRaw.trim().length > 0) {
        workspaceSettings.maxCommands = Number.parseInt(maxCommandsRaw, 10);
    }
    if (noGit) {
        workspaceSettings.noGit = true;
    }

    const inheritSpec = typeof parsed.values["env-inherit"] === "string"
        ? parsed.values["env-inherit"]
        : env.PLURNK_CLIENT_ENV_INHERIT;
    const excludeSpec = typeof parsed.values["env-exclude"] === "string"
        ? parsed.values["env-exclude"]
        : env.PLURNK_CLIENT_ENV_EXCLUDE;
    const flagEnvs = Array.isArray(parsed.values.env)
        ? parsed.values.env.filter((x): x is string => typeof x === "string")
        : [];
    const workerEnv = collectWorkerEnv(env, flagEnvs, inheritSpec, excludeSpec);

    const autostartRaw = typeof parsed.values.autostart === "string"
        ? parsed.values.autostart
        : env.PLURNK_CLIENT_AUTOSTART;
    const autostart = autostartRaw !== "0" && autostartRaw !== "false";

    const daemonTimeoutMs = Number.parseInt(
        typeof parsed.values["daemon-timeout-ms"] === "string"
            ? parsed.values["daemon-timeout-ms"]
            : env.PLURNK_CLIENT_DAEMON_TIMEOUT_MS,
        10,
    );
    const oauthTimeoutMs = Number.parseInt(
        typeof parsed.values["oauth-timeout-ms"] === "string"
            ? parsed.values["oauth-timeout-ms"]
            : env.PLURNK_CLIENT_OAUTH_TIMEOUT_MS,
        10,
    );
    const cancelGraceMs = Number.parseInt(
        typeof parsed.values["cancel-grace-ms"] === "string"
            ? parsed.values["cancel-grace-ms"]
            : env.PLURNK_CLIENT_CANCEL_GRACE_MS,
        10,
    );
    const serviceBin = typeof parsed.values["service-bin"] === "string"
        ? parsed.values["service-bin"]
        : env.PLURNK_CLIENT_SERVICE_BIN;

    const yolo = typeof parsed.values.yolo === "boolean"
        ? parsed.values.yolo
        : env.PLURNK_CLIENT_YOLO !== "0" && env.PLURNK_CLIENT_YOLO !== "false";
    const auto = parsed.values.auto === true || isTruthyEnv(env.PLURNK_CLIENT_AUTO);
    const bell = parsed.values.bell === true || isTruthyEnv(env.PLURNK_CLIENT_BELL);
    const json = parsed.values.json === true || isTruthyEnv(env.PLURNK_CLIENT_JSON);
    const statusStream = parsed.values["status-stream"] === true || isTruthyEnv(env.PLURNK_CLIENT_STATUS_STREAM);
    const shareFolder = typeof parsed.values.share === "string"
        ? parsed.values.share
        : env.PLURNK_CLIENT_SHARE;

    const maxTurnsRaw = typeof parsed.values["max-turns"] === "string"
        ? parsed.values["max-turns"]
        : env.PLURNK_CLIENT_MAX_TURNS;
    const maxTurns = maxTurnsRaw !== undefined && maxTurnsRaw.trim().length > 0
        ? Number.parseInt(maxTurnsRaw, 10)
        : undefined;

    const timeoutRaw = typeof parsed.values.timeout === "string"
        ? parsed.values.timeout
        : env.PLURNK_CLIENT_TIMEOUT;
    const timeoutSec = timeoutRaw !== undefined && timeoutRaw.trim().length > 0
        ? Number.parseFloat(timeoutRaw)
        : undefined;

    const previewLines = Number.parseInt(
        typeof parsed.values["preview-lines"] === "string"
            ? parsed.values["preview-lines"]
            : env.PLURNK_CLIENT_PREVIEW_LINES,
        10,
    );
    const historyEntries = Number.parseInt(
        typeof parsed.values["history-entries"] === "string"
            ? parsed.values["history-entries"]
            : env.PLURNK_CLIENT_HISTORY_ENTRIES,
        10,
    );
    const mermaidTimeoutMs = Number.parseInt(
        typeof parsed.values["mermaid-timeout-ms"] === "string"
            ? parsed.values["mermaid-timeout-ms"]
            : env.PLURNK_CLIENT_MERMAID_TIMEOUT_MS,
        10,
    );
    const color = typeof parsed.values.color === "string"
        ? parsed.values.color
        : env.PLURNK_CLIENT_COLOR;

    const common: CliCommonOptions = {
        url,
        explicitAcpUrl,
        host,
        port,
        credential: new Credential(env),
        env,
        cwd: process.cwd(),
        ...(workspace !== undefined && workspace.length > 0 ? { workspace } : {}),
        ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
        tuiWorker,
        ...(model !== undefined && model.length > 0 ? { model } : {}),
        ...(effort !== undefined && effort.length > 0 ? { effort } : {}),
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        ...(Object.keys(workspaceSettings).length > 0 ? { workspaceSettings } : {}),
        ...(Object.keys(workerEnv).length > 0 ? { workerEnv } : {}),
        ...(maxTurns !== undefined && Number.isInteger(maxTurns) ? { maxTurns } : {}),
        ...(timeoutSec !== undefined && Number.isFinite(timeoutSec) ? { timeoutSec } : {}),
        autostart,
        daemonTimeoutMs,
        oauthTimeoutMs,
        cancelGraceMs,
        ...(serviceBin !== undefined && serviceBin.length > 0 ? { serviceBin } : {}),
        yolo,
        auto,
        bell,
        json,
        statusStream,
        ...(shareFolder !== undefined && shareFolder.length > 0 ? { shareFolder } : {}),
        previewLines,
        historyEntries,
        mermaidTimeoutMs,
        color,
    };

    try {
        let exitCode = 0;

        if (familyName !== undefined) {
            exitCode = await runCliFamily(familyName, familyArgs, common);
        } else if (first === "session") {
            const sub = positionals[1] ?? "list";
            const targetId = positionals[2] ?? common.sessionId;
            switch (sub) {
                case "list":
                    exitCode = await runCliListSessions(common);
                    break;
                case "new":
                    exitCode = await runCliNewSession(common);
                    break;
                case "resume":
                    if (!targetId) {
                        process.stderr.write("plurnk session resume requires a <sessionId>.\n");
                        process.exitCode = 64;
                        return;
                    }
                    exitCode = await runCliResumeSession(targetId, common);
                    break;
                case "fork":
                    if (!targetId) {
                        process.stderr.write("plurnk session fork requires a <sessionId>.\n");
                        process.exitCode = 64;
                        return;
                    }
                    exitCode = await runCliForkSession(targetId, common);
                    break;
                case "delete":
                    if (!targetId) {
                        process.stderr.write("plurnk session delete requires a <sessionId>.\n");
                        process.exitCode = 64;
                        return;
                    }
                    exitCode = await runCliDeleteSession(targetId, common);
                    break;
                default:
                    process.stderr.write(`Unknown session subcommand: ${sub}\n`);
                    process.exitCode = 64;
                    return;
            }
        } else if (first === "config") {
            exitCode = await runCliConfig(positionals[1], positionals[2], common);
        } else if (first === "models") {
            const limitNum = typeof parsed.values.limit === "string"
                ? Number.parseInt(parsed.values.limit, 10)
                : undefined;
            const offsetNum = typeof parsed.values.offset === "string"
                ? Number.parseInt(parsed.values.offset, 10)
                : undefined;
            exitCode = await runCliModels(
                positionals.slice(1),
                {
                    ...(typeof parsed.values.provider === "string" ? { provider: parsed.values.provider } : {}),
                    ...(parsed.values.all === true ? { all: true } : {}),
                    ...(offsetNum !== undefined && Number.isInteger(offsetNum) ? { offset: offsetNum } : {}),
                    ...(limitNum !== undefined && Number.isInteger(limitNum) ? { limit: limitNum } : {}),
                },
                common,
            );
        } else if (first === "workspace") {
            exitCode = await runCliWorkspace(positionals[1], positionals[2], positionals[3], common);
        } else if (first === "log" && positionals[1] === "read") {
            const loopNum = typeof parsed.values.loop === "string" ? Number.parseInt(parsed.values.loop, 10) : undefined;
            const turnNum = typeof parsed.values.turn === "string" ? Number.parseInt(parsed.values.turn, 10) : undefined;
            const sinceNum = typeof parsed.values.since === "string" ? Number.parseInt(parsed.values.since, 10) : undefined;
            const limitNum = typeof parsed.values.limit === "string" ? Number.parseInt(parsed.values.limit, 10) : undefined;
            exitCode = await runCliLogRead(
                {
                    ...(loopNum !== undefined && Number.isInteger(loopNum) ? { loopId: loopNum } : {}),
                    ...(turnNum !== undefined && Number.isInteger(turnNum) ? { turnId: turnNum } : {}),
                    ...(sinceNum !== undefined && Number.isInteger(sinceNum) ? { sinceId: sinceNum } : {}),
                    ...(limitNum !== undefined && Number.isInteger(limitNum) ? { limit: limitNum } : {}),
                },
                common,
            );
        } else if (first === "read") {
            if (!positionals[1]) {
                process.stderr.write("plurnk read requires a <loop>/<turn>/<seq> coordinate.\n");
                process.exitCode = 64;
                return;
            }
            exitCode = await runCliReadCoord(positionals[1], common);
        } else if (first === "effort") {
            exitCode = await runCliConfig("thought_level", positionals[1], common);
        } else if (first === "capabilities") {
            exitCode = await runCliCapabilities(positionals[1], common);
        } else if (first === "script") {
            if (!positionals[1]) {
                process.stderr.write("plurnk script requires a <file.plk> path.\n");
                process.exitCode = 64;
                return;
            }
            exitCode = await runCliScript(positionals[1], common);
        } else {
            const positionalText = positionals.join(" ");
            const stdinText = !process.stdin.isTTY ? (await readStdinAll()).trim() : "";
            const promptText = positionalText.length > 0 && stdinText.length > 0
                ? `${positionalText}\n\n${stdinText}`
                : positionalText.length > 0
                    ? positionalText
                    : stdinText;

            if (promptText.length === 0) {
                if (process.stdin.isTTY) {
                    exitCode = await runInteractiveSession(common);
                } else {
                    process.stdout.write(USAGE);
                    return;
                }
            } else {
                exitCode = await runCliPrompt(promptText, common);
            }
        }

        if (exitCode !== 0) {
            process.exitCode = exitCode;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (common.json) {
            process.stdout.write(`${JSON.stringify({ problem: { detail: message } }, null, 2)}\n`);
        } else {
            process.stderr.write(`plurnk: ${message}\n`);
        }
        process.exitCode = 1;
    }
};
