/**
 * Cursor billing/quota fetcher. Pure Node — no Python CLI, no subprocess.
 *
 * Data flow:
 *
 *   ┌────────────────────────────┐   read   ┌─────────────────┐   HTTPS POST
 *   │ <globalStorage>/state.vscdb│─────────▶│ cursorAuth/     │──────────────▶ cursor.com
 *   │ (Cursor SQLite, same host) │  sql.js  │ accessToken JWT │   2 endpoints
 *   └────────────────────────────┘          └─────────────────┘
 *
 * We avoid the running Cursor's WAL contention by opening a small read-only
 * SQLite query against a private copy. ``state.vscdb`` can be GB-scale, so we
 * never load the whole DB into memory — sql.js is given only the bytes through
 * a typed-array view, and we trust the OS page cache.
 *
 * The dashboard API contract here is byte-identical to ``token_tracker``'s
 * ``adapters/cursor_api.py``; both call the same two POST endpoints with the
 * same ``WorkosCursorSessionToken=<sub>::<jwt>`` cookie shape. Keep them in
 * sync if Cursor server-side changes the JSON.
 */

import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";

import initSqlJs, { Database, SqlJsStatic } from "sql.js";

// ----------------------------- types --------------------------------------

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface Quota {
  enabled: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  usedPct: number | null;
}

export interface MonthSummary {
  fetchedAt: string;
  billingCycleStart: string;
  billingCycleEnd: string;
  membershipType: string;
  isUnlimited: boolean;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  byModel: ModelUsage[];
  individualQuota: Quota | null;
  teamQuotaPooled: Quota | null;
}

export type FetchStatus =
  | { ok: true; summary: MonthSummary }
  | { ok: false; error: FetchError };

export type FetchError =
  | "state_db_not_found"
  | "no_access_token"
  | "token_expired"
  | "invalid_token"
  | "http_error"
  | "network_error"
  | "shape_error";

// ----------------------------- DB discovery --------------------------------

/**
 * Where Cursor keeps its per-user state. We probe a few candidates because:
 * - Extension is the same VSIX in local Windows, macOS, Linux, WSL host, SSH host.
 * - In Remote-WSL the extension runs inside ``~/.cursor-server/`` — its
 *   ``globalStorage`` is the one we want, not the Windows-side one.
 * - ``CURSOR_USER_DIR`` / ``CURSOR_GLOBAL_STORAGE`` overrides are honored so
 *   tests and exotic installs can point us elsewhere.
 */
export function candidateUserDirs(): string[] {
  const env = process.env.CURSOR_GLOBAL_STORAGE;
  if (env) {
    // env points at globalStorage/, the User/ dir is one up.
    return [path.dirname(env)];
  }
  const userEnv = process.env.CURSOR_USER_DIR;
  if (userEnv) {
    return [userEnv];
  }

  const home = os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const appData =
    process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData =
    process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

  const candidates: string[] = [
    // macOS
    path.join(home, "Library", "Application Support", "Cursor", "User"),
    // Linux
    path.join(xdgConfig, "Cursor", "User"),
    // Cursor Remote-WSL / Remote-SSH extension host
    path.join(home, ".cursor-server", "data", "User"),
    // VS Code remote server, for users who sideload us into VS Code.
    path.join(home, ".vscode-server", "data", "User"),
    // Windows native
    path.join(appData, "Cursor", "User"),
    path.join(localAppData, "Cursor", "User"),
  ];

  // WSL: probe the Windows side too, in case the extension is somehow hosted
  // in a WSL extension host but the user only runs Cursor on Windows.
  try {
    const winUsers = "/mnt/c/Users";
    if (fs.statSync(winUsers).isDirectory()) {
      for (const entry of fs.readdirSync(winUsers)) {
        if (
          ["Public", "Default", "Default User", "All Users", "desktop.ini"].includes(
            entry,
          )
        ) {
          continue;
        }
        candidates.push(
          path.join(winUsers, entry, "AppData", "Roaming", "Cursor", "User"),
        );
        candidates.push(
          path.join(winUsers, entry, "AppData", "Local", "Cursor", "User"),
        );
      }
    }
  } catch {
    // /mnt/c not present — normal outside WSL.
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = process.platform === "win32" ? c.toLowerCase() : c;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export function findStateDb(): string | null {
  for (const userDir of candidateUserDirs()) {
    const db = path.join(userDir, "globalStorage", "state.vscdb");
    try {
      if (fs.statSync(db).isFile()) {
        return db;
      }
    } catch {
      // Missing path — try next candidate.
    }
  }
  return null;
}

// ----------------------------- sql.js bootstrap ----------------------------

let sqlJsPromise: Promise<SqlJsStatic> | undefined;
let wasmDirOverride: string | undefined;

/**
 * The extension's ``activate()`` calls this with the location of bundled
 * ``sql-wasm.wasm`` (typically ``<extensionPath>/media``). We cannot ask sql.js
 * to follow CommonJS resolution because the file ships as a side-by-side asset.
 */
export function setWasmDirectory(dir: string): void {
  wasmDirOverride = dir;
}

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => {
        if (wasmDirOverride) {
          return path.join(wasmDirOverride, file);
        }
        // Best-effort fallback: alongside our compiled JS.
        return path.join(__dirname, file);
      },
    });
  }
  return sqlJsPromise;
}

