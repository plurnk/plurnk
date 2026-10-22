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
| **workspace** | Daemon-owned shared environment, selected by name or folder at acquisition and addressed by its immutable ID thereafter; see {§cli-workspaces-and-workers}. |
| **worker** | An actor within a workspace, with its own log. `--worker` selects the worker the thread binds; client operations have their own actor. |
| **AG-UI Run** | One protocol exchange on a thread. Proposal interrupts and their resumes may span multiple Runs for one daemon loop. |
| **loop** | Daemon-owned execution spanning turns. Message delivery and loop completion are independent; the Run's end carries the authoritative terminal record as `metadata.plurnk.terminal` (plurnk-service `{§agui-plurnk-metadata}`). |
| **log/entry notification** | A durable operation row or its update; the client draws it from the standard part it builds, or whole when it builds none ({§cli-row-sources}). Rendering follows §5. |
| **one-shot mode** | `plurnk "prompt"` — one prompt's loop, rendered, then exit. Unix-tool posture. |
| **TUI mode** | `plurnk` (no args) — interactive REPL; many prompts per workspace. |

---

## §1 Invocation {§cli-invocation}

```
plurnk [options] [prompt...]                # one-shot from positionals
<piped stdin> | plurnk [options] [prompt...] # one-shot from stdin (and/or positionals)
plurnk [options]                             # TUI mode (no positionals, TTY stdin)
```

{§cli-runtime-floor} Before the client loads, `plurnk` compares the running Node.js with the
floor its package declares in `engines.node`. Below it, one stderr line names both versions and
the process exits 1, before any option is read or any daemon is contacted.

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
| `--worker <name>` | string | Resume (or create) the named worker within the workspace, in either mode. Overrides `PLURNK_CLIENT_WORKER`, which ships unset. See §1.1. |
| `--tui-worker <name>` | string | The worker the TUI, scripts and subcommands bind when no worker is selected. Overrides `PLURNK_CLIENT_TUI_WORKER` (shipped `user`). See §1.1. |
| `--model <selector>` | string | Persist a declared alias or exact `provider/model` route on the worker before its first loop. See §1.2. Overrides `PLURNK_CLIENT_MODEL`. |
| `--effort <policy>` | string | Persist the daemon-validated effort on the worker before its first loop. See §1.2.3. Overrides `PLURNK_CLIENT_EFFORT`. |
| `--autostart <0\|1>` | string | Override `PLURNK_CLIENT_AUTOSTART`: start the installed service when nothing listens, or require attachment. See {§cli-daemon-autostart}. |
| `--daemon-timeout-ms <n>` | string | Positive connection/startup limit; overrides `PLURNK_CLIENT_DAEMON_TIMEOUT_MS`. |
| `--oauth-timeout-ms <n>` | string | Positive browser OAuth callback deadline; overrides `PLURNK_CLIENT_OAUTH_TIMEOUT_MS`. See {§cli-mcp-oauth-callback}. |
| `--cancel-grace-ms <n>` | string | Positive grace after `loop.cancel` is acknowledged before the client hangs up on the run; overrides `PLURNK_CLIENT_CANCEL_GRACE_MS`. See {§cli-cancellation}. |
| `--service-bin <path>` | string | Explicit installed service entrypoint; overrides `PLURNK_CLIENT_SERVICE_BIN`. |
| `--project-root <path>` | string | Absolute path passed as `projectRoot` on `workspace.create`. See §1.3. Overrides `PLURNK_CLIENT_PROJECT_ROOT`. |
| `--yolo` | flag | Auto-accept every proposal locally without prompting (the default). See §6. Forces `PLURNK_CLIENT_YOLO` on. |
| `--auto` | flag | State that nobody is attending: the daemon asks nothing, and a loop that would wait for a person concludes instead. Approval stays local. Overrides `PLURNK_CLIENT_AUTO`. See §6.0. |
| `--capabilities <json>` | string | CapabilityPolicy applied when creating the workspace. Overrides `PLURNK_CLIENT_CAPABILITIES`. |
| `--max-turns <n>` | string | Model-call budget for the prompt's worker tree ({§turn-cap-counts-the-tree}): the loop's turns, its descendants' turns and every BARE call, one per call; omission leaves the daemon's ceiling in effect. Overrides `PLURNK_CLIENT_MAX_TURNS`. |
| `--preview-lines <n>` | string | Lines of every operation body and concluded execution output shown beneath its row (§5.1); the rest is named with `… +N lines · <address>`. Overrides `PLURNK_CLIENT_PREVIEW_LINES`. |
| `--history-entries <n>` | string | Non-negative recent entry count restored on TUI attachment; zero disables history. Overrides `PLURNK_CLIENT_HISTORY_ENTRIES`. See {§cli-worker-history}. |
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
| `PLURNK_SECRET` | `@plurnk/plurnk-contracts` | The operator's client secret, exchanged for access tokens ({§cli-credential}); unset, the client reads the secret a daemon running as the operator minted beside its database. |

**Cascading env.** Highest precedence first: shell exports → repeated `--env-file` / `--env-file-if-exists` flags (node-native; the last occurrence wins; `--env-file` requires the file, while the other skips a missing one) → `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env` → the client's own packaged floor (below). All layers are optional; the client works with no configuration. A project's variables reach its commands through the workspace environment (`/env import .env`). The client reads the daemon address (`PLURNK_HOST`/`PLURNK_PORT`, or `PLURNK_AGUI_URL`) from the shared XDG file. There is no generated aggregate defaults file; `plurnk-service config defaults` renders the complete owner-labelled catalog on demand.

**The self-serve floor** {§cli-env-defaults} — per the ecosystem standard (one owner per key, the file IS the docs), the client ships `.env.defaults` at its package root declaring only the `PLURNK_CLIENT_*` prefix and loads it SET-IF-UNSET beneath every operator layer. A knob the operator set is never overridden; a commented knob is documentation, not a value.

### Backend lifetime {§cli-daemon-autostart}

The client package declares the service as an optional dependency. A normal
install includes it; `--omit=optional` preserves client-only use with an explicit
endpoint or separately installed service. Runtime startup never downloads it.

There is one service per configuration. The client attaches to it, or starts it
once and leaves it running for every later client; the client never stops a
service. It uses the service's public `@plurnk/plurnk-service/launch` interface
and implements no second daemon supervisor.

| Connection/configuration | Behavior |
|---|---|
| The configured loopback host/port has a listener | Attach; ordinary AG-UI validation still applies. |
| That listener answers 503 `service-starting` | The service owns its address but has not admitted clients yet; wait for admission within `PLURNK_CLIENT_DAEMON_TIMEOUT_MS`, then attach. |
| The configured loopback connection is refused; `PLURNK_CLIENT_AUTOSTART=1` | Start the installed service on that address with the launcher's `shared` lifetime and the service's own storage, then attach. It keeps running after the client exits; `plurnk-service stop` ends it. |
| A start that loses the address to a concurrent first launch | Attach to the service that won it. |
| The configured port is `0` with autostart on | Usage Problem `client/daemon/port-unshareable` (exit 64): a service on an allocated port is unreachable by a later client. |
| Explicit `PLURNK_AGUI_URL`, remote host, or autostart disabled | Attach only. Failure never creates a substitute environment. |
| Timeout, DNS/routing failure, authentication rejection, or invalid protocol | Preserve the failure; do not interpret it as an absent service. |

Configuration comes from the ordinary cascade, and the started service reads its
own: its database, port, secret and log are the ones `plurnk-service start`
would use, the log being the service's `<state dir>/service.log`. Resolve the
installed service package, or its executable on `PATH`;
`PLURNK_CLIENT_SERVICE_BIN` explicitly selects an installation. The executable
and launcher must come from the same package. Missing installation is an
actionable failure, never an automatic download. Readiness uses the positive
`PLURNK_CLIENT_DAEMON_TIMEOUT_MS`, and a start that fails is stopped and awaited
by the launcher within the same limit. The client dials a service it started
with the secret that service minted beside its database ({§cli-credential}).
Text mode reports the start as `client:daemon:started`, naming the service's
pid, address and log and how to stop it; JSON stdout/stderr semantics stay
unchanged. Help, version, completion and local rendering do not acquire a
backend.

### §1.1 Workspaces and workers {§cli-workspaces-and-workers}

Workspaces and workers are daemon-owned. Names select; IDs identify.

| Surface | Contract |
|---|---|
| Workspace acquisition | `workspace.create` receives the literal selected label, if any, with projectRoot/settings. It returns `{id, name}` before bound work begins. |
| Directory default | Without a label, the invocation designates a folder ({§cli-project-root}); the daemon names/selects its workspace ({§workspace-name}). The client invents neither a label nor an ID. |
| Bound requests | `threadId` is `<workspace ID>#<worker name>` ({§agui-thread-binding}); no workspace label or creation options are resent. |
| Rename | Changes display/selection only. Existing connections, actions, observation and interrupt resumes retain their identity. A name the workspace state newly carries for the bound workspace's ID (plurnk-service `{§agui-workspace-state}`), unlike the session's, is a rename made elsewhere: the session reads it back (`workspace.list`), and only that readback gives the title, the place and the resume command the new name. A Run's state is taken when the Run started, so it never undoes the session's own rename. |
| Workspace switch | Acquire first, then replace the binding. A failed acquisition preserves the previous conversation. |
| Worker selection | `--worker` overrides `PLURNK_CLIENT_WORKER`, the worker an invocation binds in either mode, which ships unset. Unset, the TUI (workspace switches included), scripts and subcommands bind `PLURNK_CLIENT_TUI_WORKER` (`--tui-worker`, shipped `user`), and a one-shot prompt binds a new worker of its own: twelve random lowercase hexadecimal characters, which text mode reports as `client:worker:new` and the JSON record carries as `worker`, so `--worker` can continue it. A worker selection needs no explicit workspace. |
| Worker switch/fork | Change the worker name within the same workspace ID. No client-side thread alias table. |
| Inspection | `workspace.attach` resolves the selected literal name, or the launch/project folder's daemon-derived default. Absence fails without creating a workspace or asking for a creation folder. Worker reads resolve the selected name through `workspace.workers`; absence never falls back. |

Workspace identity, mutable label and saved project root are independent. Creation options never rewrite
an existing root. `--project-root=` without `--workspace` exits 64 with `client/flag/missing-dependency`:
a folderless workspace needs a label. IDs are not selection flags or environment settings.

{§cli-history-lost} **A bound name answered with no history is a new worker, and the client says so.** The daemon mints a worker anew under its old name when it no longer holds it ({§agui-thread-binding}: a fresh database, a deleted worker), and the name cannot tell the client. The run-start gauge can: `snapshot.plurnk.status.loopId` is `null` only for a worker with no loop at all, so a `STATE_SNAPSHOT` reporting `null` after a gauge on the same binding that carried a loop raises the `history_lost` warning Notice, naming the workspace and worker, ahead of the run's rows. The transcript above the alert is the terminal's memory, not the model's. Switching workspace or worker starts a fresh watch.

### §1.2 Model selection {§cli-model-selection}

The worker owns its model route ({§worker-model-selection}); the client persists deliberate selections server-side and never reasserts model policy on an individual loop. One selector accepts either a daemon-declared alias or an exact `provider/model` route. Alias selection preserves its alias-scoped configuration and provenance; exact selection uses provider-wide configuration without inventing an alias.

