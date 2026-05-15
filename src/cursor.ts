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
  // errno from readFileSync(dbPath) when it failed, e.g. "EBUSY" or
  // "EACCES" on Windows when Cursor holds an exclusive lock. We were
  // previously swallowing this and returning source=none, which made the
  // failure indistinguishable from "DB has no cursorAuth rows" — both
  // showed up as cursorAuthKeys=[]. Always log this when set.
  readError?: string;
  // Extra signal collected when the canonical lookup fails. These exist
  // because newer Cursor builds have been observed to move auth state out
  // of `ItemTable / cursorAuth/*` — without this we have no way to tell
  // *where* the token went and end up guessing in subsequent releases.
  probe?: TokenProbe;
}

export interface CandidateDbStat {
  path: string;
  exists: boolean;
  // File size in bytes (only meaningful when exists=true). Helps spot a
  // stale 0-byte or tiny DB that's masking a real one further down the
  // candidate list.
  size: number;
  // Unix ms; -1 if missing. Used to spot an obviously old DB.
  mtime: number;
}

export interface TokenProbe {
  // All table names that exist in the main state.vscdb file.
  tables: string[];
  // ItemTable row count in the DB we ultimately read. 0 strongly suggests
  // we are looking at the wrong DB (a freshly initialised state.vscdb has
  // tens to hundreds of rows even before login).
  itemTableRows: number | null;
  // stat() of every candidate state.vscdb path. Surfaces the case where
  // findStateDb() picked the first existing file even though it was empty
  // or stale, while a healthier DB lived further down the candidate list.
  candidateDbStats: CandidateDbStat[];
  // ItemTable keys whose prefix matches a small allow-list (cursor*, auth*,
  // workos*, session*, token*). Values are never included.
  itemTableSuspectKeys: string[];
  // cursorDiskKV keys whose prefix matches the same allow-list. Newer
  // Cursor builds appear to move auth state into this table; if a probe
  // shows e.g. `auth/accessToken` here we know exactly where to look.
  cursorDiskKVSuspectKeys: string[];
  // Whether scanning cursorDiskKV row values produced a valid JWT (used to
  // gate a future fallback that reads from cursorDiskKV rather than
  // ItemTable). Only ever true if parseJwtToToken accepted the value, so
  // it cannot be tripped by random base64-shaped strings.
  cursorDiskKVHasJwt: boolean;
  // Count of JWT-shaped runs found by a bounded byte-scan of the main DB.
  // We only return the count (and one prefix) because dumping every JWT
  // body to logs would leak the token if the user pastes the log.
  mainDbJwtCount: number;
  // First 12 chars of the first JWT-shaped run found in the main DB. Same
  // privacy reasoning as above — a 12-char prefix is not enough to forge
  // requests but is enough to correlate two runs of the diagnostic.
  mainDbJwtSamplePrefix: string | null;
  // Same as above but for the WAL sidecar.
  walJwtCount: number;
  walJwtSamplePrefix: string | null;
  // Top-level keys of globalStorage/storage.json (sibling of state.vscdb),
  // if that file exists and parses as JSON. Useful because some Cursor
  // builds have stored auth state in a plain JSON file instead of SQLite.
  storageJsonKeys: string[] | null;
}

export async function readAccessToken(dbPath: string): Promise<AccessToken | null> {
  const res = await readAccessTokenDetailed(dbPath);
  return res.token;
}

