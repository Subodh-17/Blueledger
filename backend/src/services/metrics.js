// backend/src/services/metrics.js — Prometheus text exposition: HTTP counters/latency (in memory) plus gauges computed from the database on scrape.
const db = require("../db");
const chain = require("./chain");
const ops = require("./chainOps");
const ipfs = require("./ipfs");

const http = { counts: new Map(), buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], hist: new Map(), sum: 0, n: 0 };
const reconcile = { ok: 0, failed: 0, lastAt: 0 };
function observe(method, status, seconds) {
  const k = `${method}|${Math.floor(status / 100)}xx`; http.counts.set(k, (http.counts.get(k) || 0) + 1);
  http.sum += seconds; http.n++;
  for (const b of http.buckets) if (seconds <= b) http.hist.set(b, (http.hist.get(b) || 0) + 1);
}
const noteReconcile = (s) => { if (s.failed || s.errors?.length) reconcile.failed++; else reconcile.ok++; reconcile.lastAt = Math.floor(Date.now() / 1000); };

async function render() {
  const L = [];
  const g = (name, help, type = "gauge") => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); };
  const line = (name, v, labels) => L.push(`${name}${labels ? `{${Object.entries(labels).map(([k, x]) => `${k}="${x}"`).join(",")}}` : ""} ${v}`);
  g("bcr_http_requests_total", "HTTP requests by method and status class", "counter");
  for (const [k, v] of http.counts) { const [method, cls] = k.split("|"); line("bcr_http_requests_total", v, { method, status_class: cls }); }
  g("bcr_http_request_duration_seconds", "HTTP request latency", "histogram");
  for (const b of http.buckets) line("bcr_http_request_duration_seconds_bucket", http.hist.get(b) || 0, { le: b });
  line("bcr_http_request_duration_seconds_bucket", http.n, { le: "+Inf" }); line("bcr_http_request_duration_seconds_sum", http.sum.toFixed(4)); line("bcr_http_request_duration_seconds_count", http.n);
  let dbUp = 1;
  try {
    await db.query("SELECT 1");
    const c = await ops.counts(); g("bcr_chain_operations", "Blockchain operations by status");
    for (const s of ["PENDING", "SUBMITTED", "CONFIRMED", "COMPLETED", "FAILED"]) line("bcr_chain_operations", c[s] || 0, { status: s });
    const b = await ops.backlog();
    g("bcr_reconciliation_backlog_open", "Operations not yet completed"); line("bcr_reconciliation_backlog_open", b.open);
    g("bcr_reconciliation_oldest_open_seconds", "Age of the oldest unfinished operation"); line("bcr_reconciliation_oldest_open_seconds", b.oldestOpenSeconds);
    g("bcr_chain_operations_failed", "Operations in FAILED state"); line("bcr_chain_operations_failed", b.failed);
    const i = await ipfs.backlog(); g("bcr_ipfs_backlog", "Evidence items by IPFS state");
    line("bcr_ipfs_backlog", i.pending, { state: "pending" }); line("bcr_ipfs_backlog", i.unavailable, { state: "unavailable" }); line("bcr_ipfs_backlog", i.verify_failed, { state: "verify_failed" });
    g("bcr_evidence_scan_unavailable", "Evidence files stored without a completed malware scan"); line("bcr_evidence_scan_unavailable", Number((await db.query("SELECT COUNT(*) AS n FROM evidence WHERE scan_status IN ('SCAN_UNAVAILABLE','SCAN_ERROR')")).rows[0].n));
    g("bcr_audit_entries_total", "Audit log entries", "counter"); line("bcr_audit_entries_total", Number((await db.query("SELECT COUNT(*) AS n FROM audit_logs")).rows[0].n));
    g("bcr_notifications_unread", "Unread notifications"); line("bcr_notifications_unread", Number((await db.query("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL")).rows[0].n));
  } catch { dbUp = 0; }
  g("bcr_database_up", "1 when PostgreSQL answers"); line("bcr_database_up", dbUp);
  g("bcr_chain_connected", "1 when the blockchain network is connected"); line("bcr_chain_connected", chain.ready ? 1 : 0);
  g("bcr_reconcile_runs_total", "Reconciliation runs by result", "counter"); line("bcr_reconcile_runs_total", reconcile.ok, { result: "ok" }); line("bcr_reconcile_runs_total", reconcile.failed, { result: "problems" });
  g("bcr_reconcile_last_run_timestamp_seconds", "Unix time of the last reconciliation run"); line("bcr_reconcile_last_run_timestamp_seconds", reconcile.lastAt);
  return L.join("\n") + "\n";
}
module.exports = { observe, render, noteReconcile };
