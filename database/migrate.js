// database/migrate.js
// Applies every SQL file in database/migrations in filename order, once each.
// Usage: node database/migrate.js            (uses backend/.env or process env)
//        node database/migrate.js --reset    (DROP SCHEMA public CASCADE first; refuses in production)
const path = require("path");
const fs = require("fs");
const BACKEND = path.join(__dirname, "..", "backend");
const req = (m) => require(require.resolve(m, { paths: [BACKEND] }));
req("dotenv").config({ path: path.join(BACKEND, ".env") });
const { Pool } = req("pg");

async function migrate({ reset = false, pool: given } = {}) {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DATABASE_URL;
  if (process.env.NODE_ENV === "production" && !connectionString && !process.env.DB_HOST) {
    throw new Error("DATABASE_URL is not set in production. Please configure your PostgreSQL connection string (e.g. Supabase URI) in the service environment variables.");
  }
  const masked = connectionString ? connectionString.replace(/:[^:@]+@/, ":***@") : (process.env.DB_HOST || "localhost");
  console.log(`[migrate] Connecting to database: ${masked}`);
  const pool = given || new Pool(
    connectionString
      ? { connectionString, ssl: !connectionString.includes("localhost") && !connectionString.includes("127.0.0.1") ? { rejectUnauthorized: false } : undefined }
      : {
          host: process.env.DB_HOST || "localhost",
          port: Number(process.env.DB_PORT || 5432),
          database: process.env.DB_NAME || "blue_carbon_mrv",
          user: process.env.DB_USER || "postgres",
          password: process.env.DB_PASSWORD,
        }
  );
  try {
    if (reset) {
      if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
    const dir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const applied = [];
    for (const f of files) {
      const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE filename=$1", [f]);
      if (rows.length) continue;
      const client = await pool.connect();
      try {
        await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
        await client.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [f]);
        applied.push(f);
      } finally { client.release(); }
    }
    return applied;
  } finally {
    if (!given) await pool.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate({ reset: process.argv.includes("--reset") })
    .then((a) => { console.log(a.length ? `Applied: ${a.join(", ")}` : "Database already up to date"); process.exit(0); })
    .catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
}
