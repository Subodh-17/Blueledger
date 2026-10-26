// V3 security: real malware scanning (ClamAV), encryption at rest and key rotation, quotas, password reset, session revocation,
// cross-organisation authorisation of consequential actions, and handling of malformed files.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const clamd = require("./helpers/clamd");
const { setup, projectBody, recordBody, uniquePng, PASSWORD } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");
const cryptoSvc = require("../src/services/crypto");

let env, P, R, clam = null;
cfg.rateLimit.max = 1e6; cfg.rateLimit.authMax = 1e6;
const CLAM = clamd.available();
const png = (extra = "") => Buffer.concat([uniquePng(), Buffer.from(extra)]);
const up = (buf, name = "photo.png", who = "fieldA", recordId = R.id) => env.as(who).upload({ projectId: P.id, recordId, kind: "FIELD_PHOTO", captureDate: "2026-06-01" }, buf, name);
const outbox = async (email) => (await db.query("SELECT * FROM mail_outbox WHERE to_email=$1 ORDER BY id DESC", [email])).rows;
const waitMail = async (email, n = 1) => { for (let i = 0; i < 40; i++) { const m = await outbox(email); if (m.length >= n) return m; await new Promise((r) => setTimeout(r, 100)); } return []; };
const tokenOf = (mail) => decodeURIComponent(mail.body.match(/token=([A-Za-z0-9_-]+)/)[1]);

test.before(async () => {
  env = await setup();
  P = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a))).body.project;
  R = (await env.as("fieldA").post("/api/records", recordBody(P.id))).body.record;
  if (CLAM) { clam = await clamd.start(); cfg.scan.port = clam.port; cfg.scan.host = "127.0.0.1"; }
});
test.after(async () => { clam?.stop(); await env.close(); });

test("malware scanning with a real ClamAV daemon: clean files are marked clean, infected files are rejected and never stored", { skip: !CLAM && "clamd is not installed" }, async () => {
  cfg.scan.policy = "required";
  const ok = await up(png());
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.evidence.scan_status, "CLEAN"); assert.match(ok.body.evidence.scan_engine, /ClamAV/);
  const bad = png("trailing data " + clam.marker + " more");
  const sha = crypto.createHash("sha256").update(bad).digest("hex");
  const r = await up(bad);
  assert.equal(r.status, 422); assert.match(r.body.error, /rejected by malware scanning \(Registry\.Test\.Marker/);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM evidence WHERE sha256=$1", [sha])).rows[0].n, 0, "no evidence row");
  assert.ok(!fs.readdirSync(cfg.uploadDir).some((f) => f.startsWith(sha)), "the infected file was never written to storage");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action='EVIDENCE_REJECTED_MALWARE'")).rows[0].n, 1);
});

test("scanner unavailable: optional policy stores the file as SCAN_UNAVAILABLE (never 'clean'); required policy refuses; rescan later upgrades the state", { skip: !CLAM && "clamd is not installed" }, async () => {
  const saved = { port: cfg.scan.port };
  cfg.scan.port = 1; // nothing listens here
  try {
    cfg.scan.policy = "optional";
    const a = await up(png());
    assert.equal(a.status, 201); assert.equal(a.body.evidence.scan_status, "SCAN_UNAVAILABLE");
    cfg.scan.policy = "required";
    const before = (await db.query("SELECT COUNT(*)::int n FROM evidence")).rows[0].n;
    const b = await up(png());
    assert.equal(b.status, 503); assert.match(b.body.error, /Malware scanning is required but unavailable/);
    assert.equal((await db.query("SELECT COUNT(*)::int n FROM evidence")).rows[0].n, before, "nothing stored while the scanner is down");
    const during = await env.as("verifier").post(`/api/evidence/${a.body.evidence.id}/rescan`);
    assert.equal(during.status, 200); assert.equal(during.body.scan.status, "SCAN_UNAVAILABLE", "a rescan during the outage cannot make the file 'clean'");
    assert.equal((await db.query("SELECT scan_status FROM evidence WHERE id=$1", [a.body.evidence.id])).rows[0].scan_status, "SCAN_UNAVAILABLE");
    cfg.scan.port = saved.port;
    const rs = await env.as("verifier").post(`/api/evidence/${a.body.evidence.id}/rescan`);
    assert.equal(rs.status, 200, JSON.stringify(rs.body)); assert.equal(rs.body.scan.status, "CLEAN");
    assert.equal((await db.query("SELECT scan_status FROM evidence WHERE id=$1", [a.body.evidence.id])).rows[0].scan_status, "CLEAN");
    assert.equal((await env.as("fieldA").post(`/api/evidence/${a.body.evidence.id}/rescan`)).status, 403);
  } finally { cfg.scan.port = saved.port; cfg.scan.policy = "off"; }
});

