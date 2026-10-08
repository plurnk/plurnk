# @plurnk/plurnk — Client SPEC

Specifies what the `plurnk` CLI/TUI client does. The external protocol is
defined by [`@plurnk/plurnk-agui`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-agui);
this document does not redefine it.

`TUI.md` records terminal design rationale. This file is the client contract:
what it guarantees, what its exit codes mean, and what it renders.

---

## §0 Glossary

| Term | Meaning |
|---|---|
| **daemon** | A running `plurnk-service` process whose in-process AG-UI+ module (`@plurnk/plurnk-agui`) serves HTTP/SSE. The client connects to it; it owns all state. |
| **workspace** | Daemon-owned shared environment, selected by name through `forwardedProps.plurnk.workspace`; see {§agui-thread-binding}. |
| **worker** | An actor within a workspace, with its own log. `--worker` selects the conversation worker; client operations have their own actor. |
| **AG-UI Run** | One protocol exchange on a conversation thread. Proposal interrupts and their resumes may span multiple Runs for one daemon loop. |
| **loop** | Daemon-owned execution spanning turns. Message delivery and loop completion are independent; `CUSTOM plurnk.terminated` carries the authoritative terminal result. |
| **log/entry notification** | A durable operation row or its update, projected through `CUSTOM plurnk.row`. Rendering follows §5. |
| **one-shot mode** | `plurnk "prompt"` — single loop.run, render, exit. Unix-tool posture. |
| **TUI mode** | `plurnk` (no args) — interactive REPL; multiple loop.run invocations per workspace. |

---

## §1 Invocation {§cli-invocation}

```
plurnk [options] [prompt...]                # one-shot from positionals
<piped stdin> | plurnk [options] [prompt...] # one-shot from stdin (and/or positionals)
plurnk [options]                             # TUI mode (no positionals, TTY stdin)
```

The prompt is assembled from positional args + piped stdin. If both are present, positionals come first followed by a blank line, then stdin. If only positionals → those. If only piped stdin → that. If neither and stdin is a TTY → TUI mode. Empty non-TTY input is a usage error (exit 64), before contacting the daemon. `CI` does not change this terminal-based choice. The `--json` flag requires a non-empty prompt (errors with exit 64 if neither source provides one).

`plurnk <subcommand> --help` prints that command's invocation forms and summary
from the same inventory as global help, without contacting the daemon.

{§cli-family-arguments} The CLI configuration families `mcp`, `skills`, `a2a`,
`members`, `env`, and `schedule` use the same handlers and command inventory as
their TUI counterparts. Client options precede the family name; everything after
that first positional belongs to the family, without re-tokenizing shell arguments
or interpreting server options as client settings. One immediately following `--`
is an optional argument separator; subsequent `--` tokens remain literal arguments.
An otherwise empty family invocation with `--help` or `-h` prints local help.
Invalid client options produce a usage Problem (exit 64), never a stack trace.

Options:

| Flag | Type | Meaning |
|---|---|---|
| `-h`, `--help` | flag | Print usage, exit 0 |
| `--json` | flag | CLI mode only (or `PLURNK_CLIENT_JSON`). One complete record document on stdout, structured errors; interactive OAuth instructions use stderr. See §2.1. |
| `--workspace <name>` | string | Resume the named workspace. See §1.1. Overrides `PLURNK_CLIENT_WORKSPACE`. |
| `--worker <name>` | string | Resume (or create) the named worker within the workspace. Overrides `PLURNK_CLIENT_WORKER`. TUI default: `PLURNK_CLIENT_TUI_WORKER`; CLI default: the workspace's conversation. See §1.1. |
| `--tui-worker <name>` | string | TUI-only default when no worker is selected. Overrides `PLURNK_CLIENT_TUI_WORKER`. |
| `--model <selector>` | string | Persist a declared alias or exact `provider/model` route on the conversation worker before its first loop. See §1.2. Overrides `PLURNK_CLIENT_MODEL`. |
| `--effort <policy>` | string | Persist the daemon-validated effort on the conversation worker before its first loop. See §1.2.3. Overrides `PLURNK_CLIENT_EFFORT`. |
| `--autostart <0\|1>` | string | Override `PLURNK_CLIENT_AUTOSTART`: permit private local startup or require attachment. See {§cli-daemon-autostart}. |
| `--daemon-timeout-ms <n>` | string | Positive connection/startup limit; overrides `PLURNK_CLIENT_DAEMON_TIMEOUT_MS`. |
| `--daemon-stop-timeout-ms <n>` | string | Positive owned-service shutdown grace; overrides `PLURNK_CLIENT_DAEMON_STOP_TIMEOUT_MS`. |
| `--oauth-timeout-ms <n>` | string | Positive browser OAuth callback deadline; overrides `PLURNK_CLIENT_OAUTH_TIMEOUT_MS`. See {§cli-mcp-oauth-callback}. |
| `--service-bin <path>` | string | Explicit installed service entrypoint; overrides `PLURNK_CLIENT_SERVICE_BIN`. |
| `--project-root <path>` | string | Absolute path passed as `projectRoot` on `workspace.create`. See §1.3. Overrides `PLURNK_CLIENT_PROJECT_ROOT`. |
| `--yolo` | flag | Auto-accept every proposal locally without prompting (the default). See §6. Forces `PLURNK_CLIENT_YOLO` on. |
| `--auto` | flag | State that nobody is attending: the daemon asks nothing, and a loop that would wait for a person concludes instead. Approval stays local. Overrides `PLURNK_CLIENT_AUTO`. See §6.0. |
| `--capabilities <json>` | string | CapabilityPolicy applied when creating the workspace. Overrides `PLURNK_CLIENT_CAPABILITIES`. |
| `--max-turns <n>` | string | Model-call budget for the prompt's worker tree ({§turn-cap-counts-the-tree}): the loop's turns, its descendants' turns and every BARE call, one per call; omission leaves the daemon's ceiling in effect. Overrides `PLURNK_CLIENT_MAX_TURNS`. |
| `--preview-lines <n>` | string | Lines of every operation body and concluded execution output shown beneath its row (§5.1); the rest is named with `… +N lines · /look <address>`. Overrides `PLURNK_CLIENT_PREVIEW_LINES`. |
| `--history-entries <n>` | string | Non-negative recent entry count restored on TUI attachment; zero disables history. Overrides `PLURNK_CLIENT_HISTORY_ENTRIES`. See {§cli-conversation-history}. |
| `--color <when>` | string | `always`, `auto`, or `never`; overrides `PLURNK_CLIENT_COLOR`. See {§cli-color-policy}. |
| `--timeout <s>` | string | Cancel each prompt loop via `loop.cancel` after `<s>` seconds. CLI exits 3 with `"timedOut":true`. Overrides `PLURNK_CLIENT_TIMEOUT`. |
| `--status-stream` | flag | Also print one greppable accounting row per turn on stderr. Overrides `PLURNK_CLIENT_STATUS_STREAM`. |
| `--share <folder>` | string | When the one-shot prompt or the interactive session ends, ask the daemon for the workspace's share (`workspace.share`): written into `<folder>`, unredacted, refused rather than overwritten. A leading `~/` expands and a relative folder resolves against the working directory. Text mode prints the folder and the disclosure on stderr. `/share <folder>` writes one mid-session. Overrides `PLURNK_CLIENT_SHARE`. |
| `--files-items <n>` | string | Workspace-open preview: `-1` full / `0` off / `N` first-N tracked files at turn 0. Create-time only. See §1.4. Overrides `PLURNK_CLIENT_FILES_ITEMS`. |
| `--max-commands <n>` | string | Tighten the workspace operation ceiling. Create-time only. See §1.4. Overrides `PLURNK_CLIENT_MAX_COMMANDS`. |
| `--no-git` | flag | Deny git membership and working-tree status for the workspace. Create-time only. See §1.4. Overrides `PLURNK_CLIENT_NO_GIT`. |

Env:

**A flag is a knob's spelling for one invocation.** Every option above that states a standing choice mirrors one `PLURNK_CLIENT_*` knob by name — `--max-turns` is `PLURNK_CLIENT_MAX_TURNS`, `--no-git` is `PLURNK_CLIENT_NO_GIT` — and the option wins when both are given. The packaged `.env.defaults` declares every knob with its meaning and its shipped value, and is their only home: this document names knobs and never restates them. An option that is not a standing choice (a subcommand's argument, `--env-file`, `--help`) has no knob, and `scripts/env-surface.test.mjs` holds the reason for each. A switch knob reads `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`; anything else is a usage error naming the knob.

The client also reads keys it does not own:

| Var | Owner | Meaning |
|---|---|---|
| `PLURNK_HOST` / `PLURNK_PORT` | `@plurnk/plurnk-contracts` | The daemon's bind address and port; the client dials `http://$PLURNK_HOST:$PLURNK_PORT/agui`. A key the daemon and its clients share has a shared owner: contracts declares it once, the daemon folds that panel into its floor and the client folds it beneath its own, so one line in a shared `.env` moves both and neither side holds the other's default. |
| `PLURNK_AGUI_URL` | `@plurnk/plurnk-contracts` | The whole URL instead: a remote portal, or a daemon bound to an address no client can dial. |
| `PLURNK_AGUI_TOKEN` | `@plurnk/plurnk-agui` | The portal's bearer, presented when set. |

**Cascading env.** Highest precedence first: shell exports → repeated `--env-file` / `--env-file-if-exists` flags (node-native; the last occurrence wins; `--env-file` requires the file, while the other skips a missing one) → `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env` → the client's own packaged floor (below). All layers are optional; the client works with no configuration. A working directory's `.env` belongs to that directory's application and is never read; a project's variables reach its commands through the workspace environment (`/env import .env`). The client reads the daemon address (`PLURNK_HOST`/`PLURNK_PORT`, or `PLURNK_AGUI_URL`) from the shared XDG file. There is no generated aggregate defaults file; `plurnk-service config defaults` renders the complete owner-labelled catalog on demand.

**The self-serve floor** {§cli-env-defaults} — per the ecosystem standard (one owner per key, the file IS the docs), the client ships `.env.defaults` at its package root declaring only the `PLURNK_CLIENT_*` prefix and loads it SET-IF-UNSET beneath every operator layer. A knob the operator set is never overridden; a commented knob is documentation, not a value.

### Backend lifetime {§cli-daemon-autostart}

The client package declares the service as an optional dependency. A normal
install includes it; `--omit=optional` preserves client-only use with an explicit
endpoint or separately installed service. Runtime startup never downloads it.

The client uses the service's public `@plurnk/plurnk-service/launch` interface;
it does not implement a second daemon supervisor. Process ownership and data
retention are separate.

| Connection/configuration | Behavior |
|---|---|
| Ordinary loopback host/port has a listener | Attach; ordinary AG-UI validation still applies. Never stop that service. |
| Ordinary loopback connection is refused; `PLURNK_CLIENT_AUTOSTART=1` | Start an installed private service on an allocated loopback port with an invocation-local bearer. Each client owns a separate process. |
| Explicit `PLURNK_AGUI_URL`, remote host, or autostart disabled | Attach only. Failure never creates a substitute environment. |
| Timeout, DNS/routing failure, authentication rejection, or invalid protocol | Preserve the failure; do not interpret it as an absent service. |
| Explicit loopback port `0` | Start privately on an allocated port; do not look for a shared listener. |

Configuration comes from the ordinary cascade. Resolve the installed service
package, or its executable on `PATH`; `PLURNK_CLIENT_SERVICE_BIN` explicitly
selects an installation. The executable and launcher must come from the same
package. Missing installation is an actionable failure, never an automatic
download. Readiness and shutdown use the positive millisecond limits in the
client's `.env.defaults`.

| Private backend boundary | Guarantee |
|---|---|
| Storage | Honor an explicit service state root/database. Otherwise allocate a unique root under `$XDG_DATA_HOME/plurnk/instances` (standard home fallback). Keep the service's existing database/workspace model and exclusive database lock. |
| Normal, failed, or interrupted invocation | Stop and await the owned service before exit. CLI interruption flushes its partial record first; TUI restores the terminal before waiting. A signal during startup cannot admit a prompt after shutdown begins. |
| Retention | Exit never deletes private data. Text mode identifies the database; JSON stdout/stderr semantics stay unchanged. The TUI's resume command includes the exact storage binding and private port selection, not the temporary bearer. |
| Multiple clients | No implicit rendezvous, shared background service, or reference counting. Sharing requires an explicitly running service. |

The service launcher cleans failed acquisition. Shutdown errors remain visible.
Forced process death (`SIGKILL`, host failure) cannot run graceful cleanup.
Help, version, completion and local rendering do not acquire a backend.

### §1.1 Workspaces and workers {§cli-workspaces-and-workers}

Workspaces and workers are daemon-owned. The client only knows their **names** — ids are internals used by the daemon to avoid conflicts and are not exposed via flags or env. Workspace-scoped calls use the transport's bound workspace; the client never invents an ID. Worker switching rebinds the conversation by name, including after a fork.

