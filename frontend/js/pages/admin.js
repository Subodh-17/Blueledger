// Administration (users, organizations, chain roles, system health and configuration), audit log, and account settings.
import * as gov from "./governance.js";
import { html, raw, badge, name, num, fmtTime, table, pager, empty, notice, opts, field, withQuery, hash, formData, actionLabel, label } from "../util.js";

export async function page(ctx, seg, query) {
  const tab = query.tab || "users";
  const tabs = [["users", "Users and roles"], ["organizations", "Organizations"], ["system", "System health and configuration"], ["methodology", "Methodology review"], ["settings", "Runtime settings"], ["roles", "On-chain roles"]];
  const nav = html`<nav class="tabs" aria-label="Administration sections">${tabs.map(([k, l]) => html`<a href="#/administration?tab=${k}" ${tab === k ? raw('aria-current="page"') : ""}>${l}</a>`)}</nav>`;
  const sections = { organizations: () => orgs(ctx), system: () => system(ctx), methodology: () => gov.methodology(ctx), settings: () => gov.settings(ctx), roles: () => gov.roles(ctx) };
  const body = await (sections[tab] || (() => users(ctx, query)))();
  return { title: "Administration", crumbs: [["Overview", "#/overview"], ["Administration"]], lede: "Manage users, organizations and on-chain roles, and monitor the health of registry services.", body: html`${nav}${body}` };
}

