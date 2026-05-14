/**
 * AI Cost Tracker: Cursor AI billing and quota status-bar companion.
 *
 * Data flow:
 *
 *   ┌──────────┐   periodic   ┌─────────────────────┐   poll   ┌────────────┐
 *   │  tt CLI  │─────────────▶│ ~/.tt/status.json   │◀─────────│ AI Cost    │
 *   │ (python) │   write json │ (schema version=2)  │   read   │ (this ext) │
 *   └──────────┘              └─────────────────────┘          └────────────┘
 *
 * On activation, the extension first reads ``~/.tt/status.json`` if it exists,
 * then periodically spawns ``tt status`` to refresh that snapshot.
 *
 * The extension never opens Cursor's SQLite databases directly. The Python
 * ``tt`` CLI owns all data collection and writes the shared JSON contract.
 *
 * Schema v2 (current_month): ``tt status`` calls Cursor's dashboard APIs for
 * current-cycle model usage cost and quota. The default status text prefers
 * ``agents[i].current_month`` and falls back to local today buckets.
 */

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// ----------------------------- snapshot schema ----------------------------

interface TodayBucket {
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  messages: number;
  sessions: number;
}

interface RateLimitBucket {
  used_percentage: number | null;
  resets_at: number | null;
}

interface QuotaBucket {
  enabled: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  used_pct: number | null;
}

interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

interface CurrentMonth {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cycle_start: string;
  cycle_end: string;
  membership: string;
  is_unlimited: boolean;
  individual_quota: QuotaBucket | null;
  team_quota_pooled: QuotaBucket | null;
  by_model: ModelUsage[];
  fetched_at: string;
}

interface AgentSnapshot {
  id: string;
  name: string;
  model: string;
  today: TodayBucket;
  all_time: TodayBucket;
  current_month?: CurrentMonth | null;
  rate_limits: {
    five_hour: RateLimitBucket | null;
    seven_day: RateLimitBucket | null;
    model?: string;
    updated_at?: string;
  } | null;
}

interface Snapshot {
  version: number;
  updated_at: string;
  tt_version: string;
  agents: AgentSnapshot[];
}

// ----------------------------- main module -------------------------------

let statusBar: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let lastSnapshot: Snapshot | undefined;
let cycleIndex = 0;

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "aiCostTracker.cycleAgent";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCostTracker.refresh", () => refresh(true)),
    vscode.commands.registerCommand("aiCostTracker.openDashboard", openDashboard),
    vscode.commands.registerCommand("aiCostTracker.cycleAgent", cycleAgent),
    vscode.commands.registerCommand("aiCostTracker.showSnapshot", showSnapshot),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiCostTracker")) {
        scheduleRefresh();
        render();
      }
    }),
  );

  // Startup: render any existing snapshot first, then refresh asynchronously.
  loadSnapshotFromDisk();
  render();
  refresh(false);
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
  const interval = Math.max(5, cfg.get<number>("refreshIntervalSec", 30));
  refreshTimer = setInterval(() => refresh(false), interval * 1000);
}