**The name IS the identity.** Terminal invocations send `--workspace`/`PLURNK_CLIENT_WORKSPACE` verbatim, otherwise the launch working directory, as `forwardedProps.plurnk.workspace`. The derived name replaces the complete home-directory prefix with `~`; paths outside home remain absolute. Clients launched in the same directory against the same daemon/database therefore attach to the same workspace. AG-UI owns attach-or-create admission under {§agui-thread-binding}. Workspace identity and project root are independent: a derived name does not override a saved root or an explicit headless/different creation root. The workspace and conversation `threadId` remain separate wire fields.

**Creation is ATOMIC with the projectRoot.** The client sends its workspace options (projectRoot/settings) on EVERY request, so whichever request causes creation creates the workspace fully formed — there is no window where a workspace exists undressed. A workspace created without a root is headless on purpose and stays headless forever: changing a project root is unimplemented by design (the root is the world's ground).

- **Worker selection**: `--worker` → `PLURNK_CLIENT_WORKER` → TUI-only `--tui-worker`/`PLURNK_CLIENT_TUI_WORKER` (shipped `user`). The selected name becomes `threadId`. TUI workspace switches use this same selection. One-shot and state-command invocations without a selection use the workspace name as `threadId`, selecting the daemon's durable default conversation worker. For read subcommands, an explicit worker resolves via `workspace.workers`; an unknown name fails rather than falling back.
- An explicit worker does not require an explicit workspace: it can attach within the directory-derived workspace.

CLI flag takes precedence over env when both are set.

{§cli-conversation-lost} **A bound name answered with no history is a new conversation, and the client says so.** The daemon mints a conversation anew under its old name when it no longer holds it ({§agui-thread-binding}: a fresh database, a deleted worker), and the name cannot tell the client. The run-start gauge can: `snapshot.plurnk.status.loopId` is `null` only for a worker with no loop at all, so a `STATE_SNAPSHOT` reporting `null` after a gauge on the same binding that carried a loop raises the `conversation_lost` warning Notice, naming the workspace and worker, ahead of the run's rows. The transcript above the alert is the terminal's memory, not the model's. Switching workspace or worker starts a fresh watch.

### §1.2 Model selection {§cli-model-selection}

The worker owns its model route ({§worker-model-selection}); the client persists deliberate selections server-side and never reasserts model policy on an individual loop. One selector accepts either a daemon-declared alias or an exact `provider/model` route. Alias selection preserves its alias-scoped configuration and provenance; exact selection uses provider-wide configuration without inventing an alias.

Resolution at the client:

- `--model <selector>` set → one `worker.model.set` before the first loop of this invocation, then no per-loop selector.
- `--model` unset → send nothing; the worker's durable route (or the daemon's `PLURNK_MODEL` default when the worker is first created) runs.

An explicit model or reasoning selection is invocation admission: rejection fails
before the CLI sends a prompt or the TUI accepts input. The client never continues
under the worker's previous policy.

The daemon alone owns provider configuration, credentials, alias declarations, and its `PLURNK_MODEL` seed. A client connected to a local or remote daemon has the same contract.

When the initial worker has no selected model, the TUI emits one startup warning
pointing to `/models`, `/model <selector>`, and README's Models section. It does
not choose a model or fetch the catalog automatically. When startup allocates
private storage, its existing informational notice points to the exit resume
command and README's Service section; explicit storage bindings receive no such hint.

The TUI's `/model` verb reads and writes `worker.model.set`/`worker.model.get`; the header displays the resolved durable route. `providers.list` remains the small declared-alias directory used for bare-fragment completion; a `/model` or `/child` fragment holding a provider prefix (`openai/…`) completes lazily from one bounded provider-scoped `models.list` page, cached per provider for the session — the client never preloads or owns the catalog. `/models [search]` and `plurnk models` lazily query `models.list`; no model catalog is fetched at startup or injected into a model packet.

### §1.2.1 Worker status {§cli-worker-status}

{§cli-status-wait} While parked with a daemon-supplied `status.waitUntil`, human
status shows `updates in <remaining>` and repaints every second, including after
reattachment. Expiry reads `updates due` until the next lifecycle event; it does
not promise immediate inference or completion of the underlying work. Waking,
concluding, or a null deadline removes the countdown. The timestamp is the
service's durable deadline, never a client timer inferred from a WAIT receipt;
untimed recovery and review receive no invented deadline.

{§cli-status-preparation} Workspace capability preparation is rendered from
`STATE /plurnk/status/preparation`: family, current alias when present, phase,
and elapsed time since the daemon's timestamp. The status clock advances while
preparation is present, including before model inference and during inspection.
An empty array clears the activity. Reattachment uses the same snapshot; the
client neither starts capabilities nor polls for progress. This state adds no
transcript rows and does not replace the loop lifecycle or indexing activity.

Human status is the summary line's shape aggregated over the session:

```
[<project folder> ] [<TUI place> ] [🔥 ]<glyph>  · 🎲 <model> · <wall> · ↓<input> ↑<output> · $<usd> · <doing> [· 🐜<children> [<child>]] [· 🧮 <percent>%]
```

YOLO is a fireball beside the lifecycle glyph. The model sits next, ahead of
everything that ticks, so the ticking never moves it; it is the client's last server-read route
({§cli-identity-effort}), never the gauge's. The traffic counts precede the phrase that
says what the worker is doing. A glyph is two columns wide, so two spaces separate the last one from the first dot. Token counts are
abbreviated (`582k`, `1.2M`; below a thousand the number itself) and spend is stated to the
hundredth of a cent with grouped thousands (`$3,333.3333`).

{§cli-status-project-root} CLI and TUI status start with the bound workspace's project folder
at column zero, before TUI place coordinates, glyphs, model and counters. It comes from
`snapshot.plurnk.workspace.projectRoot`. The launch directory and
create-time options cannot override it on reattachment. Switching workspaces replaces
the folder; a headless or unknown root omits it. Home paths use `~`. The TUI omits
the separate folder when its home-shortened form equals the workspace name's
home-shortened form; the place already identifies it. Path text is terminal-safe.
The TUI footer uses the muted color role, subject to {§cli-color-policy}.

{§cli-status-children} The ant is the daemon's count of the bound worker's alive
direct children (`snapshot.plurnk.status.children`: queued, running, or parked —
a parked child still owes a result), followed by the child model while a spawn
override is set: `🐜 2 dumbox`. Zero hides the whole child segment, even with a
configured child model. A transport without the gauge shows only the bare
`🐜 <child>`. The count is never derived from the directory;
the user hops to a child (§3.1.2) rather than watching it. `(<i>/<n>)` after the
worker is its sibling position, newest first, present only with siblings.

Turns and wall time include the running loop — its packet count from the
authoritative AG-UI `STATE_SNAPSHOT`/`STATE_DELTA` gauge and its elapsed time
from the local clock, ticking once a second throughout an unfinished run, including
queued and parked intervals. Waiting and resumption neither pause nor reset that clock;
completion, cancellation or failure freezes it. A missing start time is not invented.
Token and cost totals combine concluded
loops with settled `engine:turn` accounting from the current observed run. Every
completion beat refreshes them. The terminal loop aggregate replaces, rather than
adds to, that run's accrual. Complete `usage`/`costUsd` and `knownUsage`/`knownCostUsd`
subtotals remain distinct: any unknown contribution keeps the total unknown
through later turns, descendants, and session accumulation. A known subtotal
renders with `+ ?`; wholly unknown money renders `$?`. An explicit complete
zero remains hidden. The turns/wall group appears once a loop has
run, tokens once accounting exists, cost when nonzero or unknown, the child model while a spawn override is set and the child segment is visible (§1.2.2), the
worker once the conversation worker is known (the terminated outcome names it). The client does
not infer provider packets from operation rows or turn coordinates.

{§cli-status-descendants} Human status adds the daemon's cumulative
`snapshot.plurnk.status.descendants` accounting to the parent's own settled
evidence. Each snapshot replaces the prior descendant subtotal; snapshots and
control-plane refreshes are not billable events. On conclusion, add the final
descendant subtotal to the session tally once, beside—not inside—the parent's
terminal aggregate. A later loop starts with its own descendant projection.
Missing usage remains unknown; zero requests adds nothing. Known subtotals follow
the daemon's accounting convention. Do not sum child durations, reconstruct a
tree, reprice provider usage, or change own-loop JSON/summary accounting.
Before the first state snapshot, durable worker policy and local derivation
activity provide an honest startup fallback. Exact accounting remains in the
loop summary.

### §1.2.2 Child provider selection {§cli-child-provider-selection}

Child selection is the same durable posture for WORK, FORK, and BARE calls.
`PLURNK_MODEL_CHILD` seeds the worker's spawn override (the daemon reads its own
env); otherwise the policy is inherit. Bare `/child` reports the worker's
persisted override, `/child <selector>` persists it via `worker.child.set`, and
`/child inherit` sends `selector: null` (clearing the override). The client sends
no child selector on loops.

### §1.2.3 Effort {§cli-effort}

Effort is a durable worker setting owned and validated by the daemon.
`/effort` and `plurnk effort --workspace <name>` inspect the effective effort
and the daemon-supported choices; supplying an effort to either form persists
it. `--effort <level>` sets it before the invocation's first loop. A model and
its effort are chosen together: with `--model`, or `/model <selector> <effort>`,
the effort rides in `worker.model.set` and the daemon validates the pair once, so
switching to a model that lacks the worker's current effort never strands it.
The client forwards the value without maintaining a provider capability catalog,
uses `supportedEfforts` for completion, and never encodes effort in an alias or
loop request. Reattachment reads the durable value; descendants follow the
daemon's snapshot inheritance.

#### Effort in the identity {§cli-identity-effort}

