// backend/src/services/records.js — field data -> monitoring -> reporting -> evidence review -> verification (Modules 2 and 4).
//
//   DRAFT -> SUBMITTED -> UNDER_REVIEW -> VERIFIED | REJECTED | NEEDS_REVISION
//   NEEDS_REVISION -> (field user edits) -> SUBMITTED ...
const db = require("../db");
const audit = require("./audit");
const ops = require("./chainOps");
require("./chainHandlers");
const projects = require("./projects");
const { HttpError, validator } = require("../utils/http");
const { hashJSON } = require("../utils/hash");
const page = require("../utils/page");
const notify = require("./notify");
const C = require("./common");

const ACTIVITIES = ["PLANTING", "TRANSPLANTING", "MONITORING_SURVEY", "MAINTENANCE", "HYDROLOGY_RESTORATION"];
const MEASURE_LIMITS = { survival_rate_pct: [0, 100], canopy_cover_pct: [0, 100], avg_height_cm: [0, 3000], seedlings_planted: [0, 1e8],
  sediment_depth_cm: [0, 1000], shoot_density_per_m2: [0, 100000], water_salinity_ppt: [0, 60], dissolved_oxygen_mg_l: [0, 30] };
const DECISIONS = ["VERIFIED", "REJECTED", "NEEDS_REVISION"];
const EDITABLE = ["DRAFT", "NEEDS_REVISION"];

function parseInput(body) {
  const v = validator();
  const out = {
    activityType: v.str(body, "activityType", { oneOf: ACTIVITIES }),
    activityDate: v.date(body, "activityDate"),
    latitude: v.num(body, "latitude", { optional: true, min: -90, max: 90 }),
    longitude: v.num(body, "longitude", { optional: true, min: -180, max: 180 }),
    accuracy: v.num(body, "locationAccuracyM", { optional: true, min: 0, max: 100000 }),
    areaHa: v.num(body, "areaHa", { min: 0.01, max: 1000000 }),
    observations: v.str(body, "observations", { optional: true, max: 4000 }),
  };
  const m = body.measurements == null ? {} : body.measurements;
  const measurements = {};
  if (typeof m !== "object" || Array.isArray(m)) v.errors.measurements = "must be an object";
  else for (const [k, val] of Object.entries(m)) {
    if (val === "" || val == null) continue;
    if (!MEASURE_LIMITS[k]) { v.errors[`measurements.${k}`] = `unknown measurement (allowed: ${Object.keys(MEASURE_LIMITS).join(", ")})`; continue; }
    const n = Number(val);
    if (!Number.isFinite(n) || n < MEASURE_LIMITS[k][0] || n > MEASURE_LIMITS[k][1]) v.errors[`measurements.${k}`] = `must be between ${MEASURE_LIMITS[k].join(" and ")}`;
    else measurements[k] = n;
  }
  v.done();
  return { ...out, measurements };
}

async function linkEvidence(c, rec, ids, actor) {
  if (!Array.isArray(ids) || !ids.length) return;
  const { rows } = await c.query("SELECT id, project_id, record_id, uploader_id FROM evidence WHERE id = ANY($1::int[]) FOR UPDATE", [ids.map(Number)]);
  if (rows.length !== ids.length) throw new HttpError(400, "One or more evidence ids do not exist");
  for (const e of rows) {
    if (e.project_id !== rec.project_id) throw new HttpError(400, `Evidence ${e.id} belongs to a different project`);
    if (e.record_id && e.record_id !== rec.id) throw new HttpError(409, `Evidence ${e.id} is already attached to another record`);
    if (actor.role === C.ROLES.FIELD && e.uploader_id !== actor.id && rec.submitted_by !== actor.id) throw new HttpError(403, "Cannot attach another user's evidence");
  }
  await c.query("UPDATE evidence SET record_id=$1 WHERE id = ANY($2::int[])", [rec.id, ids.map(Number)]);
}

