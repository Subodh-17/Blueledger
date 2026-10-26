// Governance screens backed by the registry API: methodology review, runtime settings, on-chain role administration,
// notifications, and project determinations. Every action calls the server, which enforces roles and separation of duties;
// nothing here changes a status without a successful API response.
import { html, raw, badge, name, fmtTime, fmtDate, table, pager, empty, notice, opts, field, formData, hash, withQuery } from "../util.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Show server-side validation messages next to their fields. `map` translates an API field name to the field id. */
function fieldErrors(f, details, map) {
  f.querySelectorAll(".field-error").forEach((x) => (x.textContent = ""));
  for (const [k, v] of Object.entries(details || {})) {
    const id = map[k]; const el = id && f.querySelector(`#${id}-err`);
    if (el) { el.textContent = typeof v === "string" ? v : JSON.stringify(v); const input = f.querySelector(`#${id}`); input?.setAttribute("aria-invalid", "true"); }
  }
}
const clearErrors = (f) => { f.querySelectorAll(".field-error").forEach((x) => (x.textContent = "")); f.querySelectorAll("[aria-invalid]").forEach((x) => x.removeAttribute("aria-invalid")); };
const safeHref = (h) => (typeof h === "string" && h.startsWith("#/") ? h : null);
const shortTx = (t) => (t ? `${t.slice(0, 12)}…` : "");

// ───────── methodology review (Administration → Methodology review) ─────────
const STATE_TEXT = {
  APPROVED: "A recorded independent review covers the current parameter set. Assessments that use this version can become issuable once the project determinations they depend on are accepted.",
  PENDING_REVIEW: "No independent review has been recorded for this version. Assessments calculated with it cannot be approved or issued.",
  REJECTED: "The most recent independent review rejected this parameter set. Assessments calculated with it cannot be approved or issued.",
  WITHDRAWN: "The most recent independent review was withdrawn. Assessments calculated with it cannot be approved or issued.",
  STALE_REVIEW: "The parameters changed after the last review. A new independent review of the current parameter set is required before assessments can be approved or issued.",
};

