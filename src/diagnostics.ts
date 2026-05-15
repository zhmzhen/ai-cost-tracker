/**
 * Diagnostic probes for "where did the token go?" investigations. The
 * canonical SQL lookup in {@link "./cursor".readAccessTokenDetailed} calls
 * the helpers in this file to collect non-sensitive evidence whenever it
 * fails — table names, key prefixes, JWT counts, ``storage.json`` keys, and
 * stat() of every candidate DB path. The maintainer's
 * ``aiCostTracker.runProbe`` command bypasses the canonical lookup and runs
 * {@link runTokenProbe} directly.
 *
 * Two invariants this module preserves:
 *
 * - Values are never logged. The probe sees secret data (rows of
 *   ``cursorDiskKV``) but only returns booleans and counts, plus 12-char
 *   sample prefixes that cannot reconstruct a JWT.
 * - The probe never throws on a malformed DB. Every helper has a try/catch
 *   that degrades gracefully because a probe-time exception would mask the
 *   underlying "no token" report we actually want to show the user.
 */

import * as fs from "fs";
import * as path from "path";

import { type Database } from "sql.js";

import { parseJwtToToken } from "./jwt";
import {
  candidateUserDirs,
  findStateDb,
  loadSqlJs,
  readDbWithFallback,
  readIfExists,
} from "./stateDb";

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

// ----------------------------- SQL helpers ---------------------------------

/** SQLite quoted identifier; rejects names with embedded double-quotes. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`refused to quote unusual identifier: ${name}`);
  }
  return `"${name}"`;
}

/** List every user-visible table name in the open SQLite database. */
export function listTables(db: Database): string[] {
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

/** Cheap "is this DB even being used?" signal. Returns null on failure. */
export function countItemTableRows(db: Database): number | null {
  try {
    const res = db.exec("SELECT COUNT(*) FROM ItemTable");
    if (!res.length) return null;
    const v = res[0].values[0]?.[0];
    return typeof v === "number" ? v : Number(v) || 0;
  } catch {
    return null;
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
export function listSuspectItemTableKeys(db: Database): string[] {
  return listSuspectKeysInTable(db, "ItemTable", "key");
}

/**
 * Same as `listSuspectItemTableKeys` but parameterised by table and key
 * column. We re-resolve the key column dynamically via PRAGMA table_info
 * because Cursor's newer `cursorDiskKV` schema is undocumented and could
 * realistically use a column name other than `key`.
 */
export function listSuspectKeysInTable(
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
 * Look in `cursorDiskKV` (or any single-column-key + single-column-value
 * table) for at least one row whose value parses as a JWT we would accept.
 * Returns true on the first hit. The function deliberately samples only
 * the first BLOB-or-TEXT column it can find for the value, and limits
 * scanning to SUSPECT_PREFIXES so we never read the whole table.
 */
export function cursorDiskKVHasJwt(db: Database): boolean {
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

// ----------------------------- byte / fs helpers ---------------------------

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

// ----------------------------- probe builder -------------------------------

export function buildProbe(
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

// ----------------------------- standalone probe entry ---------------------

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
