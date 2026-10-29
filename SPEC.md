# @plurnk/plurnk — Client SPEC

Specifies what the `plurnk` CLI/TUI client does. The external protocol is defined by `@plurnk/plurnk-acp`; `TUI.md` records terminal design rationale.

| Term | Meaning |
| --- | --- |
| **daemon** | A running `plurnk-service` process serving ACP v2 Streamable HTTP and WebSocket at `/acp`. It owns all state. |
| **workspace** | Daemon-owned shared environment, selected by name or folder at acquisition and addressed by its immutable ID thereafter ({§cli-workspaces-and-sessions}). |
| **session** | An actor within a workspace with its own log. `--session` selects the session the thread binds; client operations have their own actor. |
| **ACP Run** | One protocol exchange on a thread. Proposal interrupts and resumes may span multiple Runs for one daemon loop. |
| **loop** | Daemon-owned execution spanning turns; the Run's end carries the authoritative terminal record as `_meta.plurnk.terminal`. |
| **one-shot mode** | `plurnk "prompt"` — one prompt's loop, rendered, then exit. Unix-tool posture. |
| **REPL mode** | `plurnk --repl` (`PLURNK_CLIENT_REPL=1`) — line-oriented interactive session over `[stdin, stdout, stderr, events, reasoning]` (`fd 0..4`), without `pi-tui`. |
| **TUI mode** | `plurnk` (no args, TTY stdin, `PLURNK_CLIENT_REPL=0`) — `pi-tui` terminal viewport composed atop REPL mode's 5-stream contract. |

---

## §cli-invocation 1. Invocation, Flags, and Environment Floor

```
plurnk [options] [prompt...]                # one-shot from positionals
<piped stdin> | plurnk [options] [prompt...] # one-shot from stdin (and/or positionals)
plurnk --repl [options]                      # REPL mode over [stdin, stdout, stderr, events, reasoning]
plurnk [options]                             # TUI mode (no positionals, TTY stdin, PLURNK_CLIENT_REPL=0)
```

- **Node runtime floor**: Before loading, `plurnk` compares the running Node.js against `engines.node` in `package.json`; below it, one `stderr` line names both versions and exits `1` before reading options or contacting a daemon.
- **Mode & prompt assembly**: With `--repl` (`PLURNK_CLIENT_REPL=1`) and no positional prompt, enters interactive REPL mode regardless of TTY status. Otherwise assembles prompt from positional args + piped `stdin` (positionals first, blank line, then `stdin`); if neither and `stdin` is a TTY $\to$ TUI mode; empty non-TTY input without `--repl` exits `64` before contacting the daemon (`CI` does not change this). `--json` requires one-shot or subcommand mode and a non-empty prompt (else exits `64`). `plurnk <subcommand> --help` prints command usage locally without contacting the daemon.
- **Family arguments**: CLI families (`mcp`, `skills`, `members`, `env`, `schedule`) share handlers and inventory with their TUI counterparts. Client options precede the family name; everything after the family positional belongs to the family (one immediate `--` is stripped as separator; subsequent `--` stay literal). Empty family invocation with `--help`/`-h` prints local help; invalid client options exit `64` with a usage Problem.

