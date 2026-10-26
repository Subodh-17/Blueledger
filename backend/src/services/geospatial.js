// backend/src/services/geospatial.js — import of field-survey and drone-derived GeoJSON as reviewable evidence.
//
// This is a file import contract, not a drone integration: nothing here talks to a drone or an image-analysis model. A processed product
// (survey points, footprints, tracks) produced elsewhere is uploaded, validated by services/geo.js against the project's boundary,
// stored byte-for-byte with its SHA-256 as evidence of kind GEOSPATIAL, and queued for the same human review as any other evidence.
// Counts found inside the file are shown as an unreviewed summary next to what the collector declared; they never alter measurements.
const db = require("../db");
const audit = require("./audit");
const evidence = require("./evidence");
const geo = require("./geo");
const storage = require("./storage");
const { HttpError, validator } = require("../utils/http");
const C = require("./common");

const SOURCES = ["FIELD_SURVEY", "DRONE_PRODUCT", "OTHER"];
const VALIDATOR_VERSION = "geo-1";

function parse(body) {
  const v = validator();
  const out = {
    projectId: v.num(body, "projectId", { int: true, min: 1 }),
    source: v.str(body, "source", { oneOf: SOURCES }),
    tool: v.str(body, "tool", { optional: true, max: 100 }),
    toolVersion: v.str(body, "toolVersion", { optional: true, max: 50 }),
    recordId: body.recordId ? v.num(body, "recordId", { int: true, min: 1 }) : undefined,
    replacesEvidenceId: body.replacesEvidenceId ? v.num(body, "replacesEvidenceId", { int: true, min: 1 }) : undefined,
  };
  v.done();
  return out;
}

/** Shared by the dry run and the import: access checks, file checks, then the validator against the project's own boundary. */
async function prepare(actor, body, file) {
  const input = parse(body || {});
  if (!file) throw new HttpError(400, "Validation failed", { file: "choose a .geojson file" });
  if (!String(file.originalname || "").toLowerCase().endsWith(".geojson")) throw new HttpError(400, "Validation failed", { file: "the file must have the .geojson extension" });
  if (file.size > geo.LIMITS.maxBytes) throw new HttpError(413, `The file is larger than the ${Math.round(geo.LIMITS.maxBytes / 1048576)} MB limit for geospatial imports`);
  const project = await C.getProject(db, input.projectId);
  C.assertProjectAccess(actor, project);
  const validation = geo.validate(file.buffer, { boundary: project.geometry });
  const sha256 = storage.validate(file.buffer, file.originalname, { allowGeo: true })?.sha256 || null;
  const dup = sha256 ? (await db.query("SELECT code FROM evidence WHERE sha256=$1 AND project_id=$2", [sha256, input.projectId])).rows[0] : null;
  return { input, project, validation, sha256, duplicateOf: dup?.code || null };
}

/** Dry run: reports exactly what an import would find, and stores nothing. */
async function check(actor, body, file) {
  const { input, validation, sha256, duplicateOf } = await prepare(actor, body, file);
  return { projectId: input.projectId, sha256, duplicateOf, validation, wouldImport: validation.valid && !duplicateOf, validatorVersion: VALIDATOR_VERSION };
}

