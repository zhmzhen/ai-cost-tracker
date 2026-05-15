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
  acquireAccessTokenDetailed,
  describeError,
  fetchMonthSummaryWithToken,
  runTokenProbe,
  setWasmDirectory,
  validateCachedToken,
} from "./cursor";

let extensionContext: vscode.ExtensionContext;
let statusBar: vscode.StatusBarItem;
let logger: vscode.OutputChannel;
let refreshTimer: NodeJS.Timeout | undefined;
let lastSummary: MonthSummary | undefined;
let lastError: string | undefined;
let lastUpdatedAt: number | undefined;
let inflight: Promise<void> | undefined;

const REFRESH_MIN_SEC = 5;
const REFRESH_DEFAULT_SEC = 60;
const STALE_DEFAULT_SEC = 600;
const TOKEN_STATE_KEY = "aiCostTracker.token.v1";
// Stable id/name so Cursor can persist the user's show/hide choice and surface
// it in the status-bar context menu. Without these, some Cursor builds hide
// the item on first paint and the user has no obvious way to recover it.
const STATUS_BAR_ID = "aiCostTracker.statusBar";
const STATUS_BAR_NAME = "AI Cost Tracker";

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  logger = vscode.window.createOutputChannel("AI Cost Tracker");
  context.subscriptions.push(logger);
  log("activate: starting (version 0.4.9)");

  // Create the status bar item FIRST and unconditionally. Anything below that
  // throws (sql.js wasm path, command registration, etc.) must not be allowed
  // to leave the user with no visible UI.
  try {
    statusBar = vscode.window.createStatusBarItem(
      STATUS_BAR_ID,
      vscode.StatusBarAlignment.Right,
      100,
    );
    statusBar.name = STATUS_BAR_NAME;
    statusBar.command = "aiCostTracker.refresh";
    statusBar.text = "$(symbol-event) Cursor: …";
    statusBar.tooltip = "AI Cost Tracker: fetching usage…";
    statusBar.show();
    context.subscriptions.push(statusBar);
    log("activate: status bar created");
  } catch (e) {
    // Extremely defensive: if the id-based overload is unsupported, fall back
    // to the legacy positional overload so we still render something.
    log(`activate: id-based createStatusBarItem failed: ${describe(e)}`);
    statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    statusBar.command = "aiCostTracker.refresh";
    statusBar.text = "$(symbol-event) Cursor: …";
    statusBar.tooltip = "AI Cost Tracker: fetching usage…";
    statusBar.show();
    context.subscriptions.push(statusBar);
  }

  try {
    // sql.js needs to find its sibling sql-wasm.wasm at runtime. We ship it
    // alongside the compiled JS so it works in every install target (local,
    // Remote-WSL, Remote-SSH, Windows native) without any user configuration.
    setWasmDirectory(path.join(context.extensionPath, "media"));
  } catch (e) {
    log(`activate: setWasmDirectory failed: ${describe(e)}`);
  }

  // Register commands inside try/catch so a failure in one does not prevent
  // the others from being available — in particular ``aiCostTracker.show``
  // is the recovery handle for users whose status bar item was hidden.
  safeRegister(context, "aiCostTracker.refresh", () => refresh(true));
  safeRegister(context, "aiCostTracker.showDetails", () => showDetails());
  safeRegister(context, "aiCostTracker.show", async () => {
    statusBar.show();
    // statusBar.show() only flips the extension-side visibility flag. Two
    // independent workbench-side things can still hide it from the user:
    //   1. The status bar as a whole is disabled in View → Appearance.
    //   2. The per-id hidden list (the status bar context menu) was used to
    //      hide this specific item.
    // Neither has an "unhide by id" API, so we expose actions that map to the
    // two recovery flows users actually have: toggle the entire status bar,
    // or open the logs to see what happened.
    const choice = await vscode.window.showInformationMessage(
      "AI Cost Tracker: status bar item is set to visible. If you still see " +
        "nothing, the whole status bar may be turned off (View → Appearance → " +
        "Status Bar), or this specific item may be hidden via the status bar " +
        "context menu — right-click any empty area of the status bar and tick " +
        "\"AI Cost Tracker\".",
      "Toggle status bar",
      "Show logs",
    );
    if (choice === "Toggle status bar") {
      await vscode.commands.executeCommand(
        "workbench.action.toggleStatusBarVisibility",
      );
    } else if (choice === "Show logs") {
      logger.show(true);
    }
  });
  safeRegister(context, "aiCostTracker.showLogs", () => logger.show(true));
  safeRegister(context, "aiCostTracker.runProbe", async () => {
    // Force the diagnostic probe to run regardless of whether the SQL
    // lookup currently succeeds. Lets the maintainer verify on a
    // working machine that the probe code in the deployed VSIX is wired
    // up correctly, instead of having to break the user's auth state.
    logger.show(true);
    log("runProbe: starting diagnostic probe");
    try {
      const p = await runTokenProbe();
      if (!p) {
        log("runProbe: no state DB found; nothing to probe");
        return;
      }
      log(`runProbe: dbPath=${p.dbPath}`);
      log(`runProbe: cursorAuthKeys=${JSON.stringify(p.cursorAuthKeys)}`);
      log(`runProbe: tables=${JSON.stringify(p.tables)}`);
      log(
        `runProbe: itemTableSuspectKeys=${JSON.stringify(
          p.itemTableSuspectKeys,
        )}`,
      );
      log(
        `runProbe: mainDb jwtCount=${p.mainDbJwtCount} samplePrefix=${
          p.mainDbJwtSamplePrefix ?? "<none>"
        }`,
      );
      log(
        `runProbe: wal jwtCount=${p.walJwtCount} samplePrefix=${
          p.walJwtSamplePrefix ?? "<none>"
        }`,
      );
      log(`runProbe: storageJsonKeys=${JSON.stringify(p.storageJsonKeys)}`);
    } catch (e) {
      log(`runProbe: failed: ${describe(e)}`);
    }
  });
  safeRegister(context, "aiCostTracker.forceReread", async () => {
    // Diagnostic-only: clear the cached JWT so the next refresh re-runs the
    // full lookup pipeline (SQL SELECT → WAL byte-scan). Useful when
    // verifying that the WAL fallback actually rescues a token on a machine
    // where the cached path normally hides the issue. Not used by happy-path
    // flows; safe to leave registered.
    await extensionContext.globalState.update(TOKEN_STATE_KEY, undefined);
    log("forceReread: cached token cleared; triggering fresh refresh");
    logger.show(true);
    await refresh(true);
  });

  context.subscriptions.push(
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
  log("activate: done");
}