Effort is identity-grade. Wherever the client names a route (status line, model
and child labels, loop headers) one formatter renders the daemon's durable effort
with the identity, and the daemon's stated provenance decides the marker:
`deepdumb[low]` is a chosen level (`worker.effort.set`), `deepdumb(low)` a
provider default the daemon seeded from the alias; brackets read as chosen,
parentheses as given. A route without an effort dimension renders bare, and a
daemon that states no source renders brackets as before. `/effort` says the
same in words. The client never infers provenance (plurnk#41 ask 2,
plurnk-service#528).

The identity is the client's last server-read route. Every durable-policy change
(`/model`, `/child` including `inherit`, `/effort`, a rebind or hop, and an explicit
`--model` or `--effort` at admission) ends in one readback, `worker.effort.get` then
`worker.model.get` for both routes, collected whole, applied together and repainted
before the change is confirmed; a setter's echo is never spliced into a label. A
persisted change whose readback fails is reported as a readback failure, distinct
from a refused change: it neither shows the requested value as read back nor rolls
anything back. A status gauge is a cache of lifecycle, place, activity and children
and never supplies the identity, so a gauge carrying an older route (the setter's own
action run snapshots the worker before it mutates) cannot override a newer
client-set policy.

### §1.3 Project root {§cli-project-root}

**Project root** is the absolute path the daemon's `file://` scheme uses as the workspace boundary for that workspace. NULL = headless (file ops 400 with "workspace has no project_root").

| Input | Resolved root |
|---|---|
| Existing named workspace, regardless of cwd or creation defaults | Stored root; no prompt or rewrite |
| New workspace, `--project-root` or `PLURNK_CLIENT_PROJECT_ROOT` | Explicit absolute path; empty string means headless (`null`). The flag wins. |
| New workspace, neither, cwd differs from home | cwd |
| Neither, cwd resolves to home, new workspace, interactive stdin and stdout, not JSON mode | Inline choice: existing project folder with path completion, no folder, or explicit home |
| Same new workspace, noninteractive or JSON mode | Exit 64 with `client/project-root/required` and explicit-root guidance; no workspace creation or model run |

The same selection precedes startup and `/workspace` creation. A folder choice
accepts absolute, home-relative and `~/` paths and validates that the directory
exists; it creates no directory. An explicit choice becomes this invocation's
creation default. Merely resuming a workspace does not make its stored root a
default for new workspaces. Escape/Ctrl-C cancels selection without creating a
workspace or changing the current binding; startup cancellation exits 130.
Read-only global commands do not select a root.

The resolved value accompanies every attach-or-create request so whichever
request wins can create the workspace atomically. An existing workspace always
preserves its stored root, even if an explicit creation default differs.

### §1.4 Workspace-open settings {§cli-workspace-open-settings}

These flags shape what the workspace sees; they map to workspace-open settings and are creation-time / workspace-level. File membership is not a flag: it is the `members` Functionality family (§3.7).

**Workspace-open settings** — sent as `settings` on `workspace.create`:

- `--files-items <n>` → `filesItems`. Controls the turn-0 tracked-file preview: `-1` full / `0` off / `N` first-N items. Must be `-1`, `0`, or a positive integer (else exit 64). Replaces the operator's `PLURNK_SERVICE_FILES_ITEMS` for the workspace.
- `--capabilities <json>` / `PLURNK_CLIENT_CAPABILITIES` → `capabilities`. The canonical CapabilityPolicy is a purely subtractive workspace ceiling. Executor plugin configuration remains service-owned and never becomes workspace settings.
- `--max-commands <n>` → `maxCommands`. Tightens the daemon ceiling and must be a positive integer.
- `--no-git` → `git: false`. It never re-enables git past a service-owned lockout.

Settings have **workspace-create-only effect** (no live setter), but accompany every attach-or-create request so a concurrent first request cannot create an undressed workspace. Existing workspaces retain their durable settings.

---

## §2 One-shot mode {§cli-one-shot-mode}

Triggered when a prompt is present from positionals, piped stdin, or both.

### §2.0 Prompt prefixes {§cli-prompt-prefixes}

The prompt's first character has the same meaning in the CLI and TUI. `plurnk "? question"` states proposal `review` for that loop without changing workspace capabilities; `": text"` states nothing new. `plurnk "! command"` execs via the daemon—op.exec, stream to conclusion, exec stdout→stdout / stderr→stderr, exit by `result.status` (0/3/4). Core has no named ask/act mode.

### §2.0.1 Prompt file references {§cli-prompt-open-paths}

A prompt token `@<path>` that starts the prompt or follows whitespace is a file reference when, at the moment the prompt is sent, `<path>` (trailing `.,;:!?)` trimmed) names an existing regular file under the bound workspace's project root (§1.3), not a creation default. The CLI and TUI project the distinct references, in prompt order, onto `openPaths`; the prompt text is sent unchanged and the daemon reads each path on the message's turn ({§methods-loop-run-open-paths}). Local absolute references under that root become workspace-relative paths on the wire.

| Token | Opens |
|---|---|
| `@src/x.ts`, the file exists | `src/x.ts` |
| `@someone`, no such file | nothing; the token is prose |
| `@src`, a directory | nothing |
| `a@b.com` (the `@` does not start a token) | nothing |
| any token, headless workspace (`null` root) | nothing |

### §2.1 Output channels {§cli-output-channels}

Standard Unix discipline: **stdout is the program's product, stderr is its narration.** There are two OUTPUT MODES, selected by `--json` / `PLURNK_CLIENT_JSON` — not a flag on one output, but two distinct contracts:

**text mode (default):**
- **stdout** — delivered conversation responses ({§cli-broadcast-send-rendering}), verbatim in operation order and separated by a blank line. A later failure or cancellation does not retract them. NOTE inventories, unrelated recipients and failed messages do not appear on stdout.
- **stderr** — one mutable status row on a TTY, durable action trace lines
  (including intermediate broadcasts), diagnostics, and the terminal summary.
  Non-TTY stderr omits routine status/progress instead of accumulating heartbeat
  history. It still receives durable trace, diagnostics, and the summary.

**json mode (`--json` / `PLURNK_CLIENT_JSON`):**
- **stdout** - ONE complete document and nothing else: the coherent record of the terminated worker loop - `schemaVersion`, authoritative `workerId` + `loopId`, `response` (the answer, top-level for `jq -r .response`), `finalStatus`, `turns: [{turn, ops: [{coord, op, origin, target, scope, status, signal, tags}]}]`, `notices`, `usage`, exit metadata. Each op preserves the daemon's line-marker `scope` as its ordered coordinate array and complete sorted durable log classifications in `tags`. `usage` is preserved verbatim from `CUSTOM plurnk.terminated`: ordered physical-request evidence and conventional aggregate token fields live under `usage.accounting`, whose `costUsd` is an exact decimal string or `null`; `curationWeight`/`curationBudget`, `contextTokens`/`contextCapacity`, and provider metadata remain sibling fields. Curation weight is never compared with physical provider tokens. The client does not project, sum, round, or settle accounting. `CUSTOM plurnk.terminated` supplies both owning coordinates; the client never combines a terminal loop with a worker inferred from ambient rows. Workspace-visible child/sibling rows may be rendered as topology, but they do not enter this record's `response` or `turns`. On failure it is `{"schemaVersion":6, "problem": ProblemDetails}` - valid JSON either way, paired with the exit code.
- **stderr** — silent.
- **NOT inlined:** op *content* (file bodies, exec output). Under co-location the consumer reads the file directly or fetches one op on demand with `plurnk read <coord> --json` (§7) — the same addressable, scoped log discipline the engine runs on. `--json` carries the record, not the content.

{§cli-interrupted-record} During the initial request or any proposal-resume segment,
`SIGINT` and `SIGTERM` explicitly request `loop.cancel` for the bound worker and
flush one JSON document containing all rows, notices, and response text observed
at interruption, then exit 130 and 143 respectively. Cancellation uses the same
15-second grace as the run timeout; another signal stops waiting for its reply.
Cancellation or flush failures are reported on stderr, including in JSON mode.
A daemon terminal result wins; otherwise an
observed Problem retains its status, or a `client/transport/terminal-missing`
Problem supplies 502. Without a daemon terminal result usage remains unknown,
never inferred from partial accounting. The client
waits for stdout to flush; interrupting its process does not assert that the
daemon loop has concluded.

Consequence:

- `plurnk "X" > answer.txt` captures just the delivered response messages.
- `plurnk "X" 2>/dev/null` suppresses the trace.
- A TTY user sees both interleaved as before (the terminal merges streams).
- `plurnk "X" | tool` pipes only the answer.
- `plurnk --json "X" | jq -r .response` pulls the answer; `… | jq .turns` the structured trace. One document, no stderr archaeology — the CLI is the integration layer, no third-party client needed for basic needs.

### §2.2 Flow {§cli-one-shot-flow}

1. Read the conversation worker's durable model, then `POST /agui` (RunAgentInput) with the workspace and thread selected under §1.1, the prompt as a user message, and per-loop options on `forwardedProps.plurnk`.
2. Consume the SSE: `CUSTOM plurnk.row` events advance observed turn status and
   render as durable action trace lines on stderr; derivation Notices update the
   replaceable activity row without becoming trace history.
   Delivered conversation responses go to stdout ({§cli-broadcast-send-rendering}).
3. A proposal arrives as a `prop:*` tool call and terminates run A with a standard AG-UI interrupt outcome (the internal loop stays paused). Run B on the same thread returns the decision through `RunAgentInput.resume`, and the continued loop streams there. `CUSTOM plurnk.terminated` is authoritative for the internal outcome; a stream that dies without terminal truth is an error (502), never a fabricated success.
4. **text mode:** write summary lines to stderr (final status, turns/wall/tokens); stdout stays the pure answer. **json mode:** emit the complete record document on stdout (§2.1); stderr stays silent.
5. Exit with the appropriate code (§4).

### §2.3 What one-shot mode does NOT do {§cli-what-one-shot-mode-does-not-do}

- No interactive prompts during the loop (proposal review prompts are separate; see §6).
- No interpretation of a positional prompt as raw DSL. Use `plurnk script <file.plk>` or the TUI's executable-fence input for `op.parse`.
- No reconnect on dropped connection. Connection drop = exit with error.

---

## §3 TUI mode {§cli-tui-mode}

Triggered when `argv` has no positional prompt.

### §3.1 Flow {§cli-tui-flow}

1. Bind a `BridgeTransport` to the module (§1.1 name-verbatim workspace on every run); its persistent handlers un-project `CUSTOM plurnk.*` events to the daemon shapes the waterfall renders. Restore the conversation under {§cli-conversation-history}.
2. Print the banner; start pi-tui's main-screen renderer with a multiline editor
   and §1.2.1's aggregate line on the place line below the composer. Before AG-UI
   state arrives, derivation, search, and
   branch activity share the fallback activity position. The
   lifecycle glyph is ⏳ while queued, `⌛︎` while running, 💤 while parked, `⏹️` when complete,
   and ❌ on failure; YOLO puts 🔥 beside the lifecycle glyph. The main-screen renderer preserves
   ordinary terminal scrollback rather than replacing it with an alternate screen.
3. Each line entered is dispatched:
    - Lines starting with `/` → command verbs: `/help /models [search] /workspaces /workers /log [n] /look <address> (§3.1.3) /model <selector> /child <selector|inherit> /effort [policy] /capabilities [json] /yolo /workspace [name] /worker [name] /attach <name> /parent /enter /older /newer /rename <name> /share <folder> /stop /quit`, plus `/import <path>` (§3.3) and the Functionality families `/mcp` (§3.4), `/skills` (§3.5), `/a2a` (§3.6), `/members` (§3.7), `/env` (§3.8), and `/schedule` (§3.9). Singular verbs CREATE, plural verbs LIST: `/workspace [name]` opens a fresh workspace (rebinds the AG-UI thread in place), `/workspaces` lists; `/worker [name]` forks a new worker (`run.fork`), `/attach <name>` binds this session to a worker by name, `/workers` lists the directory as a topology rooted at the bound worker (both §3.1.2); `/rename <name>` retargets the workspace's mutable handle (a worker's name is immutable). `/capabilities` reads or replaces the workspace's durable CapabilityPolicy. Verbs never call `loop.run`; inspect verbs reuse the §7 subcommand tables; `/stop` and `/help` stay reachable while a loop is in flight. Editor completion covers verbs, declared aliases, daemon-supported efforts, worker names after `/attach` (the directory plus the `worker://<name>` references the waterfall has shown, §3.1.2), **file paths** (after `/import`/`/script`, the `/members discover` and `/members add <alias>` positions, the `/env import` position, and bare `@file` tokens), **executable fence names** (READ, NOTE, and the other native OPs), and PLURNK target paths.
    - Named executable backtick fences → `op.parse`; a LOOK fence is inspection (§3.1.3), never a run. Help and tab-completion derive the canonical fence from the published contract ({§operation-fences}); completion preserves longer authored fences and submitted operations pass through unchanged. Native OPs and executor/MCP names share this entry point; the daemon owns parsing, resolution, and diagnostics. Prefix `: ` to force prompt treatment for a literal fenced example.
    - Lines starting with `!` → the `op.exec` action. Daemon-owned shell; proposal-gated like any side effect.
    - Lines starting with `? ` → local proposal review for that run, bypassing client auto-acceptance. `: ` uses ordinary client acceptance. Neither prefix changes the worker's owner or server policy.
    - Lines starting with `...` → the `loop.inject` action — speak into a running loop without starting a new one (the "btw" steering case).
    - Anything else → a conversation run (the prompt as the user message). Standard prompt-driven loop.
    (Verbs and injections ride §3 action runs on the same AG-UI+ surface — one wire, no side-channel.)
4. Input remains available during a run under {§cli-active-command-admission}; typed commands and shortcuts share admission.
5. `Ctrl-C`, `EOF`, and `/quit` exit cleanly. The resume command identifies the
   current workspace and worker with shell-safe arguments, including after rebinding.

### §3.1.1 Interactive command discovery {§cli-interactive-command-discovery}

One command registry owns the supported slash verbs, their groups, exact usage,
summaries, nested Functionality verbs, root completion, and contextual help.
Dispatch is exhaustive over that inventory. `/help` renders a compact grouped
index; `/help <verb>` renders that verb's usage and nested forms. This reference
and the generated man page are checked against the same inventory. The README
provides onboarding and examples, linking to this reference and pointing to
`/help` rather than repeating the full command inventory.

{§cli-posix-artifacts} The generated man page and Bash, Zsh, and Fish completions
derive from the command inventory. `plurnk completion <bash|zsh|fish>` writes the
corresponding packaged script verbatim to stdout, without configuration loading,
daemon contact or filesystem installation. The man page names the package version
and omits the optional date, so rebuilding it does not introduce a timestamp.
Bash filename candidates retain spaces,
backslashes, and glob characters as single candidates; the shell owns quoting.
Unit tests run the native syntax/format checkers when installed and name any
missing tools. `npm run test:posix` requires mandoc, Bash, Zsh, Fish, and
ShellCheck; a missing checker or an invalid artifact fails that explicit check.

| Group | Verbs |
|---|---|
| Inspect | `/help /models /workspaces /workers /log /look` |
| Policy | `/model /child /effort /capabilities /yolo` |
| Workspace | `/workspace /rename /share /worker /attach /parent /enter /older /newer` |
| Functionality | `/mcp /skills /a2a /members /env /schedule` |
| Compose | `/import /script /editor` |
| Review | `/review /accept /reject /cancel /edit` |
| Session | `/stop /quit` |

Completion remains demand-driven. The client offers local syntax and known
model aliases without I/O; provider-qualified models use one bounded provider
page; MCP, Skill, and A2A aliases call only that Functionality family's list
action after the cursor reaches an alias-taking position. A failed lazy lookup
produces no completion and never changes the editor value.

#### §3.1.1.1 Filesystem completion {§cli-path-completion}

Filesystem suggestions follow the address owner; completion never changes the process working directory.