async function importFile(actor, body, file) {
  const { input, project, validation, duplicateOf } = await prepare(actor, body, file);
  if (!validation.valid) throw new HttpError(422, "The file failed validation and was not stored", { validation });
  if (duplicateOf) throw new HttpError(409, `This exact file is already registered as ${duplicateOf} for this project`, { duplicateOf });
  let old = null, recordId = input.recordId;
  if (input.replacesEvidenceId) {
    old = await C.one(db, "SELECT * FROM evidence WHERE id=$1", [input.replacesEvidenceId], "The evidence item to replace was not found");
    if (old.kind !== "GEOSPATIAL" || old.project_id !== input.projectId) throw new HttpError(400, "Validation failed", { replacesEvidenceId: "must be a geospatial import of the same project" });
    if (old.superseded_at) throw new HttpError(409, "That geospatial import was already replaced");
    if (recordId && old.record_id !== recordId) throw new HttpError(400, "Validation failed", { recordId: "must match the record of the import being replaced" });
    recordId = old.record_id || undefined;
  }
  const s = validation.summary;
  const created = await evidence.add(actor, {
    projectId: input.projectId, recordId, captureDate: s.observationDates.last || undefined, crs: "EPSG:4326",
    platform: [input.tool, input.toolVersion].filter(Boolean).join(" ") || undefined, notes: `Geospatial import (${input.source}); ${s.featureCount} feature(s)`,
  }, file, {
    kind: "GEOSPATIAL", allowGeo: true,
    afterInsert: async (c, e) => {
      await c.query(
        `INSERT INTO geospatial_imports (evidence_id, project_id, record_id, imported_by, source, tool, tool_version, validator_version, validation_status, boundary_status,
           boundary_checked, inside_fraction, feature_count, vertex_count, bbox, geometry_types, species_totals, validation_report)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [e.id, input.projectId, recordId || null, actor.id, input.source, input.tool || null, input.toolVersion || null, VALIDATOR_VERSION,
         validation.warnings.length ? "VALID_WITH_WARNINGS" : "VALID", validation.boundary.status, validation.boundary.checked, validation.boundary.insideFraction ?? null,
         s.featureCount, s.vertexCount, s.bbox ? JSON.stringify(s.bbox) : null, JSON.stringify(s.geometryTypes), JSON.stringify(s.speciesTotals),
         JSON.stringify({ warnings: validation.warnings, boundary: validation.boundary, observationDates: s.observationDates, pointCount: s.pointCount, pointsWithoutSpeciesOrCount: s.pointsWithoutSpeciesOrCount })]);
      if (old) {
        await c.query("UPDATE evidence SET supersedes_id=$1 WHERE id=$2", [old.id, e.id]);
        await c.query("UPDATE evidence SET superseded_at=NOW(), verification_status='PENDING' WHERE id=$1", [old.id]);
        await c.query("INSERT INTO evidence_reviews (evidence_id, reviewer_id, decision, notes, content_sha256) VALUES ($1,$2,'SUPERSEDED',$3,$4)", [old.id, actor.id, `Replaced by ${e.code}`, old.sha256]);
        await audit.record(c, { actor, action: "EVIDENCE_REPLACED", entityType: "evidence", entityId: old.id, projectId: old.project_id, recordId: old.record_id, details: { replacedBy: e.code, previousSha256: old.sha256 } });
      }
      await audit.record(c, { actor, action: "GEOSPATIAL_IMPORTED", entityType: "evidence", entityId: e.id, projectId: input.projectId, recordId: recordId || null,
        details: { code: e.code, sha256: e.sha256, source: input.source, tool: input.tool || null, featureCount: s.featureCount, boundaryStatus: validation.boundary.status, boundaryChecked: validation.boundary.checked, warnings: validation.warnings.map((w) => w.code), replaces: old?.code || null } });
    },
  });
  return { evidence: evidence.present(created), validation: { warnings: validation.warnings, summary: s, boundary: validation.boundary }, project: { code: project.code } };
}

const COLS = `g.id, g.evidence_id, e.code AS evidence_code, e.sha256, e.verification_status, e.superseded_at, e.supersedes_id, g.project_id, p.code AS project_code, g.record_id, r.code AS record_code,
  g.source, g.tool, g.tool_version, g.validator_version, g.validation_status, g.boundary_status, g.boundary_checked, g.inside_fraction, g.feature_count, g.vertex_count, g.bbox, g.geometry_types,
  g.species_totals, g.validation_report, g.created_at, u.name AS imported_by_name`;
const FROM = `FROM geospatial_imports g JOIN evidence e ON e.id=g.evidence_id JOIN projects p ON p.id=g.project_id JOIN users u ON u.id=g.imported_by LEFT JOIN monitoring_records r ON r.id=g.record_id`;

async function list(actor, query = {}) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (actor.role === C.ROLES.FIELD) add("p.organization_id=?", actor.organization_id);
  if (query.projectId) add("g.project_id=?", Number(query.projectId) || 0);
  if (query.recordId) add("g.record_id=?", Number(query.recordId) || 0);
  if (query.current !== "0") where.push("e.superseded_at IS NULL");
  const rows = (await db.query(`SELECT ${COLS} ${FROM} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY g.id DESC LIMIT 200`, params)).rows;
  return { imports: rows };
}

/** One import with a comparison of declared and imported species counts, for the reviewer. Differences are information, not errors. */
async function describe(actor, evidenceId) {
  const row = (await db.query(`SELECT ${COLS}, p.organization_id ${FROM} WHERE g.evidence_id=$1`, [evidenceId])).rows[0];
  if (!row) throw new HttpError(404, "No geospatial import for this evidence item");
  C.assertProjectAccess(actor, { organization_id: row.organization_id });
  delete row.organization_id;
  let comparison = null;
  if (row.record_id) {
    const declared = (await db.query("SELECT species_name AS name, planted_count AS count FROM record_species WHERE record_id=$1 ORDER BY lower(species_name)", [row.record_id])).rows;
    const imported = row.species_totals || {}, key = (n) => n.trim().toLowerCase();
    const names = new Map(); for (const d of declared) names.set(key(d.name), d.name); for (const n of Object.keys(imported)) if (!names.has(key(n))) names.set(key(n), n);
    comparison = {
      basis: "Imported counts come from the uploaded file and are unreviewed; declared counts come from the collector's record. Neither is verified by this comparison.",
      rows: [...names].map(([k, name]) => { const d = declared.find((x) => key(x.name) === k)?.count ?? null, i = Object.entries(imported).find(([n]) => key(n) === k)?.[1] ?? null; return { species: name, declared: d, imported: i, differs: d != null && i != null && d !== i, onlyIn: d == null ? "file" : i == null ? "record" : null }; }),
    };
  }
  return { import: row, comparison };
}

module.exports = { check, importFile, list, describe, SOURCES, VALIDATOR_VERSION };
