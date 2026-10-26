// Public verification: compares a record's stored hash with the content recomputed from the registry and the hash anchored on-chain.
import { html, badge, name, prov, num, fmtTime, table, empty, notice, hash } from "../util.js";

export async function page(ctx, seg) {
  const code = seg[0] ? decodeURIComponent(seg[0]) : "";
  let result = null, error = null;
  if (code) { try { result = await ctx.api.get(`/public/verify/${encodeURIComponent(code)}`); } catch (e) { error = e; } }
  ctx.form("verify", (f) => { const c = f.elements.code.value.trim(); if (c) location.hash = `#/verify/${encodeURIComponent(c)}`; });
  const reg = !code ? await ctx.api.get("/public/registry") : null;
  return {
    title: "Public verification", lede: "Check whether a monitoring record or credit batch matches what was anchored on the blockchain network.",
    body: html`<form class="card" data-form="verify" role="search"><label for="code">Record code or credit batch</label><div class="flex"><input id="code" name="code" value="${code}" placeholder="For example MR-00001 or CB-00001" required><button type="submit" class="primary">Verify</button></div></form>
      ${error ? notice(error.status === 404 ? "warn" : "bad", error.status === 404 ? html`No record or credit batch was found for <strong>${code}</strong>. Check the identifier and try again.` : error.message) : ""}
      ${result ? view(result) : ""}
      ${reg ? html`<h2>Registry summary</h2><div class="notice info">${icon()}<div>${reg.disclaimer}</div></div><div class="grid g4"><div class="kpi"><div class="v">${reg.projects.length}</div><div class="l">Projects</div></div><div class="kpi"><div class="v">${num(reg.totals.issued, 0)}</div><div class="l">Credits issued</div></div><div class="kpi"><div class="v">${num(reg.totals.retired, 0)}</div><div class="l">Credits retired</div></div></div>
        <h2>Credit batches</h2>${table({ caption: "Credit batches", heads: ["Batch", "Project", "Record", "Quantity", "Retired", "Status", "Issued", "Transaction"], rows: reg.credits.map((c) => [html`<a href="#/verify/${c.batch_code}">${c.batch_code}</a>`, html`${c.project_code} ${prov(c.data_origin)}`, c.record_code, num(c.quantity, 0), num(c.retired, 0), badge("credit", c.status), fmtTime(c.issued_at), hash(c.tx_hash, 6)]), empty: empty("No credit batches", "") })}` : ""}`,
  };
}
const icon = () => "";

function view(v) {
  const c = v.checks;
  const explain = html`<section class="card"><h2>What this verification does and does not show</h2><div class="grid g2"><div><h3>Verified here</h3><ul><li>The stored record content produces the same hash as the one recorded when it was submitted.</li><li>That hash matches the hash anchored on the blockchain network for this record.</li><li>The status held in the registry agrees with the status recorded on the network.</li></ul></div>
    <div><h3>Not verified here</h3><ul><li>That the measurements, locations or images are true.</li><li>That restoration took place or carbon was removed.</li><li>Accreditation under an external carbon standard or legal recognition of any credit.</li></ul></div></div></section>`;
  return html`<h2>${v.code} · ${v.project} ${prov(v.provenance)}</h2><p class="muted">${v.projectName} · revision ${v.revision} · registry status ${badge("record", v.status)}</p>
    ${v.consistent === true ? notice("ok", html`<strong>Record integrity confirmed.</strong> The stored record, its recomputed hash and the anchored hash agree.`) : v.consistent === false ? notice("bad", html`<strong>Mismatch detected.</strong> The registry and the blockchain network disagree for this record. Review the checks below.`) : notice("warn", html`<strong>Blockchain comparison unavailable.</strong> ${v.onChainError || "The network could not be reached."} Integrity could not be checked against the network.`)}
    <div class="grid g2"><section class="card"><h3>Integrity checks</h3>${c ? html`<dl class="kv"><dt>Stored hash equals recomputed hash</dt><dd>${badge("tx", c.storedMatchesRecomputed ? "CONFIRMED" : "FAILED")}</dd><dt>Anchored hash equals stored hash</dt><dd>${badge("tx", c.onChainMatchesStored ? "CONFIRMED" : "FAILED")}</dd><dt>Status consistent with the network</dt><dd>${badge("tx", c.statusConsistent ? "CONFIRMED" : "FAILED")}</dd></dl>` : html`<p class="muted">Not available.</p>`}
        <h3>Content hash</h3><dl class="kv"><dt>Stored</dt><dd>${hash(v.hashes.stored, 14)}</dd><dt>Recomputed</dt><dd>${hash(v.hashes.recomputed, 14)}</dd><dt>On the network</dt><dd>${hash(v.onChain?.contentHash, 14)}</dd></dl><p class="small muted">A matching hash proves consistency with the hashed content only.</p></section>
      <section class="card"><h3>Blockchain network</h3><dl class="kv"><dt>Chain ID</dt><dd>${v.network?.chainId ?? "—"}</dd><dt>Smart contract</dt><dd>${hash(v.network?.contractAddress, 38)}</dd><dt>Latest block</dt><dd>${v.network?.blockNumber ?? "—"}</dd><dt>Network record status</dt><dd>${v.onChain ? v.onChain.status.replaceAll("_", " ").toLowerCase() : "—"}</dd><dt>Anchoring transaction</dt><dd>${hash(v.anchorTx, 12)}</dd>
        ${v.onChain?.verifier && v.onChain.verifier !== "0x0000000000000000000000000000000000000000" ? html`<dt>Verification recorded by</dt><dd>${hash(v.onChain.verifier, 38)}</dd>` : ""}</dl></section></div>
    ${v.credit ? html`<h3>Credit batch ${v.credit.batch}</h3><p>${num(v.credit.quantity, 0)} issued · ${num(v.credit.retired, 0)} retired · ${badge("credit", v.credit.status)} · ${v.credit.label} · issuance transaction ${hash(v.credit.txHash, 8)}</p>
      ${table({ caption: "Credit events", heads: ["When", "Event", "From", "To", "Quantity", "Transaction"], rows: v.events.map((e) => [fmtTime(e.created_at), ({ ISSUED: "Issued", TRANSFERRED: "Transferred", RETIRED: "Retired" })[e.event_type], e.from_org || "—", e.to_org || "—", num(e.amount, 0), hash(e.tx_hash, 8)]) })}` : html`<p class="muted">No credits have been issued for this record.</p>`}
    <p class="small muted">${v.disclaimer}</p>${explain}`;
}
