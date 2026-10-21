# Plurnk Client Agent Guidance

Read `../POSSUMTECH.md` before working in this repository. Stop if it is
unavailable.

This repository owns the open-source PLURNK terminal client. Preserve the
client boundary: it consumes `plurnk-service` through the public AG-UI+
contract and does not absorb daemon or provider responsibilities.

**A rename is total.** When a concept's name changes, it changes everywhere that names the concept, in
one landing: types, schema, methods, Problems, knobs, wire actions, spec tags, tests, fixtures and docs.
A surface-only rename, a new flag over old internals, is a defect, not a first step.

**Retired forms are erased.** A retired name, syntax, knob or behaviour leaves no trace in the living
tree: no code, spec, doc, test, comment or diagnostic refers to it, and nothing recognizes it to refuse
or translate it. Any record of it invites its resurrection. History lives in git, issues and published
changelogs.

## Verification

`npm test` runs lint, unit, integration, and TUI checks. The integration and
TUI tiers boot the service from the checkout `PLURNK_SERVICE_CHECKOUT` names
(`../plurnk-service` by default) and borrow its MCP and A2A fixtures from there;
`test/service-checkout.ts` is the one place that path is resolved. Each integration and
TUI file can start a real daemon and terminal fixtures, so those tiers run as many files
at once as the host holds: its available cores, bounded by its available memory over a
file's measured footprint (`scripts/test-concurrency.mjs`). No tier fixes a number for
one machine. Unit tests retain Node's default.

The service's pre-push drill drives this checkout's installed CLI and TUI against
a live daemon and waits for their exact output (`scripts/test-client-conformance.mjs`
in `plurnk-service`). After a presentation change, run
`npm run -s test:client-conformance` in the service checkout before landing; this
repository's own suite cannot see that coupling.

## Releases

The client owns its version and named dependency ranges; it does not share a
platform version stamp. Prepare and land manifest/lock changes before publication.
The platform's [release procedure](../plurnk-service/CONTRIBUTING.md#release)
can explicitly select this checkout, qualify its packed composition, and publish
the retained artifact without modifying source. `release:gate` owns the client
checks beyond `npm test`; `test:composition -- --installed <consumer>` exercises
an already-installed candidate graph. Keep the backend dependency optional.
