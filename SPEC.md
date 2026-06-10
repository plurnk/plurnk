# @plurnk/plurnk — Client SPEC

Specifies what the `plurnk` CLI/TUI client does. Wire protocol is defined upstream in [plurnk-service SPEC §13](https://github.com/plurnk/plurnk-service/blob/main/SPEC.md); this document does NOT redefine it.

`TUI.md` is the design rationale doc — narrative form, decisions and reasoning. `SPEC.md` (this file) is the contract: what the client guarantees, what its exit codes mean, what it renders.

---

## §0 Glossary

| Term | Meaning |
|---|---|
| **daemon** | A running `plurnk-service` process accepting WebSocket JSON-RPC. The client connects to it; it owns all state. |
| **session** | Daemon-owned long-lived state. Created via `session.create`; identified by an integer id. The TUI auto-creates one at boot. |
| **loop** | A single `loop.run` invocation against the daemon. May span many model turns; terminates on `SEND[200]` or `SEND[499]` or hitting `maxTurns`. |
| **log/entry notification** | Daemon-to-client push: one notification per dispatched op, carrying the action-entry shape (`{op, target, status_rx, rx, ...}`). |
| **one-shot mode** | `plurnk "prompt"` — single loop.run, render, exit. Unix-tool posture. |
| **TUI mode** | `plurnk` (no args) — interactive REPL; multiple loop.run invocations per session. |

---

## §1 Invocation

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
| `--json` | flag | CLI mode only. Format the terminal broadcast body as a JSON value on stdout. See §5.4. |
| `--session <name>` | string | Resume the named session. See §1.1. Overrides `PLURNK_SESSION`. |
| `--run <name>` | string | Resume (or create) the named run within the session. Requires `--session`. Overrides `PLURNK_RUN`. See §1.1. |
| `--model <alias>` | string | Model alias passed on every `loop.run`. See §1.2. Overrides `PLURNK_MODEL` for this invocation. |
| `--project-root <path>` | string | Absolute path passed as `projectRoot` on `session.create`. See §1.3. Overrides `PLURNK_PROJECT_ROOT`. |
| `--persona <path>` | string | Path to a persona file; contents passed on every `loop.run`. See §1.3. Overrides `PLURNK_PERSONA`. |
| `--yolo` | flag | Auto-accept every proposal locally without prompting. See §6. Overrides `PLURNK_YOLO`. |

Env:

| Var | Default | Meaning |
|---|---|---|
| `PLURNK_URL` | `ws://127.0.0.1:3044` | Daemon WebSocket URL |
| `PLURNK_SESSION` | _unset_ | Session name to resume. Equivalent to `--session`. |
| `PLURNK_RUN` | _unset_ | Run name to resume/create. Equivalent to `--run`. Requires `PLURNK_SESSION`. |
| `PLURNK_MODEL` | _unset_ | Model alias. Shared with the daemon (both processes read it for the same intent — see §1.2). Equivalent to `--model`. |
| `PLURNK_PROJECT_ROOT` | _unset → cwd_ | Absolute path used as session `projectRoot` on creation. Equivalent to `--project-root`. See §1.3. |
| `PLURNK_PERSONA` | _unset_ | Path to a persona file; contents sent on every `loop.run`. Equivalent to `--persona`. See §1.3. |
| `PLURNK_YOLO` | _unset_ | When truthy (`1`/`true`/`yes`/`on`), auto-accept every proposal locally. Client-only — see §6. Equivalent to `--yolo`. |

`.env` is auto-loaded if present; explicit shell exports override.

### §1.1 Sessions and runs

Sessions and runs are daemon-owned. The client only knows their **names** — ids are internals used by the daemon to avoid conflicts and are not exposed via flags or env.

Resolution at startup (applies to both CLI and TUI modes):

1. **Neither `--session` nor `PLURNK_SESSION` set** → client calls `session.create`. Daemon mints a fresh auto-named session with a fresh auto-named run. This is the default.
2. **`--session <name>` (or `PLURNK_SESSION`) set, `--run` unset** → client calls `session.list`, filters by name, and `session.attach({id})`. Daemon resumes the session with a new auto-named run.
3. **Both set** → as above, but `session.attach({id, runName})`. Daemon resumes the run with that name, or creates it if absent (per `plurnk-service` SPEC §13.5).
4. **`--run` set without `--session`** → usage error (exit 64). Run names are scoped to a session; there's no session to scope into.

Resolution errors:

- **Session name not found** → exit 1 with a clear message. The client never silently creates a session whose name didn't already exist — if you wanted to create one, run without `--session` first.
- **Multiple sessions share the name** → exit 1. The daemon does not enforce session-name uniqueness today; the client refuses to guess. Pick a unique name.

CLI flag takes precedence over env when both are set.

### §1.2 Model selection

The daemon registers model aliases via `PLURNK_MODEL_<alias>=<provider>/<model>` env entries at boot, and resolves an active alias for its own provider via `PLURNK_MODEL=<alias>` (also at boot). The client can override on a per-call basis by passing `alias` on `loop.run`.

Resolution at the client:

- `--model <alias>` set → pass `alias` on every `loop.run` from this invocation.
- `--model` unset, `PLURNK_MODEL` set → pass `PLURNK_MODEL` on every `loop.run`.
- Neither set → omit `alias`; daemon falls back to its own boot-time provider.

`PLURNK_MODEL` is shared with the daemon process; env vars represent user-level preferences, not per-process namespaces. Both processes reading the same name for the same intent is the point.

Unknown aliases return a clear error from the daemon (the `PLURNK_MODEL_<alias>=...` entry is missing on the daemon side). Discoverability is via `providers.list` (RPC; not currently surfaced as a client subcommand).

### §1.3 Project root and persona

**Project root** is the absolute path the daemon's `file://` scheme uses as the workspace boundary for that session. Stored on `sessions.project_root` (per plurnk-service migration 015); NULL = headless (file ops 400 with "session has no project_root").

Client behavior:

- Default: `process.cwd()` — the user's current directory.
- Override: `--project-root <abs-path>` or `PLURNK_PROJECT_ROOT`.
- Explicit headless: set to empty string (`--project-root=`) → wire as `null`.
- Sent on `session.create` only. On `--session` attach, the daemon preserves the stored value and the client's flag is silently ignored (no surprise overwrites of a session you're resuming). To change a live session's root, call `session.set_root` directly — not yet surfaced as a client command.

