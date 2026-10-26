// database/seed.js — deterministic ILLUSTRATIVE reference dataset.
//
// Every record below is fictional and stored with data_origin = ILLUSTRATIVE: it was NOT collected in the field and
// does not represent real restoration outcomes, NCCR data or real credits. The records are created by calling the real
// service layer (not by inserting finished rows), so verification decisions, blockchain transactions and audit entries
// are genuine for the local blockchain network.
//
// Usage:  node database/seed.js            (needs PostgreSQL migrated + local chain deployed; RESETS all data)
// Refuses to run with NODE_ENV=production.
const path = require("path");
const BACKEND = path.join(__dirname, "..", "backend");
process.chdir(BACKEND);
const bcrypt = require(require.resolve("bcryptjs", { paths: [BACKEND] }));
const cfg = require(path.join(BACKEND, "src/config"));
const db = require(path.join(BACKEND, "src/db"));
const chain = require(path.join(BACKEND, "src/services/chain"));
const projects = require(path.join(BACKEND, "src/services/projects"));
const records = require(path.join(BACKEND, "src/services/records"));
const evidence = require(path.join(BACKEND, "src/services/evidence"));
const credits = require(path.join(BACKEND, "src/services/credits"));
const audit = require(path.join(BACKEND, "src/services/audit"));

const svg = (title, line2) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#dcebe3"/>` +
  `<path d="M0 300 Q160 250 320 300 T640 290 V400 H0Z" fill="#9cc9b8"/><circle cx="520" cy="80" r="34" fill="#f2d98c"/>` +
  `<text x="24" y="52" font-family="sans-serif" font-size="26" font-weight="bold" fill="#0b4a3a">ILLUSTRATIVE IMAGE - NOT A FIELD PHOTOGRAPH</text>` +
  `<text x="24" y="90" font-family="sans-serif" font-size="18" fill="#0b4a3a">${title}</text><text x="24" y="118" font-family="sans-serif" font-size="14" fill="#0b4a3a">${line2}</text></svg>`);

