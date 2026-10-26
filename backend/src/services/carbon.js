// backend/src/services/carbon.js — carbon assessment engine (pure functions; no database access).
//
// Each assessment is bound to a versioned methodology (src/methodology/definitions.js) whose parameters carry citations and
// approval status. An assessment covers ONE monitoring period [start, end) that follows the previously assessed period of the
// project, so the same carbon is never counted twice. Quantities are kept distinct:
//   central       - point estimate from published central values
//   lowerBound    - every parameter at the lower bound of its published 95% CI (conservative)
//   upperBound    - every parameter at the upper bound
//   eligible      - floor(lowerBound x (1 - buffer%)), whole tonnes CO2e (only with a risk-based buffer determination)
// "Issuable" additionally requires methodology review, accepted determinations and approval - decided by the service layer.
const defs = require("../methodology/definitions");
const { hashJSON } = require("../utils/hash");
const { HttpError } = require("../utils/http");

const METHODOLOGY_VERSION = defs.DEFAULT_REAL;
const DAY = 86400000;
const CO2_PER_C = 44 / 12;
const r4 = (n) => Math.round(n * 1e4) / 1e4;

const isMissing = (v) => v === null || v === undefined || typeof v === "boolean" || (typeof v === "string" && v.trim() === "");
function strictNumber(v, name, { min = -Infinity, max = Infinity } = {}) {
  if (isMissing(v)) throw new HttpError(422, `${name} is required for this methodology (missing data is never treated as zero)`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(422, `${name} must be a number`);
  if (n < min || n > max) throw new HttpError(422, `${name} must be between ${min} and ${max}`);
  return n;
}
const isoDay = (d) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10);
const daysBetween = (a, b) => (Date.parse(isoDay(b)) - Date.parse(isoDay(a))) / DAY;

function periodYears(start, end) {
  const days = daysBetween(start, end);
  if (!(days > 0)) throw new HttpError(409, `The monitoring date ${isoDay(end)} does not extend beyond the previously assessed period (ends ${isoDay(start)}); nothing new can be assessed`);
  return { days, years: days / 365.25 };
}

const variantValue = (p, key, variant, byKey) => {
  const e = byKey ? p.byRegion?.[key] || p.byEcosystem?.[key] : p;
  if (!e) throw new HttpError(422, `No published value for ${key}`);
  return variant === "lower" ? e.ci.lower : variant === "upper" ? e.ci.upper : e.value;
};

