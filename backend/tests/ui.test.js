// User-interface tests: the real frontend bundle runs in jsdom against the real API, database and local blockchain network.
// Covers role navigation, critical workflows (approve + issue, review + verify, field validation + submit), accessibility
// heuristics on every page, and a wording audit of everything rendered. (jsdom is not a visual browser: layout is not checked here.)
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const esbuild = require("esbuild");
const path = require("node:path");
const cfg = require("../src/config");
const db = require("../src/db");
const chain = require("../src/services/chain");
const app = require("../src/app");
const { seed } = require("../../database/seed");

cfg.rateLimit.max = 1e6; cfg.rateLimit.authMax = 1e6;
const BAD = /demo|synthetic|prototype|mock data|vibecoded|AI-generated/i;
let server, base, w, doc, errors = [], wording = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (n, t = "click") => n.dispatchEvent(new w.Event(t, { bubbles: true, cancelable: true }));
const toasts = () => [...doc.querySelectorAll("#toasts .toast")].map((d) => d.textContent);
const dialog = () => doc.querySelector(".modal");
const dlgBtn = (x) => [...dialog().querySelectorAll("button")].find((b) => b.dataset.x === x);

async function nav(h, ms = 800) { w.location.hash = h; await sleep(ms); const t = doc.body.textContent + " " + doc.title; const m = t.match(BAD); if (m) wording.push(`${h}: "${m[0]}"`); }
async function login(email) {
  w.sessionStorage.clear(); w.location.hash = "#/login"; await sleep(250); doc.getElementById("app").innerHTML = ""; w.location.hash = "#/overview"; await sleep(700);
  const f = doc.querySelector("form[data-form=login]"); f.elements.email.value = email; f.elements.password.value = cfg.referencePassword; ev(f, "submit"); await sleep(1300);
}

/** Heuristic accessibility audit of the current document. */
function a11y() {
  const issues = [], label = (el) => el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.title || el.textContent.trim();
  doc.querySelectorAll("input:not([type=hidden]),select,textarea").forEach((el) => {
    const named = (el.id && doc.querySelector(`label[for="${el.id}"]`)) || el.closest("label") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
    if (!named) issues.push(`unlabelled control ${el.tagName.toLowerCase()}#${el.id || el.name}`);
  });
  doc.querySelectorAll("button,a[href]").forEach((el) => { if (!label(el)) issues.push(`unnamed ${el.tagName.toLowerCase()} ${el.outerHTML.slice(0, 60)}`); });
  doc.querySelectorAll("img").forEach((el) => { if (!el.hasAttribute("alt")) issues.push("image without alt"); });
  doc.querySelectorAll("table").forEach((el) => { if (!el.querySelector("caption")) issues.push("table without caption"); });
  doc.querySelectorAll("svg[role=img]").forEach((el) => { if (!el.getAttribute("aria-label")) issues.push("svg image without label"); });
  const h1 = doc.querySelectorAll("h1").length; if (h1 !== 1) issues.push(`expected one h1, found ${h1}`);
  const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id), dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) issues.push(`duplicate ids: ${[...new Set(dup)].join(", ")}`);
  if (!doc.querySelector("main")) issues.push("no main landmark");
  doc.querySelectorAll("[role=dialog]").forEach((el) => { if (!el.getAttribute("aria-labelledby")) issues.push("dialog without label"); });
  return issues;
}