function refresh(notifyOnError: boolean): void {
  const cfg = vscode.workspace.getConfiguration("aiCostTracker");
  const configuredCli = cfg.get<string>("cliPath", "tt") || "tt";
  const cli = resolveCli(configuredCli);
  const useShell =
    process.platform === "win32" && !hasPathSeparator(cli) && path.extname(cli) === "";

  // Spawn `tt status --json` and parse stdout. The CLI also writes the same
  // snapshot to ~/.tt/status.json, so multiple IDE windows can share it.
  const proc = cp.spawn(cli, ["status", "--json"], {
    env: buildChildEnv(),
    shell: useShell,
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

  proc.on("error", (err) => {
    setError(`Failed to execute \`${cli}\`: ${err.message}`, notifyOnError);
  });

  proc.on("close", (code) => {
    if (code !== 0) {
      // On non-zero exit, still try to render the previous snapshot from disk.
      loadSnapshotFromDisk();
      if (lastSnapshot === undefined) {
        setError(
          `\`${cli} status\` exited with code ${code}; ${stderr.trim() || "stderr was empty"}`,
          notifyOnError,
        );
      } else {
        render();
      }
      return;
    }
    try {
      const snap = JSON.parse(stdout) as Snapshot;
      if (typeof snap.version !== "number") {
        throw new Error("response did not include a version field");
      }
      lastSnapshot = snap;
    } catch (e) {
      // If stdout parsing fails, fall back to the on-disk snapshot.
      loadSnapshotFromDisk();
    }
    render();
  });
}

function loadSnapshotFromDisk(): void {
  const file = statusFilePath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    lastSnapshot = JSON.parse(raw) as Snapshot;
  } catch {
    // Missing file is normal before the first successful `tt status` run.
  }
}

/**
 * Remote Cursor / VS Code servers often start with a minimal PATH that excludes
 * user shell additions like ~/.local/bin. Windows Python console scripts also
 * commonly live under %APPDATA%\Python\Python3xx\Scripts. When the configured
 * CLI is a bare command name, probe common platform-specific fallback paths.
 */
let cachedCli: string | undefined;
function resolveCli(configured: string): string {
  if (hasPathSeparator(configured)) {
    return configured;
  }
  if (cachedCli) {
    return cachedCli;
  }
  for (const cand of cliCandidates(configured)) {
    if (isFile(cand)) {
      cachedCli = cand;
      return cand;
    }
  }
  cachedCli = configured;
  return configured;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isFile(file: string): boolean {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function cliCandidates(configured: string): string[] {
  const out: string[] = [];
  for (const dir of pathDirs(process.env.PATH || "")) {
    for (const name of executableNames(configured)) {
      out.push(path.join(dir, name));
    }
  }
  out.push(...fallbackCliCandidates(configured));
  return unique(out);
}

function executableNames(configured: string): string[] {
  if (process.platform !== "win32" || path.extname(configured)) {
    return [configured];
  }
  const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return unique([configured, ...pathext.map((ext) => `${configured}${ext}`)]);
}

function fallbackCliCandidates(configured: string): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const exeName = path.extname(configured) ? configured : `${configured}.exe`;
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localappdata = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(appdata, "Python", "Scripts", exeName),
      ...pythonScriptDirs(path.join(appdata, "Python")).map((dir) => path.join(dir, exeName)),
      ...pythonScriptDirs(path.join(localappdata, "Programs", "Python")).map((dir) =>
        path.join(dir, exeName),
      ),
      path.join(home, ".local", "bin", exeName),
    ];
  }

  const common = [
    path.join(home, ".local", "bin", configured),
    path.join(home, "bin", configured),
    path.join("/usr/local/bin", configured),
    path.join("/usr/bin", configured),
  ];
  if (process.platform === "darwin") {
    return [
      path.join("/opt/homebrew/bin", configured),
      path.join("/usr/local/bin", configured),
      path.join(home, ".local", "bin", configured),
      path.join(home, "bin", configured),
    ];
  }
  return common;
}

function pythonScriptDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
      .map((entry) => path.join(root, entry.name, "Scripts"));
  } catch {
    return [];
  }
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const existing = pathDirs(env.PATH || "");
  const fallbackDirs = fallbackCliCandidates("tt").map((candidate) => path.dirname(candidate));
  env.PATH = unique([...fallbackDirs, ...existing]).join(path.delimiter);
  return env;
}

