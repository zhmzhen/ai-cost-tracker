import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";

import { readAccessTokenDetailed } from "../../src/cursor";

const WASM_DIR = path.join(__dirname, "..", "..", "media");

/**
 * A throwaway JWT shaped the way parseJwtToToken expects: three
 * base64url segments where the payload has `sub` and an `exp` an
 * hour in the future. Header signature are arbitrary; the extension
 * never verifies them.
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

async function loadSqlJs() {
  return initSqlJs({ locateFile: (f) => path.join(WASM_DIR, f) });
}

describe("readAccessTokenDetailed", () => {
  let tmp: string;
  const jwt = buildJwt();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "act-readtok-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignored
    }
  });

  it("returns source=sql and a token when ItemTable has cursorAuth/accessToken", async () => {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO ItemTable VALUES (?, ?)", [
      "cursorAuth/accessToken",
      jwt,
    ]);
    const p = path.join(tmp, "healthy.vscdb");
    fs.writeFileSync(p, Buffer.from(db.export()));
    db.close();

    const res = await readAccessTokenDetailed(p);

    expect(res.source).toBe("sql");
    expect(res.token?.token).toBe(jwt);
    expect(res.cursorAuthKeys).toContain("cursorAuth/accessToken");
  });

  it("recovers via WAL byte-scan when ItemTable has no auth row but the sidecar contains a JWT", async () => {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    const p = path.join(tmp, "stale.vscdb");
    fs.writeFileSync(p, Buffer.from(db.export()));
    db.close();

    // Synthesise a WAL sidecar that carries the JWT in raw form. This
    // is not a real SQLite WAL frame; scanRawForJwt only looks at
    // bytes around the `cursorAuth/accessToken` marker, which is what
    // real WAL pages contain.
    fs.writeFileSync(
      `${p}-wal`,
      Buffer.concat([
        Buffer.from("padding-".repeat(64)),
        Buffer.from(`\x00cursorAuth/accessToken\x00${jwt}\x00`),
      ]),
    );

    const res = await readAccessTokenDetailed(p);

    expect(res.source).toBe("wal");
    expect(res.token?.token).toBe(jwt);
  });

  it("returns source=none and surfaces probe data when ItemTable has no auth and no WAL exists", async () => {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO ItemTable VALUES (?, ?)", ["telemetry.machineId", "x"]);
    const p = path.join(tmp, "noauth.vscdb");
    fs.writeFileSync(p, Buffer.from(db.export()));
    db.close();

    const res = await readAccessTokenDetailed(p);

    expect(res.source).toBe("none");
    expect(res.token).toBeNull();
    expect(res.cursorAuthKeys).toHaveLength(0);
    expect(res.probe?.tables).toContain("ItemTable");
    expect(res.probe?.mainDbJwtCount).toBe(0);
  });

  it("surfaces readError with the underlying errno when the DB file is missing", async () => {
    const res = await readAccessTokenDetailed(path.join(tmp, "absent.vscdb"));
    expect(res.source).toBe("none");
    expect(res.token).toBeNull();
    expect(res.readError).toMatch(/ENOENT|no such file/i);
  });

  it("populates cursorDiskKVSuspectKeys and cursorDiskKVHasJwt when a JWT is hidden in cursorDiskKV", async () => {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.run("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
      "auth/accessToken",
      jwt,
    ]);
    db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
      "cursor/sessionMeta",
      JSON.stringify({ unrelated: true }),
    ]);
    const p = path.join(tmp, "diskkv.vscdb");
    fs.writeFileSync(p, Buffer.from(db.export()));
    db.close();

    const res = await readAccessTokenDetailed(p);

    expect(res.source).toBe("none"); // canonical path only reads ItemTable
    expect(res.probe?.cursorDiskKVSuspectKeys).toContain("auth/accessToken");
    expect(res.probe?.cursorDiskKVHasJwt).toBe(true);
  });

  it("does not match dotted base64-ish identifiers as JWTs (regression for 0.4.10 false positives)", async () => {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO ItemTable VALUES (?, ?)", [
      "reactive.foo",
      "reactiveStorage.workbench.layout.Panel123.sidebar456",
    ]);
    const p = path.join(tmp, "noisy.vscdb");
    fs.writeFileSync(p, Buffer.from(db.export()));
    db.close();

    const res = await readAccessTokenDetailed(p);

    expect(res.probe?.mainDbJwtCount).toBe(0);
  });

  // Regression for the emily incident: the DB is so large that sql.js
  // cannot allocate its wasm heap, but the buffer itself loaded fine.
  // The byte-scan fallback should still recover the token from memory
  // and the result must be labelled ``source=main-scan`` so the log
  // says "we used the fallback path", not "the canonical SELECT
  // worked". We simulate the sql.js failure by handing in a buffer
  // that loads as a Buffer but is not a valid SQLite container.
  it("falls back to source=main-scan when sql.js cannot open the buffer but the bytes contain a token", async () => {
    const p = path.join(tmp, "not-sqlite.vscdb");
    // Bytes that pass ``readDbWithFallback`` (any non-empty file does)
    // but are not a valid SQLite database, so ``new SQL.Database(buf)``
    // throws. The scanner then walks the buffer and finds the key+JWT.
    fs.writeFileSync(
      p,
      Buffer.concat([
        Buffer.from("not a sqlite header, but readable bytes ".repeat(32)),
        Buffer.from(`\x00cursorAuth/accessToken\x00${jwt}\x00`),
        Buffer.from("trailing-padding".repeat(16)),
      ]),
    );

    const res = await readAccessTokenDetailed(p);

    expect(res.source).toBe("main-scan");
    expect(res.token?.token).toBe(jwt);
    expect(res.sqlOpenError).toMatch(/byte-scan fallback/);
  });
});
