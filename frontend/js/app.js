// Application shell: session, role-aware navigation, breadcrumbs, global search, task notifications, router.
import { api, getToken, setToken } from "./api.js";
import { html, raw, esc, icon, parseHash, notice, name } from "./util.js";
import { toast, announce, confirmDialog, copyText, watchTiles } from "./ui.js";
import * as overview from "./pages/overview.js";
import * as projects from "./pages/projects.js";
import * as records from "./pages/records.js";
import * as field from "./pages/field.js";
import * as evidence from "./pages/evidence.js";
import * as credits from "./pages/credits.js";
import * as network from "./pages/network.js";
import * as admin from "./pages/admin.js";
import * as verify from "./pages/verify.js";
import * as governance from "./pages/governance.js";
import * as reports from "./pages/reports.js";

const root = document.getElementById("app");
const state = { user: null, config: null, tasks: [] };
let acts = {}, forms = {}, current = null;

const NAV = [
  ["Registry", [["overview", "Overview", "home"], ["projects", "Project registry", "folder"]]],
  ["Workflow", [["field", "Field data", "pencil", ["FIELD_USER"]], ["review", "Verification workspace", "clipboard", ["VERIFIER", "NCCR_ADMIN"]], ["evidence", "Evidence repository", "image"], ["assessments", "Carbon assessment", "leaf"], ["reports", "Registry reports", "list"]]],
  ["Registry ledger", [["credits", "Credit registry", "ledger"], ["network", "Blockchain network", "link"]]],
  ["Governance", [["administration", "Administration", "users", ["NCCR_ADMIN"]], ["audit", "Audit log", "list", ["NCCR_ADMIN", "VERIFIER"]]]],
];
const ROUTES = {
  overview: { page: overview.page }, projects: { page: projects.page, nav: "projects" }, records: { page: records.detail, nav: "review" },
  field: { page: field.page, roles: ["FIELD_USER"] }, review: { page: records.queue, roles: ["VERIFIER", "NCCR_ADMIN"] }, evidence: { page: evidence.page },
  assessments: { page: credits.assessments }, reports: { page: reports.page }, credits: { page: credits.registry }, network: { page: network.page },
  administration: { page: admin.page, roles: ["NCCR_ADMIN"] }, audit: { page: admin.audit, roles: ["NCCR_ADMIN", "VERIFIER"] }, account: { page: admin.account }, notifications: { page: governance.notifications },
};

export const ctx = {
  get user() { return state.user; }, get config() { return state.config; }, get query() { return parseHash().query; },
  api, toast, confirm: confirmDialog,
  go: (h) => { if (location.hash === h) route(); else location.hash = h; },
  refresh: () => route({ keepScroll: true }),
  on: (n, fn) => { acts[n] = fn; }, form: (n, fn) => { forms[n] = fn; },
  can: (...roles) => roles.includes(state.user?.role),
  /** Run an action with a disabled trigger; failures are shown as a notification and rethrown flagged as handled. */
  async run(btn, fn, ok) {
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    try { const r = await fn(); if (ok) toast(ok); return r; }
    catch (e) { toast(e.message, e.status === 503 ? "warn" : "error"); e.handled = true; throw e; }
    finally { if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); } }
  },
};

// ───────── shell ─────────
const brandSvg = raw(`<svg viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="20" fill="#157f78"/><path d="M12 62c12-9 24-9 36 0s24 9 36 0v22H12z" fill="#0b2237" opacity=".55"/><path d="M48 18c10 8 14 17 8 28-3 5-8 8-8 14 0-6-5-9-8-14-6-11-2-20 8-28z" fill="#e9f7f1"/></svg>`);

