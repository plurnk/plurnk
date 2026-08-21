# plurnk

A terminal client for [plurnk-service](https://github.com/plurnk/plurnk-service). Type a prompt, drive a real model loop through the plurnk DSL — a compact grammar where the model emits operations, the daemon executes them against real workspaces, and the client renders the trace. CLI one-shot, interactive TUI, and state commands share ONE wire: AG-UI+ (the daemon's sole client surface).

Plurnk gets its power from structure, not raw model capability: the grammar forces disciplined multi-turn loops, real receipts for every operation, and a budget the model can actually see and manage. Fancy agent behavior on weak models.

## install

Try it instantly — zero install, npx fetches both (always latest):

```
export PLURNK_API_KEY="…"                # your plurnk key (optional! works with everything.)
npx @plurnk/plurnk-service start         # daemon — terminal 1
npx @plurnk/plurnk "what is 2+2?"        # client — terminal 2
```

Or install for keeps:

```
npm install -g @plurnk/plurnk           # the client — lean, a pure AG-UI+ consumer
npm install -g @plurnk/plurnk-service   # the daemon — its own (lean) install story
plurnk-service                          # start the background daemon
```

The client never starts a daemon. It POSTs runs/actions to the daemon's module at `http://PLURNK_HOST:PLURNK_PORT` (default `127.0.0.1:3044`). All engine config — models, providers, turns — lives in the daemon's environment.

## use

```
plurnk                                       # interactive TUI (no args, a TTY)
plurnk "what is the capital of France?"      # one-shot — bare answer on stdout
plurnk --json "…" | jq -r .response          # json mode: ONE complete record document
plurnk --workspace project mcp enable gitea  # activate project-specialized config
cat notes.md | plurnk "summarize this"       # piped stdin (appended)
plurnk models | workspace list | log read …  # inspect daemon state
plurnk reasoning high --workspace my-work   # persist worker reasoning policy
plurnk --help                                # full flag list
```

**Two output modes.** Default: stdout is the bare answer, stderr the trace — `plurnk "X" > a.txt` captures just the answer. `--json` (or `PLURNK_CLIENT_JSON`): one complete structured document on stdout (`response` + `turns[].ops` + `notices` + the daemon's exact `usage.accounting` envelope), stderr silent, failures as RFC 9457 Problems under `{"problem":…}`. Op *content* isn't inlined — fetch it on demand with `plurnk read <coord>`. The CLI is the integration layer: shell out, parse — no protocol client to build.

Readable provider reasoning appears as a distinct `💭` trace before the paired
SEND. It comes from AG-UI's standard reasoning events; PLAN remains the model's
durable public work inventory.

**Line language** (converged across the TUI, the CLI prefixes, and plurnk.nvim's `:AI`):

| | |
|---|---|
| `text` | a prompt (`?`=ask / `:`=act prefix) |
| `/verb` | `/models /workspaces /workers /log /model /child /reasoning /yolo /workspace [name] /worker [name] /rename <name> /stop /quit`, membership `/pick /hide /view /drop /members`, `/import <path>`, workspace MCP `/mcp`, and universal Agent Skills `/skills` |
| `! cmd` | exec via the daemon |

**Key flags:** `--model <selector>` · `--reasoning <policy>` · `--yolo` (client auto-accept) · `--auto` (loop authority) · `--json` · `--workspace/--worker <name>` · `--project-root <p>` · `--max-turns <n>` · `--timeout <s>` · membership `--pick/--hide/--view <glob>` · `--files-items <n>` · `--md NAME=path`.

## what plurnk is

From the model's perspective, plurnk is an operating environment, not a bag of tools: the log is its address space, the materialized packet is its working set, and the OPs are a small, stable system-call vocabulary over heterogeneous resources.

The model emits operations in a compact grammar; the daemon executes them, persists state, and the client renders the trace:

```
# PLAN0
Update the capital, then answer.

## EDIT0 [+france,+europe] (worker:///countries/france/capital)
Paris

## SEND0 [200]
Paris
```

Multi-turn loops emerge from the structure — `## SEND0 [102]` continues, `## SEND0 [200]` terminates. Every operation returns a real receipt; the model reads them and plans the next turn. The full grammar and its rationale live in [plurnk-service](https://github.com/plurnk/plurnk-service) (`plurnk-contracts/plurnk.md` — the model-facing contract).

What the daemon brings to those turns:

- **Private by default** — the embedding model and the per-model tokenizer vocabularies are bundled and offline. No network, no vendor sees your files.
- **One language, not a tool catalog** — explore and transform the environment with globs, regex, jsonpath, xpath, and cosine similarity, all in the same grammar. The model learns one interface instead of dozens of schemas.
- **A real environment** — a filesystem jail per project (configurable to any security posture, including none); `~phrase` FIND runs semantic search against the embedded model; the packet shows the model exactly what every row costs, from token-accurate budgets.
- **Curation, not compaction** — no context-compaction algorithms, no garbage collection. The model `FOLD`s and `OPEN`s (or `KILL`s) log items by address, usually in bulk patterns: no helper model knows what's relevant better than the model itself.
- **Topology on demand** — the model forks sister subagents, spawns children, or fires bare one-shot requests, shaping its own graph; parent and child endpoints can be different models, for cheap orchestrator-driven workflows.
- **Rails & recovery** — GBNF grammar constraints keep low-end models reliable; the model-managed context optimizes tiny KV footprints; structured failure recovery keeps extended runs alive on modest models.
- **Interop** — universal Agent Skills, and MCP hosting (stdio, remote HTTP, interactive OAuth, client credentials); attached tools materialize in the model's discovery surface like native ones.
- **Forensics** — every run is reproducible: per-op receipts, structured notices, and the daemon's digest with full packet capture.

## configuration

**Env cascade** (the client's side): packaged `.env.defaults` floor < `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env` < project `./.env` < repeated `--env-file` flags (last wins) < shell. `plurnk-service config defaults` prints the complete owner-labelled catalog on demand.

**Client env:** `PLURNK_HOST`/`PLURNK_PORT` (the daemon's one client surface, default `127.0.0.1:3044`; `PLURNK_AGUI_URL` overrides for a remote portal) · `PLURNK_CLIENT_WORKSPACE` / `PLURNK_CLIENT_WORKER` · `PLURNK_CLIENT_YOLO` · `PLURNK_AUTO` · `PLURNK_CLIENT_PROJECT_ROOT`.

**Models** are daemon-side. A worker durably owns its selected route; `--model` and `/model` accept either a declared alias or an exact `provider/model` selector and persist it without adding model policy to subsequent loops. `plurnk models [search]` and `/models [search]` query the daemon's bounded catalog only when requested. Provider credentials and the `PLURNK_MODEL` default live in the daemon's environment — the client never holds a key or guesses readiness.

**Skills:** `/skills` lists project skills; `/skills add|remove|find|update` delegates to the standard `npx skills` CLI with its `universal` target. Project skills live in `.agents/skills`; global skills live in `~/.agents/skills`.

**MCP:** project-local `PLURNK_MCP_*` declarations accompany `/mcp` and `plurnk mcp enable`; the daemon remains their sole parser and activation owner. See the plurnk-mcp docs in plurnk-service for the declaration shapes (npx servers, remote endpoints, `_TOOLS`/`_READ` policies).

## troubleshooting & forensics

- `plurnk read <loop>/<turn>/<seq> --json` — inspect the exact operation result at a log coordinate.
- `--json` mode carries `notices` and `usage.accounting` — cost and diagnostics without a UI.
- Exit codes: `0` success (`## SEND0 [200]`) · `1` runtime error · `2` maxTurns cap · `3` cancelled (`## SEND0 [499]` / `--timeout`) · `4` loop failed (4xx/5xx final) · `64` usage error.
- Deeper forensics (per-turn packet capture, the budget grinder's records, edit receipts) live in the daemon's digest — see plurnk-service's README.

## related

- [plurnk-service](https://github.com/plurnk/plurnk-service) — the daemon, contracts, and grammar authority
- [plurnk.nvim](https://github.com/plurnk/plurnk.nvim) — Neovim-integrated Plurnk client (`:AI`)
- [SPEC.md](SPEC.md) — the client's behavioral contract; [TUI.md](TUI.md) — terminal design rationale

## license

MIT. Standards-oriented, not lock-in: the client speaks AG-UI, the tooling surface is MCP2, and the whole stack is open source.