function pathDirs(value: string): string[] {
  return value.split(path.delimiter).filter(Boolean);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function statusFilePath(): string {
  const cfg = vscode.workspace.getConfiguration("aiCostTracker");
  const override = cfg.get<string>("statusFile", "");
  if (override) {
    return override;
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || os.homedir();
    return path.join(appdata, ".tt", "status.json");
  }
  return path.join(os.homedir(), ".tt", "status.json");
}

// ----------------------------- rendering ----------------------------------

function render(): void {
  if (!lastSnapshot || lastSnapshot.agents.length === 0) {
    statusBar.text = "$(symbol-event) tt: no data";
    statusBar.tooltip =
      "AI Cost Tracker has no Cursor data yet. Make sure the `tt` CLI is installed, or run `tt status` once to initialize the snapshot.";
    statusBar.backgroundColor = undefined;
    return;
  }

  const cfg = vscode.workspace.getConfiguration("aiCostTracker");
  const agent = pickAgent(lastSnapshot.agents);
  const stale = isStale(lastSnapshot, cfg.get<number>("staleAfterSec", 600));
  const template = cfg.get<string>(
    "format",
    "$(symbol-event) ${agent}: ${primaryCost}${primaryQuota}",
  );

  statusBar.text = renderTemplate(template, agent) + (stale ? " ⚠" : "");
  statusBar.tooltip = buildTooltip(lastSnapshot, agent, stale);
  statusBar.backgroundColor = stale
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
}

function pickAgent(agents: AgentSnapshot[]): AgentSnapshot {
  const cfg = vscode.workspace.getConfiguration("aiCostTracker");
  const preferred = cfg.get<string>("preferredAgent", "cursor");

  if (preferred !== "auto") {
    const found = agents.find((a) => a.id === preferred);
    if (found) {
      return found;
    }
  }

  // Clicking the status bar cycles through available agents.
  const idx = ((cycleIndex % agents.length) + agents.length) % agents.length;
  return agents[idx];
}

function renderTemplate(template: string, a: AgentSnapshot): string {
  const fmtTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return String(n);
  };
  const fmtCost = (n: number): string => `$${n.toFixed(2)}`;

  const cm = a.current_month;
  const monthCost = cm ? fmtCost(cm.cost_usd) : "—";
  const monthTokens = cm
    ? fmtTokens(
        cm.input_tokens +
          cm.output_tokens +
          cm.cache_write_tokens +
          cm.cache_read_tokens,
      )
    : "—";
  const monthQuotaPctNum = cm
    ? monthQuotaPercent(cm)
    : null;
  const monthQuotaPct =
    monthQuotaPctNum !== null ? `${Math.round(monthQuotaPctNum)}%` : "—";

  // primaryCost / primaryQuota prefer current_month and fall back to today.
  const primaryCost = cm ? monthCost : fmtCost(a.today.cost_usd);
  const primaryQuota = primaryQuotaFragment(a);

  const quota = quotaFragment(a);
  const five = quotaPctText(a.rate_limits?.five_hour, "5h");
  const seven = quotaPctText(a.rate_limits?.seven_day, "7d");

  return template
    .replace(/\$\{agent\}/g, a.name)
    .replace(/\$\{model\}/g, a.model || "—")
    .replace(/\$\{todayTokens\}/g, fmtTokens(a.today.tokens))
    .replace(/\$\{todayCost\}/g, a.today.cost_usd.toFixed(2))
    .replace(/\$\{allTokens\}/g, fmtTokens(a.all_time.tokens))
    .replace(/\$\{allCost\}/g, a.all_time.cost_usd.toFixed(2))
    .replace(/\$\{monthCost\}/g, monthCost)
    .replace(/\$\{monthTokens\}/g, monthTokens)
    .replace(/\$\{monthQuotaPct\}/g, monthQuotaPct)
    .replace(/\$\{primaryCost\}/g, primaryCost)
    .replace(/\$\{primaryQuota\}/g, primaryQuota)
    .replace(/\$\{quota\}/g, quota)
    .replace(/\$\{quota5h\}/g, five)
    .replace(/\$\{quota7d\}/g, seven);
}

/** Prefer individual quota, then team pool quota, otherwise null. */
function monthQuotaPercent(cm: CurrentMonth): number | null {
  if (cm.is_unlimited) {
    return null;
  }
  const indiv = cm.individual_quota;
  if (indiv && indiv.enabled && indiv.used_pct !== null) {
    return indiv.used_pct;
  }
  const team = cm.team_quota_pooled;
  if (team && team.enabled && team.used_pct !== null) {
    return team.used_pct;
  }
  return null;
}

/** Most useful quota fragment for the active agent: monthly quota before 5h quota. */
function primaryQuotaFragment(a: AgentSnapshot): string {
  const cm = a.current_month;
  if (cm) {
    const pct = monthQuotaPercent(cm);
    if (pct !== null) {
      return ` · ${Math.round(pct)}% used`;
    }
  }
  return quotaFragment(a);
}

function quotaFragment(a: AgentSnapshot): string {
  const five = a.rate_limits?.five_hour;
  if (!five || five.used_percentage === null) {
    return "";
  }
  const pct = Math.round(five.used_percentage);
  return ` · 5h ${pct}%`;
}

function quotaPctText(b: RateLimitBucket | null | undefined, label: string): string {
  if (!b || b.used_percentage === null) {
    return "";
  }
  return `${label} ${Math.round(b.used_percentage)}%`;
}