| Input position | Resolution base |
|---|---|
| `/import`, `/script`, `/env import` | Client launch directory; absolute paths remain host-absolute |
| `@file` | Bound workspace root; only paths under it ({§cli-prompt-open-paths}) |
| `/members discover`, `/members add <alias>` | Bound workspace root; relative sibling paths retain membership semantics ({§cli-file-members}) |
| File OP target (bare or `file:///`) | Workspace filesystem namespace; `/` denotes the workspace root ({§fs-namei}) |
| Other schemes or authorities | No local filesystem suggestions |

The TUI uses the daemon's reported workspace root for both completion and prompt references. Rebinding clears it until the new binding's state arrives; a headless or not-yet-known root yields no workspace-file suggestions. Local-file commands remain available in either case. Completion preserves the authored URI prefix and surrounding editor text. A suggested path is not a membership grant; the daemon still owns operation admission.

### §3.1.2 Worker topology and attach {§cli-workers-topology}
One AG-UI stream binds one conversation worker. Descendants of that worker reach
a client only through the daemon's correlated projection (plurnk-service#440, the
lane presentation of #38), never by inference; unrelated workspace workers never
render inside a session. What the daemon correlates (a direct child's mutations, messages,
executions, launches and conclusion) renders in the conversation as lineage rows (§5.1). The
TUI also asks the daemon to observe its delegation (`forwardedProps.plurnk.descendants`,
plurnk-service `{§agui-delegation-observation}`): every descendant's own rows and executions
arrive introduced by `plurnk.descendant` and render as §5.1 says; a descendant's reasoning,
steps and terminal never do. Navigation between workers is explicit.
`/attach <name>` rebinds the session's thread to that name with the world
unchanged: an existing worker is bound, a new name mints a fresh conversation on
the next run, exactly as `--worker <name>` at invocation. The verb reports
`(bound)` or `(new)` from the workspace directory, re-reads the worker's durable
policy, and the header and status line adopt the name.
`/workers` renders `workspace.workers` as a forest of parent/child trees from
`parentWorkerId`: the bound worker's tree first with the bound worker marked `●`,
other workers `○`, siblings newest first, each row carrying the worker's origin
(`model`, `client`, `_plurnk`) and creation time, a worker whose parent is not in
the directory standing as a root. The map carries no lifecycle: a worker's state
is seen by being in it. `plurnk workspace workers <name>` (§7.3) keeps its flat
table.

**Topology is navigation, not a dashboard** (plurnk-service#523). A child worker
is a first-class place the user goes to, prompts, forks, or makes the root of
another session. One hop is a full `/attach` of the target, never a read-only
visit; the composer then speaks to that worker. The hops follow vim's tree
orientation, depth horizontal and siblings vertical, as `Alt-h/j/k/l` and as
verbs for terminals that swallow Alt:

| Hop | Key | Verb | Target |
|---|---|---|---|
| parent | `Alt-h` | `/parent` | the bound worker's parent; at a root, `(at the root: no parent)` |
| enter | `Alt-l` | `/enter` | the newest child; none, `(no children)` |
| older | `Alt-j` | `/older` | the next older sibling, wrapping |
| newer | `Alt-k` | `/newer` | the next newer sibling, wrapping |

Places are conversations and their descendants (`origin: model`); the daemon's
maintenance worker and a connection's scratch worker are never hop targets, so a
lone conversation has `(no siblings)`. Every hop re-reads the directory; nothing
is inferred from row coordinates. `/help` moves to `Alt-?` to free `h`.

**Position.** The line below the composer names the place, `[<workspace>/<lineage>(<loop>/<turn>)]`:
the lineage from the tree root to the bound worker with `~` marking the worker the session
is in, a presentation marker rather than a URI alias, and the loop and turn beside
the worker they belong to. `[w/~main(3/12)]` at a root, `[w/main/fork-1/~recheck(1/0)]` two
hops down, `[/~]` before the worker is named; an unknown loop or turn is elided. A child
always shows that it is a child, so a session opened on a child reads its full lineage. The
§1.2.1 footer includes the place after the project folder and before activity, so the composer has one line above it
and the transcript keeps the line a separate status row used to take. The status line's
worker segment carries the sibling position when there is one: `worker://recheck/ (2/3)`,
newest first (§1.2.1).

### §cli-conversation-history Conversation history on attach

Startup and successful workspace/worker navigation synchronize through the existing
AG-UI Run `{§agui-conversation-sync}` before admitting new bound work. Synchronization
submits no prompt and performs no inference. An attached live loop remains observable;
disconnecting that observer does not cancel independently-owned work.

| Surface | History behavior |
|---|---|
| Bound recent tail | `log.read` supplies durable order and operation outcomes; `MESSAGES_SNAPSHOT` supplies conversation speech. `PLURNK_CLIENT_HISTORY_ENTRIES` bounds the tail; zero hides history without disabling synchronization. The service's read ceiling still applies. |
| Prompts and replies | Full text, in chronological order, with actor attribution. Rows committed after the snapshot retain their own authoritative body. |
| Operations | Existing one-line operation headings, including failures; no historical output fetching. |
| Reasoning | Never backfilled into the live reasoning lane or scrollback. |
| Past/live boundary | A quiet count of earlier displayed entries and `/log` for more. Unchanged overlapping receipts are shown once by durable identity; updates to the same receipt remain visible. Identical text at different identities is not deduplicated. |
| State/accounting | Replayed entries are not live activity, turns, terminal events, or fresh usage. Only the current gauge and subsequently observed events update status. Elapsed session time does not include time before attachment. |
| Return visits | Each explicit binding restores its current bounded tail. Existing terminal scrollback stays intact. Input recall is separate. |

Historical restoration completes before buffered live rows are released. Binding
transitions retain the draft and keep control commands reachable; no historical
prompt is resubmitted. A malformed snapshot or failed history read is reported,
not presented as an empty conversation.

### §3.1.3 Inspection {§cli-inspection}

`/look <address> [<scope>] [pattern]` reads a resource for the human, never for the model.
The client composes the LOOK fence and submits it through the `op.look` observation
action, which resolves `log:///` as the bound conversation and writes no log entry. The
daemon parses that statement, so the client composes it at the operation fence width the
service declares (`PLURNK_FENCE`, {§operation-fences}) — never at its own literal.
Explicit source addresses (`ops://<worker>/…`, `reasoning://<worker>/…`, and
`note://<worker>/…`) retain the named workspace worker's identity. A typed ```````LOOK (…)```````
fence takes the same path. The readout is a local human record printed above the
composer: the heading as submitted, then the content verbatim; an empty result says so in
the daemon's words; an unsuccessful one names the Problem title, with its detail and
recovery beneath. Inspection touches no loop lifecycle, summary, or tally, and stays
available while a loop runs. Alt-p and Alt-n cycle the real targets of the bound
conversation's prior operations, including client-authored operations on that binding,
into an empty composer as `/look <target>`, an editable
starting point; a composer holding anything else is left alone.

### §cli-active-command-admission Commands during an active run

Model inference and client actions are independent AG-UI runs. A command is not
refused merely because inference is active. The daemon owns admission of model,
reasoning, capability, and Functionality changes; its exact Problem is shown
without changing the client's selected policy after a refusal.

| Input | During a model run, including an interrupt awaiting review |
|---|---|
| Inspect, Functionality, model/policy commands | Ordinary action path; no inference, model-run summary, or tally of their own |
| `/help`, `/import`, `/editor`, `/yolo` | Ordinary local behavior; the composer remains editable |
| `!`, executable fences, `/script` | Client-owned operation run; its results and proposal resolutions remain separate from the model run |
| Plain prompt or `...` | Inject into the bound conversation; observe an admitted successor through the standard sync Run after the existing stream settles |
| `?`, or `:` removing an active `?` request | Explain that the local review choice belongs to a new run; do not silently strip it and inject |
| `/stop`, proposal responses, question responses, `/quit` | Remain reachable; resolve the identified owner, never whichever request arrived last |
| `/workspace`, `/rename`, `/worker`, `/attach`, topology hops | Refused until the attached model run and submitted commands settle, with that specific reason |

The TUI presents one attached conversation. Navigation does not implicitly cancel
or detach its stream. Its binding cannot change halfway through a command; a
navigation already underway admits no new bound work until confirmation. An
action and every interrupt resume retain the workspace and thread captured at
submission. Overlapping proposals resolve by proposal ID. This single-view
restriction is TUI-owned, not a daemon restriction on independent conversations.
Each stream reduces its own state; action snapshots do not replace the active
model's status. Cancellation retires only the cancelled run's interrupts and
local waits, including when its SSE has already ended at a question or proposal.

Pending injection acknowledgements keep the conversation attached through terminal
observation. `injected_next_turn` stays on the existing stream;
`enqueued_new_loop` requests one successor observer, not a replayed prompt. Sync
uses {§agui-conversation-sync} and restores unseen durable rows before releasing live
rows, with bounded `log.read` and the standard message snapshot, retaining its pre-attachment conversation-row cursor; independent
client-operation rows cannot advance that cursor. A successful observation without a
new `plurnk.terminated` event adds no synthetic loop summary, usage, or tally.
Malformed or incomplete history fails visibly rather than claiming lossless recovery.

Questions use their own inline controls under {§cli-inline-review}. Input there
is answer data, including slash-prefixed text. In the composer, all input keeps
its ordinary command/prompt meaning; `/cancel` cancels the pending review.

### §3.2 Cancellation {§cli-cancellation}

`/editor` (Alt-e) composes the current multiline value in `$VISUAL`/`$EDITOR`
(fallback `vi`): the value seeds a tmpfile buffer and the editor's result is
placed back in the composer, never auto-submitted. Enter remains the only submit
gesture. An empty buffer leaves the value unchanged. pi-tui relinquishes and
reclaims terminal custody for the bounded editor process.

In an inline review, `Esc` returns to the composer without resolving or
cancelling the interrupt. In the composer, while a dispatch is in flight it
fires `loop.cancel` (reason `user_escape`) through the identical cancel path;
while idle it clears the composed value. Esc never exits.
pi-tui owns escape-sequence reassembly and keyboard-protocol negotiation.

`Ctrl-C` during an in-flight dispatch fires the `loop.cancel` action — the daemon aborts the model run's active drain, the pending loop resolves with `finalStatus: 499`, and the editor continues. A failed cancel SURFACES on the terminal. A second `Ctrl-C` (or `Ctrl-C` while idle) exits — the escape hatch for dispatches a drain-cancel cannot unblock (`op.parse`). (Dropping a conversation run's SSE also aborts its loop — hangup is the abort; `loop.cancel` is the addressable spelling.)

CLI mode mirrors this: first `Ctrl-C` cancels (the loop resolves 499 → exit 3 per §4); second `Ctrl-C` force-exits 3.

### §3.3 `/import` and bracketed paste {§cli-import-and-bracketed-paste}

`/import <path>` reads a **local** file (co-location law — the client reads its own fs, the daemon never sees the path) and inserts its content at the editor cursor. Relative paths resolve against cwd; an unreadable file prints an error and is a no-op.

**Bracketed paste.** A multiline paste is one editable value and therefore one
submission, never one `loop.run` per line. pi-tui owns bracketed-paste framing;
small pastes remain native lines and large pastes become one expandable marker.

### §3.4 Workspace MCP controls {§cli-workspace-mcp-controls}

{§cli-configuration-source} Subsystem listings (`mcp`, `skills`, `a2a`, `schedule`,
`members`, `env`) append `source=<provenance.source>` when the daemon supplies
that field. The client does not infer a source, open its path, or resolve a
configuration cascade. Ownership and readiness remain separate; absent provenance
adds no placeholder. Positional and interactive commands use the same projection;
JSON output retains the complete action result.

MCP management is a thin projection of the daemon's `mcp` Functionality
family: the common lifecycle plus the MCP OAuth continuation. The client
composes one exact `McpServerDefinition` and renders the daemon's states; it
reads no MCP configuration. The cascade, workspace persistence, registry search,
connections, authorization and tool filtering belong to the daemon. `add`
persists a workspace definition, not a plugin installation; `remove` restores
any inherited definition and enabled state. An inherited server is disable-only.

The interactive and positional forms share one tokenizer-independent command
handler. `plurnk mcp …` uses the workspace selected under §1.1;
`--json` emits the unmodified successful action
result.

| TUI / CLI input | AG-UI+ action |
|---|---|
| `/mcp` / `plurnk mcp` | `workspace.mcp.list {}` — one row per server: alias, state, `type`, command or URL, active tool count, and `(workspace)` for a locally added definition |
| `/mcp discover <query>` | `workspace.mcp.discover {query}` — one row per MCP Registry candidate: alias, `type`, command or URL, and the daemon's summary of how it launches and what it needs |
| `/mcp add <alias> <command\|url> [args...]` | `workspace.mcp.add {alias, definition}` — an absolute `http(s)://` target is `{name: alias, type: "streamable-http", url}`, anything else `{name: alias, type: "stdio", command, args}` without `args` when none follow |
| `/mcp enable <alias>` | `workspace.mcp.enable {alias}` — publishes a dormant server or retries an unavailable one |
| `/mcp disable <alias>` | `workspace.mcp.disable {alias}` |
| `/mcp remove <alias>` | `workspace.mcp.remove {alias}` |
| `/mcp oauth <alias>` | Inspect the alias; if not active, bind a loopback callback, call `workspace.mcp.oauth.begin {alias, redirectUrl}`, open the returned authorization URL and call `workspace.mcp.oauth.complete {alias, callbackUrl}` |
| `/mcp oauth <alias> <callback-url>` | Submit the complete callback directly to `workspace.mcp.oauth.complete {alias, callbackUrl}` (remote/headless continuation) |

