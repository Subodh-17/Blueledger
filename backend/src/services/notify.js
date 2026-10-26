// backend/src/services/notify.js — notifications are created inside the same database transaction as the event they describe,
// so a notification exists if and only if the persisted event does. They are never created by UI actions.
const db = require("../db");

const usersWithRole = async (c, role) => (await c.query("SELECT id FROM users WHERE role=$1 AND is_active", [role])).rows.map((r) => r.id);
const usersInOrg = async (c, orgId, role) => (await c.query(`SELECT id FROM users WHERE organization_id=$1 AND is_active ${role ? "AND role=$2" : ""}`, role ? [orgId, role] : [orgId])).rows.map((r) => r.id);

/** @param users array of user ids (duplicates and nulls ignored). dedupeKey makes repeated conditions notify once per user. */
async function create(c, users, { type, title, body, href, entityType, entityId, severity = "INFO", dedupeKey }) {
  const ids = [...new Set((users || []).filter(Boolean))];
  for (const uid of ids)
    await c.query(`INSERT INTO notifications (user_id, type, title, body, href, entity_type, entity_id, severity, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [uid, type, title.slice(0, 200), body || null, href || null, entityType || null, entityId != null ? String(entityId) : null, severity, dedupeKey || null]);
  return ids.length;
}
const toRole = async (c, role, n) => create(c, await usersWithRole(c, role), n);
const toOrg = async (c, orgId, n, role) => create(c, await usersInOrg(c, orgId, role), n);

async function list(user, { unread, page = 1, pageSize = 20 } = {}) {
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20)), off = (Math.max(1, Number(page) || 1) - 1) * size;
  const where = `user_id=$1 ${unread ? "AND read_at IS NULL" : ""}`;
  const total = Number((await db.query(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`, [user.id])).rows[0].n);
  const rows = (await db.query(`SELECT id, type, title, body, href, severity, entity_type, entity_id, created_at, read_at FROM notifications WHERE ${where} ORDER BY id DESC LIMIT ${size} OFFSET ${off}`, [user.id])).rows;
  const unreadCount = Number((await db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [user.id])).rows[0].n);
  return { notifications: rows, unread: unreadCount, pagination: { page: Number(page) || 1, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) } };
}
async function markRead(user, { ids, all }) {
  if (all) return (await db.query("UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL", [user.id])).rowCount;
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  return list.length ? (await db.query("UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND id = ANY($2::bigint[]) AND read_at IS NULL", [user.id, list])).rowCount : 0;
}
module.exports = { create, toRole, toOrg, usersWithRole, usersInOrg, list, markRead };