function shellHtml() {
  const u = state.user;
  return html`<div class="app"><aside class="sidebar" id="sidebar" aria-label="Primary"><a class="brand" href="#/overview">${brandSvg}<span>Blue Carbon Registry</span></a>
    <nav aria-label="Main">${NAV.map(([g, items]) => { const vis = items.filter(([, , , roles]) => !roles || roles.includes(u.role)); return vis.length ? html`<div class="nav-group">${g}</div>${vis.map(([id, l, ic]) => html`<a class="nav" href="#/${id}" data-nav="${id}">${icon(ic)}<span>${l}</span></a>`)}` : ""; })}
      <div class="nav-group">Public</div><a class="nav" href="#/verify" data-nav="verify">${icon("shield")}<span>Public verification</span></a></nav>
    <div class="sidebar-foot">Methodology ${esc(state.config?.methodologyVersion || "")}<br>Records marked illustrative are not field-collected.</div></aside>
    <div class="scrim" id="scrim" data-action="nav-close"></div>
    <header class="topbar"><button type="button" class="ghost icon menu-btn" data-action="nav-open" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">${icon("menu")}</button>
      <div class="search" role="search">${icon("search")}<label class="vh" for="gsearch">Search the registry</label><input id="gsearch" type="search" placeholder="Search projects, records, evidence, credit batches" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="gresults" aria-autocomplete="list"><div class="search-results" id="gresults" role="listbox" hidden></div></div>
      <div class="top-actions"><div class="pop"><button type="button" class="ghost icon" data-action="pop" data-pop="tasks" aria-label="Pending actions" aria-haspopup="true" aria-expanded="false">${icon("bell")}<span class="bell-dot" id="bell-count" hidden></span></button>
          <div class="pop-panel" id="pop-tasks" hidden role="region" aria-label="Pending actions"></div></div>
        <div class="pop"><button type="button" class="ghost" data-action="pop" data-pop="account" aria-haspopup="true" aria-expanded="false">${icon("user")}<span class="who">${esc(u.name)}</span></button>
          <div class="pop-panel" id="pop-account" hidden><p><strong>${esc(u.name)}</strong><br><span class="muted small">${esc(name("role", u.role))}${u.organization ? " · " + esc(u.organization) : ""}</span><br><span class="muted small">${esc(u.email)}</span></p>
            <ul><li><a href="#/notifications">Notifications</a></li><li><a href="#/account">Change password</a></li><li><a href="#/verify">Public verification</a></li><li><a href="#/login" data-action="logout">Sign out</a></li></ul></div></div></div></header>
    <main id="main" tabindex="-1"></main></div>`;
}

function renderView(view) {
  const crumbs = view.crumbs?.length ? html`<nav class="crumbs" aria-label="Breadcrumb"><ol>${view.crumbs.map(([l, h], i) => html`<li>${h && i < view.crumbs.length - 1 ? html`<a href="${h}">${l}</a>` : html`<span ${i === view.crumbs.length - 1 ? raw('aria-current="page"') : ""}>${l}</span>`}</li>`)}</ol></nav>` : "";
  return html`${crumbs}<div class="page-head"><div><h1>${view.title}</h1>${view.lede ? html`<p class="lede">${view.lede}</p>` : ""}</div>${view.actions ? html`<div class="actions">${view.actions}</div>` : ""}</div>${view.body}`;
}

async function loadTasks() {
  let unread = 0;
  try { state.tasks = (await api.get("/tasks")).tasks; } catch { state.tasks = []; }
  try { unread = (await api.get("/notifications", { unread: "1", pageSize: 1 })).unread || 0; } catch { unread = 0; }
  const items = [...state.tasks, ...(unread ? [{ href: "#/notifications?unread=1", label: "Unread notifications", count: unread }] : [])];
  const total = items.reduce((a, t) => a + t.count, 0), dot = document.getElementById("bell-count"), panel = document.getElementById("pop-tasks");
  if (dot) { dot.hidden = !total; dot.textContent = total > 99 ? "99+" : total; dot.closest("button")?.setAttribute("aria-label", total ? `Pending actions: ${dot.textContent}` : "Pending actions"); } // the visible count is part of the accessible name
  if (panel) panel.innerHTML = items.length ? `<h3 class="small">Pending actions</h3><ul>${items.map((t) => `<li><a href="${esc(t.href)}"><span>${esc(t.label)}</span><span class="count">${t.count}</span></a></li>`).join("")}</ul>` : `<p class="muted">No pending actions.</p>`;
}

