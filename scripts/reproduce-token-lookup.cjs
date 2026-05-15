/**
 * Local repro harness for the WAL-vs-SQL token lookup path.
 *
 * Goal: prove on the developer machine that
 *   1. the canonical SQL SELECT against state.vscdb finds the token, OR
 *   2. the byte-scan fallback finds it in state.vscdb / state.vscdb-wal
 *      when SQL does not.
 *
 * Run with:
 *   node scripts/reproduce-token-lookup.cjs
 *   node scripts/reproduce-token-lookup.cjs --db "C:\\path\\to\\state.vscdb"
 *
 * It never contacts cursor.com and never prints the token payload. It only
 * prints the lookup path that produced the token and the prefix of the JWT
 * (so two runs can be compared without leaking the secret).
 */

const path = require("path");
const fs = require("fs");

// Reuse the compiled extension module so we test the exact code shipped in
// the VSIX, not a parallel implementation that could drift.
const cursor = require(path.join(__dirname, "..", "out", "cursor.js"));

cursor.setWasmDirectory(path.join(__dirname, "..", "media"));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function describeToken(t) {
  if (!t) return "<none>";
  const prefix = t.token.slice(0, 12);
  return `prefix=${prefix}... sub=${t.sub.slice(0, 6)}... exp=${new Date(
    t.expiresAt * 1000,
  ).toISOString()}`;
}

async function main() {
  let db = arg("--db");
  if (!db) {
    db = cursor.findStateDb();
    if (!db) {
      console.error("no state.vscdb found via candidateUserDirs(); pass --db");
      console.error("candidates considered:");
      for (const c of cursor.candidateUserDirs()) console.error("  " + c);
      process.exit(2);
    }
  }
  console.log(`db file:        ${db}`);
  try {
    const st = fs.statSync(db);
    console.log(`db size:        ${(st.size / 1024 / 1024).toFixed(1)} MB`);
  } catch {}
  for (const sidecar of [`${db}-wal`, `${db}-shm`]) {
    try {
      const st = fs.statSync(sidecar);
      console.log(
        `${path.basename(sidecar)} size: ${(st.size / 1024).toFixed(0)} KB`,
      );
    } catch {
      console.log(`${path.basename(sidecar)}: <missing>`);
    }
  }

  console.log("\n--- readAccessTokenDetailed (SQL + WAL fallback) ---");
  const detailed = await cursor.readAccessTokenDetailed(db);
  console.log(`source:         ${detailed.source}`);
  console.log(`cursorAuthKeys: ${JSON.stringify(detailed.cursorAuthKeys)}`);
  console.log(`token:          ${describeToken(detailed.token)}`);

  // Repro the production "SQL SELECT returned nothing" symptom by reading
  // ONLY the WAL sidecar and pretending the SQL row set was empty. This is
  // the exact path another user hit in 0.4.5; a passing test here means the
  // 0.4.6 WAL fallback would have saved them.
  console.log("\n--- simulated SQL-empty: WAL-only token recovery ---");
  try {
    const walBytes = fs.readFileSync(`${db}-wal`);
    const walToken = cursor.scanRawForJwt(walBytes);
    console.log(`wal-only token: ${describeToken(walToken)}`);
  } catch (e) {
    console.log(`wal-only token: <wal missing> (${e.code || e.message})`);
  }

  console.log("\n--- isolated WAL byte-scan (no SQL) ---");
  try {
    const walBytes = fs.readFileSync(`${db}-wal`);
    const walToken = cursor.scanRawForJwt(walBytes);
    console.log(`wal scan token: ${describeToken(walToken)}`);
  } catch (e) {
    console.log(`wal scan token: <wal missing> (${e.code || e.message})`);
  }

  console.log("\n--- isolated main-DB byte-scan (no SQL) ---");
  const mainBytes = fs.readFileSync(db);
  const mainToken = cursor.scanRawForJwt(mainBytes);
  console.log(`main scan token: ${describeToken(mainToken)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
