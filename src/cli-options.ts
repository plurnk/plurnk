// CLI option catalog, USAGE authority, and cascading environment option assembly
// ({§cli-invocation}, {§cli-workspaces-and-sessions}, {§cli-model-selection}, {§cli-color-policy}).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParseArgsConfig } from "node:util";
import { ClientCliError, type CliCommonOptions } from "./cli-connection.ts";
import Credential from "./credential.ts";
import { assembleClientEnv, type CascadeFileSpec } from "./envdefaults.ts";

export const CLIENT_OPTIONS = {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    json: { type: "boolean" },
    workspace: { type: "string" },
    session: { type: "string" },
    "term-session": { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    persona: { type: "string" },
    "system-prompt": { type: "string" },
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
    repl: { type: "boolean" },
    "env-file": { type: "string", multiple: true },
    "env-file-if-exists": { type: "string", multiple: true },
    "max-turns": { type: "string" },
    "timeout-ms": { type: "string" },
    "files-items": { type: "string" },
    "preview-lines": { type: "string" },
    "history-entries": { type: "string" },
    "mermaid-timeout-ms": { type: "string" },
    color: { type: "string" },
    "max-commands": { type: "string" },
    share: { type: "string" },
    "no-git": { type: "boolean" },
    "debug-no-meta": { type: "boolean" },
    loop: { type: "string" },
    turn: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
    provider: { type: "string" },
    all: { type: "boolean" },
    offset: { type: "string" },
    width: { type: "string" },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

export const USAGE = `usage: plurnk [--json] [--workspace <name>] [--session <name>] [--model <selector>] [--effort <level>] [prompt...]
       <piped stdin> | plurnk [options] [prompt...]
       plurnk daemon [start|stop|restart|reload|status|config|...]
       plurnk update [--json]
       plurnk models [search...] [--provider <name>] [--all] [--offset <n>] [--limit <n>] [--json]
       plurnk workspace list [--json]
       plurnk workspace sessions <name> [--json]
       plurnk workspace rename <name> <newname> [--json]
       plurnk session [list|new|resume <id>|fork <id>|delete <id>] [--workspace <name>] [--json]
       plurnk config [<id> [<value>]] [--workspace <name>] [--session <name>] [--json]
       plurnk log read --workspace <name> [--session <name>]
                       [--loop <id>] [--turn <id>] [--since <id>] [--limit <n>] [--json]
       plurnk read <loop>/<turn>/<seq> --workspace <name> [--session <name>] [--json]
       plurnk effort [level] --workspace <name> [--session <name>] [--json]
       plurnk persona [name|none] --workspace <name> [--session <name>] [--json]
       plurnk script <file.plk> [options]
       plurnk completion <bash|zsh|fish>
       <markdown stdin> | plurnk render [--width <columns>]
       plurnk mcp [subcommand]
       plurnk skills [subcommand]
       plurnk members [subcommand]
       plurnk env [--scope session|workspace] [subcommand]
       plurnk schedule [subcommand]
       plurnk personas [subcommand]
       plurnk login [--json]
       plurnk logout [--json]

Connects to plurnk-service at its configured address, starting the installed service there when nothing listens; it keeps running after this client (plurnk daemon stop ends it). Run a single prompt one-shot (positional args, piped stdin, or both — positionals come first, stdin is appended after a blank line). With no positionals and a TTY stdin, enters the scrollback-native interactive terminal. Read-only subcommands (models / workspace list / log read / read <coord>) inspect daemon state without running a loop.

env (cascade, low → high: packaged .env.defaults < $XDG_CONFIG_HOME/plurnk/.env
     < $XDG_CONFIG_HOME/plurnk/.env.local < repeated --env-file flags (last wins) < shell):
                        Works with no config at all.
  PLURNK_CLIENT_*       every option below is one knob's spelling for one invocation:
                        --max-turns is PLURNK_CLIENT_MAX_TURNS, --no-git is
                        PLURNK_CLIENT_NO_GIT. The packaged .env.defaults declares and
                        documents them all; the option wins when both are given.
  PLURNK_HOST, PLURNK_PORT
                        the daemon's address, under the daemon's own key names.
  PLURNK_ACP_URL       the whole URL instead, when the daemon is reached through a
                        remote ACP portal.
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
      --session <name>       resume (or create) the named session within the workspace.
                          Overrides PLURNK_CLIENT_SESSION. Unset, Term binds
                          --term-session and a one-shot opens a new session of its own.
      --term-session <name> the session Term binds when no session is selected.
                          Overrides PLURNK_CLIENT_TERM_SESSION (session1).
      --model <selector>  persistently select the session's model
                          before the first loop (session/set_config_option). A selector is
                          a declared alias or exact provider/model route. Without
                          this, the session's durable model or the daemon's
                          boot-time default runs.
      --effort <level>    persistently select the session's effort before
                          the first loop; with --model, the two are chosen together.
                          The daemon validates it against the parent and child models.
      --persona <name|none>
                          persistently select or clear the session's persona role
                          before the first loop (session/set_config_option configId
                          "persona"). Overrides PLURNK_CLIENT_PERSONA and PLURNK_PERSONA.
      --system-prompt <text|@file>
                          seed session://<session>/AGENTS.md with <text> (or @<file>
                          relative to cwd) on session open. Overrides ambient
                          PLURNK_CLIENT_PERSONA / PLURNK_PERSONA; conflicts with --persona.
      --env <NAME>[=<value>]
                          persistently set <NAME> on the session before the first loop
                          (session.env.replace); without =, carry <NAME> from this
                          environment when set. Repeatable. Overrides
                          PLURNK_CLIENT_ENV_<NAME>.
      --env-inherit <list>
                          comma-separated variable names or trailing-* prefix globs
                          carried from this environment onto the session before the
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
                          Off by default; Shift-Tab toggles it for the session.
                          Overrides PLURNK_CLIENT_YOLO.
      --auto              nobody is attending: the daemon asks nothing, and a loop
                          that would wait for a person concludes instead. Approval
                          stays local (--yolo). Overrides PLURNK_CLIENT_AUTO.
      --bell              ring the terminal bell when you are needed: the bound
                          session's loop replies, stops or fails, or a review or
                          question waits for you. Overrides PLURNK_CLIENT_BELL.
      --repl              run the interactive line-oriented REPL over the 5-stream
                          contract ([stdin, stdout, stderr, events, reasoning], fd 0..4)
                          without the Term viewport. Overrides PLURNK_CLIENT_REPL.
      --env-file <p>      load env from <p> (errors if missing). Repeatable.
      --env-file-if-exists <p>  same, but silently skip a missing file. Repeatable.
      --max-turns <n>     model-call budget for the prompt's session tree: its turns, its
                          descendants' turns and every bare call (else the daemon's ceiling).
      --timeout-ms <ms>   cancel each prompt loop (session/cancel) after <ms> milliseconds;
                          CLI exits 3 with "timedOut":true.
      --files-items <n>   turn-0 tracked-file preview: -1 full / 0 off / N first-N.
                          Create-time workspace setting.
      --preview-lines <n> lines of each operation body and execution output shown
                          beneath its row; the rest is named by its address. Overrides
                          PLURNK_CLIENT_PREVIEW_LINES.
      --history-entries <n> recent entries restored when Term opens or switches a
                          workspace or session; 0 hides history. Overrides PLURNK_CLIENT_HISTORY_ENTRIES.
      --mermaid-timeout-ms <n> total positive rendering deadline per diagram in milliseconds.
                          Overrides PLURNK_CLIENT_MERMAID_TIMEOUT_MS.
      --color <when>      style terminal output: always, auto, or never. Overrides
                          PLURNK_CLIENT_COLOR; always/never override color env preferences.
      --max-commands <n>  ceiling on ops per emission for the workspace (min with the
                          daemon's PLURNK_SERVICE_MAX_COMMANDS — can only tighten). Create-time.
      --share <folder>    when the prompt or session ends, write the workspace's share for
                          a bug report into <folder>, unredacted. A leading ~/
                          expands; a relative folder is this directory's. Overrides
                          PLURNK_CLIENT_SHARE.
      --no-git            deny git membership + working-tree status for the workspace (never
                          re-enables past the operator lockout). Create-time.
      --debug-no-meta     scrub _meta from ACP traffic to run on pure standard ACPv2
                          (overrides PLURNK_CLIENT_DEBUG_NO_META).
      --loop <id>         (log read) filter to a single loop id
      --turn <id>         (log read) filter to a single turn id
      --since <id>        (log read) return entries with id > <id>
      --limit <n>         (models / log read) page limit (models default 10, log read default 100)
      --provider <name>   (models) restrict the catalog to one provider
      --all               (models) include unconfigured models with readiness causes
      --offset <n>        (models) catalog page offset (default 0)
      --width <n>         (render) output width in terminal columns (default: stdout
                          width when available, otherwise 80)

subcommands:
  daemon [subcommand...]  manage the installed plurnk-service daemon (start, stop, restart, reload, status, config, ...)
  update                  update the model catalog and show how to update Plurnk packages (service.update)
  models [search...]      list the bounded daemon model catalog (models.list)
  workspace list            list workspaces on the daemon (workspace.list)
  workspace sessions <name> list sessions in the named workspace (workspace.sessions)
  workspace rename <a> <b>  rename workspace <a> to <b> (workspace.rename — a workspace's
                          name is a mutable handle; sessions are immutable)
  session [subcommand]      list, create, resume, fork, or delete sessions in the workspace
  config [<id> [<value>]]   inspect or set ACP session config options
  log read --workspace ...  read log entries from the named workspace's session
  read <loop>/<turn>/<seq>  inspect one log row in the selected workspace/session
  effort [level]          inspect or set a session's effort
  persona [name|none]     inspect, select, or clear a session's persona role
  render                  project Markdown stdin as width-bounded plain Unicode;
                          local only: no daemon, config cascade, or startup output
  completion <shell>      print the packaged Bash, Zsh, or Fish completion script;
                          local only: writes stdout, never installs files
  login                   sign in to the daemon through the browser and keep the grant
                          under $XDG_STATE_HOME/plurnk; a kept grant renews itself
  logout                  revoke the kept grant at the daemon and forget it
  mcp ...                   List or manage workspace or service MCP servers.
  skills ...                List or manage workspace or service Agent Skills.
  members ...               List or manage this workspace's file members.
  env ...                   Manage session, workspace, or service environment defaults.
  schedule ...              List or manage this workspace's schedules and macros.
  personas ...              List or manage workspace or service persona roles.
                          For family commands, put client options before the family name;
                          everything after it belongs to the family, including server flags.
  script <file.plk>       run a .plk file: feed its MCP expressions to op.exec,
                          render the trace, exit by worst op status. Honors
                          --workspace/--yolo/--project-root + workspace-open
                          settings. The daemon owns the grammar; the client
                          just feeds the file.
`;

export const FAMILY_COMMANDS = new Set(["mcp", "skills", "members", "env", "schedule", "personas"]);

export const STRING_LONG_FLAGS = new Set(
    Object.entries(CLIENT_OPTIONS)
        .filter(([, spec]) => spec.type === "string")
        .map(([name]) => `--${name}`),
);

export const usageError = (title: string, detail: string): ClientCliError =>
    new ClientCliError(
        {
            type: "https://problems.plurnk.xyz/client/usage",
            title,
            status: 400,
            detail,
        },
        64,
    );

export const parseSwitchValue = (name: string, raw: string | undefined, defaultValue = false): boolean => {
    if (raw === undefined || raw === "") {
        return defaultValue;
    }
    const normalized = raw.trim();
    if (normalized === "1") {
        return true;
    }
    if (normalized === "0") {
        return false;
    }
    throw usageError(
        "Invalid switch value",
        `${name} expects 0 or 1 (got ${JSON.stringify(raw)}).`,
    );
};

export const detectInitialJsonMode = (rawArgs: readonly string[], rawEnvJson: string | undefined): boolean => {
    let flagValue: boolean | undefined;
    for (const token of rawArgs) {
        if (token === "--") break;
        if (token === "--json") {
            flagValue = true;
        } else if (token === "--no-json") {
            flagValue = false;
        }
    }
    if (flagValue !== undefined) {
        return flagValue;
    }
    if (rawEnvJson === undefined) {
        return false;
    }
    return rawEnvJson.trim() === "1";
};

export const readVersion = (): string => {
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

export const collectSessionEnv = (
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

export const assembleCliCommonOptions = (
    parsedValues: Record<string, unknown>,
    processEnv: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): CliCommonOptions => {
    const cascadeFiles: CascadeFileSpec[] = [];
    const envFiles = Array.isArray(parsedValues["env-file"]) ? parsedValues["env-file"] : [];
    for (const f of envFiles) {
        if (typeof f === "string") cascadeFiles.push({ path: f, required: true });
    }
    const optionalEnvFiles = Array.isArray(parsedValues["env-file-if-exists"])
        ? parsedValues["env-file-if-exists"]
        : [];
    for (const f of optionalEnvFiles) {
        if (typeof f === "string") cascadeFiles.push({ path: f, required: false });
    }

    let env: Record<string, string>;
    try {
        env = assembleClientEnv(processEnv, cascadeFiles);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw usageError("Invalid environment file", detail);
    }

    const json =
        typeof parsedValues.json === "boolean"
            ? parsedValues.json
            : parseSwitchValue("PLURNK_CLIENT_JSON", env.PLURNK_CLIENT_JSON);

    const host = env.PLURNK_HOST;
    const port = Number.parseInt(env.PLURNK_PORT, 10);
    const configuredAcpUrl = env.PLURNK_ACP_URL;
    const explicitAcpUrl = typeof configuredAcpUrl === "string" && configuredAcpUrl.trim().length > 0;
    const url = explicitAcpUrl ? configuredAcpUrl!.trim() : `http://${host}:${String(port)}/acp`;

    const workspace = typeof parsedValues.workspace === "string"
        ? parsedValues.workspace
        : env.PLURNK_CLIENT_WORKSPACE;
    const sessionId = typeof parsedValues.session === "string"
        ? parsedValues.session
        : env.PLURNK_CLIENT_SESSION;
    const termSession = typeof parsedValues["term-session"] === "string"
        ? parsedValues["term-session"]
        : env.PLURNK_CLIENT_TERM_SESSION;
    const model = typeof parsedValues.model === "string"
        ? parsedValues.model
        : env.PLURNK_CLIENT_MODEL;
    const effort = typeof parsedValues.effort === "string"
        ? parsedValues.effort
        : env.PLURNK_CLIENT_EFFORT;
    if (typeof parsedValues.persona === "string" && typeof parsedValues["system-prompt"] === "string") {
        throw usageError("Conflicting flags", "--persona and --system-prompt cannot be used together.");
    }
    let systemPrompt: string | undefined;
    if (typeof parsedValues["system-prompt"] === "string") {
        const rawPrompt = parsedValues["system-prompt"];
        if (rawPrompt.startsWith("@") && rawPrompt.length > 1) {
            try {
                systemPrompt = readFileSync(resolve(cwd, rawPrompt.slice(1)), "utf8");
            } catch (err) {
                const detail = `Failed to read --system-prompt file ${rawPrompt.slice(1)}: ${err instanceof Error ? err.message : String(err)}`;
                throw usageError("Invalid --system-prompt file", detail);
            }
        } else {
            systemPrompt = rawPrompt;
        }
    }
    const persona =
        typeof parsedValues.persona === "string"
            ? parsedValues.persona
            : systemPrompt === undefined
              ? (env.PLURNK_CLIENT_PERSONA || env.PLURNK_PERSONA)
              : undefined;
    const projectRoot = typeof parsedValues["project-root"] === "string"
        ? parsedValues["project-root"]
        : env.PLURNK_CLIENT_PROJECT_ROOT;
    const filesItemsRaw = typeof parsedValues["files-items"] === "string"
        ? parsedValues["files-items"]
        : env.PLURNK_CLIENT_FILES_ITEMS;
    const maxCommandsRaw = typeof parsedValues["max-commands"] === "string"
        ? parsedValues["max-commands"]
        : env.PLURNK_CLIENT_MAX_COMMANDS;
    const noGit =
        parsedValues.git === false || parsedValues["no-git"] === true
            ? true
            : typeof parsedValues["no-git"] === "boolean"
              ? parsedValues["no-git"]
              : parseSwitchValue("PLURNK_CLIENT_NO_GIT", env.PLURNK_CLIENT_NO_GIT);

    const workspaceConfig: Record<string, string> = {};
    if (filesItemsRaw !== undefined && filesItemsRaw.trim().length > 0) {
        workspaceConfig.PLURNK_SERVICE_FILES_ITEMS = String(Number.parseInt(filesItemsRaw, 10));
    }
    if (maxCommandsRaw !== undefined && maxCommandsRaw.trim().length > 0) {
        workspaceConfig.PLURNK_SERVICE_MAX_COMMANDS = String(Number.parseInt(maxCommandsRaw, 10));
    }
    if (noGit) {
        workspaceConfig.PLURNK_SERVICE_GIT_ALLOWED = "0";
    }

    const inheritSpec = typeof parsedValues["env-inherit"] === "string"
        ? parsedValues["env-inherit"]
        : env.PLURNK_CLIENT_ENV_INHERIT;
    const excludeSpec = typeof parsedValues["env-exclude"] === "string"
        ? parsedValues["env-exclude"]
        : env.PLURNK_CLIENT_ENV_EXCLUDE;
    const flagEnvs = Array.isArray(parsedValues.env)
        ? parsedValues.env.filter((x): x is string => typeof x === "string")
        : [];
    const sessionEnv = collectSessionEnv(env, flagEnvs, inheritSpec, excludeSpec);

    const autostart =
        typeof parsedValues.autostart === "string"
            ? parseSwitchValue("--autostart", parsedValues.autostart, true)
            : parseSwitchValue("PLURNK_CLIENT_AUTOSTART", env.PLURNK_CLIENT_AUTOSTART, true);

    const daemonTimeoutMs = Number.parseInt(
        typeof parsedValues["daemon-timeout-ms"] === "string"
            ? parsedValues["daemon-timeout-ms"]
            : env.PLURNK_CLIENT_DAEMON_TIMEOUT_MS,
        10,
    );
    const oauthTimeoutMs = Number.parseInt(
        typeof parsedValues["oauth-timeout-ms"] === "string"
            ? parsedValues["oauth-timeout-ms"]
            : env.PLURNK_CLIENT_OAUTH_TIMEOUT_MS,
        10,
    );
    const cancelGraceMs = Number.parseInt(
        typeof parsedValues["cancel-grace-ms"] === "string"
            ? parsedValues["cancel-grace-ms"]
            : env.PLURNK_CLIENT_CANCEL_GRACE_MS,
        10,
    );
    const serviceBin = typeof parsedValues["service-bin"] === "string"
        ? parsedValues["service-bin"]
        : env.PLURNK_CLIENT_SERVICE_BIN;

    const yolo =
        typeof parsedValues.yolo === "boolean"
            ? parsedValues.yolo
            : parseSwitchValue("PLURNK_CLIENT_YOLO", env.PLURNK_CLIENT_YOLO);
    const auto =
        typeof parsedValues.auto === "boolean"
            ? parsedValues.auto
            : parseSwitchValue("PLURNK_CLIENT_AUTO", env.PLURNK_CLIENT_AUTO);
    const bell =
        typeof parsedValues.bell === "boolean"
            ? parsedValues.bell
            : parseSwitchValue("PLURNK_CLIENT_BELL", env.PLURNK_CLIENT_BELL);
    const repl =
        typeof parsedValues.repl === "boolean"
            ? parsedValues.repl
            : parseSwitchValue("PLURNK_CLIENT_REPL", env.PLURNK_CLIENT_REPL);
    const debugNoMeta =
        typeof parsedValues["debug-no-meta"] === "boolean"
            ? parsedValues["debug-no-meta"]
            : parseSwitchValue("PLURNK_CLIENT_DEBUG_NO_META", env.PLURNK_CLIENT_DEBUG_NO_META);
    if (typeof parsedValues["debug-no-meta"] === "boolean") {
        env.PLURNK_CLIENT_DEBUG_NO_META = debugNoMeta ? "1" : "0";
    }
    const shareFolder = typeof parsedValues.share === "string"
        ? parsedValues.share
        : env.PLURNK_CLIENT_SHARE;

    const maxTurnsRaw = typeof parsedValues["max-turns"] === "string"
        ? parsedValues["max-turns"]
        : env.PLURNK_CLIENT_MAX_TURNS;
    const maxTurns = maxTurnsRaw !== undefined && maxTurnsRaw.trim().length > 0
        ? Number.parseInt(maxTurnsRaw, 10)
        : undefined;

    const timeoutRaw = typeof parsedValues["timeout-ms"] === "string"
        ? parsedValues["timeout-ms"]
        : env.PLURNK_CLIENT_TIMEOUT_MS;
    const timeoutMs = timeoutRaw !== undefined && timeoutRaw.trim().length > 0
        ? Number.parseFloat(timeoutRaw)
        : undefined;

    const previewLines = Number.parseInt(
        typeof parsedValues["preview-lines"] === "string"
            ? parsedValues["preview-lines"]
            : env.PLURNK_CLIENT_PREVIEW_LINES,
        10,
    );
    const historyEntries = Number.parseInt(
        typeof parsedValues["history-entries"] === "string"
            ? parsedValues["history-entries"]
            : env.PLURNK_CLIENT_HISTORY_ENTRIES,
        10,
    );
    const mermaidTimeoutRaw =
        typeof parsedValues["mermaid-timeout-ms"] === "string"
            ? parsedValues["mermaid-timeout-ms"]
            : env.PLURNK_CLIENT_MERMAID_TIMEOUT_MS;
    const mermaidTimeoutMs =
        mermaidTimeoutRaw !== undefined && /^\d+$/u.test(mermaidTimeoutRaw.trim())
            ? Number.parseInt(mermaidTimeoutRaw.trim(), 10)
            : Number.NaN;
    if (!Number.isInteger(mermaidTimeoutMs) || mermaidTimeoutMs < 1) {
        throw usageError(
            "Invalid --mermaid-timeout-ms",
            `--mermaid-timeout-ms / PLURNK_CLIENT_MERMAID_TIMEOUT_MS must be a positive integer (got ${JSON.stringify(mermaidTimeoutRaw)}).`,
        );
    }
    const color = typeof parsedValues.color === "string"
        ? parsedValues.color
        : env.PLURNK_CLIENT_COLOR;
    if (color !== "always" && color !== "auto" && color !== "never") {
        throw usageError(
            "Invalid color mode",
            `--color / PLURNK_CLIENT_COLOR must be "always", "auto", or "never" (got ${JSON.stringify(color)}).`,
        );
    }

    return {
        url,
        explicitAcpUrl,
        host,
        port,
        credential: new Credential(env),
        env,
        cwd,
        ...(workspace !== undefined && workspace.length > 0 ? { workspace } : {}),
        ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
        termSession,
        ...(model !== undefined && model.length > 0 ? { model } : {}),
        ...(effort !== undefined && effort.length > 0 ? { effort } : {}),
        ...(persona !== undefined && persona.length > 0 ? { persona } : {}),
        ...(systemPrompt !== undefined && systemPrompt.length > 0 ? { systemPrompt } : {}),
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        ...(Object.keys(workspaceConfig).length > 0 ? { workspaceConfig } : {}),
        ...(Object.keys(sessionEnv).length > 0 ? { sessionEnv } : {}),
        ...(maxTurns !== undefined && Number.isInteger(maxTurns) ? { maxTurns } : {}),
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
        autostart,
        daemonTimeoutMs,
        oauthTimeoutMs,
        cancelGraceMs,
        ...(serviceBin !== undefined && serviceBin.length > 0 ? { serviceBin } : {}),
        yolo,
        auto,
        bell,
        repl,
        json,
        debugNoMeta,
        ...(shareFolder !== undefined && shareFolder.length > 0 ? { shareFolder } : {}),
        previewLines,
        historyEntries,
        mermaidTimeoutMs,
        color,
    };
};
