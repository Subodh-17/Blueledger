// Unit tests for the carbon assessment engine (no database or chain). Expected values were derived independently
// (separate arithmetic from the published parameters in the cited tables), not by calling the engine.
const test = require("node:test");
const assert = require("node:assert/strict");
const carbon = require("../src/services/carbon");
const defs = require("../src/methodology/definitions");

const IPCC = "IPCC-WS2013-T1-v1", ILL = "ILLUSTRATIVE-BC-v1";
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const proj = (over = {}) => ({ ecosystem_type: "MANGROVE", climate_region: "TROPICAL_WET", revegetation_method: "PLANTED", start_date: "2021-01-01", area_hectares: 50, bufferPercent: 15, ...over });
const rec = (over = {}) => ({ area_ha: 10, activity_date: "2025-01-01", measurements: { canopy_cover_pct: 60, survival_rate_pct: 80 }, ...over });
const P4 = { start: "2021-01-01", end: "2025-01-01" }; // 1461 days = exactly 4.0000 years at 365.25 d/yr

test("worked example A (mangrove, tropical wet, planted): pools, 44/12 conversion, lower/upper bounds and buffered eligible quantity", () => {
  // per ha-year, central: AGB 9.9*(1+0.49)*0.451 = 6.6527 tC + soil 1.62 tC; cap not reached. x 10 ha x 4 yr x 44/12.
  const e = carbon.estimate(IPCC, { project: proj(), record: rec(), period: P4 });
  near(e.result.periodYears, 4);
  near(e.result.tCarbon.biomass, 266.108, 0.01); near(e.result.tCarbon.soil, 64.8, 0.01);
  near(e.result.centralTCO2e, 1213.3295, 0.01);
  near(e.result.lowerBoundTCO2e, 1060.0952, 0.01);  // 9.4*1.47*0.429 + 1.3 per ha-yr
  near(e.result.upperBoundTCO2e, 1378.1657, 0.01);  // 10.4*1.51*0.471 + 2.0 per ha-yr
  near(e.result.bufferDeductionTCO2e, 159.0143, 0.01);
  assert.equal(e.result.eligibleCredits, 901);       // floor(1060.0952 * 0.85)
  assert.equal(e.methodologyStatus, "PENDING_REVIEW");
  assert.deepEqual(e.blockers, []);
});

test("worked example A2 (100 ha reference project): exact arithmetic reconciliation with Section 7 validation document", () => {
  // 100 ha over a full 4-year monitoring cycle (1461 days = exactly 4.0000 Julian years at 365.25 d/yr)
  const e = carbon.estimate(IPCC, { project: proj({ area_hectares: 100 }), record: rec({ area_ha: 100 }), period: P4 });
  near(e.result.periodYears, 4.0);

  // Intermediate carbon pool assertions (4-year totals for 100 ha):
  // Central biomass tC: 100 ha * 9.9 * (1 + 0.49) * 0.451 * 4 yr = 2,661.0804 t C
  near(e.result.tCarbon.biomass, 2661.0804, 0.01);
  // Central soil tC: 100 ha * 1.62 * 4 yr = 648.0000 t C
  near(e.result.tCarbon.soil, 648.0, 0.01);
  // Central total tC: 2,661.0804 + 648.0000 = 3,309.0804 t C
  near(e.result.tCarbon.total, 3309.0804, 0.01);

  // Central gross tCO2e: 3,309.0804 * 44 / 12 = 12,133.2948 tCO2e -> Annualized: 3,033.3237 tCO2e/yr
  near(e.result.centralTCO2e, 12133.2948, 0.01);
  near(e.result.centralTCO2e / 4, 3033.3237, 0.01);

  // Conservative lower bound (compounding 95% CI lower bounds):
  // Biomass lower: 100 ha * 9.4 * (1 + 0.47) * 0.429 * (44/12) * 4 yr = 8,694.2856 tCO2e (2,173.5714 tCO2e/yr)
  // Soil lower: 100 ha * 1.30 * (44/12) * 4 yr = 1,906.6667 tCO2e (476.6667 tCO2e/yr)
  // Total 4-year lower bound: 8,694.2856 + 1,906.6667 = 10,600.9523 tCO2e -> Annualized: 2,650.2381 tCO2e/yr
  near(e.result.lowerBoundTCO2e, 10600.9523, 0.01);
  near(e.result.lowerBoundTCO2e / 4, 2650.2381, 0.01);

  // Buffer deduction (15%): 10,600.9523 * 0.15 = 1,590.1428 tCO2e (397.5357 tCO2e/yr)
  near(e.result.bufferDeductionTCO2e, 1590.1428, 0.01);

  // Net buffered eligible credits:
  // 4-year cycle: floor(10,600.9523 * 0.85) = floor(9,010.8095) = 9,010 credits (2,252.5 credits/yr)
  assert.equal(e.result.eligibleCredits, 9010);
  assert.equal(e.methodologyStatus, "PENDING_REVIEW");

  // Reconcile standalone 1.0000 Julian year arithmetic:
  // Exact 1-year lower bound = 2,173.5714 + 476.6667 = 2,650.2381 tCO2e (not 2,651.19, which had a rounding error)
  // Exact 1-year net buffered = 2,650.2381 * 0.85 = 2,252.7024 tCO2e
  // Integer floor: floor(2,252.7024) = 2,252 credits (not 2,253)
  const oneYearLower = e.result.lowerBoundTCO2e / 4;
  near(oneYearLower, 2650.2381, 0.01);
  const oneYearNet = oneYearLower * 0.85;
  near(oneYearNet, 2252.7024, 0.01);
  assert.equal(Math.floor(oneYearNet), 2252);
});