**Persona** is the text/markdown identity prompt the daemon plumbs into `packet.system.persona`. Set per-call on `loop.run({persona})`.

Client behavior:

- Default: omitted; daemon uses its own `persona.md` baseline.
- Override: `--persona <path>` or `PLURNK_PERSONA`, both pointing to a file. Contents are read once at startup and passed on every `loop.run` for the invocation.
- File-only (no literal-text mode): personas are typically long markdown; quoting them on the command line is hostile. If you need a quick literal, write a one-line `.md` file.
- A missing/unreadable file is a fatal startup error (exit 1) — better to fail loudly than to silently drop the persona.

---

## §2 One-shot mode

Triggered when a prompt is present from positionals, piped stdin, or both.

### §2.1 Output channels

Standard Unix discipline: **stdout is the program's product, stderr is its narration.**

- **stdout** — the body of the *terminal* broadcast SEND (status 200 or 499), per §5.4. Exactly one value per invocation (none if the loop hit maxTurns and never terminated). Intermediate broadcasts (SEND[102] etc.) are protocol mechanics, not the answer, and do NOT appear on stdout.
- **stderr** — session/prompt header, per-action trace lines (including intermediate broadcasts), summary line, error messages.

Consequence:

- `plurnk "X" > answer.txt` captures just the terminal answer.
- `plurnk "X" 2>/dev/null` suppresses the trace.
- A TTY user sees both interleaved as before (the terminal merges streams).
- `plurnk "X" | tool` pipes only the answer.
- `plurnk --json "X" | jq` pipes the answer as a valid JSON value.

