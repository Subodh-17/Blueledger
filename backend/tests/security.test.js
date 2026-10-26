// Security: authorization boundaries (cross-organization access), uploads, rate limiting, password policy, token handling, error hygiene.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { setup, projectBody, recordBody, uniquePng, PASSWORD } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");
const { isDbDown } = require("../src/middleware/security");

let env, P, R, EV;
test.before(async () => {
  env = await setup();
  P = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a))).body.project;
  R = (await env.as("fieldA").post("/api/records", recordBody(P.id))).body.record;
  EV = (await env.as("fieldA").upload({ projectId: P.id, recordId: R.id, kind: "FIELD_PHOTO", captureDate: "2026-06-01" })).body.evidence;
});
test.after(async () => { await env.close(); });

test("cross-organization access (IDOR) is denied for records, evidence, files, uploads and credits", async () => {
  const b = env.as("fieldB");
  assert.equal((await b.get(`/api/records/${R.id}`)).status, 403);
  assert.equal((await b.get(`/api/evidence/${EV.id}`)).status, 403);
  assert.equal((await b.get(`/api/evidence/${EV.id}/file`)).status, 403);
  assert.equal((await b.get(`/api/projects/${P.id}`)).status, 403);
  assert.equal((await b.put(`/api/records/${R.id}`, recordBody(P.id))).status, 403);
  assert.equal((await b.post(`/api/records/${R.id}/submit`)).status, 403);
  assert.equal((await b.upload({ projectId: P.id, recordId: R.id, kind: "FIELD_PHOTO" })).status, 403);
  assert.deepEqual((await b.get("/api/records")).body.records, []);
  assert.deepEqual((await b.get("/api/evidence")).body.evidence, []);
  assert.deepEqual((await b.get("/api/projects")).body.projects, []);
  assert.equal((await b.get("/api/search?q=BCP")).body.results.length, 0, "search respects organization scope");
  assert.equal((await b.get("/api/credits/1")).status, 403);
  // same organization, different user: may read but not edit someone else's record
  const other = (await db.query("INSERT INTO users (name,email,password_hash,role,organization_id) VALUES ('fieldA2','fieldA2@test.invalid',(SELECT password_hash FROM users WHERE name='fieldA'),'FIELD_USER',$1) RETURNING id", [env.orgs.a])).rows[0];
  const tok = (await env.anon.post("/api/auth/login", { email: "fieldA2@test.invalid", password: PASSWORD })).body.token;
  const r = await fetch(`${env.base}/api/records/${R.id}`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(recordBody(P.id)) });
  assert.equal(r.status, 403, "a colleague cannot edit someone else's draft");
  assert.ok(other.id);
});