test("worked example B (tidal marsh, planted): soil pool only, no biomass term", () => {
  const e = carbon.estimate(IPCC, { project: proj({ ecosystem_type: "SALT_MARSH", climate_region: null, bufferPercent: 20 }), record: rec({ area_ha: 20, measurements: { canopy_cover_pct: 50 } }), period: { start: "2022-01-01", end: "2026-01-01" } });
  near(e.result.centralTCO2e, 266.9333, 0.01); near(e.result.lowerBoundTCO2e, 205.3333, 0.01); near(e.result.upperBoundTCO2e, 322.6667, 0.01);
  assert.equal(e.result.tCarbon.biomass, 0);
  assert.equal(e.result.eligibleCredits, 164);       // floor(205.3333 * 0.8)
});

test("seagrass uses the soil factor only; canopy below the 10% threshold credits nothing; natural recolonisation has no soil factor", () => {
  const sg = carbon.estimate(IPCC, { project: proj({ ecosystem_type: "SEAGRASS", climate_region: null }), record: rec({ measurements: { canopy_cover_pct: 40 } }), period: P4 });
  near(sg.result.centralTCO2e, 0.43 * 4 * 10 * 44 / 12, 0.01);
  const low = carbon.estimate(IPCC, { project: proj(), record: rec({ measurements: { canopy_cover_pct: 8 } }), period: P4 });
  assert.equal(low.result.centralTCO2e, 0); assert.equal(low.result.eligibleCredits, 0); assert.match(low.result.note, /below the 10%/);
  const nat = carbon.estimate(IPCC, { project: proj({ ecosystem_type: "SALT_MARSH", climate_region: null, revegetation_method: "NATURAL_RECOLONISATION" }), record: rec(), period: P4 });
  assert.equal(nat.result.centralTCO2e, 0, "IPCC Tier 1: EF = 0 when vegetation recolonises naturally");
  const edge = carbon.estimate(IPCC, { project: proj({ ecosystem_type: "SALT_MARSH", climate_region: null }), record: rec({ measurements: { canopy_cover_pct: 10 } }), period: P4 });
  assert.ok(edge.result.centralTCO2e > 0, "exactly 10% passes the threshold");
});