async function seed({ log = console.log } = {}) {
  if (cfg.isProd) throw new Error("Refusing to seed the reference dataset with NODE_ENV=production");
  const st = await chain.init();
  if (!st.ready) throw new Error(`Blockchain not available (${st.error}). Start the local node and deploy first.`);
  if (cfg.chain.mode !== "local") throw new Error("Seeding requires CHAIN_MODE=local (unlocked development accounts)");
  const acct = chain.accounts.map((a) => a.address);

  await db.query(`TRUNCATE audit_logs, credit_events, credit_balances, carbon_credits, carbon_calculations, verification_records, blockchain_transactions,
    evidence, monitoring_records, projects, users, organizations RESTART IDENTITY CASCADE`);

  // ── organizations (fictional, except the NCCR oversight role which is represented by a reference account) ──
  const orgDefs = [
    ["nccr", "NCCR Registry Administration", "REGULATOR", acct[0]],
    ["ver", "Independent Verification Body", "VERIFICATION_BODY", acct[1]],
    ["trust", "Coastal Restoration Trust", "NGO", acct[4]],
    ["village", "Village Mangrove Collective", "COMMUNITY", acct[5]],
    ["panchayat", "Gram Panchayat Seagrass Group", "PANCHAYAT", acct[6]],
    ["research", "Marine Research Foundation", "RESEARCH", acct[7]],
    ["buyer", "Offset Buyer Ltd", "CREDIT_HOLDER", acct[8]],
  ];
  const org = {};
  for (const [k, name, type, wallet] of orgDefs)
    org[k] = (await db.query("INSERT INTO organizations (name, org_type, wallet_address, is_synthetic) VALUES ($1,$2,$3,TRUE) RETURNING id", [name, type, wallet])).rows[0].id;

  const hash = await bcrypt.hash(cfg.referencePassword, cfg.bcryptRounds);
  const userDefs = [
    ["admin", "Registry Administrator", "admin@nccr.example", "NCCR_ADMIN", "nccr", acct[0]],
    ["v1", "Verifier One", "verifier1@verification.example", "VERIFIER", "ver", acct[1]],
    ["v2", "Verifier Two", "verifier2@verification.example", "VERIFIER", "ver", acct[3]],
    ["trust", "Trust Field Officer", "field.trust@field.example", "FIELD_USER", "trust", null],
    ["village", "Village Field Volunteer", "field.village@field.example", "FIELD_USER", "village", null],
    ["panchayat", "Panchayat Field Worker", "field.panchayat@field.example", "FIELD_USER", "panchayat", null],
    ["research", "Research Technician", "field.research@field.example", "FIELD_USER", "research", null],
    ["buyer", "Buyer Representative", "buyer@field.example", "FIELD_USER", "buyer", null],
  ];
  const U = {};
  for (const [k, name, email, role, o, wallet] of userDefs)
    U[k] = (await db.query("INSERT INTO users (name,email,password_hash,role,organization_id,wallet_address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [name, email, hash, role, org[o], wallet])).rows[0];

  // ── projects (admin creates them) ──
  const mkProject = (p) => projects.create(U.admin, { ...p, organizationId: org[p.org], dataOrigin: "ILLUSTRATIVE" });
  const poly = (lat, lon, d = 0.004) => ({ type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });
  const P = {};
  const defs = [
    ["p1", { code: "BCP-0001", name: "Estuary Mangrove Belt A", description: "Mangrove replanting along an estuary.", ecosystemType: "MANGROVE", restorationType: "MANGROVE_PLANTATION", climateRegion: "TROPICAL_WET", revegetationMethod: "PLANTED", region: "Estuary Zone 1", latitude: 16.78, longitude: 82.28, areaHectares: 45, startDate: "2019-07-01", org: "trust" }],
    ["p2", { code: "BCP-0002", name: "Lagoon Seagrass Meadow B", description: "Seagrass transplanting in a lagoon.", ecosystemType: "SEAGRASS", restorationType: "SEAGRASS_TRANSPLANT", region: "Lagoon Zone 2", latitude: 9.62, longitude: 79.12, areaHectares: 18, startDate: "2021-03-01", org: "panchayat" }],
    ["p3", { code: "BCP-0003", name: "Tidal Marsh Restoration C", description: "Salt-marsh re-vegetation on a tidal flat.", ecosystemType: "SALT_MARSH", restorationType: "SALT_MARSH_REVEGETATION", region: "Tidal Flats Zone 3", latitude: 21.1, longitude: 72.55, areaHectares: 30, startDate: "2022-01-15", org: "research" }],
    ["p4", { code: "BCP-0004", name: "Creek Mangrove Regeneration D", description: "Hydrological restoration plus natural regeneration.", ecosystemType: "MANGROVE", restorationType: "HYDROLOGICAL_RESTORATION", climateRegion: "TROPICAL_WET", revegetationMethod: "NATURAL_RECOLONISATION", region: "Creek Zone 4", latitude: 20.3, longitude: 86.7, areaHectares: 12, startDate: "2022-06-01", org: "village" }],
    ["p5", { code: "BCP-0005", name: "Village Mangrove Plot E", description: "Community plot protection and enrichment planting.", ecosystemType: "MANGROVE", restorationType: "NATURAL_REGENERATION_PROTECTION", climateRegion: "TROPICAL_WET", revegetationMethod: "NATURAL_RECOLONISATION", region: "Village Coast Zone 5", latitude: 13.5, longitude: 80.2, areaHectares: 9, startDate: "2023-02-01", org: "village" }],
    ["p7", { code: "BCP-0007", name: "Estuary Mangrove Belt G", description: "Mangrove replanting assessed with the sourced IPCC Tier 1 methodology, which is pending independent review.", ecosystemType: "MANGROVE", restorationType: "MANGROVE_PLANTATION", climateRegion: "TROPICAL_WET", revegetationMethod: "PLANTED", methodologyVersion: "IPCC-WS2013-T1-v1", region: "Estuary Zone 7", latitude: 22.1, longitude: 88.6, areaHectares: 25, startDate: "2021-01-01", org: "trust" }],
    ["p6", { code: "BCP-0006", name: "Delta Mangrove Belt F", description: "Large mangrove plantation in a delta.", ecosystemType: "MANGROVE", restorationType: "MANGROVE_PLANTATION", climateRegion: "TROPICAL_WET", revegetationMethod: "PLANTED", region: "Delta Zone 6", latitude: 21.9, longitude: 88.8, areaHectares: 60, startDate: "2020-08-01", org: "trust" }],
  ];
  for (const [k, d] of defs) { P[k] = await mkProject({ ...d, geometry: poly(d.latitude, d.longitude) }); }

  // ── helpers that go through the real service layer ──
  const jitter = (n) => ((n * 7919) % 100) / 100000; // deterministic small coordinate offsets
  async function fieldRecord(actor, proj, def, evidenceSpecs, { submit = true } = {}) {
    const rec = await records.create(actor, { projectId: P[proj].id, ...def, latitude: Number(P[proj].latitude) + jitter(def.seed), longitude: Number(P[proj].longitude) + jitter(def.seed + 1) });
    for (const [i, e] of evidenceSpecs.entries()) {
      const buf = svg(`${P[proj].code} / ${e.kind}`, `${def.activityDate} - ${e.label || "supporting evidence"} #${i + 1}`);
      await evidence.add(actor, { projectId: P[proj].id, recordId: rec.id, kind: e.kind, captureDate: def.activityDate, platform: e.platform, altitudeM: e.altitudeM,
        latitude: Number(P[proj].latitude) + jitter(def.seed + i), longitude: Number(P[proj].longitude) + jitter(def.seed + i + 2), externalRef: e.externalRef, notes: "Illustrative record" },
        e.externalRef ? null : { buffer: buf, originalname: `${P[proj].code}-${e.kind}-${i + 1}.svg` }, { allowSvg: true, origin: "ILLUSTRATIVE" });
    }
    const out = submit ? await records.submit(actor, rec.id) : rec;
    return out.id ? out : rec;
  }
  const reviewAll = async (v, recId) => { const e = (await evidence.list(v, { recordId: recId, pageSize: 100 })).evidence; for (const x of e) await evidence.review(v, x.id, { decision: "VERIFIED", notes: "Reviewed against the submitted checklist" }); return e; };
  const photos = [{ kind: "FIELD_PHOTO", label: "plot photo" }, { kind: "FIELD_PHOTO", label: "transect photo" }];
  const drone = { kind: "DRONE_IMAGERY", label: "drone orthomosaic tile", platform: "Quadcopter (illustrative record)", altitudeM: 90 };
  const survey = (seed, date, area, survival, extra = {}) => ({ seed, activityType: "MONITORING_SURVEY", activityDate: date, areaHa: area,
    observations: `Survey ${date}: plots inspected, propagule establishment and tidal flushing noted.`, measurements: { survival_rate_pct: survival, avg_height_cm: 120 + seed, canopy_cover_pct: 40 + (seed % 30), ...extra }, locationAccuracyM: 4 });

  // P1 + P6: full lifecycle through to issued credits
  for (const [proj, actor, seedBase, date, area, survival] of [["p1", U.trust, 11, "2025-11-15", 38, 82], ["p6", U.trust, 23, "2025-12-10", 52, 76]]) {
    const r = await fieldRecord(actor, proj, survey(seedBase, date, area, survival), [...photos, drone]);
    await records.startReview(U.v1, r.id);
    await reviewAll(U.v1, r.id);
    await records.decide(U.v1, r.id, { decision: "VERIFIED", comments: "Evidence and measurements are consistent." });
    const calc = await credits.calculate(U.v1, r.id);
    await credits.approve(U.admin, calc.id, { decision: "APPROVED", notes: "Assessment reviewed and approved for issuance." });
    const issued = await credits.issue(U.admin, calc.id);
    P[proj].issuedCreditId = issued.credit.id; P[proj].issuedQty = issued.credit.amount_tonnes;
  }
  // secondary ownership events on P1 credits: transfer to buyer, partial retirement
  await credits.moveCredits(U.trust, P.p1.issuedCreditId, "TRANSFERRED", { toOrgId: org.buyer, amount: 25 });
  await credits.moveCredits(U.buyer, P.p1.issuedCreditId, "RETIRED", { amount: 10, reason: "Voluntary retirement" });
  // P6: a further draft record still being prepared in the field
  await fieldRecord(U.trust, "p6", { ...survey(31, "2026-03-05", 20, 79), activityType: "MAINTENANCE" }, [photos[0]], { submit: false });

  // P2: verified + estimate calculated, awaiting NCCR approval; plus a second record just submitted
  const r2 = await fieldRecord(U.panchayat, "p2", { ...survey(41, "2026-02-20", 17, 71), measurements: { survival_rate_pct: 71, shoot_density_per_m2: 340, sediment_depth_cm: 22 } }, [...photos, drone]);
  await records.startReview(U.v2, r2.id); await reviewAll(U.v2, r2.id);
  await records.decide(U.v2, r2.id, { decision: "VERIFIED", comments: "Seagrass density and photos are consistent." });
  await credits.calculate(U.v2, r2.id);
  await fieldRecord(U.panchayat, "p2", survey(43, "2026-08-18", 17, 73), [photos[0]]);

  // P3: under review (evidence pending), including reference-only remote-sensing scene
  const r3 = await fieldRecord(U.research, "p3", survey(51, "2026-07-25", 26, 64, { shoot_density_per_m2: 210 }), [photos[0], drone, { kind: "REMOTE_SENSING", externalRef: "scene-0003 (external reference, no file held)" }]);
  await records.startReview(U.v1, r3.id);
  await evidence.review(U.v1, (await evidence.list(U.v1, { recordId: r3.id })).evidence[0].id, { decision: "VERIFIED", notes: "Reviewed against the submitted checklist" });

  // P4: rejected
  const r4 = await fieldRecord(U.village, "p4", survey(61, "2026-05-09", 11, 55), [photos[0]]);
  await records.startReview(U.v2, r4.id);
  await records.decide(U.v2, r4.id, { decision: "REJECTED", comments: "Submitted photos do not correspond to the claimed plot." });

  // P5: needs revision
  const r5 = await fieldRecord(U.village, "p5", survey(71, "2026-06-30", 8, 68), [photos[0]]);
  await records.startReview(U.v1, r5.id);
  await records.decide(U.v1, r5.id, { decision: "NEEDS_REVISION", comments: "Add a second geotagged photo and confirm the plot area." });

  // P7: verified record assessed with the sourced methodology. It is NOT issuable: the methodology has no independent review and the
  // project has no accepted baseline, additionality, leakage or non-permanence determinations.
  const r7 = await fieldRecord(U.trust, "p7", { ...survey(81, "2025-10-20", 22, 78), measurements: { survival_rate_pct: 78, canopy_cover_pct: 60, avg_height_cm: 210 } }, [...photos, drone]);
  await records.startReview(U.v1, r7.id); await reviewAll(U.v1, r7.id);
  await records.decide(U.v1, r7.id, { decision: "VERIFIED", comments: "Evidence and measurements are consistent." });
  await credits.calculate(U.v1, r7.id);

  const counts = {};
  for (const t of ["organizations", "users", "projects", "monitoring_records", "evidence", "verification_records", "carbon_calculations", "carbon_credits", "blockchain_transactions", "audit_logs"])
    counts[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  const chainCheck = await audit.verifyChain();
  log("Seeded illustrative reference dataset:", JSON.stringify(counts), "| audit chain ok:", chainCheck.ok);
  return counts;
}

module.exports = { seed };

if (require.main === module) {
  seed().then(() => db.end()).then(() => process.exit(0)).catch((e) => { console.error("Seed failed:", e.message); process.exit(1); });
}