// ----------------------------- access token --------------------------------

export interface AccessToken {
  token: string;
  sub: string;
  expiresAt: number; // unix seconds
}

/**
 * Decode a JWT we cached previously, return it only if still valid. Centralized
 * so the extension layer doesn't reimplement the expiry logic.
 */
export function validateCachedToken(token: AccessToken | undefined): AccessToken | null {
  if (!token) return null;
  if (!token.token || !token.sub) return null;
  if (token.expiresAt < Date.now() / 1000 + 60) return null;
  return token;
}

export interface ReadAccessTokenResult {
  token: AccessToken | null;
  // For diagnostics only: which `cursorAuth/*` keys were present in the DB.
  // Never includes values, so it is safe to log.
  cursorAuthKeys: string[];
  // Indicates how the token was ultimately recovered, for the diagnostics
  // log. "sql" = found via sql.js SELECT against the main DB file. "wal" =
  // recovered by scanning the SQLite WAL sidecar because the SELECT returned
  // no rows. "none" = no token was found by either path.
  source: "sql" | "wal" | "none";
}

export async function readAccessToken(dbPath: string): Promise<AccessToken | null> {
  const res = await readAccessTokenDetailed(dbPath);
  return res.token;
}

export async function readAccessTokenDetailed(
  dbPath: string,
): Promise<ReadAccessTokenResult> {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(dbPath);
  } catch {
    return { token: null, cursorAuthKeys: [], source: "none" };
  }

  const SQL = await loadSqlJs();
  let db: Database | undefined;
  let sqlKeys: string[] = [];
  try {
    db = new SQL.Database(buf);
  } catch {
    db = undefined;
  }

  if (db) {
    try {
      // Pull every key under cursorAuth/* so we can both pick the right one
      // and emit a key list to the diagnostic log when nothing matched.
      // Cursor has historically stored the token under
      // `cursorAuth/accessToken`, but newer builds may use a slightly
      // different key shape; scanning the prefix lets us survive that
      // without another release.
      const res = db.exec(
        "SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth%'",
      );
      if (res.length) {
        const rows = res[0].values as Array<[unknown, unknown]>;
        for (const [k] of rows) {
          if (typeof k === "string") sqlKeys.push(k);
        }

        const preferred = ["cursorAuth/accessToken", "cursorAuth.accessToken"];
        const ordered = [
          ...rows.filter(
            ([k]) => typeof k === "string" && preferred.includes(k as string),
          ),
          ...rows.filter(
            ([k]) => typeof k === "string" && !preferred.includes(k as string),
          ),
        ];
        for (const [, rawValue] of ordered) {
          if (typeof rawValue !== "string") continue;
          const tok = parseJwtToToken(rawValue);
          if (tok) {
            return {
              token: tok,
              cursorAuthKeys: sqlKeys,
              source: "sql",
            };
          }
        }
      }
    } finally {
      db.close();
    }
  }

  // SQL path returned no usable token. The most common reason on Windows is
  // that Cursor is still running and the freshly written token still lives
  // in the SQLite WAL sidecar — sql.js loads only the main DB bytes and
  // cannot apply the WAL, so any rows written after the last checkpoint are
  // invisible to the SELECT above. Fall back to a byte scan of the WAL
  // sidecar to find the JWT directly. We intentionally do NOT scan the main
  // DB byte stream: if the token were present in the main file the SQL
  // SELECT would already have returned it, and the main DB is regularly
  // multiple GB which is too large to bytes-scan cheaply.
  const walBytes = readIfExists(`${dbPath}-wal`);
  if (walBytes) {
    const tok = scanRawForJwt(walBytes);
    if (tok) {
      return { token: tok, cursorAuthKeys: sqlKeys, source: "wal" };
    }
  }

  return { token: null, cursorAuthKeys: sqlKeys, source: "none" };
}

