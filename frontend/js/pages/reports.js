// Registry reports: aggregated, filterable view of GET /api/reports/registry with CSV download.
// Every figure comes from the server response; totals are the ones the server computed (never a client-side sum), and rows are
// kept separate by data origin so illustrative sample data is never added to user-entered data.
import { html, badge, name, num, table, empty, notice, opts, field, withQuery, formData, label } from "../util.js";

const GROUPS = [["project", "Project"], ["ecosystem", "Ecosystem"], ["region", "Region"], ["period", "Activity month"], ["status", "Record status"]];
const STATUSES = ["SUBMITTED", "UNDER_REVIEW", "NEEDS_REVISION", "REJECTED", "VERIFIED"];
const ECOS = ["MANGROVE", "SEAGRASS", "SALT_MARSH"];
const FILTERS = ["groupBy", "project", "ecosystem", "region", "status", "origin", "from", "to"];
const t = (v, d = 2) => num(v, d);

const DEFINITIONS = [
  ["Reported records", "Monitoring records that have been submitted (drafts are never counted)."],
  ["Verified records", "Records with a recorded verifier decision of verified. This is a decision about the evidence, not a quantity of carbon."],
  ["Reported / verified area", "Hectares stated on those records. Verified area covers only verified records."],
  ["Estimated (central, conservative)", "Model output for each record's current assessment under its stated methodology version. An estimate is not a verified or issued credit, and may rest on unreviewed parameters."],
  ["Approved eligible", "Whole tonnes of assessments an NCCR administrator has approved for issuance. Approved is not issued."],
  ["Issued", "Registry credits actually issued and recorded on the ledger."],
  ["Transferred", "Cumulative tonnes moved between organizations according to the ledger. This is movement, not a balance."],
  ["Retired", "Tonnes permanently retired."],
  ["Outstanding", "Issued minus retired."],
];

/** The response is checked before anything is drawn, so a malformed reply produces an error rather than misleading numbers. */
function wellFormed(r) {
  const ok = (x) => x && typeof x === "object" && typeof x.data_origin === "string";
  const numeric = ["projects", "records_reported", "records_verified", "reported_area_ha", "verified_area_ha", "estimated_central_tco2e", "estimated_conservative_tco2e", "eligible_approved_tonnes", "issued_tonnes", "transferred_tonnes", "retired_tonnes", "outstanding_tonnes"];
  return r && Array.isArray(r.rows) && Array.isArray(r.totals) && [...r.rows, ...r.totals].every((x) => ok(x) && numeric.every((k) => Number.isFinite(Number(x[k]))));
}
const originCell = (o) => badge("origin", o);
const heading = (key, r) => (r.groupBy === "ecosystem" ? name("eco", key) : r.groupBy === "status" ? label("record", key) : key);

