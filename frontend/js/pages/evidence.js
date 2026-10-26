// Evidence repository: content hashes, storage status and review status for every evidence item the user may access.
import { html, badge, name, prov, fmtDate, fmtTime, table, pager, empty, notice, opts, withQuery, hash, bytes, KINDS, formData, label } from "../util.js";
import { evidenceActions } from "./shared.js";
import * as geo from "./geo.js";

export async function page(ctx, seg, query) {
  const r = await ctx.api.get("/evidence", { pageSize: 15, ...query });
  const p = r.pagination, href = (o) => withQuery("evidence", { ...query, ...o });
  evidenceActions(ctx);
  let importer = "";
  if (ctx.can("FIELD_USER")) {
    try {
      const [pr, rc] = await Promise.all([ctx.api.get("/projects", { pageSize: 100, sort: "code" }), ctx.api.get("/records", { mine: 1, pageSize: 100 })]);
      importer = geo.importPanel(ctx, { projects: pr.projects || [], records: rc.records || [] });
    } catch (e) { if (e.status === 401) throw e; importer = notice("bad", html`The geospatial import form could not be loaded: ${e.message}`); }
  }
  ctx.form("filters", (f) => ctx.go(withQuery("evidence", { ...formData(f), page: "" })));
  const unavailable = r.evidence.filter((e) => e.ipfs_status === "UNAVAILABLE" || e.storage_status === "MISSING").length;
  return {
    title: "Evidence repository", crumbs: [["Overview", "#/overview"], ["Evidence repository"]],
    lede: "Field photographs, drone imagery, remote-sensing references and documents attached to monitoring records.",
    body: html`${importer}${notice("info", html`<strong>About content hashes.</strong> A content hash (SHA-256) identifies an exact file so later changes can be detected. It is an integrity identifier, not proof that what the file shows is accurate. Access: files are visible to the owning organization, verifiers and registry administrators.`)}
      ${unavailable ? notice("warn", `${unavailable} item(s) on this page have a storage problem (missing stored file or remote storage unavailable). Local files remain the source of the content hash.`) : ""}
      <form class="filters" data-form="filters" data-autosubmit role="search" aria-label="Filter evidence"><div class="grow"><label for="q">Search</label><input id="q" name="q" type="search" value="${query.q || ""}" placeholder="Evidence code, file name or hash"></div>
        <div><label for="kind">Type</label><select id="kind" name="kind">${opts(KINDS.map((k) => [k, name("kind", k)]), query.kind, "All types")}</select></div>
        <div><label for="status">Review status</label><select id="status" name="status">${opts(["PENDING", "VERIFIED", "NEEDS_REVISION", "REJECTED"].map((s) => [s, label("evidence", s)]), query.status, "All")}</select></div><div><button type="submit" class="secondary">Apply</button> <a class="btn ghost" href="#/evidence">Clear</a></div></form>
      ${table({ caption: "Evidence items", sort: p, sortBase: (k, d) => href({ sort: k, dir: d, page: "" }), heads: [["Evidence", "code"], "File", ["Type", "kind"], "Project / record", ["Captured", "captured"], ["Uploaded", "created"], "Content hash (SHA-256)", "Storage", ["Review", "status"], "Access"],
        rows: r.evidence.map((e) => [e.code, html`${e.filename || html`<span class="muted">reference</span>`}${e.size_bytes ? html`<br><span class="small muted">${bytes(e.size_bytes)}</span>` : ""} ${prov(e.data_origin)}`, name("kind", e.kind), html`${e.project_code}${e.record_code ? html`<br><a href="#/records/${e.record_id}">${e.record_code}</a>` : html`<br><span class="small muted">unattached</span>`}`,
          fmtDate(e.captured_at), html`${fmtTime(e.created_at)}<br><span class="small muted">${e.uploader_name}</span>`, e.sha256 ? hash("0x" + e.sha256, 8) : html`<span class="muted">reference only</span>`, html`${badge("storage", e.storage_status)}<br>${badge("ipfs", e.ipfs_status)}`, badge("evidence", e.verification_status),
          e.storage_status === "STORED" ? html`<button type="button" class="secondary sm" data-action="ev-view" data-id="${e.id}" data-name="${e.filename || e.code}" data-image="${e.mime_type?.startsWith("image/") ? 1 : 0}">View</button> <button type="button" class="secondary sm" data-action="ev-download" data-id="${e.id}" data-name="${e.filename || e.code}">Download</button>` : html`<span class="muted small">No file</span>`]),
        empty: empty("No evidence found", "Evidence is attached to monitoring records in Field data.", ctx.can("FIELD_USER") ? html`<a class="btn primary" href="#/field/new">New monitoring record</a>` : "") })}${pager(p, (n) => href({ page: n }))}`,
  };
}
