// Pagination/filtering, overview figures, tasks, search, and administration of chain roles.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, projectBody, recordBody } = require("./helpers");
const db = require("../src/db");
const chain = require("../src/services/chain");

let env;
test.before(async () => {
  env = await setup();
  const a = env.as("admin");
  const names = ["Alpha Mangrove", "Bravo Seagrass", "Charlie Marsh", "Delta Mangrove", "Echo Seagrass"];
  for (const [i, n] of names.entries()) await a.post("/api/projects", projectBody(i % 2 ? env.orgs.b : env.orgs.a, { name: n, ecosystemType: n.includes("Seagrass") ? "SEAGRASS" : n.includes("Marsh") ? "SALT_MARSH" : "MANGROVE", restorationType: n.includes("Seagrass") ? "SEAGRASS_TRANSPLANT" : "MANGROVE_PLANTATION" }));
});
test.after(async () => { await env.close(); });

test("projects: pagination, sorting, filtering and text search work server-side", async () => {
  const a = env.as("admin");
  const p1 = (await a.get("/api/projects?pageSize=2&page=1&sort=name&dir=asc")).body;
  assert.deepEqual(p1.projects.map((p) => p.name), ["Alpha Mangrove", "Bravo Seagrass"]);
  assert.equal(p1.pagination.total, 5); assert.equal(p1.pagination.totalPages, 3);
  const p3 = (await a.get("/api/projects?pageSize=2&page=3&sort=name&dir=asc")).body;
  assert.deepEqual(p3.projects.map((p) => p.name), ["Echo Seagrass"]);
  assert.deepEqual((await a.get("/api/projects?sort=name&dir=desc&pageSize=1")).body.projects.map((p) => p.name), ["Echo Seagrass"]);
  assert.equal((await a.get("/api/projects?ecosystem=SEAGRASS")).body.projects.length, 2);
  assert.equal((await a.get("/api/projects?q=marsh")).body.projects.length, 1);
  assert.equal((await a.get("/api/projects?pageSize=9999")).body.pagination.pageSize, 100, "page size is capped");
  assert.equal((await a.get("/api/projects?page=-4")).body.pagination.page, 1);
  assert.equal((await env.as("fieldA").get("/api/projects")).body.pagination.total, 3, "field users only see their organization");
});

test("overview figures come from queries, scoped by role; tasks reflect real workload", async () => {
  const a = env.as("admin"), f = env.as("fieldA"), v = env.as("verifier");
  const proj = (await a.get("/api/projects?q=alpha")).body.projects[0];
  const draft = (await f.post("/api/records", recordBody(proj.id))).body.record;
  const o0 = (await f.get("/api/overview")).body;
  assert.equal(o0.scope, "ORGANIZATION");
  assert.equal(o0.counts.recordsByStatus.DRAFT, 1);
  assert.equal(o0.counts.projects, 3);
  assert.ok(o0.tasks.some((t) => t.type === "DRAFT_RECORDS" && t.count === 1));
  assert.equal(o0.series.months.length, 12);
  assert.equal((await env.as("fieldB").get("/api/overview")).body.counts.recordsByStatus.DRAFT || 0, 0, "other organization does not see it");

  await f.upload({ projectId: proj.id, recordId: draft.id, kind: "FIELD_PHOTO", captureDate: "2026-06-01" });
  await f.post(`/api/records/${draft.id}/submit`);
  const ov = (await v.get("/api/overview")).body;
  assert.equal(ov.scope, "REGISTRY");
  assert.ok(ov.tasks.some((t) => t.type === "AWAITING_REVIEW" && t.count === 1));
  const thisMonth = new Date().toISOString().slice(0, 7);
  assert.equal(ov.series.recordsSubmitted[ov.series.months.indexOf(thisMonth)], 1, "monthly series is calculated from submission timestamps");
  assert.equal(ov.counts.credits.issued, 0);
  assert.ok(ov.activity.length > 0 && ov.activity[0].action);
  assert.equal(ov.provenance.illustrativeProjects, 5);
  const ad = (await a.get("/api/tasks")).body.tasks;
  assert.ok(!ad.some((t) => t.type === "AWAITING_REVIEW"), "admin tasks are about approvals and operations");
});

