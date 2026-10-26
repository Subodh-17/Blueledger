// backend/src/db/index.js — PostgreSQL pool with a small transaction helper.
const { Pool, types } = require("pg");
// Return SQL DATE columns as plain "YYYY-MM-DD" strings (avoids timezone shifts and Date-object comparisons).
types.setTypeParser(1082, (v) => v);
const cfg = require("../config").db;

const poolConfig = cfg.connectionString
  ? { connectionString: cfg.connectionString, ssl: cfg.ssl, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 30000, options: "-c timezone=UTC" }
  : { ...cfg, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 30000, options: "-c timezone=UTC" };

const pool = new Pool(poolConfig);
pool.on("error", (err) => console.error("PostgreSQL pool error:", err.message));

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query: (t, p) => pool.query(t, p), tx, pool, end: () => pool.end() };
