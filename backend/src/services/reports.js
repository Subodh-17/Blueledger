// backend/src/services/reports.js — registry reporting by project, ecosystem, region, reporting month and verification status.
//
// Every figure is computed from persisted rows at request time. The quantities are deliberately NOT merged into one number:
//   observed   — records reported (non-draft) and the area they report
//   verified   — records with a recorded VERIFIED decision and their area
//   estimated  — central / conservative tCO2e from the current assessment of each record (an estimate, not a credit)
//   eligible   — whole tonnes of assessments the NCCR administrator has approved (approved is not issued)
//   issued     — tonnes of registry credits actually issued; retired and outstanding follow from the credit ledger
// Illustrative reference data is never added to user-entered data: data_origin is always a separate output column.
const db = require("../db");
const { HttpError } = require("../utils/http");
const C = require("./common");

const ECOSYSTEMS = ["MANGROVE", "SEAGRASS", "SALT_MARSH"];
const RECORD_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "NEEDS_REVISION", "REJECTED", "VERIFIED"]; // drafts are not reportable
const ORIGINS = ["USER_ENTERED", "ILLUSTRATIVE"];
// Whitelisted grouping dimensions: user input only ever selects a key, it is never placed in SQL.
const DIMENSIONS = {
  project: { key: "p.code", label: "p.name", heading: "Project" },
  ecosystem: { key: "p.ecosystem_type", label: "p.ecosystem_type", heading: "Ecosystem" },
  region: { key: "COALESCE(NULLIF(p.region, ''), 'Unspecified')", label: "COALESCE(NULLIF(p.region, ''), 'Unspecified')", heading: "Region" },
  period: { key: "to_char(date_trunc('month', r.activity_date), 'YYYY-MM')", label: "to_char(date_trunc('month', r.activity_date), 'YYYY-MM')", heading: "Activity month", needsRecords: true },
  status: { key: "r.status", label: "r.status", heading: "Record status", needsRecords: true },
};
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

function parse(query = {}) {
  const groupBy = query.groupBy || "project";
  if (!DIMENSIONS[groupBy]) throw new HttpError(400, `groupBy must be one of: ${Object.keys(DIMENSIONS).join(", ")}`);
  const f = { groupBy };
  for (const k of ["from", "to"]) if (query[k] != null && query[k] !== "") { if (!isDate(query[k])) throw new HttpError(400, `${k} must be a calendar date (YYYY-MM-DD)`); f[k] = query[k]; }
  if (f.from && f.to && f.from > f.to) throw new HttpError(400, "from must not be after to");
  if (query.ecosystem) { if (!ECOSYSTEMS.includes(query.ecosystem)) throw new HttpError(400, `ecosystem must be one of: ${ECOSYSTEMS.join(", ")}`); f.ecosystem = query.ecosystem; }
  if (query.status) { if (!RECORD_STATUSES.includes(query.status)) throw new HttpError(400, `status must be one of: ${RECORD_STATUSES.join(", ")}`); f.status = query.status; }
  if (query.origin) { if (!ORIGINS.includes(query.origin)) throw new HttpError(400, `origin must be one of: ${ORIGINS.join(", ")}`); f.origin = query.origin; }
  if (query.project) { if (!/^[A-Za-z0-9._-]{1,40}$/.test(String(query.project))) throw new HttpError(400, "project must be a project code"); f.project = String(query.project); }
  if (query.region) { if (String(query.region).length > 120) throw new HttpError(400, "region is too long"); f.region = String(query.region); }
  return f;
}

const MAX_ROWS = 500;
const METRICS = `
      COUNT(DISTINCT p.id)::int AS projects,
      COUNT(r.id)::int AS records_reported,
      COUNT(r.id) FILTER (WHERE r.status = 'VERIFIED')::int AS records_verified,
      COUNT(r.id) FILTER (WHERE r.status IN ('SUBMITTED','UNDER_REVIEW'))::int AS records_in_review,
      COUNT(r.id) FILTER (WHERE r.status = 'NEEDS_REVISION')::int AS records_needing_revision,
      COUNT(r.id) FILTER (WHERE r.status = 'REJECTED')::int AS records_rejected,
      COALESCE(SUM(r.area_ha), 0)::float8 AS reported_area_ha,
      COALESCE(SUM(r.area_ha) FILTER (WHERE r.status = 'VERIFIED'), 0)::float8 AS verified_area_ha,
      COALESCE(SUM(c.central_tco2e), 0)::float8 AS estimated_central_tco2e,
      COALESCE(SUM(c.conservative_tco2e), 0)::float8 AS estimated_conservative_tco2e,
      COALESCE(SUM(c.eligible_credits) FILTER (WHERE c.approval_status = 'APPROVED'), 0)::int AS eligible_approved_tonnes,
      COALESCE(SUM(k.issued), 0)::float8 AS issued_tonnes,
      COALESCE(SUM(k.transferred), 0)::float8 AS transferred_tonnes,
      COALESCE(SUM(k.retired), 0)::float8 AS retired_tonnes,
      (COALESCE(SUM(k.issued), 0) - COALESCE(SUM(k.retired), 0))::float8 AS outstanding_tonnes`;
