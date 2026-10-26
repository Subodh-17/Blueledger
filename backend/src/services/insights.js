// backend/src/services/insights.js — role-aware overview, pending actions, global search and system status.
// Every figure comes from a query over registry records; nothing here is precomputed or estimated.
const db = require("../db");
const cfg = require("../config");
const chain = require("./chain");
const ops = require("./chainOps");
const storage = require("./storage");
const scanner = require("./scanner");
const ipfsSvc = require("./ipfs");
const page = require("../utils/page");
const C = require("./common");

const scope = (actor, alias = "p") => (actor.role === C.ROLES.FIELD ? { sql: ` AND ${alias}.organization_id=$1`, params: [actor.organization_id] } : { sql: "", params: [] });
const n = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

async function tasks(actor) {
  const out = [];
  const add = (type, label, count, href) => { if (count > 0) out.push({ type, label, count, href }); };
  if (actor.role === C.ROLES.FIELD) {
    add("DRAFT_RECORDS", "Draft records to complete and submit", await n("SELECT COUNT(*) AS n FROM monitoring_records WHERE submitted_by=$1 AND status='DRAFT'", [actor.id]), "#/field");
    add("REVISION_REQUESTED", "Records needing revision", await n("SELECT COUNT(*) AS n FROM monitoring_records WHERE submitted_by=$1 AND status='NEEDS_REVISION'", [actor.id]), "#/field");
  } else if (actor.role === C.ROLES.VERIFIER) {
    add("AWAITING_REVIEW", "Records awaiting review", await n("SELECT COUNT(*) AS n FROM monitoring_records WHERE status='SUBMITTED'"), "#/review?status=SUBMITTED");
    add("IN_REVIEW", "Reviews in progress", await n("SELECT COUNT(*) AS n FROM monitoring_records WHERE status='UNDER_REVIEW'"), "#/review?status=UNDER_REVIEW");
    add("ESTIMATE_NEEDED", "Verified records without a carbon assessment", await n(`SELECT COUNT(*) AS n FROM monitoring_records r WHERE r.status='VERIFIED' AND NOT EXISTS (SELECT 1 FROM carbon_calculations c WHERE c.record_id=r.id) AND NOT EXISTS (SELECT 1 FROM carbon_credits k WHERE k.record_id=r.id)`), "#/review?status=VERIFIED");
  } else {
    add("APPROVAL", "Carbon assessments awaiting approval", await n("SELECT COUNT(*) AS n FROM carbon_calculations WHERE is_current AND approval_status='PENDING'"), "#/credits");
    add("ISSUANCE", "Approved assessments awaiting credit issuance", await n("SELECT COUNT(*) AS n FROM carbon_calculations c WHERE is_current AND approval_status='APPROVED' AND NOT EXISTS (SELECT 1 FROM carbon_credits k WHERE k.record_id=c.record_id)"), "#/credits");
    add("ANCHOR_PENDING", "Records not yet anchored on-chain", await n("SELECT COUNT(*) AS n FROM monitoring_records WHERE anchor_status='PENDING'"), "#/administration");
    add("CHAIN_OPERATIONS", "Blockchain operations needing attention", await n("SELECT COUNT(*) AS n FROM chain_operations WHERE status IN ('PENDING','SUBMITTED','CONFIRMED','FAILED')"), "#/administration");
    add("ESTIMATE_NEEDED", "Verified records without a carbon assessment", await n(`SELECT COUNT(*) AS n FROM monitoring_records r WHERE r.status='VERIFIED' AND NOT EXISTS (SELECT 1 FROM carbon_calculations c WHERE c.record_id=r.id) AND NOT EXISTS (SELECT 1 FROM carbon_credits k WHERE k.record_id=r.id)`), "#/review?status=VERIFIED");
  }
  return out;
}

function monthsBack(k = 12) {
  const out = [], d = new Date(); d.setUTCDate(1);
  for (let i = k - 1; i >= 0; i--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(x.toISOString().slice(0, 7)); }
  return out;
}

