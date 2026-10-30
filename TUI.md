# plurnk terminal design

`plurnk` is a thin terminal client for `plurnk-service`. Both one-shot and
interactive modes use the daemon's ACP v2 surface. The daemon owns
workspaces, sessions, model execution, and durable state; the client submits
actions and renders events.

The behavioral contract lives in [SPEC.md](SPEC.md). This document records only
the small set of terminal-design choices that are useful when maintaining the
client.

## Modes

- `plurnk "prompt"` is a Unix-style one-shot command. The delivered answer goes
  to stdout and errors go to stderr; when opened, `fd 3` carries NDJSON session
  events and `fd 4` streams model reasoning.
- `plurnk` is a readline-style, main-buffer interaction built on pi-tui's
  main-screen renderer and multiline editor. It preserves normal terminal
  scrollback rather than taking over the alternate screen.
- Provider reasoning streams into the reasoning scroll: a live region between the
  transcript and the composer, at most a third of the terminal tall, that shows the
  newest lines and overwrites itself as the reasoning grows. It retires when the
  turn settles and never enters the transcript; immutable history keeps every
  turn's reasoning at `reasoning://<session>/L/T` for a READ, so a model with a fat reasoning
  habit costs a third of the screen, not the session.
- Prompts, command verbs, and raw DSL use the same ACP v2 session and action transport.

## Rendering

The waterfall is intentionally compact: operation glyphs begin at the
left edge, with only the fields that identify their action and outcome.
Runtimes and subsystems retain their names after ⚙️ ({§cli-rendering}).
Delivered messages render as full response blocks rather than diagnostic rows.
The status row projects session place and ACP state in place → lifecycle → model →
elapsed → spend → activity order (`⌛︎` while a loop runs). Indexing and search
progress update the activity tail (`🧮`, `🔎`) instead of appending an event for
every milestone.

The renderer follows the shared
[colour selection policy](SPEC.md#cli-color-policy-42-palette-colour-policy-lightdark-grounds-titles-and-attention), including
`NO_COLOR` and `--color`. Rendering details and exit behavior are specified and
tested in `SPEC.md`; design history belongs in Git.

## Interaction

pi-tui owns multiline editing, history, completion presentation, paste framing,
keyboard negotiation, cursor/IME behavior, resize, and scrollback rendering.
Plurnk owns command and run semantics. `Ctrl-C` cancels an active run and
remains the escape hatch from the interactive client when idle.

Opening or switching a workspace or session restores a bounded recent transcript and
observes any current loop, without resubmitting a prompt. Replies remain whole;
historical operations are headings, a sub-session's rows are marked `🐜 <name>` and stepped in as they
are live, and old reasoning is not replayed.
`PLURNK_CLIENT_HISTORY_ENTRIES` sets the tail size; `/loops` lists the session's loops and `/loop <n>`
prints any of them whole.

Side-effect proposals are rendered for human review unless loop or client
policy has already resolved them. A transport or resolution failure is shown
as an error; the client never fabricates success.

Approvals and questions use pi-tui selection lists and multiline editors in
the composer's place, not floating dialogs. Escape returns to the untouched
composer; `/review` reopens the pending interaction. Background output keeps
flowing, and ordinary commands remain available from the composer. See
[inline review](SPEC.md#cli-inline-review-5-proposal-review-ownership-tool-acceptance-and-questions) for focus and interrupt
identity rules.
