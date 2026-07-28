# plurnk terminal design

`plurnk` is a thin terminal client for `plurnk-service`. Both one-shot and
interactive modes use the daemon's AG-UI+ HTTP/SSE surface. The daemon owns
workspaces, workers, model execution, and durable state; the client submits
actions and renders events.

The behavioral contract lives in [SPEC.md](SPEC.md). This document records only
the small set of terminal-design choices that are useful when maintaining the
client.

## Modes

- `plurnk "prompt"` is a Unix-style one-shot command. The final answer goes to
  stdout; narration and diagnostics go to stderr.
- `plurnk` is a readline REPL. It streams output into normal terminal
  scrollback rather than taking over the screen.
- Prompts, command verbs, and raw DSL use the same AG-UI+ action/run transport.
  There is no client side channel or persistent socket.

## Rendering

The waterfall is intentionally compact: a logical coordinate, actor, operation,
status, and target identify each row. Model broadcasts render as full response
blocks rather than diagnostic rows. Indexing and search progress update the
active prompt instead of appending an event for every milestone. Serialized
branch batches use the same compact treatment: 🌿 plus aggregate progress while
active, followed by one completion, failure, or recovery line.

The renderer uses width-stable glyphs and respects `NO_COLOR`. Avoid glyphs
whose variation selectors produce inconsistent terminal widths. Rendering
details and exit behavior are specified and tested in `SPEC.md`; design history
belongs in Git.

## Interaction

Readline owns input editing, history, completion, and cancellation. The client
does not maintain a virtual screen or duplicate terminal behavior. `Ctrl-C`
cancels an active run and remains the escape hatch from the interactive client
when idle.

Side-effect proposals are rendered for human review unless loop or client
policy has already resolved them. A transport or resolution failure is shown
as an error; the client never fabricates success.