### §2.2 Flow

1. Open WebSocket to `PLURNK_URL`.
2. Resolve session per §1.1 (`session.create` or `session.attach`); write `session:` and `prompt:` lines to stderr.
3. Subscribe to `log/entry` notifications; per-action trace lines go to stderr. The terminal broadcast SEND body (status 200 or 499) goes to stdout (§5.4); intermediate broadcasts do not.
4. `rpc.call("loop.run", { prompt })` → receive `{loopId, turnIds, finalStatus, hitMaxTurns}`.
5. Write summary line (turns count, wall time, final status, token usage if available) to stderr.
6. Close WebSocket.
7. Exit with the appropriate code (§4).

### §2.3 What one-shot mode does NOT do

- No interactive prompts during the loop (proposal review prompts are separate; see §6).
- No `op.parse` (raw DSL) — that's TUI-only.
- No reconnect on dropped connection. Connection drop = exit with error.

---

## §3 TUI mode

Triggered when `argv` has no positional prompt.

### §3.1 Flow

1. Open WebSocket; resolve session per §1.1 (`session.create` or `session.attach`); subscribe to `log/entry`.
2. Print banner; enter readline loop with `> ` prompt.
3. Each line entered is dispatched:
    - Lines starting with `<<` → `rpc.call("op.parse", { text })`. Raw DSL execution; useful for hand-crafted ops.
    - Anything else → `rpc.call("loop.run", { prompt })`. Standard prompt-driven loop.
4. While a dispatch is in flight, additional input is rejected with a "busy" notice.
5. `Ctrl-C` or `EOF` exits cleanly.

### §3.2 Cancellation

`Ctrl-C` during an in-flight dispatch calls `loop.cancel` (plurnk-service SPEC §13.5) — the daemon aborts the run's active drain, the pending `loop.run` resolves with `finalStatus: 499`, and the REPL continues. A second `Ctrl-C` (or `Ctrl-C` while idle) closes the readline interface — the escape hatch for dispatches a drain-cancel can't unblock (`op.parse`).

CLI mode mirrors this: first `Ctrl-C` cancels (the loop resolves 499 → exit 3 per §4); second `Ctrl-C` force-exits 3.

---

## §4 Exit codes

| Code | Meaning |
|---|---|
| `0` | Loop terminated successfully (`finalStatus === 200`) |
| `1` | Runtime error (WebSocket failure, RPC error, daemon crash, etc.) |
| `2` | Loop hit `maxTurns` safety cap (`hitMaxTurns === true`) |
| `3` | Loop terminated with cancellation (`finalStatus === 499`) |
| `64` | Usage error (missing required env var, unrecognized flag) |

TUI mode always exits `0` on clean shutdown; loop outcomes are surfaced in the summary line, not the exit code.

---

## §5 Rendering

### §5.1 `log/entry` line format

One line per dispatched op. Format (vanilla ANSI, no framework):

```
  <glyph> <origin> <status> <op> <target>  <body-preview>
```

Width-tolerant; no fixed column widths. The status code drives color. Op glyphs and origin glyphs are defined in `TUI.md §4`.

**Exception:** broadcast SEND (op == `SEND` with `target_scheme === null`) is rendered as a multi-line block per §5.4, not as a single trace line.

### §5.2 Summary line (per `loop.run`)

```
  <tag> · <N> turns · <wall>ms · <tokens> tokens
```

`tag` is a status glyph (✅ for 200, ⏳ for 102 continue, ✋ for 499 cancel, etc.). Color matches status.

### §5.3 What is NOT rendered

