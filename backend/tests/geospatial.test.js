// Geospatial evidence import and structured planting by species, against the real API, database, evidence storage and local chain.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { setup, projectBody, recordBody, uniquePng } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");
const geo = require("../src/services/geo");
const evidenceSvc = require("../src/services/evidence");
const storage = require("../src/services/storage");
const C = require("../src/services/common");

cfg.rateLimit.max = 1e6; cfg.rateLimit.authMax = 1e6; cfg.scan.policy = "off"; cfg.ipfs.provider = "none";
let env; const S = {};
const BOUNDARY = { type: "Polygon", coordinates: [[[82.15, 16.85], [82.25, 16.85], [82.25, 16.95], [82.15, 16.95], [82.15, 16.85]]] };
const feat = (lon, lat, props) => ({ type: "Feature", properties: props === undefined ? { species: "Rhizophora mucronata", count: 10, observedAt: "2026-06-01" } : props, geometry: { type: "Point", coordinates: [lon, lat] } });
const gj = (...f) => Buffer.from(JSON.stringify({ type: "FeatureCollection", features: f }));
const unique = (extra = {}) => gj(feat(82.2 + Math.random() / 1000, 16.9 + Math.random() / 1000, { species: "Rhizophora mucronata", count: 10, observedAt: "2026-06-01", ...extra }));

async function geoPost(who, path, fields, buf, name = "survey.geojson") {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) form.append(k, String(v));
  if (buf) form.append("file", new Blob([buf]), name);
  const res = await fetch(`${env.base}/api${path}`, { method: "POST", headers: who ? { authorization: `Bearer ${env.tokens[who]}` } : {}, body: form });
  let body = null; try { body = await res.json(); } catch { /* none */ }
  return { status: res.status, body };
}
const importAs = (who, fields, buf, name) => geoPost(who, "/geospatial/import", { source: "FIELD_SURVEY", ...fields }, buf, name);
const count = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);
const newRecord = async (who, projectId, over = {}) => { const r = await env.as(who).post("/api/records", recordBody(projectId, over)); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.record; };

test.before(async () => {
  env = await setup();
  const mk = async (over, org) => { const r = await env.as("admin").post("/api/projects", projectBody(org, over)); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.project; };
  S.P = await mk({ name: "Boundary project", geometry: BOUNDARY }, env.orgs.a);
  S.NB = await mk({ name: "No-boundary project" }, env.orgs.a);
  S.rec = await newRecord("fieldA", S.P.id);
});
test.after(async () => { await env.close(); });

test("dry run reports what an import would do and stores nothing", async () => {
  const before = await count("SELECT COUNT(*) AS n FROM evidence"), filesBefore = fs.readdirSync(cfg.uploadDir).length;
  const buf = unique();
  const r = await geoPost("fieldA", "/geospatial/validate", { projectId: S.P.id, source: "FIELD_SURVEY" }, buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.wouldImport, true); assert.equal(r.body.validation.valid, true); assert.equal(r.body.validation.boundary.status, "INSIDE");
  assert.equal(r.body.sha256, crypto.createHash("sha256").update(buf).digest("hex"));
  assert.equal(await count("SELECT COUNT(*) AS n FROM evidence"), before, "no evidence row");
  assert.equal(await count("SELECT COUNT(*) AS n FROM geospatial_imports"), 0);
  assert.equal(fs.readdirSync(cfg.uploadDir).length, filesBefore, "the upload directory is unchanged");
  assert.equal(fs.readdirSync(cfg.uploadDir).filter((f) => f.startsWith(r.body.sha256)).length, 0, "no file written by a dry run");
  const bad = await geoPost("fieldA", "/geospatial/validate", { projectId: S.P.id, source: "FIELD_SURVEY" }, gj(feat(83.9, 16.9)));
  assert.equal(bad.status, 200); assert.equal(bad.body.wouldImport, false); assert.equal(bad.body.validation.errors[0].code, "POINT_OUTSIDE_BOUNDARY");
});

