// Evidence chain of custody: embedded vs declared metadata, inconsistency detection, immutable provenance, review history, replacement lineage.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeExifJpeg } = require("./helpers/exif");
const { setup, projectBody, recordBody, uniquePng } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");

let env, P, R;
const jpeg = (o) => Buffer.concat([makeExifJpeg(o), Buffer.from(String(Math.random()))]);
const f = () => env.as("fieldA"), v = () => env.as("verifier");
const up = (buf, name = "p.jpg", extra = {}, recordId = R.id) => f().upload({ projectId: P.id, recordId, kind: "FIELD_PHOTO", captureDate: "2026-06-01", latitude: 16.9005, longitude: 82.2005, ...extra }, buf, name);

test.before(async () => {
  cfg.scan.policy = "off"; cfg.ipfs.provider = "none";
  env = await setup();
  P = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a))).body.project;
  R = (await f().post("/api/records", recordBody(P.id))).body.record;
});
test.after(async () => { await env.close(); });

test("embedded EXIF metadata is extracted with its method and kept separate from the declared values", async () => {
  const r = await up(jpeg({ lat: 16.9005, lon: 82.2005, takenAt: "2026:06:01 10:00:00" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body.evidence.file_metadata;
  assert.equal(m.width, 16); assert.equal(m.height, 16);
  assert.ok(Math.abs(m.embeddedLatitude - 16.9005) < 1e-4 && Math.abs(m.embeddedLongitude - 82.2005) < 1e-4);
  assert.match(m.embeddedCaptureTime, /^2026-06-01/);
  assert.match(m.method, /exifr/); assert.match(m.crs, /EPSG:4326/);
  assert.equal(Number(r.body.evidence.latitude), 16.9005, "the declared coordinates remain separate fields");
  assert.equal(r.body.evidence.captured_at.slice(0, 10), "2026-06-01");
  S.good = r.body.evidence;
});
const S = {};

test("inconsistencies between embedded and declared data are flagged for the reviewer (advisory), never treated as proof either way", async () => {
  const far = await up(jpeg({ lat: 10.0, lon: 70.0, takenAt: "2026:06:01 10:00:00" }), "far.jpg");
  const old = await up(jpeg({ lat: 16.9005, lon: 82.2005, takenAt: "2026:01:01 10:00:00" }), "old.jpg");
  assert.equal(far.status, 201); assert.equal(old.status, 201);
  assert.equal((await f().post(`/api/records/${R.id}/submit`)).status, 200);
  assert.equal((await v().post(`/api/records/${R.id}/start-review`)).status, 200);
  const chk = (await v().get(`/api/records/${R.id}`)).body.liveChecks.find((c) => c.id === "evidence_metadata");
  assert.equal(chk.passed, false); assert.equal(chk.blocking, false, "advisory: metadata alone is not proof");
  assert.match(chk.detail, /embedded location is more than 5 km/); assert.match(chk.detail, /embedded capture time differs/);
  assert.ok(!chk.detail.includes(S.good.code), "the consistent item is not flagged");
  S.far = far.body.evidence; S.old = old.body.evidence;
});

test("review decisions are appended to an immutable history tied to the exact file hash", async () => {
  assert.equal((await v().post(`/api/evidence/${S.good.id}/review`, { decision: "VERIFIED" })).status, 200);
  assert.equal((await v().post(`/api/evidence/${S.far.id}/review`, { decision: "NEEDS_REVISION", notes: "Embedded location differs from the plot." })).status, 200);
  const h = (await v().get(`/api/evidence/${S.good.id}/history`)).body;
  assert.equal(h.reviews.length, 1); assert.equal(h.reviews[0].decision, "VERIFIED"); assert.equal(h.reviews[0].content_sha256, S.good.sha256); assert.equal(h.reviews[0].reviewer_name, "verifier");
  await assert.rejects(db.query("UPDATE evidence_reviews SET decision='REJECTED'"), /append-only/);
  await assert.rejects(db.query("DELETE FROM evidence_reviews"), /append-only/);
});

test("content hash, file reference and upload provenance can never be rewritten", async () => {
  await assert.rejects(db.query("UPDATE evidence SET sha256=$1 WHERE id=$2", ["0".repeat(64), S.good.id]), /content hash is immutable/);
  await assert.rejects(db.query("UPDATE evidence SET storage_uri='other.png' WHERE id=$1", [S.good.id]), /file reference is immutable/);
  await assert.rejects(db.query("UPDATE evidence SET uploader_id=$1 WHERE id=$2", [env.users.admin, S.good.id]), /provenance is immutable/);
  await assert.rejects(db.query("UPDATE evidence SET created_at=NOW() - interval '1 year' WHERE id=$1", [S.good.id]), /provenance is immutable/);
  await db.query("UPDATE evidence SET notes='review-time note' WHERE id=$1", [S.good.id]); // non-provenance fields remain editable
});

test("revision, reset and replacement are traceable; superseded files stay on record but leave the live evidence set", async () => {
  const dec = await v().post(`/api/records/${R.id}/decision`, { decision: "NEEDS_REVISION", comments: "Replace the photo with the mismatched location." });
  assert.equal(dec.status, 200);
  const hashBefore = (await f().get(`/api/records/${R.id}`)).body.record.content_hash;
  const rep = await f().upload({ projectId: P.id }, jpeg({ lat: 16.9006, lon: 82.2004, takenAt: "2026:06:01 11:00:00" }), "replacement.jpg", S.far.id);
  void rep; // multipart helper posts to /evidence; use the dedicated replace endpoint below
  const form = new FormData(); form.append("file", new Blob([jpeg({ lat: 16.9006, lon: 82.2004, takenAt: "2026:06:01 11:00:00" })]), "replacement.jpg"); form.append("captureDate", "2026-06-01"); form.append("latitude", "16.9006"); form.append("longitude", "82.2004");
  const res = await fetch(`${env.base}/api/evidence/${S.far.id}/replace`, { method: "POST", headers: { authorization: `Bearer ${env.tokens.fieldA}` }, body: form });
  const body = await res.json(); assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.evidence.supersedes_id, S.far.id);
  const old = (await db.query("SELECT superseded_at FROM evidence WHERE id=$1", [S.far.id])).rows[0]; assert.ok(old.superseded_at);
  assert.equal((await fetch(`${env.base}/api/evidence/${S.far.id}/replace`, { method: "POST", headers: { authorization: `Bearer ${env.tokens.fieldA}` }, body: (() => { const x = new FormData(); x.append("file", new Blob([uniquePng()]), "again.png"); return x; })() })).status, 409, "an item can be replaced only once");
  const live = (await f().get(`/api/records/${R.id}`)).body.evidence.map((e) => e.code);
  assert.ok(!live.includes(S.far.code) && live.includes(body.evidence.code), "the superseded item is no longer part of the record's evidence");
  const hist = (await f().get(`/api/evidence/${S.far.id}/history`)).body;
  assert.ok(hist.reviews.some((r) => r.decision === "SUPERSEDED" && /Replaced by/.test(r.notes)));
  assert.ok(hist.lineage.length >= 2);
  const re = await f().post(`/api/records/${R.id}/submit`); assert.equal(re.status, 200);
  assert.notEqual(re.body.record.content_hash, hashBefore, "the anchored content hash changes when the evidence set changes");
  const resets = (await db.query("SELECT COUNT(*)::int n FROM evidence_reviews WHERE decision='RESET' AND evidence_id=$1", [S.good.id])).rows[0].n;
  assert.equal(resets, 1, "the earlier acceptance is explicitly reset for the new revision (history keeps both entries)");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action='EVIDENCE_REPLACED'")).rows[0].n, 1);
  const stale = await fetch(`${env.base}/api/evidence/${S.good.id}/replace`, { method: "POST", headers: { authorization: `Bearer ${env.tokens.fieldA}` }, body: (() => { const x = new FormData(); x.append("file", new Blob([uniquePng()]), "late.png"); return x; })() });
  assert.equal(stale.status, 409, "no replacement once the record is submitted for review");
});

test("coordinate reference system and capture time are validated", async () => {
  const R2 = (await f().post("/api/records", recordBody(P.id, { activityDate: "2026-07-01" }))).body.record;
  assert.equal((await up(uniquePng(), "a.png", { crs: "EPSG:3857" }, R2.id)).status, 400);
  assert.equal((await up(uniquePng(), "b.png", { crs: "EPSG:4326" }, R2.id)).status, 201);
  assert.equal((await up(uniquePng(), "c.png", { captureDate: "2019-01-01" }, R2.id)).status, 400, "cannot predate the project");
  assert.equal((await up(uniquePng(), "d.png", { captureDate: "2999-01-01" }, R2.id)).status, 400, "cannot be in the future");
  assert.equal((await up(uniquePng(), "e.png", { latitude: 95 }, R2.id)).status, 400);
});