test("evidence files: authenticated only, safe headers, sanitized download name, storage by hash not by client filename", async () => {
  const anon = await fetch(`${env.base}/api/evidence/${EV.id}/file`);
  assert.equal(anon.status, 401);
  const ok = await fetch(`${env.base}/api/evidence/${EV.id}/file?download=1`, { headers: { authorization: `Bearer ${env.tokens.fieldA}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.match(ok.headers.get("content-security-policy"), /sandbox/);
  assert.match(ok.headers.get("content-disposition"), /^attachment; filename="[\w.\- ]+"$/);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  // hostile filename never reaches the filesystem path
  const evil = await env.as("fieldA").upload({ projectId: P.id, recordId: R.id, kind: "FIELD_PHOTO" }, uniquePng(), "../../../../etc/passwd.png");
  assert.equal(evil.status, 201);
  const row = (await db.query("SELECT storage_uri FROM evidence WHERE id=$1", [evil.body.evidence.id])).rows[0];
  assert.match(row.storage_uri, /^[0-9a-f]{64}\.png$/);
});

test("uploads: content must match extension, executables and oversize files are refused", async () => {
  const f = env.as("fieldA");
  assert.equal((await f.upload({ projectId: P.id, kind: "FIELD_PHOTO" }, Buffer.from("<html><script>alert(1)</script></html>"), "x.png")).status, 400);
  assert.equal((await f.upload({ projectId: P.id, kind: "DOCUMENT" }, Buffer.from("MZ\x90\x00 not a pdf at all"), "report.pdf")).status, 400);
  assert.equal((await f.upload({ projectId: P.id, kind: "DOCUMENT" }, Buffer.from("%PDF-1.4\n%test document\n"), "report.pdf")).status, 201);
  assert.equal((await f.upload({ projectId: P.id, kind: "FIELD_PHOTO" }, uniquePng(), "image.svg")).status, 400, "svg is not accepted from users");
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(cfg.maxUploadBytes + 1024)]);
  assert.equal((await f.upload({ projectId: P.id, kind: "FIELD_PHOTO" }, big, "huge.png")).status, 413, "files above the configured limit are refused");
});

test("password policy applies to registration, user creation and password change", async () => {
  const weak = ["short1", "aaaaaaaaaaaaaaaa", "password1234", "janedoe-password"];
  for (const pw of weak) assert.equal((await env.anon.post("/api/auth/register", { name: "Jane Doe", email: "janedoe@test.invalid", password: pw })).status, 400, pw);
  assert.equal((await env.as("admin").post("/api/users", { name: "Wk", email: "wk@test.invalid", password: "short", role: "VERIFIER" })).status, 400);
  const good = await env.anon.post("/api/auth/register", { name: "Jane Doe", email: "jd@test.invalid", password: "Correct-Horse-Battery-9" });
  assert.equal(good.status, 201);
  const t = good.body.token;
  const change = (body) => fetch(`${env.base}/api/auth/change-password`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await change({ currentPassword: "wrong-password-here", newPassword: "Another-Strong-Pass-1" })).status, 400);
  assert.equal((await change({ currentPassword: "Correct-Horse-Battery-9", newPassword: "short" })).status, 400);
  assert.equal((await change({ currentPassword: "Correct-Horse-Battery-9", newPassword: "Another-Strong-Pass-1" })).status, 200);
  assert.equal((await env.anon.post("/api/auth/login", { email: "jd@test.invalid", password: "Correct-Horse-Battery-9" })).status, 401);
  assert.equal((await env.anon.post("/api/auth/login", { email: "jd@test.invalid", password: "Another-Strong-Pass-1" })).status, 200);
});

test("tokens: tampered, expired and unknown-user tokens are rejected", async () => {
  const get = (tok) => fetch(`${env.base}/api/projects`, { headers: { authorization: `Bearer ${tok}` } });
  assert.equal((await get(env.tokens.admin + "x")).status, 401);
  assert.equal((await get(jwt.sign({ id: env.users.admin, role: "NCCR_ADMIN" }, cfg.jwtSecret, { expiresIn: -10 }))).status, 401);
  assert.equal((await get(jwt.sign({ id: env.users.admin, role: "NCCR_ADMIN" }, "wrong-secret"))).status, 401);
  assert.equal((await get(jwt.sign({ id: 999999, role: "NCCR_ADMIN" }, cfg.jwtSecret))).status, 401);
  // role inside a token is not trusted: a field user's token claiming admin still has field permissions
  const forged = jwt.sign({ id: env.users.fieldA, role: "NCCR_ADMIN" }, cfg.jwtSecret);
  assert.equal((await fetch(`${env.base}/api/users`, { headers: { authorization: `Bearer ${forged}` } })).status, 403);
});

test("rate limiting returns 429 with Retry-After and standard headers", async () => {
  const saved = cfg.rateLimit.authMax; cfg.rateLimit.authMax = 3;
  try {
    let last;
    for (let i = 0; i < 6; i++) last = await fetch(`${env.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `nobody${i}@test.invalid`, password: "x" }) });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get("retry-after")) > 0);
    assert.equal(last.headers.get("ratelimit-limit"), "3");
  } finally { cfg.rateLimit.authMax = saved; }
});

test("login throttling does not reveal whether an account exists", async () => {
  const a = await env.anon.post("/api/auth/login", { email: "admin@test.invalid", password: "wrong-password-xyz" });
  const b = await env.anon.post("/api/auth/login", { email: "nobody-here@test.invalid", password: "wrong-password-xyz" });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
});

test("errors never leak stack traces; security headers present; database outage maps to 503", async () => {
  const res = await fetch(`${env.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
  const text = await res.text();
  assert.equal(res.status, 400);
  assert.ok(!/\bat \w+.*\.js:\d+/.test(text), "no stack trace");
  assert.ok(res.headers.get("x-request-id"));
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("access-control-allow-origin"), null, "no CORS by default");
  assert.ok(isDbDown({ code: "ECONNREFUSED" }) && isDbDown({ message: "Connection terminated unexpectedly" }) && !isDbDown({ code: "23505" }));

  const realQuery = db.query;
  db.query = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }));
  try {
    const r = await fetch(`${env.base}/api/projects`, { headers: { authorization: `Bearer ${env.tokens.admin}` } });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.match(body.error, /database is unavailable/i);
    assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"), "internal details are not exposed");
    const h = await fetch(`${env.base}/health`);
    assert.equal(h.status, 503);
    assert.equal((await h.json()).database, "unavailable");
  } finally { db.query = realQuery; }
  assert.equal((await fetch(`${env.base}/health`)).status, 200, "recovers when the database returns");
});

test("injection attempts in search and sort parameters are inert", async () => {
  const a = env.as("admin");
  const r = await a.get(`/api/projects?sort=${encodeURIComponent("name; DROP TABLE projects;--")}&q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.projects.length, 0);
  const all = await a.get("/api/projects?q=%25");
  assert.equal(all.body.projects.length, 0, "LIKE wildcards in user input are escaped");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM projects")).rows[0].n, 1);
});
