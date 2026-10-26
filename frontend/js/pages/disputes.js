// Disputes on a credit batch. A dispute is a registry control: it pauses transfers and retirements made through this system while it
// stands. It does not freeze, cancel or reverse the on-chain token, and every view says so. Statuses and history come from the server.
import { html, badge, name, table, empty, notice, opts, field, fmtTime } from "../util.js";

const CATEGORIES = ["EVIDENCE", "DOUBLE_COUNTING", "OWNERSHIP", "CALCULATION", "OTHER"];
const EVENT = { RAISED: "Raised", REVIEW_STARTED: "Review started", UPHELD: "Upheld", DISMISSED: "Dismissed", WITHDRAWN: "Withdrawn" };

export async function panel(ctx, creditId) {
  let log;
  try { log = await ctx.api.get(`/credits/${creditId}/disputes`); }
  catch (e) { if (e.status === 401) throw e; if (e.status === 403) return ""; return html`<h2>Disputes</h2>${notice("bad", html`Disputes could not be loaded: ${e.message}`)}`; }

  const me = ctx.user.id, isAdmin = ctx.can("NCCR_ADMIN");
  ctx.form("dispute", async (f) => {
    const msg = document.getElementById("dsp-error"), reason = f.elements.reason.value.trim();
    msg.textContent = reason.length < 10 ? "Describe the concern in at least 10 characters." : reason.length > 2000 ? "The description is too long (2,000 characters at most)." : "";
    if (msg.textContent) { f.elements.reason.focus(); return; }
    const ok = await ctx.confirm({ title: "Raise a dispute on this credit batch?", body: html`<p>Transfers and retirements of this batch made through the registry will be paused until the dispute is resolved by an NCCR administrator.</p><p class="small muted">This does not change the on-chain token. Your name, the reason and the time are recorded.</p>`, confirmLabel: "Raise dispute" });
    if (!ok.ok) return;
    await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post(`/credits/${creditId}/disputes`, { category: f.elements.category.value, reason }), "Dispute raised");
    ctx.refresh();
  });
  ctx.on("dsp-review", async (b) => { await ctx.run(b, () => ctx.api.post(`/disputes/${b.dataset.id}/start-review`), "Review started"); ctx.refresh(); });
  ctx.on("dsp-decide", async (b) => {
    const upheld = b.dataset.d === "UPHELD";
    const r = await ctx.confirm({ title: `${upheld ? "Uphold" : "Dismiss"} ${b.dataset.code}?`, danger: upheld, confirmLabel: upheld ? "Uphold dispute" : "Dismiss dispute", reasonLabel: "Reason for the decision", reasonRequired: true, reasonMin: 10,
      body: upheld ? html`<p>Upholding records a confirmed problem. The registry hold stays in place: transfers and retirements remain paused.</p><p class="small muted">The deployed contract has no cancellation function, so nothing on the blockchain changes. Cancelling credits needs a contract change that has not been approved or deployed.</p>` : html`<p>Dismissing releases the hold, if no other dispute on this batch is still unresolved.</p>` });
    if (!r.ok) return;
    await ctx.run(b, () => ctx.api.post(`/disputes/${b.dataset.id}/decision`, { decision: b.dataset.d, reason: r.reason }), upheld ? "Dispute upheld" : "Dispute dismissed");
    ctx.refresh();
  });
  ctx.on("dsp-withdraw", async (b) => {
    const r = await ctx.confirm({ title: `Withdraw ${b.dataset.code}?`, body: "Withdrawing releases the hold if no other dispute on this batch is unresolved.", confirmLabel: "Withdraw dispute", reasonLabel: "Reason", reasonRequired: false });
    if (!r.ok) return;
    await ctx.run(b, () => ctx.api.post(`/disputes/${b.dataset.id}/withdraw`, { reason: r.reason || undefined }), "Dispute withdrawn");
    ctx.refresh();
  });

  const actions = (d) => {
    const own = d.raised_by === me, out = [];
    if (isAdmin && !own && d.status === "OPEN") out.push(html`<button type="button" class="secondary sm" data-action="dsp-review" data-id="${d.id}">Start review</button>`);
    if (isAdmin && !own && d.status === "UNDER_REVIEW") out.push(html`<button type="button" class="primary sm" data-action="dsp-decide" data-d="UPHELD" data-id="${d.id}" data-code="${d.code}">Uphold</button> <button type="button" class="secondary sm" data-action="dsp-decide" data-d="DISMISSED" data-id="${d.id}" data-code="${d.code}">Dismiss</button>`);
    if (own && ["OPEN", "UNDER_REVIEW"].includes(d.status)) out.push(html`<button type="button" class="secondary sm" data-action="dsp-withdraw" data-id="${d.id}" data-code="${d.code}">Withdraw</button>`);
    if (isAdmin && own && ["OPEN", "UNDER_REVIEW"].includes(d.status)) out.push(html`<span class="small muted">Another administrator must review this.</span>`);
    return html`${out}`;
  };
  const held = log.disputes.filter((d) => ["OPEN", "UNDER_REVIEW", "UPHELD"].includes(d.status)).map((d) => d.code);
  return html`<h2>Disputes</h2>
    ${held.length ? notice("warn", html`<strong>Transfers and retirements of this batch are paused</strong> while ${held.join(", ")} ${held.length === 1 ? "stands" : "stand"}. ${log.note}`) : notice("info", log.note)}
    ${log.disputes.length ? table({ caption: "Disputes on this credit batch", heads: ["Dispute", "Concern", "Raised", "Status", "Decision", "Actions"],
      rows: log.disputes.map((d) => [d.code, html`<strong>${name("dcat", d.category)}</strong><br>${d.reason}`, html`${fmtTime(d.created_at)}<br><span class="small muted">${d.raised_by_name}</span>`, badge("dispute", d.status),
        d.resolution_note ? html`${d.resolution_note}<br><span class="small muted">${d.reviewer_name || ""}${d.resolved_at ? ` · ${fmtTime(d.resolved_at)}` : ""}</span>` : html`<span class="muted">${d.reviewer_name ? `Reviewer: ${d.reviewer_name}` : "No decision yet"}</span>`, actions(d)]) }) : empty("No disputes", "No concern has been raised about this credit batch.")}
    ${log.disputes.map((d) => html`<details class="card"><summary>History of ${d.code}</summary>${table({ caption: `History of ${d.code}`, heads: ["When", "Event", "By", "Note"], rows: d.events.map((e) => [fmtTime(e.created_at), EVENT[e.event_type] || e.event_type, e.actor_name, e.note || "—"]) })}</details>`)}
    <form class="card" data-form="dispute" novalidate aria-label="Raise a dispute"><h3>Raise a dispute</h3>
      <div class="row">${field({ id: "dsp-category", label: "Kind of concern", required: true, children: html`<select id="dsp-category" name="category">${opts(CATEGORIES.map((k) => [k, name("dcat", k)]), "EVIDENCE")}</select>` })}
      ${field({ id: "dsp-reason", label: "What is the concern?", required: true, help: "10 to 2,000 characters. Do not include personal contact details.", children: html`<textarea id="dsp-reason" name="reason" rows="3" maxlength="2000"></textarea>` })}</div>
      <p class="error small" id="dsp-error" role="alert"></p><button type="submit" class="secondary">Raise dispute</button></form>`;
}
