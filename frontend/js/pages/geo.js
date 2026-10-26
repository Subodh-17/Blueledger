// Geospatial evidence import and planting by species.
//   importPanel  — upload a GeoJSON file (field survey or processed drone product), check it without storing, then import it.
//   recordPanel  — on a monitoring record: the species list (editable by its collector while the record is open) and the geospatial imports
//                  attached to it, with a comparison of declared and imported counts for the reviewer.
// The server is the authority: every status shown here comes from the API response, and a failed request is reported as a failure.
import { html, name, num, table, empty, notice, opts, field, fmtTime, hash } from "../util.js";

const SOURCES = [["FIELD_SURVEY", "Field survey (GPS points or tracks)"], ["DRONE_PRODUCT", "Processed drone product (file import)"], ["OTHER", "Other geospatial file"]];
const MAX_MB = 5;
const UNITS = ["plants", "seedlings", "propagules", "cuttings"];
const BOUNDARY = { INSIDE: ["Inside the project boundary", "ok"], PARTIAL: ["Partly inside the project boundary", "warn"], OUTSIDE: ["Outside the project boundary", "bad"], NO_BOUNDARY: ["Not checked: the project has no boundary", "warn"], BOUNDARY_UNUSABLE: ["Not checked: the stored boundary is unusable", "warn"], NOT_APPLICABLE: ["Not applicable", "neutral"] };
const VALIDATION = { VALID: ["Valid", "ok"], VALID_WITH_WARNINGS: ["Valid, with warnings", "warn"] };
const chip = (map, key) => { const [t, tone] = map[key] || [String(key ?? "—").replaceAll("_", " "), "neutral"]; return html`<span class="badge ${tone}">${t}</span>`; };

/** Renders a validator result (from /geospatial/validate, an import response, or the details of a rejected import). */
export function report(v) {
  const errors = v.errors || [], warnings = v.warnings || [], s = v.summary, b = v.boundary;
  const list = (items, cls) => html`<ul class="${cls}">${items.map((x) => html`<li><code>${x.code}</code> ${x.message}${x.path ? html` <span class="small muted">at ${x.path}</span>` : ""}</li>`)}</ul>`;
  const species = s ? Object.entries(s.speciesTotals || {}) : [];
  return html`${errors.length ? notice("bad", html`<strong>The file cannot be imported.</strong> Fix the problems below and try again. Nothing was stored.${list(errors)}`) : warnings.length ? notice("warn", html`<strong>The file can be imported, with warnings.</strong>${list(warnings)}`) : notice("info", html`<strong>The file passed every check.</strong> A passed check means the file is well formed and located where the project is; it does not show that its contents are accurate.`)}
    ${b ? html`<p><strong>Project boundary check:</strong> ${chip(BOUNDARY, b.status)}${b.insideFraction != null ? html` <span class="small muted">${Math.round(b.insideFraction * 100)}% of checked positions inside</span>` : ""}</p>${b.checked === false ? notice("warn", b.message) : ""}` : ""}
    ${s ? html`<dl class="kv"><dt>Features</dt><dd>${num(s.featureCount, 0)}</dd><dt>Geometry types</dt><dd>${Object.entries(s.geometryTypes).map(([k, n]) => `${k} × ${n}`).join(", ") || "—"}</dd><dt>Positions</dt><dd>${num(s.vertexCount, 0)}</dd>
      <dt>Extent (west, south, east, north)</dt><dd>${s.bbox ? s.bbox.join(", ") : "—"}</dd>${s.observationDates?.first ? html`<dt>Observation dates</dt><dd>${s.observationDates.first}${s.observationDates.last !== s.observationDates.first ? ` to ${s.observationDates.last}` : ""}</dd>` : ""}</dl>
      ${species.length ? table({ caption: "Counts found in the file (unreviewed)", heads: ["Species", "Count in file"], rows: species.map(([n, c]) => [n, num(c, 0)]) }) : ""}${species.length ? html`<p class="small muted">These counts come from the uploaded file. They are shown for the reviewer and do not change the record's measurements.</p>` : ""}` : ""}`;
}

