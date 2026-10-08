# @plurnk/plurnk

## Unreleased

- Connect to `/agui` by default and preserve the complete configured or advertised
  endpoint URL, including custom paths.
- Follow durable worker approval ownership and declare the client's capability set on
  every Run: the client tools it implements and whether a person attends it.
  Reconnecting owners can resume pending approvals; observing work does not transfer
  ownership.
- `--auto` (`PLURNK_CLIENT_AUTO`) states that nobody is attending: the daemon asks
  nothing and a loop that would wait for a person concludes instead, while approval
  stays local.
- Remove `--proposals` and `PLURNK_CLIENT_PROPOSALS`. Use `--yolo` for local automatic
  acceptance or `PLURNK_SERVICE_PROPOSALS` for server-side disposition.

## 2.0.0

- Join the one-time Plurnk 2.0 baseline. Subsequent client releases follow the
  client's own changes; they do not match a platform version or publication date.
- Consume the 2.x contracts and optional service through their named compatible
  dependency ranges. A separately configured service remains supported.
- Qualify the packed client and backend together without stamping either source
  tree during publication. Newer dependency versions alone do not require a release.
