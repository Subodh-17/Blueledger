// Blockchain failure and recovery: RPC outage, registry failure after on-chain confirmation, reconciliation, deployment validation.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cfg = require("../src/config");
const REAL_RPC = process.env.ETH_RPC_URL;

// A pass-through proxy in front of the local chain that can be switched off to simulate an outage.
let down = false, proxy;
const proxyReady = new Promise((resolve) => {
  proxy = http.createServer((req, res) => {
    if (down) return req.socket.destroy();
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try { const r = await fetch(REAL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) }); res.setHeader("content-type", "application/json"); res.end(await r.text()); }
      catch { req.socket.destroy(); }
    });
  }).listen(0, "127.0.0.1", resolve);
});
cfg.chain.rpcUrl = "http://127.0.0.1:0"; // set properly in before()

const { setup, projectBody, recordBody } = require("./helpers");
const chain = require("../src/services/chain");
const ops = require("../src/services/chainOps");
const db = require("../src/db");
const { bytes32Id } = require("../src/utils/hash");

let env, P;
const outage = async (fn) => { down = true; try { return await fn(); } finally { down = false; chain.lastTry = 0; await chain.init(); } };
const verified = async (date = "2026-06-01") => {
  const f = env.as("fieldA"), v = env.as("verifier");
  const rec = (await f.post("/api/records", recordBody(P.id, { activityDate: date }))).body.record;
  await f.upload({ projectId: P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: date });
  return rec;
};

test.before(async () => {
  await proxyReady;
  cfg.chain.rpcUrl = `http://127.0.0.1:${proxy.address().port}`;
  env = await setup();
  P = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a))).body.project;
});
test.after(async () => { proxy.close(); await env.close(); });

test("RPC outage during submission: record is kept, anchoring is stored as pending, reconciliation completes it after recovery", async () => {
  const rec = await verified();
  const res = await outage(() => env.as("fieldA").post(`/api/records/${rec.id}/submit`));
  assert.equal(res.status, 200, "submission is not lost when the network is unavailable");
  assert.equal(res.body.record.status, "SUBMITTED");
  assert.equal(res.body.record.anchored, false);
  assert.match(res.body.record.anchorError, /unavailable|unreachable|stored|retried/i);
  const row = (await db.query("SELECT anchor_status FROM monitoring_records WHERE id=$1", [rec.id])).rows[0];
  assert.equal(row.anchor_status, "PENDING");
  const opRow = (await db.query("SELECT status, last_error FROM chain_operations WHERE project_id=$1 ORDER BY id DESC LIMIT 1", [P.id])).rows[0];
  assert.equal(opRow.status, "PENDING", "a durable operation was stored for retry");
  assert.ok(opRow.last_error);

  // while the network is down, review cannot start and the user is told why
  const blocked = await outage(async () => env.as("verifier").post(`/api/records/${rec.id}/start-review`));
  assert.equal(blocked.status, 503);

  const summary = await ops.reconcile();
  assert.ok(summary.completed >= 1, JSON.stringify(summary));
  assert.equal((await db.query("SELECT anchor_status FROM monitoring_records WHERE id=$1", [rec.id])).rows[0].anchor_status, "ANCHORED");
  assert.equal((await chain.getRecord(bytes32Id("record", rec.uuid))).status, "ANCHORED");
  assert.equal((await env.as("verifier").post(`/api/records/${rec.id}/start-review`)).status, 200);
  const count = (await db.query("SELECT COUNT(*)::int n FROM blockchain_transactions WHERE record_id=$1 AND tx_type='RECORD_ANCHORED'", [rec.id])).rows[0].n;
  assert.equal(count, 1, "exactly one anchoring transaction was recorded");
  S.rec = rec;
});
const S = {};

test("RPC outage during a verification decision: nothing is half-applied and the same decision can be retried", async () => {
  const rec = S.rec;
  for (const e of (await env.as("verifier").get(`/api/evidence?recordId=${rec.id}`)).body.evidence) await env.as("verifier").post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" });
  const failed = await outage(() => env.as("verifier").post(`/api/records/${rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence consistent with measurements." }));
  assert.equal(failed.status, 503);
  assert.equal((await db.query("SELECT status FROM monitoring_records WHERE id=$1", [rec.id])).rows[0].status, "UNDER_REVIEW", "status unchanged");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM verification_records WHERE record_id=$1", [rec.id])).rows[0].n, 0);
  const retry = await env.as("verifier").post(`/api/records/${rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence consistent with measurements." });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.record.status, "VERIFIED");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM verification_records WHERE record_id=$1", [rec.id])).rows[0].n, 1, "no duplicate decision");
  const op = (await db.query("SELECT status, attempts FROM chain_operations WHERE op_type='VERIFICATION' AND record_id=$1", [rec.id])).rows[0];
  assert.equal(op.status, "COMPLETED");
});