async function create(actor, body) {
  const v = validator();
  const projectId = v.num(body, "projectId", { int: true, min: 1 });
  v.done();
  const input = parseInput(body);
  const project = await C.getProject(db, projectId);
  C.assertProjectAccess(actor, project);
  if (project.status !== "ACTIVE") throw new HttpError(409, "Project is not active");
  if (input.activityDate < String(project.start_date).slice(0, 10)) throw new HttpError(400, "Validation failed", { activityDate: "cannot be before the project start date" });

  const clientRef = body.clientRef == null ? null : String(body.clientRef);
  if (clientRef !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(clientRef)) throw new HttpError(400, "Validation failed", { clientRef: "must be 8-64 characters (letters, digits, - or _)" });
  if (clientRef) { // idempotent creation for offline sync: the same client reference returns the record created earlier
    const prior = (await db.query("SELECT * FROM monitoring_records WHERE submitted_by=$1 AND client_ref=$2", [actor.id, clientRef])).rows[0];
    if (prior) return Object.assign(prior, { duplicate: true });
  }
  const rec = await db.tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO monitoring_records (project_id, submitted_by, activity_type, activity_date, latitude, longitude, location_accuracy_m, area_ha, observations, measurements, client_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [projectId, actor.id, input.activityType, input.activityDate, input.latitude ?? null, input.longitude ?? null, input.accuracy ?? null,
       input.areaHa, input.observations || null, input.measurements, clientRef]);
    const r = rows[0];
    r.code = `MR-${C.pad(r.id, 5)}`;
    await c.query("UPDATE monitoring_records SET code=$1 WHERE id=$2", [r.code, r.id]);
    await linkEvidence(c, r, body.evidenceIds, actor);
    await audit.record(c, { actor, action: "RECORD_CREATED", entityType: "monitoring_record", entityId: r.id, projectId, recordId: r.id, newStatus: "DRAFT",
      details: { code: r.code, activityType: input.activityType, areaHa: input.areaHa } });
    return r;
  });
  return body.submit && !rec.duplicate ? submit(actor, rec.id) : rec;
}

async function update(actor, id, body) {
  const input = parseInput(body);
  return db.tx(async (c) => {
    const r = await C.getRecord(c, id, { lock: true });
    if (r.submitted_by !== actor.id) throw new HttpError(403, "Only the submitter can edit this record");
    if (!EDITABLE.includes(r.status)) throw new HttpError(409, `Record is ${r.status} and can no longer be edited`);
    await c.query(`UPDATE monitoring_records SET activity_type=$1, activity_date=$2, latitude=$3, longitude=$4, location_accuracy_m=$5, area_ha=$6,
      observations=$7, measurements=$8, updated_at=NOW() WHERE id=$9`,
      [input.activityType, input.activityDate, input.latitude ?? null, input.longitude ?? null, input.accuracy ?? null, input.areaHa, input.observations || null, input.measurements, id]);
    await linkEvidence(c, r, body.evidenceIds, actor);
    await audit.record(c, { actor, action: "RECORD_EDITED", entityType: "monitoring_record", entityId: id, projectId: r.project_id, recordId: id,
      previousStatus: r.status, newStatus: r.status, details: { code: r.code } });
    return (await C.getRecord(c, id));
  });
}

/** Structured MRV report generated at submission (the "Reporting" step). */
function buildReport(project, rec, evidence) {
  const m = rec.measurements || {};
  const dist = rec.latitude != null && project.latitude != null ? C.haversineKm(Number(rec.latitude), Number(rec.longitude), Number(project.latitude), Number(project.longitude)) : null;
  const ageYears = Math.max(0, (Date.parse(rec.activity_date) - Date.parse(project.start_date)) / (365.25 * 86400000));
  return {
    generatedAt: new Date().toISOString(),
    indicators: {
      survivalRatePct: m.survival_rate_pct ?? null, canopyCoverPct: m.canopy_cover_pct ?? null, avgHeightCm: m.avg_height_cm ?? null,
      areaHa: Number(rec.area_ha), areaSharePctOfProject: Math.round((Number(rec.area_ha) / Number(project.area_hectares)) * 1000) / 10,
      projectAgeYears: Math.round(ageYears * 100) / 100, distanceFromProjectCentreKm: dist == null ? null : Math.round(dist * 100) / 100,
      evidenceCount: evidence.length, evidenceKinds: [...new Set(evidence.map((e) => e.kind))],
    },
    species: Array.isArray(rec.species_snapshot) ? { list: rec.species_snapshot, totalPlanted: rec.species_snapshot.reduce((n, x) => n + x.count, 0) } : null,
    completeness: { hasGeotag: rec.latitude != null, hasMeasurements: Object.keys(m).length > 0, hasSurvivalRate: m.survival_rate_pct != null, hasObservations: (rec.observations || "").length >= 10, hasEvidence: evidence.length > 0 },
  };
}

