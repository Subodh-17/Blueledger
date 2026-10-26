// backend/src/routes/index.js — REST API. Role summary:
//   PUBLIC            /public/*, /config, /carbon/methodology, /chain/status, /auth/login|register
//   FIELD_USER        create/edit/submit records and evidence for own organization's projects; transfer/retire own credits
//   VERIFIER          review evidence, start review, verify / reject / request revision, carbon assessment
//   NCCR_ADMIN        projects, users, organizations, chain roles, approve and issue credits, audit, system status
const router = require("express").Router();
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { isAddress } = require("ethers");
const fs = require("fs");
const db = require("../db");
const cfg = require("../config");
const chain = require("../services/chain");
const ops = require("../services/chainOps");
const carbon = require("../services/carbon");
const methodology = require("../services/methodology");
const notify = require("../services/notify");
const settings = require("../services/settings");
const projects = require("../services/projects");
const records = require("../services/records");
const evidence = require("../services/evidence");
const credits = require("../services/credits");
const registry = require("../services/registry");
const insights = require("../services/insights");
const reports = require("../services/reports");
const geospatial = require("../services/geospatial");
const species = require("../services/species");
const disputes = require("../services/disputes");
const audit = require("../services/audit");
const storage = require("../services/storage");
const page = require("../utils/page");
const password = require("../utils/password");
const C = require("../services/common");
const { authenticate, requireRole, sign } = require("../middleware/auth");
const { wrap, HttpError, validator, intParam } = require("../utils/http");

const { FIELD, VERIFIER, ADMIN } = C.ROLES;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.max(cfg.maxUploadBytes, 100 * 1048576), files: 1 } }); // hard ceiling; the configurable limit is enforced below
const auth = [authenticate];
const userOut = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, organizationId: u.organization_id, organization: u.organization_name, wallet: u.wallet_address });
const idemKey = (req) => {
  const k = req.get("Idempotency-Key");
  if (!k) throw new HttpError(400, "An Idempotency-Key header (8-100 characters) is required for credit transfers and retirements so that retries can never repeat the transaction");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(k)) throw new HttpError(400, "Idempotency-Key must be 8-100 characters (letters, digits, - or _)");
  return k;
};
const DUMMY_HASH = bcrypt.hashSync("unused-password-for-timing", cfg.bcryptRounds);
const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 200;

// ── Auth ─────────────────────────────────────────────────────────
const failures = new Map(); // login throttle per client + account (per process)
router.post("/auth/login", wrap(async (req, res) => {
  const { email, password: pw } = req.body || {};
  if (typeof email !== "string" || typeof pw !== "string") throw new HttpError(400, "Email and password are required");
  const key = `${req.ip}|${email.toLowerCase()}`;
  const f = failures.get(key);
  if (f && f.n >= 10 && Date.now() - f.t < 15 * 60000) throw new HttpError(429, "Too many failed sign-in attempts. Try again later.");
  const { rows } = await db.query(`SELECT u.*, o.name AS organization_name FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE lower(u.email)=lower($1)`, [email]);
  const u = rows[0];
  // compare against a dummy hash when the account does not exist so timing does not reveal valid emails
  const ok = await bcrypt.compare(pw, u?.password_hash || DUMMY_HASH);
  if (!u || !u.is_active || !ok) { failures.set(key, { n: (f?.n || 0) + 1, t: Date.now() }); throw new HttpError(401, "Invalid email or password"); }
  failures.delete(key);
  res.json({ token: sign(u), user: userOut(u) });
}));

// Self-registration creates a FIELD_USER with no organization: no project is accessible until administration assigns one.
router.post("/auth/register", wrap(async (req, res) => {
  const v = validator();
  const name = v.str(req.body, "name", { min: 2, max: 120 });
  const email = v.str(req.body, "email", { max: 200 });
  const pw = req.body?.password;
  if (email && !emailOk(email)) v.errors.email = "invalid email";
  const pwErr = password.check(pw, { email, name }); if (pwErr) v.errors.password = pwErr;
  v.done();
  try {
    const { rows } = await db.query("INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'FIELD_USER') RETURNING *", [name, email.toLowerCase(), await bcrypt.hash(pw, cfg.bcryptRounds)]);
    await db.tx((c) => audit.record(c, { actor: { id: rows[0].id, name, role: FIELD }, action: "USER_REGISTERED", entityType: "user", entityId: rows[0].id, newStatus: "FIELD_USER", details: { selfRegistered: true } }));
    res.status(201).json({ token: sign(rows[0]), user: userOut(rows[0]) });
  } catch (e) { if (e.code === "23505") throw new HttpError(409, "Email already registered"); throw e; }
}));