| Flag | Type | Meaning |
| --- | --- | --- |
| `-h`, `--help` | flag | Print usage, exit `0`. |
| `--repl` | flag | Enter line-oriented REPL mode over `fd 0..4` without `pi-tui` (overrides `PLURNK_CLIENT_REPL`, shipped `0`; {§cli-repl-mode}). |
| `--json` | flag | CLI mode only (`PLURNK_CLIENT_JSON`). One complete record document on `stdout`, structured errors on `stderr`. |
| `--workspace <name>` | string | Resume/create named workspace (`PLURNK_CLIENT_WORKSPACE`). |
| `--session <name>` | string | Resume/create named session in either mode (`PLURNK_CLIENT_SESSION`, shipped unset). |
| `--tui-session <name>` | string | Default session bound by TUI, scripts, and subcommands when `--session` is unset (`PLURNK_CLIENT_TUI_SESSION`, shipped `user`). |
| `--model <selector>` | string | Persist declared alias or exact `provider/model` route on the session before its first loop (`PLURNK_CLIENT_MODEL`). |
| `--effort <policy>` | string | Persist daemon-validated effort on the session before its first loop (`PLURNK_CLIENT_EFFORT`). |
| `--persona <name\|none>` | string | Select or clear the session's persona role via `session/set_config_option` (`configId: "persona"`) before its first loop (`PLURNK_CLIENT_PERSONA`, fallback `PLURNK_PERSONA`). |
| `--system-prompt <text\|@file>` | string | Seed `session://<session>/AGENTS.md` with `<text>` (or `@<file>` resolved relative to `cwd`) on session open; overrides ambient `PLURNK_CLIENT_PERSONA` / `PLURNK_PERSONA` and exits `64` if combined with `--persona`. |
| `--autostart <0\|1>` | string | Start installed service when nothing listens, or require attachment (`PLURNK_CLIENT_AUTOSTART`). |
| `--daemon-timeout-ms <n>` | string | Positive connection/startup limit (`PLURNK_CLIENT_DAEMON_TIMEOUT_MS`). |
| `--oauth-timeout-ms <n>` | string | Positive browser OAuth callback deadline (`PLURNK_CLIENT_OAUTH_TIMEOUT_MS`). |
| `--cancel-grace-ms <n>` | string | Positive grace after `session/cancel` ack before hanging up (`PLURNK_CLIENT_CANCEL_GRACE_MS`). |
| `--service-bin <path>` | string | Explicit installed service entrypoint (`PLURNK_CLIENT_SERVICE_BIN`). |
| `--project-root <path>` | string | Absolute path passed as `projectRoot` on `workspace.create` (`PLURNK_CLIENT_PROJECT_ROOT`). |
| `--yolo` | flag | Auto-accept every proposal locally without prompting (`PLURNK_CLIENT_YOLO`, shipped `1`). |
| `--auto` | flag | Nobody is attending: daemon asks no questions and loops that would wait for a person conclude instead (`PLURNK_CLIENT_AUTO`). |
| `--capabilities <json>` | string | Subtractive `CapabilityPolicy` on `workspace.create` (`PLURNK_CLIENT_CAPABILITIES`). |
| `--max-turns <n>` | string | Model-call budget for the prompt's session tree (`PLURNK_CLIENT_MAX_TURNS`). |
| `--preview-lines <n>` | string | Lines of operation body and concluded execution output shown beneath its row (`PLURNK_CLIENT_PREVIEW_LINES`). |
| `--history-entries <n>` | string | Non-negative recent entry count restored on TUI/REPL attach; `0` disables history (`PLURNK_CLIENT_HISTORY_ENTRIES`). |
| `--color <when>` | string | `always`, `auto`, or `never` (`PLURNK_CLIENT_COLOR`). |
| `--timeout <s>` | string | Cancel prompt loop via `session/cancel` after `<s>` seconds; CLI exits `3` with `"timedOut": true` (`PLURNK_CLIENT_TIMEOUT`). |
| `--status-stream` | flag | Print one greppable accounting row per turn on `stderr` (`PLURNK_CLIENT_STATUS_STREAM`). |
| `--share <folder>` | string | Write unredacted `workspace.share` into `<folder>` (`~/` expanded, refuses overwrite) when prompt/session ends; `/share <folder>` mid-session (`PLURNK_CLIENT_SHARE`). |
| `--files-items <n>` | string | Create-time turn-0 tracked-file preview: `-1` full, `0` off, `N` first-N (`PLURNK_CLIENT_FILES_ITEMS`). |
| `--max-commands <n>` | string | Create-time positive integer tightening workspace operation ceiling (`PLURNK_CLIENT_MAX_COMMANDS`). |
| `--no-git` | flag | Create-time `git: false` denying git membership/status (`PLURNK_CLIENT_NO_GIT`). |
| `--bell` | flag | Ring terminal `BEL` when attention is needed (`PLURNK_CLIENT_BELL`). |

- **Cascading env & self-serve floor**: Every standing-choice flag mirrors one `PLURNK_CLIENT_*` knob in `.env.defaults` (loaded SET-IF-UNSET beneath operator layers; switch knobs accept `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`, else exit `64`). Precedence: shell exports $\to$ repeated `--env-file` / `--env-file-if-exists` $\to$ `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env` $\to$ packaged `.env.defaults` $\to$ shared `@plurnk/plurnk-contracts` floor (`PLURNK_HOST`, `PLURNK_PORT`, `PLURNK_ACP_URL`, `PLURNK_SECRET`).
- **Daemon autostart**: Uses `@plurnk/plurnk-service/launch` (`shared` lifetime, `<state dir>/service.log`). Attaches if loopback listener is up; waits up to `PLURNK_CLIENT_DAEMON_TIMEOUT_MS` on `503 service-starting`; starts installed service (or `PLURNK_CLIENT_SERVICE_BIN`) when loopback connection is refused and `PLURNK_CLIENT_AUTOSTART=1` (attaching to winner on race, reporting `client:daemon:started` in text mode). Port `0` with autostart on fails with `64` (`client/daemon/port-unshareable`). Explicit `PLURNK_ACP_URL`, remote host, or autostart off attaches only.

### §cli-workspaces-and-sessions 1.1 Workspaces, Sessions, Project Root, and Settings

| Surface | Contract |
| --- | --- |
| Workspace acquisition & rename | `workspace.create` receives literal selected label (or lets daemon derive name from folder) plus `projectRoot`/`settings`, returning `{ id, name }`. Bound requests send `sessionId` as `<workspace ID>#<session name>`. Renames elsewhere detected via `snapshot.plurnk.workspace` trigger `workspace.list` readback. `workspace.attach` resolves existing workspaces without creating. |
| Session selection & history lost | `--session` / `PLURNK_CLIENT_SESSION` selects the session; unset, TUI/REPL/scripts/subcommands bind `PLURNK_CLIENT_TUI_SESSION` (`user`), and one-shot prompts mint a 12-hex-char session (`client:session:new` in text, `session` in JSON). If `snapshot.plurnk.status.loopId` becomes `null` after a gauge on the same binding carried a loop (fresh DB or deleted session), raises `history_lost` warning Notice. |
| Project root (`projectRoot`) | Existing workspace keeps stored root. Otherwise: `--project-root` / `PLURNK_CLIENT_PROJECT_ROOT` (empty string = headless `null`, requires `--workspace`, else exit `64` `client/flag/missing-dependency`) $\to$ `cwd` when `cwd != HOME` $\to$ home workspace `~` if held $\to$ interactive prompt (or exit `64` `client/project-root/required` when noninteractive/JSON). `Esc`/`Ctrl-C` during root prompt exits `130`. |
| Workspace-open settings | Sent as `settings` on `workspace.create` (`filesItems`, `capabilities`, `maxCommands`, `git: false`); create-time only, preserved on existing workspaces. |

