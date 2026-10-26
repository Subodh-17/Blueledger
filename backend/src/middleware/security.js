// backend/src/middleware/security.js — request ids, in-memory rate limiting and security headers.
// The rate limiter is per process (not shared between instances); put a reverse proxy / gateway in front for production.
const crypto = require("crypto");
const cfg = require("../config");
const { HttpError } = require("../utils/http");

const requestId = (req, res, next) => { req.id = crypto.randomUUID(); res.set("X-Request-Id", req.id); next(); };

const buckets = new Map();
function limiter(req, res, next) {
  const path = req.path;
  const kind = path.startsWith("/auth/") ? "auth" : path === "/evidence" && req.method === "POST" ? "upload" : "api";
  const max = kind === "auth" ? cfg.rateLimit.authMax : kind === "upload" ? cfg.rateLimit.uploadMax : cfg.rateLimit.max;
  const key = `${kind}|${req.ip}`, now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + cfg.rateLimit.windowMs }; buckets.set(key, b); }
  b.n++;
  res.set({ "RateLimit-Limit": String(max), "RateLimit-Remaining": String(Math.max(0, max - b.n)), "RateLimit-Reset": String(Math.ceil((b.reset - now) / 1000)) });
  if (b.n > max) { res.set("Retry-After", String(Math.ceil((b.reset - now) / 1000))); return next(new HttpError(429, "Too many requests. Please wait a moment and try again.")); }
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  next();
}

function headers(_req, res, next) {
  let tileOrigin = "";
  try { if (cfg.map.tileUrl) tileOrigin = " " + new URL(cfg.map.tileUrl.replace(/\{[a-z]\}/g, "x")).origin; } catch { /* invalid tile url: no external images */ }
  res.set({
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(self), camera=(self), microphone=()",
    "Content-Security-Policy": `default-src 'self'; img-src 'self' blob: data:${tileOrigin}; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  });
  if (cfg.isProd) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

const DB_DOWN = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "57P01", "57P03", "08000", "08001", "08003", "08006", "53300"]);
const isDbDown = (e) => DB_DOWN.has(e.code) || /timeout exceeded when trying to connect|Connection terminated|the database system is/i.test(e.message || "");

module.exports = { requestId, limiter, headers, isDbDown };
