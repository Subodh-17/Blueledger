// backend/src/services/ipfs.js — IPFS pinning with verification, bounded retries and truthful status.
//
// States (evidence.ipfs_status):
//   NOT_CONFIGURED  IPFS_PROVIDER=none
//   PENDING         queued, or waiting for the next retry
//   PINNED          the node reported a CID AND the content fetched back by that CID hashes to the stored bytes AND the CID is pinned
//   UNAVAILABLE     the service could not be reached / failed; retried with bounded exponential backoff until IPFS_RETRY_MAX attempts
//   VERIFY_FAILED   the service answered but the content for the CID does not match what was stored (never reported as pinned)
// What is pinned: the bytes exactly as stored locally (ciphertext when encryption at rest is enabled).
const fs = require("fs");
const db = require("../db");
const audit = require("./audit");
const storage = require("./storage");
const cfg = require("../config").ipfs;
const { sha256Hex } = require("../utils/hash");

const base = () => cfg.apiUrl.replace(/\/$/, "");
async function call(path, { body, method = "POST", timeout = cfg.timeoutMs } = {}) {
  const res = await fetch(`${base()}${path}`, { method, body, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`IPFS API ${path.split("?")[0]} returned ${res.status}`);
  return res;
}

async function pinBytes(bytes, filename) {
  if (cfg.provider === "kubo") {
    const form = new FormData(); form.append("file", new Blob([bytes]), filename);
    return (await (await call("/api/v0/add?pin=true&cid-version=1", { body: form })).json()).Hash;
  }
  if (cfg.provider === "pinata") {
    if (!cfg.pinataJwt) throw new Error("PINATA_JWT not set");
    const form = new FormData(); form.append("file", new Blob([bytes]), filename);
    const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", body: form, headers: { Authorization: `Bearer ${cfg.pinataJwt}` }, signal: AbortSignal.timeout(cfg.timeoutMs * 2) });
    if (!r.ok) throw new Error(`pinata ${r.status}`);
    return (await r.json()).IpfsHash;
  }
  throw new Error("IPFS is not configured");
}
/** Fetch the content back by CID and return its SHA-256 (the proof that the node holds the expected bytes). */
async function fetchHash(cid, maxBytes) {
  let res;
  if (cfg.provider === "kubo") res = await call(`/api/v0/cat?arg=${encodeURIComponent(cid)}`);
  else if (cfg.gatewayUrl) { res = await fetch(`${cfg.gatewayUrl.replace(/\/$/, "")}/ipfs/${encodeURIComponent(cid)}`, { signal: AbortSignal.timeout(cfg.timeoutMs * 2) }); if (!res.ok) throw new Error(`gateway ${res.status}`); }
  else throw new Error("No way to read content back: set IPFS_GATEWAY_URL for this provider");
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes * 2) throw new Error("content larger than expected");
  return sha256Hex(buf);
}
async function isPinned(cid) {
  if (cfg.provider !== "kubo") return true; // remote services pin on add; verification by fetch is the check
  try { const j = await (await call(`/api/v0/pin/ls?arg=${encodeURIComponent(cid)}&type=all`)).json(); return !!j.Keys?.[cid]; } catch { return false; }
}

const backoffMs = (attempts) => Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** Math.max(0, attempts - 1)) * (0.75 + Math.random() * 0.5);

/** Try to pin + verify one evidence item. Never throws; records the truthful outcome. */
async function attempt(id) {
  if (cfg.provider === "none") return { status: "NOT_CONFIGURED" };
  const e = (await db.query("SELECT * FROM evidence WHERE id=$1", [id])).rows[0];
  if (!e || !e.storage_uri || !storage.exists(e.storage_uri)) return { status: "SKIPPED" };
  const bytes = fs.readFileSync(storage.pathFor(e.storage_uri));
  const expected = e.stored_sha256 || sha256Hex(bytes);
  const attempts = e.ipfs_attempts + 1;
  try {
    const cid = await pinBytes(bytes, e.storage_uri);
    const got = await fetchHash(cid, bytes.length);
    if (got !== expected) {
      await db.query("UPDATE evidence SET ipfs_status='VERIFY_FAILED', ipfs_cid=NULL, ipfs_attempts=$2, ipfs_last_error=$3, ipfs_next_retry_at=NULL WHERE id=$1", [id, attempts, `content for ${cid} hashes to ${got}, expected ${expected}`]);
      await db.tx((c) => audit.record(c, { action: "EVIDENCE_IPFS_VERIFY_FAILED", entityType: "evidence", entityId: id, projectId: e.project_id, recordId: e.record_id, details: { code: e.code, cid, expected, got } }));
      return { status: "VERIFY_FAILED", cid };
    }
    if (!(await isPinned(cid))) throw new Error("the node did not report the CID as pinned");
    await db.query("UPDATE evidence SET ipfs_status='PINNED', ipfs_cid=$2, ipfs_attempts=$3, ipfs_last_error=NULL, ipfs_next_retry_at=NULL, ipfs_verified_at=NOW(), processing_status='PINNED' WHERE id=$1", [id, cid, attempts]);
    return { status: "PINNED", cid };
  } catch (err) {
    const exhausted = attempts >= cfg.retryMax;
    await db.query(`UPDATE evidence SET ipfs_status='UNAVAILABLE', ipfs_attempts=$2, ipfs_last_error=$3, ipfs_next_retry_at=${exhausted ? "NULL" : "NOW() + ($4 || ' milliseconds')::interval"} WHERE id=$1`,
      exhausted ? [id, attempts, String(err.message).slice(0, 300)] : [id, attempts, String(err.message).slice(0, 300), String(Math.round(backoffMs(attempts)))]);
    return { status: "UNAVAILABLE", error: err.message, attempts, exhausted };
  }
}

/** Process due items (called by the background worker and on demand). */
async function processPending({ limit = 20, force = false } = {}) {
  if (cfg.provider === "none") return { processed: 0 };
  const rows = (await db.query(`SELECT id FROM evidence WHERE storage_uri IS NOT NULL AND ipfs_status IN ('PENDING','UNAVAILABLE') AND ipfs_attempts < $1 AND ($2 OR ipfs_next_retry_at IS NULL OR ipfs_next_retry_at <= NOW()) ORDER BY id LIMIT $3`, [cfg.retryMax, force, limit])).rows;
  const out = { processed: rows.length, pinned: 0, unavailable: 0, verifyFailed: 0 };
  for (const r of rows) { const a = await attempt(r.id); if (a.status === "PINNED") out.pinned++; else if (a.status === "VERIFY_FAILED") out.verifyFailed++; else out.unavailable++; }
  return out;
}
const backlog = async () => (await db.query("SELECT COUNT(*) FILTER (WHERE ipfs_status='PENDING')::int AS pending, COUNT(*) FILTER (WHERE ipfs_status='UNAVAILABLE')::int AS unavailable, COUNT(*) FILTER (WHERE ipfs_status='VERIFY_FAILED')::int AS verify_failed FROM evidence")).rows[0];
module.exports = { attempt, processPending, backlog, backoffMs, pinBytes, fetchHash };