Resolution at the client:

- `--model <selector>` or `PLURNK_CLIENT_MODEL` set → one `worker.model.set` before the first loop of this invocation, then no per-loop selector.
- `--model` and `PLURNK_CLIENT_MODEL` unset → send nothing; the worker's durable route (or the daemon's `PLURNK_MODEL` default when the worker is first created) runs.

An explicit model or reasoning selection is invocation admission: rejection fails
before the CLI sends a prompt or the TUI accepts input. The client never continues
under the worker's previous policy.

The daemon alone owns provider configuration, credentials, alias declarations, and its `PLURNK_MODEL` seed. A client connected to a local or remote daemon has the same contract.

When the initial worker has no selected model, the TUI emits one startup warning
that names the provider API key the backend needs, then `/models` and
`/model <selector>`, and links README's Models section. It does not choose a
model or fetch the catalog automatically.

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
`STATE /plurnk/workspace/preparation`: family, current alias when present, phase,
and elapsed time since the daemon's timestamp. The status clock advances while
preparation is present, including before model inference and during inspection.
An empty array clears the activity. Reattachment uses the same snapshot; the
client neither starts capabilities nor polls for progress. This state adds no
transcript rows and does not replace the loop lifecycle or indexing activity
(`STATE /plurnk/workspace/activity`). Both are the workspace's, carried by every Run bound to it;
the gauge (`plurnk.status` and `budget`) is the bound worker's, and a Run that binds none, such as
a workspace action, reports no gauge.

Human status is the summary line's shape aggregated over the session:

```
[<project folder> ] [<TUI place> ] [🔌 ][🔥 ]<glyph>  · 🎲 <model> · <wall> · ↓<input> ↑<output> · $<usd> · <doing> [· 🐜<children> [<child>]] [· 🚦 <gated>] [· 📨 <waiting>] [· 🧮 <percent>%]
```

YOLO is a fireball beside the lifecycle glyph.
{§cli-status-disconnected} 🔌 leads them while the session holds no observation of its worker because the
last one ended in a failure: the daemon stopping, a revoked credential, a lost connection, as plurnk-web
shows its own disconnection. It is absent while connecting, while observing, and after the client's own
cancellation; the next command or prompt opens a new observation and clears it. The model sits next, ahead of
everything that ticks, so the ticking never moves it. The TUI's is its last server-read route
({§cli-identity-effort}), never the gauge's; a one-shot prompt's row begins with the route its
admission read and then shows the gauge's. The traffic counts precede the phrase that
says what the worker is doing. A glyph is two columns wide, so two spaces separate the last one from the first dot. Token counts are
abbreviated (`582k`, `1.2M`; below a thousand the number itself) and spend is stated to the
hundredth of a cent with grouped thousands (`$3,333.3333`).

{§cli-status-project-root} CLI and TUI status start with the bound workspace's project folder
at column zero, before TUI place coordinates, glyphs, model and counters. It is the daemon's
label for that folder, `snapshot.plurnk.workspace.projectLabel` ({§workspace-label}), shown as
given: the client shortens no path with its own home, so a daemon on another host is spelled from
its home. The launch directory and create-time options cannot override it on reattachment.
Switching workspaces replaces the folder; a headless or unknown folder omits it. The TUI omits
the separate folder when the label equals the workspace name; the place already identifies it.
Path text is terminal-safe.
The TUI footer uses the muted color role, subject to {§cli-color-policy}.

{§cli-status-children} The ant counts the bound worker's alive direct children
(queued, running, or parked — a parked child still owes a result) in the daemon's
tree beneath it (`snapshot.plurnk.status.descendants`, plurnk-service
`{§agui-status-descendants}`), followed by the child model while a spawn
override is set: `🐜 2 dumbox`. Zero hides the whole child segment, even with a
configured child model. A transport without the gauge shows only the bare
`🐜 <child>`. The count is the gauge's, never the directory's, and a gauge whose
tree is not one worker's tree is refused; the user hops to a child (§3.1.2) rather
than watching it.

{§cli-status-gated} The traffic light counts the workers anywhere in that tree
waiting on a gate, a proposal or a client interaction (`gates` above zero):
`🚦 15`. None waiting, or no gauge, hides it. The gates themselves reach their
owner as interrupts ({§cli-proposal-review}) and wait in its review.

{§cli-status-inbox} The envelope counts the messages the daemon accepted for the bound worker that a
live loop still holds unread (`snapshot.plurnk.status.inbox`, plurnk-service
`{§agui-message-acceptance}`): `📨 2`. None waiting, or no gauge, hides it. A message whose loop
concluded without reading it, cancelled say, is never counted, since nothing will read it: once the
history is drawn the session says so once, `client:message:message_unread`, naming the message by
its words when this thread sent it (the snapshot carries them) and by its address otherwise.

{§cli-status-streams} `snapshot.plurnk.status.streams` names the streams the bound worker holds open
(plurnk-service `{§agui-status-streams}`). On attach, the history's launch row of each one still open
is held as a live launch is ({§cli-what-is-not-rendered}): its conclusion draws the launch with its
outcome, never the stream's bare address.

{§cli-status-clock} Turns and wall time include the running loop — its packet count from the
authoritative AG-UI `STATE_SNAPSHOT`/`STATE_DELTA` gauge and its elapsed time, ticking once a
second throughout an unfinished run, including queued and parked intervals. A loop this client
started runs from when it sent the prompt; one it attached to runs from the daemon's
`status.claimedAt`, when the loop first ran ({§agui-status-timing}), or from the attachment while
the loop has not run yet. Waiting and resumption neither pause nor reset that clock; completion,
cancellation or failure freezes it. A missing start time is not invented.
The turns/wall group appears once a loop has
run, tokens once the worker has spent, cost when nonzero or unknown, the child model while a spawn override is set and the child segment is visible (§1.2.2), the
worker once the bound worker is known (the terminated outcome names it). The client does
not infer provider packets from operation rows or turn coordinates.

{§cli-status-spend} Tokens and cost are the daemon's spend for the bound worker,
`snapshot.plurnk.status.spend`: every settled provider request of the worker and
its descendants since the worker began ({§agui-status-spend}). Each snapshot or
delta replaces the figure and the client adds nothing to it, so a reattached
client shows the same spend and a concluded loop charges nothing again. Complete
`usage`/`costUsd` and `knownUsage`/`knownCostUsd` stay distinct: an unknown total
renders its known subtotal with `+ ?`, wholly unknown money renders `$?`, zero
requests show nothing and an explicit complete zero cost is hidden. A malformed
spend is refused. The client does not reconstruct the tree or reprice provider
usage; exact per-loop accounting stays in the loop summary. Before the first state
snapshot, durable worker policy and local derivation activity provide an honest
startup fallback.

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
parentheses as given. A route without an effort dimension renders bare. `/effort`
says the same in words. The client never infers provenance (plurnk#41 ask 2).

The identity is the client's last server-read route. A worker no act has created yet has no
route of its own: its identity is the route the daemon lists for the active alias, which that
worker reads back once created (plurnk-service `{§agui-provider-routes}`). Every durable-policy change
(`/model`, `/child` including `inherit`, `/effort`, a rebind or hop, and an explicit
`--model` or `--effort` at admission) ends in one readback, `worker.effort.get` then
`worker.model.get` for both routes, collected whole, applied together and repainted
before the change is confirmed; a setter's echo is never spliced into a label. A
persisted change whose readback fails is reported as a readback failure, distinct
from a refused change: it neither shows the requested value as read back nor rolls
anything back. A route the gauge newly carries that differs from the one last read is a
change made elsewhere, another client's model or effort (plurnk-service
`{§notifications-worker-policy}`): the session reads the policy back once and repaints from
that readback. A status gauge is a cache of lifecycle, place, activity and children
and never supplies the identity, so a gauge carrying an older route (the setter's own
action run snapshots the worker before it mutates) cannot override a newer
client-set policy.

### §1.3 Project root {§cli-project-root}

**Project root** is the absolute path the daemon's `file://` scheme uses as the workspace boundary for that workspace. NULL = headless (file ops 400 with "workspace has no project_root").

| Input | Resolved root |
|---|---|
| Existing named workspace, regardless of cwd or creation defaults | Stored root; no prompt or rewrite |
| `--project-root` or `PLURNK_CLIENT_PROJECT_ROOT` | Explicit absolute path; empty string means headless (`null`) and requires `--workspace`. The flag wins. |
| Neither, cwd differs from home | cwd: a named workspace's creation root, otherwise the folder the daemon names and selects the workspace by ({§workspace-name}) |
| Neither, cwd resolves to home, no `--workspace`, the daemon holds the home workspace `~` | Home: the launch selects that workspace; no prompt |
| Neither, cwd resolves to home, otherwise a new workspace, interactive stdin and stdout, not JSON mode | Inline choice: existing project folder with path completion, no folder, or explicit home |
| Same new workspace, noninteractive or JSON mode | Exit 64 with `client/project-root/required` and explicit-root guidance; no workspace creation or model run |

The same selection precedes startup and `/workspace` creation. Without
`--workspace`, binding reads the bound workspace's stored root back by name: a workspace
the daemon selected by folder keeps the root it was created with. A folder choice
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

The prompt's first non-blank character has the same meaning in the CLI and TUI. `plurnk "? question"` states proposal `review` for that loop without changing workspace capabilities; `": text"` states nothing new. `plurnk "! command"` execs via the daemon—op.exec, stream to conclusion, exec stdout→stdout / stderr→stderr, exit by the conclusion's `result.status` and `exitCode`; no model or loop takes part. Core has no named ask/act mode.

| `! command` | Exit |
|---|---|
| Its execution concludes `200` with no nonzero `exitCode` | `0` |
| Its execution concludes `499` | `3` |
| Its execution concludes `200` with a nonzero `exitCode` or with any other status, or `op.exec` refuses it and its Problem is reported | `4` |
| No command follows the leading `!`s | `64`, before contacting the daemon |

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
- **stdout** — delivered responses ({§cli-broadcast-send-rendering}), verbatim in operation order and separated by a blank line. A later failure or cancellation does not retract them. NOTE inventories, unrelated recipients and failed messages do not appear on stdout.
- **stderr** — one mutable status row on a TTY, durable action trace lines
  (including intermediate broadcasts), diagnostics, and the terminal summary.
  Non-TTY stderr omits routine status/progress instead of accumulating heartbeat
  history. It still receives durable trace, diagnostics, and the summary.

