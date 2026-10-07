# Plurnk Client Agent Guidance

Read `../POSSUMTECH.md` before working in this repository. Stop if it is
unavailable.

This repository owns the open-source PLURNK terminal client. Preserve the
client boundary: it consumes `plurnk-service` through the public AG-UI+
contract and does not absorb daemon or provider responsibilities.

**A rename is total.** When a concept's name changes, it changes everywhere that names the concept, in
one landing: types, schema, methods, Problems, knobs, wire actions, spec tags, tests, fixtures and docs.
Retired names fail hard and name their successor. A surface-only rename, a new flag over old internals,
is a defect, not a first step.

## Releases

The client owns its version and named dependency ranges; it does not share a
platform version stamp. Prepare and land manifest/lock changes before publication.
The platform's [release procedure](../plurnk-service/CONTRIBUTING.md#release)
can explicitly select this checkout, qualify its packed composition, and publish
the retained artifact without modifying source. `release:gate` owns the client
checks beyond `npm test`; `test:composition -- --installed <consumer>` exercises
an already-installed candidate graph. Keep the backend dependency optional.