test("global search finds projects, records, evidence and respects scope", async () => {
  const a = env.as("admin");
  assert.equal((await a.get("/api/search?q=a")).body.results.length, 0, "queries shorter than 2 characters return nothing");
  const r = (await a.get("/api/search?q=Alpha")).body.results;
  assert.ok(r.some((x) => x.type === "Project" && /Alpha/.test(x.label)));
  const rec = (await a.get("/api/records?pageSize=1")).body.records[0];
  assert.ok((await a.get(`/api/search?q=${rec.code}`)).body.results.some((x) => x.type === "Monitoring record"));
  assert.equal((await env.as("fieldB").get(`/api/search?q=${rec.code}`)).body.results.length, 0);
});

test("records, evidence and audit lists paginate and filter", async () => {
  const a = env.as("admin");
  const recs = (await a.get("/api/records?status=SUBMITTED")).body;
  assert.equal(recs.pagination.total, 1);
  const total = (await db.query("SELECT COUNT(*)::int n FROM monitoring_records")).rows[0].n;
  assert.equal((await a.get("/api/records?status=NOPE")).body.pagination.total, total, "an unknown filter value is ignored, not interpreted");
  const ev = (await a.get("/api/evidence?kind=FIELD_PHOTO&sort=code&dir=asc")).body;
  assert.ok(ev.evidence.length >= 1 && ev.evidence[0].storage_status === "STORED");
  const au = (await a.get("/api/audit?pageSize=3")).body;
  assert.equal(au.entries.length, 3);
  assert.ok(au.pagination.total > 3);
  assert.equal((await a.get("/api/audit?action=RECORD_SUBMITTED")).body.entries.length, 1);
  assert.equal((await a.get(`/api/audit?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).status, 200);
});

test("administration: on-chain role assignment is signed by the registry administrator and audited", async () => {
  const a = env.as("admin");
  const extra = env.accounts[9];
  const u = (await a.post("/api/users", { name: "Second Reviewer", email: "rev2@test.invalid", password: "Strong-Reviewer-Pass-7", role: "VERIFIER", organizationId: env.orgs.nccr, walletAddress: extra })).body.user;
  assert.equal((await chain.rolesOf(extra)).verifier, false);
  assert.equal((await env.as("verifier").post(`/api/users/${u.id}/chain-role`, { role: "verifier", granted: true })).status, 403);
  const g = await a.post(`/api/users/${u.id}/chain-role`, { role: "verifier", granted: true });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.roles.verifier, true);
  assert.match(g.body.tx, /^0x[0-9a-f]{64}$/);
  const rv = await a.post(`/api/users/${u.id}/chain-role`, { role: "verifier", granted: false });
  assert.equal(rv.body.roles.verifier, false);
  assert.equal((await a.post(`/api/users/${u.id}/chain-role`, { role: "admin", granted: true })).status, 400);
  const fieldUser = env.users.fieldA;
  assert.equal((await a.post(`/api/users/${fieldUser}/chain-role`, { role: "verifier", granted: true })).status, 422, "only Verifier-role users, and only with a wallet");
  const logged = (await a.get("/api/audit?action=CHAIN_ROLE_CHANGED")).body.entries;
  assert.equal(logged.length, 2);
  assert.ok(logged.every((e) => /^0x/.test(e.tx_hash)));
  const opsList = (await a.get("/api/chain/operations?status=COMPLETED")).body;
  assert.ok(opsList.operations.some((o) => o.op_type === "ROLE_CHANGE"));
});

test("methodology and configuration endpoints expose qualified information", async () => {
  const m = (await env.anon.get("/api/carbon/methodology")).body;
  assert.equal(m.certified, false);
  assert.equal(m.status, "PENDING_REVIEW");
  assert.ok(m.references.length === 3 && m.parameters.agb_growth.table === "Table 4.4");
  assert.ok(m.rounding && m.bufferRule);
  const c = (await env.anon.get("/api/config")).body;
  assert.ok("map" in c && c.methodologyVersion === m.version);
});