async function users(ctx, query) {
  const [r, { organizations }] = await Promise.all([ctx.api.get("/users", { pageSize: 15, sort: "name", ...query, tab: undefined }), ctx.api.get("/organizations")]);
  const href = (o) => withQuery("administration", { ...query, tab: "users", ...o });
  ctx.form("filters", (f) => ctx.go(withQuery("administration", { tab: "users", ...formData(f), page: "" })));
  ctx.form("user", async (f) => {
    const d = formData(f); f.querySelectorAll(".field-error").forEach((x) => (x.textContent = ""));
    await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post("/users", { ...d, organizationId: d.organizationId ? Number(d.organizationId) : undefined, walletAddress: d.walletAddress || undefined }), "User created").catch((e) => { if (e.details) Object.entries(e.details).forEach(([k, v]) => { const el = f.querySelector(`#${k}-err`); if (el) el.textContent = v; }); throw e; });
    ctx.refresh();
  });
  ctx.on("active", async (b) => {
    const to = b.dataset.active === "1";
    const c = await ctx.confirm({ title: to ? "Reactivate this user?" : "Deactivate this user?", body: to ? "The user can sign in again." : "The user is signed out immediately and cannot sign in. Records they created are kept.", confirmLabel: to ? "Reactivate" : "Deactivate", danger: !to });
    if (c.ok) { await ctx.run(b, () => ctx.api.patch(`/users/${b.dataset.id}`, { isActive: to }), "User updated"); ctx.refresh(); }
  });
  ctx.on("chainrole", async (b) => {
    const granted = b.dataset.granted === "1";
    const c = await ctx.confirm({ title: `${granted ? "Grant" : "Revoke"} on-chain ${b.dataset.role} role?`, body: html`<p>The registry administrator signs a transaction ${granted ? "granting" : "revoking"} the ${b.dataset.role} role for ${b.dataset.who}'s wallet address on the smart contract.</p><p class="small muted">Verifiers cannot issue credits and the registry administrator cannot verify records (separation of duties).</p>`, confirmLabel: granted ? "Grant role" : "Revoke role" });
    if (!c.ok) return;
    const out = await ctx.run(b, () => ctx.api.post(`/users/${b.dataset.id}/chain-role`, { role: b.dataset.role, granted }));
    ctx.toast(`Role updated on the blockchain network${out.tx ? ` (transaction ${out.tx.slice(0, 12)}…)` : ""}`); ctx.refresh();
  });
  return html`<form class="filters" data-form="filters" data-autosubmit role="search" aria-label="Filter users"><div class="grow"><label for="q">Search</label><input id="q" name="q" type="search" value="${query.q || ""}" placeholder="Name or email"></div>
      <div><label for="role">Role</label><select id="role" name="role">${opts(["FIELD_USER", "VERIFIER", "NCCR_ADMIN"].map((x) => [x, name("role", x)]), query.role, "All roles")}</select></div><div><button type="submit" class="secondary">Apply</button></div></form>
    ${table({ caption: "Users", heads: ["Name", "Email", "Role", "Organization", "Wallet address", "Status", "Actions"], rows: r.users.map((u) => [u.name, u.email, name("role", u.role), u.organization_name || "—", u.wallet_address ? hash(u.wallet_address, 6) : "—", badge("active", String(u.is_active)),
      html`${u.id === ctx.user.id ? html`<span class="muted small">your account</span>` : html`<button type="button" class="secondary sm" data-action="active" data-id="${u.id}" data-active="${u.is_active ? 0 : 1}">${u.is_active ? "Deactivate" : "Reactivate"}</button>`}
        ${u.role === "VERIFIER" && u.wallet_address ? html`<button type="button" class="secondary sm" data-action="chainrole" data-id="${u.id}" data-role="verifier" data-granted="1" data-who="${u.name}">Grant on-chain verifier role</button><button type="button" class="ghost sm" data-action="chainrole" data-id="${u.id}" data-role="verifier" data-granted="0" data-who="${u.name}">Revoke</button>` : ""}`]) })}${pager(r.pagination, (n) => href({ page: n }))}
    <details class="card"><summary><strong>Create user</strong></summary><form data-form="user" novalidate><div class="row">${field({ id: "name", label: "Full name", required: true, children: html`<input id="name" name="name" required maxlength="120">` })}${field({ id: "email", label: "Email address", required: true, children: html`<input id="email" name="email" type="email" required>` })}
      ${field({ id: "password", label: "Temporary password", required: true, help: "At least 12 characters; avoid common passwords and personal details.", children: html`<input id="password" name="password" type="password" minlength="12" autocomplete="new-password" required>` })}</div>
      <div class="row">${field({ id: "newRole", label: "Role", required: true, children: html`<select id="newRole" name="role">${opts(["FIELD_USER", "VERIFIER", "NCCR_ADMIN"].map((x) => [x, name("role", x)]))}</select>` })}${field({ id: "organizationId", label: "Organization", optional: true, children: html`<select id="organizationId" name="organizationId"><option value="">None</option>${organizations.map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select>` })}
      ${field({ id: "walletAddress", label: "Wallet address", optional: true, help: "Required for on-chain verifier actions", children: html`<input id="walletAddress" name="walletAddress" placeholder="0x…">` })}</div><p><button type="submit" class="primary">Create user</button></p></form></details>`;
}

async function orgs(ctx) {
  const { organizations } = await ctx.api.get("/organizations");
  ctx.form("org", async (f) => { const d = formData(f); await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post("/organizations", { name: d.name, orgType: d.orgType, walletAddress: d.walletAddress || undefined }), "Organization created"); ctx.refresh(); });
  return html`${table({ caption: "Organizations", heads: ["Name", "Type", "Wallet address (credit holder)"], rows: organizations.map((o) => [o.name, name("org", o.org_type), o.wallet_address ? hash(o.wallet_address, 6) : html`<span class="muted">none</span>`]) })}
    <details class="card"><summary><strong>Register organization</strong></summary><form data-form="org" novalidate><div class="row">${field({ id: "oname", label: "Name", required: true, children: html`<input id="oname" name="name" required maxlength="200">` })}${field({ id: "orgType", label: "Type", required: true, children: html`<select id="orgType" name="orgType">${opts(["NGO", "COMMUNITY", "PANCHAYAT", "RESEARCH", "VERIFICATION_BODY", "CREDIT_HOLDER", "REGULATOR"].map((x) => [x, name("org", x)]))}</select>` })}
      ${field({ id: "owallet", label: "Wallet address", optional: true, help: "Needed to receive credits", children: html`<input id="owallet" name="walletAddress" placeholder="0x…">` })}</div><p><button type="submit" class="primary">Register organization</button></p></form></details>`;
}

