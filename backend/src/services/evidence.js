// backend/src/services/evidence.js — field photos, drone imagery, remote-sensing references and documents.
// Facts read from the file itself (type, size, image dimensions, embedded capture time/location when present) are stored
// as file_metadata and compared with the declared values during review. No image-analysis model is used: the content hash is an
// integrity identifier for the file, not evidence that what it shows is true.
const db = require("../db");
const audit = require("./audit");
const storage = require("./storage");
const scanner = require("./scanner");
const ipfs = require("./ipfs");
const notify = require("./notify");
const cfgAll = require("../config");
const page = require("../utils/page");
const { HttpError, validator } = require("../utils/http");
const C = require("./common");

const KINDS = ["FIELD_PHOTO", "DRONE_IMAGERY", "REMOTE_SENSING", "DOCUMENT"]; // kinds a user may choose on the generic upload
const ALL_KINDS = [...KINDS, "GEOSPATIAL"]; // GEOSPATIAL is created only by the validating import in services/geospatial.js
const DECISIONS = ["VERIFIED", "REJECTED", "NEEDS_REVISION"];

// options (internal callers only): kind forces the kind, allowGeo admits a .geojson file, afterInsert(c, row) runs inside the same transaction as the insert.
async function add(actor, body, file, { allowSvg = false, origin = "USER_ENTERED", kind: forcedKind, allowGeo = false, afterInsert } = {}) {
  const v = validator();
  const projectId = v.num(body, "projectId", { int: true, min: 1 });
  const kind = forcedKind || v.str(body, "kind", { oneOf: KINDS });
  const capturedAt = v.date(body, "captureDate", { optional: true });
  const latitude = v.num(body, "latitude", { optional: true, min: -90, max: 90 });
  const longitude = v.num(body, "longitude", { optional: true, min: -180, max: 180 });
  const altitude = v.num(body, "altitudeM", { optional: true, min: 0, max: 20000 });
  const platform = v.str(body, "platform", { optional: true, max: 100 });
  const notes = v.str(body, "notes", { optional: true, max: 1000 });
  const externalRef = v.str(body, "externalRef", { optional: true, max: 500 });
  const recordId = body.recordId ? v.num(body, "recordId", { int: true, min: 1 }) : undefined;
  const crs = v.str(body, "crs", { optional: true, max: 20 });
  if (crs && crs.toUpperCase() !== "EPSG:4326") v.errors.crs = "only WGS 84 (EPSG:4326) latitude/longitude coordinates are supported";
  if (!file && !externalRef) v.errors.file = "upload a file or provide an evidence reference";
  v.done();

  const project = await C.getProject(db, projectId);
  C.assertProjectAccess(actor, project);
  if (project.status !== "ACTIVE") throw new HttpError(409, "Project is not active");
  if (capturedAt && capturedAt < String(project.start_date).slice(0, 10)) throw new HttpError(400, "Validation failed", { captureDate: "cannot be before the project start date" });
  if (recordId) {
    const record = await C.getRecord(db, recordId);
    if (record.project_id !== projectId) throw new HttpError(400, "Record belongs to a different project");
    if (!["DRAFT", "NEEDS_REVISION"].includes(record.status)) throw new HttpError(409, `Evidence can only be attached while the record is a draft or awaiting revision (is ${record.status})`);
    if (actor.role === C.ROLES.FIELD && record.submitted_by !== actor.id) throw new HttpError(403, "Only the record's submitter can attach evidence");
  }

  let saved = null, pin = { cid: null, status: "REFERENCE_ONLY", ipfsStatus: "NOT_CONFIGURED" }, meta = null, scan = { status: "NOT_SCANNED" };
  if (file) {
    const v2 = storage.validate(file.buffer, file.originalname, { allowSvg, allowGeo });
    if (!v2) throw new HttpError(400, `Unsupported file type. Allowed: ${storage.UPLOAD_EXTS.join(", ")}`);
    if (v2.error) throw new HttpError(400, v2.error);
    // Storage quota (per organization), before anything is written.
    const used = Number((await db.query("SELECT COALESCE(SUM(e.size_bytes),0) AS s FROM evidence e JOIN projects p ON p.id=e.project_id WHERE p.organization_id=$1", [project.organization_id])).rows[0].s);
    if (used + file.buffer.length > cfgAll.orgQuotaBytes) throw new HttpError(413, `Evidence storage quota exceeded for this organization (${Math.round(used / 1048576)} MB used of ${Math.round(cfgAll.orgQuotaBytes / 1048576)} MB)`);
    // Malware scan of the exact bytes, before they are stored. Infected files are never stored.
    scan = allowSvg ? { status: "NOT_SCANNED" } : await scanner.scan(file.buffer);
    if (scan.status === "INFECTED") {
      await db.tx((c) => audit.record(c, { actor, action: "EVIDENCE_REJECTED_MALWARE", entityType: "evidence", projectId, recordId: recordId || null, details: { filename: file.originalname?.slice(0, 120), sha256: v2.sha256, signature: scan.signature, engine: scan.engine } }));
      throw new HttpError(422, `The file was rejected by malware scanning (${scan.signature})`);
    }
    if (scanner.policy() === "required" && scan.status !== "CLEAN") throw new HttpError(503, `Malware scanning is required but unavailable (${scan.detail || scan.status}); the upload was refused and nothing was stored`);
    meta = await storage.inspect(file.buffer, v2.mime);
    const st = storage.store(file.buffer, v2);
    saved = { ...v2, ...st };
    pin = { cid: null, status: "HASHED", ipfsStatus: cfgAll.ipfs.provider === "none" ? "NOT_CONFIGURED" : "PENDING" }; // pinning happens after the upload is stored, and is only reported once verified
  }

  return db.tx(async (c) => {
    if (saved) {
      const dup = await C.fromPg(c, "SELECT code FROM evidence WHERE sha256=$1 AND project_id=$2", [saved.sha256, projectId]);
      if (dup.length) throw new HttpError(409, `This exact file is already registered as ${dup[0].code} for this project`, { duplicateOf: dup[0].code });
    }
    const { rows } = await c.query(
      `INSERT INTO evidence (project_id, record_id, uploader_id, filename, storage_uri, ipfs_cid, ipfs_status, kind, latitude, longitude, captured_at,
         sha256, mime_type, size_bytes, external_ref, platform, altitude_m, notes, processing_status, data_origin, file_metadata, metadata_extracted_at,
         scan_status, scan_engine, scanned_at, encrypted, enc_key_id, enc_wrapped_key, stored_sha256, stored_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *`,
      [projectId, recordId || null, actor.id, file?.originalname?.slice(0, 250) || null, saved?.file || null, pin.cid, pin.ipfsStatus, kind, latitude ?? null, longitude ?? null,
       capturedAt ? (capturedAt.includes('T') ? capturedAt : capturedAt + 'T00:00:00Z') : null, saved?.sha256 || null, saved?.mime || null, saved?.size || null, externalRef || null, platform || null, altitude ?? null,
       notes || null, pin.status, origin, meta, meta ? new Date() : null,
       scan.status === "CLEAN" ? "CLEAN" : scan.status === "SCAN_UNAVAILABLE" ? "SCAN_UNAVAILABLE" : scan.status === "SCAN_ERROR" ? "SCAN_ERROR" : "NOT_SCANNED", scan.engine || null, scan.status === "CLEAN" ? new Date() : null,
       !!saved?.encrypted, saved?.keyId || null, saved?.wrappedKey || null, saved?.storedSha256 || null, saved?.storedSize || null]);
    const e = rows[0];
    const code = `EV-${C.pad(e.id, 5)}`;
    await c.query("UPDATE evidence SET code=$1 WHERE id=$2", [code, e.id]);
    e.code = code;
    if (afterInsert) await afterInsert(c, e);
    if (cfgAll.ipfs.provider !== "none" && saved) setImmediate(() => ipfs.attempt(e.id).catch(() => {}));
    await audit.record(c, { actor, action: "EVIDENCE_UPLOADED", entityType: "evidence", entityId: e.id, projectId, recordId: recordId || null, newStatus: "PENDING",
      details: { code, kind, filename: e.filename, sha256: e.sha256, ipfsCid: e.ipfs_cid, ipfsStatus: e.ipfs_status, referenceOnly: !file } });
    return e;
  });
}