// ── account recovery: expiring, single-use tokens (only a SHA-256 of the token is stored); the response never reveals whether an account exists ──
const GENERIC_RESET = { message: "If an account exists for that address, a password reset link has been sent." };
router.post("/auth/forgot-password", wrap(async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 200) : "";
  res.status(202).json(GENERIC_RESET); // answered immediately and identically; the work below happens afterwards so timing reveals nothing
  if (!emailOk(email)) return;
  setImmediate(async () => {
    try {
      const u = (await db.query("SELECT id, name, email, is_active FROM users WHERE lower(email)=$1", [email])).rows[0];
      if (!u || !u.is_active) return;
      const recent = Number((await db.query("SELECT COUNT(*) AS n FROM password_resets WHERE user_id=$1 AND created_at > NOW() - interval '1 hour'", [u.id])).rows[0].n);
      if (recent >= 3) return; // silently limited per account
      const token = require("crypto").randomBytes(32).toString("base64url");
      await db.tx(async (c) => {
        await c.query("UPDATE password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL", [u.id]); // older links stop working
        await c.query("INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip) VALUES ($1,$2,NOW() + ($3 || ' minutes')::interval,$4)", [u.id, require("../utils/hash").sha256Hex(token), String(cfg.mail.resetMinutes), req.ip]);
        await audit.record(c, { actor: { id: u.id, name: u.name, role: FIELD }, action: "PASSWORD_RESET_REQUESTED", entityType: "user", entityId: u.id });
      });
      await require("../services/mailer").send({ to: u.email, subject: "Reset your Blue Carbon Registry password",
        body: `A password reset was requested for your account.\n\nOpen this link within ${cfg.mail.resetMinutes} minutes to choose a new password:\n${cfg.publicBaseUrl}/#/reset?token=${token}\n\nIf you did not request this, ignore this message; your password has not changed.` });
    } catch (e) { console.error(`[${req.id}] password reset request failed:`, e.message); }
  });
}));
router.post("/auth/reset-password", wrap(async (req, res) => {
  const { token, newPassword } = req.body || {};
  const invalid = () => new HttpError(400, "This reset link is invalid or has expired. Request a new one.");
  if (typeof token !== "string" || token.length < 20 || token.length > 200) throw invalid();
  await db.tx(async (c) => {
    const row = (await c.query(`SELECT pr.id, pr.used_at, pr.expires_at, u.id AS uid, u.email, u.name, u.is_active FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.token_hash=$1 FOR UPDATE OF pr`, [require("../utils/hash").sha256Hex(token)])).rows[0];
    if (!row || row.used_at || new Date(row.expires_at) < new Date() || !row.is_active) throw invalid();
    const e = password.check(newPassword, { email: row.email, name: row.name });
    if (e) throw new HttpError(400, "Validation failed", { newPassword: e });
    await c.query("UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2", [await bcrypt.hash(newPassword, cfg.bcryptRounds), row.uid]);
    await c.query("UPDATE password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL", [row.uid]);
    await audit.record(c, { actor: { id: row.uid, name: row.name, role: FIELD }, action: "PASSWORD_RESET_COMPLETED", entityType: "user", entityId: row.uid, details: { sessionsRevoked: true } });
  });
  res.json({ ok: true });
}));
router.post("/auth/logout", ...auth, wrap(async (req, res) => { await db.tx(async (c) => { await c.query("UPDATE users SET token_version=token_version+1 WHERE id=$1", [req.user.id]); await audit.record(c, { actor: req.user, action: "SESSIONS_REVOKED", entityType: "user", entityId: req.user.id }); }); res.json({ ok: true }); }));

router.get("/auth/me", ...auth, wrap(async (req, res) => {
  const { rows } = await db.query("SELECT u.*, o.name AS organization_name FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1", [req.user.id]);
  res.json({ user: userOut(rows[0]) });
}));
router.post("/auth/change-password", ...auth, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = (await db.query("SELECT * FROM users WHERE id=$1", [req.user.id])).rows[0];
  if (typeof currentPassword !== "string" || !(await bcrypt.compare(currentPassword, u.password_hash))) throw new HttpError(400, "Validation failed", { currentPassword: "is incorrect" });
  const e = password.check(newPassword, { email: u.email, name: u.name });
  if (e) throw new HttpError(400, "Validation failed", { newPassword: e });
  if (newPassword === currentPassword) throw new HttpError(400, "Validation failed", { newPassword: "must differ from the current password" });
  const updated = await db.tx(async (c) => {
    const { rows } = await c.query("UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2 RETURNING *", [await bcrypt.hash(newPassword, cfg.bcryptRounds), u.id]);
    await audit.record(c, { actor: req.user, action: "PASSWORD_CHANGED", entityType: "user", entityId: u.id, details: { sessionsRevoked: true } });
    return rows[0];
  });
  res.json({ ok: true, token: sign(updated) }); // every other session is revoked; this one continues with a fresh token
}));

