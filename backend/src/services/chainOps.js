// backend/src/services/chainOps.js — durable, idempotent blockchain operations with crash recovery.
//
// CONSISTENCY MODEL (what is and is not guaranteed)
//   PostgreSQL and a blockchain cannot be updated atomically. Every consequential on-chain action is stored as an operation row BEFORE
//   any external side effect, and driven through explicit states:
//     PENDING   intent stored; no transaction known
//     SUBMITTED transaction hash stored
//     CONFIRMED receipt successful at the required depth on the canonical chain; registry update not yet applied
//     COMPLETED registry updated (one database transaction that also records the audit entry)
//     FAILED    rejected/reverted by the contract (permanent); funds reservation released
//   RECOVERY INVARIANTS (each is exercised by tests/recovery.test.js)
//     I1  An operation's economic effect happens at most once on-chain: state-based probes (anchor/verify/issue/role) and unique
//         on-chain references (transfer/retire) make re-submission safe after any crash, including a crash between the network accepting
//         a transaction and its hash being stored.
//     I2  The registry applies the effect of a confirmed operation exactly once (finalize is idempotent and COMPLETED is terminal).
//     I3  Funds for a transfer/retirement are reserved atomically with the operation, so concurrent requests cannot spend the same credits.
//     I4  A transaction that is dropped or reorganised away is detected (receipt unknown/non-canonical) and re-submitted only after the probe
//         shows its effect is absent on-chain.
//     I5  A timeout never means "failed": it leaves the operation SUBMITTED/PENDING for reconciliation.
//   NOT guaranteed: that two ledgers are ever instantaneously equal. Between steps they can differ; reconciliation closes the gap and
//   consistency checks (services/consistency.js) expose any divergence that recovery cannot explain.
const db = require("../db");
const chain = require("./chain");
const { ChainError } = chain;
const { HttpError } = require("../utils/http");
const { canonical } = require("../utils/hash");
const cfg = require("../config");

const handlers = {};
const register = (type, h) => { handlers[type] = h; };

/** Fault injection (tests only): simulates a process crash at a named boundary. A crash leaves state exactly as it was. */
class SimulatedCrash extends Error { constructor(point) { super(`simulated crash at ${point}`); this.point = point; } }
const testHooks = { fault: null, failFinalizeOnce: false };
function fault(point) {
  const f = testHooks.fault;
  if (f && f.point === point && f.times > 0) { f.times--; throw new SimulatedCrash(point); }
}

const LOCK_SECONDS = 120;
const same = (a, b) => canonical(a) === canonical(b);
const logEvent = (opId, event, detail = {}) => db.query("INSERT INTO chain_operation_events (op_id, event, detail) VALUES ($1,$2,$3)", [opId, event, JSON.stringify(detail)]).catch(() => {});

async function claim(key) {
  const { rows } = await db.query(
    `UPDATE chain_operations SET locked_until = NOW() + ($2 || ' seconds')::interval, attempts = attempts + 1, updated_at = NOW()
     WHERE idempotency_key=$1 AND status <> 'COMPLETED' AND (locked_until IS NULL OR locked_until < NOW()) RETURNING *`, [key, String(LOCK_SECONDS)]);
  return rows[0] || null;
}
const patch = (id, fields) => {
  const cols = Object.keys(fields);
  return db.query(`UPDATE chain_operations SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(", ")}, updated_at=NOW() WHERE id=$1`, [id, ...Object.values(fields)]);
};
const release = (id, err) => db.query("UPDATE chain_operations SET locked_until=NULL, last_error=$2, updated_at=NOW() WHERE id=$1", [id, err || null]);
const releaseReservation = (id) => db.query("UPDATE credit_reservations SET status='RELEASED', updated_at=NOW() WHERE op_id=$1 AND status='ACTIVE'", [id]);