test.before(async () => {
  await chain.init();
  await seed({ log: () => {} });
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const bundle = await esbuild.build({ entryPoints: [path.join(__dirname, "..", "..", "frontend", "js", "app.js")], bundle: true, format: "iife", write: false });
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>Blue Carbon Registry</title></head><body><div id="app"></div><div id="toasts"></div><div id="sr-announce"></div></body></html>`, { url: base + "/", runScripts: "outside-only", pretendToBeVisual: true });
  w = dom.window; doc = w.document;
  w.fetch = (u, o) => fetch(new URL(u, base), o); w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {}; w.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  w.console.error = (...a) => errors.push(a.join(" ")); w.addEventListener("error", (e) => errors.push(e.message));
  w.eval(bundle.outputFiles[0].text); await sleep(600);
});
test.after(async () => { server.close(); await db.end(); });

test("sign-in and public verification pages render, accessible and free of prohibited wording", async () => {
  assert.match(doc.body.textContent, /Sign in/);
  assert.ok(doc.querySelector("[data-action=fill]"), "reference accounts are offered outside production");
  assert.deepEqual(a11y(), []);
  await nav("#/verify");
  assert.match(doc.body.textContent, /Credit batches/);
  const f = doc.querySelector("form[data-form=verify]"); f.elements.code.value = "CB-00001"; ev(f, "submit"); await sleep(1200);
  assert.match(doc.body.textContent, /Record integrity confirmed/);
  assert.match(doc.body.textContent, /Not verified here/);
  assert.match(doc.body.textContent, /Chain ID/);
  assert.deepEqual(a11y(), []);
  const again = doc.querySelector("form[data-form=verify]"); again.elements.code.value = "NOPE-1"; ev(again, "submit"); await sleep(900);
  assert.match(doc.body.textContent, /No record or credit batch was found/);
});

const PLAN = {
  "admin@nccr.example": { nav: ["Overview", "Project registry", "Verification workspace", "Evidence repository", "Carbon assessment", "Registry reports", "Credit registry", "Blockchain network", "Administration", "Audit log", "Public verification"],
    pages: ["#/overview", "#/projects", "#/projects?q=delta&sort=name&dir=asc", "#/projects/new", "#/projects/1", "#/review", "#/records/1", "#/evidence", "#/assessments", "#/reports", "#/reports?groupBy=period", "#/reports?groupBy=ecosystem&origin=ILLUSTRATIVE", "#/credits", "#/credits/1", "#/network", "#/administration", "#/administration?tab=organizations", "#/administration?tab=system", "#/administration?tab=methodology", "#/administration?tab=settings", "#/administration?tab=roles", "#/notifications", "#/audit", "#/account"], blocked: ["#/field"] },
  "verifier1@verification.example": { nav: ["Overview", "Project registry", "Verification workspace", "Evidence repository", "Carbon assessment", "Registry reports", "Credit registry", "Blockchain network", "Audit log", "Public verification"],
    pages: ["#/overview", "#/review?status=UNDER_REVIEW", "#/evidence?status=PENDING", "#/assessments", "#/reports?groupBy=status", "#/projects/1", "#/notifications", "#/audit"], blocked: ["#/administration", "#/field"] },
  "field.trust@field.example": { nav: ["Overview", "Project registry", "Field data", "Evidence repository", "Carbon assessment", "Registry reports", "Credit registry", "Blockchain network", "Public verification"],
    pages: ["#/overview", "#/projects", "#/projects/1", "#/field", "#/field/new", "#/records/1", "#/evidence", "#/assessments", "#/reports", "#/credits", "#/credits/1", "#/network", "#/notifications"], blocked: ["#/review", "#/audit", "#/administration"] },
};
for (const [email, spec] of Object.entries(PLAN)) {
  test(`every page renders for ${email}: role navigation, no errors, accessible, clean wording`, async () => {
    await login(email);
    assert.deepEqual([...doc.querySelectorAll("nav[aria-label=Main] a")].map((a) => a.textContent.trim()), spec.nav);
    for (const p of spec.pages) {
      await nav(p);
      assert.equal(doc.querySelector("#main .notice.bad"), null, `${p}: ${doc.querySelector("#main .notice.bad")?.textContent}`);
      assert.deepEqual(a11y(), [], p);
      assert.ok(doc.querySelector("#main h1").textContent.trim().length > 0, p);
    }
    for (const p of spec.blocked) { await nav(p); assert.match(doc.querySelector("#main").textContent, /not available/i, `${p} is not available to this role`); }
  });
}

test("approve an assessment and issue credits through the interface (with confirmation dialogs)", async () => {
  await login("admin@nccr.example"); await nav("#/assessments");
  const before = Number((await db.query("SELECT COUNT(*) AS n FROM carbon_credits")).rows[0].n);
  // The seed also holds a pending assessment under the unreviewed IPCC method that is correctly blocked; approve an unblocked one here.
  const open = [...doc.querySelectorAll("button[data-action=approve][data-d=APPROVED]")].find((b) => b.dataset.q !== "0");
  assert.ok(open, "an approvable (unblocked) assessment is listed");
  ev(open); await sleep(300);
  assert.equal(dialog().querySelector("h2").textContent, "Approve this assessment?");
  assert.ok(dialog().contains(doc.activeElement), "focus moves into the dialog");
  dlgBtn("ok").click(); await sleep(1500);
  assert.ok(toasts().includes("Assessment approved"));
  await nav("#/assessments"); ev(doc.querySelector("button[data-action=issue]")); await sleep(300); dlgBtn("ok").click(); await sleep(2500);
  assert.match(w.location.hash, /^#\/credits\/\d+$/);
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM carbon_credits")).rows[0].n), before + 1);
  assert.match(doc.querySelector("#main").textContent, /Issuance transaction/);
});

test("a blocked assessment shows its blockers and methodology status, and approval is refused by the server with the reason (no false success)", async () => {
  await login("admin@nccr.example"); await nav("#/assessments");
  const main = () => doc.querySelector("#main").textContent;
  assert.match(main(), /Pending independent review/, "methodology review state is shown");
  assert.match(main(), /\d+ issuance blockers?/, "blocked assessments are flagged in the list");
  assert.match(main(), /BUFFER_UNSET/, "blocker codes are listed in the calculation detail");
  assert.match(main(), /Required determinations/);
  const blocked = [...doc.querySelectorAll("button[data-action=approve][data-d=APPROVED]")].find((b) => b.dataset.q === "0");
  assert.ok(blocked, "the blocked assessment still offers a decision; the server is authoritative");
  const id = Number(blocked.dataset.id);
  ev(blocked); await sleep(300); dlgBtn("ok").click(); await sleep(1500);
  assert.ok(!toasts().includes("Assessment approved"), "no success message for a refused approval");
  assert.match(toasts().join("|"), /cannot be approved for issuance/, toasts().join("|"));
  assert.equal((await db.query("SELECT approval_status FROM carbon_calculations WHERE id=$1", [id])).rows[0].approval_status, "PENDING");
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM carbon_credits k JOIN carbon_calculations c ON c.record_id=k.record_id WHERE c.id=$1", [id])).rows[0].n), 0);
});

test("verifier reviews evidence and records a decision; rejection requires a reason", async () => {
  await login("verifier1@verification.example");
  const rid = (await db.query("SELECT id FROM monitoring_records WHERE status='UNDER_REVIEW' ORDER BY id LIMIT 1")).rows[0].id;
  await nav(`#/records/${rid}`);
  assert.ok(doc.querySelectorAll(".check").length >= 8, "validation checks are listed");
  for (let i = 0; i < 6; i++) { const b = doc.querySelector("button[data-action=ev-review][data-d=VERIFIED]"); if (!b) break; ev(b); await sleep(300); dlgBtn("ok").click(); await sleep(1700); }
  ev(doc.querySelector("button[data-action=decide][data-d=REJECTED]")); await sleep(300); dlgBtn("ok").click(); await sleep(200);
  assert.match(dialog().querySelector("#dlg-e").textContent, /at least 5 characters/); dlgBtn("cancel").click(); await sleep(100);
  doc.getElementById("comments").value = "Evidence and measurements are consistent.";
  ev(doc.querySelector("button[data-action=decide][data-d=VERIFIED]")); await sleep(300); dlgBtn("ok").click(); await sleep(2500);
  assert.ok(toasts().some((t) => /Decision recorded/.test(t)), toasts().join("|"));
  assert.equal((await db.query("SELECT status FROM monitoring_records WHERE id=$1", [rid])).rows[0].status, "VERIFIED");
});

