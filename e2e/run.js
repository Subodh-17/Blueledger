// e2e/run.js — real-browser end-to-end run against disposable services.
// Starts a local Hardhat node, resets a DEDICATED database, seeds the illustrative reference dataset, starts the real server, then runs
// e2e/browser.spec.js with Playwright (Chromium). Nothing outside the temporary directory is touched.
// Requires: PostgreSQL reachable with DB_PASSWORD set; Playwright with a Chromium build (PLAYWRIGHT_BROWSERS_PATH if not the default);
// optionally axe-core (npm install axe-core) for the accessibility scan.
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const isWin = process.platform === "win32";

if (!process.env.DB_PASSWORD) {
  const envPath = path.join(ROOT, "backend", ".env");
  if (fs.existsSync(envPath)) {
    try { require(path.join(ROOT, "backend", "node_modules", "dotenv")).config({ path: envPath }); } catch {}
  }
}

const DB = process.env.E2E_DB_NAME || "blue_carbon_mrv_e2e";
if (!/(test|e2e)/i.test(DB)) { console.error(`Refusing to reset database "${DB}": the name must contain "test" or "e2e". The database is DROPPED AND RECREATED by this run.`); process.exit(2); }
if (!process.env.DB_PASSWORD) { console.error("Set DB_PASSWORD (and optionally DB_HOST, DB_PORT, DB_USER)."); process.exit(2); }
const CHAIN_PORT = process.env.E2E_CHAIN_PORT || "18547", APP_PORT = process.env.E2E_APP_PORT || "4010";
const RPC = `http://127.0.0.1:${CHAIN_PORT}`, BASE = `http://127.0.0.1:${APP_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcmrv-e2e-"));
const env = {
  ...process.env, NODE_ENV: "test", JWT_SECRET: "e2e-secret-not-for-production", BCRYPT_ROUNDS: "4", DB_NAME: DB, ETH_RPC_URL: RPC, CHAIN_MODE: "local",
  DEPLOYMENT_FILE: path.join(tmp, "deployment.json"), UPLOAD_DIR: path.join(tmp, "uploads"), IPFS_PROVIDER: "none", MALWARE_SCAN: "off", PORT: APP_PORT,
  REFERENCE_PASSWORD: process.env.REFERENCE_PASSWORD || `E2e-${crypto.randomBytes(9).toString("base64url")}-1a`, // random per run; the seeded accounts only exist in the disposable database E2E_BASE: BASE, E2E_TMP: tmp,
};
const rpc = async (method) => (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) })).ok;
const waitFor = async (fn, what) => { for (let i = 0; i < 80; i++) { try { if (await fn()) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error(`${what} did not start`); };

(async () => {
  const procs = []; let code = 1;
  try {
    // the database must exist; create it if the role may
    spawnSync("node", ["-e", `const {Client}=require("pg");(async()=>{const c=new Client({host:process.env.DB_HOST||"127.0.0.1",port:process.env.DB_PORT||5432,user:process.env.DB_USER||"postgres",password:process.env.DB_PASSWORD,database:"postgres"});await c.connect();const r=await c.query("select 1 from pg_database where datname=$1",[process.env.DB_NAME]);if(!r.rowCount)await c.query('create database "'+process.env.DB_NAME+'"');await c.end()})().catch(e=>{console.error(e.message);process.exit(1)})`], { cwd: path.join(ROOT, "backend"), env, stdio: "inherit" });
    procs.push(spawn("npx", ["hardhat", "node", "--port", CHAIN_PORT], { cwd: path.join(ROOT, "blockchain"), env, stdio: "ignore", shell: isWin }));
    await waitFor(() => rpc("eth_chainId"), "Hardhat node");
    for (const [cmd, args, cwd] of [["npx", ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], path.join(ROOT, "blockchain")], ["node", [path.join(ROOT, "database", "migrate.js"), "--reset"], ROOT], ["node", [path.join(ROOT, "database", "seed.js")], ROOT]]) {
      const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: cmd === "npx" ? isWin : false }); if (r.status) throw new Error(`${args.join(" ")} failed`);
    }
    procs.push(spawn("node", ["src/index.js"], { cwd: path.join(ROOT, "backend"), env, stdio: ["ignore", "ignore", "inherit"] }));
    await waitFor(async () => (await fetch(`${BASE}/health`)).ok, "the application");
    const spec = spawnSync("node", [path.join(__dirname, "browser.spec.js")], { cwd: ROOT, env: { ...env, NODE_PATH: [process.env.NODE_PATH, spawnSync("npm", ["root", "-g"]).stdout.toString().trim(), path.join(ROOT, "backend", "node_modules")].filter(Boolean).join(path.delimiter) }, stdio: "inherit" });
    code = spec.status ?? 1;
  } catch (e) { console.error(e.message); }
  finally { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
})();
