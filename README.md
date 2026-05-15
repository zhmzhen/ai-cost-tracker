# AI Cost Tracker for Cursor

**Install and forget.** Shows your real Cursor billing cycle cost and quota right in the status bar — no extra CLI, no PATH gymnastics, no per-environment setup.

![status bar showing Cursor: $344.27 · 34% used](https://raw.githubusercontent.com/zhmzhen/ai-cost-tracker/main/media/statusbar.png)

## What it does

One status bar item, always visible:

- Current billing cycle **usage cost** in USD (the same number you see on cursor.com)
- **Quota %** for individual or team-pool plans (omitted on unlimited plans)
- Hover for the full breakdown: cycle dates, per-model cost, quota numbers, membership tier
- Click for an immediate refresh

It reuses your existing Cursor login (the session token already on disk) and talks only to `https://cursor.com`. There is nothing to sign up for, nothing to paste, no API key.

## Install

In Cursor or VS Code: **Extensions** → search for **AI Cost Tracker for Cursor** → **Install**. That's it.

Alternatively, install the VSIX file by hand: **Cmd/Ctrl + Shift + P** → **Extensions: Install from VSIX…**.

The extension prefers Cursor's local UI extension host, including Remote-WSL and Remote-SSH windows. That lets it read the local Cursor state database where your session token lives, without installing a helper on each remote environment.

## Settings

Three optional knobs. All have sensible defaults; you should never need to touch them.

| Key | Default | Description |
|---|---|---|
| `aiCostTracker.refreshIntervalSec` | `60` | How often to refresh from cursor.com, in seconds. |
| `aiCostTracker.staleAfterSec` | `600` | After this many seconds with no successful refresh, the status bar shows a stale-warning indicator. |
| `aiCostTracker.format` | `$(symbol-event) Cursor: ${cost}${quota}` | Status bar template. |

Template variables: `${cost}`, `${tokens}`, `${quota}`, `${quotaPct}`, `${membership}`.

## Commands

| Command | Action |
|---|---|
| `AI Cost Tracker: Refresh now` | Force an immediate refresh. |
| `AI Cost Tracker: Show raw cycle data (JSON)` | Open the latest fetched summary as JSON. |
| `AI Cost Tracker: Show status bar item` | Bring the status bar item back if you previously hid it. |
| `AI Cost Tracker: Show logs` | Open the dedicated output channel with activation diagnostics. |

## Troubleshooting

### I installed it but no status bar item appears

This is almost always one of two workbench-side toggles, not the extension
itself. Try them in order:

1. **Make sure the whole status bar is enabled.** `View → Appearance →
   Status Bar` must be checked. If it is off, no extension can render
   anything there. The command palette equivalent is
   `View: Toggle Status Bar Visibility`. `AI Cost Tracker: Show status bar
   item` also offers a `Toggle status bar` button that runs this command.
2. **Make sure this specific item is not hidden.** Right-click any empty area
   of the status bar (not on an existing item). A list of every status bar
   item appears. Tick `AI Cost Tracker`. Cursor remembers this choice per
   profile.
3. If `AI Cost Tracker` is not in that list at all, the extension may have
   failed to activate. Run `AI Cost Tracker: Show logs` and share the
   activation lines.

### The status bar shows "Cursor: error — session token not found"

The extension reads `cursorAuth/*` from Cursor's own local `state.vscdb`. If
the lookup fails on a machine you are signed in to:

1. Run `AI Cost Tracker: Show logs`. The log lists every candidate user
   directory the extension scanned, which `state.vscdb` it ended up using,
   and which keys live under `cursorAuth*` in that DB.
2. If the DB path looks wrong (e.g. a Cursor portable install or a custom
   `--user-data-dir`), set `CURSOR_USER_DIR` in the environment to point at
   the right `User/` directory and reload the window.
3. If the DB path is correct but `cursorAuthKeys` is empty, sign out and sign
   back in to Cursor on this machine, then run `AI Cost Tracker: Refresh
   now`. Cursor only writes the token after a successful sign-in.

## Privacy

- The extension reads `cursorAuth/accessToken` only from Cursor's own local `state.vscdb` (the file Cursor itself wrote).
- The token never leaves your machine except as a `Cookie` header to `https://cursor.com`, exactly the way the cursor.com web client uses it.
- The token is **not** stored in any file the extension creates, not logged, and not sent to any third party.
- No telemetry.

## Why no Python CLI?

Earlier 0.x versions depended on a Python `tt` CLI that the user had to install separately in each extension host (Windows, WSL, SSH). That was fragile. Starting with 0.4.0, all data fetching happens directly inside the extension in pure Node + WebAssembly. The companion [`token-tracker`](https://github.com/zhmzhen/token-tracker) Python CLI still exists for command-line users who want richer per-day reports across Claude Code / Codex / Cursor, but the extension no longer requires it.

## Build from source

```bash
npm install
npm run package      # -> dist-vsix/ai-cost-tracker-0.4.13.vsix
```

## License

MIT.

## Acknowledgements

Thanks to [stormzhang](https://github.com/stormzhang) for the original MIT-licensed `token-tracker` project this work builds on.
