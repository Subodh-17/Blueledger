// End-to-end lifecycle test against real PostgreSQL and a real (local Hardhat) EVM chain.
// CREATE PROJECT -> SUBMIT FIELD DATA -> ADD EVIDENCE -> MRV REVIEW -> VERIFY -> CALCULATE CARBON
//   -> NCCR APPROVE -> ISSUE TOKENIZED CREDIT -> BLOCKCHAIN RECORD -> AUDIT TRAIL
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, projectBody, recordBody } = require("./helpers");
const chain = require("../src/services/chain");
const db = require("../src/db");
const { bytes32Id } = require("../src/utils/hash");

let env, S = {};
let baseIssued = 0;
test.before(async () => { env = await setup(); baseIssued = (await chain.status()).totalIssued; });
test.after(async () => { await env.close(); });

const admin = () => env.as("admin"), verifier = () => env.as("verifier"), fieldA = () => env.as("fieldA");

test("1. NCCR admin creates a project; other roles cannot", async () => {
  assert.equal((await fieldA().post("/api/projects", projectBody(env.orgs.a))).status, 403);
  assert.equal((await verifier().post("/api/projects", projectBody(env.orgs.a))).status, 403);
  assert.equal((await env.anon.post("/api/projects", projectBody(env.orgs.a))).status, 401);
  const r = await admin().post("/api/projects", projectBody(env.orgs.a));
  assert.equal(r.status, 201);
  assert.match(r.body.project.code, /^BCP-/);
  S.project = r.body.project;
  const list = await fieldA().get("/api/projects");
  assert.equal(list.body.projects.length, 1);
  assert.equal((await env.as("fieldB").get("/api/projects")).body.projects.length, 0, "other org sees nothing");
  assert.equal((await env.as("fieldB").get(`/api/projects/${S.project.id}`)).status, 403);
});

test("2. field user saves a DRAFT, attaches photo + drone evidence", async () => {
  assert.equal((await verifier().post("/api/records", recordBody(S.project.id))).status, 403, "verifier cannot submit field data");
  assert.equal((await env.as("fieldB").post("/api/records", recordBody(S.project.id))).status, 403, "other org blocked");
  const r = await fieldA().post("/api/records", recordBody(S.project.id));
  assert.equal(r.status, 201);
  assert.equal(r.body.record.status, "DRAFT");
  S.rec = r.body.record;
  const photo = await fieldA().upload({ projectId: S.project.id, recordId: S.rec.id, kind: "FIELD_PHOTO", captureDate: "2026-06-01", latitude: 16.9004, longitude: 82.2004 });
  assert.equal(photo.status, 201);
  assert.match(photo.body.evidence.sha256, /^[0-9a-f]{64}$/);
  assert.equal(photo.body.evidence.ipfs_cid, null, "no fake CID is invented when IPFS is not configured");
  assert.equal(photo.body.evidence.processing_status, "HASHED");
  const drone = await fieldA().upload({ projectId: S.project.id, recordId: S.rec.id, kind: "DRONE_IMAGERY", captureDate: "2026-06-01", platform: "Demo quadcopter (synthetic)", altitudeM: 80 });
  assert.equal(drone.status, 201);
  S.photo = photo.body.evidence; S.drone = drone.body.evidence;
});

test("3. submission: report generated, hashes computed, anchored on-chain", async () => {
  const r = await fieldA().post(`/api/records/${S.rec.id}/submit`);
  assert.equal(r.status, 200);
  assert.equal(r.body.record.status, "SUBMITTED");
  assert.equal(r.body.record.anchored, true);
  assert.match(r.body.record.content_hash, /^0x[0-9a-f]{64}$/);
  assert.ok(r.body.record.report.indicators.evidenceCount === 2);
  assert.equal((await fieldA().post(`/api/records/${S.rec.id}/submit`)).status, 409, "cannot submit twice");
  assert.equal((await fieldA().put(`/api/records/${S.rec.id}`, recordBody(S.project.id))).status, 409, "submitted records are immutable");
  const onChain = await chain.getRecord(bytes32Id("record", S.rec.uuid));
  assert.equal(onChain.status, "ANCHORED");
  assert.equal(onChain.contentHash, r.body.record.content_hash);
  const reg = (await db.query("SELECT chain_registered FROM projects WHERE id=$1", [S.project.id])).rows[0];
  assert.equal(reg.chain_registered, true);
});

