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
| **workspace** | The WORLD (service SPEC, machine-processes): one curated workspace, daemon-owned. Selected by NAME, verbatim — the client sends `forwardedProps.plurnk.workspace` on every run (attach-or-create module-side; a worker without a workspace is rejected 500). |
| **run** | A conversation over the workspace's world. The client's thread binds the workspace's model run; client ops journal in the client run. Addressed by name via `--worker` (see §1.1). |
| **loop** | A single prompt-driven model loop. May span many model turns; terminates on a broadcast SEND carrying signal 200 or 499, or on hitting `maxTurns`; the outcome arrives as `CUSTOM plurnk.terminated` on the worker's SSE. |
| **log/entry notification** | Daemon-to-client push: one notification per dispatched op, carrying the action-entry shape (`{op, target, status_rx, rx, ...}`). |
| **one-shot mode** | `plurnk "prompt"` — single loop.run, render, exit. Unix-tool posture. |
| **TUI mode** | `plurnk` (no args) — interactive REPL; multiple loop.run invocations per workspace. |

---

## §1 Invocation {§cli-invocation}

```
plurnk [options] [prompt...]                # one-shot from positionals
<piped stdin> | plurnk [options] [prompt...] # one-shot from stdin (and/or positionals)
plurnk [options]                             # TUI mode (no positionals, TTY stdin)
```

The prompt is assembled from positional args + piped stdin. If both are present, positionals come first followed by a blank line, then stdin. If only positionals → those. If only piped stdin → that. If neither and stdin is a TTY → TUI mode. The `--json` flag requires a non-empty prompt (errors with exit 64 if neither source provides one).

Options:

| Flag | Type | Meaning |
|---|---|---|
| `-h`, `--help` | flag | Print usage, exit 0 |
| `--json` | flag | CLI mode only (or `PLURNK_CLIENT_JSON`). json OUTPUT MODE: one complete record document on stdout, stderr silent, structured errors. See §2.1 / §5.5. |
| `--workspace <name>` | string | Resume the named workspace. See §1.1. Overrides `PLURNK_CLIENT_WORKSPACE`. |
| `--worker <name>` | string | Resume (or create) the named run within the workspace. Requires `--workspace` outside web mode; an unconstrained web portal resolves the workspace first. Overrides `PLURNK_CLIENT_WORKER`. See §1.1. |
| `--model <selector>` | string | Persist a declared alias or exact `provider/model` route on the conversation worker before its first loop. See §1.2. |
| `--reasoning <policy>` | string | Persist the daemon-validated reasoning policy on the conversation worker before its first loop. See §1.2.3. |
| `--project-root <path>` | string | Absolute path passed as `projectRoot` on `workspace.create`. See §1.3. Overrides `PLURNK_CLIENT_PROJECT_ROOT`. |
| `--yolo` | flag | Auto-accept every proposal locally without prompting (the default). See §6. Forces `PLURNK_CLIENT_YOLO` on. |
| `--auto` | flag | Set the loop proposal disposition to `accept`; no client review/resume round-trip. |
| `--policy <json>` | string | Complete LoopPolicy applied to every loop: `review`, `accept`, or `reject` proposal disposition. |
| `--capabilities <json>` | string | CapabilityPolicy applied when creating the workspace. |
| `--max-turns <n>` | string | Per-loop turn cap (daemon default `PLURNK_MAX_TURNS`). |
| `--timeout <s>` | string | Cancel each prompt loop via `loop.cancel` after `<s>` seconds. CLI exits 3 with `"timedOut":true`; web keeps the selected Worker and renders the resulting terminal state. |
| `--host <host>` | string | Web mode only: local browser portal host. Defaults to `PLURNK_WEB_HOST`, then `127.0.0.1`. |
| `--port <n>` | string | Web mode only: local browser portal port. Defaults to `PLURNK_WEB_PORT`, then `10660`. |
| `--files-items <n>` | string | Workspace-open preview: `-1` full / `0` off / `N` first-N tracked files at turn 0. Create-time only. See §1.4. |
| `--max-commands <n>` | string | Tighten the workspace operation ceiling. Create-time only. See §1.4. |
| `--no-git` | flag | Deny git membership and working-tree status for the workspace. Create-time only. See §1.4. |

Env:

| Var | Default | Meaning |
|---|---|---|
| `PLURNK_HOST` / `PLURNK_PORT` | `127.0.0.1` / `1066` | The daemon's in-process AG-UI+ module — `http://$PLURNK_HOST:$PLURNK_PORT`, the client's sole surface. `PLURNK_AGUI_URL` overrides the assembled URL; `PLURNK_AGUI_TOKEN` rides as the bearer when set. |
| `PLURNK_CLIENT_WORKSPACE` | _unset_ | Workspace name to resume (or create). Equivalent to `--workspace`. |
| `PLURNK_CLIENT_WORKER` | _unset_ | Run name to resume/create. Equivalent to `--worker`. Requires `PLURNK_CLIENT_WORKSPACE` outside web mode. |
| `PLURNK_CLIENT_PROJECT_ROOT` | _unset → cwd_ | Absolute path used as workspace `projectRoot` on creation. Equivalent to `--project-root`. See §1.3. |
| `PLURNK_CLIENT_YOLO` | `1` | When truthy (`1`/`true`/`yes`/`on`), auto-accept every client-owned proposal locally; `0` reviews each one. See §6. Equivalent to `--yolo`. |
| `PLURNK_AUTO` | _unset_ | When truthy, keep proposal authority inside every loop. Equivalent to `--auto`. |
| `PLURNK_CLIENT_LOOP_POLICY` | _unset_ | Default LoopPolicy JSON. `--policy` overrides it. |
| `PLURNK_CLIENT_WORKSPACE_CAPABILITIES` | _unset_ | Create-time workspace CapabilityPolicy JSON. `--capabilities` overrides it. |

**Cascading env.** Highest precedence first: shell exports → repeated `--env-file` / `--env-file-if-exists` flags (node-native; the last occurrence wins; `--env-file` requires the file, while the other skips a missing one) → project `./.env` → `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env` → the client's own packaged floor (below). All layers are optional; the client works with no configuration. The client reads the daemon address (`PLURNK_HOST`/`PLURNK_PORT`, or `PLURNK_AGUI_URL`) from the shared XDG file. There is no generated aggregate defaults file; `plurnk-service config defaults` renders the complete owner-labelled catalog on demand.

**The self-serve floor** {§cli-env-defaults} — per the ecosystem standard (one owner per key, the file IS the docs), the client ships `.env.defaults` at its package root declaring only the `PLURNK_CLIENT_*` prefix and loads it SET-IF-UNSET beneath every operator layer. A knob the operator set is never overridden; a commented knob is documentation, not a value.

### §1.1 Workspaces and workers {§cli-workspaces-and-workers}

Workspaces and workers are daemon-owned. The client only knows their **names** — ids are internals used by the daemon to avoid conflicts and are not exposed via flags or env. Workspace-scoped calls use the transport's bound workspace; the client never invents an ID. Worker switching rebinds the conversation by name, including after a fork.

