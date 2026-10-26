// Blockchain network: connection state, contract details, durable operations and the transaction register.
import { html, badge, name, num, fmtTime, table, pager, empty, notice, withQuery, hash, formData, opts } from "../util.js";

export async function page(ctx, seg, query) {
  const [st, tx] = await Promise.all([ctx.api.get("/chain/status"), ctx.api.get("/chain/transactions", { pageSize: 20, ...query })]);
  const sys = ctx.can("NCCR_ADMIN") ? await ctx.api.get("/system/status").catch(() => null) : null;
  const ops = ctx.can("NCCR_ADMIN") ? await ctx.api.get("/chain/operations", { pageSize: 10 }).catch(() => null) : null;
  const href = (o) => withQuery("network", { ...query, ...o });
  ctx.form("filters", (f) => ctx.go(withQuery("network", { ...formData(f), page: "" })));
  ctx.on("reconcile", async (b) => {
    const r = await ctx.confirm({ title: "Run reconciliation now?", body: "Interrupted blockchain operations are resumed: transactions are checked against the network and confirmed results are applied to the registry exactly once.", confirmLabel: "Run reconciliation" });
    if (!r.ok) return;
    const s = await ctx.run(b, () => ctx.api.post("/system/reconcile"));
    ctx.toast(`Reconciliation finished: ${s.completed} completed, ${s.stillPending} still pending, ${s.failed} failed.`, s.stillPending || s.failed ? "warn" : ""); ctx.refresh();
  });
  const local = st.mode === "local";
  return {
    title: "Blockchain network", crumbs: [["Overview", "#/overview"], ["Blockchain network"]], lede: "Network connection, smart contract and the register of transactions written by this registry.",
    actions: ctx.can("NCCR_ADMIN") ? html`<button type="button" class="secondary" data-action="reconcile">Run reconciliation</button>` : "",
    body: html`${st.ready ? "" : notice("bad", html`<strong>Network not connected.</strong> ${st.error}. Records are saved; blockchain actions are stored and retried automatically after the connection returns.`)}
      ${st.ready && local ? notice("info", "Connected to a local development network. Transactions are confirmed by that network only; they are not confirmed by any public blockchain.") : ""}
      <div class="grid g2"><section class="card"><h2>Network connection</h2><dl class="kv"><dt>Connection status</dt><dd>${st.ready ? html`<span class="badge ok">Connected</span>` : html`<span class="badge bad">Not connected</span>`}</dd>
        <dt>Chain ID</dt><dd>${st.chainId ?? "—"}</dd><dt>Latest block</dt><dd>${st.blockNumber ?? "—"}</dd><dt>RPC endpoint</dt><dd><code>${st.rpcEndpoint}</code></dd><dt>Signing mode</dt><dd>${local ? "Local development accounts" : "Service signing keys from the environment"}</dd></dl></section>
        <section class="card"><h2>Smart contract</h2>${st.ready ? html`<dl class="kv"><dt>Contract address</dt><dd>${hash(st.contractAddress, 38)}</dd><dt>Credit name</dt><dd>${st.tokenName} (${st.tokenSymbol})</dd><dt>Registry administrator</dt><dd>${hash(st.admin, 38)}</dd><dt>Credits issued</dt><dd>${num(st.totalIssued, 0)}</dd><dt>Credits retired</dt><dd>${num(st.totalRetired, 0)}</dd><dt>Deployed</dt><dd>${st.deployment?.deployedAt ? fmtTime(st.deployment.deployedAt) : "—"}</dd></dl>` : html`<p class="muted">Contract details are unavailable while the network is not connected.</p>`}</section></div>
      ${sys ? html`<section class="card"><h2>Registry operations</h2><p class="small muted">Each on-chain action is stored as an operation before it is sent, so an interruption never loses or duplicates it.</p>
        <div class="flex">${Object.entries(sys.operations || {}).map(([k, v]) => html`<span>${badge("op", k)} ${v}</span>`)}${!Object.keys(sys.operations || {}).length ? html`<span class="muted">No operations yet.</span>` : ""}</div>
        ${ops && ops.operations.filter((o) => o.status !== "COMPLETED").length ? table({ caption: "Operations needing attention", heads: ["Operation", "Type", "Record", "Status", "Attempts", "Last error", "Updated"], rows: ops.operations.filter((o) => o.status !== "COMPLETED").map((o) => [`#${o.id}`, o.op_type.replaceAll("_", " ").toLowerCase(), o.record_code || o.project_code || "—", badge("op", o.status), o.attempts, o.last_error || "—", fmtTime(o.updated_at)]) }) : html`<p class="small">No operations are waiting.</p>`}</section>` : ""}
      <h2>Transaction register</h2><form class="filters" data-form="filters" data-autosubmit role="search" aria-label="Filter transactions"><div class="grow"><label for="q">Search</label><input id="q" name="q" type="search" value="${query.q || ""}" placeholder="Transaction hash, project or record code"></div>
        <div><label for="type">Type</label><select id="type" name="type">${opts(["PROJECT_REGISTERED", "RECORD_ANCHORED", "RECORD_REANCHORED", "VERIFICATION_RECORDED", "CREDITS_ISSUED", "CREDITS_TRANSFERRED", "CREDITS_RETIRED", "ROLE_CHANGED"].map((t) => [t, name("tx", t)]), query.type, "All types")}</select></div><div><button type="submit" class="secondary">Apply</button></div></form>
      ${table({ caption: "Blockchain transactions", heads: ["Block", "When", "Type", "Project", "Record", "Detail", "Signing account", "Status", "Transaction hash"], rows: tx.transactions.map((t) => [t.block_num, fmtTime(t.created_at), name("tx", t.tx_type), t.project_code || "—", t.record_code || "—", t.detail, hash(t.from_addr, 4), badge("tx", t.status), hash(t.tx_hash, 10)]), empty: empty("No transactions", "Transactions appear once records are anchored, verified or credited.") })}${pager(tx.pagination, (n) => href({ page: n }))}
      <p>Check a specific record or credit batch against the network on the <a href="#/verify">public verification page</a>.</p>`,
  };
}