test("scan policy off: files are stored as NOT_SCANNED and are never described as scanned", async () => {
  cfg.scan.policy = "off";
  const r = await up(png());
  assert.equal(r.status, 201); assert.equal(r.body.evidence.scan_status, "NOT_SCANNED");
});

test("evidence encrypted at rest: ciphertext on disk, hash of plaintext recorded, authorized download decrypts, tampering is detected", async () => {
  cfg.encryption.mode = "required"; cfg.encryption.current = cryptoSvc.generateKey("k1"); cfg.encryption.previous = "";
  try {
    const plain = png("secret-field-notes-marker");
    const r = await up(plain);
    assert.equal(r.status, 201); const id = r.body.evidence.id;
    const row = (await db.query("SELECT * FROM evidence WHERE id=$1", [id])).rows[0];
    assert.equal(row.encrypted, true); assert.equal(row.enc_key_id, "k1");
    assert.equal(row.sha256, crypto.createHash("sha256").update(plain).digest("hex"), "the content hash identifies the original file");
    assert.notEqual(row.stored_sha256, row.sha256);
    const onDisk = fs.readFileSync(path.join(cfg.uploadDir, row.storage_uri));
    assert.ok(row.storage_uri.endsWith(".enc")); assert.ok(!onDisk.includes("secret-field-notes-marker"), "plaintext does not appear on disk");
    assert.equal(crypto.createHash("sha256").update(onDisk).digest("hex"), row.stored_sha256);
    const dl = await fetch(`${env.base}/api/evidence/${id}/file`, { headers: { authorization: `Bearer ${env.tokens.fieldA}` } });
    assert.equal(dl.status, 200); assert.ok(Buffer.from(await dl.arrayBuffer()).equals(plain), "decrypted bytes equal the original");
    assert.ok(!JSON.stringify((await env.as("fieldA").get(`/api/evidence/${id}`)).body).includes("wrapped"), "key material is never returned by the API");
    const t = Buffer.from(onDisk); t[t.length - 1] ^= 1; fs.writeFileSync(path.join(cfg.uploadDir, row.storage_uri), t);
    const bad = await fetch(`${env.base}/api/evidence/${id}/file`, { headers: { authorization: `Bearer ${env.tokens.fieldA}` } });
    assert.equal(bad.status, 409); assert.match((await bad.json()).error, /no longer matches|not served/);
    fs.writeFileSync(path.join(cfg.uploadDir, row.storage_uri), onDisk);
    S.encId = id; S.plain = plain;
  } finally { /* keep encryption configured for the rotation test */ }
});
const S = {};