**The name IS the identity.** With `--workspace`/`PLURNK_CLIENT_WORKSPACE`, the client sends that name VERBATIM as `forwardedProps.plurnk.workspace` on every run (also the AG-UI `threadId`); the module attaches it if it exists, creates it with exactly that name otherwise — no prefixes, no forging. **With NO workspace, the DAEMON mints a fresh, uniquely-named workspace** (a no-name `workspace.create`, created WITH the invocation's options so creation is atomic with the project root) and the client binds to the returned name. A literal client label (`tui`/`cli`) is NEVER a workspace name — that would collide every unnamed launch into one shared world. The workspace is required wire-side: a worker without one is rejected 500, and the client never relies on a module fallback.

**Creation is ATOMIC with the projectRoot.** The client sends its workspace options (projectRoot/settings) on EVERY request, so whichever request causes creation creates the workspace fully formed — there is no window where a workspace exists undressed. A workspace created without a root is headless on purpose and stays headless forever: changing a project root is unimplemented by design (the root is the world's ground).

- **`--worker <name>` names the CONVERSATION**: with a prompt, the worker name becomes the `threadId` — an existing run (a fork, a prior conversation) is bound by name; a new name mints a fresh conversation run over the same world. Without `--worker`, thread == world and conversations bind the workspace's model run (the default conversation). For read subcommands, `--worker` resolves via `workspace.workers` and an unknown name fails hard — no silent fallback to the model run.
- **`--worker` set without `--workspace`** → usage error (exit 64) for the one-shot, TUI, and state-command surfaces. Web mode may retain the Worker constraint while each browser route selects or creates its workspace first; the Worker never exists outside that resolved world.

CLI flag takes precedence over env when both are set.

### §1.2 Model selection {§cli-model-selection}

The worker owns its model route ({§worker-model-selection}); the client persists deliberate selections server-side and never reasserts model policy on an individual loop. One selector accepts either a daemon-declared alias or an exact `provider/model` route. Alias selection preserves its alias-scoped configuration and provenance; exact selection uses provider-wide configuration without inventing an alias.

Resolution at the client:

- `--model <selector>` set → one `worker.model.set` before the first loop of this invocation, then no per-loop selector.
- `--model` unset → send nothing; the worker's durable route (or the daemon's `PLURNK_MODEL` default when the worker is first created) runs.

An explicit model or reasoning selection is invocation admission: rejection fails
before the CLI sends a prompt or the TUI accepts input. The client never continues
under the worker's previous policy.

The daemon alone owns provider configuration, credentials, alias declarations, and its `PLURNK_MODEL` seed. A client connected to a local or remote daemon has the same contract.

The TUI's `/model` verb reads and writes `worker.model.set`/`worker.model.get`; the header displays the resolved durable route. `providers.list` remains the small declared-alias directory used for bare-fragment completion; a `/model` or `/child` fragment holding a provider prefix (`openai/…`) completes lazily from one bounded provider-scoped `models.list` page, cached per provider for the session — the client never preloads or owns the catalog. `/models [search]` and `plurnk models` lazily query `models.list`; no model catalog is fetched at startup or injected into a model packet.

### §1.2.1 Worker status {§cli-worker-status}

Human status is the summary line's shape aggregated over the session:

```
<glyph>  · <N> turns · <wall> · ↓<input> ↑<output> · $<usd> · 🎲 <model> [· 🐜<children> [<child>]] · <workspace> · worker://<name>/ [(<i>/<n>)] [· 🧮 <percent>%]
```

The glyph is two columns wide, so two spaces separate it from the first dot. Token counts are
abbreviated (`582k`, `1.2M`; below a thousand the number itself) and spend is stated to the
hundredth of a cent with grouped thousands (`$3,333.3333`).

```
```

{§cli-status-children} The ant is the daemon's count of the bound worker's alive
direct children (`snapshot.plurnk.status.children`: queued, running, or parked —
a parked child still owes a result), followed by the child model while a spawn
override is set: `🐜0`, `🐜2 dumbox`. A transport without the gauge shows only
the bare `🐜 <child>` as before. The count is never derived from the directory;
the user hops to a child (§3.1.2) rather than watching it. `(<i>/<n>)` after the
worker is its sibling position, newest first, present only with siblings.

Turns and wall time include the running loop — its packet count from the
authoritative AG-UI `STATE_SNAPSHOT`/`STATE_DELTA` gauge and its elapsed time
from the local clock, ticking once a second; token and cost totals combine concluded
loops with settled `engine:turn` accounting from the current observed run. Every
completion beat refreshes them. The terminal loop aggregate replaces, rather than
adds to, that run's accrual. Unknown usage remains unknown. The turns/wall group appears once a loop has
run, tokens once accounting exists, cost when nonzero, the child model while a spawn override is set (§1.2.2), the
worker once the conversation worker is known (the terminated outcome names it). The client does
not infer provider packets from operation rows or turn coordinates.
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

### §1.2.3 Reasoning policy {§cli-reasoning-policy}

Reasoning is a separate durable worker policy owned and validated by the daemon.
`/reasoning` and `plurnk reasoning --workspace <name>` inspect the effective
policy and daemon-supported choices; supplying a policy to either form persists
it. `--reasoning <policy>` performs that same action after an explicit model
selection and before the invocation's first loop. The client forwards the value
without maintaining a provider capability catalog, uses `supportedPolicies` for
completion, and never encodes policy in an alias or loop request. Reattachment
reads the durable value; descendants follow the daemon's snapshot inheritance.

#### Effort in the identity {§cli-identity-effort}

Effort is identity-grade. Wherever the client names a route (status line, model
and child labels, loop headers) one formatter renders the daemon's durable policy
with the identity, and the daemon's stated provenance decides the marker:
`deepdumb[low]` is a chosen level (`worker.reasoning.set`), `deepdumb(low)` a
provider default the daemon seeded from the alias; brackets read as chosen,
parentheses as given. A route without an effort dimension renders bare, and a
daemon that states no source renders brackets as before. `/reasoning` says the
same in words. The client never infers provenance (plurnk#41 ask 2,
plurnk-service#528).

### §1.3 Project root {§cli-project-root}

**Project root** is the absolute path the daemon's `file://` scheme uses as the workspace boundary for that workspace. NULL = headless (file ops 400 with "workspace has no project_root").

Client behavior:

- Default: `process.cwd()` — the user's current directory.
- Override: `--project-root <abs-path>` or `PLURNK_CLIENT_PROJECT_ROOT`.
- Explicit headless: set to empty string (`--project-root=`) → wire as `null`.
- Accompanies every attach-or-create request so whichever request wins can create the workspace atomically. An existing workspace preserves its stored root; the value never rewrites it.

### §1.4 Workspace-open settings {§cli-workspace-open-settings}

These flags shape what the workspace sees; they map to workspace-open settings and are creation-time / workspace-level. File membership is not a flag: it is the `members` Functionality family (§3.7).

**Workspace-open settings** — sent as `settings` on `workspace.create`:

- `--files-items <n>` → `filesItems`. Controls the turn-0 tracked-file preview: `-1` full / `0` off / `N` first-N items. Must be `-1`, `0`, or a positive integer (else exit 64). Replaces the operator's `PLURNK_FILES_ITEMS` for the workspace.
- `--capabilities <json>` / `PLURNK_CLIENT_WORKSPACE_CAPABILITIES` → `capabilities`. The canonical CapabilityPolicy is a purely subtractive workspace ceiling. Executor plugin configuration remains service-owned and never becomes workspace settings.
- `--max-commands <n>` → `maxCommands`. Tightens the daemon ceiling and must be a positive integer.
- `--no-git` → `git: false`. It never re-enables git past a service-owned lockout.

Settings have **workspace-create-only effect** (no live setter), but accompany every attach-or-create request so a concurrent first request cannot create an undressed workspace. Existing workspaces retain their durable settings.

---

## §2 One-shot mode {§cli-one-shot-mode}

Triggered when a prompt is present from positionals, piped stdin, or both.

### §2.0 Prompt prefixes {§cli-prompt-prefixes}

The prompt's first character has the same meaning in the CLI and TUI. `plurnk "? question"` selects proposal `review` without changing workspace capabilities; `": text"` uses the base policy unchanged. `plurnk "! command"` execs via the daemon—op.exec, stream to conclusion, exec stdout→stdout / stderr→stderr, exit by `result.status` (0/3/4). Core has no named ask/act mode.

### §2.1 Output channels {§cli-output-channels}

Standard Unix discipline: **stdout is the program's product, stderr is its narration.** There are two OUTPUT MODES, selected by `--json` / `PLURNK_CLIENT_JSON` — not a flag on one output, but two distinct contracts:

**text mode (default):**
- **stdout** — successfully delivered, targetless model SEND bodies, verbatim in operation order and separated by a blank line (§5.4). A later failure or cancellation does not retract them. NOTE inventories and directed or failed messages do not appear on stdout.
- **stderr** — one mutable status row on a TTY, durable action trace lines
  (including intermediate broadcasts), diagnostics, and the terminal summary.
  Non-TTY stderr omits routine status/progress instead of accumulating heartbeat
  history. It still receives durable trace, diagnostics, and the summary.

**json mode (`--json` / `PLURNK_CLIENT_JSON`):**
- **stdout** - ONE complete document and nothing else (§5.5): the coherent record of the terminated worker loop - `schemaVersion`, authoritative `workerId` + `loopId`, `response` (the answer, top-level for `jq -r .response`), `finalStatus`, `turns: [{turn, ops: [{coord, op, origin, target, scope, status, signal, tags}]}]`, `notices`, `usage`, exit metadata. Each op preserves the daemon's line-marker `scope` as its ordered coordinate array and complete sorted durable log classifications in `tags`. `usage` is preserved verbatim from `CUSTOM plurnk.terminated`: ordered physical-request evidence and conventional aggregate token fields live under `usage.accounting`, whose `costUsd` is an exact decimal string or `null`; `curationWeight`/`curationBudget`, `contextTokens`/`contextCapacity`, and provider metadata remain sibling fields. Curation weight is never compared with physical provider tokens. The client does not project, sum, round, or settle accounting. `CUSTOM plurnk.terminated` supplies both owning coordinates; the client never combines a terminal loop with a worker inferred from ambient rows. Workspace-visible child/sibling rows may be rendered as topology, but they do not enter this record's `response` or `turns`. On failure it is `{"schemaVersion":6, "problem": ProblemDetails}` - valid JSON either way, paired with the exit code.
- **stderr** — silent.
- **NOT inlined:** op *content* (file bodies, exec output). Under co-location the consumer reads the file directly or fetches one op on demand with `plurnk read <coord> --json` (§7) — the same addressable, scoped log discipline the engine runs on. `--json` carries the record, not the content.

Consequence:

- `plurnk "X" > answer.txt` captures just the delivered response messages.
- `plurnk "X" 2>/dev/null` suppresses the trace.
- A TTY user sees both interleaved as before (the terminal merges streams).
- `plurnk "X" | tool` pipes only the answer.
- `plurnk --json "X" | jq -r .response` pulls the answer; `… | jq .turns` the structured trace. One document, no stderr archaeology — the CLI is the integration layer, no third-party client needed for basic needs.

### §2.2 Flow {§cli-one-shot-flow}

1. Read the conversation worker's durable model, then `POST /` (RunAgentInput) to the module — `threadId` = the workspace name, the prompt as the user message, workspace + per-run knobs on `forwardedProps.plurnk`.
2. Consume the SSE: `CUSTOM plurnk.row` events advance observed turn status and
   render as durable action trace lines on stderr; derivation Notices update the
   replaceable activity row without becoming trace history.
   Successful targetless model SEND bodies go to stdout (§5.4).
3. A proposal arrives as a `prop:*` tool call and terminates run A with a standard AG-UI interrupt outcome (the internal loop stays paused). Run B on the same thread returns the decision through `RunAgentInput.resume`, and the continued loop streams there. `CUSTOM plurnk.terminated` is authoritative for the internal outcome; a stream that dies without terminal truth is an error (502), never a fabricated success.
4. **text mode:** write summary lines to stderr (final status, turns/wall/tokens); stdout stays the pure answer. **json mode:** emit the one complete record document on stdout (§5.5); stderr stayed silent throughout. (The old greppable `result:` stderr envelope is retired — json mode is the machine path now.)
5. Exit with the appropriate code (§4).

### §2.3 What one-shot mode does NOT do {§cli-what-one-shot-mode-does-not-do}

- No interactive prompts during the loop (proposal review prompts are separate; see §6).
- No `op.parse` (raw DSL) — that's TUI-only.
- No reconnect on dropped connection. Connection drop = exit with error.

---

## §3 TUI mode {§cli-tui-mode}

Triggered when `argv` has no positional prompt.

### §3.1 Flow {§cli-tui-flow}

1. Bind a `BridgeTransport` to the module (§1.1 name-verbatim workspace on every run); its persistent handlers un-project `CUSTOM plurnk.*` events to the daemon shapes the waterfall renders.
2. Print the banner; start pi-tui's main-screen renderer with a multiline editor
   and §1.2.1's aggregate line on the place line above the composer. Before AG-UI
   state arrives, derivation, search, and
   branch activity share the fallback activity position. The
   lifecycle glyph is ⏳ while queued, `⌛︎` while running, 💤 while parked, `⏹️` when complete,
   and ❌ on failure; idle YOLO may use 🔥. The main-screen renderer preserves
   ordinary terminal scrollback rather than replacing it with an alternate screen.
3. Each line entered is dispatched:
    - Lines starting with `/` → command verbs: `/help /models [search] /workspaces /workers /log [n] /look <address> (§3.1.3) /model <selector> /child <selector|inherit> /reasoning [policy] /capabilities [json] /yolo /workspace [name] /worker [name] /attach <name> /parent /enter /older /newer /rename <name> /stop /quit`, plus `/import <path>` (§3.3) and the Functionality families `/mcp` (§3.4), `/skills` (§3.5), `/agents` (§3.6), and `/members` (§3.7). Singular verbs CREATE, plural verbs LIST: `/workspace [name]` opens a fresh workspace (rebinds the AG-UI thread in place), `/workspaces` lists; `/worker [name]` forks a new worker (`run.fork`), `/attach <name>` binds this session to a worker by name, `/workers` lists the directory as a topology rooted at the bound worker (both §3.1.2); `/rename <name>` retargets the workspace's mutable handle (a worker's name is immutable). `/capabilities` reads or replaces the workspace's durable CapabilityPolicy. Verbs never call `loop.run`; inspect verbs reuse the §7 subcommand tables; `/stop` and `/help` stay reachable while a loop is in flight. Editor completion covers verbs, declared aliases, daemon-supported reasoning policies, worker names after `/attach` (the directory plus the `worker://<name>` references the waterfall has shown, §3.1.2), **file paths** (after `/import`/`/script`, the `/members discover` and `/members add <alias>` positions, the MCP options-file position, and bare `@file` tokens), **executable fence names** (READ, NOTE, and the other native OPs), and PLURNK target paths.
    - Named executable backtick fences → `op.parse`; a LOOK fence is inspection (§3.1.3), never a run. Native OPs and executor/MCP names share this entry point; the daemon owns parsing, resolution, and diagnostics. Prefix `: ` to force prompt treatment for a literal fenced example.
    - Lines starting with `!` → the `op.exec` action. Daemon-owned shell; proposal-gated like any side effect.
    - Lines starting with `? ` → a conversation run whose loop policy selects proposal review. `: ` uses the configured ordinary loop policy. Both are client projections of the generic contract.
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

| Group | Verbs |
|---|---|
| Inspect | `/help /models /workspaces /workers /log` |
| Policy | `/model /child /reasoning /yolo` |
| Workspace | `/workspace /rename /worker /attach /parent /enter /older /newer` |
| Functionality | `/mcp /skills /agents /members` |
| Compose | `/import /script /editor` |
| Review | `/accept /reject /cancel /edit` |
| Session | `/stop /quit` |

Completion remains demand-driven. The client offers local syntax and known
model aliases without I/O; provider-qualified models use one bounded provider
page; MCP, Skill, and A2A aliases call only that Functionality family's list
action after the cursor reaches an alias-taking position. A failed lazy lookup
produces no completion and never changes the editor value.

### §3.1.2 Worker topology and attach {§cli-workers-topology}
One AG-UI stream binds one conversation worker. Descendants of that worker reach
a client only through the daemon's correlated projection (plurnk-service#440, the
lane presentation of #38), never by inference; unrelated workspace workers never
render inside a session. Navigation between workers is explicit.
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

**Position.** The line above the composer names the place, `[<workspace>/<lineage>(<loop>/<turn>)]`:
the lineage from the tree root to the bound worker with `~` marking the worker the session
is in — the same `~` that means "this worker" in `worker://~/` — and the loop and turn beside
the worker they belong to. `[w/~main(3/12)]` at a root, `[w/main/fork-1/~recheck(1/0)]` two
hops down, `[/~]` before the worker is named; an unknown loop or turn is elided. A child
always shows that it is a child, so a session opened on a child reads its full lineage. The
§1.2.1 status line follows the place on the same line, so the composer has one line above it
and the transcript keeps the line a separate status row used to take. The status line's
worker segment carries the sibling position when there is one: `worker://recheck/ (2/3)`,
newest first (§1.2.1).

### §3.1.3 Inspection {§cli-inspection}

`/look <address> [<scope>] [pattern]` reads a resource for the human, never for the model.
The client composes the LOOK fence and submits it through the `op.look` observation
action, which resolves it as the bound conversation (`log:///`, `reasoning:///`, and
`ops:///` as the model sees them) and writes no log entry. A typed ```````LOOK (…)```````
fence takes the same path. The readout is a local human record printed above the
composer: the heading as submitted, then the content verbatim; an empty result says so in
the daemon's words; an unsuccessful one names the Problem title, with its detail and
recovery beneath. Inspection touches no loop lifecycle, summary, or tally, and stays
available while a loop runs. Alt-p and Alt-n cycle the real targets of the bound
conversation's prior operations into an empty composer as `/look <target>`, an editable
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
| `?`, or `:` removing an active `?` request | Explain that the requested policy belongs to a new loop; do not silently strip it and inject |
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
uses {§agui-conversation-sync} and restores unseen durable rows with bounded
`log.read`, retaining its pre-attachment conversation-row cursor; independent
client-operation rows cannot advance that cursor. A successful observation without a
new `plurnk.terminated` event adds no synthetic loop summary, usage, or tally.
Malformed or incomplete history fails visibly rather than claiming lossless recovery.

During a question, recognized slash commands retain their normal meaning;
`/cancel` dismisses the question. Other input answers the current field. A literal
command can be entered with a leading backslash. Command completion or
failure never consumes the question's answer slot.

### §3.2 Cancellation {§cli-cancellation}

`/editor` (Alt-e) composes the current multiline value in `$VISUAL`/`$EDITOR`
(fallback `vi`): the value seeds a tmpfile buffer and the editor's result is
placed back in the composer, never auto-submitted. Enter remains the only submit
gesture. An empty buffer leaves the value unchanged. pi-tui relinquishes and
reclaims terminal custody for the bounded editor process.

`Esc` is the same interrupt in its modern agent-CLI spelling: while a dispatch
is in flight it fires `loop.cancel` (reason `user_escape`) through the identical
cancel path, and while idle it clears the composed value; Esc never exits.
pi-tui owns escape-sequence reassembly and keyboard-protocol negotiation.

`Ctrl-C` during an in-flight dispatch fires the `loop.cancel` action — the daemon aborts the model run's active drain, the pending loop resolves with `finalStatus: 499`, and the editor continues. A failed cancel SURFACES on the terminal. A second `Ctrl-C` (or `Ctrl-C` while idle) exits — the escape hatch for dispatches a drain-cancel cannot unblock (`op.parse`). (Dropping a conversation run's SSE also aborts its loop — hangup is the abort; `loop.cancel` is the addressable spelling.)

