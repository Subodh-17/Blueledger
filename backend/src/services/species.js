// backend/src/services/species.js — planting by species for a monitoring record.
// The list belongs to the collector who owns the record and is editable only while the record is a draft or awaiting revision (also enforced
// by a database trigger). It is a declaration: species names are free text and are not checked against any taxonomy. At submission the list
// is snapshotted into the record, so it is covered by the content hash and the on-chain anchor; earlier lists survive in the audit log.
const db = require("../db");
const audit = require("./audit");
const { HttpError, validator } = require("../utils/http");
const C = require("./common");

const EDITABLE = ["DRAFT", "NEEDS_REVISION"];
const UNITS = ["plants", "seedlings", "propagules", "cuttings"];
const MAX_ROWS = 100;
const norm = (s) => String(s).trim().replace(/\s+/g, " ");

function summarize(rows, record) {
  const total = rows.reduce((n, r) => n + r.planted_count, 0), measured = record?.measurements?.seedlings_planted;
  return {
    species: rows.map((r) => ({ name: r.species_name, plantedCount: r.planted_count, unit: r.unit })), totalPlanted: total,
    measuredSeedlings: measured ?? null,
    // Informational: the measurement and the species list are entered separately; a difference is surfaced to the verifier, not hidden.
    consistentWithMeasurement: rows.length && measured != null ? total === Number(measured) : null,
  };
}

async function get(actor, recordId) {
  const rec = await C.getRecord(db, recordId);
  C.assertProjectAccess(actor, await C.getProject(db, rec.project_id));
  const rows = (await db.query("SELECT * FROM record_species WHERE record_id=$1 ORDER BY lower(btrim(species_name))", [recordId])).rows;
  return { recordId, editable: EDITABLE.includes(rec.status) && rec.submitted_by === actor.id, ...summarize(rows, rec), submittedSnapshot: rec.species_snapshot || null };
}

/** Replace the whole list. Idempotent: sending the same list again changes nothing and still audits only real changes. */
async function set(actor, recordId, body) {
  const v = validator();
  const list = body && body.species;
  if (!Array.isArray(list)) v.errors.species = "must be a list of {name, plantedCount, unit}";
  else if (list.length > MAX_ROWS) v.errors.species = `at most ${MAX_ROWS} species per record`;
  const clean = [], seen = new Set();
  if (Array.isArray(list) && list.length <= MAX_ROWS) list.forEach((s, i) => {
    const sv = validator();
    const name = s && typeof s.name === "string" ? norm(s.name) : "";
    if (!name || name.length > 120) v.errors[`species[${i}].name`] = "required, up to 120 characters";
    const count = s?.plantedCount;
    if (!Number.isInteger(count) || count < 0 || count > 1e7) v.errors[`species[${i}].plantedCount`] = "must be a whole number from 0 to 10,000,000";
    const unit = s?.unit == null ? "plants" : s.unit;
    if (!UNITS.includes(unit)) v.errors[`species[${i}].unit`] = `must be one of: ${UNITS.join(", ")}`;
    if (name && seen.has(name.toLowerCase())) v.errors[`species[${i}].name`] = "each species may appear once";
    seen.add(name.toLowerCase());
    clean.push({ name, count, unit });
  });
  v.done();
  return db.tx(async (c) => {
    const rec = await C.getRecord(c, recordId, { lock: true });
    const project = await C.getProject(c, rec.project_id);
    C.assertProjectAccess(actor, project);
    if (rec.submitted_by !== actor.id) throw new HttpError(403, "Only the record's submitter can edit its species list");
    if (!EDITABLE.includes(rec.status)) throw new HttpError(409, `Record is ${rec.status}; the species list can only be changed while it is a draft or awaiting revision`);
    const before = (await c.query("SELECT species_name AS name, planted_count AS count, unit FROM record_species WHERE record_id=$1 ORDER BY lower(btrim(species_name))", [recordId])).rows;
    const after = clean.map((s) => ({ name: s.name, count: s.count, unit: s.unit })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const same = JSON.stringify(before) === JSON.stringify(after);
    if (!same) {
      await c.query("DELETE FROM record_species WHERE record_id=$1", [recordId]);
      for (const s of clean) await c.query("INSERT INTO record_species (record_id, species_name, planted_count, unit, created_by) VALUES ($1,$2,$3,$4,$5)", [recordId, s.name, s.count, s.unit, actor.id]);
      await audit.record(c, { actor, action: "RECORD_SPECIES_UPDATED", entityType: "monitoring_record", entityId: recordId, projectId: rec.project_id, recordId, previousStatus: rec.status, newStatus: rec.status,
        details: { code: rec.code, before, after } });
    }
    const rows = (await c.query("SELECT * FROM record_species WHERE record_id=$1 ORDER BY lower(btrim(species_name))", [recordId])).rows;
    return { recordId, unchanged: same, ...summarize(rows, rec) };
  });
}

module.exports = { get, set, summarize, UNITS, EDITABLE };
