# AI Cost Tracker for Cursor

Show **Cursor** AI usage cost, quota, and token details in the status bar — companion to the [`tt` (token-tracker)](https://github.com/zhmzhen/token-tracker) Python CLI.

Current scope: this extension is intentionally Cursor-only. The underlying `tt`
CLI can detect other agents, but this IDE extension is published and tested for
Cursor's server-side monthly cost/quota data.

```
┌──────────┐   periodic   ┌─────────────────────┐   poll   ┌────────────┐
│  tt CLI  │─────────────▶│ ~/.tt/status.json   │◀─────────│ AI Cost    │
│ (python) │   write json │ (schema version=2)  │   read   │ (this ext) │
└──────────┘              └─────────────────────┘          └────────────┘
```

## Architecture

The extension never opens Cursor's own SQLite directly; that's the Python CLI's job. The two pieces share **one data contract**: the JSON file at `~/.tt/status.json` (or `%APPDATA%\.tt\status.json` on Windows), produced by `tt status`.

The extension is declared as a **workspace extension**. In a normal local window it runs on the local machine; in Remote-WSL / Remote-SSH it runs inside that remote extension host. Use the same VSIX everywhere, but install `tt` where that specific extension host can execute it.

`AI Cost Tracker for Cursor` simply:

1. Reads `~/.tt/status.json` on activation (zero-wait initial render).
2. Periodically spawns `tt status --json` (configurable interval) to refresh.
3. Renders one configurable line in the status bar; full data in the hover tooltip.
4. Click the status bar item to cycle between detected agents (Cursor / Claude Code / Codex / ...).

This means you get the same numbers in the IDE as on the CLI — there's only one source of truth.

## Security / Privacy

No API key setup is required. The companion `tt` CLI automatically reuses the
local Cursor login session by reading Cursor's `cursorAuth/accessToken` from the
local Cursor state database, then uses it only to call official Cursor endpoints
on `https://cursor.com` for usage and quota data.

- This extension does not read Cursor's session token directly; it only spawns `tt status --json`.
- The Cursor session token is never written to `~/.tt/status.json`.
- The token is never printed by `tt cursor-debug` or `TT_CURSOR_DEBUG_API=1`.
- No token or usage data is uploaded to third-party servers; there is no telemetry.
- The shared snapshot contains only aggregated display data such as cost, tokens, quota, and model breakdown.
- Use `TT_CURSOR_NO_API=1 tt status` to disable Cursor server-side API calls entirely.

## Requirements

- Cursor (or VS Code) ≥ 1.85.
- `tt` (token-tracker) Python CLI installed in the current extension host and visible on `PATH`. Install with:

  ```bash
  pip install token-tracker
  tt status   # warms the cache, also confirms tt is reachable
  ```

  If `tt` lives somewhere off-PATH, set `aiCostTracker.cliPath` in Settings. The extension also probes common fallback locations: `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, and Windows Python user-script directories such as `%APPDATA%\Python\Python311\Scripts`.

Remote-WSL / Remote-SSH note: the extension host often has a minimal `PATH`. If `tt` was installed to `~/.local/bin`, either symlink it to `/usr/local/bin/tt` or set `aiCostTracker.cliPath` to the absolute path in that remote environment.

## Settings

| Key | Default | Description |
|---|---|---|
| `aiCostTracker.statusFile` | `""` (= CLI default) | Path to the snapshot file written by `tt status` in the current extension host. |
| `aiCostTracker.cliPath` | `tt` | How to invoke the CLI in the current extension host. Use absolute path if needed. |
| `aiCostTracker.refreshIntervalSec` | `30` | How often to spawn `tt status` to refresh. |
| `aiCostTracker.staleAfterSec` | `600` | After this many seconds, status bar shows a stale-warning indicator. |
| `aiCostTracker.preferredAgent` | `cursor` | Currently intended to display Cursor. |
| `aiCostTracker.format` | `$(symbol-event) ${agent}: ${primaryCost}${primaryQuota}` | Status bar template. |

Available format vars: `${agent}`, `${model}`, `${primaryCost}`, `${primaryQuota}`, `${monthCost}`, `${monthTokens}`, `${monthQuotaPct}`, `${todayTokens}`, `${todayCost}`, `${allTokens}`, `${allCost}`, `${quota}`, `${quota5h}`, `${quota7d}`.

## Commands

| Command | Action |
|---|---|
| `AI Cost Tracker: Refresh now` | Force a `tt status` spawn immediately. |
| `AI Cost Tracker: Open full dashboard in terminal (`tt`)` | Opens an integrated terminal and runs `tt`. |
| `AI Cost Tracker: Cycle visible agent` | Same as clicking the status bar item. |
| `AI Cost Tracker: Show raw status JSON` | Open the current snapshot in a JSON editor (debug). |

## Build

```bash
npm install
npm run compile      # tsc → out/
npm run package      # → dist/ai-cost-tracker-0.3.3.vsix
```

Then in Cursor: **Cmd/Ctrl + Shift + P** → **Extensions: Install from VSIX…** → pick the `.vsix`.

## Publishing / Auto update

Registration and publishing for a free extension are normally free: VS Code
Marketplace needs a publisher id (for this extension: `zhmzhen`) and an Azure
DevOps PAT; Open VSX needs an Open VSX token.

Auto update only works after publishing under a stable extension id such as
`zhmzhen.ai-cost-tracker`. Sideloaded `.vsix` files do not reliably auto-update, and
local / Remote-WSL / Remote-SSH windows are different extension hosts, so the
same VSIX may need to be installed once per host.

## Data contract (schema version 2)

```jsonc
{
  "version": 2,
  "updated_at": "2026-05-12T08:30:00+00:00",
  "tt_version": "0.3.1",
  "agents": [
    {
      "id": "cursor",
      "name": "Cursor",
      "model": "claude-4.5-sonnet-thinking",
      "today":    { "tokens": 2200000, "input_tokens": 2086000, "output_tokens": 113900,
                    "cost_usd": 7.89, "messages": 19, "sessions": 1 },
      "all_time": { "tokens": 8400000, "input_tokens": 7776748, "output_tokens": 595147,
                    "cost_usd": 34.69, "messages": 99, "sessions": 20 },
      "current_month": {
        "cost_usd": 243.68,
        "input_tokens": 4394021,
        "output_tokens": 1468606,
        "cache_write_tokens": 8235907,
        "cache_read_tokens": 278049468,
        "cycle_start": "2026-05-01T00:00:00.000Z",
        "cycle_end": "2026-06-01T00:00:00.000Z",
        "membership": "enterprise",
        "is_unlimited": false,
        "individual_quota": {
          "enabled": true,
          "used": 24368,
          "limit": 100000,
          "remaining": 75632,
          "used_pct": 24.37
        },
        "team_quota_pooled": null,
        "by_model": [],
        "fetched_at": "2026-05-12T08:30:00+00:00"
      },
      "rate_limits": null
    }
  ]
}
```

## License

MIT. Companion to `token-tracker`.

## Acknowledgements

Thanks to [stormzhang](https://github.com/stormzhang) for the original MIT-licensed `token-tracker` project this work builds on.