async function submit(actor, id) {
  const { rec, project, evidence } = await db.tx(async (c) => {
    const r = await C.getRecord(c, id, { lock: true });
    if (r.submitted_by !== actor.id) throw new HttpError(403, "Only the submitter can submit this record");
    if (!EDITABLE.includes(r.status)) throw new HttpError(409, `Record is ${r.status}; only DRAFT or NEEDS_REVISION records can be submitted`);
    const p = await C.getProject(c, r.project_id);
    if (p.status !== "ACTIVE") throw new HttpError(409, "Project is not active");
    const ev = await C.fromPg(c, "SELECT * FROM evidence WHERE record_id=$1 AND superseded_at IS NULL ORDER BY id", [id]);
    const problems = {};
    if (r.latitude == null || r.longitude == null) problems.location = "geotag (latitude/longitude) is required to submit";
    if (!ev.length) problems.evidence = "attach at least one evidence item (photo, drone imagery or reference)";
    if (Object.keys(problems).length) throw new HttpError(422, "Record is incomplete", problems);
    const isRevision = r.status === "NEEDS_REVISION";
    const revision = isRevision ? r.revision + 1 : r.revision;
    const sp = (await c.query("SELECT species_name AS name, planted_count AS count, unit FROM record_species WHERE record_id=$1 ORDER BY lower(btrim(species_name))", [id])).rows;
    const next = { ...r, revision, species_snapshot: sp.length ? sp : null };
    const report = buildReport(p, next, ev);
    const contentHash = C.contentHashOf(p, next, ev);
    const evidenceRoot = C.evidenceRootOf(ev);
    // Evidence that was reviewed for the previous revision is reset so the new revision is re-reviewed.
    await c.query("INSERT INTO evidence_reviews (evidence_id, reviewer_id, decision, notes, record_revision, content_sha256) SELECT id, NULL, 'RESET', 'Reset for re-review after revision', $2, sha256 FROM evidence WHERE record_id=$1 AND superseded_at IS NULL AND verification_status <> 'PENDING'", [id, revision]);
    await c.query("UPDATE evidence SET verification_status='PENDING', review_notes=NULL, reviewed_by=NULL, reviewed_at=NULL WHERE record_id=$1 AND superseded_at IS NULL", [id]);
    await c.query(`UPDATE monitoring_records SET status='SUBMITTED', revision=$1, submitted_at=NOW(), report=$2, content_hash=$3, evidence_root=$4,
       anchor_status='PENDING', anchor_tx_hash=NULL, species_snapshot=$6, updated_at=NOW() WHERE id=$5`, [revision, report, contentHash, evidenceRoot, id, next.species_snapshot ? JSON.stringify(next.species_snapshot) : null]);
    await c.query("UPDATE projects SET verification_status='PENDING', updated_at=NOW() WHERE id=$1", [p.id]);
    await audit.record(c, { actor, action: isRevision ? "RECORD_RESUBMITTED" : "RECORD_SUBMITTED", entityType: "monitoring_record", entityId: id, projectId: p.id, recordId: id,
      previousStatus: r.status, newStatus: "SUBMITTED", details: { code: r.code, revision, contentHash, evidenceRoot, evidenceCount: ev.length } });
    await notify.toRole(c, "VERIFIER", { type: "RECORD_AWAITING_REVIEW", title: `Record ${r.code} is awaiting review`, body: `${p.code} — revision ${revision}`, href: `#/records/${id}`, entityType: "monitoring_record", entityId: id, severity: "ACTION", dedupeKey: `review:${id}:${revision}` });
    return { rec: { ...next, content_hash: contentHash, evidence_root: evidenceRoot }, project: p, evidence: ev };
  });

  let anchored = true, anchorError = null;
  try { await anchorRecord(actor, id); } catch (e) { anchored = false; anchorError = e.message; }
  const fresh = await C.getRecord(db, id);
  return { ...fresh, anchored, anchorError };
}

/** Anchor (or re-anchor) the submitted record's hashes on-chain. Durable and idempotent; safe to retry. */
async function anchorRecord(actor, id) {
  const r = await C.getRecord(db, id);
  if (r.anchor_status === "ANCHORED") return r;
  if (!["SUBMITTED", "UNDER_REVIEW"].includes(r.status)) throw new HttpError(409, `Record is ${r.status}; nothing to anchor`);
  await projects.ensureChainRegistered(actor, r.project_id);
  await ops.run("RECORD_ANCHOR", `anchor:${r.uuid}:${r.revision}`, { recordId: id, revision: r.revision }, { actor, projectId: r.project_id, recordId: id });
  return C.getRecord(db, id);
}

