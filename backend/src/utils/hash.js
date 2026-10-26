// backend/src/utils/hash.js — canonical JSON + hashing helpers used for on-chain anchoring.
const crypto = require("crypto");
const { id: keccak } = require("ethers");

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
const hashJSON = (v) => keccak(canonical(v));          // 0x-prefixed keccak-256 of canonical JSON
const bytes32Id = (kind, uuid) => keccak(`${kind}:${uuid}`); // on-chain identifier for an off-chain entity
const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

module.exports = { canonical, hashJSON, bytes32Id, sha256Hex, keccak };