const COLS = `e.id, e.code, e.project_id, e.record_id, e.filename, e.kind, e.captured_at, e.latitude, e.longitude, e.sha256, e.ipfs_cid, e.ipfs_status, e.mime_type, e.size_bytes,
  e.external_ref, e.platform, e.altitude_m, e.notes, e.processing_status, e.verification_status, e.file_metadata, e.review_notes, e.reviewed_at, e.data_origin, e.created_at, e.scan_status, e.scan_engine, e.scanned_at, e.encrypted, e.stored_sha256,
  e.storage_uri, e.enc_key_id, e.enc_wrapped_key, p.code AS project_code, p.name AS project_name, r.code AS record_code, u.name AS uploader_name, rv.name AS reviewer_name`;
const FROM = `FROM evidence e JOIN projects p ON p.id=e.project_id JOIN users u ON u.id=e.uploader_id LEFT JOIN users rv ON rv.id=e.reviewed_by LEFT JOIN monitoring_records r ON r.id=e.record_id`;
const SORTS = { created: { sql: "e.created_at" }, code: { sql: "e.code", dir: "ASC" }, kind: { sql: "e.kind", dir: "ASC" }, status: { sql: "e.verification_status", dir: "ASC" }, captured: { sql: "e.captured_at" } };

/** storage_status: where the bytes are, as far as this server can tell. */
function present(row) {
  const out = { ...row, has_file: !!row.storage_uri };
  delete out.enc_key_id; delete out.enc_wrapped_key;
  out.storage_status = !row.storage_uri ? "REFERENCE_ONLY" : storage.exists(row.storage_uri) ? "STORED" : "MISSING";
  delete out.storage_uri;
  return out;
}