test("4. MRV review: state machine, evidence review, blocking checks", async () => {
  assert.equal((await verifier().post(`/api/records/${S.rec.id}/decision`, { decision: "VERIFIED" })).status, 409, "must start review first");
  assert.equal((await fieldA().post(`/api/records/${S.rec.id}/start-review`)).status, 403);
  assert.equal((await verifier().post(`/api/records/${S.rec.id}/start-review`)).status, 200);
  const blocked = await verifier().post(`/api/records/${S.rec.id}/decision`, { decision: "VERIFIED", comments: "Looks fine to me." });
  assert.equal(blocked.status, 422, "cannot verify with unreviewed evidence");
  assert.ok(blocked.body.details.failed.some((f) => f.id === "evidence_reviewed"));
  assert.equal((await verifier().post(`/api/evidence/${S.photo.id}/review`, { decision: "REJECTED" })).status, 400, "notes required when not accepting");
  assert.equal((await verifier().post(`/api/evidence/${S.photo.id}/review`, { decision: "VERIFIED" })).status, 200);
  const md = await verifier().post(`/api/evidence/${S.drone.id}/extract-metadata`);
  assert.equal(md.status, 200);
  assert.equal(md.body.metadata.width, 1, "image dimensions are read from the file itself");
  assert.equal((await fieldA().post(`/api/evidence/${S.drone.id}/extract-metadata`)).status, 403);
  assert.equal((await verifier().post(`/api/evidence/${S.drone.id}/review`, { decision: "VERIFIED" })).status, 200);
});

