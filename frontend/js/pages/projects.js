// Project directory and project detail (full lifecycle: monitoring, evidence, review, assessment, approval, chain record, credits).
import { html, raw, badge, label, name, prov, num, fmtDate, fmtTime, table, pager, empty, notice, opts, field, formData, withQuery, hash, ECO, REST, actionLabel, bytes } from "../util.js";
import { mapView } from "../ui.js";
import { determinations } from "./governance.js";

export async function page(ctx, seg, query) {
  if (seg[0] === "new" && ctx.can("NCCR_ADMIN")) return newProject(ctx);
  if (seg[0]) return detail(ctx, seg[0]);
  const r = await ctx.api.get("/projects", { pageSize: 15, sort: "code", ...query });
  const p = r.pagination, href = (over) => withQuery("projects", { ...query, ...over });
  ctx.form("filters", (f) => ctx.go(withQuery("projects", { ...formData(f), page: "" })));
  const e = query;
  return {
    title: "Project registry", crumbs: [["Overview", "#/overview"], ["Project registry"]], lede: "Registered restoration projects, their verification status and issued credits.",
    actions: ctx.can("NCCR_ADMIN") ? html`<a class="btn primary" href="#/projects/new">Register project</a>` : "",
    body: html`<form class="filters" data-form="filters" data-autosubmit role="search" aria-label="Filter projects"><div class="grow"><label for="q">Search</label><input id="q" name="q" type="search" value="${e.q || ""}" placeholder="Name, code or region"></div>
      <div><label for="ecosystem">Habitat</label><select id="ecosystem" name="ecosystem">${opts(ECO.map((x) => [x, name("eco", x)]), e.ecosystem, "All habitats")}</select></div>
      <div><label for="status">Lifecycle</label><select id="status" name="status">${opts(["ACTIVE", "ON_HOLD", "CLOSED"].map((x) => [x, label("project", x)]), e.status, "All")}</select></div>
      <div><label for="verification">Verification</label><select id="verification" name="verification">${opts(["PENDING", "VERIFIED", "NEEDS_REVISION", "REJECTED"].map((x) => [x, label("verification", x)]), e.verification, "All")}</select></div>
      <div><label for="creditStatus">Credits</label><select id="creditStatus" name="creditStatus">${opts(["NONE", "ELIGIBLE", "APPROVED", "ISSUED"].map((x) => [x, label("creditStage", x)]), e.creditStatus, "All")}</select></div>
      <div><button type="submit" class="secondary">Apply</button> <a class="btn ghost" href="#/projects">Clear</a></div></form>
      ${table({ caption: "Projects", sort: p, sortBase: (k, d) => href({ sort: k, dir: d, page: "" }), heads: [["Code", "code"], ["Project", "name"], "Habitat", ["Area (ha)", "area"], "Lifecycle", "Verification", "Credits", "Last monitoring", ["Updated", "updated"]],
        rows: r.projects.map((x) => [html`<a href="#/projects/${x.id}">${x.code}</a>`, html`<strong>${x.name}</strong><br><span class="small muted">${x.region} · ${x.organization_name}</span> ${prov(x.data_origin)}`, name("eco", x.ecosystem_type), num(x.area_hectares), badge("project", x.status), badge("verification", x.verification_status),
          x.credit_status === "ISSUED" ? html`${num(x.credits_issued, 0)} issued` : badge("creditStage", x.credit_status), fmtDate(x.last_monitoring_date), fmtDate(x.updated_at)]),
        empty: empty("No projects match", "Adjust the filters or clear them to see every project.", html`<a class="btn secondary" href="#/projects">Clear filters</a>`) })}
      ${pager(p, (n) => href({ page: n }))}`,
  };
}

