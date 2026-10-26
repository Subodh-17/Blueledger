// scripts/local-stack.js — one-command local environment: Hardhat node -> deploy -> migrate -> seed reference data -> API + UI on http://localhost:3001
// Requires: PostgreSQL reachable (see backend/.env.example; `docker compose up -d db` provides one) and `npm run setup` done.
// The seed RESETS the local database. Refuses to run with NODE_ENV=production.
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const isWin = process.platform === "win32";

if (!process.env.DB_PASSWORD) {
  const envPath = path.join(ROOT, "backend", ".env");
  if (fs.existsSync(envPath)) {
    try { require(path.join(ROOT, "backend", "node_modules", "dotenv")).config({ path: envPath }); } catch {}
  }
}

if (process.env.NODE_ENV === "production") { console.error("local-stack.js is for local development only"); process.exit(1); }
const run = (cmd, args, cwd, label) => { const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env, shell: isWin }); if (r.status) { console.error(`\n${label} failed`); process.exit(r.status); } };

(async () => {
  console.log("1/5 starting local blockchain (Hardhat node)…");
  const node = spawn("npx", ["hardhat", "node"], { cwd: path.join(ROOT, "blockchain"), stdio: "ignore", shell: isWin });
  const stop = () => { node.kill(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const rpc = process.env.ETH_RPC_URL || "http://127.0.0.1:8545";
  for (let i = 0; ; i++) {
    try { const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch { /* wait */ }
    if (i > 60) { console.error("blockchain node did not start"); node.kill(); process.exit(1); }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("2/5 deploying BlueCarbonRegistry…"); run("npx", ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], path.join(ROOT, "blockchain"), "deploy");
  console.log("3/5 migrating database…"); run("node", ["database/migrate.js", "--reset"], ROOT, "migration");
  console.log("4/5 loading the illustrative reference dataset…"); run("node", ["database/seed.js"], ROOT, "seed");
  console.log("5/5 starting API + UI…");
  spawn("node", ["src/index.js"], { cwd: path.join(ROOT, "backend"), stdio: "inherit", env: process.env }).on("exit", stop);
})();