export async function methodology(ctx) {
  const { methodologies } = await ctx.api.get("/methodologies");
  const reviewable = methodologies.filter((m) => !m.illustrativeOnly);
  const reviews = Object.fromEntries(await Promise.all(reviewable.map(async (m) => [m.version, (await ctx.api.get(`/methodologies/${encodeURIComponent(m.version)}/reviews`)).reviews])));

  ctx.form("mreview", async (f) => {
    clearErrors(f);
    const d = formData(f), approve = d.decision === "APPROVED";
    const c = await ctx.confirm({
      title: "Record this independent review?",
      body: html`<p>This records a review that was carried out <strong>outside this system</strong> by ${d.reviewerName || "the named reviewer"}. It documents the review for methodology ${f.dataset.version}; it does not validate the parameters itself.</p>
        <p>The record is bound to the current parameter set (${f.dataset.hash.slice(0, 12)}…) and cannot be edited afterwards. ${approve ? "Assessments using this version may become issuable once project determinations are accepted." : "Assessments using this version stay blocked."}</p>`,
      confirmLabel: "Record review", danger: !approve,
    });
    if (!c.ok) return;
    try {
      await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post(`/methodologies/${encodeURIComponent(f.dataset.version)}/review`, {
        decision: d.decision, reviewerName: d.reviewerName, reviewerOrganization: d.reviewerOrganization, reviewReference: d.reviewReference, reviewDate: d.reviewDate,
        scopeNotes: d.scopeNotes || undefined, parametersHash: f.dataset.hash,
      }), "Review recorded");
    } catch (e) { fieldErrors(f, e.details, { decision: `${f.dataset.p}-decision`, reviewerName: `${f.dataset.p}-name`, reviewerOrganization: `${f.dataset.p}-org`, reviewReference: `${f.dataset.p}-ref`, reviewDate: `${f.dataset.p}-date`, scopeNotes: `${f.dataset.p}-scope` }); return; }
    ctx.refresh();
  });

  const card = (m, i) => {
    const a = m.approval || {}, p = `mr${i}`, list = reviews[m.version] || [];
    if (m.illustrativeOnly) return html`<section class="card"><h2>${m.title}</h2><p class="muted small">Version ${m.version} · ${badge("method", "ILLUSTRATIVE_ONLY")}</p>
      <p>This version supports illustrative assessments only. It cannot be independently reviewed and can only be applied to projects marked as an illustrative dataset. Its quantities are never presented as issuable for a real project.</p></section>`;
    return html`<section class="card"><h2>${m.title}</h2>
      <p class="muted small">Version ${m.version} · ${badge("method", a.state)}</p>
      <p>${STATE_TEXT[a.state] || "The review state of this version could not be determined."}</p>
      <dl class="kv"><dt>Parameter set hash</dt><dd>${a.parametersHash ? hash(a.parametersHash) : "—"}</dd>
        ${a.review ? html`<dt>Latest review</dt><dd>${name("review", a.review.decision)} by ${a.review.reviewer_name} (${a.review.reviewer_organization}), ${fmtDate(a.review.review_date)}</dd>` : ""}</dl>
      <h3>Recorded reviews</h3>
      ${table({ caption: `Reviews of methodology ${m.version}`, heads: ["Recorded", "Decision", "Reviewer", "Organization", "Review date", "Reference", "Scope notes", "Recorded by", "Parameter set"],
        rows: list.map((r) => [fmtTime(r.recorded_at), name("review", r.decision), r.reviewer_name, r.reviewer_organization, fmtDate(r.review_date), r.review_reference, r.scope_notes || "—", r.recorded_by_name, hash(r.parameters_hash, 6)]),
        empty: empty("No review recorded", "No independent review of this methodology has been recorded yet.") })}
      <details class="card"><summary><strong>Record an independent review</strong></summary>
        <form data-form="mreview" data-version="${m.version}" data-hash="${a.parametersHash || ""}" data-p="${p}" novalidate>
          <div class="row">${field({ id: `${p}-decision`, label: "Decision", required: true, children: html`<select id="${p}-decision" name="decision" required>${opts([["APPROVED", "Approved"], ["REJECTED", "Rejected"], ["WITHDRAWN", "Withdrawn"]])}</select>` })}
            ${field({ id: `${p}-date`, label: "Date of the review", required: true, children: html`<input id="${p}-date" name="reviewDate" type="date" required>` })}</div>
          <div class="row">${field({ id: `${p}-name`, label: "Reviewer name", required: true, children: html`<input id="${p}-name" name="reviewerName" required minlength="3" maxlength="200">` })}
            ${field({ id: `${p}-org`, label: "Reviewer organization", required: true, children: html`<input id="${p}-org" name="reviewerOrganization" required minlength="3" maxlength="200">` })}</div>
          ${field({ id: `${p}-ref`, label: "Review report reference", required: true, help: "Report identifier or link to the independent review, at least 5 characters.", children: html`<input id="${p}-ref" name="reviewReference" required minlength="5" maxlength="500">` })}
          ${field({ id: `${p}-scope`, label: "Scope and limitations", optional: true, children: html`<textarea id="${p}-scope" name="scopeNotes" maxlength="2000"></textarea>` })}
          <p><button type="submit" class="primary" ${a.parametersHash ? "" : raw("disabled")}>Record review</button></p></form></details></section>`;
  };

  return html`${notice("info", html`Recording a review documents an <strong>independent review performed outside this system</strong>. The registry does not validate coefficients itself; until a review is recorded for the exact current parameter set, assessments for real projects cannot be approved or issued.`)}
    ${methodologies.length ? methodologies.map(card) : empty("No methodology versions", "The registry has no methodology definitions loaded.")}`;
}

