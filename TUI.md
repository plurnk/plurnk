# plurnk — Client Surface Design

`plurnk` is a thin client for `plurnk-service`. It speaks the RPC defined in plurnk-service SPEC.md §13 over a WebSocket and renders the daemon's log waterfall.

Two invocation modes share the same RPC client:

- **CLI** (`plurnk "prompt"`) — one-shot: connect → `loop.run` → render notifications until terminal → disconnect → exit. Standard Unix tool posture.
- **TUI** (`plurnk` no args) — interactive REPL: connect once, accept prompts and DSL fragments at a readline prompt, render `log/entry` notifications live, ctrl-c to exit.

v0 scope is "minimum viable fiddle": enough surface for the user to interactively exercise a real agent so observed behavior informs plurnk-service design decisions.

This document is the client-side reference. The wire protocol is plurnk-service SPEC §13; this document does NOT redefine it.

---

## §1 RPC client (shared substrate)

`src/rpc.ts` — a minimal WebSocket JSON-RPC client. Reused by both CLI and TUI modes.

### §1.1 Responsibilities

- Connect to `ws://<host>:<port>` (default `127.0.0.1:3044`).
- Send JSON-RPC requests with auto-incrementing `id`; correlate responses by `id`.
- Dispatch incoming notifications to subscriber callbacks per method name.
- Surface protocol errors verbatim; no swallowing.

### §1.2 API shape

```ts
class Rpc {
    constructor({ url, signal });
    async connect(): Promise<void>;
    async call(method: string, params?: object): Promise<unknown>;
    onNotification(method: string, handler: (params: unknown) => void): void;
    async close(): Promise<void>;
}
```

No retry logic. No queue. Connection lost = client tells user, exits cleanly. Reconnect on next invocation. Local-daemon model expects high uptime; retry semantics added if real-world friction surfaces.

### §1.3 Transport substrate

`ws` npm package, matching the daemon. Single connection, full-duplex. Each `ws.send` is one JSON-RPC envelope.

---

## §2 CLI mode (one-shot, Unix-tool posture)

### §2.1 Invocation

```
plurnk "what is the capital of france"
plurnk what is the capital of france             # quotes optional
git diff | plurnk "summarize this"               # positional + piped stdin (concatenated)
cat question.md | plurnk                         # piped stdin alone
plurnk -h
plurnk --help
```

Prompt assembly: positional args first, then piped stdin (separated by a blank line). Either source alone is fine; if neither is present and stdin is a TTY, TUI mode triggers instead.

No flair. No glyphs in CLI mode. No progress bars. Plain text, suitable for piping.

### §2.2 Output channels

Standard Unix discipline: stdout is the program's product, stderr is its narration.

- **stdout** — the body of the *terminal* broadcast SEND (status 200 or 499). One value per invocation. Intermediate broadcasts (SEND[102] etc.) are protocol mechanics, not the answer.
- **stderr** — session/prompt header, per-action trace lines (including intermediate broadcasts), summary block, errors.

This is what makes `plurnk "X" > answer.txt` capture just the answer. A TTY user sees both interleaved because the terminal merges streams.

`--json` flips the stdout format: terminal broadcast emitted as exactly one JSON value (`JSON.stringify(json)` if the body parsed as JSON, else `JSON.stringify(raw)` to wrap the prose as a JSON string literal). No double-wrap, no envelope key naming — `jq` works either way.

SPEC.md §2.1 / §5.4 are the canonical contracts.

### §2.3 Flow

```
1. Parse argv; assemble prompt from positionals.
2. Construct Rpc({ url: PLURNK_URL || ws://127.0.0.1:3044 }).
3. Connect.
4. Resolve session: session.create (default) or session.attach when
   --session/PLURNK_SESSION is set. See SPEC.md §1.1.
5. Subscribe to `log/entry` notification — trace each action to stderr;
   for the terminal broadcast SEND, also write the body content to stdout.
6. Call `loop.run({ prompt, maxTurns?, alias? })`. `alias` from `--model`/`PLURNK_MODEL` (see SPEC.md §1.2). Wait for response.
7. Write summary block (final status, turn count, wall time) to stderr.
8. Disconnect. Exit with code matching the final status.
```

### §2.4 Exit codes

| Code | Meaning                                  |
|------|------------------------------------------|
| 0    | Loop terminated with status 200 (success)|
| 1    | Connection / protocol / internal error   |
| 2    | Loop hit maxTurns cap                    |
| 3    | Loop terminated with another status      |