async function list(actor, query = {}) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (actor.role === C.ROLES.FIELD) add("p.organization_id=?", actor.organization_id);
  if (Number(query.projectId) > 0) add("e.project_id=?", Number(query.projectId));
  if (Number(query.recordId) > 0) add("e.record_id=?", Number(query.recordId));
  if (DECISIONS.concat("PENDING").includes(query.status)) add("e.verification_status=?", query.status);
  if (ALL_KINDS.includes(query.kind)) add("e.kind=?", query.kind);
  if (query.q) add("(e.code ILIKE ? OR e.filename ILIKE ? OR e.sha256 ILIKE ?)", page.like(query.q));
  const pg = page.parse(query, SORTS, "created", "e.id");
  const r = await page.run({ select: `SELECT ${COLS}`, from: FROM, where, params }, pg);
  return { evidence: r.rows.map(present), pagination: r.pagination };
}

async function get(actor, id) {
  const { rows } = await db.query(`SELECT ${COLS} ${FROM} WHERE e.id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Evidence not found");
  C.assertProjectAccess(actor, await C.getProject(db, rows[0].project_id));
  return { ...present(rows[0]), storage_uri: rows[0].storage_uri, enc_key_id: rows[0].enc_key_id, enc_wrapped_key: rows[0].enc_wrapped_key, encrypted: rows[0].encrypted, sha256: rows[0].sha256 };
}

async function review(actor, id, body) {
  const v = validator();
  const decision = v.str(body, "decision", { oneOf: DECISIONS });
  const notes = v.str(body, "notes", { optional: decision === "VERIFIED", min: 5, max: 1000 });
  v.done();
  return db.tx(async (c) => {
    const e = await C.one(c, "SELECT * FROM evidence WHERE id=$1 FOR UPDATE", [id], "Evidence not found");
    if (!e.record_id) throw new HttpError(409, "Evidence is not attached to a monitoring record");
    const rec = await C.getRecord(c, e.record_id);
    if (rec.status !== "UNDER_REVIEW") throw new HttpError(409, `Evidence can only be reviewed while its record is under review (is ${rec.status})`);
    if (rec.submitted_by === actor.id) throw new HttpError(403, "A verifier cannot review their own submission");
    await c.query("UPDATE evidence SET verification_status=$1, review_notes=$2, reviewed_by=$3, reviewed_at=NOW() WHERE id=$4", [decision, notes || null, actor.id, id]);
    await c.query("INSERT INTO evidence_reviews (evidence_id, reviewer_id, decision, notes, record_revision, content_sha256) VALUES ($1,$2,$3,$4,$5,$6)", [id, actor.id, decision, notes || null, rec.revision, e.sha256]);
    await audit.record(c, { actor, action: "EVIDENCE_REVIEWED", entityType: "evidence", entityId: id, projectId: e.project_id, recordId: e.record_id, previousStatus: e.verification_status, newStatus: decision, details: { code: e.code, notes: notes || null } });
    await notify.create(c, [rec.submitted_by], { type: `EVIDENCE_${decision}`, title: decision === "VERIFIED" ? `Evidence ${e.code} was accepted` : decision === "REJECTED" ? `Evidence ${e.code} was rejected` : `Revision requested for evidence ${e.code}`, body: notes || undefined, href: `#/records/${e.record_id}`, entityType: "evidence", entityId: id, severity: decision === "VERIFIED" ? "INFO" : "ACTION", dedupeKey: `evidence:${id}:${rec.revision}:${decision}` });
    return { ...e, verification_status: decision };
  });
}