CLI mode mirrors this: first `Ctrl-C` cancels (the loop resolves 499 → exit 3 per §4); second `Ctrl-C` force-exits 3.

### §3.3 `/import` and bracketed paste {§cli-import-and-bracketed-paste}

`/import <path>` reads a **local** file (co-location law — the client reads its own fs, the daemon never sees the path) and inserts its content at the editor cursor. Relative paths resolve against cwd; an unreadable file prints an error and is a no-op.

**Bracketed paste.** A multiline paste is one editable value and therefore one
submission, never one `loop.run` per line. pi-tui owns bracketed-paste framing;
small pastes remain native lines and large pastes become one expandable marker.

### §3.4 Workspace MCP controls {§cli-workspace-mcp-controls}

MCP management is a thin projection of the daemon's workspace actions. The
client tokenizes quoted alias/target arguments and JSON-decodes an optional
local options file, but the daemon owns normalization, schema validation,
connection behavior, persistence, and exact Problem Details. Symbolic
credential references remain unchanged. After resolving the ordinary client
environment cascade, the client projects string-valued `PLURNK_MCP_*`
declarations as one raw `McpConfigurationOverlay`; it excludes
`PLURNK_MCP_ENABLED`, `PLURNK_MCP_CONNECT_TIMEOUT`, and
`PLURNK_MCP_REQUEST_TIMEOUT`, and interprets no server, transport, companion,
or credential semantics. Merely listing configuration never activates or
persists a server.