// ── Public configuration, registry and verification ──────────────
router.get("/config", wrap(async (_req, res) => {
  const out = { map: { tileUrl: cfg.map.tileUrl || null, attribution: cfg.map.attribution }, referenceAccounts: null, methodologyVersion: carbon.METHODOLOGY_VERSION };
  if (cfg.showReferenceAccounts) {
    const rows = (await db.query(`SELECT u.name, u.email, u.role, o.name AS organization FROM users u JOIN organizations o ON o.id=u.organization_id WHERE o.is_synthetic AND u.is_active ORDER BY u.role DESC, u.id LIMIT 12`)).rows;
    if (rows.length) out.referenceAccounts = { password: cfg.referencePassword, accounts: rows };
  }
  res.json(out);
}));
router.get("/public/registry", wrap(async (_req, res) => res.json(await registry.publicRegistry())));
router.get("/public/verify/:code", wrap(async (req, res) => res.json(await registry.verifyRecord(req.params.code))));
router.get("/public/transactions", wrap(async (req, res) => res.json({ disclaimer: registry.DISCLAIMER, ...(await registry.transactions({ pageSize: 25, page: req.query.page })) })));
router.get("/chain/status", wrap(async (_req, res) => res.json(await chain.status())));
router.get("/carbon/methodology", (req, res) => { const m = carbon.describeMethodology(req.query.version); if (!m) throw new HttpError(404, "Unknown methodology version"); res.json(m); });
router.get("/methodologies", wrap(async (_req, res) => res.json({ methodologies: await Promise.all(carbon.definitions.list().map(async (d) => ({ version: d.version, title: d.title, status: d.status, illustrativeOnly: d.illustrativeOnly, approval: await methodology.approvalState(d.version) }))) })));
router.get("/methodologies/:version/reviews", ...auth, requireRole(ADMIN, VERIFIER), wrap(async (req, res) => res.json({ reviews: (await db.query("SELECT r.*, u.name AS recorded_by_name FROM methodology_reviews r JOIN users u ON u.id=r.recorded_by WHERE methodology_version=$1 ORDER BY r.id DESC", [req.params.version])).rows })));
router.post("/methodologies/:version/review", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.status(201).json({ review: await methodology.recordReview(req.user, req.params.version, req.body || {}) })));
router.get("/projects/:id/determinations", ...auth, wrap(async (req, res) => { await projects.detail(req.user, intParam(req.params.id)); res.json({ determinations: await methodology.listDeterminations(intParam(req.params.id)) }); }));
router.post("/projects/:id/determinations", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.status(201).json({ determination: await methodology.submitDetermination(req.user, intParam(req.params.id), req.body || {}) })));
router.post("/determinations/:id/review", ...auth, requireRole(VERIFIER), wrap(async (req, res) => res.json({ determination: await methodology.reviewDetermination(req.user, intParam(req.params.id), req.body || {}) })));

// ── Overview, tasks, search ──────────────────────────────────────
router.get("/overview", ...auth, wrap(async (req, res) => res.json(await insights.overview(req.user))));
// Registry reporting. Any signed-in role may ask; field users are scoped to their own organization inside the service.
router.get("/reports/registry", ...auth, wrap(async (req, res) => {
  const report = await reports.registryReport(req.user, req.query);
  if (req.query.format === "csv") {
    res.set({ "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="registry-report-${report.groupBy}.csv"`, "cache-control": "no-store" });
    return res.send(reports.toCsv(report));
  }
  if (req.query.format && req.query.format !== "json") throw new HttpError(400, "format must be json or csv");
  res.json(report);
}));
router.get("/tasks", ...auth, wrap(async (req, res) => res.json({ tasks: await insights.tasks(req.user) })));
router.get("/search", ...auth, wrap(async (req, res) => res.json(await insights.search(req.user, req.query.q))));

// ── Organizations & users ────────────────────────────────────────
router.get("/organizations", ...auth, wrap(async (_req, res) => res.json({ organizations: (await db.query("SELECT id, name, org_type, wallet_address, is_synthetic FROM organizations ORDER BY name")).rows })));
router.post("/organizations", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  const v = validator();
  const name = v.str(req.body, "name", { min: 3, max: 200 });
  const orgType = v.str(req.body, "orgType", { oneOf: projects.ORG_TYPES });
  const wallet = v.str(req.body, "walletAddress", { optional: true, max: 42 });
  if (wallet && !isAddress(wallet)) v.errors.walletAddress = "invalid address";
  v.done();
  try {
    const o = await db.tx(async (c) => {
      const { rows } = await c.query("INSERT INTO organizations (name, org_type, wallet_address) VALUES ($1,$2,$3) RETURNING *", [name, orgType, wallet || null]);
      await audit.record(c, { actor: req.user, action: "ORGANIZATION_CREATED", entityType: "organization", entityId: rows[0].id, details: { name, orgType } });
      return rows[0];
    });
    res.status(201).json({ organization: o });
  } catch (e) { if (e.code === "23505") throw new HttpError(409, "Organization name already exists"); throw e; }
}));

