// backend/src/methodology/definitions.js — versioned methodology definitions with sourced parameters.
//
// Every parameter lists its source, table and page, units, carbon pool, geographic/ecosystem applicability, sample size,
// the published 95% confidence interval and range, limitations, and an approval status. NOTHING here is scientifically
// approved for operational use: approval is a separate, recorded independent review (methodology_reviews) that is only
// valid for the exact parameter set (see parametersHash). Values were transcribed from the cited publication; none were estimated.
const { hashJSON } = require("../utils/hash");

const SOURCES = {
  IPCC_WS_CH4: {
    id: "IPCC_WS_CH4",
    citation: "IPCC (2014). 2013 Supplement to the 2006 IPCC Guidelines for National Greenhouse Gas Inventories: Wetlands. Chapter 4: Coastal Wetlands. Coordinating Lead Authors: Kennedy, H., Alongi, D.M., Karim, A.; Lead Authors: Chen, G., Chmura, G.L., Crooks, S., Kairo, J.G., Liao, B., Lin, G.; Contributing Author: Troxler, T.G. IPCC, Switzerland.",
    url: "https://www.ipcc-nggip.iges.or.jp/public/wetlands/",
    retrieved: "2026-10-11 (chapter PDF read directly; values transcribed from the printed tables)",
  },
  VM0033: {
    id: "VM0033",
    citation: "Verra. VM0033 Methodology for Tidal Wetland and Seagrass Restoration, v2.1. Verified Carbon Standard (VCS).",
    url: "https://verra.org/methodologies/vm0033-methodology-for-tidal-wetland-and-seagrass-restoration-v2-1/",
    retrieved: "2026-10-11 (methodology listing page; the full document was not transcribed)",
  },
  VCS_NPRT: {
    id: "VCS_NPRT",
    citation: "Verra. VCS AFOLU Non-Permanence Risk Tool (latest version). Required by VM0033 v2.1 clarifications to assess risk of erosion and submergence and to determine the pooled buffer contribution.",
    url: "https://verra.org/methodologies/vm0033-methodology-for-tidal-wetland-and-seagrass-restoration-v2-1/",
    retrieved: "2026-10-11 (referenced from the VM0033 page; the tool itself was not transcribed)",
  },
};

const ci = (lo, hi) => ({ lower: lo, upper: hi });
const REGIONS = ["TROPICAL_WET", "TROPICAL_DRY", "SUBTROPICAL"];
const IPCC_COMMON = { source: "IPCC_WS_CH4", approval: "PENDING_REVIEW", ciBasis: "95% CI of the geometric mean (as published)" };

