# @plurnk/plurnk

## 10.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk/issues).

### Upgrade

Upgrade this client, `@plurnk/plurnk-service` (`10.0.0`), and `@plurnk/plurnk-web` (`5.0.0`) together.

- **Service-Tier Cascade & Configuration Plane:** Adopt `service.<family>.*` and `service.config.{list,set,unset}` / `workspace.config.{list,set,unset}` ACP actions, the `host | service | workspace | session` Functionality origin model, canonical `workspace.create({ config })` (retiring `workspace.create({ settings })`), per-family scope discovery (`policy.familyScopes`), and `models.providers` onboarding (`#285`, `#286`).
- **Per-Server MCP Secrets:** Add `service.mcp.secrets.{set,unset}` and `workspace.mcp.secrets.{set,unset}` CLI and interactive `/mcp secrets` commands, completion, formatting, POSIX manual coverage, and conformance witnesses (`#287`, `#288`).
- **ACP Discovery Hygiene:** Retire the vestigial `notifications` block from `conformance/acp-client.json` in favor of the standard `acpV2` conformance surface (`#291`).
- **Dependencies:** Bump `@earendil-works/pi-tui` (`1.7.0`, `#289`) and `@types/node` (`^26.6.11`), and widen `@plurnk/plurnk-contracts` (`^10.0.0 || ^11.0.0`) and optional `@plurnk/plurnk-service` (`^9.0.0 || ^10.0.0`) dependency ranges for `10.0.0` (`#290`).

## 9.0.1

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk/issues).

### Patch Changes

- Guard Term `markTurnStart()` on queued prompts so active loop/OAuth status indicators are never overwritten, make `/mcp oauth` and `/login` immediately cancellable via `/stop`, `Escape`, `/quit`, and `SIGINT` outside the serialized REPL queue, name `<alias>` and `PLURNK_CLIENT_OAUTH_TIMEOUT_MS` on OAuth timeouts, and surface structured Problem `diagnostic` and `recovery` details in Term, REPL, and CLI (`#284`).
- Update `@earendil-works/pi-tui` (`1.6.1`) and `@types/node` (`^26.6.10`).

## 9.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk/issues).

### Upgrade

Upgrade this client, `@plurnk/plurnk-service` (`9.0.0`), and `@plurnk/plurnk-web` (`4.0.0`) together.

- **Auth & Zero-Config Startup:** Retire `plurnk onboard`, `plurnk web` handoff, and local secret files in favor of passwordless loopback `:1066` startup and external OIDC PKCE authentication (`#277`, `#278`).
- **Wire & Protocol Freeze:** Align all client commands, `PlurnkActionMap` types, notification streams, and slash commands with the v9.0 camelCase wire freeze (`child` / `childModel`, `actor`, `PLURNK_CLIENT_TIMEOUT_MS`, `review | accept | reject` approval mode, `exec:///` streams, canonical `/~/<workspace>#<session>` addresses, default `session1` / `workspace1` naming, and erased `attrs.distilled` kill-note handling) (`#270`, `#271`, `#272`, `#275`, `#276`, `#277`, `#279`, `#282`).
- **Unified Collection Browsing & Model Autocomplete:** Unify `list` / `discover` search, filtering, and `offset`/`limit` pagination across `members`, `skills`, `personas`, `mcp`, `env`, `schedule`, and `models` (defaulting `/models` to 10 rows), add live substring model catalog autocomplete and `turn_queued` indicators, align `/schedule` with structured `once`/cron macros and per-step receipts, and negotiate linked ACP bodies (`#274`, `#280`, `#281`, `#283`).
- **Architecture & Dependencies:** Decompose the Term presenter, ACP client, viewport, and REPL monoliths (`#282`), bump `@agentclientprotocol/sdk` (`^2.12.0`), `@earendil-works/pi-tui` (`1.6.0`), and `@types/node` (`^26.6.7`), and widen `@plurnk/plurnk-contracts` (`^9.0.0 || ^10.0.0`), optional `@plurnk/plurnk-service` (`^8.0.0 || ^9.0.0`), and `@plurnk/plurnk-spec-check` (`^0.2.0 || ^0.3.0`) ranges for `9.0.0` (`#282`).

