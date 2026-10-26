// Templating with automatic escaping, one terminology system for statuses, and shared presentation helpers.
const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => MAP[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join("") : v === false || v == null ? "" : esc(v));
export const html = (strings, ...vals) => new Raw(strings.reduce((a, s, i) => a + s + (i < vals.length ? val(vals[i]) : ""), ""));

// ── icons (stroke icons, decorative) ──
const P = { home: "M3 11l9-8 9 8M5 10v10h14V10", folder: "M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z", pencil: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4", clipboard: "M9 4h6v3H9zM7 5H5v16h14V5h-2M9 12h6M9 16h4", image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M9 9.5a1 1 0 100-.01", leaf: "M5 19c0-9 5-14 15-14 0 10-5 15-14 15M5 19l8-8", ledger: "M5 4h14v16H5zM9 4v16M12 9h4M12 13h4", link: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1", users: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.3a3 3 0 010 5.4M18 14c2 .7 3 2.600 3 6", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", search: "M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5", bell: "M6 16V11a6 6 0 1112 0v5l2 2H4zM10 20a2 2 0 004 0", user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.6-7 8-7s8 3 8 7", menu: "M4 6h16M4 12h16M4 18h16", x: "M6 6l12 12M18 6L6 18", pin: "M12 21s7-6.100 7-11a7 7 0 10-14 0c0 4.900 7 11 7 11zM12 12a2 2 0 100-4 2 2 0 000 4z", info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01", alert: "M12 3l10 18H2zM12 10v5M12 18h.01", copy: "M9 9h11v11H9zM5 15V4h11", shield: "M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z", check: "M5 12l5 5 9-10", download: "M12 4v12M7 11l5 5 5-5M5 20h14", plus: "M12 5v14M5 12h14", out: "M10 5H5v14h5M15 8l4 4-4 4M9 12h10" };
export const icon = (n) => raw(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${P[n] || P.info}"/></svg>`);

// ── one terminology system ──
const L = {
  dispute: { OPEN: ["Open", "warn"], UNDER_REVIEW: ["Under review", "info"], UPHELD: ["Upheld: hold remains", "bad"], DISMISSED: ["Dismissed", "neutral"], WITHDRAWN: ["Withdrawn", "neutral"] },
  origin: { ILLUSTRATIVE: ["Illustrative sample data", "warn"], USER_ENTERED: ["User-entered data", "neutral"] },
  project: { ACTIVE: ["Active", "ok"], ON_HOLD: ["On hold", "warn"], CLOSED: ["Closed", "neutral"] },
  verification: { PENDING: ["Awaiting verification", "warn"], VERIFIED: ["Verified", "ok"], REJECTED: ["Rejected", "bad"], NEEDS_REVISION: ["Revision requested", "warn"] },
  record: { DRAFT: ["Draft", "neutral"], SUBMITTED: ["Submitted", "info"], UNDER_REVIEW: ["Under review", "warn"], VERIFIED: ["Verified", "ok"], REJECTED: ["Rejected", "bad"], NEEDS_REVISION: ["Revision requested", "warn"] },
  evidence: { PENDING: ["Pending review", "warn"], VERIFIED: ["Accepted", "ok"], REJECTED: ["Rejected", "bad"], NEEDS_REVISION: ["Revision requested", "warn"] },
  assessment: { PENDING: ["Awaiting approval", "warn"], APPROVED: ["Approved", "ok"], REJECTED: ["Not approved", "bad"] },
  creditStage: { NONE: ["No credits", "neutral"], ELIGIBLE: ["Assessment calculated", "info"], APPROVED: ["Approved for issuance", "ok"], ISSUED: ["Credits issued", "ok"] },
  credit: { ISSUED: ["Issued", "ok"], PARTIALLY_RETIRED: ["Partly retired", "info"], RETIRED: ["Retired", "neutral"], PARTIALLY_CANCELLED: ["Partly cancelled", "warn"], CANCELLED: ["Cancelled", "bad"] },
  anchor: { NONE: ["Not anchored", "neutral"], PENDING: ["Anchoring pending", "warn"], ANCHORED: ["Anchored on-chain", "ok"] },
  tx: { CONFIRMED: ["Confirmed", "ok"], PENDING: ["Pending", "warn"], FAILED: ["Failed", "bad"], UNKNOWN: ["Unavailable", "neutral"], NOT_SUBMITTED: ["Not submitted", "neutral"] },
  op: { PENDING: ["Not submitted", "neutral"], SUBMITTED: ["Pending confirmation", "warn"], CONFIRMED: ["Confirmed; registry update pending", "warn"], COMPLETED: ["Completed", "ok"], FAILED: ["Failed", "bad"] },
  storage: { STORED: ["Stored on server", "ok"], MISSING: ["Stored file missing", "bad"], REFERENCE_ONLY: ["Reference only", "neutral"] },
  ipfs: { NOT_CONFIGURED: ["IPFS not configured", "neutral"], PINNED: ["Pinned to IPFS", "ok"], UNAVAILABLE: ["IPFS unavailable", "warn"] },
  validation: { UNVALIDATED: ["Unvalidated placeholder", "warn"], ILLUSTRATION_ONLY: ["Illustration only", "neutral"] },
  method: { APPROVED: ["Independently reviewed", "ok"], PENDING_REVIEW: ["Pending independent review", "warn"], REJECTED: ["Review rejected", "bad"], WITHDRAWN: ["Review withdrawn", "neutral"], STALE_REVIEW: ["Review out of date", "warn"], ILLUSTRATIVE_ONLY: ["Illustration only", "neutral"], UNKNOWN: ["Unknown version", "neutral"] },
  determination: { SUBMITTED: ["Awaiting review", "warn"], ACCEPTED: ["Accepted", "ok"], REJECTED: ["Rejected", "bad"], SUPERSEDED: ["Superseded", "neutral"] },
  severity: { INFO: ["Information", "info"], ACTION: ["Action needed", "warn"], WARNING: ["Warning", "warn"], CRITICAL: ["Critical", "bad"] },
  active: { true: ["Active", "ok"], false: ["Deactivated", "neutral"] },
};
export const badge = (kind, v) => { const [t, tone] = (L[kind] && L[kind][v]) || [String(v ?? "—").replaceAll("_", " "), "neutral"]; return html`<span class="badge ${tone}">${t}</span>`; };
export const label = (kind, v) => (L[kind] && L[kind][v] ? L[kind][v][0] : String(v ?? "—"));
const NAMES = {
  dcat: { EVIDENCE: "Evidence", DOUBLE_COUNTING: "Possible double counting", OWNERSHIP: "Ownership", CALCULATION: "Calculation", OTHER: "Other" },
  eco: { MANGROVE: "Mangrove", SEAGRASS: "Seagrass meadow", SALT_MARSH: "Salt marsh" },
  rest: { MANGROVE_PLANTATION: "Mangrove plantation", HYDROLOGICAL_RESTORATION: "Hydrological restoration", SEAGRASS_TRANSPLANT: "Seagrass transplanting", SALT_MARSH_REVEGETATION: "Salt-marsh re-vegetation", NATURAL_REGENERATION_PROTECTION: "Natural regeneration and protection" },
  act: { PLANTING: "Planting", TRANSPLANTING: "Transplanting", MONITORING_SURVEY: "Monitoring survey", MAINTENANCE: "Maintenance", HYDROLOGY_RESTORATION: "Hydrology restoration" },
  kind: { FIELD_PHOTO: "Field photograph", DRONE_IMAGERY: "Drone imagery", REMOTE_SENSING: "Remote-sensing reference", DOCUMENT: "Document", GEOSPATIAL: "Geospatial import" },
  det: { BASELINE: "Baseline", ADDITIONALITY: "Additionality", LEAKAGE: "Leakage", NON_PERMANENCE_RISK: "Non-permanence risk" },
  role: { FIELD_USER: "Field user", VERIFIER: "Verifier", NCCR_ADMIN: "Registry administrator", SYSTEM: "System" },
  org: { REGULATOR: "Registry authority", NGO: "NGO", COMMUNITY: "Community group", PANCHAYAT: "Panchayat", RESEARCH: "Research body", VERIFICATION_BODY: "Verification body", CREDIT_HOLDER: "Credit holder" },
  tx: { PROJECT_REGISTERED: "Project registered", RECORD_ANCHORED: "Record anchored", RECORD_REANCHORED: "Record re-anchored", VERIFICATION_RECORDED: "Verification recorded", CREDITS_ISSUED: "Credits issued", CREDITS_TRANSFERRED: "Credits transferred", CREDITS_RETIRED: "Credits retired", ROLE_CHANGED: "Role changed" },
  measure: { survival_rate_pct: ["Survival rate", "%"], avg_height_cm: ["Average height", "cm"], canopy_cover_pct: ["Canopy cover", "%"], seedlings_planted: ["Seedlings planted", "count"], shoot_density_per_m2: ["Shoot density", "per m²"], sediment_depth_cm: ["Sediment depth", "cm"], water_salinity_ppt: ["Salinity", "ppt"], dissolved_oxygen_mg_l: ["Dissolved oxygen", "mg/L"] },
};
export const name = (g, v) => NAMES[g]?.[v] || String(v ?? "—").replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
export const MEASURES = NAMES.measure;
export const ECO = Object.keys(NAMES.eco), REST = Object.keys(NAMES.rest), ACT = Object.keys(NAMES.act), KINDS = Object.keys(NAMES.kind), UPLOAD_KINDS = KINDS.filter((k) => k !== "GEOSPATIAL"); // geospatial files go through the validating import, not the generic upload
export const actionLabel = (a) => String(a).replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

export const PROV_TEXT = "Illustrative record: not collected in the field and without verification standing outside this system.";
export const prov = (o) => (o === "ILLUSTRATIVE" ? html`<span class="badge prov" title="${PROV_TEXT}">Illustrative dataset</span>` : "");

// ── formatting ──
export const fmtDate = (d) => (d ? String(d).slice(0, 10) : "—");
export const fmtTime = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export const num = (n, d = 2) => (n == null || n === "" || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
export const bytes = (n) => (n == null ? "—" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const hash = (h, n = 10) => (h ? html`<span class="hash"><code title="${h}">${h.slice(0, 2 + n)}…${h.slice(-6)}</code><button type="button" class="secondary sm" data-action="copy" data-value="${h}" aria-label="Copy full value">Copy</button></span>` : "—");

// ── tables, pagination, forms ──
export const table = ({ caption, heads, rows, empty, sort, sortBase }) => {
  if (!rows.length) return empty || html`<div class="empty"><strong>Nothing to show</strong>No matching records.</div>`;
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="${caption}"><table><caption class="vh">${caption}</caption><thead><tr>${heads.map((h) => {
    const [text, key] = Array.isArray(h) ? h : [h];
    if (!key || !sort) return html`<th scope="col">${text}</th>`;
    const active = sort.sort === key, dir = active ? (sort.dir === "asc" ? "desc" : "asc") : "asc";
    return html`<th scope="col" aria-sort="${active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}"><a href="${sortBase(key, dir)}">${text}${active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</a></th>`;
  })}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (i === 0 ? html`<th scope="row" class="rowhead">${c}</th>` : html`<td>${c}</td>`))}</tr>`)}</tbody></table></div>`;
};
export const pager = (p, href) => (!p || p.total === 0 ? "" : html`<nav class="pager" aria-label="Pagination"><span>Showing ${(p.page - 1) * p.pageSize + 1}–${Math.min(p.total, p.page * p.pageSize)} of ${p.total}</span>
  <span class="btns">${p.page > 1 ? html`<a class="btn secondary sm" href="${href(p.page - 1)}" rel="prev">Previous</a>` : ""}<span class="small">Page ${p.page} of ${p.totalPages}</span>${p.page < p.totalPages ? html`<a class="btn secondary sm" href="${href(p.page + 1)}" rel="next">Next</a>` : ""}</span></nav>`);
export const empty = (title, text, action) => html`<div class="empty"><strong>${title}</strong>${text}${action ? html`<p>${action}</p>` : ""}</div>`;
export const notice = (tone, content) => html`<div class="notice ${tone}" role="${tone === "bad" ? "alert" : "note"}">${icon(tone === "bad" || tone === "warn" ? "alert" : "info")}<div>${content}</div></div>`;
export const opts = (list, selected, any) => html`${any ? html`<option value="">${any}</option>` : ""}${list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return html`<option value="${v}" ${String(v) === String(selected) ? raw("selected") : ""}>${l}</option>`; })}`;
export const field = ({ id, label: l, required, optional, help, unit, error, children }) => html`<div class="fld"><label for="${id}">${l}${required ? html`<span class="req" aria-hidden="true">*</span><span class="vh"> (required)</span>` : ""}${optional ? html` <span class="opt">(optional)</span>` : ""}</label>
  ${unit ? html`<div class="unit-field">${children}<span class="unit" id="${id}-unit">${unit}</span></div>` : children}${help ? html`<div class="help" id="${id}-help">${help}</div>` : ""}<div class="field-error" id="${id}-err" role="alert">${error || ""}</div></div>`;
export const formData = (f) => Object.fromEntries([...new FormData(f).entries()].filter(([, v]) => typeof v === "string"));
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── hash-based query helpers ──
export const parseHash = () => { const [path, q = ""] = location.hash.replace(/^#\/?/, "").split("?"); return { segments: path.split("/").filter(Boolean), query: Object.fromEntries(new URLSearchParams(q)) }; };
export const withQuery = (base, query) => { const p = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== "" && v != null)); return `#/${base}${p.toString() ? "?" + p : ""}`; };
