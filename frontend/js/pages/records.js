// Monitoring records: review queue and the record workspace (completeness, evidence checklist, checks, decision, assessment).
import * as geo from "./geo.js";
import { html, raw, badge, label, name, prov, num, fmtDate, fmtTime, table, pager, empty, notice, opts, withQuery, hash, MEASURES, actionLabel, formData } from "../util.js";
import { evidenceCard, evidenceActions, loadThumbs } from "./shared.js";

export async function queue(ctx, seg, query) {
  const r = await ctx.api.get("/records", { pageSize: 15, sort: "submitted", dir: "desc", ...query });
  const p = r.pagination, href = (o) => withQuery("review", { ...query, ...o });
  ctx.form("filters", (f) => ctx.go(withQuery("review", { ...formData(f), page: "" })));
  return {
    title: "Verification workspace", crumbs: [["Overview", "#/overview"], ["Verification workspace"]],
    lede: ctx.can("VERIFIER") ? "Review submitted records and evidence, then verify, reject or request revision." : "Supervise the verification queue. Decisions on records are made by verifiers (separation of duties).",
    body: html`<form class="filters" data-form="filters" data-autosubmit role="search" aria-label="Filter records"><div class="grow"><label for="q">Search</label><input id="q" name="q" type="search" value="${query.q || ""}" placeholder="Record or project code or name"></div>
      <div><label for="status">Status</label><select id="status" name="status">${opts(["SUBMITTED", "UNDER_REVIEW", "VERIFIED", "NEEDS_REVISION", "REJECTED", "DRAFT"].map((x) => [x, label("record", x)]), query.status, "All statuses")}</select></div><div><button type="submit" class="secondary">Apply</button> <a class="btn ghost" href="#/review">Clear</a></div></form>
      ${table({ caption: "Monitoring records", sort: p, sortBase: (k, d) => href({ sort: k, dir: d, page: "" }), heads: [["Record", "code"], ["Project", "project"], ["Activity date", "date"], "Area (ha)", "Evidence", "Submitted by", ["Submitted", "submitted"], ["Status", "status"], "Anchoring"],
        rows: r.records.map((x) => [html`<a href="#/records/${x.id}">${x.code}</a>`, html`${x.project_code}<br><span class="small muted">${x.project_name}</span>`, fmtDate(x.activity_date), num(x.area_ha), x.evidence_count, x.submitted_by_name, fmtDate(x.submitted_at), badge("record", x.status), badge("anchor", x.anchor_status)]),
        empty: empty("No records in this view", "Records appear here after the field team submits them.") })}${pager(p, (n) => href({ page: n }))}`,
  };
}

const txLine = (t) => (t ? html`Transaction ${hash(t.txHash, 8)}${t.blockNumber != null ? ` in block ${t.blockNumber}` : ""}` : "");