async function startReview(actor, id) {
  let r = await C.getRecord(db, id);
  if (r.status !== "SUBMITTED") throw new HttpError(409, `Record is ${r.status}; only SUBMITTED records can enter review`);
  if (r.submitted_by === actor.id) throw new HttpError(403, "A verifier cannot review their own submission");
  if (r.anchor_status !== "ANCHORED") r = await anchorRecord(actor, id); // lazy retry; throws 503 if chain is down
  return db.tx(async (c) => {
    const cur = await C.getRecord(c, id, { lock: true });
    if (cur.status !== "SUBMITTED") throw new HttpError(409, `Record is ${cur.status}`);
    await c.query("UPDATE monitoring_records SET status='UNDER_REVIEW', review_started_by=$1, updated_at=NOW() WHERE id=$2", [actor.id, id]);
    await audit.record(c, { actor, action: "REVIEW_STARTED", entityType: "monitoring_record", entityId: id, projectId: cur.project_id, recordId: id,
      previousStatus: "SUBMITTED", newStatus: "UNDER_REVIEW", details: { code: cur.code } });
    return { ...cur, status: "UNDER_REVIEW" };
  });
}

/** Automated completeness / consistency checks shown to the verifier and stored with the decision. */
function runChecks(project, rec, evidence) {
  const m = rec.measurements || {};
  const checks = [];
  const add = (id, label, passed, detail, blocking = true) => checks.push({ id, label, passed: !!passed, blocking, detail });
  const mdef = require("../methodology/definitions").get(project.methodology_version) || require("../methodology/definitions").get(require("../methodology/definitions").DEFAULT_ILLUSTRATIVE);
  const needed = mdef.requiredMeasurements, missingM = needed.filter((k) => m[k] == null);
  add("completeness", "Required fields present (geotag, area, observations and the measurements required by the project's methodology)",
    rec.latitude != null && rec.longitude != null && Number(rec.area_ha) > 0 && (rec.observations || "").length >= 10 && missingM.length === 0,
    `geotag=${rec.latitude != null}, observations>=10 chars=${(rec.observations || "").length >= 10}, required measurements (${needed.join(", ")}): ${missingM.length ? "missing " + missingM.join(", ") : "present"}`);
  const files = evidence.filter((e) => e.sha256);
  add("evidence_present", "At least one evidence file with a content hash", files.length > 0, `${files.length} hashed file(s), ${evidence.length - files.length} reference-only`);
  const unreviewed = evidence.filter((e) => e.verification_status !== "VERIFIED");
  add("evidence_reviewed", "All linked evidence reviewed and accepted", evidence.length > 0 && unreviewed.length === 0,
    unreviewed.length ? `${unreviewed.length} item(s) not accepted: ${unreviewed.map((e) => `${e.code}:${e.verification_status}`).join(", ")}` : "all accepted");
  add("area_consistency", "Reported area does not exceed project area (+5% tolerance)", Number(rec.area_ha) <= Number(project.area_hectares) * 1.05,
    `record ${rec.area_ha} ha vs project ${project.area_hectares} ha`);
  const d = String(rec.activity_date instanceof Date ? rec.activity_date.toISOString() : rec.activity_date).slice(0, 10);
  add("date_consistency", "Activity date is between project start and today", d >= String(project.start_date).slice(0, 10) && Date.parse(d) <= Date.now() + 86400000, `${d} (project start ${String(project.start_date).slice(0, 10)})`);
  if (rec.latitude != null && project.latitude != null) {
    const km = C.haversineKm(Number(rec.latitude), Number(rec.longitude), Number(project.latitude), Number(project.longitude));
    add("location_consistency", "Geotag within 25 km of the project location", km <= 25, `${km.toFixed(2)} km from project centre`);
  } else add("location_consistency", "Geotag within 25 km of the project location", false, "no geotag");
  const far = evidence.filter((e) => e.latitude != null && rec.latitude != null && C.haversineKm(Number(e.latitude), Number(e.longitude), Number(rec.latitude), Number(rec.longitude)) > 5);
  add("evidence_geotag_proximity", "Evidence geotags within 5 km of the record geotag (advisory)", far.length === 0, far.length ? `${far.length} item(s) farther than 5 km` : "ok", false);
  const mism = [];
  for (const e of evidence) {
    const m = e.file_metadata; if (!m) continue;
    if (m.embeddedCaptureTime && e.captured_at && Math.abs(Date.parse(m.embeddedCaptureTime) - Date.parse(e.captured_at)) > 2 * 86400000) mism.push(`${e.code}: embedded capture time differs from the declared date`);
    if (m.embeddedLatitude != null && rec.latitude != null && C.haversineKm(m.embeddedLatitude, m.embeddedLongitude, Number(rec.latitude), Number(rec.longitude)) > 5) mism.push(`${e.code}: embedded location is more than 5 km from the record geotag`);
  }
  const withEmbedded = evidence.filter((e) => e.file_metadata?.embeddedCaptureTime || e.file_metadata?.embeddedLatitude != null).length;
  add("evidence_metadata", "Embedded file metadata agrees with declared evidence details (advisory)", mism.length === 0, mism.length ? mism.join("; ") : `${withEmbedded} of ${evidence.filter((e) => e.sha256).length} file(s) carry embedded capture metadata that could be compared`, false);
  const scanReq = require("../config").scan.policy === "required";
  add("malware_scan", "Every evidence file was scanned and no malware was found", files.every((e) => e.scan_status === "CLEAN"), `${files.filter((e) => e.scan_status === "CLEAN").length} of ${files.length} file(s) scanned clean; others: ${files.filter((e) => e.scan_status !== "CLEAN").map((e) => `${e.code}:${e.scan_status}`).join(", ") || "none"}`, scanReq);
  if (Array.isArray(rec.species_snapshot) && rec.species_snapshot.length && m.seedlings_planted != null) {
    const tot = rec.species_snapshot.reduce((n, x) => n + x.count, 0);
    add("species_counts", "Species planting counts add up to the seedlings-planted measurement (advisory)", tot === Number(m.seedlings_planted), `species total ${tot}, measurement ${m.seedlings_planted}`, false);
  }
  add("integrity", "Stored content hash matches the record as it exists now", C.contentHashOf(project, rec, evidence) === rec.content_hash, "recomputed keccak-256 of canonical record JSON");
  add("anchored_on_chain", "Record hash anchored on-chain", rec.anchor_status === "ANCHORED", `anchor_status=${rec.anchor_status}`);
  return checks;
}

