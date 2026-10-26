// backend/src/utils/http.js — error type, async wrapper, small validators.
class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Collects validation problems; call .done() to throw a 400 if any. */
function validator() {
  const errors = {};
  const add = (k, m) => { errors[k] = m; };
  const api = {
    errors,
    str(obj, k, { min = 1, max = 500, optional = false, oneOf } = {}) {
      let v = obj[k];
      if (v === undefined || v === null || v === "") { if (!optional) add(k, "required"); return undefined; }
      if (typeof v !== "string") { add(k, "must be a string"); return undefined; }
      v = v.trim();
      if (v.length < min) add(k, `must be at least ${min} characters`);
      else if (v.length > max) add(k, `must be at most ${max} characters`);
      else if (oneOf && !oneOf.includes(v)) add(k, `must be one of ${oneOf.join(", ")}`);
      return v;
    },
    num(obj, k, { min = -Infinity, max = Infinity, optional = false, int = false } = {}) {
      let v = obj[k];
      if (v === undefined || v === null || v === "") { if (!optional) add(k, "required"); return undefined; }
      v = Number(v);
      if (!Number.isFinite(v)) { add(k, "must be a number"); return undefined; }
      if (int && !Number.isInteger(v)) add(k, "must be an integer");
      else if (v < min || v > max) add(k, `must be between ${min} and ${max}`);
      return v;
    },
    date(obj, k, { optional = false, allowFuture = false } = {}) {
      const v = obj[k];
      if (v === undefined || v === null || v === "") { if (!optional) add(k, "required"); return undefined; }
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(Date.parse(v))) { add(k, "must be a date (YYYY-MM-DD)"); return undefined; }
      if (!allowFuture && Date.parse(v) > Date.now() + 86400000) add(k, "cannot be in the future");
      return v.slice(0, 10);
    },
    done() { if (Object.keys(errors).length) throw new HttpError(400, "Validation failed", errors); },
  };
  return api;
}

const intParam = (v, name = "id") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
};

module.exports = { HttpError, wrap, validator, intParam };
