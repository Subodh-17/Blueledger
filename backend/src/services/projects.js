// backend/src/services/projects.js — project registry (Module 1).
const db = require("../db");
const audit = require("./audit");
const ops = require("./chainOps");
require("./chainHandlers");
const { HttpError, validator } = require("../utils/http");
const { hashJSON } = require("../utils/hash");
const page = require("../utils/page");
const defs = require("../methodology/definitions");
const methodology = require("./methodology");
const { like } = page;
const C = require("./common");

const ECOSYSTEMS = ["MANGROVE", "SEAGRASS", "SALT_MARSH"];
const RESTORATION_TYPES = ["MANGROVE_PLANTATION", "HYDROLOGICAL_RESTORATION", "SEAGRASS_TRANSPLANT", "SALT_MARSH_REVEGETATION", "NATURAL_REGENERATION_PROTECTION"];
const ORG_TYPES = ["REGULATOR", "NGO", "COMMUNITY", "PANCHAYAT", "RESEARCH", "VERIFICATION_BODY", "CREDIT_HOLDER"];

const PROJECT_COLS = `p.*, o.name AS organization_name, o.org_type,
  (SELECT COUNT(*) FROM monitoring_records r WHERE r.project_id=p.id)::int AS record_count,
  (SELECT COALESCE(SUM(c.amount_tonnes),0) FROM carbon_credits c WHERE c.project_id=p.id)::float AS credits_issued,
  (SELECT MAX(r.activity_date) FROM monitoring_records r WHERE r.project_id=p.id AND r.status <> 'DRAFT') AS last_monitoring_date`;
const PROJECT_FROM = "FROM projects p LEFT JOIN organizations o ON o.id=p.organization_id";
const PROJECT_SELECT = `SELECT ${PROJECT_COLS} ${PROJECT_FROM}`;
const SORTS = { code: { sql: "p.code", dir: "ASC" }, name: { sql: "lower(p.name)", dir: "ASC" }, area: { sql: "p.area_hectares" }, updated: { sql: "p.updated_at" }, created: { sql: "p.created_at" }, issued: { sql: "credits_issued" } };