// ── IPCC 2013 Wetlands Supplement Tier 1 ───────────────────────────────────
function estimateIpcc(def, { project, record, period, previous }) {
  const P = def.parameters, eco = project.ecosystem_type;
  if (!P.soil_accumulation.byEcosystem[eco]) throw new HttpError(422, `Habitat ${eco} is not covered by ${def.version}`);
  if (!["PLANTED", "NATURAL_RECOLONISATION"].includes(project.revegetation_method)) throw new HttpError(422, "The project's revegetation method (planted or natural recolonisation) must be recorded");
  const mangrove = eco === "MANGROVE";
  if (mangrove && !defs.REGIONS.includes(project.climate_region)) throw new HttpError(422, `The project's climate region must be one of ${defs.REGIONS.join(", ")} for mangrove assessments (IPCC defaults are not published for other regions)`);
  const canopy = strictNumber(record.measurements?.canopy_cover_pct, "Canopy cover (%)", { min: 0, max: 100 });
  const area = strictNumber(record.area_ha, "Area (ha)", { min: 1e-9, max: 1e7 });
  const projectArea = strictNumber(project.area_hectares, "Project area (ha)", { min: 1e-9 });
  if (area > projectArea * 1.05) throw new HttpError(422, "The assessed area exceeds the project area");
  const { days, years } = periodYears(period.start, period.end);

  const gate = canopy >= P.canopy_threshold_pct.value;
  const planted = project.revegetation_method === "PLANTED";
  const prevB = Number(previous?.cumulative?.biomassTcPerHa || 0), prevS = Number(previous?.cumulative?.soilTcPerHa || 0);

  const perHaYear = (variant) => {
    let biomass = 0;
    if (mangrove) {
      const g = variantValue(P.agb_growth, project.climate_region, variant, true), R = variantValue(P.root_shoot_ratio, project.climate_region, variant, true), cf = variantValue(P.carbon_fraction_mangrove, null, variant, false);
      biomass = g * (1 + R) * cf;
    }
    const soil = planted ? variantValue(P.soil_accumulation, eco, variant, true) : 0;
    return { biomass: gate ? biomass : 0, soil: gate ? soil : 0 };
  };
  const capB = mangrove ? P.agb_stock.byRegion[project.climate_region].value * (1 + P.root_shoot_ratio.byRegion[project.climate_region].value) * P.carbon_fraction_mangrove.value : 0;
  const capS = P.soil_stock_cap.byEcosystem[eco].value;
  const room = { biomass: Math.max(0, capB - prevB), soil: Math.max(0, capS - prevS) };

  const calc = (variant) => {
    const r = perHaYear(variant);
    const b = Math.min(r.biomass * years, room.biomass), s = Math.min(r.soil * years, room.soil); // tC per ha added in this period
    return { biomassTcPerHa: b, soilTcPerHa: s, tC: (b + s) * area, tCO2e: (b + s) * area * CO2_PER_C };
  };
  const central = calc("central"), lower = calc("lower"), upper = calc("upper");
  const bufferPercent = project.bufferPercent == null ? null : Number(project.bufferPercent);
  const eligible = bufferPercent == null ? 0 : Math.floor(lower.tCO2e * (1 - bufferPercent / 100) + 1e-9);
  const blockers = [];
  if (bufferPercent == null) blockers.push({ code: "BUFFER_UNSET", detail: "No accepted non-permanence risk determination supplies a buffer percentage" });

  const used = [
    ["carbon_fraction_mangrove", mangrove], ["agb_growth", mangrove], ["agb_stock", mangrove], ["root_shoot_ratio", mangrove], ["soil_accumulation", true], ["soil_stock_cap", true], ["canopy_threshold_pct", true],
  ].filter(([, on]) => on).map(([id]) => ({ id, label: P[id].label, table: P[id].table, page: P[id].page, unit: P[id].unit, source: P[id].source, approval: P[id].approval,
    value: P[id].byRegion ? P[id].byRegion[project.climate_region]?.value : P[id].byEcosystem ? P[id].byEcosystem[eco]?.value : P[id].value }));
  return {
    inputs: { habitat: eco, climateRegion: mangrove ? project.climate_region : null, revegetationMethod: project.revegetation_method, areaHa: area, canopyCoverPct: canopy, canopyGatePassed: gate,
      periodStart: isoDay(period.start), periodEnd: isoDay(period.end), periodDays: days, periodYears: r4(years), previousCumulative: { biomassTcPerHa: prevB, soilTcPerHa: prevS }, bufferPercent },
    result: {
      periodYears: r4(years), tCarbon: { biomass: r4(central.biomassTcPerHa * area), soil: r4(central.soilTcPerHa * area), total: r4(central.tC) },
      centralTCO2e: r4(central.tCO2e), lowerBoundTCO2e: r4(lower.tCO2e), upperBoundTCO2e: r4(upper.tCO2e), conservativeTCO2e: r4(lower.tCO2e),
      bufferPercent, bufferDeductionTCO2e: bufferPercent == null ? null : r4(lower.tCO2e * (bufferPercent / 100)), eligibleCredits: eligible,
      caps: { biomassTcPerHa: r4(capB), soilTcPerHa: r4(capS), biomassRoomTcPerHa: r4(room.biomass), soilRoomTcPerHa: r4(room.soil) },
      perHectare: { biomassTcCumulative: r4(prevB + central.biomassTcPerHa), soilTcCumulative: r4(prevS + central.soilTcPerHa) },
      note: gate ? null : `Canopy cover ${canopy}% is below the ${P.canopy_threshold_pct.value}% threshold: no accumulation is credited for this period.`,
    },
    parametersUsed: used, blockers,
    estimate: { central: r4(central.tCO2e), low: r4(lower.tCO2e), high: r4(upper.tCO2e), conservative: r4(lower.tCO2e), eligible },
  };
}