test("field form validates inline, keeps input on failure and submits with an evidence reference", async () => {
  await login("field.trust@field.example"); await nav("#/field/new");
  const E = doc.querySelector("#recform").elements;
  E.areaHa.value = "99999"; E.observations.value = "short";
  ev(doc.querySelector("button[data-action=submit]")); await sleep(500);
  const msgs = [...doc.querySelectorAll(".field-error")].map((x) => x.textContent).filter(Boolean);
  assert.ok(msgs.some((m) => /exceeds the project area/.test(m)));
  assert.ok(doc.querySelector("[aria-invalid=true]"), "invalid fields are flagged");
  assert.equal(E.areaHa.value, "99999", "input is preserved");
  E.areaHa.value = "10"; E.observations.value = "Observation text that is long enough for review."; E.latitude.value = "21.901"; E.longitude.value = "88.801"; E.m_survival_rate_pct.value = "72"; E.externalRef.value = "scene-ui-check (external reference)";
  ev(doc.querySelector("button[data-action=submit]")); await sleep(500); dlgBtn("ok").click(); await sleep(3000);
  assert.match(w.location.hash, /^#\/records\/\d+$/);
  const rec = (await db.query("SELECT status, anchor_status FROM monitoring_records ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual(rec, { status: "SUBMITTED", anchor_status: "ANCHORED" });
});


// ───────── registry reports page ─────────
const apiToken = async (email) => (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: cfg.referencePassword }) })).json()).token;
const apiGet = async (token, p) => (await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } })).json();
const realFetch = () => w.__realFetch || (w.__realFetch = w.fetch);
const stubReports = (make) => { const real = realFetch(); w.fetch = (u, o) => (String(u).includes("/api/reports/registry") ? Promise.resolve(make(u)) : real(u, o)); };
const unstub = () => { if (w.__realFetch) w.fetch = w.__realFetch; };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("reports page: figures come from the API, quantities are separated, illustrative data is labelled, definitions are present", async () => {
  await login("admin@nccr.example"); await nav("#/reports");
  const main = doc.querySelector("#main"), text = main.textContent;
  assert.equal(main.querySelector("h1").textContent.trim(), "Registry reports");
  for (const t of ["Field observations", "Estimates — not credits", "Approved and issued credits", "Totals for the selected filters", "What each quantity means"]) assert.ok(text.includes(t), t);
  assert.match(text, /Illustrative sample data is included and shown separately/);
  assert.match(text, /Approved is not issued/); assert.match(text, /Estimated .* not a verified or issued credit/);
  const token = await apiToken("admin@nccr.example"), api = await apiGet(token, "/api/reports/registry?groupBy=project");
  const fmt = (n, d) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
  const totals = [...main.querySelectorAll("table")].find((t) => t.querySelector("caption").textContent.startsWith("Totals computed by the registry"));
  const rowsText = [...totals.querySelectorAll("tbody tr")].map((r) => r.textContent);
  for (const t of api.totals) {
    const line = rowsText.find((x) => x.includes(t.data_origin === "ILLUSTRATIVE" ? "Illustrative sample data" : "User-entered data"));
    assert.ok(line, `totals row for ${t.data_origin}; rows: ${JSON.stringify(rowsText)}; caption count ${main.querySelectorAll("table").length}`);
    for (const [k, d] of [["issued_tonnes", 4], ["transferred_tonnes", 4], ["retired_tonnes", 4], ["eligible_approved_tonnes", 0]]) assert.ok(line.includes(fmt(t[k], d)), `${t.data_origin} ${k} = ${fmt(t[k], d)} appears in: ${line}`);
  }
  for (const r of api.rows) assert.ok(text.includes(r.key), `project ${r.key} listed`);
  assert.ok(doc.querySelector("#main").querySelectorAll("table").length >= 4);
});