const USORT = { name: { sql: "lower(u.name)", dir: "ASC" }, role: { sql: "u.role", dir: "ASC" }, created: { sql: "u.created_at" } };
router.get("/users", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (req.query.q) add("(u.name ILIKE ? OR u.email ILIKE ?)", page.like(req.query.q));
  if ([FIELD, VERIFIER, ADMIN].includes(req.query.role)) add("u.role=?", req.query.role);
  if (req.query.active === "1" || req.query.active === "0") add("u.is_active=?", req.query.active === "1");
  const r = await page.run({ select: "SELECT u.id, u.name, u.email, u.role, u.organization_id, o.name AS organization_name, u.wallet_address, u.is_active, u.created_at", from: "FROM users u LEFT JOIN organizations o ON o.id=u.organization_id", where, params }, page.parse(req.query, USORT, "name", "u.id"));
  res.json({ users: r.rows, pagination: r.pagination });
}));
router.post("/users", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  const v = validator();
  const name = v.str(req.body, "name", { min: 2, max: 120 });
  const email = v.str(req.body, "email", { max: 200 });
  const role = v.str(req.body, "role", { oneOf: [FIELD, VERIFIER, ADMIN] });
  const organizationId = v.num(req.body, "organizationId", { optional: true, int: true, min: 1 });
  const wallet = v.str(req.body, "walletAddress", { optional: true, max: 42 });
  if (email && !emailOk(email)) v.errors.email = "invalid email";
  if (wallet && !isAddress(wallet)) v.errors.walletAddress = "invalid address";
  const pwErr = password.check(req.body?.password, { email, name }); if (pwErr) v.errors.password = pwErr;
  v.done();
  try {
    const u = await db.tx(async (c) => {
      const { rows } = await c.query("INSERT INTO users (name,email,password_hash,role,organization_id,wallet_address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [name, email.toLowerCase(), await bcrypt.hash(req.body.password, cfg.bcryptRounds), role, organizationId || null, wallet || null]);
      await audit.record(c, { actor: req.user, action: "USER_CREATED", entityType: "user", entityId: rows[0].id, newStatus: role, details: { email, role, organizationId: organizationId || null } });
      return rows[0];
    });
    res.status(201).json({ user: userOut(u) });
  } catch (e) { if (e.code === "23505") throw new HttpError(409, "Email already registered"); if (e.code === "23503") throw new HttpError(400, "Unknown organization"); throw e; }
}));
router.patch("/users/:id", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  const id = intParam(req.params.id), b = req.body || {};
  const u = (await db.query("SELECT * FROM users WHERE id=$1", [id])).rows[0];
  if (!u) throw new HttpError(404, "User not found");
  if (id === req.user.id && (b.isActive === false || (b.role && b.role !== ADMIN))) throw new HttpError(400, "You cannot deactivate your own account or lower your own role");
  if (b.walletAddress && !isAddress(b.walletAddress)) throw new HttpError(400, "Invalid wallet address");
  if (b.role && ![FIELD, VERIFIER, ADMIN].includes(b.role)) throw new HttpError(400, "Invalid role");
  await db.tx(async (c) => {
    await c.query("UPDATE users SET is_active=COALESCE($1,is_active), organization_id=COALESCE($2,organization_id), wallet_address=COALESCE($3,wallet_address), role=COALESCE($4,role), token_version=token_version + CASE WHEN $1 IS FALSE OR ($4 IS NOT NULL AND $4 <> role) THEN 1 ELSE 0 END WHERE id=$5",
      [typeof b.isActive === "boolean" ? b.isActive : null, b.organizationId || null, b.walletAddress || null, b.role || null, id]);
    await audit.record(c, { actor: req.user, action: "USER_UPDATED", entityType: "user", entityId: id, previousStatus: u.role, newStatus: b.role || u.role, details: { isActive: b.isActive, organizationId: b.organizationId, role: b.role } });
  });
  res.json({ ok: true });
}));
// Grant or revoke the on-chain verifier / registrar role for a user's wallet (registry administrator signs).
router.post("/users/:id/chain-role", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  const id = intParam(req.params.id), { role, granted } = req.body || {};
  if (!["verifier", "registrar"].includes(role) || typeof granted !== "boolean") throw new HttpError(400, "role must be 'verifier' or 'registrar' and granted must be true or false");
  const u = (await db.query("SELECT * FROM users WHERE id=$1", [id])).rows[0];
  if (!u) throw new HttpError(404, "User not found");
  if (!u.wallet_address) throw new HttpError(422, "The user has no wallet address");
  if (role === "verifier" && u.role !== VERIFIER) throw new HttpError(422, "Only users with the Verifier role can be given the on-chain verifier role");
  const out = await ops.run("ROLE_CHANGE", `role:${id}:${role}:${granted}:${require("crypto").randomUUID()}`, { userId: id, account: u.wallet_address, role, granted }, { actor: req.user });
  res.json({ ok: true, tx: out.tx?.txHash || null, roles: await chain.rolesOf(u.wallet_address) });
}));