Every token after a command target reaches the server verbatim; a URL target
takes none. The positional form uses `--` before server options so the client
does not consume them: `plurnk --workspace w mcp -- add example npx -y @example/server`.

An add or enable requiring authorization prints the alias (or authorization URL
when already available) and exact `/mcp oauth …` command. It does not itself open
a browser. Daemon Problems cross the
existing diagnostic path without rewriting or retry.

#### OAuth callbacks {§cli-mcp-oauth-callback}

Beginning sign-in does not enable or publish capabilities. A begin result with
an authorization URL opens consent; an already-active result or an accepted
connection awaiting publication closes the listener without opening a browser.

Automatic reception binds an OS-assigned port on the IPv4 loopback interface
before requesting authorization (RFC 8252 §7.3). An explicit fixed callback
instead binds that exact HTTP loopback IP and port; it is never rewritten.
The callback is transient client session state, not a persisted definition.
The daemon's authorization URL must name the already bound callback. The listener
accepts one GET with the exact Host, path and state; unrelated requests cannot
consume the attempt. Duplicate response parameters and duplicate callbacks
are rejected. The complete callback is forwarded once; only the daemon's
accepted result produces a success response. The browser and client say
“Sign-in accepted; tools awaiting activation.” They do not claim tool readiness
or wait for capability publication; normal workspace inspection reports it.
PKCE, issuer checks and token exchange
remain daemon-owned. Callback codes are neither printed nor retained.

The listener closes on completion, failure, cancellation or the client panel's
`PLURNK_CLIENT_OAUTH_TIMEOUT_MS` deadline and cannot keep an exiting client
alive. An unavailable browser leaves the URL available to open manually while
the listener remains active. Occupied ports, non-loopback or HTTPS redirects
require direct callback submission; the client starts no remote listener or
SSH forwarding and does not change the MCP definition.

### §3.5 Universal Agent Skills {§cli-universal-agent-skills}

Agent Skills management is a thin projection of the daemon's `skills`
Functionality family — the same common lifecycle as `/mcp`. The client
composes one exact `SkillDefinition` and renders the daemon's states; it
runs no package manager, reads no registry, parses no frontmatter, and keeps
no parallel package metadata. The daemon resolves every source: local folders
stay live references and Git/archive copies belong to workspace state. The standard
universal roots (`.agents/skills` in the project, `~/.agents/skills` globally)
stay interoperable with every other agent, beside plurnk's own
`$XDG_CONFIG_HOME/plurnk/skills`; a skill placed in any of them by any other
tool is admitted by the daemon at the next turn. These roots are configuration
inputs, never installation targets of `/skills`. Removing a workspace binding
preserves its source and restores any inherited definition and enabledness.

| TUI input | AG-UI+ action |
|---|---|
| `/skills` | `workspace.skills.list {}` |
| `/skills discover <source>` | `workspace.skills.discover {source}`; a source is a git remote as a full https or ssh URL, a folder, a lone `SKILL.md`, or a zip or tar archive |
| `/skills add <name> <source> [--ref <ref>]` | `workspace.skills.add {alias, definition: {name, source, ref?}}`; names retain their standard digit-leading and Unicode forms |
| `/skills enable <name>` | `workspace.skills.enable {alias}` |
| `/skills disable <name>` | `workspace.skills.disable {alias}` |
| `/skills remove <name>` | `workspace.skills.remove {alias}` |

Daemon Problems — an unreachable source, a moved ref, a missing project root, a
service-owned skill that cannot be removed — cross the existing diagnostic
path without rewriting or retry. The list shows a git source's ref and the
commit it was added at.

### §3.6 Outbound A2A agents {§cli-outbound-agents}

Outbound A2A agents are a thin projection of the daemon's `a2a`
Functionality family — the same common lifecycle as `/mcp` and `/skills`. The
client composes one exact `A2aAgentDefinition` and renders the daemon's
states; the remote Agent Card, connection, and enablement policy live in the
service, and the model addresses an enabled agent as `a2a://<alias>`.

| TUI input | AG-UI+ action |
|---|---|
| `/a2a` | `workspace.a2a.list {}` |
| `/a2a discover <url>` | `workspace.a2a.discover {source}` — one inert card-derived candidate |
| `/a2a add <alias> <url> [options.json]` | `workspace.a2a.add {alias, definition: {name: alias, url, ...options}}`; `options.json` supplies `cardPath`, `headers`, `authorization` |
| `/a2a enable <alias>` | `workspace.a2a.enable {alias}` |
| `/a2a disable <alias>` | `workspace.a2a.disable {alias}` |
| `/a2a remove <alias>` | `workspace.a2a.remove {alias}` |

Invalid or unreadable local JSON fails before dispatch; daemon Problems — an
unreachable card, an unsupported interface, an unresolved symbolic credential —
cross the existing diagnostic path without rewriting or retry.

### §3.7 File members {§cli-file-members}

File membership is a thin projection of the daemon's `members` Functionality
family — the same common lifecycle as `/mcp`, `/skills`, and `/a2a`. The
client composes one exact definition, `{glob}`, and renders the daemon's
states; resolution, the model's ceiling, and enablement policy live in the
service. Git-tracked files are members on their own. A definition is one
gitignore-style glob relative to the project root: it includes matching
untracked files or, with a leading `!`, excludes matching members — an
exclusion wins over every inclusion. The glob is one argument, tokenized
exactly as the sibling families tokenize theirs (quote it to keep whitespace).

| TUI input | AG-UI+ action |
|---|---|
| `/members` | `workspace.members.list {}` — one line per definition with what its glob resolved to: `docs  service  active  include docs/** → 12 files (3 ignored)`, `no-tokenizer  worker  active  exclude **/tokenizer.json → 4 members` |
| `/members discover <path>` | `workspace.members.discover {query}` — one candidate explaining why the file is or is not a member |
| `/members discover <glob>` | `workspace.members.discover {query}` — one candidate previewing what `add` would include or exclude |
| `/members add <alias> <glob>` | `workspace.members.add {alias, definition: {glob}}` |
| `/members enable <alias>` | `workspace.members.enable {alias}` |
| `/members disable <alias>` | `workspace.members.disable {alias}` |
| `/members remove <alias>` | `workspace.members.remove {alias}` |

Daemon Problems — a headless workspace, an invalid pattern, a service-owned
definition that cannot be removed — cross the existing diagnostic path without
rewriting or retry.

### §3.8 Environment {§cli-environment}

The environment is a thin projection of the daemon's `env` Functionality
family — the same common lifecycle as `/mcp`, `/skills`, `/a2a`, and
`/members`. Unqualified commands use `worker.env.*`; `--scope workspace` before
the verb selects `workspace.env.*` for shared defaults. `--scope worker` is
explicitly local; both space-separated and `--scope=workspace` forms are accepted.
The transport binds the active workspace and worker. The client composes one
exact definition, `{value}`, and renders the daemon's states; admission (the
shell's name grammar, never plurnk's own names), the operator's ceiling, and
the composition at the spawn live in the service. A value is used verbatim by
the daemon, so `add` hands over the rest of the line as typed, never tokenized.

| TUI input | AG-UI+ action |
|---|---|
| `/env` | `worker.env.list {}` — one line per name with origin, state, value, and the worker it was inherited from: `PATH  service  active  /usr/bin:/bin`, `TOOLCHAIN  worker  active  stable  (from alice)` |
| `/env discover [query]` | `worker.env.discover {query?}` — the names this worker may set, each with its owning package and the declaration's comment; an empty query is the whole catalog |
| `/env add <NAME> <value>` | `worker.env.add {alias, definition: {value}}` |
| `/env enable <NAME>` | `worker.env.enable {alias}` |
| `/env disable <NAME>` | `worker.env.disable {alias}` — an ambient name disabled here is withheld from this worker's commands alone |
| `/env remove <NAME>` | `worker.env.remove {alias}` |
| `/env import <path>` | `worker.env.add` once per variable of a dotenv file — each lands or is refused exactly as a typed `add` would, and a summary names the scope that received them: `imported 3 of 4 into this worker only`. The path resolves from the launch folder, as `/import` does; Node's dotenv parser reads it. |
| `/env --scope workspace [verb]` | The same verb and input under `workspace.env.*`; no verb, or `list`, lists that scope. |

Worker lists include workspace defaults with `origin: "workspace"`. These defaults
also reach shared MCP launches; worker overrides do not. Existing processes retain
their launch environment; clients do not restart them automatically.

Daemon Problems — a name a shell cannot export, one of plurnk's own names, a
service-owned definition that cannot be removed — cross the existing
diagnostic path without rewriting or retry.

---

### §3.9 Scheduled messages {§cli-schedule}

Scheduled messages are a thin projection of the daemon's `schedule`
Functionality family — the same common lifecycle as `/mcp` and `/a2a`. The
client composes one exact definition (`rule`, `target`, `prompt`)
and renders the daemon's states; the clock, the rule's canonical
form, the timers and the delivery live in the service, and an occurrence
reaches its worker as an ordinary message from `schedule://<alias>`.

| TUI input | AG-UI+ action |
|---|---|
| `/schedule` | `workspace.schedule.list {}` — each rule with its state, wording, next occurrence or `exhausted`, and target |
| `/schedule discover <rule>` | `workspace.schedule.discover {source}` — one inert candidate whose summary opens with the current time in the effective zone |
| `/schedule add <alias> <worker> <rule> <prompt...>` | `workspace.schedule.add {alias, definition: {rule, target: worker://<worker>, prompt}}`; the receiving worker retains its owner |
| `/schedule enable <alias>` | `workspace.schedule.enable {alias}` |
| `/schedule disable <alias>` | `workspace.schedule.disable {alias}` |
| `/schedule remove <alias>` | `workspace.schedule.remove {alias}` |

Incomplete arguments print the exact usage and dispatch nothing; daemon
Problems — an unreadable or unbounded rule, an unknown zone, a missing target
worker — cross the existing diagnostic path without rewriting or retry.


## §4 Exit codes {§cli-exit-codes}

| Code | Meaning |
|---|---|
| `0` | Loop terminated successfully (`finalStatus === 200`) |
| `1` | Runtime error (module unreachable, action error, daemon crash, etc.) |
| `2` | The worker tree spent its model-call budget ({§turn-cap-counts-the-tree}; `hitMaxTurns === true`) |
| `3` | Loop terminated with cancellation (`finalStatus === 499`, including `--timeout`) |
| `4` | Loop FAILED (4xx/5xx terminal status other than 499) — failure ≠ cancel, so benchmark stats stay honest |
| `64` | Usage error (missing required env var, unrecognized flag) |
| `130` / `143` | SIGINT / SIGTERM interruption; see {§cli-interrupted-record} |

TUI mode always exits `0` on clean shutdown; loop outcomes are surfaced in the summary line, not the exit code.

---

## §5 Rendering {§cli-rendering}

### §5.0 Presentation loading {§cli-presentation-loading}

Presentation dependencies load at their owning interface,
not through shared wire formatting. Imports use the native module cache; load
failures remain causal errors, never a silent replacement rendering mode.

| Path | Presentation initialization |
|---|---|
| Help/version, plain/JSON CLI, state commands | No pi-tui, Markdown, Mermaid, or diagram-layout initialization. |
| TUI | Load the terminal implementation when selected; message rendering stays synchronous. |
| `render --help` | Help only, without initializing the renderer. |
| `render` | Load the Markdown/diagram renderer before producing output; no pi-tui or daemon. |

### §5.1 `log/entry` line format {§cli-log-entry-line-format}

Received operation rows render as below, except delivered message blocks (§5.4)
and the aggregation and suppression rules in this section.
A row is the operation as written, literal text with the client's own styling and never a
Markdown pass:

```
<OP> (<target>) [<scope>] [<pattern>] [{<n>}] [<aside>] [— <problem title>[: <diagnostic>]]
```

- `OP` is the operation's name, bold: green when the outcome succeeded, red otherwise. An
  execution row is named by its runtime (`sh`, `python3`): the row's `op` is the fence name as written, never a generic keyword.
- `(target)` is the authored target text, in its parentheses; `<scope>` is the canonical
  `<mark,...>` form; `<pattern>` is the matcher as authored (`/regex/i`, `~query`, `&symbol`).
  COPY and MOVE render `(source) <scope> (destination) <scope>`, each scope beside its own path.
  `*.md` is not emphasis, `<17,-1>` is not markup, `/^# /` is not a heading.
