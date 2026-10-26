// Disputes against issued credit batches: registry hold on transfer and retirement, review workflow, permissions, history, audit.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, projectBody, recordBody, PASSWORD } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");
const chain = require("../src/services/chain");

cfg.rateLimit.max = 1e6; cfg.rateLimit.authMax = 1e6; cfg.scan.policy = "off"; cfg.ipfs.provider = "none";
let env; const S = {};
const count = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);
const admin = () => env.as("admin"), admin2 = () => env.as("admin2"), verifier = () => env.as("verifier"), fieldA = () => env.as("fieldA"), fieldB = () => env.as("fieldB");

async function issueCredit(activityDate) {
  const p = await admin().post("/api/projects", projectBody(env.orgs.a, { name: `Dispute project ${activityDate}` })); assert.equal(p.status, 201, JSON.stringify(p.body));
  const r = await fieldA().post("/api/records", recordBody(p.body.project.id, { activityDate })); assert.equal(r.status, 201, JSON.stringify(r.body));
  const up = await fieldA().upload({ projectId: p.body.project.id, recordId: r.body.record.id, kind: "FIELD_PHOTO", captureDate: activityDate, latitude: 16.9004, longitude: 82.2004 }); assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await fieldA().post(`/api/records/${r.body.record.id}/submit`)).status, 200);
  assert.equal((await verifier().post(`/api/records/${r.body.record.id}/start-review`)).status, 200);
  assert.equal((await verifier().post(`/api/evidence/${up.body.evidence.id}/review`, { decision: "VERIFIED" })).status, 200);
  assert.equal((await verifier().post(`/api/records/${r.body.record.id}/decision`, { decision: "VERIFIED", comments: "Evidence consistent." })).status, 200);
  const calc = (await verifier().post(`/api/records/${r.body.record.id}/carbon-estimate`)).body.calculation;
  assert.equal((await admin().post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Approved for the dispute tests." })).status, 200);
  const iss = await admin().post(`/api/carbon/calculations/${calc.id}/issue`); assert.equal(iss.status, 201, JSON.stringify(iss.body));
  return { credit: iss.body.credit, calc, record: r.body.record };
}
const transfer = (who, creditId, amount = 1, extra = {}) => env.as(who).post(`/api/credits/${creditId}/transfer`, { toOrgId: env.orgs.buyer, amount, ...extra });
const retire = (who, creditId, amount = 1, extra = {}) => env.as(who).post(`/api/credits/${creditId}/retire`, { amount, reason: "Voluntary retirement for the test", ...extra });
const raise = (who, creditId, over = {}) => env.as(who).post(`/api/credits/${creditId}/disputes`, { category: "EVIDENCE", reason: "The evidence photographs appear to show a different site.", ...over });

test.before(async () => {
  env = await setup();
  const hash = (await db.query("SELECT password_hash FROM users WHERE name='admin'")).rows[0].password_hash;
  await db.query("INSERT INTO users (name,email,password_hash,role,organization_id) VALUES ('admin2','admin2@test.invalid',$1,'NCCR_ADMIN',$2)", [hash, env.orgs.nccr]);
  env.tokens.admin2 = (await (await fetch(`${env.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin2@test.invalid", password: PASSWORD }) })).json()).token;
  assert.ok(env.tokens.admin2);
  S.a = await issueCredit("2026-06-01");
  assert.ok(Number(S.a.credit.amount_tonnes) >= 3, `enough credits for the scenarios (got ${S.a.credit.amount_tonnes})`);
});
test.after(async () => { await env.close(); });

test("who may raise a dispute, and what must be provided", async () => {
  const id = S.a.credit.id;
  assert.equal((await env.anon.post(`/api/credits/${id}/disputes`, { category: "EVIDENCE", reason: "Anonymous attempt to dispute." })).status, 401);
  assert.equal((await raise("fieldB", id)).status, 403, "an unrelated organization cannot raise or read disputes on this batch");
  assert.equal((await fieldB().get(`/api/credits/${id}/disputes`)).status, 403);
  assert.equal((await raise("fieldA", 99999)).status, 404);
  for (const [label, body] of [["short reason", { reason: "too short" }], ["no reason", { reason: undefined }], ["bad category", { category: "RUMOUR" }], ["no category", { category: undefined }], ["huge reason", { reason: "x".repeat(2001) }]]) assert.equal((await raise("fieldA", id, body)).status, 400, label);
  assert.equal(await count("SELECT COUNT(*) AS n FROM credit_disputes"), 0, "nothing was created by the rejected requests");
});

test("a dispute holds transfers and retirements through the API, for holders and for administrators acting for them, and creates no blockchain operation", async () => {
  const id = S.a.credit.id;
  const chainBefore = await chain.batchBalance(require("../src/services/common").recordChainId({ uuid: (await db.query("SELECT uuid FROM monitoring_records WHERE id=$1", [S.a.record.id])).rows[0].uuid }), (await db.query("SELECT wallet_address FROM organizations WHERE id=$1", [env.orgs.a])).rows[0].wallet_address);
  const r = await raise("verifier", id, { category: "CALCULATION", reason: "The survival rate used in the assessment looks inconsistent with the photographs." });
  assert.equal(r.status, 201, JSON.stringify(r.body)); S.d1 = r.body.dispute;
  assert.equal(S.d1.status, "OPEN"); assert.match(S.d1.code, /^DSP-\d{4}$/); assert.equal(S.d1.record_id, S.a.record.id); assert.equal(S.d1.calculation_id, S.a.calc.id, "tied to the exact assessment");
  assert.equal(r.body.holdsTransfers, true); assert.match(r.body.note, /does not freeze, cancel or reverse the on-chain token/);
  const ops = await count("SELECT COUNT(*) AS n FROM chain_operations");
  for (const attempt of [() => transfer("fieldA", id), () => retire("fieldA", id), () => transfer("admin", id, 1, { fromOrgId: env.orgs.a }), () => retire("admin", id, 1, { fromOrgId: env.orgs.a })]) {
    const res = await attempt(); assert.equal(res.status, 409, JSON.stringify(res.body)); assert.match(res.body.error, new RegExp(S.d1.code)); assert.match(res.body.error, /on-chain token is not changed/);
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM chain_operations"), ops, "a blocked request starts no blockchain operation");
  assert.equal(await count("SELECT COUNT(*) AS n FROM credit_reservations WHERE credit_id=$1", [id]), 0, "and reserves nothing");
  const detail = await fieldA().get(`/api/credits/${id}`); assert.equal(detail.body.activeDisputes, 1);
  const log = await fieldA().get(`/api/credits/${id}/disputes`); assert.equal(log.body.onHold, true); assert.equal(log.body.disputes[0].events.length, 1);
  assert.equal(await chain.batchBalance(require("../src/services/common").recordChainId({ uuid: (await db.query("SELECT uuid FROM monitoring_records WHERE id=$1", [S.a.record.id])).rows[0].uuid }), (await db.query("SELECT wallet_address FROM organizations WHERE id=$1", [env.orgs.a])).rows[0].wallet_address), chainBefore, "the on-chain balance is untouched");
});

test("review workflow: separation of duties, valid transitions only, mandatory reasons", async () => {
  const id = S.a.credit.id, d = S.d1.id;
  assert.equal((await env.as("verifier").post(`/api/disputes/${d}/start-review`)).status, 403, "verifiers cannot run the review");
  assert.equal((await fieldA().post(`/api/disputes/${d}/start-review`)).status, 403);
  assert.equal((await admin().post(`/api/disputes/${d}/decision`, { decision: "DISMISSED", reason: "Dismissed before any review." })).status, 409, "no decision before the review starts");
  // an administrator who raised a dispute cannot review it
  const own = await raise("admin", id, { category: "OWNERSHIP", reason: "Ownership of the project area is unclear to the administrator." }); assert.equal(own.status, 201);
  assert.equal((await admin().post(`/api/disputes/${own.body.dispute.id}/start-review`)).status, 403, "raiser cannot review their own dispute");
  assert.equal((await admin2().post(`/api/disputes/${own.body.dispute.id}/start-review`)).status, 200);
  assert.equal((await admin().post(`/api/disputes/${own.body.dispute.id}/decision`, { decision: "UPHELD", reason: "Deciding my own dispute." })).status, 403, "nor decide it");
  assert.equal((await admin2().post(`/api/disputes/${own.body.dispute.id}/decision`, { decision: "DISMISSED", reason: "The ownership question was resolved by the register." })).status, 200);
  // the verifier's dispute: start review, then decisions need a valid outcome and a reason
  assert.equal((await admin().post(`/api/disputes/${d}/start-review`)).status, 200);
  assert.equal((await admin().post(`/api/disputes/${d}/start-review`)).status, 409, "cannot start twice");
  assert.equal((await admin().post(`/api/disputes/${d}/decision`, { decision: "UPHELD", reason: "short" })).status, 400);
  assert.equal((await admin().post(`/api/disputes/${d}/decision`, { decision: "MAYBE", reason: "A long enough reason here." })).status, 400);
  assert.equal((await fieldA().post(`/api/disputes/${d}/decision`, { decision: "DISMISSED", reason: "Field user trying to decide." })).status, 403);
  assert.equal((await fieldA().post(`/api/disputes/${d}/withdraw`)).status, 403, "only the person who raised it can withdraw");
  assert.equal((await transfer("fieldA", id)).status, 409, "still held while under review");
});

test("upheld keeps the hold; dismissed and withdrawn release it; released batches transfer and retire again", async () => {
  const id = S.a.credit.id, d = S.d1.id;
  const up = await admin().post(`/api/disputes/${d}/decision`, { decision: "UPHELD", reason: "The survival rate is not supported by the evidence; a remedy is needed." });
  assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.dispute.status, "UPHELD"); assert.equal(up.body.holdsTransfers, true); assert.match(up.body.note, /does not freeze/);
  assert.equal((await transfer("fieldA", id)).status, 409, "upheld keeps the registry hold");
  assert.equal((await admin().post(`/api/disputes/${d}/decision`, { decision: "DISMISSED", reason: "Trying to reverse a final decision." })).status, 409, "a decision is final");
  assert.equal((await fieldA().post(`/api/disputes/${d}/withdraw`)).status, 403); assert.equal((await verifier().post(`/api/disputes/${d}/withdraw`)).status, 409, "an upheld dispute cannot be withdrawn");
  // a second dispute on the same batch, dismissed: the upheld one still holds
  const s2 = await raise("fieldA", id, { category: "OTHER", reason: "Holder asks for a clarification of the assessment basis." }); assert.equal(s2.status, 201);
  assert.equal((await admin().post(`/api/disputes/${s2.body.dispute.id}/start-review`)).status, 200);
  assert.equal((await admin().post(`/api/disputes/${s2.body.dispute.id}/decision`, { decision: "DISMISSED", reason: "The basis is documented in the methodology." })).status, 200);
  assert.equal((await transfer("fieldA", id)).status, 409, "other disputes do not release an upheld one");
  assert.equal((await fieldA().get(`/api/credits/${id}/disputes`)).body.onHold, true);
});

test("a dismissed or withdrawn dispute releases the hold, and an operation then succeeds on the chain", async () => {
  S.b = await issueCredit("2026-06-02"); const id = S.b.credit.id;
  const d = (await raise("verifier", id, { reason: "Possible double counting with an earlier project." })).body.dispute;
  assert.equal((await retire("fieldA", id)).status, 409);
  assert.equal((await verifier().post(`/api/disputes/${d.id}/withdraw`, { reason: "Checked: no overlap found." })).status, 200);
  assert.equal((await fieldA().get(`/api/credits/${id}/disputes`)).body.onHold, false);
  const tr = await transfer("fieldA", id, 1); assert.equal(tr.status, 201, JSON.stringify(tr.body)); assert.ok(tr.body.tx?.blockNumber != null || tr.body.status, "executed on the chain");
  const d2 = (await raise("fieldA", id, { category: "EVIDENCE", reason: "A second concern about the evidence set." })).body.dispute;
  assert.equal((await transfer("fieldA", id, 1)).status, 409, "a new dispute holds again");
  assert.equal((await admin().post(`/api/disputes/${d2.id}/start-review`)).status, 200);
  assert.equal((await admin().post(`/api/disputes/${d2.id}/decision`, { decision: "DISMISSED", reason: "Concern addressed by the reviewer." })).status, 200);
  assert.equal((await retire("fieldA", id, 1)).status, 201, "released after dismissal");
});

test("history and audit: every step names the actor, the reason, the record and the assessment, and cannot be rewritten", async () => {
  const log = (await verifier().get(`/api/credits/${S.a.credit.id}/disputes`)).body;
  const first = log.disputes.find((x) => x.id === S.d1.id);
  assert.deepEqual(first.events.map((e) => [e.event_type, e.from_status, e.to_status]), [["RAISED", null, "OPEN"], ["REVIEW_STARTED", "OPEN", "UNDER_REVIEW"], ["UPHELD", "UNDER_REVIEW", "UPHELD"]]);
  assert.deepEqual(first.events.map((e) => e.actor_name), ["verifier", "admin", "admin"]);
  assert.ok(first.events.every((e) => !Number.isNaN(Date.parse(e.created_at))) && first.events[0].note.includes("survival rate")); assert.ok(first.events[2].note.includes("remedy"));
  const au = (await db.query("SELECT action, actor_id, details, record_id, new_status FROM audit_logs WHERE action LIKE 'CREDIT_DISPUTE_%' AND entity_id=$1 ORDER BY id", [S.d1.id])).rows;
  assert.deepEqual(au.map((a) => a.action), ["CREDIT_DISPUTE_RAISED", "CREDIT_DISPUTE_REVIEW_STARTED", "CREDIT_DISPUTE_UPHELD"]);
  assert.ok(au.every((a) => a.record_id === S.a.record.id && a.details.calculationId === S.a.calc.id && a.details.code === S.d1.code && a.details.creditId === S.a.credit.id));
  assert.equal(au[0].actor_id, env.users.verifier); assert.equal(au[2].actor_id, env.users.admin); assert.equal(au[2].new_status, "UPHELD");
  assert.ok(au[2].details.reason.includes("remedy"));
  const chainCheck = await require("../src/services/audit").verifyChain(); assert.equal(chainCheck.ok, true, "the audit hash chain still verifies");
  await assert.rejects(db.query("UPDATE credit_dispute_events SET note='edited' WHERE dispute_id=$1", [S.d1.id]), /append-only/);
  await assert.rejects(db.query("DELETE FROM credit_dispute_events WHERE dispute_id=$1", [S.d1.id]), /append-only/);
  await assert.rejects(db.query("DELETE FROM credit_disputes WHERE id=$1", [S.d1.id]), /cannot be deleted/);
  await assert.rejects(db.query("UPDATE credit_disputes SET reason='rewritten later on' WHERE id=$1", [S.d1.id]), /cannot be changed/);
  await assert.rejects(db.query("UPDATE credit_disputes SET status='DISMISSED' WHERE id=$1", [S.d1.id]), /invalid dispute status change UPHELD -> DISMISSED/);
  const dismissed = (await db.query("SELECT id FROM credit_disputes WHERE status='DISMISSED' LIMIT 1")).rows[0]; assert.ok(dismissed, "a dismissed dispute exists");
  await assert.rejects(db.query("UPDATE credit_disputes SET status='UPHELD' WHERE id=$1", [dismissed.id]), /invalid dispute status change DISMISSED -> UPHELD/);
  const open = await raise("fieldA", S.b.credit.id, { reason: "Another open dispute to test a skipped step." });
  await assert.rejects(db.query("UPDATE credit_disputes SET status='UPHELD' WHERE id=$1", [open.body.dispute.id]), /invalid dispute status change OPEN -> UPHELD/, "review cannot be skipped even by direct SQL");
});

test("queues, visibility and notifications", async () => {
  const all = await admin().get("/api/disputes"); assert.equal(all.status, 200); assert.ok(all.body.disputes.length >= 4); assert.match(all.body.note, /registry control/);
  assert.ok((await admin().get("/api/disputes?status=UPHELD")).body.disputes.every((d) => d.status === "UPHELD"));
  assert.ok((await admin().get("/api/disputes?category=OWNERSHIP")).body.disputes.every((d) => d.category === "OWNERSHIP"));
  const mine = await fieldA().get("/api/disputes"); assert.ok(mine.body.disputes.length > 0); assert.ok(mine.body.disputes.every((d) => d.credit_id === S.a.credit.id || d.credit_id === S.b.credit.id));
  assert.equal((await fieldB().get("/api/disputes")).body.disputes.length, 0, "an unrelated organization sees none");
  assert.ok(await count("SELECT COUNT(*) AS n FROM notifications WHERE type='CREDIT_DISPUTE_RAISED' AND user_id=$1", [env.users.admin]) >= 2, "administrators are told when a dispute is raised");
  assert.ok(await count("SELECT COUNT(*) AS n FROM notifications WHERE type='CREDIT_DISPUTE_UPHELD' AND user_id=$1", [env.users.verifier]) >= 1, "the person who raised it hears the outcome");
});

test("upheld dispute can lead to on-chain cancellation of credits, reducing circulating supply", async () => {
  const id = S.a.credit.id;
  const balanceBefore = Number((await db.query("SELECT balance FROM credit_balances WHERE credit_id=$1 AND org_id=$2", [id, env.orgs.a])).rows[0].balance);
  assert.ok(balanceBefore >= 1);
  const cancelRes = await admin().post(`/api/credits/${id}/cancel`, {
    holderOrgId: env.orgs.a,
    amount: 1,
    reason: "Upheld dispute DSP-0001: 1 credit cancelled",
    disputeId: S.d1.id
  });
  assert.equal(cancelRes.status, 201, JSON.stringify(cancelRes.body));
  assert.equal(cancelRes.body.cancelledAmount, 1);
  assert.ok(cancelRes.body.tx?.txHash || cancelRes.body.ref);

  const balanceAfter = Number((await db.query("SELECT balance FROM credit_balances WHERE credit_id=$1 AND org_id=$2", [id, env.orgs.a])).rows[0].balance);
  assert.equal(balanceAfter, balanceBefore - 1);

  const cred = (await db.query("SELECT cancelled_tonnes FROM carbon_credits WHERE id=$1", [id])).rows[0];
  assert.equal(Number(cred.cancelled_tonnes), 1);

  const cancRecord = (await db.query("SELECT * FROM credit_cancellations WHERE credit_id=$1", [id])).rows[0];
  assert.equal(Number(cancRecord.amount), 1);
  assert.equal(cancRecord.dispute_id, S.d1.id);
});