function buildTooltip(snap: Snapshot, a: AgentSnapshot, stale: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`### AI Cost Tracker · ${a.name}\n\n`);

  const cm = a.current_month;
  if (cm) {
    const cycle =
      cm.cycle_start && cm.cycle_end
        ? ` (${cm.cycle_start.slice(0, 10)} → ${cm.cycle_end.slice(0, 10)})`
        : "";
    md.appendMarkdown(`**This billing cycle${cycle}**\n\n`);
    md.appendMarkdown(`- Usage cost: **$${cm.cost_usd.toFixed(2)}** _(from Cursor usage events)_\n`);
    md.appendMarkdown(
      `- Billing note: website total may be about **$20 higher** if it includes a base subscription / seat fee.\n`,
    );
    const individualQuota = cm.individual_quota;
    if (individualQuota && individualQuota.enabled && individualQuota.limit !== null) {
      const q = individualQuota;
      md.appendMarkdown(
        `- Individual quota: ${q.used.toLocaleString()} / ${Number(q.limit).toLocaleString()} (${q.used_pct?.toFixed(1)}%)\n`,
      );
    }
    const teamQuota = cm.team_quota_pooled;
    if (teamQuota && teamQuota.enabled && teamQuota.limit !== null) {
      const q = teamQuota;
      md.appendMarkdown(
        `- Team pool: ${q.used.toLocaleString()} / ${Number(q.limit).toLocaleString()} (${q.used_pct?.toFixed(1)}%)\n`,
      );
    }
    md.appendMarkdown(
      `- Membership: \`${cm.membership || "—"}\`${cm.is_unlimited ? " · _unlimited_" : ""}\n\n`,
    );

    if (cm.by_model.length > 0) {
      md.appendMarkdown(`**Top models**\n\n`);
      const sorted = [...cm.by_model].sort((x, y) => y.cost_usd - x.cost_usd);
      const top = sorted.slice(0, 4);
      for (const m of top) {
        md.appendMarkdown(`- \`${m.model}\`: $${m.cost_usd.toFixed(2)}\n`);
      }
      const rest = sorted.slice(top.length);
      if (rest.length > 0) {
        const restCost = rest.reduce((sum, m) => sum + m.cost_usd, 0);
        md.appendMarkdown(`- Other ${rest.length} model(s): $${restCost.toFixed(2)}\n`);
      }
      md.appendMarkdown("\n");
    }
  } else if (!cm) {
    const hasLocal =
      a.today.tokens > 0 || a.all_time.tokens > 0 || a.today.messages > 0;
    if (hasLocal) {
      md.appendMarkdown("**Today (local data)**\n\n");
      md.appendMarkdown(
        `- Tokens: ${a.today.tokens.toLocaleString()} · Cost (eq.): $${a.today.cost_usd.toFixed(2)} · Messages: ${a.today.messages}\n\n`,
      );
    }
    md.appendMarkdown(
      `_No local data and no server data yet. Run \`tt status\` and check that Cursor is logged in._\n\n`,
    );
  } else if (a.id === "cursor") {
    md.appendMarkdown(
      `_Local Cursor token buckets may be zero because recent Cursor builds no longer write real local \`tokenCount\` values._\n\n`,
    );
  }

  if (a.rate_limits) {
    md.appendMarkdown("**Rate limits**\n\n");
    const five = a.rate_limits.five_hour;
    const seven = a.rate_limits.seven_day;
    if (five && five.used_percentage !== null) {
      md.appendMarkdown(`- 5h: ${five.used_percentage.toFixed(0)}%\n`);
    }
    if (seven && seven.used_percentage !== null) {
      md.appendMarkdown(`- 7d: ${seven.used_percentage.toFixed(0)}%\n`);
    }
    md.appendMarkdown("\n");
  }

  md.appendMarkdown(`_Snapshot: ${snap.updated_at}${stale ? " ⚠ stale" : ""}_`);
  return md;
}

function isStale(snap: Snapshot, staleAfterSec: number): boolean {
  const t = Date.parse(snap.updated_at);
  if (Number.isNaN(t)) {
    return true;
  }
  return Date.now() - t > staleAfterSec * 1000;
}

// ----------------------------- commands -----------------------------------

function cycleAgent(): void {
  if (!lastSnapshot || lastSnapshot.agents.length <= 1) {
    return;
  }
  cycleIndex = (cycleIndex + 1) % lastSnapshot.agents.length;
  render();
}

function openDashboard(): void {
  const cfg = vscode.workspace.getConfiguration("aiCostTracker");
  const cli = cfg.get<string>("cliPath", "tt") || "tt";
  const term = vscode.window.createTerminal({ name: "AI Cost Tracker" });
  term.sendText(cli, true);
  term.show();
}

function showSnapshot(): void {
  if (!lastSnapshot) {
    void vscode.window.showInformationMessage("AI Cost Tracker: no snapshot yet");
    return;
  }
  void vscode.workspace
    .openTextDocument({
      content: JSON.stringify(lastSnapshot, null, 2),
      language: "json",
    })
    .then((doc) => vscode.window.showTextDocument(doc, { preview: true }));
}

function setError(msg: string, alsoToast: boolean): void {
  statusBar.text = `$(error) tt: error`;
  statusBar.tooltip = `AI Cost Tracker error: ${msg}\n\n• Check that the \`tt\` CLI is installed and visible on PATH\n• Or set \`aiCostTracker.cliPath\` to an absolute path\n• Command Palette -> "AI Cost Tracker: Refresh now" to retry`;
  statusBar.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.errorBackground",
  );
  if (alsoToast) {
    void vscode.window.showErrorMessage(`ai-cost-tracker: ${msg}`);
  }
}
