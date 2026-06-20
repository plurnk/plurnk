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
| `--json` | flag | CLI mode only (or `PLURNK_JSON`). json OUTPUT MODE: one complete record document on stdout, stderr silent, structured errors. See §2.1 / §5.5. |
| `--session <name>` | string | Resume the named session. See §1.1. Overrides `PLURNK_SESSION`. |
| `--run <name>` | string | Resume (or create) the named run within the session. Requires `--session`. Overrides `PLURNK_RUN`. See §1.1. |
| `--model <alias>` | string | Model alias passed on every `loop.run`. See §1.2. Overrides `PLURNK_MODEL` for this invocation. |
| `--project-root <path>` | string | Absolute path passed as `projectRoot` on `session.create`. See §1.3. Overrides `PLURNK_PROJECT_ROOT`. |
| `--yolo` | flag | Auto-accept every proposal locally without prompting. See §6. Overrides `PLURNK_YOLO`. |
| `--flags <json>` | string | Raw LoopFlags JSON passthrough on every `loop.run` (e.g. `'{"yolo":true}'` for server-side YOLO in benchmark/automation runs). Mode is not a flag — see the prompt prefixes (§2.0). |
| `--max-turns <n>` | string | Per-loop turn cap (daemon default `PLURNK_MAX_TURNS`). |
| `--timeout <s>` | string | CLI mode only: cancel the loop via `loop.cancel` after `<s>` seconds; exits 3 with `"timedOut":true` in the result envelope. |
| `--pick <glob>` | string, repeatable | Membership overlay: admit files git misses (the sole source when headless). Maps to a `pick` constraint. Create-time / session-level. See §1.4. |
| `--hide <glob>` | string, repeatable | Membership overlay: drop a tracked match. Maps to a `hide` constraint. See §1.4. |
| `--view <glob>` | string, repeatable | Membership overlay: admit a member read-only. Maps to a `view` constraint. See §1.4. |
| `--manifest-items <n>` | string | Session-open preview: `-1` full / `0` off / `N` first-N items of `plurnk://manifest.json` at turn 0. Create-time only. See §1.4. |
| `--md <name=path>` | string, repeatable | Pin a markdown doc into the session (read at turn 0). Reads the local file and sends its content; unions with the operator's `PLURNK_MD_*` (client wins a collision). Create-time only. See §1.4. |

Env:

| Var | Default | Meaning |
|---|---|---|
| `PLURNK_WS` | `ws://127.0.0.1:3044` | Daemon WebSocket URL |
| `PLURNK_SESSION` | _unset_ | Session name to resume. Equivalent to `--session`. |
| `PLURNK_RUN` | _unset_ | Run name to resume/create. Equivalent to `--run`. Requires `PLURNK_SESSION`. |
| `PLURNK_MODEL` | _unset_ | Model alias. Shared with the daemon (both processes read it for the same intent — see §1.2). Equivalent to `--model`. |
| `PLURNK_PROJECT_ROOT` | _unset → cwd_ | Absolute path used as session `projectRoot` on creation. Equivalent to `--project-root`. See §1.3. |
| `PLURNK_YOLO` | _unset_ | When truthy (`1`/`true`/`yes`/`on`), auto-accept every proposal locally. Client-only — see §6. Equivalent to `--yolo`. |

**Cascading env (shared `~/.plurnk` home with plurnk-service).** Highest precedence first: shell exports → `--env-file` / `--env-file-if-exists` (node-native; `--env-file` requires the file, the other skips a missing one) → project `./.env` → `~/.plurnk/.env` → `~/.plurnk/.env.example` (the floor plurnk-service ships and copies on first run). All layers optional; the client works with no config at all. The client reads exactly ONE knob from this shared home — `PLURNK_WS` (which daemon to reach) — and ships no `.env.example` of its own; the floor and everything else there are the daemon's.

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

### §1.3 Project root

**Project root** is the absolute path the daemon's `file://` scheme uses as the workspace boundary for that session. Stored on `sessions.project_root` (per plurnk-service migration 015); NULL = headless (file ops 400 with "session has no project_root").

Client behavior:

- Default: `process.cwd()` — the user's current directory.
- Override: `--project-root <abs-path>` or `PLURNK_PROJECT_ROOT`.
- Explicit headless: set to empty string (`--project-root=`) → wire as `null`.
- Sent on `session.create` only. On `--session` attach, the daemon preserves the stored value and the client's flag is silently ignored (no surprise overwrites of a session you're resuming). To change a live session's root, call `session.set_root` directly — not yet surfaced as a client command.

