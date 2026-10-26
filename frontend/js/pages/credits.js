// Carbon assessment (estimates, methodology, approval) and the credit registry (batches, ownership, transfer, retirement).
import * as disputesUi from "./disputes.js";
import { html, raw, badge, label, name, prov, num, fmtDate, fmtTime, table, pager, empty, notice, opts, field, withQuery, hash, formData } from "../util.js";

// ───────── carbon assessment ─────────
// Rendering is driven by the methodology object the server returns (GET /carbon/methodology) and by the stored calculation
// (inputs, assumptions.parametersUsed, result, blockers), so it works for every methodology version in the registry.
const RESULT_ROWS = [["grossTCO2e", "Gross total (all pools, period)"], ["lowerBoundTCO2e", "Lower bound"], ["centralTCO2e", "Central estimate"], ["upperBoundTCO2e", "Upper bound"], ["conservativeTCO2e", "Conservative quantity"], ["bufferPercent", "Buffer deduction", "%"], ["eligibleCredits", "Eligible (whole tonnes, rounded down)", "", 0]];
const INPUT_LABELS = { areaHa: ["Restored area", "ha"], habitat: ["Habitat"], periodStart: ["Period start"], periodEnd: ["Period end"], periodDays: ["Period length", "days"], periodYears: ["Period length", "years"], survivalRatePct: ["Survival rate", "%"], canopyCoverPct: ["Canopy cover", "%"] };
const pv = (x) => (x != null && typeof x === "object" && "value" in x ? x.value : x);
const ci = (x) => (x != null && typeof x === "object" && x.ci ? ` (95% CI ${x.ci.lower} – ${x.ci.upper})` : "");
function paramValue(p) {
  if (p.value != null) return `${p.value}${ci(p)}`;
  const groups = p.byRegion || p.byEcosystem;
  return groups ? Object.entries(groups).map(([k, v]) => `${name(p.byRegion ? "region" : "eco", k)}: ${pv(v)}${ci(v)}`).join("; ") : "—";
}
export async function assessments(ctx, seg, query) {
  const priv = ctx.can("VERIFIER", "NCCR_ADMIN");
  const [m, calcs] = await Promise.all([ctx.api.get("/carbon/methodology", query.version ? { version: query.version } : undefined), priv ? ctx.api.get("/carbon/calculations", { pageSize: 15, ...query, version: undefined }) : { calculations: [], pagination: null }]);
  const href = (o) => withQuery("assessments", { ...query, ...o });
  ctx.form("filters", (f) => ctx.go(withQuery("assessments", { ...formData(f), page: "" })));
  ctx.on("approve", async (b) => {
    const dec = b.dataset.d, ok = dec === "APPROVED";
    const r = await ctx.confirm({ title: ok ? "Approve this assessment?" : "Do not approve this assessment?", body: html`<p>${ok ? `Approving makes ${b.dataset.q} whole tonne(s) eligible for credit issuance. The approver must differ from the verifier of the record.` : "The assessment will not be issued. The reason is recorded."}</p>`, confirmLabel: ok ? "Approve assessment" : "Do not approve", danger: !ok, reasonLabel: ok ? "Approval note" : "Reason", reasonRequired: !ok });
    if (r.ok) { await ctx.run(b, () => ctx.api.post(`/carbon/calculations/${b.dataset.id}/approve`, { decision: dec, notes: r.reason || "Approved for issuance" }), ok ? "Assessment approved" : "Assessment not approved"); ctx.refresh(); }
  });
  ctx.on("issue", async (b) => {
    const r = await ctx.confirm({ title: "Issue registry credits?", body: html`<p>${b.dataset.q} registry credit(s) will be issued to the project's implementing organization and recorded on the blockchain network.</p><p class="small muted">Issuance is permanent and cannot be repeated for the same record.</p>`, confirmLabel: "Issue credits" });
    if (!r.ok) return;
    const out = await ctx.run(b, () => ctx.api.post(`/carbon/calculations/${b.dataset.id}/issue`));
    ctx.toast(`Credits issued (block ${out.tx.blockNumber ?? "pending"})`); ctx.go(`#/credits/${out.credit.id}`);
  });
  const status = m.illustrativeOnly
    ? notice("warn", html`<strong>Illustrative method.</strong> ${m.version} uses unvalidated placeholder parameters and is limited to the reference dataset. Its estimates must not be represented as accredited, validated or tradable carbon credits.`)
    : m.status === "APPROVED" ? notice("info", html`<strong>${m.version}</strong> has a recorded independent review. Issuance still requires accepted determinations and an approver who differs from the verifier.`)
      : notice("warn", html`<strong>Pending independent review.</strong> The parameters of ${m.version} are transcribed from the cited source and have not been independently reviewed. No quantity under this method can be issued until a review is recorded and the required determinations (${(m.requiredDeterminations || []).map((k) => name("det", k)).join(", ") || "none"}) are accepted for the project.`);
  const blockerList = (c) => (c.blockers || []).length ? html`<h3>Issuance blockers recorded at calculation</h3><ul>${c.blockers.map((b) => html`<li><code>${b.code}</code> — ${b.detail}</li>`)}</ul><p class="small muted">Approval and issuance check these conditions again on the server and state the current reason if they are not met.</p>` : html`<p class="small muted">No issuance blockers were recorded when this assessment was calculated.</p>`;
  const resultRows = (c) => RESULT_ROWS.filter(([k]) => c.result && c.result[k] != null).map(([k, text, unit, d]) => html`<dt>${text}</dt><dd>${num(c.result[k], d ?? 4)} ${unit ?? "tCO₂e"}</dd>`);
  const inputRows = (c) => Object.entries(c.inputs || {}).filter(([, v]) => v == null || typeof v !== "object").map(([k, v]) => { const [text, unit] = INPUT_LABELS[k] || [name("", k)]; return html`<dt>${text}</dt><dd>${k === "habitat" ? name("eco", v) : typeof v === "number" ? num(v, 4) : String(v ?? "—")}${unit ? ` ${unit}` : ""}</dd>`; });
  const used = (c) => (c.assumptions?.parametersUsed || []).length ? table({ caption: `Parameters used for ${c.record_code}`, heads: ["Parameter", "Value", "Unit", "Status"], rows: c.assumptions.parametersUsed.map((p) => [p.label || p.id, paramValue(p), p.unit || "—", badge("validation", p.approval)]) }) : "";
  return {
    title: "Carbon assessment", crumbs: [["Overview", "#/overview"], ["Carbon assessment"]], lede: "Estimates for verified records, their inputs and assumptions, and approval before credit issuance.",
    body: html`${status}
      ${priv ? html`<form class="filters" data-form="filters" data-autosubmit aria-label="Filter assessments"><div><label for="approval">Approval status</label><select id="approval" name="approval">${opts(["PENDING", "APPROVED", "REJECTED"].map((s) => [s, label("assessment", s)]), query.approval, "All")}</select></div></form>
      ${table({ caption: "Current carbon assessments", heads: ["Record", "Version", "Central (tCO₂e)", "Conservative (tCO₂e)", "Eligible (whole tonnes)", "Assessed", "Status", "Actions"],
        rows: calcs.calculations.map((c) => [html`<a href="#/records/${c.record_id}">${c.record_code}</a><br><span class="small muted">${c.project_code} · ${name("eco", c.ecosystem_type)}</span>`, html`${c.assessment_no} · <a href="${href({ version: c.methodology_version, page: "" })}">${c.methodology_version}</a>${(c.blockers || []).length ? html`<br><span class="badge warn">${c.blockers.length} issuance blocker${c.blockers.length === 1 ? "" : "s"}</span>` : ""}`, num(c.central_tco2e ?? c.estimate_tco2e), num(c.conservative_tco2e ?? c.low_tco2e), c.eligible_credits, html`${fmtTime(c.calculated_at)}<br><span class="small muted">${c.calculated_by_name}</span>`, html`${badge("assessment", c.approval_status)}${c.approved_by_name ? html`<br><span class="small muted">${c.approved_by_name}</span>` : ""}`,
          c.credited ? badge("credit", "ISSUED") : ctx.can("NCCR_ADMIN") ? (c.approval_status === "PENDING" ? html`<button type="button" class="primary sm" data-action="approve" data-d="APPROVED" data-id="${c.id}" data-q="${c.eligible_credits}">Approve</button> <button type="button" class="secondary sm" data-action="approve" data-d="REJECTED" data-id="${c.id}" data-q="${c.eligible_credits}">Do not approve</button>` : c.approval_status === "APPROVED" ? html`<button type="button" class="primary sm" data-action="issue" data-id="${c.id}" data-q="${c.eligible_credits}">Issue credits</button>` : "") : ""]),
        empty: empty("No assessments", "An assessment is calculated for a record after it is verified.") })}${calcs.pagination ? pager(calcs.pagination, (n) => href({ page: n })) : ""}
      ${calcs.calculations.length ? html`<h2>Calculation detail</h2>${calcs.calculations.map((c) => html`<details class="card"><summary><strong>${c.record_code}</strong> — assessment ${c.assessment_no}: inputs, result and parameters</summary><div class="grid g2"><div><h3>Inputs</h3><dl class="kv">${inputRows(c)}<dt>Input hash</dt><dd>${hash(c.input_hash, 10)}</dd><dt>Methodology hash</dt><dd>${hash(c.methodology_hash, 10)}</dd></dl></div>
        <div><h3>Result</h3><dl class="kv">${resultRows(c)}</dl>${c.result?.note ? html`<p class="small muted">${c.result.note}</p>` : ""}</div></div>${used(c)}${blockerList(c)}</details>`)}` : ""}` : ""}
      <h2>Methodology and assumptions — ${m.version}</h2><section class="card"><p><strong>${m.title}</strong></p><p>${m.scope || ""}</p>
        <h3>Parameters and their sources</h3>${table({ caption: "Methodology parameters", heads: ["Parameter", "Value", "Unit", "Status", "Source"], rows: Object.values(m.parameters || {}).map((p) => [p.label, paramValue(p), p.unit || "—", badge("validation", p.approval), [p.source, p.table, p.page ? `p. ${p.page}` : ""].filter(Boolean).join(", ") || "No source recorded"]) })}
        ${m.unitConversion ? html`<h3>Unit conversion</h3><p>${m.unitConversion.expression} = ${num(m.unitConversion.value, 4)} ${m.unitConversion.unit}. ${m.unitConversion.note}</p>` : ""}
        <h3>Uncertainty</h3><p>${m.uncertaintyApproach?.description || "—"}</p><h3>Buffer</h3><p>${m.bufferRule || "—"}</p><h3>Rounding</h3><p>${m.rounding || "—"}</p>
        <h3>Required determinations</h3><ul>${(m.requiredDeterminations || []).map((k) => html`<li>${name("det", k)}</li>`)}</ul>
        ${(m.references || []).length ? html`<h3>References</h3><ul>${m.references.map((r) => html`<li>${r.citation}</li>`)}</ul>` : ""}
        <p class="small muted">Parameters hash: ${hash(m.parametersHash, 10)}</p></section>`,
  };
}

