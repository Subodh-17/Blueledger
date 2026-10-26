// Registry reporting: grouping, separation of observed / verified / estimated / eligible / issued quantities, draft exclusion,
// data-origin separation, input validation, organization scoping, and safe CSV export.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, projectBody, recordBody, uniquePng } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");

cfg.rateLimit.max = 1e6; cfg.rateLimit.authMax = 1e6; cfg.scan.policy = "off"; cfg.ipfs.provider = "none";
let env; const S = {};
const admin = () => env.as("admin"), verifier = () => env.as("verifier"), fieldA = () => env.as("fieldA"), fieldB = () => env.as("fieldB");
const report = async (who, q = "") => (await env.as(who).get(`/api/reports/registry${q}`));
const row = (r, key, origin) => r.body.rows.find((x) => x.key === key && (!origin || x.data_origin === origin));

async function newRecord(who, projectId, over) {
  const r = await env.as(who).post("/api/records", recordBody(projectId, over)); assert.equal(r.status, 201, JSON.stringify(r.body));
  const up = await env.as(who).upload({ projectId, recordId: r.body.record.id, kind: "FIELD_PHOTO", captureDate: over.activityDate, latitude: 16.9004, longitude: 82.2004 }); assert.equal(up.status, 201, JSON.stringify(up.body));
  return { record: r.body.record, evidence: up.body.evidence };
}
const submit = async (who, rec) => { const s = await env.as(who).post(`/api/records/${rec.id}/submit`); assert.equal(s.status, 200, JSON.stringify(s.body)); };

test.before(async () => {
  env = await setup();
  // PA: illustrative reference project (org A). PB: user-entered project (org B). PC: user-entered project with no records.
  const mk = async (over, orgId) => { const r = await admin().post("/api/projects", projectBody(orgId, over)); assert.equal(r.status, 201, `${over.name}: ${JSON.stringify(r.body)}`); return r.body.project; };
  S.PA = await mk({ name: "Report project A", region: "Region X" }, env.orgs.a);
  S.PB = await mk({ name: "=HYPERLINK(\"http://example.invalid\")", region: "Region Y", dataOrigin: "USER_ENTERED", revegetationMethod: "PLANTED", climateRegion: "TROPICAL_WET" }, env.orgs.b);
  S.PC = await mk({ name: "Report project C (no records)", region: "Region Y", dataOrigin: "USER_ENTERED", revegetationMethod: "PLANTED", climateRegion: "TROPICAL_WET" }, env.orgs.b);
  S.r1 = await newRecord("fieldA", S.PA.id, { activityDate: "2026-06-01", areaHa: 40 });
  S.r2 = await newRecord("fieldA", S.PA.id, { activityDate: "2026-07-10", areaHa: 10 });
  S.r3 = await newRecord("fieldB", S.PB.id, { activityDate: "2026-06-15", areaHa: 5 });
  S.draft = await newRecord("fieldB", S.PB.id, { activityDate: "2026-08-01", areaHa: 7 }); // stays DRAFT
  await submit("fieldA", S.r1.record); await submit("fieldA", S.r2.record); await submit("fieldB", S.r3.record);
  assert.equal((await verifier().post(`/api/records/${S.r1.record.id}/start-review`)).status, 200);
  assert.equal((await verifier().post(`/api/evidence/${S.r1.evidence.id}/review`, { decision: "VERIFIED" })).status, 200);
  const d = await verifier().post(`/api/records/${S.r1.record.id}/decision`, { decision: "VERIFIED", comments: "Evidence and measurements consistent." });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  S.calc = (await verifier().post(`/api/records/${S.r1.record.id}/carbon-estimate`)).body.calculation;
  assert.ok(S.calc.eligible_credits >= 1);
});
test.after(async () => { await env.close(); });

