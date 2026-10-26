// backend/src/services/chainHandlers.js — what each durable blockchain operation submits, how to detect that it already
// happened on-chain (probe), and how to apply its result to the registry database (finalize; always idempotent).
const ops = require("./chainOps");
const chain = require("./chain");
const audit = require("./audit");
const db = require("../db");
const C = require("./common");
const notify = require("./notify");
const { hashJSON } = require("../utils/hash");
const { ChainError } = chain;

/** Transaction details for a contract event found during recovery, so a recovered operation records its transaction exactly like a normal one. */
const txOf = async (ev) => {
  if (!ev) return null;
  const r = await chain.receiptFor(ev.transactionHash);
  if (r.status === "CONFIRMED") return r;
  if (r.status === "PENDING" || r.status === "UNKNOWN") return { txHash: ev.transactionHash, blockNumber: ev.blockNumber, blockHash: ev.blockHash }; // the contract state already proves it happened
  return null;
};

const projectMeta = (p) => hashJSON({ uuid: p.uuid, code: p.code, name: p.name, ecosystem: p.ecosystem_type, areaHa: Number(p.area_hectares), startDate: String(p.start_date).slice(0, 10) });

// ── project registration ──
ops.register("PROJECT_REGISTER", {
  async submit({ projectId }) { const p = await C.getProject(db, projectId); return chain.registerProject(C.projectChainId(p), projectMeta(p)); },
  async probe({ projectId }) { const p = await C.getProject(db, projectId), id32 = C.projectChainId(p); return (await chain.getProject(id32)).exists ? { tx: await txOf((await chain.findEvents("ProjectRegistered", id32))[0]) } : null; },
  async finalize(c, { projectId }, tx, op) {
    const p = await C.getProject(c, projectId, { lock: true });
    if (p.chain_registered) return { alreadyApplied: true };
    await c.query("UPDATE projects SET chain_registered=TRUE, chain_register_tx=$1 WHERE id=$2", [tx.txHash || null, projectId]);
    if (tx.txHash) await C.logChainTx(c, null, { tx, type: "PROJECT_REGISTERED", detail: `Project ${p.code} registered on-chain`, projectId, payloadHash: projectMeta(p) });
    await audit.record(c, { actor: await C.loadActor(c, op.actor_id), action: "PROJECT_REGISTERED_ONCHAIN", entityType: "project", entityId: projectId, projectId, txHash: tx.txHash || null, details: { metadataHash: projectMeta(p) } });
    return {};
  },
});

// ── record anchoring (first submission and re-anchoring after revision) ──
ops.register("RECORD_ANCHOR", {
  async submit({ recordId }) {
    const r = await C.getRecord(db, recordId), p = await C.getProject(db, r.project_id), id32 = C.recordChainId(r);
    const oc = await chain.getRecord(id32);
    if (oc.status === "NONE") return chain.anchorRecord(C.projectChainId(p), id32, r.content_hash, r.evidence_root);
    if (oc.status === "NEEDS_REVISION") return chain.reanchorRecord(id32, r.content_hash, r.evidence_root);
    throw new ChainError(`On-chain record is in state ${oc.status}; it cannot be anchored`, { permanent: true });
  },
  async probe({ recordId, revision }) {
    const r = await C.getRecord(db, recordId), oc = await chain.getRecord(C.recordChainId(r));
    if (!(oc.status === "ANCHORED" && oc.contentHash === r.content_hash && oc.revision === revision)) return null;
    const evs = (await chain.findEvents("RecordAnchored", C.recordChainId(r))).filter((e) => Number(e.args.revision) === revision && e.args.contentHash === r.content_hash);
    return { tx: await txOf(evs.at(-1)) };
  },
  async finalize(c, { recordId, revision }, tx, op) {
    const r = await C.getRecord(c, recordId, { lock: true });
    if (r.revision !== revision || !["SUBMITTED", "UNDER_REVIEW"].includes(r.status) || r.anchor_status === "ANCHORED") return { alreadyApplied: true };
    const txRow = tx.txHash ? await C.logChainTx(c, null, { tx, type: revision > 1 ? "RECORD_REANCHORED" : "RECORD_ANCHORED", detail: `Record ${r.code} revision ${revision} anchored`, projectId: r.project_id, recordId, payloadHash: r.content_hash }) : null;
    await c.query("UPDATE monitoring_records SET anchor_status='ANCHORED', anchor_tx_hash=COALESCE($1, anchor_tx_hash) WHERE id=$2", [tx.txHash || null, recordId]);
    await audit.record(c, { actor: await C.loadActor(c, op.actor_id), action: "RECORD_ANCHORED", entityType: "monitoring_record", entityId: recordId, projectId: r.project_id, recordId, txHash: tx.txHash || null,
      details: { code: r.code, revision, contentHash: r.content_hash, evidenceRoot: r.evidence_root, txRowId: txRow } });
    return {};
  },
});

