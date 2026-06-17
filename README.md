# plurnk

Terminal client for [plurnk-service](https://github.com/plurnk/plurnk-service) — type a prompt, drive a real model loop through the plurnk DSL. CLI one-shot, interactive TUI, and read-only subcommands over one WebSocket.

## install

```
npm install -g @plurnk/plurnk          # bundles the daemon (optional dep)
export OPENAI_API_KEY="…"              # your provider keys (read by the daemon)
plurnk-service                          # start the background daemon
```

The client only needs the daemon reachable at `PLURNK_URL` (default `ws://127.0.0.1:3044`). All engine config — models, turns, providers — lives in the daemon's environment.

## use

```
plurnk "what is the capital of France?"      # one-shot
cat notes.md | plurnk "summarize this"        # piped stdin (appended)
plurnk                                         # interactive TUI (no args, a TTY)
plurnk models | session list | log read …      # read-only subcommands
plurnk --help                                  # full flag list
```

**Line language** (converged across the TUI, the CLI prefixes, and plurnk.nvim's `:AI`):

| | |
|---|---|
| `text` | a prompt (`?`=ask / `:`=act prefix) |
| `/verb` | `/models /sessions /runs /log /model /yolo /new /stop /quit`, membership `/pick /hide /view /drop /members`, `/import <path>` |
| `<<…>>` | raw plurnk DSL (`op.parse`) |
| `! cmd` | exec via the daemon |
| `... text` | inject into the running loop (or just type — a mid-loop prompt steers) |

Tab completes verbs, model aliases, file paths (`/pick`, `@file`), and DSL ops (`<<RE`→`<<READ`). Multi-line paste folds to one prompt.

**Key flags:** `--model <alias>` · `--yolo` · `--json` · `--session/--run <name>` · `--project-root <p>` · `--max-turns <n>` · `--timeout <s>` · membership `--pick/--hide/--view <glob>` · `--manifest-items <n>` · `--md NAME=path`.

**Env:** `PLURNK_URL` (daemon) · `PLURNK_SESSION` / `PLURNK_RUN` (resume) · `PLURNK_MODEL` · `PLURNK_YOLO` · `PLURNK_PROJECT_ROOT`. Cascade: shell > `./.env` > `$XDG_CONFIG_HOME/plurnk/env`.

## what plurnk is

The model emits operations in a compact grammar; the daemon executes them, persists state, and the client renders the trace:

```
<<EDIT[france,europe](known://countries/france/capital):Paris:EDIT
<<SEND[200]:Paris:SEND
```

Multi-turn loops emerge from the structure — `SEND[102]` continues, `SEND[200]` terminates — fancy agent behavior on weak models via grammar rather than raw capability. See [plurnk-service](https://github.com/plurnk/plurnk-service).

## exit codes (CLI mode)

`0` success (`SEND[200]`) · `1` runtime error · `2` maxTurns cap · `3` cancelled (`SEND[499]` / `--timeout`) · `4` loop failed (4xx/5xx final) · `64` usage error.

## license

MIT.
