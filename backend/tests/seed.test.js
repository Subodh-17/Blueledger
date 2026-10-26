// The demo seed must produce every lifecycle state, with real on-chain transactions and a consistent audit trail.
const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/db");
const chain = require("../src/services/chain");
const audit = require("../src/services/audit");
const { seed } = require("../../database/seed");

test("reference dataset seed covers all lifecycle states and is chain-consistent", async () => {
  await chain.init();
  const before = await chain.status(); // the local chain is shared by all test files, so compare deltas
  const counts = await seed({ log: () => {} });
  assert.equal(counts.projects, 7);
  const recStatus = Object.fromEntries((await db.query("SELECT status, COUNT(*)::int n FROM monitoring_records GROUP BY status")).rows.map((r) => [r.status, r.n]));
  for (const s of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "VERIFIED", "REJECTED", "NEEDS_REVISION"]) assert.ok(recStatus[s] >= 1, `has ${s} record`);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_credits")).rows[0].n, 2);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_calculations WHERE approval_status='PENDING' AND is_current")).rows[0].n, 2);
  const blocked = (await db.query("SELECT blockers FROM carbon_calculations WHERE methodology_version='IPCC-WS2013-T1-v1'")).rows;
  assert.equal(blocked.length, 1, "one assessment uses the sourced methodology");
  const codes = blocked[0].blockers.map((b) => b.code);
  for (const c of ["METHODOLOGY_NOT_APPROVED", "BUFFER_UNSET", "DETERMINATION_BASELINE_MISSING", "DETERMINATION_ADDITIONALITY_MISSING", "DETERMINATION_LEAKAGE_MISSING"]) assert.ok(codes.includes(c), c);
  assert.ok((await db.query("SELECT COUNT(*)::int n FROM evidence WHERE kind='DRONE_IMAGERY'")).rows[0].n >= 3);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM projects WHERE data_origin<>'ILLUSTRATIVE'")).rows[0].n, 0);
  // every chain tx hash is a real 32-byte hash on the local chain and every credit balance matches on-chain
  const txs = (await db.query("SELECT tx_hash FROM blockchain_transactions")).rows;
  assert.ok(txs.length >= 20);
  for (const t of txs) assert.ok(await chain.provider.getTransactionReceipt(t.tx_hash), "receipt exists on chain");
  const st = await chain.status();
  const issued = Number((await db.query("SELECT SUM(amount_tonnes)::int s FROM carbon_credits")).rows[0].s);
  assert.equal(st.totalIssued - before.totalIssued, issued);
  assert.equal(st.totalRetired - before.totalRetired, 10);
  assert.equal((await audit.verifyChain()).ok, true);
  await db.end();
});
