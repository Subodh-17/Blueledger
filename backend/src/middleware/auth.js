// backend/src/middleware/auth.js — JWT authentication + role guards.
// Roles: FIELD_USER, VERIFIER, NCCR_ADMIN. Unauthenticated callers are the PUBLIC / VIEWER role.
const jwt = require("jsonwebtoken");
const db = require("../db");
const { jwtSecret } = require("../config");
const { HttpError, wrap } = require("../utils/http");

const authenticate = wrap(async (req, _res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  let payload;
  try { payload = jwt.verify(h.slice(7), jwtSecret); } catch { throw new HttpError(401, "Invalid or expired token"); }
  // Re-read the user so deactivated accounts and role changes take effect immediately.
  const { rows } = await db.query(
    "SELECT id, name, email, role, organization_id, wallet_address, is_active, token_version FROM users WHERE id=$1", [payload.id]);
  const u = rows[0];
  if (!u || !u.is_active) throw new HttpError(401, "Account not found or deactivated");
  if ((payload.tv ?? 0) !== u.token_version) throw new HttpError(401, "Session has been revoked; sign in again");
  req.user = u;
  next();
});

const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(new HttpError(403, `Access denied. Required role: ${roles.join(" or ")}`));

const sign = (u) => jwt.sign({ id: u.id, role: u.role, tv: u.token_version ?? 0 }, jwtSecret, { expiresIn: require("../config").jwtExpiresIn });

module.exports = { authenticate, requireRole, sign };