/** The import form. Returns markup; registers its handlers on ctx. */
export function importPanel(ctx, { projects, records }) {
  const result = () => document.getElementById("geo-result"), err = () => document.getElementById("geo-error");
  const show = (view) => { result().innerHTML = view.s; result().scrollIntoView?.({ block: "nearest" }); };
  const read = (f) => {
    const d = new FormData(f), file = f.elements.file.files?.[0];
    const problems = {};
    if (!d.get("projectId")) problems.projectId = "Choose the project the file belongs to.";
    if (!file) problems.file = "Choose a .geojson file.";
    else if (!file.name.toLowerCase().endsWith(".geojson")) problems.file = "The file must have the .geojson extension.";
    else if (file.size > MAX_MB * 1048576) problems.file = `The file is larger than ${MAX_MB} MB.`;
    else if (file.size === 0) problems.file = "The file is empty.";
    if (!d.get("source")) problems.source = "Choose where the file comes from.";
    err().textContent = Object.values(problems).join(" ");
    if (Object.keys(problems).length) { (f.elements[Object.keys(problems)[0]] || f.elements.file).focus(); return null; }
    if (file) d.set("file", file); // explicit, so the exact chosen file is what is sent
    if (!d.get("recordId")) d.delete("recordId");
    for (const k of ["tool", "toolVersion"]) if (!String(d.get(k) || "").trim()) d.delete(k);
    return d;
  };
  const send = async (f, btn, path, done) => {
    const form = read(f); if (!form) return;
    btn.disabled = true; btn.setAttribute("aria-busy", "true"); show(notice("info", "Checking the file…"));
    try { done(await ctx.api.upload(path, form)); }
    catch (e) {
      if (e.status === 401) throw e;
      const v = e.details?.validation;
      show(v ? report(v) : notice("bad", html`<strong>${e.network ? "The upload could not be completed." : "The file was not imported."}</strong> ${e.message}`));
    } finally { btn.disabled = false; btn.removeAttribute("aria-busy"); }
  };
  ctx.on("geo-check", (b) => send(b.form, b, "/geospatial/validate", (r) => show(html`${r.duplicateOf ? notice("warn", html`This exact file is already registered as <strong>${r.duplicateOf}</strong>; importing it again would be refused.`) : ""}${report(r.validation)}<p class="small muted">${r.wouldImport ? "This was a check only: nothing has been stored." : "This was a check only: nothing has been stored and the file cannot be imported as it is."}</p>`)));
  ctx.form("geo", (f) => send(f, f.querySelector("button[type=submit]"), "/geospatial/import", (r) => {
    ctx.toast(`Imported as ${r.evidence.code}`);
    show(html`${notice("info", html`<strong>Imported as ${r.evidence.code}.</strong> The original file is stored with content hash ${hash("0x" + r.evidence.sha256, 8)} and is now awaiting review.`)}${report(r.validation)}<p><button type="button" class="secondary sm" data-action="geo-refresh">Refresh the evidence list</button></p>`);
  }));
  ctx.on("geo-refresh", () => ctx.refresh());
  const editable = (records || []).filter((r) => ["DRAFT", "NEEDS_REVISION"].includes(r.status));
  return html`<section class="card" aria-labelledby="geo-h"><h2 id="geo-h">Import a geospatial file</h2>
    <p class="small muted">Upload a GeoJSON file from a field survey or from a processed drone product. This is a file import: no drone is connected and nothing here analyses images. The file is checked against the project's boundary, stored unchanged with its content hash, and then reviewed by a verifier like any other evidence.</p>
    <form data-form="geo" novalidate enctype="multipart/form-data" aria-label="Import a geospatial file">
      <div class="row">${field({ id: "geo-project", label: "Project", required: true, children: html`<select id="geo-project" name="projectId" required>${opts(projects.map((p) => [p.id, `${p.code} — ${p.name}`]), "", "Choose a project")}</select>` })}
        ${field({ id: "geo-record", label: "Attach to record", optional: true, help: "Only records still open for editing are listed.", children: html`<select id="geo-record" name="recordId">${opts(editable.map((r) => [r.id, `${r.code} — ${r.project_code}`]), "", "Not attached to a record")}</select>` })}</div>
      <div class="row">${field({ id: "geo-source", label: "Source of the file", required: true, children: html`<select id="geo-source" name="source">${opts(SOURCES, "FIELD_SURVEY")}</select>` })}
        ${field({ id: "geo-tool", label: "Tool or software", optional: true, children: html`<input id="geo-tool" name="tool" maxlength="100" autocomplete="off">` })}
        ${field({ id: "geo-version", label: "Tool version", optional: true, children: html`<input id="geo-version" name="toolVersion" maxlength="50" autocomplete="off">` })}</div>
      ${field({ id: "geo-file", label: "GeoJSON file (.geojson, up to 5 MB)", required: true, help: "Coordinates must be WGS 84 longitude and latitude, in that order.", children: html`<input id="geo-file" name="file" type="file" accept=".geojson,application/geo+json" required>` })}
      <p class="error small" id="geo-error" role="alert"></p>
      <div class="flex"><button type="button" class="secondary" data-action="geo-check">Check file (nothing is stored)</button><button type="submit" class="primary">Import file</button></div></form>
    <div id="geo-result" aria-live="polite"></div></section>`;
}

