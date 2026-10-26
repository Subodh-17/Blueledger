// backend/tests/run.js — end-to-end test runner.
// Starts a local Hardhat node, deploys the contract, resets a dedicated test database and runs node:test.
// Requires: PostgreSQL reachable with DB_PASSWORD set (database TEST_DB_NAME, default blue_carbon_mrv_test; it is RESET).
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..", "..");
const isWin = process.platform === "win32";

// Auto-load backend/.env if DB_PASSWORD is not already set in process.env
if (!process.env.DB_PASSWORD) {
  const envPath = path.join(ROOT, "backend", ".env");
  if (fs.existsSync(envPath)) {
    try {
      require(path.join(ROOT, "backend", "node_modules", "dotenv")).config({ path: envPath });
    } catch { /* proceed with process.env */ }
  }
}

const PORT = process.env.TEST_CHAIN_PORT || "18545";
const RPC = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcmrv-test-"));
const env = {
  ...process.env, NODE_ENV: "test", JWT_SECRET: "test-secret-not-for-production", BCRYPT_ROUNDS: "4",
  DB_NAME: process.env.TEST_DB_NAME || "blue_carbon_mrv_test", ETH_RPC_URL: RPC, CHAIN_MODE: "local",
  DEPLOYMENT_FILE: path.join(tmp, "deployment.json"), UPLOAD_DIR: path.join(tmp, "uploads"), IPFS_PROVIDER: "none",
};

async function waitRpc() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Hardhat node did not start");
}

(async () => {
  if (!env.DB_PASSWORD) { console.error("Set DB_PASSWORD (and optionally DB_HOST/DB_USER) to run the tests."); process.exit(2); }
  const argsOnly = process.argv.slice(2);
  const node = spawn("npx", ["hardhat", "node", "--port", PORT], { cwd: path.join(ROOT, "blockchain"), env, stdio: "ignore", shell: isWin });
  let code = 1;
  try {
    await waitRpc();
    let r = spawnSync("npx", ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], { cwd: path.join(ROOT, "blockchain"), env, stdio: "inherit", shell: isWin });
    if (r.status) throw new Error("deploy failed");
    r = spawnSync("node", [path.join(ROOT, "database", "migrate.js"), "--reset"], { env, stdio: "inherit" });
    if (r.status) throw new Error("migration failed");
    const files = argsOnly.length ? argsOnly : fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).map((f) => path.join(__dirname, f));
    r = spawnSync("node", ["--test", "--test-concurrency=1", ...files], { env, stdio: "inherit" });
    code = r.status ?? 1;
  } catch (e) { console.error(e.message); }
  finally { node.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
})();