function readIfExists(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/**
 * Decode a JWT string into an AccessToken; null if shape/payload is wrong.
 */
function parseJwtToToken(raw: string): AccessToken | null {
  if (raw.split(".").length !== 3) return null;
  const payload = decodeJwtPayload(raw);
  if (!payload) return null;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const exp = Number(payload.exp);
  if (!sub || !Number.isFinite(exp)) return null;
  return { token: raw, sub, expiresAt: exp };
}

/**
 * Last-resort fallback for Cursor builds where the access token has just
 * been written and is still pinned in the SQLite WAL sidecar. We scan the
 * raw bytes for the string `cursorAuth/accessToken`, then read forward to
 * the next plausible JWT (three base64url segments separated by `.`). This
 * is a byte-level heuristic, not a SQLite parse, so it has to validate the
 * candidate string through ``parseJwtToToken`` before trusting it.
 *
 * The scan is chunked so we never allocate a JS string larger than ~64 MB.
 * Node strings have a hard upper bound of about 512 MB and a Cursor main DB
 * can exceed that several times over; even though we only call this on the
 * WAL sidecar today, keeping the routine chunk-safe avoids surprises if a
 * future caller hands it a larger buffer.
 */
const SCAN_CHUNK_BYTES = 64 * 1024 * 1024;
// 8 KB overlap: SQLite pages are at most 64 KB; a JWT plus the
// `cursorAuth/accessToken` key prefix is well under 8 KB, so this is enough
// to never split a match across chunks. Keep the constant generous because
// a missed token here means a regression to "session token not found".
const SCAN_OVERLAP_BYTES = 8 * 1024;

export function scanRawForJwt(bytes: Buffer): AccessToken | null {
  const jwtCharset = "A-Za-z0-9_\\-";
  const jwtRe = new RegExp(
    `[${jwtCharset}]+\\.[${jwtCharset}]+\\.[${jwtCharset}]+`,
    "g",
  );
  const keyRe = /cursorAuth[\/\.]accessToken/g;

  // Strategy 1: locate the auth key and read the JWT that immediately
  // follows it. SQLite stores key and value back-to-back in the page
  // payload, so the value is normally within a few hundred bytes of the key
  // string. This is the high-precision path; we run it first.
  let stash: AccessToken | null = null;
  forEachChunk(bytes, (text) => {
    keyRe.lastIndex = 0;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(text)) !== null) {
      jwtRe.lastIndex = keyMatch.index + keyMatch[0].length;
      const m = jwtRe.exec(text);
      if (!m) continue;
      if (m.index - keyMatch.index > 4096) continue;
      const tok = parseJwtToToken(m[0]);
      if (tok) {
        stash = tok;
        return true; // stop early
      }
    }
    return false;
  });
  if (stash) return stash;

  // Strategy 2: some WAL frames split the key off from the value across the
  // page boundary. Walk every JWT-shaped run and accept the first one whose
  // payload decodes as a Cursor access token (has `sub` and a future-ish
  // `exp`). Higher false-positive risk, so it is only used as fallback.
  forEachChunk(bytes, (text) => {
    jwtRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = jwtRe.exec(text)) !== null) {
      const tok = parseJwtToToken(m[0]);
      if (tok) {
        stash = tok;
        return true;
      }
    }
    return false;
  });
  return stash;
}

/**
 * Yield latin1-decoded slices of ``bytes`` no larger than SCAN_CHUNK_BYTES,
 * with SCAN_OVERLAP_BYTES of overlap between consecutive chunks so a match
 * is never split across slice boundaries. ``cb`` returning true stops
 * iteration early.
 */