- The full packet (`turn.packet`). The client never displays the rendered index, log section, or telemetry — those are the model's view, not the user's.
- Raw bodies for non-broadcast ops. Broadcast SEND body IS rendered (§5.4); other op bodies surface only via `entry.read` / `<<READ(log://...)>>`.
- Raw RPC frames. Set `DEBUG=plurnk:rpc` (future) to enable.
- Content fetching from streaming channels. Client renders `stream/event` and `stream/concluded` notifications as one-line metadata traces (`📡 stream/event exec://ls channel=stdout state=active len=1234`) on stderr (CLI) / waterfall (TUI); fetching the actual channel content via `entry.read` is the consumer's job. See §8.7.

### §5.4 Broadcast SEND rendering

A broadcast SEND (`op === "SEND" && target_scheme === null`) is the model's reply to the user. It is content, not telemetry, and the client MUST render the full body verbatim.

TUI mode contract (see TUI.md §3.4.1 for design rationale):

- Header line: `  <origin-glyph> ✉️  <sub-glyph> <status>` — 2-space INDENT matching the trace lines, no PATH. Origin glyph column-aligns across waterfall and broadcast.
- Body: split on `\n`, each line prefixed with five spaces (3 more than the header), no ellipsis, no dim.
- Surrounded by one blank line above and one blank line below.
- Empty body is legal and renders as just the header.

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
- **Markdown** — `raw` matches structural markdown markers (heading `# `, bold `**…**`, list `- `, fenced code ` ``` `, or `[text](url)` link). Minimal vanilla-ANSI transform: bold, italic, dim inline code, `• ` bullets, header text bolded.
- **Plain (or anything else)** — emit `raw` verbatim.

If `tx.body` is null, or `tx.body.raw` is absent or non-string, the body is treated as empty (stdout receives nothing for that broadcast).

---

## §6 Proposal review

Side-effecting operations (file writes, exec) emit a `loop/proposal` notification when the daemon pauses dispatch awaiting human resolution (per plurnk-service SPEC §13). The client receives the notification, presents the proposal to the user, and sends back `loop.resolve({logEntryId, decision, body?, outcome?})`.

### §6.1 Notification shape

```ts
loop/proposal {
    logEntryId: number,           // pending log_entries row
    loopId, turnId: number,
    op: "EDIT" | "EXEC" | ...,
    target: { scheme: string | null, pathname: string | null },
    body: string,                 // udiff for EDIT; command summary for EXEC
    attrs: object,                // scheme-specific payload (opaque to client)
    flags: object,                // loop's persisted flags ({yolo, noProposals, ...})
}
```

**Server-resolved proposals.** When `flags.yolo` (server-side YOLO auto-accept) or `flags.noProposals` (server-side auto-reject) is set, the daemon settles the entry in-process before any human can react — the notification is informational. The client skips review UI entirely and sends no `loop.resolve` (which would race the already-settled proposal). The proposed-then-resolved lifecycle still shows in the `log/entry` waterfall.

### §6.2 Review menu (interactive)

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

### §6.3 `--yolo` / `PLURNK_YOLO`

Client-side opt-in. When set, the proposal handler skips the menu and immediately sends `loop.resolve({decision: "accept", outcome: "client_yolo"})`. The proposal notification still goes over the wire (the daemon is unaware that the client auto-accepted).

This is distinct from **server-side YOLO** (`loop.run({flags: {yolo: true}})`, plurnk-service §13.5), where the daemon auto-accepts proposals in-process without client involvement — intended for benchmarks and automation, not routine client UX. The client does not expose a flag for it; its only obligation is the §6.1 suppression: a proposal carrying `flags.yolo` gets no review UI and no `loop.resolve`.

### §6.4 Fail-closed (non-TTY, no yolo)

When stdin is not a TTY and `--yolo` is not set, the client cannot interactively review. To avoid stalling on the daemon's 5-minute resolution timeout, the handler immediately sends:

```
loop.resolve({decision: "reject", outcome: "no_tty_review"})
```

Use cases this protects: `plurnk "X" > answer.txt`, `plurnk "X" | tool`, scripted invocations without `--yolo`. The model sees the reject in the next turn's telemetry and can adapt or terminate.

### §6.5 What proposal review does NOT do

- Concurrent proposals. The daemon pauses one dispatch per proposal; at most one proposal is pending per loop at any time. Client handles them sequentially as they arrive.
- Patch validation. The client does not parse the udiff. `body` is treated as opaque text for display and (when edited) re-submission.
- Persisting decisions. Each proposal is reviewed in isolation; no "always accept this scheme" memory.

---

## §7 Subcommands

Read-only subcommands inspect daemon state without running a loop. They share the same connection and session-resolution machinery as the prompt-driven flow, but skip `loop.run` entirely. All support `--json` for machine-readable output (stdout product per §2.1; trace and errors stay on stderr).

When `argv[0]` (after flag parsing) matches a known subcommand verb, the dispatcher routes there instead of assembling a prompt. Unknown subcommands exit `64`.

### §7.1 `plurnk models`

Lists registered provider/model aliases via the daemon's `providers.list` RPC. No session is attached (no `requiresInit`).

Default output: a column-aligned table of `alias / provider / model / active`. The `active` column carries a `*` for the alias the daemon resolved as its boot-time `PLURNK_MODEL`. With `--json`: emits `aliases` array verbatim as compact JSON.

### §7.2 `plurnk session list`

Lists sessions on the daemon via `session.list`. No prior attach required.

Default output: a column-aligned table of `name / project_root / created / cost`. Null `project_root` renders as `(headless)`. Cost is formatted from pico-USD to human-readable.

With `--json`: emits `sessions` array verbatim.

### §7.3 `plurnk session runs <name>`

Lists runs within a named session via `session.runs`. Resolves `<name>` to a session id via a `session.list` filter; no attach required. Exits `1` if the name is unknown or ambiguous.

Default output: a column-aligned table of `name / created / cost`. With `--json`: emits `runs` array verbatim.

Typical use: discover a run name to pass as `--run` on `plurnk log read`.

### §7.4 `plurnk log read`

Reads log entries from an attached session's run via `log.read`. **Requires `--session <name>`** (exit `64` if unset) — the log is a per-run artifact and the client must know which to read. `--run <name>` selects a specific run within the session (defaults to a fresh auto-named run on attach, which is usually not what you want — pass `--run` when reading historic logs).

Filter flags (all numeric, all optional):

| Flag | Maps to | Meaning |
|---|---|---|
| `--loop <id>` | `loopId` | Limit to one loop |
| `--turn <id>` | `turnId` | Limit to one turn |
| `--since <id>` | `sinceId` | Entries with id > sinceId (incremental fetch) |
| `--limit <n>` | `limit` | Cap entries (daemon default 100, max 1000) |

Default output: one trace line per entry, same format as CLI-mode trace (`[<status>] <origin> <op>[<sub>] <path>`). With `--json`: emits `entries` array verbatim.

### §7.5 What subcommands do NOT do

- Send prompts. They never call `loop.run`.
- Mutate state (yet). Future write subcommands (e.g. `plurnk session rename`) would be a separate addition.
- Honor flags that only matter to loop runs (`--model`, `--persona`, `--yolo`) — those parse without error but have no effect in subcommand mode.

---

## §8 Errors and telemetry

Every user-visible error — client-side flag validation, RPC failures, daemon-pushed runtime signals — uses the same shape: the `TelemetryEvent` envelope from `@plurnk/plurnk-grammar` 0.17.0 (`schema/TelemetryEvent.json`). The client is one speaker among many (grammar, engine rails, schemes, providers); it isn't a passive renderer of *their* errors, it emits its own in the same vocabulary.

### §8.1 Shape

```ts
interface TelemetryEvent {
    source: string;           // lowercase, optionally colon-namespaced
    kind: string;             // discriminator within source
    message?: string | null;  // optional terse string
    position?: ContentOffset | LogCoordinate | null;
    hints?: string[];         // client-side convention; rendered as continuation lines
    [key: string]: unknown;   // open at the kind-specific field layer
}
```

`source` follows the pattern `^[a-z]+(:[a-z][a-z0-9-]*)?$`. Daemon producers: `grammar`, `engine:rail`, `scheme:<name>`, `provider:<vendor>`. Client producers: `client:connection`, `client:flag`, `client:subcommand`, `client:proposal`, `client:io`, `client:rpc`, `client:runtime`.

### §8.2 Rendering

`renderTelemetryEvent(event)` produces a single multi-line string with:

```
  📡 <source>:<kind> [<position>] ["<message>"]
       <snippet lines, if any>
       <hint lines, if any>
```

- **2-space indent** matches the trace-line waterfall (§5.1).
- **📡 glyph** is the universal telemetry marker; it sits in the same column as the op-glyph slot on trace lines.
- **Position** renders inline as `L<line> col<column>` for `ContentOffset`, `<coordinate>` (with `(op)` suffix when present) for `LogCoordinate`.
- **Message** appears in quotes after the discriminator/position.
- **Snippet** (`event.snippet`, used by grammar:parse_error) renders as a 5-space-indented block; the `N:\t`-prefixed content from the daemon is preserved verbatim.
- **Hints** are a client-side convention (not in the grammar schema) for actionable nudges — e.g. "Is the daemon running?" on connection refused. They render as dim 5-space-indented continuation lines below the headline.

### §8.3 Channel posture

- **CLI mode**: stderr. Same channel as the log/entry trace per §2.1.
- **TUI mode**: inline in the waterfall on stdout, with the `\r\x1b[2K` line-wipe prefix so the readline prompt doesn't collide with the rendered event.

In both modes events interleave with `log/entry` trace lines and proposal-review prompts; the glyph is the visual cue that an event is telemetry rather than an action trace.

### §8.4 Client-source events

Client-side errors that previously surfaced as ad-hoc `plurnk:` strings now flow through the same shape via `src/telemetry.ts` helpers:

| Source | Kind(s) | When |
|---|---|---|
| `client:connection` | `refused`, `closed` | WebSocket couldn't open / dropped mid-call |
| `client:flag` | `invalid`, `missing_dependency` | Flag value malformed / requires another flag |
| `client:subcommand` | `session_not_found`, `session_ambiguous`, `unknown_verb`, `missing_argument` | Subcommand dispatch / validation |
| `client:proposal` | `no_tty_review` | Fail-closed reject in CLI without `--yolo` |
| `client:io` | `persona_read_failed` | `--persona` file unreadable |
| `client:rpc` | `error` | Daemon-returned RPC error surfaced verbatim |
| `client:runtime` | `error` | Generic fallback for unstructured throws |

Each helper (e.g. `clientConnectionRefused(url, cause)`) builds a well-formed event with kind-specific fields populated. Callers don't hand-shape JSON.

### §8.5 `TelemetryError` for control flow

A `TelemetryError extends Error` class carries an event through normal async error propagation. Deep throws (`attachOrCreateSession`, `resolveProjectRoot`, `parseIntFlag`) wrap a built event; the global catch in `dispatcher.ts` unwraps, renders, and exits with the carried `exitCode` (default 64 for usage errors; override per call). Non-`TelemetryError` throws collapse to a generic `client:runtime:error`.

### §8.6 Daemon `telemetry/event` notification

The client subscribes to `telemetry/event` in both modes and routes received events through the same renderer. Notification shape per plurnk-service SPEC §15.1:

```
telemetry/event { loopId: number, event: TelemetryEvent }
```

Daemon-side producers as of plurnk-service 0.11.0:
- `grammar:parse_error` — model emitted invalid DSL; `position: ContentOffset`, `snippet: string` with offending content.
- `engine:rail:strike` / `cycle` / `sudden_death` / `no_ops` / `max_commands_exceeded` — engine-rail signals during loop.run; structured fields only, no human-readable message.
- `engine:rail:action_failure` — `position: LogCoordinate`, optional scheme-emitted error.
- `engine:rail:budget_overflow` — assembled packet exceeded the budget ceiling; `hidden: [{scheme, count}]` lists the entries the grinder moved out of the window (plurnk-service §14.4).

Future producers (`scheme:<name>`, `provider:<vendor>`) land as siblings adopt the protocol.

### §8.7 `stream/event` and `stream/concluded`

The daemon also broadcasts streaming-channel metadata as `stream/event` and `stream/concluded` notifications (per plurnk-service SPEC §7.1 / §13.6). These are NOT `TelemetryEvent`-shaped — they're plain content-growth signals — but the client uses the same `📡` glyph and rendering channel so the user gets one visual cue for "daemon pushed something."

```
stream/event     { entryId, target, channel, state, contentLength }
stream/concluded { entryId, target, subscriptionId, scheme, closeStatus, summary, wakeAction, wakeLoopId? }
```

`target` is the entry's URI (`scheme://pathname`, plurnk-service #179) — clients route on it without an entryId→URI lookup. Both render as one-line traces:

```
  📡 stream/event exec://ls -la channel=stdout state=active len=1234
  📡 stream/concluded exec://ls -la status=200 wake=opened-loop "ls -la done"
```

CLI mode writes to stderr; TUI mode interleaves in the waterfall with the prompt-wipe prefix. **The client does not fetch the actual streamed content** — that's not the CLI's job. Consumers who want the body (e.g. `plurnk.nvim`) call `entry.read` themselves.

### §8.8 What this is NOT

- **Severity filtering** — the kind discriminator IS the signal. No `--verbose` / `--quiet-telemetry` flag in v0.4.0; add when volume bites.
- **Categorization or interpretation** — per the dumb-client principle, the client doesn't decide that `engine:rail:strike` means "your model is in trouble" or rewrite messages for readability. Producer-side intelligence stands.
- **Replacement for exit codes** — SPEC §4 exit codes remain orthogonal. The event renders; the exit code propagates.
- **Telemetry transport** — events render to the user; they do NOT get re-shipped anywhere else. The daemon-side `packet.user.telemetry.events[]` (what the model sees) is separate from the client-side notification stream.

---

## §9 Conformance

A conforming `plurnk` client:

1. Speaks JSON-RPC 2.0 over WebSocket per plurnk-service SPEC §13.
2. Connects to the URL in `PLURNK_URL` (or its default).
3. Resolves the session per §1.1 (`session.create` by default, or `session.attach` when `--session`/`PLURNK_SESSION` is set); uses the returned session for all subsequent RPCs until disconnect.
4. Subscribes to `log/entry` notifications and renders each per §5.1.
5. Subscribes to `loop/proposal` notifications and resolves each via `loop.resolve` per §6, skipping server-resolved proposals (`flags.yolo` / `flags.noProposals`) entirely.
6. Subscribes to `telemetry/event` notifications and renders each through the unified telemetry shape per §8.
7. Maps `loop.run` results to exit codes per §4.
8. Emits its own user-visible errors as `TelemetryEvent` (source `client:*`) routed through the same renderer per §8.

---

## §10 Out of scope

- Multi-daemon connections. One client, one daemon.
- Authentication / TLS. Local-loopback only; auth is a plurnk-service concern with its own design pass.
- Direct provider access. The client never talks to OpenAI/Anthropic/etc.; the daemon owns provider integration.
- Direct grammar parsing. The client emits raw DSL only via `op.parse` (which delegates to the daemon's parser); it does not parse locally.

When any of these becomes in-scope, file an issue and update this SPEC.
