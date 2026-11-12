# Plurnk Client Agent Guidance

This repository owns the open-source PLURNK terminal client. Preserve the
client boundary: it consumes `plurnk-service` through the public ACP v2
contract (`@agentclientprotocol/sdk/experimental/v2/unstable`) and does not
absorb daemon or provider responsibilities.

**ACPv2 is the Schelling point.** Our prerogative is not to maintain a translation layer between
PLURNK and ACPv2, but to become an ACPv2 agent paradigmatically — aggressively simplifying until the
only things that aren't ACPv2 are either essential to PLURNK's virtual machine or orthogonal to the
protocol ([`ARCHITECTURE.md` § Standards and substrate](https://github.com/plurnk/plurnk-service/blob/main/ARCHITECTURE.md)). When ACPv2 names or shapes a
concept, it drives a maximal rename across the service and client so the codebase reads as if that was
always our name and model for it. `_plurnk/action` is a shrinking residual bridge for VM and workspace
operations ACPv2 cannot yet express, never a permanent bespoke dialect.

**Implementation substrates (`What we build with`).** The client builds on `@agentclientprotocol/sdk`
(ACP v2 JSON-RPC framing, Streamable HTTP and WebSocket client streams, and protocol types) and
`@earendil-works/pi-tui` (main-screen terminal viewport diffing, scrollback preservation, multiline
editing, selection widgets, and GFM/table/LaTeX layout). Delegate undifferentiated transport and
terminal heavy lifting to these substrates instead of hand-rolling plumbing, and keep their internals
behind their owning boundaries (`src/acp-client.ts`, `src/acp-session.ts`, `src/term-surface.ts`,
`src/markdown.ts`).

**A rename is total.** When a concept's name changes, it changes everywhere that names the concept, in
one landing: types, schema, methods, Problems, knobs, wire actions, spec tags, tests, fixtures and docs.
A surface-only rename, a new flag over old internals, is a defect, not a first step.

**Retired forms are erased.** A retired name, syntax, knob, dependency, protocol or behaviour leaves no
trace in the living tree: no code, spec, doc, test, comment or diagnostic refers to it, and nothing
recognizes it to refuse, shim or translate it. Never vendor or inline a retired dependency or protocol
under local names, run dual protocols on one endpoint, or relabel an old wire contract as the new one;
when an adopted standard has an official SDK, build on that SDK rather than hand-rolling its wire or
transport layer. Any record of a retired form invites its resurrection. History lives in git, issues and
published changelogs.

## Verification

`npm test` runs lint, unit, integration, and Term checks standalone with no
sibling repository required. Deterministic integration tests (`test/intg/*`)
drive in-process mock ACP v2 agents, while `test/term/live.test.ts` (`npm run test:term:live`)
boots the service from `PLURNK_SERVICE_CHECKOUT` when set, from `../plurnk-service`
when present, or from the installed `@plurnk/plurnk-service` dependency.
Integration and Term suites run as many files at once as the host holds: its
available cores, bounded by its available memory over a file's measured footprint
(`scripts/test-concurrency.mjs`). No tier fixes a number for one machine. Unit
tests retain Node's default.

When working alongside a sibling `plurnk-service` checkout, the service's
pre-push drill drives this checkout's installed CLI and Term against a live
daemon (`scripts/test-client-conformance.mjs` in `plurnk-service`). After a
presentation change in a multi-repo workspace, run
`npm run -s test:client-conformance` in the service checkout before landing; this
repository's own suite cannot see that coupling.

## Releases

The client owns its version and named dependency ranges; it does not share a
platform version stamp. Prepare and land manifest/lock changes before publication.
The platform's [release procedure](https://github.com/plurnk/plurnk-service/blob/main/CONTRIBUTING.md#release)
can explicitly select this checkout, qualify its packed composition, and publish
the retained artifact without modifying source. `release:gate` owns the client
checks beyond `npm test`; `test:composition -- --installed <consumer>` exercises
an already-installed candidate graph. Keep the backend dependency optional.

## Dependency Freshness Policy

`deps-policy.json` is the committed freshness ledger for rapid-cadence upstream
dependencies (`{§cli-conformance}`):

- `@earendil-works/pi-tui` (the terminal UI implementation substrate owning viewport diffing, scrollback rendering, multiline editing, and Markdown/table/math projection) is pinned **exact** (`requirement: "exact"` in `deps-policy.json`): it ships roughly 5 minor versions every 3 weeks without a changelog and carries native prebuilds. Every minor upgrade is an intentional, test-verified bump in `package.json`, `package-lock.json`, and `deps-policy.json`.
- `@agentclientprotocol/sdk` (the ACPv2 protocol and transport substrate) uses a **caret** range (`requirement: "caret"` in `deps-policy.json`) paired with an exact `resolved`/`verifiedLatest` entry in `deps-policy.json` and compile-time + lint-time surface exhaustiveness over `@agentclientprotocol/sdk/experimental/v2/unstable`.
- `npm run deps:check` runs hermetically inside `npm test` (`test:lint`) with no
  network access. `npm run deps:drift` runs in `.githooks/pre-push` and
  `release:gate`, enforcing the 14-day `verifiedAt` age budget and live npm
  registry alignment (with `ownerVeto` forbidding waivers on `@earendil-works/pi-tui`
  and `@agentclientprotocol/sdk`).