async function decide(actor, id, body) {
  const v = validator();
  const decision = v.str(body, "decision", { oneOf: DECISIONS });
  const comments = v.str(body, "comments", { optional: decision === "VERIFIED", min: 5, max: 2000 });
  v.done();

  const rec = await C.getRecord(db, id);
  if (rec.status !== "UNDER_REVIEW") throw new HttpError(409, `Record is ${rec.status}; only UNDER_REVIEW records can be decided`);
  if (rec.submitted_by === actor.id) throw new HttpError(403, "A verifier cannot decide on their own submission");
  const project = await C.getProject(db, rec.project_id);
  const evidence = await C.fromPg(db, "SELECT * FROM evidence WHERE record_id=$1 AND superseded_at IS NULL ORDER BY id", [id]);
  const checks = runChecks(project, rec, evidence);
  const failed = checks.filter((c) => c.blocking && !c.passed);
  if (decision === "VERIFIED" && failed.length)
    throw new HttpError(422, "Cannot verify: blocking checks failed", { failed: failed.map((f) => ({ id: f.id, detail: f.detail })) });

  const reportHash = hashJSON({ record: rec.uuid, revision: rec.revision, decision, verifierId: actor.id, comments: comments || null, checks: checks.map((c) => [c.id, c.passed]) });
  const out = await ops.run("VERIFICATION", `verify:${rec.uuid}:${rec.revision}`, { recordId: id, decision, reportHash, comments: comments || null, checks, revision: rec.revision, verifierId: actor.id, failedChecks: failed.map((f) => f.id) },
    { actor, projectId: rec.project_id, recordId: id });
  const record = await C.getRecord(db, id);
  const verification = (await db.query("SELECT * FROM verification_records WHERE record_id=$1 AND report_hash=$2", [id, reportHash])).rows[0];
  return { record, verification, checks, tx: out.tx?.txHash ? { txHash: out.tx.txHash, blockNumber: out.tx.blockNumber } : verification?.tx_hash ? { txHash: verification.tx_hash } : null };
}

