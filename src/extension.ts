/**
 * AI Cost Tracker for Cursor — zero-dependency status bar companion.
 *
 * No Python CLI, no PATH gymnastics, no per-environment install. The extension
 * reads Cursor's own SQLite session token in-process (sql.js, pure WASM) and
 * calls Cursor's dashboard API directly to render real billing / quota data.
 *
 * Data flow:
 *
 *   ┌──────────────────────────┐                 ┌────────────────────────┐
 *   │ <Cursor User>/           │   read once     │                        │
 *   │   globalStorage/         │────────────────▶│  this extension        │
 *   │     state.vscdb          │  cursorAuth/    │                        │
 *   └──────────────────────────┘  accessToken    │                        │
 *                                                │   periodic HTTPS POST  │
 *                                                │   → cursor.com         │
 *                                                └────────────────────────┘
 *
 * The status bar item is intentionally minimal: cost + quota%; full breakdown
 * (cycle dates, top models, quotas, errors) lives in the hover tooltip.
 */

import * as path from "path";
import * as vscode from "vscode";

import {
  AccessToken,
  FetchStatus,
  MonthSummary,
  Quota,
  acquireAccessToken,
  describeError,
  fetchMonthSummaryWithToken,
  setWasmDirectory,
  validateCachedToken,
} from "./cursor";

let extensionContext: vscode.ExtensionContext;
let statusBar: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let lastSummary: MonthSummary | undefined;
let lastError: string | undefined;
let lastUpdatedAt: number | undefined;
let inflight: Promise<void> | undefined;

const REFRESH_MIN_SEC = 5;
const REFRESH_DEFAULT_SEC = 60;
const STALE_DEFAULT_SEC = 600;
const TOKEN_STATE_KEY = "aiCostTracker.token.v1";

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  // sql.js needs to find its sibling sql-wasm.wasm at runtime. We ship it
  // alongside the compiled JS so it works in every install target (local,
  // Remote-WSL, Remote-SSH, Windows native) without any user configuration.
  setWasmDirectory(path.join(context.extensionPath, "media"));

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "aiCostTracker.refresh";
  statusBar.text = "$(symbol-event) Cursor: …";
  statusBar.tooltip = "AI Cost Tracker: fetching usage…";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCostTracker.refresh", () =>
      refresh(true),
    ),
    vscode.commands.registerCommand("aiCostTracker.showDetails", showDetails),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiCostTracker")) {
        scheduleRefresh();
        render();
      }
    }),
  );

  // Fire the first refresh asynchronously so activation never blocks the UI.
  void refresh(false);
  scheduleRefresh();
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

// ----------------------------- refresh loop -------------------------------

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  const cfg = vscode.workspace.getConfiguration("aiCostTracker");
  const requested = cfg.get<number>("refreshIntervalSec", REFRESH_DEFAULT_SEC);
  const interval = Math.max(REFRESH_MIN_SEC, requested);
  refreshTimer = setInterval(() => void refresh(false), interval * 1000);
}

async function getToken(): Promise<{ ok: true; token: AccessToken } | { ok: false; error: string }> {
  // Cached path: reading Cursor's SQLite DB on a slow filesystem (e.g. WSL
  // /mnt/c) can take 30+ seconds for a multi-GB file. Cache the JWT in
  // globalState (per-host) and only reread the DB when it's missing or expired.
  const cached = extensionContext.globalState.get<AccessToken>(TOKEN_STATE_KEY);
  const valid = validateCachedToken(cached);
  if (valid) {
    return { ok: true, token: valid };
  }

  const fresh = await acquireAccessToken();
  if (!fresh.ok) {
    return { ok: false, error: describeError(fresh.error) };
  }
  await extensionContext.globalState.update(TOKEN_STATE_KEY, fresh.token);
  return { ok: true, token: fresh.token };
}

async function refresh(notifyOnError: boolean): Promise<void> {
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const t = await getToken();
      if (!t.ok) {
        lastError = t.error;
        if (notifyOnError) {
          void vscode.window.showWarningMessage(`AI Cost Tracker: ${t.error}`);
        }
        return;
      }
      const status: FetchStatus = await fetchMonthSummaryWithToken(t.token);
      if (status.ok) {
        lastSummary = status.summary;
        lastError = undefined;
        lastUpdatedAt = Date.now();
      } else {
        // If the server says the token is no longer valid, evict it so the
        // next refresh re-reads from disk; otherwise we'd keep using a dead
        // token forever.
        if (status.error === "http_error") {
          await extensionContext.globalState.update(TOKEN_STATE_KEY, undefined);
        }
        lastError = describeError(status.error);
        if (notifyOnError) {
          void vscode.window.showWarningMessage(
            `AI Cost Tracker: ${lastError}`,
          );
        }
      }
    } catch (e) {
      lastError = `Unexpected error: ${(e as Error).message}`;
      if (notifyOnError) {
        void vscode.window.showErrorMessage(
          `AI Cost Tracker: ${lastError}`,
        );
      }
    } finally {
      render();
      inflight = undefined;
    }
  })();
  return inflight;
}

// ----------------------------- rendering ----------------------------------

function render(): void {
  const cfg = vscode.workspace.getConfiguration("aiCostTracker");
  const template = cfg.get<string>(
    "format",
    "$(symbol-event) Cursor: ${cost}${quota}",
  );

  if (!lastSummary) {
    statusBar.text = lastError
      ? "$(warning) Cursor: error"
      : "$(symbol-event) Cursor: …";
    statusBar.tooltip = buildTooltipNoData();
    statusBar.backgroundColor = lastError
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    return;
  }

  const stale = isStale(lastUpdatedAt, cfg.get<number>("staleAfterSec", STALE_DEFAULT_SEC));
  statusBar.text = renderTemplate(template, lastSummary) + (stale ? " ⚠" : "");
  statusBar.tooltip = buildTooltip(lastSummary, stale);
  statusBar.backgroundColor = stale
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
}