### §cli-model-selection 1.2 Model, Child Provider, Effort, and Persona Selection

- **Model selection**: `--model <selector>` or `PLURNK_CLIENT_MODEL` calls `session/set_config_option` (`configId: "model"`) before the invocation's first loop (rejection fails admission before sending a prompt or accepting input). When initial session has no model, TUI emits one startup warning naming the provider API key, `/models`, and `/model <selector>`. `/model` reads/writes `model`; bare fragments complete from `providers/list` aliases, and `provider/…` fragments complete lazily from one bounded `models.list` page cached per provider.
- **Child provider (`/child`)**: `PLURNK_MODEL_CHILD` seeds spawn override for `WORK`, `FORK`, and `BARE`. `/child` inspects; `/child <selector>` sets `configId: "spawn_model"`; `/child inherit` clears (`value: ""`).
- **Effort & identity provenance (`/effort`)**: `/effort` and `plurnk effort` inspect or set `configId: "thought_level"`; `--model <selector> <effort>` / `/model <selector> <effort>` validates the pair atomically. Route labels format chosen effort in brackets (`deepdumb[low]`), alias-seeded default in parentheses (`deepdumb(low]`), and effortless routes bare. Every durable policy mutation (`/model`, `/child`, `/effort`, `/persona`, rebind/hop, admission flags) performs one whole readback of `configOptions` (`thought_level`, `model`, `spawn_model`, `persona`) before confirming; external changes detected on the gauge trigger the same readback.
- **Persona & role seeding (`/persona`, `--persona`, `--system-prompt`)**: `--persona <name|none>`, `PLURNK_CLIENT_PERSONA`, or `PLURNK_PERSONA` calls `session/set_config_option` (`configId: "persona"`) before explicit `--model`/`--effort` overrides so persona defaults apply when `--model`/`--effort` are omitted. `--system-prompt <text|@file>` passes `systemPrompt` (`mode: "append"`) on `session/new` (suppressing ambient `PLURNK_CLIENT_PERSONA`/`PLURNK_PERSONA`, or exiting `64` when paired with `--persona`). `/persona` and `plurnk persona` inspect, select, or clear (`none`) `configId: "persona"`, with TUI tab-completion from the session's `persona` config option.

### §cli-session-status 1.3 Session Status and Gauge

```
[<project folder> ] [<TUI place> ] [🔌 ][🔥 ]<glyph>  · <model> · <wall> · ↓<input> ↑<output> · $<usd> · <doing> [· 🐜<children> [<child>]] [· 🚦 <gated>] [· 📨 <waiting>] [· 🧮 <percent>%]
```

| Segment | Contract |
| --- | --- |
| Project folder & place | Starts with `snapshot.plurnk.workspace.projectLabel` (omitted when headless or equal to workspace name in TUI), then `[<workspace>/<lineage>(<loop>/<turn>)]` with `~` on the bound session. TUI footer uses muted color role ({§cli-color-policy}). |
| Glyphs (`🔌`, `🔥`, `<glyph>`) | `🔌` leads when the last session observation ended in failure (cleared on next command/prompt). `🔥` appears when YOLO is on. Lifecycle glyphs: `⏳` queued, `⌛︎` running, `💤` parked, `⏹️` complete, `🛑` cancelled, `❌` failed (two spaces after last glyph). |
| Clock, wait & preparation | Ticks once per second during unfinished runs (from prompt send, `status.claimedAt`, or attachment) and freezes on settlement. Parked with `status.waitUntil` shows `updates in <remaining>` then `updates due`. `_meta.plurnk.workspace.preparation` shows family, alias, phase, and elapsed time. |
| Spend (`↓<in> ↑<out> · $<usd>`) | From `snapshot.plurnk.status.spend` across session and descendants (`582k`, `1.2M`; `$3,333.3333`). Partial unknown totals append `+ ?`, wholly unknown renders `$?`, zero cost hidden. |
| Children (`🐜`), gates (`🚦`), inbox (`📨`), streams | `🐜 <count> [<child>]` from `status.descendants` alive direct children (hidden when `0`). `🚦 <n>` counts tree sessions awaiting a gate/proposal/interaction. `📨 <n>` counts unread accepted messages in `status.inbox`; messages left unread when a watched loop concludes emit `client:message:message_unread`. Open streams in `status.streams` hold their historical launch row until conclusion. |

---

## §cli-output-channels 2. One-Shot Mode and Five-Stream Output Channels

