# @plurnk/plurnk

## Unreleased

- Connect to `/agui` by default and preserve the complete configured or advertised
  endpoint URL, including custom paths.

## 2.0.0

- Join the one-time Plurnk 2.0 baseline. Subsequent client releases follow the
  client's own changes; they do not match a platform version or publication date.
- Consume the 2.x contracts and optional service through their named compatible
  dependency ranges. A separately configured service remains supported.
- Qualify the packed client and backend together without stamping either source
  tree during publication. Newer dependency versions alone do not require a release.
