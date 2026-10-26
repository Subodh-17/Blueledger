// scripts/backup-restore-drill.js — proves a backup can be restored, in isolation from the live registry.
// Backs up the configured database + evidence, restores into a scratch database/directory, and verifies:
//   * every table has the same row count; schema migrations match
//   * the audit log hash chain verifies in the live database (before) and in the restored copy, so a failure can be attributed to the data or to the restore
//   * every evidence file exists and its stored bytes match the recorded hash
//   * the manifest check rejects a corrupted backup
// Usage: DB_PASSWORD=... node scripts/backup-restore-drill.js     (exit code 1 on any failed check)
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const req = (m) => require(require.resolve(m, { paths: [path.join(ROOT, "backend")] }));
const { Pool } = req("pg");

const env = { ...process.env };
if (!env.DB_PASSWORD) {
  const envPath = path.join(ROOT, "backend", ".env");
  if (fs.existsSync(envPath)) {
    try {
      require(path.join(ROOT, "backend", "node_modules", "dotenv")).config({ path: envPath });
      Object.assign(env, process.env);
    } catch {}
  }
}
const DB = env.DB_NAME || "blue_carbon_mrv", RESTORED = `${DB}_drill_${Date.now()}`;
const UPLOADS = env.UPLOAD_DIR || path.join(ROOT, "backend", "uploads");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcr-drill-")), backup = path.join(tmp, "backup"), restoredUploads = path.join(tmp, "uploads");
const results = []; const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
const sh = (script, args, extra = {}) => { const t0 = Date.now(); const r = spawnSync("bash", [path.join(ROOT, "scripts", script), ...args], { env: { ...env, ...extra }, encoding: "utf8" }); return { ...r, ms: Date.now() - t0 }; };
const pool = (db) => new Pool({ host: env.DB_HOST || "localhost", port: Number(env.DB_PORT || 5432), database: db, user: env.DB_USER || "postgres", password: env.DB_PASSWORD });

// Verifies the audit hash chain of one database in a child process (the service reads DB_NAME at load time).
// stdout carries {ok, entries, firstBadId}; stderr carries the error if verification itself could not run (exit code 2).
const verifyChainIn = (dbName) => {
  const code = `process.chdir(${JSON.stringify(path.join(ROOT, "backend"))});
    const a = require(${JSON.stringify(path.join(ROOT, "backend", "src", "services", "audit"))}), db = require(${JSON.stringify(path.join(ROOT, "backend", "src", "db"))});
    a.verifyChain().then(async (r) => { console.log(JSON.stringify(r)); await db.end(); process.exit(r.ok ? 0 : 1); })
      .catch((e) => { console.error(e.stack || e.message); process.exit(2); });`;
  return spawnSync(process.execPath, ["-e", code], { env: { ...env, DB_NAME: dbName, NODE_ENV: "test" }, encoding: "utf8" });
};

(async () => {
  if (!env.DB_PASSWORD) { console.error("DB_PASSWORD is required"); process.exit(2); }
  const src = pool(DB);
  const tables = (await src.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows.map((r) => r.tablename);
  const counts = {}; for (const t of tables) counts[t] = Number((await src.query(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);
  const lastAudit = (await src.query("SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1")).rows[0]?.entry_hash;

  const live = verifyChainIn(DB);
  check("audit hash chain verifies in the live database (before the backup)", live.status === 0, (live.stdout || live.stderr || "").trim().slice(0, 400));
  const b = sh("backup.sh", [backup], { UPLOAD_DIR: UPLOADS });
  check("backup completed with a manifest", b.status === 0 && fs.existsSync(path.join(backup, "MANIFEST.sha256")), `${b.ms} ms, ${fs.statSync(path.join(backup, "db.dump")).size} bytes dump`);
  const r = sh("restore.sh", [backup, RESTORED, restoredUploads], { UPLOAD_DIR: UPLOADS });
  check("restore into an isolated database and directory completed", r.status === 0, `${r.ms} ms`);
  const dst = pool(RESTORED);
  try {
    let same = true; const diffs = [];
    for (const t of tables) { const n = Number((await dst.query(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n); if (n !== counts[t]) { same = false; diffs.push(`${t}: ${counts[t]} vs ${n}`); } }
    check(`row counts equal in all ${tables.length} tables`, same, diffs.join("; "));
    check("audit log tail hash identical", (await dst.query("SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1")).rows[0]?.entry_hash === lastAudit);
    const chain = verifyChainIn(RESTORED);
    check("audit hash chain verifies in the restored copy", chain.status === 0, (chain.stdout || chain.stderr || "").trim().slice(0, 400));
    const ev = (await dst.query("SELECT code, storage_uri, stored_sha256, sha256 FROM evidence WHERE storage_uri IS NOT NULL")).rows;
    let missing = 0, mismatched = 0;
    for (const e of ev) { const p = path.join(restoredUploads, e.storage_uri); if (!fs.existsSync(p)) missing++; else if (crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== (e.stored_sha256 || e.sha256)) mismatched++; }
    check(`all ${ev.length} evidence files present and matching their recorded hashes`, missing + mismatched === 0, missing + mismatched ? `${missing} missing from the backed-up evidence directory, ${mismatched} with a different hash (UPLOAD_DIR=${UPLOADS})` : "");
    const mig = (await dst.query("SELECT COUNT(*) AS n FROM schema_migrations")).rows[0].n;
    check("schema migrations preserved", Number(mig) === counts.schema_migrations, `${mig} applied`);
  } finally {
    await dst.end(); await src.end();
    const admin = pool("postgres"); await admin.query(`DROP DATABASE IF EXISTS "${RESTORED}"`); await admin.end();
  }
  // corrupted backup must be refused
  fs.appendFileSync(path.join(backup, "uploads.tar.gz"), "corruption");
  const bad = sh("restore.sh", [backup, `${RESTORED}_x`, path.join(tmp, "x")], { UPLOAD_DIR: UPLOADS });
  check("a corrupted backup is refused by the manifest check", bad.status !== 0);
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((x) => !x.ok).length;
  console.log(failed ? `\nDRILL FAILED (${failed} check(s))` : `\nDRILL PASSED (${results.length} checks); backup ${b.ms} ms, restore ${r.ms} ms on this host`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("drill error:", e.message); process.exit(1); });
