# Changelog

All notable changes to AI Cost Tracker for Cursor are documented here.

## 0.4.4

### Fixed

- `AI Cost Tracker: Show status bar item` previously told users to "right-click
  the status bar to pin it permanently", but VS Code's per-id hidden list can
  override `statusBar.show()`, so the item still did not appear in some
  profiles. The command's notification now points users at the correct
  recovery path: right-click any empty area of the status bar and tick
  `AI Cost Tracker` in the list (this works because 0.4.3 already added a
  stable id and display name to the item). A "Show logs" button on the
  notification opens the dedicated output channel.

### Changed

- README Troubleshooting section rewritten to match the actual VS Code 1.74+
  status bar behavior, including the manual context-menu step Cursor uses to
  persist visibility per profile.

## 0.4.3

### Fixed

- Some users reported that the extension installed and activated but no status
  bar item appeared at all. The status bar item is now created with a stable
  id and name, so Cursor can persist the user's show/hide choice and list the
  item in the status bar context menu instead of silently dropping it.
- Hardened `activate()` so a failure in `setWasmDirectory`, command
  registration, or the id-based `createStatusBarItem` overload cannot leave
  the user with no visible UI. The status bar item is created first and
  unconditionally, and remaining setup steps each have their own guard.

### Added

- New command `AI Cost Tracker: Show status bar item` as a recovery handle for
  users who previously hid the item from the status bar context menu.
- New command `AI Cost Tracker: Show logs` that opens a dedicated output
  channel; activation steps and recoverable errors are logged there to make
  "I installed it but nothing shows up" reports easy to triage.

## 0.4.2

### Fixed

- Prefer Cursor's local UI extension host before the workspace extension host.
  This fixes Remote-WSL and Remote-SSH windows where the workspace host cannot
  read the local Cursor `state.vscdb`, causing `Cursor session token not found`
  even when the user is signed in locally.

### Changed

- Updated the README install notes to describe the UI-host behavior for remote
  windows.

## 0.4.1

### Changed

- Move packaged VSIX artifacts from `dist/` to `dist-vsix/`, matching the
  convention used by the sibling extension projects.
- Generate versioned VSIX filenames from `package.json`, for example
  `ai-cost-tracker-0.4.1.vsix`.
- Updated the README build instructions for the new output path.

## 0.4.0

### Changed

- Removed the Python `tt` CLI runtime dependency. The extension no longer needs
  a separate CLI installed in each Windows, WSL, or Remote-SSH environment.
- Rewrote the extension refresh path to read Cursor's local
  `cursorAuth/accessToken` directly from `state.vscdb` using bundled `sql.js`
  WebAssembly.
- Added direct Cursor dashboard API calls from the extension process.
- Cached the decoded Cursor JWT in VS Code global state so only cold starts or
  expired tokens need to reread the SQLite database.
- Automatically evict the cached token when Cursor's API rejects it, allowing a
  Cursor re-login to heal the extension on the next refresh.
- Added packaged extension metadata, TypeScript build configuration, lockfile,
  bundled `sql.js`, icon, and status-bar screenshot.
- Updated README images to use `raw.githubusercontent.com` URLs so Open VSX and
  extension marketplaces render them correctly.

## 0.3.3

### Added

- Initial AI Cost Tracker for Cursor extension.
- Status bar item for Cursor usage and cost visibility.
- Commands to refresh usage and show raw cycle data.
- Settings for refresh interval, stale-data threshold, and status bar format.
- README, license, packaging ignore rules, and source implementation for the
  original CLI-backed architecture.