/** Re-read facts from the stored file (for example after an inspection failure at upload time). */
async function extractMetadata(actor, id) {
  const e = await C.one(db, "SELECT * FROM evidence WHERE id=$1", [id], "Evidence not found");
  if (!e.storage_uri || !storage.exists(e.storage_uri)) throw new HttpError(409, "No stored file is available for this evidence item");
  const meta = await storage.inspect(storage.readStored(e), e.mime_type);
  await db.tx(async (c) => {
    await c.query("UPDATE evidence SET file_metadata=$1, metadata_extracted_at=NOW() WHERE id=$2", [meta, id]);
    await audit.record(c, { actor, action: "EVIDENCE_METADATA_EXTRACTED", entityType: "evidence", entityId: id, projectId: e.project_id, recordId: e.record_id, details: { code: e.code } });
  });
  return meta;
}

/** Scan stored evidence that was accepted while the scanner was unavailable. */
async function rescan(actor, id) {
  const e = await C.one(db, "SELECT * FROM evidence WHERE id=$1", [id], "Evidence not found");
  if (!e.storage_uri || !storage.exists(e.storage_uri)) throw new HttpError(409, "No stored file is available for this evidence item");
  const r = await scanner.scan(storage.readStored(e));
  if (r.status === "INFECTED") {
    await db.tx(async (c) => { await c.query("UPDATE evidence SET verification_status='REJECTED', review_notes=$2, reviewed_at=NOW(), scan_status='SCAN_ERROR' WHERE id=$1", [id, `Rejected: malware signature ${r.signature}`]);
      await audit.record(c, { actor, action: "EVIDENCE_MALWARE_DETECTED", entityType: "evidence", entityId: id, projectId: e.project_id, recordId: e.record_id, previousStatus: e.verification_status, newStatus: "REJECTED", details: { code: e.code, signature: r.signature } }); });
    throw new HttpError(422, `Malware detected (${r.signature}); the evidence item was rejected`);
  }
  await db.tx(async (c) => { await c.query("UPDATE evidence SET scan_status=$1::varchar, scan_engine=$2, scanned_at=CASE WHEN $1::varchar='CLEAN' THEN NOW() ELSE scanned_at END WHERE id=$3", [r.status, r.engine || null, id]);
    await audit.record(c, { actor, action: "EVIDENCE_RESCANNED", entityType: "evidence", entityId: id, projectId: e.project_id, recordId: e.record_id, details: { code: e.code, result: r.status } }); });
  return r;
}

/** Replace an evidence item while its record is still editable. The old item is kept (superseded), never overwritten or deleted. */
async function replace(actor, oldId, body, file) {
  const old = await C.one(db, "SELECT * FROM evidence WHERE id=$1", [oldId], "Evidence not found");
  if (old.superseded_at) throw new HttpError(409, "This evidence item was already replaced");
  if (!old.record_id) throw new HttpError(409, "Only evidence attached to a record can be replaced");
  const created = await add(actor, { ...body, projectId: old.project_id, recordId: old.record_id, kind: body.kind || old.kind }, file);
  await db.tx(async (c) => {
    await c.query("UPDATE evidence SET supersedes_id=$1 WHERE id=$2", [oldId, created.id]);
    await c.query("UPDATE evidence SET superseded_at=NOW(), verification_status='PENDING' WHERE id=$1", [oldId]);
    await c.query("INSERT INTO evidence_reviews (evidence_id, reviewer_id, decision, notes, content_sha256) VALUES ($1,$2,'SUPERSEDED',$3,$4)", [oldId, actor.id, `Replaced by ${created.code}`, old.sha256]);
    await audit.record(c, { actor, action: "EVIDENCE_REPLACED", entityType: "evidence", entityId: oldId, projectId: old.project_id, recordId: old.record_id, details: { replacedBy: created.code, previousSha256: old.sha256 } });
  });
  return { ...created, supersedes_id: oldId };
}
async function history(actor, id) {
  const e = await get(actor, id);
  const reviews = (await db.query("SELECT r.*, u.name AS reviewer_name FROM evidence_reviews r LEFT JOIN users u ON u.id=r.reviewer_id WHERE evidence_id=$1 ORDER BY r.id", [id])).rows;
  const lineage = (await db.query("SELECT code, sha256, created_at, superseded_at FROM evidence WHERE id=$1 OR supersedes_id=$1 OR id=(SELECT supersedes_id FROM evidence WHERE id=$1) ORDER BY id", [id])).rows;
  return { evidence: { id: e.id, code: e.code, sha256: e.sha256, uploaded_at: e.created_at, uploader: e.uploader_name }, reviews, lineage };
}

module.exports = { replace, history, rescan, add, list, get, review, extractMetadata, present, KINDS, ALL_KINDS };
