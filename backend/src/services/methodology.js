// backend/src/services/methodology.js — methodology approval state, project determinations and issuability rules.
const db = require("../db");
const audit = require("./audit");
const defs = require("../methodology/definitions");
const C = require("./common");
const notify = require("./notify");
const { HttpError, validator } = require("../utils/http");

/** Current approval state of a methodology version. A review applies only to the exact parameter set it reviewed. */
async function approvalState(version, c = db) {
  const def = defs.get(version);
  if (!def) return { version, known: false, approved: false, state: "UNKNOWN" };
  if (def.illustrativeOnly) return { version, known: true, approved: false, state: "ILLUSTRATIVE_ONLY", illustrativeOnly: true };
  const hash = defs.parametersHash(def);
  const r = (await c.query("SELECT * FROM methodology_reviews WHERE methodology_version=$1 ORDER BY id DESC LIMIT 1", [version])).rows[0];
  if (!r) return { version, known: true, approved: false, state: "PENDING_REVIEW", parametersHash: hash };
  if (r.decision !== "APPROVED") return { version, known: true, approved: false, state: r.decision, review: r, parametersHash: hash };
  if (r.parameters_hash !== hash) return { version, known: true, approved: false, state: "STALE_REVIEW", review: r, parametersHash: hash, detail: "Parameters changed after the review" };
  return { version, known: true, approved: true, state: "APPROVED", review: r, parametersHash: hash };
}