// ───────── runtime settings (Administration → Runtime settings) ─────────
export async function settings(ctx) {
  const [{ settings: list }, { history }] = await Promise.all([ctx.api.get("/settings"), ctx.api.get("/settings/history")]);
  ctx.form("setting", async (f) => {
    clearErrors(f);
    const key = f.dataset.key, raw_ = f.elements.value.value, reason = f.elements.reason.value.trim();
    const value = f.dataset.type === "int" ? (raw_.trim() === "" ? NaN : Number(raw_)) : raw_;
    const c = await ctx.confirm({ title: "Change this setting?", body: html`<p><strong>${f.dataset.label}</strong> will change to <strong>${String(value)}</strong> for the running service immediately. The change, the previous value and your reason are written to the audit log.</p>`, confirmLabel: "Change setting" });
    if (!c.ok) return;
    try { await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.put(`/settings/${encodeURIComponent(key)}`, { value, reason }), "Setting changed"); }
    catch (e) { fieldErrors(f, e.details, { value: `${f.dataset.p}`, reason: `${f.dataset.p}-reason` }); return; }
    ctx.refresh();
  });
  ctx.on("setting-reset", async (b) => {
    const c = await ctx.confirm({ title: "Reset to the built-in default?", body: html`<p>${b.dataset.label} returns to its built-in default value. The change is audited.</p>`, confirmLabel: "Reset setting", reasonLabel: "Reason for the reset", reasonRequired: true });
    if (!c.ok) return;
    await ctx.run(b, () => ctx.api.delete(`/settings/${encodeURIComponent(b.dataset.key)}`, { reason: c.reason }), "Setting reset to default");
    ctx.refresh();
  });
  const card = (s, i) => {
    const p = `st${i}`;
    const control = s.type === "enum"
      ? html`<select id="${p}" name="value" required>${opts(s.values.map((v) => [v, v]), s.value)}</select>`
      : html`<input id="${p}" name="value" type="number" inputmode="numeric" step="1" min="${s.min}" max="${s.max}" value="${s.value}" required>`;
    return html`<section class="card"><h3>${s.label}</h3>
      <p class="small muted"><code>${s.key}</code> · ${s.source === "override" ? html`Changed from the default (${String(s.default)})${s.changedBy ? html` by ${s.changedBy}` : ""}${s.changedAt ? html`, ${fmtTime(s.changedAt)}` : ""}` : "Using the default"}</p>
      <form data-form="setting" data-key="${s.key}" data-type="${s.type}" data-label="${s.label}" data-p="${p}" novalidate>
        ${field({ id: p, label: "Value", required: true, help: s.type === "int" ? `Whole number from ${s.min} to ${s.max}.` : `One of: ${s.values.join(", ")}.`, children: control })}
        ${field({ id: `${p}-reason`, label: "Reason for the change", required: true, help: "At least 5 characters; recorded in the audit log.", children: html`<input id="${p}-reason" name="reason" required minlength="5" maxlength="500">` })}
        <p class="flex"><button type="submit" class="primary">Save</button>${s.source === "override" ? html`<button type="button" class="secondary" data-action="setting-reset" data-key="${s.key}" data-label="${s.label}">Reset to default</button>` : ""}</p></form></section>`;
  };
  return html`${notice("info", "Only the settings listed here can be changed at runtime. Secrets, signing keys and connection strings are never shown or editable here.")}
    <div class="grid g2">${list.map(card)}</div>
    <h2>Change history</h2>
    ${table({ caption: "Setting changes", heads: ["When", "Setting", "From", "To", "Reason", "Changed by"],
      rows: history.map((h) => [fmtTime(h.changed_at), html`<code>${h.key}</code>`, h.old_value == null ? "—" : String(h.old_value), String(h.new_value), h.reason || "—", h.changed_by_name || "—"]),
      empty: empty("No changes recorded", "Every setting is still at its built-in default.") })}`;
}

