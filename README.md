# plurnk

Client app for [plurnk-service](https://github.com/plurnk/plurnk-service). Type a prompt at the terminal, drive a real model loop through the plurnk DSL.

## install

```
npm install -g @plurnk/plurnk
```

Requires Node ≥ 25.

## use

Set up env (copy `.env.example` to `.env`, or export the vars in your shell):

```
PLURNK_DB_PATH=./plurnk.db
PLURNK_MAX_TURNS=50
OPENAI_BASE_URL=http://localhost:11435    # or your provider endpoint
OPENAI_API_KEY=
OPENAI_MODEL=macher.gguf
OPENAI_CONTEXT_SIZE=262144
OPENAI_FETCH_TIMEOUT_MS=600000
OPENAI_THINK=0
```

Run:

```
plurnk "What is the capital of France? Store at known://france/capital and reply SEND[200]."
```

You get a per-turn trace of the model's plurnk DSL emissions, the final loop status, and a list of entries written.

## what plurnk does

Plurnk is the agent's command grammar. The model emits operations like:

```
<<EDIT[france,europe](known://countries/france/capital):Paris:EDIT
<<SEND[200]:Paris:SEND
```

The CLI parses these, dispatches each to its scheme handler, persists state, and surfaces what happened. Multi-turn loops emerge naturally — the model emits `SEND[102]` to continue, `SEND[200]` to terminate.

The protocol's pitch: fancy multi-turn agent behavior on weak models, via the structure rather than the model's raw capability. See [plurnk-service](https://github.com/plurnk/plurnk-service)'s AGENTS.md for the full architecture.

## exit codes

- `0` — loop terminated successfully (`SEND[200]`)
- `1` — runtime error
- `2` — loop hit maxTurns safety cap
- `3` — loop terminated with cancellation (`SEND[499]`)
- `64` — usage error (missing prompt or env)

## license

MIT.