## 8.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk/issues).

### Upgrade

Upgrade this client and `@plurnk/plurnk-service` together to `8.0.0`.

- Erase the retired `capabilities` CLI/Term surface and Agent Plugins references across client commands, specifications, and teaching fixtures (#267, https://repo.possumtech.com/plurnk/plurnk-service/issues/1517).
- Unify interactive and CLI family command parsing across `env`, `schedule`, `skills`, `mcp`, and workspace `members`, route `mcp` and `skills` completion against the connected server, and scope `/learn` target coordinates (#268, https://repo.possumtech.com/plurnk/plurnk-service/issues/1521).
- Adopt `@agentclientprotocol/sdk` `^2.8.0` (`cursor_update` session event classification) and widen `@plurnk/plurnk-contracts` (`^8.0.0 || ^9.0.0`) and optional `@plurnk/plurnk-service` (`^7.0.0 || ^8.0.0`) dependency ranges for `8.0.0` (#269).

## 7.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk/issues).

### Upgrade

Upgrade this client and `@plurnk/plurnk-service` together to `7.0.0`.

- Render open stream causal `aside` labels (`<glyph> <tool> <aside> <elapsed>`, falling back to `(<target>)`) and compact active child worker names (`<glyph> <worker> <elapsed>`) with parameter-free water-filling truncation in Term mode's live activity strip (#266, https://repo.possumtech.com/plurnk/plurnk-service/issues/1514).
- Align README, teaching fixtures, and MCP expressions terminology with the `7.0` universal `mcp` wire tool, retire the `## Errors` packet section and outside-prose fallback handling in favor of transient `## Notices` and leading `note` lowering, fix warning notice styling, and restore Mermaid diagram transposition, timeout bounds, and fallback labels (#264, #265).
- Update `@plurnk/plurnk-contracts` (`^7.5.0 || ^8.0.0`) and optional `@plurnk/plurnk-service` (`^6.1.0 || ^7.0.0`) dependency ranges for `7.0.0`.

## 6.1.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk/issues).

### Upgrade

Upgrade this client and `@plurnk/plurnk-service` together to `6.1.0`.

- Adopt `@agentclientprotocol/sdk` `^2.7.0` `replay_complete` session replay boundaries, inline `skill` prompt blocks and `available_commands_update` skill entries, and prompt suggestions.
- Migrate interactive terminal nomenclature, CLI flags, test tiers (`test/term/`), and modules from TUI to **Plurnk Term**, align composer `Ctrl+Enter`, review selection keys, and `Shift+Tab` mode cycling, and retire `Alt+Y` (#262, #263).
- Point `/learn` prompt expansion to `mcp:///plurnk/skills.json`, isolate `seedDemoProject` from host Git configuration, and resolve non-UI CLI, session lifecycle, onboarding, and reconnect edge cases (#254, #261).
- Bump `@plurnk/plurnk-contracts` to `^7.4.0` (compatible with `7.5.0` and `@plurnk/plurnk-service` `6.1.0`).

## 6.0.0

> Bare `#N` issue citations reference our private development forge rather than public GitHub issues — our apologies for the opaque provenance; open public bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk/issues).

### Upgrade

Upgrade this client and `@plurnk/plurnk-service` together to `6.0.0`.

- Ship POSIX `install.sh` with verified Node 26 fallback, add `plurnk daemon`, `plurnk web` (`/web`), `/learn`, `plurnk onboard`, and `/personas` family commands, default `PLURNK_CLIENT_YOLO=0` with CSI-u `Shift+Tab` mode cycling, statusline `🔥` YOLO lead, and `!cmd` / `?review` / `/yolo` / `/thinking` / `/agent` shadow hints, drop canonical `await` in Code Mode input and completion, align CLI `--json` `problem` presence with terminal `finalStatus`, refresh multi-surface README session media, break the CLI connection runtime import cycle (`cli-connection.ts`), modularize REPL command/prompt/watcher seams, decouple standalone `@plurnk/plurnk-spec-check` verification and contributor guidance from sibling monorepo paths, and ship packed `inlineSources: true` sourcemaps with public GitHub `bugs.url` metadata (#253, #254, #255, #257, #258, #259, #260, #261, https://repo.possumtech.com/plurnk/plurnk-service/issues/1451, https://repo.possumtech.com/plurnk/plurnk-service/issues/1452).
- Adopt `@agentclientprotocol/sdk` `^2.6.0` `session/options` (`initialConfigOptions`) and `@earendil-works/pi-tui` `1.5.2`, gate interactive elicitation capabilities on attended runs, show JSON argument field names on runtime tool headers, handle ACP v2 `_plurnk_telemetry` notifications (`kind: "notice"` and `kind: "state"`), parse `workspaceName#sessionName` composite session identifiers directly from `sessionId` when `_meta.plurnk` is omitted, and opt into windowed session resume (#252, #256, https://repo.possumtech.com/plurnk/plurnk-service/issues/1439, https://repo.possumtech.com/plurnk/plurnk-service/issues/1449).
- Add `--debug-no-meta` (`PLURNK_CLIENT_DEBUG_NO_META`) to strip `_meta.plurnk` from inbound ACP notifications for pure ACP v2 fallback verification (#252).
- Render named voice labels on prompts and replies, hydrate `resource_link` reply bodies when inline text is omitted, and route outside-of-operation prose via `agent_thought_chunk` to stderr stream `4` / TUI `💭` instead of stdout (#252).
- Render ACP v2 multi-select (`multiple: true`) and titled question options (`Option { id, title, label }`) in interactive review cards (#250).
- Deduplicate `engine:configuration` startup notices across session resume and live updates while preserving distinct action and provider notices (#251).
- Retire the `todo` operation and `plan_update` waterfall rows, probe `HEAD /` on unauthenticated `plurnk web` handoffs so omitted `@plurnk/plurnk-web` fails cleanly as `client/web/handoff-failed`, and retire the stream `lifetime` field (#249, https://repo.possumtech.com/plurnk/plurnk-service/issues/1439).
- Retire the unread `PLURNK_CLIENT_STATUS_STREAM` (`--status-stream`) knob, remove inline magic-number defaults (`DEFAULT_WIDTH` and `300_000` OAuth fallbacks), and enforce zero `DEFAULT_*` constants, bare timer literals, or unregistered confessing numeric constants in `scripts/env-surface.test.mjs` (https://repo.possumtech.com/plurnk/plurnk-service/issues/1441).

## 5.3.0

- Lowercase operation names across the presenter, viewport, and specs, render newly opened plan items with `🚧` while ignoring completed items, and implement `plurnk login` / `plurnk logout`, `PLURNK_CLIENT_CANCEL_GRACE_SECONDS`, `SIGINT`/`SIGTERM` cancellation, and unified family commands (#247).
- Bump `@plurnk/plurnk-contracts` to `^7.3.0` and `@plurnk/plurnk-service` to `^5.3.0` (#248).

## 5.2.2

- Handle `mcp oauth <alias> [callback-url]` in `executeFamilyCommand` with RFC 8252 §7.3 loopback callback reception (`workspace.mcp.oauth.begin` and `workspace.mcp.oauth.complete`), and bump `@plurnk/plurnk-contracts` to `^7.2.1` and `@plurnk/plurnk-service` to `^5.2.2` (#246).

## 5.2.1

- Parallelize initial `session.env.replace` RPC batch in `applyInitialConfig` and bump optional `@plurnk/plurnk-service` dependency to `^5.2.1` (#245).

## 5.2.0

- Support `DONE` (`🐹`), `FAIL` (`❌`), and `TODO` operations, preview `KILL` distillation bodies under `🗑️` while suppressing standalone `🗒️` rows for distilled `NOTE`s, and render per-turn `plan_update` diffs (`☐` opened, `🗹` completed) at the end of each turn in the waterfall (#232, #241, #244).
- Bind ACP v2 `session/archive`, `session/unarchive`, `session/status`, `auth/logout`, `PlanFile`, and `SubagentUpdate` capabilities, rename `workspace.hide` to `workspace.archive` (`includeArchived`), honor active provider and `configOptions` on fresh sessions, and upgrade `@agentclientprotocol/sdk` to `2.4.0` and `@earendil-works/pi-tui` to `1.5.0` (#232, #242, #243).

## 5.1.0

- Render a 3-line line-chunk live reasoning ticker (`💭`), an active streams/workers activity strip above the status bar, single-line terminal stream receipts (`<status> <aside> (<logPath>)`), and terminal-width status truncation while clearing concluded `WAIT` operations from the active strip (#238, #240).
- Classify `workspace.personas.*` actions (`list`, `get`, `add`, `replace`, `enable`, `disable`, `remove`) as `permanent-domain` in `conformance/acp-client.json` (#239).

## 5.0.4

- Patch matched `messageId` receipt and message items in place across updates and chunks, bound `session_bound` prompt history by `PLURNK_CLIENT_HISTORY_ENTRIES`, and enforce the 5-container pinned TUI chrome budget (#236).
- Complete `/models <prefix>` by longest common prefix on `Tab` while keeping the narrowed candidate popup open, and complete `/model <selector> <effort>` from the selected model's advertised effort levels (#237).
- Fail with exit code `64` (`https://problems.plurnk.xyz/client/usage`) on unknown `plurnk config` option IDs or excess positional arguments, pointing daemon configuration subcommands to `plurnk-service config <subcommand>` (https://repo.possumtech.com/plurnk/plurnk-service/issues/1362).

## 5.0.3

- Anchor TUI tool-call entries at their launch coordinate across mid-turn message chunks and preserve reply summaries when turn completion precedes the final reply chunk (#231).
- Enforce watched dependency freshness (`deps-policy.json`) and ACP v2 unstable surface exhaustiveness (#232).
- Deduplicate session replay materialization, preserve untruncated prompt history on `↑`/`↓`, classify transport disconnects and typed `PlurnkActionMap` keybindings, and retire `selectConfirm` on `pi-tui` `1.4.0` (#233).
- Render provider-only `/models` tables (`selector | name | context | efforts | readiness`), complete `/model <selector>` from the ready model catalog, suppress duplicate initial configuration notices on session open, and surface only actionable loop/gate indicators in the status bar (#234).

## 5.0.2

- Render `WAIT` operations, retain streamed receipt headers on `output_rx`, replay `/sessions <id>` loops in chronological order, preserve active status-bar lifecycle glyphs (`⏳`/`⏸`/`🛑`) alongside notices, preserve aggregate session spend across `499`/`202` parked turns and `/sessions <id>` resume, and retire live reasoning (`💭`) at every turn boundary (https://repo.possumtech.com/plurnk/plurnk-service/issues/1356).

## 5.0.1

- Pass `--ignore-scripts` in global install documentation and upgrade commands, and deny transitive install scripts in `allowScripts` (https://repo.possumtech.com/plurnk/plurnk-service/issues/1331).

## 5.0.0

### Upgrade

Upgrade this client and the daemon together to 5.0.

- The client communicates with `plurnk-service` over ACP v2 (`/acp`) using `@agentclientprotocol/sdk` (#218, #219, #220, #221).
- The session entity and its flags, subcommands, slash commands, and environment variables use `session` across the CLI and TUI (`--session`, `PLURNK_CLIENT_SESSION`, `PLURNK_SESSION_ENV_*`, `/session`, `/sessions`), and `session://`, `workspace://`, `persona://`, `mcp://`, and `plurnk://` address session, workspace, persona, MCP, and built-in resources (#223).
- `--persona`, `--system-prompt`, `PLURNK_CLIENT_PERSONA`, and `/persona` select or override a session's persona (`persona://<name>`) and `session://<session>/AGENTS.md` (#228).
- `plurnk update` and `/update` refresh the daemon's live model catalog and report package upgrade status (#224).
- Interactive `--repl` mode and the full-screen `pi-tui` surface share a 5-stream contract (`3` status, `4` reasoning, `5` gates) with multiline fenced input, `/import`, `/editor`, and `@<id>` gate targeting (#218, #230).
- `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env.local` loads above `.env` in the client configuration cascade (#229).

## 4.3.0

- `/loops` lists the bound worker's loops with their sequence number, lifecycle, sender and opening
  excerpt; `/loop [n]` prints a loop whole, and `/worker [name]` opens or creates a worker directly,
  retiring `/log` and `/attach` (#208, #209, #210, #214).
- One attention signal fires when a worker needs operator input, with `--bell` / `PLURNK_CLIENT_BELL`
  ringing the terminal bell on it (#213).
- Root workers admit the client's cascading `PLURNK_WORKER_ENV_*` environment and `PLURNK_CLIENT_MODEL`
  default, and `!` shell commands execute with the worker's environment (#211, #212).
- Attach and live observation read body and message references (`entry?target=`), negotiate reasoning
  by link, track `status.descendants`, `status.streams` and `status.inbox`, and reconcile external
  workspace renames and model changes (#193–#207, #215–#217).

## 4.2.0

- TUI cancellation keeps the run's connection until the daemon's terminal record arrives, up to
  `PLURNK_CLIENT_CANCEL_GRACE_MS` / `--cancel-grace-ms` (default 15000); the summary carries the
  loop's turn count and usage. A run the client hung up on reports `turns unknown`, never `0 turns`
  (#190). The one-shot `--timeout` hangup uses the same grace.
- The live reasoning tail is retired when the run streaming it settles (terminal, cancellation, lost
  connection), so the next prompt's reasoning starts clean instead of failing with "A second reasoning
  message started before the first ended." (#189).

## 4.0.0

### Upgrade

Upgrade this client and the daemon together to 4.0. Their authentication,
worker binding and AG-UI projection replace the 3.x wire contract.

- Replace `PLURNK_AGUI_TOKEN` with `PLURNK_SECRET`, or leave it unset for
  same-user local discovery. The secret is exchanged for short-lived access
  credentials; it is not sent as a bearer token.
- `plurnk login` uses browser authorization with PKCE and a loopback callback.
  `plurnk logout` revokes and forgets the retained grant. Interactive clients
  can initiate sign-in; unattended clients report the required action.
- Both CLI and TUI default to worker `user` through `PLURNK_CLIENT_WORKER`.
  The separate `--tui-worker` / `PLURNK_CLIENT_TUI_WORKER` setting is removed.
- LOOK, `/look` and the Alt-p/Alt-n target cycler are removed. Use ordinary
  resource reads; `plurnk read` reads a complete log entry.

### Worker and protocol alignment

- Bind to the daemon-returned workspace ID and worker name. Workspace renames
  preserve the worker, ownership and pending interrupt identity. Directory-derived
  names and folder labels come from the daemon; read-only selection creates nothing.
- Reopening a worker restores its standard AG-UI conversation snapshot. Live and
  restored messages use the same row projection, including assistant replies,
  refused operations, delegated results and subagent identities.
- Approvals use standard AG-UI interrupts and resume by interrupt ID. The retired
  `request_approval` pseudo-tool and custom duplicate row/terminal/action events
  are replaced by standard messages, results and namespaced metadata.
- Status reads workspace preparation and activity separately from worker state.
  Elapsed time uses the daemon's original loop start; worker spend includes its
  descendants and refreshes as turns settle.
- Informational operation details remain muted; failure styling follows failed
  status or unsuccessful execution.
- Development targets native ECMAScript and erasable TypeScript on Node 26.
  npm's install-script policy explicitly permits the locked native PTY test
  dependency; it is not a runtime dependency.

The optional web client is not part of this publication. Its conversation UI
remains deferred.

## 3.3.0

- Submit fixed question choices without an extra optional-detail step; display
  `other` as “Free response” when text fields follow (#180).

- A members definition is its glob: `/members add <glob...>` adds each glob as one
  definition and lists what was admitted, `/members enable|disable|remove <glob>`
  name one, and `/members` lists definitions by their glob; the family has no
  `replace`, following the daemon's `workspace.members` actions (#0).

- `/rollback <loop>/<turn>/<item>` reverses the bound worker's file mutations after
  that log coordinate, latest first, as your own operations, and prints each
  reversal, the rows skipped, and where drift stopped it, following the daemon's
  `workspace.rollback` action (#0).

## 3.2.0

- Replace a functionality definition whole from the client commands, through the
  daemon's atomic publication (#178).
- Preserve incomplete fan-out receipts in the TUI (#179).
- Keep Mermaid and hyperlink customization local to Plurnk's Markdown instances,
  with explicit compatibility coverage for the pinned pi-tui version (#177).
- Render all rich text through native Markdown without changing literal code;
  remove unused direct Markdown-parser and wrapping dependencies (#177).

## 3.1.1

- Delegate GFM markdown, tables, and LaTeX math rendering to `@earendil-works/pi-tui`,
  rendering symbols, arrows (`\leftrightarrow` to ↔, `\to` to →), relations (`\le`, `\ge`),
  Greek letters, and display equations natively in the terminal (#177).
- Eject custom `Marked` tokenizers, ad-hoc regex normalizers, and `cli-table3` dependency (#177).
- Close TUI transport before its private daemon shutdown, preserving graceful shutdown and
  reporting failed exits (#176).

## 3.1.0

- Web addresses (`http`, `https`) render as terminal hyperlinks wherever the client shows
  them, in markdown and in row targets, when colour is enabled; Plurnk addresses are never
  made clickable. The terminal window title names the bound workspace and worker: pushed
  once at start, updated on workspace switch and worker attach, restored at exit.
- The daemon's over-budget row (`engine/context/packet-exceeds-budget`) renders as
  `notice — curating context`, not as a failure.
- A one-shot `plurnk "! command"` exits by its conclusion status and the command's own
  exit code.
- Resuming a run supplies the interrupt identity the daemon issued.
- Explicit reply deliveries and message completion outcomes render as what they are.
- A failure to reach the daemon keeps the evidence the client observed before it failed.
- One-shot stream previews are bounded again.
- Live subsystem discovery derives from the daemon's advertised actions.
- A refused execution row renders immediately.
- The manual's date derives from source history.

## 3.0.0

- Connect to `/agui` by default and preserve the complete configured or advertised
  endpoint URL, including custom paths.
- Follow durable worker approval ownership and declare the client's capability set on
  every Run: the client tools it implements and whether a person attends it.
  Reconnecting owners can resume pending approvals; observing work does not transfer
  ownership.
- `--auto` (`PLURNK_CLIENT_AUTO`) states that nobody is attending: the daemon asks
  nothing and a loop that would wait for a person concludes instead, while approval
  stays local.
- Remove `--proposals` and `PLURNK_CLIENT_PROPOSALS`. Use `--yolo` for local automatic
  acceptance or `PLURNK_SERVICE_PROPOSALS` for server-side disposition.
- Remove `plurnk web`, its `--host` and `--port` options, and the `web/not-installed`
  Problem. The optional browser client is retired.
- `--policy`, `--reasoning` and `schedule --accept` are unknown options, and
  `PLURNK_AUTO`, `PLURNK_CLIENT_LOOP_POLICY`, `PLURNK_CLIENT_REASONING`,
  `PLURNK_CLIENT_WORKSPACE_CAPABILITIES` and `PLURNK_STATUS_STREAM` are unread; none
  has a refusal of its own.
- A failure to reach the daemon is the `client/agui/error` Problem, naming the endpoint
  in `url`.
- The status line reads the complete status gauge the daemon sends, including
  `children`, `waitUntil`, `preparation` and `descendants`.
- A one-shot `plurnk "! command"` runs the command through `op.exec` again instead of
  sending it to the model: its stdout and stderr are the client's, and it exits by its result.

## 2.0.0

- Join the one-time Plurnk 2.0 baseline. Subsequent client releases follow the
  client's own changes; they do not match a platform version or publication date.
- Consume the 2.x contracts and optional service through their named compatible
  dependency ranges. A separately configured service remains supported.
- Qualify the packed client and backend together without stamping either source
  tree during publication. Newer dependency versions alone do not require a release.