// ───────── credit registry ─────────
export async function registry(ctx, seg, query) {
  if (seg[0]) return batch(ctx, seg[0]);
  const r = await ctx.api.get("/credits", { pageSize: 15, ...query });
  const p = r.pagination, href = (o) => withQuery("credits", { ...query, ...o });
  ctx.form("filters", (f) => ctx.go(withQuery("credits", { ...formData(f), page: "" })));
  return {
    title: "Credit registry", crumbs: [["Overview", "#/overview"], ["Credit registry"]], lede: "Registry credit batches issued from verified and approved assessments, with ownership and retirement.",
    body: html`${notice("info", "Registry credits record approved quantities for traceability. They are not accredited under an external carbon standard and carry no legal recognition.")}
      <form class="filters" data-form="filters" data-autosubmit role="search" aria-label="Filter credit batches"><div class="grow"><label for="q">Search</label><input id="q" name="q" type="search" value="${query.q || ""}" placeholder="Batch, project or record code"></div>
        <div><label for="status">Status</label><select id="status" name="status">${opts(["ISSUED", "PARTIALLY_RETIRED", "RETIRED", "PARTIALLY_CANCELLED", "CANCELLED"].map((s) => [s, label("credit", s)]), query.status, "All")}</select></div><div><button type="submit" class="secondary">Apply</button> <a class="btn ghost" href="#/credits">Clear</a></div></form>
      ${table({ caption: "Credit batches", sort: p, sortBase: (k, d) => href({ sort: k, dir: d, page: "" }), heads: [["Batch", "batch"], ["Project", "project"], "Record", "Holder at issuance", ["Quantity (tCO₂e)", "quantity"], "Retired", "Status", ["Issued", "issued"], "Transaction"],
        rows: r.credits.map((c) => [html`<a href="#/credits/${c.id}">${c.batch_code}</a>`, html`${c.project_code}<br><span class="small muted">${c.project_name}</span> ${prov(c.data_origin)}`, html`<a href="#/records/${c.record_id}">${c.record_code}</a>`, c.holder_org_name, num(c.amount_tonnes, 0), num(c.retired_tonnes, 0), badge("credit", c.status), fmtDate(c.issued_at), hash(c.tx_hash, 6)]),
        empty: empty("No credit batches", "Batches appear after an approved assessment is issued.") })}${pager(p, (n) => href({ page: n }))}`,
  };
}

