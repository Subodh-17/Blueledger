// backend/src/services/registry.js — public registry views, on-chain verification, and administrative statistics.
const db = require("../db");
const chain = require("./chain");
const audit = require("./audit");
const { HttpError } = require("../utils/http");
const C = require("./common");

const DISCLAIMER = "Registry credits are recorded for traceability only. They are not accredited under any external carbon standard and carry no legal recognition. Records marked illustrative were not collected in the field.";

async function publicRegistry() {
  const { rows: projects } = await db.query(
    `SELECT p.code, p.name, p.ecosystem_type, p.restoration_type, p.region, p.area_hectares::float AS area_hectares, p.latitude::float AS latitude, p.longitude::float AS longitude,
       p.start_date, p.status, p.verification_status, p.credit_status, p.latest_estimate_tco2e::float AS latest_estimate_tco2e, p.data_origin, o.name AS organization,
       COALESCE((SELECT SUM(amount_tonnes) FROM carbon_credits c WHERE c.project_id=p.id),0)::float AS credits_issued,
       COALESCE((SELECT SUM(retired_tonnes) FROM carbon_credits c WHERE c.project_id=p.id),0)::float AS credits_retired
     FROM projects p LEFT JOIN organizations o ON o.id=p.organization_id ORDER BY p.id`);
  const { rows: credits } = await db.query(
    `SELECT cc.id, cc.batch_code, cc.data_origin, p.code AS project_code, r.code AS record_code, cc.amount_tonnes::float AS quantity, cc.retired_tonnes::float AS retired, cc.status, cc.credit_label, cc.tx_hash, cc.block_number, cc.issued_at, o.name AS holder
     FROM carbon_credits cc JOIN projects p ON p.id=cc.project_id JOIN monitoring_records r ON r.id=cc.record_id JOIN organizations o ON o.id=cc.holder_org_id ORDER BY cc.id DESC`);
  const totals = credits.reduce((a, c) => ({ issued: a.issued + c.quantity, retired: a.retired + c.retired }), { issued: 0, retired: 0 });
  return { disclaimer: DISCLAIMER, projects, credits, totals: { ...totals, outstanding: totals.issued - totals.retired } };
}

/** Recompute the record hash from stored data and compare with the on-chain anchor. Accepts a record code or a credit batch code. */
async function verifyRecord(code) {
  const batch = (await db.query("SELECT * FROM carbon_credits WHERE batch_code=$1", [String(code).toUpperCase()])).rows[0];
  const rec = batch ? (await db.query("SELECT * FROM monitoring_records WHERE id=$1", [batch.record_id])).rows[0]
    : (await db.query("SELECT * FROM monitoring_records WHERE code=upper($1) OR uuid::text=lower($1)", [String(code).slice(0, 64)])).rows[0];
  if (!rec) throw new HttpError(404, "No record or credit batch found with that identifier");
  const project = await C.getProject(db, rec.project_id);
  const evidence = await C.fromPg(db, "SELECT * FROM evidence WHERE record_id=$1 AND superseded_at IS NULL ORDER BY id", [rec.id]);
  const recomputed = rec.content_hash ? C.contentHashOf(project, rec, evidence) : null;
  const credit = batch || (await db.query("SELECT * FROM carbon_credits WHERE record_id=$1", [rec.id])).rows[0] || null;
  const events = credit ? (await db.query(`SELECT e.event_type, e.amount::float AS amount, e.created_at, e.tx_hash, fo.name AS from_org, tor.name AS to_org FROM credit_events e LEFT JOIN organizations fo ON fo.id=e.from_org_id LEFT JOIN organizations tor ON tor.id=e.to_org_id WHERE e.credit_id=$1 ORDER BY e.id`, [credit.id])).rows : [];
  const out = {
    disclaimer: DISCLAIMER, code: rec.code, project: project.code, projectName: project.name, status: rec.status, revision: rec.revision, provenance: rec.data_origin,
    hashes: { stored: rec.content_hash, recomputed, evidenceRootStored: rec.evidence_root, evidenceRootRecomputed: evidence.length ? C.evidenceRootOf(evidence) : null },
    anchorTx: rec.anchor_tx_hash, onChain: null, network: null,
    credit: credit ? { batch: credit.batch_code, quantity: Number(credit.amount_tonnes), retired: Number(credit.retired_tonnes), status: credit.status, issuedAt: credit.issued_at, txHash: credit.tx_hash, label: credit.credit_label } : null, events,
  };
  try {
    const oc = await chain.getRecord(C.recordChainId(rec));
    const st = await chain.status();
    out.network = { chainId: st.chainId, contractAddress: st.contractAddress, blockNumber: st.blockNumber };
    out.onChain = oc;
    out.checks = {
      storedMatchesRecomputed: !!recomputed && recomputed === rec.content_hash,
      onChainMatchesStored: oc.contentHash === rec.content_hash && oc.evidenceRoot === rec.evidence_root,
      statusConsistent: oc.status === rec.status || (oc.status === "ANCHORED" && ["SUBMITTED", "UNDER_REVIEW"].includes(rec.status)) || (oc.status === "CREDITED" && rec.status === "VERIFIED"),
    };
    out.consistent = Object.values(out.checks).every(Boolean);
  } catch (e) { out.onChainError = e.message; out.consistent = null; }
  return out;
}