// ── Placeholder method (reference dataset only) ────────────────────────────
function estimateIllustrative(def, { project, record, period }) {
  const P = def.parameters, eco = project.ecosystem_type;
  if (!P.sequestration_rate.byEcosystem[eco]) throw new HttpError(400, `Unsupported ecosystem: ${eco}`);
  const survival = strictNumber(record.measurements?.survival_rate_pct, "A survival rate (0-100%) measurement", { min: 0, max: 100 });
  const area = strictNumber(record.area_ha, "Record area must be > 0 ha; area", { min: 1e-9 });
  const { days, years } = periodYears(period.start, period.end);
  const rate = P.sequestration_rate.byEcosystem[eco].value;
  const gross = area * rate * years * (survival / 100);
  const net = gross * (1 - P.uncertainty_discount.value) * (1 - P.buffer_fraction.value);
  const band = P.range_band.value;
  return {
    inputs: { habitat: eco, areaHa: area, survivalRatePct: survival, periodStart: isoDay(period.start), periodEnd: isoDay(period.end), periodDays: days, periodYears: r4(years) },
    result: { periodYears: r4(years), grossTCO2e: r4(gross), centralTCO2e: r4(net), lowerBoundTCO2e: r4(net * (1 - band)), upperBoundTCO2e: r4(net * (1 + band)), conservativeTCO2e: r4(net), bufferPercent: P.buffer_fraction.value * 100, eligibleCredits: Math.floor(net + 1e-9),
      perHectare: { biomassTcCumulative: 0, soilTcCumulative: 0 }, note: "Placeholder coefficients; not a scientific estimate." },
    parametersUsed: Object.entries(P).map(([id, p]) => ({ id, label: p.label, unit: p.unit, source: p.source, approval: p.approval, value: p.byEcosystem ? p.byEcosystem[eco]?.value : p.value })), blockers: [],
    estimate: { central: r4(net), low: r4(net * (1 - band)), high: r4(net * (1 + band)), conservative: r4(net), eligible: Math.floor(net + 1e-9) },
  };
}

/**
 * @param methodologyVersion  version string (see definitions)
 * @param ctx { project, record, period: {start, end}, previous?: {cumulative}, }  project.bufferPercent comes from an accepted determination
 */
function estimate(methodologyVersion, ctx) {
  const def = defs.get(methodologyVersion);
  if (!def) throw new HttpError(422, `Unknown methodology version ${methodologyVersion}`);
  const out = def.illustrativeOnly ? estimateIllustrative(def, ctx) : estimateIpcc(def, ctx);
  const mh = defs.parametersHash(def);
  return { methodologyVersion: def.version, methodologyHash: mh, methodologyStatus: def.status, ...out, inputHash: hashJSON({ v: def.version, mh, inputs: out.inputs }) };
}

function describeMethodology(version) {
  const def = defs.get(version || defs.DEFAULT_REAL);
  if (!def) return null;
  return { version: def.version, title: def.title, status: def.status, certified: false, illustrativeOnly: def.illustrativeOnly, scope: def.scope, parametersHash: defs.parametersHash(def),
    requiredMeasurements: def.requiredMeasurements, requiredDeterminations: def.requiredDeterminations, unitConversion: def.unitConversion, parameters: def.parameters,
    uncertaintyApproach: def.uncertaintyApproach, bufferRule: def.bufferRule, rounding: def.rounding, references: def.governingReferences.map((id) => defs.SOURCES[id]) };
}

module.exports = { estimate, describeMethodology, METHODOLOGY_VERSION, CO2_PER_C, periodYears, definitions: defs };