test("reports page: filters change the query and the grouping; an inverted date range is refused inline", async () => {
  await login("admin@nccr.example"); await nav("#/reports");
  const f = () => doc.querySelector("form[data-form=filters]");
  f().elements.groupBy.value = "period"; f().elements.from.value = "2026-09-01"; f().elements.to.value = "2026-01-01"; ev(f(), "submit"); await sleep(300);
  assert.match(f().querySelector("[data-form-error]").textContent, /start date must not be after the end date/);
  assert.ok(!w.location.hash.includes("groupBy=period"), "no navigation with an invalid range");
  f().elements.from.value = ""; f().elements.to.value = ""; ev(f(), "submit"); await sleep(900);
  assert.ok(w.location.hash.includes("groupBy=period"), w.location.hash);
  assert.ok([...doc.querySelectorAll("#main th")].some((th) => th.textContent.trim() === "Activity month"), "grouped by activity month");
  assert.equal(doc.querySelector("#groupBy").value, "period", "filters persist after the page reloads");
  await nav("#/reports?region=Atlantis");
  assert.match(doc.querySelector("#main").textContent, /No records match these filters/);
  assert.equal(doc.querySelectorAll("#main table").length, 0, "no tables for an empty result");
});

test("reports page: backend failure shows an error with retry; malformed responses are refused rather than displayed", async () => {
  await login("admin@nccr.example");
  stubReports(() => json(500, { error: "Database unavailable", requestId: "r-1" })); await nav("#/reports");
  let bad = doc.querySelector("#main .notice.bad"); assert.ok(bad, "error notice shown"); assert.match(bad.textContent, /could not be produced/); assert.match(bad.textContent, /Database unavailable/);
  assert.ok(doc.querySelector("form[data-form=filters]"), "filters stay available"); assert.equal(doc.querySelectorAll("#main table").length, 0, "no stale figures");
  unstub(); ev(doc.querySelector("#main [data-action=retry]")); await sleep(1000);
  assert.equal(doc.querySelector("#main .notice.bad"), null, "retry recovers"); assert.ok(doc.querySelectorAll("#main table").length >= 4);
  const bad1 = { rows: [{ data_origin: "USER_ENTERED" }], totals: [] };
  const bad2 = { rows: [{ data_origin: "USER_ENTERED", projects: 1, records_reported: 1, records_verified: 1, reported_area_ha: 1, verified_area_ha: 1, estimated_central_tco2e: 1, estimated_conservative_tco2e: 1, eligible_approved_tonnes: 1, issued_tonnes: "abc", transferred_tonnes: 0, retired_tonnes: 0, outstanding_tonnes: 0 }], totals: [] };
  let n = 0; // a different hash each time, otherwise the router does not reload the page
  for (const body of [bad1, bad2, { nope: true }]) {
    stubReports(() => json(200, body)); await nav(`#/reports?groupBy=project&t=${++n}`);
    assert.match(doc.querySelector("#main .notice.bad").textContent, /unexpected format/); assert.equal(doc.querySelectorAll("#main table").length, 0);
  }
  stubReports(() => json(400, { error: "groupBy must be one of: project" })); await nav("#/reports?groupBy=x&t=9");
  assert.match(doc.querySelector("#main .notice.bad").textContent, /filters were not accepted/);
  unstub();
});