const FROM = `
    FROM projects p
    LEFT JOIN monitoring_records r ON r.project_id = p.id AND r.status <> 'DRAFT'
    LEFT JOIN carbon_calculations c ON c.record_id = r.id AND c.is_current
    LEFT JOIN LATERAL (
      SELECT SUM(k0.amount_tonnes) AS issued, SUM(k0.retired_tonnes) AS retired,
             (SELECT SUM(ev.amount) FROM credit_events ev JOIN carbon_credits k1 ON k1.id = ev.credit_id WHERE k1.record_id = r.id AND ev.event_type = 'TRANSFERRED') AS transferred
      FROM carbon_credits k0 WHERE k0.record_id = r.id) k ON TRUE`;

async function registryReport(actor, query) {
  const f = parse(query), dim = DIMENSIONS[f.groupBy];
  const params = [], where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (actor.role === C.ROLES.FIELD) add("p.organization_id = ?", actor.organization_id); // field users only ever see their own organization
  if (f.ecosystem) add("p.ecosystem_type = ?", f.ecosystem);
  if (f.region) add("COALESCE(NULLIF(p.region, ''), 'Unspecified') = ?", f.region);
  if (f.origin) add("p.data_origin = ?", f.origin);
  if (f.status) add("r.status = ?", f.status);
  if (f.from) add("r.activity_date >= ?", f.from);
  if (f.to) add("r.activity_date <= ?", f.to);
  if (f.project) add("p.code = ?", f.project);
  const needRecords = dim.needsRecords || f.status || f.from || f.to;
  const w = (extra) => { const all = [...where, ...extra]; return all.length ? "WHERE " + all.join(" AND ") : ""; };
  const recWhere = needRecords ? ["r.id IS NOT NULL"] : [];
  const rows = (await db.query(`
    SELECT ${dim.key} AS key, ${dim.label} AS label, p.data_origin, ${METRICS}
    ${FROM} ${w(recWhere)}
    GROUP BY ${dim.key}, ${dim.label}, p.data_origin
    ORDER BY p.data_origin, ${dim.key} LIMIT ${MAX_ROWS + 1}`, params)).rows;
  const truncated = rows.length > MAX_ROWS; if (truncated) rows.length = MAX_ROWS;
  // Totals are computed by the database over the same filters (one row per data origin). Adding the grouped rows would double count
  // projects that appear in several groups (several months or statuses), so the page never sums rows itself.
  const totals = (await db.query(`SELECT p.data_origin, ${METRICS} ${FROM} ${w(recWhere)} GROUP BY p.data_origin ORDER BY p.data_origin`, params)).rows;
  return {
    groupBy: f.groupBy, heading: dim.heading, filters: { ...f, groupBy: undefined }, generatedAt: new Date().toISOString(), rows, totals, truncated, maxRows: MAX_ROWS,
    notes: [
      "Estimated quantities are model outputs under the stated methodology version; they are not verified or issued credits.",
      "Eligible quantities are assessments approved for issuance; only the issued column reflects credits recorded on the ledger.",
      "Transferred is the cumulative tonnes moved between organizations according to the credit ledger (not a balance); outstanding is issued minus retired.",
      "Rows are separated by data origin; illustrative reference data is never added to user-entered data.",
    ],
  };
}

const COLUMNS = ["key", "label", "data_origin", "projects", "records_reported", "records_verified", "records_in_review", "records_needing_revision", "records_rejected",
  "reported_area_ha", "verified_area_ha", "estimated_central_tco2e", "estimated_conservative_tco2e", "eligible_approved_tonnes", "issued_tonnes", "transferred_tonnes", "retired_tonnes", "outstanding_tonnes"];
// Spreadsheet formula injection guard: a text cell that starts with = + - @ tab or CR (including leading whitespace) is prefixed so it is read as text.
const cell = (v) => {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && (/^[=+\-@\t\r]/.test(s) || /^\s+[=+\-@]/.test(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
function toCsv(report) {
  const head = [`# groupBy=${report.groupBy}; generated=${report.generatedAt}; filters=${JSON.stringify(report.filters)}`, ...report.notes.map((n) => `# ${n}`)];
  return [...head, COLUMNS.join(","), ...report.rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

module.exports = { registryReport, toCsv, parse, DIMENSIONS, ECOSYSTEMS, RECORD_STATUSES, ORIGINS };
