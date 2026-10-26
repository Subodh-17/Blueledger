// backend/src/services/storage.js — off-chain evidence storage and file inspection.
// Files are stored on local disk (content addressed by SHA-256). Optionally the file is also pinned to IPFS
// (Kubo HTTP API or Pinata). A CID is only recorded when a pin really succeeded; otherwise ipfs_cid stays NULL and
// ipfs_status says whether pinning was not configured or was attempted and failed.
// Only hashes are ever anchored on-chain, never the file itself.
const fs = require("fs");
const path = require("path");
const cfg = require("../config");
const { sha256Hex } = require("../utils/hash");
const crypto = require("./crypto");

fs.mkdirSync(cfg.uploadDir, { recursive: true });

const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff", ".pdf": "application/pdf", ".svg": "image/svg+xml", ".geojson": "application/geo+json" };
const UPLOAD_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".pdf"];

/** File-signature (magic number) check: the content must match the claimed extension. */
function signatureOk(buf, ext) {
  const b = buf;
  if (b.length < 12) return false;
  if (ext === ".png") return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === ".jpg" || ext === ".jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === ".webp") return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  if (ext === ".tif" || ext === ".tiff") return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a);
  if (ext === ".pdf") return b.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ext === ".geojson") { const head = b.subarray(0, 64).toString("utf8").replace(/^\uFEFF/, "").trimStart(); return head.startsWith("{"); } // text: full structure is checked by services/geo.js
  return false;
}

/** Validate type and file signature. @returns {{sha256,ext,mime,size}} | null (extension not allowed) | {error} (content does not match extension) */
function validate(buffer, originalName, { allowSvg = false, allowGeo = false } = {}) {
  const ext = path.extname(originalName || "").toLowerCase();
  const svg = allowSvg && ext === ".svg";
  const geoOk = allowGeo && ext === ".geojson"; // only the geospatial import path may store GeoJSON
  if (!(UPLOAD_EXTS.includes(ext) || svg || geoOk)) return null;
  if (!svg && !signatureOk(buffer, ext)) return { error: "File content does not match its extension" };
  return { sha256: sha256Hex(buffer), ext, mime: MIME_BY_EXT[ext], size: buffer.length };
}

/** Write the file (encrypted when encryption is enabled). Content-addressed by the plaintext SHA-256. */
function store(buffer, info) {
  const enc = crypto.enabled();
  const body = enc ? crypto.encrypt(buffer, info.sha256) : null;
  const bytes = enc ? body.stored : buffer;
  const file = `${info.sha256}${enc ? ".enc" : info.ext}`;
  const full = path.join(cfg.uploadDir, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, bytes, { mode: 0o640 });
  return { file, storedSha256: sha256Hex(bytes), storedSize: bytes.length, encrypted: enc, keyId: body?.keyId || null, wrappedKey: body?.wrappedKey || null, bytes };
}

/** Convenience used by the seeder and tests: validate + store. */
function save(buffer, originalName, opts = {}) {
  const v = validate(buffer, originalName, opts);
  if (!v || v.error) return v;
  const s = store(buffer, v);
  return { ...v, ...s, mime: v.mime };
}

/** Read the original file bytes (decrypting if needed) and verify them against the recorded SHA-256. */
function readStored(row) {
  const raw = fs.readFileSync(pathFor(row.storage_uri));
  let plain;
  try { plain = row.encrypted ? crypto.decrypt(raw, { keyId: row.enc_key_id, wrappedKey: row.enc_wrapped_key }, row.sha256) : raw; }
  catch (e) { throw e.code === "KEY_UNAVAILABLE" ? e : Object.assign(new Error("Stored file failed authenticated decryption (modified or corrupted)"), { code: "INTEGRITY" }); }
  if (row.sha256 && sha256Hex(plain) !== row.sha256) throw Object.assign(new Error("Stored file does not match its recorded content hash"), { code: "INTEGRITY" });
  return plain;
}

const pathFor = (file) => path.resolve(cfg.uploadDir, path.basename(file));
const exists = (file) => !!file && fs.existsSync(pathFor(file));