test("5. verification decision is recorded on-chain and audited", async () => {
  assert.equal((await verifier().post(`/api/records/${S.rec.id}/decision`, { decision: "MAYBE" })).status, 400);
  const d = await verifier().post(`/api/records/${S.rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence and measurements consistent." });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.record.status, "VERIFIED");
  assert.match(d.body.tx.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(d.body.checks.filter((c) => c.blocking && !c.passed).length, 0);
  assert.equal((await chain.getRecord(bytes32Id("record", S.rec.uuid))).status, "VERIFIED");
  assert.equal((await verifier().post(`/api/records/${S.rec.id}/decision`, { decision: "VERIFIED" })).status, 409, "decision is final");
  const detail = await admin().get(`/api/projects/${S.project.id}`);
  assert.equal(detail.body.project.verification_status, "VERIFIED");
  assert.equal(detail.body.verifications.length, 1);
});

test("6. carbon estimate: transparent inputs, assumptions, version, timestamp", async () => {
  assert.equal((await fieldA().post(`/api/records/${S.rec.id}/carbon-estimate`)).status, 403);
  const c = await verifier().post(`/api/records/${S.rec.id}/carbon-estimate`);
  assert.equal(c.status, 201);
  const calc = c.body.calculation;
  assert.equal(calc.methodology_version, "ILLUSTRATIVE-BC-v1");
  assert.equal(calc.inputs.habitat, "MANGROVE");
  assert.equal(calc.inputs.survivalRatePct, 80);
  assert.equal(calc.inputs.periodStart, "2020-01-01", "the first assessed period starts at the project start date");
  assert.equal(calc.period_end.slice(0, 10), "2026-06-01");
  assert.ok(calc.assumptions.parametersUsed.length >= 3 && calc.calculated_at && calc.methodology_hash);
  assert.ok(calc.eligible_credits >= 1);
  assert.equal(calc.approval_status, "PENDING");
  S.calc = calc;
  // recalculation supersedes, never duplicates
  const again = await admin().post(`/api/records/${S.rec.id}/carbon-estimate`);
  assert.equal(again.status, 201);
  S.calc = again.body.calculation;
  const cur = await db.query("SELECT COUNT(*)::int AS n FROM carbon_calculations WHERE record_id=$1 AND is_current", [S.rec.id]);
  assert.equal(cur.rows[0].n, 1);
});

test("7. NCCR approval gates issuance; only admin approves/issues", async () => {
  const issueBefore = await admin().post(`/api/carbon/calculations/${S.calc.id}/issue`);
  assert.equal(issueBefore.status, 409, "no issuance before approval");
  assert.equal((await verifier().post(`/api/carbon/calculations/${S.calc.id}/approve`, { decision: "APPROVED" })).status, 403);
  assert.equal((await fieldA().post(`/api/carbon/calculations/${S.calc.id}/issue`)).status, 403);
  assert.equal((await verifier().post(`/api/carbon/calculations/${S.calc.id}/issue`)).status, 403);
  assert.equal((await admin().post(`/api/carbon/calculations/${S.calc.id}/approve`, { decision: "REJECTED" })).status, 400, "rejection needs notes");
  const ap = await admin().post(`/api/carbon/calculations/${S.calc.id}/approve`, { decision: "APPROVED", notes: "Approved for demonstration issuance." });
  assert.equal(ap.status, 200);
  assert.equal((await admin().post(`/api/carbon/calculations/${S.calc.id}/approve`, { decision: "APPROVED" })).status, 409);
});

test("8. credit issuance on-chain; duplicate issuance blocked in API and contract", async () => {
  const r = await admin().post(`/api/carbon/calculations/${S.calc.id}/issue`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.credit = r.body.credit;
  assert.equal(S.credit.credit_label, "Registry Credit");
  assert.match(S.credit.batch_code, /^CB-\d{5}$/);
  assert.equal(Number(S.credit.amount_tonnes), S.calc.eligible_credits);
  assert.match(r.body.tx.txHash, /^0x[0-9a-f]{64}$/);
  const onChain = await chain.getRecord(bytes32Id("record", S.rec.uuid));
  assert.equal(onChain.status, "CREDITED");
  assert.equal(onChain.creditQuantity, S.calc.eligible_credits);
  assert.equal(await chain.batchBalance(bytes32Id("record", S.rec.uuid), env.accounts[4]), S.calc.eligible_credits);

  assert.equal((await admin().post(`/api/carbon/calculations/${S.calc.id}/issue`)).status, 409, "API duplicate blocked");
  await assert.rejects(chain.issueCredits(bytes32Id("record", S.rec.uuid), 1, "0x" + "11".repeat(32), env.accounts[4]), /already issued/i, "contract duplicate blocked");
  const n = await db.query("SELECT COUNT(*)::int AS n FROM carbon_credits WHERE record_id=$1", [S.rec.id]);
  assert.equal(n.rows[0].n, 1);
  assert.equal((await admin().post(`/api/records/${S.rec.id}/carbon-estimate`)).status, 409, "no re-estimate after issuance");
  const proj = (await admin().get(`/api/projects/${S.project.id}`)).body;
  assert.equal(proj.project.credit_status, "ISSUED");
});

test("9. ownership, transfer and retirement are enforced and traceable", async () => {
  const qty = Number(S.credit.amount_tonnes);
  const cid = S.credit.id;
  assert.equal((await env.as("fieldB").post(`/api/credits/${cid}/transfer`, { toOrgId: env.orgs.buyer, amount: 1 })).status, 409, "non-holder cannot transfer");
  assert.equal((await fieldA().post(`/api/credits/${cid}/transfer`, { toOrgId: env.orgs.buyer, amount: qty + 1 })).status, 409, "cannot exceed balance");
  assert.equal((await fieldA().post(`/api/credits/${cid}/transfer`, { toOrgId: env.orgs.buyer, amount: 0 })).status, 400);
  const t = await fieldA().post(`/api/credits/${cid}/transfer`, { toOrgId: env.orgs.buyer, amount: 5 });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const rt = await env.as("buyer").post(`/api/credits/${cid}/retire`, { amount: 2, reason: "Demo retirement for test" });
  assert.equal(rt.status, 201, JSON.stringify(rt.body));
  assert.equal((await env.as("buyer").post(`/api/credits/${cid}/retire`, { amount: 99, reason: "too many credits" })).status, 409);
  const d = (await admin().get(`/api/credits/${cid}`)).body;
  assert.deepEqual(d.events.map((e) => e.event_type), ["ISSUED", "TRANSFERRED", "RETIRED"]);
  const byOrg = Object.fromEntries(d.balances.map((b) => [b.name, b]));
  assert.equal(byOrg["Test NGO A"].balance, qty - 5);
  assert.equal(byOrg["Test Buyer"].balance, 3);
  for (const b of d.balances) assert.equal(b.onChainBalance, b.balance, "database mirror equals on-chain balance");
  assert.equal(d.credit.retired_tonnes, "2.00");
  assert.equal(d.credit.status, "PARTIALLY_RETIRED");
});

test("10. blockchain registry + public verification are consistent", async () => {
  const tx = (await admin().get(`/api/chain/transactions?projectId=${S.project.id}`)).body.transactions;
  const types = tx.map((t) => t.tx_type).reverse();
  assert.deepEqual(types.slice(0, 5), ["PROJECT_REGISTERED", "RECORD_ANCHORED", "VERIFICATION_RECORDED", "CREDITS_ISSUED", "CREDITS_TRANSFERRED"]);
  assert.ok(tx.every((t) => /^0x[0-9a-f]{64}$/.test(t.tx_hash) && t.block_num >= 0 && t.status === "CONFIRMED"));
  const st0 = (await env.anon.get("/api/chain/status")).body;
  const pub = await env.anon.get(`/api/public/verify/${S.rec.code}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.consistent, true);
  assert.equal(pub.body.onChain.status, "CREDITED");
  const reg = (await env.anon.get("/api/public/registry")).body;
  assert.match(reg.disclaimer, /not accredited/);
  assert.equal(reg.credits.length, 1);
  assert.ok(!JSON.stringify(reg).includes("@test.invalid"), "public registry exposes no user data");
  assert.equal((await env.anon.get("/api/public/verify/NOPE")).status, 404);
  const byBatch = (await env.anon.get(`/api/public/verify/${S.credit.batch_code}`)).body;
  assert.equal(byBatch.code, S.rec.code);
  assert.equal(byBatch.credit.quantity, Number(S.credit.amount_tonnes));
  assert.equal(byBatch.network.chainId, st0.chainId);
  assert.deepEqual(byBatch.events.map((e) => e.event_type), ["ISSUED", "TRANSFERRED", "RETIRED"]);
  const st = (await env.anon.get("/api/chain/status")).body;
  assert.equal(st.ready, true);
  assert.equal(st.totalIssued - baseIssued, Number(S.credit.amount_tonnes), "on-chain supply grew by exactly this issuance");
});