async function create(actor, body) {
  const v = validator();
  const name = v.str(body, "name", { min: 3, max: 200 });
  const description = v.str(body, "description", { optional: true, max: 2000 });
  const ecosystemType = v.str(body, "ecosystemType", { oneOf: ECOSYSTEMS });
  const restorationType = v.str(body, "restorationType", { oneOf: RESTORATION_TYPES });
  const region = v.str(body, "region", { max: 255 });
  const latitude = v.num(body, "latitude", { min: -90, max: 90 });
  const longitude = v.num(body, "longitude", { min: -180, max: 180 });
  const areaHectares = v.num(body, "areaHectares", { min: 0.01, max: 1000000 });
  const startDate = v.date(body, "startDate", { allowFuture: false });
  const organizationId = v.num(body, "organizationId", { int: true, min: 1 });
  const dataOrigin = body.dataOrigin === "ILLUSTRATIVE" ? "ILLUSTRATIVE" : "USER_ENTERED";
  const climateRegion = v.str(body, "climateRegion", { optional: true, oneOf: ["TROPICAL_WET", "TROPICAL_DRY", "SUBTROPICAL", "OTHER"] });
  const revegetationMethod = v.str(body, "revegetationMethod", { optional: true, oneOf: ["PLANTED", "NATURAL_RECOLONISATION"] });
  const methodologyVersion = body.methodologyVersion || (dataOrigin === "ILLUSTRATIVE" ? defs.DEFAULT_ILLUSTRATIVE : defs.DEFAULT_REAL);
  const mdef = defs.get(methodologyVersion);
  if (!mdef) v.errors.methodologyVersion = "unknown methodology version";
  else if (mdef.illustrativeOnly && dataOrigin !== "ILLUSTRATIVE") v.errors.methodologyVersion = "the illustrative method can only be used for projects marked illustrative";
  else if (!mdef.illustrativeOnly) {
    if (!revegetationMethod) v.errors.revegetationMethod = "required for this methodology (planted or natural recolonisation)";
    if (ecosystemType === "MANGROVE" && !["TROPICAL_WET", "TROPICAL_DRY", "SUBTROPICAL"].includes(climateRegion)) v.errors.climateRegion = "required for mangrove projects (tropical wet, tropical dry or subtropical)";
  }
  let geometry = null;
  if (body.geometry != null) {
    const g = body.geometry;
    if (g.type !== "Polygon" || !Array.isArray(g.coordinates) || !Array.isArray(g.coordinates[0]) || g.coordinates[0].length < 4) v.errors.geometry = "must be a GeoJSON Polygon";
    else geometry = g;
  }
  v.done();

  return db.tx(async (c) => {
    const org = await C.fromPg(c, "SELECT id FROM organizations WHERE id=$1", [organizationId]);
    if (!org.length) throw new HttpError(400, "Unknown organization", { organizationId: "not found" });
    const { rows } = await c.query(
      `INSERT INTO projects (owner_id, organization_id, name, description, region, location_text, latitude, longitude, area_hectares,
         ecosystem_type, restoration_type, start_date, geometry, data_origin, climate_region, revegetation_method, methodology_version)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [actor.id, organizationId, name, description || null, region, latitude, longitude, areaHectares, ecosystemType, restorationType, startDate, geometry, dataOrigin, climateRegion || null, revegetationMethod || null, methodologyVersion]);
    const p = rows[0];
    const code = body.code && /^[A-Z0-9-]{4,40}$/.test(body.code) ? body.code : `BCP-${C.pad(p.id, 4)}`;
    await c.query("UPDATE projects SET code=$1 WHERE id=$2", [code, p.id]);
    p.code = code;
    await audit.record(c, { actor, action: "PROJECT_CREATED", entityType: "project", entityId: p.id, projectId: p.id, newStatus: "ACTIVE",
      details: { code, name, ecosystemType, areaHectares, organizationId } });
    return p;
  });
}

async function list(actor, query = {}) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (actor.role === C.ROLES.FIELD) add("p.organization_id=?", actor.organization_id);
  if (query.q) add("(p.name ILIKE ? OR p.code ILIKE ? OR p.region ILIKE ?)".replaceAll("?", `$${params.length + 1}`), like(query.q));
  if (ECOSYSTEMS.includes(query.ecosystem)) add("p.ecosystem_type=?", query.ecosystem);
  if (["ACTIVE", "ON_HOLD", "CLOSED"].includes(query.status)) add("p.status=?", query.status);
  if (["PENDING", "VERIFIED", "REJECTED", "NEEDS_REVISION"].includes(query.verification)) add("p.verification_status=?", query.verification);
  if (["NONE", "ELIGIBLE", "APPROVED", "ISSUED"].includes(query.creditStatus)) add("p.credit_status=?", query.creditStatus);
  if (Number(query.organizationId) > 0) add("p.organization_id=?", Number(query.organizationId));
  const pg = page.parse(query, SORTS, "code", "p.id");
  const r = await page.run({ select: `SELECT ${PROJECT_COLS}`, from: PROJECT_FROM, where, params }, pg);
  return { projects: r.rows, pagination: r.pagination };
}

/** Full lifecycle view of one project: PROJECT -> MONITORING -> EVIDENCE -> MRV -> VERIFICATION -> ESTIMATE -> APPROVAL -> CHAIN -> CREDIT */
async function detail(actor, id) {
  const p = (await db.query(`${PROJECT_SELECT} WHERE p.id=$1`, [id])).rows[0];
  if (!p) throw new HttpError(404, "Project not found");
  C.assertProjectAccess(actor, p);
  const q = async (sql) => (await db.query(sql, [id])).rows;
  const [records, evidence, verifications, calculations, credits, transactions, auditRows] = await Promise.all([
    q(`SELECT r.*, u.name AS submitted_by_name FROM monitoring_records r JOIN users u ON u.id=r.submitted_by WHERE r.project_id=$1 ORDER BY r.id`),
    q(`SELECT e.id, e.code, e.record_id, e.kind, e.captured_at, e.latitude, e.longitude, e.sha256, e.ipfs_cid, e.processing_status, e.verification_status,
         e.ipfs_status, e.filename, e.data_origin, e.external_ref FROM evidence e WHERE e.project_id=$1 ORDER BY e.id`),
    q(`SELECT v.*, u.name AS verifier_name FROM verification_records v JOIN users u ON u.id=v.verifier_id JOIN monitoring_records r ON r.id=v.record_id WHERE r.project_id=$1 ORDER BY v.id`),
    q(`SELECT * FROM carbon_calculations WHERE project_id=$1 ORDER BY id`),
    q(`SELECT * FROM carbon_credits WHERE project_id=$1 ORDER BY id`),
    q(`SELECT * FROM blockchain_transactions WHERE project_id=$1 ORDER BY id`),
    q(`SELECT * FROM audit_logs WHERE project_id=$1 ORDER BY id`),
  ]);
  const [determinations, methodologyState] = [await methodology.listDeterminations(id), await methodology.approvalState(p.methodology_version || (p.data_origin === "ILLUSTRATIVE" ? defs.DEFAULT_ILLUSTRATIVE : defs.DEFAULT_REAL))];
  return { project: p, records, evidence, verifications, calculations, credits, transactions, audit: auditRows, determinations, methodology: methodologyState };
}

async function setStatus(actor, id, status, reason) {
  if (!["ACTIVE", "ON_HOLD", "CLOSED"].includes(status)) throw new HttpError(400, "Invalid status");
  return db.tx(async (c) => {
    const p = await C.getProject(c, id, { lock: true });
    if (p.status === status) return p;
    await c.query("UPDATE projects SET status=$1, updated_at=NOW() WHERE id=$2", [status, id]);
    await audit.record(c, { actor, action: "PROJECT_STATUS_CHANGED", entityType: "project", entityId: id, projectId: id,
      previousStatus: p.status, newStatus: status, details: { reason: reason || null } });
    return { ...p, status };
  });
}

/** Register the project on-chain if needed (durable, idempotent operation). */
async function ensureChainRegistered(actor, projectId) {
  const p = await C.getProject(db, projectId);
  if (p.chain_registered) return p;
  await ops.run("PROJECT_REGISTER", `register:${p.uuid}`, { projectId }, { actor, projectId });
  return C.getProject(db, projectId);
}

module.exports = { create, list, detail, setStatus, ensureChainRegistered, ECOSYSTEMS, RESTORATION_TYPES, ORG_TYPES };