The interactive and positional forms share one tokenizer-independent command
handler. `plurnk mcp …` requires `--workspace` or
`PLURNK_CLIENT_WORKSPACE`; `--json` emits the unmodified successful action
result.

| TUI / CLI input | AG-UI+ action |
|---|---|
| `/mcp` / `plurnk mcp` | `workspace.mcp.list {}`, then `workspace.mcp.discover {configuration}` when the client holds `PLURNK_MCP_*` declarations |
| `/mcp discover <url\|command>` | `workspace.mcp.discover {source}` |
| `/mcp add <alias> <target> [options.json]` | `workspace.mcp.add {alias, definition}` — the client composes the exact `McpServerDefinition`: `name = alias`; an absolute `http(s)://` target is `{transport: "http", url}`, anything else `{transport: "stdio", command, args: []}`; `options.json` supplies the remaining definition members |
| `/mcp enable <alias>` | `workspace.mcp.enable {alias}` for an available definition; `workspace.mcp.add {alias, definition}` when `alias` is a candidate of the client's own configuration |
| `/mcp enable <alias> options.json` | `workspace.mcp.add {alias, definition}` with the alias's current (listed or discovered) definition specialized by `options.json` |
| `/mcp disable <alias>` | `workspace.mcp.disable {alias}` |
| `/mcp remove <alias>` | `workspace.mcp.remove {alias}` |
| `/mcp oauth <alias> <callback-url>` | `workspace.mcp.oauth.complete {alias, callbackUrl}` |

