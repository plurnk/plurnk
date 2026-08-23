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
| `--json` | flag | CLI mode only (or `PLURNK_JSON`). json OUTPUT MODE: one complete record document on stdout, stderr silent, structured errors. See §2.1 / §5.5. |
| `--workspace <name>` | string | Resume the named workspace. See §1.1. Overrides `PLURNK_CLIENT_WORKSPACE`. |
| `--worker <name>` | string | Resume (or create) the named run within the workspace. Requires `--workspace`. Overrides `PLURNK_CLIENT_WORKER`. See §1.1. |
| `--model <selector>` | string | Persist a declared alias or exact `provider/model` route on the conversation worker before its first loop. See §1.2. |
| `--project-root <path>` | string | Absolute path passed as `projectRoot` on `workspace.create`. See §1.3. Overrides `PLURNK_CLIENT_PROJECT_ROOT`. |
| `--yolo` | flag | Auto-accept every proposal locally without prompting. See §6. Overrides `PLURNK_YOLO`. |
| `--auto` | flag | Keep proposal authority inside the loop (`flags.auto=true`); no client review/resume round-trip. |
| `--flags <json>` | string | Raw LoopFlags JSON passthrough on every `loop.run` (e.g. `'{"auto":true}'` for automation workers). Mode is not a flag — see the prompt prefixes (§2.0). |
| `--max-turns <n>` | string | Per-loop turn cap (daemon default `PLURNK_MAX_TURNS`). |
| `--timeout <s>` | string | CLI mode only: cancel the loop via `loop.cancel` after `<s>` seconds; exits 3 with `"timedOut":true` in the result envelope. |
| `--pick <glob>` | string, repeatable | Membership overlay: track file(s) in manifest (the sole source when headless). Maps to a `pick` constraint. Create-time / workspace-level. See §1.4. |
| `--hide <glob>` | string, repeatable | Membership overlay: block file(s) from manifest. Maps to a `hide` constraint. See §1.4. |
| `--view <glob>` | string, repeatable | Membership overlay: track file(s) in manifest (read-only). Maps to a `view` constraint. See §1.4. |
| `--manifest-items <n>` | string | Workspace-open preview: `-1` full / `0` off / `N` first-N items of `plurnk://manifest.json` at turn 0. Create-time only. See §1.4. |
| `--md <name=path>` | string, repeatable | Pin a markdown doc into the workspace (read at turn 0). Reads the local file and sends its content; unions with the operator's `PLURNK_MD_*` (client wins a collision). Create-time only. See §1.4. |

Env:

| Var | Default | Meaning |
|---|---|---|
| `PLURNK_HOST` / `PLURNK_PORT` | `127.0.0.1` / `3044` | The daemon's in-process AG-UI+ module — `http://$PLURNK_HOST:$PLURNK_PORT`, the client's sole surface. `PLURNK_AGUI_URL` overrides the assembled URL; `PLURNK_AGUI_TOKEN` rides as the bearer when set. |
| `PLURNK_CLIENT_WORKSPACE` | _unset_ | Workspace name to resume (or create). Equivalent to `--workspace`. |
| `PLURNK_CLIENT_WORKER` | _unset_ | Run name to resume/create. Equivalent to `--worker`. Requires `PLURNK_CLIENT_WORKSPACE`. |
| `PLURNK_CLIENT_PROJECT_ROOT` | _unset → cwd_ | Absolute path used as workspace `projectRoot` on creation. Equivalent to `--project-root`. See §1.3. |
| `PLURNK_YOLO` | _unset_ | When truthy (`1`/`true`/`yes`/`on`), auto-accept every proposal locally. Client-only — see §6. Equivalent to `--yolo`. |
| `PLURNK_AUTO` | _unset_ | When truthy, keep proposal authority inside every loop. Equivalent to `--auto`. |
| `PLURNK_EXECS_ONLY` / `PLURNK_EXECS_<tag>` | _unset_ | Create-time workspace executor policy. The client forwards only the closed allowlist/runtime-tag grammar; plugin configuration sharing the broad prefix is not workspace policy and never crosses the wire. |

**Cascading env.** Highest precedence first: shell exports → repeated `--env-file` / `--env-file-if-exists` flags (node-native; the last occurrence wins; `--env-file` requires the file, while the other skips a missing one) → project `./.env` → `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env` → the client's own packaged floor (below). All layers are optional; the client works with no configuration. The client reads the daemon address (`PLURNK_HOST`/`PLURNK_PORT`, or `PLURNK_AGUI_URL`) from the shared XDG file. There is no generated aggregate defaults file; `plurnk-service config defaults` renders the complete owner-labelled catalog on demand.

**The self-serve floor** {§cli-env-defaults} — per the ecosystem standard (one owner per key, the file IS the docs), the client ships `.env.defaults` at its package root declaring only the `PLURNK_CLIENT_*` prefix and loads it SET-IF-UNSET beneath every operator layer. A knob the operator set is never overridden; a commented knob is documentation, not a value.

