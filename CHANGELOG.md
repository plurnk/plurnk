# @plurnk/plurnk

## Unreleased

- `PLURNK_SECRET` replaces `PLURNK_AGUI_TOKEN`: the operator's client secret, which the client
  exchanges at the daemon's authorization server for an access token (RFC 9728 discovery,
  `client_credentials`) and renews when it lapses or is revoked. Unset, the client reads the secret
  a daemon running as you minted beside its database (`~/.local/share/plurnk/secret`, or beside
  `PLURNK_SERVICE_DB_PATH`) and reads it again when a restarted daemon refuses the old one, so a
  fresh install needs no line set; a private backend gets a secret the client mints. A daemon that
  authenticates nothing is dialed with no credential (#0).
- Without `--workspace`, the daemon names the workspace after its folder and selects an
  existing one of that name: the client sends the folder it launches from, or
  `--project-root`, and binds the name the daemon answers. A redirected root names its own
  folder, a launch from home selects the home workspace `~` when it exists and asks for a
  folder otherwise, `--project-root=` requires `--workspace`, and state commands bind the
  launch workspace only when they address one (#0).

## 3.3.0

- Submit fixed question choices without an extra optional-detail step; display
  `other` as “Free response” when text fields follow (#180).

- A members definition is its glob: `/members add <glob...>` adds each glob as one
  definition and lists what was admitted, `/members enable|disable|remove <glob>`
  name one, and `/members` lists definitions by their glob; the family has no
  `replace`, following the daemon's `workspace.members` actions (#0).

- `/rollback <loop>/<turn>/<item>` reverses the bound worker's file mutations after
  that log coordinate, latest first, as your own operations, and prints each
  reversal, the rows skipped, and where drift stopped it, following the daemon's
  `workspace.rollback` action (#0).

## 3.2.0

- Replace a functionality definition whole from the client commands, through the
  daemon's atomic publication (#178).
- Preserve incomplete fan-out receipts in the TUI (#179).
- Keep Mermaid and hyperlink customization local to Plurnk's Markdown instances,
  with explicit compatibility coverage for the pinned pi-tui version (#177).
- Render all rich text through native Markdown without changing literal code;
  remove unused direct Markdown-parser and wrapping dependencies (#177).

## 3.1.1

- Delegate GFM markdown, tables, and LaTeX math rendering to `@earendil-works/pi-tui`,
  rendering symbols, arrows (`\leftrightarrow` to ↔, `\to` to →), relations (`\le`, `\ge`),
  Greek letters, and display equations natively in the terminal (#177).
- Eject custom `Marked` tokenizers, ad-hoc regex normalizers, and `cli-table3` dependency (#177).
- Close TUI transport before its private daemon shutdown, preserving graceful shutdown and
  reporting failed exits (#176).

## 3.1.0

- Web addresses (`http`, `https`) render as terminal hyperlinks wherever the client shows
  them, in markdown and in row targets, when colour is enabled; Plurnk addresses are never
  made clickable. The terminal window title names the bound workspace and worker: pushed
  once at start, updated on workspace switch and worker attach, restored at exit.
- The daemon's over-budget row (`engine/context/packet-exceeds-budget`) renders as
  `notice — curating context`, not as a failure.
- A one-shot `plurnk "! command"` exits by its conclusion status and the command's own
  exit code.
- Resuming a run supplies the interrupt identity the daemon issued.
- Explicit reply deliveries and message completion outcomes render as what they are.
- A failure to reach the daemon keeps the evidence the client observed before it failed.
- One-shot stream previews are bounded again.
- Live subsystem discovery derives from the daemon's advertised actions.
- A refused execution row renders immediately.
- The manual's date derives from source history.

## 3.0.0

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
- Remove `plurnk web`, its `--host` and `--port` options, and the `web/not-installed`
  Problem. The optional browser client is retired.
- `--policy`, `--reasoning` and `schedule --accept` are unknown options, and
  `PLURNK_AUTO`, `PLURNK_CLIENT_LOOP_POLICY`, `PLURNK_CLIENT_REASONING`,
  `PLURNK_CLIENT_WORKSPACE_CAPABILITIES` and `PLURNK_STATUS_STREAM` are unread; none
  has a refusal of its own.
- A failure to reach the daemon is the `client/agui/error` Problem, naming the endpoint
  in `url`.
- The status line reads the complete status gauge the daemon sends, including
  `children`, `waitUntil`, `preparation` and `descendants`.
- A one-shot `plurnk "! command"` runs the command through `op.exec` again instead of
  sending it to the model: its stdout and stderr are the client's, and it exits by its result.

## 2.0.0

- Join the one-time Plurnk 2.0 baseline. Subsequent client releases follow the
  client's own changes; they do not match a platform version or publication date.
- Consume the 2.x contracts and optional service through their named compatible
  dependency ranges. A separately configured service remains supported.
- Qualify the packed client and backend together without stamping either source
  tree during publication. Newer dependency versions alone do not require a release.