// ── Projects ─────────────────────────────────────────────────────
router.get("/projects", ...auth, wrap(async (req, res) => res.json(await projects.list(req.user, req.query))));
router.post("/projects", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.status(201).json({ project: await projects.create(req.user, req.body || {}) })));
router.get("/projects/:id", ...auth, wrap(async (req, res) => res.json(await projects.detail(req.user, intParam(req.params.id)))));
router.patch("/projects/:id/status", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.json({ project: await projects.setStatus(req.user, intParam(req.params.id), req.body?.status, req.body?.reason) })));

// ── Monitoring records ───────────────────────────────────────────
router.get("/records", ...auth, wrap(async (req, res) => res.json(await records.list(req.user, req.query))));
router.post("/records", ...auth, requireRole(FIELD), wrap(async (req, res) => res.status(201).json({ record: await records.create(req.user, req.body || {}) })));
router.get("/records/:id", ...auth, wrap(async (req, res) => res.json(await records.get(req.user, intParam(req.params.id)))));
router.put("/records/:id", ...auth, requireRole(FIELD), wrap(async (req, res) => res.json({ record: await records.update(req.user, intParam(req.params.id), req.body || {}) })));
router.post("/records/:id/submit", ...auth, requireRole(FIELD), wrap(async (req, res) => res.json({ record: await records.submit(req.user, intParam(req.params.id)) })));
router.post("/records/:id/anchor", ...auth, requireRole(ADMIN, VERIFIER), wrap(async (req, res) => res.json({ record: await records.anchorRecord(req.user, intParam(req.params.id)) })));
router.post("/records/:id/start-review", ...auth, requireRole(VERIFIER), wrap(async (req, res) => res.json({ record: await records.startReview(req.user, intParam(req.params.id)) })));
router.post("/records/:id/decision", ...auth, requireRole(VERIFIER), wrap(async (req, res) => res.json(await records.decide(req.user, intParam(req.params.id), req.body || {}))));
router.post("/records/:id/carbon-estimate", ...auth, requireRole(VERIFIER, ADMIN), wrap(async (req, res) => res.status(201).json({ calculation: await credits.calculate(req.user, intParam(req.params.id)) })));