Every slash-command row also admits the same arguments after `plurnk mcp`.

An add or enable requiring interactive authorization prints the
authorization URL and exact `/mcp oauth …` completion command. Invalid or
unreadable local JSON fails before dispatch; daemon Problems—including an
unsupported MCP protocol revision—cross the existing diagnostic path without
rewriting or retry.

### §3.5 Universal Agent Skills {§cli-universal-agent-skills}

Agent Skills management is a thin projection of the daemon's `skills`
Functionality family — the same common lifecycle as `/mcp`. The client
composes one exact `SkillDefinition` and renders the daemon's states; it
runs no package manager, reads no registry, parses no frontmatter, and keeps
no parallel package metadata. The standard universal roots
(`.agents/skills` in the project, `~/.agents/skills` globally) stay
interoperable with every other agent; a skill installed there by any other
tool is admitted by the daemon at the next turn.

| TUI input | AG-UI+ action |
|---|---|
| `/skills` | `workspace.skills.list {}` |
| `/skills discover <query>` | `workspace.skills.discover {query}` — registry search |
| `/skills discover <source>` | `workspace.skills.discover {source}` — a single term holding `/`, `:`, or `\\`, or starting with `.` or `~`, is a package reference |
| `/skills add <name> <source> [--global]` | `workspace.skills.add {alias, definition: {name, scope, source}}` with `scope` `project` unless `--global` |
| `/skills enable <name>` | `workspace.skills.enable {alias}` |
| `/skills disable <name>` | `workspace.skills.disable {alias}` |
| `/skills remove <name>` | `workspace.skills.remove {alias}` |

Daemon Problems — an uninstallable source, a missing project root, a
service-owned skill that cannot be removed — cross the existing diagnostic
path without rewriting or retry.

### §3.6 Outbound A2A agents {§cli-outbound-agents}

Outbound A2A agents are a thin projection of the daemon's `agents`
Functionality family — the same common lifecycle as `/mcp` and `/skills`. The
client composes one exact `A2aAgentDefinition` and renders the daemon's
states; the remote Agent Card, connection, and enablement policy live in the
service, and the model addresses an enabled agent as `a2a://<alias>`.

| TUI input | AG-UI+ action |
|---|---|
| `/agents` | `workspace.agents.list {}` |
| `/agents discover <url>` | `workspace.agents.discover {source}` — one inert card-derived candidate |
| `/agents add <alias> <url> [options.json]` | `workspace.agents.add {alias, definition: {name: alias, url, ...options}}`; `options.json` supplies `cardPath`, `headers`, `authorization` |
| `/agents enable <alias>` | `workspace.agents.enable {alias}` |
| `/agents disable <alias>` | `workspace.agents.disable {alias}` |
| `/agents remove <alias>` | `workspace.agents.remove {alias}` |

Invalid or unreadable local JSON fails before dispatch; daemon Problems — an
unreachable card, an unsupported interface, an unresolved symbolic credential —
cross the existing diagnostic path without rewriting or retry.

### §3.7 File members {§cli-file-members}

File membership is a thin projection of the daemon's `members` Functionality
family — the same common lifecycle as `/mcp`, `/skills`, and `/agents`. The
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
family — the same common lifecycle as `/mcp`, `/skills`, `/agents`, and
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
Functionality family — the same common lifecycle as `/mcp` and `/agents`. The
client composes one exact definition (`rule`, `target`, `prompt`, optional
`policy`) and renders the daemon's states; the clock, the rule's canonical
form, the timers and the delivery live in the service, and an occurrence
reaches its worker as an ordinary message from `schedule://<alias>`.

| TUI input | AG-UI+ action |
|---|---|
| `/schedule` | `workspace.schedule.list {}` — each rule with its state, wording, next occurrence or `exhausted`, and target |
| `/schedule discover <rule>` | `workspace.schedule.discover {source}` — one inert candidate whose summary opens with the current time in the effective zone |
| `/schedule add [--accept] <alias> <worker> <rule> <prompt...>` | `workspace.schedule.add {alias, definition: {rule, target: worker://<worker>, prompt, policy?}}`; `--accept` sets `policy.proposals` to `accept` |
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
| `2` | Loop hit `maxTurns` safety cap (`hitMaxTurns === true`) |
| `3` | Loop terminated with cancellation (`finalStatus === 499`, including `--timeout`) |
| `4` | Loop FAILED (4xx/5xx terminal status other than 499) — failure ≠ cancel, so benchmark stats stay honest |
| `64` | Usage error (missing required env var, unrecognized flag) |

TUI mode always exits `0` on clean shutdown; loop outcomes are surfaced in the summary line, not the exit code.

---

## §5 Rendering {§cli-rendering}

### §5.1 `log/entry` line format {§cli-log-entry-line-format}

One row per dispatched op, except delivered message blocks (§5.4).
A row is the operation as written, literal text with the client's own styling and never a
Markdown pass:

```
<OP> (<target>) [<scope>] [<pattern>] [{<n>}] [<aside>] [— <problem title>]
```

- `OP` is the operation's name, bold: green when the outcome succeeded, pink otherwise. An
  execution row is named by its runtime (`sh`, `python`): the row's `op` is the fence name as written, never a generic keyword.
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
- An unsuccessful outcome (`status_rx >= 400`) names the structured result's own `problem.title`
  (else its `detail`, else the bare status) at the right of the row. A 204 is not a failure: a
  FIND counts `{0}`; a glob READ that matched no path carries the daemon's detail instead of a count.
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

**Exceptions:** targetless SEND and native dispositions render as blocks per §5.4 and §5.1.2. The TUI moves each submitted editor value into ordinary terminal scrollback; its inbound SEND echo is not rendered again (`isOwnArrival`). Arrivals from other actors remain visible with their causal source.

#### §5.1.0 Markdown projection {§cli-markdown-projection}

