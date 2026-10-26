// Input validation, authentication and role-permission tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, projectBody, recordBody, PASSWORD } = require("./helpers");
const db = require("../src/db");

let env, P;
test.before(async () => { env = await setup(); P = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a))).body.project; });
test.after(async () => { await env.close(); });

test("authentication: bad credentials, missing/garbled token, deactivated users", async () => {
  assert.equal((await env.anon.post("/api/auth/login", { email: "admin@test.invalid", password: "wrong-password" })).status, 401);
  assert.equal((await env.anon.post("/api/auth/login", {})).status, 400);
  assert.equal((await env.anon.get("/api/projects")).status, 401);
  const garbled = await fetch(`${env.base}/api/projects`, { headers: { authorization: "Bearer not.a.token" } });
  assert.equal(garbled.status, 401);
  await env.as("admin").patch(`/api/users/${env.users.fieldB}`, { isActive: false });
  assert.equal((await env.as("fieldB").get("/api/projects")).status, 401, "deactivated user's token stops working");
  assert.equal((await env.anon.post("/api/auth/login", { email: "fieldB@test.invalid", password: PASSWORD })).status, 401);
});

test("self-registration yields an organization-less FIELD_USER with no project access; no privilege escalation", async () => {
  const r = await env.anon.post("/api/auth/register", { name: "New Person", email: "new@test.invalid", password: "long-enough-pass", role: "NCCR_ADMIN", adminKey: "x" });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, "FIELD_USER");
  const tok = r.body.token;
  const mine = await fetch(`${env.base}/api/projects`, { headers: { authorization: `Bearer ${tok}` } });
  assert.deepEqual((await mine.json()).projects, [], "no organization -> no projects");
  assert.equal((await env.anon.post("/api/auth/register", { name: "x", email: "bad", password: "short" })).status, 400);
  assert.equal((await env.anon.post("/api/auth/register", { name: "New Person", email: "new@test.invalid", password: "long-enough-pass" })).status, 409);
  const rows = (await db.query("SELECT role, organization_id FROM users WHERE email='new@test.invalid'")).rows[0];
  assert.deepEqual(rows, { role: "FIELD_USER", organization_id: null });
  assert.ok(tok);
});

test("project validation", async () => {
  const a = env.as("admin");
  assert.equal((await a.post("/api/projects", {})).status, 400);
  assert.equal((await a.post("/api/projects", projectBody(env.orgs.a, { areaHectares: -5 }))).status, 400);
  assert.equal((await a.post("/api/projects", projectBody(env.orgs.a, { latitude: 123 }))).status, 400);
  assert.equal((await a.post("/api/projects", projectBody(env.orgs.a, { ecosystemType: "KELP" }))).status, 400);
  assert.equal((await a.post("/api/projects", projectBody(env.orgs.a, { startDate: "2999-01-01" }))).status, 400);
  assert.equal((await a.post("/api/projects", projectBody(9999))).status, 400);
  assert.equal((await a.get("/api/projects/abc")).status, 400);
  assert.equal((await a.get("/api/projects/99999")).status, 404);
});

test("record validation: ranges, unknown measurements, dates, completeness at submission", async () => {
  const f = env.as("fieldA");
  const bad = async (over) => (await f.post("/api/records", recordBody(P.id, over))).status;
  assert.equal(await bad({ areaHa: 0 }), 400);
  assert.equal(await bad({ activityType: "DANCING" }), 400);
  assert.equal(await bad({ activityDate: "not-a-date" }), 400);
  assert.equal(await bad({ activityDate: "2999-01-01" }), 400);
  assert.equal(await bad({ activityDate: "2019-01-01" }), 400, "before project start");
  assert.equal(await bad({ latitude: 200 }), 400);
  assert.equal(await bad({ measurements: { survival_rate_pct: 140 } }), 400);
  assert.equal(await bad({ measurements: { secret_field: 1 } }), 400);
  assert.equal(await bad({ projectId: "x" }), 400);
  assert.equal((await f.post("/api/records", recordBody(99999))).status, 404);
  // incomplete: no geotag, no evidence
  const r = await f.post("/api/records", recordBody(P.id, { latitude: undefined, longitude: undefined }));
  assert.equal(r.status, 201);
  const s = await f.post(`/api/records/${r.body.record.id}/submit`);
  assert.equal(s.status, 422);
  assert.ok(s.body.details.location && s.body.details.evidence);
});

test("evidence validation: type, kind, ownership, duplicates, attach window", async () => {
  const f = env.as("fieldA");
  const rec = (await f.post("/api/records", recordBody(P.id))).body.record;
  assert.equal((await f.upload({ projectId: P.id, kind: "SELFIE" })).status, 400);
  assert.equal((await f.upload({ projectId: P.id, kind: "FIELD_PHOTO" }, Buffer.from("MZ not an image"), "malware.exe")).status, 400);
  assert.equal((await f.upload({ projectId: P.id, kind: "FIELD_PHOTO" }, null)).status, 400, "file or reference required");
  assert.equal((await f.upload({ projectId: P.id, kind: "FIELD_PHOTO", latitude: 999 })).status, 400);
  const png = require("./helpers").uniquePng();
  assert.equal((await f.upload({ projectId: P.id, kind: "FIELD_PHOTO" }, png)).status, 201);
  assert.equal((await f.upload({ projectId: P.id, kind: "FIELD_PHOTO" }, png)).status, 409, "same file twice");
  assert.equal((await env.as("verifier").upload({ projectId: P.id, kind: "FIELD_PHOTO" })).status, 403);
  assert.equal((await env.as("fieldA").upload({ projectId: P.id, recordId: 99999, kind: "FIELD_PHOTO" })).status, 404);
  const ref = await f.upload({ projectId: P.id, recordId: rec.id, kind: "REMOTE_SENSING", externalRef: "demo-scene-0001 (synthetic reference)" }, null);
  assert.equal(ref.status, 201);
  assert.equal(ref.body.evidence.processing_status, "REFERENCE_ONLY");
  assert.equal(ref.body.evidence.sha256, null);
});

test("evidence files are only served to authenticated users with access", async () => {
  const f = env.as("fieldA");
  const e = (await f.upload({ projectId: P.id, kind: "FIELD_PHOTO" })).body.evidence;
  const url = `/api/evidence/${e.id}/file`;
  assert.equal((await env.anon.get(url)).status, 401);
  assert.equal((await env.as("fieldA").get(`/api/evidence/${e.id}`)).status, 200);
});

test("admin user management and role guards", async () => {
  const a = env.as("admin");
  assert.equal((await env.as("verifier").get("/api/users")).status, 403);
  assert.equal((await a.post("/api/users", { name: "V3", email: "v3@test.invalid", password: "long-enough-pass", role: "VERIFIER", walletAddress: "0xnot" })).status, 400);
  assert.equal((await a.post("/api/users", { name: "V3", email: "v3@test.invalid", password: "long-enough-pass", role: "SUPERUSER" })).status, 400);
  assert.equal((await a.post("/api/users", { name: "V3", email: "v3@test.invalid", password: "long-enough-pass", role: "VERIFIER", organizationId: env.orgs.nccr })).status, 201);
  assert.equal((await a.patch(`/api/users/${env.users.admin}`, { isActive: false })).status, 400, "cannot lock yourself out");
});

test("malformed JSON and unknown routes", async () => {
  assert.equal((await env.anon.get("/api/nothing")).status, 404);
  const res = await fetch(`${env.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
});