test("reports page: CSV download uses the authenticated API with the current filters and reports the result", async () => {
  await login("admin@nccr.example"); unstub();
  const blobs = [], clicks = [];
  w.URL.createObjectURL = (b) => { blobs.push(b); return "blob:test"; }; w.URL.revokeObjectURL = () => {};
  const proto = w.HTMLAnchorElement.prototype, origClick = proto.click; proto.click = function () { clicks.push({ href: this.href, name: this.download }); };
  try {
    await nav("#/reports?groupBy=ecosystem&origin=ILLUSTRATIVE");
    ev(doc.querySelector("[data-action=download-csv]")); await sleep(1200);
    assert.equal(clicks.length, 1); assert.equal(clicks[0].name, "registry-report-ecosystem.csv"); assert.ok(toasts().includes("CSV downloaded"), toasts().join("|"));
    const csv = await blobs[0].text(); assert.ok(csv.startsWith("# groupBy=ecosystem"), csv.slice(0, 80)); assert.match(csv.split("\r\n")[0], /"origin":"ILLUSTRATIVE"/);
    assert.ok(!/USER_ENTERED/.test(csv.split("\r\n").filter((l) => !l.startsWith("#")).join("\n")), "the origin filter applies to the exported rows");
    // a failing export is reported and nothing is downloaded
    stubReports((u) => (String(u).includes("format=csv") ? json(503, { error: "Reporting is temporarily unavailable" }) : json(200, { rows: [], totals: [] })));
    ev(doc.querySelector("[data-action=download-csv]")); await sleep(600);
    assert.equal(clicks.length, 1, "no file after a failed export"); assert.ok(toasts().some((t) => /temporarily unavailable/.test(t)), toasts().join("|"));
  } finally { proto.click = origClick; unstub(); }
});

test("reports page: a field user sees only their own organization's projects", async () => {
  await login("field.trust@field.example"); unstub(); await nav("#/reports");
  const own = await apiGet(await apiToken("field.trust@field.example"), "/api/reports/registry?groupBy=project");
  const all = await apiGet(await apiToken("admin@nccr.example"), "/api/reports/registry?groupBy=project");
  assert.ok(all.rows.length > own.rows.length, "the seed has projects of other organizations");
  const text = doc.querySelector("#main").textContent;
  for (const r of own.rows) assert.ok(text.includes(r.key));
  for (const r of all.rows.filter((x) => !own.rows.some((o) => o.key === x.key))) assert.ok(!text.includes(r.key), `${r.key} belongs to another organization`);
});