function safeRegister(
  context: vscode.ExtensionContext,
  command: string,
  handler: (...args: unknown[]) => unknown,
): void {
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, handler),
    );
  } catch (e) {
    log(`activate: registerCommand(${command}) failed: ${describe(e)}`);
  }
}

function log(msg: string): void {
  try {
    logger?.appendLine(`[${new Date().toISOString()}] ${msg}`);
  } catch {
    // logger may be undefined extremely early; never let logging itself throw.
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
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

  const fresh = await acquireAccessTokenDetailed();
  // Always log diagnostics: scanned candidates, the file we actually used, and
  // which cursorAuth keys lived in that DB. This is the answer to "I'm signed
  // in but the extension still says no token" — we can tell whether we hit
  // the wrong state.vscdb or the right one with the wrong key.
  log(`token lookup: dbPath=${fresh.diagnostics.dbPath ?? "<none>"}`);
  log(
    `token lookup: candidate userDirs=${JSON.stringify(
      fresh.diagnostics.candidateUserDirs,
    )}`,
  );
  log(
    `token lookup: cursorAuthKeys=${JSON.stringify(
      fresh.diagnostics.cursorAuthKeys,
    )}`,
  );
  log(`token lookup: source=${fresh.diagnostics.source}`);
  const probe = fresh.diagnostics.probe;
  if (probe) {
    // When the canonical SELECT misses we need to know *where* the token
    // went. The probe is bounded and contains no secrets — only names and
    // counts — so it is safe to surface in plain logs.
    log(`token probe: tables=${JSON.stringify(probe.tables)}`);
    log(
      `token probe: itemTableSuspectKeys=${JSON.stringify(
        probe.itemTableSuspectKeys,
      )}`,
    );
    log(
      `token probe: mainDb jwtCount=${probe.mainDbJwtCount} samplePrefix=${
        probe.mainDbJwtSamplePrefix ?? "<none>"
      }`,
    );
    log(
      `token probe: wal jwtCount=${probe.walJwtCount} samplePrefix=${
        probe.walJwtSamplePrefix ?? "<none>"
      }`,
    );
    log(
      `token probe: storageJsonKeys=${JSON.stringify(probe.storageJsonKeys)}`,
    );
  }
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