test("key rotation re-wraps data keys without rewriting files; a missing key fails closed", async () => {
  const k1 = cfg.encryption.current;
  cfg.encryption.current = cryptoSvc.generateKey("k2"); cfg.encryption.previous = k1;
  const out = await cryptoSvc.rewrapAll(db);
  assert.equal(out.rewrapped >= 1, true); assert.deepEqual(out.failed, []);
  assert.equal((await db.query("SELECT enc_key_id FROM evidence WHERE id=$1", [S.encId])).rows[0].enc_key_id, "k2");
  cfg.encryption.previous = ""; // the old key is retired
  const dl = await fetch(`${env.base}/api/evidence/${S.encId}/file`, { headers: { authorization: `Bearer ${env.tokens.fieldA}` } });
  assert.equal(dl.status, 200); assert.ok(Buffer.from(await dl.arrayBuffer()).equals(S.plain), "still readable after rotation and retiring the old key");
  const keep = cfg.encryption.current; cfg.encryption.current = cryptoSvc.generateKey("k9");
  assert.equal((await fetch(`${env.base}/api/evidence/${S.encId}/file`, { headers: { authorization: `Bearer ${env.tokens.fieldA}` } })).status, 503, "without the right key the file is not served");
  cfg.encryption.current = keep;
  cfg.encryption.mode = "off"; cfg.encryption.current = undefined;
  const plainUpload = await up(png());
  assert.equal((await db.query("SELECT encrypted FROM evidence WHERE id=$1", [plainUpload.body.evidence.id])).rows[0].encrypted, false);
  assert.throws(() => { cfg.encryption.mode = "required"; cryptoSvc.encrypt(Buffer.from("x"), "00".repeat(32)); }, /EVIDENCE_KEK_CURRENT/);
  cfg.encryption.mode = "off";
});

test("organization storage quota is enforced before anything is stored", async () => {
  const saved = cfg.orgQuotaBytes; cfg.orgQuotaBytes = 10;
  try { const r = await up(png()); assert.equal(r.status, 413); assert.match(r.body.error, /quota exceeded/); } finally { cfg.orgQuotaBytes = saved; }
});

test("malformed and hostile files: truncated images, oversized declared dimensions, wrong signature, empty and tiny files", async () => {
  assert.equal((await up(Buffer.alloc(0))).status, 400);
  assert.equal((await up(Buffer.from("%PDF"), "t.pdf")).status, 400, "too short to carry a valid signature");
  const truncated = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF"), crypto.randomBytes(8)]);
  const t = await up(truncated, "cut.jpg"); assert.equal(t.status, 201); assert.ok(t.body.evidence.file_metadata, "inspection never throws on a truncated JPEG");
  const huge = Buffer.from(uniquePng()); huge.writeUInt32BE(60000, 16); huge.writeUInt32BE(60000, 20);
  const h = await up(huge); assert.equal(h.status, 201); assert.match(h.body.evidence.file_metadata.warning, /unusually large/);
  assert.equal((await up(Buffer.from("GIF89a" + "x".repeat(40)), "x.png")).status, 400);
  assert.equal((await up(png(), "../../etc/passwd.png")).status, 201);
});

test("password reset: generic responses, hashed single-use expiring tokens, policy enforced, all sessions revoked", async () => {
  const a = await env.anon.post("/api/auth/forgot-password", { email: "fieldA@test.invalid" });
  const b = await env.anon.post("/api/auth/forgot-password", { email: "nobody@test.invalid" });
  const c = await env.anon.post("/api/auth/forgot-password", { email: "not-an-email" });
  assert.equal(a.status, 202); assert.equal(b.status, 202); assert.equal(c.status, 202);
  assert.deepEqual(a.body, b.body); assert.deepEqual(a.body, c.body);
  const mails = await waitMail("fieldA@test.invalid"); assert.equal(mails.length, 1);
  await new Promise((r) => setTimeout(r, 300)); assert.equal((await outbox("nobody@test.invalid")).length, 0, "no mail for unknown accounts");
  const token = tokenOf(mails[0]);
  const h = crypto.createHash("sha256").update(token).digest("hex");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM password_resets WHERE token_hash=$1", [h])).rows[0].n, 1);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM password_resets WHERE token_hash=$1", [token])).rows[0].n, 0, "the token itself is never stored");
  assert.equal((await env.anon.post("/api/auth/reset-password", { token, newPassword: "short" })).status, 400, "weak password rejected");
  const oldToken = env.tokens.fieldA;
  const ok = await env.anon.post("/api/auth/reset-password", { token, newPassword: "Fresh-Reset-Pass-77" });
  assert.equal(ok.status, 200);
  assert.equal((await env.anon.post("/api/auth/reset-password", { token, newPassword: "Another-Fresh-Pass-88" })).status, 400, "single use");
  assert.equal((await fetch(`${env.base}/api/projects`, { headers: { authorization: `Bearer ${oldToken}` } })).status, 401, "existing sessions are revoked");
  assert.equal((await env.anon.post("/api/auth/login", { email: "fieldA@test.invalid", password: PASSWORD })).status, 401);
  assert.equal((await env.anon.post("/api/auth/login", { email: "fieldA@test.invalid", password: "Fresh-Reset-Pass-77" })).status, 200);
  const same = await env.anon.post("/api/auth/reset-password", { token: "x".repeat(40), newPassword: "Fresh-Reset-Pass-99" });
  assert.equal(same.status, 400); assert.equal(same.body.error, (await env.anon.post("/api/auth/reset-password", { token, newPassword: "Fresh-Reset-Pass-99" })).body.error, "invalid, used and unknown tokens look identical");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action IN ('PASSWORD_RESET_REQUESTED','PASSWORD_RESET_COMPLETED')")).rows[0].n, 2);
});