### §2.5 What CLI mode does NOT do

- Multiple prompts in one invocation (use TUI for that — but re-invoking with `--session=<name>` resumes daemon state across calls).
- Live glyph rendering (TUI's job).
- Session attachment (each invocation gets an auto-created session per §13.7).
- JSON output mode (future, if scripting needs it).

---

## §3 TUI mode (interactive REPL)

When invoked with no positional args, `plurnk` enters TUI mode. Vanilla Node ANSI escape codes + `node:readline`. No widget framework.

### §3.1 Substrate philosophy

The "TUI" is a glyph-prefixed REPL — not a full-screen app with split panes and box drawing. Output streams to stdout line-by-line; the terminal's own scrollback owns history; readline manages the prompt at the bottom. No virtual scroll buffer to manage; no full-screen takeover; no resize handling complexity.

Under the hood, it's a long-lived WebSocket connection to the daemon, subscribed to `log/entry` notifications, with each readline submission firing either `loop.run` (if the input is a prompt) or `op.dispatch` (if the input is raw DSL).

### §3.2 Input dispatch

Each line entered at the readline prompt:

- **Starts with `<<`** — treat as a raw DSL fragment. Parse via `@plurnk/plurnk-grammar`, fire `op.dispatch` for each statement in turn.
- **Otherwise** — treat as a prompt. Fire `loop.run`.

This gives the user direct ops AND prompt-driven loops at the same surface. Mistake-resistant: if the model emits DSL and you copy-paste it back as a prompt, the parser catches the `<<` prefix and you get the right behavior.

### §3.3 Interaction shape

```
$ plurnk
plurnk v0.1.0 · daemon ws://127.0.0.1:3044 · session 47 · ctrl-c to quit

> what is the capital of france
  🤖 ✏️  201  known://france/capital  "Paris"

  🤖 ✉️ ✅ 200
     The capital of France is Paris.

  done · 1 turn · 0.4s · 142 tokens

> show me what's in the index
  🤖 🔍  200  known://**  → 2 results

  🤖 ✉️ ✅ 200
     I found 2 entries: known://france/capital and known://animals/cat.

  done · 1 turn · 0.3s · 89 tokens

> ^C
$
```

The user's direct DSL dispatch (line 2) shows origin 👤 (client) instead of 🤖 (model), making manual ops visually distinct in the waterfall.

### §3.4 Line format

```
INDENT ORIGIN OP [SUB] STATUS PATH  EXTRA
```

| Field    | Source                              | Example                                  |
|----------|-------------------------------------|------------------------------------------|
| INDENT   | Two spaces (visual offset from `>`) | `  `                                     |
| ORIGIN   | `log_entries.origin` glyph          | 🤖 model / 👤 client / ⚙️ system / 🔌 plugin |
| OP       | Op glyph from §4                    | ✏️ EDIT / 📖 READ / 🔍 FIND / etc.        |
| SUB      | Sub-status glyph for SEND only      | ✅ 200 / 🗑 410 / ✋ 499 / ⚠️ 4xx / 🔥 5xx |
| STATUS   | HTTP status code, 3 digits          | `201`, `404`, `200`                      |
| PATH     | Full URI as typed by the source     | `known://france/capital`                 |
| EXTRA    | Op-specific short context           | `"Paris"` (EDIT) / `→ 1 result` (FIND)   |

EXTRA examples per op:

- **EDIT**: first ~40 chars of body in quotes, ellipsis if longer
- **READ**: nothing (content surfaced via separate `read` call if requested)
- **COPY/MOVE**: `→ <destination URI>`, or `(deleted)` for null-body MOVE
- **FIND**: `→ N results`
- **SHOW/HIDE**: nothing (state change is the message)
- **SEND** (broadcast): does NOT use this one-line format — see §3.4.1
- **SEND** (directed): `→ <recipient>` and the action implied by SUB
- **EXEC**: first ~40 chars of command, ellipsis if longer

### §3.4.1 Broadcast SEND (model → user)

A SEND with no target URI is the model's reply to the user. It is the only op whose payload IS content rather than telemetry, and the only op a human reader consumes as conversation rather than as a trace. It deliberately breaks the one-op-one-line discipline of the waterfall.

**Conversation stripes (v0.7.0; user half revised v0.9.2).** Model speech carries a full-width dark-blue band (`48;5;17`; 102/200/499 alike) so the dialogue pops against the operation grid — painted to the right edge via `\x1b[K`, self-contained foreground, theme-safe. The user's half is the line they typed at the prompt: once plurnk-service#198 made the prompt entry broadcast live, banding it duplicated every prompt, and erasing the typed echo would mean terminal-row math over emoji/nerdfont widths — the rabbit hole this client refuses by policy. The user's typed line is the indented `  : <text>` echo — deliberately glyph-free. The pre-rendered-row experiment (prompt = `  👤 ✉️  ✅ 201 : `) failed in real terminals within hours: readline's per-refresh cursor repositioning uses its own emoji width count, and the disagreement with the terminal's rendering shifted the typed text on every history-nav/backspace. Emoji in OUTPUT are safe (no cursor math); emoji in the PROMPT are not. The lesson is now policy. Model = blue band, user = their own aligned line, which stands out precisely by being the only glyph-anchored UNBANDED line.

**Stripes stay scarce (policy).** The contrast economy is: one band (model speech, blue), one deliberate absence (the user's `👤 :` line), everything else is plain dim field. Banding more categories turns the waterfall into a quilt — when everything is a stripe, stripeless stops signifying, and the eye is back to parsing glyphs instead of seeing color mass. Telemetry already carries its 📡 discriminator; streams live in their own splits; neither gets paint.

Format:

```
<blank line>
  ORIGIN OP SUB STATUS
     <body line 1>
     <body line 2>
     …
<blank line>
```

Differences from the trace line:

- **Same 2-space INDENT as trace lines.** Origin glyphs column-align across waterfall and broadcast so the reader's eye tracks the speaker continuously.
- **No PATH.** Broadcast is pathless by definition.
- **No ellipsis on the body.** Full content rendered verbatim; terminal handles soft-wrap.
- **Body indented 5 spaces** (3 more than the header) under the speaker glyph, no dim. It's content; styling it like metadata would be wrong.
- **Surrounding blank lines.** One above, one below. Breathing room separates conversation from telemetry.

Example:

```
  🤖 ✏️  201  known://france/capital  "Paris"

  🤖 ✉️ ✅ 200
     The capital of France is Paris.

  done · 1 turn · 0.4s · 142 tokens
```

The body source is `entry.tx.body`, a `SendBody` object (`{ raw, json }` per `plurnk-grammar/schema/SendBody.json`), not a plain string. The TUI dispatches by content type — this is a TUI convenience and does NOT apply to CLI mode, which emits `raw` verbatim:

- If `tx.body.json !== null` → pretty-printed JSON (`JSON.stringify(json, null, 2)`).
- Else if `raw` carries markdown markers (`#`, `**…**`, `- `, ` ``` `, links) → minimal vanilla-ANSI transform (bold, italic, dim inline code, `• ` bullets).
- Else → `raw` verbatim.

Anything not detected as JSON or markdown falls through to plain. Empty body or null body is legal and renders as just the header. See SPEC.md §5.4 for the canonical contract.

### §3.5 Summary line (per `loop.run`)

```
done · 1 turn · 0.4s · 142 tokens
maxTurns · 50 turns · 18.2s · 6,841 tokens
error · 1 turn · 0.1s · provider 503
```

No summary for individual `op.dispatch` invocations — the op line itself is the summary.

### §3.6 Key bindings (v0, minimal)

| Key      | Behavior                                          |
|----------|---------------------------------------------------|
| Enter    | Submit current input as prompt or DSL             |
| Ctrl-C   | Cancel current run if one is active; exit if idle |
| Ctrl-D   | Exit (EOF on input)                               |
| Ctrl-L   | Clear screen and reprint the welcome banner       |

Up-arrow history is future work. Session persistence has its own design questions (which session to attach to? list and pick?).

### §3.7 Color palette (proposed; TBD on user review)

Subtle ANSI, terminal-respecting:

| Element             | ANSI                                  |
|---------------------|---------------------------------------|
| Welcome banner      | `\x1b[2m` (dim)                       |
| Prompt `>`          | default (no styling)                  |
| User input          | default                               |
| Op line (default)   | default                               |
| Path (URI)          | `\x1b[36m` (cyan)                     |
| Status 2xx          | `\x1b[32m` (green)                    |
| Status 3xx, 102     | `\x1b[33m` (yellow)                   |
| Status 4xx          | `\x1b[31m` (red, default brightness)  |
| Status 5xx          | `\x1b[1;31m` (bright red)             |
| Summary line        | `\x1b[2m` (dim)                       |
| EXTRA (body excerpt)| `\x1b[2m` (dim)                       |

Respect `NO_COLOR=1` (Unix convention) — when set, all styling is skipped; only glyphs and plain text remain.

### §3.8 What is NOT shown in v0

- Per-channel content for non-broadcast ops (e.g. full READ payloads). Broadcast SEND body IS rendered per §3.4.1 — that's the conversation, not telemetry. Full bodies for other ops remain accessible via `<<READ(log://<L>/<T>/<A>)>>` or the `entry.read` RPC.
- Index/visibility state. Future inspector pane.
- Token cost breakdown. Future `--verbose` summary.
- Reasoning/thinking content. Future toggle.
- Multi-session/run navigation. Each invocation auto-attaches to an ephemeral session.

---

## §4 Glyph palette (canonical for the constellation)

Universal across all plurnk clients (TUI, CLI, neovim, Telegram, web). Mimetype glyphs are normative per plurnk-service SPEC §4.1. Op / status / origin glyphs are conventional; this document is the canonical reference.

### §4.1 Op glyphs

| Op    | Glyph |
|-------|-------|
| FIND  | 🔍    |
| READ  | 📖    |
| EDIT  | ✏️    |
| COPY  | 📋    |
| MOVE  | 📦    |
| SHOW  | ➕    |
| HIDE  | ➖    |
| SEND  | ✉️    |
| EXEC  | ⚙️    |

### §4.2 SEND sub-status glyphs

| Status range | Glyph | Meaning                              |
|--------------|-------|--------------------------------------|
| 102          | ⏳    | Processing (open subscription)       |
| 2xx          | ✅    | Success / terminal                   |
| 410          | 🗑    | Gone / delete                        |
| 499          | ✋    | Cancel                               |
| 4xx (other)  | ⚠️    | Client error                         |
| 5xx          | 🔥    | Server / handler error               |

### §4.3 Origin glyphs

| Origin | Glyph |
|--------|-------|
| model  | 🤖    |
| client | 👤    |
| system | ⚙️    |
| plugin | 🔌    |

### §4.4 Mimetype glyphs

Per plurnk-service SPEC §4.1, every mimetype handler declares its own `glyph`. Currently locked in the bundled set:

| Mimetype          | Glyph |
|-------------------|-------|
| text/plain        | 📄    |
| text/markdown     | 📝    |
| application/json  | 🗂    |
| text/vnd.plurnk   | 📜    |

Used when the TUI surfaces channel content (future feature — entry inspector). Not part of the v0 op-line format.

---

## §5 Implementation order

Sequential per user direction. Each item is its own PR; the next gated on the previous landing.

1. **plurnk-service `feat/daemon`** — implements SPEC §13: WebSocket server (`ws`), JSON-RPC dispatch, method registration with metadata, `discover`, `ping`, `session.*`, `loop.run`, `op.dispatch`, `entry.read`, `log.read`, `log/entry` and `loop/terminated` notifications, the client-loop envelope, auto-create-on-demand session/run. `bin/plurnk-service.js` gains a `start` subcommand running the daemon. Auto-flag-derivation from `.env.example` lands here too.
2. **plurnk `feat/rpc-client`** — `src/rpc.ts` implementing §1. Independent of TUI/CLI logic. Tested standalone against the daemon.
3. **plurnk `feat/cli-rewrite`** — `src/cli.ts` becomes a thin wrapper using `src/rpc.ts`. `src/run.ts` is gutted (no more in-process engine; daemon owns that). One-shot flow per §2.
4. **plurnk `feat/tui`** — `src/tui.ts` implementing §3 against `src/rpc.ts`. Glyph waterfall renderer (`src/render.ts`). REPL loop with input-dispatch logic per §3.2.

Floor-scope work in plurnk-service continues in parallel — different files, no conflict.

---

## §6 Open questions for user review

1. **Color palette in §3.7.** Anything to redirect? Specific terminals you optimize for?
2. **Op glyph picks in §4.1.** Settled in prior conversation. Anything still feel wrong?
3. **Input dispatch heuristic (§3.2).** `<<` prefix detection for DSL vs prompt — is that the right discriminator, or should there be an explicit toggle (e.g., `/dsl` prefix, or a `--mode` key binding)?
4. **CLI `loop/entry` rendering.** Should one-shot CLI mode (§2) also render glyph-prefixed lines for live feedback, just without the REPL prompt? Or stay text-only as currently described?
