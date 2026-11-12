# plurnk terminal design

Thin ACP v2 terminal client for [`plurnk-service`](https://github.com/plurnk/plurnk-service), built on `@agentclientprotocol/sdk` (Streamable HTTP / WebSocket JSON-RPC framing) and `@earendil-works/pi-tui` (main-screen viewport diffing, native scrollback preservation, multiline editor, GFM/table/LaTeX layout). Behavioral contract: [`SPEC.md`](SPEC.md).

## Modes

| Invocation | Surface |
| --- | --- |
| `plurnk "prompt"` | Unix one-shot: delivered answer on `stdout`, errors on `stderr`; when opened, `fd 3` streams NDJSON session events and `fd 4` streams reasoning. |
| `plurnk` | Main-buffer interactive Plurnk Term viewport preserving terminal scrollback (never alternate screen). Transport defaults to Streamable HTTP (`ws://` / `wss://` when selected by `PLURNK_ACP_URL`). |

## Main-screen stack (`pi-tui`)

| Container | Role & height budget |
| --- | --- |
| `#transcript` | Scrollable settled conversation: full reply blocks, compact left-edge operation headings (`⚙️` for runtimes/subsystems, {§cli-rendering}), and indented `🐜 <name>` child rows. Bounded on attach by `PLURNK_CLIENT_HISTORY_ENTRIES` (`/loops` and `/loop <n>` inspect history; past reasoning stays at `reasoning://<session>/L/T`). |
| `#turn` | Active turn responses. |
| `#live` | `TailText` while a loop runs (collapses to `0` lines when idle): up to 3 whole-line rolling reasoning lines (`💭 ` on line 1, 3-space indent on lines 2–3, cleared on turn settlement) plus 1 active streams/sessions strip (`<glyph> <op> (<target>) <elapsed> · ...`). |
| `#input` | Multiline `Editor` composer or inline `SelectList` / `Editor` proposal and question review (`Escape` returns to untouched composer; `/review` reopens, [inline review](SPEC.md#cli-inline-review-5-proposal-review-ownership-tool-acceptance-and-questions)). |
| `#status` | Single-line muted footer truncated with `…` to terminal width: `place → lifecycle → model → elapsed → spend → activity` (`⌛︎` active, `🧮` indexing, `🔎` search). |

## Controls & colour

- `Ctrl-C` cancels an active loop or exits when idle; transport/resolution errors never fabricate success.
- Honours `NO_COLOR` and `--color` per [`SPEC.md` colour policy](SPEC.md#cli-color-policy-42-palette-colour-policy-lightdark-grounds-titles-and-attention).