**json mode (`--json` / `PLURNK_CLIENT_JSON`):**
- **stdout** - ONE complete document and nothing else: the coherent record of the terminated worker loop - `schemaVersion`, the bound `worker` name, authoritative `workerId` + `loopId`, `response` (the answer, top-level for `jq -r .response`), `finalStatus`, `turns: [{turn, ops: [{coord, op, origin, target, scope, status, signal}]}]`, `notices`, `usage`, exit metadata. Each op's `target` is the address its row recorded, and its `scope` the daemon's line marker as its ordered coordinate array. `usage` is preserved verbatim from the terminal record: ordered physical-request evidence and conventional aggregate token fields live under `usage.accounting`, whose `costUsd` is an exact decimal string or `null`; `curationWeight`/`curationBudget`, `contextTokens`/`contextCapacity`, and provider metadata remain sibling fields. Curation weight is never compared with physical provider tokens. The client does not project, sum, round, or settle accounting. The terminal record supplies both owning coordinates; the client never combines a terminal loop with a worker inferred from ambient rows. Workspace-visible child/sibling rows may be rendered as topology, but they do not enter this record's `response` or `turns`. On failure it is `{"schemaVersion":6, "problem": ProblemDetails}` - valid JSON either way, paired with the exit code.
- **stderr** — silent.
- **NOT inlined:** op *content* (file bodies, exec output). Under co-location the consumer reads the file directly or fetches one op on demand with `plurnk read <coord> --json` (§7) — the same addressable, scoped log discipline the engine runs on. `--json` carries the record, not the content.

{§cli-partial-record} A connection or decoding failure during any one-shot Run
segment retains the rows, response and notices already observed, including prior
proposal-resume segments. JSON emits one record; text retains delivered output
and reports the failure. The invocation exits with the client failure, without
reconnecting or replaying the prompt. A received terminal result and accounting
remain authoritative; absent those, an observed Problem or the client failure
describes the incomplete outcome and usage remains unknown. A secondary client
failure is retained as an error Notice with its Problem, not substituted for
known daemon evidence. Failures before Run consumption use the problem-only form.

{§cli-interrupted-record} During the initial request or any proposal-resume segment,
`SIGINT` and `SIGTERM` explicitly request `loop.cancel` for the bound worker and
flush one JSON document containing all rows, notices, and response text observed
at interruption, then exit 130 and 143 respectively. Cancellation uses the same
grace as the run timeout (`PLURNK_CLIENT_CANCEL_GRACE_MS`); another signal stops waiting for its reply.
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
- A TTY user sees both interleaved (the terminal merges streams).
- `plurnk "X" | tool` pipes only the answer.
- `plurnk --json "X" | jq -r .response` pulls the answer; `… | jq .turns` the structured trace. One document, no stderr archaeology — the CLI is the integration layer, no third-party client needed for basic needs.

### §2.2 Flow {§cli-one-shot-flow}

1. Read the worker's durable model, then `POST /agui` (RunAgentInput) with the workspace and thread selected under §1.1, the prompt as a user message, and per-loop options on `forwardedProps.plurnk`.
2. Consume the SSE: rows ({§cli-row-sources}) advance observed turn status and
   render as durable action trace lines on stderr; derivation Notices update the
   replaceable activity row without becoming trace history.
   Delivered responses go to stdout ({§cli-broadcast-send-rendering}).
3. A proposal arrives as a standard AG-UI interrupt carrying the daemon's proposal projection, naming the operation's own call when the run holds it, and terminates run A (the internal loop stays paused). Run B on the same thread returns the decision through `RunAgentInput.resume`, and the continued loop streams there. The terminal record its Run ends with is authoritative for the internal outcome; a stream that dies without terminal truth is an error (502), never a fabricated success.
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

1. Acquire the workspace and bind `AguiTransport` to its ID and worker name (§1.1). Its persistent handlers retain standard conversation meaning and add Plurnk waterfall details. Restore the bound worker's history under {§cli-worker-history}.
2. Print the banner; start pi-tui's main-screen renderer with a multiline editor
   and §1.2.1's aggregate line on the place line below the composer. Before AG-UI
   state arrives, derivation and search share the
   fallback activity position. The
   lifecycle glyph, for the daemon's lifecycle word (plurnk-service `{§loop-lifecycle-vocabulary}`), is ⏳ while
   queued, `⌛︎` while running, 💤 while parked, `⏹️` when complete, 🛑 when cancelled and ❌ on failure;
   YOLO puts 🔥 beside the lifecycle glyph. The main-screen renderer preserves
   ordinary terminal scrollback rather than replacing it with an alternate screen.
3. Each line entered is dispatched:
    - Lines starting with `/` → command verbs: `/help /models [search] /workspaces /workers /loops /loop [n] /model <selector> /child <selector|inherit> /effort [policy] /capabilities [json] /yolo /workspace [name] /worker [name] /fork [name] /parent /enter /older /newer /rename <name> /share <folder> /rollback <loop>/<turn>/<item> /stop /quit`, plus `/import <path>` (§3.3) and the Functionality families `/mcp` (§3.4), `/skills` (§3.5), `/a2a` (§3.6), `/members` (§3.7), `/env` (§3.8), and `/schedule` (§3.9). `/workspace [name]` selects or creates a workspace, then binds its shared-default worker under §1.1; `/workspaces` lists. The plural lists and the singular opens one: `/workers` lists the workspace's workers as a tree, `/worker [name]` shows the bound worker or goes to the named one, creating it when the workspace holds no worker by that name, and `/fork [name]` branches the bound worker (`run.fork`) and goes there (all §3.1.2); `/loops` lists the bound worker's loops and `/loop [n]` prints one whole ({§cli-loops}). `/rename <name>` changes the workspace's display name without changing its ID, worker or thread. `/rollback <loop>/<turn>/<item>` asks the daemon (`workspace.rollback {to}`) to reverse the bound worker's settled file mutations after that log coordinate, latest first, as this client's own operations, and prints each reversal, the rows it skipped, and where drift or a refusal stopped it; a coordinate that is not one of the worker's rows renders the daemon's Problem. `/capabilities` reads or replaces the workspace's durable CapabilityPolicy. Verbs never start a loop; inspect verbs reuse the §7 subcommand tables; `/stop` and `/help` stay reachable while a loop is in flight. Editor completion covers verbs, declared aliases, daemon-supported efforts, worker names after `/worker` (the directory plus the `worker://<name>` references the waterfall has shown, §3.1.2), **file paths** (after `/import`/`/script`, the `/members discover` position and every `/members add` argument, the `/env import` position, and bare `@file` tokens), **executable fence names** (READ, NOTE, and the other native OPs), and PLURNK target paths.
    - Named executable backtick fences → `op.parse`. Help and tab-completion derive the canonical fence from the published contract ({§operation-fences}); completion preserves longer authored fences and submitted operations pass through unchanged. Native OPs and executor/MCP names share this entry point; the daemon owns parsing, resolution, and diagnostics. Prefix `: ` to force prompt treatment for a literal fenced example.
    - Lines starting with `!` → the `op.exec` action. Daemon-owned shell; the person's own command, so it runs at once: the daemon never routes it for review, though its server policy can still refuse it.
    - Lines starting with `? ` → local proposal review for that run, bypassing client auto-acceptance. `: ` uses ordinary client acceptance. Neither prefix changes the worker's owner or server policy.
    - Lines starting with `...` → the `loop.inject` action — speak into a running loop without starting a new one (the "btw" steering case).
    - Anything else → a message Run (the prompt as the user message). Standard prompt-driven loop.
    (Verbs and injections ride §3 action runs on the same AG-UI+ surface.)
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
and source commit date; regeneration introduces no wall-clock timestamp.
Bash filename candidates retain spaces,
backslashes, and glob characters as single candidates; the shell owns quoting.
Unit tests run the native syntax/format checkers when installed and name any
missing tools. `npm run test:posix` requires mandoc, Bash, Zsh, Fish, and
ShellCheck; a missing checker or an invalid artifact fails that explicit check.

| Group | Verbs |
|---|---|
| Inspect | `/help /models /workspaces /workers /loops /loop` |
| Policy | `/model /child /effort /capabilities /yolo` |
| Workspace | `/workspace /rename /share /rollback /worker /fork /parent /enter /older /newer` |
| Functionality | `/mcp /skills /a2a /members /env /schedule` |
| Compose | `/import /script /editor` |
| Review | `/review /accept /reject /cancel /edit` |
| Session | `/stop /quit` |

Completion remains demand-driven. Root syntax and known model aliases need no
I/O. Live Functionality help and nested completion project the registry against
the bound daemon's `discover.actions`; composed commands require each action
they use. Offline references retain the complete syntax. Provider-qualified models
use one bounded provider page; aliases call the advertised family's list action
only at an alias-taking position. A failed lazy lookup produces no completion
and never changes the editor value.

#### §3.1.1.1 Filesystem completion {§cli-path-completion}

Filesystem suggestions follow the address owner; completion never changes the process working directory.

| Input position | Resolution base |
|---|---|
| `/import`, `/script`, `/env import` | Client launch directory; absolute paths remain host-absolute |
| `@file` | Bound workspace root; only paths under it ({§cli-prompt-open-paths}) |
| `/members discover`, every `/members add` argument | Bound workspace root; relative sibling paths retain membership semantics ({§cli-file-members}) |
| File OP target (bare or `file:///`) | Workspace filesystem namespace; `/` denotes the workspace root ({§fs-namei}) |
| Other schemes or authorities | No local filesystem suggestions |

The TUI uses the daemon's reported workspace root for both completion and prompt references. Rebinding clears it until the new binding's state arrives; a headless or not-yet-known root yields no workspace-file suggestions. Local-file commands remain available in either case. Completion preserves the authored URI prefix and surrounding editor text. A suggested path is not a membership grant; the daemon still owns operation admission.

### §3.1.2 Worker topology and attach {§cli-workers-topology}
One AG-UI stream binds one worker. Descendants of that worker reach
a client only through the daemon's correlated projection (plurnk-service#440, the
lane presentation of #38), never by inference; unrelated workspace workers never
render inside a session. What the daemon correlates (a direct child's mutations, messages,
executions, launches and conclusion) renders in the session as lineage rows (§5.1). The
TUI also asks the daemon to observe its delegation (`forwardedProps.plurnk.descendants`,
plurnk-service `{§agui-delegation-observation}`) on every Run that observes its worker, a resume
included ({§cli-resume-observation}): every descendant's own rows and executions
arrive introduced by `plurnk.descendant` and render as §5.1 says; a descendant's reasoning,
steps and terminal never do, including those the daemon attributes to a subagent run
(plurnk-service `{§agui-subagents}`). Navigation between workers is explicit.
`/worker <name>` rebinds the session's thread to that name with the workspace
unchanged: an existing worker is bound, and a new name's worker is created as
the session goes to it, exactly as with `--worker <name>` at invocation and as `/workspace <name>`
creates a workspace. The verb reports `(bound)` or `(new)` from the workspace directory, re-reads the
worker's durable policy, and the header and status line adopt the name. `/worker` alone names the bound
worker and its lineage, `worker: recheck [/main/fork-1/~recheck]`, and binds nothing. `/fork [name]`
branches the bound worker into a child that keeps its history (`run.fork`) and goes there.
`/workers` renders `workspace.workers` as a forest of parent/child trees from
`parentWorkerId`, places only: the bound worker's tree first with the bound worker marked `●`,
other workers `○`, siblings newest first, a worker whose parent is not in the directory standing as
a root. Each worker carries the lifecycle mark the directory states for it (⌛︎ running, ⏳ queued,
💤 parked, 🛑 cancelled, ❌ failed, none when idle or completed) and, for one in the session's tree,
`🚦 n` for the gates it waits on (`status.descendants`). A bound name the directory does not hold yet
leads as `● <name>  (new)`. `plurnk workspace workers <name>` (§7.3) keeps its flat table.