test("11. tampering with a stored record is detected by public verification", async () => {
  await db.query("UPDATE monitoring_records SET observations='tampered after anchoring' WHERE id=$1", [S.rec.id]);
  const pub = await env.anon.get(`/api/public/verify/${S.rec.code}`);
  assert.equal(pub.body.checks.storedMatchesRecomputed, false);
  assert.equal(pub.body.consistent, false);
  await db.query("UPDATE monitoring_records SET observations=$1 WHERE id=$2", [recordBody(0).observations, S.rec.id]);
  assert.equal((await env.anon.get(`/api/public/verify/${S.rec.code}`)).body.consistent, true);
});

test("12. audit trail covers the lifecycle with actor, role, status change and tx hash", async () => {
  const a = (await admin().get(`/api/audit?recordId=${S.rec.id}&limit=200`)).body.entries.reverse();
  const actions = a.map((e) => e.action);
  for (const x of ["RECORD_CREATED", "EVIDENCE_UPLOADED", "RECORD_SUBMITTED", "RECORD_ANCHORED", "REVIEW_STARTED", "EVIDENCE_REVIEWED", "RECORD_VERIFIED", "CARBON_CALCULATED", "NCCR_APPROVED", "CREDITS_ISSUED", "CREDITS_TRANSFERRED", "CREDITS_RETIRED"])
    assert.ok(actions.includes(x), `audit contains ${x}`);
  const ver = a.find((e) => e.action === "RECORD_VERIFIED");
  assert.equal(ver.actor_role, "VERIFIER");
  assert.equal(ver.previous_status, "UNDER_REVIEW");
  assert.equal(ver.new_status, "VERIFIED");
  assert.match(ver.tx_hash, /^0x[0-9a-f]{64}$/);
  assert.ok(ver.created_at);
  assert.equal((await fieldA().get("/api/audit")).status, 403, "field users cannot read the global audit log");
  const v = (await admin().get("/api/audit/verify")).body;
  assert.equal(v.ok, true);
  assert.ok(v.entries >= actions.length);
});

