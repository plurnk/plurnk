# plurnk

A terminal client for [plurnk-service](https://github.com/plurnk/plurnk-service). Type a prompt, drive a real model loop through the plurnk DSL — a compact grammar where the model emits operations, the daemon executes them against real workspaces, and the client renders the trace. One-shot CLI, scrollback-native interactive terminal, and Neovim integration share ONE wire: AG-UI+ (the daemon's sole client surface).

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

The client never starts a daemon. It POSTs runs/actions to the daemon's module at `http://PLURNK_HOST:PLURNK_PORT` (default `127.0.0.1:1066`). All engine config — models, providers, turns — lives in the daemon's environment.

## use

```
plurnk                                       # interactive terminal (no args, a TTY)
plurnk "what is the capital of France?"      # one-shot — bare answer on stdout
plurnk --json "…" | jq -r .response          # json mode: ONE complete record document
plurnk --workspace project mcp enable gitea  # activate project-specialized config
cat notes.md | plurnk "summarize this"       # piped stdin (appended)
plurnk models | workspace list | log read …  # inspect daemon state
plurnk reasoning high --workspace my-work   # persist worker reasoning policy
plurnk web --workspace my-work              # foreground browser client (optional package)
printf '# Result\n\n| a | b |\n| - | - |' | plurnk render --width 80
plurnk --help                                # full flag list
```

`plurnk render` is a daemon-free stdin/stdout filter for clients that want the
terminal client's width-aware GFM and Beautiful Mermaid projection as plain Unicode.

`plurnk web` loads an already installed `@plurnk/plurnk-web` presentation
module after the normal client has resolved its complete environment cascade.
The browser uses `/<workspace>/<threadId>` URLs: without configured constraints
it can create or select many workspaces and Workers; configured workspace or
Worker values lock only their respective coordinates. The web package receives
a safe resolved projection rather than duplicating configuration parsing. The
command never downloads a package or starts the daemon.
Install the optional client with
`npm install -g @plurnk/plurnk-web`.

To run both sibling working trees without publishing either package, build the
web checkout and link it into the client checkout:

```sh
cd ../plurnk-web
npm install
npm run build

cd ../plurnk
npm install
npm link --no-save --package-lock=false ../plurnk-web
npm run build
./bin/plurnk.js web --yolo --model=fireox
```

**Two output modes.** Default: stdout is the bare answer, stderr the trace — `plurnk "X" > a.txt` captures just the answer. On a terminal, one replaceable status row shows authoritative lifecycle, durable model, packet count, and current activity; indexing repaints at most every 15 seconds and redirected stderr omits routine progress history. `--json` (or `PLURNK_CLIENT_JSON`): one complete structured document on stdout (`response` + `turns[].ops` + `notices` + the daemon's exact `usage.accounting` envelope), stderr silent, failures as RFC 9457 Problems under `{"problem":…}`. Op *content* isn't inlined — fetch it on demand with `plurnk read <coord>`. The CLI is the integration layer: shell out, parse — no protocol client to build.

The one-shot CLI is the pipeline surface, the interactive terminal is a
readline-style main-buffer conversation with real multiline editing, and
plurnk.nvim is a native editor surface. None is a protocol intermediary for
another; each speaks AG-UI+ directly.

Readable provider reasoning appears as a distinct `💭` trace before the paired
SEND. It comes from AG-UI's standard reasoning events; PLAN remains the model's
durable public work inventory.

**Line language** (converged across the TUI, the CLI prefixes, and plurnk.nvim's `:AI`):

| | |
|---|---|
| `text` | a prompt (`?` denies EXEC and keeps proposal review; `:` is ordinary) |
| `/verb` | `/help /models /workspaces /workers /log` · `/model /child /reasoning /capabilities /yolo` · `/workspace /rename /worker` · `/mcp /skills /agents /members` · `/import /script /editor` · `/accept /reject /cancel /edit /stop /quit` |
| `! cmd` | exec via the daemon |

**Key flags:** `--model <selector>` · `--reasoning <policy>` · `--policy <json>` · `--capabilities <json>` · `--yolo` (client auto-accept) · `--auto` (loop authority) · `--json` · `--workspace/--worker <name>` · `--project-root <p>` · `--max-turns <n>` · `--timeout <s>` · `--files-items <n>` · `--md NAME=path`.

## what plurnk is

From the model's perspective, plurnk is an operating environment, not a bag of tools: the log is its address space, the materialized packet is its working set, and the OPs are a small, stable system-call vocabulary over heterogeneous resources.

The model emits operations in a compact grammar; the daemon executes them, persists state, and the client renders the trace. An action turn:

```
# PLAN0
[{"content":"Update the capital, then answer.","status":"in_progress"}]
## EDIT0 (worker:///countries/france/capital)
Paris
## SEND0 (NEXT)
Next: Confirm the update, then answer.
```

Then its completion turn:

```
# PLAN0
[{"content":"The capital is updated and confirmed.","status":"completed"}]
## SEND0 (TERM)
Paris
```

Multi-turn loops emerge from the structure — `## SEND0 (NEXT)` continues, `## SEND0 (TERM)` terminates. Every operation returns a real receipt; the model reads them and plans the next turn. The full grammar and its rationale live in [plurnk-service](https://github.com/plurnk/plurnk-service) (`plurnk-contracts/plurnk.md` — the model-facing contract).

What the daemon brings to those turns:

- **Private by default** — the embedding model and the per-model tokenizer vocabularies are bundled and offline. No network, no vendor sees your files.
- **One language, not a tool catalog** — explore and transform the environment with globs, regex, jsonpath, xpath, and cosine similarity, all in the same grammar. The model learns one interface instead of dozens of schemas.
- **A real environment** — a filesystem jail per project (configurable to any security posture, including none); `~phrase` FIND runs semantic search against the embedded model; the packet shows the model exactly what every row costs, from token-accurate budgets.
- **Curation, not compaction** — no context-compaction algorithms, no garbage collection. The model `KILL`s superseded log items or selected ranges by address, usually in bulk patterns; the corresponding source material survives log curation.
- **Topology on demand** — the model forks sister subagents, spawns children, or fires bare one-shot requests, shaping its own graph; parent and child endpoints can be different models, for cheap orchestrator-driven workflows.
- **Rails & recovery** — GBNF grammar constraints keep low-end models reliable; the model-managed context optimizes tiny KV footprints; structured failure recovery keeps extended runs alive on modest models.
- **Interop** — universal Agent Skills, and MCP hosting (stdio, remote HTTP, interactive OAuth, client credentials); attached tools materialize in the model's discovery surface like native ones.
- **Forensics** — every run is reproducible: per-op receipts, structured notices, and the daemon's digest with full packet capture.

## configuration

**Env cascade** (the client's side): packaged `.env.defaults` floor < `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env` < project `./.env` < repeated `--env-file` flags (last wins) < shell. `plurnk-service config defaults` prints the complete owner-labelled catalog on demand.

**Client env:** `PLURNK_HOST`/`PLURNK_PORT` (the daemon's one client surface, default `127.0.0.1:1066`; `PLURNK_AGUI_URL` overrides for a remote portal) · `PLURNK_CLIENT_WORKSPACE` / `PLURNK_CLIENT_WORKER` · `PLURNK_CLIENT_YOLO` · `PLURNK_AUTO` · `PLURNK_CLIENT_PROJECT_ROOT` · `PLURNK_CLIENT_LOOP_POLICY` · `PLURNK_CLIENT_WORKSPACE_CAPABILITIES`.

**Capabilities** use the daemon's one subtractive policy contract at every scope. `--capabilities` applies a workspace ceiling at creation; `plurnk capabilities [json]` and `/capabilities [json]` inspect the service/workspace/inherited/Worker cascade or replace its mutable Worker layer; `--policy` supplies the complete per-loop policy. Child Workers inherit the parent's effective ceiling and may only narrow it.

**Models** are daemon-side. A worker durably owns its selected route; `--model` and `/model` accept either a declared alias or an exact `provider/model` selector and persist it without adding model policy to subsequent loops. `plurnk models [search]` and `/models [search]` query the daemon's bounded catalog only when requested. Provider credentials and the `PLURNK_MODEL` default live in the daemon's environment — the client never holds a key or guesses readiness.

**Agents:** `/agents` lists this Worker's outbound A2A agents; `/agents discover <url>|add <alias> <url> [options.json]|enable|disable|remove` are the daemon's common Functionality actions; an enabled agent is `a2a://<alias>` to the model.

**Skills:** `/skills` lists this Worker's Agent Skills; `/skills discover|add <name> <source> [--global]|enable|disable|remove` are the daemon's common Functionality actions — the client runs no package manager. Project skills live in `.agents/skills`; global skills live in `~/.agents/skills`.

**Members:** `/members` lists this Worker's file members — what the model may see; `/members discover <path|glob>|add <alias> <glob>|enable|disable|remove` are the daemon's common Functionality actions. Git-tracked files are members on their own; a gitignore-style glob adds untracked files, and a leading `!` excludes matching members.

**MCP:** project-local `PLURNK_MCP_*` declarations accompany `/mcp` and `plurnk mcp enable`; the daemon remains their sole parser and activation owner. See the plurnk-mcp docs in plurnk-service for the declaration shapes (npx servers, remote endpoints, `_TOOLS`/`_READ` policies).

## troubleshooting & forensics

- `plurnk read <loop>/<turn>/<seq> --json` — inspect the exact operation result at a log coordinate.
- `--json` mode carries `notices` and `usage.accounting` — cost and diagnostics without a UI.
- Exit codes: `0` success (`## SEND0 (TERM)`) · `1` runtime error · `2` maxTurns cap · `3` cancelled (`## SEND0 (FAIL)` / `--timeout`) · `4` loop failed (4xx/5xx final) · `64` usage error.
- Deeper forensics (per-turn packet capture, the budget grinder's records, edit receipts) live in the daemon's digest — see plurnk-service's README.

## related

- [plurnk-service](https://github.com/plurnk/plurnk-service) — the daemon, contracts, and grammar authority
- [plurnk.nvim](https://github.com/plurnk/plurnk.nvim) — Neovim-integrated Plurnk client (`:AI`)
- [SPEC.md](SPEC.md) — the client's behavioral contract; [TUI.md](TUI.md) — terminal design rationale

## license

MIT. Standards-oriented, not lock-in: the client speaks AG-UI, the tooling surface is MCP2, and the whole stack is open source.