// ───────── on-chain role administration (Administration → On-chain roles) ─────────
export async function roles(ctx) {
  let r;
  try { r = await ctx.api.get("/chain/roles"); }
  catch (e) { if (e.status === 401) throw e; return notice("warn", html`<strong>Blockchain network not connected.</strong> On-chain roles cannot be read or changed right now. ${e.message}`); }
  const roleLabel = (x) => (x === "verifier" ? "Verifier" : x === "registrar" ? "Registrar" : x);
  ctx.form("role-grant", async (f) => {
    clearErrors(f); const d = formData(f);
    const c = await ctx.confirm({ title: `Grant the on-chain ${d.role} role?`, body: html`<p>The registry administrator account signs a transaction on the smart contract granting the ${d.role} role to <code>${d.account}</code>. The role controls what that wallet can do on-chain.</p>`, confirmLabel: "Grant role" });
    if (!c.ok) return;
    let out;
    try { out = await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post("/chain/roles", { account: d.account.trim(), role: d.role, granted: true })); }
    catch (e) { fieldErrors(f, e.details, { account: "rg-account", role: "rg-role" }); return; }
    ctx.toast(`Role granted${out.tx ? ` (transaction ${shortTx(out.tx)})` : ""}`); ctx.refresh();
  });
  ctx.on("role-revoke", async (b) => {
    const c = await ctx.confirm({ title: `Revoke the on-chain ${b.dataset.role} role?`, body: html`<p>The registry administrator account signs a transaction revoking the ${b.dataset.role} role for <code>${b.dataset.account}</code>. That wallet can no longer perform ${b.dataset.role} actions on the smart contract.</p>`, confirmLabel: "Revoke role", danger: true });
    if (!c.ok) return;
    const out = await ctx.run(b, () => ctx.api.post("/chain/roles", { account: b.dataset.account, role: b.dataset.role, granted: false }));
    ctx.toast(`Role revoked${out.tx ? ` (transaction ${shortTx(out.tx)})` : ""}`); ctx.refresh();
  });
  ctx.form("admin-propose", async (f) => {
    clearErrors(f); const d = formData(f);
    const c = await ctx.confirm({ title: "Propose a new registry administrator?", body: html`<p>This proposes <code>${d.account}</code> as the next registry administrator. Control does not change until that account accepts from its own wallet. Until then the current administrator keeps full control.</p><p>Double-check the address: a hand-over to an account nobody controls can never be completed.</p>`, confirmLabel: "Propose hand-over", danger: true });
    if (!c.ok) return;
    let out;
    try { out = await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post("/chain/admin/propose", { account: d.account.trim() })); }
    catch (e) { fieldErrors(f, e.details, { account: "ap-account" }); return; }
    ctx.toast(`Hand-over proposed${out.tx ? ` (transaction ${shortTx(out.tx)})` : ""}`); ctx.refresh();
  });
  const pending = r.pendingAdmin && r.pendingAdmin !== ZERO_ADDRESS;
  return html`<div class="grid g2"><section class="card"><h2>Control accounts</h2><dl class="kv">
      <dt>Registry administrator</dt><dd>${hash(r.admin, 8)}${r.adminUser ? html` <span class="small muted">${r.adminUser}</span>` : ""}</dd>
      <dt>Pending hand-over</dt><dd>${pending ? html`${hash(r.pendingAdmin, 8)} <span class="small muted">awaiting acceptance from that wallet</span>` : html`<span class="muted">None</span>`}</dd>
      <dt>Service registrar account</dt><dd>${hash(r.serviceRegistrar, 8)}</dd></dl></section>
    <section class="card"><h2>About these roles</h2><p class="small">Verifiers can record verification decisions on-chain. Registrars can register projects and anchor records. Only the registry administrator can issue credits or change roles. Changes are transactions on the smart contract and appear in the blockchain network history.</p></section></div>
    <h2>Role holders</h2>
    ${table({ caption: "On-chain role holders", heads: ["Role", "Wallet address", "Linked registry user", "Actions"],
      rows: r.holders.map((h) => [roleLabel(h.role), hash(h.account, 8), h.user ? `${h.user.name} (${name("role", h.user.role)})` : html`<span class="muted">No linked user</span>`,
        html`<button type="button" class="secondary sm" data-action="role-revoke" data-role="${h.role}" data-account="${h.account}">Revoke role</button>`]),
      empty: empty("No role holders found", "No wallet currently holds the verifier or registrar role.") })}
    <div class="grid g2"><details class="card"><summary><strong>Grant a role to a wallet address</strong></summary>
      <form data-form="role-grant" novalidate>${field({ id: "rg-role", label: "Role", required: true, children: html`<select id="rg-role" name="role">${opts([["verifier", "Verifier"], ["registrar", "Registrar"]])}</select>` })}
        ${field({ id: "rg-account", label: "Wallet address", required: true, help: "A 42-character address starting with 0x.", children: html`<input id="rg-account" name="account" required placeholder="0x…" autocomplete="off" spellcheck="false">` })}
        <p><button type="submit" class="primary">Grant role</button></p></form></details>
    <details class="card"><summary><strong>Propose an administrator hand-over</strong></summary>
      <form data-form="admin-propose" novalidate>${field({ id: "ap-account", label: "New administrator wallet address", required: true, help: "The proposed account must accept the hand-over from its own wallet.", children: html`<input id="ap-account" name="account" required placeholder="0x…" autocomplete="off" spellcheck="false">` })}
        <p><button type="submit" class="danger">Propose hand-over</button></p></form></details></div>`;
}

