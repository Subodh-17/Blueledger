// backend/src/services/disputes.js — disputes against issued credit batches.
//
// WHAT A DISPUTE DOES: while a dispute on a batch is OPEN, UNDER_REVIEW or UPHELD, this API refuses to start transfers and retirements of
// that batch (assertNoHold, called from credits.moveCredits). WHAT IT DOES NOT DO: it does not freeze, cancel or reverse anything on the
// blockchain. The deployed contract has no such function, so an upheld dispute records a confirmed problem and keeps the registry hold in
// place; it does not change the token. Anyone able to sign directly with a holder's key is not stopped by this control.
// Every state change is one transaction: the dispute row, an append-only history event, an audit entry naming the actor, the reason, the
// record and the assessment concerned, and the notifications.
const db = require("../db");
const audit = require("./audit");
const notify = require("./notify");
const { HttpError, validator } = require("../utils/http");
const C = require("./common");

const CATEGORIES = ["EVIDENCE", "DOUBLE_COUNTING", "OWNERSHIP", "CALCULATION", "OTHER"];
const HOLD_STATUSES = ["OPEN", "UNDER_REVIEW", "UPHELD"];
const NOTE = "This is a registry control: transfers and retirements through this system are paused while the dispute stands. It does not freeze, cancel or reverse the on-chain token.";

/** May this actor see or raise a dispute on the credit? Reviewers and NCCR always; field users through the project owner or a holding organization. */
async function canAccess(c, actor, credit) {
  if (actor.role !== C.ROLES.FIELD) return true;
  const org = actor.organization_id; if (!org) return false;
  if (credit.holder_org_id === org) return true;
  const p = await c.query("SELECT organization_id FROM projects WHERE id=$1", [credit.project_id]);
  if (p.rows[0]?.organization_id === org) return true;
  return (await c.query("SELECT 1 FROM credit_balances WHERE credit_id=$1 AND org_id=$2 AND balance > 0", [credit.id, org])).rows.length > 0;
}
async function load(c, id, { lock = false } = {}) { return C.one(c, `SELECT * FROM credit_disputes WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [id], "Dispute not found"); }

async function event(c, d, type, from, to, actor, note) {
  await c.query("INSERT INTO credit_dispute_events (dispute_id, event_type, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5,$6)", [d.id, type, from, to, actor.id, note || null]);
  await audit.record(c, { actor, action: `CREDIT_DISPUTE_${type}`, entityType: "credit_dispute", entityId: d.id, projectId: d.project_id ?? null, recordId: d.record_id, previousStatus: from, newStatus: to,
    details: { code: d.code, creditId: d.credit_id, calculationId: d.calculation_id, category: d.category, reason: note || d.reason } });
}

async function raise(actor, creditId, body) {
  const v = validator();
  const category = v.str(body, "category", { oneOf: CATEGORIES });
  const reason = v.str(body, "reason", { min: 10, max: 2000 });
  v.done();
  return db.tx(async (c) => {
    const credit = await C.one(c, "SELECT * FROM carbon_credits WHERE id=$1 FOR SHARE", [creditId], "Credit not found");
    if (!(await canAccess(c, actor, credit))) throw new HttpError(403, "You do not have access to this credit batch");
    const d = (await c.query("INSERT INTO credit_disputes (credit_id, record_id, calculation_id, category, reason, raised_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [creditId, credit.record_id, credit.calculation_id, category, reason.trim(), actor.id])).rows[0];
    d.project_id = credit.project_id;
    await event(c, d, "RAISED", null, "OPEN", actor, reason.trim());
    await notify.toRole(c, "NCCR_ADMIN", { type: "CREDIT_DISPUTE_RAISED", title: `Dispute ${d.code} raised on credit batch ${credit.batch_code || credit.id}`, body: `${category.replaceAll("_", " ").toLowerCase()} — transfers and retirements are paused`, href: `#/credits/${creditId}`, entityType: "credit_dispute", entityId: d.id, severity: "ACTION", dedupeKey: `dispute:${d.id}:raised` });
    return { dispute: d, note: NOTE, holdsTransfers: true };
  });
}

async function transition(actor, id, { from, to, type, note, requireAdmin = true, raiserOnly = false, notRaiser = false }) {
  return db.tx(async (c) => {
    const d = await load(c, id, { lock: true });
    const credit = await C.one(c, "SELECT * FROM carbon_credits WHERE id=$1", [d.credit_id], "Credit not found");
    if (requireAdmin && actor.role !== C.ROLES.ADMIN) throw new HttpError(403, "Only an NCCR administrator can do this");
    if (raiserOnly && d.raised_by !== actor.id) throw new HttpError(403, "Only the person who raised the dispute can withdraw it");
    if (notRaiser && d.raised_by === actor.id) throw new HttpError(403, "A dispute cannot be reviewed or decided by the person who raised it");
    if (!from.includes(d.status)) throw new HttpError(409, `Dispute ${d.code} is ${d.status}; this action needs it to be ${from.join(" or ")}`);
    const upd = (await c.query("UPDATE credit_disputes SET status=$1::varchar, reviewer_id=COALESCE($2::integer, reviewer_id), resolution_note=COALESCE($3::text, resolution_note), resolved_at=CASE WHEN $1::varchar IN ('UPHELD','DISMISSED','WITHDRAWN') THEN NOW() ELSE resolved_at END, updated_at=NOW() WHERE id=$4 RETURNING *",
      [to, to === "WITHDRAWN" ? null : actor.id, type === "REVIEW_STARTED" ? null : note, id])).rows[0];
    upd.project_id = credit.project_id;
    await event(c, upd, type, d.status, to, actor, note);
    const targets = [d.raised_by]; // the person who raised it hears the outcome
    await notify.create(c, targets.filter((u) => u !== actor.id), { type: `CREDIT_DISPUTE_${type}`, title: `Dispute ${upd.code}: ${to.replaceAll("_", " ").toLowerCase()}`, body: note || null, href: `#/credits/${d.credit_id}`, entityType: "credit_dispute", entityId: id, severity: "INFO", dedupeKey: `dispute:${id}:${type}` });
    return { dispute: upd, note: NOTE, holdsTransfers: HOLD_STATUSES.includes(to) };
  });
}