async function batch(ctx, id) {
  const disputePanel = await disputesUi.panel(ctx, id);
  const [{ credit: c, events, balances }, { organizations }] = await Promise.all([ctx.api.get(`/credits/${id}`), ctx.api.get("/organizations")]);
  const mine = balances.find((b) => b.org_id === ctx.user.organizationId);
  const canAct = !c.is_frozen && c.status !== "CANCELLED" && (ctx.can("FIELD_USER") ? !!mine && mine.balance > 0 : ctx.can("NCCR_ADMIN"));
  ctx.form("move", async (f, e) => {
    const kind = e.submitter?.value; if (!kind) return;
    const amount = Number(f.elements.amount.value), err = f.querySelector("#amount-err"); err.textContent = "";
    const holder = f.elements.fromOrgId ? Number(f.elements.fromOrgId.value) : ctx.user.organizationId, bal = balances.find((b) => b.org_id === holder)?.balance || 0;
    if (!Number.isInteger(amount) || amount < 1) return (err.textContent = "Enter a whole number of at least 1.");
    if (amount > bal) return (err.textContent = `The holder has only ${num(bal, 0)} credit(s) in this batch.`);
    if (kind === "retire" && f.elements.reason.value.trim().length < 5) { f.querySelector("#reason-err").textContent = "Enter a reason (at least 5 characters) to retire credits."; return f.elements.reason.focus(); }
    const to = organizations.find((o) => String(o.id) === f.elements.toOrgId.value);
    const ok = await ctx.confirm({ title: kind === "transfer" ? `Transfer ${amount} credit(s)?` : `Retire ${amount} credit(s)?`, danger: kind === "retire", confirmLabel: kind === "transfer" ? "Transfer credits" : "Retire permanently",
      body: html`<p>${kind === "transfer" ? `Ownership of ${amount} credit(s) in batch ${c.batch_code} moves to ${to?.name}.` : `${amount} credit(s) in batch ${c.batch_code} will be retired. Retirement is permanent and cannot be reversed.`}</p><p class="small muted">The action is signed and recorded on the blockchain network. If the network is unavailable nothing is changed and you can retry.</p>` });
    if (!ok.ok) return;
    const body = kind === "transfer" ? { amount, toOrgId: Number(f.elements.toOrgId.value), fromOrgId: f.elements.fromOrgId ? holder : undefined } : { amount, reason: f.elements.reason.value, fromOrgId: f.elements.fromOrgId ? holder : undefined };
    const out = await ctx.run(e.submitter, () => ctx.api.post(`/credits/${id}/${kind}`, body));
    ctx.toast(`${kind === "transfer" ? "Transfer" : "Retirement"} confirmed${out.tx?.blockNumber != null ? ` in block ${out.tx.blockNumber}` : ""}`); ctx.refresh();
  });
  return {
    title: html`Credit batch ${c.batch_code} ${badge("credit", c.status)}`, crumbs: [["Overview", "#/overview"], ["Credit registry", "#/credits"], [c.batch_code]], lede: html`${c.project_code} — ${c.project_name} ${prov(c.data_origin)}`,
    actions: html`<a class="btn secondary" href="#/verify/${c.batch_code}">Public verification page</a>`,
    body: html`${c.is_frozen ? notice("warn", "This credit batch is frozen under dispute on the blockchain contract. Direct transfers and retirements are restricted until the dispute is resolved.") : ""}
      ${c.status === "CANCELLED" ? notice("warn", "This credit batch has been cancelled on-chain following an upheld dispute and can no longer be transferred or retired.") : ""}
      <div class="grid g2"><section class="card"><h2>Batch</h2><dl class="kv"><dt>Credit type</dt><dd>${c.credit_label} <span class="small muted">(not accredited under an external standard)</span></dd><dt>Project</dt><dd><a href="#/projects/${c.project_id}">${c.project_code}</a></dd><dt>Monitoring record</dt><dd><a href="#/records/${c.record_id}">${c.record_code}</a></dd>
        <dt>Quantity issued</dt><dd>${num(c.amount_tonnes, 0)} (1 unit = 1 tCO₂e of the approved assessment)</dd><dt>Retired</dt><dd>${num(c.retired_tonnes, 0)}</dd>${c.cancelled_tonnes > 0 ? html`<dt>Cancelled</dt><dd>${num(c.cancelled_tonnes, 0)}</dd>` : ""}<dt>Assessment</dt><dd>version ${c.assessment_no}, ${num(c.estimate_tco2e)} tCO₂e estimated (${c.methodology_version})</dd><dt>Issued</dt><dd>${fmtTime(c.issued_at)}</dd><dt>Block</dt><dd>${c.block_number ?? "—"}</dd><dt>Issuance transaction</dt><dd>${hash(c.tx_hash, 12)}</dd></dl></section>
      <section class="card"><h2>Current holders</h2>${table({ caption: "Holders", heads: ["Holder", "Wallet address", "Registry balance", "On-chain balance", "Match"], rows: balances.filter((b) => b.balance > 0 || b.onChainBalance > 0).map((b) => [b.name, hash(b.wallet_address, 6), num(b.balance, 0), b.onChainBalance == null ? "Unavailable" : num(b.onChainBalance, 0), b.onChainBalance == null ? badge("tx", "UNKNOWN") : b.onChainBalance === b.balance ? badge("tx", "CONFIRMED") : badge("tx", "FAILED")]), empty: empty("No current holders", "All credits in this batch have been retired.") })}
        <p class="small muted">The registry balance is the database record; the on-chain balance is read from the smart contract. They should match.</p></section></div>
    <h2>Issuance, transfer and retirement history</h2>${table({ caption: "Credit events", heads: ["When", "Event", "From", "To", "Quantity", "Reason", "Transaction"], rows: events.map((e) => [fmtTime(e.created_at), ({ ISSUED: "Issued", TRANSFERRED: "Transferred", RETIRED: "Retired", CANCELLED: "Cancelled" })[e.event_type] || e.event_type, e.from_org || "—", e.to_org || "—", num(e.amount, 0), e.reason || "—", hash(e.tx_hash, 8)]) })}
    ${disputePanel}
    ${canAct ? html`<h2>Transfer or retire</h2><form class="card" data-form="move" novalidate>${ctx.can("NCCR_ADMIN") ? field({ id: "fromOrgId", label: "On behalf of holder", required: true, children: html`<select id="fromOrgId" name="fromOrgId">${balances.filter((b) => b.balance > 0).map((b) => html`<option value="${b.org_id}">${b.name} (${num(b.balance, 0)})</option>`)}</select>` }) : ""}
      <div class="row">${field({ id: "amount", label: "Quantity", required: true, unit: "credits", help: "Whole number", children: html`<input id="amount" name="amount" type="number" min="1" step="1" value="1">` })}${field({ id: "toOrgId", label: "Transfer to", children: html`<select id="toOrgId" name="toOrgId">${organizations.filter((o) => o.wallet_address).map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select>` })}</div>
      ${field({ id: "reason", label: "Retirement reason", optional: true, help: "Required to retire credits", children: html`<input id="reason" name="reason" maxlength="500">` })}
      <p class="flex"><button name="k" value="transfer" class="secondary">Transfer credits</button><button name="k" value="retire" class="danger">Retire credits</button></p>
      <p class="small muted">Signing is performed by the registry on a local development network. A production deployment would require the holder's own wallet signature.</p></form>` : ""}`,
  };
}