const LIST_COLS = `SELECT r.*, p.code AS project_code, p.name AS project_name, p.ecosystem_type, p.organization_id, u.name AS submitted_by_name,
  (SELECT COUNT(*) FROM evidence e WHERE e.record_id=r.id)::int AS evidence_count`;
const LIST_FROM = "FROM monitoring_records r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.submitted_by";
const LIST_SQL = `${LIST_COLS} ${LIST_FROM}`;

const SORTS = { code: { sql: "r.code", dir: "ASC" }, date: { sql: "r.activity_date" }, submitted: { sql: "r.submitted_at" }, status: { sql: "r.status", dir: "ASC" }, project: { sql: "p.code", dir: "ASC" } };
async function list(actor, query = {}) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (actor.role === C.ROLES.FIELD) add("p.organization_id=?", actor.organization_id);
  if (query.mine === "1" || query.mine === true) add("r.submitted_by=?", actor.id);
  if (["DRAFT", "SUBMITTED", "UNDER_REVIEW", "VERIFIED", "REJECTED", "NEEDS_REVISION"].includes(query.status)) add("r.status=?", query.status);
  if (Number(query.projectId) > 0) add("r.project_id=?", Number(query.projectId));
  if (query.q) add("(r.code ILIKE ? OR p.code ILIKE ? OR p.name ILIKE ?)", page.like(query.q));
  const pg = page.parse(query, SORTS, "code", "r.id");
  pg.orderBy = pg.sort === "code" ? `r.id ${pg.dir.toUpperCase()}` : pg.orderBy;
  const res = await page.run({ select: LIST_COLS, from: LIST_FROM, where, params }, pg);
  return { records: res.rows, pagination: res.pagination };
}

async function get(actor, id) {
  const rec = (await db.query(`${LIST_SQL} WHERE r.id=$1`, [id])).rows[0];
  if (!rec) throw new HttpError(404, "Record not found");
  C.assertProjectAccess(actor, rec);
  const project = await C.getProject(db, rec.project_id);
  const evidence = (await C.fromPg(db, `SELECT e.id, e.code, e.kind, e.captured_at, e.latitude, e.longitude, e.sha256, e.ipfs_cid, e.processing_status, e.verification_status,
     e.review_notes, e.filename, e.ipfs_status, e.ipfs_attempts, e.ipfs_last_error, e.ipfs_verified_at, e.scan_status, e.encrypted, e.supersedes_id, e.file_metadata, e.captured_at, e.external_ref, e.platform, e.altitude_m, e.data_origin, e.mime_type, e.size_bytes, e.storage_uri FROM evidence e WHERE e.record_id=$1 AND e.superseded_at IS NULL ORDER BY e.id`, [id])).map(require("./evidence").present);
  const verifications = await C.fromPg(db, "SELECT v.*, u.name AS verifier_name FROM verification_records v JOIN users u ON u.id=v.verifier_id WHERE record_id=$1 ORDER BY v.id", [id]);
  const calculations = await C.fromPg(db, "SELECT c.*, u.name AS calculated_by_name, a.name AS approved_by_name FROM carbon_calculations c JOIN users u ON u.id=c.calculated_by LEFT JOIN users a ON a.id=c.approved_by WHERE c.record_id=$1 ORDER BY c.id", [id]);
  const calculation = calculations.find((c) => c.is_current) || null;
  const credit = (await C.fromPg(db, "SELECT * FROM carbon_credits WHERE record_id=$1", [id]))[0] || null;
  const fullEvidence = await C.fromPg(db, "SELECT * FROM evidence WHERE record_id=$1 AND superseded_at IS NULL ORDER BY id", [id]);
  const checks = ["UNDER_REVIEW", "SUBMITTED"].includes(rec.status) ? runChecks(project, rec, fullEvidence) : null;
  const history = await C.fromPg(db, "SELECT * FROM audit_logs WHERE record_id=$1 ORDER BY id", [id]);
  return { record: rec, project, evidence, verifications, calculation, calculations, credit, liveChecks: checks, audit: history };
}

module.exports = { create, update, submit, anchorRecord, startReview, decide, list, get, runChecks, ACTIVITIES, MEASURE_LIMITS };