const startReview = (actor, id) => transition(actor, id, { from: ["OPEN"], to: "UNDER_REVIEW", type: "REVIEW_STARTED", notRaiser: true });
async function decide(actor, id, body) {
  const v = validator();
  const decision = v.str(body, "decision", { oneOf: ["UPHELD", "DISMISSED"] });
  const reason = v.str(body, "reason", { min: 10, max: 2000 });
  v.done();
  return transition(actor, id, { from: ["UNDER_REVIEW"], to: decision, type: decision, note: reason.trim(), notRaiser: true });
}
async function withdraw(actor, id, body = {}) {
  const note = body.reason ? String(body.reason).slice(0, 2000) : "Withdrawn by the person who raised it";
  return transition(actor, id, { from: ["OPEN", "UNDER_REVIEW"], to: "WITHDRAWN", type: "WITHDRAWN", note, requireAdmin: false, raiserOnly: true });
}

const COLS = `d.*, c.batch_code, c.credit_label, r.code AS record_code, u.name AS raised_by_name, rv.name AS reviewer_name`;
const FROM = `FROM credit_disputes d JOIN carbon_credits c ON c.id=d.credit_id JOIN monitoring_records r ON r.id=d.record_id JOIN users u ON u.id=d.raised_by LEFT JOIN users rv ON rv.id=d.reviewer_id`;
async function visibleTo(actor, rows) { const out = []; for (const d of rows) if (await canAccess(db, actor, { id: d.credit_id, holder_org_id: d.holder_org_id, project_id: d.project_id })) out.push(d); return out; }

async function list(actor, query = {}) {
  const where = [], params = [];
  if (CATEGORIES.includes(query.category)) { params.push(query.category); where.push(`d.category=$${params.length}`); }
  if (["OPEN", "UNDER_REVIEW", "UPHELD", "DISMISSED", "WITHDRAWN"].includes(query.status)) { params.push(query.status); where.push(`d.status=$${params.length}`); }
  if (query.creditId) { params.push(Number(query.creditId) || 0); where.push(`d.credit_id=$${params.length}`); }
  const rows = (await db.query(`SELECT ${COLS}, c.holder_org_id, c.project_id ${FROM} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.id DESC LIMIT 200`, params)).rows;
  return { disputes: await visibleTo(actor, rows), note: NOTE };
}
async function forCredit(actor, creditId) {
  const credit = await C.one(db, "SELECT * FROM carbon_credits WHERE id=$1", [creditId], "Credit not found");
  if (!(await canAccess(db, actor, credit))) throw new HttpError(403, "You do not have access to this credit batch");
  const disputes = (await db.query(`SELECT ${COLS} ${FROM} WHERE d.credit_id=$1 ORDER BY d.id`, [creditId])).rows;
  const events = disputes.length ? (await db.query("SELECT e.*, u.name AS actor_name FROM credit_dispute_events e JOIN users u ON u.id=e.actor_id WHERE e.dispute_id = ANY($1) ORDER BY e.id", [disputes.map((d) => d.id)])).rows : [];
  return { creditId, onHold: disputes.some((d) => HOLD_STATUSES.includes(d.status)), disputes: disputes.map((d) => ({ ...d, events: events.filter((e) => e.dispute_id === d.id) })), note: NOTE };
}
/** Throws 409 when an unresolved dispute holds the batch. Pass the transaction client where there is one, so the check and the reservation are one unit. */
async function assertNoHold(c, creditId) {
  const rows = (await c.query("SELECT code, status FROM credit_disputes WHERE credit_id=$1 AND status = ANY($2) ORDER BY id", [creditId, HOLD_STATUSES])).rows;
  if (rows.length) throw new HttpError(409, `This credit batch is under dispute (${rows.map((r) => `${r.code} ${r.status.replace("_", " ").toLowerCase()}`).join(", ")}); transfers and retirements are paused in the registry until it is resolved. The on-chain token is not changed by this hold.`, { disputes: rows.map((r) => r.code) });
}
const countActive = async (c, creditId) => Number((await c.query("SELECT COUNT(*) AS n FROM credit_disputes WHERE credit_id=$1 AND status = ANY($2)", [creditId, HOLD_STATUSES])).rows[0].n);

module.exports = { raise, startReview, decide, withdraw, list, forCredit, assertNoHold, countActive, CATEGORIES, HOLD_STATUSES, NOTE };