**Topology is navigation, not a dashboard** (plurnk-service#523). A child worker
is a first-class place the user goes to, prompts, forks, or makes the root of
another session. One hop is a full `/worker` of the target, never a read-only
visit; the composer then speaks to that worker. The hops follow vim's tree
orientation, depth horizontal and siblings vertical, as `Alt-h/j/k/l` and as
verbs for terminals that swallow Alt:

| Hop | Key | Verb | Target |
|---|---|---|---|
| parent | `Alt-h` | `/parent` | the bound worker's parent; at a root, `(at the root: no parent)` |
| enter | `Alt-l` | `/enter` | the newest child; none, `(no children)` |
| older | `Alt-j` | `/older` | the next older sibling, wrapping |
| newer | `Alt-k` | `/newer` | the next newer sibling, wrapping |

Places are root workers and their descendants (`origin: model`); the daemon's
maintenance worker and a connection's scratch worker are never hop targets, so a
lone root has `(no siblings)`. Every hop re-reads the directory; nothing
is inferred from row coordinates. `/help` moves to `Alt-?` to free `h`.

**Position.** The line below the composer names the place, `[<workspace>/<lineage>(<loop>/<turn>)]`:
the lineage from the tree root to the bound worker with `~` marking the worker the session
is in, a presentation marker rather than a URI alias, and the loop and turn beside
the worker they belong to: the loop by its number among the worker's loops, the one `/loops` lists
and `/loop` takes (plurnk-service `{§agui-status-loop-number}`). `[w/~main(3/12)]` at a root, `[w/main/fork-1/~recheck(1/0)]` two
hops down, `[/~]` before the worker is named; an unknown loop or turn is elided. A child
always shows that it is a child, so a session opened on a child reads its full lineage. The
§1.2.1 footer includes the place after the project folder and before activity, so the composer has one line above it.

### §3.1.3 Loops {§cli-loops}

A worker's conversation is its loops. `/loops` lists the bound worker's loops oldest first, one line
each, from the daemon's list (`worker.loops`, plurnk-service `{§agui-worker-loops}`): the loop's number,
the sender of its opening message when no person sent it (a worker, a schedule, a peer), that message's
first line with `…` when it holds more, and the lifecycle mark of a loop under way or ended early, each
line cut to the terminal's width:

```
  1: Let's build an app! Make no mistakes.
  2: No, you did it wrong!… 🛑
  3: worker://helper: Check the tests. ⌛︎
```

`/loop <n>` prints loop `n` whole, oldest first, as history draws it ({§cli-worker-history}): the person's
prompts, replies whole, operations as their headings, its delegation's rows marked and stepped in, reasoning never. It reads the loop's page
(plurnk-service `{§agui-loop-page}`) under the view the session's Runs negotiate, its delegation
observed and reasoning by link, reads each sender's words that travel by reference in their place,
rebuilds its rows from the parts that build them live ({§cli-row-sources}), and prints them below
everything already on the screen under `── loop n ──`. `/loop` alone prints the current loop. A worker
no act has created yet has no loops.

### §cli-worker-history Worker history on attach

Startup and successful workspace/worker navigation synchronize through the existing
AG-UI Run `{§agui-sync}` before admitting new bound work. Synchronization
submits no prompt and performs no inference. An attached live loop remains observable;
disconnecting never cancels work ({§agui-run-disconnect}).

| Surface | History behavior |
|---|---|
| Bound recent tail | The sync Run's `MESSAGES_SNAPSHOT`, the window of the bound worker's conversation (plurnk-service `{§agui-history-window}`), supplies every row, rebuilt from the parts that build it live ({§cli-row-sources}). `PLURNK_CLIENT_HISTORY_ENTRIES` bounds the tail; zero hides history without disabling synchronization. A snapshot the daemon sends again during a Run (plurnk-service `{§agui-history-advance}`) draws each row it holds that the Run has not drawn, the rows its live stream then skips; nothing drawn changes, and a call the Run already holds keeps the arguments it was built with. |
| Prompts and replies | Full text, in chronological order, with actor attribution. |
| Operations | Existing one-line operation headings, including failures; no historical output fetching. |
| Delegation | A descendant's rows the window holds, the delegation the TUI observes (plurnk-service `{§agui-history-window}`), are drawn as quietly as the bound worker's, a message or reply with its words whole and any other operation as its heading, in log order among them, marked `🐜 <name>` and stepped in per generation as §5.1 marks them live, by the bound worker's tree in the gauge (plurnk-service `{§agui-status-descendants}`). A descendant's reasoning and terminal never are. |
| Reasoning | Never backfilled into the live reasoning lane or scrollback. |
| Past/live boundary | Unchanged overlapping receipts are shown once by durable identity; an update to the same receipt, a change of its status, signal or attributes, remains visible. Identical text at different identities is not deduplicated. |
| State/accounting | Replayed entries are not live activity, turns, terminal events, or fresh usage. Only the current gauge and subsequently observed events update status. Elapsed session time does not include time before attachment. |
| Return visits | Each explicit binding restores its current bounded tail. Existing terminal scrollback stays intact. Input recall is separate. |

Historical restoration completes before buffered live rows are released. Binding
transitions retain the draft and keep control commands reachable; no historical
prompt is resubmitted. A malformed or missing snapshot is reported, not presented
as an empty history.

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
| Plain prompt or `...` | Inject into the bound worker's loop; observe an admitted successor through the standard sync Run after the existing stream settles |
| `?`, or `:` removing an active `?` request | Explain that the local review choice belongs to a new run; do not silently strip it and inject |
| `/stop`, proposal responses, question responses, `/quit` | Remain reachable; resolve the identified owner, never whichever request arrived last |
| `/workspace`, `/rename`, `/worker <name>`, `/fork`, topology hops | Refused until the attached model run and submitted commands settle, with that specific reason |

The TUI presents one bound worker. Navigation does not implicitly cancel
or detach its stream. Its binding cannot change halfway through a command; a
navigation already underway admits no new bound work until confirmation. An
action and every interrupt resume retain the workspace and thread captured at
submission. Overlapping proposals resolve by proposal ID. This single-view
restriction is TUI-owned, not a daemon restriction on independent threads.
Each stream reduces its own state; action snapshots do not replace the active
model's status. Cancellation retires only the cancelled run's interrupts and
local waits, including when its SSE has already ended at a question or proposal.

Pending injection acknowledgements keep the worker bound through terminal
observation. `injected_next_turn` stays on the existing stream;
`enqueued_new_loop` requests one successor observer, not a replayed prompt. Sync
uses {§agui-sync} and restores the snapshot's unseen durable rows before releasing
live rows. Rows are seen by durable identity, so a row drawn out of order, such as an
independent client operation's, hides no row the snapshot holds. A successful
observation without a new terminal record adds no loop summary, usage, or tally, whether it
completed, lost its connection or ended with a Problem ({§cli-summary-line-per-loop}).

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

`Ctrl-C` during an in-flight dispatch fires the `loop.cancel` action — the daemon aborts the model run's active drain, the pending loop resolves with `finalStatus: 499`, and the editor continues. The acknowledgement of `loop.cancel` is not the loop's end: the client keeps the run's connection until the daemon's terminal record arrives, up to `PLURNK_CLIENT_CANCEL_GRACE_MS`, so the summary carries the loop's own turn count and accounting; past the grace it hangs up, and a summary without that record says `turns unknown`, never `0 turns`. A run paused on a client-side interrupt — a review, a question — has no stream to carry the record: the client settles it locally, and the observation that follows presents the daemon's terminal. The one-shot client's `--timeout` cancellation hangs up by the same grace, and its summary says `turns unknown` by the same rule. A failed cancel SURFACES on the terminal. A second `Ctrl-C` (or `Ctrl-C` while idle) exits the client; work the daemon admitted runs on, since dropping a Run's connection ends only its delivery ({§agui-run-disconnect}) — `loop.cancel` is the one cancellation.

CLI mode mirrors this: first `Ctrl-C` cancels (the loop resolves 499 → exit 3 per §4); second `Ctrl-C` force-exits 3.

### §3.3 `/import` and bracketed paste {§cli-import-and-bracketed-paste}

`/import <path>` reads a **local** file (co-location law — the client reads its own fs, the daemon never sees the path) and inserts its content at the editor cursor. Relative paths resolve against cwd; an unreadable file prints an error and is a no-op.

**Bracketed paste.** A multiline paste is one editable value and therefore one
submission. pi-tui owns bracketed-paste framing; small pastes remain native lines
and large pastes become one expandable marker.

### §3.4 Workspace MCP controls {§cli-workspace-mcp-controls}

{§cli-functionality-replacement} Every Functionality family but `members`, whose
definition is its glob (§3.7), accepts `replace` with its `add` arguments. The client sends the complete definition to the
corresponding `replace` action, without merging fields or enabling it separately.
The service retains existing enabledness, creates an absent alias enabled, and
preserves the preceding publication on refusal. Both forms use the same argument
parsing, help, completion and exact failure presentation.

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
any inherited definition and enabled state. An inherited server cannot be removed;
disable it or replace it with a workspace definition.

The interactive and positional forms share one tokenizer-independent command
handler. `plurnk mcp …` uses the workspace selected under §1.1;
`--json` emits the unmodified successful action
result.

| TUI / CLI input | AG-UI+ action |
|---|---|
| `/mcp` / `plurnk mcp` | `workspace.mcp.list {}` — one row per server: alias, state, `type`, command or URL, active tool count, and `(workspace)` for a locally added definition |
| `/mcp discover <query>` | `workspace.mcp.discover {query}` — one row per MCP Registry candidate: alias, `type`, command or URL, and the daemon's summary of how it launches and what it needs |
| `/mcp add <alias> <command\|url> [args...]` | `workspace.mcp.add {alias, definition}` — an absolute `http(s)://` target is `{name: alias, type: "streamable-http", url}`, anything else `{name: alias, type: "stdio", command, args}` without `args` when none follow |
| `/mcp replace <alias> <command\|url> [args...]` | `workspace.mcp.replace {alias, definition}` — {§cli-functionality-replacement} |
| `/mcp enable <alias>` | `workspace.mcp.enable {alias}` — publishes a dormant server or retries an unavailable one |
| `/mcp disable <alias>` | `workspace.mcp.disable {alias}` |
| `/mcp remove <alias>` | `workspace.mcp.remove {alias}` |
| `/mcp oauth <alias>` | Inspect the alias; if not active, bind a loopback callback, call `workspace.mcp.oauth.begin {alias, redirectUrl}`, open the returned authorization URL and call `workspace.mcp.oauth.complete {alias, callbackUrl}` |
| `/mcp oauth <alias> <callback-url>` | Submit the complete callback directly to `workspace.mcp.oauth.complete {alias, callbackUrl}` (remote/headless continuation) |

Every token after a command target reaches the server verbatim; a URL target
takes none. The positional form uses `--` before server options so the client
does not consume them: `plurnk --workspace w mcp -- add example npx -y @example/server`.

An add, replace or enable requiring authorization prints the alias (or authorization URL
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
| `/skills replace <name> <source> [--ref <ref>]` | `workspace.skills.replace {alias, definition}` — {§cli-functionality-replacement} |
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
| `/a2a replace <alias> <url> [options.json]` | `workspace.a2a.replace {alias, definition}` — {§cli-functionality-replacement} |
| `/a2a enable <alias>` | `workspace.a2a.enable {alias}` |
| `/a2a disable <alias>` | `workspace.a2a.disable {alias}` |
| `/a2a remove <alias>` | `workspace.a2a.remove {alias}` |

Invalid or unreadable local JSON fails before dispatch; daemon Problems — an
unreachable card, an unsupported interface, an unresolved symbolic credential —
cross the existing diagnostic path without rewriting or retry.

### §3.7 File members {§cli-file-members}

File membership is a thin projection of the daemon's `members` Functionality
family — the common lifecycle of `/mcp`, `/skills`, and `/a2a`, except that a
definition is its glob: nothing is aliased and nothing is replaced. The client
passes the globs through and renders the daemon's states; resolution, the
model's ceiling, and enablement policy live in the service. Git-tracked files are members on their own. A definition is one
gitignore-style glob relative to the project root: it includes matching
untracked files or, with a leading `!`, excludes matching members — an
exclusion wins over every inclusion. The glob is one argument, tokenized
exactly as the sibling families tokenize theirs (quote it to keep whitespace).

| TUI input | AG-UI+ action |
|---|---|
| `/members` | `workspace.members.list {}` — one line per definition, named by its glob, with what it resolved to: `docs/**  service  active → 12 files (3 ignored)`, `!**/tokenizer.json  worker  active → 4 members` |
| `/members discover <path>` | `workspace.members.discover {query}` — one candidate explaining why the file is or is not a member |
| `/members discover <glob>` | `workspace.members.discover {query}` — one candidate previewing what `add` would include or exclude |
| `/members add <glob...>` | `workspace.members.add {files: [glob, ...]}` — each glob is one definition; the reply lists what was admitted |
| `/members enable <glob>` | `workspace.members.enable {file}` |
| `/members disable <glob>` | `workspace.members.disable {file}` |
| `/members remove <glob>` | `workspace.members.remove {file}` |

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
| `/env replace <NAME> <value>` | `worker.env.replace {alias, definition: {value}}` — {§cli-functionality-replacement}; workspace scope uses `workspace.env.replace` |
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

At invocation admission, and when the TUI switches workspace or worker, the
client persists its configured worker environment onto the bound worker via
`worker.env.replace` (and `worker.env.enable` if the entry was disabled) when that
worker has no parent: a child's environment is the one its parent handed down. A
person's own `! command`, in the CLI and the TUI, carries the same entries as the
command's own environment (`op.exec`'s `env`) instead: it runs as the workspace's,
which no worker's layer reaches. A script's statements carry their own
`[{"env": …}]`.

| Source (low → high) | Meaning |
|---|---|
| `PLURNK_CLIENT_ENV_INHERIT` / `--env-inherit <NAME,...>` | Comma-separated exact variable names or trailing-`*` prefix globs whose present values in the client's environment are carried onto the worker (globs skip `PLURNK_*`). |
| `PLURNK_CLIENT_ENV_EXCLUDE` / `--env-exclude <NAME,...>` | Names or trailing-`*` prefix globs, the same syntax, removed from what the inherit patterns matched: `GIT*` less `GITHUB_*`. An explicit entry below is never excluded. |
| `PLURNK_CLIENT_ENV_<NAME>=<value>` | Explicit worker variable definition across the client's `.env` cascade and shell; `INHERIT` and `EXCLUDE` name the two knobs above, never a variable. |
| `--env <NAME>[=<value>]` (repeatable) | Explicit per-invocation override; without `=`, carries `<NAME>` from the client's environment when set. |

A persisted value is the worker's: its `env list` shows it, to the worker's model
as well. A daemon refusal on any configured entry fails admission before a prompt
is sent or TUI input is accepted; a TUI switch whose admission is refused stays
where it was.

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
| `/schedule replace <alias> <worker> <rule> <prompt...>` | `workspace.schedule.replace {alias, definition}` — {§cli-functionality-replacement} |
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

A one-shot `! command` runs no loop; its execution, not a loop, selects `0`, `3` or `4` ({§cli-prompt-prefixes}).

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
| `render` | Load the Markdown/diagram renderer before producing output; no daemon. |

### §5.0.1 Row sources {§cli-row-sources}

The client draws each row from the standard AG-UI part the row builds, the row's facts riding once as that
part's `metadata.plurnk` (plurnk-service `{§agui-plurnk-metadata}`): its durable `id`, log `coordinate`,
`worker`, `origin`, `op`, `source`, the `address` it recorded, `signal`, `status` and `attrs`. A call holds
them; its own receipt repeats none.

| The row | Arrives as | Drawn |
|---|---|---|
| A model operation | `TOOL_CALL_START/ARGS/END`, its statement the arguments, then `TOOL_CALL_RESULT` with its receipt and no facts: text, or a receipt that holds a body as its text part beside the body's document part (plurnk-service `{§agui-body-reference}`), the body never fetched to draw it | When its receipt arrives; a call that opened an obligation (`attrs.stream` or `attrs.message`, below 400) has none and is drawn at its end |
| A delivered reply, or a WAIT that carries a body | `TEXT_MESSAGE_START/CONTENT/END`, the metadata adding its heading's `aside` and its `receipt` | When the message ends |
| An arrival | A user `TEXT_MESSAGE_*`, named by its source | When the message ends; the client's own message, which it already holds, carries no content |
| An accepted message the Worker has not observed | A user message in a sync Run's snapshot, after every row, its `metadata.plurnk` the message's lifecycle with `published: false` (plurnk-service `{§agui-message-acceptance}`) | Never as a row: its arrival, when the Worker observes it, draws it; one its loop left unread is said once ({§cli-status-inbox}) |
| A row that answers another row's call | `TOOL_CALL_RESULT` under its own coordinate, with its own facts | On arrival: a reply's words as its body, any other answer as its receipt |
| A row that builds no part | `CUSTOM plurnk.ambient`, the whole row | On arrival; an actionless row draws nothing |
| History | A sync Run's `MESSAGES_SNAPSHOT`: the same parts, as messages | {§cli-worker-history} |

A row's `target` is the address it recorded; its heading shows the target as authored when its statement
has one (§5.1). A call ended without its receipt, a receipt before its call ended, a result with no text, or
row facts that are present but unreadable are a broken wire (`result-invalid`), never a row skipped.

A sender's words past the daemon's ceiling travel by reference (plurnk-service `{§agui-words-by-reference}`): a
reply's result, or a snapshot's message, whose content is one `document` part, `text/plain` or `text/markdown`, at
the address that serves them. They are the message's words, so the client reads them there with the Run's credential
before anything draws the message; a receipt's body beside its text part is never fetched. An address that answers
a Problem ends the Run with that Problem.

Text-message identity, role and optional sender name survive projection. The daemon owns whether a
delivery is speech: the client does not reinterpret recorded reply addresses using its current thread
spelling. Reopening a conversation through another supported spelling preserves its delivered answers.

### §5.1 `log/entry` line format {§cli-log-entry-line-format}

Received operation rows render as below, except delivered message blocks (§5.4)
and the aggregation and suppression rules in this section.
A row is the operation as written, literal text with the client's own styling and never a
Markdown pass:

```
<label> (<target>) [<scope>] [<pattern>] [{<n>}] [<aside>] [— <outcome>]
```

- The operation label uses {§cli-operation-glyphs}, bold: green when the outcome succeeded, red otherwise. An
  execution row retains its runtime (`⚙️ sh`, `⚙️ python3`): the row's `op` is the fence name as written, never a generic keyword.
  A parse refusal is named by the verb of the statement it refused (plurnk-service `{§parse-attempt}`); one that
  names no attempt uses the failure glyph, `⛔`.
- **The verdict is the row's status, never the presence of an outcome text.** A row failed when its
  status is 400 or above, or when its execution concluded with any status but 200; nothing else
  reddens it. The outcome after the dash takes the verdict's paint: a failed row's Problem title,
  with its diagnostic, in red; any other row's outcome dim. A turn disposition (`WAIT`, and the
  other loop-state rows) carries the daemon's `detail` there, so a `WAIT` with nothing in flight
  renders its glyph and `— Nothing is in flight. Continuing.` dim: a note about what happened.