// ── IPCC 2013 Wetlands Supplement, Chapter 4, Tier 1 ───────────────────────────────────────
const IPCC_T1 = {
  version: "IPCC-WS2013-T1-v1",
  title: "IPCC 2013 Wetlands Supplement Tier 1 — rewetting, revegetation and creation of coastal wetlands (period-based)",
  status: "PENDING_REVIEW",
  illustrativeOnly: false,
  scope: "Restoration by planting or seeding (rewetting, revegetation, creation) of mangroves, tidal marshes and seagrass meadows. Tier 1 global defaults; not site-specific.",
  requiredMeasurements: ["canopy_cover_pct"],
  requiresProject: ["climate_region (mangrove)", "revegetation_method"],
  requiredDeterminations: ["BASELINE", "ADDITIONALITY", "LEAKAGE", "NON_PERMANENCE_RISK"],
  governingReferences: ["IPCC_WS_CH4", "VM0033", "VCS_NPRT"],
  unitConversion: { id: "co2_per_c", value: 44 / 12, expression: "44/12", unit: "t CO2 per t C", note: "Ratio of molecular masses (CO2 44, C 12) used in IPCC inventory guidance; not tabulated in Chapter 4." },
  parameters: {
    carbon_fraction_mangrove: { ...IPCC_COMMON, label: "Carbon fraction of above-ground mangrove biomass", table: "Table 4.2", page: "4.13", unit: "t C (t d.m.)-1", pool: "biomass", value: 0.451, ci: ci(0.429, 0.471), range: [0.422, 0.502], n: 47,
      applicability: "Mangroves, leaves + wood; all regions", limitations: "Applied here to above- and below-ground biomass following the structure of IPCC Equation 4.4." },
    agb_growth: { ...IPCC_COMMON, label: "Above-ground biomass growth in mangroves", table: "Table 4.4", page: "4.14", unit: "t d.m. ha-1 yr-1", pool: "above-ground biomass", byRegion: {
      TROPICAL_WET: { value: 9.9, ci: ci(9.4, 10.4), range: [0.1, 27.4], n: 23 }, TROPICAL_DRY: { value: 3.3, ci: ci(3.1, 3.5), range: [0.1, 7.5], n: 6 }, SUBTROPICAL: { value: 18.1, ci: ci(17.1, 19.1), range: [5.3, 29.1], n: 4 } },
      applicability: "Mangroves by IPCC climate domain/region", limitations: "From forests of varying age; applies only until the biomass stock in Table 4.3 is reached. Subtropical default rests on n=4 and a very wide range." },
    agb_stock: { ...IPCC_COMMON, label: "Above-ground biomass stock of mangroves (cap for biomass accumulation)", table: "Table 4.3", page: "4.14", unit: "t d.m. ha-1", pool: "above-ground biomass", byRegion: {
      TROPICAL_WET: { value: 192, ci: ci(187, 204), range: [8.7, 384], n: 49 }, TROPICAL_DRY: { value: 92, ci: ci(88, 97), range: [3.2, 201], n: 13 }, SUBTROPICAL: { value: 75, ci: ci(66, 84), range: [3.9, 129], n: 10 } },
      applicability: "Mangroves by IPCC climate domain/region", limitations: "Used only as an upper bound on accumulated biomass." },
    root_shoot_ratio: { ...IPCC_COMMON, label: "Ratio of below-ground to above-ground biomass (R) in mangroves", table: "Table 4.5", page: "4.14", unit: "t root d.m. (t shoot d.m.)-1", pool: "below-ground biomass", byRegion: {
      TROPICAL_WET: { value: 0.49, ci: ci(0.47, 0.51), range: [0.04, 1.1], n: 18 }, TROPICAL_DRY: { value: 0.29, ci: ci(0.28, 0.3), range: [0.09, 0.79], n: 9 }, SUBTROPICAL: { value: 0.96, ci: ci(0.91, 1.0), range: null, n: 18 } },
      applicability: "Mangroves by IPCC climate domain/region", limitations: "The printed range for the subtropical value is inconsistent in the extracted text and is not reproduced." },
    soil_accumulation: { ...IPCC_COMMON, label: "Soil carbon accumulation after rewetting and vegetation re-establishment (EF_REWET, magnitude of removal)", table: "Table 4.12", page: "4.29", unit: "t C ha-1 yr-1", pool: "soil organic carbon", byEcosystem: {
      MANGROVE: { value: 1.62, ci: ci(1.3, 2.0), range: [0.1, 10.2], n: 69 }, SALT_MARSH: { value: 0.91, ci: ci(0.7, 1.1), range: [0.05, 4.65], n: 66 }, SEAGRASS: { value: 0.43, ci: ci(0.2, 0.7), range: [0.09, 1.12], n: 6 } },
      applicability: "Aggregated organic and mineral soils; applies when vegetation is established by planting or seeding (EF = 0 for natural recolonisation) and canopy cover is at least 10% of the area (IPCC Section 4.2.3.3).",
      limitations: "Global averages with large uncertainty (variation with intertidal depth, species, climate). Printed values are negative (removal); magnitudes are stored. Seagrass rests on n=6." },
    soil_stock_cap: { ...IPCC_COMMON, label: "Soil carbon stock of natural settings (cap for accumulated soil carbon)", table: "Table 4.11", page: "4.26", unit: "t C ha-1 (to 1 m depth)", pool: "soil organic carbon", byEcosystem: {
      MANGROVE: { value: 386, ci: ci(351, 424), range: [55, 1376], n: 119 }, SALT_MARSH: { value: 255, ci: ci(254, 297), range: [15.6, 623], n: 117 }, SEAGRASS: { value: 108, ci: ci(84, 139), range: [9.1, 829], n: 89 } },
      applicability: "Aggregated organic and mineral soils (seagrass: mineral soils). IPCC advises applying the accumulation factor until stocks equal natural settings.",
      limitations: "Used only as an upper bound on cumulative accumulation." },
    canopy_threshold_pct: { source: "IPCC_WS_CH4", approval: "PENDING_REVIEW", label: "Minimum canopy cover for applying accumulation factors", table: "Section 4.2.3.3 (Choice of emission/removal factors, Tier 1)", page: "4.28", unit: "% of area", pool: "all", value: 10,
      applicability: "Mangrove, tidal marsh and seagrass revegetation", limitations: "Stated in the guidance for the soil factor; this software also applies it to biomass accumulation (conservative software rule)." },
  },
  uncertaintyApproach: { id: "LOWER_BOUND_95CI", description: "The conservative quantity applies the lower bound of each parameter's published 95% confidence interval. Compounding lower bounds is a software design choice, not an IPCC rule; whether it is appropriate relative to the methodology's own uncertainty treatment is a review item." },
  bufferRule: "Buffer percentage is NOT defaulted. It must come from an accepted NON_PERMANENCE_RISK determination (VCS AFOLU Non-Permanence Risk Tool). Without it no quantity is issuable.",
  rounding: "Eligible credits = floor(conservative total x (1 - buffer%)), whole tonnes CO2e, never rounded up.",
};

