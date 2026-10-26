// Methodology approval gating, project determinations, period sequencing and the database-level no-overlap guarantee.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, projectBody, recordBody } = require("./helpers");
const db = require("../src/db");
const defs = require("../src/methodology/definitions");

let env, P;
const IPCC = "IPCC-WS2013-T1-v1";
test.before(async () => {
  env = await setup();
  const r = await env.as("admin").post("/api/projects", projectBody(env.orgs.a, { dataOrigin: "USER_ENTERED", climateRegion: "TROPICAL_WET", revegetationMethod: "PLANTED", name: "Field-Collected Mangrove Plot" }));
  assert.equal(r.status, 201, JSON.stringify(r.body)); P = r.body.project;
});
test.after(async () => { await env.close(); });

async function verifiedRecord(date, over = {}) {
  const f = env.as("fieldA"), v = env.as("verifier");
  const rec = (await f.post("/api/records", recordBody(P.id, { activityDate: date, ...over }))).body.record;
  await f.upload({ projectId: P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: date });
  await f.post(`/api/records/${rec.id}/submit`); await v.post(`/api/records/${rec.id}/start-review`);
  for (const e of (await v.get(`/api/evidence?recordId=${rec.id}`)).body.evidence) await v.post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" });
  const d = await v.post(`/api/records/${rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence and measurements are consistent." });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  return rec;
}
const reviewBody = (hash, over = {}) => ({ decision: "APPROVED", reviewerName: "Dr A. Reviewer", reviewerOrganization: "Independent Review Body", reviewReference: "REVIEW-2026-014", reviewDate: "2026-09-01", parametersHash: hash, ...over });

test("project creation enforces methodology prerequisites", async () => {
  const a = env.as("admin");
  assert.equal((await a.post("/api/projects", projectBody(env.orgs.a, { dataOrigin: "USER_ENTERED", methodologyVersion: "ILLUSTRATIVE-BC-v1" }))).status, 400, "illustrative method refused for real projects");
  assert.equal((await a.post("/api/projects", projectBody(env.orgs.a, { dataOrigin: "USER_ENTERED" }))).status, 400, "mangrove needs a climate region and revegetation method");
  assert.equal((await a.post("/api/projects", projectBody(env.orgs.a, { dataOrigin: "USER_ENTERED", methodologyVersion: "X-v0", climateRegion: "TROPICAL_WET", revegetationMethod: "PLANTED" }))).status, 400);
  assert.equal(P.methodology_version, IPCC);
});

test("a sourced assessment is calculated but is not issuable until methodology review and accepted determinations exist", async () => {
  const rec = await verifiedRecord("2026-06-01");
  const c = await env.as("verifier").post(`/api/records/${rec.id}/carbon-estimate`);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const calc = c.body.calculation;
  assert.equal(calc.methodology_version, IPCC);
  assert.equal(calc.period_start.slice(0, 10), "2020-01-01");
  assert.ok(Number(calc.central_tco2e) > Number(calc.conservative_tco2e) && Number(calc.conservative_tco2e) > 0);
  assert.equal(calc.eligible_credits, 0, "no buffer determination => nothing eligible");
  const codes = calc.blockers.map((b) => b.code);
  for (const x of ["METHODOLOGY_NOT_APPROVED", "BUFFER_UNSET", "DETERMINATION_BASELINE_MISSING", "DETERMINATION_ADDITIONALITY_MISSING", "DETERMINATION_LEAKAGE_MISSING", "DETERMINATION_NON_PERMANENCE_RISK_MISSING", "NO_ELIGIBLE_QUANTITY"]) assert.ok(codes.includes(x), x);
  const ap = await env.as("admin").post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Approve anyway" });
  assert.equal(ap.status, 422);
  assert.ok(ap.body.details.blockers.length >= 5);
  assert.equal((await env.as("admin").post(`/api/carbon/calculations/${calc.id}/issue`)).status, 409);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_credits")).rows[0].n, 0);
  // the admin may still record that the estimate was not approved
  assert.equal((await env.as("admin").post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "REJECTED", notes: "Not issuable yet" })).status, 200);
  const states = (await env.anon.get("/api/methodologies")).body.methodologies;
  assert.equal(states.find((m) => m.version === IPCC).approval.state, "PENDING_REVIEW");
  assert.equal(states.find((m) => m.version === "ILLUSTRATIVE-BC-v1").approval.state, "ILLUSTRATIVE_ONLY");
  S.rec = rec;
});
const S = {};

test("independent review is recorded only for the exact parameter set, only by the administrator, and is audited", async () => {
  const hash = defs.parametersHash(defs.get(IPCC));
  assert.equal((await env.as("verifier").post(`/api/methodologies/${IPCC}/review`, reviewBody(hash))).status, 403);
  assert.equal((await env.as("admin").post(`/api/methodologies/${IPCC}/review`, reviewBody("0x" + "ab".repeat(32)))).status, 409, "hash must match the current parameters");
  assert.equal((await env.as("admin").post(`/api/methodologies/${IPCC}/review`, reviewBody(hash, { reviewReference: "x" }))).status, 400);
  assert.equal((await env.as("admin").post("/api/methodologies/ILLUSTRATIVE-BC-v1/review", reviewBody(hash))).status, 404, "the illustrative method cannot be approved");
  const ok = await env.as("admin").post(`/api/methodologies/${IPCC}/review`, reviewBody(hash));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await env.anon.get("/api/methodologies")).body.methodologies.find((m) => m.version === IPCC).approval.state, "APPROVED");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action='METHODOLOGY_REVIEW_RECORDED'")).rows[0].n, 1);
});

test("determinations: submitted by the administrator, accepted by a different person; the buffer comes only from an accepted risk assessment", async () => {
  const a = env.as("admin"), v = env.as("verifier");
  const sub = (kind, extra = {}) => a.post(`/api/projects/${P.id}/determinations`, { kind, summary: `Documented ${kind.toLowerCase()} assessment for this project.`, documentReference: "DOC-2026-" + kind, ...extra });
  assert.equal((await sub("NON_PERMANENCE_RISK")).status, 400, "a risk determination must state its buffer percentage");
  assert.equal((await sub("NON_PERMANENCE_RISK", { bufferPercent: 120 })).status, 400);
  assert.equal((await env.as("fieldA").post(`/api/projects/${P.id}/determinations`, { kind: "BASELINE", summary: "x".repeat(20), documentReference: "DOC-X" })).status, 403);
  const ids = {};
  for (const [k, x] of [["BASELINE", {}], ["ADDITIONALITY", {}], ["LEAKAGE", {}], ["NON_PERMANENCE_RISK", { bufferPercent: 20 }]]) { const r = await sub(k, x); assert.equal(r.status, 201, JSON.stringify(r.body)); ids[k] = r.body.determination.id; }
  assert.equal((await a.post(`/api/determinations/${ids.BASELINE}/review`, { decision: "ACCEPTED", notes: "Accepted", reviewerOrganization: "Review Org" })).status, 403, "administrators cannot review");
  assert.equal((await v.post(`/api/determinations/${ids.BASELINE}/review`, { decision: "ACCEPTED", notes: "ok" })).status, 400, "notes and organization required");
  for (const id of Object.values(ids)) assert.equal((await v.post(`/api/determinations/${id}/review`, { decision: "ACCEPTED", notes: "Documents reviewed and accepted.", reviewerOrganization: "Independent Verification Body" })).status, 200);
  assert.equal((await v.post(`/api/determinations/${ids.BASELINE}/review`, { decision: "ACCEPTED", notes: "again again", reviewerOrganization: "Org Org" })).status, 409, "already reviewed");
  const list = (await a.get(`/api/projects/${P.id}/determinations`)).body.determinations;
  assert.equal(list.filter((d) => d.status === "ACCEPTED").length, 4);
});

test("with an approved methodology and accepted determinations the assessment is issuable: eligible = floor(conservative x (1 - buffer))", async () => {
  const c = await env.as("verifier").post(`/api/records/${S.rec.id}/carbon-estimate`);
  const calc = c.body.calculation;
  assert.deepEqual(calc.blockers, []);
  assert.equal(Number(calc.buffer_percent), 20);
  assert.equal(calc.eligible_credits, Math.floor(Number(calc.conservative_tco2e) * 0.8 + 1e-9));
  assert.ok(calc.eligible_credits >= 1);
  assert.equal(calc.assessment_no, 2, "recalculation creates a new version; the earlier one is superseded");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_calculations WHERE record_id=$1 AND is_current", [S.rec.id])).rows[0].n, 1);
  const ap = await env.as("admin").post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Methodology reviewed; determinations accepted." });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const iss = await env.as("admin").post(`/api/carbon/calculations/${calc.id}/issue`);
  assert.equal(iss.status, 201, JSON.stringify(iss.body));
  assert.equal(Number(iss.body.credit.amount_tonnes), calc.eligible_credits);
  S.calc = calc;
});

test("period sequencing: the next assessment starts where the previous ended; earlier dates cannot be assessed again", async () => {
  const rec2 = await verifiedRecord("2026-09-01");
  const c2 = (await env.as("verifier").post(`/api/records/${rec2.id}/carbon-estimate`)).body.calculation;
  assert.equal(c2.period_start.slice(0, 10), "2026-06-01");
  assert.equal(c2.period_end.slice(0, 10), "2026-09-01");
  assert.ok(Number(c2.result.perHectare.biomassTcCumulative) > Number(S.calc.result.perHectare.biomassTcCumulative), "cumulative per-hectare stock continues from the previous period");
  const early = await verifiedRecord("2026-07-15");
  const r = await env.as("verifier").post(`/api/records/${early.id}/carbon-estimate`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /does not extend beyond the previously assessed period/);
  S.rec2 = rec2; S.c2 = c2; S.early = early;
});

test("the database refuses overlapping current assessment periods for a project (no double counting even via direct writes)", async () => {
  await assert.rejects(db.query(`INSERT INTO carbon_calculations (record_id, project_id, methodology_version, inputs, assumptions, result, estimate_tco2e, low_tco2e, high_tco2e, eligible_credits, input_hash, calculated_by, assessment_no, period_start, period_end)
    VALUES ($1,$2,$3,'{}','{}','{}',1,1,1,1,'0x',$4,9,'2026-08-01','2026-08-20')`, [S.early.id, P.id, IPCC, env.users.verifier]), /carbon_no_period_overlap|conflicting key/);
});

test("withdrawing the methodology review blocks approval and issuance of existing assessments", async () => {
  const hash = defs.parametersHash(defs.get(IPCC));
  const ap = await env.as("admin").post(`/api/carbon/calculations/${S.c2.id}/approve`, { decision: "APPROVED", notes: "Approved while the review stands." });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const w = await env.as("admin").post(`/api/methodologies/${IPCC}/review`, reviewBody(hash, { decision: "WITHDRAWN", reviewReference: "REVIEW-2026-020 (withdrawn)" }));
  assert.equal(w.status, 201);
  const iss = await env.as("admin").post(`/api/carbon/calculations/${S.c2.id}/issue`);
  assert.equal(iss.status, 422);
  assert.ok(iss.body.details.blockers.some((b) => b.code === "METHODOLOGY_NOT_APPROVED"));
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM carbon_credits")).rows[0].n, 1, "no further credits were issued");
});

test("a changed determination invalidates earlier assessments (buffer changed)", async () => {
  const hash = defs.parametersHash(defs.get(IPCC));
  await env.as("admin").post(`/api/methodologies/${IPCC}/review`, reviewBody(hash, { reviewReference: "REVIEW-2026-021 (re-approved)" }));
  const a = env.as("admin"), v = env.as("verifier");
  const d = (await a.post(`/api/projects/${P.id}/determinations`, { kind: "NON_PERMANENCE_RISK", bufferPercent: 35, summary: "Revised risk rating after erosion survey.", documentReference: "DOC-2026-NPRT-2" })).body.determination;
  await v.post(`/api/determinations/${d.id}/review`, { decision: "ACCEPTED", notes: "Revised rating accepted.", reviewerOrganization: "Independent Verification Body" });
  const iss = await a.post(`/api/carbon/calculations/${S.c2.id}/issue`);
  assert.equal(iss.status, 422);
  assert.ok(iss.body.details.blockers.some((b) => b.code === "BUFFER_CHANGED"));
});