test("a valid file is stored byte-for-byte as GEOSPATIAL evidence with a frozen validation record, a hash and an audit entry", async () => {
  const buf = gj(feat(82.2, 16.9, { species: "Rhizophora mucronata", count: 12, observedAt: "2026-06-01" }), feat(82.21, 16.91, { species: "Avicennia marina", count: 8, observedAt: "2026-06-02" }), feat(82.22, 16.92, {}));
  const r = await importAs("fieldA", { projectId: S.P.id, recordId: S.rec.id, tool: "SurveyKit", toolVersion: "2.1" }, buf);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.imp = r.body.evidence;
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  assert.equal(S.imp.kind, "GEOSPATIAL"); assert.equal(S.imp.sha256, sha); assert.equal(S.imp.record_id, S.rec.id);
  assert.deepEqual(r.body.validation.summary.speciesTotals, { "Rhizophora mucronata": 12, "Avicennia marina": 8 });
  assert.ok(r.body.validation.warnings.some((w) => w.code === "MISSING_PROPERTIES"));
  const row = (await db.query("SELECT * FROM geospatial_imports WHERE evidence_id=$1", [S.imp.id])).rows[0];
  assert.equal(row.validation_status, "VALID_WITH_WARNINGS"); assert.equal(row.boundary_status, "INSIDE"); assert.equal(row.boundary_checked, true); assert.equal(row.feature_count, 3); assert.equal(row.tool, "SurveyKit"); assert.equal(row.source, "FIELD_SURVEY");
  assert.equal(row.validator_version, geo.LIMITS ? "geo-1" : "");
  const ev = (await db.query("SELECT * FROM evidence WHERE id=$1", [S.imp.id])).rows[0];
  assert.equal(ev.mime_type, "application/geo+json"); assert.equal(ev.crs, "EPSG:4326"); assert.equal(ev.verification_status, "PENDING");
  const stored = fs.readFileSync(`${cfg.uploadDir}/${ev.storage_uri}`); assert.equal(crypto.createHash("sha256").update(stored).digest("hex"), sha, "stored bytes hash to the recorded digest (encryption off in tests)");
  const au = (await db.query("SELECT details, actor_id FROM audit_logs WHERE action='GEOSPATIAL_IMPORTED' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(au.actor_id, env.users.fieldA); assert.equal(au.details.sha256, sha); assert.equal(au.details.boundaryStatus, "INSIDE");
  assert.ok(!JSON.stringify(au.details).includes("Rhizophora"), "file contents are not copied into the audit log");
});

test("the stored file is served sandboxed and the import is visible to the reviewer with a declared-versus-imported comparison", async () => {
  const sp = await env.as("fieldA").put(`/api/records/${S.rec.id}/species`, { species: [{ name: "Rhizophora mucronata", plantedCount: 12 }, { name: "Bruguiera gymnorhiza", plantedCount: 5 }] });
  assert.equal(sp.status, 200, JSON.stringify(sp.body));
  const res = await fetch(`${env.base}/api/evidence/${S.imp.id}/file`, { headers: { authorization: `Bearer ${env.tokens.verifier}` } });
  assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "application/geo+json"); assert.equal(res.headers.get("x-content-type-options"), "nosniff"); assert.match(res.headers.get("content-security-policy"), /sandbox/);
  const d = await env.as("verifier").get(`/api/geospatial/imports/${S.imp.id}`);
  assert.equal(d.status, 200); assert.equal(d.body.import.evidence_code, S.imp.code);
  const rows = Object.fromEntries(d.body.comparison.rows.map((r) => [r.species, r]));
  assert.deepEqual([rows["Rhizophora mucronata"].declared, rows["Rhizophora mucronata"].imported, rows["Rhizophora mucronata"].differs], [12, 12, false]);
  assert.equal(rows["Bruguiera gymnorhiza"].onlyIn, "record"); assert.equal(rows["Avicennia marina"].onlyIn, "file");
  assert.match(d.body.comparison.basis, /unreviewed/);
  assert.equal((await env.as("verifier").get(`/api/geospatial/imports?recordId=${S.rec.id}`)).body.imports.length, 1);
  assert.equal((await env.as("fieldB").get(`/api/geospatial/imports/${S.imp.id}`)).status, 403, "another organization cannot read it");
  assert.equal((await env.as("fieldB").get("/api/geospatial/imports")).body.imports.length, 0);
});

test("duplicates are refused without storing a second copy", async () => {
  const buf = unique(); const first = await importAs("fieldA", { projectId: S.P.id }, buf); assert.equal(first.status, 201);
  const n = await count("SELECT COUNT(*) AS n FROM evidence WHERE sha256=$1", [first.body.evidence.sha256]);
  const again = await importAs("fieldA", { projectId: S.P.id }, buf); assert.equal(again.status, 409); assert.equal(again.body.details.duplicateOf, first.body.evidence.code);
  assert.equal(await count("SELECT COUNT(*) AS n FROM evidence WHERE sha256=$1", [first.body.evidence.sha256]), n);
  const dry = await geoPost("fieldA", "/geospatial/validate", { projectId: S.P.id, source: "FIELD_SURVEY" }, buf); assert.equal(dry.body.wouldImport, false); assert.equal(dry.body.duplicateOf, first.body.evidence.code);
});

test("invalid files are rejected with the validator's report, and nothing is stored or audited as imported", async () => {
  const cases = [
    ["malformed JSON", Buffer.from("{not json"), "MALFORMED_JSON"],
    ["a point outside the boundary", gj(feat(83.9, 16.9)), "POINT_OUTSIDE_BOUNDARY"],
    ["latitude out of range", gj(feat(82.2, 95)), "COORDINATE_OUT_OF_RANGE"],
    ["unsupported geometry", Buffer.from(JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "GeometryCollection", geometries: [] } })), "UNSUPPORTED_GEOMETRY"],
    ["a self-crossing polygon", Buffer.from(JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[82.16, 16.86], [82.24, 16.94], [82.24, 16.86], [82.16, 16.94], [82.16, 16.86]]] } })), "SELF_INTERSECTION"],
    ["an unsupported CRS", Buffer.from(JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } }, features: [feat(82.2, 16.9)] })), "UNSUPPORTED_CRS"],
    ["a bad count", gj(feat(82.2, 16.9, { species: "A", count: -3 })), "BAD_PROPERTY"],
    ["an empty collection", gj(), "NO_FEATURES"],
  ];
  const before = [await count("SELECT COUNT(*) AS n FROM evidence"), await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action='GEOSPATIAL_IMPORTED'")];
  for (const [label, buf, code] of cases) {
    const r = await importAs("fieldA", { projectId: S.P.id }, buf); assert.equal(r.status, 422, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.details.validation.errors.some((e) => e.code === code), `${label}: ${JSON.stringify(r.body.details.validation.errors)}`);
  }
  assert.deepEqual([await count("SELECT COUNT(*) AS n FROM evidence"), await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action='GEOSPATIAL_IMPORTED'")], before);
});

test("request-level rules: extension, missing file, size limit, bad parameters, unknown project", async () => {
  assert.equal((await importAs("fieldA", { projectId: S.P.id }, unique(), "survey.json")).status, 400);
  assert.equal((await importAs("fieldA", { projectId: S.P.id }, null)).status, 400);
  assert.equal((await importAs("fieldA", { projectId: S.P.id, source: "LASER" }, unique())).status, 400);
  assert.equal((await importAs("fieldA", { source: "FIELD_SURVEY" }, unique())).status, 400);
  assert.equal((await importAs("fieldA", { projectId: 99999 }, unique())).status, 404);
  const keep = geo.LIMITS.maxBytes; geo.LIMITS.maxBytes = 300;
  try { const r = await importAs("fieldA", { projectId: S.P.id }, gj(...Array.from({ length: 40 }, (_, i) => feat(82.2 + i / 1e5, 16.9)))); assert.equal(r.status, 413); } finally { geo.LIMITS.maxBytes = keep; }
});

test("permissions: only field users of the owning organization can import; the generic upload cannot create or carry GeoJSON", async () => {
  assert.equal((await importAs(null, { projectId: S.P.id }, unique())).status, 401);
  assert.equal((await importAs("verifier", { projectId: S.P.id }, unique())).status, 403);
  assert.equal((await importAs("admin", { projectId: S.P.id }, unique())).status, 403);
  assert.equal((await importAs("fieldB", { projectId: S.P.id }, unique())).status, 403, "other organization");
  assert.equal((await geoPost("verifier", "/geospatial/validate", { projectId: S.P.id, source: "FIELD_SURVEY" }, unique())).status, 403);
  const generic = await env.as("fieldA").upload({ projectId: S.P.id, kind: "DOCUMENT" }, unique(), "x.geojson"); assert.equal(generic.status, 400, "GeoJSON is not accepted by the generic evidence upload");
  const forged = await env.as("fieldA").upload({ projectId: S.P.id, kind: "GEOSPATIAL" }, uniquePng()); assert.equal(forged.status, 400, "the GEOSPATIAL kind cannot be chosen on the generic upload");
  assert.equal((await env.as("fieldA").get("/api/evidence?kind=GEOSPATIAL")).status, 200);
});

test("a project without a configured boundary is not failed against one, and the limitation is stated", async () => {
  const r = await importAs("fieldA", { projectId: S.NB.id }, gj(feat(10.5, 20.5)));
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.validation.boundary.status, "NO_BOUNDARY"); assert.equal(r.body.validation.boundary.checked, false); assert.match(r.body.validation.boundary.message, /not validated/);
  const row = (await db.query("SELECT boundary_status, boundary_checked, inside_fraction FROM geospatial_imports WHERE evidence_id=$1", [r.body.evidence.id])).rows[0];
  assert.deepEqual([row.boundary_status, row.boundary_checked, row.inside_fraction], ["NO_BOUNDARY", false, null]);
});

