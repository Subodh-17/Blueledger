// backend/src/services/crypto.js — envelope encryption for evidence files at rest.
//
//   file  --AES-256-GCM(data key, random IV)-->  stored bytes: IV(12) | tag(16) | ciphertext
//   data key --AES-256-GCM(key-encryption key)--> wrapped key stored in the database next to the key id
//
// Key management: key-encryption keys (KEKs) come from the environment or a secret manager, never from the repository:
//   EVIDENCE_KEK_CURRENT  = "<id>:<base64 32 bytes>"     used to wrap new data keys
//   EVIDENCE_KEK_PREVIOUS = "<id>:<base64>,<id>:<base64>" still accepted for unwrapping (rotation window)
// Rotation never rewrites files: rewrapAll() unwraps each data key with its old KEK and wraps it with the current one.
// The GCM additional-authenticated-data binds ciphertext to the plaintext SHA-256 so blobs cannot be swapped between evidence rows.
const crypto = require("crypto");
const cfg = require("../config").encryption;

function parseKey(s) {
  if (!s) return null;
  const i = s.indexOf(":"); const id = s.slice(0, i), key = Buffer.from(s.slice(i + 1), "base64");
  if (!id || key.length !== 32) throw new Error("Evidence key must be '<id>:<base64 of 32 bytes>'");
  return { id, key };
}
const keys = () => {
  const cur = parseKey(cfg.current), prev = (cfg.previous || "").split(",").filter(Boolean).map(parseKey);
  return { current: cur, all: new Map([...(cur ? [cur] : []), ...prev].map((k) => [k.id, k.key])) };
};
const enabled = () => cfg.mode !== "off";
function assertConfigured() { if (enabled() && !keys().current) throw new Error("EVIDENCE_ENCRYPTION is enabled but EVIDENCE_KEK_CURRENT is not set"); }

const wrap = (kek, dk, aad) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", kek, iv); c.setAAD(aad); const ct = Buffer.concat([c.update(dk), c.final()]); return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join("."); };
const unwrap = (kek, w, aad) => { const [iv, tag, ct] = w.split(".").map((x) => Buffer.from(x, "base64")); const d = crypto.createDecipheriv("aes-256-gcm", kek, iv); d.setAAD(aad); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]); };

function encrypt(plain, plainSha256) {
  assertConfigured();
  const { current } = keys(), dk = crypto.randomBytes(32), iv = crypto.randomBytes(12), aad = Buffer.from(plainSha256, "hex");
  const c = crypto.createCipheriv("aes-256-gcm", dk, iv); c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { stored: Buffer.concat([iv, c.getAuthTag(), ct]), keyId: current.id, wrappedKey: wrap(current.key, dk, Buffer.from(current.id)) };
}
function decrypt(stored, { keyId, wrappedKey }, plainSha256) {
  const kek = keys().all.get(keyId);
  if (!kek) throw Object.assign(new Error(`Key ${keyId} is not available: cannot decrypt this evidence`), { code: "KEY_UNAVAILABLE" });
  const dk = unwrap(kek, wrappedKey, Buffer.from(keyId));
  const iv = stored.subarray(0, 12), tag = stored.subarray(12, 28), ct = stored.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", dk, iv); d.setAAD(Buffer.from(plainSha256, "hex")); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
/** Re-wrap every data key under the current KEK. Returns {rewrapped, skipped, failed}. */
async function rewrapAll(db) {
  assertConfigured(); const { current, all } = keys(); const out = { rewrapped: 0, skipped: 0, failed: [] };
  for (const r of (await db.query("SELECT id, enc_key_id, enc_wrapped_key FROM evidence WHERE encrypted")).rows) {
    if (r.enc_key_id === current.id) { out.skipped++; continue; }
    try { const dk = unwrap(all.get(r.enc_key_id), r.enc_wrapped_key, Buffer.from(r.enc_key_id)); await db.query("UPDATE evidence SET enc_key_id=$1, enc_wrapped_key=$2 WHERE id=$3", [current.id, wrap(current.key, dk, Buffer.from(current.id)), r.id]); out.rewrapped++; }
    catch (e) { out.failed.push({ id: r.id, error: e.message }); }
  }
  return out;
}
const generateKey = (id) => `${id}:${crypto.randomBytes(32).toString("base64")}`;
module.exports = { enabled, encrypt, decrypt, rewrapAll, generateKey, assertConfigured };