const rowsHtml = (rows, start = 0) => rows.map((r, k) => { const i = start + k; return html`<tr><td><label class="vh" for="sp-name-${i}">Species ${i + 1} name</label><input id="sp-name-${i}" name="sp_name" maxlength="120" value="${r.name}" autocomplete="off"></td>
  <td><label class="vh" for="sp-count-${i}">Species ${i + 1} planted count</label><input id="sp-count-${i}" name="sp_count" type="number" min="0" max="10000000" step="1" inputmode="numeric" value="${r.plantedCount ?? ""}"></td>
  <td><label class="vh" for="sp-unit-${i}">Species ${i + 1} unit</label><select id="sp-unit-${i}" name="sp_unit">${opts(UNITS, r.unit || "plants")}</select></td>
  <td><button type="button" class="secondary sm" data-action="sp-remove" aria-label="Remove species row ${i + 1}">Remove</button></td></tr>`; });

/** Species list and geospatial imports of one record. Failures are shown in place and never stop the rest of the page. */
export async function recordPanel(ctx, id) {
  let sp, imports, details = [];
  try {
    [sp, imports] = await Promise.all([ctx.api.get(`/records/${id}/species`), ctx.api.get("/geospatial/imports", { recordId: id })]);
    details = await Promise.all(imports.imports.map((i) => ctx.api.get(`/geospatial/imports/${i.evidence_id}`).catch(() => null)));
  } catch (e) { if (e.status === 401) throw e; return html`<h2>Planting by species and geospatial files</h2>${notice("bad", html`This section could not be loaded: ${e.message}`)}`; }

  ctx.on("sp-add", () => { const tb = document.getElementById("sp-rows"); tb.insertAdjacentHTML("beforeend", rowsHtml([{ name: "", plantedCount: "", unit: "plants" }], tb.rows.length).map((x) => x.s).join("")); tb.rows[tb.rows.length - 1].querySelector("input").focus(); });
  ctx.on("sp-remove", (b) => { b.closest("tr").remove(); });
  ctx.form("species", async (f) => {
    const msg = document.getElementById("sp-error"), tr = [...document.querySelectorAll("#sp-rows tr")];
    const list = tr.map((r) => ({ name: r.querySelector("[name=sp_name]").value.trim(), raw: r.querySelector("[name=sp_count]").value.trim(), unit: r.querySelector("[name=sp_unit]").value })).filter((x) => x.name || x.raw);
    const problems = [], seen = new Set();
    list.forEach((x, i) => {
      if (!x.name) problems.push(`Row ${i + 1}: enter the species name.`);
      else if (seen.has(x.name.toLowerCase().replace(/\s+/g, " "))) problems.push(`Row ${i + 1}: ${x.name} is listed twice.`);
      seen.add(x.name.toLowerCase().replace(/\s+/g, " "));
      if (!/^\d+$/.test(x.raw) || Number(x.raw) > 1e7) problems.push(`Row ${i + 1}: the planted count must be a whole number from 0 to 10,000,000.`);
    });
    msg.textContent = problems.join(" "); if (problems.length) return;
    const btn = f.querySelector("button[type=submit]");
    const out = await ctx.run(btn, () => ctx.api.put(`/records/${id}/species`, { species: list.map((x) => ({ name: x.name, plantedCount: Number(x.raw), unit: x.unit })) }), "Species list saved");
    ctx.refresh();
    return out;
  });

  const note = sp.consistentWithMeasurement === false ? notice("warn", html`The species counts add up to ${num(sp.totalPlanted, 0)}, but the seedlings-planted measurement is ${num(sp.measuredSeedlings, 0)}. The verifier will see this difference.`) : "";
  const form = sp.editable ? html`<form data-form="species" novalidate aria-label="Planting by species">
      <div class="table-wrap"><table><caption class="vh">Species planted</caption><thead><tr><th scope="col">Species</th><th scope="col">Planted count</th><th scope="col">Unit</th><th scope="col"><span class="vh">Actions</span></th></tr></thead><tbody id="sp-rows">${rowsHtml(sp.species.length ? sp.species : [{ name: "", plantedCount: "", unit: "plants" }])}</tbody></table></div>
      <p class="error small" id="sp-error" role="alert"></p><div class="flex"><button type="button" class="secondary" data-action="sp-add">Add species</button><button type="submit" class="primary">Save species list</button></div></form>
      <p class="small muted">Species names are entered as text and are not checked against a taxonomy. The list is locked when the record is submitted.</p>`
    : (sp.species.length ? table({ caption: "Species planted", heads: ["Species", "Planted count", "Unit"], rows: sp.species.map((s) => [s.name, num(s.plantedCount, 0), s.unit]) }) : empty("No species list", "The collector did not record planting by species for this record."));
  const snap = sp.submittedSnapshot ? html`<p class="small muted">Submitted list (covered by the record's content hash): ${sp.submittedSnapshot.map((s) => `${s.name} ${num(s.count, 0)}`).join("; ")}.</p>` : "";
  const cmp = (d) => d?.comparison?.rows.length ? html`${table({ caption: `Declared and imported counts for ${d.import.evidence_code}`, heads: ["Species", "Declared on the record", "In the imported file (unreviewed)", ""], rows: d.comparison.rows.map((r) => [r.species, r.declared ?? "—", r.imported ?? "—", r.differs ? html`<span class="badge warn">Differs</span>` : r.onlyIn ? html`<span class="badge warn">Only in the ${r.onlyIn}</span>` : html`<span class="badge ok">Match</span>`]) })}<p class="small muted">${d.comparison.basis}</p>` : "";
  return html`<h2>Planting by species and geospatial files</h2><div class="grid g2"><section class="card"><h3>Planting by species</h3>${note}${form}${snap}</section>
    <section class="card"><h3>Geospatial imports</h3>${imports.imports.length ? table({ caption: "Geospatial imports attached to this record", heads: ["Evidence", "Source", "Features", "Boundary check", "Validation", "Imported"],
      rows: imports.imports.map((i) => [html`${i.evidence_code}<br>${hash("0x" + i.sha256, 6)}`, html`${name("", i.source)}${i.tool ? html`<br><span class="small muted">${i.tool}${i.tool_version ? ` ${i.tool_version}` : ""}</span>` : ""}`, num(i.feature_count, 0), chip(BOUNDARY, i.boundary_status), chip(VALIDATION, i.validation_status), html`${fmtTime(i.created_at)}<br><span class="small muted">${i.imported_by_name}</span>`]) }) : empty("No geospatial files", "Field survey or processed drone files can be imported from the Evidence repository.")}
      ${details.map(cmp)}</section></div>`;
}