function forEachChunk(bytes: Buffer, cb: (text: string) => boolean): void {
  if (bytes.length <= SCAN_CHUNK_BYTES) {
    cb(bytes.toString("latin1"));
    return;
  }
  let start = 0;
  while (start < bytes.length) {
    const end = Math.min(start + SCAN_CHUNK_BYTES, bytes.length);
    const slice = bytes.subarray(start, end).toString("latin1");
    const stop = cb(slice);
    if (stop) return;
    if (end === bytes.length) return;
    start = end - SCAN_OVERLAP_BYTES;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const obj = JSON.parse(json);
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}

// ----------------------------- dashboard API -------------------------------

const BASE = "https://cursor.com";
const USER_AGENT = "ai-cost-tracker-cursor/0.4 (+https://github.com/zhmzhen/ai-cost-tracker)";

function postJson<T>(
  urlPath: string,
  token: AccessToken,
  body: object,
  timeoutMs: number,
): Promise<T> {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  // The Cursor web client encodes the cookie as: WorkosCursorSessionToken=<sub>::<jwt>
  // We percent-encode the "::" separator to match what the browser sends.
  const cookie = `WorkosCursorSessionToken=${token.sub}%3A%3A${token.token}`;

  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      `${BASE}${urlPath}`,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Accept: "application/json",
          Origin: BASE,
          Referer: `${BASE}/dashboard`,
          "User-Agent": USER_AGENT,
          Cookie: cookie,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;
          const text = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(new HttpError(status, text));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}`);
  }
}

// ----------------------------- assembly ------------------------------------

interface AggregatedUsageResponse {
  totalCostCents?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheWriteTokens?: number;
  totalCacheReadTokens?: number;
  aggregations?: Array<{
    modelIntent?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalCents?: number;
  }>;
}

interface UsageSummaryResponse {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  membershipType?: string;
  isUnlimited?: boolean;
  individualUsage?: { overall?: RawQuota };
  teamUsage?: { pooled?: RawQuota };
}

interface RawQuota {
  enabled?: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
}

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toQuota(raw: RawQuota | undefined): Quota | null {
  if (!raw) return null;
  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit) ? raw.limit : null;
  const remaining =
    typeof raw.remaining === "number" && Number.isFinite(raw.remaining)
      ? raw.remaining
      : null;
  const used = toInt(raw.used);
  const usedPct =
    limit !== null && limit > 0 ? Math.round((used / limit) * 10000) / 100 : null;
  return { enabled: Boolean(raw.enabled), used, limit, remaining, usedPct };
}

function assemble(
  agg: AggregatedUsageResponse,
  summ: UsageSummaryResponse,
): MonthSummary {
  const byModel: ModelUsage[] = (agg.aggregations || []).map((a) => ({
    model: String(a.modelIntent || "unknown"),
    inputTokens: toInt(a.inputTokens),
    outputTokens: toInt(a.outputTokens),
    cacheWriteTokens: toInt(a.cacheWriteTokens),
    cacheReadTokens: toInt(a.cacheReadTokens),
    costUsd: (Number(a.totalCents) || 0) / 100,
  }));
  return {
    fetchedAt: new Date().toISOString(),
    billingCycleStart: String(summ.billingCycleStart || ""),
    billingCycleEnd: String(summ.billingCycleEnd || ""),
    membershipType: String(summ.membershipType || ""),
    isUnlimited: Boolean(summ.isUnlimited),
    totalCostUsd: (Number(agg.totalCostCents) || 0) / 100,
    totalInputTokens: toInt(agg.totalInputTokens),
    totalOutputTokens: toInt(agg.totalOutputTokens),
    totalCacheWriteTokens: toInt(agg.totalCacheWriteTokens),
    totalCacheReadTokens: toInt(agg.totalCacheReadTokens),
    byModel,
    individualQuota: toQuota(summ.individualUsage?.overall),
    teamQuotaPooled: toQuota(summ.teamUsage?.pooled),
  };
}

// ----------------------------- public entrypoint ---------------------------

export type TokenResult =
  | { ok: true; token: AccessToken }
  | { ok: false; error: FetchError };

/**
 * Locate Cursor's state DB and extract a fresh access token. This is the slow
 * path because ``state.vscdb`` can be hundreds of MB and sometimes lives on a
 * cross-VM 9P mount (WSL → ``/mnt/c/...``) where reading it takes 30+ seconds.
 * The extension layer should cache the returned token and only call this when
 * the cached one is missing or expired.
 */
export interface AcquireDiagnostics {
  // The on-disk path of the state DB we ultimately read, if any.
  dbPath: string | null;
  // All candidate User directories that were considered, in order.
  candidateUserDirs: string[];
  // Keys observed under `cursorAuth*` in the DB (no values).
  cursorAuthKeys: string[];
  // How the token was ultimately recovered: "sql" path (the normal one),
  // "wal" path (WAL sidecar byte-scan fallback), or "none".
  source: "sql" | "wal" | "none";
}

export type TokenResultWithDiagnostics =
  | { ok: true; token: AccessToken; diagnostics: AcquireDiagnostics }
  | { ok: false; error: FetchError; diagnostics: AcquireDiagnostics };

export async function acquireAccessToken(): Promise<TokenResult> {
  const r = await acquireAccessTokenDetailed();
  if (r.ok) return { ok: true, token: r.token };
  return { ok: false, error: r.error };
}

export async function acquireAccessTokenDetailed(): Promise<TokenResultWithDiagnostics> {
  const candidates = candidateUserDirs();
  const db = findStateDb();
  const baseDiag: AcquireDiagnostics = {
    dbPath: db,
    candidateUserDirs: candidates,
    cursorAuthKeys: [],
    source: "none",
  };
  if (!db) {
    return { ok: false, error: "state_db_not_found", diagnostics: baseDiag };
  }
  let detailed: ReadAccessTokenResult;
  try {
    detailed = await readAccessTokenDetailed(db);
  } catch {
    return { ok: false, error: "invalid_token", diagnostics: baseDiag };
  }
  const diag: AcquireDiagnostics = {
    ...baseDiag,
    cursorAuthKeys: detailed.cursorAuthKeys,
    source: detailed.source,
  };
  if (!detailed.token) {
    return { ok: false, error: "no_access_token", diagnostics: diag };
  }
  if (detailed.token.expiresAt < Date.now() / 1000 + 60) {
    return { ok: false, error: "token_expired", diagnostics: diag };
  }
  return { ok: true, token: detailed.token, diagnostics: diag };
}

/**
 * Fast path: call the Cursor dashboard API with a token we already have. This
 * usually completes in well under a second; the only slow step in the whole
 * pipeline is the initial SQLite read in ``acquireAccessToken``.
 */
export async function fetchMonthSummaryWithToken(
  token: AccessToken,
  timeoutMs = 8000,
): Promise<FetchStatus> {
  try {
    const [agg, summ] = await Promise.all([
      postJson<AggregatedUsageResponse>(
        "/api/dashboard/get-aggregated-usage-events",
        token,
        {},
        timeoutMs,
      ),
      postJson<UsageSummaryResponse>(
        "/api/usage-summary",
        token,
        {},
        timeoutMs,
      ),
    ]);
    if (typeof agg !== "object" || agg === null) {
      return { ok: false, error: "shape_error" };
    }
    if (typeof summ !== "object" || summ === null) {
      return { ok: false, error: "shape_error" };
    }
    return { ok: true, summary: assemble(agg, summ) };
  } catch (e) {
    if (e instanceof HttpError) {
      return { ok: false, error: "http_error" };
    }
    return { ok: false, error: "network_error" };
  }
}

/**
 * Convenience wrapper: acquire the token (slow path the first time, cached
 * thereafter) and call the API. Used by tests and by the legacy single-call
 * path. The extension layer prefers ``acquireAccessToken`` +
 * ``fetchMonthSummaryWithToken`` so it can cache tokens explicitly.
 */
export async function fetchMonthSummary(timeoutMs = 8000): Promise<FetchStatus> {
  const t = await acquireAccessToken();
  if (!t.ok) return t;
  return fetchMonthSummaryWithToken(t.token, timeoutMs);
}

/** Human-friendly error message for tooltip use. */
export function describeError(err: FetchError): string {
  switch (err) {
    case "state_db_not_found":
      return "Could not find Cursor's state database. Are you signed in to Cursor on this machine?";
    case "no_access_token":
      return (
        "Cursor session token not found in the local state database. " +
        "Try signing out and back in to Cursor on this machine, then run " +
        "`AI Cost Tracker: Refresh now`. Run `AI Cost Tracker: Show logs` to see " +
        "which state.vscdb was inspected and which `cursorAuth/*` keys it contained."
      );
    case "token_expired":
      return "Cursor session token is expired. Restart Cursor or sign back in so it refreshes the token.";
    case "invalid_token":
      return "Cursor session token could not be decoded.";
    case "http_error":
      return "Cursor dashboard API returned an error. The session may have been revoked, or Cursor's API has changed.";
    case "network_error":
      return "Could not reach cursor.com. Check the network connection and proxy settings.";
    case "shape_error":
      return "Cursor dashboard API returned an unexpected response shape.";
  }
}
