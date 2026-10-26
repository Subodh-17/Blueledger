// Crash-recovery and concurrency invariants for blockchain operations (fault injection at every boundary).
// Invariants (see src/services/chainOps.js): I1 at most one on-chain effect; I2 registry applies it exactly once; I3 no overspend under concurrency;
// I4 dropped/reorganised transactions are detected and re-submitted safely; I5 timeouts never mean failure.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { setup, projectBody, recordBody } = require("./helpers");
const cfg = require("../src/config");
const chain = require("../src/services/chain");
const ops = require("../src/services/chainOps");
const consistency = require("../src/services/consistency");
const db = require("../src/db");
const { bytes32Id } = require("../src/utils/hash");

let env, P, credit, rec32;
const key = () => "k-" + Math.random().toString(36).slice(2) + Date.now();
const move = async (who, cid, kind, body, k = key()) => {
  const res = await fetch(`${env.base}/api/credits/${cid}/${kind}`, { method: "POST", headers: { authorization: `Bearer ${env.tokens[who]}`, "content-type": "application/json", "idempotency-key": k }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), key: k };
};
const crashAt = (point) => { ops.testHooks.fault = { point, times: 1 }; };
const unlock = () => db.query("UPDATE chain_operations SET locked_until=NULL"); // emulates the lock expiring after a process crash
const opOf = async (k) => (await db.query("SELECT * FROM chain_operations WHERE idempotency_key LIKE $1", [`%:${k}`])).rows[0];
const onChain = (wallet) => chain.batchBalance(rec32, wallet);
const bal = async (org) => (await db.query("SELECT COALESCE(SUM(balance),0)::float b FROM credit_balances WHERE credit_id=$1 AND org_id=$2", [credit.id, org])).rows[0].b;
const eventsOf = async (id) => (await db.query("SELECT event FROM chain_operation_events WHERE op_id=$1 ORDER BY id", [id])).rows.map((r) => r.event);

