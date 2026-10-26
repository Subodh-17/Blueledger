// backend/src/config.js — all configuration comes from the environment (see .env.example).
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const crypto = require("crypto");

const env = process.env;
const isProd = env.NODE_ENV === "production";

if (isProd && (env.CORS_ORIGINS || "").includes("*")) throw new Error("CORS_ORIGINS must list explicit origins in production");
let jwtSecret = env.JWT_SECRET;
if (!jwtSecret || jwtSecret.startsWith("change_this")) {
  if (isProd) throw new Error("JWT_SECRET must be set to a long random value (>= 32 characters) in production");
  jwtSecret = crypto.randomBytes(32).toString("hex"); // ephemeral: tokens die on restart (dev only)
  if (env.NODE_ENV !== "test") console.warn("[config] JWT_SECRET not set - using an ephemeral development secret");
}

if (isProd && env.EVIDENCE_ENCRYPTION === "off") console.warn("[config] EVIDENCE_ENCRYPTION=off in production: evidence files are stored unencrypted");
if (isProd && jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters in production");

module.exports = {
  isProd,
  port: Number(env.PORT || 3001),
  jwtSecret,
  bcryptRounds: Number(env.BCRYPT_ROUNDS || 12),
  corsOrigins: (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  db: {
    connectionString: env.DATABASE_URL || env.POSTGRES_URL || env.SUPABASE_DATABASE_URL || undefined,
    ssl: env.DB_SSL === "true" || ((env.DATABASE_URL || env.POSTGRES_URL || env.SUPABASE_DATABASE_URL) && !(env.DATABASE_URL || env.POSTGRES_URL || env.SUPABASE_DATABASE_URL).includes("localhost") && !(env.DATABASE_URL || env.POSTGRES_URL || env.SUPABASE_DATABASE_URL).includes("127.0.0.1")) ? { rejectUnauthorized: false } : undefined,
    host: env.DB_HOST || "localhost",
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME || "blue_carbon_mrv",
    user: env.DB_USER || "postgres",
    password: env.DB_PASSWORD,
  },
  chain: {
    rpcUrl: env.ETH_RPC_URL || "http://127.0.0.1:8545",
    // "local": use the unlocked accounts of a local Hardhat/Anvil node (development only)
    // "keys":  use CHAIN_*_PRIVATE_KEY service keys from the environment
    mode: env.CHAIN_MODE || "local",
    deploymentFile: env.DEPLOYMENT_FILE || path.join(__dirname, "..", "..", "blockchain", "deployments", "localhost.json"),
    contractAddress: env.CONTRACT_ADDRESS || null,
    expectedChainId: env.EXPECTED_CHAIN_ID ? Number(env.EXPECTED_CHAIN_ID) : null,   // REQUIRED in production
    allowLocalChain: env.ALLOW_LOCAL_CHAIN === "1",
    confirmations: Math.max(1, Number(env.CHAIN_CONFIRMATIONS || 1)),
    dropGraceMs: Number(env.TX_DROP_GRACE_MS || 120000),
    adminKey: env.CHAIN_ADMIN_PRIVATE_KEY,
    verifierKey: env.CHAIN_VERIFIER_PRIVATE_KEY,
    registrarKey: env.CHAIN_REGISTRAR_PRIVATE_KEY,
  },
  ipfs: {
    provider: env.IPFS_PROVIDER || "none", // none | kubo | pinata
    apiUrl: env.IPFS_API_URL || "http://127.0.0.1:5001",
    timeoutMs: Number(env.IPFS_TIMEOUT_MS || 15000), retryMax: Number(env.IPFS_RETRY_MAX || 6), backoffBaseMs: Number(env.IPFS_BACKOFF_BASE_MS || 30000), backoffMaxMs: Number(env.IPFS_BACKOFF_MAX_MS || 900000),
    gatewayUrl: env.IPFS_GATEWAY_URL || null,
    pinataJwt: env.PINATA_JWT,
  },
  uploadDir: env.UPLOAD_DIR || path.join(__dirname, "..", "uploads"),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
  referencePassword: env.REFERENCE_PASSWORD || "Reference-Pass-2026",
  // Reference sign-in shortcuts on the login page (development convenience; always off in production)
  showReferenceAccounts: !isProd && env.SHOW_REFERENCE_ACCOUNTS !== "0",
  map: {
    tileUrl: env.MAP_TILE_URL === undefined ? "https://tile.openstreetmap.org/{z}/{x}/{y}.png" : env.MAP_TILE_URL, // empty string disables basemap tiles
    attribution: env.MAP_ATTRIBUTION || "© OpenStreetMap contributors",
  },
  jwtExpiresIn: env.JWT_EXPIRES_IN || "8h",
  publicBaseUrl: env.PUBLIC_BASE_URL || `http://localhost:${Number(env.PORT || 3001)}`,
  mail: { transport: env.MAIL_TRANSPORT || (isProd ? "smtp" : "outbox"), smtpUrl: env.SMTP_URL, from: env.MAIL_FROM || "Blue Carbon Registry <no-reply@localhost>", resetMinutes: Number(env.PASSWORD_RESET_MINUTES || 30) },
  scan: { policy: env.MALWARE_SCAN || (isProd ? "required" : "optional"), host: env.CLAMAV_HOST || "127.0.0.1", port: Number(env.CLAMAV_PORT || 3310), timeoutMs: Number(env.CLAMAV_TIMEOUT_MS || 20000) },
  encryption: { mode: env.EVIDENCE_ENCRYPTION || "off", current: env.EVIDENCE_KEK_CURRENT, previous: env.EVIDENCE_KEK_PREVIOUS },
  orgQuotaBytes: Number(env.EVIDENCE_ORG_QUOTA_MB || 2048) * 1024 * 1024,
  inspectMaxBytes: Number(env.INSPECT_MAX_MB || 10) * 1024 * 1024,
  alertBacklogSeconds: Number(env.ALERT_BACKLOG_SECONDS || 900),
  rpcTimeoutMs: Number(env.RPC_TIMEOUT_MS || 10000),
  txConfirmTimeoutMs: Number(env.TX_CONFIRM_TIMEOUT_MS || 60000),
  reconcileIntervalMs: Number(env.RECONCILE_INTERVAL_MS || 30000),
  rateLimit: { windowMs: 60000, max: Number(env.RATE_LIMIT_MAX || 600), authMax: Number(env.RATE_LIMIT_AUTH_MAX || 30), uploadMax: Number(env.RATE_LIMIT_UPLOAD_MAX || 60) },
};