/** Move one operation as far forward as possible. Throws HttpError describing where it stopped. */
async function drive(op, h) {
  let handle = null, txInfo = null;
  try {
    for (let guard = 0; guard < 4; guard++) {
      if (op.status === "PENDING") {
        const hit = h.probe ? await h.probe(op.payload, op) : null;
        if (hit) { txInfo = hit.tx || null; await patch(op.id, { status: "CONFIRMED", tx_hash: txInfo?.txHash || null, block_number: txInfo?.blockNumber ?? null, block_hash: txInfo?.blockHash ?? null, last_error: null }); op.status = "CONFIRMED"; await logEvent(op.id, "FOUND_ON_CHAIN", { txHash: txInfo?.txHash || null }); }
        else {
          fault("before_submit");
          handle = await h.submit(op.payload, op);
          fault("after_submit_before_hash");
          await patch(op.id, { status: "SUBMITTED", tx_hash: handle.hash, submitted_at: new Date(), last_error: null }); op.status = "SUBMITTED"; op.tx_hash = handle.hash; op.submitted_at = new Date();
          await logEvent(op.id, "SUBMITTED", { txHash: handle.hash });
          fault("after_hash");
        }
      }
      if (op.status === "SUBMITTED") {
        if (handle) txInfo = await handle.wait();
        else {
          const r = await chain.receiptFor(op.tx_hash);
          if (r.status === "FAILED") throw new ChainError("Transaction reverted", { permanent: true });
          if (r.status === "CONFIRMED") txInfo = r;
          else {
            const hit = h.probe ? await h.probe(op.payload, op) : null;
            if (hit) txInfo = hit.tx || { txHash: op.tx_hash };
            else if (r.status === "UNKNOWN" && h.probe && Date.now() - new Date(op.submitted_at || op.updated_at).getTime() >= cfg.chain.dropGraceMs) {
              // Dropped, replaced or reorganised away, and the probe proves its effect is absent on-chain: safe to submit again.
              await logEvent(op.id, "DROPPED_RESUBMIT", { previousTxHash: op.tx_hash, reason: r.reason || "not found" });
              await patch(op.id, { status: "PENDING", tx_hash: null, block_number: null, block_hash: null, last_error: `Transaction ${op.tx_hash} was not found after ${cfg.chain.dropGraceMs} ms; re-submitting` });
              op.status = "PENDING"; op.tx_hash = null; handle = null; continue;
            } else throw new ChainError(r.status === "PENDING" ? "Transaction is still pending or awaiting confirmations" : "Transaction is not visible on the network yet", { timeout: true });
          }
        }
        fault("after_confirm");
        await patch(op.id, { status: "CONFIRMED", tx_hash: txInfo.txHash || op.tx_hash, block_number: txInfo.blockNumber ?? null, block_hash: txInfo.blockHash ?? null, last_error: null }); op.status = "CONFIRMED";
        await logEvent(op.id, "CONFIRMED", { txHash: txInfo.txHash || op.tx_hash, block: txInfo.blockNumber ?? null });
      }
      if (op.status === "CONFIRMED") {
        if (!txInfo && op.tx_hash) txInfo = { txHash: op.tx_hash, blockNumber: op.block_number == null ? null : Number(op.block_number), blockHash: op.block_hash || undefined };
        fault("before_db_transition");
        if (testHooks.failFinalizeOnce) { testHooks.failFinalizeOnce = false; throw Object.assign(new Error("simulated registry failure"), { registry: true }); }
        const result = await db.tx(async (c) => {
          const r = await h.finalize(c, op.payload, txInfo || {}, op);
          await c.query("UPDATE credit_reservations SET status='CONSUMED', updated_at=NOW() WHERE op_id=$1 AND status='ACTIVE'", [op.id]);
          await c.query("UPDATE chain_operations SET status='COMPLETED', result=$2, completed_at=NOW(), locked_until=NULL, last_error=NULL, updated_at=NOW() WHERE id=$1", [op.id, JSON.stringify(r ?? {})]);
          await c.query("INSERT INTO chain_operation_events (op_id, event, detail) VALUES ($1,'COMPLETED',$2)", [op.id, JSON.stringify({ txHash: txInfo?.txHash || null })]);
          return r;
        });
        return { result, tx: txInfo };
      }
    }
    throw new Error(`Unexpected operation state ${op.status}`);
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e; // a crash changes nothing: the operation stays exactly where it was (lock included)
    if (e instanceof HttpError) { await release(op.id, e.message); await logEvent(op.id, "RETRYABLE_ERROR", { message: e.message }); throw e; }
    if (e instanceof ChainError && e.permanent) {
      await db.query("UPDATE chain_operations SET status='FAILED', last_error=$2, locked_until=NULL, updated_at=NOW() WHERE id=$1", [op.id, e.message]);
      await releaseReservation(op.id); await logEvent(op.id, "FAILED", { message: e.message });
      await db.tx((c) => require("./notify").toRole(c, "NCCR_ADMIN", { type: "OPERATION_FAILED", severity: "ALERT", title: `Blockchain operation #${op.id} (${op.op_type.replaceAll("_", " ").toLowerCase()}) failed`, body: e.message, href: "#/network", entityType: "chain_operation", entityId: op.id, dedupeKey: `opfail:${op.id}` })).catch(() => {});
      throw new HttpError(409, `The blockchain network rejected the transaction: ${e.message}`, { operationId: Number(op.id) });
    }
    await release(op.id, e.message); await logEvent(op.id, e instanceof ChainError ? "NETWORK_ERROR" : "REGISTRY_ERROR", { message: e.message });
    if (e instanceof ChainError) {
      throw new HttpError(503, e.timeout ? "The transaction was submitted but is not confirmed yet. It will be completed automatically once confirmed." : `Blockchain network unavailable: ${e.message}. The operation is stored and will be retried automatically.`,
        { operationId: Number(op.id), txHash: op.tx_hash || undefined });
    }
    console.error("[chainOps] registry update failed for operation", op.id, e.message);
    throw new HttpError(503, "The transaction is confirmed on the blockchain, but the registry update did not complete. It will be retried automatically.", { operationId: Number(op.id), txHash: op.tx_hash || undefined });
  }
}

