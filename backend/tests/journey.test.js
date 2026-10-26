// End-to-end journey, from organization onboarding to NCCR reporting, against the real API, PostgreSQL, evidence storage and a local chain.
// Steps run in order and share state. Every actor is a distinct user; each stage also proves that the wrong actor is refused.
// All records are labelled illustrative sample data; the estimates use placeholder parameters and are not carbon accounting.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { setup, projectBody, recordBody, uniquePng } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");
const chain = require("../src/services/chain");
const ops = require("../src/services/chainOps");
const consistency = require("../src/services/consistency");
const audit = require("../src/services/audit");
const C = require("../src/services/common");

cfg.rateLimit.max = 1e6; cfg.rateLimit.authMax = 1e6; cfg.scan.policy = "off"; cfg.ipfs.provider = "none";
let env; const S = {};
const COLLECTOR = { name: "Journey Collector", email: "journey.collector@example.org", password: "Tidal-Marsh-Heron-Quartz-84!" };
const BOUNDARY = { type: "Polygon", coordinates: [[[82.15, 16.85], [82.25, 16.85], [82.25, 16.95], [82.15, 16.95], [82.15, 16.85]]] };
const admin = () => env.as("admin"), verifier = () => env.as("verifier"), collector = () => env.as("collector"), outsider = () => env.as("fieldB");
const count = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);
const login = async (email, password) => (await (await fetch(`${env.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) })).json()).token;
const geoUpload = async (who, path, fields, buf, name = "survey.geojson") => {
  const form = new FormData(); for (const [k, v] of Object.entries(fields)) form.append(k, String(v)); form.append("file", new Blob([buf]), name);
  const res = await fetch(`${env.base}/api${path}`, { method: "POST", headers: { authorization: `Bearer ${env.tokens[who]}` }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const geojson = (...pts) => Buffer.from(JSON.stringify({ type: "FeatureCollection", features: pts.map(([lon, lat, props]) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } })) }));
const unlock = () => db.query("UPDATE chain_operations SET locked_until=NULL");
const onChain = (rec) => chain.getRecord(C.recordChainId(rec));

async function verifiedRecord(date, { areaHa = 30, species = true } = {}) {
  const r = await collector().post("/api/records", recordBody(S.project.id, { activityDate: date, areaHa, observations: `Journey survey on ${date}: planting plots checked on foot, healthy propagules.`, measurements: { survival_rate_pct: 80, avg_height_cm: 210, canopy_cover_pct: 55, seedlings_planted: 100 } }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rec = r.body.record;
  if (species) assert.equal((await collector().put(`/api/records/${rec.id}/species`, { species: [{ name: "Rhizophora mucronata", plantedCount: 70 }, { name: "Avicennia marina", plantedCount: 30 }] })).status, 200);
  const up = await collector().upload({ projectId: S.project.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: date, latitude: 16.9004, longitude: 82.2004 }); assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await collector().post(`/api/records/${rec.id}/submit`)).status, 200);
  return { rec, evidence: up.body.evidence };
}
const reviewAndVerify = async (x, decision = "VERIFIED", comments = "Evidence and measurements are consistent.") => {
  assert.equal((await verifier().post(`/api/records/${x.rec.id}/start-review`)).status, 200);
  if (decision === "VERIFIED") assert.equal((await verifier().post(`/api/evidence/${x.evidence.id}/review`, { decision: "VERIFIED" })).status, 200);
  return verifier().post(`/api/records/${x.rec.id}/decision`, { decision, comments });
};

test.before(async () => { env = await setup(); });
test.after(async () => { await env.close(); });

test("1. onboarding: only an administrator registers organizations and projects; a self-registered collector has no access until attached", async () => {
  for (const who of ["fieldA", "verifier"]) assert.equal((await env.as(who).post("/api/organizations", { name: "Rogue Organization", orgType: "NGO" })).status, 403, `${who} cannot create organizations`);
  assert.equal((await env.anon.post("/api/organizations", { name: "Rogue Organization", orgType: "NGO" })).status, 401);
  const org = await admin().post("/api/organizations", { name: "Journey Community Trust", orgType: "COMMUNITY", walletAddress: env.accounts[7] }); assert.equal(org.status, 201, JSON.stringify(org.body));
  S.org = org.body.organization || org.body; assert.ok(S.org.id);
  const reg = await env.anon.post("/api/auth/register", COLLECTOR); assert.equal(reg.status, 201, JSON.stringify(reg.body));
  S.collectorId = reg.body.user.id; assert.equal(reg.body.user.role, "FIELD_USER"); env.tokens.collector = reg.body.token;
  S.project = (await admin().post("/api/projects", projectBody(S.org.id, { name: "Journey Mangrove Restoration (sample data)", region: "Journey Estuary", geometry: BOUNDARY }))).body.project;
  assert.ok(S.project?.id, "project registered"); assert.equal(S.project.data_origin, "ILLUSTRATIVE", "sample data is labelled as such");
  // unaffiliated: no access to the organization's project
  assert.equal((await collector().post("/api/records", recordBody(S.project.id))).status, 403, "an unaffiliated user cannot submit for the project");
  // privilege escalation attempts
  assert.equal((await collector().patch(`/api/users/${S.collectorId}`, { role: "NCCR_ADMIN" })).status, 403, "no self-promotion");
  assert.equal((await collector().patch(`/api/users/${S.collectorId}`, { organizationId: S.org.id })).status, 403, "no self-attachment to an organization");
  assert.equal((await collector().post("/api/projects", projectBody(S.org.id))).status, 403);
  assert.equal((await collector().post("/api/organizations", { name: "Self Made Organization", orgType: "NGO" })).status, 403);
  assert.equal((await verifier().patch(`/api/users/${S.collectorId}`, { role: "VERIFIER" })).status, 403, "verifiers cannot assign roles either");
  // the administrator attaches the collector
  assert.equal((await admin().patch(`/api/users/${S.collectorId}`, { organizationId: S.org.id })).status, 200);
  assert.equal((await outsider().post("/api/records", recordBody(S.project.id))).status, 403, "another organization's collector is refused");
  assert.equal(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('ORGANIZATION_CREATED','USER_REGISTERED','USER_UPDATED')"), 3, "onboarding steps are audited");
});

test("2. field submission: invalid input, duplicates and bad evidence are refused; valid evidence keeps its provenance", async () => {
  const bad = (over) => collector().post("/api/records", recordBody(S.project.id, over));
  assert.equal((await bad({ latitude: 95 })).status, 400, "latitude out of range"); assert.equal((await bad({ longitude: 200 })).status, 400, "longitude out of range");
  assert.equal((await bad({ activityDate: "2999-01-01" })).status, 400, "future activity date"); assert.equal((await bad({ areaHa: 0 })).status, 400, "zero area");
  const first = await collector().post("/api/records", recordBody(S.project.id, { activityDate: "2026-06-01", clientRef: "journey-offline-0001", areaHa: 30 })); assert.equal(first.status, 201);
  const again = await collector().post("/api/records", recordBody(S.project.id, { activityDate: "2026-06-01", clientRef: "journey-offline-0001", areaHa: 30 }));
  assert.equal(again.body.record.id, first.body.record.id, "a repeated client reference returns the same record"); assert.equal(await count("SELECT COUNT(*) AS n FROM monitoring_records WHERE client_ref='journey-offline-0001'"), 1);
  S.A = { rec: first.body.record };
  assert.equal((await collector().put(`/api/records/${S.A.rec.id}/species`, { species: [{ name: "Rhizophora mucronata", plantedCount: 70 }, { name: "Avicennia marina", plantedCount: 30 }] })).status, 200);
  // evidence refused: wrong type, content that does not match the extension, nothing attached
  const upload = (buf, name, extra = {}) => collector().upload({ projectId: S.project.id, recordId: S.A.rec.id, kind: "FIELD_PHOTO", captureDate: "2026-06-01", latitude: 16.9004, longitude: 82.2004, ...extra }, buf, name);
  const filesBefore = fs.readdirSync(cfg.uploadDir).length, rowsBefore = await count("SELECT COUNT(*) AS n FROM evidence");
  assert.equal((await upload(Buffer.from("MZ not an image"), "photo.exe")).status, 400, "unsupported file type");
  assert.equal((await upload(Buffer.from("this is text, not a PNG"), "photo.png")).status, 400, "content does not match the extension");
  assert.equal((await collector().upload({ projectId: S.project.id, recordId: S.A.rec.id, kind: "FIELD_PHOTO" }, null)).status, 400, "no file");
  assert.equal((await outsider().upload({ projectId: S.project.id, recordId: S.A.rec.id, kind: "FIELD_PHOTO" })).status, 403, "another organization cannot attach evidence");
  assert.equal(await count("SELECT COUNT(*) AS n FROM evidence"), rowsBefore, "refused uploads leave no evidence row"); assert.equal(fs.readdirSync(cfg.uploadDir).length, filesBefore, "and no stored file");
  // valid evidence, hash and provenance
  const png = uniquePng(), ok = await upload(png, "plot-1.png"); assert.equal(ok.status, 201, JSON.stringify(ok.body)); S.A.photo = ok.body.evidence;
  const sha = crypto.createHash("sha256").update(png).digest("hex"); assert.equal(S.A.photo.sha256, sha);
  const row = (await db.query("SELECT * FROM evidence WHERE id=$1", [S.A.photo.id])).rows[0];
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(`${cfg.uploadDir}/${row.storage_uri}`)).digest("hex"), sha, "stored bytes match the recorded digest");
  assert.equal((await upload(png, "plot-1-copy.png")).status, 409, "the same file cannot be registered twice for a project");
  await assert.rejects(db.query("UPDATE evidence SET sha256='00' WHERE id=$1", [row.id]), /immutable/, "the recorded digest cannot be rewritten");
  // geospatial file: dry run, a file outside the boundary is refused, a valid file is imported
  const fields = { projectId: S.project.id, recordId: S.A.rec.id, source: "DRONE_PRODUCT", tool: "SampleProcessor", toolVersion: "0.1 (sample)" };
  assert.equal((await geoUpload("collector", "/geospatial/import", fields, geojson([83.9, 16.9, { species: "Rhizophora mucronata", count: 70 }]))).status, 422, "point outside the project boundary");
  assert.equal((await geoUpload("collector", "/geospatial/import", fields, geojson([82.2, 95, {}]))).status, 422, "invalid coordinates");
  assert.equal((await geoUpload("collector", "/geospatial/import", fields, Buffer.from("{ not json"))).status, 422, "malformed file");
  const geo = await geoUpload("collector", "/geospatial/import", fields, geojson([82.2, 16.9, { species: "Rhizophora mucronata", count: 70, observedAt: "2026-06-01" }, ], [82.21, 16.91, { species: "Avicennia marina", count: 30, observedAt: "2026-06-01" }]));
  assert.equal(geo.status, 201, JSON.stringify(geo.body)); S.A.geo = geo.body.evidence; assert.equal(geo.body.validation.boundary.status, "INSIDE");
  assert.equal((await verifier().post("/api/geospatial/import", {})).status, 403, "reviewers cannot import evidence");
  // submission, duplicate submission, tamper-evidence
  const sub = await collector().post(`/api/records/${S.A.rec.id}/submit`); assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal((await collector().post(`/api/records/${S.A.rec.id}/submit`)).status, 409, "a record cannot be submitted twice");
  assert.equal((await collector().put(`/api/records/${S.A.rec.id}/species`, { species: [{ name: "Late edit", plantedCount: 1 }] })).status, 409, "no edits after submission");
  const rec = (await db.query("SELECT * FROM monitoring_records WHERE id=$1", [S.A.rec.id])).rows[0]; S.A.rec = rec;
  assert.equal(rec.status, "SUBMITTED"); assert.match(rec.content_hash, /^0x[0-9a-f]{64}$/); assert.equal(rec.species_snapshot.length, 2);
  assert.equal(rec.anchor_status, "ANCHORED", "the anchoring transaction was confirmed before the record is reported as anchored"); assert.ok(rec.anchor_tx_hash);
  const anchored = await onChain(rec); assert.equal(anchored.contentHash, rec.content_hash, "the on-chain hash equals the stored hash");
  assert.equal(anchored.evidenceRoot, rec.evidence_root, "and the evidence root covers the photo and the geospatial file");
  assert.equal(await count("SELECT COUNT(*) AS n FROM evidence WHERE record_id=$1 AND superseded_at IS NULL", [rec.id]), 2);
});

test("3. review: independent verifier, no self-approval; an estimate with disclosed assumptions and uncertainty", async () => {
  const id = S.A.rec.id;
  assert.equal((await collector().post(`/api/records/${id}/start-review`)).status, 403, "the collector cannot start the review");
  assert.equal((await verifier().post(`/api/records/${id}/decision`, { decision: "VERIFIED", comments: "Too early." })).status, 409, "a decision needs a review in progress");
  assert.equal((await verifier().post(`/api/records/${id}/start-review`)).status, 200);
  assert.equal((await verifier().post(`/api/records/${id}/decision`, { decision: "VERIFIED", comments: "Evidence not yet reviewed." })).status, 422, "blocking checks stop a verification with unreviewed evidence");
  for (const e of [S.A.photo, S.A.geo]) assert.equal((await verifier().post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" })).status, 200);
  // the collector, even when promoted to verifier, cannot decide their own submission
  assert.equal((await admin().patch(`/api/users/${S.collectorId}`, { role: "VERIFIER" })).status, 200);
  env.tokens.collector = await login(COLLECTOR.email, COLLECTOR.password);
  const own = await collector().post(`/api/records/${id}/decision`, { decision: "VERIFIED", comments: "Approving my own work." }); assert.equal(own.status, 403); assert.match(own.body.error, /cannot decide on their own submission/);
  assert.equal((await admin().patch(`/api/users/${S.collectorId}`, { role: "FIELD_USER" })).status, 200); env.tokens.collector = await login(COLLECTOR.email, COLLECTOR.password);
  assert.equal((await verifier().post(`/api/records/${id}/decision`, { decision: "NEEDS_REVISION" })).status, 400, "a reason is mandatory");
  const dec = await verifier().post(`/api/records/${id}/decision`, { decision: "VERIFIED", comments: "Photographs, survey file and measurements are consistent." }); assert.equal(dec.status, 200, JSON.stringify(dec.body));
  assert.ok(dec.body.tx?.blockNumber != null, "the verification transaction is confirmed in a block before it is reported as recorded");
  // estimate
  assert.equal((await collector().post(`/api/records/${id}/carbon-estimate`)).status, 403);
  const est = await verifier().post(`/api/records/${id}/carbon-estimate`); assert.ok([200, 201].includes(est.status), JSON.stringify(est.body)); const calc = est.body.calculation; S.A.calc = calc;
  assert.ok(calc.methodology_version && calc.methodology_hash && calc.input_hash, "versioned and hashed");
  assert.equal(calc.approval_status, "PENDING", "an estimate is not an approval");
  assert.ok(Number(calc.low_tco2e) <= Number(calc.central_tco2e) && Number(calc.central_tco2e) <= Number(calc.high_tco2e), "uncertainty bounds bracket the central estimate");
  assert.ok(Number(calc.conservative_tco2e) <= Number(calc.central_tco2e));
  assert.ok(calc.assumptions.parametersUsed.length > 0 && calc.assumptions.parametersUsed.every((p) => p.approval && p.label), "every parameter is disclosed with its review status");
  assert.ok(calc.assumptions.parametersUsed.some((p) => /UNVALIDATED|PLACEHOLDER/i.test(p.approval)), "placeholder parameters are labelled as unvalidated");
  assert.equal((await db.query("SELECT data_origin FROM projects WHERE id=$1", [S.project.id])).rows[0].data_origin, "ILLUSTRATIVE");
  assert.equal(await count("SELECT COUNT(*) AS n FROM carbon_credits WHERE record_id=$1", [id]), 0, "an estimate creates no credits");
});

test("4. rejected determination and overlapping reporting period are refused and create nothing", async () => {
  // rejected
  const rej = await verifiedRecord("2026-06-10", { areaHa: 5 });
  assert.equal((await verifier().post(`/api/records/${rej.rec.id}/start-review`)).status, 200);
  assert.equal((await verifier().post(`/api/records/${rej.rec.id}/decision`, { decision: "REJECTED" })).status, 400, "rejection needs a reason");
  assert.equal((await verifier().post(`/api/records/${rej.rec.id}/decision`, { decision: "REJECTED", comments: "The photographs do not show the stated plots." })).status, 200);
  assert.equal((await verifier().post(`/api/records/${rej.rec.id}/carbon-estimate`)).status, 409, "no estimate for a rejected record");
  assert.equal((await verifier().post(`/api/records/${rej.rec.id}/decision`, { decision: "VERIFIED", comments: "Reversing a rejection." })).status, 409, "rejection is final");
  assert.equal(await count("SELECT COUNT(*) AS n FROM carbon_calculations WHERE record_id=$1", [rej.rec.id]), 0);
  // a record that claims more area than the whole project can be drafted and submitted, but review refuses to verify it
  const big = await verifiedRecord("2026-06-12", { areaHa: 99999, species: false });
  assert.equal((await verifier().post(`/api/records/${big.rec.id}/start-review`)).status, 200); assert.equal((await verifier().post(`/api/evidence/${big.evidence.id}/review`, { decision: "VERIFIED" })).status, 200);
  const blocked = await verifier().post(`/api/records/${big.rec.id}/decision`, { decision: "VERIFIED", comments: "Trying to verify an oversized area." });
  assert.equal(blocked.status, 422, JSON.stringify(blocked.body)); assert.match(JSON.stringify(blocked.body), /area_consistency|exceed project area/i, "the blocking check is named");
  assert.equal((await db.query("SELECT status FROM monitoring_records WHERE id=$1", [big.rec.id])).rows[0].status, "UNDER_REVIEW", "the record stays under review");
  // overlap: a record dated before the end of the period already assessed
  const early = await verifiedRecord("2026-05-01", { areaHa: 10, species: false }); const dec = await reviewAndVerify(early); assert.equal(dec.status, 200, JSON.stringify(dec.body));
  const overlap = await verifier().post(`/api/records/${early.rec.id}/carbon-estimate`);
  assert.ok([400, 409, 422].includes(overlap.status), `an overlapping period is refused (got ${overlap.status}: ${JSON.stringify(overlap.body)})`);
  assert.equal(await count("SELECT COUNT(*) AS n FROM carbon_calculations WHERE record_id=$1", [early.rec.id]), 0, "no assessment row for the overlapping record");
  await assert.rejects(db.query(`INSERT INTO carbon_calculations (record_id, project_id, methodology_version, methodology_hash, inputs, assumptions, result, estimate_tco2e, low_tco2e, high_tco2e, central_tco2e, conservative_tco2e, buffer_percent, eligible_credits, input_hash, calculated_by, assessment_no, period_start, period_end, blockers)
     SELECT $1, project_id, methodology_version, methodology_hash, inputs, assumptions, result, estimate_tco2e, low_tco2e, high_tco2e, central_tco2e, conservative_tco2e, buffer_percent, eligible_credits, 'x', calculated_by, 1, '2026-01-01', '2026-05-01', '[]' FROM carbon_calculations WHERE id=$2`, [early.rec.id, S.A.calc.id]), /overlap|exclusion|conflict/i, "the database itself refuses overlapping periods");
});

test("5. eligibility and issuance: unapproved, wrong actor and duplicate attempts fail; a crash after submission is recovered exactly once", async () => {
  const calc = S.A.calc, rec = S.A.rec;
  assert.equal((await admin().post(`/api/carbon/calculations/${calc.id}/issue`)).status, 409, "not issuable before approval");
  for (const who of ["verifier", "collector", "fieldB"]) assert.equal((await env.as(who).post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Not allowed." })).status, 403, `${who} cannot approve`);
  assert.equal((await env.anon.post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED" })).status, 401);
  assert.equal((await admin().post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Approved for the journey." })).status, 200);
  for (const who of ["verifier", "collector"]) assert.equal((await env.as(who).post(`/api/carbon/calculations/${calc.id}/issue`)).status, 403, `${who} cannot issue`);
  const supplyBefore = await chain.readContract?.totalIssued?.() ?? 0n;
  // the issuing request dies after the transaction was submitted but before its confirmation was recorded
  ops.testHooks.fault = { point: "after_submit_before_hash", times: 1 };
  const crashed = await admin().post(`/api/carbon/calculations/${calc.id}/issue`); ops.testHooks.fault = null;
  assert.equal(crashed.status, 500, "the request died like a crashed process");
  const op = (await db.query("SELECT * FROM chain_operations WHERE idempotency_key=$1", [`issue:${rec.id}`])).rows[0];
  assert.ok(op, "a durable operation exists"); assert.notEqual(op.status, "COMPLETED", `a submitted transaction is not a completed one (status ${op.status})`);
  assert.equal(await count("SELECT COUNT(*) AS n FROM carbon_credits WHERE record_id=$1", [rec.id]), 0, "no credits are shown as issued while the outcome is unconfirmed");
  await unlock(); const sum = await ops.reconcile(); assert.ok(sum.completed >= 1, JSON.stringify(sum));
  const done = (await db.query("SELECT * FROM chain_operations WHERE id=$1", [op.id])).rows[0]; assert.equal(done.status, "COMPLETED"); assert.ok(done.tx_hash);
  const credit = (await db.query("SELECT * FROM carbon_credits WHERE record_id=$1", [rec.id])).rows; assert.equal(credit.length, 1, "exactly one credit batch"); S.credit = credit[0];
  assert.equal(Number(S.credit.amount_tonnes), calc.eligible_credits);
  // the transaction is on record even though the process died before it could be stored: it was recovered from the contract's own event
  const issuedEvents = await chain.findEvents("CreditsIssued", C.recordChainId(rec)); assert.equal(issuedEvents.length, 1, "one issuance event on the chain");
  assert.equal(done.tx_hash, issuedEvents[0].transactionHash, "the operation records the real transaction"); assert.equal(Number(done.block_number), issuedEvents[0].blockNumber);
  assert.equal(S.credit.tx_hash, done.tx_hash); assert.equal(Number(S.credit.block_number), issuedEvents[0].blockNumber);
  assert.equal(await count("SELECT COUNT(*) AS n FROM credit_events WHERE credit_id=$1 AND event_type='ISSUED' AND tx_hash=$2", [S.credit.id, done.tx_hash]), 1, "the ledger event names the transaction");
  assert.ok(await count("SELECT COUNT(*) AS n FROM blockchain_transactions WHERE tx_hash=$1", [done.tx_hash]) >= 1, "and it appears in the chain-transaction log");
  const wallet = (await db.query("SELECT wallet_address FROM organizations WHERE id=$1", [S.org.id])).rows[0].wallet_address;
  assert.equal(await chain.batchBalance(C.recordChainId(rec), wallet), calc.eligible_credits, "the on-chain balance equals what was issued, once");
  assert.equal((await ops.reconcile()).completed, 0, "reconciling again changes nothing");
  assert.equal((await admin().post(`/api/carbon/calculations/${calc.id}/issue`)).status, 409, "a repeated issuance request is refused");
  assert.equal(await chain.batchBalance(C.recordChainId(rec), wallet), calc.eligible_credits, "and issues nothing more");
  assert.equal(await count("SELECT COUNT(*) AS n FROM carbon_credits WHERE record_id=$1", [rec.id]), 1);
  const chk = await consistency.check(); assert.equal(chk.ok, true, JSON.stringify(chk.mismatches));
});

test("6. credit lifecycle and audit trail: holders move credits idempotently, a dispute pauses them, every step names its actor", async () => {
  const id = S.credit.id, holder = collector, key = "journey-transfer-0001";
  const move = (kind, body, k = key) => fetch(`${env.base}/api/credits/${id}/${kind}`, { method: "POST", headers: { authorization: `Bearer ${env.tokens.collector}`, "content-type": "application/json", "idempotency-key": k }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  assert.equal((await move("transfer", { toOrgId: env.orgs.buyer, amount: 1 }, "x")).status, 400, "an idempotency key is required");
  const t1 = await move("transfer", { toOrgId: env.orgs.buyer, amount: 2 }); assert.equal(t1.status, 201, JSON.stringify(t1.body));
  const t2 = await move("transfer", { toOrgId: env.orgs.buyer, amount: 2 }); assert.ok([200, 201].includes(t2.status), "a retry with the same key is accepted");
  assert.equal(await count("SELECT COUNT(*) AS n FROM credit_events WHERE credit_id=$1 AND event_type='TRANSFERRED'", [id]), 1, "the retry did not transfer twice");
  assert.equal((await outsider().post(`/api/credits/${id}/transfer`, { toOrgId: env.orgs.buyer, amount: 1 })).status, 409, "an organization without a balance cannot move credits");
  const view = await verifier().get(`/api/credits/${id}`); assert.equal(view.status, 200);
  assert.deepEqual(view.body.events.map((e) => e.event_type).slice(0, 2), ["ISSUED", "TRANSFERRED"]);
  assert.ok(view.body.balances.every((b) => b.onChainBalance === undefined || b.onChainBalance === b.balance), "registry balances equal on-chain balances");
  const d = await verifier().post(`/api/credits/${id}/disputes`, { category: "EVIDENCE", reason: "Journey check: raising a dispute pauses transfers and retirements." }); assert.equal(d.status, 201);
  assert.equal((await move("transfer", { toOrgId: env.orgs.buyer, amount: 1 }, "journey-transfer-0002")).status, 409, "paused while the dispute stands");
  assert.equal((await verifier().post(`/api/disputes/${d.body.dispute.id}/withdraw`, {})).status, 200);
  const t3 = await move("retire", { amount: 1, reason: "Journey retirement" }, "journey-retire-0001"); assert.equal(t3.status, 201, JSON.stringify(t3.body));
  // audit trail
  const actions = (await db.query("SELECT action, actor_id FROM audit_logs WHERE record_id=$1 ORDER BY id", [S.A.rec.id])).rows;
  const names = new Set(actions.map((a) => a.action));
  for (const a of ["RECORD_CREATED", "RECORD_SPECIES_UPDATED", "GEOSPATIAL_IMPORTED", "RECORD_SUBMITTED", "REVIEW_STARTED", "CARBON_CALCULATED"]) assert.ok(names.has(a), `audit has ${a}: ${[...names].join(",")}`);
  assert.equal(actions.find((a) => a.action === "RECORD_SUBMITTED").actor_id, S.collectorId); assert.equal(actions.find((a) => a.action === "REVIEW_STARTED").actor_id, env.users.verifier); assert.equal(actions.find((a) => a.action === "CARBON_CALCULATED").actor_id, env.users.verifier);
  assert.equal((await audit.verifyChain()).ok, true, "the audit hash chain verifies");
  await assert.rejects(db.query("UPDATE audit_logs SET details='{}' WHERE record_id=$1", [S.A.rec.id]), /./, "audit entries cannot be rewritten");
  assert.equal((await outsider().get(`/api/records/${S.A.rec.id}`)).status, 403, "another organization cannot read the record or its audit trail");
});

test("7. NCCR reporting: figures match the ledger, exports are permissioned and safe", async () => {
  await admin().post("/api/projects", projectBody(S.org.id, { name: "=HYPERLINK(\"http://example.invalid\",\"x\")", region: "Journey Estuary", geometry: BOUNDARY }));
  const calc = S.A.calc, q = calc.eligible_credits;
  const rep = await admin().get("/api/reports/registry?groupBy=project"); assert.equal(rep.status, 200);
  const row = rep.body.rows.find((r) => r.key === S.project.code);
  assert.equal(row.records_reported, 4, "four submitted records: two verified, one rejected, one still under review"); assert.equal(row.records_verified, 2); assert.equal(row.records_rejected, 1); assert.equal(row.records_in_review, 1);
  assert.equal(row.estimated_central_tco2e, Number(calc.central_tco2e)); assert.equal(row.eligible_approved_tonnes, q);
  assert.equal(row.issued_tonnes, q); assert.equal(row.transferred_tonnes, 2); assert.equal(row.retired_tonnes, 1); assert.equal(row.outstanding_tonnes, q - 1);
  assert.equal(row.data_origin, "ILLUSTRATIVE");
  const total = rep.body.totals.find((t) => t.data_origin === "ILLUSTRATIVE"); assert.equal(total.issued_tonnes, q);
  assert.equal((await env.anon.get("/api/reports/registry")).status, 401);
  const mine = await collector().get("/api/reports/registry?groupBy=project"); assert.ok(mine.body.rows.length >= 1 && mine.body.rows.every((r) => r.key.length > 0));
  assert.equal((await outsider().get("/api/reports/registry?groupBy=project")).body.rows.some((r) => r.key === S.project.code), false, "another organization sees none of these figures");
  const csv = await fetch(`${env.base}/api/reports/registry?groupBy=project&format=csv`, { headers: { authorization: `Bearer ${env.tokens.admin}` } });
  assert.equal(csv.status, 200); const text = await csv.text();
  assert.ok(text.includes(`"'=HYPERLINK(""http://example.invalid"",""x"")"`), "a spreadsheet formula in a project name is neutralised in the export");
  assert.ok(text.includes(S.project.code));
  assert.equal((await fetch(`${env.base}/api/reports/registry?format=csv`)).status, 401);
});
