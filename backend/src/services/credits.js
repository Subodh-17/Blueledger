// backend/src/services/credits.js — carbon estimate -> NCCR approval -> registry credit -> transfer / retirement.
const disputes = require("./disputes");
const db = require("../db");
const audit = require("./audit");
const chain = require("./chain");
const ops = require("./chainOps");
require("./chainHandlers");
const crypto = require("crypto");
const page = require("../utils/page");
const carbon = require("./carbon");
const methodology = require("./methodology");
const notify = require("./notify");
const { HttpError, validator } = require("../utils/http");
const C = require("./common");

async function calculate(actor, recordId) {
  return db.tx(async (c) => {
    const rec = await C.getRecord(c, recordId, { lock: true });
    if (rec.status !== "VERIFIED") throw new HttpError(409, `A carbon assessment requires a VERIFIED record (record is ${rec.status})`);
    if ((await C.fromPg(c, "SELECT 1 FROM carbon_credits WHERE record_id=$1", [recordId])).length) throw new HttpError(409, "Credits were already issued for this record");
    const project = await C.getProject(c, rec.project_id, { lock: true });
    const version = project.methodology_version || (project.data_origin === "ILLUSTRATIVE" ? carbon.definitions.DEFAULT_ILLUSTRATIVE : carbon.definitions.DEFAULT_REAL);
    // The assessed period starts where the previous (non-rejected) assessment of the project ended, so no period is counted twice.
    const prev = (await c.query(`SELECT * FROM carbon_calculations WHERE project_id=$1 AND record_id<>$2 AND is_current AND approval_status<>'REJECTED' ORDER BY period_end DESC LIMIT 1`, [project.id, recordId])).rows[0];
    const period = { start: prev ? prev.period_end : project.start_date, end: rec.activity_date };
    const previous = prev ? { cumulative: { biomassTcPerHa: prev.result?.perHectare?.biomassTcCumulative || 0, soilTcPerHa: prev.result?.perHectare?.soilTcCumulative || 0 } } : null;
    const acc = await methodology.acceptedByKind(project.id, c);
    const est = carbon.estimate(version, { project: { ...project, bufferPercent: acc.NON_PERMANENCE_RISK?.buffer_percent ?? null }, record: rec, period, previous });
    await c.query("UPDATE carbon_calculations SET is_current=FALSE, superseded_at=NOW() WHERE record_id=$1 AND is_current", [recordId]);
    const no = Number((await c.query("SELECT COUNT(*) AS n FROM carbon_calculations WHERE record_id=$1", [recordId])).rows[0].n) + 1;
    const pseudo = { methodology_version: est.methodologyVersion, methodology_hash: est.methodologyHash, buffer_percent: est.result.bufferPercent, eligible_credits: est.estimate.eligible };
    const iss = await methodology.issuability(pseudo, project, c);
    const blockers = [...est.blockers, ...iss.blockers.filter((b) => !est.blockers.some((x) => x.code === b.code))];
    const { rows } = await c.query(
      `INSERT INTO carbon_calculations (record_id, project_id, methodology_version, methodology_hash, inputs, assumptions, result, estimate_tco2e, low_tco2e, high_tco2e, central_tco2e, conservative_tco2e, buffer_percent,
         eligible_credits, input_hash, calculated_by, assessment_no, period_start, period_end, blockers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [recordId, project.id, est.methodologyVersion, est.methodologyHash, est.inputs, { parametersUsed: est.parametersUsed, methodologyStatus: est.methodologyStatus }, est.result, est.estimate.central, est.estimate.low, est.estimate.high, est.estimate.central,
       est.estimate.conservative, est.result.bufferPercent, est.estimate.eligible, est.inputHash, actor.id, no, est.inputs.periodStart, est.inputs.periodEnd, JSON.stringify(blockers)]);
    await c.query("UPDATE projects SET latest_estimate_tco2e=$1, credit_status=$2, updated_at=NOW() WHERE id=$3", [est.estimate.central, est.estimate.eligible > 0 && !blockers.length ? "ELIGIBLE" : "NONE", project.id]);
    await audit.record(c, { actor, action: "CARBON_CALCULATED", entityType: "carbon_calculation", entityId: rows[0].id, projectId: project.id, recordId,
      details: { methodology: est.methodologyVersion, label: "Illustrative estimate", assessmentNo: no, centralTCO2e: est.estimate.central, conservativeTCO2e: est.estimate.conservative, eligibleCredits: est.estimate.eligible, period: [est.inputs.periodStart, est.inputs.periodEnd], blockers: blockers.map((b) => b.code), inputHash: est.inputHash } });
    await notify.toRole(c, "NCCR_ADMIN", { type: "ASSESSMENT_AWAITING_APPROVAL", title: `Assessment for ${rec.code} is awaiting approval`, body: blockers.length ? `${blockers.length} issuance blocker(s) must be resolved first.` : `${est.estimate.eligible} whole tonne(s) eligible.`, href: "#/assessments", entityType: "carbon_calculation", entityId: rows[0].id, severity: "ACTION", dedupeKey: `assessment:${rows[0].id}` });
    return rows[0];
  });
}

async function approve(actor, calcId, body) {
  const v = validator();
  const decision = v.str(body, "decision", { oneOf: ["APPROVED", "REJECTED"] });
  const notes = v.str(body, "notes", { optional: decision === "APPROVED", min: 5, max: 2000 });
  v.done();
  return db.tx(async (c) => {
    const calc = await C.one(c, "SELECT * FROM carbon_calculations WHERE id=$1 FOR UPDATE", [calcId], "Calculation not found");
    if (!calc.is_current) throw new HttpError(409, "This calculation has been superseded by a newer one");
    if (calc.approval_status !== "PENDING") throw new HttpError(409, `Calculation already ${calc.approval_status}`);
    if ((await C.fromPg(c, "SELECT 1 FROM carbon_credits WHERE record_id=$1", [calc.record_id])).length) throw new HttpError(409, "Credits already issued for this record");
    const ver = (await C.fromPg(c, "SELECT verifier_id FROM verification_records WHERE record_id=$1 AND decision='VERIFIED' ORDER BY id DESC LIMIT 1", [calc.record_id]))[0];
    if (!ver) throw new HttpError(409, "Record has no verification decision");
    if (ver.verifier_id === actor.id) throw new HttpError(403, "The verifier of a record cannot also approve its credits");
    if (decision === "APPROVED") {
      const iss = await methodology.issuability(calc, await C.getProject(c, calc.project_id), c);
      if (!iss.ok) throw new HttpError(422, `This assessment cannot be approved for issuance: ${iss.blockers.map((b) => b.detail).join("; ")}`, { blockers: iss.blockers });
    }
    await c.query("UPDATE carbon_calculations SET approval_status=$1, approved_by=$2, approved_at=NOW(), approval_notes=$3 WHERE id=$4", [decision, actor.id, notes || null, calcId]);
    await c.query("UPDATE projects SET credit_status=$1, updated_at=NOW() WHERE id=$2", [decision === "APPROVED" ? "APPROVED" : "NONE", calc.project_id]);
    await audit.record(c, { actor, action: decision === "APPROVED" ? "NCCR_APPROVED" : "NCCR_REJECTED", entityType: "carbon_calculation", entityId: calcId, projectId: calc.project_id, recordId: calc.record_id,
      previousStatus: "PENDING", newStatus: decision, details: { eligibleCredits: calc.eligible_credits, notes: notes || null } });
    await notify.create(c, [calc.calculated_by], { type: decision === "APPROVED" ? "ASSESSMENT_APPROVED" : "ASSESSMENT_NOT_APPROVED", title: `Assessment ${decision === "APPROVED" ? "approved" : "not approved"}`, body: notes || undefined, href: `#/records/${calc.record_id}`, entityType: "carbon_calculation", entityId: calcId, dedupeKey: `approval:${calcId}` });
    return { ...calc, approval_status: decision };
  });
}

async function issue(actor, calcId, body = {}) {
  const calc = await C.one(db, "SELECT * FROM carbon_calculations WHERE id=$1", [calcId], "Calculation not found");
  if (!calc.is_current) throw new HttpError(409, "This calculation has been superseded");
  if ((await C.fromPg(db, "SELECT 1 FROM carbon_credits WHERE record_id=$1", [calc.record_id])).length) throw new HttpError(409, "Credits were already issued for this record (duplicate issuance blocked)");
  if (calc.approval_status !== "APPROVED") throw new HttpError(409, `NCCR approval required before issuance (calculation is ${calc.approval_status})`);
  const rec = await C.getRecord(db, calc.record_id);
  if (rec.status !== "VERIFIED") throw new HttpError(409, "Record is not VERIFIED");
  const project = await C.getProject(db, calc.project_id);
  if (project.status !== "ACTIVE") throw new HttpError(409, "Project is not active");
  const iss = await methodology.issuability(calc, project);
  if (!iss.ok) throw new HttpError(422, `Credits cannot be issued: ${iss.blockers.map((b) => b.detail).join("; ")}`, { blockers: iss.blockers });
  const holderOrgId = body.holderOrgId ? Number(body.holderOrgId) : project.organization_id;
  const org = await C.one(db, "SELECT * FROM organizations WHERE id=$1", [holderOrgId], "Holder organization not found");
  if (!org.wallet_address) throw new HttpError(422, "Holder organization has no wallet address");

  const out = await ops.run("CREDIT_ISSUE", `issue:${calc.record_id}`, { calcId, holderOrgId, quantity: calc.eligible_credits, estimateHash: C.estimateHashOf(calc), adminId: actor.id },
    { actor, projectId: project.id, recordId: rec.id });
  const credit = (await db.query("SELECT * FROM carbon_credits WHERE record_id=$1", [calc.record_id])).rows[0];
  return { credit, tx: { txHash: out.tx?.txHash || credit.tx_hash, blockNumber: out.tx?.blockNumber ?? credit.block_number } };
}

/** Funds not already promised to a pending transfer or retirement. */
async function availableBalance(client, creditId, orgId) {
  const bal = (await client.query("SELECT balance::float AS b FROM credit_balances WHERE credit_id=$1 AND org_id=$2 FOR UPDATE", [creditId, orgId])).rows[0];
  if (!bal) return { balance: 0, reserved: 0, available: 0 };
  const reserved = Number((await client.query("SELECT COALESCE(SUM(amount),0) AS s FROM credit_reservations WHERE credit_id=$1 AND org_id=$2 AND status='ACTIVE'", [creditId, orgId])).rows[0].s);
  return { balance: bal.b, reserved, available: bal.b - reserved };
}

async function moveCredits(actor, creditId, kind, body, idempotencyKey) {
  const v = validator();
  const amount = v.num(body, "amount", { int: true, min: 1 });
  const toOrgId = kind === "TRANSFERRED" ? v.num(body, "toOrgId", { int: true, min: 1 }) : undefined;
  const reason = kind === "RETIRED" ? v.str(body, "reason", { min: 5, max: 500 }) : undefined;
  v.done();
  const fromOrgId = actor.role === C.ROLES.FIELD ? actor.organization_id : Number(body.fromOrgId);
  if (!fromOrgId) throw new HttpError(400, "Validation failed", { fromOrgId: "required for NCCR administrators acting on behalf of a holder" });
  if (kind === "TRANSFERRED" && toOrgId === fromOrgId) throw new HttpError(400, "Cannot transfer to the same organization");

  const credit = await C.one(db, "SELECT * FROM carbon_credits WHERE id=$1", [creditId], "Credit not found");
  await disputes.assertNoHold(db, creditId); // fail fast; checked again inside the reservation transaction below
  if (kind === "TRANSFERRED") {
    const to = await C.one(db, "SELECT * FROM organizations WHERE id=$1", [toOrgId], "Destination organization not found");
    if (!to.wallet_address) throw new HttpError(422, "Destination organization has no wallet address");
  }
  const key = `${kind === "TRANSFERRED" ? "transfer" : "retire"}:${creditId}:${idempotencyKey || crypto.randomUUID()}`;
  const ref = require("ethers").id(key); // unique on-chain reference: the contract refuses to execute the same reference twice
  const reserve = async (client, opId) => {
    await disputes.assertNoHold(client, creditId);
    const a = await availableBalance(client, creditId, fromOrgId);
    if (a.available < amount) throw new HttpError(409, `Insufficient available balance (holder has ${a.balance}, of which ${a.reserved} is reserved for pending operations)`);
    await client.query(`INSERT INTO credit_reservations (op_id, credit_id, org_id, amount) VALUES ($1,$2,$3,$4) ON CONFLICT (op_id) DO UPDATE SET status='ACTIVE', amount=$4, updated_at=NOW()`, [opId, creditId, fromOrgId, amount]);
  };
  const out = await ops.run(kind === "TRANSFERRED" ? "CREDIT_TRANSFER" : "CREDIT_RETIRE", key, { creditId, fromOrgId, toOrgId: toOrgId || null, amount, reason: reason || null, actorId: actor.id, ref },
    { actor, projectId: credit.project_id, recordId: credit.record_id, reserve, opRef: ref });
  return { creditId, event: kind, amount, tx: out.tx?.txHash ? { txHash: out.tx.txHash, blockNumber: out.tx.blockNumber } : null };
}

const CREDIT_COLS = `SELECT cc.*, p.code AS project_code, p.name AS project_name, p.ecosystem_type, p.region, r.code AS record_code, r.uuid AS record_uuid, o.name AS holder_org_name, o.wallet_address AS holder_wallet,
  cal.methodology_version, cal.estimate_tco2e, cal.low_tco2e, cal.high_tco2e, cal.assessment_no`;
const CREDIT_FROM = `FROM carbon_credits cc JOIN projects p ON p.id=cc.project_id JOIN monitoring_records r ON r.id=cc.record_id JOIN organizations o ON o.id=cc.holder_org_id
  JOIN carbon_calculations cal ON cal.id=cc.calculation_id`;
const CREDIT_SQL = `${CREDIT_COLS} ${CREDIT_FROM}`;
const CSORTS = { issued: { sql: "cc.issued_at" }, quantity: { sql: "cc.amount_tonnes" }, batch: { sql: "cc.batch_code", dir: "ASC" }, project: { sql: "p.code", dir: "ASC" } };
async function list(actor, query = {}) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (actor?.role === C.ROLES.FIELD) add("(p.organization_id=? OR EXISTS (SELECT 1 FROM credit_balances b WHERE b.credit_id=cc.id AND b.org_id=? AND b.balance>0))", actor.organization_id);
  if (["ISSUED", "PARTIALLY_RETIRED", "RETIRED"].includes(query.status)) add("cc.status=?", query.status);
  if (Number(query.projectId) > 0) add("cc.project_id=?", Number(query.projectId));
  if (query.q) add("(cc.batch_code ILIKE ? OR p.code ILIKE ? OR r.code ILIKE ?)", page.like(query.q));
  const pg = page.parse(query, CSORTS, "issued", "cc.id");
  const res = await page.run({ select: CREDIT_COLS, from: CREDIT_FROM, where, params }, pg);
  return { credits: res.rows, pagination: res.pagination };
}

