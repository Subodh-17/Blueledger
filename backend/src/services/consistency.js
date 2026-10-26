// backend/src/services/consistency.js — compares the registry (PostgreSQL) with the authoritative contract state.
// Read-only: it reports divergence; it never "fixes" balances silently. Divergence that recovery cannot explain needs a human decision.
const db = require("../db");
const chain = require("./chain");
const C = require("./common");

async function check() {
  const out = { checkedAt: new Date().toISOString(), ok: true, credits: 0, balancesChecked: 0, mismatches: [] };
  const credits = (await db.query(`SELECT cc.id, cc.amount_tonnes::float AS issued, cc.retired_tonnes::float AS retired, COALESCE(cc.cancelled_tonnes,0)::float AS cancelled, r.uuid, r.code FROM carbon_credits cc JOIN monitoring_records r ON r.id=cc.record_id ORDER BY cc.id`)).rows;
  const known = new Set();
  for (const cr of credits) {
    out.credits++;
    const id32 = C.recordChainId({ uuid: cr.uuid }); known.add(id32);
    const bals = (await db.query(`SELECT cb.org_id, cb.balance::float AS b, o.wallet_address, o.name FROM credit_balances cb JOIN organizations o ON o.id=cb.org_id WHERE cb.credit_id=$1`, [cr.id])).rows;
    let onChainHeld = 0;
    for (const b of bals) {
      const oc = await chain.batchBalance(id32, b.wallet_address); out.balancesChecked++; onChainHeld += oc;
      if (oc !== b.b) out.mismatches.push({ type: "BALANCE", credit: cr.id, record: cr.code, holder: b.name, registry: b.b, onChain: oc });
    }
    const onChainRetired = await chain.batchRetired(id32);
    const onChainCancelled = await chain.batchCancelled(id32);
    if (onChainRetired !== cr.retired) out.mismatches.push({ type: "RETIRED", credit: cr.id, record: cr.code, registry: cr.retired, onChain: onChainRetired });
    if (onChainCancelled !== cr.cancelled) out.mismatches.push({ type: "CANCELLED", credit: cr.id, record: cr.code, registry: cr.cancelled, onChain: onChainCancelled });
    if (onChainHeld + onChainRetired + onChainCancelled !== cr.issued) out.mismatches.push({ type: "SUPPLY", credit: cr.id, record: cr.code, issued: cr.issued, onChainHeldByKnownHolders: onChainHeld, onChainRetired, onChainCancelled });
  }
  // Transfers/retirements on-chain for our records that no registry operation accounts for (for example performed directly on the contract).
  const refs = new Set((await db.query("SELECT op_ref FROM chain_operations WHERE op_ref IS NOT NULL")).rows.map((r) => r.op_ref));
  for (const ev of await chain.allRefEvents()) if (known.has(ev.recordId) && !refs.has(ev.ref)) out.mismatches.push({ type: "UNKNOWN_CHAIN_EVENT", kind: ev.kind, amount: ev.amount, ref: ev.ref, tx: ev.tx });
  // Registry operations that claim completion but whose reference is not on-chain.
  for (const o of (await db.query("SELECT id, op_ref, op_type FROM chain_operations WHERE op_ref IS NOT NULL AND status='COMPLETED'")).rows) if (!(await chain.refUsed(o.op_ref))) out.mismatches.push({ type: "COMPLETED_WITHOUT_CHAIN_EFFECT", operation: Number(o.id), opType: o.op_type });
  out.ok = out.mismatches.length === 0;
  return out;
}
module.exports = { check };
