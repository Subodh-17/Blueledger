// backend/src/app.js — Express application factory (no listen; used by index.js and tests).
const express = require("express");
const cors = require("cors");
const path = require("path");
const cfg = require("./config");
const routes = require("./routes");
const db = require("./db");
const { HttpError } = require("./utils/http");
const { requestId, limiter, headers, isDbDown } = require("./middleware/security");
const log = require("./utils/log");
const metrics = require("./services/metrics");
const { authenticate, requireRole } = require("./middleware/auth");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "1");

app.use(requestId);
app.use((req, res, next) => { // structured access log: method, path (no query string), status, duration, request id, user id. Never bodies, headers or tokens.
  const t0 = process.hrtime.bigint();
  res.on("finish", () => { const s = Number(process.hrtime.bigint() - t0) / 1e9; if (req.path !== "/health" && req.path !== "/metrics") metrics.observe(req.method, res.statusCode, s); if (req.path.startsWith("/api")) log.info("request", { requestId: req.id, method: req.method, path: req.baseUrl + req.path, status: res.statusCode, ms: Math.round(s * 1000), userId: req.user?.id }); });
  next();
});
if (cfg.corsOrigins.length) app.use(cors({ origin: cfg.corsOrigins }));
app.use(headers);
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try { await db.query("SELECT 1"); res.json({ status: "ok", database: "connected", ts: new Date().toISOString() }); }
  catch { res.status(503).json({ status: "degraded", database: "unavailable", ts: new Date().toISOString() }); }
});
// Prometheus metrics: a dedicated bearer token (METRICS_TOKEN) or a signed-in registry administrator.
app.get("/metrics", (req, res, next) => {
  const t = process.env.METRICS_TOKEN, h = req.get("authorization") || "";
  if (t) { const a = Buffer.from(h), b = Buffer.from(`Bearer ${t}`); return a.length === b.length && crypto.timingSafeEqual(a, b) ? next() : next(new HttpError(401, "Metrics access requires the metrics token")); }
  authenticate(req, res, (e) => (e ? next(e) : requireRole("NCCR_ADMIN")(req, res, next)));
}, async (_req, res, next) => { try { res.type("text/plain; version=0.0.4").send(await metrics.render()); } catch (e) { next(e); } });
app.use("/api", limiter, routes);
app.use("/api", (_req, res) => res.status(404).json({ error: "Route not found" }));

// Frontend (static, no build step): served at the site root.
app.use(express.static(path.join(__dirname, "..", "..", "frontend"), { extensions: ["html"], maxAge: 0 }));

app.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details, requestId: req.id });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body", requestId: req.id });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request body too large", requestId: req.id });
  if (err.name === "MulterError") return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: `Upload error: ${err.message}`, requestId: req.id });
  if (isDbDown(err)) { log.error("database unavailable", { requestId: req.id, code: err.code }); return res.status(503).json({ error: "The registry database is unavailable. Please try again shortly.", requestId: req.id }); }
  if (err.code === "23505") return res.status(409).json({ error: "Duplicate record", requestId: req.id });
  if (err.code === "23503" || err.code === "23514" || err.code === "22P02") return res.status(400).json({ error: "Invalid data", requestId: req.id });
  log.error("unhandled error", { requestId: req.id, method: req.method, path: req.path, error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error", requestId: req.id });
});

module.exports = app;