test("carbon-pool and period double counting: accumulated stocks are capped and later periods start where earlier ones ended", () => {
  // tropical dry: biomass cap = 92*(1+0.29)*0.451 = 53.5247 tC/ha; 53 tC/ha already credited -> only 0.5247 tC/ha of room.
  const e = carbon.estimate(IPCC, { project: proj({ climate_region: "TROPICAL_DRY" }), record: rec({ area_ha: 5 }), period: P4, previous: { cumulative: { biomassTcPerHa: 53, soilTcPerHa: 0 } } });
  near(e.result.tCarbon.biomass, 0.52468 * 5, 0.001); near(e.result.tCarbon.soil, 6.48 * 5, 0.001); near(e.result.centralTCO2e, 128.4191, 0.01);
  near(e.result.perHectare.biomassTcCumulative, 53.52468, 0.001);
  // soil cap (marsh 255 tC/ha) with 254 already accumulated leaves 1 tC/ha
  const s = carbon.estimate(IPCC, { project: proj({ ecosystem_type: "SALT_MARSH", climate_region: null }), record: rec({ area_ha: 20 }), period: P4, previous: { cumulative: { biomassTcPerHa: 0, soilTcPerHa: 254 } } });
  near(s.result.centralTCO2e, 73.3333, 0.01);
  assert.throws(() => carbon.estimate(IPCC, { project: proj(), record: rec(), period: { start: "2025-01-01", end: "2025-01-01" } }), /nothing new/);
  assert.throws(() => carbon.estimate(IPCC, { project: proj(), record: rec(), period: { start: "2025-06-01", end: "2025-01-01" } }), /nothing new/, "an earlier monitoring date cannot be assessed again");
});

test("unit conversion constant and rounding rules", () => {
  assert.equal(carbon.CO2_PER_C, 44 / 12);
  const e = carbon.estimate(IPCC, { project: proj({ ecosystem_type: "SEAGRASS", climate_region: null, bufferPercent: 0 }), record: rec({ area_ha: 7.3 }), period: P4 });
  assert.equal(e.result.eligibleCredits, Math.floor(e.result.lowerBoundTCO2e), "rounded down, never up");
  assert.ok(e.result.eligibleCredits <= e.result.lowerBoundTCO2e && e.result.lowerBoundTCO2e <= e.result.centralTCO2e && e.result.centralTCO2e <= e.result.upperBoundTCO2e, "lower <= central <= upper");
});

test("the buffer is never defaulted: without a risk-based determination nothing is eligible and the reason is reported", () => {
  const e = carbon.estimate(IPCC, { project: proj({ bufferPercent: null }), record: rec(), period: P4 });
  assert.equal(e.result.eligibleCredits, 0); assert.equal(e.estimate.eligible, 0);
  assert.deepEqual(e.blockers.map((b) => b.code), ["BUFFER_UNSET"]);
  assert.equal(e.result.bufferPercent, null);
});

test("missing, empty, invalid and out-of-range inputs are rejected; a measured zero is valid", () => {
  const run = (m, p = {}, r = {}) => carbon.estimate(IPCC, { project: proj(p), record: rec({ measurements: m, ...r }), period: P4 });
  for (const bad of [undefined, null, "", "  ", true]) assert.throws(() => run({ canopy_cover_pct: bad }), /canopy cover.*required|required/i, String(bad));
  assert.throws(() => run({ canopy_cover_pct: "abc" }), /must be a number/);
  assert.throws(() => run({ canopy_cover_pct: -1 }), /between 0 and 100/);
  assert.throws(() => run({ canopy_cover_pct: 101 }), /between 0 and 100/);
  assert.throws(() => run({ canopy_cover_pct: 50 }, {}, { area_ha: 0 }), /Area/);
  assert.throws(() => run({ canopy_cover_pct: 50 }, {}, { area_ha: 80 }), /exceeds the project area/);
  assert.throws(() => run({ canopy_cover_pct: 50 }, { climate_region: null }), /climate region/);
  assert.throws(() => run({ canopy_cover_pct: 50 }, { climate_region: "OTHER" }), /climate region/);
  assert.throws(() => run({ canopy_cover_pct: 50 }, { revegetation_method: null }), /revegetation method/);
  assert.throws(() => run({ canopy_cover_pct: 50 }, { ecosystem_type: "KELP" }), /not covered/);
  const zero = run({ canopy_cover_pct: 0 });
  assert.equal(zero.result.eligibleCredits, 0); assert.equal(zero.inputs.canopyCoverPct, 0); assert.equal(zero.inputs.canopyGatePassed, false);
});

