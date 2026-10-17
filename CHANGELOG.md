# @plurnk/plurnk

## Unreleased

### Upgrade

Upgrade this client and the daemon together to 4.0. Their authentication,
worker binding and AG-UI projection replace the 3.x wire contract.

- Replace `PLURNK_AGUI_TOKEN` with `PLURNK_SECRET`, or leave it unset for
  same-user local discovery. The secret is exchanged for short-lived access
  credentials; it is not sent as a bearer token.
- `plurnk login` uses browser authorization with PKCE and a loopback callback.
  `plurnk logout` revokes and forgets the retained grant. Interactive clients
  can initiate sign-in; unattended clients report the required action.
- Both CLI and TUI default to worker `user` through `PLURNK_CLIENT_WORKER`.
  The separate `--tui-worker` / `PLURNK_CLIENT_TUI_WORKER` setting is removed.
- LOOK, `/look` and the Alt-p/Alt-n target cycler are removed. Use ordinary
  resource reads; `plurnk read` reads a complete log entry.

### Worker and protocol alignment

- Bind to the daemon-returned workspace ID and worker name. Workspace renames
  preserve the worker, ownership and pending interrupt identity. Directory-derived
  names and folder labels come from the daemon; read-only selection creates nothing.
- Reopening a worker restores its standard AG-UI conversation snapshot. Live and
  restored messages use the same row projection, including assistant replies,
  refused operations, delegated results and subagent identities.
- Approvals use standard AG-UI interrupts and resume by interrupt ID. The retired
  `request_approval` pseudo-tool and custom duplicate row/terminal/action events
  are replaced by standard messages, results and namespaced metadata.
- Status reads workspace preparation and activity separately from worker state.
  Elapsed time uses the daemon's original loop start; worker spend includes its
  descendants and refreshes as turns settle.
- Informational operation details remain muted; failure styling follows failed
  status or unsuccessful execution.
- Development targets native ECMAScript and erasable TypeScript on Node 26.
  npm's install-script policy explicitly permits the locked native PTY test
  dependency; it is not a runtime dependency.

The optional web client is not part of this publication. Its conversation UI
remains deferred.

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