- {§cli-curation-notice} **Over budget is a curation moment, not a failure.** The daemon's over-budget
  row — an `error` row whose Problem is `engine/context/packet-exceeds-budget` ({§context-over-budget-row}
  in the service SPEC) — is a mandate to the model to curate, and the model is about to. It renders as
  `📌 — curating context`, green and dim, with no title, status or detail; the Problem stays on the
  wire and in the daemon's log untouched. Every other failed row keeps its red `OP` and its title.
- `(target)` is the authored target text, in its parentheses; `<scope>` is the canonical
  `<mark,...>` form; `<pattern>` is the matcher as authored (`/regex/i`, `~query`, `&symbol`).
  COPY and MOVE render `(source) <scope> (destination) <scope>`, each scope beside its own path.
  `*.md` is not emphasis, `<17,-1>` is not markup, `/^# /` is not a heading.
- `{n}` is what the receipt returned, in the receipt's own unit, on every READ and FIND row:
  a FIND's returned items, an exact READ's returned lines (a pattern READ carries its matched
  lines as `lineOrdinals`). A collapsed fan-out counts its received resource receipts instead.
  Pattern, scope, and metadata compose into what is returned and are never operative for the count.
  Other individual operations carry no count.
- The aside is the durable operation aside as sanitized literal text, italic and dim, never
  interpreted as Markdown or HTML.
- A lineage row, a direct child's durable activity the daemon correlated into the bound
  worker's log (`origin: _plurnk` with `source: worker://<name>`), renders two columns
  in, led by `🐜 <name>` in dim, its body previewed beneath one step deeper. Its outcome is the
  row's own: a child's execution concludes in the child's Run, so its lineage row is never held
  for a stream conclusion. A child's conclusion is the parent's own READ of `ops://<name>/<loop>`,
  an ordinary row carrying the child's terminal status and Problem title; it takes no mark
  ({§cli-workers-topology}).
- An observed descendant's own row (the TUI asks the daemon to observe its delegation,
  `forwardedProps.plurnk.descendants`; each descendant arrives introduced with its name and
  generation, by its subagent's `SUBAGENT_STARTED` or, outside any subagent, by
  `plurnk.descendant`) renders one step in per generation, two
  columns each, led by `🐜 <name>` in dim, its body previewed beneath, and its execution's
  conclusion and output peeks stepped in the same way. It never drives the turn presentation,
  the status line's activity, or the response area, and an observed
  descendant's lineage rows are not rendered a second time. Outside a descendant's row the ant
  is the status line's child count.