// ───────── notifications (account menu → Notifications) ─────────
export async function notifications(ctx, seg, query) {
  const unreadOnly = query.unread === "1";
  const r = await ctx.api.get("/notifications", { page: query.page, unread: unreadOnly ? "1" : undefined, pageSize: 20 });
  const href = (p) => withQuery("notifications", { ...query, page: p });
  ctx.on("notif-read", async (b) => { await ctx.run(b, () => ctx.api.post("/notifications/read", { ids: [Number(b.dataset.id)] })); ctx.refresh(); });
  ctx.on("notif-readall", async (b) => { await ctx.run(b, () => ctx.api.post("/notifications/read", { all: true }), "All notifications marked as read"); ctx.refresh(); });
  const tabs = html`<nav class="tabs" aria-label="Notification filter"><a href="#/notifications" ${unreadOnly ? "" : raw('aria-current="page"')}>All</a><a href="#/notifications?unread=1" ${unreadOnly ? raw('aria-current="page"') : ""}>Unread (${r.unread})</a></nav>`;
  const items = r.notifications.map((n) => {
    const link = safeHref(n.href);
    return html`<li class="notif ${n.read_at ? "" : "unread"}"><div class="notif-main"><p><span class="notif-sev">${badge("severity", n.severity)}</span> <strong>${link ? html`<a href="${link}">${n.title}</a>` : n.title}</strong></p>
      ${n.body ? html`<p class="small">${n.body}</p>` : ""}<p class="small muted">${fmtTime(n.created_at)}${n.read_at ? html` · read ${fmtTime(n.read_at)}` : ""}</p></div>
      ${n.read_at ? "" : html`<button type="button" class="secondary sm" data-action="notif-read" data-id="${n.id}">Mark as read</button>`}</li>`;
  });
  return {
    title: "Notifications", crumbs: [["Overview", "#/overview"], ["Notifications"]],
    lede: "Events that need your attention. A notification is created together with the event it describes, never by a button in the interface.",
    actions: r.unread ? html`<button type="button" class="secondary" data-action="notif-readall">Mark all as read</button>` : "",
    body: html`${tabs}${items.length ? html`<ul class="notif-list">${items}</ul>${pager(r.pagination, href)}` : empty(unreadOnly ? "No unread notifications" : "No notifications yet", unreadOnly ? "You are up to date." : "Events that need your attention will appear here.")}`,
  };
}

