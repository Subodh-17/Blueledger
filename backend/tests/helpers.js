// backend/tests/helpers.js — fixtures + tiny API client for the integration tests.
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { JsonRpcProvider } = require("ethers");
const db = require("../src/db");
const chain = require("../src/services/chain");
const app = require("../src/app");

const PASSWORD = "test-password-1234";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const uniquePng = () => Buffer.concat([PNG, crypto.randomBytes(16)]);

async function setup() {
  await db.query(`TRUNCATE audit_logs, credit_events, credit_balances, carbon_credits, carbon_calculations, verification_records, blockchain_transactions,
    evidence, monitoring_records, projects, users, organizations RESTART IDENTITY CASCADE`);
  const accounts = (await new JsonRpcProvider(process.env.ETH_RPC_URL).listAccounts()).map((a) => a.address);
  const org = async (name, type, wallet) => (await db.query("INSERT INTO organizations (name, org_type, wallet_address, is_synthetic) VALUES ($1,$2,$3,TRUE) RETURNING id", [name, type, wallet])).rows[0].id;
  const orgs = { nccr: await org("Test NCCR", "REGULATOR", accounts[0]), a: await org("Test NGO A", "NGO", accounts[4]),
    b: await org("Test NGO B", "COMMUNITY", accounts[5]), buyer: await org("Test Buyer", "CREDIT_HOLDER", accounts[6]) };
  const hash = await bcrypt.hash(PASSWORD, 4);
  const user = async (key, role, orgId, wallet) => (await db.query("INSERT INTO users (name,email,password_hash,role,organization_id,wallet_address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [key, `${key}@test.invalid`, hash, role, orgId, wallet])).rows[0].id;
  const users = { admin: await user("admin", "NCCR_ADMIN", orgs.nccr, accounts[0]), verifier: await user("verifier", "VERIFIER", orgs.nccr, accounts[1]),
    verifier2: await user("verifier2", "VERIFIER", orgs.nccr, accounts[3]), fieldA: await user("fieldA", "FIELD_USER", orgs.a, null),
    fieldB: await user("fieldB", "FIELD_USER", orgs.b, null), buyer: await user("buyer", "FIELD_USER", orgs.buyer, null) };
  await chain.init();
  if (!chain.ready) throw new Error("chain not ready: " + chain.error);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  const call = async (method, path, { token, body, form } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (method === "POST" && /\/credits\/\d+\/(transfer|retire)$/.test(path)) headers["idempotency-key"] = crypto.randomUUID();
    let payload;
    if (form) payload = form; else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers, body: payload });
    let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json };
  };
  for (const k of Object.keys(users)) tokens[k] = (await call("POST", "/api/auth/login", { body: { email: `${k}@test.invalid`, password: PASSWORD } })).body.token;
  const as = (who) => ({
    get: (p) => call("GET", p, { token: tokens[who] }), post: (p, body) => call("POST", p, { token: tokens[who], body }),
    put: (p, body) => call("PUT", p, { token: tokens[who], body }), patch: (p, body) => call("PATCH", p, { token: tokens[who], body }),
    upload: (fields, buf = uniquePng(), name = "photo.png") => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
      if (buf) form.append("file", new Blob([buf]), name);
      return call("POST", "/api/evidence", { token: tokens[who], form });
    },
  });
  const anon = { get: (p) => call("GET", p), post: (p, body) => call("POST", p, { body }) };
  const provider = new JsonRpcProvider(process.env.ETH_RPC_URL);
  return { provider, base, orgs, users, accounts, tokens, as, anon, close: async () => { server.close(); await db.end(); } };
}

const projectBody = (orgId, over = {}) => ({ name: "Test Mangrove Belt (synthetic)", ecosystemType: "MANGROVE", restorationType: "MANGROVE_PLANTATION",
  region: "Synthetic Test Estuary", latitude: 16.9, longitude: 82.2, areaHectares: 50, startDate: "2020-01-01", organizationId: orgId, dataOrigin: "ILLUSTRATIVE", ...over });
const recordBody = (projectId, over = {}) => ({ projectId, activityType: "MONITORING_SURVEY", activityDate: "2026-06-01", latitude: 16.9005, longitude: 82.2005,
  locationAccuracyM: 4, areaHa: 40, observations: "Synthetic survey: healthy propagules across plots, tidal flow restored.", measurements: { survival_rate_pct: 80, avg_height_cm: 210, canopy_cover_pct: 55 }, ...over });

module.exports = { setup, projectBody, recordBody, uniquePng, PASSWORD };