test("reset tokens expire, a newer request invalidates the older link, requests are limited per account, deactivated users get nothing", async () => {
  await env.anon.post("/api/auth/forgot-password", { email: "verifier2@test.invalid" });
  const m1 = (await waitMail("verifier2@test.invalid", 1))[0]; const t1 = tokenOf(m1);
  await env.anon.post("/api/auth/forgot-password", { email: "verifier2@test.invalid" });
  const m2 = (await waitMail("verifier2@test.invalid", 2))[0]; const t2 = tokenOf(m2);
  assert.notEqual(t1, t2);
  assert.equal((await env.anon.post("/api/auth/reset-password", { token: t1, newPassword: "Valid-New-Password-12" })).status, 400, "the older link no longer works");
  await db.query("UPDATE password_resets SET expires_at = NOW() - interval '1 minute' WHERE token_hash=$1", [crypto.createHash("sha256").update(t2).digest("hex")]);
  assert.equal((await env.anon.post("/api/auth/reset-password", { token: t2, newPassword: "Valid-New-Password-12" })).status, 400, "expired");
  await env.anon.post("/api/auth/forgot-password", { email: "verifier2@test.invalid" }); await waitMail("verifier2@test.invalid", 3);
  await env.anon.post("/api/auth/forgot-password", { email: "verifier2@test.invalid" }); await new Promise((r) => setTimeout(r, 500));
  assert.equal((await outbox("verifier2@test.invalid")).length, 3, "the fourth request within an hour is silently dropped");
  await env.as("admin").patch(`/api/users/${env.users.buyer}`, { isActive: false });
  await env.anon.post("/api/auth/forgot-password", { email: "buyer@test.invalid" }); await new Promise((r) => setTimeout(r, 400));
  assert.equal((await outbox("buyer@test.invalid")).length, 0);
});