async function overview(actor) {
  const s = scope(actor, "p"), pr = s.params;
  const byStatus = async (sql, params) => Object.fromEntries((await db.query(sql, params)).rows.map((r) => [r.k, r.n]));
  const records = await byStatus(`SELECT r.status AS k, COUNT(*)::int AS n FROM monitoring_records r JOIN projects p ON p.id=r.project_id WHERE TRUE${s.sql} GROUP BY r.status`, pr);
  const evidence = await byStatus(`SELECT e.verification_status AS k, COUNT(*)::int AS n FROM evidence e JOIN projects p ON p.id=e.project_id WHERE TRUE${s.sql} GROUP BY e.verification_status`, pr);
  const verification = await byStatus(`SELECT p.verification_status AS k, COUNT(*)::int AS n FROM projects p WHERE TRUE${s.sql} GROUP BY p.verification_status`, pr);
  const projects = Object.values(verification).reduce((a, b) => a + b, 0);
  const illustrative = await n(`SELECT COUNT(*) AS n FROM projects p WHERE p.data_origin='ILLUSTRATIVE'${s.sql}`, pr);
  const cr = (await db.query(`SELECT COALESCE(SUM(cc.amount_tonnes),0)::float AS issued, COALESCE(SUM(cc.retired_tonnes),0)::float AS retired FROM carbon_credits cc JOIN projects p ON p.id=cc.project_id WHERE TRUE${s.sql}`, pr)).rows[0];
  const awaiting = actor.role === C.ROLES.FIELD ? null : await n("SELECT COUNT(*) AS n FROM carbon_calculations WHERE is_current AND approval_status='PENDING'");
  const activity = (await db.query(`SELECT a.id, a.created_at, a.actor_name, a.actor_role, a.action, a.entity_type, a.previous_status, a.new_status, a.tx_hash, p.code AS project_code, r.code AS record_code
    FROM audit_logs a LEFT JOIN projects p ON p.id=a.project_id LEFT JOIN monitoring_records r ON r.id=a.record_id
    WHERE ${actor.role === C.ROLES.FIELD ? "p.organization_id=$1" : "TRUE"} ORDER BY a.id DESC LIMIT 10`, pr)).rows;

  const months = monthsBack(12), from = `${months[0]}-01`;
  const sub = Object.fromEntries((await db.query(`SELECT to_char(date_trunc('month', r.submitted_at),'YYYY-MM') AS m, COUNT(*)::int AS n FROM monitoring_records r JOIN projects p ON p.id=r.project_id
    WHERE r.submitted_at >= $${pr.length + 1}::date${s.sql} GROUP BY 1`, [...pr, from])).rows.map((r) => [r.m, r.n]));
  const ev = (await db.query(`SELECT to_char(date_trunc('month', e.created_at),'YYYY-MM') AS m, e.event_type AS t, COALESCE(SUM(e.amount),0)::float AS q FROM credit_events e JOIN carbon_credits cc ON cc.id=e.credit_id JOIN projects p ON p.id=cc.project_id
    WHERE e.created_at >= $${pr.length + 1}::date${s.sql} GROUP BY 1,2`, [...pr, from])).rows;
  const credit = (t) => months.map((m) => ev.filter((r) => r.m === m && r.t === t).reduce((a, r) => a + r.q, 0));

  return {
    scope: actor.role === C.ROLES.FIELD ? "ORGANIZATION" : "REGISTRY",
    counts: { projects, recordsByStatus: records, evidenceByStatus: evidence, projectsByVerification: verification, assessmentsAwaitingApproval: awaiting, credits: { issued: cr.issued, retired: cr.retired, outstanding: cr.issued - cr.retired } },
    provenance: { illustrativeProjects: illustrative, totalProjects: projects },
    tasks: await tasks(actor), activity,
    series: { months, recordsSubmitted: months.map((m) => sub[m] || 0), creditsIssued: credit("ISSUED"), creditsRetired: credit("RETIRED"), creditsTransferred: credit("TRANSFERRED") },
    chain: await chain.status(),
  };
}

async function search(actor, q) {
  q = String(q || "").trim();
  if (q.length < 2) return { query: q, results: [] };
  const like = page.like(q), field = actor.role === C.ROLES.FIELD, org = actor.organization_id;
  const w = field ? " AND p.organization_id=$2" : "", args = field ? [like, org] : [like];
  const results = [];
  (await db.query(`SELECT p.id, p.code, p.name FROM projects p WHERE (p.code ILIKE $1 OR p.name ILIKE $1 OR p.region ILIKE $1)${w} ORDER BY p.code LIMIT 5`, args)).rows.forEach((r) => results.push({ type: "Project", label: `${r.code} — ${r.name}`, href: `#/projects/${r.id}` }));
  (await db.query(`SELECT r.id, r.code, p.code AS pc FROM monitoring_records r JOIN projects p ON p.id=r.project_id WHERE r.code ILIKE $1${w} ORDER BY r.id DESC LIMIT 5`, args)).rows.forEach((r) => results.push({ type: "Monitoring record", label: `${r.code} (${r.pc})`, href: `#/records/${r.id}` }));
  (await db.query(`SELECT e.id, e.code, e.filename, e.record_id FROM evidence e JOIN projects p ON p.id=e.project_id WHERE (e.code ILIKE $1 OR e.filename ILIKE $1 OR e.sha256 ILIKE $1)${w} ORDER BY e.id DESC LIMIT 5`, args)).rows.forEach((r) => results.push({ type: "Evidence", label: `${r.code}${r.filename ? " — " + r.filename : ""}`, href: "#/evidence?q=" + encodeURIComponent(r.code) }));
  (await db.query(`SELECT cc.id, cc.batch_code, p.code AS pc FROM carbon_credits cc JOIN projects p ON p.id=cc.project_id WHERE (cc.batch_code ILIKE $1 OR p.code ILIKE $1)${w} ORDER BY cc.id DESC LIMIT 5`, args)).rows.forEach((r) => results.push({ type: "Credit batch", label: `${r.batch_code} (${r.pc})`, href: `#/credits/${r.id}` }));
  return { query: q, results };
}

async function systemStatus() {
  const t0 = Date.now();
  let database;
  try { const m = await n("SELECT COUNT(*) AS n FROM schema_migrations"); database = { connected: true, latencyMs: Date.now() - t0, migrationsApplied: m }; } catch (e) { database = { connected: false, error: e.message }; }
  const chainStatus = await chain.status();
  return {
    version: "2.1.0", environment: cfg.isProd ? "production" : process.env.NODE_ENV || "development", database, blockchain: chainStatus,
    operations: database.connected ? await ops.counts() : null, backlog: database.connected ? await ops.backlog() : null, evidenceStorage: { ...storage.storageHealth(), ipfs: await storage.ipfsHealth(), ipfsBacklog: database.connected ? await ipfsSvc.backlog() : null, malwareScanner: await scanner.health(), encryption: { enabled: require("./crypto").enabled() } },
    configuration: { chainMode: cfg.chain.mode, ipfsProvider: cfg.ipfs.provider, maxUploadMb: cfg.maxUploadBytes / 1048576, rateLimitPerMinute: cfg.rateLimit.max, mapTilesConfigured: !!cfg.map.tileUrl, confirmationTimeoutMs: cfg.txConfirmTimeoutMs, reconcileIntervalMs: cfg.reconcileIntervalMs },
  };
}

module.exports = { overview, tasks, search, systemStatus };