export async function page(ctx, seg, query) {
  const q = Object.fromEntries(FILTERS.map((k) => [k, query[k] || ""])); if (!q.groupBy) q.groupBy = "project";
  ctx.form("filters", (f) => {
    const d = formData(f), msg = f.querySelector("[data-form-error]");
    if (d.from && d.to && d.from > d.to) { msg.textContent = "The start date must not be after the end date."; f.elements.from.focus(); return; }
    ctx.go(withQuery("reports", d));
  });
  let projects = [];
  try { projects = (await ctx.api.get("/projects", { pageSize: 100, sort: "code" })).projects || []; } catch { /* the filter simply offers no project list */ }
  ctx.on("retry", () => ctx.refresh());
  const csvPath = `/reports/registry${withQuery("", { ...q, format: "csv" }).slice(2)}`;
  ctx.on("download-csv", async (b) => {
    const url = await ctx.run(b, () => ctx.api.blobUrl(csvPath));
    const a = document.createElement("a"); a.href = url; a.download = `registry-report-${q.groupBy}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); ctx.toast("CSV downloaded");
  });

  const filters = html`<form class="filters" data-form="filters" aria-label="Report filters" novalidate>
    <div><label for="groupBy">Group by</label><select id="groupBy" name="groupBy">${opts(GROUPS, q.groupBy)}</select></div>
    <div><label for="project">Project</label><select id="project" name="project">${opts(projects.map((p) => [p.code, `${p.code} — ${p.name}`]), q.project, "All projects")}</select></div>
    <div><label for="ecosystem">Ecosystem</label><select id="ecosystem" name="ecosystem">${opts(ECOS.map((e) => [e, name("eco", e)]), q.ecosystem, "All ecosystems")}</select></div>
    <div><label for="region">Region</label><input id="region" name="region" type="text" maxlength="120" value="${q.region}" autocomplete="off"></div>
    <div><label for="status">Record status</label><select id="status" name="status">${opts(STATUSES.map((s) => [s, label("record", s)]), q.status, "All statuses")}</select></div>
    <div><label for="origin">Data origin</label><select id="origin" name="origin">${opts([["USER_ENTERED", "User-entered data"], ["ILLUSTRATIVE", "Illustrative sample data"]], q.origin, "Both, shown separately")}</select></div>
    <div><label for="from">Activity from</label><input id="from" name="from" type="date" value="${q.from}"></div>
    <div><label for="to">Activity to</label><input id="to" name="to" type="date" value="${q.to}"></div>
    <div class="flex"><button type="submit" class="primary">Apply filters</button> <a class="btn secondary" href="#/reports">Clear</a></div>
    <p class="error small" data-form-error role="alert"></p></form>`;
  const defs = html`<details class="card"><summary>What each quantity means</summary><dl class="kv">${DEFINITIONS.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></details>`;
  const intro = { title: "Registry reports", crumbs: [["Overview", "#/overview"], ["Registry reports"]], lede: "Observations, estimates, approved quantities and issued credits by project, ecosystem, region, month or status." };

  let r, failure = null;
  try { r = await ctx.api.get("/reports/registry", Object.fromEntries(Object.entries(q).filter(([, v]) => v))); if (!wellFormed(r)) { failure = "The server returned a report in an unexpected format, so nothing is shown rather than risk showing wrong figures."; } }
  catch (e) { if (e.status === 401) throw e; failure = e.status === 400 ? `The filters were not accepted: ${e.message}` : e.message; }
  if (failure) return { ...intro, body: html`${filters}${notice("bad", html`<strong>The report could not be produced.</strong><br>${failure}<p><button type="button" class="secondary sm" data-action="retry">Try again</button></p>`)}${defs}` };

  const hasIllustrative = r.rows.some((x) => x.data_origin === "ILLUSTRATIVE") || r.totals.some((x) => x.data_origin === "ILLUSTRATIVE");
  const rowHead = (x) => html`${heading(x.key, r)}${r.groupBy === "project" ? html`<br><span class="small muted">${x.label}</span>` : ""}`;
  const section = (cap, heads, cols) => table({ caption: cap, heads: [r.heading, "Data origin", ...heads], rows: r.rows.map((x) => [rowHead(x), originCell(x.data_origin), ...cols(x)]), empty: "" });
  const none = empty("No records match these filters", "Change or clear the filters. Drafts are not included in reports.", html`<a class="btn secondary sm" href="#/reports">Clear filters</a>`);
  return { ...intro, body: html`${filters}
    ${hasIllustrative ? notice("warn", html`<strong>Illustrative sample data is included and shown separately.</strong> It is reference data, not real restoration or carbon accounting, and is never added to user-entered data.`) : ""}
    ${r.truncated ? notice("warn", html`Only the first ${r.maxRows} groups are shown. Narrow the filters to see the rest.`) : ""}
    <div class="flex"><button type="button" class="secondary" data-action="download-csv">${"Download CSV (current filters)"}</button><span class="small muted">Generated ${new Date(r.generatedAt).toLocaleString()} · ${r.rows.length} group${r.rows.length === 1 ? "" : "s"}</span></div>
    ${defs}
    ${r.rows.length ? html`
      <h2>Field observations</h2>${section("Reported and verified records and area", ["Projects", "Reported records", "Verified records", "In review", "Needs revision", "Rejected", "Reported area (ha)", "Verified area (ha)"], (x) => [x.projects, x.records_reported, x.records_verified, x.records_in_review, x.records_needing_revision, x.records_rejected, t(x.reported_area_ha), t(x.verified_area_ha)])}
      <h2>Estimates — not credits</h2>${section("Estimated carbon quantities", ["Central estimate (tCO₂e)", "Conservative estimate (tCO₂e)"], (x) => [t(x.estimated_central_tco2e, 4), t(x.estimated_conservative_tco2e, 4)])}
      <h2>Approved and issued credits</h2>${section("Approved eligible quantities and issued credits", ["Approved eligible (t)", "Issued (t)", "Transferred (t)", "Retired (t)", "Outstanding (t)"], (x) => [t(x.eligible_approved_tonnes, 0), t(x.issued_tonnes, 4), t(x.transferred_tonnes, 4), t(x.retired_tonnes, 4), t(x.outstanding_tonnes, 4)])}
      <h2>Totals for the selected filters</h2>${table({ caption: "Totals computed by the registry, one row per data origin", heads: ["Data origin", "Projects", "Reported records", "Verified records", "Reported area (ha)", "Estimated central (tCO₂e)", "Approved eligible (t)", "Issued (t)", "Transferred (t)", "Retired (t)", "Outstanding (t)"],
        rows: r.totals.map((x) => [originCell(x.data_origin), x.projects, x.records_reported, x.records_verified, t(x.reported_area_ha), t(x.estimated_central_tco2e, 4), t(x.eligible_approved_tonnes, 0), t(x.issued_tonnes, 4), t(x.transferred_tonnes, 4), t(x.retired_tonnes, 4), t(x.outstanding_tonnes, 4)]) })}
      <ul class="small muted">${r.notes.map((n) => html`<li>${n}</li>`)}</ul>` : none}` };
}