// ───────── routing ─────────
let navSeq = 0;
async function route(opts = {}) {
  // Overlapping navigations: only the newest may render or register handlers; a slower earlier page is discarded when it finishes.
  const seq = ++navSeq, live = () => seq === navSeq;
  acts = {}; forms = {};
  const rctx = Object.create(ctx); rctx.on = (n, f) => { if (live()) acts[n] = f; }; rctx.form = (n, f) => { if (live()) forms[n] = f; };
  const { segments, query } = parseHash();
  const page = segments[0] || "overview";
  try {
    if (page === "verify") return await renderPublic(segments, query);
    if (page === "forgot" || page === "reset") return renderRecovery(page, query);
    if (page === "login" && !getToken()) return renderLogin();
    if (!getToken()) return renderLogin();
    if (!state.config) state.config = await api.get("/config");
    if (!state.user) { try { state.user = (await api.get("/auth/me")).user; } catch (e) { if (e.status === 401) { setToken(null); return renderLogin(); } throw e; } }
    if (!document.getElementById("main")) { root.innerHTML = shellHtml().s; wireShell(); loadTasks(); }
    const r = ROUTES[page];
    const main = document.getElementById("main");
    if (!r || (r.roles && !r.roles.includes(state.user.role))) {
      main.innerHTML = renderView({ title: "Page not available", crumbs: [["Overview", "#/overview"], ["Not available"]], body: notice("warn", html`This page does not exist or is not available to your role (${name("role", state.user.role)}). <a href="#/overview">Return to the overview</a>.`) }).s;
      return finishNav(null);
    }
    if (!opts.keepScroll) main.innerHTML = '<p class="muted" role="status">Loading…</p>';
    const view = await r.page(rctx, segments.slice(1), query);
    if (!live()) return; // a newer navigation has started
    current = view;
    if (!view) return;
    main.innerHTML = renderView(view).s;
    document.title = `${String(view.title?.s ?? view.title).replace(/<[^>]*>/g, "")} — Blue Carbon Registry`;
    finishNav(r.nav || page, !opts.keepScroll);
    watchTiles(main);
    view.after?.(main);
    if (!opts.keepScroll) loadTasks();
  } catch (e) {
    if (!live()) return;
    if (e.status === 401) { setToken(null); state.user = null; return renderLogin("Your session has expired. Sign in again."); }
    const main = document.getElementById("main") || root;
    main.innerHTML = `<div class="notice bad" role="alert"><div><strong>${e.network ? "You appear to be offline" : "This page could not be loaded"}</strong><br>${esc(e.message)}${e.requestId ? `<br><span class="small">Reference: ${esc(e.requestId)}</span>` : ""}<p><button type="button" class="secondary sm" data-action="retry">Try again</button></p></div></div>`;
    acts.retry = () => route();
  }
}
function finishNav(active, focus = true) {
  document.querySelectorAll("[data-nav]").forEach((a) => (a.dataset.nav === active ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  closeNav();
  if (focus) { const m = document.getElementById("main"); m.focus({ preventScroll: true }); window.scrollTo(0, 0); announce(document.title); }
}

// ───────── login and public shell ─────────
function renderLogin(msg) {
  state.user = null;
  const ref = state.config?.referenceAccounts;
  root.innerHTML = html`<main id="main" class="login-wrap" tabindex="-1"><section class="login-art" aria-label="About the registry"><div>${brandSvg}</div><h1>Blue Carbon Registry</h1>
      <p>Monitoring, reporting and verification for coastal restoration projects, with on-chain record anchoring and traceable credit issuance, transfer and retirement.</p>
      <ul><li>Field data and evidence submitted from the field</li><li>Independent verification with an auditable decision trail</li><li>Transparent carbon assessment methodology and assumptions</li><li>Public verification of records and credit batches</li></ul></section>
    <section class="login-form"><h2>Sign in</h2>${msg ? notice("warn", msg) : ""}<form data-form="login" novalidate><div class="fld"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="fld"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><div class="field-error" id="login-err" role="alert"></div>
      <p><button type="submit" class="primary">Sign in</button></p></form><p><a href="#/forgot">Forgot your password?</a></p><p><a href="#/verify">Verify a record or credit batch without signing in</a></p>
      ${ref ? html`<details><summary>Reference accounts for the local reference dataset</summary><p class="small muted">Available only while reference data is loaded in a non-production environment.</p><ul>${ref.accounts.map((a) => html`<li><button type="button" class="secondary sm" data-action="fill" data-email="${a.email}" data-password="${ref.password}">${name("role", a.role)}: ${a.name}</button></li>`)}</ul></details>` : ""}</section></main>`.s;
  document.title = "Sign in — Blue Carbon Registry";
  forms.login = async (f) => {
    const err = f.querySelector("#login-err"), btn = f.querySelector("button[type=submit]"); err.textContent = ""; btn.disabled = true;
    try { const r = await api.post("/auth/login", { email: f.elements.email.value.trim(), password: f.elements.password.value }); setToken(r.token); state.user = r.user; state.config = null; root.innerHTML = ""; location.hash = location.hash.startsWith("#/login") || !location.hash ? "#/overview" : location.hash; route(); }
    catch (e) { err.textContent = e.message; f.elements.password.value = ""; f.elements.password.focus(); } finally { btn.disabled = false; }
  };
  acts.fill = (b) => { const f = root.querySelector("form[data-form=login]"); f.elements.email.value = b.dataset.email; f.elements.password.value = b.dataset.password; f.elements.password.focus(); };
  if (!state.config) api.get("/config").then((c) => { state.config = c; if (c.referenceAccounts && !getToken()) renderLogin(msg); }).catch(() => {});
}

function renderRecovery(kind, query) {
  state.user = null;
  const reset = kind === "reset", token = query.token || "";
  const intro = reset ? "Choose a new password for your account. Signing in again is required on every device afterwards." : "Enter the email address of your account. If an account exists, a reset link that expires shortly is sent to it.";
  root.innerHTML = html`<main id="main" class="login-wrap" tabindex="-1"><section class="login-art" aria-label="About the registry"><div>${brandSvg}</div><h1>Blue Carbon Registry</h1><p>Account recovery</p></section>
    <section class="login-form"><h2>${reset ? "Choose a new password" : "Reset your password"}</h2><p>${intro}</p>
      <div id="recovery-result" role="status"></div>
      ${reset && !token ? notice("warn", "This reset link is incomplete. Request a new link.") : ""}
      <form data-form="${reset ? "reset" : "forgot"}" novalidate>
        ${reset ? html`<div class="fld"><label for="newpw">New password<span class="req" aria-hidden="true">*</span></label><input id="newpw" name="newPassword" type="password" autocomplete="new-password" minlength="12" required><div class="help">At least 12 characters; avoid common passwords and personal details.</div></div>
          <div class="fld"><label for="confirmpw">Confirm new password<span class="req" aria-hidden="true">*</span></label><input id="confirmpw" name="confirm" type="password" autocomplete="new-password" required></div>`
        : html`<div class="fld"><label for="email">Email address<span class="req" aria-hidden="true">*</span></label><input id="email" name="email" type="email" autocomplete="username" required></div>`}
        <div class="field-error" id="recovery-err" role="alert"></div>
        <p><button type="submit" class="primary">${reset ? "Set new password" : "Send reset link"}</button></p></form>
      <p><a href="#/login">Back to sign in</a></p></section></main>`.s;
  document.title = `${reset ? "Choose a new password" : "Reset your password"} — Blue Carbon Registry`;
  const err = () => document.getElementById("recovery-err"), done = (msg) => { document.getElementById("recovery-result").innerHTML = notice("info", msg).s; };
  forms.forgot = async (f) => {
    err().textContent = ""; const email = f.elements.email.value.trim();
    if (!email) { err().textContent = "Enter your email address."; return; }
    const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
    try { const r = await api.post("/auth/forgot-password", { email }); f.hidden = true; done(r?.message || "If an account exists for that address, a password reset link has been sent."); }
    catch (e) { err().textContent = e.message; } finally { btn.disabled = false; }
  };
  forms.reset = async (f) => {
    err().textContent = ""; const pw = f.elements.newPassword.value;
    if (!token) { err().textContent = "This reset link is incomplete. Request a new link."; return; }
    if (pw !== f.elements.confirm.value) { err().textContent = "The two passwords do not match."; f.elements.confirm.focus(); return; }
    const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
    try { await api.post("/auth/reset-password", { token, newPassword: pw }); setToken(null); f.hidden = true; done(html`Your password was changed and all existing sessions were signed out. <a href="#/login">Sign in with the new password</a>.`); }
    catch (e) { err().textContent = e.details?.newPassword ? `New password ${e.details.newPassword}` : e.message; } finally { btn.disabled = false; }
  };
  document.getElementById("main").focus({ preventScroll: true }); announce(document.title);
}

async function renderPublic(segments) {
  const view = await verify.page(ctx, segments.slice(1));
  root.innerHTML = html`<div class="public-shell"><header class="public-top"><a class="brand" href="#/overview">${brandSvg}<span>Blue Carbon Registry</span></a><span class="muted small">Public verification</span><span class="top-actions"><a class="btn secondary sm" href="#/overview">${getToken() ? "Back to the registry" : "Sign in"}</a></span></header>
    <main id="main" class="public-main" tabindex="-1">${renderView(view)}</main></div>`.s;
  document.title = `${view.title} — Blue Carbon Registry`;
  watchTiles(root); view.after?.(root); document.getElementById("main").focus({ preventScroll: true }); announce(document.title);
}

// ───────── shell behaviour ─────────
function closeNav() { document.getElementById("sidebar")?.classList.remove("open"); document.getElementById("scrim")?.classList.remove("open"); document.querySelector(".menu-btn")?.setAttribute("aria-expanded", "false"); }
function closePops() { document.querySelectorAll(".pop-panel").forEach((p) => (p.hidden = true)); document.querySelectorAll("[data-action=pop]").forEach((b) => b.setAttribute("aria-expanded", "false")); }

function wireShell() {
  const input = document.getElementById("gsearch"), box = document.getElementById("gresults");
  let timer, items = [], idx = -1;
  const hide = () => { box.hidden = true; input.setAttribute("aria-expanded", "false"); idx = -1; };
  const paint = (q, results) => {
    items = results;
    box.innerHTML = results.length ? results.map((r, i) => `<a role="option" id="sr-${i}" href="${esc(r.href)}" aria-selected="false"><span class="type">${esc(r.type)}</span><span>${esc(r.label)}</span></a>`).join("") : `<p class="muted small sr-msg"></p>`;
    if (!results.length) box.firstElementChild.textContent = `No results for “${q}”.`;
    box.hidden = false; input.setAttribute("aria-expanded", "true");
  };
  input.addEventListener("input", () => { clearTimeout(timer); const q = input.value.trim(); if (q.length < 2) return hide(); timer = setTimeout(async () => { try { paint(q, (await api.get("/search", { q })).results); } catch (e) { box.innerHTML = `<p class="small sr-msg">${esc(e.message)}</p>`; box.hidden = false; } }, 250); });
  input.addEventListener("keydown", (e) => {
    const links = [...box.querySelectorAll("a")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!links.length) return; idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length; links.forEach((l, i) => l.setAttribute("aria-selected", i === idx)); input.setAttribute("aria-activedescendant", links[idx].id); }
    else if (e.key === "Enter" && idx >= 0) { e.preventDefault(); links[idx].click(); }
    else if (e.key === "Escape") { hide(); input.value = ""; }
  });
  box.addEventListener("click", () => { hide(); input.value = ""; });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) hide(); if (!e.target.closest(".pop")) closePops(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePops(); closeNav(); } });
}

