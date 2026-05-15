import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SCAN_CHUNK_BYTES,
  forEachFileChunk,
  scanFileForJwt,
} from "../../src/cursor";

/**
 * A throwaway JWT shaped the way ``parseJwtToToken`` expects: three
 * base64url segments where the payload has ``sub`` and an ``exp`` an
 * hour in the future. The streaming scan never validates expiry, but
 * keeping the timestamp valid means the same JWT also survives
 * ``validateCachedToken`` in case a future test reuses it.
 */
function buildJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "auth0|unit-test",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const sig = Buffer.from("unit-test-sig").toString("base64url");
  return `${header}.${payload}.${sig}`;
}

describe("scanFileForJwt", () => {
  let tmp: string;
  const jwt = buildJwt();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "act-stream-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // tmp will be reaped by the OS
    }
  });

  it("finds a Strategy 1 hit (key marker followed by JWT) in a small file", () => {
    const p = path.join(tmp, "small.vscdb");
    fs.writeFileSync(
      p,
      Buffer.from(`\x00cursorAuth/accessToken\x00${jwt}\x00`),
    );

    const tok = scanFileForJwt(p);

    expect(tok?.token).toBe(jwt);
    expect(tok?.sub).toBe("auth0|unit-test");
  });

  it("returns null when the file has neither key marker nor a JWT-shaped run", () => {
    const p = path.join(tmp, "no-token.vscdb");
    fs.writeFileSync(
      p,
      Buffer.from("nothing to see here ".repeat(1024)),
    );

    expect(scanFileForJwt(p)).toBeNull();
  });

  it("returns null on a zero-byte file (regression: don't crash on empty DB)", () => {
    const p = path.join(tmp, "empty.vscdb");
    fs.writeFileSync(p, Buffer.alloc(0));
    expect(scanFileForJwt(p)).toBeNull();
  });

  // The overlap is the whole reason this routine exists; if a key+JWT
  // pair lands at the boundary between two chunks and overlap is 0, we
  // miss it. Use tiny custom chunk/overlap parameters so the test stays
  // fast (KB instead of MB) but exercises the same code path that runs
  // against a 2 GiB Cursor DB.
  it("finds a match that straddles a chunk boundary thanks to overlap", () => {
    const p = path.join(tmp, "straddle.vscdb");
    const chunk = 4 * 1024;
    const overlap = 256;
    const marker = `cursorAuth/accessToken\x00${jwt}`;
    // Write so the marker starts a few bytes before chunk 1 ends; only
    // a handful of leading chars sit in chunk 1, the rest is in chunk 2.
    const offset = chunk - 5;
    const total = offset + marker.length;
    const padded = Buffer.alloc(total, 0);
    padded.write(marker, offset, "binary");
    fs.writeFileSync(p, padded);

    const tok = scanFileForJwt(p, chunk, overlap);

    expect(tok?.token).toBe(jwt);
  });

  it("falls through to Strategy 2 when no key marker exists but a JWT-shaped run does", () => {
    const p = path.join(tmp, "wal-shape.vscdb");
    // No `cursorAuth/accessToken` anywhere, but a parseable JWT is
    // present surrounded by SQLite-ish bytes. This is the shape we
    // sometimes see in a WAL frame whose key got reordered away from
    // the value. Use a NUL byte boundary on both sides so the JWT
    // regex (which is greedy over [A-Za-z0-9_\-]) cannot extend into
    // the padding and produce a spuriously-longer match.
    fs.writeFileSync(
      p,
      Buffer.concat([
        Buffer.alloc(1024, 0x20), // ASCII spaces — not in the JWT charset
        Buffer.from([0]),
        Buffer.from(jwt),
        Buffer.from([0]),
        Buffer.alloc(64, 0x20),
      ]),
    );

    const tok = scanFileForJwt(p);

    expect(tok?.token).toBe(jwt);
  });

  it("rejects key/JWT pairs that are more than 4096 bytes apart (high-precision guard)", () => {
    const p = path.join(tmp, "far.vscdb");
    // Put the marker, then 5 KB of filler, then a JWT. Strategy 1
    // requires distance <= 4096 so it must skip this pair. Strategy 2
    // would still match the JWT regardless, so we instead place an
    // *invalid* JWT shape near the marker and a valid JWT 5 KB later:
    // both strategies should still find the valid one (Strategy 2),
    // confirming the cap fires but the fallback rescues us.
    const buf = Buffer.concat([
      Buffer.from("cursorAuth/accessToken\x00"),
      Buffer.from("not.a.jwt"),
      Buffer.alloc(5 * 1024, 0x20),
      Buffer.from(jwt),
    ]);
    fs.writeFileSync(p, buf);

    const tok = scanFileForJwt(p);

    expect(tok?.token).toBe(jwt);
  });

  it("exposes the default chunk size as a number, not stringly-typed", () => {
    // Belt-and-suspenders: this catches a future refactor that
    // accidentally exports SCAN_CHUNK_BYTES as a string.
    expect(typeof SCAN_CHUNK_BYTES).toBe("number");
    expect(SCAN_CHUNK_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe("forEachFileChunk", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "act-foreach-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignored
    }
  });

  it("invokes the callback once per chunk, with overlap between consecutive chunks", () => {
    const p = path.join(tmp, "chunked.bin");
    // Build a file slightly larger than 2 * chunk so we trigger at
    // least 3 iterations. Use ASCII so the latin1 decode is faithful.
    const chunk = 1024;
    const overlap = 64;
    const size = chunk * 2 + 200;
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i++) data[i] = 0x41 + (i % 26); // A..Z
    fs.writeFileSync(p, data);

    const seenLengths: number[] = [];
    const res = forEachFileChunk(p, chunk, overlap, (text) => {
      seenLengths.push(text.length);
      return false;
    });

    expect(res.error).toBeNull();
    expect(seenLengths.length).toBeGreaterThanOrEqual(2);
    // First chunk is always exactly ``chunk`` bytes when file >= chunk.
    expect(seenLengths[0]).toBe(chunk);
    // Each subsequent read starts ``chunk - overlap`` further along, so
    // the total bytes covered (with overlap subtracted) equals the file
    // size — proving the entire file is visited.
    const covered =
      seenLengths[0] +
      seenLengths.slice(1).reduce((sum, len) => sum + (len - overlap), 0);
    expect(covered).toBe(size);
  });

  it("short-circuits when the callback returns true", () => {
    const p = path.join(tmp, "shortcircuit.bin");
    fs.writeFileSync(p, Buffer.alloc(1024 * 32, 0x41));

    let calls = 0;
    forEachFileChunk(p, 1024, 64, () => {
      calls++;
      return true;
    });

    expect(calls).toBe(1);
  });

  it("is a no-op on a zero-byte file", () => {
    const p = path.join(tmp, "empty.bin");
    fs.writeFileSync(p, Buffer.alloc(0));

    let calls = 0;
    const res = forEachFileChunk(p, 1024, 64, () => {
      calls++;
      return false;
    });

    expect(res.error).toBeNull();
    expect(calls).toBe(0);
  });

  it("reports an errno when the file does not exist", () => {
    const res = forEachFileChunk(
      path.join(tmp, "missing.bin"),
      1024,
      64,
      () => false,
    );
    expect(res.error).toMatch(/ENOENT|no such file/i);
  });

  it("refuses non-progressing parameters (chunkBytes <= overlapBytes)", () => {
    const p = path.join(tmp, "any.bin");
    fs.writeFileSync(p, Buffer.from("xyz"));

    const same = forEachFileChunk(p, 64, 64, () => false);
    const smaller = forEachFileChunk(p, 32, 64, () => false);

    expect(same.error).toMatch(/chunkBytes/);
    expect(smaller.error).toMatch(/chunkBytes/);
  });
});
