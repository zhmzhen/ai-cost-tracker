import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chunkedReadFile, readDbWithFallback } from "../../src/cursor";

// Bytes per GiB; used in several size assertions below.
const GiB = 1024 ** 3;

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "act-readdb-"));
}

function writeTmp(dir: string, name: string, contents: Buffer | string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

/**
 * Create a sparse file of the requested size. The OS records the size in
 * metadata but does not allocate the bytes — used here to reproduce the
 * `ERR_FS_FILE_TOO_LARGE` symptom (2 GiB+ apparent size) without writing
 * 2 GiB to disk. Works on Linux and Windows NTFS; tests skip themselves
 * if the host filesystem refuses the truncate.
 */
function makeSparseFile(p: string, size: number): boolean {
  try {
    const fd = fs.openSync(p, "w");
    try {
      fs.ftruncateSync(fd, size);
    } finally {
      fs.closeSync(fd);
    }
    const st = fs.statSync(p);
    return st.size === size;
  } catch {
    return false;
  }
}

describe("readDbWithFallback", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures; tmp will be reaped by the OS
    }
  });

  it("reads a normal file directly without falling back", () => {
    const data = Buffer.from("hello-state-db");
    const p = writeTmp(dir, "ok.vscdb", data);

    const res = readDbWithFallback(p);

    expect(res.error).toBeNull();
    expect(res.fallback).toBe(false);
    expect(res.buf?.equals(data)).toBe(true);
  });

  it("returns ENOENT (or platform equivalent) without crashing on a missing path", () => {
    const res = readDbWithFallback(path.join(dir, "does-not-exist.vscdb"));
    expect(res.buf).toBeNull();
    expect(res.error).toMatch(/ENOENT|no such file/i);
    expect(res.fallback).toBe(false);
  });

  it("reads a zero-byte file as an empty Buffer rather than failing", () => {
    const p = writeTmp(dir, "empty.vscdb", Buffer.alloc(0));
    const res = readDbWithFallback(p);
    expect(res.error).toBeNull();
    expect(res.buf?.length).toBe(0);
  });

  // The emily failure: file is past libuv's 2 GiB single-read cap.
  // Before 0.4.13 the code bailed with ERR_FS_FILE_TOO_LARGE; we now
  // open the fd ourselves and read in 256 MiB chunks, so the call
  // should succeed (or, on a filesystem that refuses sparse files,
  // be skipped — never produce ERR_FS_FILE_TOO_LARGE).
  it("handles files larger than 2 GiB without ERR_FS_FILE_TOO_LARGE", () => {
    const p = path.join(dir, "huge.vscdb");
    const ok = makeSparseFile(p, 2 * GiB + 50 * 1024 * 1024); // 2.05 GiB
    if (!ok) {
      // No sparse-file support on this FS (or insufficient quota).
      // Skipping is preferable to a false positive.
      return;
    }
    const res = readDbWithFallback(p);

    // Either the read succeeds and we got 2.05 GiB of (mostly zero)
    // bytes back, OR a different error (e.g. ENOMEM in CI) — but
    // never the specific bug we shipped 0.4.13 to fix.
    if (res.buf) {
      expect(res.buf.length).toBe(2 * GiB + 50 * 1024 * 1024);
    } else {
      expect(res.error).not.toMatch(/ERR_FS_FILE_TOO_LARGE/);
    }
  });
});

describe("chunkedReadFile (byte-equivalence to readFileSync)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignored
    }
  });

  it("produces the same bytes as readFileSync on a small file", () => {
    const data = Buffer.from(
      "the-quick-brown-fox-".repeat(1024) /* 20 KB */,
    );
    const p = writeTmp(dir, "smallish.vscdb", data);
    const direct = fs.readFileSync(p);
    const chunked = chunkedReadFile(p);
    expect(chunked.error).toBeNull();
    expect(chunked.buf?.equals(direct)).toBe(true);
  });

  it("returns an empty buffer for a zero-byte file", () => {
    const p = writeTmp(dir, "empty2.vscdb", Buffer.alloc(0));
    const res = chunkedReadFile(p);
    expect(res.error).toBeNull();
    expect(res.buf?.length).toBe(0);
  });
});