async function recordReview(actor, version, body) {
  const def = defs.get(version);
  if (!def || def.illustrativeOnly) throw new HttpError(404, "Methodology version not found or not reviewable");
  const v = validator();
  const decision = v.str(body, "decision", { oneOf: ["APPROVED", "REJECTED", "WITHDRAWN"] });
  const reviewerName = v.str(body, "reviewerName", { min: 3, max: 200 });
  const reviewerOrganization = v.str(body, "reviewerOrganization", { min: 3, max: 200 });
  const reviewReference = v.str(body, "reviewReference", { min: 5, max: 500 });
  const reviewDate = v.date(body, "reviewDate");
  const scopeNotes = v.str(body, "scopeNotes", { optional: true, max: 2000 });
  const hash = v.str(body, "parametersHash", { min: 66, max: 66 });
  v.done();
  if (hash !== defs.parametersHash(def)) throw new HttpError(409, "The parameters hash does not match the current parameter set; review the current definition and retry");
  return db.tx(async (c) => {
    const { rows } = await c.query(`INSERT INTO methodology_reviews (methodology_version, parameters_hash, decision, reviewer_name, reviewer_organization, review_reference, review_date, scope_notes, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [version, hash, decision, reviewerName, reviewerOrganization, reviewReference, reviewDate, scopeNotes || null, actor.id]);
    await audit.record(c, { actor, action: "METHODOLOGY_REVIEW_RECORDED", entityType: "methodology", entityId: version, previousStatus: null, newStatus: decision, details: { version, reviewerName, reviewerOrganization, reviewReference, parametersHash: hash } });
    return rows[0];
  });
}

const KINDS = ["BASELINE", "ADDITIONALITY", "LEAKAGE", "NON_PERMANENCE_RISK"];

async function submitDetermination(actor, projectId, body) {
  const v = validator();
  const kind = v.str(body, "kind", { oneOf: KINDS });
  const summary = v.str(body, "summary", { min: 10, max: 4000 });
  const documentReference = v.str(body, "documentReference", { min: 5, max: 500 });
  const bufferPercent = kind === "NON_PERMANENCE_RISK" ? v.num(body, "bufferPercent", { min: 0, max: 99.99 }) : undefined;
  v.done();
  return db.tx(async (c) => {
    const p = await C.getProject(c, projectId, { lock: true });
    const last = (await c.query("SELECT COALESCE(MAX(version),0) AS v FROM project_determinations WHERE project_id=$1 AND kind=$2", [projectId, kind])).rows[0].v;
    await c.query("UPDATE project_determinations SET status='SUPERSEDED' WHERE project_id=$1 AND kind=$2 AND status IN ('SUBMITTED','ACCEPTED')", [projectId, kind]);
    const { rows } = await c.query(`INSERT INTO project_determinations (project_id, kind, version, summary, document_reference, buffer_percent, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [projectId, kind, last + 1, summary, documentReference, bufferPercent ?? null, actor.id]);
    await audit.record(c, { actor, action: "DETERMINATION_SUBMITTED", entityType: "project_determination", entityId: rows[0].id, projectId, newStatus: "SUBMITTED", details: { kind, version: last + 1, documentReference, bufferPercent: bufferPercent ?? null } });
    await notify.toRole(c, "VERIFIER", { type: "DETERMINATION_AWAITING_REVIEW", title: `A ${kind.replaceAll("_", " ").toLowerCase()} determination for ${p.code} needs review`, href: `#/projects/${projectId}`, entityType: "project_determination", entityId: rows[0].id, severity: "ACTION", dedupeKey: `det:${rows[0].id}` });
    return rows[0];
  });
}

async function reviewDetermination(actor, id, body) {
  const v = validator();
  const decision = v.str(body, "decision", { oneOf: ["ACCEPTED", "REJECTED"] });
  const notes = v.str(body, "notes", { min: 5, max: 2000 });
  const org = v.str(body, "reviewerOrganization", { min: 3, max: 200 });
  v.done();
  return db.tx(async (c) => {
    const d = await C.one(c, "SELECT * FROM project_determinations WHERE id=$1 FOR UPDATE", [id], "Determination not found");
    if (d.status !== "SUBMITTED") throw new HttpError(409, `Determination is ${d.status}; only submitted determinations can be reviewed`);
    if (d.submitted_by === actor.id) throw new HttpError(403, "A determination cannot be reviewed by the person who submitted it");
    await c.query("UPDATE project_determinations SET status=$1, reviewed_by=$2, reviewer_organization=$3, reviewed_at=NOW(), review_notes=$4 WHERE id=$5", [decision, actor.id, org, notes, id]);
    await audit.record(c, { actor, action: decision === "ACCEPTED" ? "DETERMINATION_ACCEPTED" : "DETERMINATION_REJECTED", entityType: "project_determination", entityId: id, projectId: d.project_id, previousStatus: "SUBMITTED", newStatus: decision, details: { kind: d.kind, notes } });
    await notify.create(c, [d.submitted_by], { type: `DETERMINATION_${decision}`, title: `Your ${d.kind.replaceAll("_", " ").toLowerCase()} determination was ${decision.toLowerCase()}`, body: notes, href: `#/projects/${d.project_id}`, entityType: "project_determination", entityId: id, dedupeKey: `detrev:${id}` });
    return { ...d, status: decision };
  });
}

async function listDeterminations(projectId, c = db) {
  return (await c.query(`SELECT d.*, s.name AS submitted_by_name, r.name AS reviewed_by_name FROM project_determinations d JOIN users s ON s.id=d.submitted_by LEFT JOIN users r ON r.id=d.reviewed_by WHERE d.project_id=$1 ORDER BY d.kind, d.version DESC`, [projectId])).rows;
}
const acceptedByKind = async (projectId, c = db) => {
  const rows = (await c.query("SELECT DISTINCT ON (kind) * FROM project_determinations WHERE project_id=$1 AND status='ACCEPTED' ORDER BY kind, version DESC", [projectId])).rows;
  return Object.fromEntries(rows.map((r) => [r.kind, r]));
};

/**
 * Can a stored assessment be represented as an issuable quantity right now? Evaluated at approval AND issuance time because
 * reviews and determinations can change after the calculation was made.
 */
async function issuability(calc, project, c = db) {
  const def = defs.get(calc.methodology_version);
  const blockers = [];
  if (!def) blockers.push({ code: "METHODOLOGY_UNKNOWN", detail: `Unknown methodology ${calc.methodology_version}` });
  else if (def.illustrativeOnly) { if (project.data_origin !== "ILLUSTRATIVE") blockers.push({ code: "ILLUSTRATIVE_METHOD_ON_REAL_PROJECT", detail: "The illustrative method may only be used for projects marked illustrative" }); }
  else {
    const st = await approvalState(def.version, c);
    if (!st.approved) blockers.push({ code: "METHODOLOGY_NOT_APPROVED", detail: `Methodology ${def.version} has no valid independent review (state: ${st.state})` });
    const acc = await acceptedByKind(project.id, c);
    for (const k of def.requiredDeterminations) if (!acc[k]) blockers.push({ code: `DETERMINATION_${k}_MISSING`, detail: `No accepted ${k.replaceAll("_", " ").toLowerCase()} determination for this project` });
    if (acc.NON_PERMANENCE_RISK && calc.buffer_percent != null && Number(acc.NON_PERMANENCE_RISK.buffer_percent) !== Number(calc.buffer_percent))
      blockers.push({ code: "BUFFER_CHANGED", detail: "The accepted buffer percentage changed after this assessment was calculated; recalculate" });
    if (calc.methodology_hash && def && calc.methodology_hash !== defs.parametersHash(def)) blockers.push({ code: "METHODOLOGY_PARAMETERS_CHANGED", detail: "The methodology parameters changed after this assessment; recalculate" });
  }
  if (!(calc.eligible_credits >= 1)) blockers.push({ code: "NO_ELIGIBLE_QUANTITY", detail: "The assessment yields fewer than 1 whole tonne" });
  return { ok: blockers.length === 0, blockers };
}

module.exports = { approvalState, recordReview, submitDetermination, reviewDetermination, listDeterminations, acceptedByKind, issuability, KINDS };