const TX_SORTS = { created: { sql: "t.id" }, block: { sql: "t.block_num" } };
async function transactions(query = {}) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (Number(query.projectId) > 0) add("t.project_id=?", Number(query.projectId));
  if (Number(query.recordId) > 0) add("t.record_id=?", Number(query.recordId));
  if (query.type) add("t.tx_type=?", String(query.type));
  if (query.q) add("(t.tx_hash ILIKE ? OR p.code ILIKE ? OR r.code ILIKE ?)", require("../utils/page").like(query.q));
  const pg = require("../utils/page").parse({ pageSize: 50, ...query }, TX_SORTS, "created", "t.id");
  const r = await require("../utils/page").run({ select: `SELECT t.id, t.tx_hash, t.block_num, t.tx_type, t.detail, t.from_addr, t.gas_used, t.status, t.chain_id, t.contract_address, t.payload_hash, t.created_at, p.code AS project_code, r.code AS record_code, u.name AS actor_name`,
    from: "FROM blockchain_transactions t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN monitoring_records r ON r.id=t.record_id LEFT JOIN users u ON u.id=t.owner_id", where, params }, pg);
  return { transactions: r.rows, pagination: r.pagination };
}

async function adminStats() {
  const scalar = async (q) => Number((await db.query(q)).rows[0].n);
  const byStatus = async (t, col) => Object.fromEntries((await db.query(`SELECT ${col} AS k, COUNT(*)::int AS n FROM ${t} GROUP BY ${col}`)).rows.map((r) => [r.k, r.n]));
  const credits = (await db.query("SELECT COALESCE(SUM(amount_tonnes),0)::float AS issued, COALESCE(SUM(retired_tonnes),0)::float AS retired FROM carbon_credits")).rows[0];
  return {
    projects: await scalar("SELECT COUNT(*) AS n FROM projects"),
    projectsByVerification: await byStatus("projects", "verification_status"),
    projectsByCredit: await byStatus("projects", "credit_status"),
    recordsByStatus: await byStatus("monitoring_records", "status"),
    evidenceByStatus: await byStatus("evidence", "verification_status"),
    awaitingNccrApproval: await scalar("SELECT COUNT(*) AS n FROM carbon_calculations WHERE is_current AND approval_status='PENDING'"),
    approvedAwaitingIssuance: await scalar("SELECT COUNT(*) AS n FROM carbon_calculations c WHERE is_current AND approval_status='APPROVED' AND NOT EXISTS (SELECT 1 FROM carbon_credits k WHERE k.record_id=c.record_id)"),
    calculations: { current: await scalar("SELECT COUNT(*) AS n FROM carbon_calculations WHERE is_current"), approved: await scalar("SELECT COUNT(*) AS n FROM carbon_calculations WHERE is_current AND approval_status='APPROVED'") },
    credits: { issued: credits.issued, retired: credits.retired, outstanding: credits.issued - credits.retired },
    chainTransactions: await scalar("SELECT COUNT(*) AS n FROM blockchain_transactions"),
    auditEntries: await scalar("SELECT COUNT(*) AS n FROM audit_logs"),
    users: await scalar("SELECT COUNT(*) AS n FROM users WHERE is_active"),
    anchorPending: await scalar("SELECT COUNT(*) AS n FROM monitoring_records WHERE anchor_status='PENDING'"),
  };
}

module.exports = { publicRegistry, verifyRecord, transactions, adminStats, DISCLAIMER, auditVerify: audit.verifyChain };