// ── Evidence ─────────────────────────────────────────────────────
router.get("/evidence", ...auth, wrap(async (req, res) => res.json(await evidence.list(req.user, req.query))));
router.post("/evidence", ...auth, requireRole(FIELD), upload.single("file"), wrap(async (req, res) => {
  const limit = cfg.runtimeMaxUploadBytes || cfg.maxUploadBytes;
  if (req.file && req.file.size > limit) throw new HttpError(413, `The file is larger than the ${Math.round(limit / 1048576)} MB limit for one evidence file`);
  const e = await evidence.add(req.user, req.body || {}, req.file);
  res.status(201).json({ evidence: evidence.present(e) });
}));
router.get("/evidence/:id", ...auth, wrap(async (req, res) => { const e = await evidence.get(req.user, intParam(req.params.id)); delete e.storage_uri; delete e.enc_key_id; delete e.enc_wrapped_key; res.json({ evidence: e }); }));
router.get("/evidence/:id/file", ...auth, wrap(async (req, res) => {
  const e = await evidence.get(req.user, intParam(req.params.id));
  if (!e.storage_uri) throw new HttpError(404, "No file is held for this evidence item (reference only)");
  if (!storage.exists(e.storage_uri)) throw new HttpError(404, "The stored file is missing from evidence storage");
  let bytes;
  try { bytes = storage.readStored(e); }
  catch (err) { if (err.code === "INTEGRITY") throw new HttpError(409, "The stored file no longer matches its recorded content hash; it was not served"); if (err.code === "KEY_UNAVAILABLE") throw new HttpError(503, "The encryption key for this file is unavailable"); throw err; }
  const safeName = (e.filename || e.code).replace(/[^\w.\- ]/g, "_");
  res.set({ "Content-Type": e.mime_type || "application/octet-stream", "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${req.query.download === "1" ? "attachment" : "inline"}; filename="${safeName}"`, "Cache-Control": "private, no-store", "Content-Length": String(bytes.length) });
  res.end(bytes);
}));
// Geospatial import (GeoJSON from field surveys or processed drone products). /validate is a dry run that stores nothing.
router.post("/geospatial/validate", ...auth, requireRole(FIELD), upload.single("file"), wrap(async (req, res) => res.json(await geospatial.check(req.user, req.body || {}, req.file))));
router.post("/geospatial/import", ...auth, requireRole(FIELD), upload.single("file"), wrap(async (req, res) => res.status(201).json(await geospatial.importFile(req.user, req.body || {}, req.file))));
router.get("/geospatial/imports", ...auth, wrap(async (req, res) => res.json(await geospatial.list(req.user, req.query))));
router.get("/geospatial/imports/:evidenceId", ...auth, wrap(async (req, res) => res.json(await geospatial.describe(req.user, intParam(req.params.evidenceId)))));
// Planting by species for a record (editable by the submitting collector while the record is a draft or awaiting revision).
router.get("/records/:id/species", ...auth, wrap(async (req, res) => res.json(await species.get(req.user, intParam(req.params.id)))));
router.put("/records/:id/species", ...auth, requireRole(FIELD), wrap(async (req, res) => res.json(await species.set(req.user, intParam(req.params.id), req.body || {}))));
router.post("/evidence/:id/rescan", ...auth, requireRole(VERIFIER, ADMIN), wrap(async (req, res) => res.json({ scan: await evidence.rescan(req.user, intParam(req.params.id)) })));
router.post("/evidence/:id/replace", ...auth, requireRole(FIELD), upload.single("file"), wrap(async (req, res) => res.status(201).json({ evidence: evidence.present(await evidence.replace(req.user, intParam(req.params.id), req.body || {}, req.file)) })));
router.get("/evidence/:id/history", ...auth, wrap(async (req, res) => res.json(await evidence.history(req.user, intParam(req.params.id)))));
router.post("/system/ipfs/retry", ...auth, requireRole(ADMIN), wrap(async (req, res) => { if (req.body?.resetAttempts) await db.query("UPDATE evidence SET ipfs_attempts=0, ipfs_status='PENDING', ipfs_next_retry_at=NULL WHERE ipfs_status='UNAVAILABLE'"); res.json(await require("../services/ipfs").processPending({ force: true })); }));
router.post("/evidence/:id/review", ...auth, requireRole(VERIFIER), wrap(async (req, res) => res.json({ evidence: await evidence.review(req.user, intParam(req.params.id), req.body || {}) })));
router.post("/evidence/:id/extract-metadata", ...auth, requireRole(VERIFIER, ADMIN), wrap(async (req, res) => res.json({ metadata: await evidence.extractMetadata(req.user, intParam(req.params.id)) })));

// ── Carbon assessment, approval, credits ─────────────────────────
router.get("/carbon/calculations", ...auth, requireRole(VERIFIER, ADMIN), wrap(async (req, res) => {
  const where = ["c.is_current"], params = [];
  if (["PENDING", "APPROVED", "REJECTED"].includes(req.query.approval)) { params.push(req.query.approval); where.push(`c.approval_status=$${params.length}`); }
  const r = await page.run({ select: `SELECT c.*, r.code AS record_code, p.code AS project_code, p.name AS project_name, p.ecosystem_type, u.name AS calculated_by_name, a.name AS approved_by_name,
      EXISTS (SELECT 1 FROM carbon_credits k WHERE k.record_id=c.record_id) AS credited`,
    from: `FROM carbon_calculations c JOIN monitoring_records r ON r.id=c.record_id JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=c.calculated_by LEFT JOIN users a ON a.id=c.approved_by`, where, params },
    page.parse(req.query, { calculated: { sql: "c.calculated_at" } }, "calculated", "c.id"));
  res.json({ calculations: r.rows, pagination: r.pagination });
}));
router.post("/carbon/calculations/:id/approve", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.json({ calculation: await credits.approve(req.user, intParam(req.params.id), req.body || {}) })));
router.post("/carbon/calculations/:id/issue", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.status(201).json(await credits.issue(req.user, intParam(req.params.id), req.body || {}))));
router.get("/credits", ...auth, wrap(async (req, res) => res.json(await credits.list(req.user, req.query))));
router.get("/credits/:id", ...auth, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  if (req.user.role === FIELD) { // cross-organization access check: project owner or current/previous holder only
    const ok = (await db.query(`SELECT 1 FROM carbon_credits cc JOIN projects p ON p.id=cc.project_id WHERE cc.id=$1 AND (p.organization_id=$2 OR EXISTS (SELECT 1 FROM credit_events e WHERE e.credit_id=cc.id AND (e.to_org_id=$2 OR e.from_org_id=$2)))`, [id, req.user.organization_id])).rows.length;
    if (!ok) throw new HttpError(403, "This credit batch is not associated with your organization");
  }
  res.json(await credits.detail(id));
}));
// Disputes against issued credit batches (registry control; see services/disputes.js for what this does and does not do).
router.post("/credits/:id/disputes", ...auth, wrap(async (req, res) => res.status(201).json(await disputes.raise(req.user, intParam(req.params.id), req.body || {}))));
router.get("/credits/:id/disputes", ...auth, wrap(async (req, res) => res.json(await disputes.forCredit(req.user, intParam(req.params.id)))));
router.get("/disputes", ...auth, wrap(async (req, res) => res.json(await disputes.list(req.user, req.query))));
router.post("/disputes/:id/start-review", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.json(await disputes.startReview(req.user, intParam(req.params.id)))));
router.post("/disputes/:id/decision", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.json(await disputes.decide(req.user, intParam(req.params.id), req.body || {}))));
router.post("/disputes/:id/withdraw", ...auth, wrap(async (req, res) => res.json(await disputes.withdraw(req.user, intParam(req.params.id), req.body || {}))));
router.post("/credits/:id/transfer", ...auth, requireRole(FIELD, ADMIN), wrap(async (req, res) => res.status(201).json(await credits.moveCredits(req.user, intParam(req.params.id), "TRANSFERRED", req.body || {}, idemKey(req)))));
router.post("/credits/:id/retire", ...auth, requireRole(FIELD, ADMIN), wrap(async (req, res) => res.status(201).json(await credits.moveCredits(req.user, intParam(req.params.id), "RETIRED", req.body || {}, idemKey(req)))));
router.post("/credits/:id/cancel", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.status(201).json(await credits.cancelCredits(req.user, intParam(req.params.id), req.body || {}))));