### §1.1 Workspaces and workers {§cli-workspaces-and-workers}

Workspaces and workers are daemon-owned. The client only knows their **names** — ids are internals used by the daemon to avoid conflicts and are not exposed via flags or env.

**The name IS the identity.** With `--workspace`/`PLURNK_CLIENT_WORKSPACE`, the client sends that name VERBATIM as `forwardedProps.plurnk.workspace` on every run (also the AG-UI `threadId`); the module attaches it if it exists, creates it with exactly that name otherwise — no prefixes, no forging. **With NO workspace, the DAEMON mints a fresh, uniquely-named workspace** (a no-name `workspace.create`, created WITH the invocation's options so creation is atomic with the project root) and the client binds to the returned name. A literal client label (`tui`/`cli`) is NEVER a workspace name — that would collide every unnamed launch into one shared world. The workspace is required wire-side: a worker without one is rejected 500, and the client never relies on a module fallback.

**Creation is ATOMIC with the projectRoot.** The client sends its workspace options (projectRoot/constraints/settings) on EVERY request, so whichever request causes creation creates the workspace fully formed — there is no window where a workspace exists undressed. A workspace created without a root is headless on purpose and stays headless forever: changing a project root is unimplemented by design (the root is the world's ground).

- **`--worker <name>` names the CONVERSATION** (thread-per-run, svc#366): with a prompt, the worker name becomes the `threadId` — an existing run (a fork, a prior conversation) is bound by name; a new name mints a fresh conversation run over the same world. Without `--worker`, thread == world and conversations bind the workspace's model run (the default conversation). For read subcommands, `--worker` resolves via `workspace.workers` and an unknown name fails hard — no silent fallback to the model run.
- **`--worker` set without `--workspace`** → usage error (exit 64). Run names are scoped to a workspace; there's no workspace to scope into.

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

The TUI's `/model` verb reads and writes `worker.model.set`/`worker.model.get`; the header displays the resolved durable route. `providers.list` remains the small declared-alias directory used for completion. `/models [search]` and `plurnk models` lazily query `models.list`; no model catalog is fetched at startup or injected into a model packet.

### §1.2.1 Child provider selection {§cli-child-provider-selection}

Child selection is the same durable posture for WORK, FORK, and BARE calls.
`PLURNK_MODEL_CHILD` seeds the worker's spawn override (the daemon reads its own
env); otherwise the policy is inherit. Bare `/child` reports the worker's
persisted override, `/child <selector>` persists it via `worker.child.set`, and
`/child inherit` sends `selector: null` (clearing the override). The client sends
no child selector on loops.

### §1.2.2 Reasoning policy {§cli-reasoning-policy}

Reasoning is a separate durable worker policy owned and validated by the daemon.
`/reasoning` and `plurnk reasoning --workspace <name>` inspect the effective
policy and daemon-supported choices; supplying a policy to either form persists
it. `--reasoning <policy>` performs that same action after an explicit model
selection and before the invocation's first loop. The client forwards the value
without maintaining a provider capability catalog, uses `supportedPolicies` for
completion, and never encodes policy in an alias or loop request. Reattachment
reads the durable value; descendants follow the daemon's snapshot inheritance.

### §1.3 Project root {§cli-project-root}

**Project root** is the absolute path the daemon's `file://` scheme uses as the workspace boundary for that workspace. Stored on `workspaces.project_root` (per plurnk-service migration 015); NULL = headless (file ops 400 with "workspace has no project_root").

Client behavior:

- Default: `process.cwd()` — the user's current directory.
- Override: `--project-root <abs-path>` or `PLURNK_PROJECT_ROOT`.
- Explicit headless: set to empty string (`--project-root=`) → wire as `null`.
- Sent on `workspace.create` only. On `--workspace` attach, the daemon preserves the stored value and the client's flag is silently ignored (no surprise overwrites of a workspace you're resuming). To change a live workspace's root, call `workspace.set_root` directly — not yet surfaced as a client command.

The "inject standing context into every loop" role formerly served by persona is now `--md`/`mdDocs` (§1.4): markdown docs pinned into the workspace and read at turn 0.

### §1.4 Membership overlay and workspace-open settings {§cli-membership-overlay-and-workspace-open-settings}

These flags shape what the workspace sees. The membership overlay flags map to **constraints** (service vocabulary, svc#200); the settings flags map to **workspace-open settings** (svc#231). All are creation-time / workspace-level.

**Membership overlay** — repeatable glob flags, sent as `constraints` on `workspace.create`:

- `--pick <glob>` → `{effect: "pick", glob}` — track file(s) in manifest (the sole source when headless).
- `--hide <glob>` → `{effect: "hide", glob}` — block file(s) from manifest.
- `--view <glob>` → `{effect: "view", glob}` — track file(s) in manifest (read-only).

Seeded atomically at `workspace.create` so turn-1's manifest is right with no follow-up RPC. On `--workspace` attach, each constraint is applied **live** via `workspace.constrain` (workspace-scoped, re-resolved immediately).

**Workspace-open settings** — sent as `settings` on `workspace.create`:

- `--manifest-items <n>` → `manifestItems`. Controls the `plurnk://manifest.json` preview at turn 0: `-1` full / `0` off / `N` first-N items. Must be `-1`, `0`, or a positive integer (else exit 64). Replaces the operator's `PLURNK_MANIFEST_ITEMS` for the workspace.
- `--md <name=path>` → `mdDocs` (`[{alias, content}]`). Pins a markdown doc into the workspace, read at turn 0. The client reads each file from its **own** local fs (co-location law — correct, not a workaround) and sends `content`, not a path. Relative paths resolve against cwd; an unreadable file is a usage error (exit 64). Unions with the operator's `PLURNK_MD_*` (client wins a collision). Repeatable.
- Executor policy → `execs` (`Record<string, string>`). Only `PLURNK_EXECS_ONLY` and `PLURNK_EXECS_<canonical-runtime-tag>` are admitted, case-insensitively. Values remain verbatim for daemon-owned interpretation; unrelated executor/plugin configuration is excluded.

Settings are **workspace-create-only** (no live setter). On `--workspace` attach, `--manifest-items`/`--md` are flagged and skipped — the client prints a dim notice and ignores them.

---

## §2 One-shot mode {§cli-one-shot-mode}

Triggered when a prompt is present from positionals, piped stdin, or both.

### §2.0 Prompt prefixes (converged with plurnk.nvim and the TUI) {§cli-prompt-prefixes-converged-with-plurnknvim-and-the-tui}

The prompt's first character carries the same habits as nvim's `:AI` and the TUI line: `plurnk "? question"` runs a read-only loop (`flags.mode="ask"`), `": text"` forces act, and `plurnk "! command"` execs via the daemon — op.exec, stream to conclusion, exec stdout→stdout / stderr→stderr, exit by `result.status` (0/3/4). A prefix wins over a `--flags` mode.

### §2.1 Output channels {§cli-output-channels}

Standard Unix discipline: **stdout is the program's product, stderr is its narration.** There are two OUTPUT MODES, selected by `--json` / `PLURNK_JSON` — not a flag on one output, but two distinct contracts:

**text mode (default):**
- **stdout** — the body of the *terminal* broadcast SEND (status 200 or 499), per §5.4. Exactly one value per invocation (none if the loop hit maxTurns and never terminated). Intermediate broadcasts (such as a SEND carrying signal 102) are protocol mechanics, not the answer, and do NOT appear on stdout.
- **stderr** — workspace/prompt header, per-action trace lines (including intermediate broadcasts), summary line, error messages.

**json mode (`--json` / `PLURNK_JSON`):**
- **stdout** - ONE complete document and nothing else (§5.5): the coherent record of the terminated worker loop - `schemaVersion`, authoritative `workerId` + `loopId`, `response` (the answer, top-level for `jq -r .response`), `finalStatus`, `turns: [{turn, ops: [{coord, op, origin, target, scope, status, signal, tags}]}]`, `notices`, `usage`, exit metadata. Each op preserves the daemon's line-marker `scope` as its ordered coordinate array and complete sorted durable log classifications in `tags`. `usage` is preserved verbatim from `CUSTOM plurnk.terminated`: ordered physical-request evidence and conventional aggregate token fields live under `usage.accounting`, whose `costUsd` is an exact decimal string or `null`; `curationWeight`/`curationBudget`, `contextTokens`/`contextCapacity`, and provider metadata remain sibling fields. Curation weight is never compared with physical provider tokens. The client does not project, sum, round, or settle accounting. `CUSTOM plurnk.terminated` supplies both owning coordinates; the client never combines a terminal loop with a worker inferred from ambient rows. Workspace-visible child/sibling rows may be rendered as topology, but they do not enter this record's `response` or `turns`. On failure it is `{"schemaVersion":6, "problem": ProblemDetails}` - valid JSON either way, paired with the exit code.
- **stderr** — silent.
- **NOT inlined:** op *content* (file bodies, exec output). Under co-location the consumer reads the file directly or fetches one op on demand with `plurnk read <coord> --json` (§7) — the same OPEN/FOLD discipline the engine runs on. `--json` carries the record, not the content.

Consequence:

- `plurnk "X" > answer.txt` captures just the terminal answer.
- `plurnk "X" 2>/dev/null` suppresses the trace.
- A TTY user sees both interleaved as before (the terminal merges streams).
- `plurnk "X" | tool` pipes only the answer.
- `plurnk --json "X" | jq -r .response` pulls the answer; `… | jq .turns` the structured trace. One document, no stderr archaeology — the CLI is the integration layer, no third-party client needed for basic needs.

### §2.2 Flow {§cli-one-shot-flow}

1. `POST /` (RunAgentInput) to the module — `threadId` = the workspace name, the prompt as the user message, workspace + per-run knobs on `forwardedProps.plurnk`.
2. Consume the SSE: `CUSTOM plurnk.row` events render as per-action trace lines on stderr. The terminal broadcast SEND body (status 200 or 499) goes to stdout (§5.4); intermediate broadcasts do not.
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
2. Print banner; enter readline loop with the `  <coord>🐹 <status> 201 : ` prompt — the user's waterfall row, coordinate-prefixed (the coordinate the typed line will get; §5.1), pre-rendered, restricted to WIDTH-STABLE glyphs, carrying exactly TWO glyph lanes like every waterfall row (identity · status). The identity lane is 🐹 (🧮 while embeddings warm); the status lane shows ⏳ while busy (💤 when the loop is parked on a SEND carrying signal 202) and holds a RESERVED BLANK when idle; a 🔥 gutter precedes the coordinate when YOLO is armed. The `201` is an input-affordance constant, not the service's durable prompt-row operation or status. Settled empirically: `✉️` (U+2709+VS16) drifted the cursor one column on terminals that cell-count VS16 sequences as 1 (readline repositions at its own computed width on every refresh) and is banned. **Prompt glyph policy: no VS16/width-ambiguous sequences, ever**; output lines render anything — no cursor positioning happens on output.
3. Each line entered is dispatched:
    - Lines starting with `/` → command verbs (one vocabulary with nvim's `:AI/`): `/help /models [search] /workspaces /workers /log [n] /model <selector> /child <selector|inherit> /reasoning [policy] /yolo /workspace [name] /worker [name] /rename <name> /stop /quit`, plus membership verbs `/pick <glob> /hide <glob> /view <glob> /drop <glob> /members` (§1.4), `/import <path>` (§3.3), and workspace MCP controls (§3.4). Singular verbs CREATE, plural verbs LIST: `/workspace [name]` opens a fresh workspace (rebinds the AG-UI thread in place), `/workspaces` lists; `/worker [name]` forks a new worker (`run.fork`), `/workers` lists; `/rename <name>` retargets the workspace's mutable handle (a worker's name is immutable). Verbs never call `loop.run`; inspect verbs reuse the §7 subcommand tables; membership verbs apply live via `workspace.constrain`/`workspace.unconstrain`; `/stop` and `/help` stay reachable while a loop is in flight. Tab completion (readline completer, no screen takeover) covers verbs, declared aliases, daemon-supported reasoning policies, **file paths** (after `/pick`/`/hide`/`/view`/`/import`, the MCP options-file position, and bare `@file` tokens), **PLURNK headings** (`## RE` → `## READ0`), and PLURNK target paths.
    - Lines beginning with a recognized PLURNK operation heading (`# PLAN…` or `## OP…`) → `op.parse`; `## LOOK…` instead uses the non-logging `op.look` observation action. The daemon owns parsing and diagnostics. Prefix `: ` to force prompt treatment when prose intentionally begins with a reserved operation heading.
    - Lines starting with `!` → the `op.exec` action. Daemon-owned shell; proposal-gated like any side effect.
    - Lines starting with `? ` → a conversation run with `flags.mode="ask"` (read-only loop); `: ` forces act (the daemon default). Mode is a per-line prefix habit, never a flag — there is no `--ask`; `--flags '{"mode":"ask"}'` is the generic passthrough for automation.
    - Lines starting with `...` → the `loop.inject` action — speak into a running loop without starting a new one (the "btw" steering case).
    - Anything else → a conversation run (the prompt as the user message). Standard prompt-driven loop.
    (Verbs and injections ride §3 action runs on the same AG-UI+ surface — one wire, no side-channel.)
4. While a dispatch is in flight, additional input is rejected with a "busy" notice (except `/stop`, `/help`, and a bare `...`/`?`/`:` prompt, which injects).
5. `Ctrl-C` or `EOF` exits cleanly.

### §3.2 Cancellation {§cli-cancellation}

`Ctrl-C` during an in-flight dispatch fires the `loop.cancel` action — the daemon aborts the model run's active drain, the pending loop resolves with `finalStatus: 499`, and the REPL continues. A failed cancel SURFACES on the terminal — a stop control that silently does nothing is the worst kind of broken. A second `Ctrl-C` (or `Ctrl-C` while idle) closes the readline interface — the escape hatch for dispatches a drain-cancel can't unblock (`op.parse`). (Dropping a conversation run's SSE also aborts its loop — hangup is the abort; `loop.cancel` is the addressable spelling.)

CLI mode mirrors this: first `Ctrl-C` cancels (the loop resolves 499 → exit 3 per §4); second `Ctrl-C` force-exits 3.

### §3.3 `/import` and bracketed paste {§cli-import-and-bracketed-paste}

`/import <path>` reads a **local** file (co-location law — the client reads its own fs, the daemon never sees the path) and stashes its content into the prompt buffer, reusing the paste machinery (§below): a short marker lands in the line and expands to the full content on submit, framed however you type. Relative paths resolve against cwd; an unreadable file prints an error and is a no-op.

**Bracketed paste.** A multi-line paste must become ONE prompt, not one `loop.run` per line. The client filters stdin through a paste filter and feeds readline a `PassThrough`, buffering the paste between the terminal's `?2004` markers so the whole block submits as a single prompt. Stream plumbing only — no cursor/width math.

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
| `/mcp` / `plurnk mcp` | `worker.mcp.list {}`, then `worker.mcp.discover {configuration}` when the client holds `PLURNK_MCP_*` declarations |
| `/mcp discover <url\|command>` | `worker.mcp.discover {source}` |
| `/mcp add <alias> <target> [options.json]` | `worker.mcp.add {alias, definition}` — the client composes the exact `McpServerDefinition`: `name = alias`; an absolute `http(s)://` target is `{transport: "http", url}`, anything else `{transport: "stdio", command, args: []}`; `options.json` supplies the remaining definition members |
| `/mcp enable <alias>` | `worker.mcp.enable {alias}` for an available definition; `worker.mcp.add {alias, definition}` when `alias` is a candidate of the client's own configuration |
| `/mcp enable <alias> options.json` | `worker.mcp.add {alias, definition}` with the alias's current (listed or discovered) definition specialized by `options.json` |
| `/mcp disable <alias>` | `worker.mcp.disable {alias}` |
| `/mcp remove <alias>` | `worker.mcp.remove {alias}` |
| `/mcp oauth <alias> <callback-url>` | `worker.mcp.oauth.complete {alias, callbackUrl}` |

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
| `/skills` | `worker.skills.list {}` |
| `/skills discover <query>` | `worker.skills.discover {query}` — registry search |
| `/skills discover <source>` | `worker.skills.discover {source}` — a single term holding `/`, `:`, or `\\`, or starting with `.` or `~`, is a package reference |
| `/skills add <name> <source> [--global]` | `worker.skills.add {alias, definition: {name, scope, source}}` with `scope` `project` unless `--global` |
| `/skills enable <name>` | `worker.skills.enable {alias}` |
| `/skills disable <name>` | `worker.skills.disable {alias}` |
| `/skills remove <name>` | `worker.skills.remove {alias}` |

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
| `/agents` | `worker.agents.list {}` |
| `/agents discover <url>` | `worker.agents.discover {source}` — one inert card-derived candidate |
| `/agents add <alias> <url> [options.json]` | `worker.agents.add {alias, definition: {name: alias, url, ...options}}`; `options.json` supplies `cardPath`, `headers`, `authorization` |
| `/agents enable <alias>` | `worker.agents.enable {alias}` |
| `/agents disable <alias>` | `worker.agents.disable {alias}` |
| `/agents remove <alias>` | `worker.agents.remove {alias}` |

Invalid or unreadable local JSON fails before dispatch; daemon Problems — an
unreachable card, an unsupported interface, an unresolved symbolic credential —
cross the existing diagnostic path without rewriting or retry.

---

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

One line per dispatched op, except the structured PLAN block below. Format
(vanilla ANSI, no framework):

```
  <origin> <op-glyph> <status-glyph> <status> <target> <scope>  <body-preview> [— <annotation>]
```

Width-tolerant; no fixed column widths. The status code drives color; EVERY line carries a status glyph (✅/⏳/❌ from the outcome; SENDs glyph their signal — ✋/💥/⏳ carry meaning; 4xx and 5xx share ❌, nvim-converged: one failure signal in the alignment column, the colored status carries the class). A glyph that exists only sometimes is dissonant (rummy f20c4a0 precedent).
The target and scope are omitted independently when absent; a present scope renders in canonical `<mark,...>` form.
A present durable operation annotation is appended as sanitized, literal plain text; clients do not interpret its Markdown or HTML syntax.

**Coordinate prefix.** Each line opens with the `LL/TT/SS` logical coordinate (loop/turn/sequence, zero-padded min-2), so it's its own `log://` address. AG-UI+ row events carry `loop_seq`/`turn_seq`/`sequence`; the readline prompt shows the coordinate the typed line will get — the next loop's actionless `prompt` row at `<next>/01/01`, advancing as loops complete. Stream lines (`📡`) carry it too — `stream/event`/`stream/concluded` mirror the entry's coordinate, read straight from the payload (never reconstructed from the URI). A stream without a coordinate renders without one.

**Width-stable glyph palette (both clients).** Every palette glyph is plain East-Asian-Wide — width 2 in node and every major terminal. VS16 variation-selector sequences (✉️ ✏️ ⚙️ ⚠️ 🗑) are banned from the palette entirely: they cell-count differently across terminals, which corrupted readline cursor math in the prompt and produced ragged column gaps in output. Stable widths need no pad-space hacks, so columns align truly. Palette: 🤖 🐹 🧰 🔌 (origins) · 🔍 📖 📝 📋 📦 ➕ ➖ 💬 🔧 🔮 (ops) · ✅ 🚧 ⬜ 📭 💾 (Plan) · ⏳ 💤 🤔 💥 ✋ ❌ (status). Prefer plane-1 emoji (U+1F300+) for any new glyph: BMP "ornament" dingbats with default emoji presentation (e.g. ❓ U+2753) are width-2 in spec but a font may still render them as a width-1 text glyph — `300` was ❓ until a terminal showed it un-emojified, now 🤔.

**Exceptions:** broadcast SEND (op == `SEND` with `target_scheme === null`) is rendered as a multi-line block per §5.4, not as a single trace line. The service's actionless lowercase `prompt` row at `prompt:///<loop>/<turn>` is **skipped entirely** in the TUI waterfall: the line the user typed at the readline prompt is already their record, and rendering the durable row too would duplicate every prompt. (Erasing the typed echo instead would require terminal-row math over emoji/nerdfont-width prompts — out of bounds by policy: the TUI stays brutally simple and works on every modern terminal.)

#### §5.1.1 Provider reasoning {§cli-provider-reasoning}

Readable provider reasoning is neither PLAN nor assistant speech. The client
consumes AG-UI's standard `REASONING_MESSAGE_START/CONTENT/END` lifecycle,
shows its growing tail in one replaceable `💭` row, then replaces that preview
with the complete dim block before the paired SEND row. No delta creates a
scrollback row. It never infers reasoning
from PLAN, renders encrypted reasoning as text, or invents an empty transcript.
The one-shot client streams this human trace to stderr; stdout remains the bare
answer and JSON mode remains silent.

#### §5.1.2 Plan {§cli-plan-rendering}

PLAN renders its complete entries in source order, one human line each:

| Status | Glyph |
|---|---|
| `completed` | ✅ |
| `in_progress` | 🚧 |
| `completed` content beginning `Memory: ` | 💾 |
| `pending` | ⬜ |

The first line carries the PLAN row's coordinate and dispatch status; subsequent
entries align beneath it as the same durable row. The client consumes the ACP
Plan projection; projected memory omits its `Memory: ` prefix. Entry whitespace
collapses to one line.
Neutral `medium` priority is implicit; `high` and `low` render as
`[high]` and `[low]`. An empty Plan renders `📭 no entries`. The one-shot plain
trace retains its PLAN header and applies the same entry projection below it.

### §5.2 Summary line (per `loop.run`) {§cli-summary-line-per-looprun}

```
  <tag> · <N> turns · <wall>ms · ↑<input> ↓<output> [· cur <percent>/<budget>] [· ctx <percent>/<capacity>] [· loop $<exact-usd|unknown>]
```

`tag` derives from the exact terminal `OperationResult`. A 500 is `strike-out` only for `engine/rails/strike-threshold`; exhausted invalid emission is `invalid emission`, and another 500 is `failed`.
Input and output are the conventional aggregate fields from the daemon's accounting envelope. Missing token quantities render as `?`; exact zero cost is omitted; a nonzero exact decimal is rendered without floating-point conversion; and a physical request with incomplete monetary evidence renders `$unknown`.

### §5.3 What is NOT rendered {§cli-what-is-not-rendered}

- The full packet (`turn.packet`). The client never displays the rendered index or model-facing log sections.
- Raw bodies for non-broadcast ops. Broadcast SEND body IS rendered (§5.4); other op bodies surface only via `entry.read` / `## READ0 (log://...)`.
- Raw SSE frames. Set `DEBUG=plurnk:agui` (future) to enable.
- Content fetching from streaming channels — with ONE bounded exception. Streams render coalesced: a single start line on the first `stream/event` (`📡 ⏳ <target>`; growth ticks and per-channel closes are silent) and a single conclusion line in the waterfall grammar (`📡 ✅ 200 <target> "<summary>"`, target echo stripped from the summary, `→ resumed loop` only when the wake resumed one). On conclusion the client makes one `entry.read` and inlines a channel's content only when it is ≤160 chars and ≤2 lines (stderr marked `!`) — at that size the content IS the better optics (a 12-byte exec answer should be visible, not described). Larger outputs remain summary-only; fetching them is the consumer's job. See §8.7.

### §5.4 Broadcast SEND rendering {§cli-broadcast-send-rendering}

A broadcast SEND (`op === "SEND" && target_scheme === null`) is the model's reply to the user. It is content, not a diagnostic, and the client MUST render the full body verbatim.

TUI mode contract:

- Header line: two glyph lanes — identity (🐹 client / status-flavored model-send glyph: 💭 102, 💡 200, 💤 202, 🤔 300) then the status code in ONE display column across every line species (blanks reserved, never omitted). 2-space INDENT matching the trace lines, no PATH.
- Body: a short single-line body (≤80 chars) inlines on the header line after two spaces (nvim convergence); otherwise the body starts on the next line, each line prefixed with five spaces (3 more than the header), no ellipsis, no dim.
- Surrounded by one blank line above and one blank line below.
- Empty body is legal and renders as just the header.

**Conversation stripe.** Model speech stands out against operation records as a full-width background band (every block line painted to the terminal's right edge via `\x1b[K`, with an explicit near-white foreground so the band reads on any theme). It is the ONLY thing that gets a background:

- **Model speech** — any broadcast SEND from `origin === "model"` (102 intermediate, 200/499 terminal alike): the project green `#148800`, emitted as truecolor (`48;2;20;136;0`) when `COLORTERM` advertises it, else the nearest 256-color cube entry (`48;5;28` = `#008700`). A 2xx on the band drops its green foreground (band-white) so it doesn't vanish green-on-green; non-2xx keep their signal color.
- **Nothing else is banded.** The user's prompt entry is skipped per §5.1 (the typed line is their record); client-origin and other broadcasts render plain. One band, one signal.

Inner ANSI resets (status colors, markdown styling) re-arm the band so a styled span can't cut it mid-line. `NO_COLOR` drops the bands; the block layout (header + indented body) remains. CLI mode is unaffected — stdout/stderr stay plain per §2.

CLI/one-shot mode contract: trace line emits as usual per §5.1, immediately followed by the body content as plain unprefixed lines. This makes the assistant's reply present in stdout for the standard Unix-tool posture (§2).

The body source is `entry.tx.body`, a `SendBody` object (`{ raw: string, json: any }` per `plurnk-grammar/schema/SendBody.json`), NOT a plain string.

A broadcast is **terminal** when `entry.signal` is `200` or `499` — those are the only statuses that end a loop (per `plurnk-service` Engine). Only the terminal broadcast contributes to stdout in CLI mode.

**CLI default** emits `tx.body.raw` of the terminal broadcast verbatim on stdout — no transformation. Pretty-printing is a TUI convenience; piped consumers receive exactly what the model emitted.

**CLI `--json`** emits the terminal broadcast as exactly one JSON value on stdout:

- If `tx.body.json !== null` (the grammar parsed `raw` as JSON), emit `JSON.stringify(json)` — compact, validated, no double-wrap.
- Otherwise emit `JSON.stringify(raw)` — the reply wrapped as a JSON string literal.

This makes `plurnk --json "X" | jq` always valid regardless of whether the model emitted JSON or prose.

**TUI mode** (no `--json`; the flag is CLI-only) renders *every* broadcast (terminal and intermediate alike) as a block per §3.4.1, dispatching by content type:

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
    op: "EDIT" | "EXEC" | ...,
    target: { scheme: string | null, pathname: string | null },
    body: string,                 // udiff for EDIT; command summary for EXEC
    attrs: object,                // scheme-specific payload (opaque to client)
    flags: object,                // loop's persisted flags ({auto, noProposals, ...})
}
```

**Service-resolved proposals.** When `flags.auto` or `flags.noProposals` is set, the service settles the entry before any human can react—the notification is informational. The client skips review UI and sends no `loop.resolve`.

### §6.2 Review menu (interactive) {§cli-review-menu-interactive}

When the proposal is not server-resolved (§6.1), a TTY is present, and `--yolo` is not set, the client renders the proposal to stderr and prompts:

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

Udiff coloring for EDIT bodies: `+` lines green, `-` lines red, `@@` hunks cyan, headers (`+++`/`---`) bold. EXEC bodies render plain.

### §6.3 `--yolo` / `PLURNK_YOLO` {§cli-yolo-plurnkyolo}

Client-side opt-in. When set, the proposal handler skips the menu and immediately sends `loop.resolve({decision: "accept", outcome: "client_yolo"})`. The proposal notification still goes over the wire (the daemon is unaware that the client auto-accepted).

This is distinct from **loop auto** (`--auto`, `loop.run({flags:{auto:true}})`), where proposal authority never crosses into client review. A proposal carrying `flags.auto` gets no review UI and no `loop.resolve`.

### §6.4 Fail-closed (non-TTY, no yolo) — server-side via `noProposals` {§cli-fail-closed-non-tty-no-yolo-server-side-via-noproposals}

When stdin is not a TTY and `--yolo` is not set, the client cannot interactively review. Rather than reject each proposal client-side, the client runs the loop with `flags.noProposals: true` (plurnk-service #169 server half): the server auto-rejects side-effecting ops in-process, the model sees a plain 400 (mode-blind, no per-proposal roundtrip, no 5-minute hang). The `loop/proposal` still broadcasts; the client suppresses its handler via the server-resolved check (§6.1).

Because the server is silent by design, **the client owns the explanation** — it emits `client:proposal:edits_blocked` once at loop start: "edits and exec blocked: no review channel to approve them (run on a TTY, or pass --yolo)."

Use cases this protects: `plurnk "X" > answer.txt`, `plurnk "X" | tool`, scripted invocations without `--yolo`. A user who passes `--flags '{"noProposals":true}'` sets it explicitly; the no-review-channel detection merges with it.

### §6.5 What proposal review does NOT do {§cli-what-proposal-review-does-not-do}

- Concurrent proposals. The daemon pauses one dispatch per proposal; at most one proposal is pending per loop at any time. Client handles them sequentially as they arrive.
- Patch validation. The client does not parse the udiff. `body` is treated as opaque text for display and (when edited) re-submission.
- Persisting decisions. Each proposal is reviewed in isolation; no "always accept this scheme" memory.

---

## §7 Subcommands {§cli-subcommands}

Subcommands inspect or deliberately configure daemon state without running a
loop. They share the same connection and workspace-resolution machinery as the
prompt-driven flow, but skip `loop.run` entirely. All support `--json` for
machine-readable output (stdout product per §2.1; trace and errors stay on
stderr). `reasoning [policy]` is the sole worker-policy mutation in this surface
and follows {§cli-reasoning-policy}.

When `argv[0]` (after flag parsing) matches a known subcommand verb, the dispatcher routes there instead of assembling a prompt. Unknown subcommands exit `64`.

### §7.1 `plurnk models` {§cli-plurnk-models}

Queries one bounded page from the daemon's release-pinned catalog through `models.list`. No workspace is attached and no provider request is made. Positional words form a case-insensitive search; `--provider <name>` narrows the provider, `--all` includes models missing local configuration, and `--offset`/`--limit` page without loading the full catalog.

Default output is a column-aligned table of `selector / name / context / reasoning / readiness` plus a continuation offset when another page exists. The default availability is configured-and-ready exact routes; `--all` rows explain missing credential or configuration alternatives. With `--json`, the client emits the complete page unchanged so `offset`, `total`, and `nextOffset` survive.

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

### §7.6 What subcommands do NOT do

- Send prompts. They never call `loop.run`.
- Hide state changes: workspace rename and an explicit reasoning policy are the
  only mutations; every other subcommand is read-only.
- Honor flags that only matter to loop workers (`--model`, `--reasoning`,
  `--yolo`, `--auto`) — those parse without error but have no effect in
  subcommand mode. Reasoning mutation uses the positional policy above.

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
`https://problems.plurnk.dev/client/<owner>/<kind>`. Helpers in
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

AG-UI projects daemon `notice/event {loopId, notice}` notifications as
`CUSTOM plurnk.notice`. The client consumes that event name only. Notices
interleave with trace lines in text mode and accumulate under `notices` in the
version-2 JSON record.

Two progress Notices are interactive edge state rather than waterfall history:
`engine:derivation/embed_progress` replaces the prompt coordinate with indexing
percent, and `exec:*/search_progress` does the same with search-acquisition
percent. Their terminal phase restores the real coordinate. The client does not
append every tick, nor live-render durable `entry_materialized` narration.

Serialized Git branch batches arrive separately as `CUSTOM
plurnk.branch_batch`, preserving the daemon's full lifecycle payload. Queued and
running transitions replace the prompt actor with 🌿 and show aggregate
completion in the coordinate slot. Completion and failure clear that state and
append one summary; `recovery_required` remains visible and appends one
operator-facing error. Per-child progress never becomes waterfall spam.

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
Streams are content lifecycle, not Problems or Notices. The client merely uses
the same `📡` glyph so daemon-pushed activity has one visual lane.

```
stream/event     { entryId, workerId, target, channel, state, contentLength }
stream/concluded { entryId, workerId, target, subscriptionId, scheme, result, summary, wakeAction, wakeLoopId? }
```

`workerId` is the entry-read perspective and `target` is the entry's URI (`scheme://pathname`). Rendering is coalesced per §5.3:

```
  📡 ⏳ exec://python/1/2/1
  📡    200 exec://python/1/2/1 "completed (exit 0); stdout=12 bytes, stderr=0 bytes"
     Ulaanbaatar
```

CLI mode writes to stderr; TUI mode interleaves in the waterfall with the prompt-wipe prefix. **The client does not fetch the actual streamed content** — that's not the CLI's job. Consumers who want the body (e.g. `plurnk.nvim`) call `entry.read` themselves.

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
5. Consumes `loop/proposal` interrupts and resolves each through standard AG-UI resume per §6, skipping service-resolved proposals (`flags.auto` / `flags.noProposals`) entirely.
6. Consumes `CUSTOM plurnk.notice` and renders each Notice per §8.
7. Maps `loop.run` results to exit codes per §4.
8. Emits client-owned failures as RFC 9457 Problems and advisories as Notices per §8.

---

## §10 Out of scope

- Multi-daemon connections. One client, one daemon.
- Interactive provider authentication. It belongs to third-party MCP tooling, not this client.
- Direct provider access. The client never talks to OpenAI/Anthropic/etc.; the daemon owns provider integration.
- Direct grammar parsing. The client emits raw DSL only via `op.parse` (which delegates to the daemon's parser); it does not parse locally.

When any of these becomes in-scope, file an issue and update this SPEC.