root.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]"); if (!el) return;
  const a = el.dataset.action;
  if (a === "nav-open") { document.getElementById("sidebar").classList.add("open"); document.getElementById("scrim").classList.add("open"); el.setAttribute("aria-expanded", "true"); document.querySelector("#sidebar a")?.focus(); return; }
  if (a === "nav-close") return closeNav();
  if (a === "pop") { const p = document.getElementById(`pop-${el.dataset.pop}`), open = p.hidden; closePops(); p.hidden = !open; el.setAttribute("aria-expanded", String(open)); return; }
  if (a === "logout") { e.preventDefault(); setToken(null); state.user = null; state.config = null; root.innerHTML = ""; location.hash = "#/login"; route(); return; }
  if (a === "copy") return copyText(el.dataset.value);
  Promise.resolve(acts[a]?.(el, e)).catch((err) => { if (!err?.handled) toast(err?.message || "Unexpected error", "error"); });
});
root.addEventListener("submit", (e) => {
  const f = e.target.closest("form[data-form]"); if (!f) return; e.preventDefault();
  Promise.resolve(forms[f.dataset.form]?.(f, e)).catch((err) => { if (!err?.handled) toast(err?.message || "Unexpected error", "error"); });
});
root.addEventListener("change", (e) => { const f = e.target.closest("form[data-autosubmit]"); if (f) (f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); });
window.addEventListener("unhandledrejection", (e) => { e.preventDefault(); if (!e.reason?.handled) toast(e.reason?.message || "Unexpected error", "error"); });
window.addEventListener("hashchange", () => route());
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
route();
