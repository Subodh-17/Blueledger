// e2e/browser.spec.js — real-Chromium workflows, keyboard and mobile checks, accessibility scan. Started by e2e/run.js.
// Reports every check as PASS or FAIL and exits non-zero on any failure. Nothing here is mocked: real server, database, evidence storage and chain.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { projectBody, recordBody } = require("../backend/tests/helpers");

const BASE = process.env.E2E_BASE, TMP = process.env.E2E_TMP, PASSWORD = process.env.REFERENCE_PASSWORD;
const SHOTS = process.env.E2E_SHOTS || path.join(TMP, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
let axeSource = null;
for (const dir of [process.env.E2E_AXE_DIR, process.cwd(), ...String(process.env.NODE_PATH || "").split(path.delimiter)].filter(Boolean)) { try { axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js", { paths: [dir] }), "utf8"); break; } catch { /* next */ } }

const results = []; const problems = []; const notOk = [];
let lastPage = null; const dumps = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok && lastPage && process.env.E2E_DEBUG) { const pg = lastPage; dumps.push(pg.evaluate(() => `${location.hash} :: ${(document.querySelector("#main") || document.body).innerText.replace(/\s+/g, " ").slice(0, 600)}`).then((t) => console.log(`   [page at failure] ${t}`)).catch(() => {})); }
};
const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message).split("\n")[0].slice(0, 300)); } };
const USERS = { admin: "admin@nccr.example", verifier: "verifier1@verification.example", field: "field.trust@field.example" };
const api = async (token, p, body, method = body ? "POST" : "GET") => { const r = await fetch(`${BASE}/api${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const tokenFor = async (who) => (await api(null, "/auth/login", { email: USERS[who], password: PASSWORD })).body.token;

async function newPage(browser, who, viewport = { width: 1280, height: 800 }, mobile = false) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${who} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`${who} console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 500) problems.push(`${who} ${r.status()} ${r.url()}`); if (r.status() >= 400) notOk.push(`${who} ${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`); });
  await page.goto(`${BASE}/`); await page.fill("#email", USERS[who]); await page.fill("#password", PASSWORD); await page.press("#password", "Enter");
  await page.waitForSelector("#main h1", { timeout: 15000 });
  return { ctx, page };
}
// The previous page's heading is still in the DOM when the hash changes, so it is marked stale first; the route has rendered when a fresh heading appears.
const go = async (page, hash) => {
  lastPage = page;
  await page.evaluate((h) => { const t = document.querySelector("#main h1"); if (t) t.dataset.stale = "1"; if (location.hash === h) location.hash = "#/__"; location.hash = h; }, hash);
  await page.waitForSelector("#main h1:not([data-stale])", { timeout: 20000 }); await page.waitForLoadState("networkidle");
};
const text = (page, sel = "#main") => page.locator(sel).first().innerText();
const toastText = (page) => page.locator("[role=status], .toast").allInnerTexts().then((t) => t.join(" | "));