test("registry failure AFTER on-chain confirmation: operation stays CONFIRMED and reconciliation applies it exactly once", async () => {
  const rec = S.rec;
  const calc = (await env.as("verifier").post(`/api/records/${rec.id}/carbon-estimate`)).body.calculation;
  assert.equal((await env.as("admin").post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Approved for issuance." })).status, 200);
  const before = (await chain.status()).totalIssued;
  ops.testHooks.failFinalizeOnce = true;
  const r = await env.as("admin").post(`/api/carbon/calculations/${calc.id}/issue`);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /confirmed on the blockchain.*registry update/i);
  assert.ok(r.body.details.txHash);
  assert.equal((await chain.getRecord(bytes32Id("record", rec.uuid))).status, "CREDITED", "the chain already issued the credits");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_credits WHERE record_id=$1", [rec.id])).rows[0].n, 0, "registry not yet updated");
  assert.equal((await db.query("SELECT status FROM chain_operations WHERE op_type='CREDIT_ISSUE' AND record_id=$1", [rec.id])).rows[0].status, "CONFIRMED");

  await db.query("UPDATE chain_operations SET locked_until=NULL WHERE record_id=$1", [rec.id]);
  const sum = await ops.reconcile();
  assert.ok(sum.completed >= 1, JSON.stringify(sum));
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_credits WHERE record_id=$1", [rec.id])).rows[0].n, 1);
  assert.equal((await db.query("SELECT status FROM chain_operations WHERE op_type='CREDIT_ISSUE' AND record_id=$1", [rec.id])).rows[0].status, "COMPLETED");
  assert.equal((await chain.status()).totalIssued - before, calc.eligible_credits, "supply grew by exactly one issuance");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM blockchain_transactions WHERE record_id=$1 AND tx_type='CREDITS_ISSUED'", [rec.id])).rows[0].n, 1);
  assert.equal((await env.as("admin").post(`/api/carbon/calculations/${calc.id}/issue`)).status, 409, "no second issuance");
  S.credit = (await db.query("SELECT * FROM carbon_credits WHERE record_id=$1", [rec.id])).rows[0];
  const reconcileTwice = await ops.reconcile();
  assert.equal(reconcileTwice.completed, 0, "reconciliation is idempotent");
});

test("transfer during an outage is stored, funds are reserved, and reconciliation completes it exactly once after recovery", async () => {
  const cid = S.credit.id;
  const key = "retry-key-" + Date.now();
  const bad = await outage(() => fetchWithKey(`/api/credits/${cid}/transfer`, { toOrgId: env.orgs.buyer, amount: 3 }, key));
  assert.equal(bad.status, 503);
  const bal = (await db.query("SELECT balance::float b FROM credit_balances WHERE credit_id=$1 AND org_id=$2", [cid, env.orgs.a])).rows[0].b;
  assert.equal(bal, Number(S.credit.amount_tonnes), "registry balance untouched until the transfer is confirmed");
  const op = (await db.query("SELECT id, status FROM chain_operations WHERE idempotency_key=$1", [`transfer:${cid}:${key}`])).rows[0];
  assert.equal(op.status, "PENDING", "the intent is stored so it is never lost");
  assert.equal((await db.query("SELECT status FROM credit_reservations WHERE op_id=$1", [op.id])).rows[0].status, "ACTIVE", "funds are reserved");
  const sum = await ops.reconcile();
  assert.ok(sum.completed >= 1, JSON.stringify(sum));
  const replay = await fetchWithKey(`/api/credits/${cid}/transfer`, { toOrgId: env.orgs.buyer, amount: 3 }, key);
  assert.equal(replay.status, 201, "the same idempotency key replays the stored result");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM credit_events WHERE credit_id=$1 AND event_type='TRANSFERRED'", [cid])).rows[0].n, 1, "the transfer happened exactly once");
  assert.equal((await db.query("SELECT status FROM credit_reservations WHERE op_id=$1", [op.id])).rows[0].status, "CONSUMED");
});
async function fetchWithKey(p, body, key) {
  const res = await fetch(env.base + p, { method: "POST", headers: { authorization: `Bearer ${env.tokens.fieldA}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("system status reports real connectivity and operation counts; admin can trigger reconciliation", async () => {
  const s = (await env.as("admin").get("/api/system/status")).body;
  assert.equal(s.database.connected, true);
  assert.equal(s.blockchain.ready, true);
  assert.ok(s.operations.COMPLETED >= 3);
  down = true;
  const during = (await env.anon.get("/api/chain/status")).body;
  assert.equal(during.connection, "NOT_CONNECTED", "an unreachable network is reported as not connected, never as empty or ok");
  assert.ok(during.error);
  down = false; chain.lastTry = 0; await chain.init();
  assert.equal((await env.anon.get("/api/chain/status")).body.connection, "CONNECTED");
  assert.equal((await env.as("verifier").post("/api/system/reconcile")).status, 403);
  assert.equal((await env.as("admin").post("/api/system/reconcile")).status, 200);
});

test("deployment validation: chain ID mismatch and incomplete ABI are rejected with clear errors", async () => {
  const dep = JSON.parse(fs.readFileSync(cfg.chain.deploymentFile, "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-"));
  const original = cfg.chain.deploymentFile;
  try {
    const bad1 = path.join(dir, "a.json"); fs.writeFileSync(bad1, JSON.stringify({ ...dep, chainId: dep.chainId + 1 }));
    cfg.chain.deploymentFile = bad1;
    assert.match((await chain.init()).error, /Chain ID mismatch/);
    const bad2 = path.join(dir, "b.json"); fs.writeFileSync(bad2, JSON.stringify({ ...dep, abi: dep.abi.filter((f) => f.name !== "issueCredits") }));
    cfg.chain.deploymentFile = bad2;
    assert.match((await chain.init()).error, /missing functions: issueCredits/);
    const bad3 = path.join(dir, "c.json"); fs.writeFileSync(bad3, JSON.stringify({ ...dep, address: "0x" + "12".repeat(20) }));
    cfg.chain.deploymentFile = bad3;
    assert.match((await chain.init()).error, /No contract code/);
    const bad4 = path.join(dir, "d.json"); fs.writeFileSync(bad4, "{not json");
    cfg.chain.deploymentFile = bad4;
    assert.match((await chain.init()).error, /not valid JSON/);
    cfg.chain.deploymentFile = path.join(dir, "missing.json");
    assert.match((await chain.init()).error, /not found/);
  } finally { cfg.chain.deploymentFile = original; assert.equal((await chain.init()).ready, true); fs.rmSync(dir, { recursive: true, force: true }); }
});
