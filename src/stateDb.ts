/**
 * Locate, open, and read Cursor's ``state.vscdb`` SQLite file across all
 * supported host shapes (Windows, macOS, Linux, WSL, Remote-SSH). This
 * module deliberately knows nothing about the JWT format or the dashboard
 * API; the token layer ({@link "./cursor"}) calls in here and then parses
 * the bytes itself.
 *
 * Two hard-won lessons live here:
 *
 * 1. ``readFileSync`` on Cursor's DB fails for two distinct Windows
 *    reasons — libuv's 2 GiB-per-syscall cap and the exclusive lock
 *    Cursor takes on its own DB. See ``readDbWithFallback`` for the
 *    chunk-then-copy strategy.
 * 2. Where the DB lives depends on the extension host: Remote-WSL
 *    extensions run inside ``~/.cursor-server`` and must read the WSL
 *    side; bare Windows extensions read ``%APPDATA%`` directly. The
 *    candidate-dir list in {@link candidateUserDirs} encodes every
 *    shape we've seen in the wild.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

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

/** @internal Used by the token + diagnostics modules to share one sql.js init. */
export function loadSqlJs(): Promise<SqlJsStatic> {
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

// ----------------------------- chunked / locked DB reads -------------------

/**
 * Read ``state.vscdb`` (or any file) into a Buffer, working around two
 * Windows-specific failure modes that ``fs.readFileSync`` does not handle
 * out of the box.
 *
 * Mode 1 — libuv 2 GiB I/O cap. The Cursor state DB can exceed 2 GiB
 * (one observed in the wild at 2.02 GiB). Even though Node's Buffer can
 * hold up to 4 GiB on 64-bit, libuv refuses any single read whose size
 * is larger than INT32_MAX. ``readFileSync`` then throws
 * ``ERR_FS_FILE_TOO_LARGE``. We work around it by opening the file
 * ourselves and issuing repeated ``fs.readSync`` calls into chunk-sized
 * windows of a pre-sized destination Buffer. 256 MiB per call is well
 * under the libuv cap and keeps memory pressure bounded.
 *
 * Mode 2 — Cursor's exclusive lock on Windows. Some user profiles (so
 * far seen under particular AV/EDR setups) return EBUSY/EACCES/EPERM on
 * direct opens. The fix VS Code's own user-data backup uses is to copy
 * via ``fs.copyFileSync`` first — ``copyFile`` requests
 * ``FILE_SHARE_READ`` semantics and so succeeds where a plain read does
 * not — then read the copy with the same chunked path.
 *
 * Returns ``{ buf, error: null }`` on success or ``{ buf: null, error }``
 * with the errno from the *direct* read on failure. The caller can pass
 * ``error`` straight into a log line.
 */
const READ_CHUNK_BYTES = 256 * 1024 * 1024;

export function readDbWithFallback(
  p: string,
): { buf: Buffer | null; error: string | null; fallback: boolean } {
  const direct = chunkedReadFile(p);
  if (direct.buf) return { buf: direct.buf, error: null, fallback: false };

  const directErr = direct.error ?? "unknown";
  // ENOENT / EISDIR will still fail after copying — bubble them up.
  if (
    directErr !== "EBUSY" &&
    directErr !== "EACCES" &&
    directErr !== "EPERM"
  ) {
    return { buf: null, error: directErr, fallback: false };
  }

  // Lock-y error: copyFile to a tmp path, then read that.
  let tmp: string | null = null;
  try {
    tmp = path.join(
      os.tmpdir(),
      `ai-cost-tracker-${process.pid}-${Date.now()}-${path.basename(p)}`,
    );
    fs.copyFileSync(p, tmp);
    const copied = chunkedReadFile(tmp);
    if (copied.buf) return { buf: copied.buf, error: null, fallback: true };
    return {
      buf: null,
      error: `direct=${directErr},copyread=${copied.error ?? "unknown"}`,
      fallback: false,
    };
  } catch (e2) {
    return {
      buf: null,
      error: `direct=${directErr},copy=${errnoOf(e2)}`,
      fallback: false,
    };
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Tmp leftover is harmless; OS will reap it.
      }
    }
  }
}

/**
 * Read a file into a Buffer using chunked ``fs.readSync`` calls so a
 * single I/O never exceeds libuv's INT32_MAX limit. Returns the errno on
 * failure so the caller can log it.
 */
export function chunkedReadFile(
  p: string,
): { buf: Buffer | null; error: string | null } {
  let fd: number | null = null;
  try {
    const st = fs.statSync(p);
    const size = st.size;
    if (size === 0) return { buf: Buffer.alloc(0), error: null };
    fd = fs.openSync(p, "r");
    const out = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const want = Math.min(READ_CHUNK_BYTES, size - offset);
      const got = fs.readSync(fd, out, offset, want, offset);
      if (got <= 0) {
        // Premature EOF: file shrank mid-read. Return what we have so
        // the caller can decide whether the truncated bytes are useful.
        return { buf: out.subarray(0, offset), error: null };
      }
      offset += got;
    }
    return { buf: out, error: null };
  } catch (e) {
    return { buf: null, error: errnoOf(e) };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignored
      }
    }
  }
}

/** Best-effort read; returns null on any failure (used for sidecar files). */
export function readIfExists(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/** Extract a POSIX-style errno from a thrown error, falling back to message. */
export function errnoOf(e: unknown): string {
  if (
    e &&
    typeof e === "object" &&
    "code" in e &&
    typeof (e as { code: unknown }).code === "string"
  ) {
    return (e as { code: string }).code;
  }
  return e instanceof Error ? e.message : String(e);
}