The "inject standing context into every loop" role formerly served by persona is now `--md`/`mdDocs` (§1.4): markdown docs pinned into the session and read at turn 0.

### §1.4 Membership overlay and session-open settings

These flags shape what the session sees. The membership overlay flags map to **constraints** (service vocabulary, svc#200); the settings flags map to **session-open settings** (svc#231). All are creation-time / session-level.

**Membership overlay** — repeatable glob flags, sent as `constraints` on `session.create`:

- `--pick <glob>` → `{effect: "pick", glob}` — admit files git misses (the sole source when headless).
- `--hide <glob>` → `{effect: "hide", glob}` — drop a tracked match.
- `--view <glob>` → `{effect: "view", glob}` — admit a member read-only.

Seeded atomically at `session.create` so turn-1's manifest is right with no follow-up RPC. On `--session` attach, each constraint is applied **live** via `session.constrain` (session-scoped, re-resolved immediately).

**Session-open settings** — sent as `settings` on `session.create`:

- `--manifest-items <n>` → `manifestItems`. Controls the `plurnk://manifest.json` preview at turn 0: `-1` full / `0` off / `N` first-N items. Must be `-1`, `0`, or a positive integer (else exit 64). Replaces the operator's `PLURNK_MANIFEST_ITEMS` for the session.
- `--md <name=path>` → `mdDocs` (`[{alias, content}]`). Pins a markdown doc into the session, read at turn 0. The client reads each file from its **own** local fs (co-location law — correct, not a workaround) and sends `content`, not a path. Relative paths resolve against cwd; an unreadable file is a usage error (exit 64). Unions with the operator's `PLURNK_MD_*` (client wins a collision). Repeatable.

Settings are **session-create-only** (no live setter). On `--session` attach, `--manifest-items`/`--md` are flagged and skipped — the client prints a dim notice and ignores them.

---

## §2 One-shot mode

Triggered when a prompt is present from positionals, piped stdin, or both.

### §2.0 Prompt prefixes (converged with plurnk.nvim and the TUI)

The prompt's first character carries the same habits as nvim's `:AI` and the TUI line: `plurnk "? question"` runs a read-only loop (`flags.mode="ask"`), `": text"` forces act, and `plurnk "! command"` execs via the daemon — op.exec, stream to conclusion, exec stdout→stdout / stderr→stderr, exit by closeStatus (0/3/4). A prefix wins over a `--flags` mode.

### §2.1 Output channels

Standard Unix discipline: **stdout is the program's product, stderr is its narration.** There are two OUTPUT MODES, selected by `--json` / `PLURNK_JSON` — not a flag on one output, but two distinct contracts:

**text mode (default):**
- **stdout** — the body of the *terminal* broadcast SEND (status 200 or 499), per §5.4. Exactly one value per invocation (none if the loop hit maxTurns and never terminated). Intermediate broadcasts (SEND[102] etc.) are protocol mechanics, not the answer, and do NOT appear on stdout.
- **stderr** — session/prompt header, per-action trace lines (including intermediate broadcasts), summary line, error messages.

**json mode (`--json` / `PLURNK_JSON`):**
- **stdout** — ONE complete document and nothing else (§5.5): the whole client-observed record of the run — `schemaVersion`, `response` (the answer, top-level for `jq -r .response`), `finalStatus`, `turns: [{turn, ops: [{coord, op, origin, target, status, signal}]}]`, `telemetry`, `usage`, exit metadata. On failure it is `{"schemaVersion", "error": {kind, message, …}}` — valid JSON either way, paired with the exit code.
- **stderr** — silent.
- **NOT inlined:** op *content* (file bodies, exec output). Under co-location the consumer reads the file directly or fetches one op on demand with `plurnk read <coord> --json` (§7) — the same OPEN/FOLD discipline the engine runs on. `--json` carries the record, not the content.

Consequence:

- `plurnk "X" > answer.txt` captures just the terminal answer.
- `plurnk "X" 2>/dev/null` suppresses the trace.
- A TTY user sees both interleaved as before (the terminal merges streams).
- `plurnk "X" | tool` pipes only the answer.
- `plurnk --json "X" | jq -r .response` pulls the answer; `… | jq .turns` the structured trace. One document, no stderr archaeology — the CLI is the integration layer, no third-party client needed for basic needs.

### §2.2 Flow

1. Open WebSocket to `PLURNK_WS`.
2. Resolve session per §1.1 (`session.create` or `session.attach`); write `session:` and `prompt:` lines to stderr.
3. Subscribe to `log/entry` notifications; per-action trace lines go to stderr. The terminal broadcast SEND body (status 200 or 499) goes to stdout (§5.4); intermediate broadcasts do not.
4. `rpc.call("loop.run", { prompt })` → receive `{loopId, turnIds, finalStatus, hitMaxTurns}`.
5. **text mode:** write summary lines to stderr (final status, turns/wall/tokens); stdout stays the pure answer. **json mode:** emit the one complete record document on stdout (§5.5); stderr stayed silent throughout. (The old greppable `result:` stderr envelope is retired — json mode is the machine path now.)
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
2. Print banner; enter readline loop with the `  <coord>🐹 💬 ✅ 201 : ` prompt — the user's waterfall row, coordinate-prefixed (the coordinate the typed line will get; §5.1), pre-rendered, restricted to WIDTH-STABLE glyphs. Settled empirically in two rounds: `✉️` (U+2709+VS16) drifted the cursor one column on terminals that cell-count VS16 sequences as 1 (readline repositions at its own computed width on every refresh) and is banned; `🐹`/`✅` are plain East-Asian-Wide (width 2 in node and every major terminal) and stay, `💬` (stable-wide) fills the op slot. The `201` is a contract constant (the prompt row is always a 201 EDIT). The `: ` flips to `? ` when an ask-default toggle exists. **Prompt glyph policy: no VS16/width-ambiguous sequences, ever**; output lines render anything — no cursor positioning happens on output.
3. Each line entered is dispatched:
    - Lines starting with `/` → command verbs (one vocabulary with nvim's `:AI/`): `/help /models /sessions /runs /log [n] /model <alias> /yolo /session [name] /run [name] /rename <name> /stop /quit`, plus membership verbs `/pick <glob> /hide <glob> /view <glob> /drop <glob> /members` (§1.4) and `/import <path>` (§3.3). Singular verbs CREATE, plural verbs LIST: `/session [name]` opens a fresh session (rebinds the connection in place, §13.5-rebind), `/sessions` lists; `/run [name]` forks a new run (`run.fork`), `/runs` lists; `/rename <name>` retargets the session's mutable handle (a run's name is immutable). Verbs never call `loop.run`; inspect verbs reuse the §7 subcommand tables; membership verbs apply live via `session.constrain`/`session.unconstrain`; `/stop` and `/help` stay reachable while a loop is in flight. Tab completion (readline completer, no screen takeover) covers verbs and `/model` aliases, **file paths** (after `/pick`/`/hide`/`/view`/`/import` and bare `@file` tokens), **DSL ops** (`<<RE` → `<<READ`), and DSL target paths.
    - Lines starting with `<<` → `rpc.call("op.parse", { text })`. Raw DSL execution; useful for hand-crafted ops.
    - Lines starting with `!` → `rpc.call("op.exec", { command })`. Daemon-owned shell; proposal-gated like any side effect.
    - Lines starting with `? ` → `loop.run` with `flags.mode="ask"` (read-only loop); `: ` forces act (the daemon default). Mode is a per-line prefix habit, never a flag — there is no `--ask`; `--flags '{"mode":"ask"}'` is the generic passthrough for automation.
    - Lines starting with `...` → `loop.inject` — speak into a running loop without starting a new one (the "btw" steering case).
    - Anything else → `rpc.call("loop.run", { prompt })`. Standard prompt-driven loop.
4. While a dispatch is in flight, additional input is rejected with a "busy" notice (except `/stop`, `/help`, and a bare `...`/`?`/`:` prompt, which injects).
5. `Ctrl-C` or `EOF` exits cleanly.

### §3.2 Cancellation

`Ctrl-C` during an in-flight dispatch calls `loop.cancel` (plurnk-service SPEC §13.5) — the daemon aborts the run's active drain, the pending `loop.run` resolves with `finalStatus: 499`, and the REPL continues. A second `Ctrl-C` (or `Ctrl-C` while idle) closes the readline interface — the escape hatch for dispatches a drain-cancel can't unblock (`op.parse`).

CLI mode mirrors this: first `Ctrl-C` cancels (the loop resolves 499 → exit 3 per §4); second `Ctrl-C` force-exits 3.

### §3.3 `/import` and bracketed paste

`/import <path>` reads a **local** file (co-location law — the client reads its own fs, the daemon never sees the path) and stashes its content into the prompt buffer, reusing the paste machinery (§below): a short marker lands in the line and expands to the full content on submit, framed however you type. Relative paths resolve against cwd; an unreadable file prints an error and is a no-op.

**Bracketed paste.** A multi-line paste must become ONE prompt, not one `loop.run` per line. The client filters stdin through a paste filter and feeds readline a `PassThrough`, buffering the paste between the terminal's `?2004` markers so the whole block submits as a single prompt. Stream plumbing only — no cursor/width math.

---

## §4 Exit codes

| Code | Meaning |
|---|---|
| `0` | Loop terminated successfully (`finalStatus === 200`) |
| `1` | Runtime error (WebSocket failure, RPC error, daemon crash, etc.) |
| `2` | Loop hit `maxTurns` safety cap (`hitMaxTurns === true`) |
| `3` | Loop terminated with cancellation (`finalStatus === 499`, including `--timeout`) |
| `4` | Loop FAILED (4xx/5xx terminal status other than 499) — failure ≠ cancel, so benchmark stats stay honest |
| `64` | Usage error (missing required env var, unrecognized flag) |

TUI mode always exits `0` on clean shutdown; loop outcomes are surfaced in the summary line, not the exit code.

---

## §5 Rendering

### §5.1 `log/entry` line format

One line per dispatched op. Format (vanilla ANSI, no framework):

```
  <origin> <op-glyph> <status-glyph> <status> <target>  <body-preview>
```

Width-tolerant; no fixed column widths. The status code drives color; EVERY line carries a status glyph (✅/⏳/❌ from the outcome; SENDs glyph their signal — ✋/💥/⏳ carry meaning; 4xx and 5xx share ❌, nvim-converged: one failure signal in the alignment column, the colored status carries the class). A glyph that exists only sometimes is dissonant (rummy f20c4a0 precedent).

**Coordinate prefix.** Each line opens with the `LL/TT/SS` logical coordinate (loop/turn/sequence, zero-padded min-2), so it's its own `log://` address. Log entries carry it on the wire (§13, loop_seq/turn_seq/sequence); the readline prompt shows the coordinate the typed line WILL get — the next loop's foist EDIT at `<next>/01/01`, advancing as loops complete. Stream lines (`📡`) carry it too — `stream/event`/`stream/concluded` mirror the entry's `loop_seq`/`turn_seq`/`sequence` on the wire (plurnk-service#224), read straight from the payload (never reconstructed from the URI). A stream without a coordinate (a non-exec streaming scheme) renders without one.

**Width-stable glyph palette (both clients).** Every palette glyph is plain East-Asian-Wide — width 2 in node and every major terminal. VS16 variation-selector sequences (✉️ ✏️ ⚙️ ⚠️ 🗑) are banned from the palette entirely: they cell-count differently across terminals, which corrupted readline cursor math in the prompt and produced ragged column gaps in output. Stable widths need no pad-space hacks, so columns align truly. Palette: 🤖 🐹 🧰 🔌 (origins) · 🔍 📖 📝 📋 📦 ➕ ➖ 💬 🔧 (ops) · ⏳ ✅ 💤 🤔 💥 ✋ ❌ (status). Op glyphs and origin glyphs are defined in `TUI.md §4`. Prefer plane-1 emoji (U+1F300+) for any new glyph: BMP "ornament" dingbats with default emoji presentation (e.g. ❓ U+2753) are width-2 in spec but a font may still render them as a width-1 text glyph — `300` was ❓ until a terminal showed it un-emojified, now 🤔.

**Exceptions:** broadcast SEND (op == `SEND` with `target_scheme === null`) is rendered as a multi-line block per §5.4, not as a single trace line. The prompt entry (the engine's system-origin `EDIT` against `plurnk://prompt/<loop>/<turn>` — plurnk-service SPEC §15) is **skipped entirely** in the TUI waterfall: the line the user typed at the readline prompt is already their record, and rendering the broadcast too duplicated every prompt. (Erasing the typed echo instead would require terminal-row math over emoji/nerdfont-width prompts — out of bounds by policy: the TUI stays brutally simple and works on every modern terminal.)

### §5.2 Summary line (per `loop.run`)

```
  <tag> · <N> turns · <wall>ms · <tokens> tokens
```

`tag` is a status glyph (✅ for 200, ⏳ for 102 continue, ✋ for 499 cancel, etc.). Color matches status.

### §5.3 What is NOT rendered

- The full packet (`turn.packet`). The client never displays the rendered index, log section, or telemetry — those are the model's view, not the user's.
- Raw bodies for non-broadcast ops. Broadcast SEND body IS rendered (§5.4); other op bodies surface only via `entry.read` / `<<READ(log://...)>>`.
- Raw RPC frames. Set `DEBUG=plurnk:rpc` (future) to enable.
- Content fetching from streaming channels — with ONE bounded exception. Streams render coalesced: a single start line on the first `stream/event` (`📡 ⏳ <target>`; growth ticks and per-channel closes are silent) and a single conclusion line in the waterfall grammar (`📡 ✅ 200 <target> "<summary>"`, target echo stripped from the summary, `→ woke loop` only when the wake opened one). On conclusion the client makes one `entry.read` and inlines a channel's content only when it is ≤160 chars and ≤2 lines (stderr marked `!`) — at that size the content IS the better optics (a 12-byte exec answer should be visible, not described). Larger outputs remain summary-only; fetching them is the consumer's job. See §8.7.

### §5.4 Broadcast SEND rendering

A broadcast SEND (`op === "SEND" && target_scheme === null`) is the model's reply to the user. It is content, not telemetry, and the client MUST render the full body verbatim.

TUI mode contract (see TUI.md §3.4.1 for design rationale):

- Header line: `  <origin-glyph> ✉️  <sub-glyph> <status>` — 2-space INDENT matching the trace lines, no PATH. Origin glyph column-aligns across waterfall and broadcast.
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

### §6.4 Fail-closed (non-TTY, no yolo) — server-side via `noProposals`

When stdin is not a TTY and `--yolo` is not set, the client cannot interactively review. Rather than reject each proposal client-side, the client runs the loop with `flags.noProposals: true` (plurnk-service #169 server half): the server auto-rejects side-effecting ops in-process, the model sees a plain 400 (mode-blind, no per-proposal roundtrip, no 5-minute hang). The `loop/proposal` still broadcasts; the client suppresses its handler via the server-resolved check (§6.1).

Because the server is silent by design, **the client owns the explanation** — it emits `client:proposal:edits_blocked` once at loop start: "edits and exec blocked: no review channel to approve them (run on a TTY, or pass --yolo)."

Use cases this protects: `plurnk "X" > answer.txt`, `plurnk "X" | tool`, scripted invocations without `--yolo`. A user who passes `--flags '{"noProposals":true}'` sets it explicitly; the no-review-channel detection merges with it.

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
- Honor flags that only matter to loop runs (`--model`, `--yolo`) — those parse without error but have no effect in subcommand mode.

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

`source` follows the pattern `^[a-z]+(:[a-z][a-z0-9-]*)?$`. Daemon producers: `grammar`, `engine:rail`, `scheme:<name>`, `provider:<vendor>`. Client producers: `client:connection`, `client:flag`, `client:subcommand`, `client:proposal`, `client:rpc`, `client:runtime`.

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
| `client:connection` | `refused`, `closed`, `daemon_stale` | WebSocket couldn't open / dropped mid-call / `discover` is missing wire markers this client depends on (daemon older than client) |
| `client:flag` | `invalid`, `missing_dependency` | Flag value malformed / requires another flag |
| `client:subcommand` | `session_not_found`, `session_ambiguous`, `unknown_verb`, `missing_argument` | Subcommand dispatch / validation |
| `client:proposal` | `edits_blocked` | No review channel (non-TTY, no `--yolo`) — loop runs with `noProposals`; client owns the why |
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

`target` is the entry's URI (`scheme://pathname`, plurnk-service #179) — clients route on it without an entryId→URI lookup. Rendering is coalesced per §5.3:

```
  📡 ⏳ exec://python/1/2/1
  📡 ✅ 200 exec://python/1/2/1 "completed (exit 0); stdout=12 bytes, stderr=0 bytes"
     Ulaanbaatar
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
2. Connects to the URL in `PLURNK_WS` (or its default).
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