function newProject(ctx) {
  let orgs = [];
  ctx.form("create", async (f) => {
    const d = formData(f); f.querySelectorAll(".field-error").forEach((x) => (x.textContent = ""));
    const r = await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post("/projects", { ...d, organizationId: Number(d.organizationId) }), "Project registered").catch((e) => {
      if (e.details) Object.entries(e.details).forEach(([k, v]) => { const el = f.querySelector(`#${k}-err`); if (el) el.textContent = v; }); throw e; });
    ctx.go(`#/projects/${r.project.id}`);
  });
  return ctx.api.get("/organizations").then(({ organizations }) => ({
    title: "Register project", crumbs: [["Overview", "#/overview"], ["Project registry", "#/projects"], ["Register project"]], lede: "Registered projects can receive monitoring records from the implementing organization.",
    body: html`<form class="card" data-form="create" novalidate><div class="row">${field({ id: "name", label: "Project name", required: true, children: html`<input id="name" name="name" required minlength="3" maxlength="200">` })}
      ${field({ id: "region", label: "Location description", required: true, help: "Place or administrative area", children: html`<input id="region" name="region" required maxlength="255">` })}</div>
      <div class="row">${field({ id: "ecosystemType", label: "Habitat", required: true, children: html`<select id="ecosystemType" name="ecosystemType">${opts(ECO.map((x) => [x, name("eco", x)]))}</select>` })}
      ${field({ id: "restorationType", label: "Restoration approach", required: true, children: html`<select id="restorationType" name="restorationType">${opts(REST.map((x) => [x, name("rest", x)]))}</select>` })}
      ${field({ id: "organizationId", label: "Implementing organization", required: true, children: html`<select id="organizationId" name="organizationId">${organizations.filter((o) => ["NGO", "COMMUNITY", "PANCHAYAT", "RESEARCH"].includes(o.org_type)).map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select>` })}</div>
      <div class="row">${field({ id: "latitude", label: "Latitude", required: true, unit: "° N", help: "−90 to 90", children: html`<input id="latitude" name="latitude" type="number" step="any" min="-90" max="90" required inputmode="decimal">` })}
      ${field({ id: "longitude", label: "Longitude", required: true, unit: "° E", help: "−180 to 180", children: html`<input id="longitude" name="longitude" type="number" step="any" min="-180" max="180" required inputmode="decimal">` })}
      ${field({ id: "areaHectares", label: "Project area", required: true, unit: "ha", children: html`<input id="areaHectares" name="areaHectares" type="number" step="any" min="0.01" required inputmode="decimal">` })}
      ${field({ id: "startDate", label: "Start date", required: true, children: html`<input id="startDate" name="startDate" type="date" required>` })}</div>
      ${field({ id: "description", label: "Description", optional: true, children: html`<textarea id="description" name="description" maxlength="2000"></textarea>` })}
      <p><button type="submit" class="primary">Register project</button> <a class="btn secondary" href="#/projects">Cancel</a></p></form>`,
  }));
}

