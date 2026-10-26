// backend/src/services/alerts.js — raises administrator notifications for persistent failures. Conditions come from persisted state, are
// de-duplicated (one notification per condition per administrator), and complement the Prometheus rules in docs/alerts.yml.
const db = require("../db");
const cfg = require("../config");
const chain = require("./chain");
const ops = require("./chainOps");
const ipfs = require("./ipfs");
const notify = require("./notify");

async function check() {
  const raised = [];
  const day = new Date().toISOString().slice(0, 13); // per-hour de-duplication
  const send = async (n) => { await db.tx((c) => notify.toRole(c, "NCCR_ADMIN", { severity: "ALERT", ...n })); raised.push(n.type); };
  const b = await ops.backlog();
  if (b.open > 0 && b.oldestOpenSeconds > cfg.alertBacklogSeconds) await send({ type: "ALERT_BACKLOG", title: "Blockchain operations are not completing", body: `${b.open} operation(s) are unfinished; the oldest is ${Math.round(b.oldestOpenSeconds / 60)} minutes old. Check the blockchain network and run reconciliation.`, href: "#/network", dedupeKey: `backlog:${day}` });
  if (b.failed > 0) { const last = (await db.query("SELECT MAX(id) AS id FROM chain_operations WHERE status='FAILED'")).rows[0].id; await send({ type: "ALERT_FAILED_OPS", title: "A blockchain operation failed", body: `${b.failed} operation(s) are in a failed state and need attention.`, href: "#/network", dedupeKey: `failed:${last}` }); }
  if (!chain.ready) await send({ type: "ALERT_CHAIN_DOWN", title: "Blockchain network not connected", body: chain.error || "The network could not be reached.", href: "#/network", dedupeKey: `chain-down:${day}` });
  const i = await ipfs.backlog();
  if (i.unavailable + i.verify_failed > 0) await send({ type: "ALERT_IPFS", title: "Evidence pinning needs attention", body: `${i.unavailable} item(s) unavailable and ${i.verify_failed} failed verification.`, href: "#/evidence", dedupeKey: `ipfs:${day}`, severity: "WARNING" });
  return raised;
}
module.exports = { check };