test("attachment rules follow the record: only the submitter, only while draft or awaiting revision", async () => {
  assert.equal((await importAs("fieldB", { projectId: S.P.id, recordId: S.rec.id }, unique())).status, 403);
  const other = await newRecord("fieldA", S.P.id, { activityDate: "2026-06-05" });
  const mismatched = await importAs("fieldA", { projectId: S.NB.id, recordId: other.id }, gj(feat(1, 1))); assert.equal(mismatched.status, 400, "record of another project");
  const ok = await importAs("fieldA", { projectId: S.P.id, recordId: other.id }, unique()); assert.equal(ok.status, 201);
  const photo = await env.as("fieldA").upload({ projectId: S.P.id, recordId: other.id, kind: "FIELD_PHOTO", captureDate: "2026-06-05", latitude: 16.9, longitude: 82.2 }); assert.equal(photo.status, 201, JSON.stringify(photo.body));
  assert.equal((await env.as("fieldA").post(`/api/records/${other.id}/submit`)).status, 200);
  const late = await importAs("fieldA", { projectId: S.P.id, recordId: other.id }, unique()); assert.equal(late.status, 409, "locked after submission");
});

test("a corrected file supersedes the earlier one atomically; history, hashes and audit entries of the original are kept", async () => {
  const rec = await newRecord("fieldA", S.P.id, { activityDate: "2026-06-10" });
  const v1 = await importAs("fieldA", { projectId: S.P.id, recordId: rec.id }, unique({ count: 1 })); assert.equal(v1.status, 201);
  const v2 = await importAs("fieldA", { projectId: S.P.id, replacesEvidenceId: v1.body.evidence.id }, unique({ count: 2 })); assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal(v2.body.evidence.record_id, rec.id, "the replacement stays on the same record");
  const old = (await db.query("SELECT * FROM evidence WHERE id=$1", [v1.body.evidence.id])).rows[0], neu = (await db.query("SELECT * FROM evidence WHERE id=$1", [v2.body.evidence.id])).rows[0];
  assert.ok(old.superseded_at); assert.equal(neu.supersedes_id, old.id); assert.equal(old.sha256, v1.body.evidence.sha256, "the original hash is untouched");
  assert.equal(await count("SELECT COUNT(*) AS n FROM geospatial_imports WHERE evidence_id=ANY($1)", [[old.id, neu.id]]), 2, "both import records exist");
  assert.equal(await count("SELECT COUNT(*) AS n FROM evidence_reviews WHERE evidence_id=$1 AND decision='SUPERSEDED'", [old.id]), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action='EVIDENCE_REPLACED' AND entity_id=$1", [old.id]), 1);
  assert.equal((await env.as("fieldA").get(`/api/geospatial/imports?recordId=${rec.id}`)).body.imports.length, 1, "only the current version is listed by default");
  assert.equal((await env.as("fieldA").get(`/api/geospatial/imports?recordId=${rec.id}&current=0`)).body.imports.length, 2, "the history is still available");
  assert.equal((await importAs("fieldA", { projectId: S.P.id, replacesEvidenceId: v1.body.evidence.id }, unique({ count: 3 }))).status, 409, "already replaced");
  const photo = await env.as("fieldA").upload({ projectId: S.P.id, recordId: S.rec.id, kind: "FIELD_PHOTO", captureDate: "2026-06-01", latitude: 16.9, longitude: 82.2 });
  assert.equal((await importAs("fieldA", { projectId: S.P.id, replacesEvidenceId: photo.body.evidence.id }, unique())).status, 400, "only geospatial imports can be replaced this way");
});

test("import records are append-only in the database", async () => {
  await assert.rejects(db.query("UPDATE geospatial_imports SET feature_count=999 WHERE id=(SELECT MIN(id) FROM geospatial_imports)"), /append-only/);
  await assert.rejects(db.query("DELETE FROM geospatial_imports"), /append-only/);
  await assert.rejects(db.query("UPDATE evidence SET sha256='00' WHERE id=$1", [S.imp.id]), /immutable/, "the evidence hash is protected by the existing provenance trigger");
});

test("if anything fails inside the import transaction nothing is left behind", async () => {
  const actor = await C.loadActor(db, env.users.fieldA);
  const buf = unique({ count: 77 }); const sha = crypto.createHash("sha256").update(buf).digest("hex");
  await assert.rejects(evidenceSvc.add(actor, { projectId: S.P.id }, { buffer: buf, originalname: "x.geojson", size: buf.length }, { kind: "GEOSPATIAL", allowGeo: true, afterInsert: async () => { throw new Error("simulated failure after insert"); } }), /simulated failure/);
  assert.equal(await count("SELECT COUNT(*) AS n FROM evidence WHERE sha256=$1", [sha]), 0, "the evidence row was rolled back");
  assert.equal(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action='EVIDENCE_UPLOADED' AND details->>'sha256'=$1", [sha]), 0, "and so was its audit entry");
  const retry = await importAs("fieldA", { projectId: S.P.id }, buf); assert.equal(retry.status, 201, "a retry of the same file succeeds");
});

// ───────── species ─────────
test("species: validation, ownership and idempotence", async () => {
  const rec = await newRecord("fieldA", S.P.id, { activityDate: "2026-07-01", measurements: { survival_rate_pct: 80, avg_height_cm: 210, canopy_cover_pct: 55, seedlings_planted: 1000 } });
  const put = (who, body) => env.as(who).put(`/api/records/${rec.id}/species`, body);
  for (const [label, body] of [["not a list", { species: "x" }], ["negative", { species: [{ name: "A", plantedCount: -1 }] }], ["fraction", { species: [{ name: "A", plantedCount: 1.5 }] }], ["string count", { species: [{ name: "A", plantedCount: "5" }] }],
    ["no name", { species: [{ name: " ", plantedCount: 5 }] }], ["unknown unit", { species: [{ name: "A", plantedCount: 5, unit: "tonnes" }] }], ["duplicate names", { species: [{ name: "Avicennia  marina", plantedCount: 5 }, { name: "avicennia marina", plantedCount: 6 }] }],
    ["too many", { species: Array.from({ length: 101 }, (_, i) => ({ name: `S${i}`, plantedCount: 1 })) }], ["huge", { species: [{ name: "A", plantedCount: 1e9 }] }]]) assert.equal((await put("fieldA", body)).status, 400, label);
  assert.equal((await put("fieldB", { species: [{ name: "A", plantedCount: 1 }] })).status, 403, "other organization");
  assert.equal((await put("verifier", { species: [] })).status, 403);
  assert.equal((await env.as("fieldB").get(`/api/records/${rec.id}/species`)).status, 403);
  const list = { species: [{ name: "Rhizophora  mucronata", plantedCount: 600 }, { name: "Avicennia marina", plantedCount: 300, unit: "seedlings" }] };
  const a = await put("fieldA", list); assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.totalPlanted, 900); assert.equal(a.body.measuredSeedlings, 1000); assert.equal(a.body.consistentWithMeasurement, false);
  assert.deepEqual(a.body.species.map((s) => s.name), ["Avicennia marina", "Rhizophora mucronata"], "names are normalised and ordered");
  const audits = () => count("SELECT COUNT(*) AS n FROM audit_logs WHERE action='RECORD_SPECIES_UPDATED' AND record_id=$1", [rec.id]);
  assert.equal(await audits(), 1);
  const again = await put("fieldA", list); assert.equal(again.body.unchanged, true); assert.equal(await audits(), 1, "resending the same list is not a change");
  const fixed = await put("fieldA", { species: [{ name: "Rhizophora mucronata", plantedCount: 700 }, { name: "Avicennia marina", plantedCount: 300 }] }); assert.equal(fixed.body.consistentWithMeasurement, true);
  const log = (await db.query("SELECT details FROM audit_logs WHERE action='RECORD_SPECIES_UPDATED' AND record_id=$1 ORDER BY id DESC LIMIT 1", [rec.id])).rows[0].details;
  assert.equal(log.before.length, 2); assert.equal(log.after.find((x) => x.name === "Rhizophora mucronata").count, 700, "before and after are kept in the audit log");
  S.spRec = rec;
});

test("species: snapshot at submission is hashed and reported; a mismatch with the measurement is an advisory check; the list locks; revision reopens it", async () => {
  const rec = S.spRec;
  await env.as("fieldA").put(`/api/records/${rec.id}/species`, { species: [{ name: "Rhizophora mucronata", plantedCount: 650 }, { name: "Avicennia marina", plantedCount: 300 }] });
  const photo = await env.as("fieldA").upload({ projectId: S.P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: "2026-07-01", latitude: 16.9, longitude: 82.2 }); assert.equal(photo.status, 201, JSON.stringify(photo.body));
  const sub = await env.as("fieldA").post(`/api/records/${rec.id}/submit`); assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const row = (await db.query("SELECT * FROM monitoring_records WHERE id=$1", [rec.id])).rows[0];
  assert.deepEqual(row.species_snapshot, [{ name: "Avicennia marina", count: 300, unit: "plants" }, { name: "Rhizophora mucronata", count: 650, unit: "plants" }]);
  assert.equal(row.report.species.totalPlanted, 950);
  const project = await C.getProject(db, S.P.id), ev = (await db.query("SELECT * FROM evidence WHERE record_id=$1 AND superseded_at IS NULL", [rec.id])).rows;
  assert.equal(row.content_hash, C.contentHashOf(project, row, ev), "the stored hash covers the species list");
  assert.notEqual(C.contentHashOf(project, { ...row, species_snapshot: null }, ev), row.content_hash, "removing the species changes the hash");
  assert.equal("species" in C.recordPayload(project, { ...row, species_snapshot: null }, ev), false, "records without species hash exactly as before");
  assert.equal("species" in C.recordPayload(project, { ...row, species_snapshot: [] }, ev), false);
  const detail = await env.as("verifier").get(`/api/records/${rec.id}`);
  const chk = detail.body.liveChecks.find((c) => c.id === "species_counts"); assert.ok(chk, "check present"); assert.equal(chk.passed, false); assert.equal(chk.blocking, false); assert.match(chk.detail, /species total 950, measurement 1000/);
  assert.equal(detail.body.liveChecks.find((c) => c.id === "integrity").passed, true);
  // locked after submission
  assert.equal((await env.as("fieldA").put(`/api/records/${rec.id}/species`, { species: [{ name: "X", plantedCount: 1 }] })).status, 409);
  await assert.rejects(db.query("INSERT INTO record_species (record_id, species_name, planted_count, created_by) VALUES ($1,'Sneaky',1,$2)", [rec.id, env.users.fieldA]), /locked/);
  await assert.rejects(db.query("DELETE FROM record_species WHERE record_id=$1", [rec.id]), /locked/);
  // revision reopens it, and resubmission refreshes the snapshot while the earlier list stays in the audit log
  assert.equal((await env.as("verifier").post(`/api/records/${rec.id}/start-review`)).status, 200);
  assert.equal((await env.as("verifier").post(`/api/records/${rec.id}/decision`, { decision: "NEEDS_REVISION", comments: "Species counts do not add up to the seedlings measurement." })).status, 200);
  const fix = await env.as("fieldA").put(`/api/records/${rec.id}/species`, { species: [{ name: "Rhizophora mucronata", plantedCount: 700 }, { name: "Avicennia marina", plantedCount: 300 }] }); assert.equal(fix.status, 200, JSON.stringify(fix.body));
  assert.equal((await env.as("fieldA").post(`/api/records/${rec.id}/submit`)).status, 200);
  const row2 = (await db.query("SELECT * FROM monitoring_records WHERE id=$1", [rec.id])).rows[0];
  assert.equal(row2.revision, row.revision + 1); assert.equal(row2.species_snapshot.find((s) => s.name === "Rhizophora mucronata").count, 700); assert.notEqual(row2.content_hash, row.content_hash);
  assert.ok(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action='RECORD_SPECIES_UPDATED' AND record_id=$1", [rec.id]) >= 4, "every edit, including the earlier lists, remains in the audit log");
  const live = await env.as("verifier").get(`/api/records/${rec.id}`); assert.equal(live.body.liveChecks.find((c) => c.id === "species_counts").passed, true);
});