test("estimated, approved-eligible and issued are separate figures: approval does not create issued credits", async () => {
  let a = row(await report("admin", "?groupBy=project"), S.PA.code);
  assert.equal(a.records_reported, 2); assert.equal(a.records_verified, 1); assert.equal(a.records_in_review, 1);
  assert.equal(a.reported_area_ha, 50); assert.equal(a.verified_area_ha, 40);
  assert.equal(a.estimated_central_tco2e, Number(S.calc.central_tco2e), "estimate comes from the current assessment");
  assert.equal(a.eligible_approved_tonnes, 0, "a pending assessment is not eligible");
  assert.equal(a.issued_tonnes, 0);
  assert.equal((await admin().post(`/api/carbon/calculations/${S.calc.id}/approve`, { decision: "APPROVED", notes: "Approved for the reporting test." })).status, 200);
  a = row(await report("admin", "?groupBy=project"), S.PA.code);
  assert.equal(a.eligible_approved_tonnes, S.calc.eligible_credits, "approved quantity is eligible");
  assert.equal(a.issued_tonnes, 0, "approved is not issued");
  const issue = await admin().post(`/api/carbon/calculations/${S.calc.id}/issue`); assert.equal(issue.status, 201, JSON.stringify(issue.body));
  a = row(await report("admin", "?groupBy=project"), S.PA.code);
  assert.equal(a.issued_tonnes, S.calc.eligible_credits); assert.equal(a.retired_tonnes, 0); assert.equal(a.outstanding_tonnes, S.calc.eligible_credits);
  const credit = issue.body.credit;
  assert.ok(S.calc.eligible_credits >= 2, `the fixture assessment yields at least 2 tonnes (got ${S.calc.eligible_credits})`);
  a = row(await report("admin", "?groupBy=project"), S.PA.code); assert.equal(a.transferred_tonnes, 0, "nothing transferred yet");
  const tr = await fieldA().post(`/api/credits/${credit.id}/transfer`, { toOrgId: env.orgs.buyer, amount: 1 }); assert.equal(tr.status, 201, JSON.stringify(tr.body));
  a = row(await report("admin", "?groupBy=project"), S.PA.code);
  assert.equal(a.transferred_tonnes, 1, "a transfer is counted as tonnes moved");
  assert.equal(a.outstanding_tonnes, S.calc.eligible_credits, "a transfer does not change what is outstanding");
  // retirement moves tonnes from outstanding to retired; issued stays the same
  const ret = await fieldA().post(`/api/credits/${credit.id}/retire`, { amount: 1, reason: "Reporting test retirement" }); // holder is the implementing organization
  assert.ok([200, 201].includes(ret.status), `retirement must succeed so the retired/outstanding figures are really exercised: ${ret.status} ${JSON.stringify(ret.body)}`);
  a = row(await report("admin", "?groupBy=project"), S.PA.code);
  assert.equal(a.retired_tonnes, 1); assert.equal(a.issued_tonnes, S.calc.eligible_credits); assert.equal(a.outstanding_tonnes, S.calc.eligible_credits - 1);
});

test("drafts are never reported; projects without records still appear with zeros; blank region is labelled Unspecified", async () => {
  const r = await report("admin", "?groupBy=project");
  const b = row(r, S.PB.code); assert.equal(b.records_reported, 1, "the draft is excluded"); assert.equal(b.reported_area_ha, 5);
  const c = row(r, S.PC.code); assert.equal(c.records_reported, 0); assert.equal(c.estimated_central_tco2e, 0); assert.equal(c.issued_tonnes, 0);
  assert.equal((await report("admin", "?groupBy=period")).body.rows.some((x) => x.key === "2026-08"), false, "the draft's month does not appear");
  await db.query("UPDATE projects SET region=NULL WHERE id=$1", [S.PC.id]);
  assert.ok(row(await report("admin", "?groupBy=region"), "Unspecified", "USER_ENTERED"));
  await db.query("UPDATE projects SET region='Region Y' WHERE id=$1", [S.PC.id]);
});

test("illustrative and user-entered data are never summed into one row", async () => {
  const eco = await report("admin", "?groupBy=ecosystem");
  const mangrove = eco.body.rows.filter((x) => x.key === "MANGROVE");
  assert.deepEqual(mangrove.map((x) => x.data_origin).sort(), ["ILLUSTRATIVE", "USER_ENTERED"]);
  assert.equal(mangrove.find((x) => x.data_origin === "ILLUSTRATIVE").records_reported, 2);
  assert.equal(mangrove.find((x) => x.data_origin === "USER_ENTERED").records_reported, 1);
  assert.deepEqual((await report("admin", "?groupBy=ecosystem&origin=ILLUSTRATIVE")).body.rows.map((x) => x.data_origin), ["ILLUSTRATIVE"]);
  assert.match(eco.body.notes.join(" "), /never added to user-entered data/);
});

test("grouping by reporting month, record status and region; filters narrow the result", async () => {
  const p = await report("admin", "?groupBy=period");
  assert.equal(row(p, "2026-06", "ILLUSTRATIVE").records_reported, 1); assert.equal(row(p, "2026-06", "USER_ENTERED").records_reported, 1); assert.equal(row(p, "2026-07", "ILLUSTRATIVE").records_reported, 1);
  const st = await report("admin", "?groupBy=status");
  assert.equal(row(st, "VERIFIED", "ILLUSTRATIVE").records_reported, 1); assert.equal(row(st, "SUBMITTED", "ILLUSTRATIVE").records_reported, 1);
  assert.equal(row(await report("admin", "?groupBy=region"), "Region X", "ILLUSTRATIVE").records_reported, 2);
  const july = await report("admin", "?groupBy=project&from=2026-07-01&to=2026-07-31");
  assert.deepEqual(july.body.rows.map((x) => [x.key, x.records_reported]), [[S.PA.code, 1]]);
  assert.equal(july.body.rows[0].reported_area_ha, 10, "date filters apply to the activity date of each record");
  assert.deepEqual((await report("admin", "?groupBy=project&status=VERIFIED")).body.rows.map((x) => x.key), [S.PA.code]);
  assert.equal((await report("admin", "?groupBy=project&ecosystem=SEAGRASS")).body.rows.length, 0);
  assert.equal((await report("admin", "?groupBy=project&region=Region%20Y")).body.rows.every((x) => x.data_origin === "USER_ENTERED"), true);
});

