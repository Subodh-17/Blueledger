// backend/src/utils/page.js — safe pagination, sorting and search for list endpoints.
const db = require("../db");

/** Parse ?page, ?pageSize, ?sort, ?dir against a whitelist of sortable SQL expressions; tiebreak keeps pages stable. */
function parse(query, sorts, defaultSort, tiebreak) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25));
  const key = Object.prototype.hasOwnProperty.call(sorts, query.sort) ? query.sort : defaultSort;
  const d = String(query.dir || "").toLowerCase();
  const dir = d === "asc" ? "ASC" : d === "desc" ? "DESC" : (sorts[key].dir || "DESC");
  return { page, pageSize, orderBy: `${sorts[key].sql} ${dir}, ${tiebreak} ${dir}`, sort: key, dir: dir.toLowerCase() };
}

/**
 * @param select  "SELECT ... " (no FROM)
 * @param from    "FROM ... JOIN ..."
 * @param where   array of SQL fragments using $n placeholders aligned with params
 */
async function run({ select, from, where = [], params = [], countSelect = "COUNT(*)" }, p) {
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((await db.query(`SELECT ${countSelect} AS n ${from} ${w}`, params)).rows[0].n);
  const { rows } = await db.query(`${select} ${from} ${w} ORDER BY ${p.orderBy} LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`, params);
  return { rows, pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)), sort: p.sort, dir: p.dir } };
}

/** Escape LIKE wildcards in user-supplied search text. */
const like = (q) => `%${String(q).trim().slice(0, 100).replace(/[\\%_]/g, (c) => "\\" + c)}%`;

module.exports = { parse, run, like };