// ── Registry activity, administration, audit ─────────────────────
router.get("/chain/transactions", ...auth, wrap(async (req, res) => res.json(await registry.transactions(req.query))));
router.get("/chain/operations", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  const where = [], params = [];
  if (["PENDING", "SUBMITTED", "CONFIRMED", "COMPLETED", "FAILED"].includes(req.query.status)) { params.push(req.query.status); where.push(`o.status=$${params.length}`); }
  const r = await page.run({ select: "SELECT o.id, o.op_type, o.status, o.tx_hash, o.attempts, o.last_error, o.created_at, o.updated_at, o.completed_at, p.code AS project_code, r.code AS record_code",
    from: "FROM chain_operations o LEFT JOIN projects p ON p.id=o.project_id LEFT JOIN monitoring_records r ON r.id=o.record_id", where, params }, page.parse(req.query, { created: { sql: "o.id" } }, "created", "o.id"));
  res.json({ operations: r.rows, pagination: r.pagination });
}));
router.get("/admin/stats", ...auth, requireRole(ADMIN, VERIFIER), wrap(async (_req, res) => res.json({ stats: await registry.adminStats(), chain: await chain.status() })));
// ── notifications, runtime settings, on-chain roles ──
router.get("/notifications", ...auth, wrap(async (req, res) => res.json(await notify.list(req.user, { unread: req.query.unread === "1", page: req.query.page, pageSize: req.query.pageSize }))));
router.post("/notifications/read", ...auth, wrap(async (req, res) => res.json({ marked: await notify.markRead(req.user, req.body || {}) })));
router.get("/settings", ...auth, requireRole(ADMIN), wrap(async (_req, res) => res.json({ settings: await settings.list() })));
router.get("/settings/history", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.json({ history: await settings.history(req.query.key) })));
router.put("/settings/:key", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.json(await settings.set(req.user, req.params.key, req.body?.value, req.body?.reason))));
router.delete("/settings/:key", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.json(await settings.reset(req.user, req.params.key, req.body?.reason))));
router.get("/chain/roles", ...auth, requireRole(ADMIN), wrap(async (_req, res) => {
  const auditCandidates = (await db.query("SELECT DISTINCT details->>'account' AS account, details->>'role' AS role FROM audit_logs WHERE action='CHAIN_ROLE_CHANGED' AND details->>'account' IS NOT NULL")).rows;
  const wallets = (await db.query("SELECT lower(wallet_address) AS w, name, role FROM users WHERE wallet_address IS NOT NULL")).rows;
  const userCandidates = wallets.map((u) => ({ account: u.w, role: u.role === "VERIFIER" ? "verifier" : "registrar" }));
  const r = await chain.roleHolders([...auditCandidates, ...userCandidates]);
  const owner = (a) => wallets.find((u) => u.w === String(a).toLowerCase());
  res.json({ ...r, holders: r.holders.map((h) => ({ ...h, user: owner(h.account) ? { name: owner(h.account).name, role: owner(h.account).role } : null })), adminUser: owner(r.admin)?.name || null });
}));
router.post("/chain/roles", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  const { account, role, granted } = req.body || {};
  if (!isAddress(account || "")) throw new HttpError(400, "A valid wallet address is required");
  if (!["verifier", "registrar"].includes(role) || typeof granted !== "boolean") throw new HttpError(400, "role must be 'verifier' or 'registrar' and granted must be true or false");
  const out = await ops.run("ROLE_CHANGE", `role:${account.toLowerCase()}:${role}:${granted}:${require("crypto").randomUUID()}`, { userId: null, account, role, granted }, { actor: req.user });
  res.json({ ok: true, tx: out.tx?.txHash || null, roles: await chain.rolesOf(account) });
}));
router.post("/chain/admin/propose", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  const { account } = req.body || {}; if (!isAddress(account || "")) throw new HttpError(400, "A valid wallet address is required");
  const t = await chain.proposeAdmin(account); const info = await t.wait();
  await db.tx((c) => audit.record(c, { actor: req.user, action: "ADMIN_HANDOVER_PROPOSED", entityType: "chain_role", entityId: account, txHash: info.txHash, details: { account } }));
  res.json({ ok: true, tx: info.txHash, note: "The proposed account must accept from its own wallet (acceptAdmin) before control changes." });
}));
router.post("/system/alerts/check", ...auth, requireRole(ADMIN), wrap(async (_req, res) => res.json({ raised: await require("../services/alerts").check() })));
router.get("/system/consistency", ...auth, requireRole(ADMIN), wrap(async (_req, res) => res.json(await require("../services/consistency").check())));
router.get("/chain/operations/:id/events", ...auth, requireRole(ADMIN), wrap(async (req, res) => res.json({ events: (await db.query("SELECT at, event, detail FROM chain_operation_events WHERE op_id=$1 ORDER BY id", [intParam(req.params.id)])).rows })));
router.get("/system/status", ...auth, requireRole(ADMIN), wrap(async (_req, res) => res.json(await insights.systemStatus())));
router.post("/system/reconcile-evidence", ...auth, requireRole(ADMIN), wrap(async (_req, res) => res.json(await require("../services/ipfs").processPending({ force: true }))));
router.post("/system/reconcile", ...auth, requireRole(ADMIN), wrap(async (req, res) => {
  await chain.ensure();
  const summary = await ops.reconcile();
  await db.tx((c) => audit.record(c, { actor: req.user, action: "RECONCILIATION_RUN", entityType: "system", details: summary }));
  res.json(summary);
}));
const ASORT = { created: { sql: "a.id" } };
router.get("/audit", ...auth, requireRole(ADMIN, VERIFIER), wrap(async (req, res) => {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (Number(req.query.projectId) > 0) add("a.project_id=?", Number(req.query.projectId));
  if (Number(req.query.recordId) > 0) add("a.record_id=?", Number(req.query.recordId));
  if (Number(req.query.actorId) > 0) add("a.actor_id=?", Number(req.query.actorId));
  if (req.query.action) add("a.action=?", String(req.query.action).slice(0, 40));
  if (req.query.entity) add("a.entity_type=?", String(req.query.entity).slice(0, 30));
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "")) add("a.created_at >= ?::date", req.query.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "")) add("a.created_at < (?::date + 1)", req.query.to);
  const r = await page.run({ select: "SELECT a.*, p.code AS project_code, r.code AS record_code", from: "FROM audit_logs a LEFT JOIN projects p ON p.id=a.project_id LEFT JOIN monitoring_records r ON r.id=a.record_id", where, params },
    page.parse({ pageSize: 50, ...req.query }, ASORT, "created", "a.id"));
  res.json({ entries: r.rows, pagination: r.pagination });
}));
router.get("/audit/verify", ...auth, requireRole(ADMIN), wrap(async (_req, res) => res.json(await audit.verifyChain())));

module.exports = router;