test("invalid parameters are rejected with 400 and nothing reaches SQL", async () => {
  for (const q of ["?groupBy=p.code;DROP TABLE projects", "?groupBy=unknown", "?from=2026-02-30", "?from=yesterday", "?from=2026-08-01&to=2026-07-01", "?ecosystem=FOREST", "?status=DRAFT", "?origin=REAL", "?format=xml"]) {
    const r = await report("admin", q); assert.equal(r.status, 400, `${q} -> ${r.status}`); assert.ok(r.body.error || r.body.message, q);
  }
  assert.equal((await db.query("SELECT to_regclass('public.projects') AS t")).rows[0].t, "projects");
});

test("access: sign-in required; field users see only their own organization; verifiers and administrators see all", async () => {
  assert.equal((await env.anon.get("/api/reports/registry")).status, 401);
  const a = await report("fieldA", "?groupBy=project"); assert.equal(a.status, 200); assert.deepEqual(a.body.rows.map((x) => x.key), [S.PA.code]);
  const b = await report("fieldB", "?groupBy=project"); assert.deepEqual(b.body.rows.map((x) => x.key).sort(), [S.PB.code, S.PC.code].sort());
  assert.equal((await report("fieldB", "?groupBy=ecosystem")).body.rows.every((x) => x.data_origin === "USER_ENTERED"), true);
  assert.equal((await report("verifier", "?groupBy=project")).body.rows.length, 3);
  assert.equal((await report("admin", "?groupBy=project")).body.rows.length, 3);
});

test("CSV export: attachment headers, provenance notes, and spreadsheet-formula neutralisation", async () => {
  const res = await fetch(`${env.base}/api/reports/registry?groupBy=project&format=csv`, { headers: { authorization: `Bearer ${env.tokens.admin}` } });
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /^text\/csv/); assert.match(res.headers.get("content-disposition"), /attachment; filename="registry-report-project\.csv"/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text(), lines = text.trim().split("\r\n");
  assert.ok(lines[0].startsWith("# groupBy=project")); assert.ok(lines.some((l) => /not verified or issued credits/.test(l)));
  const header = lines.find((l) => l.startsWith("key,label,data_origin,projects,records_reported")); assert.ok(header, "column header present");
  const bLine = lines.find((l) => l.startsWith(S.PB.code)); assert.ok(bLine);
  assert.ok(bLine.includes(`"'=HYPERLINK(""http://example.invalid"")"`), `formula cell is neutralised and quoted: ${bLine}`);
  // Test cell formula neutralization directly including leading whitespace
  const reportsSvc = require("../src/services/reports");
  const testCsv = reportsSvc.toCsv({ groupBy: "project", generatedAt: "2026-10-26T00:00:00.000Z", filters: {}, notes: [], rows: [{ key: "P-SEC", label: "  =cmd|' /C calc'!A0", data_origin: "USER_ENTERED" }] });
  assert.ok(testCsv.includes("'  =cmd|' /C calc'!A0"), "leading whitespace formula injection is neutralized");
  assert.equal((await fetch(`${env.base}/api/reports/registry?format=csv`)).status, 401, "no export without sign-in");
});

test("totals are computed by the database over the same filters; summing grouped rows would double count projects", async () => {
  const byMonth = await report("admin", "?groupBy=period");
  const ill = byMonth.body.totals.find((t) => t.data_origin === "ILLUSTRATIVE");
  const summed = byMonth.body.rows.filter((r) => r.data_origin === "ILLUSTRATIVE").reduce((n, r) => n + r.projects, 0);
  assert.equal(ill.projects, 1, "one illustrative project in total"); assert.equal(summed, 2, "the same project is in two month groups");
  const byProject = await report("admin", "?groupBy=project");
  for (const k of ["records_reported", "issued_tonnes", "transferred_tonnes", "retired_tonnes", "reported_area_ha"]) {
    for (const t of byProject.body.totals) assert.equal(t[k], byProject.body.rows.filter((r) => r.data_origin === t.data_origin).reduce((n, r) => n + r[k], 0), `${k} total equals the sum of its rows for ${t.data_origin}`);
  }
  assert.deepEqual(byProject.body.totals.map((t) => t.data_origin), ["ILLUSTRATIVE", "USER_ENTERED"], "origins are never merged in totals");
  assert.equal(byProject.body.truncated, false); assert.equal(byProject.body.maxRows, 500);
  const scoped = await report("fieldA", "?groupBy=period"); assert.deepEqual(scoped.body.totals.map((t) => t.data_origin), ["ILLUSTRATIVE"], "field users' totals cover only their organization");
});

test("project filter selects one project by code and rejects anything else", async () => {
  const one = await report("admin", `?groupBy=ecosystem&project=${S.PA.code}`);
  assert.equal(one.body.rows.length, 1); assert.equal(one.body.rows[0].records_reported, 2); assert.equal(one.body.totals.length, 1);
  assert.equal((await report("admin", "?project=NOPE-999")).body.rows.length, 0);
  assert.equal((await report("admin", "?project=a%27%3B%20DROP%20TABLE%20projects%3B--")).status, 400);
});
