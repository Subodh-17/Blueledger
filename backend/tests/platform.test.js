// Notifications from persisted events, audited runtime settings, on-chain role administration, offline-sync idempotency,
// metrics, log redaction and alerts.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { setup, projectBody, recordBody, uniquePng } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");
const chain = require("../src/services/chain");
const alerts = require("../src/services/alerts");
const log = require("../src/utils/log");

let env, P;
cfg.rateLimit.max = 1e6; cfg.rateLimit.authMax = 1e6; cfg.scan.policy = "off"; cfg.ipfs.provider = "none";
const notes = async (who, q = "") => (await env.as(who).get(`/api/notifications${q}`)).body;
const types = async (who) => (await notes(who)).notifications.map((n) => n.type);

test.before(async () => {
  env = await setup();
  P = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a))).body.project;
});
test.after(async () => { await env.close(); });

test("notifications are created only by persisted events and are addressed to the right people", async () => {
  const f = env.as("fieldA"), v = env.as("verifier"), a = env.as("admin");
  const rec = (await f.post("/api/records", recordBody(P.id))).body.record;
  assert.deepEqual(await types("verifier"), [], "a draft creates no notification");
  const e = (await f.upload({ projectId: P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: "2026-06-01" })).body.evidence;
  await f.post(`/api/records/${rec.id}/submit`);
  assert.deepEqual(await types("verifier"), ["RECORD_AWAITING_REVIEW"]);
  assert.deepEqual(await types("verifier2"), ["RECORD_AWAITING_REVIEW"], "every verifier is told");
  assert.deepEqual(await types("fieldA"), [], "the submitter is not notified of their own submission");
  assert.deepEqual(await types("fieldB"), [], "other organizations see nothing");
  assert.deepEqual(await types("admin"), []);
  assert.equal((await v.post(`/api/records/${rec.id}/start-review`)).status, 200);
  assert.equal((await env.as("fieldB").post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" })).status, 403);
  assert.deepEqual(await types("fieldA"), [], "a refused action creates no notification");
  assert.equal((await v.post(`/api/evidence/${e.id}/review`, { decision: "NEEDS_REVISION", notes: "Please add a clearer photograph." })).status, 200);
  let n = await notes("fieldA"); assert.deepEqual(n.notifications.map((x) => x.type), ["EVIDENCE_NEEDS_REVISION"]); assert.equal(n.notifications[0].severity, "ACTION"); assert.match(n.notifications[0].body, /clearer photograph/);
  assert.equal((await v.post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" })).status, 200);
  assert.equal((await v.post(`/api/records/${rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence and measurements are consistent." })).status, 200);
  assert.deepEqual(await types("fieldA"), ["RECORD_VERIFIED", "EVIDENCE_VERIFIED", "EVIDENCE_NEEDS_REVISION"]);
  assert.deepEqual(await types("admin"), ["READY_FOR_ASSESSMENT"]);
  const calc = (await a.post(`/api/records/${rec.id}/carbon-estimate`)).body.calculation;
  assert.ok((await types("admin")).includes("ASSESSMENT_AWAITING_APPROVAL"));
  await a.post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Approved for issuance." });
  assert.ok((await types("admin")).length >= 2 && (await types("admin")).every((t) => t));
  const iss = await a.post(`/api/carbon/calculations/${calc.id}/issue`); assert.equal(iss.status, 201);
  assert.ok((await types("fieldA")).includes("CREDITS_ISSUED"), "the holder organization is told about the issuance");
  assert.deepEqual(await types("fieldB"), []);
  await env.as("fieldA").post(`/api/credits/${iss.body.credit.id}/transfer`, { toOrgId: env.orgs.buyer, amount: 3 });
  assert.ok((await types("buyer")).includes("CREDITS_TRANSFERRED"), "the receiving organization is told");
  await env.as("buyer").post(`/api/credits/${iss.body.credit.id}/retire`, { amount: 1, reason: "Voluntary retirement" });
  assert.ok((await types("buyer")).includes("CREDITS_RETIRED") && (await types("admin")).includes("CREDITS_RETIRED"));
  S.credit = iss.body.credit; S.rec = rec;
});
const S = {};

test("notifications can be listed, paged and marked read; users only ever see their own", async () => {
  const n = await notes("fieldA", "?pageSize=2");
  assert.equal(n.notifications.length, 2); assert.ok(n.pagination.total >= 4); assert.ok(n.unread >= 4);
  const first = n.notifications[0].id;
  assert.equal((await env.as("fieldA").post("/api/notifications/read", { ids: [first] })).body.marked, 1);
  assert.equal((await notes("fieldA", "?unread=1")).notifications.every((x) => x.id !== first), true);
  assert.equal((await env.as("fieldB").post("/api/notifications/read", { ids: [first] })).body.marked, 0, "another user cannot mark it");
  assert.equal((await env.as("fieldA").post("/api/notifications/read", { all: true })).body.marked >= 3, true);
  assert.equal((await notes("fieldA")).unread, 0);
  assert.equal((await env.anon.get("/api/notifications")).status, 401);
});

test("a failed blockchain operation and a reconciliation problem alert the administrators", async () => {
  const cid = S.credit.id;
  await db.query("UPDATE credit_balances SET balance = balance + 40 WHERE credit_id=$1 AND org_id=$2", [cid, env.orgs.a]); // registry claims more than the chain holds
  const bal = (await db.query("SELECT balance::float b FROM credit_balances WHERE credit_id=$1 AND org_id=$2", [cid, env.orgs.a])).rows[0].b;
  const r = await env.as("fieldA").post(`/api/credits/${cid}/transfer`, { toOrgId: env.orgs.buyer, amount: bal });
  assert.equal(r.status, 409);
  const n = (await notes("admin")).notifications.find((x) => x.type === "OPERATION_FAILED");
  assert.ok(n); assert.equal(n.severity, "ALERT"); assert.match(n.body, /Insufficient batch balance/);
  await db.query("UPDATE credit_balances SET balance = balance - 40 WHERE credit_id=$1 AND org_id=$2", [cid, env.orgs.a]);
});

test("alerts for persistent failures are raised once per condition", async () => {
  await db.query("DELETE FROM notifications");
  await db.query(`INSERT INTO chain_operations (idempotency_key, op_type, payload, status, created_at, updated_at) VALUES ('stuck-op-test','CREDIT_ISSUE','{}','SUBMITTED', NOW() - interval '2 hours', NOW() - interval '2 hours')`);
  const first = await alerts.check(); assert.ok(first.includes("ALERT_BACKLOG"), JSON.stringify(first));
  assert.equal((await alerts.check()).includes("ALERT_BACKLOG"), true);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM notifications WHERE type='ALERT_BACKLOG' AND user_id=$1", [env.users.admin])).rows[0].n, 1, "de-duplicated per hour");
  chain.ready = false; chain.error = "RPC unreachable (test)";
  try { assert.ok((await alerts.check()).includes("ALERT_CHAIN_DOWN")); } finally { chain.lastTry = 0; await chain.init(); }
  assert.ok((await notes("admin")).notifications.some((x) => x.type === "ALERT_CHAIN_DOWN"));
  assert.deepEqual(await types("fieldA"), [], "alerts go to administrators only");
  await db.query("DELETE FROM chain_operations WHERE idempotency_key='stuck-op-test'");
});

test("runtime settings: allow-listed, validated, reasoned, audited, applied immediately, resettable; secrets are never exposed", async () => {
  const a = env.as("admin");
  assert.equal((await env.as("verifier").get("/api/settings")).status, 403);
  const list = (await a.get("/api/settings")).body.settings;
  assert.ok(list.length >= 8);
  assert.ok(!JSON.stringify(list).match(/private|secret|password|jwt|kek|token/i), "no secret-bearing setting exists");
  const put = (k, value, reason = "Operational adjustment for testing") => a.put(`/api/settings/${k}`, { value, reason });
  assert.equal((await put("rateLimit.authMax", 1)).status, 400, "below the minimum");
  assert.equal((await put("rateLimit.authMax", "many")).status, 400);
  assert.equal((await put("scan.policy", "sometimes")).status, 400);
  assert.equal((await put("rateLimit.authMax", 50, "no")).status, 400, "a reason is required");
  assert.equal((await put("jwt.secret", "x")).status, 404, "only allow-listed settings can change");
  assert.equal((await env.as("fieldA").put("/api/settings/rateLimit.authMax", { value: 50, reason: "attempt" })).status, 403);
  const before = cfg.rateLimit.authMax;
  assert.equal((await put("rateLimit.authMax", 4)).status, 200);
  assert.equal(cfg.rateLimit.authMax, 4, "applied without a restart");
  let last; for (let i = 0; i < 6; i++) last = await env.anon.post("/api/auth/login", { email: `x${i}@test.invalid`, password: "wrong-wrong-1" });
  assert.equal(last.status, 429, "the new limit is enforced");
  const del = await fetch(`${env.base}/api/settings/rateLimit.authMax`, { method: "DELETE", headers: { authorization: `Bearer ${env.tokens.admin}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "Restore the default after testing" }) });
  assert.equal(del.status, 200); assert.equal(cfg.rateLimit.authMax, before);
  const hist = (await a.get("/api/settings/history?key=rateLimit.authMax")).body.history;
  assert.equal(hist.length, 2); assert.equal(hist[0].changed_by_name, "admin"); assert.match(hist[0].reason, /reset to default/);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action IN ('SETTING_CHANGED','SETTING_RESET')")).rows[0].n, 2);
  const prod = cfg.isProd; cfg.isProd = true;
  try { assert.equal((await put("scan.policy", "off")).status, 422, "scanning cannot be disabled in production"); } finally { cfg.isProd = prod; }
});

test("the evidence size limit is a runtime setting", async () => {
  const a = env.as("admin"), f = env.as("fieldA");
  const rec = (await f.post("/api/records", recordBody(P.id, { activityDate: "2026-07-01" }))).body.record;
  assert.equal((await a.put("/api/settings/evidence.maxUploadMb", { value: 1, reason: "Limit uploads while testing" })).status, 200);
  try {
    const big = Buffer.concat([uniquePng(), Buffer.alloc(1.5 * 1048576)]);
    const r = await f.upload({ projectId: P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: "2026-07-01" }, big, "big.png");
    assert.equal(r.status, 413); assert.match(r.body.error, /1 MB limit/);
  } finally { await fetch(`${env.base}/api/settings/evidence.maxUploadMb`, { method: "DELETE", headers: { authorization: `Bearer ${env.tokens.admin}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "Restore default limit" }) }); }
  assert.equal((await f.upload({ projectId: P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: "2026-07-01" })).status, 201);
});

test("on-chain role administration: list holders, grant and revoke for any address, propose a two-step administrator hand-over", async () => {
  const a = env.as("admin"), acct = env.accounts[12];
  assert.equal((await env.as("verifier").get("/api/chain/roles")).status, 403);
  const before = (await a.get("/api/chain/roles")).body;
  assert.equal(before.admin.toLowerCase(), env.accounts[0].toLowerCase()); assert.equal(before.adminUser, "admin");
  assert.ok(before.holders.some((h) => h.role === "verifier" && h.user?.name === "verifier"), "deployment-time verifier is listed and mapped to a user");
  assert.equal((await a.post("/api/chain/roles", { account: "0x123", role: "verifier", granted: true })).status, 400);
  assert.equal((await a.post("/api/chain/roles", { account: acct, role: "admin", granted: true })).status, 400);
  const g = await a.post("/api/chain/roles", { account: acct, role: "registrar", granted: true });
  assert.equal(g.status, 200, JSON.stringify(g.body)); assert.equal(g.body.roles.registrar, true); assert.match(g.body.tx, /^0x/);
  assert.ok((await a.get("/api/chain/roles")).body.holders.some((h) => h.role === "registrar" && h.account.toLowerCase() === acct.toLowerCase()));
  assert.equal((await a.post("/api/chain/roles", { account: acct, role: "registrar", granted: false })).body.roles.registrar, false);
  assert.ok(!(await a.get("/api/chain/roles")).body.holders.some((h) => h.account.toLowerCase() === acct.toLowerCase()), "revoked holders disappear");
  const p = await a.post("/api/chain/admin/propose", { account: env.accounts[13] });
  assert.equal(p.status, 200); assert.match(p.body.note, /must accept/);
  assert.equal((await a.get("/api/chain/roles")).body.pendingAdmin.toLowerCase(), env.accounts[13].toLowerCase());
  assert.equal((await chain.getRecord(crypto.createHash("sha256").update("none").digest("hex").replace(/^/, "0x")).catch(() => ({ status: "n/a" }))).status !== undefined, true);
  assert.ok((await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action IN ('CHAIN_ROLE_CHANGED','ADMIN_HANDOVER_PROPOSED')")).rows[0].n >= 3);
});

test("offline-sync safety: a client reference makes record creation idempotent per user", async () => {
  const f = env.as("fieldA");
  const ref = "offline-" + crypto.randomUUID();
  const one = await f.post("/api/records", recordBody(P.id, { clientRef: ref, activityDate: "2026-08-01" }));
  const two = await f.post("/api/records", recordBody(P.id, { clientRef: ref, activityDate: "2026-08-01" }));
  assert.equal(one.status, 201); assert.equal(two.status, 201);
  assert.equal(one.body.record.id, two.body.record.id, "retries never create a second record");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM monitoring_records WHERE client_ref=$1", [ref])).rows[0].n, 1);
  assert.equal((await f.post("/api/records", recordBody(P.id, { clientRef: "short" }))).status, 400);
  assert.equal((await f.upload({ projectId: P.id, recordId: one.body.record.id, kind: "FIELD_PHOTO", captureDate: "2026-08-01" }, Buffer.concat([uniquePng(), Buffer.from("same")]))).status, 201);
  const dupBuf = Buffer.concat([uniquePng(), Buffer.from("dup-evidence")]);
  const u1 = await f.upload({ projectId: P.id, recordId: one.body.record.id, kind: "FIELD_PHOTO", captureDate: "2026-08-01" }, dupBuf);
  const u2 = await f.upload({ projectId: P.id, recordId: one.body.record.id, kind: "FIELD_PHOTO", captureDate: "2026-08-01" }, dupBuf);
  assert.equal(u1.status, 201); assert.equal(u2.status, 409); assert.equal(u2.body.details.duplicateOf, u1.body.evidence.code, "a re-sent file is reported as already stored");
  assert.equal((await f.post(`/api/records/${one.body.record.id}/submit`)).status, 200);
  assert.equal((await f.post(`/api/records/${one.body.record.id}/submit`)).status, 409, "a conflict (already submitted elsewhere) is reported, never silently overwritten");
  const other = await env.as("buyer").post("/api/records", recordBody(P.id, { clientRef: ref }));
  assert.equal(other.status, 403, "references are scoped to the user and organization rules still apply");
});

test("metrics: protected, Prometheus text format, derived from real state", async () => {
  assert.equal((await fetch(`${env.base}/metrics`)).status, 401);
  assert.equal((await fetch(`${env.base}/metrics`, { headers: { authorization: `Bearer ${env.tokens.fieldA}` } })).status, 403);
  const ok = await fetch(`${env.base}/metrics`, { headers: { authorization: `Bearer ${env.tokens.admin}` } });
  assert.equal(ok.status, 200); assert.match(ok.headers.get("content-type"), /text\/plain/);
  const t = await ok.text();
  for (const m of ["bcr_http_requests_total", "bcr_chain_operations{status=\"COMPLETED\"}", "bcr_reconciliation_backlog_open", "bcr_reconciliation_oldest_open_seconds", "bcr_database_up 1", "bcr_chain_connected 1", "bcr_ipfs_backlog", "bcr_evidence_scan_unavailable"]) assert.ok(t.includes(m), m);
  assert.match(t, /bcr_chain_operations\{status="COMPLETED"\} [1-9]/);
  process.env.METRICS_TOKEN = "scrape-token-for-tests-123";
  try {
    assert.equal((await fetch(`${env.base}/metrics`, { headers: { authorization: "Bearer scrape-token-for-tests-123" } })).status, 200);
    assert.equal((await fetch(`${env.base}/metrics`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${env.base}/metrics`, { headers: { authorization: `Bearer ${env.tokens.admin}` } })).status, 401, "when a metrics token is configured it is required");
  } finally { delete process.env.METRICS_TOKEN; }
});

test("logging is structured and never contains tokens, passwords, bodies or key material", async () => {
  assert.deepEqual(log.redact({ a: 1, password: "p", nested: { authorization: "Bearer x", fine: "ok", wrappedKey: "k" } }), { a: 1, password: "[redacted]", nested: { authorization: "[redacted]", fine: "ok", wrappedKey: "[redacted]" } });
  const lines = []; const orig = process.stdout.write.bind(process.stdout); process.env.LOG_LEVEL = "info";
  process.stdout.write = (s, ...r) => { lines.push(String(s)); return orig(s, ...r); };
  try {
    await fetch(`${env.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@test.invalid", password: "super-secret-password-value" }) });
    await fetch(`${env.base}/api/projects?q=SECRETQUERY`, { headers: { authorization: `Bearer ${env.tokens.admin}` } });
  } finally { process.stdout.write = orig; delete process.env.LOG_LEVEL; }
  const joined = lines.join("");
  assert.ok(joined.includes('"msg":"request"') && joined.includes('"requestId"'), "structured request lines with request ids");
  assert.ok(!joined.includes("super-secret-password-value") && !joined.includes(env.tokens.admin) && !joined.includes("SECRETQUERY"), "no password, bearer token or query string in logs");
  for (const l of lines.filter((x) => x.startsWith("{"))) JSON.parse(l);
});