- `{n}` is what the receipt returned, in the receipt's own unit, on every READ and FIND row:
  a FIND's returned items, an exact READ's returned lines (a pattern READ carries its matched
  lines as `lineOrdinals`), a collapsed glob READ's paths. Pattern, scope, and metadata compose
  into what is returned and are never operative for the count. No other operation carries a count.
- The aside is the durable operation aside as sanitized literal text, italic and dim, never
  interpreted as Markdown or HTML.
- A lineage row, a direct child's durable activity the daemon correlated into this
  conversation's log (`origin: _plurnk` with `source: worker://<name>`), renders two columns
  in, led by `🐜 <name>` in dim, its body previewed beneath one step deeper. Its outcome is the
  row's own: a child's execution concludes in the child's Run, so its lineage row is never held
  for a stream conclusion. A child's conclusion is the parent's own READ of `ops://<name>/<loop>`,
  an ordinary row carrying the child's terminal status and Problem title; it takes no mark
  ({§cli-workers-topology}).
- An observed descendant's own row (the TUI asks the daemon to observe its delegation,
  `forwardedProps.plurnk.descendants`; each descendant arrives introduced once by
  `plurnk.descendant` with its name and generation) renders one step in per generation, two
  columns each, led by `🐜 <name>` in dim, its body previewed beneath, and its execution's
  conclusion and output peeks stepped in the same way. It never drives the turn presentation,
  the status line's activity, the LOOK cycler, or the response area, and an observed
  descendant's lineage rows are not rendered a second time. Outside a descendant's row the ant
  is the status line's child count.