- Every authored body renders beneath its row as a preview: the plain text, no Markdown pass,
  `PLURNK_CLIENT_PREVIEW_LINES` lines (`--preview-lines` for one invocation), independent of
  the terminal's height, four columns in and dim (the reasoning lane's fade, never italic),
  each line one row: a line wider than the terminal is cut at its width and ends in `…`, a tab
  counting four columns ({plurnk#162}), so three lines of minified output are three rows.
  The preview ends in `… +N lines · <address>` when lines are cut, and a blank row closes the block. A
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
- No body, preview, hit count beyond `{n}`, byte count, numeric status, or log coordinate
  reaches the row; coordinates and every exact status remain on the wire and in `--json`.

§cli-operation-glyphs **Operation labels.** TUI operation labels replace known names with the following glyphs. Other runtimes and
subsystems retain their literal names after `⚙️`. This is presentation only: operation names,
statuses, bodies, and metadata remain unchanged on the wire and in CLI records and plain traces.

| Operation or category | Label |
|---|---|
| NOTE | 🗒️ |
| FIND | 🔎 |
| READ | 📖 |
| EDIT | 📝 |
| COPY | 🖨️ |
| MOVE | 📦 |
| KILL | 🗑️ |
| WORK | 🐜 |
| FORK | 🔱 |
| BARE | ☁️ |
| WAIT | ⏳ |
| SEND | ✉️ |
| SEND with completion 200 | 🐹 |
| SEND with completion 499 | ❌ |
| WARN | ⚠️ |
| FAIL / error | ⛔ |
| INFO | 📌 |
| FACT | 📊 |
| IDEA | 💡 |
| PLAN | 🚧 |

A NOTE whose entire sanitized aside is `fact`, `idea`, or `plan` (case-insensitive)
uses that category's glyph instead of the NOTE glyph and category word. Other asides
remain literal. SEND uses its authored completion signal, or the receipt's completion
when no signal is available; receipt status alone never implies a completion reply.
Live, pending, descendant, and historical rows share this mapping. Delivered messages
and model notes retain their existing body layout beneath the glyph-bearing lead line.
Use explicit emoji presentation for text-default symbols and one ordinary separating
space; width measurement and clipping use the existing terminal-aware utilities.

Fan-out READ, EDIT and resource KILL carry service-owned `attrs.fanout`
(`{target, matched, index, count}`). The live waterfall may collapse a contiguous,
complete successful group to its authored selector and received resource count `{n}`.
`count` describes admitted work, not evidence that every target ran.

| Receipt boundary | Presentation |
|---|---|
| Failure, pending result, missing index, or different worker/loop/turn/operation | Show the received rows with their concrete targets and original outcomes; never merge unrelated groups. |
| New group with the same selector | Index zero starts a separate group. |
| Other waterfall output, next turn, review, parking, run end, disconnect, rebind, or exit | Flush buffered receipts individually before leaving that presentation. |
| History window or suffix arriving after a flush | Show known receipts individually; never infer a missing prefix or unexecuted targets. |

Failures are visible on receipt, not delayed until later targets settle. Historical
rows retain their existing per-resource headings ({§cli-worker-history}).
Collapsing never changes durable receipts, execution policy, or wire counts.

A started execution (status 200, outcome `started`) has no
outcome yet: the service stamps its stream address on the row (`attrs.stream`), and the row
appears when that stream concludes, colored by the conclusion (§5.3). An execution still open
when the following turn begins shows once in grey, with no outcome, and again when it concludes;
a detached execution (`<-1>`) is covered by the same rule, greyed at the next turn and shown
again when it eventually ends.

Width-tolerant; no fixed column widths. Every row begins at column zero.

**Exceptions:** delivered replies render as blocks per §5.4. The TUI moves each submitted editor value into ordinary terminal scrollback — bold, in the human's colour (§5.5), with a blank row above and below, so the human's turns read apart from the model's plain replies — and its inbound SEND echo is not rendered again (`isOwnArrival`). Arrivals from other actors remain visible with their causal source.

#### §5.1.0 Markdown projection {§cli-markdown-projection}

A prettified message body (TUI only; the one-shot CLI keeps raw verbatim for
pipes) delegates GFM parsing, tables, and LaTeX math rendering to pi-tui at
the current terminal width, less its container indentation. All text bodies use
that parser; literal code is never normalized as prose. Nested blocks start
on separate lines; prose, code, and source wrap without truncation. Tables use
aligned box-drawn columns, wrap complete cell content, and separate every
logical row; headings, inline markup, lists, and links retain conventional
terminal presentation; supported LaTeX math expressions (arrows, relations,
Greek letters, fractions, and display blocks) project as Unicode terminal text.
A ```mermaid fence projects as
a topology- and label-preserving Unicode diagram when it fits the same live
viewport. Preserve the authored layout when it fits; otherwise try one alternate
flowchart layout exchanging horizontal and vertical directions, including explicit
subgraph directions. Both attempts share the `PLURNK_CLIENT_MERMAID_TIMEOUT_MS`
execution deadline from the client panel. An error, unsupported diagram, or
expired deadline renders the complete source under
`💻 mermaid — diagram failed to render`; a valid diagram that neither attempt fits renders it
under `💻 mermaid — rendered width <W> exceeds <V>`, the narrower attempt's width and the
viewport's. An invalid deadline is diagnosed in that same
fallback header without preventing the rest of the message from rendering.
Decide the projection before appending it;
there is no delayed replacement, recovery narration, or half-drawn diagram. The wire always
carries semantic source; no pre-rendered channel exists at the protocol boundary.

**Renderer customization {§cli-markdown-adapter}.** Customization is instance-local.
The installed pi-tui public hooks lack a width-aware whole-code-block override
and a link renderer receiving both label and destination. A narrow adapter of its
private rendering hooks supplies only Mermaid projection at the actual nested
block width and {§cli-hyperlinks}. Other tokens retain native rendering; the
library prototype and unrelated Markdown instances remain unchanged. The dependency
is pinned to the verified version; upgrades must verify that boundary, nested
layout, literal-code preservation, complete source fallback, and link styling
before landing. The adapter neither
parses Markdown independently nor substitutes another renderer if its hooks fail.

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

Readable provider reasoning is neither working memory nor assistant speech. Every Run negotiates
reasoning by link (plurnk-service `{§agui-reasoning-link}`, `forwardedProps.plurnk.reasoning: "link"`):
the live text arrives as the `plurnk.reasoning` preview of the reasoning message it belongs to, and each
turn's reasoning travels by its link, a message that draws nothing. AG-UI's standard
`REASONING_MESSAGE_START/CONTENT/END` text stays a preview source when the text rides the message itself.
The TUI shows a dim `💭` tail, at most one third of the terminal, below operation
history and above delivered responses. It disappears when reasoning ends, and the tail belongs to the Run streaming it: when that Run settles
— by its terminal, by cancellation, or by a lost connection — the tail is retired whether or not its end
arrived, so the next prompt's reasoning starts clean. Reasoning history remains available from the daemon,
not duplicated into scrollback.
It never infers reasoning
from NOTE, renders encrypted reasoning as text, or invents an empty transcript.
The one-shot client streams this human trace to stderr; stdout remains the bare
answer and JSON mode remains silent.

#### §5.1.2 Response ordering {§cli-response-order}

The TUI orders operation history, live reasoning, then delivered responses. Operations
render when their receipts arrive. Responses from a continuing turn enter scrollback
when the next turn begins; final responses remain below reasoning until the next user
interaction or rebinding. No task inventory or fixed task-table slot exists.
Every response line fits the current viewport, including plain text and JSON;
resizing rewraps the retained content through pi-tui's ANSI-aware text layout.
Unchanged response projections, including diagram failures, are reused across
refreshes and archival; only a width or presentation invalidation rerenders them.

| Operation | Waterfall projection |
|---|---|
| NOTE | {§cli-note-rendering} A model NOTE renders its whole body in the Markdown layout at the current width, stripped of every weight and painted dim — the status line's weight — beneath its glyph and aside ({§cli-operation-glyphs}), with a reply's column-zero layout. Its log identity and failure visibility remain; it is not a delivered message and does not enter CLI response stdout. A harness NOTE retains its operation heading and whole plain, dim, four-column-indented body. |
| Outside text (`plurnk.outside`) | {§cli-outside-text} A turn's prose outside its fences arrives once per turn as `CUSTOM plurnk.outside` ({§agui-outside-text}: its log coordinate, the text verbatim, its packet weight), never as a row. It renders with a reply's layout — blank lead line, full Markdown body at column zero at the current width — where the turn's rows are, in arrival order. It is not speech: never the response surface, never a delivered reply, never CLI stdout. The one-shot CLI traces the text verbatim to stderr, and the `--json` record's `response` excludes it. |
| WAIT | Ordinary heading, aside and any receipt detail; never assistant speech. |
| Delivered SEND | Message block per §5.4. |
| Other SEND | Operation heading and actual receipt detail or Problem. |

Loop state comes from the daemon's status events, not an inference from a verb or body.

### §5.2 Summary line (per loop) {§cli-summary-line-per-loop}

```
<lead><tag> · <N> turns · <wall>ms · ↓<input> ↑<output> [· cur <percent>/<budget>] [· ctx <percent>/<capacity>] [· loop $<usd to the hundredth of a cent>]
```

`tag` derives from the exact terminal `OperationResult`; `lead` is `🎯 ` for a success (`done`) and two spaces
for every other tag. A 500 is `strike-out` only for `engine/rails/strike-threshold`; another 500 is `failed`.
A summary follows exactly one loop terminal. An observation that ends without one — the sync Run
completing, the daemon stopping, a credential revoked, a dead wire, this client's own hangup — is no
loop outcome: no summary, no usage, no tally, no lifecycle change; its Problem is diagnosed as it arrives
and the session stops observing. Idle connection time is never loop wall time. A prompt's own Run that
ends without terminal truth keeps its summary of uncertainty (`turns unknown`, the wire's Problem).
Input and output are the conventional aggregate fields from the daemon's accounting envelope. Missing token quantities render as `?`; zero or unavailable aggregate cost is omitted; a nonzero exact decimal is rendered without floating-point conversion. JSON output retains the complete accounting evidence.

### §5.3 What is NOT rendered {§cli-what-is-not-rendered}

- The full packet (`turn.packet`). The client never displays the rendered index or model-facing log sections.
- Whole bodies. Every body but a NOTE's is a preview (§5.1); `plurnk read` retrieves a complete log entry.
- Raw SSE frames.
- Emission rows. A `_plurnk` READ whose `attrs.kind` is `emission` is the daemon's announcement of the worker's own admitted emission, whose operations already render as their own rows. The TUI waterfall, history replay and CLI trace skip it; `--json` and `plurnk read` keep it.
- Stream telemetry. A `stream/event` (start, growth, per-channel close) writes nothing to the waterfall. An admitted execution appears when its outcome is known: the conclusion renders the launching fence's row (§5.1), colored by result, which succeeds below `400`, with the Problem title or daemon summary on failure. A conclusion that arrives before the gated call that launched its stream has settled waits for the settled row and renders with it (§8.4). A stream whose launch is unknown renders as its scheme and address. Activity belongs to the status line; wake bookkeeping is never a row.

Concluded output is read through `entry.read` using the event's exact target and worker perspective:

| Surface | Output |
|---|---|
| TUI, including human `!` | stdout/stderr previews under the operation row (§5.1), then one blank line; an execution with no output adds no line |
| One-shot loop or script, text mode | stderr trace inlines only channels ≤160 characters and ≤2 lines; stderr content is marked `!` |
| One-shot `!` | Complete verbatim stdout/stderr as the command's product ({§cli-prompt-prefixes}); no duplicate preview |
| `--json` | No preview read or rendering |

A failed preview read is diagnosed without replacing the execution or loop result.

### §5.4 Delivered messages {§cli-broadcast-send-rendering}

An assistant text message projected from SEND or KILL carries response content, including another actor's delivered reply observation. The standard message role establishes delivery; the receipt's historic thread spelling does not reclassify it. The interactive client renders full message bodies, not diagnostic previews. Completion metadata selects the SEND glyph, not delivery or loop settlement, which belong to the daemon. An empty body creates no response and neither repeats nor erases a previous reply.

TUI mode contract:

- Lead line: the operation glyph ({§cli-operation-glyphs}), muted, followed by the sanitized aside. The body's lines stay at column zero. No keyword, numeric code, or path.
- Body: follows the lead line at column zero, without indentation, truncation, or dimming; §5.1.0 owns Markdown layout.
- No synthetic surrounding blank rows.
- Empty SEND content is legal; its receipt remains an operation row, not blank speech.

A delivered response is plain: its Markdown carries the only emphasis
(headings, `**strong**`, table heads), and the human's own line — bold, in the human's
colour, spaced (§5.1) — is what sets the two voices apart. Delivery alone makes a message
block: a failed, unrelated or undelivered SEND, targetless or not, is an Other
SEND (§5.1.2). {§cli-color-policy} controls colour and emphasis without changing
layout. CLI delivered answers remain verbatim per §2.

CLI/one-shot mode: trace entries use stderr per §5.1; delivered response messages use stdout (§2).

The message body source is `entry.tx.body`, carrying `{ raw, json }`.

Bodies accumulate in delivery order, separated by a blank line. Tool results and ambient rows do not
become responses through their metadata. NOTE is working memory; WAIT speech remains progress rather
than contributing to the CLI's answer accumulator.

**CLI default** emits each qualifying body verbatim, without Markdown or
JSON transformation. **CLI `--json`** includes the aggregated `response` in the
single complete run record defined in §2.1, not a second body-only output format.

**TUI mode** (no `--json`; the flag is CLI-only) renders qualifying responses as blocks, dispatching by content type:

- **JSON** — `tx.body.json !== null`. Render `JSON.stringify(json, null, 2)`.
- **Text** — the native Markdown renderer described in §5.1.0 handles plain prose, inline markup, code, and supported LaTeX together. JSON retains its separate literal projection; CLI output remains verbatim.

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

### §5.6 Terminal conveniences {§cli-terminal-conveniences}

Native terminal features the client emits only where they cost nothing when unsupported:

- {§cli-hyperlinks} **A web address links to itself.** Under the styling policy
  ({§cli-color-policy}), text whose destination is an `http(s)://` URL is wrapped in an OSC 8
  hyperlink: a row's web target (`READ (https://…)`), and a Markdown link's label in a delivered
  message, whose visible `(href)` stays beside it. A `worker://`, `log:///`, file or any other
  Plurnk address is never a hyperlink: OSC 8 can encode it, but nothing outside the client can open
  it. The model's own text is sanitized of every escape before any link is added, so a link is
  always the client's, never one the model wrote. Terminals without OSC 8 show the plain text.
- {§cli-terminal-title} **The window title names the binding.** While the TUI runs, the title is
  `plurnk · <workspace>` or `plurnk · <workspace> · <worker>`, set on attachment and on every
  workspace or worker switch. Before the first title the client pushes the terminal's current title
  (XTWINOPS 22) and on stop it pops it (XTWINOPS 23), so a shell or multiplexer gets its own title
  back; a terminal without the title stack keeps the last title until its shell sets the next, as
  with any program. The one-shot CLI sets no title.

### §5.6.1 Attention {§cli-attention}

The client raises one signal when the person is needed, and its sinks decide how to reach them. The
terminal bell is the one sink: with `PLURNK_CLIENT_BELL=1` or `--bell`, each raise writes one BEL, to
the TUI's terminal or a one-shot prompt's stderr, so a piped or `--json` stdout carries only its product.
A stream that is not a terminal hears nothing, and the model's text never carries a bell
({§cli-hyperlinks}).

| Raised when | Reason |
|---|---|
| A loop of the bound worker concludes `200` | `reply` |
| A loop concludes `499`, unless the person stopped it from this client while it ran | `stopped` |
| A loop ends any other way, or at its turn budget | `failed` |
| A proposal waits for review while nothing else did | `review` |
| A question waits for an answer while nothing else did | `question` |

A review or question raises the signal only when nothing was waiting, so a burst rings once, and the
next one raises it again after every waiting item is decided. A one-shot prompt presents no questions
({§cli-question-forms}): it raises for its review prompts and its loop's end. A person's own `!`
commands and scripts raise nothing.

---

## §6 Proposal review {§cli-proposal-review}

Client-owned proposals arrive as standard AG-UI interrupts under plurnk-service
`{§agui-proposal-resolve}`: each carries the daemon's proposal projection as
`metadata.plurnk.proposal`, and names the operation's own call as `toolCallId` when the
Run holds that worker's conversation. The client presents the proposal and resumes the
Run with the selected decision, echoing the supplied opaque `Interrupt.id`; it never
derives a resume identity from the call or from a proposal number. The gated call awaits
its decision without a row; its settlement folds the settled facts onto the call and draws
the operation once ({§cli-row-sources}). The following sections describe its local review projection.

{§cli-resume-observation} A resume continues the Run it answers: it carries that Run's observation
and claim (`forwardedProps.plurnk.descendants` when the session observes its delegation, and
`control`), never a message's own parameters (`maxTurns`, `openPaths`).

### §6.0 Worker ownership {§cli-worker-ownership}

The thread's workspace-scoped AG-UI identity owns approvals. Prompt submission,
client operations, and explicit TUI attachment claim only runtime-owned workers
and their runtime-owned descendants; observing another owner never transfers authority.
Every Run declares the client's capability set: `RunAgentInput.tools` advertises the
client tools it implements, not permission grants, and `forwardedProps.plurnk.interactive`
states whether a person attends it.

| Client mode | `interactive` | Advertised tools |
|---|---|---|
| The TUI at a terminal | `true` | `question`, `mcp_input_required` |
| A one-shot prompt at a terminal | `true` | none: it reviews, but presents no questions ({§cli-question-forms}) |
| No terminal, or `--auto` | `false` | none |

Review needs no declared tool: every AG-UI owner reviews (plurnk-service `{§agui-worker-owner}`), and
this client always resolves it, by a person, `--yolo`, configured acceptance, or fail-closed headless review.

`--auto` (`PLURNK_CLIENT_AUTO`) states that nobody is attending, even at a terminal: the
daemon asks nothing, because its workers are not offered `question`, and a loop that would
wait for a person concludes instead. It removes
the person, not the approver: `--yolo`, configured acceptance, or fail-closed review still
settle what the daemon routes to this client.

The TUI maintains `/agui/connect` while idle and reconnects after a terminal or
resolved interrupt. That owner connection creates the session's worker when there is none
(plurnk-service `{§agui-action-binding}`); verbs wait for it. Inspection and direct operations do not
detach that owner connection. Future owned work, including independently active children, can request
review without a new user prompt. Disconnect changes neither ownership nor pending gates.

{§cli-gate-answer-lifetime} Concurrent Runs share one local resolver per interrupt, and an answer
holds its gate only while the Run that carries it lasts. A gate presented to a Run while another of
the client's Runs holds it opens no second review and submits no second decision: that Run holds
the gate's interrupt on a connection (plurnk-service `{§agui-held-interrupts}`) and follows the
work once the gate settles or the other Run lets it go. Once the Run carrying an answer ends, the
answer applied, refused or lost with its connection, the gate is no longer held: a later
presentation of it is reviewed again.

`--yolo`, configured acceptance, and `?` remain client-side decisions. Server
`PLURNK_SERVICE_PROPOSALS` owns automatic server disposition.

### §6.1 Notification shape {§cli-notification-shape}

The interrupt's `metadata.plurnk.proposal`, as plurnk-service `{§proposal-projection}` defines it; the
client reads these fields:

```ts
proposal {
    logEntryId: number,           // pending log_entries row
    workerId: number,             // the worker asking
    worker: string,
    expiresAt?: string,           // the operator's decision deadline, ISO 8601; absent while it waits indefinitely
    op: "EDIT" | <runtime tag> | ...,
    target: { scheme: string | null, pathname: string | null },
    body: string,                 // udiff for EDIT; command summary for an execution
    attrs: object,                // scheme-specific payload; configured acceptance reads an execution's ({§cli-tool-acceptance})
}
```

AG-UI routes review to the recorded owner. Server `accept` and `reject` dispositions settle in Core and never become client review work.

{§cli-review-attribution} A gate names the worker asking when it is not the bound worker, by the name its proposal
carries or, for a question, the name the session's delegation introduced (`worker <id>` when it holds none), and the
deadline the operator set for the decision: `proposal EDIT a.ts · from helper · decide by 14:32`, the date added when
the deadline is not today. The TUI's review titles and the one-shot menu say the same.

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

While the one-shot menu waits, the CLI holds the proposal's interrupt on a connection (plurnk-service
`{§agui-held-interrupts}`). When another client's answer or the daemon settles it first, the menu withdraws with
`settled elsewhere` and sends no decision; a decision already under way, such as an open editor, finishes unsent. The CLI
then follows the work to its end. An answer refused because its gate no longer waits is shown, never retried, and the CLI
follows the work.

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
| Settled elsewhere | While a request is pending, the client holds its interrupt on a connection (plurnk-service `{§agui-held-interrupts}`). When another client's answer or the daemon settles it, before the connection or while it holds, the connection finishes and the request is withdrawn, never answered by this client; the client follows the work that continues. An answer refused because its gate no longer waits is shown, and the client follows the work. |

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

The TUI presents questions; a one-shot prompt offers no question tools
({§cli-worker-ownership}), and cancels through ordinary AG-UI resume one delivered anyway.
AG-UI `request_user_input` interrupts present the message and the exact response
contract. Independent, directly typed fields are collected individually; each
shows its type, required/optional status, and description. String enums use
pi-tui selection lists; optional enums include a Skip choice. Other fields use
the multiline editor, with empty Enter skipping optional fields. Unrestricted
strings accept free text; non-string values use JSON notation.
For the native `question` tool, a string-enum choice followed only by text fields
(strings without enums) treats the literal `other` option as **Free response** in
the menu, without changing its wire value. A nonempty fixed choice submits
immediately when all those remaining fields are optional, omitting them and
validating the complete response. Free response continues through the text
fields; required fields are never skipped. Other tool forms retain their exact
field collection. No field name is reserved for these details.
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
prompt-driven flow. They support `--json` for machine-readable output (stdout
product per §2.1; trace and errors stay on stderr). `effort [policy]` reads or
changes the durable effort. `capabilities [json]` projects every durable
capability layer and its effective intersection, or replaces the workspace
policy. Local `render` does not contact the daemon.

When the first positional argument matches a known subcommand verb, the dispatcher
routes there instead of assembling a prompt. Invalid forms of that command exit
`64`; other positionals remain prompt text.

### §7.1 `plurnk models` {§cli-plurnk-models}

Queries one bounded page from the daemon's release-pinned catalog through `models.list`. No workspace is attached and no provider request is made. Positional words form a case-insensitive search; `--provider <name>` narrows the provider, `--all` includes models missing local configuration, and `--offset`/`--limit` page without loading the full catalog.

Default output is a column-aligned table of `selector / name / context / efforts / readiness`, where `efforts` {§cli-models-efforts} lists the daemon's admitted efforts for the exact route (`capabilities.efforts`) or `-` for a model without an effort dimension, plus a continuation offset when another page exists. The default availability is configured-and-ready exact routes; `--all` rows explain missing credential or configuration alternatives. With `--json`, the client emits the complete page unchanged so `offset`, `total`, and `nextOffset` survive.

### §7.2 `plurnk workspace list` {§cli-plurnk-workspace-list}

Lists workspaces on the daemon via `workspace.list`. No prior attach required.

Default output: a column-aligned table of `name / project_root / created`. Null `project_root` renders as `(headless)`. Physical provider-request accounting is not denormalized into this directory view.

With `--json`: emits `workspaces` array verbatim.

### §7.3 `plurnk workspace workers <name>` {§cli-plurnk-workspace-workers-name}

Lists workers within the existing workspace selected by literal `<name>` through `workspace.attach`, then calls `workspace.workers` on its qualified thread. A missing workspace preserves the daemon's 404 Problem and creates nothing.

Default output: a column-aligned table of `name / created`. With `--json`: emits `workers` array verbatim. Physical provider-request accounting is not denormalized into this directory view.

Typical use: discover a worker name to pass as `--worker` on `plurnk log read`.

### §7.4 `plurnk log read` {§cli-plurnk-log-read}

Reads a worker's log through `log.read` in the workspace selected under §1.1.
`--worker <name>` selects an existing worker;
omission uses the shared worker default under §1.1.

Filter flags (all numeric, all optional):

| Flag | Maps to | Meaning |
|---|---|---|
| `--loop <id>` | `loopId` | Limit to one loop |
| `--turn <id>` | `turnId` | Limit to one turn |
| `--since <id>` | `sinceId` | Entries with id > sinceId (incremental fetch) |
| `--limit <n>` | `limit` | Cap entries (daemon default 100, max 1000) |

Default output: one trace line per entry, same format as CLI-mode trace (`[<status>] <origin> <op>[<sub>] <path> <scope>`). The scope is omitted when the operation has no line marker. With `--json`: emits `entries` array verbatim.

### §7.5 `plurnk effort [level]` {§cli-plurnk-effort}

Uses the workspace selected under §1.1; `--worker` selects a named worker. With no
level, calls `worker.effort.get`. With one level, calls
`worker.effort.set`. Text mode prints the effective effort and supported
choices; JSON mode emits the daemon result unchanged.

### §7.6 What subcommands do NOT do

- Send prompts.
- Hide state changes: workspace rename, reasoning and capability setters, MCP
  management, and scripts explicitly request mutations; inspection commands do not.
- Honor flags that only matter to a message Run (`--model`, `--effort`,
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
  subcommand, action, and runtime failures use `{type, title, status, detail}` plus
  useful extensions. Daemon operation failures remain durable log results; the
  client does not recreate them as push events.
- Incoming Problems remain exact. The client accepts them from
  `application/problem+json`, a Run end's metadata (the terminal record's `result.problem`, or `problem` for a Run
  that failed without its loop's end), a failed action outcome in `RUN_FINISHED.result`, and `CUSTOM plurnk.problem`
  for a Problem that ends no Run (plurnk-service `{§agui-plurnk-metadata}`). The terminal record's `result` is the
  terminal wire truth; the client's
  `finalStatus` JSON field is its projection of `result.status`, not a daemon
  field. `RUN_ERROR`'s `code` and `message` are the standard terminal signal, not a source from which
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
Problem's title, detail, and optional recovery to stderr. An AG-UI endpoint that answered with a failure surfaces that failure;
only connection-level failures receive service address/availability hints.
{§cli-connection-onboarding}

This boundary includes workspace creation before the interactive transport is
bound; omitting `--workspace` must not turn the same failure into an uncaught exception.

### §8.2 Credential {§cli-credential}

The operator's secret is a client secret at the daemon's authorization server
({§agui-oauth-clients}), never a bearer: the shared `PLURNK_SECRET` when set, else the one line of
the file a daemon running as the operator minted beside its database ({§credential-authority}),
`secret` beside `PLURNK_SERVICE_DB_PATH` when the environment names a database and otherwise
`$XDG_DATA_HOME/plurnk/secret` (`~/.local/share/plurnk/secret`); with neither, the client presents
nothing. On the first request of an invocation the client discovers
that server from the resource it dials, `<origin>/.well-known/oauth-protected-resource` (RFC 9728)
and the issuer's `/.well-known/oauth-authorization-server` (RFC 8414), and exchanges the secret for an
access token with the `client_credentials` grant as the client `operator` with the scope `agui`; every
request then presents `Authorization: Bearer <access token>`. A token is renewed when it lapses, and
once more when the daemon answers `bearer-token-invalid` before any event of a run was seen. A secret
read from the file is read once more when the daemon answers `invalid_client`, since a restarted
daemon mints anew, and the exchange is retried with the new line. A daemon that publishes no resource
metadata authenticates nothing, and the client presents nothing. A service the client starts is
dialed with the secret it minted beside its database ({§cli-daemon-autostart}). The daemon
refusing the secret is `client/credential/refused`, whose recovery names the file when one was read;
metadata that cannot be read is `client/credential/discovery-failed`; both end the invocation as any
Problem does. With no secret at hand, the client signs in ({§cli-sign-in}).

#### Sign-in {§cli-sign-in}

With neither `PLURNK_SECRET` nor a minted file, the client's credential at an authenticating daemon is
the grant a browser sign-in left: on first use it registers itself as a public client (RFC 7591),
opens the browser at the daemon's authorization endpoint with PKCE (`S256`), a fresh `state` and the
`agui` scope, receives the code through the loopback callback it binds for MCP
({§cli-mcp-oauth-callback}, the page then saying "Signed in to Plurnk"), exchanges the code itself,
and keeps the refresh token with the client id, the issuer and its token and revocation endpoints
under `$XDG_STATE_HOME/plurnk/grants.json` (`~/.local/state/plurnk/grants.json`, 0600, one entry per
daemon address). Every later invocation renews through that grant with no browser and no discovery;
a grant the daemon no longer knows (`invalid_grant` or `invalid_client`, as after a daemon restart)
is forgotten and the sign-in runs again. With no grant, the client presents nothing and asks nothing
until the daemon answers `bearer-token-required`, which the credential answers once. Only an
interactive invocation, a terminal on both stdin and stderr and no `--json`, opens a browser by
itself: a headless one with no grant is refused with `client/credential/sign-in-required`, whose
recovery names `plurnk login` and `PLURNK_SECRET`. `plurnk login` signs in now, whatever grant stands,
and keeps the new one; `plurnk logout` revokes the kept grant at the daemon's revocation endpoint and
forgets it; either says so on stderr and exits 0, and both do nothing when a secret is at hand or the
daemon authenticates nothing. In that browser the operator signs in with the daemon's
`PLURNK_PASS` ({§agui-oauth-login}), or answers its consent page when the browser
already holds the daemon's session ({§agui-oauth-session}); the deadline is
`PLURNK_CLIENT_OAUTH_TIMEOUT_MS`. Callback codes are neither printed nor kept.

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

Client `edits_blocked`, `history_lost` and `message_unread` observations are also Notices because
they advise without terminating an operation. Client failures are Problems.

### §8.3 Rendering and channel posture {§cli-notice-rendering} {§cli-channel-posture}

`renderDiagnostic(diagnostic)` preserves the distinction between transient Notices
and RFC 9457 Problems. Notices use the operation-row presentation, not an alert block:

```
⚠️ <source>:<kind> [<position>] — <message>
```

| Contract | Label and style | Layout |
| --- | --- | --- |
| Notice, `warn` | `⚠️` and message in the operation failure red | Flush-left, no gutter or surrounding blank rows |
| Notice, `error` | `⛔` and message in the operation failure red | Same as `warn` |
| Notice, `info` | `📌` and message in muted text | Same as `warn` |
| Problem | `❌` and message in the operation failure red: a request of this session's, or its connection, failed (the glyph of a failed status and a cancelled SEND); `⛔` stays the worker's own operation failing | Same as `warn`; recovery and hint lines follow |

Notice discriminators are muted; further message, snippet and hint lines follow
without an alert gutter. Rendering does not change severity, operation results,
or model teaching, and never infers severity from `kind`. Problems retain their
alert presentation:

```
│ <icon>  <Alert> <source>:<kind> [<position>] — <detail-or-message>
│ <further message lines, if any>
│   <snippet lines, if any>
│ <recovery and hint lines, if any>
```

The icon is two columns wide, so two spaces separate it from the word; the message rides the
title line.

`ContentOffset` renders as
`L<line> col<column>` and `LogCoordinate` as its coordinate plus optional op.
CLI mode writes diagnostics to stderr. TUI mode inserts them into the waterfall
without colliding with the active prompt. JSON records retain the original diagnostic.

### §8.4 `stream/event` and `stream/concluded` {§cli-stream-event-and-stream-concluded}

The daemon also projects streaming-channel metadata as `plurnk.stream` events.
Streams are content lifecycle, not Problems or Notices. The client renders no
stream lifecycle of its own: a start or growth event writes nothing, and a
conclusion renders the launching fence's operation row once (§5.3).

```
stream/event     { entryId, workerId, target, channel, state, contentLength }
stream/concluded { entryId, workerId, target, subscriptionId, scheme, result, summary, wakeAction }
```

`workerId` is the entry-read perspective and `target` is the stream's address: the one the service stamped on the execution row as `attrs.stream` (`python3:///0c0ffee1`), opaque to the client and never composed. An address alone does not establish a producer. Only an admitted receipt (`200` started or `202` queued) waits for a conclusion; refusals render immediately. Approval may supply the receipt's outcome text; admission follows status, not that text. A conclusion can come first: the daemon runs a subsystem command inside the settlement of its call, so the stream concludes while the call still awaits its settled row. That conclusion waits for the row, which then renders with it whatever its status, and the CLI trace prints the conclusion's line right after the row. The TUI keeps the admitted row until that address concludes, then renders it once, per §5.1:

```
python3 Run the focused tests
python3 Run the focused tests — failed (exit 2); stdout=0 bytes, stderr=41 bytes
```

`wakeAction` is engine bookkeeping and never a row: a concluded stream does not
claim that a loop resumed; ordinary loop events remain the execution evidence.
A conclusion whose launch the client never saw renders as its scheme and address in
the same grammar. Output presentation follows §5.3; consumers obtain content
through `entry.read`, not stream telemetry.

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
2. Connects to the module at `http://$PLURNK_HOST:$PLURNK_PORT/agui` (or the exact `PLURNK_AGUI_URL`), presenting an access token acquired with the operator's secret, `PLURNK_SECRET` or the daemon's minted file, when there is one ({§cli-credential}).
3. Resolves the workspace and worker separately under §1.1, retaining their binding for subsequent requests until an explicit navigation command changes it.
4. Subscribes to `log/entry` notifications and renders each per §5.1.
5. Consumes client-owned proposal interrupts and resolves each through standard AG-UI resume per §6; loop-owned dispositions are absent from that surface.
6. Consumes `CUSTOM plurnk.notice` and renders each Notice per §8.
7. Maps each loop's terminal result to exit codes per §4.
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