export async function detail(ctx, [id]) {
  const d = await ctx.api.get(`/records/${id}`);
  const r = d.record, rep = r.report, isV = ctx.can("VERIFIER"), isField = ctx.can("FIELD_USER");
  const checks = d.liveChecks || d.verifications.at(-1)?.checks || [];
  const blocking = checks.filter((c) => c.blocking && !c.passed), calc = d.calculation;
  evidenceActions(ctx);
  ctx.on("start", async (b) => { await ctx.run(b, () => ctx.api.post(`/records/${id}/start-review`), "Review started"); ctx.refresh(); });
  ctx.on("anchor", async (b) => { await ctx.run(b, () => ctx.api.post(`/records/${id}/anchor`), "Record anchored on-chain"); ctx.refresh(); });
  ctx.on("decide", async (b) => {
    const dec = b.dataset.d, comments = document.getElementById("comments").value.trim();
    const verifying = dec === "VERIFIED";
    if (verifying && blocking.length) { ctx.toast(`Cannot verify: ${blocking.map((c) => c.label).join("; ")}`, "warn"); document.getElementById("checks").scrollIntoView({ behavior: "smooth" }); return; }
    const res = await ctx.confirm({ title: verifying ? `Verify ${r.code}?` : dec === "REJECTED" ? `Reject ${r.code}?` : `Request revision of ${r.code}?`,
      body: html`<p>${verifying ? "You confirm that the evidence has been reviewed and the measurements are complete and consistent." : dec === "REJECTED" ? "Rejection is final for this record. The field team must submit a new record." : "The record returns to the field team for correction and resubmission."}</p><p class="small muted">The decision is written to the blockchain network and the audit log, and cannot be edited afterwards.</p>`,
      confirmLabel: verifying ? "Record verification" : dec === "REJECTED" ? "Reject record" : "Request revision", danger: dec === "REJECTED", reasonLabel: "Comments", reasonRequired: !verifying });
    if (!res.ok) return;
    const out = await ctx.run(b, () => ctx.api.post(`/records/${id}/decision`, { decision: dec, comments: res.reason || comments }));
    ctx.toast(`Decision recorded${out.tx?.blockNumber != null ? ` (confirmed in block ${out.tx.blockNumber})` : ""}`);
    ctx.refresh();
  });
  ctx.on("assess", async (b) => { await ctx.run(b, () => ctx.api.post(`/records/${id}/carbon-estimate`), "Carbon assessment calculated"); ctx.go("#/assessments"); });

  const geoPanel = await geo.recordPanel(ctx, id);
  const m = r.measurements || {};
  return {
    title: html`${r.code} ${badge("record", r.status)}`, crumbs: [["Overview", "#/overview"], isField ? ["Field data", "#/field"] : ["Verification workspace", "#/review"], [r.code]],
    lede: html`${d.project.code} — ${d.project.name} · revision ${r.revision} ${prov(r.data_origin)}`,
    actions: html`${isField && ["DRAFT", "NEEDS_REVISION"].includes(r.status) && r.submitted_by === ctx.user.id ? html`<a class="btn primary" href="#/field/edit/${r.id}">Edit and resubmit</a>` : ""}${isV && r.status === "SUBMITTED" ? html`<button type="button" class="primary" data-action="start">Start review</button>` : ""}${r.anchor_status === "PENDING" && ctx.can("VERIFIER", "NCCR_ADMIN") ? html`<button type="button" class="secondary" data-action="anchor">Retry on-chain anchoring</button>` : ""}`,
    body: html`${r.status === "NEEDS_REVISION" && d.verifications.length ? notice("warn", html`<strong>Revision requested:</strong> ${d.verifications.at(-1).comments}`) : ""}
      ${r.status === "REJECTED" && d.verifications.length ? notice("bad", html`<strong>Rejected:</strong> ${d.verifications.at(-1).comments}`) : ""}
      ${r.anchor_status === "PENDING" && r.status !== "DRAFT" ? notice("warn", "This record has not been anchored on the blockchain network yet. It is stored and will be anchored automatically; review can start once anchoring completes.") : ""}
      <div class="grid g2"><section class="card"><h2>Monitoring record</h2><dl class="kv"><dt>Project</dt><dd><a href="#/projects/${d.project.id}">${d.project.code}</a> ${d.project.name}</dd><dt>Activity</dt><dd>${name("act", r.activity_type)}, ${fmtDate(r.activity_date)}</dd>
        <dt>Submitted by</dt><dd>${r.submitted_by_name}${r.submitted_at ? ` · ${fmtTime(r.submitted_at)}` : ""}</dd><dt>Geotag</dt><dd>${r.latitude != null ? `${Number(r.latitude).toFixed(5)}° N, ${Number(r.longitude).toFixed(5)}° E (accuracy ${r.location_accuracy_m ?? "not stated"} m)` : html`<span class="muted">Missing</span>`}</dd>
        <dt>Area</dt><dd>${num(r.area_ha)} ha</dd>${Object.keys(m).length ? Object.entries(m).map(([k, v]) => html`<dt>${MEASURES[k]?.[0] || name("", k)}</dt><dd>${v} ${MEASURES[k]?.[1] || ""}</dd>`) : html`<dt>Measurements</dt><dd><span class="muted">None recorded</span></dd>`}<dt>Observations</dt><dd>${r.observations || html`<span class="muted">None</span>`}</dd></dl></section>
      <section class="card"><h2>MRV report</h2>${rep ? html`<dl class="kv"><dt>Survival rate</dt><dd>${rep.indicators.survivalRatePct ?? "not measured"}${rep.indicators.survivalRatePct != null ? " %" : ""}</dd><dt>Area share of project</dt><dd>${rep.indicators.areaSharePctOfProject} %</dd><dt>Project age at activity</dt><dd>${rep.indicators.projectAgeYears} years</dd><dt>Distance from project centre</dt><dd>${rep.indicators.distanceFromProjectCentreKm ?? "—"} km</dd><dt>Evidence</dt><dd>${rep.indicators.evidenceCount} item(s): ${rep.indicators.evidenceKinds.map((k) => name("kind", k)).join(", ")}</dd><dt>Generated</dt><dd>${fmtTime(rep.generatedAt)}</dd></dl>` : html`<p class="muted">The report is generated when the record is submitted.</p>`}
        <h3>On-chain anchoring</h3><dl class="kv"><dt>Status</dt><dd>${badge("anchor", r.anchor_status)}</dd><dt>Content hash</dt><dd>${hash(r.content_hash, 12)}</dd><dt>Evidence root</dt><dd>${hash(r.evidence_root, 12)}</dd><dt>Anchor transaction</dt><dd>${hash(r.anchor_tx_hash, 10)}</dd></dl>
        <p class="small muted">The content hash is an integrity identifier for the submitted record. It shows the record has not changed since anchoring; it does not show the measurements are correct.</p></section></div>
      <h2>Evidence checklist</h2>${d.evidence.length ? html`<div class="evgrid">${d.evidence.map((e) => evidenceCard(e, { review: isV && r.status === "UNDER_REVIEW" }))}</div>` : empty("No evidence attached", "A record needs at least one evidence item before it can be verified.")}
      ${geoPanel}
      ${checks.length ? html`<h2 id="checks">Validation checks</h2><section class="card" aria-label="Validation checks">${blocking.length ? html`<p class="notice warn">${blocking.length} blocking check(s) must pass before this record can be verified.</p>` : ""}${checks.map((c) => html`<div class="check ${c.passed ? "pass" : "fail"} ${c.blocking ? "" : "advisory"}"><span class="mark" aria-hidden="true">${c.passed ? "✓" : c.blocking ? "✗" : "!"}</span><div><strong>${c.label}</strong>${c.blocking ? "" : " (advisory)"} <span class="vh">${c.passed ? "passed" : "not passed"}</span><br><span class="small muted">${c.detail}</span></div></div>`)}
        <h3>Methodology requirements</h3><p class="small muted">A record is complete when it has a geotag, a measured survival rate, observations, accepted evidence, an area not exceeding the project area and an activity date within the project period. Missing information is not treated as zero.</p></section>` : ""}
      ${isV && r.status === "UNDER_REVIEW" ? html`<h2>Verifier decision</h2><section class="card"><label for="comments">Comments <span class="opt">(required to reject or request revision)</span></label><textarea id="comments" maxlength="2000"></textarea>
        <p class="flex"><button type="button" class="primary" data-action="decide" data-d="VERIFIED" ${blocking.length ? raw('aria-describedby="checks"') : ""}>Verify record</button><button type="button" class="secondary" data-action="decide" data-d="NEEDS_REVISION">Request revision</button><button type="button" class="danger" data-action="decide" data-d="REJECTED">Reject record</button></p>
        <p class="small muted">Each decision is confirmed, written to the blockchain network and recorded in the audit log with your identity.</p></section>` : ""}
      ${r.status === "VERIFIED" ? html`<h2>Carbon assessment</h2>${d.calculations.length ? table({ caption: "Assessments for this record", heads: ["Version", "Calculated", "Estimated (tCO₂e)", "Eligible (whole tonnes)", "Status"], rows: d.calculations.map((c) => [`${c.assessment_no}${c.is_current ? " (current)" : " (superseded)"}`, fmtTime(c.calculated_at), num(c.estimate_tco2e), c.eligible_credits, badge("assessment", c.approval_status)]) }) : html`<p class="muted">No assessment has been calculated.</p>`}
        ${!d.credit && ctx.can("VERIFIER", "NCCR_ADMIN") ? html`<p><button type="button" class="secondary" data-action="assess">${calc ? "Recalculate assessment" : "Calculate carbon assessment"}</button> <a href="#/assessments">Open carbon assessment</a></p>` : ""}${d.credit ? notice("ok", html`Registry credit batch <a href="#/credits/${d.credit.id}">${d.credit.batch_code}</a>: ${num(d.credit.amount_tonnes, 0)} issued. ${hash(d.credit.tx_hash, 8)}`) : ""}` : ""}
      <h2>Review history</h2>${table({ caption: "Verification decisions", heads: ["When", "Verifier", "Revision", "Decision", "Comments", "Transaction"], rows: d.verifications.map((v) => [fmtTime(v.created_at), v.verifier_name, v.revision, badge("verification", v.decision), v.comments || "—", hash(v.tx_hash, 6)]), empty: empty("No decisions yet", "") })}
      ${ctx.can("NCCR_ADMIN", "VERIFIER") ? html`<h2>Audit events</h2>${table({ caption: "Audit events", heads: ["When", "Actor", "Action", "Status change", "Transaction"], rows: d.audit.map((a) => [fmtTime(a.created_at), `${a.actor_name} (${name("role", a.actor_role)})`, actionLabel(a.action), a.previous_status || a.new_status ? `${a.previous_status || "—"} → ${a.new_status || "—"}` : "—", hash(a.tx_hash, 6)]) })}` : ""}`,
    after: (main) => loadThumbs(ctx, main),
  };
}