- Every authored body renders beneath its row as a preview: the plain text, no Markdown pass,
  `PLURNK_CLIENT_PREVIEW_LINES` lines (`--preview-lines` for one invocation), independent of
  the terminal's height, four columns in and dim (the reasoning lane's fade, never italic),
  each line one row: a line wider than the terminal is cut at its width and ends in `…`, a tab
  counting four columns ({plurnk#162}), so three lines of minified output are three rows.
  The preview ends in `… +N lines · /look <address>` when lines are cut, and a blank row closes the block. A
  concluded execution's output previews the same way under its row, and its blank row follows
  the output. Model NOTEs render whole, in the Markdown layout but dim ({§cli-note-rendering}), including within
  an observed descendant's indentation; runtime NOTEs stay whole and plain. Delivered answers
  also render whole (§5.4);
  the reasoning lane (§5.1.1) is a separate, live window.
- An unsuccessful outcome (`status_rx >= 400`) names the structured result's own `problem.title`
  (else its `detail`, else the bare status) at the right of the row. A nonblank string
  `problem.diagnostic` follows the title after `: `, unless identical to the title.
  Both are terminal-safe literal text with whitespace collapsed for the row, never Markdown.
  Ordinary rows, collapsed failures, history replay, and known or unknown stream conclusions
  use the same presentation; absent or non-string diagnostics add nothing. The client neither
  interprets output bodies to invent an explanation nor changes the wire result.
  A 204 is not a failure: a FIND counts `{0}`; a glob READ that matched no path carries the
  daemon's detail instead of a count.
- No body, preview, hit count beyond `{n}`, byte count, numeric status, glyph, or log coordinate
  reaches the row; coordinates and every exact status remain on the wire and in `--json`.

A glob READ lands one receipt row per path, each stamped `attrs.fanout` by the service
(`{target, matched, index, count}`). The waterfall shows the authored statement once, when
the row with the last index arrives: the glob as the target and `count` as `{n}`; a failed
path names the collapsed row. A started execution (status 200, outcome `started`) has no
outcome yet: the service stamps its stream address on the row (`attrs.stream`), and the row
appears when that stream concludes, colored by the conclusion (§5.3). An execution still open
when the following turn begins shows once in grey, with no outcome, and again when it concludes;
a detached execution (`<-1>`) is covered by the same rule, greyed at the next turn and shown
again when it eventually ends.

Width-tolerant; no fixed column widths. Every row begins at column zero.

**Exceptions:** delivered conversation replies render as blocks per §5.4. The TUI moves each submitted editor value into ordinary terminal scrollback — bold, in the human's colour (§5.5), with a blank row above and below, so the human's turns read apart from the model's plain replies — and its inbound SEND echo is not rendered again (`isOwnArrival`). Arrivals from other actors remain visible with their causal source.

#### §5.1.0 Markdown projection {§cli-markdown-projection}

A prettified message body (TUI only; the one-shot CLI keeps raw verbatim for
pipes) delegates GFM parsing and terminal layout to maintained renderers at
the current terminal width, less its container indentation. Nested blocks start
on separate lines; prose, code, and source wrap without truncation. Tables use
aligned box-drawn columns, wrap complete cell content, and separate every
logical row; headings, inline markup, lists, and links retain conventional
terminal presentation, while ordinary fenced code begins with a `💻 language`
header. A block's gutter belongs to every row it produces, wrapped rows included,
and the gutter's columns come out of that block's width rather than out of the
viewport. A ```mermaid fence projects as
a topology- and label-preserving Unicode diagram when it fits the same live
viewport. Preserve the authored layout when it fits; otherwise try one alternate
flowchart layout exchanging horizontal and vertical directions, including explicit
subgraph directions. Both attempts share the `PLURNK_CLIENT_MERMAID_TIMEOUT_MS`
execution deadline from the client panel. An error, unsupported diagram, or
expired deadline renders the complete source under
`💻 mermaid — diagram failed to render`; a valid but still-overwide diagram uses
the ordinary `💻 mermaid` header. An invalid deadline is diagnosed in that same
fallback header without preventing the rest of the message from rendering.
Decide the projection before appending it;
there is no delayed replacement, recovery narration, or half-drawn diagram. The wire always
carries semantic source; no pre-rendered channel exists at the protocol boundary.

#### §5.1.0a Local rendering filter {§cli-render-filter}

`plurnk render --width <columns>` is the renderer's daemon-free Unix filter:
it reads semantic Markdown from stdin and writes one width-bounded plain-Unicode
projection to stdout. It loads only the packaged environment floor beneath
exported settings and explicit options, not operator configuration files. It
performs no model work, network activity, startup narration, or ANSI styling. Other clients may discover this
optional executable for presentation while retaining their protocol-native
transport and a faithful source fallback. `plurnk render --help` begins with
the exact filter synopsis and is the side-effect-free capability probe; clients
must not send semantic content to an unproven executable.

#### §5.1.1 Provider reasoning {§cli-provider-reasoning}

Readable provider reasoning is neither working memory nor assistant speech. The client
consumes AG-UI's standard `REASONING_MESSAGE_START/CONTENT/END` lifecycle.
The TUI shows a dim `💭` tail, at most one third of the terminal, below operation
history and above delivered responses. It disappears when reasoning ends;
reasoning history remains available from the daemon, not duplicated into scrollback.
It never infers reasoning
from NOTE, renders encrypted reasoning as text, or invents an empty transcript.
The one-shot client streams this human trace to stderr; stdout remains the bare
answer and JSON mode remains silent.

#### §5.1.2 Response ordering {§cli-response-order}

The TUI orders operation history, live reasoning, then delivered responses. Operations
render when their receipts arrive. Responses from a continuing turn enter scrollback
when the next turn begins; final responses remain below reasoning until the next user
interaction or conversation switch. No task inventory or fixed task-table slot exists.
Every response line fits the current viewport, including plain text and JSON;
resizing rewraps the retained content through pi-tui's ANSI-aware text layout.
Unchanged response projections, including diagram failures, are reused across
refreshes and archival; only a width or presentation invalidation rerenders them.

| Operation | Waterfall projection |
|---|---|
| NOTE | {§cli-note-rendering} A model NOTE renders its whole body in the Markdown layout at the current width, stripped of every weight and painted dim — the status line's weight — with the same blank lead/aside and column-zero layout as a reply, so bearings never read as an answer. Its log identity and failure visibility remain; it is not a delivered message and does not enter CLI response stdout. A harness NOTE retains its operation heading and whole plain, dim, four-column-indented body. |
| Outside text (`plurnk.outside`) | {§cli-outside-text} A turn's prose outside its fences arrives once per turn as `CUSTOM plurnk.outside` ({§agui-outside-text}: its log coordinate, the text verbatim, its packet weight), never as a row. It renders with a reply's layout — blank lead line, full Markdown body at column zero at the current width — where the turn's rows are, in arrival order. It is not speech: never the response surface, never a delivered reply, never CLI stdout. The one-shot CLI traces the text verbatim to stderr, and the `--json` record's `response` excludes it. |
| WAIT | Ordinary heading, aside and any receipt detail; never assistant speech. |
| Delivered conversation SEND | Message block per §5.4. |
| Other SEND | Operation heading and actual receipt detail or Problem. |

Loop state comes from the daemon's status events, not an inference from a verb or body.

### §5.2 Summary line (per `loop.run`) {§cli-summary-line-per-looprun}

```
  <tag> · <N> turns · <wall>ms · ↓<input> ↑<output> [· cur <percent>/<budget>] [· ctx <percent>/<capacity>] [· loop $<usd to the hundredth of a cent>]
```

`tag` derives from the exact terminal `OperationResult`. A 500 is `strike-out` only for `engine/rails/strike-threshold`; exhausted invalid emission is `invalid emission`, and another 500 is `failed`.
Input and output are the conventional aggregate fields from the daemon's accounting envelope. Missing token quantities render as `?`; zero or unavailable aggregate cost is omitted; a nonzero exact decimal is rendered without floating-point conversion. JSON output retains the complete accounting evidence.

### §5.3 What is NOT rendered {§cli-what-is-not-rendered}

- The full packet (`turn.packet`). The client never displays the rendered index or model-facing log sections.
- Whole bodies. Every body but a NOTE's is a preview (§5.1); human inspection uses LOOK (§3.1.3), while `plurnk read` retrieves a complete log entry.
- Raw SSE frames.
- Emission rows. A `_plurnk` READ whose `attrs.kind` is `emission` is the daemon's announcement of the worker's own admitted emission, whose operations already render as their own rows. The TUI waterfall, history replay, LOOK cycler and CLI trace skip it; `--json` and `plurnk read` keep it.
- Stream telemetry. A `stream/event` (start, growth, per-channel close) writes nothing to the waterfall, and the TUI previews a concluded execution's output under its row (§5.1). An execution appears once, when its outcome is known: the conclusion renders the launching fence's row (§5.1), green for exit 0 and red otherwise with the result's Problem title or the daemon's summary as its outcome. A stream whose launch is unknown renders as its scheme and address in the same grammar. Wake bookkeeping is never a row. Activity while a stream runs belongs to the status line. One bounded exception stays for the human's own command: a client-typed `!` execution makes one `entry.read` on conclusion and inlines a channel's content only when it is ≤160 chars and ≤2 lines (stderr marked `!`), because the human asked for that output. The one-shot CLI keeps the same exception for every tiny concluded output. See §8.4.

### §5.4 Delivered messages {§cli-broadcast-send-rendering}

A successful SEND or accepted parameterless KILL whose receipt addresses the current AG-UI conversation carries response content, including an exact-address reply or another actor's delivered reply observation. An unsolicited targetless model reply also qualifies. The interactive client renders full message bodies, not diagnostic previews; an unrelated worker or protocol recipient does not become conversation speech. A deferred KILL renders its continuation or parking detail as an operation, never its undelivered answer body. An empty KILL does not repeat a previous reply.

TUI mode contract:

- Lead line: no keyword and no glyph. A final KILL answer's lead line stands blank, as a SEND's does where `SEND` was; the sanitized aside follows. The body's lines stay at column zero. No numeric code, no path.
- Body: follows the lead line at column zero, without indentation, truncation, or dimming; §5.1.0 owns Markdown layout.
- No synthetic surrounding blank rows.
- Empty SEND content is legal and renders as just the lead line.

A delivered conversation response is plain: its Markdown carries the only emphasis
(headings, `**strong**`, table heads), and the human's own line — bold, in the human's
colour, spaced (§5.1) — is what sets the two voices apart. Delivery alone makes a message
block: a failed, unrelated, inherited or undelivered SEND, targetless or not, is an Other
SEND (§5.1.2). {§cli-color-policy} controls colour and emphasis without changing
layout. CLI delivered answers remain verbatim per §2.

CLI/one-shot mode: trace entries use stderr per §5.1; delivered response messages use stdout (§2).

The message body source is `entry.tx.body`, carrying `{ raw, json }`.

Successful (`200 ≤ status_rx < 300`) SEND rows contribute through their recorded
`answers` message addresses, independently of loop completion. Inherited rows and ordinary source
observations cannot deliver the same message again; a source-attributed `reply`
observation is a genuine delivery to this conversation.
Bodies accumulate in delivery order, separated by a blank line. NOTE and WAIT are not speech.

**CLI default** emits each qualifying body verbatim, without Markdown or
JSON transformation. **CLI `--json`** includes the aggregated `response` in the
single complete run record defined in §2.1, not a second body-only output format.

**TUI mode** (no `--json`; the flag is CLI-only) renders qualifying responses as blocks, dispatching by content type:

- **JSON** — `tx.body.json !== null`. Render `JSON.stringify(json, null, 2)`.
- **Markdown** — structural Markdown markers select the maintained renderer described in §5.1.0. Rich-client prose also normalizes the common inline token `$\rightarrow$` to `→`; this is not general LaTeX support. CLI output remains verbatim.
- **Plain (or anything else)** — emit the rich-client prose after the exact normalization above.

If `tx.body` is null, or `tx.body.raw` is absent or non-string, the body is treated as empty (stdout receives nothing for that broadcast).

### §5.5 Palette {§cli-palette}

`src/color.ts` names every colour and emphasis by role; no other module writes an escape code.
The five alert accents are the scheme — note blue, tip green, important purple, warning orange,
caution red — and semantic roles borrow from them: success and added diff lines are green,
failure and removed lines red, the human's line blue. Links, diff hunk headers and the
completion cursor are cyan. Secondary text uses the shared muted foreground, not ANSI faint intensity.

### §5.5.1 Colour selection {§cli-color-policy}

`--color` overrides `PLURNK_CLIENT_COLOR` through the normal configuration cascade.
Both accept only `always`, `auto`, or `never`; invalid values are usage errors (64).
For human-facing rendering, the first applicable rule wins:

| Condition | Colour and emphasis |
|---|---|
| Client choice `always` / `never` | On / off, overriding environment preferences |
| Nonempty `NO_COLOR` | Off |
| Nonempty `FORCE_COLOR` or `CLICOLOR_FORCE` | On, including pipes and `TERM=dumb` |
| `CLICOLOR=0` | Off |
| Otherwise | On only when the destination is a TTY and `TERM` is not `dumb` |

Empty preference variables are unset; force values have no numeric colour-depth
semantics. The nonempty conventions follow [NO_COLOR](https://no-color.org/),
[FORCE_COLOR](https://force-color.org/), and [CLICOLORS](https://bixense.com/clicolors/),
with `NO_COLOR` taking precedence over force requests.

Stdout and stderr are evaluated independently at rendering time. Styling never changes
layout. Raw one-shot answers, JSON, completion scripts, help/version text, and the
plain `render` filter receive no client-added styling, even when colour is forced.

### §5.5.2 Light and dark grounds {§cli-color-scheme}

The palette follows the terminal's ground, with no knob or theme catalogue.
The ANSI accents follow the terminal's own theme and never pivot. Fixed 256-colour roles are:

| Role | Dark ground | Light ground |
|---|---|---|
| Important | Purple 141 | Purple 97 |
| Warning | Orange 172 | Orange 130 |
| Muted | Neutral 145 | Neutral 60 |

The muted pair uses the 256-colour projection of Pi's built-in
[dark](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/dark.json)
and [light](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/light.json)
muted colours. Prompt borders, statuslines, summaries and inline code share this role;
ordinary response text retains the terminal's foreground.

The first known source decides:

| Source | Read by |
|---|---|
| The background the terminal reports (OSC 11): dark when white text contrasts with it more than black text (WCAG 2) | TUI |
| The terminal's light/dark report (DEC mode 2031); an announced switch asks for the background again | TUI |
| The background index in `COLORFGBG`: 0–6 and 8 dark, 7 and 9–15 light | TUI and one-shot CLI |
| None of these | The dark ground's palette |

The TUI asks only while colour is enabled ({§cli-color-policy}). Archived text keeps its colours;
live prompt borders, the footer and pending-review text repaint for the new ground even when their
contents have not changed. Subsequent output uses the new palette.

---

## §6 Proposal review {§cli-proposal-review}

Client-owned proposals arrive through standard AG-UI tool-call interrupts under
{§agui-proposal-disposition}. The client presents the proposal and resumes the
Run with the selected decision; the following sections describe its local review projection.

### §6.0 Worker ownership {§cli-worker-ownership}

The conversation's workspace-scoped AG-UI identity owns approvals. Prompt submission,
client operations, and explicit TUI attachment claim only runtime-owned conversations
and their runtime-owned descendants; observing another owner never transfers authority.
Every Run declares the client's capability set: `RunAgentInput.tools` advertises the
client tools it implements, not permission grants, and `forwardedProps.plurnk.interactive`
states whether a person attends it.

| Client mode | `interactive` | Advertised tools |
|---|---|---|
| Interactive terminal | `true` | `request_approval`, `question`, `mcp_input_required` |
| No terminal, or `--auto` | `false` | `request_approval`, including fail-closed headless resolution |

`--auto` (`PLURNK_CLIENT_AUTO`) states that nobody is attending, even at a terminal: the
daemon asks nothing, because its workers are not offered `question`, and a loop that would
wait for a person concludes instead. It removes
the person, not the approver: `--yolo`, configured acceptance, or fail-closed review still
settle what the daemon routes to this client.

The TUI maintains `/agui/connect` while idle and reconnects after a terminal or
resolved interrupt. Inspection and direct operations do not detach that owner
connection. Future owned work, including independently active children, can request
review without a new user prompt. Disconnect changes neither ownership nor pending gates.
Concurrent Runs share one local resolver per interrupt. A resurfaced gate does not
open another review or submit another decision; its observer resumes after the standard
`TOOL_CALL_RESULT` acknowledges settlement, without waiting for the approved work to finish.

`--yolo`, configured acceptance, and `?` remain client-side decisions. Server
`PLURNK_SERVICE_PROPOSALS` owns automatic server disposition. The retired `--policy`,
`--proposals`, `PLURNK_AUTO`, `PLURNK_CLIENT_LOOP_POLICY`, and `PLURNK_CLIENT_PROPOSALS`
fail and name their replacement; no approval policy travels with a message or schedule.

### §6.1 Notification shape {§cli-notification-shape}

```ts
loop/proposal {
    logEntryId: number,           // pending log_entries row
    loopId, turnId: number,
    op: "EDIT" | <runtime tag> | ...,
    target: { scheme: string | null, pathname: string | null },
    body: string,                 // udiff for EDIT; command summary for an execution
    attrs: object,                // scheme-specific payload (opaque to client)
    owner: string,                // workspace-scoped approval owner
    disposition: { decision: "review" },
}
```

AG-UI routes review to the recorded owner. Server `accept` and `reject` dispositions settle in Core and never become client review work.

### §6.2 Review menu (interactive) {§cli-review-menu-interactive}

When a proposal arrives and manual review is required, the one-shot TTY client
prints its menu to stderr. The TUI uses a pi-tui selection list under
{§cli-inline-review}. Both show the proposed body and offer accept, edit,
reject, and cancel. The one-shot menu is:

```
── proposal EDIT file:///path/to/file ──
<colored udiff>
[a]ccept · [e]dit · [r]eject · [c]ancel
```

Resolutions use the originating AG-UI interrupt identity:

| Key | Action |
|---|---|
| `a` | Resolved resume with `{decision: "accept"}` — apply body as-is. |
| `e` | Edit the body in `$VISUAL` / `$EDITOR` / `vi`; resume with `{decision: "accept", body: <edited>}`. An empty buffer cancels. |
| `r` | Resolved resume with `{decision: "reject"}`. |
| `c` | Cancelled resume. |

The one-shot raw-key menu cancels on other input. The TUI retains ordinary
commands and the `/accept`, `/edit`, `/reject`, `/cancel` spellings under
{§cli-active-command-admission}.

Udiff coloring for EDIT bodies: `+` lines green, `-` lines red, `@@` hunks cyan, headers (`+++`/`---`) bold. Execution bodies render plain.

#### Inline review {§cli-inline-review}

One arrival-ordered queue projects pending proposal and question interrupts by
their AG-UI identity. pi-tui controls replace the composer in the normal main
buffer; there are no overlays, alternate screen, or captured mouse gestures.

| Event | Presentation and input |
|---|---|
| First request arrives | Show its controls if the composer is empty; otherwise retain the draft and focus, with a pending-review hint. |
| `Esc` in review | Return to the same composer object, preserving its draft, cursor, undo and history. The request and any partial answer remain pending. |
| `/review` | Reopen the oldest pending request with its partial answer/selection intact. |
| Input in review | pi-tui owns selection, multiline editing, paste and cursor/IME placement. Enter confirms/submits; slash-prefixed answers are literal data. |
| Input in composer | Normal commands, inspection and prompt injection; proposal keys do not intercept ordinary letters. |
| Resolution or withdrawal | Remove only that interrupt. Show the next queued request if reviewing, otherwise retain composer focus. Restore the composer when no reviews remain. |

Reasoning, transcript and status updates continue while reviewing. A pending
submission cannot be submitted twice. An external-editor result belongs only
to its original still-pending proposal and cannot restart a closed client.
Resolution/editor failures surface
without discarding a still-pending request or silently cancelling it.
Successful local resolutions leave one concise decision/answered line in
scrollback; form redraws and answer values are not appended to the transcript
or prompt-recall history. The line acknowledges the human's resolution, not
the eventual execution outcome.

### §6.3 `--yolo` / `PLURNK_CLIENT_YOLO` {§cli-yolo-plurnkyolo}

Client-side, and on by default: the packaged defaults ship `PLURNK_CLIENT_YOLO=1`; `0` or `/yolo` turns it off. The startup header names explicit review as `yolo: off`; the default adds no header segment. When on, the proposal handler skips the menu and resumes the interrupt with `{decision: "accept"}`. The proposal still crosses the ordinary client-review boundary. A prompt that starts with `?` asks for review of that run: its proposals take the menu even while yolo is on.

This is distinct from server auto-approval, where the proposal never crosses into client review.

### §6.4 Configured tool acceptance {§cli-tool-acceptance}

Client-owned proposals use one ordered decision across CLI, scripts, and TUI:

| Condition | Resolution |
|---|---|
| Prompt starts with `?` | Review, regardless of automatic acceptance settings |
| YOLO enabled | Accept |
| Matching enabled runtime/tool rule | Accept |
| Otherwise | Review |

`PLURNK_CLIENT_ACCEPT_<runtime>` is an optional boolean switch. Runtime aliases
are lowercase, with `_` encoding `-`. An optional `_TOOLS` JSON array restricts
acceptance to exact tool names: no patterns, command-prefix matching, or body
inspection. The list alone enables nothing; `[]` accepts nothing. Restricted
matching requires the proposal's execution attributes to identify the same
runtime and exact tool target, not a resource-backed script. Without `_TOOLS`,
the switch accepts all proposals from that runtime.

These settings answer ordinary proposals; they do not grant capabilities,
change operation effects, or override server dispositions. Each automatic
resolution carries its reason through {§agui-proposal-resolve} into the durable
result. Invalid acceptance configuration emits a diagnostic and disables
selective acceptance, without blocking startup or changing YOLO.

### §6.4.1 No review terminal {§cli-fail-closed-no-review-channel}

When stdin is not a TTY, client-owned proposals are accepted by YOLO or matching
configured rules and otherwise rejected with `client_no_review_channel`.
Explicit `?` requests cannot be auto-accepted. Resolution still crosses the normal
owner-checked AG-UI resume boundary; the client does not change server policy.

A headless client advertises no clarification tools. Unsupported requests fail in
Core without parking or inventing an answer. If an already-pending interaction is
delivered after a mode change, the client cancels it through ordinary AG-UI resume.

Redirection alone does not request review. This applies when review is explicitly selected, such as `PLURNK_CLIENT_YOLO=0 plurnk "X" > answer.txt` or a prompt starting with `?`.

### §6.5 Questions {§cli-question-forms}

AG-UI `request_user_input` interrupts present the message and the exact response
contract. Independent, directly typed fields are collected individually; each
shows its type, required/optional status, and description. String enums use
pi-tui selection lists; optional enums include a Skip choice. Other fields use
the multiline editor, with empty Enter skipping optional fields. Unrestricted
strings accept free text; non-string values use JSON notation.
Complex schemas (including composed or referenced schemas and nested forms)
are shown whole and accept one JSON response object, without detaching schema
fragments from their reference or cross-field context. The contracts-owned JSON
Schema validator checks answers before submission. Invalid input remains
editable without advancing or losing earlier field answers. Empty forms
explicitly submit an empty object. Completed forms resume with the exact response-schema object.
From the composer, `/cancel` sends a cancelled resolution; `/stop`, `/quit`,
and `/help` remain available. Schema and resolution failures surface with their
cause, leaving a pending form cancellable. `--yolo` does not
invent answers. The originating tool constructs its own result envelope. A stale
interaction identity cannot answer a subsequent interrupt.

### §6.6 Proposal-review boundaries {§cli-proposal-review-boundaries}

- Concurrent proposals. The daemon pauses one dispatch per proposal; at most one proposal is pending per loop at any time. Client handles them sequentially as they arrive.
- Patch validation. The client does not parse the udiff. `body` is treated as opaque text for display and (when edited) re-submission.
- Persisting decisions. Review does not create remembered approvals; reusable acceptance is explicit configuration under {§cli-tool-acceptance}.

---

## §7 Subcommands {§cli-subcommands}

Daemon subcommands inspect or deliberately configure state without running a
loop. They share the same connection and workspace-resolution machinery as the
prompt-driven flow, but skip `loop.run` entirely. They support `--json` for
machine-readable output (stdout product per §2.1; trace and errors stay on
stderr). `effort [policy]` reads or changes the durable effort.
`capabilities [json]` projects every durable capability layer and its effective
intersection, or replaces the workspace policy. Prompt runs carry no approval
policy. Local `render` does not contact the daemon.

When the first positional argument matches a known subcommand verb, the dispatcher
routes there instead of assembling a prompt. Invalid forms of that command exit
`64`; other positionals remain prompt text.

### §7.1 `plurnk models` {§cli-plurnk-models}

Queries one bounded page from the daemon's release-pinned catalog through `models.list`. No workspace is attached and no provider request is made. Positional words form a case-insensitive search; `--provider <name>` narrows the provider, `--all` includes models missing local configuration, and `--offset`/`--limit` page without loading the full catalog.

Default output is a column-aligned table of `selector / name / context / efforts / readiness`, where `efforts` {§cli-models-efforts} lists the daemon's admitted efforts for the exact route (`capabilities.efforts`, plurnk-service#529) or `-` for a model without an effort dimension, plus a continuation offset when another page exists. The default availability is configured-and-ready exact routes; `--all` rows explain missing credential or configuration alternatives. With `--json`, the client emits the complete page unchanged so `offset`, `total`, and `nextOffset` survive.

### §7.2 `plurnk workspace list` {§cli-plurnk-workspace-list}

Lists workspaces on the daemon via `workspace.list`. No prior attach required.

Default output: a column-aligned table of `name / project_root / created`. Null `project_root` renders as `(headless)`. Physical provider-request accounting is not denormalized into this directory view.

With `--json`: emits `workspaces` array verbatim.

### §7.3 `plurnk workspace workers <name>` {§cli-plurnk-workspace-workers-name}

Lists workers within a named workspace via `workspace.workers`. Resolves `<name>` to a workspace id via a `workspace.list` filter; no attach required. Exits `1` if the name is unknown or ambiguous.

Default output: a column-aligned table of `name / created`. With `--json`: emits `workers` array verbatim. Physical provider-request accounting is not denormalized into this directory view.

Typical use: discover a worker name to pass as `--worker` on `plurnk log read`.

### §7.4 `plurnk log read` {§cli-plurnk-log-read}

Reads a worker's log through `log.read` in the workspace selected under §1.1.
`--worker <name>` selects an existing conversation worker;
omission selects the workspace's durable default conversation under §1.1.

Filter flags (all numeric, all optional):

| Flag | Maps to | Meaning |
|---|---|---|
| `--loop <id>` | `loopId` | Limit to one loop |
| `--turn <id>` | `turnId` | Limit to one turn |
| `--since <id>` | `sinceId` | Entries with id > sinceId (incremental fetch) |
| `--limit <n>` | `limit` | Cap entries (daemon default 100, max 1000) |

Default output: one trace line per entry, same format as CLI-mode trace (`[<status>] <origin> <op>[<sub>] <path> <scope>`). The scope is omitted when the operation has no line marker. With `--json`: emits `entries` array verbatim.

### §7.5 `plurnk effort [level]` {§cli-plurnk-effort}

Uses the workspace selected under §1.1; `--worker` selects a named conversation. With no
level, calls `worker.effort.get`. With one level, calls
`worker.effort.set`. Text mode prints the effective effort and supported
choices; JSON mode emits the daemon result unchanged.

### §7.6 What subcommands do NOT do

- Send prompts. They never call `loop.run`.
- Hide state changes: workspace rename, reasoning and capability setters, MCP
  management, and scripts explicitly request mutations; inspection commands do not.
- Honor flags that only matter to a conversation (`--model`, `--effort`,
  `--yolo`, `--auto`) in state-command mode. Those parse without effect there.
  Reasoning mutation uses the positional policy above.

### Script invocation and resume {§cli-script-binding}

`plurnk script <file.plk>` submits the file unchanged through `op.parse`.
Workspace selection follows §1.1, including daemon-generated names for unnamed
invocations. Every proposal-resume Run retains that workspace and thread without
resubmitting the program. The first creation request carries the complete
workspace settings and project root, including explicit `null` for headless use.
Successful scripts exit 0; an unsuccessful operation exits 4.

---

## §8 Problems and Notices {§cli-problems-and-notices}

The client has two product-level diagnostic contracts, not one generic event
envelope:

- An RFC 9457 Problem is failure truth. Client-owned flag, connection,
  subcommand, RPC, and runtime failures use `{type, title, status, detail}` plus
  useful extensions. Daemon operation failures remain durable log results; the
  client does not recreate them as push events.
- Incoming Problems remain exact. The client accepts them from
  `application/problem+json`, `CUSTOM plurnk.problem`, failed
  `plurnk.action.result` events, and `plurnk.terminated.result.problem`.
  `plurnk.terminated.result` is the terminal wire truth; the client's
  `finalStatus` JSON field is its projection of `result.status`, not a daemon
  field. `RUN_ERROR` is the standard terminal signal, not a source from which
  to reconstruct a Problem.
- A Notice is a transient, nonterminal observation. It may describe progress or
  a non-fatal degradation, but it cannot determine success, failure, scheduling,
  recovery, or exit status.

Both are open to domain-specific extension fields. Shared rendering is a UI
choice, not a shared semantic envelope.

### §8.1 Failure shape and control flow {§cli-problem-control-flow}

```ts
interface ProblemDetails {
    type: string;       // stable absolute problem-type URI
    title: string;
    status: number;     // 400–599
    detail: string;
    instance?: string;
    [extension: string]: unknown;
}
```

Client problem types live under
`https://problems.plurnk.xyz/client/<owner>/<kind>`. Helpers in
`src/diagnostics.ts` own the stable type, status, detail, and recovery fields;
callers do not hand-shape failure JSON. `ProblemError` carries an exact Problem
through async control flow together with its process exit code. Unstructured
throws become `client/runtime/error` Problems.

In JSON output, a failure is
`{"schemaVersion":6,"problem":<ProblemDetails>}`. Text mode renders the same
Problem's title, detail, and optional recovery to stderr. A bridge that answered with a failure surfaces that failure;
only connection-level failures receive service address/availability hints.
{§cli-connection-onboarding}

This boundary includes workspace creation before the interactive transport is
bound; omitting `--workspace` must not turn the same failure into an uncaught exception.

### §8.2 Notice shape and transport

```ts
interface Notice {
    source: string;
    kind: string;
    level: "error" | "warn" | "info";
    message?: string | null;
    position?: ContentOffset | LogCoordinate | null;
    [extension: string]: unknown;
}
```

Diagnostic Notices arrive as `CUSTOM plurnk.notice`, interleave with trace
lines in text mode and accumulate under `notices` in the JSON record (§2.1).

Indexing activity arrives only through the ordinary AG-UI status snapshot/delta
stream; clients do not poll or interpret a second progress Notice. The one-shot
TTY repaints routine activity changes no more than once per 15 seconds;
non-TTY stderr omits them. Indexing warnings and failures remain explicit
diagnostic Notices. `exec:*/search_progress` replaces search acquisition's
activity position and its terminal phase clears it. Neither client appends
progress ticks or live-renders durable `entry_materialized` narration.

Client `daemon_stale`, `edits_blocked`, and `conversation_lost` observations are also Notices because
they advise without terminating an operation. Client failures are Problems.

### §8.3 Rendering and channel posture {§cli-notice-rendering} {§cli-channel-posture}

`renderDiagnostic(diagnostic)` renders either contract as an alert block without
converting one into the other:

```
│ <icon>  <Alert> <source>:<kind> [<position>] — <detail-or-message>
│ <further message lines, if any>
│   <snippet lines, if any>
│ <recovery and hint lines, if any>
```

The icon is two columns wide, so two spaces separate it from the word; the message rides the
title line.

A Problem or an `error` Notice is a 🛑 Caution, a `warn` Notice a ⚠️ Warning, and an
`info` Notice an ℹ️ Note, each in its accent (§5.5); the client never infers severity
from `kind`. `ContentOffset` renders as
`L<line> col<column>` and `LogCoordinate` as its coordinate plus optional op.
CLI mode writes diagnostics to stderr. TUI mode inserts them into the waterfall
without colliding with the active prompt, with a blank row above and below the block.

### §8.4 `stream/event` and `stream/concluded` {§cli-stream-event-and-stream-concluded}

The daemon also projects streaming-channel metadata as `plurnk.stream` events.
Streams are content lifecycle, not Problems or Notices. The client renders no
stream lifecycle of its own: a start or growth event writes nothing, and a
conclusion renders the launching fence's operation row once (§5.3).

```
stream/event     { entryId, workerId, target, channel, state, contentLength }
stream/concluded { entryId, workerId, target, subscriptionId, scheme, result, summary, wakeAction }
```

`workerId` is the entry-read perspective and `target` is the stream's address: the one the service stamped on the started execution row as `attrs.stream` (`python3:///0c0ffee1`), opaque to the client and never composed. The TUI keeps the started row until that address concludes, then renders it once, per §5.1:

```
python3 Run the focused tests
python3 Run the focused tests — failed (exit 2); stdout=0 bytes, stderr=41 bytes
```

`wakeAction` is engine bookkeeping and never a row: a concluded stream does not
claim that a loop resumed; ordinary loop events remain the execution evidence.
A conclusion whose launch the client never saw renders as its scheme and address in
the same grammar. The one-shot CLI writes its trace to stderr and keeps its bounded
inline exception for tiny concluded outputs. **The TUI fetches no streamed content for a model's execution**; the human's own `!`
command is the one bounded exception (§5.3). Consumers who want the body call `entry.read` themselves.

### §8.5 Boundaries

- A Notice is not a replacement for a failed durable result or an exit code.
- A Problem is not progress and does not travel on `plurnk.notice`.
- Stream activity is not a diagnostic envelope.
- Observability export is outside the client product protocol.

---

## §9 Conformance {§cli-conformance}

{§cli-agui-conformance} `conformance/agui-client.json` exhaustively classifies
every action and notification in the daemon's live schema-bearing discovery as
dedicated client behavior, lossless generic transport, or explicitly
unsupported behavior. It records evidence by conformance dimension; the shared
contracts reporter rejects missing members, dimensions, and evidence files and
emits one record per member. The client feeds the contracts-owned SSE and
lifecycle corpus through its production transport, and durable controls are
observed through a second client instance. A changed public surface cannot
remain an implicit client assumption.

A conforming `plurnk` client:

1. Speaks AG-UI+ (RunAgentInput over HTTP, AG-UI events + `CUSTOM plurnk.*` over SSE) per the plurnk-agui SPEC.
2. Connects to the module at `http://$PLURNK_HOST:$PLURNK_PORT/agui` (or the exact `PLURNK_AGUI_URL`), bearer from `PLURNK_AGUI_TOKEN` when set.
3. Resolves the workspace and conversation separately under §1.1, retaining their binding for subsequent requests until an explicit navigation command changes it.
4. Subscribes to `log/entry` notifications and renders each per §5.1.
5. Consumes client-owned proposal interrupts and resolves each through standard AG-UI resume per §6; loop-owned dispositions are absent from that surface.
6. Consumes `CUSTOM plurnk.notice` and renders each Notice per §8.
7. Maps `loop.run` results to exit codes per §4.
8. Emits client-owned failures as RFC 9457 Problems and advisories as Notices per §8.
9. Projects `STATE_SNAPSHOT` and each `STATE_DELTA` into the run's status gauge (`loop/packet`, plurnk-agui SPEC); a delta before a snapshot or a patch op other than `replace` is a 502 `state-invalid` Problem.

### Test daemon ownership {§cli-test-daemon-lifecycle}

| Responsibility | Owner |
|---|---|
| Spawn, readiness address, SIGTERM-and-wait with bounded escalation | The selected service package's public `@plurnk/plurnk-service/launch` helper. |
| Executable, fixture configuration, deadlines and disposable state root | The test caller. Deterministic tests isolate HOME and XDG configuration; MCP fixtures supply complete environment definitions or workspace additions. Only the explicit live tier inherits operator configuration. |
| Failed startup | The helper stops and awaits its process; the caller then disposes of its temporary state. |
| Successful shutdown | The caller awaits `stop()` before removing temporary state. Repeated cleanup is harmless. |
| Packed composition | The helper and daemon executable come from the same installed service artifact. Failed composition retains its evidence after stopping the process. |

---

## §10 Out of scope

- Multi-daemon connections. One client, one daemon.
- Interactive provider authentication. It belongs to third-party MCP tooling, not this client.
- Direct provider access. The client never talks to OpenAI/Anthropic/etc.; the daemon owns provider integration.
- Direct grammar parsing. The client emits raw DSL only via `op.parse` (which delegates to the daemon's parser); it does not parse locally.

When any of these becomes in-scope, file an issue and update this SPEC.