// ───────── project determinations (section of the project detail page) ─────────
export async function determinations(ctx, projectId) {
  const { determinations: list } = await ctx.api.get(`/projects/${projectId}/determinations`);
  const isAdmin = ctx.can("NCCR_ADMIN"), isVerifier = ctx.can("VERIFIER");
  ctx.form("determination", async (f) => {
    clearErrors(f); const d = formData(f), npr = d.kind === "NON_PERMANENCE_RISK";
    const c = await ctx.confirm({ title: "Submit this determination?", body: html`<p>The ${name("det", d.kind).toLowerCase()} determination is submitted for review by a verifier and supersedes any earlier version that is still open. The values must come from a reviewed project document; this system does not generate them.</p>`, confirmLabel: "Submit determination" });
    if (!c.ok) return;
    try { await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post(`/projects/${projectId}/determinations`, { kind: d.kind, summary: d.summary, documentReference: d.documentReference, ...(npr ? { bufferPercent: d.bufferPercent === "" ? undefined : Number(d.bufferPercent) } : {}) }), "Determination submitted"); }
    catch (e) { fieldErrors(f, e.details, { kind: "dt-kind", summary: "dt-summary", documentReference: "dt-doc", bufferPercent: "dt-buffer" }); return; }
    ctx.refresh();
  });
  ctx.on("det-review", async (b) => {
    const accept = b.dataset.decision === "ACCEPTED", org = ctx.user?.organization;
    if (!org || org.length < 3) { ctx.toast("Your account has no organization recorded, which is required to review a determination.", "error"); return; }
    const c = await ctx.confirm({ title: `${accept ? "Accept" : "Reject"} this determination?`, body: html`<p>Your decision is recorded against ${org} with your notes. A determination cannot be reviewed by the person who submitted it.${accept ? " Accepting it can unblock issuance for assessments that depend on it." : ""}</p>`, confirmLabel: accept ? "Accept determination" : "Reject determination", danger: !accept, reasonLabel: "Review notes", reasonRequired: true });
    if (!c.ok) return;
    await ctx.run(b, () => ctx.api.post(`/determinations/${b.dataset.id}/review`, { decision: b.dataset.decision, notes: c.reason, reviewerOrganization: org }), accept ? "Determination accepted" : "Determination rejected");
    ctx.refresh();
  });
  const rows = list.map((d) => [name("det", d.kind), `v${d.version}`, badge("determination", d.status), d.summary, d.document_reference, d.buffer_percent == null ? "—" : `${Number(d.buffer_percent)} %`,
    `${d.submitted_by_name}, ${fmtTime(d.submitted_at)}`, d.reviewed_by_name ? html`${d.reviewed_by_name}${d.reviewer_organization ? ` (${d.reviewer_organization})` : ""}, ${fmtTime(d.reviewed_at)}${d.review_notes ? html`<br><span class="small muted">${d.review_notes}</span>` : ""}` : "—",
    isVerifier && d.status === "SUBMITTED" ? html`<span class="flex"><button type="button" class="secondary sm" data-action="det-review" data-id="${d.id}" data-decision="ACCEPTED">Accept</button><button type="button" class="ghost sm" data-action="det-review" data-id="${d.id}" data-decision="REJECTED">Reject</button></span>` : ""]);
  return html`<h2>Methodology determinations</h2>
    <p class="small muted">Baseline, additionality, leakage and non-permanence risk (buffer) are never defaulted. Each value is submitted from a reviewed project document and must be accepted by a verifier other than the submitter before credits can be issued under a reviewed methodology.</p>
    ${table({ caption: "Methodology determinations", heads: ["Determination", "Version", "Status", "Summary", "Document", "Buffer", "Submitted", "Review", "Actions"], rows,
      empty: empty("No determinations submitted", "No baseline, additionality, leakage or non-permanence determinations have been submitted for this project.") })}
    ${isAdmin ? html`<details class="card"><summary><strong>Submit a determination</strong></summary><form data-form="determination" novalidate>
      <div class="row">${field({ id: "dt-kind", label: "Determination", required: true, children: html`<select id="dt-kind" name="kind">${opts([["BASELINE", "Baseline"], ["ADDITIONALITY", "Additionality"], ["LEAKAGE", "Leakage"], ["NON_PERMANENCE_RISK", "Non-permanence risk"]])}</select>` })}
        ${field({ id: "dt-buffer", label: "Buffer", optional: true, unit: "%", help: "Required for a non-permanence risk determination; from 0 up to 99.99.", children: html`<input id="dt-buffer" name="bufferPercent" type="number" inputmode="decimal" min="0" max="99.99" step="0.01">` })}</div>
      ${field({ id: "dt-doc", label: "Source document reference", required: true, help: "Identifier or link of the reviewed project document, at least 5 characters.", children: html`<input id="dt-doc" name="documentReference" required minlength="5" maxlength="500">` })}
      ${field({ id: "dt-summary", label: "Summary of the determination", required: true, help: "At least 10 characters.", children: html`<textarea id="dt-summary" name="summary" required minlength="10" maxlength="4000"></textarea>` })}
      <p><button type="submit" class="primary">Submit determination</button></p></form></details>` : ""}`;
}