async function detail(ctx, id) {
  const d = await ctx.api.get(`/projects/${id}`);
  const p = d.project, priv = ctx.can("NCCR_ADMIN", "VERIFIER");
  const credits = await Promise.all(d.credits.map((c) => ctx.api.get(`/credits/${c.id}`).catch(() => null)));
  const events = credits.filter(Boolean).flatMap((x) => x.events.map((e) => ({ ...e, batch: x.credit.batch_code, creditId: x.credit.id })));
  const rec = (rid) => d.records.find((r) => r.id === rid);
  const has = (s) => d.records.some((r) => s.includes(r.status));
  const calcs = d.calculations, curCalcs = calcs.filter((c) => c.is_current);
  const st = (done, active, fail) => (fail ? "fail" : done ? "done" : active ? "active" : "");
  const steps = [
    ["Project registered", "Registered", "done"], ["Monitoring", `${d.records.filter((r) => r.status !== "DRAFT").length} submitted`, st(has(["SUBMITTED", "UNDER_REVIEW", "VERIFIED", "REJECTED", "NEEDS_REVISION"]), has(["DRAFT"]))],
    ["Evidence", `${d.evidence.length} item(s)`, st(d.evidence.length && d.evidence.every((e) => e.verification_status === "VERIFIED"), d.evidence.length)],
    ["Review", has(["UNDER_REVIEW"]) ? "In progress" : has(["SUBMITTED"]) ? "Awaiting" : "—", st(has(["VERIFIED", "REJECTED", "NEEDS_REVISION"]), has(["UNDER_REVIEW", "SUBMITTED"]))],
    ["Verification", label("verification", p.verification_status), st(has(["VERIFIED"]), false, p.verification_status === "REJECTED" && !has(["VERIFIED"]))],
    ["Carbon assessment", curCalcs.length ? `${num(curCalcs.at(-1).estimate_tco2e)} tCO₂e (illustrative estimate)` : "—", st(curCalcs.length, has(["VERIFIED"]))],
    ["Approval", curCalcs.some((c) => c.approval_status === "APPROVED") ? "Approved" : curCalcs.length ? "Awaiting" : "—", st(curCalcs.some((c) => c.approval_status === "APPROVED"), curCalcs.length, curCalcs.some((c) => c.approval_status === "REJECTED"))],
    ["Blockchain record", d.transactions.length ? `${d.transactions.length} transaction(s)` : "—", st(d.transactions.length, false)], ["Credits", d.credits.length ? `${num(d.credits.reduce((a, c) => a + Number(c.amount_tonnes), 0), 0)} issued` : "—", st(d.credits.length, false)],
  ];
  ctx.on("status", async (b) => {
    const to = b.dataset.to, hold = to === "ON_HOLD";
    const r = await ctx.confirm({ title: hold ? "Put project on hold?" : "Reactivate project?", body: hold ? "While on hold, no new records or evidence can be submitted and no credits can be issued for this project." : "The project will accept records and credit issuance again.", confirmLabel: hold ? "Put on hold" : "Reactivate", reasonLabel: "Reason", reasonRequired: hold });
    if (r.ok) { await ctx.run(b, () => ctx.api.patch(`/projects/${id}/status`, { status: to, reason: r.reason }), "Project status updated"); ctx.refresh(); }
  });
  let det;
  try { det = await determinations(ctx, id); } catch (e) { if (e.status === 401) throw e; det = notice("warn", html`Methodology determinations could not be loaded: ${e.message}`); }
  return {
    title: html`${p.name}`, crumbs: [["Overview", "#/overview"], ["Project registry", "#/projects"], [p.code]],
    lede: html`${p.code} · ${name("eco", p.ecosystem_type)} · ${p.region} ${prov(p.data_origin)}`,
    actions: ctx.can("NCCR_ADMIN") ? (p.status === "ACTIVE" ? html`<button type="button" class="secondary" data-action="status" data-to="ON_HOLD">Put on hold</button>` : html`<button type="button" class="secondary" data-action="status" data-to="ACTIVE">Reactivate</button>`) : "",
    body: html`<div class="grid g2"><section class="card"><h2>Project details</h2><dl class="kv"><dt>Habitat</dt><dd>${name("eco", p.ecosystem_type)}</dd><dt>Restoration approach</dt><dd>${name("rest", p.restoration_type)}</dd><dt>Location</dt><dd>${p.region}<br><span class="small muted">${Number(p.latitude).toFixed(5)}° N, ${Number(p.longitude).toFixed(5)}° E</span></dd>
        <dt>Project area</dt><dd>${num(p.area_hectares)} ha</dd><dt>Start date</dt><dd>${fmtDate(p.start_date)}</dd><dt>Implementer</dt><dd>${p.organization_name} (${name("org", p.org_type)})</dd><dt>Lifecycle</dt><dd>${badge("project", p.status)}</dd>
        <dt>Verification</dt><dd>${badge("verification", p.verification_status)}</dd><dt>Credits</dt><dd>${badge("creditStage", p.credit_status)}</dd>
        <dt>Latest estimate</dt><dd>${p.latest_estimate_tco2e == null ? "—" : html`${num(p.latest_estimate_tco2e)} tCO₂e <span class="small muted">(illustrative estimate, not an approved quantity)</span>`}</dd>
        <dt>On-chain registration</dt><dd>${p.chain_registered ? html`${badge("tx", "CONFIRMED")} ${hash(p.chain_register_tx, 6)}` : html`${badge("tx", "NOT_SUBMITTED")} <span class="small muted">occurs when the first record is anchored</span>`}</dd></dl>
        ${p.description ? html`<p>${p.description}</p>` : ""}</section>
      <section class="card"><h2>Geographic context</h2>${mapView({ points: [{ lat: Number(p.latitude), lon: Number(p.longitude), label: p.name }], polygon: p.geometry?.coordinates?.[0], tileUrl: ctx.config.map.tileUrl, attribution: ctx.config.map.attribution, label: `Map showing ${p.name}` })}</section></div>
    <h2>Lifecycle</h2><ol class="steps">${steps.map(([l, v, c]) => html`<li class="${c}"><b>${l}</b>${v}</li>`)}</ol>
    <h2>Monitoring records</h2>${table({ caption: "Monitoring records", heads: ["Record", "Activity date", "Activity", "Area (ha)", "Revision", "Status", "Anchoring", "Submitted by"],
      rows: d.records.map((r) => [html`<a href="#/records/${r.id}">${r.code}</a>`, fmtDate(r.activity_date), name("act", r.activity_type), num(r.area_ha), r.revision, badge("record", r.status), badge("anchor", r.anchor_status), r.submitted_by_name]), empty: empty("No monitoring records", "Records submitted by the implementing organization appear here.") })}
    <h2>Evidence attachments</h2>${table({ caption: "Evidence attachments", heads: ["Evidence", "Type", "Record", "Captured", "Content hash (SHA-256)", "Review"], rows: d.evidence.map((e) => [e.code, name("kind", e.kind), rec(e.record_id)?.code || "—", fmtDate(e.captured_at), e.sha256 ? hash("0x" + e.sha256, 8) : html`<span class="muted">reference only</span>`, badge("evidence", e.verification_status)]), empty: empty("No evidence", "Photographs, drone imagery and references appear here.") })}
    <h2>Review and verification history</h2>${table({ caption: "Verification decisions", heads: ["When", "Record", "Revision", "Verifier", "Decision", "Comments", "Transaction"], rows: d.verifications.map((v) => [fmtTime(v.created_at), rec(v.record_id)?.code, v.revision, v.verifier_name, badge("verification", v.decision), v.comments || "—", hash(v.tx_hash, 6)]), empty: empty("No verification decisions", "Decisions made by verifiers are recorded here and written on-chain.") })}
    <h2>Carbon assessments</h2>${table({ caption: "Carbon assessments", heads: ["Assessed", "Record", "Version", "Method", "Estimated (tCO₂e)", "Range", "Eligible (whole tonnes)", "Status"], rows: calcs.map((c) => [fmtTime(c.calculated_at), rec(c.record_id)?.code, `${c.assessment_no}${c.is_current ? "" : " (superseded)"}`, c.methodology_version, num(c.estimate_tco2e), `${num(c.low_tco2e)} – ${num(c.high_tco2e)}`, c.eligible_credits, badge("assessment", c.approval_status)]), empty: empty("No assessments", "An assessment is calculated after a record is verified.") })}
    ${det}
    <h2>Credit issuance, transfer and retirement</h2>${events.length ? table({ caption: "Credit events", heads: ["When", "Batch", "Event", "From", "To", "Quantity", "Reason", "Transaction"], rows: events.map((e) => [fmtTime(e.created_at), html`<a href="#/credits/${e.creditId}">${e.batch}</a>`, ({ ISSUED: "Issued", TRANSFERRED: "Transferred", RETIRED: "Retired" })[e.event_type], e.from_org || "—", e.to_org || "—", num(e.amount, 0), e.reason || "—", hash(e.tx_hash, 6)]) }) : empty("No credits issued", "Issuance, transfers and retirements appear here.")}
    <h2>Blockchain transactions</h2>${table({ caption: "Blockchain transactions", heads: ["When", "Type", "Detail", "Block", "Status", "Transaction hash"], rows: d.transactions.map((t) => [fmtTime(t.created_at), name("tx", t.tx_type), t.detail, t.block_num, badge("tx", t.status), hash(t.tx_hash, 8)]), empty: empty("No blockchain activity", "Anchoring, verification and issuance transactions appear here.") })}
    ${priv ? html`<h2>Audit events</h2>${table({ caption: "Audit events", heads: ["When", "Actor", "Action", "Status change", "Transaction"], rows: d.audit.map((a) => [fmtTime(a.created_at), `${a.actor_name} (${name("role", a.actor_role)})`, actionLabel(a.action), a.previous_status || a.new_status ? `${a.previous_status || "—"} → ${a.new_status || "—"}` : "—", hash(a.tx_hash, 6)]), empty: empty("No audit events", "") })}` : ""}`,
  };
}
