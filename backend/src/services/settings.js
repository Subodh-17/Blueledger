// backend/src/services/settings.js — runtime configuration that is safe to change without a restart.
// Only settings listed here can be changed. Each has a type, bounds and an explanation; changes require a reason, are audited and kept in
// app_settings_history. Secrets (keys, tokens, passwords, connection strings) are deliberately NOT settings and are never returned.
const db = require("../db");
const cfg = require("../config");
const audit = require("./audit");
const { HttpError } = require("../utils/http");

const DEFS = {
  "rateLimit.max": { type: "int", min: 60, max: 100000, def: () => cfg.rateLimit.max, label: "API requests per client per minute", apply: (v) => { cfg.rateLimit.max = v; } },
  "rateLimit.authMax": { type: "int", min: 3, max: 1000, def: () => cfg.rateLimit.authMax, label: "Sign-in and recovery requests per client per minute", apply: (v) => { cfg.rateLimit.authMax = v; } },
  "rateLimit.uploadMax": { type: "int", min: 5, max: 5000, def: () => cfg.rateLimit.uploadMax, label: "Evidence uploads per client per minute", apply: (v) => { cfg.rateLimit.uploadMax = v; } },
  "evidence.maxUploadMb": { type: "int", min: 1, max: 100, def: () => Math.round(cfg.maxUploadBytes / 1048576), label: "Maximum size of one evidence file (MB)", apply: (v) => { cfg.runtimeMaxUploadBytes = v * 1048576; } },
  "evidence.orgQuotaMb": { type: "int", min: 10, max: 1048576, def: () => Math.round(cfg.orgQuotaBytes / 1048576), label: "Evidence storage quota per organization (MB)", apply: (v) => { cfg.orgQuotaBytes = v * 1048576; } },
  "scan.policy": { type: "enum", values: ["off", "optional", "required"], def: () => cfg.scan.policy, label: "Malware scanning policy", apply: (v) => { cfg.scan.policy = v; }, guard: (v) => { if (cfg.isProd && v === "off") throw new HttpError(422, "Malware scanning cannot be switched off in production"); } },
  "chain.confirmations": { type: "int", min: 1, max: 64, def: () => cfg.chain.confirmations, label: "Block confirmations required before an operation is treated as confirmed", apply: (v) => { cfg.chain.confirmations = v; } },
  "chain.dropGraceMs": { type: "int", min: 1000, max: 3600000, def: () => cfg.chain.dropGraceMs, label: "Time before a vanished transaction is re-submitted (ms)", apply: (v) => { cfg.chain.dropGraceMs = v; } },
  "ipfs.retryMax": { type: "int", min: 1, max: 20, def: () => cfg.ipfs.retryMax, label: "Maximum IPFS pinning attempts per file", apply: (v) => { cfg.ipfs.retryMax = v; } },
  "alerts.backlogSeconds": { type: "int", min: 60, max: 86400, def: () => cfg.alertBacklogSeconds, label: "Raise an alert when an unfinished blockchain operation is older than (seconds)", apply: (v) => { cfg.alertBacklogSeconds = v; } },
};
const parse = (d, raw) => {
  if (d.type === "int") { const n = Number(raw); if (!Number.isInteger(n) || n < d.min || n > d.max) throw new HttpError(400, "Validation failed", { value: `must be a whole number between ${d.min} and ${d.max}` }); return n; }
  if (!d.values.includes(raw)) throw new HttpError(400, "Validation failed", { value: `must be one of ${d.values.join(", ")}` });
  return raw;
};
const defaults = {};
const snap = () => { for (const [k, d] of Object.entries(DEFS)) if (!(k in defaults)) defaults[k] = d.def(); }; // remember the built-in defaults before any override is applied
async function load() {
  snap();
  for (const r of (await db.query("SELECT key, value FROM app_settings")).rows) { const d = DEFS[r.key]; if (d) { try { d.apply(parse(d, r.value)); } catch { /* ignore invalid stored value */ } } }
}
async function list() {
  snap();
  const rows = Object.fromEntries((await db.query("SELECT s.key, s.value, s.updated_at, u.name AS updated_by FROM app_settings s LEFT JOIN users u ON u.id=s.updated_by")).rows.map((r) => [r.key, r]));
  return Object.entries(DEFS).map(([key, d]) => ({ key, label: d.label, type: d.type, min: d.min, max: d.max, values: d.values, value: d.def(), default: defaults[key] ?? d.def(), source: rows[key] ? "override" : "default", changedBy: rows[key]?.updated_by || null, changedAt: rows[key]?.updated_at || null }));
}
async function set(actor, key, raw, reason) {
  snap();
  const d = DEFS[key]; if (!d) throw new HttpError(404, "Unknown or non-configurable setting");
  if (typeof reason !== "string" || reason.trim().length < 5) throw new HttpError(400, "Validation failed", { reason: "a reason of at least 5 characters is required" });
  const value = parse(d, raw); d.guard?.(value);
  const old = d.def();
  await db.tx(async (c) => {
    await c.query("INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=NOW()", [key, JSON.stringify(value), actor.id]);
    await c.query("INSERT INTO app_settings_history (key, old_value, new_value, reason, changed_by) VALUES ($1,$2,$3,$4,$5)", [key, JSON.stringify(old), JSON.stringify(value), reason.trim(), actor.id]);
    await audit.record(c, { actor, action: "SETTING_CHANGED", entityType: "setting", entityId: key, details: { key, from: old, to: value, reason: reason.trim() } });
  });
  d.apply(value);
  return { key, value };
}
async function reset(actor, key, reason) {
  snap();
  const d = DEFS[key]; if (!d) throw new HttpError(404, "Unknown or non-configurable setting");
  if (typeof reason !== "string" || reason.trim().length < 5) throw new HttpError(400, "Validation failed", { reason: "a reason of at least 5 characters is required" });
  await db.tx(async (c) => { await c.query("DELETE FROM app_settings WHERE key=$1", [key]); await c.query("INSERT INTO app_settings_history (key, old_value, new_value, reason, changed_by) VALUES ($1,$2,$3,$4,$5)", [key, JSON.stringify(d.def()), JSON.stringify(defaults[key]), `reset to default: ${reason.trim()}`, actor.id]);
    await audit.record(c, { actor, action: "SETTING_RESET", entityType: "setting", entityId: key, details: { key, reason: reason.trim() } }); });
  d.apply(defaults[key]); return { key, value: defaults[key] };
}
const history = async (key) => (await db.query("SELECT h.*, u.name AS changed_by_name FROM app_settings_history h LEFT JOIN users u ON u.id=h.changed_by WHERE ($1::text IS NULL OR h.key=$1) ORDER BY h.id DESC LIMIT 100", [key || null])).rows;
module.exports = { load, list, set, reset, history, DEFS };