// ───────── geospatial import and species (field user and reviewer) ─────────
const BOUNDARY_UI = { type: "Polygon", coordinates: [[[82.15, 16.85], [82.25, 16.85], [82.25, 16.95], [82.15, 16.95], [82.15, 16.85]]] };
const geoFile = (features, name = "survey.geojson") => new w.File([JSON.stringify({ type: "FeatureCollection", features })], name, { type: "application/geo+json" });
const ptF = (lon, lat, props = { species: "Rhizophora mucronata", count: 25, observedAt: "2026-06-01" }) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } });
const pick = (id, file) => { const input = doc.getElementById(id); Object.defineProperty(input, "files", { value: file ? [file] : [], configurable: true }); };
const S2 = {};
async function geoFixture() {
  if (S2.project) return S2;
  const { projectBody, recordBody } = require("./helpers");
  const org = (await db.query("SELECT organization_id FROM users WHERE email='field.trust@field.example'")).rows[0].organization_id;
  const adminTok = await apiToken("admin@nccr.example"), fieldTok = await apiToken("field.trust@field.example");
  const post = async (tok, p, body) => (await fetch(`${base}${p}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  S2.project = (await post(adminTok, "/api/projects", projectBody(org, { name: "UI boundary project", region: "Test Estuary", geometry: BOUNDARY_UI }))).project;
  S2.record = (await post(fieldTok, "/api/records", recordBody(S2.project.id, { observations: "Planting plots surveyed on foot: healthy propagules and restored tidal flow.", measurements: { survival_rate_pct: 80, avg_height_cm: 210, canopy_cover_pct: 55, seedlings_planted: 100 } }))).record;
  assert.ok(S2.project && S2.record, "fixture created");
  return S2;
}
const evCount = async () => Number((await db.query("SELECT COUNT(*) AS n FROM evidence")).rows[0].n);

test("geospatial import form: client checks, check-only run, rejected file, import, duplicate", async () => {
  await login("field.trust@field.example"); const fx = await geoFixture(); unstub(); await nav("#/evidence");
  const form = () => doc.querySelector("form[data-form=geo]");
  assert.ok(form(), "the import form is offered to field users"); assert.deepEqual(a11y(), []);
  assert.match(doc.querySelector("#geo-h").parentElement.textContent, /no drone is connected/);
  // client-side checks: nothing is sent
  const before = await evCount();
  ev(form(), "submit"); await sleep(200); assert.match(doc.getElementById("geo-error").textContent, /Choose the project/); assert.match(doc.getElementById("geo-error").textContent, /Choose a \.geojson file/);
  doc.getElementById("geo-project").value = String(fx.project.id); pick("geo-file", new w.File(["x"], "notes.txt")); ev(form(), "submit"); await sleep(200);
  assert.match(doc.getElementById("geo-error").textContent, /\.geojson extension/);
  pick("geo-file", new w.File([], "empty.geojson")); ev(form(), "submit"); await sleep(200); assert.match(doc.getElementById("geo-error").textContent, /empty/);
  assert.equal(await evCount(), before);
  // check only
  doc.getElementById("geo-record").value = String(fx.record.id); doc.getElementById("geo-tool").value = "SurveyKit";
  pick("geo-file", geoFile([ptF(82.2, 16.9), ptF(82.21, 16.91, { species: "Avicennia marina", count: 15 })]));
  ev(doc.querySelector("[data-action=geo-check]")); await sleep(1500);
  let res = doc.getElementById("geo-result").textContent;
  assert.match(res, /passed every check/); assert.match(res, /Inside the project boundary/); assert.match(res, /Counts found in the file \(unreviewed\)/); assert.match(res, /nothing has been stored/);
  assert.equal(await evCount(), before, "a check stores nothing"); assert.equal(doc.getElementById("geo-error").textContent, "");
  // a file the validator rejects
  pick("geo-file", geoFile([ptF(83.9, 16.9)])); ev(doc.querySelector("[data-action=geo-check]")); await sleep(1500);
  res = doc.getElementById("geo-result").textContent; assert.match(res, /cannot be imported/); assert.match(res, /POINT_OUTSIDE_BOUNDARY/);
  pick("geo-file", geoFile([ptF(83.9, 16.9)], "bad.geojson")); ev(form(), "submit"); await sleep(1500);
  res = doc.getElementById("geo-result").textContent; assert.match(res, /cannot be imported/); assert.match(res, /Nothing was stored/); assert.equal(await evCount(), before, "a rejected import stores nothing");
  assert.ok(!toasts().some((t) => /Imported as/.test(t)), "no success message for a rejected file");
  // a malformed file
  pick("geo-file", new w.File(["{broken"], "broken.geojson")); ev(form(), "submit"); await sleep(1500); assert.match(doc.getElementById("geo-result").textContent, /MALFORMED_JSON/);
  // import
  pick("geo-file", geoFile([ptF(82.2, 16.9), ptF(82.21, 16.91, { species: "Avicennia marina", count: 15 })])); ev(form(), "submit"); await sleep(2000);
  assert.ok(toasts().some((t) => /Imported as EV-/.test(t)), toasts().join("|")); assert.match(doc.getElementById("geo-result").textContent, /Imported as EV-\d+/);
  const row = (await db.query("SELECT e.kind, e.record_id, g.tool, g.boundary_status FROM geospatial_imports g JOIN evidence e ON e.id=g.evidence_id ORDER BY g.id DESC LIMIT 1")).rows[0];
  assert.deepEqual([row.kind, row.record_id, row.tool, row.boundary_status], ["GEOSPATIAL", fx.record.id, "SurveyKit", "INSIDE"]); assert.equal(await evCount(), before + 1);
  // the same file again
  pick("geo-file", geoFile([ptF(82.2, 16.9), ptF(82.21, 16.91, { species: "Avicennia marina", count: 15 })])); ev(form(), "submit"); await sleep(1500);
  assert.match(doc.getElementById("geo-result").textContent, /already registered as EV-/); assert.equal(await evCount(), before + 1);
  assert.deepEqual(a11y(), [], "form and results remain accessible");
});

test("geospatial import form is not offered to verifiers or administrators", async () => {
  for (const email of ["verifier1@verification.example", "admin@nccr.example"]) { await login(email); await nav("#/evidence"); assert.equal(doc.querySelector("form[data-form=geo]"), null, email); }
});

test("record page: species editor validates inline, saves, and reviewers see a read-only list with the declared-versus-imported comparison", async () => {
  await login("field.trust@field.example"); const fx = await geoFixture(); unstub(); await nav(`#/records/${fx.record.id}`);
  const form = () => doc.querySelector("form[data-form=species]");
  assert.ok(form(), "the collector can edit the species list of an open record"); assert.deepEqual(a11y(), []);
  const put = [], real = w.fetch; w.fetch = (u, o) => { if (o?.method === "PUT") put.push(u); return real(u, o); };
  try {
    const fill = (i, n, c) => { doc.getElementById(`sp-name-${i}`).value = n; doc.getElementById(`sp-count-${i}`).value = c; };
    fill(0, "Rhizophora mucronata", "25"); ev(doc.querySelector("[data-action=sp-add]")); await sleep(100); assert.ok(doc.getElementById("sp-name-1"), "a row was added with its own labelled fields");
    fill(1, "rhizophora  mucronata", "5"); ev(form(), "submit"); await sleep(300); assert.match(doc.getElementById("sp-error").textContent, /listed twice/); assert.equal(put.length, 0, "nothing sent");
    fill(1, "Avicennia marina", "2.5"); ev(form(), "submit"); await sleep(300); assert.match(doc.getElementById("sp-error").textContent, /whole number/); assert.equal(put.length, 0);
    fill(1, "Avicennia marina", "40"); ev(form(), "submit"); await sleep(1500);
  } finally { w.fetch = real; }
  assert.equal(put.length, 1); assert.ok(toasts().includes("Species list saved"), toasts().join("|"));
  const saved = (await db.query("SELECT species_name, planted_count FROM record_species WHERE record_id=$1 ORDER BY species_name", [fx.record.id])).rows;
  assert.deepEqual(saved.map((r) => [r.species_name, r.planted_count]), [["Avicennia marina", 40], ["Rhizophora mucronata", 25]]);
  await sleep(500); await nav(`#/records/${fx.record.id}?r=1`);
  const text = doc.querySelector("#main").textContent;
  assert.match(text, /species counts add up to 65, but the seedlings-planted measurement is 100/, "the inconsistency is stated, not hidden");
  assert.equal(doc.getElementById("sp-name-0").value, "Avicennia marina", "saved data survives a reload");
  // reviewer view: read-only, with comparison to the imported file
  await login("verifier1@verification.example"); await nav(`#/records/${fx.record.id}`);
  assert.equal(doc.querySelector("form[data-form=species]"), null, "reviewers cannot edit"); const vt = doc.querySelector("#main").textContent;
  assert.match(vt, /Planting by species and geospatial files/); assert.match(vt, /Declared and imported counts for EV-/); assert.match(vt, /In the imported file \(unreviewed\)/);
  assert.match(vt, /Inside the project boundary/); assert.match(vt, /SurveyKit/); assert.match(vt, /Differs/, "Rhizophora is declared 25 and imported 25: Avicennia declared 40 vs imported 15");
  assert.deepEqual(a11y(), []);
});

test("record page: a failing species or geospatial service is reported in place and the rest of the page still loads", async () => {
  await login("verifier1@verification.example"); const fx = await geoFixture(); unstub();
  const real = w.fetch; w.fetch = (u, o) => (String(u).includes("/species") ? Promise.resolve(json(500, { error: "Species service unavailable" })) : real(u, o));
  try { await nav(`#/records/${fx.record.id}?r=2`); } finally { unstub(); }
  const main = doc.querySelector("#main"); assert.match(main.textContent, /This section could not be loaded: Species service unavailable/);
  assert.ok(main.querySelector("h1").textContent.includes("RC-") || main.querySelector("h1").textContent.length > 0); assert.match(main.textContent, /Validation checks|Evidence checklist/, "the rest of the record is shown");
});


// ───────── disputes on a credit batch ─────────
const dspRows = () => db.query("SELECT code, status, category, reason FROM credit_disputes ORDER BY id").then((r) => r.rows);

test("credit batch: a verifier raises a dispute, an administrator reviews and decides it, and the page states the hold and its limits", async () => {
  await login("verifier1@verification.example"); unstub(); await nav("#/credits/1");
  const main = () => doc.querySelector("#main").textContent, form = () => doc.querySelector("form[data-form=dispute]");
  assert.match(main(), /Disputes/); assert.match(main(), /does not freeze, cancel or reverse the on-chain token/); assert.match(main(), /No concern has been raised/); assert.deepEqual(a11y(), []);
  assert.equal(doc.querySelector("[data-action=dsp-review]"), null);
  form().elements.reason.value = "too short"; ev(form(), "submit"); await sleep(300);
  assert.match(doc.getElementById("dsp-error").textContent, /at least 10 characters/); assert.equal(dialog(), null, "no confirmation for an invalid form"); assert.equal((await dspRows()).length, 0);
  form().elements.category.value = "CALCULATION"; form().elements.reason.value = "The survival rate used in this assessment looks inconsistent with the photographs.";
  ev(form(), "submit"); await sleep(300);
  assert.equal(dialog().querySelector("h2").textContent, "Raise a dispute on this credit batch?"); assert.match(dialog().textContent, /does not change the on-chain token/);
  dlgBtn("cancel").click(); await sleep(200); assert.equal((await dspRows()).length, 0, "cancelling raises nothing");
  ev(form(), "submit"); await sleep(300); dlgBtn("ok").click(); await sleep(1800);
  assert.ok(toasts().includes("Dispute raised"), toasts().join("|"));
  const rows = await dspRows(); assert.equal(rows.length, 1); assert.deepEqual([rows[0].status, rows[0].category], ["OPEN", "CALCULATION"]);
  assert.match(main(), new RegExp(`${rows[0].code}`)); assert.match(main(), /Transfers and retirements of this batch are paused/); assert.match(main(), /Open/);
  assert.equal(doc.querySelector("[data-action=dsp-review]"), null, "a verifier cannot run the review");
  assert.deepEqual(a11y(), []);
  // administrator
  await login("admin@nccr.example"); await nav("#/credits/1");
  assert.match(main(), /Transfers and retirements of this batch are paused/);
  ev(doc.querySelector("[data-action=dsp-review]")); await sleep(1800);
  assert.ok(toasts().includes("Review started"), toasts().join("|")); assert.equal((await dspRows())[0].status, "UNDER_REVIEW");
  ev(doc.querySelector("[data-action=dsp-decide][data-d=DISMISSED]")); await sleep(300);
  dlgBtn("ok").click(); await sleep(200); assert.match(dialog().querySelector("#dlg-e").textContent, /at least 10 characters/, "a decision needs a reason");
  dialog().querySelector("#dlg-r").value = "short"; dlgBtn("ok").click(); await sleep(200); assert.match(dialog().querySelector("#dlg-e").textContent, /at least 10 characters/);
  dialog().querySelector("#dlg-r").value = "The photographs were checked and support the survival rate."; dlgBtn("ok").click(); await sleep(1800);
  assert.ok(toasts().includes("Dispute dismissed"), toasts().join("|")); assert.equal((await dspRows())[0].status, "DISMISSED");
  assert.doesNotMatch(main(), /Transfers and retirements of this batch are paused/, "dismissal releases the hold");
  assert.match(main(), /History of DSP-/); assert.equal(doc.querySelectorAll("#main details table tbody tr").length, 3, "raised, review started, dismissed");
  assert.deepEqual(a11y(), []);
});

test("credit batch: upholding keeps the hold and says nothing on the blockchain changes; the holder can withdraw its own dispute", async () => {
  await login("verifier1@verification.example"); unstub(); await nav("#/credits/2");
  const main = () => doc.querySelector("#main").textContent, form = () => doc.querySelector("form[data-form=dispute]");
  form().elements.reason.value = "Possible overlap with an earlier project area."; ev(form(), "submit"); await sleep(300); dlgBtn("ok").click(); await sleep(1800);
  await login("admin@nccr.example"); await nav("#/credits/2"); ev(doc.querySelector("[data-action=dsp-review]")); await sleep(1800);
  ev(doc.querySelector("[data-action=dsp-decide][data-d=UPHELD]")); await sleep(300);
  assert.match(dialog().textContent, /deployed contract has no cancellation function/); assert.match(dialog().textContent, /nothing on the blockchain changes/);
  dialog().querySelector("#dlg-r").value = "The overlap is confirmed by the project boundaries."; dlgBtn("ok").click(); await sleep(1800);
  assert.ok(toasts().includes("Dispute upheld"), toasts().join("|"));
  assert.match(main(), /Transfers and retirements of this batch are paused/, "upheld keeps the hold"); assert.match(main(), /Upheld: hold remains/);
  assert.equal(doc.querySelector("[data-action=dsp-decide]"), null, "a decision is final");
  // the holder: sees the hold, raises its own concern and withdraws it
  await login("field.trust@field.example"); await nav("#/credits/1");
  assert.equal(doc.querySelector("[data-action=dsp-review]"), null, "holders cannot review");
  form().elements.reason.value = "Please clarify how the estimate was calculated."; form().elements.category.value = "OTHER"; ev(form(), "submit"); await sleep(300); dlgBtn("ok").click(); await sleep(1800);
  assert.ok(toasts().includes("Dispute raised"), toasts().join("|"));
  ev(doc.querySelector("[data-action=dsp-withdraw]")); await sleep(300); dlgBtn("ok").click(); await sleep(1800);
  assert.ok(toasts().includes("Dispute withdrawn"), toasts().join("|"));
  const last = (await dspRows()).at(-1); assert.equal(last.status, "WITHDRAWN");
  assert.doesNotMatch(main(), /Transfers and retirements of this batch are paused/);
  await nav("#/credits/2"); assert.match(main(), /Transfers and retirements of this batch are paused/, "the other batch is still held");
  assert.deepEqual(a11y(), []);
});


test("navigation: a slow page that finishes after the user moved on does not overwrite the current page or its handlers", async () => {
  await login("admin@nccr.example"); unstub(); await nav("#/overview");
  const real = realFetch();
  w.fetch = (u, o) => (String(u).includes("/api/reports/registry") ? new Promise((r) => setTimeout(() => r(json(200, { rows: [], totals: [], notes: [], generatedAt: new Date().toISOString(), groupBy: "project", heading: "Project", truncated: false, maxRows: 500 })), 900)) : real(u, o));
  try {
    w.location.hash = "#/reports?slow=1"; await sleep(150);               // the slow page starts loading
    w.location.hash = "#/evidence"; await sleep(2000);                    // the user has already moved on; the slow reply arrives meanwhile
  } finally { unstub(); }
  const main = doc.querySelector("#main");
  assert.equal(main.querySelector("h1").textContent.trim(), "Evidence repository", "the page the user is on is the one shown");
  assert.equal(main.querySelector("form[data-form=filters][aria-label='Report filters']"), null, "the slow page did not render over it");
  assert.equal(doc.title.startsWith("Evidence repository"), true, doc.title);
  assert.ok(main.querySelector("[data-action=ev-view], table"), "its content is in place");
});

test("whole session: no script errors and no prohibited wording anywhere in the rendered interface", () => {
  assert.deepEqual(errors, []);
  assert.deepEqual(wording, []);
});
