// Field data collection: validated form with units, draft saving, evidence upload with progress, and a local safety copy
// of unsent input so nothing the user entered is silently lost.
import { html, raw, badge, name, num, fmtDate, table, pager, empty, notice, opts, field, withQuery, ACT, UPLOAD_KINDS, MEASURES, bytes, debounce } from "../util.js";

const UNITS = { survival_rate_pct: "%", avg_height_cm: "cm", canopy_cover_pct: "%", seedlings_planted: "count", shoot_density_per_m2: "per m²", sediment_depth_cm: "cm", water_salinity_ppt: "ppt", dissolved_oxygen_mg_l: "mg/L" };
const LIMITS = { survival_rate_pct: [0, 100], avg_height_cm: [0, 3000], canopy_cover_pct: [0, 100], seedlings_planted: [0, 1e8], shoot_density_per_m2: [0, 100000], sediment_depth_cm: [0, 1000], water_salinity_ppt: [0, 60], dissolved_oxygen_mg_l: [0, 30] };
const draftKey = (id) => `bcr_form_${id || "new"}`;

export async function page(ctx, seg, query) {
  if (seg[0] === "new" || seg[0] === "edit") return form(ctx, seg[1]);
  const r = await ctx.api.get("/records", { mine: 1, pageSize: 15, sort: "date", dir: "desc", ...query });
  const href = (n) => withQuery("field", { ...query, page: n });
  ctx.on("submit-existing", async (b) => {
    const c = await ctx.confirm({ title: "Submit this record for verification?", body: "After submission the record can no longer be edited unless a verifier requests a revision.", confirmLabel: "Submit record" });
    if (!c.ok) return;
    const out = await ctx.run(b, () => ctx.api.post(`/records/${b.dataset.id}/submit`));
    ctx.toast(out.record.anchored ? "Record submitted and anchored on the blockchain network" : "Record submitted. On-chain anchoring is pending and will complete automatically.", out.record.anchored ? "" : "warn"); ctx.refresh();
  });
  return {
    title: "Field data", crumbs: [["Overview", "#/overview"], ["Field data"]], lede: "Record restoration activities and monitoring measurements, attach evidence and submit them for verification.",
    actions: html`<a class="btn primary" href="#/field/new">New monitoring record</a>`,
    body: html`${table({ caption: "My monitoring records", heads: ["Record", "Project", "Activity date", "Area (ha)", "Evidence", "Revision", "Status", "Actions"],
      rows: r.records.map((x) => [html`<a href="#/records/${x.id}">${x.code}</a>`, x.project_code, fmtDate(x.activity_date), num(x.area_ha), x.evidence_count, x.revision, badge("record", x.status),
        ["DRAFT", "NEEDS_REVISION"].includes(x.status) ? html`<a class="btn secondary sm" href="#/field/edit/${x.id}">Edit</a> ${x.status === "DRAFT" && x.evidence_count ? html`<button type="button" class="primary sm" data-action="submit-existing" data-id="${x.id}">Submit</button>` : ""}` : ""]),
      empty: empty("No monitoring records yet", "Create a record to start reporting restoration activity.", html`<a class="btn primary" href="#/field/new">New monitoring record</a>`) })}${pager(r.pagination, href)}`,
  };
}

