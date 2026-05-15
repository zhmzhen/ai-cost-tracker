# Changelog

All notable changes to AI Cost Tracker for Cursor are documented here.

## 0.4.9

### Added

- New command `AI Cost Tracker: Run token probe (diagnostic)`. The 0.4.8
  probe was wired to run *only* when the canonical SQL SELECT misses,
  which meant a machine where SQL still works could not be used to
  confirm that the probe code in the deployed VSIX is alive. This
  command runs the probe unconditionally — it queries `sqlite_master`,
  lists ItemTable keys, samples JWT-shaped runs in the main DB and WAL,
  and reads top-level keys of `storage.json` — and prints all five
  `runProbe: ...` lines to the output channel.
- No behaviour change for the normal refresh path; the new command is
  only used when an operator wants to compare probe output across
  machines that succeed vs. fail.

## 0.4.8

### Added

- Probe logging for the "session token not found" failure mode where the
  canonical SELECT against `ItemTable WHERE key LIKE 'cursorAuth%'`
  returns zero rows. When this happens the extension now records and
  logs, all non-sensitive:
  - every table name in `state.vscdb` (to detect a schema move, e.g. into
    a `cursorDiskKV` table some newer Cursor builds use);
  - any `ItemTable` keys whose prefix is one of `cursor`, `auth`, `workos`,
    `session`, `token`, `user` (to spot a key-name rename);
  - the count of JWT-shaped runs found in the main DB and the WAL sidecar,
    plus a 12-character non-secret prefix of the first one (so a future
    release knows whether the token is still physically present somewhere
    in the file);
  - the top-level keys of `globalStorage/storage.json` (since some Cursor
    builds have moved auth state out of SQLite entirely).
- The extra fields appear in the AI Cost Tracker output channel as
  `token probe: ...` lines. They never contain secret material.

## 0.4.7

### Fixed

- The 0.4.6 byte-scan fallback would throw `ERR_STRING_TOO_LONG` if invoked
  on a `state.vscdb` larger than ~512 MB, because Node's string upper bound
  is 2^29 - 16 characters and the scan called `Buffer.toString("latin1")` on
  the entire file. Real Cursor DBs routinely run from 2 GB to 3+ GB. The
  scan is now chunked into 64 MB slices with 8 KB overlap, which both fits
  the JS string limit and guarantees no JWT or `cursorAuth/accessToken`
  marker is split across the slice boundary.
- The fallback no longer attempts to byte-scan the main `state.vscdb` file.
  If the token were present in the main file the SQL SELECT would already
  have returned it; scanning a multi-GB file again wasted memory and CPU
  for no additional coverage. Only the (much smaller) `state.vscdb-wal`
  sidecar is scanned, which is the real source of the missing rows.

### Added

- New command `AI Cost Tracker: Force re-read state DB` clears the cached
  JWT in `globalState` and triggers an immediate refresh. Intended for
  reproducing the WAL fallback path on developer machines (where the
  cached path normally hides whether SQL or WAL recovered the token) and
  for asking testers to capture fresh diagnostics without uninstalling.
- `scripts/reproduce-token-lookup.cjs` runs the same code path against a
  real `state.vscdb`, prints `source=sql|wal|none`, key list, and JWT
  prefix. `scripts/reproduce-wal-fallback.cjs` builds a synthetic DB whose
  main file has no auth row but whose WAL sidecar contains a valid JWT,
  and asserts the fallback returns `source=wal`. Both scripts are used to
  validate the chunked scan on local data without disturbing the user's
  Cursor instance.

## 0.4.6

### Fixed

- Some users with a working Cursor sign-in still saw "Cursor session token not
  found", with diagnostics showing the correct `state.vscdb` and an empty
  `cursorAuthKeys` list. Root cause: Cursor uses SQLite WAL mode, so a
  freshly written `cursorAuth/accessToken` lives in the `state.vscdb-wal`
  sidecar until Cursor checkpoints the WAL back into the main file. `sql.js`
  loads only the main file's bytes and cannot apply the WAL, so the SELECT
  legitimately returned no rows for these users.
- The token reader now falls back to a byte-level scan of `state.vscdb` and
  `state.vscdb-wal` when the SELECT path comes back empty. The scan looks
  for `cursorAuth/accessToken` followed by the nearest JWT-shaped run, and
  validates it via the same JWT-payload check as the SQL path before
  trusting it. This lets the extension recover the token from a running
  Cursor without waiting for a checkpoint or a restart.

### Added

- `AI Cost Tracker: Show logs` now records which path produced the token
  on each refresh: `source=sql` for the normal SQL SELECT, `source=wal` for
  the WAL byte-scan fallback, or `source=none` if neither path found a
  usable JWT.

## 0.4.5

### Fixed

- "I installed it but nothing shows up" sometimes meant the user had turned
  off the whole status bar via `View → Appearance → Status Bar`, not just
  hidden this single item. `AI Cost Tracker: Show status bar item` now offers
  a `Toggle status bar` action that runs
  `workbench.action.toggleStatusBarVisibility`, covering that case directly.
- Token lookup is more resilient. The extension now scans every
  `cursorAuth*` key in the state database and tries the first one whose
  value parses as a JWT, instead of only looking for the literal key
  `cursorAuth/accessToken`. This avoids spurious "session token not found"
  errors on Cursor builds that use a slightly different key shape.

### Added

- `AI Cost Tracker: Show logs` now reports, on every refresh, the candidate
  Cursor user directories that were scanned, which `state.vscdb` ended up
  being used, and which `cursorAuth*` keys lived in it (key names only — no
  token values are ever logged). That answers "is the extension looking at
  the wrong DB or the right one with the wrong key?" without a developer
  build.
- README Troubleshooting section now distinguishes the two failure modes
  ("status bar disabled entirely" vs "this item hidden via context menu")
  and documents the `CURSOR_USER_DIR` / `CURSOR_GLOBAL_STORAGE` overrides
  for portable / custom Cursor installs.

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