(async () => {
  const browser = await chromium.launch();
  try {
    // ── fixtures through the API (as the real users) ──
    const adminTok = await tokenFor("admin"), fieldTok = await tokenFor("field"), verTok = await tokenFor("verifier");
    const me = (await api(fieldTok, "/auth/me")).body; const orgId = (me.user || me).organizationId ?? (me.user || me).organization_id;
    const BOUNDARY = { type: "Polygon", coordinates: [[[82.15, 16.85], [82.25, 16.85], [82.25, 16.95], [82.15, 16.95], [82.15, 16.85]]] };
    const project = (await api(adminTok, "/projects", projectBody(orgId, { name: "Browser journey project (sample data)", region: "Test Estuary", geometry: BOUNDARY }))).body.project;
    const record = (await api(fieldTok, "/records", recordBody(project.id, { activityDate: "2026-06-01", observations: "Planting plots surveyed on foot: healthy propagules and restored tidal flow.", measurements: { survival_rate_pct: 80, avg_height_cm: 210, canopy_cover_pct: 55, seedlings_planted: 100 } }))).body.record;
    check("fixtures created through the API (project with boundary, draft record)", !!project && !!record);
    const good = path.join(TMP, "survey.geojson"), bad = path.join(TMP, "outside.geojson");
    const pt = (lon, lat, props) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } });
    fs.writeFileSync(good, JSON.stringify({ type: "FeatureCollection", features: [pt(82.2, 16.9, { species: "Rhizophora mucronata", count: 25, observedAt: "2026-06-01" }), pt(82.21, 16.91, { species: "Avicennia marina", count: 15, observedAt: "2026-06-01" })] }));
    fs.writeFileSync(bad, JSON.stringify({ type: "FeatureCollection", features: [pt(83.9, 16.9, { species: "Rhizophora mucronata", count: 5 })] }));

    // ── sign-in page, keyboard ──
    await step("sign-in", async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const page = await ctx.newPage(); await page.goto(`${BASE}/`);
      await page.waitForSelector("#email"); await page.keyboard.press("Tab");
      check("the sign-in form is reachable and labelled", (await page.locator("label[for=email]").count()) === 1 && (await page.locator("label[for=password]").count()) === 1);
      await page.fill("#email", USERS.field); await page.fill("#password", "wrong-password-123"); await page.press("#password", "Enter"); await page.waitForTimeout(1200); lastPage = page;
      check("a wrong password is refused with a visible message and no session", /Invalid email or password/.test(await text(page, "body")) && (await page.evaluate(() => Object.keys(sessionStorage).length)) === 0 && (await page.locator("#sidebar").count()) === 0);
      await ctx.close();
    });

    // ── field collector, desktop: geospatial import, species, keyboard order ──
    const F = await newPage(browser, "field"); const fp = F.page;
    await step("geospatial import in the browser", async () => {
      await go(fp, "#/evidence");
      check("the import form is offered to the collector", (await fp.locator("form[data-form=geo]").count()) === 1);
      const order = []; await fp.focus("#geo-project");
      for (let i = 0; i < 9; i++) { order.push(await fp.evaluate(() => document.activeElement.id || document.activeElement.dataset?.action || document.activeElement.tagName)); await fp.keyboard.press("Tab"); }
      check("keyboard order follows the form: project, record, source, tool, version, file, check, import", ["geo-project", "geo-record", "geo-source", "geo-tool", "geo-version", "geo-file"].every((id, i) => order[i] === id) && order.includes("geo-check"), order.join(" > "));
      await fp.selectOption("#geo-project", String(project.id)); await fp.selectOption("#geo-record", String(record.id)); await fp.fill("#geo-tool", "SurveyKit");
      await fp.click("[data-action=geo-check]"); await fp.waitForTimeout(300);
      check("submitting without a file is stopped with a message", /Choose a \.geojson file/.test(await text(fp, "#geo-error")));
      await fp.setInputFiles("#geo-file", bad); await fp.click("[data-action=geo-check]"); await fp.waitForFunction(() => /cannot be imported/.test(document.getElementById("geo-result").innerText), null, { timeout: 10000 });
      check("a file outside the project boundary is rejected with the validator's report", /cannot be imported/.test(await text(fp, "#geo-result")) && /POINT_OUTSIDE_BOUNDARY/.test(await text(fp, "#geo-result")));
      await fp.setInputFiles("#geo-file", good); await fp.click("[data-action=geo-check]"); await fp.waitForFunction(() => /passed every check/.test(document.getElementById("geo-result").innerText), null, { timeout: 10000 });
      check("a valid file passes the check, shows the boundary result and the unreviewed counts, and stores nothing", /Inside the project boundary/.test(await text(fp, "#geo-result")) && /unreviewed/.test(await text(fp, "#geo-result")) && (await api(fieldTok, "/geospatial/imports")).body.imports.length === 0);
      await fp.click("form[data-form=geo] button[type=submit]"); await fp.waitForFunction(() => /Imported as EV-/.test(document.getElementById("geo-result").innerText), null, { timeout: 15000 });
      check("the import succeeds and is stored", (await api(fieldTok, "/geospatial/imports")).body.imports.length === 1);
      await fp.reload(); await fp.waitForSelector("#main h1"); await fp.waitForLoadState("networkidle");
      check("after a reload the imported file is listed as geospatial evidence", /Geospatial import/.test(await text(fp)));
    });
    await step("species editor in the browser", async () => {
      await go(fp, `#/records/${record.id}`);
      await fp.fill("#sp-name-0", "Rhizophora mucronata"); await fp.fill("#sp-count-0", "25"); await fp.click("[data-action=sp-add]"); await fp.fill("#sp-name-1", "Avicennia marina"); await fp.fill("#sp-count-1", "15");
      await fp.click("form[data-form=species] button[type=submit]"); await fp.waitForFunction(() => /Species list saved/.test(document.body.innerText), null, { timeout: 10000 });
      await fp.reload(); await fp.waitForSelector("#sp-name-0"); await fp.waitForLoadState("networkidle");
      check("the species list survives a reload", (await fp.inputValue("#sp-name-0")) === "Avicennia marina" && (await fp.inputValue("#sp-count-1")) === "25");
      check("a difference from the seedlings measurement is stated", /add up to 40, but the seedlings-planted measurement is 100/.test(await text(fp)));
    });

    // ── reviewer and administrator ──
    const V = await newPage(browser, "verifier"); const vp = V.page;
    await step("reviewer view", async () => {
      await go(vp, `#/records/${record.id}`); const t = await text(vp);
      check("the reviewer sees the species list read-only with the declared-versus-imported comparison", !(await vp.locator("form[data-form=species]").count()) && /Declared and imported counts for EV-/.test(t) && /Inside the project boundary/.test(t));
    });
    const A = await newPage(browser, "admin"); const ap = A.page;
    await step("registry reports in the browser", async () => {
      await go(ap, "#/reports"); check("the reports page lists the seeded illustrative data under its own label", /Illustrative sample data/.test(await text(ap)));
      await ap.selectOption("#groupBy", "ecosystem"); await ap.click("form[data-form=filters] button[type=submit]"); await ap.waitForFunction(() => location.hash.includes("groupBy=ecosystem")); await ap.waitForSelector("#main table", { timeout: 15000 }); await ap.waitForLoadState("networkidle");
      check("changing the grouping reloads the tables", /Ecosystem/.test(await text(ap)) && (await ap.locator("#main table").count()) >= 4);
      const [dl] = await Promise.all([ap.waitForEvent("download", { timeout: 15000 }), ap.click("[data-action=download-csv]")]);
      const csv = fs.readFileSync(await dl.path(), "utf8");
      check("the CSV download carries the current grouping, the notes and the column header", dl.suggestedFilename() === "registry-report-ecosystem.csv" && csv.startsWith("# groupBy=ecosystem") && /key,label,data_origin,projects/.test(csv));
      check("the export needs a session", (await fetch(`${BASE}/api/reports/registry?format=csv`)).status === 401);
    });
    await step("dispute dialog in the browser", async () => {
      await go(vp, "#/credits/1"); await vp.selectOption("#dsp-category", "CALCULATION"); await vp.fill("#dsp-reason", "The survival rate looks inconsistent with the photographs."); await vp.click("form[data-form=dispute] button[type=submit]");
      await vp.waitForSelector(".modal"); const focusInside = await vp.evaluate(() => document.querySelector(".modal").contains(document.activeElement));
      check("the confirmation dialog takes keyboard focus", focusInside); await vp.keyboard.press("Escape"); await vp.waitForTimeout(300);
      check("Escape closes the dialog and nothing was raised", !(await vp.locator(".modal").count()) && (await api(adminTok, "/disputes")).body.disputes.length === 0);
      await vp.click("form[data-form=dispute] button[type=submit]"); await vp.waitForSelector(".modal"); await vp.click(".modal [data-x=ok]"); await vp.waitForFunction(() => /Transfers and retirements of this batch are paused/.test(document.body.innerText), null, { timeout: 10000 });
      check("raising a dispute shows the hold and its limit", /does not freeze, cancel or reverse the on-chain token/.test(await text(vp)));
      await go(ap, "#/credits/1"); await ap.click("[data-action=dsp-review]"); await ap.waitForSelector("[data-action=dsp-decide]"); await ap.click("[data-action=dsp-decide][data-d=DISMISSED]"); await ap.waitForSelector(".modal");
      await ap.fill("#dlg-r", "The photographs support the survival rate."); await ap.click(".modal [data-x=ok]"); await ap.waitForFunction(() => !/Transfers and retirements of this batch are paused/.test(document.body.innerText), null, { timeout: 10000 });
      check("an administrator reviews and dismisses it, and the hold is released", (await api(adminTok, "/disputes")).body.disputes[0].status === "DISMISSED");
    });

    // ── mobile layout and accessibility, every role ──
    const PAGES = { admin: ["#/overview", "#/projects", "#/assessments", "#/reports", "#/credits", "#/credits/1", "#/administration"], verifier: ["#/overview", "#/review", "#/evidence", "#/reports", `#/records/${record.id}`], field: ["#/overview", "#/field", "#/evidence", "#/reports", `#/records/${record.id}`, "#/credits/1"] };
    for (const who of ["admin", "verifier", "field"]) {
      const M = await newPage(browser, who, { width: 390, height: 844 }, true);
      for (const hash of PAGES[who]) await step(`mobile ${who} ${hash}`, async () => {
        await go(M.page, hash);
        const m = await M.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, main: !!document.querySelector("#main h1"), burger: !!document.querySelector("[data-action=nav-open]") && getComputedStyle(document.querySelector("[data-action=nav-open]")).display !== "none" }));
        check(`390 px wide, ${who} ${hash}: no horizontal scrolling, content shown, navigation toggle available`, m.sw <= m.iw + 1 && m.main && m.burger, JSON.stringify(m));
        if (["#/reports", "#/evidence"].includes(hash)) await M.page.screenshot({ path: path.join(SHOTS, `mobile-${who}-${hash.replace(/[^a-z]/gi, "")}.png`), fullPage: true });
      });
      await M.ctx.close();
    }
    if (axeSource) {
      const roles = { admin: [A.page, PAGES.admin], verifier: [V.page, PAGES.verifier], field: [F.page, PAGES.field] };
      for (const [who, [page, hashes]] of Object.entries(roles)) for (const hash of hashes) await step(`axe ${who} ${hash}`, async () => {
        await go(page, hash); await page.evaluate(axeSource);
        const res = await page.evaluate(() => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
        const bad = res.violations.filter((v) => ["serious", "critical"].includes(v.impact));
        check(`axe (WCAG 2.1 A/AA) ${who} ${hash}: no serious or critical violations (${res.violations.length} total, ${res.passes.length} rules passed)`, bad.length === 0, bad.map((v) => `${v.id}[${v.nodes.length}]: ${v.nodes[0].target.join(" ")}`).join("; "));
      });
    } else check("axe-core scan", false, "axe-core not found; install it (npm install axe-core) and set E2E_AXE_DIR");
    check("no script errors, no failed server responses (5xx) during the whole session", problems.length === 0, problems.slice(0, 5).join(" | "));
  } finally { await browser.close(); }
  await Promise.all(dumps); const failed = results.filter((r) => !r.ok).length;
  if (notOk.length) console.log(`\nResponses with status >= 400 (${notOk.length}); first 12:\n  ${notOk.slice(0, 12).join("\n  ")}`);
  console.log(`\nBROWSER E2E: ${results.length - failed} passed, ${failed} failed, ${results.length} checks. Screenshots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("E2E crashed:", e); process.exit(1); });