async function system(ctx) {
  const s = await ctx.api.get("/system/status");
  const row = (l, ok, text, extra) => html`<dt>${l}</dt><dd>${ok === null ? html`<span class="badge neutral">${text}</span>` : html`<span class="badge ${ok ? "ok" : "bad"}">${text}</span>`} ${extra || ""}</dd>`;
  const ipfs = s.evidenceStorage.ipfs;
  return html`<div class="grid g2"><section class="card"><h2>Service health</h2><dl class="kv">
      ${row("Registry database", s.database.connected, s.database.connected ? "Connected" : "Not connected", s.database.connected ? html`<span class="small muted">${s.database.latencyMs} ms · ${s.database.migrationsApplied} migrations applied</span>` : s.database.error)}
      ${row("Blockchain network", s.blockchain.ready, s.blockchain.ready ? "Connected" : "Not connected", s.blockchain.ready ? html`<span class="small muted">chain ${s.blockchain.chainId}, block ${s.blockchain.blockNumber}</span>` : s.blockchain.error)}
      ${row("Evidence storage (server)", s.evidenceStorage.writable, s.evidenceStorage.writable ? "Writable" : "Not writable")}
      ${row("IPFS pinning", ipfs.configured ? (ipfs.reachable === false ? false : ipfs.reachable ? true : null) : null, !ipfs.configured ? "Not configured" : ipfs.reachable === false ? "Unreachable" : ipfs.reachable ? "Reachable" : "Configured", html`<span class="small muted">${ipfs.provider}</span>`)}</dl>
      <p class="small muted">Confirmation levels: <strong>locally confirmed</strong> means confirmed by the connected network (a local development network unless configured otherwise); <strong>externally confirmed</strong> means confirmed on a public network; <strong>not connected</strong> means the service could not be reached. Unreachable is never shown as empty or successful.</p></section>
    <section class="card"><h2>Configuration</h2><p class="small muted">Read-only view of non-secret settings. Secrets are never displayed.</p><dl class="kv"><dt>Environment</dt><dd>${s.environment}</dd><dt>Version</dt><dd>${s.version}</dd><dt>Signing mode</dt><dd>${s.configuration.chainMode === "local" ? "Local development accounts" : "Service signing keys"}</dd><dt>IPFS provider</dt><dd>${s.configuration.ipfsProvider}</dd>
      <dt>Maximum upload</dt><dd>${s.configuration.maxUploadMb} MB</dd><dt>Rate limit</dt><dd>${s.configuration.rateLimitPerMinute} requests / minute</dd><dt>Basemap tiles</dt><dd>${s.configuration.mapTilesConfigured ? "Configured" : "Not configured"}</dd><dt>Confirmation timeout</dt><dd>${s.configuration.confirmationTimeoutMs / 1000} s</dd><dt>Reconciliation interval</dt><dd>${s.configuration.reconcileIntervalMs / 1000} s</dd></dl></section></div>
    ${s.operations ? html`<section class="card"><h2>Blockchain operations</h2><div class="flex">${Object.entries(s.operations).map(([k, v]) => html`<span>${badge("op", k)} ${v}</span>`)}</div><p><a href="#/network">Open blockchain network</a> to inspect or reconcile operations.</p></section>` : ""}`;
}