export async function readAccessTokenDetailed(
  dbPath: string,
): Promise<ReadAccessTokenResult> {
  const readRes = readDbWithFallback(dbPath);
  if (!readRes.buf) {
    return {
      token: null,
      cursorAuthKeys: [],
      source: "none",
      readError: readRes.error ?? "unknown",
    };
  }
  const buf: Buffer = readRes.buf;

  const SQL = await loadSqlJs();
  let db: Database | undefined;
  let sqlKeys: string[] = [];
  let tables: string[] = [];
  let suspectKeys: string[] = [];
  let diskKvSuspectKeys: string[] = [];
  let diskKvHasJwt = false;
  let itemTableRows: number | null = null;
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

      // Canonical SELECT yielded no usable token. Collect probe data so the
      // next release has something to work with instead of another guess.
      tables = listTables(db);
      suspectKeys = listSuspectItemTableKeys(db);
      diskKvSuspectKeys = listSuspectKeysInTable(db, "cursorDiskKV", "key");
      diskKvHasJwt = cursorDiskKVHasJwt(db);
      itemTableRows = countItemTableRows(db);
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
  // DB byte stream for the *token* (if it were in the main file the SQL
  // SELECT would already have returned it, and the main DB is regularly
  // multiple GB which is too large to bytes-scan cheaply); we do however
  // sample it during the probe below.
  const walBytes = readIfExists(`${dbPath}-wal`);
  if (walBytes) {
    const tok = scanRawForJwt(walBytes);
    if (tok) {
      return {
        token: tok,
        cursorAuthKeys: sqlKeys,
        source: "wal",
        probe: buildProbe(
          dbPath,
          buf,
          walBytes,
          tables,
          suspectKeys,
          diskKvSuspectKeys,
          diskKvHasJwt,
          itemTableRows,
        ),
      };
    }
  }

  return {
    token: null,
    cursorAuthKeys: sqlKeys,
    source: "none",
    probe: buildProbe(
      dbPath,
      buf,
      walBytes,
      tables,
      suspectKeys,
      diskKvSuspectKeys,
      diskKvHasJwt,
      itemTableRows,
    ),
  };
}

