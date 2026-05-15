/**
 * Synthetic reproducer for the WAL-only token recovery path.
 *
 * We use sql.js to build a tiny ItemTable from scratch, insert a real
 * Cursor-shaped JWT under `cursorAuth/accessToken`, and write the file out.
 * Then we manually craft a *second* SQLite file pair where the main DB is
 * checkpoint-clean (no auth row) but a sidecar WAL file contains the JWT
 * bytes — that is exactly the production failure mode 0.4.5 reported.
 *
 * Running this script is a no-op for the user's real Cursor data; the
 * synthetic files live in a temporary directory and are removed at exit.
 *
 *   node scripts/reproduce-wal-fallback.cjs
 *
 * Expected output (passes):
 *   sql path on healthy DB:   source=sql,  token recovered
 *   sql path on stale DB:     source=none from SQL alone
 *   wal byte-scan on stale:   token recovered
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const cursor = require(path.join(__dirname, "..", "out", "cursor.js"));
cursor.setWasmDirectory(path.join(__dirname, "..", "media"));

// A throw-away JWT that satisfies parseJwtToToken: three base64url segments
// where the payload has `sub` and a future `exp`. Header and signature are
// arbitrary base64url runs (never verified by the extension).
function buildFakeJwt() {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "auth0|repro",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const sig = Buffer.from("repro-signature").toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function main() {
  const jwt = buildFakeJwt();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "act-repro-"));
  const healthy = path.join(tmp, "healthy.vscdb");
  const stale = path.join(tmp, "stale.vscdb");
  const staleWal = `${stale}-wal`;

  // --- build a healthy DB: ItemTable contains cursorAuth/accessToken ---
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, "..", "media", f),
  });
  let db = new SQL.Database();
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO ItemTable VALUES (?, ?)", [
    "cursorAuth/accessToken",
    jwt,
  ]);
  fs.writeFileSync(healthy, Buffer.from(db.export()));
  db.close();

  // --- build a stale DB: same schema but no auth row. The "WAL" sidecar is
  //     not a real SQLite WAL — we never run sql.js against it — but
  //     scanRawForJwt only cares about raw bytes containing the key and the
  //     JWT, which is exactly what a real WAL frame would contain. ---
  db = new SQL.Database();
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  fs.writeFileSync(stale, Buffer.from(db.export()));
  db.close();
  fs.writeFileSync(
    staleWal,
    Buffer.concat([
      Buffer.from("wal-header-padding-".repeat(32)),
      Buffer.from(`\x00cursorAuth/accessToken\x00${jwt}\x00`),
      Buffer.from("trailer-padding-".repeat(32)),
    ]),
  );

  let failed = 0;
  function check(label, ok, extra) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
    if (!ok) failed++;
  }

  // Healthy DB: SQL path should win.
  const a = await cursor.readAccessTokenDetailed(healthy);
  check(
    "healthy DB → source=sql",
    a.source === "sql" && a.token && a.token.token === jwt,
    `(source=${a.source}, recovered=${!!a.token})`,
  );

  // Stale DB with WAL sidecar containing the JWT: SQL returns nothing, WAL
  // byte-scan rescues it. This is the production failure mode.
  const b = await cursor.readAccessTokenDetailed(stale);
  check(
    "stale DB + WAL sidecar → source=wal",
    b.source === "wal" && b.token && b.token.token === jwt,
    `(source=${b.source}, recovered=${!!b.token})`,
  );

  // Stale DB with no WAL sidecar at all: both paths return nothing.
  fs.unlinkSync(staleWal);
  const c = await cursor.readAccessTokenDetailed(stale);
  check(
    "stale DB, no WAL → source=none",
    c.source === "none" && !c.token,
    `(source=${c.source}, recovered=${!!c.token})`,
  );
  check(
    "stale DB, no WAL → probe populated (tables listed)",
    Array.isArray(c.probe && c.probe.tables) &&
      c.probe.tables.includes("ItemTable"),
    `(tables=${JSON.stringify(c.probe && c.probe.tables)})`,
  );

  // Mimic the emilyzh failure mode: ItemTable exists but has no cursorAuth
  // rows at all. Probe should report the empty cursorAuth key list, list
  // the table, and find zero JWTs anywhere.
  const moved = path.join(tmp, "moved.vscdb");
  db = new SQL.Database();
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO ItemTable VALUES (?, ?)", [
    "telemetry.machineId",
    "abc123",
  ]);
  fs.writeFileSync(moved, Buffer.from(db.export()));
  db.close();
  const d = await cursor.readAccessTokenDetailed(moved);
  check(
    "moved-auth DB → source=none, probe surfaces empty cursorAuth",
    d.source === "none" &&
      d.cursorAuthKeys.length === 0 &&
      d.probe &&
      d.probe.mainDbJwtCount === 0 &&
      d.probe.tables.includes("ItemTable"),
    `(cursorAuthKeys=${JSON.stringify(d.cursorAuthKeys)}, jwt=${
      d.probe && d.probe.mainDbJwtCount
    })`,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