- **Prompt prefixes**: `? <question>` requests local proposal review for that loop; `: <text>` forces literal prompt treatment; `! <command>` executes via `op.parse` (`sh`), streaming `stdout`/`stderr` verbatim and exiting `0` (200 with zero `exitCode`), `3` (499), `4` (nonzero `exitCode`, $\ge 400$ status, or parse refusal), or `64` (empty command after `!`).
- **Prompt `@<path>` references**: Tokens `@<path>` at prompt start or after whitespace (trailing `.,;:!?)` trimmed) that name an existing regular file under the bound workspace's `projectRoot` project onto `openPaths` as workspace-relative paths while keeping prompt text unchanged.
- **Five-stream POSIX descriptor contract (`fd 0..4`)**:

| Slot | Stream | Contract |
| --- | --- | --- |
| `fd 0` | `stdin` | User prompts, `/` slash commands, `!` shell commands, `?` review prompts, `: ` literal prompts, `...` loop injections, and executable backtick/tilde fences. |
| `fd 1` | `stdout` | **Product only.** Text mode: delivered assistant responses verbatim in operation order, and `/` or subcommand outputs. `--json` mode: one complete JSON document (`schemaVersion`, `session`, `sessionId`, `loopId`, `response`, `finalStatus`, `turns: [{turn, ops: [{coord, op, origin, target, scope, status, signal}]}]`, `notices`, `usage` with `accounting.costUsd` as exact decimal string or `null`, `curationWeight`/`curationBudget`, `contextTokens`/`contextCapacity`), or `{"schemaVersion":6,"problem":ProblemDetails}` on failure. Op bodies are never inlined in `--json`. |
| `fd 2` | `stderr` | **Errors only.** RFC 9457 `ProblemDetails` and `error`-level diagnostics (plus one-shot TTY trace/menus when applicable). |
| `fd 3` | `events` | **Discrete session telemetry (NDJSON)** when `fd 3` is open (`fstatSync(3)` or in-process stream): `session_bound`, `tool_call_update`, `terminal_update`, `terminal_output_chunk`, `usage_update`, `state_update`, `config_option_update`, `subagent_update`, `session_message`, `notice` (`info`/`warn`), `composer_updated`, and gate events (`permission_request`, `elicitation_request`, `gate_resolved`) with 8-hex-char `id` hash. |
| `fd 4` | `reasoning` | **Model reasoning stream (UTF-8)** when `fd 4` is open: raw `agent_thought_chunk` text flushed with trailing `\n` when the turn's reasoning retires. |

- **Partial & interrupted records**:

| Condition | Contract |
| --- | --- |
| Mid-run connection or decode cutoff | Retains all rows, `response` text, and `notices` already observed across initial and proposal-resume segments without reconnecting or replaying the prompt. If a daemon terminal arrived (`turnSettled`), its `finalStatus` and `usage` remain authoritative; otherwise an observed `reportedProblem` supplies `finalStatus` (or `502 https://problems.plurnk.xyz/client/transport/terminal-missing`), `usage` is `null` (never fabricated from intermediate `usage_update`), and CLI exits `4`. |
| Pre-admission failure | Emits `{"schemaVersion":6,"problem":ProblemDetails}` on `stdout` in `--json` mode or renders Problem title/detail/recovery on `stderr` in text mode. |
| `SIGINT` / `SIGTERM` interruption | Sends `session/cancel` for the bound session (waiting up to `PLURNK_CLIENT_CANCEL_GRACE_MS` for the terminal record; a second signal aborts the wait), flushes one complete record (`client/transport/terminal-missing` `502` with `usage: null` if no daemon terminal arrived), and exits `130` (`SIGINT`) or `143` (`SIGTERM`). |

- **Exit codes**:

| Exit Code | Meaning |
| ---: | --- |
| `0` | Loop terminated successfully (`finalStatus === 200`), or clean TUI/REPL shutdown. |
| `1` | Runtime, connection, authentication, or action error before or outside loop settlement. |
| `2` | Session tree exhausted its model-call budget (`hitMaxTurns === true`). |
| `3` | Loop terminated with cancellation (`finalStatus === 499`, including `--timeout` which sets `"timedOut": true`). |
| `4` | Loop failed (`4xx`/`5xx` terminal status other than `499`), mid-turn stream cutoff without settlement, or failed `plurnk script` / `! <command>`. |
| `64` | Usage or flag validation error (missing prompt, unrecognized flag, invalid switch value, missing project root). |
| `130` / `143` | `SIGINT` / `SIGTERM` interruption. |

---

## §cli-repl-mode 3. REPL Mode and TUI Viewport

