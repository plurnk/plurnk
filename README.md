# Plurnk

**The [Bitter Lesson](https://bitterlesson.ai/) applies to the harness, too.**

The model should decide what to remember, where to look, when to delegate, and
how to proceed. Plurnk is an agentic operating system and programming language
that puts those decisions in the model's hands.

Files, tools, and the agent's own context become an addressable environment.
Composable operations let it search that environment, make precise changes,
curate its memory, and build its own delegation topology. The runtime provides
reliable machinery; the model supplies the strategy.

Use local or cloud models to build software, investigate a codebase, or automate
work across tools. Interact from your terminal or editor, or compose Plurnk
with ordinary shell pipelines.

This repository provides the CLI and interactive terminal client for
[plurnk-service](https://github.com/plurnk/plurnk-service), the shared daemon.

## Why Plurnk

- **Curation, not compaction.** The agent retrieves the passages it needs and
  removes stale items or individual lines from its active context. Its working
  set changes; source material and original execution evidence survive.
- **Precision without ceremony.** Line ranges, character regions, and
  hash-anchored edits make surgical changes possible. Stale anchors reject
  conflicting edits before they overwrite the wrong text.
- **The model chooses the topology.** Fork with existing context, start a
  worker with a fresh log, or delegate pure inference without an agent loop.
  Parent and child models can use different endpoints: a cloud model can
  orchestrate local workers through the same primitives.
- **Execution with evidence.** ANTLR parses model output into executable
  operations. The runtime records their results and returns structured errors
  the model can act on. Full packet digests make the work inspectable.
  Compatible local servers can enforce the operation grammar during generation
  with GBNF.

Workspaces and worker conversations live in the daemon, independently of the
client session. Choose your model, context limits, tools, and capability
policies without replacing the environment. No Plurnk account is required.

## Patterns that compose

The pattern engine connects discovery and context management. Path globs
combine with full-text search, regex, JSONPath, XPath, and symbol-graph queries.
The model can search for phrases, inspect structured data, or follow symbol
relationships without writing a script for each question.

For example, these model-side operations find TypeScript files matching
`retry` or `timeout`, then trim older READ receipts to their first 16 lines:

```text
### FIND_ (src/**/*.{ts,tsx})
~retry OR timeout

### KILL_ (log:///1/[1-7]/*/READ) <17,-1>
```

The second operation targets READ results from turns 1–7 of loop 1. It curates
the log, not the source files. One expression can manage many entries: the
agent has bulk operations over its own context, not just over your code.

## Get started

Requires Node.js 26+, npm, Git, and a local or cloud model endpoint.

```sh
npm install -g @plurnk/plurnk @plurnk/plurnk-service
```

In one terminal, configure a model and start the daemon. This example uses
DeepSeek; see [model configuration](https://github.com/plurnk/plurnk-service/blob/main/plurnk-providers/docs/models.md)
for other providers and local servers.

```sh
export DEEPSEEK_API_KEY="your-api-key"
export PLURNK_MODEL=deepseek/deepseek-v4-flash
plurnk-service start
```

In another terminal, open a project:

```sh
cd /path/to/your/project
plurnk --workspace="myProject" --yolo
```

Give it a task in ordinary language. The model uses the operation language;
you do not need to learn it to use Plurnk. Run the same command later to return
to that workspace's conversation.

The client connects to `127.0.0.1:1066` by default and never starts the daemon.
Provider credentials belong in the daemon's environment. Proposal review is
interactive by default; `--yolo` automatically accepts proposals but does not
override capability restrictions.

## TUI, CLI, and Neovim

### Interactive terminal

```sh
plurnk --workspace="myProject" --yolo
```

A scrollback-native TUI with multiline prompts, streaming reasoning when the
provider supplies it, Markdown and Mermaid rendering, and slash commands for
managing models, workers, and tools. Run `/help` to explore; `/model` and
`/child` select the conversation and delegated models.

### CLI and pipelines

```sh
plurnk "Explain how this project's request handling works"
plurnk "Summarize this repository" > overview.md
git diff | plurnk "Review this patch for correctness"
plurnk --json "Explain the test layout" | jq -r .response
```

One-shot commands put the answer on stdout and progress on stderr. `--json`
returns one structured document containing the answer, operation trace,
diagnostics, and usage.

Use `plurnk --help` for CLI options. `plurnk models` lists available model
routes.

### Neovim

For an editor-native interface, use [plurnk.nvim](https://github.com/plurnk/plurnk.nvim)
against the same daemon.

## Extend and configure

Plurnk uses **AG-UI** for clients, **MCP** for external tools, **Agent Skills**
for reusable instructions, and **A2A** for remote agents. Tools, skills, and
agents can be discovered and enabled per worker without restarting the daemon.
Their documentation is retrieved on demand rather than loading every tool's
schema into every prompt.

Configuration uses cascading environment variables and `.env` files, including
the XDG user configuration at `~/.config/plurnk/.env`. Model discovery uses
[models.dev](https://models.dev). Inspect the complete, documented configuration
catalog with:

```sh
plurnk-service config defaults
```

## Documentation

- [Installation and configuration](https://github.com/plurnk/plurnk-service/blob/main/plurnk-core/INSTALL.md)
- [Architecture and extension points](https://github.com/plurnk/plurnk-service/blob/main/ARCHITECTURE.md)
- [The model-facing language](https://github.com/plurnk/plurnk-service/blob/main/plurnk-contracts/plurnk.md)
- [Client reference](SPEC.md) and [terminal design](TUI.md)

## Contributing

Questions, bug reports, and feedback are welcome in
[GitHub issues](https://github.com/plurnk/plurnk/issues). See the shared
[contributing guide](https://github.com/plurnk/plurnk-service/blob/main/CONTRIBUTING.md)
for development guidance.

## License

[MIT](LICENSE).