test("sessions: logout, password change, deactivation and role change revoke previously issued tokens", async () => {
  const login = async (e, p = PASSWORD) => (await env.anon.post("/api/auth/login", { email: e, password: p })).body.token;
  const works = async (t) => (await fetch(`${env.base}/api/auth/me`, { headers: { authorization: `Bearer ${t}` } })).status === 200;
  let t = await login("verifier@test.invalid"); assert.ok(await works(t));
  await fetch(`${env.base}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(await works(t), false);
  t = await login("verifier@test.invalid");
  const ch = await fetch(`${env.base}/api/auth/change-password`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "Changed-Password-4321" }) });
  const body = await ch.json(); assert.equal(ch.status, 200);
  assert.equal(await works(t), false, "the old token is revoked"); assert.ok(await works(body.token), "the response carries a fresh token");
  const bt = await login("fieldB@test.invalid"); assert.ok(await works(bt));
  await env.as("admin").patch(`/api/users/${env.users.fieldB}`, { role: "VERIFIER" });
  assert.equal(await works(bt), false, "a role change revokes sessions");
  assert.equal((await db.query("SELECT role FROM users WHERE id=$1", [env.users.fieldB])).rows[0].role, "VERIFIER");
  await env.as("admin").patch(`/api/users/${env.users.fieldB}`, { role: "FIELD_USER" });
});

test("consequential actions are denied across organizations and roles (approve, issue, transfer, retire)", async () => {
  // earlier tests revoked these users' sessions on purpose; sign in again
  env.tokens.fieldA = (await env.anon.post("/api/auth/login", { email: "fieldA@test.invalid", password: "Fresh-Reset-Pass-77" })).body.token;
  env.tokens.fieldB = (await env.anon.post("/api/auth/login", { email: "fieldB@test.invalid", password: PASSWORD })).body.token;
  // a credit owned by organization A
  const a = env.as("admin"), f = env.as("fieldA"), v = env.as("verifier2");
  const rec = (await f.post("/api/records", recordBody(P.id, { activityDate: "2026-07-01" }))).body.record;
  await f.upload({ projectId: P.id, recordId: rec.id, kind: "FIELD_PHOTO", captureDate: "2026-07-01" }); await f.post(`/api/records/${rec.id}/submit`);
  await v.post(`/api/records/${rec.id}/start-review`);
  for (const e of (await v.get(`/api/evidence?recordId=${rec.id}`)).body.evidence) await v.post(`/api/evidence/${e.id}/review`, { decision: "VERIFIED" });
  const tokV = await env.anon.post("/api/auth/login", { email: "verifier2@test.invalid", password: PASSWORD });
  const dec = await v.post(`/api/records/${rec.id}/decision`, { decision: "VERIFIED", comments: "Evidence and measurements are consistent." });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  const ce = await a.post(`/api/records/${rec.id}/carbon-estimate`); assert.equal(ce.status, 201, JSON.stringify(ce.body));
  const calc = ce.body.calculation;
  assert.equal((await env.as("fieldA").post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "no" })).status, 403);
  assert.equal((await env.as("fieldB").post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "no" })).status, 403);
  assert.equal((await v.post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "verifier cannot approve" })).status, 403);
  assert.equal((await a.post(`/api/carbon/calculations/${calc.id}/approve`, { decision: "APPROVED", notes: "Approved for issuance." })).status, 200);
  assert.equal((await env.as("fieldB").post(`/api/carbon/calculations/${calc.id}/issue`)).status, 403);
  assert.equal((await v.post(`/api/carbon/calculations/${calc.id}/issue`)).status, 403);
  const is = await a.post(`/api/carbon/calculations/${calc.id}/issue`); assert.equal(is.status, 201, JSON.stringify(is.body));
  const credit = is.body.credit;
  assert.equal((await env.as("fieldB").get(`/api/credits/${credit.id}`)).status, 403);
  const key = () => ({ "idempotency-key": "x-" + crypto.randomUUID() });
  const call = (who, kind, body) => fetch(`${env.base}/api/credits/${credit.id}/${kind}`, { method: "POST", headers: { authorization: `Bearer ${env.tokens[who]}`, "content-type": "application/json", ...key() }, body: JSON.stringify(body) });
  assert.equal((await call("fieldB", "transfer", { toOrgId: env.orgs.buyer, amount: 1 })).status, 409, "an organization that holds nothing cannot move credits");
  assert.equal((await call("fieldB", "retire", { amount: 1, reason: "Not my credits at all" })).status, 409);
  assert.equal((await call("verifier2", "transfer", { toOrgId: env.orgs.buyer, amount: 1 })).status, 403, "verifiers cannot move credits");
  assert.equal((await call("fieldA", "transfer", { toOrgId: env.orgs.a, amount: 1 })).status, 400, "no self-transfer");
  assert.equal((await db.query("SELECT balance::float b FROM credit_balances WHERE credit_id=$1 AND org_id=$2", [credit.id, env.orgs.a])).rows[0].b, Number(credit.amount_tonnes), "nothing moved");
  void tokV; void dec;
});
