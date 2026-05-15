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

import { type Database } from "sql.js";

import { fetchMonthSummaryWithToken } from "./api";
import { type FetchError, type FetchStatus } from "./apiTypes";
import {
  type TokenProbe,
  buildProbe,
  countItemTableRows,
  cursorDiskKVHasJwt,
  listSuspectItemTableKeys,
  listSuspectKeysInTable,
  listTables,
} from "./diagnostics";
import { type AccessToken, parseJwtToToken } from "./jwt";
import {
  candidateUserDirs,
  chunkedReadFile,
  errnoOf,
  findStateDb,
  loadSqlJs,
  readDbWithFallback,
  readIfExists,
  setWasmDirectory,
} from "./stateDb";

export type { AccessToken } from "./jwt";
export type {
  FetchError,
  FetchStatus,
  ModelUsage,
  MonthSummary,
  Quota,
} from "./apiTypes";
export {
  candidateUserDirs,
  chunkedReadFile,
  findStateDb,
  readDbWithFallback,
  setWasmDirectory,
};
export {
  decodeJwtPayload,
  parseJwtToToken,
  validateCachedToken,
} from "./jwt";
export {
  type AggregatedUsageResponse,
  type RawQuota,
  type UsageSummaryResponse,
  assemble,
  fetchMonthSummaryWithToken,
  toQuota,
} from "./api";

// ModelUsage / Quota / MonthSummary / FetchStatus / FetchError live in
// ./apiTypes and are re-exported above. DB discovery and chunked/locked
// reads live in ./stateDb. We re-export both so external callers keep
// resolving the same names from "./cursor".

// ----------------------------- access token --------------------------------

// AccessToken / validateCachedToken / parseJwtToToken / decodeJwtPayload now
// live in ./jwt and are re-exported above for callers that still expect the
// public symbols here.

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
  // Set when ``new SQL.Database(buf)`` threw — typically because the
  // multi-GiB Cursor DB exceeds the sql.js wasm heap. Captured so a
  // "source=none" with a healthy `readError=null` is still attributable.
  sqlOpenError?: string;
  // Extra signal collected when the canonical lookup fails. These exist
  // because newer Cursor builds have been observed to move auth state out
  // of `ItemTable / cursorAuth/*` — without this we have no way to tell
  // *where* the token went and end up guessing in subsequent releases.
  probe?: TokenProbe;
}

// CandidateDbStat + TokenProbe and the runTokenProbe entrypoint moved to
// ./diagnostics. They are re-exported below so external callers keep
// resolving the same names from this module.
export type { CandidateDbStat, TokenProbe } from "./diagnostics";
export { runTokenProbe } from "./diagnostics";

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
  let sqlOpenError: string | undefined;
  try {
    db = new SQL.Database(buf);
  } catch (e) {
    // sql.js loads the entire buffer into its wasm heap. For multi-GiB
    // Cursor DBs that allocation can fail with `RangeError: WebAssembly
    // memory ...` even though Node-level Buffer.MAX_LENGTH is 4 GiB.
    // Capture the message so the caller's "source=none" line is
    // distinguishable from "DB read fine but auth row was missing".
    sqlOpenError = errnoOf(e);
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
    sqlOpenError,
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

// listTables / suspect-key listers / quoteIdent / cursorDiskKVHasJwt /
// probeJwts / buildProbe / statCandidateDbs / countItemTableRows /
// runTokenProbe moved to ./diagnostics. They are imported below for
// use inside readAccessTokenDetailed and re-exported via the type/value
// re-exports near the top of this file.

// readIfExists / readDbWithFallback / chunkedReadFile / errnoOf moved to
// ./stateDb (imported above). They are tested by
// test/unit/readDbWithFallback.spec.ts.

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

// decodeJwtPayload moved to ./jwt.

// Dashboard HTTPS client (postJson, HttpError, fetchMonthSummaryWithToken)
// and JSON assembly (toQuota, assemble, AggregatedUsageResponse,
// UsageSummaryResponse, RawQuota) live in ./api and are re-exported above
// for legacy callers and tests.

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
  // Error from `new SQL.Database(buf)` if that threw. See
  // ReadAccessTokenResult.sqlOpenError.
  sqlOpenError?: string;
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
    sqlOpenError: detailed.sqlOpenError,
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

// fetchMonthSummaryWithToken moved to ./api (imported above for use by
// fetchMonthSummary below, and re-exported for external callers).

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
