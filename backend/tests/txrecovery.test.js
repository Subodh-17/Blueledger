// A recovered operation must record the transaction that actually happened, exactly like one that completed normally.
// Regression for recovery paths that completed with no transaction hash or block number (anchoring, verification, issuance).
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, projectBody, recordBody } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");
const chain = require("../src/services/chain");
const ops = require("../src/services/chainOps");
const C = require("../src/services/common");

cfg.rateLimit.max = 1e6; cfg.rateLimit.authMax = 1e6; cfg.scan.policy = "off"; cfg.ipfs.provider = "none";
let env; const S = {};
const count = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);
const crashOnce = (point = "after_submit_before_hash") => { ops.testHooks.fault = { point, times: 1 }; };
const recover = async () => { ops.testHooks.fault = null; await db.query("UPDATE chain_operations SET locked_until=NULL"); const s = await ops.reconcile(); assert.ok(s.completed >= 1, JSON.stringify(s)); return s; };

const newRecord = async (projectId, date) => {
  const r = await env.as("fieldA").post("/api/records", recordBody(projectId, { activityDate: date })); assert.equal(r.status, 201, JSON.stringify(r.body));
  const up = await env.as("fieldA").upload({ projectId, recordId: r.body.record.id, kind: "FIELD_PHOTO", captureDate: date, latitude: 16.9004, longitude: 82.2004 }); assert.equal(up.status, 201, JSON.stringify(up.body));
  return { rec: r.body.record, ev: up.body.evidence };
};
const opRow = async (type) => (await db.query("SELECT * FROM chain_operations WHERE op_type=$1 ORDER BY id DESC LIMIT 1", [type])).rows[0];

test.before(async () => {
  env = await setup();
  S.project = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a, { name: "Recovery project one" }))).body.project;
  // A warm-up submission registers the project on the chain, so the later crashes hit the operation each test is about.
  const warm = await newRecord(S.project.id, "2026-05-20"); assert.equal((await env.as("fieldA").post(`/api/records/${warm.rec.id}/submit`)).status, 200);
  assert.equal((await db.query("SELECT anchor_status FROM monitoring_records WHERE id=$1", [warm.rec.id])).rows[0].anchor_status, "ANCHORED", "warm-up anchored normally");
  const x = await newRecord(S.project.id, "2026-06-01"); S.rec = x.rec; S.ev = x.ev;
});
test.afterEach(() => { ops.testHooks.fault = null; });
test.after(async () => { await env.close(); });

test("project registration: a crash after the transaction was sent is recovered with its real transaction hash", async () => {
  const p2 = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a, { name: "Recovery project two" }))).body.project;
  const x = await newRecord(p2.id, "2026-06-02");
  crashOnce();
  const r = await env.as("fieldA").post(`/api/records/${x.rec.id}/submit`); assert.equal(r.status, 200, "the submission itself succeeds");
  const pending = await opRow("PROJECT_REGISTER"); assert.notEqual(pending.status, "COMPLETED"); assert.ok(!pending.tx_hash, "no hash was stored before the crash");
  await recover();
  const proj = (await db.query("SELECT uuid FROM projects WHERE id=$1", [p2.id])).rows[0];
  const evs = await chain.findEvents("ProjectRegistered", C.projectChainId({ uuid: proj.uuid })); assert.equal(evs.length, 1, "registered once");
  const done = await opRow("PROJECT_REGISTER"); assert.equal(done.status, "COMPLETED"); assert.equal(done.tx_hash, evs[0].transactionHash); assert.equal(Number(done.block_number), evs[0].blockNumber);
});

test("anchoring: a crash after the transaction was sent is recovered with its real transaction hash and block", async () => {
  crashOnce();
  const r = await env.as("fieldA").post(`/api/records/${S.rec.id}/submit`);
  assert.equal(r.status, 200, "the submission itself succeeds; a ledger failure must not invalidate the business transaction");
  assert.equal(ops.testHooks.fault?.times, 0, "the injected crash was used"); const stuck = await opRow("RECORD_ANCHOR"); assert.ok(stuck, "the anchoring operation was the one that crashed"); assert.notEqual(stuck.status, "COMPLETED"); assert.ok(!stuck.tx_hash);
  let row = (await db.query("SELECT * FROM monitoring_records WHERE id=$1", [S.rec.id])).rows[0];
  assert.equal(row.status, "SUBMITTED"); assert.notEqual(row.anchor_status, "ANCHORED", "an unconfirmed anchor is not reported as anchored"); assert.ok(!row.anchor_tx_hash);
  await recover();
  row = (await db.query("SELECT * FROM monitoring_records WHERE id=$1", [S.rec.id])).rows[0];
  const evs = await chain.findEvents("RecordAnchored", C.recordChainId(row)); assert.equal(evs.length, 1, "one anchoring transaction on the chain");
  assert.equal(row.anchor_status, "ANCHORED"); assert.equal(row.anchor_tx_hash, evs[0].transactionHash, "the stored hash is the real transaction");
  assert.equal(await count("SELECT COUNT(*) AS n FROM blockchain_transactions WHERE tx_hash=$1", [evs[0].transactionHash]), 1, "and it is in the chain-transaction log");
  const op = await opRow("RECORD_ANCHOR"); assert.equal(op.status, "COMPLETED"); assert.equal(op.tx_hash, evs[0].transactionHash); assert.equal(Number(op.block_number), evs[0].blockNumber);
  assert.equal((await ops.reconcile()).completed, 0, "a second reconciliation changes nothing"); assert.equal((await chain.findEvents("RecordAnchored", C.recordChainId(row))).length, 1);
});

test("verification: a crash after the transaction was sent is recovered with its real transaction hash", async () => {
  assert.equal((await env.as("verifier").post(`/api/records/${S.rec.id}/start-review`)).status, 200);
  assert.equal((await env.as("verifier").post(`/api/evidence/${S.ev.id}/review`, { decision: "VERIFIED" })).status, 200);
  crashOnce();
  const r = await env.as("verifier").post(`/api/records/${S.rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence and measurements are consistent." }); assert.equal(r.status, 500);
  assert.notEqual((await db.query("SELECT status FROM monitoring_records WHERE id=$1", [S.rec.id])).rows[0].status, "VERIFIED", "not verified until the transaction is confirmed");
  await recover();
  const row = (await db.query("SELECT * FROM monitoring_records WHERE id=$1", [S.rec.id])).rows[0]; assert.equal(row.status, "VERIFIED");
  const evs = await chain.findEvents("RecordVerified", C.recordChainId(row)); assert.equal(evs.length, 1);
  assert.equal(ops.testHooks.fault, null, "reset by recover()"); const op = await opRow("VERIFICATION"); assert.equal(op.status, "COMPLETED"); assert.equal(op.tx_hash, evs[0].transactionHash); assert.equal(Number(op.block_number), evs[0].blockNumber);
  assert.ok(await count("SELECT COUNT(*) AS n FROM blockchain_transactions WHERE tx_hash=$1", [evs[0].transactionHash]) >= 1, "the verification transaction is logged");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM verification_records WHERE record_id=$1", [S.rec.id])).rows[0].n, 1, "exactly one verification decision");
});