// ── verification decision ──
ops.register("VERIFICATION", {
  async submit({ recordId, decision, reportHash, verifierId }) {
    const r = await C.getRecord(db, recordId), v = await C.loadActor(db, verifierId);
    return chain.recordVerification(C.recordChainId(r), decision, reportHash, v?.wallet_address);
  },
  async probe({ recordId, reportHash }) {
    const r = await C.getRecord(db, recordId), oc = await chain.getRecord(C.recordChainId(r));
    if (!(oc.verificationHash === reportHash && oc.status !== "ANCHORED")) return null;
    const evs = (await chain.findEvents("RecordVerified", C.recordChainId(r))).filter((e) => e.args.verificationHash === reportHash);
    return { tx: await txOf(evs.at(-1)) };
  },
  async finalize(c, p, tx, op) {
    const rec = await C.getRecord(c, p.recordId, { lock: true });
    const done = await C.fromPg(c, "SELECT 1 FROM verification_records WHERE record_id=$1 AND revision=$2 AND report_hash=$3", [p.recordId, p.revision, p.reportHash]);
    if (done.length || rec.status !== "UNDER_REVIEW" || rec.revision !== p.revision) return { alreadyApplied: true };
    const actor = await C.loadActor(c, p.verifierId);
    const txId = tx.txHash ? await C.logChainTx(c, actor, { tx, type: "VERIFICATION_RECORDED", detail: `Record ${rec.code}: ${p.decision}`, projectId: rec.project_id, recordId: p.recordId, payloadHash: p.reportHash }) : null;
    const { rows } = await c.query(`INSERT INTO verification_records (record_id, verifier_id, decision, revision, checks, comments, report_hash, tx_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [p.recordId, p.verifierId, p.decision, p.revision, JSON.stringify(p.checks), p.comments || null, p.reportHash, tx.txHash || null]);
    await c.query("UPDATE monitoring_records SET status=$1, reviewed_at=NOW(), updated_at=NOW() WHERE id=$2", [p.decision, p.recordId]);
    await c.query("UPDATE projects SET verification_status=$1, updated_at=NOW() WHERE id=$2", [p.decision, rec.project_id]);
    const action = { VERIFIED: "RECORD_VERIFIED", REJECTED: "RECORD_REJECTED", NEEDS_REVISION: "REVISION_REQUESTED" }[p.decision];
    await audit.record(c, { actor, action, entityType: "monitoring_record", entityId: p.recordId, projectId: rec.project_id, recordId: p.recordId, previousStatus: "UNDER_REVIEW", newStatus: p.decision, txHash: tx.txHash || null,
      details: { code: rec.code, revision: p.revision, comments: p.comments || null, reportHash: p.reportHash, txRowId: txId, failedChecks: p.failedChecks || [] } });
    const label = { VERIFIED: "verified", REJECTED: "rejected", NEEDS_REVISION: "returned for revision" }[p.decision];
    await notify.create(c, [rec.submitted_by], { type: `RECORD_${p.decision}`, title: `Record ${rec.code} was ${label}`, body: p.comments || undefined, href: `#/records/${p.recordId}`, entityType: "monitoring_record", entityId: p.recordId, severity: p.decision === "VERIFIED" ? "INFO" : "ACTION", dedupeKey: `decision:${p.recordId}:${p.revision}` });
    if (p.decision === "VERIFIED") await notify.toRole(c, "NCCR_ADMIN", { type: "READY_FOR_ASSESSMENT", title: `Record ${rec.code} is verified and ready for a carbon assessment`, href: `#/records/${p.recordId}`, entityType: "monitoring_record", entityId: p.recordId, severity: "ACTION", dedupeKey: `ready:${p.recordId}` });
    return { verificationId: rows[0].id, decision: p.decision };
  },
});

// ── credit issuance ──
ops.register("CREDIT_ISSUE", {
  async submit({ calcId, holderOrgId, quantity, estimateHash, adminId }) {
    const calc = await C.one(db, "SELECT * FROM carbon_calculations WHERE id=$1", [calcId]), rec = await C.getRecord(db, calc.record_id);
    const org = await C.one(db, "SELECT wallet_address FROM organizations WHERE id=$1", [holderOrgId]), admin = await C.loadActor(db, adminId);
    return chain.issueCredits(C.recordChainId(rec), quantity, estimateHash, org.wallet_address, admin?.wallet_address);
  },
  async probe({ calcId, estimateHash, quantity }) {
    const calc = await C.one(db, "SELECT * FROM carbon_calculations WHERE id=$1", [calcId]), oc = await chain.getRecord(C.recordChainId(await C.getRecord(db, calc.record_id)));
    if (!(oc.status === "CREDITED" && oc.estimateHash === estimateHash && oc.creditQuantity === quantity)) return null;
    const rec = await C.getRecord(db, calc.record_id), evs = (await chain.findEvents("CreditsIssued", C.recordChainId(rec))).filter((e) => e.args.estimateHash === estimateHash);
    return { tx: await txOf(evs[0]) };
  },
  async finalize(c, p, tx, op) {
    const calc = await C.one(c, "SELECT * FROM carbon_calculations WHERE id=$1 FOR UPDATE", [p.calcId]);
    if ((await C.fromPg(c, "SELECT 1 FROM carbon_credits WHERE record_id=$1", [calc.record_id])).length) return { alreadyApplied: true };
    const rec = await C.getRecord(c, calc.record_id), project = await C.getProject(c, calc.project_id, { lock: true });
    const org = await C.one(c, "SELECT * FROM organizations WHERE id=$1", [p.holderOrgId]), actor = await C.loadActor(c, p.adminId);
    const { rows } = await c.query(
      `INSERT INTO carbon_credits (project_id, record_id, calculation_id, holder_org_id, amount_tonnes, tx_hash, block_number, issued_by, data_origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [project.id, rec.id, calc.id, p.holderOrgId, p.quantity, tx.txHash || null, tx.blockNumber ?? null, p.adminId, project.data_origin]);
    const credit = rows[0];
    await c.query("UPDATE carbon_credits SET batch_code=$1 WHERE id=$2", [`CB-${C.pad(credit.id, 5)}`, credit.id]);
    credit.batch_code = `CB-${C.pad(credit.id, 5)}`;
    await c.query("INSERT INTO credit_balances (credit_id, org_id, balance) VALUES ($1,$2,$3)", [credit.id, p.holderOrgId, p.quantity]);
    await c.query(`INSERT INTO credit_events (credit_id, event_type, to_org_id, to_wallet, amount, actor_id, tx_hash) VALUES ($1,'ISSUED',$2,$3,$4,$5,$6)`, [credit.id, p.holderOrgId, org.wallet_address, p.quantity, p.adminId, tx.txHash || null]);
    if (tx.txHash) await C.logChainTx(c, actor, { tx, type: "CREDITS_ISSUED", detail: `${p.quantity} registry credit(s) issued for ${rec.code} to ${org.name}`, projectId: project.id, recordId: rec.id, payloadHash: p.estimateHash });
    await c.query("UPDATE projects SET credit_status='ISSUED', updated_at=NOW() WHERE id=$1", [project.id]);
    await audit.record(c, { actor, action: "CREDITS_ISSUED", entityType: "carbon_credit", entityId: credit.id, projectId: project.id, recordId: rec.id, previousStatus: "APPROVED", newStatus: "ISSUED", txHash: tx.txHash || null,
      details: { batch: credit.batch_code, quantity: p.quantity, holderOrg: org.name, estimateHash: p.estimateHash } });
    await notify.toOrg(c, p.holderOrgId, { type: "CREDITS_ISSUED", title: `${p.quantity} registry credit(s) were issued to ${org.name}`, body: `Batch ${credit.batch_code} for record ${rec.code}.`, href: `#/credits/${credit.id}`, entityType: "carbon_credit", entityId: credit.id, dedupeKey: `issued:${credit.id}` });
    await notify.toRole(c, "NCCR_ADMIN", { type: "CREDITS_ISSUED", title: `Batch ${credit.batch_code} was issued (${p.quantity})`, href: `#/credits/${credit.id}`, entityType: "carbon_credit", entityId: credit.id, dedupeKey: `issued:${credit.id}` });
    return { creditId: credit.id };
  },
});

// ── transfer / retirement: identified on-chain by a unique reference, so recovery can prove whether the call already happened ──
const move = (kind) => ({
  async submit(p) {
    const credit = await C.one(db, "SELECT * FROM carbon_credits WHERE id=$1", [p.creditId]), rec = await C.getRecord(db, credit.record_id);
    const from = await C.one(db, "SELECT * FROM organizations WHERE id=$1", [p.fromOrgId]);
    if (kind === "TRANSFERRED") { const to = await C.one(db, "SELECT * FROM organizations WHERE id=$1", [p.toOrgId]); return chain.transfer(C.recordChainId(rec), from.wallet_address, to.wallet_address, p.amount, p.ref); }
    return chain.retire(C.recordChainId(rec), from.wallet_address, p.amount, p.reason, p.ref);
  },
  async probe(p) {
    if (!(await chain.refUsed(p.ref))) return null;
    const ev = await chain.findRefEvent(kind === "TRANSFERRED" ? "transfer" : "retire", p.ref);
    if (!ev) return null;
    const r = await chain.receiptFor(ev.transactionHash);
    if (r.status === "CONFIRMED") return { tx: r };
    if (r.status === "PENDING" || r.status === "UNKNOWN") return { tx: { txHash: ev.transactionHash, blockNumber: ev.blockNumber, blockHash: ev.blockHash } }; // the contract state already proves it happened
    return null;
  },
  async finalize(c, p, tx) {
    if (tx.txHash && (await C.fromPg(c, "SELECT 1 FROM credit_events WHERE tx_hash=$1", [tx.txHash])).length) return { alreadyApplied: true };
    const credit = await C.one(c, "SELECT * FROM carbon_credits WHERE id=$1 FOR UPDATE", [p.creditId]);
    const from = await C.one(c, "SELECT * FROM organizations WHERE id=$1", [p.fromOrgId]), to = p.toOrgId ? await C.one(c, "SELECT * FROM organizations WHERE id=$1", [p.toOrgId]) : null;
    const actor = await C.loadActor(c, p.actorId);
    const bal = (await C.fromPg(c, "SELECT balance::float AS b FROM credit_balances WHERE credit_id=$1 AND org_id=$2 FOR UPDATE", [p.creditId, p.fromOrgId]))[0];
    if (!bal || bal.b < p.amount) throw new Error("Registry balance is lower than the confirmed on-chain movement; manual reconciliation required");
    await c.query("UPDATE credit_balances SET balance=balance-$1 WHERE credit_id=$2 AND org_id=$3", [p.amount, p.creditId, p.fromOrgId]);
    if (to) await c.query(`INSERT INTO credit_balances (credit_id, org_id, balance) VALUES ($1,$2,$3) ON CONFLICT (credit_id, org_id) DO UPDATE SET balance = credit_balances.balance + $3`, [p.creditId, p.toOrgId, p.amount]);
    else { const retired = Number(credit.retired_tonnes) + p.amount; await c.query("UPDATE carbon_credits SET retired_tonnes=$1, status=$2 WHERE id=$3", [retired, retired >= Number(credit.amount_tonnes) ? "RETIRED" : "PARTIALLY_RETIRED", p.creditId]); }
    await c.query(`INSERT INTO credit_events (credit_id, event_type, from_org_id, to_org_id, from_wallet, to_wallet, amount, reason, actor_id, tx_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.creditId, kind, p.fromOrgId, p.toOrgId || null, from.wallet_address, to?.wallet_address || null, p.amount, p.reason || null, p.actorId, tx.txHash || null]);
    if (tx.txHash) await C.logChainTx(c, actor, { tx, type: kind === "TRANSFERRED" ? "CREDITS_TRANSFERRED" : "CREDITS_RETIRED", detail: kind === "TRANSFERRED" ? `${p.amount} credit(s) ${from.name} -> ${to.name}` : `${p.amount} credit(s) retired by ${from.name}`, projectId: credit.project_id, recordId: credit.record_id });
    await audit.record(c, { actor, action: kind === "TRANSFERRED" ? "CREDITS_TRANSFERRED" : "CREDITS_RETIRED", entityType: "carbon_credit", entityId: p.creditId, projectId: credit.project_id, recordId: credit.record_id, txHash: tx.txHash || null,
      details: { amount: p.amount, from: from.name, to: to?.name || null, reason: p.reason || null, ref: p.ref } });
    const verb = kind === "TRANSFERRED" ? "transferred" : "retired";
    const n = { type: `CREDITS_${kind}`, title: `${p.amount} credit(s) ${verb}${to ? ` from ${from.name} to ${to.name}` : ` by ${from.name}`}`, href: `#/credits/${p.creditId}`, entityType: "carbon_credit", entityId: p.creditId, dedupeKey: `${kind}:${tx.txHash || p.ref}` };
    await notify.toOrg(c, p.fromOrgId, n); if (to) await notify.toOrg(c, p.toOrgId, n); if (!to) await notify.toRole(c, "NCCR_ADMIN", n);
    return { creditId: p.creditId, event: kind, amount: p.amount };
  },
});
ops.register("CREDIT_TRANSFER", move("TRANSFERRED"));
ops.register("CREDIT_RETIRE", move("RETIRED"));

// ── role assignment on the contract ──
ops.register("ROLE_CHANGE", {
  probe: async ({ account, role, granted }) => { const r = await chain.rolesOf(account); return r[role] === granted ? { tx: null } : null; },
  submit: ({ account, role, granted }) => (role === "verifier" ? chain.setVerifier(account, granted) : chain.setRegistrar(account, granted)),
  async finalize(c, p, tx, op) {
    const actor = await C.loadActor(c, op.actor_id);
    if (tx.txHash) await C.logChainTx(c, actor, { tx, type: "ROLE_CHANGED", detail: `${p.role} role ${p.granted ? "granted to" : "revoked from"} ${p.account}` });
    await audit.record(c, { actor, action: "CHAIN_ROLE_CHANGED", entityType: p.userId ? "user" : "chain_role", entityId: p.userId || p.account, txHash: tx.txHash || null, details: { role: p.role, granted: p.granted, account: p.account } });
    return {};
  },
});

// ── credit freezing & unfreezing on-chain ──
ops.register("CREDIT_FREEZE", {
  async submit({ creditId, frozen, caseHash, adminId }) {
    const credit = await C.one(db, "SELECT * FROM carbon_credits WHERE id=$1", [creditId]);
    const rec = await C.getRecord(db, credit.record_id);
    const admin = await C.loadActor(db, adminId);
    return chain.setBatchFrozen(C.recordChainId(rec), !!frozen, caseHash, admin?.wallet_address);
  },
  async probe({ creditId, frozen }) {
    const credit = await C.one(db, "SELECT * FROM carbon_credits WHERE id=$1", [creditId]);
    const rec = await C.getRecord(db, credit.record_id);
    const id32 = C.recordChainId(rec);
    const oc = await chain.isBatchFrozen(id32);
    if (oc !== !!frozen) return null;
    const evs = await chain.findEvents("BatchFrozen", id32);
    const ev = evs.filter((e) => Boolean(e.args.frozen) === !!frozen).at(-1);
    return { tx: await txOf(ev) };
  },
  async finalize(c, p, tx, op) {
    const credit = await C.one(c, "SELECT * FROM carbon_credits WHERE id=$1 FOR UPDATE", [p.creditId]);
    const actor = await C.loadActor(c, op.actor_id);
    await c.query("UPDATE carbon_credits SET is_frozen=$1 WHERE id=$2", [!!p.frozen, p.creditId]);
    if (p.disputeId) {
      await c.query("UPDATE credit_disputes SET onchain_frozen=$1, freeze_tx_hash=COALESCE($2, freeze_tx_hash) WHERE id=$3", [!!p.frozen, tx.txHash || null, p.disputeId]);
    }
    if (tx.txHash) await C.logChainTx(c, actor, { tx, type: p.frozen ? "CREDITS_FROZEN" : "CREDITS_UNFROZEN", detail: `Batch ${credit.batch_code} ${p.frozen ? "frozen" : "unfrozen"} on-chain`, projectId: credit.project_id, recordId: credit.record_id });
    await audit.record(c, { actor, action: p.frozen ? "CREDITS_FROZEN_ONCHAIN" : "CREDITS_UNFROZEN_ONCHAIN", entityType: "carbon_credit", entityId: p.creditId, projectId: credit.project_id, recordId: credit.record_id, txHash: tx.txHash || null, details: { frozen: !!p.frozen, caseHash: p.caseHash } });
    return { creditId: p.creditId, frozen: !!p.frozen };
  },
});

// ── credit cancellation on-chain ──
ops.register("CREDIT_CANCEL", {
  async submit({ creditId, holderOrgId, amount, caseHash, ref, adminId }) {
    const credit = await C.one(db, "SELECT * FROM carbon_credits WHERE id=$1", [creditId]);
    const rec = await C.getRecord(db, credit.record_id);
    const org = await C.one(db, "SELECT wallet_address FROM organizations WHERE id=$1", [holderOrgId]);
    const admin = await C.loadActor(db, adminId);
    return chain.cancelCredits(C.recordChainId(rec), org.wallet_address, amount, caseHash, ref, admin?.wallet_address);
  },
  async probe(p) {
    if (!(await chain.refUsed(p.ref))) return null;
    const credit = await C.one(db, "SELECT * FROM carbon_credits WHERE id=$1", [p.creditId]);
    const rec = await C.getRecord(db, credit.record_id);
    const id32 = C.recordChainId(rec);
    const evs = (await chain.findEvents("CreditsCancelled", id32)).filter((e) => e.args.ref === p.ref);
    return { tx: await txOf(evs[0]) };
  },
  async finalize(c, p, tx, op) {
    const credit = await C.one(c, "SELECT * FROM carbon_credits WHERE id=$1 FOR UPDATE", [p.creditId]);
    const org = await C.one(c, "SELECT * FROM organizations WHERE id=$1", [p.holderOrgId]);
    const actor = await C.loadActor(c, op.actor_id);
    const bal = (await C.fromPg(c, "SELECT balance::float AS b FROM credit_balances WHERE credit_id=$1 AND org_id=$2 FOR UPDATE", [p.creditId, p.holderOrgId]))[0];
    if (!bal || bal.b < p.amount) throw new Error("Registry balance is lower than the cancelled amount");
    await c.query("UPDATE credit_balances SET balance=balance-$1 WHERE credit_id=$2 AND org_id=$3", [p.amount, p.creditId, p.holderOrgId]);
    const cancelled = Number(credit.cancelled_tonnes || 0) + p.amount;
    await c.query("UPDATE carbon_credits SET cancelled_tonnes=$1, status=$2 WHERE id=$3", [cancelled, cancelled >= Number(credit.amount_tonnes) ? "CANCELLED" : "PARTIALLY_CANCELLED", p.creditId]);
    await c.query(`INSERT INTO credit_events (credit_id, event_type, from_org_id, from_wallet, amount, reason, actor_id, tx_hash) VALUES ($1,'CANCELLED',$2,$3,$4,$5,$6,$7)`,
      [p.creditId, p.holderOrgId, org.wallet_address, p.amount, p.reason || null, op.actor_id, tx.txHash || null]);
    await c.query(`INSERT INTO credit_cancellations (credit_id, record_id, holder_org_id, dispute_id, amount, case_hash, op_ref, tx_hash, cancelled_by, reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (op_ref) DO NOTHING`,
      [p.creditId, credit.record_id, p.holderOrgId, p.disputeId || null, p.amount, p.caseHash, p.ref, tx.txHash || null, op.actor_id, p.reason || "Credit cancelled by administrator"]);
    if (p.disputeId && tx.txHash) {
      await c.query("UPDATE credit_disputes SET cancellation_tx_hash=$1 WHERE id=$2", [tx.txHash, p.disputeId]);
    }
    if (tx.txHash) await C.logChainTx(c, actor, { tx, type: "CREDITS_CANCELLED", detail: `${p.amount} credit(s) of batch ${credit.batch_code} cancelled on-chain`, projectId: credit.project_id, recordId: credit.record_id });
    await audit.record(c, { actor, action: "CREDITS_CANCELLED_ONCHAIN", entityType: "carbon_credit", entityId: p.creditId, projectId: credit.project_id, recordId: credit.record_id, txHash: tx.txHash || null,
      details: { amount: p.amount, holderOrg: org.name, caseHash: p.caseHash, ref: p.ref, reason: p.reason } });
    return { creditId: p.creditId, cancelledAmount: p.amount };
  },
});

module.exports = { projectMeta };
