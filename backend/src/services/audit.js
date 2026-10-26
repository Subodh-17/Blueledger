// backend/src/services/audit.js — append-only, hash-chained audit log.
// Every entry stores prev_hash and entry_hash = sha256(prev_hash + canonical(entry)), so removal or
// alteration of history is detectable via verifyChain(). The database also blocks UPDATE/DELETE.
const crypto = require("crypto");
const db = require("../db");
const { canonical } = require("../utils/hash");

const LOCK_KEY = 7001;

function entryHash(prev, e) {
  return crypto.createHash("sha256").update((prev || "") + canonical(e)).digest("hex");
}

/**
 * @param client  pg client inside a transaction (so the audit entry commits with the change)
 * @param e {actor, action, entityType, entityId, projectId, recordId, previousStatus, newStatus, details, txHash}
 */
async function record(client, e) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
  const { rows } = await client.query("SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1");
  const prev = rows[0]?.entry_hash || null;
  const createdAt = new Date();
  const body = {
    created_at: createdAt.toISOString(),
    actor_id: e.actor?.id ?? null, actor_name: e.actor?.name ?? "system", actor_role: e.actor?.role ?? "SYSTEM",
    action: e.action, entity_type: e.entityType, entity_id: e.entityId != null ? String(e.entityId) : null,
    project_id: e.projectId ?? null, record_id: e.recordId ?? null,
    previous_status: e.previousStatus ?? null, new_status: e.newStatus ?? null,
    details: e.details || {}, tx_hash: e.txHash ?? null,
  };
  const hash = entryHash(prev, body);
  const { rows: ins } = await client.query(
    `INSERT INTO audit_logs (created_at, actor_id, actor_name, actor_role, action, entity_type, entity_id,
       project_id, record_id, previous_status, new_status, details, tx_hash, prev_hash, entry_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [createdAt, body.actor_id, body.actor_name, body.actor_role, body.action, body.entity_type, body.entity_id,
     body.project_id, body.record_id, body.previous_status, body.new_status, body.details, body.tx_hash, prev, hash]);
  return ins[0].id;
}

/** Recompute the whole chain; returns {ok, entries, firstBadId}. */
async function verifyChain() {
  const { rows } = await db.query("SELECT * FROM audit_logs ORDER BY id");
  let prev = null;
  for (const r of rows) {
    const body = {
      created_at: new Date(r.created_at).toISOString(), actor_id: r.actor_id, actor_name: r.actor_name, actor_role: r.actor_role,
      action: r.action, entity_type: r.entity_type, entity_id: r.entity_id, project_id: r.project_id, record_id: r.record_id,
      previous_status: r.previous_status, new_status: r.new_status, details: r.details, tx_hash: r.tx_hash,
    };
    if (r.prev_hash !== prev || entryHash(prev, body) !== r.entry_hash) return { ok: false, entries: rows.length, firstBadId: Number(r.id) };
    prev = r.entry_hash;
  }
  return { ok: true, entries: rows.length, firstBadId: null };
}

module.exports = { record, verifyChain };