A prettified SEND body (TUI only; the one-shot CLI keeps raw verbatim for
pipes) delegates GFM parsing and terminal layout to maintained renderers at
the current terminal width, less the SEND-body indent. Tables use
aligned box-drawn columns, wrap complete cell content, and separate every
logical row; headings, inline markup, lists, and links retain conventional
terminal presentation, while ordinary fenced code begins with a `💻 language`
header. A ```mermaid fence projects as
a topology- and label-preserving Unicode diagram when it fits the same live
viewport. Preserve the authored layout when it fits; otherwise try one alternate
flowchart layout exchanging horizontal and vertical directions, including explicit
subgraph directions. Invalid, unsupported,
or still-overwide diagrams fall back to labeled verbatim source with the
reason, never a half-drawn diagram. The wire always carries semantic source;
no pre-rendered channel exists at the protocol boundary.

#### §5.1.0a Local rendering filter {§cli-render-filter}

`plurnk render --width <columns>` is the renderer's daemon-free Unix filter:
it reads semantic Markdown from stdin and writes one width-bounded plain-Unicode
projection to stdout. It performs no configuration loading, model work, network
activity, startup narration, or ANSI styling. Other clients may discover this
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

| Operation | Waterfall projection |
|---|---|
| NOTE | Ordinary operation heading and aside; working-memory body available through LOOK. |
| WAIT | Ordinary heading, aside and any receipt detail; never assistant speech. |
| DONE / FAIL with a delivered body | Message block per §5.4, with any deferral detail. |
| Blank or undelivered DONE / FAIL | Operation heading and actual receipt detail or Problem. |

Loop state comes from the daemon's status events, not an inference from a verb or body.

### §5.2 Summary line (per `loop.run`) {§cli-summary-line-per-looprun}

```
  <tag> · <N> turns · <wall>ms · ↓<input> ↑<output> [· cur <percent>/<budget>] [· ctx <percent>/<capacity>] [· loop $<usd to the hundredth of a cent>]
```

`tag` derives from the exact terminal `OperationResult`. A 500 is `strike-out` only for `engine/rails/strike-threshold`; exhausted invalid emission is `invalid emission`, and another 500 is `failed`.
Input and output are the conventional aggregate fields from the daemon's accounting envelope. Missing token quantities render as `?`; exact zero cost is omitted; a nonzero exact decimal is rendered without floating-point conversion; and a physical request with incomplete monetary evidence renders `$unknown`.

### §5.3 What is NOT rendered {§cli-what-is-not-rendered}

- The full packet (`turn.packet`). The client never displays the rendered index or model-facing log sections.
- Raw bodies for non-broadcast ops: command snippets, JSON arguments, edit replacements, notes, and result previews. Message bodies render per §5.4; other op bodies surface only via `entry.read` or a READ fence targeting `log://...`.
- Raw SSE frames. Set `DEBUG=plurnk:agui` (future) to enable.
- Stream telemetry. A `stream/event` (start, growth, per-channel close) writes nothing to the waterfall, and the TUI fetches no channel content for a model's execution. An execution appears once, when its outcome is known: the conclusion renders the launching fence's row (§5.1), green for exit 0 and pink otherwise with the result's Problem title or the daemon's summary as its outcome. A stream whose launch is unknown renders as its scheme and address in the same grammar. Wake bookkeeping is never a row. Activity while a stream runs belongs to the status line. One bounded exception stays for the human's own command: a client-typed `!` execution makes one `entry.read` on conclusion and inlines a channel's content only when it is ≤160 chars and ≤2 lines (stderr marked `!`), because the human asked for that output. The one-shot CLI keeps the same exception for every tiny concluded output. See §8.7.

### §5.4 Messages and dispositions {§cli-broadcast-send-rendering}

A targetless SEND or a delivered DONE/FAIL body carries message content. Both scheme and pathname must be absent. The interactive client renders full message bodies, not diagnostic previews.

TUI mode contract:

- Lead line: no keyword. A blank line stands where `SEND` was; a failed message puts its Problem title there in pink; the sanitized aside follows. The body's lines stay at column zero. No glyph, no numeric code, no path.
- Body: a short single-line body inlines after one space when it fits the live viewport; otherwise the body starts on the next line, each line prefixed with three spaces, no ellipsis and no dim.
- No synthetic surrounding blank rows.
- Empty SEND content is legal and renders as just the lead line. Blank lifecycle operations follow §5.1.2.

Delivered targetless model responses are bold so messages stand out from
operation records; failed, directed, inherited, and non-model messages remain plain. Inner ANSI
resets re-arm bold across Markdown spans. `NO_COLOR` removes the emphasis while
preserving layout. CLI mode is unaffected — stdout/stderr stay plain per §2.

CLI/one-shot mode: trace entries use stderr per §5.1; delivered response messages use stdout (§2).

The message body source is `entry.tx.body`: SEND uses `{ raw, json }`; DONE/FAIL use literal text.

Successful (`200 ≤ status_rx < 300`) targetless model SEND rows contribute to the response.
DONE/FAIL require a nonempty body and a receipt `recipients` array proving delivery,
independently of lifecycle settlement: deferred completion and declared failure can
both deliver speech. Source and inherited rows cannot deliver the same message again.
Bodies accumulate in delivery order, separated by a blank line. NOTE and WAIT are not speech.

**CLI default** emits each qualifying body verbatim, without Markdown or
JSON transformation. **CLI `--json`** includes the aggregated `response` in the
single complete run record defined in §2.1, not a second body-only output format.

**TUI mode** (no `--json`; the flag is CLI-only) renders every targetless SEND as a block, dispatching by content type:

- **JSON** — `tx.body.json !== null`. Render `JSON.stringify(json, null, 2)`.
- **Markdown** — `raw` matches structural markdown markers (heading `# `, bold `**…**`, list `- `, fenced code ` ``` `, or `[text](url)` link). Minimal vanilla-ANSI transform: bold, italic, dim inline code, `• ` bullets, header text bolded. Rich-client prose also normalizes the common inline token `$\rightarrow$` to `→`; this is not general LaTeX support. CLI output remains verbatim.
- **Plain (or anything else)** — emit the rich-client prose after the exact normalization above.

If `tx.body` is null, or `tx.body.raw` is absent or non-string, the body is treated as empty (stdout receives nothing for that broadcast).

---

## §6 Proposal review {§cli-proposal-review}

Side-effecting operations (file writes, exec) emit a `plurnk.proposal` event when the daemon pauses dispatch awaiting human resolution. The client presents the proposal and resumes the run with the selected decision.

### §6.1 Notification shape {§cli-notification-shape}

```ts
loop/proposal {
    logEntryId: number,           // pending log_entries row
    loopId, turnId: number,
    op: "EDIT" | <runtime tag> | ...,
    target: { scheme: string | null, pathname: string | null },
    body: string,                 // udiff for EDIT; command summary for an execution
    attrs: object,                // scheme-specific payload (opaque to client)
    policy: LoopPolicy,           // loop's immutable proposal disposition
}
```

AG-UI emits this client surface only for proposals whose durable disposition owner is the client. Loop-owned `accept` and `reject` dispositions settle in Core and never become client review work. The client does not infer ownership from policy fields.

### §6.2 Review menu (interactive) {§cli-review-menu-interactive}

When a proposal arrives, a TTY is present, and yolo is off (or the prompt asked for review with `?`), the client renders the proposal to stderr and prompts:

```
── proposal EDIT file:///path/to/file ──
<colored udiff>
[a]ccept · [e]dit · [r]eject · [c]ancel
```

Single-keypress menu (raw stdin):

| Key | Action |
|---|---|
| `a` | `loop.resolve({decision: "accept"})` — apply body as-is. |
| `e` | Spawn `$VISUAL` / `$EDITOR` / `vi` on a tmpfile holding `body`. On save: `loop.resolve({decision: "accept", body: <edited>})`. Empty buffer ⇒ `cancel` with outcome `"empty_editor_buffer"` (git-commit convention). |
| `r` | `loop.resolve({decision: "reject"})`. |
| `c` | `loop.resolve({decision: "cancel"})`. |
| any other | `cancel` with outcome `"unknown_key"`. Safe default; includes ctrl-c. |

Udiff coloring for EDIT bodies: `+` lines green, `-` lines red, `@@` hunks cyan, headers (`+++`/`---`) bold. Execution bodies render plain.

### §6.3 `--yolo` / `PLURNK_CLIENT_YOLO` {§cli-yolo-plurnkyolo}

Client-side, and on by default: the packaged defaults ship `PLURNK_CLIENT_YOLO=1`; `0` or `/yolo` turns it off. When on, the proposal handler skips the menu and immediately sends `loop.resolve({decision: "accept", outcome: "client_yolo"})`. The proposal notification still goes over the wire (the daemon is unaware that the client auto-accepted). A prompt that starts with `?` asks for review of that run: its proposals take the menu even while yolo is on.

This is distinct from **loop auto** (`--auto`, or a policy with `proposals:"accept"`), where proposal authority never crosses into client review.

### §6.4 Fail-closed (non-TTY, no yolo) {§cli-fail-closed-no-review-channel}

When stdin is not a TTY and yolo is off, the client cannot interactively review. If the selected policy requests `review`, the client projects `proposals:"reject"`; Core settles admitted side effects without a client round-trip. An explicitly selected `accept` or `reject` disposition remains authoritative.

The one-shot client cancels input-request interrupts through the standard AG-UI resume contract because it has no interactive form. It does not alter workspace capabilities or invent an answer; the worker receives the cancellation and can continue.

Use cases this protects: `plurnk "X" > answer.txt`, `plurnk "X" | tool`, scripted invocations with `PLURNK_CLIENT_YOLO=0`.

### §6.5 Questions {§cli-question-forms}

AG-UI `request_user_input` interrupts present the message and the exact response
contract. Independent, directly typed fields are collected individually; each
shows its type, required/optional status, and description. Optional fields may
be skipped with Enter. String enums offer numbered choices or a listed value;
unrestricted strings accept free text. Non-string values use JSON notation.
Complex schemas (including composed or referenced schemas and nested forms)
are shown whole and accept one JSON response object, without detaching schema
fragments from their reference or cross-field context. The contracts-owned JSON
Schema validator checks answers before submission. Invalid input remains
editable without advancing or losing earlier field answers. Empty forms
explicitly submit an empty object. Completed forms resume with the exact response-schema object;
`/cancel` sends a cancelled resolution. `/stop`, `/quit`, and `/help` remain
available. Resolution failures are visible, never swallowed. `--yolo` does not
invent answers. The originating tool constructs its own result envelope. A stale
interaction identity cannot answer a subsequent interrupt.

### §6.6 Proposal-review boundaries {§cli-proposal-review-boundaries}

- Concurrent proposals. The daemon pauses one dispatch per proposal; at most one proposal is pending per loop at any time. Client handles them sequentially as they arrive.
- Patch validation. The client does not parse the udiff. `body` is treated as opaque text for display and (when edited) re-submission.
- Persisting decisions. Each proposal is reviewed in isolation; no "always accept this scheme" memory.

---

## §7 Subcommands {§cli-subcommands}

Daemon subcommands inspect or deliberately configure state without running a
loop. They share the same connection and workspace-resolution machinery as the
prompt-driven flow, but skip `loop.run` entirely. They support `--json` for
machine-readable output (stdout product per §2.1; trace and errors stay on
stderr). `reasoning [policy]` reads or changes the durable reasoning policy.
`capabilities [json]` projects every durable capability layer and its effective
intersection, or replaces the workspace policy. Prompt runs only carry proposal
policy. Local `render` and launcher `web` subcommands do not contact the daemon.

When `argv[0]` (after flag parsing) matches a known subcommand verb, the dispatcher routes there instead of assembling a prompt. Unknown subcommands exit `64`.

### §7.1 `plurnk models` {§cli-plurnk-models}

Queries one bounded page from the daemon's release-pinned catalog through `models.list`. No workspace is attached and no provider request is made. Positional words form a case-insensitive search; `--provider <name>` narrows the provider, `--all` includes models missing local configuration, and `--offset`/`--limit` page without loading the full catalog.

Default output is a column-aligned table of `selector / name / context / efforts / readiness`, where `efforts` {§cli-models-efforts} lists the daemon's admitted reasoning policies for the exact route (`capabilities.reasoningPolicies`, plurnk-service#529) or `-` for a model without an effort dimension, plus a continuation offset when another page exists. The default availability is configured-and-ready exact routes; `--all` rows explain missing credential or configuration alternatives. With `--json`, the client emits the complete page unchanged so `offset`, `total`, and `nextOffset` survive.

### §7.2 `plurnk workspace list` {§cli-plurnk-workspace-list}

Lists workspaces on the daemon via `workspace.list`. No prior attach required.

Default output: a column-aligned table of `name / project_root / created`. Null `project_root` renders as `(headless)`. Physical provider-request accounting is not denormalized into this directory view.

With `--json`: emits `workspaces` array verbatim.

### §7.3 `plurnk workspace workers <name>` {§cli-plurnk-workspace-workers-name}

Lists workers within a named workspace via `workspace.workers`. Resolves `<name>` to a workspace id via a `workspace.list` filter; no attach required. Exits `1` if the name is unknown or ambiguous.

Default output: a column-aligned table of `name / created`. With `--json`: emits `workers` array verbatim. Physical provider-request accounting is not denormalized into this directory view.

Typical use: discover a worker name to pass as `--worker` on `plurnk log read`.

### §7.4 `plurnk log read` {§cli-plurnk-log-read}

Reads log entries from an attached workspace's run via `log.read`. **Requires `--workspace <name>`** (exit `64` if unset) — the log is a per-run artifact and the client must know which to read. `--worker <name>` selects a specific run within the workspace (defaults to a fresh auto-named run on attach, which is usually not what you want — pass `--worker` when reading historic logs).

Filter flags (all numeric, all optional):

| Flag | Maps to | Meaning |
|---|---|---|
| `--loop <id>` | `loopId` | Limit to one loop |
| `--turn <id>` | `turnId` | Limit to one turn |
| `--since <id>` | `sinceId` | Entries with id > sinceId (incremental fetch) |
| `--limit <n>` | `limit` | Cap entries (daemon default 100, max 1000) |

Default output: one trace line per entry, same format as CLI-mode trace (`[<status>] <origin> <op>[<sub>] <path> <scope>`). The scope is omitted when the operation has no line marker. With `--json`: emits `entries` array verbatim.

### §7.5 `plurnk reasoning [policy]` {§cli-plurnk-reasoning}

Requires `--workspace`; `--worker` selects a named conversation. With no
policy, calls `worker.reasoning.get`. With one policy, calls
`worker.reasoning.set`. Text mode prints the effective policy and supported
choices; JSON mode emits the daemon result unchanged.

### §7.6 `plurnk web [options...]` {§cli-web-launcher}

Uses the canonical client invocation path to resolve the environment cascade,
then loads the separately installed `@plurnk/plurnk-web` module in-process.
There is one configuration owner and one interpretation of every shared knob:

| Resolved client surface | Browser projection |
|---|---|
| daemon address and bearer | Portal-only AG-UI target; neither value enters browser bootstrap |
| `--host`, `--port` | Loopback portal listener |
| workspace and Worker | Optional URL-coordinate constraints |
| project root, files preview, command ceiling, git policy, workspace capabilities | Create-time properties accompanying every selected workspace |
| explicit model and reasoning | Durable Worker actions before that session's first prompt |
| LoopPolicy and `--auto` | Base policy on every prompt Run |
| `?` prompt prefix | Per-prompt proposal review, using the same projector as CLI/TUI |
| prompt `@path` references | Per-prompt `openPaths` turn-0 projection |
| `--max-turns` | Per-prompt daemon turn ceiling |
| `--timeout` | Portal-owned deadline followed by `loop.cancel {reason:"client_timeout"}` for the exact workspace/Worker |
| `--yolo` | Automatic acceptance of client-owned proposals; interactions remain user-owned |
| client `PLURNK_MCP_*` declarations | Host-side discovery overlay for the browser's ordinary `workspace.mcp.*` management actions; never bootstrap data |

Terminal output controls (`--json`, `--width`) and state-subcommand filters do
not project into browser behavior. The web package parses no second environment
cascade and receives no provider credential or daemon environment.

Every ready browser URL is `/<workspace>/<threadId>`. Without configured route
constraints, browser tabs may create or select many workspaces and many Workers.
A configured workspace fixes the first coordinate; a configured Worker fixes
the second; missing unconstrained coordinates are generated before the page is
served. Opening the same complete URL observes the same durable Worker.

Create-time workspace options accompany every browser-selected world and every
Run, preserving atomic creation. The client applies explicit model then
reasoning selections once to each Worker first selected during this portal
process; it does not turn them into per-loop policy. `--yolo` remains
client-side proposal behavior: the browser auto-resolves proposal interrupts
while interaction requests still require user input.

The MCP manager is lazy: opening it lists the Worker's durable MCP state and
discovers client-configured candidates through AG-UI. Discovery remains inert;
adding, enabling, disabling, and removing use the daemon-owned Functionality
lifecycle. The portal inserts the client-held configuration only into an
unscoped MCP discovery action, so raw declarations are neither serialized at
startup nor made into a browser-side configuration authority.

The launcher never downloads code or starts the daemon. If the optional module
is absent, it exits 127 and names the exact installation command. `SIGINT` and
`SIGTERM` close the portal before the foreground process exits.

### §7.7 What subcommands do NOT do

- Send prompts. They never call `loop.run`.
- Hide state changes: workspace rename and an explicit reasoning policy are the
  only mutations; every other subcommand is read-only.
- Honor flags that only matter to a conversation (`--model`, `--reasoning`,
  `--yolo`, `--auto`) in state-command mode. Those parse without effect there;
  `web` is a client presentation mode and therefore does honor them. Reasoning
  mutation uses the positional policy above.

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
only connection-level failures receive the “no daemon” onboarding hints.
{§cli-connection-onboarding}

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
lines in text mode and accumulate under `notices` in the version-2 JSON record.

Indexing activity arrives only through the ordinary AG-UI status snapshot/delta
stream; clients do not poll or interpret a second progress Notice. The one-shot
TTY repaints routine activity changes no more than once per 15 seconds;
non-TTY stderr omits them. Indexing warnings and failures remain explicit
diagnostic Notices. `exec:*/search_progress` replaces search acquisition's
activity position and its terminal phase clears it. Neither client appends
progress ticks or live-renders durable `entry_materialized` narration.

Client `daemon_stale` and `edits_blocked` observations are also Notices because
they advise without terminating an operation. Client failures are Problems.

### §8.3 Rendering and channel posture {§cli-notice-rendering} {§cli-channel-posture}

`renderDiagnostic(diagnostic)` renders either contract without converting one
into the other:

```
📡 <source>:<kind> [<position>] ["<detail-or-message>"]
   <snippet lines, if any>
   <hint lines, if any>
```

Problems render red. Notices use their required producer-owned `level`; the
client never infers severity from `kind`. `ContentOffset` renders as
`L<line> col<column>` and `LogCoordinate` as its coordinate plus optional op.
CLI mode writes diagnostics to stderr. TUI mode inserts them into the waterfall
without colliding with the active prompt.

### §8.4 `stream/event` and `stream/concluded` {§cli-stream-event-and-stream-concluded}

The daemon also projects streaming-channel metadata as `plurnk.stream` events.
Streams are content lifecycle, not Problems or Notices. The client renders no
stream lifecycle of its own: a start or growth event writes nothing, and a
conclusion renders the launching fence's operation row once (§5.3).

```
stream/event     { entryId, workerId, target, channel, state, contentLength }
stream/concluded { entryId, workerId, target, subscriptionId, scheme, result, summary, wakeAction }
```

`workerId` is the entry-read perspective and `target` is the stream's address: the one the service stamped on the started execution row as `attrs.stream` (`python:///0c0ffee1`), opaque to the client and never composed. The TUI keeps the started row until that address concludes, then renders it once, per §5.1:

```
python Run the focused tests
python Run the focused tests — failed (exit 2); stdout=0 bytes, stderr=41 bytes
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
2. Connects to the module at `http://$PLURNK_HOST:$PLURNK_PORT` (or `PLURNK_AGUI_URL`), bearer from `PLURNK_AGUI_TOKEN` when set.
3. Resolves the workspace per §1.1 (`workspace.create` by default, or `workspace.attach` when `--workspace`/`PLURNK_SESSION` is set); uses the returned workspace for all subsequent RPCs until disconnect.
4. Subscribes to `log/entry` notifications and renders each per §5.1.
5. Consumes client-owned proposal interrupts and resolves each through standard AG-UI resume per §6; loop-owned dispositions are absent from that surface.
6. Consumes `CUSTOM plurnk.notice` and renders each Notice per §8.
7. Maps `loop.run` results to exit codes per §4.
8. Emits client-owned failures as RFC 9457 Problems and advisories as Notices per §8.
9. Projects `STATE_SNAPSHOT` and each `STATE_DELTA` into the run's status gauge (`loop/packet`, plurnk-agui SPEC); a delta before a snapshot or a patch op other than `replace` is a 502 `state-invalid` Problem.

---

## §10 Out of scope

- Multi-daemon connections. One client, one daemon.
- Interactive provider authentication. It belongs to third-party MCP tooling, not this client.
- Direct provider access. The client never talks to OpenAI/Anthropic/etc.; the daemon owns provider integration.
- Direct grammar parsing. The client emits raw DSL only via `op.parse` (which delegates to the daemon's parser); it does not parse locally.

When any of these becomes in-scope, file an issue and update this SPEC.