test("13. NEEDS_REVISION loop: revise, resubmit, re-anchor, verify", async () => {
  const mk = async () => {
    const r = await fieldA().post("/api/records", recordBody(S.project.id, { activityDate: "2026-07-01", areaHa: 30 }));
    await fieldA().upload({ projectId: S.project.id, recordId: r.body.record.id, kind: "FIELD_PHOTO", captureDate: "2026-07-01" });
    await fieldA().post(`/api/records/${r.body.record.id}/submit`);
    await verifier().post(`/api/records/${r.body.record.id}/start-review`);
    return r.body.record;
  };
  const rec = await mk();
  assert.equal((await verifier().post(`/api/records/${rec.id}/decision`, { decision: "NEEDS_REVISION" })).status, 400, "comments required");
  const nr = await verifier().post(`/api/records/${rec.id}/decision`, { decision: "NEEDS_REVISION", comments: "Please add canopy transect photo." });
  assert.equal(nr.body.record.status, "NEEDS_REVISION");
  assert.equal((await chain.getRecord(bytes32Id("record", rec.uuid))).status, "NEEDS_REVISION");
  const upd = await fieldA().put(`/api/records/${rec.id}`, recordBody(S.project.id, { activityDate: "2026-07-01", areaHa: 31, observations: "Revised: added transect photo and corrected plot area." }));
  assert.equal(upd.status, 200);
  await fieldA().upload({ projectId: S.project.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: "2026-07-01" });
  const re = await fieldA().post(`/api/records/${rec.id}/submit`);
  assert.equal(re.body.record.revision, 2);
  assert.equal(re.body.record.status, "SUBMITTED");
  assert.equal((await chain.getRecord(bytes32Id("record", rec.uuid))).revision, 2);
  await verifier().post(`/api/records/${rec.id}/start-review`);
  const det = (await verifier().get(`/api/records/${rec.id}`)).body;
  for (const e of det.evidence) assert.equal(e.verification_status, "PENDING", "evidence is re-reviewed after revision");
  for (const e of det.evidence) await verifier().post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" });
  const ok = await verifier().post(`/api/records/${rec.id}/decision`, { decision: "VERIFIED", comments: "Revision accepted." });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // second estimate for same project deducts credits already issued (incremental, no double counting)
  const c2 = (await verifier().post(`/api/records/${rec.id}/carbon-estimate`)).body.calculation;
  assert.equal(c2.period_start.slice(0, 10), "2026-06-01", "the next assessment starts where the issued one ended (no period is counted twice)");
  assert.equal(c2.inputs.periodStart, "2026-06-01");
  assert.ok(c2.result.centralTCO2e > 0 && c2.result.periodYears < 0.1);
});

test("14. REJECTED is terminal and yields no credits", async () => {
  const r = await fieldA().post("/api/records", recordBody(S.project.id, { activityDate: "2026-08-01" }));
  await fieldA().upload({ projectId: S.project.id, recordId: r.body.record.id, kind: "FIELD_PHOTO", captureDate: "2026-08-01" });
  await fieldA().post(`/api/records/${r.body.record.id}/submit`);
  await verifier().post(`/api/records/${r.body.record.id}/start-review`);
  const d = await verifier().post(`/api/records/${r.body.record.id}/decision`, { decision: "REJECTED", comments: "Photos do not match claimed plot." });
  assert.equal(d.body.record.status, "REJECTED");
  assert.equal((await fieldA().post(`/api/records/${r.body.record.id}/submit`)).status, 409);
  assert.equal((await verifier().post(`/api/records/${r.body.record.id}/carbon-estimate`)).status, 409);
  assert.equal((await env.anon.get(`/api/public/verify/${r.body.record.code}`)).body.onChain.status, "REJECTED");
});