// ── Placeholder method retained for the illustrative reference dataset only ───────────────
const ILLUSTRATIVE = {
  version: "ILLUSTRATIVE-BC-v1",
  title: "Illustrative placeholder method (reference dataset only)",
  status: "ILLUSTRATIVE_ONLY",
  illustrativeOnly: true,
  scope: "Usable only for projects whose records are marked illustrative. Coefficients are unvalidated placeholders carried over from earlier project code and have no published source attached.",
  requiredMeasurements: ["survival_rate_pct"],
  requiresProject: [],
  requiredDeterminations: [],
  governingReferences: [],
  unitConversion: { id: "co2_per_c", value: 44 / 12, expression: "44/12", unit: "t CO2 per t C", note: "Not used by this method." },
  parameters: {
    sequestration_rate: { source: null, approval: "UNVALIDATED_PLACEHOLDER", label: "Net sequestration rate", unit: "t CO2e ha-1 yr-1", pool: "combined (unspecified)", byEcosystem: { MANGROVE: { value: 6.0 }, SEAGRASS: { value: 1.38 }, SALT_MARSH: { value: 2.18 } },
      applicability: "None established", limitations: "No source, region or pool is documented." },
    uncertainty_discount: { source: null, approval: "UNVALIDATED_PLACEHOLDER", label: "Flat uncertainty deduction", unit: "fraction", pool: "all", value: 0.2, applicability: "None established", limitations: "Not derived from data." },
    buffer_fraction: { source: null, approval: "UNVALIDATED_PLACEHOLDER", label: "Flat buffer deduction", unit: "fraction", pool: "all", value: 0.1, applicability: "None established", limitations: "Not derived from a risk assessment." },
    range_band: { source: null, approval: "ILLUSTRATION_ONLY", label: "Display range band", unit: "fraction", pool: "n/a", value: 0.35, applicability: "Display only", limitations: "Not a statistical interval." },
  },
  uncertaintyApproach: { id: "FLAT_DISCOUNT", description: "Flat deduction, not derived from data." },
  bufferRule: "Flat placeholder; not a risk-based buffer.",
  rounding: "Eligible credits = floor(net quantity), whole tonnes CO2e.",
};

const DEFINITIONS = { [IPCC_T1.version]: IPCC_T1, [ILLUSTRATIVE.version]: ILLUSTRATIVE };
const parametersHash = (def) => hashJSON({ version: def.version, parameters: def.parameters, unitConversion: def.unitConversion, uncertaintyApproach: def.uncertaintyApproach, rounding: def.rounding });
const get = (v) => DEFINITIONS[v] || null;
const list = () => Object.values(DEFINITIONS);

module.exports = { SOURCES, DEFINITIONS, REGIONS, get, list, parametersHash, DEFAULT_REAL: IPCC_T1.version, DEFAULT_ILLUSTRATIVE: ILLUSTRATIVE.version };