/**
 * @param meta { actor, projectId, recordId, reserve?: async (client, opId) => void }  reserve() runs in the SAME transaction that stores the operation
 */
async function run(type, key, payload, { actor, projectId, recordId, reserve, opRef } = {}) {
  const h = handlers[type];
  if (!h) throw new Error(`No handler for ${type}`);
  const json = JSON.stringify(payload);
  const created = await db.tx(async (c) => {
    const ins = await c.query(`INSERT INTO chain_operations (idempotency_key, op_type, project_id, record_id, actor_id, payload, op_ref) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [key, type, projectId ?? null, recordId ?? null, actor?.id ?? null, json, opRef ?? null]);
    if (ins.rows[0]) { if (reserve) await reserve(c, ins.rows[0].id); await c.query("INSERT INTO chain_operation_events (op_id, event, detail) VALUES ($1,'STORED',$2)", [ins.rows[0].id, JSON.stringify({ type })]); }
    return !!ins.rows[0];
  });
  const cur = (await db.query("SELECT * FROM chain_operations WHERE idempotency_key=$1", [key])).rows[0];
  if (cur.status === "COMPLETED") return { result: cur.result, tx: cur.tx_hash ? { txHash: cur.tx_hash, blockNumber: cur.block_number == null ? null : Number(cur.block_number) } : null, replayed: true };
  if (!created) {
    if (cur.status === "FAILED") {
      await db.tx(async (c) => {
        await c.query("UPDATE chain_operations SET status='PENDING', tx_hash=NULL, block_number=NULL, payload=$2, actor_id=$3, last_error=NULL, updated_at=NOW() WHERE id=$1", [cur.id, json, actor?.id ?? null]);
        if (reserve) await reserve(c, cur.id);
        await c.query("INSERT INTO chain_operation_events (op_id, event, detail) VALUES ($1,'RESTARTED_AFTER_FAILURE','{}')", [cur.id]);
      });
    } else if (!same(cur.payload, JSON.parse(json))) throw new HttpError(409, "A different operation with the same identity is already in progress for this item", { operationId: Number(cur.id) });
  }
  const op = await claim(key);
  if (!op) throw new HttpError(409, "This operation is already being processed", { operationId: Number(cur.id) });
  return drive(op, h);
}

/** Resume interrupted operations. Safe to call at any time and from several processes. */
async function reconcile({ minAgeMs = 0 } = {}) {
  const summary = { examined: 0, completed: 0, failed: 0, stillPending: 0, errors: [] };
  const { rows } = await db.query(
    `SELECT idempotency_key FROM chain_operations WHERE status IN ('PENDING','SUBMITTED','CONFIRMED') AND (locked_until IS NULL OR locked_until < NOW())
       AND updated_at < NOW() - ($1 || ' milliseconds')::interval ORDER BY id LIMIT 50`, [String(minAgeMs)]);
  for (const r of rows) {
    const op = await claim(r.idempotency_key);
    if (!op) continue;
    summary.examined++;
    const h = handlers[op.op_type];
    try {
      fault("during_reconcile");
      if (!h) { await patch(op.id, { status: "FAILED", last_error: `No handler for ${op.op_type}`, locked_until: null }); await releaseReservation(op.id); summary.failed++; continue; }
      await logEvent(op.id, "RECONCILE_ATTEMPT", { status: op.status });
      await drive(op, h); summary.completed++;
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      (e.status === 409 ? summary.failed++ : summary.stillPending++); summary.errors.push(`#${op.id} ${op.op_type}: ${e.message}`);
    }
  }
  // Records whose anchoring was never started (for example the network was down at submission) are retried here too.
  const pending = (await db.query("SELECT id FROM monitoring_records WHERE anchor_status='PENDING' AND status IN ('SUBMITTED','UNDER_REVIEW') ORDER BY id LIMIT 50")).rows;
  for (const r of pending) {
    summary.examined++;
    try { await require("./records").anchorRecord(null, r.id); summary.completed++; }
    catch (e) { (e.status === 409 ? summary.failed++ : summary.stillPending++); summary.errors.push(`record ${r.id}: ${e.message}`); }
  }
  if (summary.failed || summary.errors.length) await db.tx((c) => require("./notify").toRole(c, "NCCR_ADMIN", { type: "RECONCILIATION_PROBLEM", severity: "WARNING", title: "Reconciliation could not finish some operations", body: summary.errors.slice(0, 3).join("; ") || `${summary.failed} operation(s) failed`, href: "#/network", dedupeKey: `reconcile:${new Date().toISOString().slice(0, 13)}` })).catch(() => {});
  return summary;
}

async function counts() {
  const { rows } = await db.query("SELECT status, COUNT(*)::int AS n FROM chain_operations GROUP BY status");
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
async function backlog() {
  const r = (await db.query(`SELECT COUNT(*) FILTER (WHERE status IN ('PENDING','SUBMITTED','CONFIRMED'))::int AS open, COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
    COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status IN ('PENDING','SUBMITTED','CONFIRMED')))), 0)::int AS oldest_open_seconds FROM chain_operations`)).rows[0];
  return { open: r.open, failed: r.failed, oldestOpenSeconds: r.oldest_open_seconds };
}

let timer = null;
function startReconciler(onRun) {
  if (timer || cfg.reconcileIntervalMs <= 0) return;
  timer = setInterval(() => { chain.ensure().then(() => reconcile({ minAgeMs: 5000 })).then((s) => onRun?.(s)).catch(() => {}); }, cfg.reconcileIntervalMs);
  timer.unref();
}

module.exports = { register, run, reconcile, counts, backlog, startReconciler, testHooks, SimulatedCrash, logEvent };