/** List every user-visible table name in the open SQLite database. */
function listTables(db: Database): string[] {
  try {
    const res = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    if (!res.length) return [];
    return (res[0].values as Array<[unknown]>)
      .map(([n]) => (typeof n === "string" ? n : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const SUSPECT_PREFIXES = [
  "cursor",
  "auth",
  "workos",
  "session",
  "token",
  "user",
];

/**
 * Return ItemTable keys whose name might plausibly contain auth state in a
 * Cursor build that has moved away from the old `cursorAuth/*` convention.
 * Values are never read; the list is safe to log.
 */
function listSuspectItemTableKeys(db: Database): string[] {
  return listSuspectKeysInTable(db, "ItemTable", "key");
}

/**
 * Same as `listSuspectItemTableKeys` but parameterised by table and key
 * column. We re-resolve the key column dynamically via PRAGMA table_info
 * because Cursor's newer `cursorDiskKV` schema is undocumented and could
 * realistically use a column name other than `key`.
 */
function listSuspectKeysInTable(
  db: Database,
  table: string,
  keyCol: string,
): string[] {
  const out: string[] = [];
  try {
    for (const pref of SUSPECT_PREFIXES) {
      const res = db.exec(
        `SELECT ${quoteIdent(keyCol)} FROM ${quoteIdent(
          table,
        )} WHERE ${quoteIdent(keyCol)} LIKE '${pref}%' LIMIT 50`,
      );
      if (!res.length) continue;
      for (const [k] of res[0].values as Array<[unknown]>) {
        if (typeof k === "string") out.push(k);
      }
    }
  } catch {
    // Table or column may not exist; empty list is informative.
  }
  return out;
}

/** SQLite quoted identifier; rejects names with embedded double-quotes. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`refused to quote unusual identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Look in `cursorDiskKV` (or any single-column-key + single-column-value
 * table) for at least one row whose value parses as a JWT we would accept.
 * Returns true on the first hit. The function deliberately samples only
 * the first BLOB-or-TEXT column it can find for the value, and limits
 * scanning to SUSPECT_PREFIXES so we never read the whole table.
 */
function cursorDiskKVHasJwt(db: Database): boolean {
  const cols = describeColumns(db, "cursorDiskKV");
  if (!cols) return false;
  const keyCol = cols.find((c) => /key|name|id/i.test(c)) ?? cols[0];
  const valueCol =
    cols.find((c) => /val|data|content|payload/i.test(c)) ??
    cols.find((c) => c !== keyCol) ??
    null;
  if (!valueCol) return false;
  try {
    for (const pref of SUSPECT_PREFIXES) {
      const res = db.exec(
        `SELECT ${quoteIdent(valueCol)} FROM ${quoteIdent(
          "cursorDiskKV",
        )} WHERE ${quoteIdent(keyCol)} LIKE '${pref}%' LIMIT 50`,
      );
      if (!res.length) continue;
      for (const [raw] of res[0].values as Array<[unknown]>) {
        const candidates = jwtCandidatesFromValue(raw);
        for (const c of candidates) {
          if (parseJwtToToken(c)) return true;
        }
      }
    }
  } catch {
    // Schema mismatch is exactly the signal we want — fall through to false.
  }
  return false;
}

/**
 * Best-effort enumeration of column names for ``table``. Returns null if
 * the table is missing or PRAGMA returned nothing recognisable.
 */
function describeColumns(db: Database, table: string): string[] | null {
  try {
    const res = db.exec(`PRAGMA table_info(${quoteIdent(table)})`);
    if (!res.length) return null;
    const nameIdx = res[0].columns.indexOf("name");
    if (nameIdx === -1) return null;
    return (res[0].values as unknown[][])
      .map((row) => row[nameIdx])
      .filter((n): n is string => typeof n === "string");
  } catch {
    return null;
  }
}

/**
 * Cursor's newer rows may store the JWT as plain text, as JSON containing
 * an `accessToken` field, or as a BLOB of UTF-8. Try a few shapes and
 * return every plausible JWT-looking substring found within.
 */
function jwtCandidatesFromValue(raw: unknown): string[] {
  const out: string[] = [];
  let text: string | null = null;
  if (typeof raw === "string") text = raw;
  else if (raw instanceof Uint8Array) {
    try {
      text = Buffer.from(raw).toString("utf8");
    } catch {
      text = null;
    }
  }
  if (!text) return out;
  // First try JSON: { accessToken: "..." } / { token: { value: "..." } }.
  try {
    const obj = JSON.parse(text);
    collectStringsRecursive(obj, out);
  } catch {
    // Not JSON; fall through to regex over the raw text.
  }
  const re = /eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

function collectStringsRecursive(v: unknown, out: string[]): void {
  if (typeof v === "string") {
    if (v.startsWith("eyJ") && v.split(".").length === 3) out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStringsRecursive(x, out);
    return;
  }
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) collectStringsRecursive(x, out);
  }
}

/**
 * Bounded scan: walk up to MAX_PROBE_BYTES of ``bytes`` looking for JWT-
 * shaped runs and return how many we saw plus a non-secret prefix of the
 * first one. We never return the full JWT — if the user pastes the log we
 * do not want to leak a working session token.
 *
 * The regex requires the first segment to start with `eyJ`. A JWT header
 * is base64url of a JSON object, which always begins with `{"`; that
 * base64-encodes to `eyJ`. Without this anchor we were matching every
 * dotted base64-ish identifier in Cursor's state (e.g.
 * `reactiveStorage.workbench.X.Y`) and reporting 100+ false positives.
 */
const MAX_PROBE_BYTES = 64 * 1024 * 1024;
function probeJwts(
  bytes: Buffer | null,
): { count: number; samplePrefix: string | null } {
  if (!bytes) return { count: 0, samplePrefix: null };
  const slice = bytes.length > MAX_PROBE_BYTES
    ? bytes.subarray(0, MAX_PROBE_BYTES)
    : bytes;
  const text = slice.toString("latin1");
  const jwtCharset = "A-Za-z0-9_\\-";
  const re = new RegExp(
    `eyJ[${jwtCharset}]{8,}\\.[${jwtCharset}]{10,}\\.[${jwtCharset}]{10,}`,
    "g",
  );
  let count = 0;
  let samplePrefix: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    count++;
    if (samplePrefix === null) samplePrefix = m[0].slice(0, 12);
    if (count >= 100) break; // capping prevents pathological loops
  }
  return { count, samplePrefix };
}

/** Read globalStorage/storage.json and return its top-level keys, if any. */
function readStorageJsonKeys(dbPath: string): string[] | null {
  const candidate = path.join(path.dirname(dbPath), "storage.json");
  try {
    const txt = fs.readFileSync(candidate, "utf8");
    const obj = JSON.parse(txt);
    if (obj && typeof obj === "object") return Object.keys(obj).slice(0, 50);
    return null;
  } catch {
    return null;
  }
}

function buildProbe(
  dbPath: string,
  mainBytes: Buffer,
  walBytes: Buffer | null,
  tables: string[],
  suspectKeys: string[],
  diskKvSuspectKeys: string[],
  diskKvHasJwt: boolean,
  itemTableRows: number | null,
): TokenProbe {
  const main = probeJwts(mainBytes);
  const wal = probeJwts(walBytes);
  return {
    tables,
    itemTableRows,
    candidateDbStats: statCandidateDbs(),
    itemTableSuspectKeys: suspectKeys,
    cursorDiskKVSuspectKeys: diskKvSuspectKeys,
    cursorDiskKVHasJwt: diskKvHasJwt,
    mainDbJwtCount: main.count,
    mainDbJwtSamplePrefix: main.samplePrefix,
    walJwtCount: wal.count,
    walJwtSamplePrefix: wal.samplePrefix,
    storageJsonKeys: readStorageJsonKeys(dbPath),
  };
}

/**
 * stat() every candidate state.vscdb the resolver knows about. The point
 * is to surface "we picked the first existing path but it's a 0-byte
 * leftover" — without this we keep retrying SELECTs against a DB that
 * was never going to contain auth state.
 */
function statCandidateDbs(): CandidateDbStat[] {
  return candidateUserDirs().map((dir) => {
    const p = path.join(dir, "globalStorage", "state.vscdb");
    try {
      const st = fs.statSync(p);
      return {
        path: p,
        exists: true,
        size: st.size,
        mtime: st.mtimeMs,
      };
    } catch {
      return { path: p, exists: false, size: 0, mtime: -1 };
    }
  });
}

/** Cheap "is this DB even being used?" signal. Returns null on failure. */
function countItemTableRows(db: Database): number | null {
  try {
    const res = db.exec("SELECT COUNT(*) FROM ItemTable");
    if (!res.length) return null;
    const v = res[0].values[0]?.[0];
    return typeof v === "number" ? v : Number(v) || 0;
  } catch {
    return null;
  }
}

/**
 * Run the diagnostic probe against the state DB regardless of whether the
 * SQL lookup currently succeeds. Useful when the maintainer needs to
 * confirm a deployed build's probe code is wired up correctly on a
 * machine where the canonical SELECT happens to work — the normal
 * lookup path skips the probe by design once SQL returns a token, so
 * happy-path users would otherwise have no way to exercise it.
 *
 * Returns null if the DB cannot be located or opened.
 */
export async function runTokenProbe(): Promise<
  | null
  | (TokenProbe & {
      dbPath: string;
      cursorAuthKeys: string[];
      readError: string | null;
      readFallback: boolean;
    })
> {
  const dbPath = findStateDb();
  if (!dbPath) return null;
  const readRes = readDbWithFallback(dbPath);
  if (!readRes.buf) {
    // Return a stub so the caller can still log readError + candidateDbStats
    // instead of just "nothing to probe", which was the unhelpful state on
    // the emily machine.
    return {
      dbPath,
      cursorAuthKeys: [],
      readError: readRes.error,
      readFallback: false,
      tables: [],
      itemTableRows: null,
      candidateDbStats: statCandidateDbs(),
      itemTableSuspectKeys: [],
      cursorDiskKVSuspectKeys: [],
      cursorDiskKVHasJwt: false,
      mainDbJwtCount: 0,
      mainDbJwtSamplePrefix: null,
      walJwtCount: 0,
      walJwtSamplePrefix: null,
      storageJsonKeys: readStorageJsonKeys(dbPath),
    };
  }
  const buf: Buffer = readRes.buf;
  const SQL = await loadSqlJs();
  let db: Database | undefined;
  let tables: string[] = [];
  let suspectKeys: string[] = [];
  let diskKvSuspectKeys: string[] = [];
  let diskKvHasJwt = false;
  let itemTableRows: number | null = null;
  const cursorAuthKeys: string[] = [];
  try {
    db = new SQL.Database(buf);
  } catch {
    db = undefined;
  }
  if (db) {
    try {
      tables = listTables(db);
      suspectKeys = listSuspectItemTableKeys(db);
      diskKvSuspectKeys = listSuspectKeysInTable(db, "cursorDiskKV", "key");
      diskKvHasJwt = cursorDiskKVHasJwt(db);
      itemTableRows = countItemTableRows(db);
      try {
        const res = db.exec(
          "SELECT key FROM ItemTable WHERE key LIKE 'cursorAuth%'",
        );
        if (res.length) {
          for (const [k] of res[0].values as Array<[unknown]>) {
            if (typeof k === "string") cursorAuthKeys.push(k);
          }
        }
      } catch {
        // ItemTable may not exist; cursorAuthKeys stays empty.
      }
    } finally {
      db.close();
    }
  }
  const walBytes = readIfExists(`${dbPath}-wal`);
  return {
    dbPath,
    cursorAuthKeys,
    readError: null,
    readFallback: readRes.fallback,
    ...buildProbe(
      dbPath,
      buf,
      walBytes,
      tables,
      suspectKeys,
      diskKvSuspectKeys,
      diskKvHasJwt,
      itemTableRows,
    ),
  };
}

function readIfExists(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/**
 * Read ``state.vscdb`` (or any file) into a Buffer, falling back to a
 * snapshot copy when Windows refuses a direct read.
 *
 * Cursor opens the DB with an exclusive lock on Windows; a direct
 * ``readFileSync`` against it returns EBUSY/EACCES/EPERM for some users
 * (so far observed only on certain Windows AV/EDR setups; the same path
 * reads fine for others, including all WSL hosts). The workaround is the
 * one VS Code's own user-data backup uses: ``fs.copyFile`` first into
 * the OS tmpdir, then read the copy. ``copyFile`` opens the source with
 * ``FILE_SHARE_READ`` semantics on Windows and so succeeds where a plain
 * read does not.
 *
 * Returns ``{ buf, error: null }`` on success or ``{ buf: null, error }``
 * with the errno from the *direct* read on failure. The caller can pass
 * ``error`` straight into a log line.
 */
function readDbWithFallback(
  p: string,
): { buf: Buffer | null; error: string | null; fallback: boolean } {
  try {
    return { buf: fs.readFileSync(p), error: null, fallback: false };
  } catch (e) {
    const directErr = errnoOf(e);
    // Only the lock-y errors warrant a snapshot fallback. ENOENT / EISDIR
    // would still fail after copying, so just bubble them up unchanged.
    if (directErr !== "EBUSY" && directErr !== "EACCES" && directErr !== "EPERM") {
      return { buf: null, error: directErr, fallback: false };
    }
    try {
      const tmp = path.join(
        os.tmpdir(),
        `ai-cost-tracker-${process.pid}-${Date.now()}-${path.basename(p)}`,
      );
      fs.copyFileSync(p, tmp);
      try {
        return { buf: fs.readFileSync(tmp), error: null, fallback: true };
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // Leftover file in tmpdir is harmless; OS will reap it.
        }
      }
    } catch (e2) {
      // Surface both errors so the log shows whether copyFile also failed
      // or only the original read did.
      return {
        buf: null,
        error: `direct=${directErr},copy=${errnoOf(e2)}`,
        fallback: false,
      };
    }
  }
}

function errnoOf(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return e instanceof Error ? e.message : String(e);
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
  // errno from the readFileSync against state.vscdb, if it failed.
  // Threaded straight from ReadAccessTokenResult so the user-facing log
  // makes "the DB is locked" distinguishable from "the DB has no auth".
  readError?: string;
  // Probe data collected when the canonical SQL lookup fails. Populated by
  // ``readAccessTokenDetailed`` and threaded through unchanged. Always safe
  // to log: it is restricted to key names, table names, and counts.
  probe?: TokenProbe;
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
    readError: detailed.readError,
    probe: detailed.probe,
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