async function detail(creditId, { live = true } = {}) {
  const credit = (await db.query(`${CREDIT_SQL} WHERE cc.id=$1`, [creditId])).rows[0];
  if (!credit) throw new HttpError(404, "Credit not found");
  const events = (await db.query(`SELECT e.*, fo.name AS from_org, tor.name AS to_org FROM credit_events e LEFT JOIN organizations fo ON fo.id=e.from_org_id LEFT JOIN organizations tor ON tor.id=e.to_org_id WHERE credit_id=$1 ORDER BY e.id`, [creditId])).rows;
  const balances = (await db.query(`SELECT b.org_id, o.name, o.wallet_address, b.balance::float AS balance FROM credit_balances b JOIN organizations o ON o.id=b.org_id WHERE b.credit_id=$1 ORDER BY b.org_id`, [creditId])).rows;
  if (live) {
    try { for (const b of balances) b.onChainBalance = await chain.batchBalance(C.recordChainId({ uuid: credit.record_uuid }), b.wallet_address); }
    catch { /* chain unreachable: leave onChainBalance undefined */ }
  }
  const activeDisputes = await disputes.countActive(db, creditId);
  return { credit, events, balances, activeDisputes };
}

async function cancelCredits(actor, creditId, body) {
  if (actor.role !== C.ROLES.ADMIN) throw new HttpError(403, "Only NCCR admin can cancel credits");
  const v = validator();
  const orgId = v.num(body, "holderOrgId", { int: true, min: 1 });
  const amount = v.num(body, "amount", { min: 1 });
  const reason = v.str(body, "reason", { min: 5, max: 2000 });
  const disputeId = body.disputeId ? v.num(body, "disputeId", { int: true, min: 1 }) : null;
  v.done();

  const credit = await C.one(db, "SELECT * FROM carbon_credits WHERE id=$1", [creditId], "Credit not found");
  const rec = await C.getRecord(db, credit.record_id);
  const ver = (await db.query("SELECT verifier_id FROM verification_records WHERE record_id=$1 AND decision='VERIFIED' ORDER BY id DESC LIMIT 1", [credit.record_id])).rows[0];
  if (ver && ver.verifier_id === actor.id) throw new HttpError(403, "The verifier of a record cannot cancel its credits (separation of duties)");

  const bal = (await db.query("SELECT balance::float AS b FROM credit_balances WHERE credit_id=$1 AND org_id=$2", [creditId, orgId])).rows[0];
  if (!bal || bal.b < amount) throw new HttpError(409, "Insufficient batch balance for this organization");

  const key = `cancel:${creditId}:${disputeId || 'admin'}:${body.idempotencyKey || crypto.randomUUID()}`;
  const ref = require("ethers").id(key);
  const caseHash = crypto.createHash("sha256").update(`cancel:${creditId}:${disputeId || 'admin'}:${reason}`).digest("hex");
  const caseHash32 = "0x" + caseHash;

  const out = await ops.run("CREDIT_CANCEL", key,
    { creditId, holderOrgId: orgId, amount, caseHash: caseHash32, ref, adminId: actor.id, reason, disputeId },
    { actor, projectId: credit.project_id, recordId: rec.id, opRef: ref });

  return { creditId, cancelledAmount: amount, ref, tx: out.tx };
}

module.exports = { availableBalance, calculate, approve, issue, moveCredits, cancelCredits, list, detail };