function renderTemplate(template: string, s: MonthSummary): string {
  const cost = `$${s.totalCostUsd.toFixed(2)}`;
  const tokens = s.totalInputTokens + s.totalOutputTokens +
    s.totalCacheWriteTokens + s.totalCacheReadTokens;
  const quotaFragment = primaryQuotaFragment(s);
  const quotaPct = quotaPercentText(s);
  return template
    .replace(/\$\{cost\}/g, cost)
    .replace(/\$\{tokens\}/g, formatTokens(tokens))
    .replace(/\$\{quota\}/g, quotaFragment)
    .replace(/\$\{quotaPct\}/g, quotaPct)
    .replace(/\$\{membership\}/g, s.membershipType || "—");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function preferredQuota(s: MonthSummary): Quota | null {
  if (s.isUnlimited) return null;
  if (s.individualQuota && s.individualQuota.enabled && s.individualQuota.limit !== null) {
    return s.individualQuota;
  }
  if (s.teamQuotaPooled && s.teamQuotaPooled.enabled && s.teamQuotaPooled.limit !== null) {
    return s.teamQuotaPooled;
  }
  return null;
}

function primaryQuotaFragment(s: MonthSummary): string {
  const q = preferredQuota(s);
  if (!q || q.usedPct === null) return "";
  return ` · ${Math.round(q.usedPct)}% used`;
}

function quotaPercentText(s: MonthSummary): string {
  const q = preferredQuota(s);
  return q && q.usedPct !== null ? `${Math.round(q.usedPct)}%` : "—";
}

// ----------------------------- tooltips -----------------------------------

function buildTooltip(s: MonthSummary, stale: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`### AI Cost Tracker · Cursor\n\n`);

  const cycle =
    s.billingCycleStart && s.billingCycleEnd
      ? ` (${s.billingCycleStart.slice(0, 10)} → ${s.billingCycleEnd.slice(0, 10)})`
      : "";
  md.appendMarkdown(`**This billing cycle${cycle}**\n\n`);
  md.appendMarkdown(`- Usage cost: **$${s.totalCostUsd.toFixed(2)}** _(from Cursor usage events)_\n`);
  md.appendMarkdown(
    `- The cursor.com website total can be ~$20 higher if it includes a base subscription / seat fee that this usage endpoint does not return.\n`,
  );
  appendQuotaLine(md, "Individual quota", s.individualQuota);
  appendQuotaLine(md, "Team pool", s.teamQuotaPooled);
  md.appendMarkdown(
    `- Membership: \`${s.membershipType || "—"}\`${s.isUnlimited ? " · _unlimited_" : ""}\n\n`,
  );

  if (s.byModel.length > 0) {
    md.appendMarkdown(`**Top models**\n\n`);
    const sorted = [...s.byModel].sort((a, b) => b.costUsd - a.costUsd);
    for (const m of sorted.slice(0, 4)) {
      md.appendMarkdown(`- \`${m.model}\`: $${m.costUsd.toFixed(2)}\n`);
    }
    const rest = sorted.slice(4);
    if (rest.length > 0) {
      const restCost = rest.reduce((sum, m) => sum + m.costUsd, 0);
      md.appendMarkdown(`- Other ${rest.length} model(s): $${restCost.toFixed(2)}\n`);
    }
    md.appendMarkdown("\n");
  }

  const updated = lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString() : "—";
  md.appendMarkdown(`_Last refreshed at ${updated}${stale ? " ⚠ stale" : ""}_\n\n`);
  md.appendMarkdown(`[Refresh now](command:aiCostTracker.refresh) · `);
  md.appendMarkdown(`[Show details](command:aiCostTracker.showDetails)`);
  return md;
}

function buildTooltipNoData(): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`### AI Cost Tracker · Cursor\n\n`);
  if (lastError) {
    md.appendMarkdown(`**Error**\n\n`);
    md.appendMarkdown(`${lastError}\n\n`);
    md.appendMarkdown(`- If you are signed out, sign back in to Cursor.\n`);
    md.appendMarkdown(`- If you use Remote-WSL/SSH, make sure Cursor is signed in on _this_ host.\n\n`);
  } else {
    md.appendMarkdown(`Fetching usage from cursor.com…\n\n`);
  }
  md.appendMarkdown(`[Refresh now](command:aiCostTracker.refresh)`);
  return md;
}

function appendQuotaLine(
  md: vscode.MarkdownString,
  label: string,
  q: Quota | null,
): void {
  if (!q || !q.enabled || q.limit === null) return;
  md.appendMarkdown(
    `- ${label}: ${q.used.toLocaleString()} / ${q.limit.toLocaleString()}` +
      (q.usedPct !== null ? ` (${q.usedPct.toFixed(1)}%)\n` : "\n"),
  );
}

function isStale(updatedAt: number | undefined, staleAfterSec: number): boolean {
  if (!updatedAt) return false;
  return Date.now() - updatedAt > staleAfterSec * 1000;
}

// ----------------------------- commands -----------------------------------

function showDetails(): void {
  if (!lastSummary) {
    void vscode.window.showInformationMessage(
      lastError
        ? `AI Cost Tracker: ${lastError}`
        : "AI Cost Tracker: no data yet.",
    );
    return;
  }
  void vscode.workspace
    .openTextDocument({
      content: JSON.stringify(lastSummary, null, 2),
      language: "json",
    })
    .then((doc) => vscode.window.showTextDocument(doc, { preview: true }));
}