- **REPL mode (`--repl` / `PLURNK_CLIENT_REPL=1`)**: Binds workspace and session, restores up to `PLURNK_CLIENT_HISTORY_ENTRIES` history items, and emits `session_bound` on `fd 3`. Reads `fd 0` (`stdin`) supporting bracketed paste (`\x1b[200~...\x1b[201~`), multiline executable backtick/tilde fences (```` ```<info> ```` / ```` ~~~<info> ```` $\to$ `op.parse`), trailing `\` line continuation, slash commands, `/import <path>` (stages file into composition buffer and emits `composer_updated` on `fd 3`), and `/editor` (`$VISUAL`/`$EDITOR` fallback `vi`). Gate commands in REPL require `@<id>` (`8`-hex-char hash from `fd 3`; stale hashes fail `404` on `fd 2`): `/approve @<id> [optionId]` (`/accept`), `/reject @<id> [optionId]`, `/cancel @<id>`, `/edit @<id> <body...>`, `/answer @<id> <json-or-text>`, and `/review`; resolution emits `gate_resolved` on `fd 3`. `SIGINT` during an active loop or pending gate cancels it without exiting; `SIGINT` while idle clears staged `/import` buffer or exits `0`.
- **TUI mode (`pi-tui` viewport)**: Pure viewport over `[stdin, stdout, stderr, events, reasoning]` preserving native terminal scrollback. Tracks focused gate from `fd 3` so bare `/approve`, `/accept`, `/reject`, `/cancel`, `/edit`, and `/answer` automatically target the focused `@<id>`. `Esc` in inline review returns focus to composer preserving draft; `Esc` in composer cancels in-flight dispatch (`user_escape`) or clears idle draft; `Ctrl-C` cancels in-flight dispatch (waiting up to `PLURNK_CLIENT_CANCEL_GRACE_MS` for terminal record, else `turns unknown`) and a second `Ctrl-C` (or idle `Ctrl-C`, `EOF`, `/quit`) exits `0` printing a shell-safe resume command.

### §cli-interactive-command-discovery 3.1 Interactive Command Inventory, POSIX Artifacts, and Path Completion

| Group | Verbs |
| --- | --- |
| Inspect | `/help /models /workspaces /sessions /loops /loop` |
| Policy | `/model /child /effort /persona /capabilities /yolo` |
| Workspace | `/workspace /rename /share /rollback /session /fork /parent /enter /older /newer` |
| Functionality | `/mcp /skills /members /env /schedule` |
| Compose | `/import /script /editor` |
| Review | `/review /approve /accept /reject /cancel /edit /answer` |
| Session | `/stop /quit /update` |

- **POSIX artifacts**: `dist/posix/man/plurnk.1` (dated by source commit `%cs`, no wall-clock timestamp) and `dist/posix/completions/{plurnk.bash,_plurnk,plurnk.fish}` derive from the single command/usage inventory (`npm run build:posix`). `plurnk completion <bash|zsh|fish>` prints the script to `stdout` without daemon contact; `npm run test:posix` validates with `mandoc`, `bash`, `zsh`, `fish`, and `shellcheck`.
- **Filesystem completion**: `/import`, `/script`, `/env import` resolve against client launch directory; `@file` and `/members discover|add` resolve against bound workspace root; bare or `file:///` OP targets resolve against workspace `/` (`§fs-namei`); other schemes produce no local filesystem suggestions.

### §cli-sessions-topology 3.2 Session Topology, Loops, History, and Active Run Admission

- **Topology & hops**: One ACP stream binds one session, requesting `_meta.plurnk.descendants` delegation observation on session Runs (including resumes). `/session <name>` binds or creates `<name>`; `/session` prints lineage (`session: recheck [/main/fork-1/~recheck]`); `/fork [name]` calls `run.fork` and binds the child; `/sessions` renders the parent/child forest (`●` bound, `○` others, lifecycle marks, `🚦 n` gate counts). Tree hops re-read `workspace.sessions` and rebind: `Alt-h` / `/parent`, `Alt-l` / `/enter` (newest child), `Alt-j` / `/older`, `Alt-k` / `/newer` (`Alt-?` opens `/help`). `/rollback <loop>/<turn>/<item>` calls `workspace.rollback { to }`.
- **Loops (`/loops`, `/loop [n]`)**: `/loops` lists the bound session's loops oldest first (`<n>: [<sender>: ]<first line>[…] [<glyph>]`). `/loop [n]` fetches `session.loops` / `loop.page`, resolves words-by-reference, and renders loop `n` (or current loop) under `── loop n ──`.
- **Session history on attach**: Synchronizes via `session/resume` (`PLURNK_CLIENT_HISTORY_ENTRIES` tail) before releasing buffered live rows, deduplicating overlapping receipts by durable identity while keeping status/signal updates visible. Replayed entries do not count as live turns or fresh spend.
- **Active command admission**: During an active model run, inspect/Functionality/policy commands, `/help`, `/import`, `/editor`, `/yolo`, `!`, executable fences, `/script`, `/stop`, `/quit`, and gate responses remain reachable; plain prompts and `...` inject into the running loop (`loop.inject`, observing `enqueued_new_loop` via a sync Run); `?` or `:` prefixes are refused with an explanation; navigation commands (`/workspace`, `/rename`, `/session <name>`, `/fork`, hops) are refused until the active run settles.

### §cli-configuration-source 3.3 Workspace Functionality Controls (MCP, Skills, Members, Env, Schedule)

Subsystem listings (`mcp`, `skills`, `schedule`, `members`, `env`) append `source=<provenance.source>` when supplied by the daemon. Every family except `members` supports `replace` with `add` arguments (`workspace.<family>.replace` / `session.env.replace`).

| Family | Commands & ACP v2 Mapping |
| --- | --- |
| `/mcp` / `plurnk mcp` | `list`, `discover <query>`, `add <alias> <command\|url> [args...]`, `replace`, `enable`, `disable`, `remove`, `oauth <alias> [callback-url]`. Automatic OAuth binds an IPv4 loopback listener (RFC 8252 §7.3, deadline `PLURNK_CLIENT_OAUTH_TIMEOUT_MS`), calls `workspace.mcp.oauth.begin { alias, redirectUrl }`, opens the browser, validates exact `Host`/path/`state` on one `GET`, forwards to `workspace.mcp.oauth.complete { alias, callbackUrl }`, and prints `"Sign-in accepted; tools awaiting activation."` |
| `/skills` / `plurnk skills` | `list`, `discover <source>`, `add <name> <source> [--ref <ref>]`, `replace`, `enable`, `disable`, `remove` (`workspace.skills.*`). Preserves digit-leading and Unicode skill names. |
| `/members` / `plurnk members` | `list`, `discover <path\|glob>`, `add <glob...>`, `enable <glob>`, `disable <glob>`, `remove <glob>` (`workspace.members.*`). Definitions are gitignore-style globs (leading `!` excludes). |
| `/env` / `plurnk env` | Defaults to `session.env.*` (`--scope workspace` selects `workspace.env.*`): `list`, `discover [query]`, `add <NAME> <value>`, `replace`, `enable`, `disable`, `remove`, `import <path>` (dotenv file). At invocation admission and workspace/session switch on root sessions, persists client env configured via `PLURNK_CLIENT_ENV_INHERIT` / `--env-inherit`, `PLURNK_CLIENT_ENV_EXCLUDE` / `--env-exclude`, `PLURNK_CLIENT_ENV_<NAME>`, and `--env <NAME>[=<value>]` (and passes them on `!` commands). |
| `/schedule` / `plurnk schedule` | `list`, `discover <rule>`, `add <alias> <session> <rule> <prompt...>`, `replace`, `enable`, `disable`, `remove` (`workspace.schedule.*`; target formatted as `session://<session>`). |

---

## §cli-rendering 4. Rendering, Row Sources, and Log Entry Format

- **Presentation loading**: Help/version, plain/JSON CLI, and state commands do not initialize `pi-tui`, Markdown, or Mermaid; `render` loads only the Markdown/diagram renderer without contacting a daemon.
- **Row sources**: Drawn from ACP parts carrying `_meta.plurnk` (`id`, `coordinate`, `session`, `origin`, `op`, `source`, `address`, `signal`, `status`, `attrs`). Model operations draw when `tool_call_update` receipt arrives (or on stream/message conclusion when opening an obligation `< 400`); replies and body-bearing `WAIT` arrive as `agent_message_chunk`; arrivals as `user_message_chunk` (`published: false` replay chunks are not drawn as rows); words-by-reference (`document` part) are fetched with the Run's credential before drawing. Missing receipts or unreadable facts fail with `result-invalid`.
- **`log/entry` line format**:

```
<label> (<target>) [<scope>] [<pattern>] [{<n>}] [<aside>] [— <outcome>]
```

- **Operation glyphs & verdicts**: `NOTE` `🗒️` (`fact` `📊`, `idea` `💡`, `plan` `🚧`), `FIND` `🔎`, `READ` `📖`, `EDIT` `📝`, `COPY` `🖨️`, `MOVE` `📦`, `KILL` `🗑️`, `WORK` `🐜`, `FORK` `🔱`, `BARE` `☁️`, `WAIT` `⏳`, `SEND` `✉️` (completion 200 `🐹`, 499 `❌`), `WARN` `⚠️`, `FAIL`/error `⛔`, `INFO` `📌`, runtimes `⚙️ <runtime>`. Bold green below 400 (and 200 stream conclusion), bold red at $\ge 400$ (with `problem.title` and `problem.diagnostic`). Over-budget rows (`engine/context/packet-exceeds-budget`) render green/dim as `📌 — curating context`. `{n}` shows returned items/lines on `READ`/`FIND` and collapsed contiguous fan-out groups (`attrs.fanout`). Lineage rows indent 2 columns (`🐜 <name>`); observed descendants indent 2 columns per generation. Body/output previews (`EDIT`, `WORK`, `FORK`, undelivered `SEND`, script runtimes `sh`/`js`/`python3`, and concluded runtime outputs; never MCP tool request bodies) show `PLURNK_CLIENT_PREVIEW_LINES` lines indented 4 columns in dim text (`… +N lines · <address>`). Model `NOTE`s render whole in dim Markdown at column zero; runtime `NOTE`s render whole in dim plain text indented 4 columns.
- **Per-loop summary line**: `<lead><tag> · <N> turns · <wall>ms · ↓<input> ↑<output> [· cur <percent>/<budget>] [· ctx <percent>/<capacity>] [· loop $<usd>]` (`🎯 ` on `done`, Riding the `🐹` lead line when a `200` loop ends with a delivered `🐹` reply; `strike-out` on `engine/rails/strike-threshold`). Full packets, raw JSON-RPC frames, `_plurnk` `emission` READ rows, and intermediate `stream/event` updates are never rendered in the waterfall.

### §cli-markdown-projection 4.1 Markdown Projection, Render Filter, Reasoning, and Delivered Messages

- **Markdown & Mermaid projection**: TUI delegates GFM, box-drawn tables, and Unicode LaTeX math to `pi-tui` at container width via an instance-local adapter (`src/markdown.ts`). `mermaid` fences render as Unicode diagrams within `PLURNK_CLIENT_MERMAID_TIMEOUT_MS` (retrying with transposed flowchart direction if too wide, or falling back to source under `💻 mermaid — diagram failed to render` / `💻 mermaid — rendered width <W> exceeds <V>`).
- **Local rendering filter (`plurnk render --width <columns>`)**: Daemon-free Unix filter reading Markdown from `stdin` and writing width-bounded plain Unicode to `stdout` (`plurnk render --help` is the capability probe).
- **Provider reasoning & response order**: TUI orders operation history, dim `💭` live reasoning tail (at most 1/3 terminal height, retired when the Run settles), then delivered responses. Outside text (`agent_message_chunk`) renders in arrival order with Markdown layout at column zero but never enters CLI `stdout` or `--json` `response`.
- **Delivered messages (`SEND`/`KILL`)**: `entry.tx.body` (`{ raw, json }`). CLI emits `raw` verbatim on `stdout` (`--json` puts aggregated `response` in the run record). TUI renders `200` `SEND` under muted `🐹` with loop metrics on the lead line and column-zero Markdown (or 2-space indented JSON) body.

### §cli-color-policy 4.2 Palette, Colour Policy, Light/Dark Grounds, Titles, and Attention

- **Palette & colour policy (`src/color.ts`)**: `--color` / `PLURNK_CLIENT_COLOR` (`always`, `auto`, `never`, else exit `64`). Precedence: client choice `always`/`never` $\to$ nonempty `NO_COLOR` (off) $\to$ nonempty `FORCE_COLOR`/`CLICOLOR_FORCE` (on) $\to$ `CLICOLOR=0` (off) $\to$ TTY and `TERM != dumb`. Raw one-shot answers, JSON, completions, help/version, and `plurnk render` never receive ANSI styling.
- **Light & dark grounds**: Pivots fixed 256-colour roles (`Important` 141/97, `Warning` 172/130, `Muted` 145/60) from first known source: OSC 11 background luminance $\to$ DEC mode 2031 $\to$ `COLORFGBG` (0–6,8 dark; 7,9–15 light) $\to$ dark default.
- **Terminal conveniences & attention**: `http(s)://` URLs wrap in OSC 8 hyperlinks when colour is on (Plurnk schemes never do; model text is sanitized of escapes first). TUI sets window title `plurnk · <workspace>[ · <session>]` with XTWINOPS 22/23 push/pop. With `--bell` / `PLURNK_CLIENT_BELL=1`, writes `BEL` on `reply` (200), `stopped` (external 499), `failed`, or first waiting `review` / `question`.

---

## §cli-inline-review 5. Proposal Review, Ownership, Tool Acceptance, and Questions

- **Session ownership & `--auto`**: Every Run declares `_meta.plurnk.interactive` and `_meta.plurnk.tools` (`question`, `mcp_input_required` in TTY TUI; none in one-shot or `--auto`). Proposal resumes carry `_meta.plurnk.descendants` and `control`. Concurrent Runs share one local resolver per interrupt (`_meta.plurnk.proposal`), holding the interrupt connection (`§acp-held-interrupts`) and withdrawing with `settled elsewhere` if another client or the daemon settles it first; passive subcommand clients without gate handlers reject incoming permission and elicitation requests rather than cancelling pending interrupts. Review titles name non-bound asking sessions and `expiresAt` deadlines (`proposal EDIT a.ts · from helper · decide by 14:32`).
- **Interactive review & inline queue**: One-shot TTY menu prints colored udiff to `stderr` (`[a]ccept · [e]dit · [r]eject · [c]ancel`). TUI queues pending proposals and questions in main-buffer `pi-tui` controls (auto-focusing when composer is empty, preserving draft on `Esc`, reopening oldest via `/review`).
- **YOLO, configured acceptance & fail-closed headless**: Precedence: `?` prompt prefix (always review) $\to$ `--yolo` / `PLURNK_CLIENT_YOLO=1` (accept; `0` or `/yolo` disables, showing `yolo: off` in startup header) $\to$ `PLURNK_CLIENT_ACCEPT_<runtime>=1` (with optional `PLURNK_CLIENT_ACCEPT_<runtime>_TOOLS` exact JSON array) $\to$ interactive review (or reject with `client_no_review_channel` when `stdin` is not a TTY).
- **Questions (`request_user_input`)**: TUI collects independent scalar/enum fields sequentially (rendering `other` as **Free response** on native `question` enums and submitting immediately when remaining fields are optional) or whole JSON objects for complex schemas, validating against the contracts JSON Schema validator before submission. One-shot and headless clients cancel delivered question interrupts via ACP resume.

---

## §cli-subcommands 6. Subcommands and Script Invocation

Subcommands inspect or configure daemon state without running a model loop (`--json` emits structured output on `stdout`).

| Subcommand | Contract |
| --- | --- |
| `plurnk models [search...]` | Queries one bounded page from `models.list` (`--provider`, `--all`, `--offset`, `--limit`) without attaching a workspace; renders `selector / name / context / efforts / readiness`. |
| `plurnk update` / `/update` | Calls `service.update` (`_plurnk/action`) to refresh the cached model catalog and report package upgrade instructions when `PLURNK_SERVICE_UPDATEABLE=1`. |
| `plurnk workspace list` | Calls `workspace.list`; renders `name / project_root / created` (`(headless)` for `null` root). |
| `plurnk workspace sessions <name>` | Attaches existing `<name>` via `workspace.attach` (404 if missing) and lists `workspace.sessions` (`name / created`). |
| `plurnk log read` | Calls `log.read` (`--session`, `--loop`, `--turn`, `--since`, `--limit`); renders trace lines `[<status>] <origin> <op>[<sub>] <path> <scope>` or JSON `entries`. |
| `plurnk effort [level]` | Reads or updates `thought_level` on `configOptions` via `session/set_config_option`. |
| `plurnk persona [name\|none]` | Reads, selects, or clears `persona` on `configOptions` via `session/set_config_option`. |
| `plurnk script <file.plk>` | Submits `<file.plk>` via `op.parse` on the resolved workspace/session, retaining binding across proposal resumes; exits `0` on success or `4` on failed operation. |

---

## §cli-problems-and-notices 7. Problems, Notices, OAuth Credentials, and Stream Events

- **Problems & Notices**: Client Problems use `https://problems.plurnk.xyz/client/<kind>` (JSON mode outputs `{"schemaVersion":6,"problem":ProblemDetails}`). Notices (`warn` `⚠️`, `error` `⛔`, `info` `📌`) and Problems (`❌`) render flush-left in the waterfall or on `stderr` (`ContentOffset` as `L<line> col<column>`), keeping `stdout` strictly for delivered product.

| Problem Type URI | Status | Condition |
| --- | ---: | --- |
| `https://problems.plurnk.xyz/client/usage` | 400 | Invalid flag, missing argument, or invalid interactive slash-command syntax (CLI exits `64`). |
| `https://problems.plurnk.xyz/client/unknown-command` | 400 | Unrecognized interactive `/` command. |
| `https://problems.plurnk.xyz/client/gate-not-found` | 404 | Interactive gate command (`/approve`, `/reject`, `/cancel`, `/edit`, `/answer`) named an unknown or already-settled `@<id>` hash. |
| `https://problems.plurnk.xyz/client/editor-unavailable` | 500 | External `$VISUAL` / `$EDITOR` invocation failed or returned nonzero during `/editor`. |
| `https://problems.plurnk.xyz/client/command-failed` | 400 / 500 | Interactive command or `_plurnk/action` call failed. |
| `https://problems.plurnk.xyz/client/exec-failed` | 400 / 500 | Direct `! <command>` or executable fence (`op.parse`) failed. |
| `https://problems.plurnk.xyz/client/prompt-failed` | 500 | Prompt turn or auto-recovery reconnect failed. |
| `https://problems.plurnk.xyz/client/transport/terminal-missing` | 502 | Stream closed or was interrupted before a terminal `state_update` (`idle` / `failed` / `cancelled`) arrived. |

- **Credentials & browser sign-in (`src/credential.ts`)**: Uses `PLURNK_SECRET` or the daemon's minted `secret` file beside `PLURNK_SERVICE_DB_PATH` / `$XDG_DATA_HOME/plurnk/secret` to exchange `client_credentials` (`client_id: "operator"`, `scope: "acp"`) via RFC 9728 / RFC 8414 discovery, retrying once on `bearer-token-invalid` or rotated `invalid_client` file (`client/credential/refused` or `client/credential/discovery-failed` on failure). With no secret at an authenticating daemon, interactive invocations register a public client (RFC 7591), run PKCE (`S256`) browser sign-in via loopback callback (`PLURNK_CLIENT_OAUTH_TIMEOUT_MS`), and persist the refresh grant in `$XDG_STATE_HOME/plurnk/grants.json` (`0600`); headless invocations without a grant fail with `client/credential/sign-in-required`.
- **Stream events (`stream/event`, `stream/concluded`)**: `stream/event` writes nothing; admitted executions (`200` started / `202` queued with `attrs.stream`) wait for `stream/concluded` and render once with their conclusion (`wakeAction` is never rendered as a row).

---

## §cli-conformance 8. ACP Client Conformance and Test Daemon Lifecycle

- **ACP client conformance**: `conformance/acp-client.json` exhaustively classifies every action and notification in the daemon's live schema-bearing discovery with evidence by dimension, verified against the contracts-owned ACP stream and lifecycle corpus.
- **Test daemon lifecycle**: Deterministic tests launch the service via `@plurnk/plurnk-service/launch` with isolated `HOME`/`XDG_*` state roots and await `stop()` before removing temporary state; only the explicit live tier inherits operator configuration.