/** Extract facts that can be read from the file itself. Declared values are compared with these in review checks. */
async function inspect(buffer, mime) {
  const meta = { mime, sizeBytes: buffer.length, extractedAt: new Date().toISOString(), method: "header parser (PNG/JPEG) + exifr@7 (EXIF/GPS)", embeddedCaptureTime: null, embeddedLatitude: null, embeddedLongitude: null, device: null, crs: "EPSG:4326 (WGS 84), as defined by EXIF GPS" };
  if (buffer.length > cfg.inspectMaxBytes) { meta.note = `Metadata extraction skipped: file larger than ${Math.round(cfg.inspectMaxBytes / 1048576)} MB`; return meta; }
  try {
    if (mime === "image/png" && buffer.subarray(12, 16).toString("latin1") === "IHDR") { meta.width = buffer.readUInt32BE(16); meta.height = buffer.readUInt32BE(20); }
    else if (mime === "image/jpeg") {
      for (let i = 2; i + 9 < buffer.length;) {
        if (buffer[i] !== 0xff) break;
        const marker = buffer[i + 1], len = buffer.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) { meta.height = buffer.readUInt16BE(i + 5); meta.width = buffer.readUInt16BE(i + 7); break; }
        i += 2 + len;
      }
    }
    if (mime === "image/jpeg" || mime === "image/tiff") {
      const exifr = require("exifr");
      const t = await Promise.race([exifr.parse(buffer, { gps: true, tiff: true, exif: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("metadata extraction timed out")), 3000))]);
      if (t) {
        const when = t.DateTimeOriginal || t.CreateDate;
        if (when instanceof Date && !Number.isNaN(when.getTime())) meta.embeddedCaptureTime = when.toISOString();
        if (Number.isFinite(t.latitude) && Number.isFinite(t.longitude)) { meta.embeddedLatitude = t.latitude; meta.embeddedLongitude = t.longitude; }
        if (t.Make || t.Model) meta.device = [t.Make, t.Model].filter(Boolean).join(" ").trim();
      }
    }
  } catch (e) { meta.note = "Embedded metadata could not be read"; }
  if (meta.width && meta.height && (meta.width * meta.height > 2e8 || meta.width > 30000 || meta.height > 30000)) meta.warning = "Image dimensions are unusually large";
  return meta;
}

async function pin(buffer, filename) {
  const { provider, apiUrl, pinataJwt } = cfg.ipfs;
  if (provider === "none") return { cid: null, status: "HASHED", ipfsStatus: "NOT_CONFIGURED" };
  try {
    const form = new FormData();
    form.append("file", new Blob([buffer]), filename);
    let res;
    if (provider === "kubo") {
      res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v0/add?pin=true`, { method: "POST", body: form, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`kubo ${res.status}`);
      return { cid: (await res.json()).Hash, status: "PINNED", ipfsStatus: "PINNED" };
    }
    if (provider === "pinata") {
      if (!pinataJwt) throw new Error("PINATA_JWT not set");
      res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", body: form, headers: { Authorization: `Bearer ${pinataJwt}` }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`pinata ${res.status}`);
      return { cid: (await res.json()).IpfsHash, status: "PINNED", ipfsStatus: "PINNED" };
    }
  } catch (e) { console.warn("[storage] IPFS pin failed, keeping local copy only:", e.message); }
  return { cid: null, status: "HASHED", ipfsStatus: "UNAVAILABLE" };
}

/** Reachability probe for the configured IPFS provider (used by the system status page). */
async function ipfsHealth() {
  const { provider, apiUrl } = cfg.ipfs;
  if (provider === "none") return { configured: false, reachable: null, provider };
  if (provider === "pinata") return { configured: !!cfg.ipfs.pinataJwt, reachable: null, provider, note: "Remote service; reachability is checked when pinning" };
  try { const r = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v0/version`, { method: "POST", signal: AbortSignal.timeout(3000) }); return { configured: true, reachable: r.ok, provider }; }
  catch (e) { return { configured: true, reachable: false, provider, error: e.message }; }
}

function storageHealth() {
  try { fs.accessSync(cfg.uploadDir, fs.constants.W_OK); return { writable: true }; } catch (e) { return { writable: false, error: e.message }; }
}

module.exports = { validate, store, readStored, save, inspect, pin, pathFor, exists, ipfsHealth, storageHealth, UPLOAD_EXTS, signatureOk };