// ───────── audit log ─────────
export async function audit(ctx, seg, query) {
  const [r, pr] = await Promise.all([ctx.api.get("/audit", { pageSize: 25, ...query }), ctx.api.get("/projects", { pageSize: 100 })]);
  const href = (o) => withQuery("audit", { ...query, ...o });
  ctx.form("filters", (f) => ctx.go(withQuery("audit", { ...formData(f), page: "" })));
  ctx.on("verifychain", async (b) => { const v = await ctx.run(b, () => ctx.api.get("/audit/verify")); document.getElementById("chainout").innerHTML = v.ok ? `<div class="notice ok" role="status"><div>Audit hash chain intact across ${v.entries} entries.</div></div>` : `<div class="notice bad" role="alert"><div>Audit chain broken at entry #${v.firstBadId}.</div></div>`; });
  return {
    title: "Audit log", crumbs: [["Overview", "#/overview"], ["Audit log"]], lede: "Append-only, hash-chained record of consequential actions.",
    actions: ctx.can("NCCR_ADMIN") ? html`<button type="button" class="secondary" data-action="verifychain">Verify log integrity</button>` : "",
    body: html`<div id="chainout" aria-live="polite"></div><form class="filters" data-form="filters" role="search" aria-label="Filter audit log"><div><label for="projectId">Project</label><select id="projectId" name="projectId"><option value="">All projects</option>${pr.projects.map((p) => html`<option value="${p.id}" ${String(query.projectId) === String(p.id) ? raw("selected") : ""}>${p.code}</option>`)}</select></div>
      <div><label for="action">Action code</label><input id="action" name="action" value="${query.action || ""}" placeholder="e.g. RECORD_VERIFIED"></div><div><label for="from">From</label><input id="from" name="from" type="date" value="${query.from || ""}"></div><div><label for="to">To</label><input id="to" name="to" type="date" value="${query.to || ""}"></div><div><button type="submit" class="secondary">Apply</button> <a class="btn ghost" href="#/audit">Clear</a></div></form>
      ${table({ caption: "Audit entries", heads: ["When", "Actor", "Role", "Action", "Project", "Record", "Previous status", "New status", "Transaction"], rows: r.entries.map((a) => [fmtTime(a.created_at), a.actor_name, name("role", a.actor_role), actionLabel(a.action), a.project_code || "—", a.record_code || "—", a.previous_status || "—", a.new_status || "—", hash(a.tx_hash, 6)]), empty: empty("No audit entries", "No entries match the filters.") })}${pager(r.pagination, (n) => href({ page: n }))}`,
  };
}

// ───────── account ─────────
export async function account(ctx) {
  ctx.form("pw", async (f) => {
    const g = (n) => f.elements[n].value; f.querySelectorAll(".field-error").forEach((x) => (x.textContent = ""));
    if (g("newPassword") !== g("confirm")) { f.querySelector("#confirm-err").textContent = "The passwords do not match."; return f.elements.confirm.focus(); }
    await ctx.run(f.querySelector("button[type=submit]"), () => ctx.api.post("/auth/change-password", { currentPassword: g("currentPassword"), newPassword: g("newPassword") }), "Password changed").catch((e) => { if (e.details) Object.entries(e.details).forEach(([k, v]) => { const el = f.querySelector(`#${k === "currentPassword" ? "currentPassword" : "newPassword"}-err`); if (el) el.textContent = v; }); throw e; });
    f.reset();
  });
  const u = ctx.user;
  return { title: "Account", crumbs: [["Overview", "#/overview"], ["Account"]], lede: `${u.name} · ${name("role", u.role)}${u.organization ? " · " + u.organization : ""}`,
    body: html`<form class="card" data-form="pw" novalidate><h2>Change password</h2>${field({ id: "currentPassword", label: "Current password", required: true, children: html`<input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required>` })}
      ${field({ id: "newPassword", label: "New password", required: true, help: "At least 12 characters; avoid common passwords and your name or email.", children: html`<input id="newPassword" name="newPassword" type="password" minlength="12" autocomplete="new-password" required>` })}
      ${field({ id: "confirm", label: "Confirm new password", required: true, children: html`<input id="confirm" name="confirm" type="password" autocomplete="new-password" required>` })}<p><button type="submit" class="primary">Change password</button></p></form>` };
}