test.before(async () => {
  env = await setup();
  const a = env.as("admin"), f = env.as("fieldA"), v = env.as("verifier");
  P = (await a.post("/api/projects", projectBody(env.orgs.a))).body.project;
  const rec = (await f.post("/api/records", recordBody(P.id))).body.record;
  await f.upload({ projectId: P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: "2026-06-01" });
  await f.post(`/api/records/${rec.id}/submit`); await v.post(`/api/records/${rec.id}/start-review`);
  for (const e of (await v.get(`/api/evidence?recordId=${rec.id}`)).body.evidence) await v.post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" });
  await v.post(`/api/records/${rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence and measurements are consistent." });
  const calc = (await v.post(`/api/records/${rec.id}/carbon-estimate`)).body.calculation;
  await a.post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Approved for issuance." });
  credit = (await a.post(`/api/carbon/calculations/${calc.id}/issue`)).body.credit;
  rec32 = bytes32Id("record", rec.uuid);
});
test.afterEach(() => { ops.testHooks.fault = null; ops.testHooks.failFinalizeOnce = false; });
test.after(async () => { await env.close(); });

const transferCrash = async (point, extra) => {
  const before = { a: await bal(env.orgs.a), b: await bal(env.orgs.buyer), ca: await onChain(env.accounts[4]), cb: await onChain(env.accounts[6]) };
  crashAt(point);
  const k = key();
  const r = await move("fieldA", credit.id, "transfer", { toOrgId: env.orgs.buyer, amount: 7 }, k);
  assert.equal(r.status, 500, `the request died at ${point} like a crashed process`);
  ops.testHooks.fault = null;
  const op = await opOf(k);
  if (extra) await extra(op, k);
  await unlock();
  const sum = await ops.reconcile();
  assert.ok(sum.completed >= 1, JSON.stringify(sum));
  const done = await opOf(k);
  assert.equal(done.status, "COMPLETED");
  assert.equal(await bal(env.orgs.a), before.a - 7); assert.equal(await bal(env.orgs.buyer), before.b + 7);
  assert.equal(await onChain(env.accounts[4]), before.ca - 7, "exactly one on-chain debit"); assert.equal(await onChain(env.accounts[6]), before.cb + 7, "exactly one on-chain credit");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM credit_events WHERE tx_hash=$1", [done.tx_hash])).rows[0].n, 1, "exactly one registry event");
  assert.equal((await db.query("SELECT status FROM credit_reservations WHERE op_id=$1", [done.id])).rows[0].status, "CONSUMED");
  assert.equal((await ops.reconcile()).completed, 0, "a second reconciliation changes nothing");
  return { op, done, k };
};

test("boundary 1 - crash BEFORE transaction submission: nothing on-chain; reconciliation submits once", async () => {
  const { op } = await transferCrash("before_submit", async (o, k) => {
    assert.equal(o.status, "PENDING"); assert.equal(o.tx_hash, null);
    assert.equal(await chain.refUsed(ethers.id(`transfer:${credit.id}:${k}`)), false, "no on-chain effect yet");
  });
  assert.ok((await eventsOf(op.id)).includes("STORED"));
});

test("boundary 2 - crash AFTER submission but BEFORE the hash is persisted: the unique on-chain reference proves it happened, so it is never sent twice", async () => {
  const { op } = await transferCrash("after_submit_before_hash", async (o, k) => {
    assert.equal(o.status, "PENDING"); assert.equal(o.tx_hash, null, "the hash was lost in the crash");
    assert.equal(await chain.refUsed(ethers.id(`transfer:${credit.id}:${k}`)), true, "...yet the transfer is already on-chain");
  });
  const ev = await eventsOf(op.id);
  assert.ok(ev.includes("FOUND_ON_CHAIN") && !ev.includes("SUBMITTED"), "recovered from the event log without re-submission: " + ev.join(","));
});

test("boundary 3 - crash AFTER the hash is persisted: reconciliation reads the receipt", async () => {
  const { op } = await transferCrash("after_hash", async (o) => { assert.equal(o.status, "SUBMITTED"); assert.match(o.tx_hash, /^0x[0-9a-f]{64}$/); });
  assert.ok((await eventsOf(op.id)).includes("CONFIRMED"));
});

test("boundary 4 - crash AFTER on-chain confirmation, before it is recorded", async () => {
  await transferCrash("after_confirm", async (o) => assert.equal(o.status, "SUBMITTED"));
});

test("boundary 5 - crash BEFORE the database state transition: operation stays CONFIRMED; the effect is applied exactly once", async () => {
  await transferCrash("before_db_transition", async (o) => { assert.equal(o.status, "CONFIRMED"); assert.equal((await db.query("SELECT status FROM credit_reservations WHERE op_id=$1", [o.id])).rows[0].status, "ACTIVE", "funds stay reserved until applied"); });
});

test("boundary 6 - crash DURING reconciliation: the lock protects the operation, and a later reconciliation completes it", async () => {
  const k = key(); crashAt("after_hash");
  await move("fieldA", credit.id, "transfer", { toOrgId: env.orgs.buyer, amount: 4 }, k); ops.testHooks.fault = null;
  await unlock();
  crashAt("during_reconcile");
  await assert.rejects(ops.reconcile(), /simulated crash at during_reconcile/);
  const locked = await opOf(k);
  assert.equal(locked.status, "SUBMITTED"); assert.ok(locked.locked_until, "the crashed reconciler left its claim in place");
  assert.equal((await ops.reconcile()).examined, 0, "another reconciler does not touch a claimed operation");
  await unlock();
  assert.ok((await ops.reconcile()).completed >= 1);
  assert.equal((await opOf(k)).status, "COMPLETED");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM credit_events WHERE credit_id=$1 AND amount=4 AND event_type='TRANSFERRED'", [credit.id])).rows[0].n, 1);
});

test("boundary 7 - concurrent transfers cannot overspend: reserved funds make exactly the affordable number succeed", async () => {
  const total = await bal(env.orgs.a), amount = Math.floor(total * 0.4) + 1; // three requests of ~40%: at most two can be afforded
  const rs = await Promise.all([1, 2, 3].map(() => move("fieldA", credit.id, "transfer", { toOrgId: env.orgs.buyer, amount })));
  const ok = rs.filter((r) => r.status === 201).length, rejected = rs.filter((r) => r.status === 409).length;
  assert.equal(ok, 2, JSON.stringify(rs.map((r) => [r.status, r.body?.error])));
  assert.equal(rejected, 1);
  assert.match(rs.find((r) => r.status === 409).body.error, /Insufficient available balance/);
  assert.equal(await bal(env.orgs.a), total - 2 * amount);
  assert.equal(await onChain(env.accounts[4]), total - 2 * amount, "the contract agrees");
});

test("concurrent transfer and retirement of the same credits: only one can win", async () => {
  const total = await bal(env.orgs.a), amount = Math.floor(total * 0.7);
  if (amount < 1) return;
  const [t, r] = await Promise.all([move("fieldA", credit.id, "transfer", { toOrgId: env.orgs.buyer, amount }), move("fieldA", credit.id, "retire", { amount, reason: "Voluntary retirement for test" })]);
  assert.deepEqual([t.status, r.status].sort(), [201, 409]);
  assert.equal(await bal(env.orgs.a), total - amount);
  assert.equal(await onChain(env.accounts[4]), total - amount);
});

test("the same idempotency key submitted concurrently executes once", async () => {
  const k = key(), before = await onChain(env.accounts[6]);
  const rs = await Promise.all([1, 2, 3, 4].map(() => move("buyer", credit.id, "transfer", { toOrgId: env.orgs.a, amount: 1 }, k)));
  assert.ok(rs.some((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.ok(rs.every((r) => [201, 409].includes(r.status)));
  assert.equal(before - (await onChain(env.accounts[6])), 1, "exactly one unit moved on-chain");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM chain_operations WHERE idempotency_key=$1", [`transfer:${credit.id}:${k}`])).rows[0].n, 1);
});

test("chain reorganisation: a transaction that disappears is detected and re-submitted once its effect is proven absent", async () => {
  const snap = await env.provider.send("evm_snapshot", []);
  const before = { a: await bal(env.orgs.a), cb: await onChain(env.accounts[6]) };
  const k = key(); crashAt("after_hash");
  await move("buyer", credit.id, "transfer", { toOrgId: env.orgs.a, amount: 2 }, k); ops.testHooks.fault = null;
  const o1 = await opOf(k); assert.equal(o1.status, "SUBMITTED");
  await env.provider.send("evm_revert", [snap]); // the block containing the transaction is reorganised away
  // A real node may return the transaction to its mempool and re-mine it (handled: it is then simply CONFIRMED). Here it is lost for good.
  await env.provider.send("hardhat_dropTransaction", [o1.tx_hash]);
  assert.equal(await chain.refUsed(ethers.id(`transfer:${credit.id}:${k}`)), false, "the effect no longer exists on-chain");
  await unlock();
  const saved = cfg.chain.dropGraceMs; cfg.chain.dropGraceMs = 600000;
  try { const waiting = await ops.reconcile(); assert.equal(waiting.completed, 0, "within the grace period the service waits instead of re-sending"); } finally { cfg.chain.dropGraceMs = saved; }
  await unlock(); cfg.chain.dropGraceMs = 0;
  try { const s = await ops.reconcile(); assert.ok(s.completed >= 1, JSON.stringify(s)); } finally { cfg.chain.dropGraceMs = saved; }
  const o2 = await opOf(k);
  assert.equal(o2.status, "COMPLETED"); // (an identical re-submission can legitimately have the identical hash: same signer, nonce and calldata)
  assert.ok((await eventsOf(o2.id)).includes("DROPPED_RESUBMIT"));
  assert.equal(await onChain(env.accounts[6]), before.cb - 2, "exactly one transfer on-chain after the reorganisation");
  assert.equal(await bal(env.orgs.a), before.a + 2);
});

test("a revert by the contract is permanent: operation FAILED, funds released, registry unchanged, then divergence is reported", async () => {
  const before = await bal(env.orgs.a), chainBefore = await onChain(env.accounts[4]);
  await db.query("UPDATE credit_balances SET balance = balance + 50 WHERE credit_id=$1 AND org_id=$2", [credit.id, env.orgs.a]); // registry now claims more than the chain holds
  const r = await move("fieldA", credit.id, "transfer", { toOrgId: env.orgs.buyer, amount: before + 20 });
  assert.equal(r.status, 409); assert.match(r.body.error, /rejected the transaction/);
  const op = await opOf(r.key);
  assert.equal(op.status, "FAILED");
  assert.equal((await db.query("SELECT status FROM credit_reservations WHERE op_id=$1", [op.id])).rows[0].status, "RELEASED");
  assert.equal(await onChain(env.accounts[4]), chainBefore);
  const report = await consistency.check();
  assert.equal(report.ok, false);
  assert.ok(report.mismatches.some((m) => m.type === "BALANCE" && m.registry === before + 50 && m.onChain === chainBefore), JSON.stringify(report.mismatches));
  await db.query("UPDATE credit_balances SET balance = balance - 50 WHERE credit_id=$1 AND org_id=$2", [credit.id, env.orgs.a]);
  assert.equal((await consistency.check()).ok, true, "consistent again after repair");
});

test("direct contract interaction that bypasses the registry is reported as an unknown on-chain event", async () => {
  const holder = await env.provider.getSigner(env.accounts[4]);
  const c = new ethers.Contract(chain.address, chain.abi, holder);
  await (await c.transfer(rec32, env.accounts[6], 1, ethers.id("outside-the-registry-" + Date.now()))).wait();
  const report = await consistency.check();
  assert.equal(report.ok, false);
  assert.ok(report.mismatches.some((m) => m.type === "UNKNOWN_CHAIN_EVENT"));
  assert.ok(report.mismatches.some((m) => m.type === "BALANCE"));
  assert.equal((await env.as("verifier").get("/api/system/consistency")).status, 403);
  assert.equal((await env.as("admin").get("/api/system/consistency")).body.ok, false, "visible to administrators");
});

test("a transfer or retirement without an Idempotency-Key is refused; replays of a completed key return the stored result", async () => {
  const bad = await fetch(`${env.base}/api/credits/${credit.id}/retire`, { method: "POST", headers: { authorization: `Bearer ${env.tokens.fieldA}`, "content-type": "application/json" }, body: JSON.stringify({ amount: 1, reason: "no key supplied" }) });
  assert.equal(bad.status, 400);
  const k = key(), a = await move("buyer", credit.id, "retire", { amount: 1, reason: "Voluntary retirement test" }, k), b = await move("buyer", credit.id, "retire", { amount: 1, reason: "Voluntary retirement test" }, k);
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.body.tx.txHash, b.body.tx.txHash, "the replay returns the original transaction");
});

test("issuance and verification survive crashes at the confirmation boundary and are never applied twice", async () => {
  const a = env.as("admin"), f = env.as("fieldA"), v = env.as("verifier");
  const rec = (await f.post("/api/records", recordBody(P.id, { activityDate: "2026-09-01" }))).body.record;
  await f.upload({ projectId: P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: "2026-09-01" }); await f.post(`/api/records/${rec.id}/submit`); await v.post(`/api/records/${rec.id}/start-review`);
  for (const e of (await v.get(`/api/evidence?recordId=${rec.id}`)).body.evidence) await v.post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" });
  crashAt("after_confirm");
  assert.equal((await v.post(`/api/records/${rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence and measurements are consistent." })).status, 500);
  assert.equal((await db.query("SELECT status FROM monitoring_records WHERE id=$1", [rec.id])).rows[0].status, "UNDER_REVIEW", "registry not yet updated");
  await unlock(); assert.ok((await ops.reconcile()).completed >= 1);
  assert.equal((await db.query("SELECT status FROM monitoring_records WHERE id=$1", [rec.id])).rows[0].status, "VERIFIED");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM verification_records WHERE record_id=$1", [rec.id])).rows[0].n, 1);
  const calc = (await v.post(`/api/records/${rec.id}/carbon-estimate`)).body.calculation;
  await a.post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Approved for issuance." });
  const issuedBefore = (await chain.status()).totalIssued;
  crashAt("after_submit_before_hash");
  assert.equal((await a.post(`/api/carbon/calculations/${calc.id}/issue`)).status, 500);
  assert.equal((await chain.getRecord(bytes32Id("record", rec.uuid))).status, "CREDITED", "credits already issued on-chain");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_credits WHERE record_id=$1", [rec.id])).rows[0].n, 0);
  assert.equal((await a.post(`/api/carbon/calculations/${calc.id}/issue`)).status, 409, "while the crashed worker's claim is still held, a retry is told the operation is in progress");
  await unlock(); // the claim expires
  assert.equal((await a.post(`/api/carbon/calculations/${calc.id}/issue`)).status, 201, "an API retry recovers the operation instead of issuing again");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_credits WHERE record_id=$1", [rec.id])).rows[0].n, 1);
  assert.equal((await chain.status()).totalIssued - issuedBefore, calc.eligible_credits, "supply grew by exactly one issuance");
});
