# Multi-surface session recording

`session.webp` is the README demonstration for `@plurnk/plurnk`: one live
`plurnk-service` daemon and one shared session (`~/retry-budget#audit`) driven
consecutively across the Unix CLI, interactive `pi-tui` terminal client, and
`@plurnk/plurnk-web` browser client against a local model — never a mocked or
scripted answer.

| Capture | Value |
| --- | --- |
| Date | 2026-11-11 |
| Client | 6.0.0, `07b30de` |
| Service | 6.0.0, `5005e671f` (`@plurnk/plurnk-web` 2.0.0) |
| Model | `Qwen3.8-27B-UD-IQ4_XS` (`rtx5070`, `medium` effort) via `llama.cpp` |
| Canvas | `1440×840` dark studio stage (`112×30` full terminal → `82×30` terminal + `654×718` web split) |
| Playback | `29.2 s` (`96` captured frames → `71` animated WebP frames, `1.34 MB`) |

## Three-act choreography

1. **Unix CLI pipeline** — pipes `git diff` into a named daemon session:
   ```sh
   git diff | plurnk --session audit "Spot the retry bug in one short sentence."
   ```
2. **Interactive TUI (`--yolo`)** — resumes `audit`, streams the 3-line rolling
   `💭` reasoning ticker and glyph operation waterfall (`📖`, `🗒️`, `📝`, `⚙️ sh`),
   verifies `node --test`, and runs `/web` to mint a single-use OAuth browser
   handoff URL.
3. **50/50 Terminal + Web live sync** — opens `@plurnk/plurnk-web` via
   `/oauth/handoff`, visits `/~/~/retry-budget/` and `/~/~/retry-budget@audit/`,
   and submits a follow-up Mermaid prompt from the browser composer so both
   surfaces stream and render the final summary and flowchart simultaneously
   (Unicode box-drawing in TUI, SVG in Web).

## Regenerating `session.webp`

Ensure the client (`npm run build`) and `../plurnk-service` (`npm run build`)
are built, Chromium and Python `Pillow` (`webp_anim`) are installed, and your
local OpenAI-compatible inference server is listening on `OPENAI_BASE_URL`
(default `http://127.0.0.1:11435`), then run:

```sh
node scripts/record-demo.mjs
```

Pass `--work-dir /tmp/plurnk-demo` to retain individual PNG frames,
`manifest.json`, and raw PTY output for inspection, or `--model <alias>` /
`--effort <level>` / `--openai-base-url <url>` to override local model routing.