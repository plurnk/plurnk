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
plurnk [options] [prompt...]
plurnk [options]            # TUI mode (no prompt)
```

Options:

| Flag | Type | Meaning |
|---|---|---|
| `-h`, `--help` | flag | Print usage, exit 0 |

Env:

| Var | Default | Meaning |
|---|---|---|
| `PLURNK_URL` | `ws://127.0.0.1:3044` | Daemon WebSocket URL |

`.env` is auto-loaded if present; explicit shell exports override.

---

## §2 One-shot mode

Triggered when `argv` includes a positional prompt.

### §2.1 Flow

1. Open WebSocket to `PLURNK_URL`.
2. `rpc.call("session.create")` → receive `{id, name}`.
3. Subscribe to `log/entry` notifications; print each via `renderLogEntry` (one ANSI line per action).
4. `rpc.call("loop.run", { prompt })` → receive `{loopId, turnIds, finalStatus, hitMaxTurns}`.
5. Print summary line (turns count, wall time, final status, token usage if available).
6. Close WebSocket.
7. Exit with the appropriate code (§4).

### §2.2 What one-shot mode does NOT do

- No interactive prompts. Stdin is not read.
- No `op.parse` (raw DSL) — that's TUI-only.
- No reconnect on dropped connection. Connection drop = exit with error.

---

## §3 TUI mode

Triggered when `argv` has no positional prompt.

### §3.1 Flow

1. Open WebSocket; `session.create`; subscribe to `log/entry`.
2. Print banner; enter readline loop with `> ` prompt.
3. Each line entered is dispatched:
    - Lines starting with `<<` → `rpc.call("op.parse", { text })`. Raw DSL execution; useful for hand-crafted ops.
    - Anything else → `rpc.call("loop.run", { prompt })`. Standard prompt-driven loop.
4. While a dispatch is in flight, additional input is rejected with a "busy" notice.
5. `Ctrl-C` or `EOF` exits cleanly.

### §3.2 Future: cancellation

`Ctrl-C` during an in-flight loop.run should send `SEND[499]` to the loop's URI to request cancellation. Not implemented in v0; current `Ctrl-C` just closes the readline interface.

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

### §5.2 Summary line (per `loop.run`)

```
  <tag> · <N> turns · <wall>ms · <tokens> tokens
```

`tag` is a status glyph (✅ for 200, ⏳ for 102 continue, ✋ for 499 cancel, etc.). Color matches status.

### §5.3 What is NOT rendered

- The full packet (`turn.packet`). The client never displays the rendered index, log section, or telemetry — those are the model's view, not the user's.
- Raw RPC frames. Set `DEBUG=plurnk:rpc` (future) to enable.
- Stream events between turn boundaries (`stream/event` notifications). Future feature; not in v0.

---

## §6 Conformance

A conforming `plurnk` client:

1. Speaks JSON-RPC 2.0 over WebSocket per plurnk-service SPEC §13.
2. Connects to the URL in `PLURNK_URL` (or its default).
3. Calls `session.create` at boot of each invocation; uses the returned session for all subsequent RPCs until disconnect.
4. Subscribes to `log/entry` notifications and renders each per §5.1.
5. Maps `loop.run` results to exit codes per §4.
6. Surfaces RPC errors verbatim to stderr; does not swallow.

---

## §7 Out of scope

- Persistent sessions across invocations. Each run gets a fresh session; persistence is a future feature.
- Multi-daemon connections. One client, one daemon.
- Authentication / TLS. Local-loopback only; auth is a plurnk-service concern with its own design pass.
- Direct provider access. The client never talks to OpenAI/Anthropic/etc.; the daemon owns provider integration.
- Direct grammar parsing. The client emits raw DSL only via `op.parse` (which delegates to the daemon's parser); it does not parse locally.

When any of these becomes in-scope, file an issue and update this SPEC.