async function form(ctx, id) {
  const [{ projects }, existing] = await Promise.all([ctx.api.get("/projects", { pageSize: 100, status: "ACTIVE" }), id ? ctx.api.get(`/records/${id}`) : null]);
  let rec = existing?.record || null;
  const evidenceList = existing?.evidence || [];
  const stash = JSON.parse(sessionStorage.getItem(draftKey(id)) || "null");
  const v = (k, dflt = "") => (stash && stash[k] != null ? stash[k] : rec && rec[k] != null ? String(rec[k]).slice(0, k === "activity_date" ? 10 : 99) : dflt);
  const mv = (k) => (stash && stash[`m_${k}`] != null ? stash[`m_${k}`] : rec?.measurements?.[k] ?? "");
  const today = new Date().toISOString().slice(0, 10);
  const queued = new Map(); // key -> { file, state }

  const projectOf = (f) => projects.find((p) => String(p.id) === f.elements.projectId.value);
  function validate(f, forSubmit = false) {
    const errs = {}, g = (n) => f.elements[n].value.trim(), num_ = (n) => Number(g(n));
    if (!g("projectId")) errs.projectId = "Select a project.";
    if (!g("activityDate")) errs.activityDate = "Enter the activity date."; else if (g("activityDate") > today) errs.activityDate = "The date cannot be in the future.";
    else if (projectOf(f) && g("activityDate") < String(projectOf(f).start_date).slice(0, 10)) errs.activityDate = `The date cannot be before the project start (${fmtDate(projectOf(f).start_date)}).`;
    if (!g("areaHa") || !(num_("areaHa") > 0)) errs.areaHa = "Enter an area greater than 0 ha."; else if (projectOf(f) && num_("areaHa") > Number(projectOf(f).area_hectares) * 1.05) errs.areaHa = `The area exceeds the project area (${num(projectOf(f).area_hectares)} ha).`;
    if ((g("latitude") === "") !== (g("longitude") === "")) errs[g("latitude") === "" ? "latitude" : "longitude"] = "Provide both latitude and longitude.";
    if (g("latitude") !== "" && (num_("latitude") < -90 || num_("latitude") > 90)) errs.latitude = "Latitude must be between −90 and 90.";
    if (g("longitude") !== "" && (num_("longitude") < -180 || num_("longitude") > 180)) errs.longitude = "Longitude must be between −180 and 180.";
    if (forSubmit) {
      if (g("latitude") === "") errs.latitude = errs.latitude || "Location is required to submit. Use your current location or enter the coordinates.";
      if (g("longitude") === "") errs.longitude = errs.longitude || "Location is required to submit.";
      if (g("observations").length < 10) errs.observations = "Enter at least 10 characters of observations.";
      if (g("m_survival_rate_pct") === "") errs.m_survival_rate_pct = "A survival rate is required to submit. Enter 0 only if the measured survival is zero.";
      if (!evidenceList.length && !queued.size && !g("externalRef")) errs.files = "Attach at least one evidence item (file or reference) to submit.";
    }
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (g(`m_${k}`) !== "" && (Number.isNaN(num_(`m_${k}`)) || num_(`m_${k}`) < lo || num_(`m_${k}`) > hi)) errs[`m_${k}`] = `Enter a value between ${lo} and ${hi}.`;
    return errs;
  }
  function show(f, errs) {
    f.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid")); f.querySelectorAll(".field-error").forEach((el) => (el.textContent = ""));
    for (const [k, msg] of Object.entries(errs)) { const el = f.elements[k], out = f.querySelector(`#${k}-err`); if (out) out.textContent = msg; if (el) { el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-describedby", `${k}-err`); } }
    const first = Object.keys(errs)[0]; if (first) { f.elements[first]?.focus(); ctx.toast(`${Object.keys(errs).length} field(s) need attention.`, "warn"); }
  }
  const body = (f) => {
    const g = (n) => f.elements[n].value.trim(), measurements = {};
    for (const k of Object.keys(LIMITS)) if (g(`m_${k}`) !== "") measurements[k] = Number(g(`m_${k}`));
    return { projectId: Number(g("projectId")), activityType: g("activityType"), activityDate: g("activityDate"), latitude: g("latitude") === "" ? undefined : Number(g("latitude")), longitude: g("longitude") === "" ? undefined : Number(g("longitude")),
      locationAccuracyM: g("locationAccuracyM") === "" ? undefined : Number(g("locationAccuracyM")), areaHa: Number(g("areaHa")), observations: g("observations"), measurements };
  };
  async function uploadAll(f, record) {
    const kind = f.elements.kind.value, list = f.querySelector("#queue");
    const common = (fd) => { fd.append("projectId", record.project_id); fd.append("recordId", record.id); fd.append("kind", kind); fd.append("captureDate", f.elements.activityDate.value); if (f.elements.latitude.value) { fd.append("latitude", f.elements.latitude.value); fd.append("longitude", f.elements.longitude.value); } if (f.elements.platform.value) fd.append("platform", f.elements.platform.value); if (f.elements.altitudeM.value) fd.append("altitudeM", f.elements.altitudeM.value); };
    let failed = 0;
    for (const [key, q] of queued) {
      if (q.state === "done") continue;
      const row = list.querySelector(`[data-q="${CSS.escape(key)}"]`), bar = row.querySelector(".progress>span"), msg = row.querySelector(".qmsg");
      const fd = new FormData(); common(fd); fd.append("file", q.file);
      try { await ctx.api.upload("/evidence", fd, (p) => { bar.style.width = `${p}%`; }); q.state = "done"; bar.style.width = "100%"; msg.textContent = "Uploaded"; }
      catch (e) { if (e.status === 409 && e.details?.duplicateOf) { q.state = "done"; msg.textContent = `Already registered as ${e.details.duplicateOf}; not uploaded again.`; } else { failed++; q.state = "failed"; msg.textContent = `Failed: ${e.message}`; } }
    }
    const ref = f.elements.externalRef.value.trim();
    if (ref) { const fd = new FormData(); common(fd); fd.append("externalRef", ref); try { await ctx.api.upload("/evidence", fd); f.elements.externalRef.value = ""; } catch (e) { failed++; ctx.toast(`Evidence reference not saved: ${e.message}`, "error"); } }
    return failed;
  }
  async function save(f, submit, btn) {
    const errs = validate(f, submit); if (Object.keys(errs).length) return show(f, errs); show(f, {});
    if (submit) {
      const c = await ctx.confirm({ title: "Submit for verification?", body: "After submission the record can no longer be edited unless a verifier requests a revision. A structured report is generated and its hash is anchored on the blockchain network.", confirmLabel: "Submit record" });
      if (!c.ok) return;
    }
    await ctx.run(btn, async () => {
      const b = body(f);
      rec = rec ? (await ctx.api.put(`/records/${rec.id}`, b)).record : (await ctx.api.post("/records", b)).record; // keep the record so a retry updates it instead of creating a duplicate
      const failed = await uploadAll(f, rec);
      if (failed) throw new Error(`${failed} evidence item(s) could not be uploaded. Your data is saved in the draft; fix the problem and try again.`);
      if (submit) { const out = (await ctx.api.post(`/records/${rec.id}/submit`)).record; ctx.toast(out.anchored ? "Record submitted and anchored on the blockchain network" : "Record submitted. On-chain anchoring is pending and will complete automatically.", out.anchored ? "" : "warn"); }
      else ctx.toast("Draft saved");
      sessionStorage.removeItem(draftKey(id));
    });
    ctx.go(`#/records/${rec.id}`);
  }
  ctx.on("draft", (b) => save(b.closest("form"), false, b));
  ctx.on("submit", (b) => save(b.closest("form"), true, b));
  ctx.on("gps", (b) => {
    const f = b.closest("form");
    if (!navigator.geolocation) return ctx.toast("This device does not provide location access. Enter the coordinates manually.", "warn");
    b.disabled = true;
    navigator.geolocation.getCurrentPosition((p) => { f.elements.latitude.value = p.coords.latitude.toFixed(6); f.elements.longitude.value = p.coords.longitude.toFixed(6); f.elements.locationAccuracyM.value = Math.round(p.coords.accuracy); b.disabled = false; ctx.toast("Location captured"); },
      (e) => { b.disabled = false; ctx.toast(`Location could not be read (${e.message}). Enter the coordinates manually.`, "warn"); }, { enableHighAccuracy: true, timeout: 15000 });
  });
  ctx.on("unqueue", (b) => { queued.delete(b.dataset.key); b.closest("[data-q]").remove(); });
  ctx.form("record", (f) => save(f, false, f.querySelector("[data-action=draft]")));

  const selected = rec?.project_id || stash?.projectId || projects[0]?.id;
  return {
    title: rec ? `Edit ${rec.code}` : "New monitoring record", crumbs: [["Overview", "#/overview"], ["Field data", "#/field"], [rec ? rec.code : "New record"]],
    lede: "Fields marked * are required. Measurements are optional unless noted, but a survival rate is needed for verification.",
    body: html`${!navigator.onLine ? notice("warn", "You are offline. Data is sent when you save or submit; there is no offline queue, so reconnect before saving. Your input is kept on this device in the meantime.") : ""}
      ${!projects.length ? notice("warn", "No active projects are assigned to your organization. Ask the registry administrator to assign one.") : ""}
      ${rec?.status === "NEEDS_REVISION" ? notice("warn", html`The verifier requested a revision. Review the comments on <a href="#/records/${rec.id}">the record</a>, update the data or evidence and submit again.`) : ""}
      <form class="card" data-form="record" novalidate id="recform"><fieldset class="plain"><legend>Activity</legend><div class="row">
        ${field({ id: "projectId", label: "Project", required: true, children: html`<select id="projectId" name="projectId" required ${rec ? raw("disabled") : ""}>${projects.map((p) => html`<option value="${p.id}" ${String(p.id) === String(selected) ? raw("selected") : ""}>${p.code} — ${p.name}</option>`)}</select>` })}
        ${field({ id: "activityType", label: "Restoration activity", required: true, children: html`<select id="activityType" name="activityType">${opts(ACT.map((a) => [a, name("act", a)]), v("activityType", rec?.activity_type))}</select>` })}
        ${field({ id: "activityDate", label: "Activity date", required: true, children: html`<input id="activityDate" name="activityDate" type="date" max="${today}" value="${v("activityDate", v("activity_date", today))}" required>` })}</div></fieldset>
      <fieldset><legend>Location</legend><div class="row">
        ${field({ id: "latitude", label: "Latitude", required: true, unit: "° N", help: "Decimal degrees, −90 to 90", children: html`<input id="latitude" name="latitude" type="number" step="any" inputmode="decimal" value="${v("latitude")}">` })}
        ${field({ id: "longitude", label: "Longitude", required: true, unit: "° E", help: "Decimal degrees, −180 to 180", children: html`<input id="longitude" name="longitude" type="number" step="any" inputmode="decimal" value="${v("longitude")}">` })}
        ${field({ id: "locationAccuracyM", label: "Location accuracy", optional: true, unit: "m", children: html`<input id="locationAccuracyM" name="locationAccuracyM" type="number" step="any" min="0" inputmode="decimal" value="${v("locationAccuracyM", v("location_accuracy_m"))}">` })}</div>
        <button type="button" class="secondary" data-action="gps">Use my current location</button><p class="help">Location is required to submit. Accuracy is as reported by the device.</p></fieldset>
      <fieldset><legend>Measurements</legend><div class="row">${field({ id: "areaHa", label: "Area surveyed or restored", required: true, unit: "ha", children: html`<input id="areaHa" name="areaHa" type="number" step="any" min="0.01" inputmode="decimal" value="${v("areaHa", v("area_ha"))}" required>` })}
        ${Object.keys(LIMITS).map((k) => field({ id: `m_${k}`, label: MEASURES[k][0], optional: k !== "survival_rate_pct", required: k === "survival_rate_pct", unit: UNITS[k], help: k === "survival_rate_pct" ? "Required for verification and the carbon assessment. Enter 0 only if the measured survival is zero." : `${LIMITS[k][0]} to ${LIMITS[k][1]}`, children: html`<input id="m_${k}" name="m_${k}" type="number" step="any" inputmode="decimal" value="${mv(k)}">` }))}</div>
        ${field({ id: "observations", label: "Observations", required: true, help: "At least 10 characters. Describe site condition, tidal flow, damage or other relevant notes.", children: html`<textarea id="observations" name="observations" maxlength="4000">${v("observations")}</textarea>` })}</fieldset>
      <fieldset><legend>Evidence</legend>${evidenceList.length ? html`<p class="small">Already attached: ${evidenceList.map((e) => html`<code>${e.code}</code> `)}</p>` : ""}
        <div class="row">${field({ id: "kind", label: "Evidence type", required: true, children: html`<select id="kind" name="kind">${opts(UPLOAD_KINDS.map((k) => [k, name("kind", k)]))}</select>` })}
          ${field({ id: "files", label: "Files", optional: true, help: "JPEG, PNG, WebP, TIFF or PDF, up to 25 MB each. Photos from the camera are supported.", children: html`<input id="files" name="files" type="file" multiple accept="image/jpeg,image/png,image/webp,image/tiff,application/pdf" capture="environment">` })}</div>
        <div id="queue" aria-live="polite"></div>
        <div class="row">${field({ id: "platform", label: "Drone or sensor platform", optional: true, help: "For drone imagery or remote sensing", children: html`<input id="platform" name="platform" maxlength="100">` })}${field({ id: "altitudeM", label: "Flight altitude", optional: true, unit: "m", children: html`<input id="altitudeM" name="altitudeM" type="number" min="0" step="any">` })}
          ${field({ id: "externalRef", label: "Evidence reference", optional: true, help: "Scene or dataset identifier when no file is uploaded (stored as a reference only)", children: html`<input id="externalRef" name="externalRef" maxlength="500">` })}</div></fieldset>
      <p class="flex"><button type="button" class="secondary" data-action="draft">Save draft</button><button type="button" class="primary" data-action="submit">Submit for verification</button><a class="btn ghost" href="#/field">Cancel</a></p></form>`,
    after: (main) => {
      const f = main.querySelector("#recform"); if (!f) return;
      const saveStash = debounce(() => { const o = {}; for (const el of f.elements) if (el.name && el.type !== "file") o[el.name.startsWith("m_") ? el.name : el.name === "projectId" ? "projectId" : el.name] = el.value; sessionStorage.setItem(draftKey(id), JSON.stringify(o)); }, 400);
      f.addEventListener("input", saveStash);
      if (stash) { for (const [k, val] of Object.entries(stash)) if (f.elements[k] && f.elements[k].type !== "file" && !f.elements[k].disabled) f.elements[k].value = val; ctx.toast("Restored your unsent input from this device.", "warn"); }
      f.elements.files.addEventListener("change", () => {
        const list = f.querySelector("#queue");
        for (const file of f.elements.files.files) { const key = `${file.name}:${file.size}`; if (queued.has(key)) continue; queued.set(key, { file, state: "queued" });
          const row = document.createElement("div"); row.dataset.q = key; row.className = "stack"; row.innerHTML = `<div class="section-head"><span>${esc2(file.name)} <span class="muted small">(${bytes(file.size)})</span></span><button type="button" class="ghost sm" data-action="unqueue" data-key="${esc2(key)}" aria-label="Remove ${esc2(file.name)}">Remove</button></div><div class="progress" aria-hidden="true"><span></span></div><div class="qmsg small muted" role="status">Ready to upload when you save</div>`; list.appendChild(row); }
        f.elements.files.value = "";
      });
    },
  };
}
const esc2 = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
