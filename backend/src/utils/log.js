// backend/src/utils/log.js — structured JSON logging with redaction. Never pass request bodies, headers, tokens or file contents.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = () => LEVELS[process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "error" : "info")] || 20;
const SENSITIVE = /pass(word)?|token|secret|authorization|cookie|private|api[_-]?key|jwt|wrapped|kek|credential/i;
function redact(v, depth = 0) {
  if (v == null || depth > 4) return v;
  if (typeof v === "string") return v.length > 500 ? v.slice(0, 500) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(x, depth + 1)]));
  return v;
}
function write(level, msg, fields) {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields ? redact(fields) : {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}
module.exports = { redact, debug: (m, f) => write("debug", m, f), info: (m, f) => write("info", m, f), warn: (m, f) => write("warn", m, f), error: (m, f) => write("error", m, f) };