test("repeated calculation with identical inputs is reproducible; changed inputs produce a different input hash", () => {
  const a = carbon.estimate(IPCC, { project: proj(), record: rec(), period: P4 }), b = carbon.estimate(IPCC, { project: proj(), record: rec(), period: P4 });
  assert.deepEqual(a.result, b.result); assert.equal(a.inputHash, b.inputHash);
  assert.notEqual(carbon.estimate(IPCC, { project: proj(), record: rec({ measurements: { canopy_cover_pct: 61 } }), period: P4 }).inputHash, a.inputHash);
  assert.notEqual(carbon.estimate(IPCC, { project: proj({ bufferPercent: 16 }), record: rec(), period: P4 }).inputHash, a.inputHash, "buffer is part of the inputs");
});

test("methodology versions: parameters carry citations, are pending review, and a parameter change changes the approval hash", () => {
  const d = defs.get(IPCC);
  assert.equal(d.status, "PENDING_REVIEW");
  for (const [id, p] of Object.entries(d.parameters)) { assert.equal(p.source, "IPCC_WS_CH4", id); assert.match(p.table, /Table|Section/, id); assert.ok(p.page, id); assert.equal(p.approval, "PENDING_REVIEW", `${id} is not approved for operational use`); }
  assert.ok(defs.SOURCES.IPCC_WS_CH4.citation.includes("Kennedy") && defs.SOURCES.VM0033.citation.includes("VM0033"));
  const before = defs.parametersHash(d), copy = JSON.parse(JSON.stringify(d)); copy.parameters.soil_accumulation.byEcosystem.MANGROVE.value = 1.7;
  assert.notEqual(defs.parametersHash(copy), before);
  assert.equal(carbon.estimate(ILL, { project: proj({ ecosystem_type: "MANGROVE" }), record: rec(), period: P4 }).methodologyVersion, ILL);
  assert.throws(() => carbon.estimate("NOPE-v9", { project: proj(), record: rec(), period: P4 }), /Unknown methodology/);
});

test("illustrative placeholder method: period-based, flat deductions, distinct from the sourced method", () => {
  const e = carbon.estimate(ILL, { project: proj({ climate_region: null }), record: rec(), period: P4 });
  near(e.result.centralTCO2e, 138.24, 0.01); near(e.result.lowerBoundTCO2e, 89.856, 0.01); near(e.result.upperBoundTCO2e, 186.624, 0.01); assert.equal(e.result.eligibleCredits, 138);
  assert.equal(e.methodologyStatus, "ILLUSTRATIVE_ONLY");
  assert.throws(() => carbon.estimate(ILL, { project: proj(), record: rec({ measurements: {} }), period: P4 }), /survival rate/);
  assert.throws(() => carbon.estimate(ILL, { project: proj(), record: rec({ measurements: { survival_rate_pct: "" } }), period: P4 }), /survival rate/, "empty string is missing data, not zero");
  assert.equal(carbon.estimate(ILL, { project: proj(), record: rec({ measurements: { survival_rate_pct: 0 } }), period: P4 }).result.eligibleCredits, 0);
});

test("methodology description exposes sources, status and review requirements", () => {
  const m = carbon.describeMethodology(IPCC);
  assert.equal(m.certified, false); assert.equal(m.status, "PENDING_REVIEW"); assert.equal(m.references.length, 3);
  assert.ok(m.requiredDeterminations.includes("NON_PERMANENCE_RISK") && m.bufferRule.includes("NOT defaulted"));
  assert.equal(carbon.describeMethodology("nope"), null);
});
