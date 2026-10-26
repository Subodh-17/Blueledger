// backend/src/services/common.js — shared helpers.
const { HttpError } = require("../utils/http");
const { hashJSON, bytes32Id } = require("../utils/hash");

const ROLES = { FIELD: "FIELD_USER", VERIFIER: "VERIFIER", ADMIN: "NCCR_ADMIN" };
const ZERO32 = "0x" + "0".repeat(64);
const pad = (n, w) => String(n).padStart(w, "0");

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const fromPg = (c, q, p) => c.query(q, p).then((r) => r.rows);
async function one(c, q, p, notFound = "Not found") {
  const { rows } = await c.query(q, p);
  if (!rows[0]) throw new HttpError(404, notFound);
  return rows[0];
}

async function getProject(c, id, { lock = false } = {}) {
  return one(c, `SELECT * FROM projects WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [id], "Project not found");
}
async function getRecord(c, id, { lock = false } = {}) {
  return one(c, `SELECT * FROM monitoring_records WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [id], "Record not found");
}

/** FIELD_USER may only touch projects of their own organization; verifier/admin see all. */
function assertProjectAccess(actor, project) {
  if (actor.role === ROLES.FIELD && (!actor.organization_id || project.organization_id !== actor.organization_id))
    throw new HttpError(403, "This project belongs to a different organization");
}

async function logChainTx(c, actor, { tx, type, detail, projectId, recordId, payloadHash }) {
  const { rows } = await c.query(
    `INSERT INTO blockchain_transactions (tx_hash, block_num, tx_type, detail, from_addr, gas_used, owner_id, project_id, record_id, chain_id, contract_address, payload_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (tx_hash) DO NOTHING RETURNING id`,
    [tx.txHash, tx.blockNumber, type, detail, tx.from || null, tx.gasUsed || null, actor?.id ?? null, projectId ?? null, recordId ?? null, tx.chainId ?? null, tx.contract ?? null, payloadHash ?? null]);
  return rows[0]?.id ?? null;
}

async function loadActor(c, id) {
  if (!id) return null;
  const { rows } = await c.query("SELECT id, name, role, organization_id, wallet_address FROM users WHERE id=$1", [id]);
  return rows[0] || null;
}

const recordChainId = (rec) => bytes32Id("record", rec.uuid);
const projectChainId = (p) => bytes32Id("project", p.uuid);

/** Hash of the immutable, submitted content of a monitoring record (what is anchored on-chain). */
function recordPayload(project, rec, evidenceRows) {
  const ev = evidenceRows.map((e) => ({ kind: e.kind, sha256: e.sha256 || null, externalRef: e.external_ref || null,
    captureDate: e.captured_at ? new Date(e.captured_at).toISOString() : null })).sort((a, b) => (a.sha256 || a.externalRef || "").localeCompare(b.sha256 || b.externalRef || ""));
  return {
    projectUuid: project.uuid, recordUuid: rec.uuid, revision: rec.revision, activityType: rec.activity_type,
    activityDate: String(rec.activity_date instanceof Date ? rec.activity_date.toISOString() : rec.activity_date).slice(0, 10),
    latitude: rec.latitude == null ? null : Number(rec.latitude), longitude: rec.longitude == null ? null : Number(rec.longitude),
    areaHa: Number(rec.area_ha), observations: rec.observations || "", measurements: rec.measurements, evidence: ev,
    // Added only when a species list was submitted, so the hash of every earlier record is unchanged.
    ...(Array.isArray(rec.species_snapshot) && rec.species_snapshot.length ? { species: rec.species_snapshot } : {}),
  };
}
const contentHashOf = (project, rec, ev) => hashJSON(recordPayload(project, rec, ev));
const evidenceRootOf = (ev) => ev.length ? hashJSON(ev.map((e) => e.sha256 || `ref:${e.external_ref}`).sort()) : ZERO32;
const estimateHashOf = (c) => hashJSON({ uuid: c.uuid, methodology: c.methodology_version, inputs: c.inputs, result: c.result });

module.exports = { loadActor, ROLES, ZERO32, pad, haversineKm, fromPg, one, getProject, getRecord, assertProjectAccess, logChainTx,
  recordChainId, projectChainId, recordPayload, contentHashOf, evidenceRootOf, estimateHashOf };
