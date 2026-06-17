/**
 * @deprecated Since 2026-04-15. Retained until Session 11.
 *
 * Consumed by EstimatePage.jsx and EstimateViewPage.jsx which depend on this
 * file's flat-return shape ({ property, recurring, oneTime, results, totals,
 * specItems, fieldVerify, urgency, urgLabel, urgMult, modifiers, ... }).
 *
 * The server modular engine at POST /admin/pricing-config/estimate returns a
 * different shape ({ summary, waveGuard, lineItems, ... }) and does not emit
 * tier arrays, fieldVerify, urgency labels, modifiers, or specItems. A
 * drop-in migration is not possible without extending the modular engine.
 *
 * Full retirement planned as part of Session 11 when v1's generateEstimate
 * emits the full tier/specialty/urgency/modifiers shape needed by the UI.
 * Session 11 also absorbs v2 server retirement + property-lookup-v2 rewrite.
 *
 * DO NOT extend. Add new pricing features to server/services/pricing-engine/.
 *
 * Waves Pest Control — Estimate Calculation Engine v1.5
 * Ported from waves-estimator.html weCalculate() function.
 * Pure calculation — no DOM, no side effects.
 *
 * v1.5 changes:
 * - Tree & Shrub: bed area cap raised 8k→12k, access difficulty modifier (+8/+15 min)
 * - Palm Injection: requires explicit treated palm count, flags missing measurement data
 * - Mosquito: irrigation modifier (+0.08 pressure), cap raised 1.50→1.60
 * - Rodent Bait: matrix scoring (footprint + lot + water + trees) replaces OR logic
 * - One-Time Lawn: higher standalone fungicide base ($95 floor vs $73)
 * - Trenching: concrete cap raised 0.50→0.60 for full-cage + 3-car garage
 * - Bora-Care: multi-day pricing for 4,500+ sf attics, labor cap raised 6→10 hrs
 * - Bed Bug Heat: equipment cost for in-house treatments ($150 + $75/extra room)
 *
 * v1.4 changes:
 * - Roach modifier: one-time initial knockdown fee, no recurring % premium
 * - Tiered hardscape marginal: 3% up to 15k, 5% above (was flat 3%)
 * - Fungicide multiplier: 1.55 (was 1.38)
 * - Margin floor check at 35% for WaveGuard tiers
 * - Tier commitment data for billing reconciliation
 */

// Lawn V2 cost floor — single source of truth shared with the server pricing
// engine (@waves/lawn-cost-floor) so the previewed price and the server-
// authoritative billed price cannot drift.
import {
  lawnMaterialBudget,
  lawnMaterialCostPerVisit,
  lawnComplexityMinutes,
  computeLawnCostFloor,
} from '@waves/lawn-cost-floor';

/* ── helpers ────────────────────────────────────────────────── */

export function interpolate(v, b) {
  if (v <= b[0].at) return b[0].adj;
  if (v >= b[b.length - 1].at) return b[b.length - 1].adj;
  for (let i = 1; i < b.length; i++) {
    if (v <= b[i].at) {
      return b[i - 1].adj;
    }
  }
  return 0;
}

function interpolateLinear(v, b) {
  if (v <= b[0].at) return b[0].adj;
  if (v >= b[b.length - 1].at) return b[b.length - 1].adj;
  for (let i = 0; i < b.length - 1; i++) {
    const lo = b[i];
    const hi = b[i + 1];
    if (v >= lo.at && v <= hi.at) {
      const span = hi.at - lo.at;
      if (span === 0) return lo.adj;
      return lo.adj + ((v - lo.at) / span) * (hi.adj - lo.adj);
    }
  }
  return b[b.length - 1].adj;
}

export function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '$0.00';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtInt(n) {
  if (n === undefined || n === null || isNaN(n)) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString();
}

export function termiteBaitSystemLabel(value) {
  const key = String(value || '').trim().toLowerCase();
  return key === 'trelona' ? 'Trelona' : 'Advance';
}

export function termiteBaitMonitoringLabel(value) {
  const key = String(value || '').trim().toLowerCase();
  return key === 'premier' ? 'Premier' : 'Basic';
}

export function termiteBaitSelectionLabel(tmBait = {}, fallback = {}) {
  const system = tmBait.selectedSystem || tmBait.system || fallback.termiteBaitSystem;
  const tier = tmBait.selectedMonitoringTier || tmBait.monitoringTier || fallback.termiteMonitoringTier;
  return `${termiteBaitSystemLabel(system)} ${termiteBaitMonitoringLabel(tier)}`;
}

export function normalizeCommercialString(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_");
}

export function normalizePropertyType(value) {
  const normalized = normalizeCommercialString(value);
  if (!normalized) return "";
  const commercialAliases = [
    "commercial",
    "commercial_property",
    "business",
    "office",
    "office_retail",
    "retail",
    "shop",
    "storefront",
    "plaza",
    "warehouse",
    "warehouse_light",
    "light_warehouse",
    "apartment",
    "apartments",
    "apartment_common",
    "multi_family",
    "multifamily",
    "multifamily_common_area_residential",
    "multifamily_common_area_commercial",
    "commercial_multifamily",
    "hoa",
    "hoa_common",
    "hoa_common_area",
    "hoa_common_area_residential",
    "hoa_common_area_commercial",
    "residential_hoa",
    "residential_common_area",
    "commercial_hoa",
    "business_park",
    "condo_association",
    "common_area",
    "restaurant",
    "restaurant_food_service",
    "food_service",
    "medical",
    "medical_office",
    "clinic",
    "industrial",
    "school",
    "daycare",
    "school_daycare",
    "government",
    "municipal",
    "government_municipal",
  ];
  if (commercialAliases.includes(normalized)) {
    return "commercial";
  }
  const commercialTokens = [
    "commercial",
    "business",
    "office",
    "retail",
    "shop",
    "storefront",
    "plaza",
    "warehouse",
    "apartment",
    "apartments",
    "multifamily",
    "hoa",
    "restaurant",
    "medical",
    "clinic",
    "industrial",
    "school",
    "daycare",
    "government",
    "municipal",
  ];
  const tokens = normalized.split("_").filter(Boolean);
  if (normalized.includes("multi_family")) return "commercial";
  if (normalized.includes("common_area")) return "commercial";
  if (normalized.includes("food_service")) return "commercial";
  if (commercialTokens.some((token) => tokens.includes(token))) return "commercial";
  if (normalized === "residential") return "single_family";
  if (normalized === "single_family" || normalized === "single_family_home") return "single_family";
  if (normalized === "townhome_interior" || normalized === "town_home_interior") return "townhome_interior";
  if (normalized === "townhome" || normalized === "town_home" || normalized === "townhouse") return "townhome_end";
  if (normalized === "duplex") return "duplex";
  if (normalized === "condo_upper" || normalized === "upper_condo") return "condo_upper";
  if (normalized === "condo" || normalized === "condo_ground" || normalized === "condominium") return "condo_ground";
  if ((tokens.includes("townhome") || tokens.includes("townhouse")) && tokens.includes("interior")) return "townhome_interior";
  if (tokens.includes("townhome") || tokens.includes("townhouse")) return "townhome_end";
  if (tokens.includes("town") && tokens.includes("home") && tokens.includes("interior")) return "townhome_interior";
  if (tokens.includes("town") && tokens.includes("home")) return "townhome_end";
  if (tokens.includes("duplex")) return "duplex";
  if ((tokens.includes("condo") || tokens.includes("condominium")) && tokens.includes("upper")) return "condo_upper";
  if (tokens.includes("condo") || tokens.includes("condominium")) return "condo_ground";
  if (tokens.includes("single") || tokens.includes("family") || tokens.includes("home") || tokens.includes("residential")) return "single_family";
  return normalized;
}

const RESIDENTIAL_PROPERTY_TYPES = new Set([
  "single_family",
  "townhome_end",
  "townhome_interior",
  "duplex",
  "condo_ground",
  "condo_upper",
]);

export function isCommercialEstimateInput(input = {}) {
  const commercialFlag = input.isCommercial === true ||
    ["yes", "true", "commercial"].includes(String(input.isCommercial || "").trim().toLowerCase());
  const explicitResidentialOverride = input.isCommercial === false ||
    ["no", "false", "residential"].includes(String(input.isCommercial || "").trim().toLowerCase());
  const propertyType = normalizePropertyType(input.propertyType);
  const hasResidentialPropertyType = RESIDENTIAL_PROPERTY_TYPES.has(propertyType);
  if (!commercialFlag && hasResidentialPropertyType) {
    return false;
  }
  if (explicitResidentialOverride && propertyType !== "commercial") {
    return false;
  }

  return !!(
    commercialFlag ||
    propertyType === "commercial" ||
    normalizePropertyType(input.category) === "commercial" ||
    input.commercialSubtype
  );
}

const LOOKUP_PROPERTY_TYPE_LABELS = {
  single_family: "Single Family",
  townhome_end: "Townhome",
  townhome_interior: "Townhome Interior",
  duplex: "Duplex",
  condo_ground: "Condo",
  condo_upper: "Condo Upper",
};

export function resolveLookupPropertyTypeAutofill(propertyType, category) {
  const normalizedPropertyType = normalizePropertyType(propertyType);
  if (normalizedPropertyType === "commercial") {
    return { propertyType: "Commercial", isCommercial: "YES" };
  }
  if (LOOKUP_PROPERTY_TYPE_LABELS[normalizedPropertyType]) {
    return {
      propertyType: LOOKUP_PROPERTY_TYPE_LABELS[normalizedPropertyType],
      isCommercial: "NO",
      commercialSubtype: "",
    };
  }

  const normalizedCategory = normalizePropertyType(category);
  if (normalizedCategory === "commercial") {
    return { propertyType: "Commercial", isCommercial: "YES" };
  }
  if (!normalizedPropertyType && LOOKUP_PROPERTY_TYPE_LABELS[normalizedCategory]) {
    return {
      propertyType: LOOKUP_PROPERTY_TYPE_LABELS[normalizedCategory],
      isCommercial: "NO",
      commercialSubtype: "",
    };
  }
  return {};
}

function commercialManualQuoteItem(service, input = {}) {
  const isLawn = service === "commercial_lawn" || service === "lawn_care";
  const canonical = isLawn ? "commercial_lawn" : "commercial_pest";
  const reason = isLawn
    ? "Commercial lawn treatment requires manual quote or commercial pilot pricing."
    : "Commercial pest requires manual quote or commercial pilot pricing.";
  return {
    service: canonical,
    name: isLawn ? "Commercial Lawn Treatment" : "Commercial Pest Control",
    price: null,
    det: reason,
    detail: reason,
    originalRequestedService: isLawn ? "lawn_care" : "pest_control",
    propertyType: "commercial",
    isCommercial: true,
    commercialSubtype: input.commercialSubtype || null,
    commercialPricingMode: "manual_quote",
    quoteRequired: true,
    requiresManualReview: true,
    autoQuoteRequiresAdminApproval: true,
    manualReviewReasons: ["commercial_property_manual_quote_required"],
    reason,
    taxable: !isLawn,
    taxCategory: isLawn ? "lawn_spraying_or_treatment" : "nonresidential_pest_control",
    pricingConfidence: "LOW",
  };
}

const COMMERCIAL_LAWN_FALLBACK_FLAGS = [
  "svcLawn",
  "svcOnetimeLawn",
  "svcTopdress",
  "svcDethatch",
  "svcPlugging",
  "svcTs",
  "svcInjection",
];

const COMMERCIAL_PEST_FALLBACK_FLAGS = [
  "svcPest",
  "svcOnetimePest",
  "svcMosquito",
  "svcOnetimeMosquito",
  "svcTermiteBait",
  "svcRodentBait",
  "svcTrenching",
  "svcBoracare",
  "svcPreslab",
  "svcFoam",
  "svcRodentTrap",
  "svcFlea",
  "svcWasp",
  "svcRoach",
  "svcBedbug",
  "svcExclusion",
];

function hasAnySelectedFlag(input = {}, flags = []) {
  return flags.some((flag) => !!input[flag]);
}

const LAWN_TABLE_MAX_SQFT = 20000;
const LAWN_FREQS = [4, 6, 9, 12];
const LAWN_PRICING_V2 = {
  targetCollectedMarginFloor: 0.35,
  pricingMode: 'THIRTY_FIVE_MARGIN_FLOOR',
  pricingVersion: 'LAWN_PRICING_V2_DENSE_35_FLOOR',
  laborRateLoaded: 35,
  equipmentReservePerVisit: 0,
  adminAnnualDefault: 51,
  callbackReservePerVisitDefault: 2,
  laborMinutesBase: 12,
  laborMinutesPer1000Sqft: 2.5,
  defaultRouteDensity: 'DENSE',
  routeDensityMinutes: { DENSE: 5, NORMAL: 10, LOOSE: 15, SPARSE: 20 },
};
// Material budgets now live in @waves/lawn-cost-floor (lawnMaterialBudget),
// shared with the server so the table can't drift between preview and bill.
const LAWN_PRICES = {
  st_augustine: { name: 'St. Augustine', code: 'A', pts: [[0,30,38,47,55],[3000,30,38,47,55],[3500,30,38,47,58],[4000,30,38,47,62],[5000,30,38,50,71],[6000,30,39,56,81],[7000,32,42,62,91],[8000,35,47,68,100],[10000,40,54,80,118],[12000,46,62,92,137],[15000,53,73,110,165],[20000,68,91,140,212]] },
  bermuda:      { name: 'Bermuda',       code: 'C1', pts: [[0,34,42,51,63],[4000,34,42,51,63],[5000,34,42,51,73],[6000,34,42,57,82],[7000,34,43,63,91],[8000,36,47,69,102],[10000,41,55,81,120],[12000,47,63,94,140],[15000,55,74,112,168],[20000,69,94,143,217]] },
  zoysia:       { name: 'Zoysia',        code: 'C2', pts: [[0,34,42,51,63],[4000,34,42,51,63],[5000,34,42,52,74],[6000,34,42,58,83],[7000,34,44,63,93],[8000,36,47,70,102],[10000,41,56,82,122],[12000,47,63,95,141],[15000,56,75,113,171],[20000,70,95,145,219]] },
  bahia:        { name: 'Bahia',         code: 'D', pts: [[0,25,34,42,51],[3000,25,34,42,51],[3500,25,34,42,53],[4000,25,34,42,58],[5000,25,34,47,66],[6000,27,36,52,74],[7000,30,39,57,82],[8000,31,42,62,91],[10000,36,49,73,107],[12000,41,56,83,123],[15000,48,65,99,147],[20000,60,82,125,189]] },
};

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toNonNegativeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function hasNonNegativeNumber(value) {
  return value !== undefined &&
    value !== null &&
    value !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0;
}

function normalizeGrassType(grassType) {
  const raw = String(grassType || '').trim();
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const aliases = {
    st_augustine: ['A', 'B', 'STAUGUSTINE', 'STAUG'],
    bermuda: ['C1', 'BERMUDA'],
    zoysia: ['C2', 'ZOYSIA'],
    bahia: ['D', 'BAHIA'],
  };
  if (LAWN_PRICES[raw]) return raw;
  for (const [track, values] of Object.entries(aliases)) {
    if (values.includes(compact)) return track;
  }
  return 'st_augustine';
}

const DETHATCHING_CONFIG = {
  floor: 150,
  marginDivisor: 0.40,
  materialPer1K: 2.10,
  baseCompatibilityPrices: {
    1500: 150,
    3000: 150,
    4500: 166,
    6000: 205,
    10000: 315,
  },
  timeModel: {
    primaryPassSqFtPerMin: 100,
    crossPassSqFtPerMin: 200,
    setupMin: 30,
  },
  cleanup: {
    none: { minutesPer1K: 0, pricePer1K: 0, label: 'No debris removal' },
    light: { minutesPer1K: 3, pricePer1K: 10, label: 'Light cleanup' },
    moderate: { minutesPer1K: 7, pricePer1K: 20, label: 'Moderate cleanup' },
    heavy: { minutesPer1K: 12, pricePer1K: 35, label: 'Heavy cleanup / bagging' },
  },
  accessMinutes: {
    easy: 0,
    moderate: 10,
    difficult: 20,
  },
  manualReview: {
    largeLawnSqFt: 10000,
    heavyCleanupSqFt: 6000,
    stAugustineRequiresApproval: true,
  },
};

function hasClientValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function normalizeDethatchingToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function parseClientNonNegativeMeasurement(value) {
  if (!hasClientValue(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function roundClientMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function clientBooleanTrue(value) {
  return value === true || value === 'true' || value === 'TRUE' || value === 'YES' || value === 'yes';
}

function uniqueClientStrings(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeDethatchingChoice(value, choices, fallback, warningCode) {
  const raw = normalizeDethatchingToken(value || fallback);
  if (Object.prototype.hasOwnProperty.call(choices || {}, raw)) {
    return { key: raw, warning: null };
  }
  return { key: fallback, warning: warningCode };
}

function normalizeDethatchingGrassType(options = {}) {
  const requestedGrassType = options.grassType ?? options.track ?? options.turfTrack ?? options.grassTrack;
  if (!hasClientValue(requestedGrassType)) {
    return {
      requestedGrassType,
      grassType: 'unknown',
      isStAugustine: false,
      isKnown: false,
      warnings: ['grass_type_not_recorded'],
    };
  }
  const raw = normalizeDethatchingToken(requestedGrassType);
  const compact = String(requestedGrassType).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (
    ['a', 'b', 'st_augustine', 'staugustine', 'staug', 'floratam'].includes(raw) ||
    ['staugustine', 'staug'].includes(compact) ||
    compact.includes('floratam')
  ) {
    return { requestedGrassType, grassType: 'st_augustine', isStAugustine: true, isKnown: true, warnings: [] };
  }
  if (['c1', 'bermuda'].includes(raw)) {
    return { requestedGrassType, grassType: 'bermuda', isStAugustine: false, isKnown: true, warnings: [] };
  }
  if (['c2', 'zoysia'].includes(raw)) {
    return { requestedGrassType, grassType: 'zoysia', isStAugustine: false, isKnown: true, warnings: [] };
  }
  if (['d', 'bahia'].includes(raw)) {
    return { requestedGrassType, grassType: 'bahia', isStAugustine: false, isKnown: true, warnings: [] };
  }
  return {
    requestedGrassType,
    grassType: 'unknown',
    isStAugustine: false,
    isKnown: false,
    warnings: ['unknown_grass_type_requires_dethatching_review'],
  };
}

function resolveDethatchingProbe(options = {}) {
  const probeValues = [
    parseClientNonNegativeMeasurement(options.thatchProbe1Inches),
    parseClientNonNegativeMeasurement(options.thatchProbe2Inches),
    parseClientNonNegativeMeasurement(options.thatchProbe3Inches),
  ];
  const validProbeValues = probeValues.filter(value => value !== null);
  const explicitDepth = parseClientNonNegativeMeasurement(options.thatchDepthInches);
  const averageDepth = explicitDepth !== null
    ? explicitDepth
    : (validProbeValues.length > 0
      ? validProbeValues.reduce((sum, value) => sum + value, 0) / validProbeValues.length
      : null);
  const warnings = [];
  if (validProbeValues.length > 0 && validProbeValues.length < 3) warnings.push('partial_thatch_probe_readings');
  if ((clientBooleanTrue(options.requireThatchDepth) || clientBooleanTrue(options.requireThatchProbe)) && averageDepth === null) {
    warnings.push('thatch_depth_not_recorded');
  }
  return {
    thatchDepthInches: averageDepth === null ? null : roundClientMoney(averageDepth),
    thatchMeasurementSource: options.thatchMeasurementSource || (validProbeValues.length > 0 || explicitDepth !== null ? 'manual' : 'unknown'),
    probeMeasurements: {
      thatchProbe1Inches: probeValues[0],
      thatchProbe2Inches: probeValues[1],
      thatchProbe3Inches: probeValues[2],
    },
    warnings,
  };
}

const DETHATCHING_MANAGER_APPROVAL_REASONS = new Set([
  'verified_thatch_probe',
  'customer_requested_after_warning',
  'bermuda_or_zoysia_confirmed',
  'manager_override',
]);

function normalizeDethatchingManagerApprovalReason(value) {
  const raw = typeof value === 'string' ? normalizeDethatchingToken(value) : '';
  return DETHATCHING_MANAGER_APPROVAL_REASONS.has(raw) ? raw : null;
}

function priceDethatchingClient(lawnSqFt, options = {}) {
  const cfg = DETHATCHING_CONFIG;
  const lawnEst = Math.max(0, Number(lawnSqFt) || 0);
  const cleanupChoice = normalizeDethatchingChoice(
    options.cleanupLevel,
    cfg.cleanup,
    'none',
    'invalid_dethatching_cleanup_level_defaulted'
  );
  const accessChoice = normalizeDethatchingChoice(
    options.access ?? options.accessDifficulty,
    cfg.accessMinutes,
    'easy',
    'invalid_dethatching_access_defaulted'
  );
  const debrisRemovalRequested = clientBooleanTrue(options.debrisRemovalIncluded);
  const cleanupLevel = cleanupChoice.key === 'none' && debrisRemovalRequested ? 'light' : cleanupChoice.key;
  const cleanup = cfg.cleanup[cleanupLevel] || cfg.cleanup.none;
  const grass = normalizeDethatchingGrassType(options);
  const probe = resolveDethatchingProbe(options);
  const basePrimaryMin = lawnEst / cfg.timeModel.primaryPassSqFtPerMin;
  const baseCrossMin = lawnEst / cfg.timeModel.crossPassSqFtPerMin;
  const setupMin = cfg.timeModel.setupMin;
  const cleanupMin = (lawnEst / 1000) * cleanup.minutesPer1K;
  const accessMin = cfg.accessMinutes[accessChoice.key] || 0;
  const timeMin = basePrimaryMin + baseCrossMin + setupMin + cleanupMin + accessMin;
  const laborCost = 35 * timeMin / 60;
  const materialCost = (lawnEst / 1000) * cfg.materialPer1K;
  const cleanupPriceAdder = (lawnEst / 1000) * cleanup.pricePer1K;
  const rawCost = laborCost + materialCost;
  const formulaBasePrice = Math.max(cfg.floor, Math.round(rawCost / cfg.marginDivisor));
  const compatibilityBasePrice = cleanupLevel === 'none' && accessChoice.key === 'easy'
    ? cfg.baseCompatibilityPrices?.[String(Math.round(lawnEst))]
    : undefined;
  const basePrice = Number.isFinite(Number(compatibilityBasePrice))
    ? Number(compatibilityBasePrice)
    : formulaBasePrice;
  const calculatedPrice = Math.round(basePrice + cleanupPriceAdder);
  const debrisRemovalIncluded = debrisRemovalRequested || cleanupLevel !== 'none';
  const managerApproved = clientBooleanTrue(options.managerApproved);
  const managerApprovalOverrideReason = normalizeDethatchingManagerApprovalReason(options.managerApprovalReason);
  const requiresManagerApproval = !!(cfg.manualReview.stAugustineRequiresApproval && grass.isStAugustine);
  const warnings = uniqueClientStrings([
    cleanupChoice.warning,
    accessChoice.warning,
    ...grass.warnings,
    ...probe.warnings,
    cleanupLevel === 'none' && !debrisRemovalIncluded ? 'base_price_excludes_bagging_or_debris_hauling' : null,
    requiresManagerApproval ? 'Dethatching St. Augustine / Floratam can damage stolons. Manager approval required.' : null,
  ]);
  const manualReviewReasons = [];
  if (lawnEst >= cfg.manualReview.largeLawnSqFt) manualReviewReasons.push('large_lawn_dethatching_manual_review');
  if (cleanupLevel === 'heavy' && lawnEst >= cfg.manualReview.heavyCleanupSqFt) manualReviewReasons.push('heavy_cleanup_required');
  if (accessChoice.key === 'difficult') manualReviewReasons.push('difficult_access_dethatching');
  if (grass.grassType === 'unknown') manualReviewReasons.push('unknown_grass_dethatching_review');
  if ((clientBooleanTrue(options.requireThatchDepth) || clientBooleanTrue(options.requireThatchProbe)) && probe.thatchDepthInches === null) {
    manualReviewReasons.push('thatch_depth_not_recorded');
  }
  if (requiresManagerApproval && !managerApproved) {
    manualReviewReasons.push('st_augustine_dethatching_manager_approval_required');
  }
  if (requiresManagerApproval && managerApproved && !managerApprovalOverrideReason) {
    manualReviewReasons.push('st_augustine_dethatching_manager_approval_reason_missing');
  }
  if (clientBooleanTrue(options.isCommercial) || normalizeDethatchingToken(options.propertyType) === 'commercial') {
    manualReviewReasons.push('commercial_dethatching_manual_quote_required');
  }

  let dethatchingRecommended = false;
  let recommendationReason = 'thatch_depth_not_recorded';
  if (probe.thatchDepthInches !== null) {
    if (grass.grassType === 'bermuda' || grass.grassType === 'zoysia') {
      dethatchingRecommended = probe.thatchDepthInches > 0.5;
      recommendationReason = dethatchingRecommended
        ? 'bermuda_zoysia_thatch_above_half_inch'
        : 'thatch_probe_threshold_not_met';
      if (!dethatchingRecommended) manualReviewReasons.push('thatch_probe_threshold_not_met');
    } else if (grass.isStAugustine) {
      recommendationReason = probe.thatchDepthInches > 0.75
        ? 'st_augustine_threshold_requires_manager_approval'
        : 'st_augustine_no_auto_recommendation';
    } else if (grass.grassType === 'unknown') {
      recommendationReason = 'unknown_grass_manual_review';
    } else {
      recommendationReason = 'grass_track_not_configured_for_auto_recommendation';
    }
  }

  const managerApprovalSatisfied = !requiresManagerApproval || (managerApproved && !!managerApprovalOverrideReason);
  const manualReviewReasonList = uniqueClientStrings(manualReviewReasons);
  const approvalBlocked = requiresManagerApproval && !managerApprovalSatisfied;
  const approvalBlockReason = approvalBlocked
    ? 'Manager approval is required before St. Augustine / Floratam dethatching can be quoted.'
    : null;
  const manualReviewBlockReason = !approvalBlockReason && manualReviewReasonList.length > 0
    ? `Dethatching requires admin review: ${manualReviewReasonList.join(', ')}.`
    : null;
  const quoteRequired = approvalBlocked || manualReviewReasonList.length > 0;
  const detailParts = [
    'Double-pass machine time',
    cleanup.label,
    accessChoice.key === 'easy' ? null : `${accessChoice.key} access`,
    debrisRemovalIncluded ? 'cleanup/debris removal included' : null,
    approvalBlocked ? 'manager approval required' : null,
  ].filter(Boolean);

  return {
    service: 'dethatching',
    lawnSqFt: lawnEst,
    manuallyEnteredLawnSqFt: options.manuallyEnteredLawnSqFt ?? null,
    price: quoteRequired ? null : calculatedPrice,
    estimatedPrice: calculatedPrice,
    basePrice,
    rawCost: roundClientMoney(rawCost),
    timeMin: roundClientMoney(timeMin),
    laborCost: roundClientMoney(laborCost),
    materialCost: roundClientMoney(materialCost),
    cleanupLevel,
    requestedCleanupLevel: cleanupChoice.key,
    cleanupLabel: cleanup.label,
    cleanupMin: roundClientMoney(cleanupMin),
    cleanupPriceAdder: roundClientMoney(cleanupPriceAdder),
    debrisRemovalIncluded,
    access: accessChoice.key,
    accessMin,
    grassType: grass.grassType,
    requestedGrassType: grass.requestedGrassType,
    thatchDepthInches: probe.thatchDepthInches,
    thatchMeasurementSource: probe.thatchMeasurementSource,
    probeMeasurements: probe.probeMeasurements,
    dethatchingRecommended,
    recommendationReason,
    requiresManualReview: quoteRequired,
    manualReviewReasons: manualReviewReasonList,
    quoteRequired,
    requiresCustomQuote: quoteRequired,
    autoQuoteRequiresAdminApproval: quoteRequired,
    customQuoteReason: approvalBlockReason || manualReviewBlockReason,
    reason: approvalBlockReason || manualReviewBlockReason,
    requiresManagerApproval,
    managerApproved,
    managerApprovalSatisfied,
    managerApprovalReason: requiresManagerApproval ? 'st_augustine_dethatching' : null,
    managerApprovalOverrideReason,
    warnings,
    warning: requiresManagerApproval
      ? 'Dethatching St. Augustine / Floratam can damage stolons. Manager approval required.'
      : null,
    equipmentMetadata: {
      equipmentAssetTag: 'LAWN-001',
      equipmentName: 'Classen TR-20H Dethatcher',
      seasonalUse: 'spring/fall',
      internalOnly: true,
    },
    detail: detailParts.join(' | '),
  };
}

function resolveFoamDrillTier(points) {
  const pointCount = Number(points === undefined ? 5 : points);
  if (!Number.isInteger(pointCount) || pointCount < 1) {
    throw new Error('Foam drill point count must be a positive whole number.');
  }
  const tiers = [
    { max: 5, c: 1, l: 1, n: 'Spot (1–5)' },
    { max: 10, c: 2, l: 1.5, n: 'Moderate (6–10)' },
    { max: 15, c: 3, l: 2, n: 'Extensive (11–15)' },
    { max: 20, c: 4, l: 3, n: 'Full Perimeter' },
  ];
  const tier = tiers.find(t => pointCount <= t.max);
  if (!tier) throw new Error(`Foam drill point count ${pointCount} exceeds the configured 20-point maximum.`);
  return { pointCount, tier };
}

const PRE_SLAB_TERMITICIDE_PRODUCTS = {
  termidor_sc: {
    label: 'Termidor SC - Fipronil',
    shortLabel: 'Termidor SC',
    activeIngredient: 'fipronil',
    chemistryType: 'non_repellent',
    positioning: 'premium_non_repellent',
    containerCost: 174.72,
    containerOz: 78,
    productOzPer10SqFt: 0.8,
    marginDivisor: 0.45,
    warning: 'Premium fipronil non-repellent pre-slab treatment. Confirm label rate and builder documentation requirements.',
  },
  taurus_sc: {
    label: 'Taurus SC - Fipronil',
    shortLabel: 'Taurus SC',
    activeIngredient: 'fipronil',
    chemistryType: 'non_repellent',
    positioning: 'standard_non_repellent',
    containerCost: 95.00,
    containerOz: 78,
    productOzPer10SqFt: 0.8,
    marginDivisor: 0.45,
    warning: 'Value fipronil non-repellent pre-slab treatment. Confirm label rate and product configuration.',
  },
  bifen_it: {
    label: 'Bifen I/T - Bifenthrin',
    shortLabel: 'Bifen I/T',
    activeIngredient: 'bifenthrin',
    chemistryType: 'repellent_pyrethroid',
    positioning: 'standard_repellent',
    containerCost: 41.53,
    containerOz: 128,
    productOzPer10SqFt: 1.0,
    marginDivisor: 0.45,
    warning: 'Bifenthrin repellent barrier. Not equivalent to non-repellent fipronil positioning. Confirm label supports pre-construction subterranean termite treatment.',
  },
  talstar_p: {
    label: 'Talstar P - Bifenthrin',
    shortLabel: 'Talstar P',
    activeIngredient: 'bifenthrin',
    chemistryType: 'repellent_pyrethroid',
    positioning: 'branded_repellent',
    containerCost: 38.99,
    containerOz: 128,
    productOzPer10SqFt: 1.0,
    marginDivisor: 0.45,
    warning: 'Branded bifenthrin repellent barrier. Confirm exact Talstar P label and rate before treatment.',
  },
};

const PRE_SLAB_TERMITICIDE_MINIMUMS = {
  standalone: [
    { maxSqFt: 250, floor: 225 },
    { maxSqFt: 750, floor: 325 },
    { maxSqFt: 1250, floor: 425 },
    { maxSqFt: Infinity, floor: 600 },
  ],
  builderBatch: [
    { maxSqFt: 250, floor: 150 },
    { maxSqFt: 750, floor: 250 },
    { maxSqFt: 1250, floor: 350 },
    { maxSqFt: Infinity, floor: 500 },
  ],
  sameTripAddOn: [
    { maxSqFt: 250, floor: 125 },
    { maxSqFt: 750, floor: 225 },
    { maxSqFt: 1250, floor: 325 },
    { maxSqFt: Infinity, floor: 500 },
  ],
};

const PRE_SLAB_JOB_CONTEXT_LABELS = {
  standalone: 'Standalone one-off job',
  builderBatch: 'Builder batch / same site',
  sameTripAddOn: 'Same-trip add-on',
};

const PRE_SLAB_COMPLIANCE_ADMIN_COST = 25;
const PRE_SLAB_INCLUDE_DRIVE_COST_BY_CONTEXT = {
  standalone: true,
  builderBatch: false,
  sameTripAddOn: false,
};

const TRENCHING_TERMITICIDE_PRODUCTS = {
  termidor_sc: {
    label: 'Termidor SC - Fipronil',
    shortLabel: 'Termidor SC',
    activeIngredient: 'fipronil',
    chemistryType: 'non_repellent',
    positioning: 'premium_non_repellent',
    containerCost: 375.00,
    containerOz: 78,
    standardOzPerGal: 0.8,
    highOzPerGal: 1.6,
    warning: 'Premium fipronil non-repellent trench treatment. Confirm exact label rate, trench depth, and warranty obligation before treatment.',
  },
  taurus_sc: {
    label: 'Taurus SC - Fipronil',
    shortLabel: 'Taurus SC',
    activeIngredient: 'fipronil',
    chemistryType: 'non_repellent',
    positioning: 'standard_non_repellent',
    containerCost: 85.00,
    containerOz: 78,
    standardOzPerGal: 0.8,
    highOzPerGal: 1.6,
    warning: 'Value fipronil non-repellent trench treatment. Good default option for standard trenching when a fipronil barrier is desired.',
  },
  bifen_it: {
    label: 'Bifen I/T - Bifenthrin',
    shortLabel: 'Bifen I/T',
    activeIngredient: 'bifenthrin',
    chemistryType: 'repellent_pyrethroid',
    positioning: 'standard_repellent',
    containerCost: 55.00,
    containerOz: 96,
    standardOzPerGal: 1.0,
    highOzPerGal: 2.0,
    warning: 'Repellent bifenthrin barrier; not equivalent to non-repellent fipronil positioning.',
  },
  talstar_p: {
    label: 'Talstar P / Pro - Bifenthrin',
    shortLabel: 'Talstar P / Pro',
    activeIngredient: 'bifenthrin',
    chemistryType: 'repellent_pyrethroid',
    positioning: 'branded_repellent',
    containerCost: 65.00,
    containerOz: 96,
    standardOzPerGal: 1.0,
    highOzPerGal: 2.0,
    warning: 'Branded bifenthrin repellent barrier. Do not attach long repair-and-retreat warranty without admin approval.',
  },
};

function normalizeTrenchingProductKey(value) {
  const raw = String(value || 'taurus_sc')
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, '_')
    .replace(/_+/g, '_');
  const aliases = {
    termidor: 'termidor_sc',
    termidor_sc: 'termidor_sc',
    basf: 'termidor_sc',
    taurus: 'taurus_sc',
    taurus_sc: 'taurus_sc',
    fipronil: 'taurus_sc',
    bifen: 'bifen_it',
    bifen_it: 'bifen_it',
    bifen_i_t: 'bifen_it',
    bifenthrin: 'bifen_it',
    talstar: 'talstar_p',
    talstar_p: 'talstar_p',
    talstar_pro: 'talstar_p',
    talstar_professional: 'talstar_p',
  };
  return aliases[raw] || 'taurus_sc';
}

function normalizeTrenchingRate(value) {
  const raw = String(value || 'standard').trim().toLowerCase().replace(/[%\s.-]+/g, '_').replace(/_+/g, '_');
  if (['high', 'high_rate', '0_125', '0_12', 'problem_soil', 'active_subterranean', 'formosan', 'asian_subterranean'].includes(raw)) return 'high';
  return 'standard';
}

function normalizeTrenchingWarranty(value, product) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return product.chemistryType === 'repellent_pyrethroid' ? 'none' : 'one_year_retreat';
  const aliases = {
    none: 'none',
    one_year: 'one_year_retreat',
    '1_year': 'one_year_retreat',
    one_year_retreat: 'one_year_retreat',
    three_year: 'three_year_repair_retreat',
    '3_year': 'three_year_repair_retreat',
    three_year_repair_retreat: 'three_year_repair_retreat',
    five_year: 'five_year_repair_retreat',
    '5_year': 'five_year_repair_retreat',
    five_year_repair_retreat: 'five_year_repair_retreat',
  };
  return aliases[raw] || (product.chemistryType === 'repellent_pyrethroid' ? 'none' : 'one_year_retreat');
}

function normalizePreSlabProductKey(value) {
  const raw = String(value || 'termidor_sc')
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, '_')
    .replace(/_+/g, '_');
  const aliases = {
    termidor: 'termidor_sc',
    termidor_sc: 'termidor_sc',
    fipronil: 'termidor_sc',
    taurus: 'taurus_sc',
    taurus_sc: 'taurus_sc',
    bifen: 'bifen_it',
    bifen_it: 'bifen_it',
    bifen_i_t: 'bifen_it',
    bifenthrin: 'bifen_it',
    talstar: 'talstar_p',
    talstar_p: 'talstar_p',
    talstar_professional: 'talstar_p',
  };
  return aliases[raw] || 'termidor_sc';
}

function normalizePreSlabVolume(value) {
  const raw = String(value || 'NONE').trim().toUpperCase();
  if (raw === '10' || raw === '10PLUS' || raw === '10_PLUS') return { key: '10plus', label: '10+', multiplier: 0.85 };
  if (raw === '5' || raw === '5PLUS' || raw === '5_PLUS') return { key: '5plus', label: '5+', multiplier: 0.90 };
  return { key: 'none', label: 'NONE', multiplier: 1.00 };
}

function normalizePreSlabWarranty(value) {
  const raw = String(value || 'BASIC').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const aliases = {
    NONE: 'NONE',
    NO: 'NONE',
    NO_WARRANTY: 'NONE',
    BASIC: 'BASIC',
    BASIC_1YR: 'BASIC',
    BASIC_1_YEAR: 'BASIC',
    ONE_YEAR: 'BASIC',
    ONE_YEAR_INCLUDED: 'BASIC',
    EXTENDED: 'EXTENDED',
    FIVE_YEAR: 'EXTENDED',
    FIVE_YEAR_EXTENDED: 'EXTENDED',
    '5_YEAR': 'EXTENDED',
  };
  const tier = aliases[raw] || 'BASIC';
  const labels = {
    NONE: 'No warranty',
    BASIC: 'Basic 1-yr warranty',
    EXTENDED: 'Extended 5-yr warranty',
  };
  return { tier, label: labels[tier] };
}

function normalizePreSlabJobContext(value, volumeKey = 'none') {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, '_')
    .replace(/_+/g, '_');
  const aliases = {
    standalone: 'standalone',
    one_off: 'standalone',
    oneoff: 'standalone',
    single_job: 'standalone',
    builder: 'builderBatch',
    builderbatch: 'builderBatch',
    builder_batch: 'builderBatch',
    batch: 'builderBatch',
    same_site: 'builderBatch',
    same_trip: 'sameTripAddOn',
    sametripaddon: 'sameTripAddOn',
    same_trip_add_on: 'sameTripAddOn',
    same_trip_addon: 'sameTripAddOn',
    addon: 'sameTripAddOn',
    add_on: 'sameTripAddOn',
  };
  if (aliases[raw]) return aliases[raw];
  return volumeKey === '5plus' || volumeKey === '10plus' ? 'builderBatch' : 'standalone';
}

function lookupPreSlabMinimum(slabSqFt, jobContext) {
  const tiers = PRE_SLAB_TERMITICIDE_MINIMUMS[jobContext] || PRE_SLAB_TERMITICIDE_MINIMUMS.standalone;
  const tier = tiers.find(row => slabSqFt <= row.maxSqFt) || tiers[tiers.length - 1];
  return {
    floor: tier.floor,
    maxSqFt: tier.maxSqFt,
    basis: `${PRE_SLAB_JOB_CONTEXT_LABELS[jobContext] || PRE_SLAB_JOB_CONTEXT_LABELS.standalone}, ` +
      `${tier.maxSqFt === Infinity ? 'over 1,250' : `up to ${tier.maxSqFt}`} sqft`,
  };
}

function resolveLawnFreq(freq) {
  const parsed = Number(freq);
  return LAWN_FREQS.includes(parsed) ? parsed : 9;
}

function lawnLookup(lp, sf, freqIdx) {
  const pts = lp.pts;
  if (sf <= pts[0][0]) return { monthly: pts[0][freqIdx + 1], pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
  if (sf > LAWN_TABLE_MAX_SQFT) {
    const lo = pts[pts.length - 2], hi = pts[pts.length - 1];
    const slope = (hi[freqIdx + 1] - lo[freqIdx + 1]) / (hi[0] - lo[0]);
    return {
      monthly: Math.round(hi[freqIdx + 1] + (sf - hi[0]) * slope),
      pricingBasis: 'EXTRAPOLATED_ABOVE_TABLE_MAX',
      pricingSource: 'EXTRAPOLATED_TABLE',
    };
  }
  for (let i = 1; i < pts.length; i++) {
    if (sf <= pts[i][0]) {
      const lo = pts[i - 1], hi = pts[i];
      const ratio = (sf - lo[0]) / (hi[0] - lo[0]);
      return {
        monthly: Math.round(lo[freqIdx + 1] + ratio * (hi[freqIdx + 1] - lo[freqIdx + 1])),
        pricingBasis: 'TABLE_INTERPOLATION',
        pricingSource: 'MARKET_TABLE',
      };
    }
  }
  return { monthly: pts[pts.length - 1][freqIdx + 1], pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
}

// Delegates entirely to @waves/lawn-cost-floor so the preview floor is the same
// math the server bills. opts mirror the server's property/options:
//   complexityMinutes      extra labor minutes/visit — see lawnComplexityMinutes()
//   callbackReservePerVisit override of the $2 default (poor maintenance / high pressure)
function calcLawnFloorPrice(sf, grassType, visits, opts = {}) {
  const annualMaterialBudget = lawnMaterialBudget(grassType, visits);
  const materialCostPerVisit = lawnMaterialCostPerVisit(annualMaterialBudget, sf, visits);
  const floor = computeLawnCostFloor({
    lawnSqFt: sf,
    visits,
    materialCostPerVisit,
    laborMinutesBase: LAWN_PRICING_V2.laborMinutesBase,
    laborMinutesPer1000Sqft: LAWN_PRICING_V2.laborMinutesPer1000Sqft,
    complexityMinutes: Math.max(0, Number(opts.complexityMinutes) || 0),
    laborRate: LAWN_PRICING_V2.laborRateLoaded,
    routeDriveMinutes: LAWN_PRICING_V2.routeDensityMinutes[LAWN_PRICING_V2.defaultRouteDensity],
    callbackReservePerVisit: Number.isFinite(Number(opts.callbackReservePerVisit))
      ? Math.max(0, Number(opts.callbackReservePerVisit))
      : LAWN_PRICING_V2.callbackReservePerVisitDefault,
    equipmentReservePerVisit: LAWN_PRICING_V2.equipmentReservePerVisit,
    adminAnnual: LAWN_PRICING_V2.adminAnnualDefault,
    targetGrossMargin: LAWN_PRICING_V2.targetCollectedMarginFloor,
  });
  const pa = Math.ceil(floor.minimumCollectedAnnualPriceFor55 / visits);
  const ann = pa * visits;
  return {
    pa,
    ann,
    mo: Math.round(ann / 12 * 100) / 100,
    costFloorAnnual: floor.minimumCollectedAnnualPriceFor55,
    costs: {
      annualMaterial: Math.round(floor.annualMaterial * 100) / 100,
      annualLabor: Math.round(floor.annualLabor * 100) / 100,
      annualDrive: Math.round(floor.annualDrive * 100) / 100,
      annualCallbackReserve: Math.round(floor.annualCallbackReserve * 100) / 100,
      annualAdmin: LAWN_PRICING_V2.adminAnnualDefault,
      total: Math.round(floor.annualCost * 100) / 100,
      pricingVersion: LAWN_PRICING_V2.pricingVersion,
    },
  };
}

/* ── main engine ────────────────────────────────────────────── */

export function calculateEstimate(inputs) {
  const {
    homeSqFt: _homeSqFt,
    stories: _stories,
    lotSqFt: _lotSqFt,
    propertyType,
    hasPool,
    hasPoolCage,
    poolCageSize,
    hasLargeDriveway,
    indoor,
    shrubDensity,
    treeDensity,
    landscapeComplexity,
    nearWater,
    urgency,
    isAfterHours,
    isRecurringCustomer: isRC,
    bedArea: _bedArea,
    palmCount: _palmCount,
    palmTreatmentCount: _palmTreatmentCount,
    treeCount: _treeCount,
    roachModifier: roachMod,
    pestFreq: _pestFreq,
    plugArea: _plugArea,
    plugSpacing: _plugSpacing,
    grassType: _grassType,
    lawnFreq: _lawnFreq,
    measuredTurfSf: _measuredTurfSf,
    estimatedTurfSf: _estimatedTurfSf,
    imperviousSurfacePercent: _imperviousSurfacePercent,
    imperviosSurfacePercent: _imperviosSurfacePercent,
    estimatedBedAreaPercent: _estimatedBedAreaPercent,
    mosquitoStationCount: _mosquitoStationCount,
    mosquitoDunkCount: _mosquitoDunkCount,
    otLawnType,
    exclSimple: exS,
    exclModerate: exM,
    exclAdvanced: exA,
    exclWaive: exW,
    bedbugRooms: _bedbugRooms,
    bedbugMethod,
    bedbugSeverity,
    bedbugPrepStatus,
    bedbugOccupancyType,
    bedbugHeatScope,
    bedbugSubcontractCost,
    termiteFootprintSqFt: _termiteFootprintSqFt,
    termitePerimeterLF: _termitePerimeterLF,
    termiteBaitComplexity,
    termiteBaitSystem,
    termiteMonitoringTier,
    trenchingPerimeterLF: _trenchingPerimeterLF,
    trenchingConcreteLF: _trenchingConcreteLF,
    trenchingDirtLF: _trenchingDirtLF,
    trenchingConcretePct: _trenchingConcretePct,
    trenchingEstimateFromFootprint,
    trenchingProductKey,
    trenchingApplicationRate,
    trenchingDepthFt,
    trenchingWarrantyTier,
    trenchingLabelConfirmed,
    boracareSqft: bcSqft,
    preslabSqft: psSqft,
    preslabWarranty,
    preslabVolume,
    preslabJobContext,
    preslabProductKey,
    preslabLabelConfirmed,
    foamPoints: _foamPoints,
    roachType,
    roachSeverity,
    // Service selections (booleans)
    svcLawn,
    svcPest,
    svcTs,
    svcInjection,
    svcMosquito,
    svcTermiteBait,
    svcRodentBait,
    svcOnetimePest,
    svcOnetimeLawn,
    svcOnetimeMosquito,
    svcPlugging,
    svcTopdress,
    svcDethatch,
    dethatchingCleanupLevel,
    dethatchingDebrisRemovalIncluded,
    dethatchingAccess,
    dethatchingAccessDifficulty,
    dethatchingManagerApproved,
    dethatchingManagerApprovalReason,
    thatchProbe1Inches,
    thatchProbe2Inches,
    thatchProbe3Inches,
    thatchDepthInches,
    thatchMeasurementSource,
    svcTrenching,
    svcBoracare,
    svcPreslab,
    svcFoam,
    svcRodentTrap,
    svcFlea,
    svcWasp,
    svcRoach,
    svcBedbug,
    svcExclusion,
    // v1.5 inputs
    accessDifficulty,   // 'EASY' | 'MODERATE' | 'DIFFICULT' — gate access, narrow side yards
    hasIrrigation,      // boolean — extensive irrigation creates standing water
    injectablePalms: _injectablePalms, // legacy manual override for injectable palm count
    bedbugEquipment,    // 'SUBCONTRACT' | 'INHOUSE' — heat treatment equipment source
  } = inputs;

  const homeSqFt = Number(_homeSqFt) || 0;
  const stories = Math.max(1, Number(_stories) || 1);
  const lotSqFt = Number(_lotSqFt) || 0;
  const bedArea = Number(_bedArea) || 0;
  const palmCount = Number(_palmCount) || 0;
  const treeCount = Number(_treeCount) || 0;
  const pestFreq = Number(_pestFreq) || 4;
  const plugArea = Math.max(0, Number(_plugArea) || 0);
  const plugSpacing = Number(_plugSpacing) || 12;
  const bedbugRooms = Number(_bedbugRooms) || 1;
  const termiteFootprintSqFt = toPositiveNumber(_termiteFootprintSqFt);
  const termitePerimeterLF = toPositiveNumber(_termitePerimeterLF);
  const trenchingPerimeterLF = toPositiveNumber(_trenchingPerimeterLF);
  const hasTrenchingConcreteLF = hasNonNegativeNumber(_trenchingConcreteLF);
  const hasTrenchingDirtLF = hasNonNegativeNumber(_trenchingDirtLF);
  const hasTrenchingConcretePct = hasNonNegativeNumber(_trenchingConcretePct);
  const trenchingConcreteLF = hasTrenchingConcreteLF ? toNonNegativeNumber(_trenchingConcreteLF) : 0;
  const trenchingDirtLF = hasTrenchingDirtLF ? toNonNegativeNumber(_trenchingDirtLF) : 0;
  const trenchingConcretePctRaw = hasTrenchingConcretePct ? toNonNegativeNumber(_trenchingConcretePct) : 0;
  const trenchingConcretePct = trenchingConcretePctRaw > 1
    ? trenchingConcretePctRaw / 100
    : trenchingConcretePctRaw;
  const grassType = normalizeGrassType(_grassType);
  const lawnFreq = resolveLawnFreq(_lawnFreq);
  const mosquitoStationCount = Math.max(0, Math.round(Number(_mosquitoStationCount) || 0));
  const mosquitoDunkCount = Math.max(0, Math.round(Number(_mosquitoDunkCount) || 0));

  const LABOR = 35, DRIVE = 20;
  const footprint = homeSqFt > 0 ? Math.round(homeSqFt / stories) : 0;
  const treeNum = treeDensity === 'HEAVY' ? 2 : treeDensity === 'MODERATE' ? 1 : 0;
  const estimateHardscape = () => {
    const pt = (propertyType || '').toLowerCase();
    let hardscape = 0;
    if (pt.includes('commercial')) {
      hardscape = Math.round(lotSqFt * 0.15);
    } else {
      let base = 800;
      if (pt.includes('town') || pt.includes('duplex')) {
        hardscape = 400 + Math.max(0, Math.round((lotSqFt - 7500) * 0.02));
      } else if (pt.includes('condo')) {
        hardscape = 200 + Math.max(0, Math.round((lotSqFt - 7500) * 0.05));
      } else {
        const tier1 = Math.max(0, Math.min(lotSqFt, 15000) - 7500) * 0.03;
        const tier2 = Math.max(0, lotSqFt - 15000) * 0.05;
        hardscape = base + Math.round(tier1 + tier2);
      }
    }
    if (hasPoolCage) hardscape += 600;
    else if (hasPool) hardscape += 450;
    if (hasLargeDriveway) hardscape += 300;
    return hardscape;
  };

  const selectedServiceFlags = [
    svcLawn,
    svcPest,
    svcTs,
    svcInjection,
    svcMosquito,
    svcTermiteBait,
    svcRodentBait,
    svcOnetimePest,
    svcOnetimeLawn,
    svcOnetimeMosquito,
    svcPlugging,
    svcTopdress,
    svcDethatch,
    svcTrenching,
    svcBoracare,
    svcPreslab,
    svcFoam,
    svcRodentTrap,
    svcFlea,
    svcWasp,
    svcRoach,
    svcBedbug,
    svcExclusion,
  ];
  const preSlabOnly = !!svcPreslab && selectedServiceFlags.filter(Boolean).length === 1;
  if (!preSlabOnly && homeSqFt <= 0 && lotSqFt <= 0) {
    return { error: 'Enter home sq ft or lot size.' };
  }

  /* ── urgency multiplier ──────────────────────────────────── */
  let urgMult = 1.0, urgLabel = '';
  if (urgency === 'SOON') {
    urgMult = isAfterHours ? 1.50 : 1.25;
    urgLabel = isAfterHours ? 'Soon+AH (+50%)' : 'Soon (+25%)';
  } else if (urgency === 'URGENT') {
    urgMult = isAfterHours ? 2.0 : 1.50;
    urgLabel = isAfterHours ? 'Emerg AH (+100%)' : 'Emergency (+50%)';
  }

  const rD = isRC ? 0.85 : 1.0;
  function otP(b) { return Math.round(b * urgMult * rD); }

  /* ── field verify tracking ───────────────────────────────── */
  let fieldVerify = [];
  const bedAreaIsEstimated = !bedArea;
  // atticIsEstimated flag — caller can pass boracareSqftAuto if needed;
  // for now we assume auto-estimated when boracareSqft was auto-filled
  const atticIsEstimated = inputs.boracareSqftAuto || false;

  let R = {}, wgServices = [];
  let notes = [];
  const pricingMetadata = {
    warnings: [],
    manualReviewReasons: [],
    skippedServices: [],
  };
  const uniqueStrings = values => [...new Set((values || []).filter(Boolean))];
  const addRoutingWarning = warning => {
    pricingMetadata.warnings = uniqueStrings([...pricingMetadata.warnings, warning]);
  };
  const addManualReviewReason = reason => {
    pricingMetadata.manualReviewReasons = uniqueStrings([...pricingMetadata.manualReviewReasons, reason]);
  };
  const addSkippedService = skipped => {
    if (!skipped) return;
    pricingMetadata.skippedServices.push(skipped);
    if (skipped.skippedDuplicateRoachLine) {
      pricingMetadata.skippedDuplicateRoachLine = true;
      pricingMetadata.skippedService = skipped.skippedService;
      pricingMetadata.skippedReason = skipped.skippedReason;
    }
  };
  const isCommercial = isCommercialEstimateInput(inputs);
  const commercialManualSpecItems = [];
  if (isCommercial && hasAnySelectedFlag(inputs, COMMERCIAL_PEST_FALLBACK_FLAGS)) {
    commercialManualSpecItems.push(commercialManualQuoteItem("commercial_pest", inputs));
  }
  if (isCommercial && hasAnySelectedFlag(inputs, COMMERCIAL_LAWN_FALLBACK_FLAGS)) {
    commercialManualSpecItems.push(commercialManualQuoteItem("commercial_lawn", inputs));
  }
  function addLawnCustomQuoteNote() {
    if (notes.some(n => n.type === 'LAWN_CUSTOM_QUOTE')) return;
    notes.push({
      type: 'LAWN_CUSTOM_QUOTE',
      text: 'Turf area exceeds 20,000 sq ft. Pricing was extrapolated and requires field verification/custom quote.',
      priority: 'HIGH',
    });
  }

  function estimateLegacyTurfArea() {
    let hardscapeEstimate = 800;
    const propertyTypeKey = String(propertyType || '').toLowerCase();
    if (propertyTypeKey.includes('town') || propertyTypeKey.includes('duplex')) {
      hardscapeEstimate = 400 + Math.max(0, Math.round((lotSqFt - 7500) * 0.02));
    } else if (propertyTypeKey.includes('condo')) {
      hardscapeEstimate = 200 + Math.max(0, Math.round((lotSqFt - 7500) * 0.05));
    }
    else if (propertyTypeKey.includes('commercial')) hardscapeEstimate = lotSqFt * 0.15;
    else {
      if (lotSqFt > 7500) hardscapeEstimate += (Math.min(lotSqFt, 15000) - 7500) * 0.03;
      if (lotSqFt > 15000) hardscapeEstimate += (lotSqFt - 15000) * 0.05;
    }
    if (hasPoolCage) hardscapeEstimate += 600;
    else if (hasPool) hardscapeEstimate += 450;
    if (hasLargeDriveway) hardscapeEstimate += 300;

    const openArea = Math.max(0, Math.round(lotSqFt - footprint - hardscapeEstimate));
    let score = 0;
    if (hasPool) score += 2;
    if (hasPoolCage) score += 2;
    if (hasLargeDriveway) score += 2;
    if (shrubDensity === 'MODERATE') score += 1; else if (shrubDensity === 'HEAVY') score += 2;
    if (treeDensity === 'MODERATE') score += 1; else if (treeDensity === 'HEAVY') score += 2;
    if (landscapeComplexity === 'MODERATE') score += 1; else if (landscapeComplexity === 'COMPLEX') score += 2;
    if (bedArea > 0 && lotSqFt > 0) {
      const bedRatio = bedArea / lotSqFt;
      if (bedRatio >= 0.20) score += 3;
      else if (bedRatio >= 0.10) score += 1;
    }
    const turfFactors = [0.78, 0.73, 0.68, 0.63, 0.58, 0.53, 0.48, 0.43, 0.38, 0.33];
    return {
      turfSf: Math.round(openArea * turfFactors[Math.min(score, 9)]),
      openArea,
    };
  }

  function computeTurfArea() {
    if (hasNonNegativeNumber(_measuredTurfSf)) {
      const measured = Number(_measuredTurfSf);
      return { turfSf: measured, turfEstimated: false, turfConfidence: 'HIGH', turfBasis: 'measuredTurfSf', turfFlags: [] };
    }
    const estimated = toPositiveNumber(_estimatedTurfSf);
    if (estimated > 0) {
      return { turfSf: estimated, turfEstimated: true, turfConfidence: 'MEDIUM', turfBasis: 'estimatedTurfSf', turfFlags: [] };
    }
    const hasLotBasedTurfFields =
      hasNonNegativeNumber(_imperviousSurfacePercent) ||
      hasNonNegativeNumber(_imperviosSurfacePercent) ||
      hasNonNegativeNumber(_estimatedBedAreaPercent);
    if (!hasLotBasedTurfFields) {
      const legacy = estimateLegacyTurfArea();
      return {
        turfSf: legacy.turfSf,
        turfEstimated: true,
        turfConfidence: 'LOW',
        turfBasis: 'legacyHardscapeEstimate',
        turfOpenArea: legacy.openArea,
        turfFlags: ['FIELD_VERIFY_TURF_SQFT'],
      };
    }
    const rawImperviousPct = hasNonNegativeNumber(_imperviousSurfacePercent)
      ? _imperviousSurfacePercent
      : (hasNonNegativeNumber(_imperviosSurfacePercent) ? _imperviosSurfacePercent : 20);
    const imperviousPct = toNonNegativeNumber(rawImperviousPct, 20);
    const openArea = Math.max(0, Math.round(lotSqFt * (1 - Math.min(1, imperviousPct / 100))));
    const hasBedPercent = hasNonNegativeNumber(_estimatedBedAreaPercent);
    const hasExplicitBedArea = _bedArea !== undefined && _bedArea !== null && _bedArea !== ''
      && Number.isFinite(Number(_bedArea)) && Number(_bedArea) >= 0;
    const turfBedArea = hasBedPercent
      ? Math.round(openArea * (Number(_estimatedBedAreaPercent) / 100))
      : (hasExplicitBedArea ? Number(_bedArea) : Math.round(openArea * 0.15));
    return {
      turfSf: Math.max(0, Math.round(openArea - turfBedArea)),
      turfEstimated: true,
      turfConfidence: 'LOW',
      turfBasis: 'lotFallback',
      turfOpenArea: openArea,
      turfFlags: ['FIELD_VERIFY_TURF_SQFT'],
    };
  }

  const turfArea = computeTurfArea();
  const hasTurfPricedService = svcLawn || svcOnetimeLawn || svcTopdress || svcDethatch || svcPlugging;
  if (hasTurfPricedService) {
    turfArea.turfFlags.forEach(flag => {
      if (!fieldVerify.includes(flag)) fieldVerify.push(flag);
    });
  }

  /* ── pricing modifiers tracking ─────────────────────────── */
  const modifiers = [];
  const addMod = (service, label, impact, type = 'info') => modifiers.push({ service, label, impact, type });
  const pestFootprintBrackets = [
    { at: 800, adj: -15 }, { at: 1200, adj: -10 }, { at: 1500, adj: -5 },
    { at: 1750, adj: -5 }, { at: 2000, adj: 0 }, { at: 2500, adj: 3 },
    { at: 3000, adj: 6 }, { at: 4000, adj: 10 }, { at: 5500, adj: 16 },
  ];
  const pestInterp = (v, b) => {
    if (v <= b[0].at) return b[0].adj;
    if (v >= b[b.length - 1].at) return b[b.length - 1].adj;
    for (let i = 1; i < b.length; i++) {
      if (v <= b[i].at) {
        const lo = b[i - 1];
        const hi = b[i];
        const ratio = (v - lo.at) / (hi.at - lo.at);
        return Math.round(lo.adj + ratio * (hi.adj - lo.adj));
      }
    }
    return 0;
  };
  const cageSize = ['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED'].includes(String(poolCageSize || '').toUpperCase())
    ? String(poolCageSize).toUpperCase()
    : 'MEDIUM';
  const cageAdjBySize = { SMALL: 5, MEDIUM: 8, LARGE: 12, OVERSIZED: 18 };
  // Deprecated client mirror of server/services/pricing-engine/constants.PEST.
  // Keep these literals synced until this file is retired.
  const pestFrequencyTiers = [
    { f: 4, label: 'Quarterly', disc: 1.00, rec: pestFreq === 4 },
    { f: 6, label: 'Bi-Monthly', disc: 0.85, rec: pestFreq === 6 },
    { f: 12, label: 'Monthly', disc: 0.70, rec: pestFreq === 12 },
  ];

  // Track ALL property-level modifiers with dollar amounts
  addMod('property', `Home: ${homeSqFt.toLocaleString()} sq ft · ${stories} story`, 0, 'info');
  addMod('property', `Footprint: ${footprint.toLocaleString()} sq ft`, 0, 'info');
  addMod('property', `Lot: ${lotSqFt.toLocaleString()} sq ft`, 0, 'info');

  // Footprint impact — based on actual chemical cost + labor data
  const fpAdj = pestInterp(footprint, pestFootprintBrackets);
  addMod('pest', `Footprint: ${footprint.toLocaleString()} sq ft → ${fpAdj >= 0 ? '+' : ''}$${fpAdj}/visit`, fpAdj, fpAdj > 0 ? 'up' : fpAdj < 0 ? 'down' : 'info');


  // Pool
  if (hasPoolCage) addMod('pest', `Pool cage (${cageSize.toLowerCase()}): +$${cageAdjBySize[cageSize]}/visit`, cageAdjBySize[cageSize], 'up');
  else if (hasPool) addMod('pest', 'Pool (no cage): $0/visit', 0, 'info');
  else addMod('pest', 'No pool: $0/visit', 0, 'info');

  // Shrubs
  if (shrubDensity === 'HEAVY') addMod('pest', 'Heavy shrubs: +$6/visit', 6, 'up');
  else if (shrubDensity === 'MODERATE') addMod('pest', 'Moderate shrubs: $0/visit', 0, 'info');
  else if (shrubDensity === 'LIGHT') addMod('pest', 'Light shrubs: -$5/visit', -5, 'down');
  else addMod('pest', 'Shrubs: not specified', 0, 'info');

  // Trees
  if (treeDensity === 'HEAVY') addMod('pest', 'Heavy trees: +$6/visit', 6, 'up');
  else if (treeDensity === 'MODERATE') addMod('pest', 'Moderate trees: $0/visit', 0, 'info');
  else if (treeDensity === 'LIGHT') addMod('pest', 'Light trees: -$5/visit', -5, 'down');
  else addMod('pest', 'Trees: not specified', 0, 'info');

  // Complexity
  if (landscapeComplexity === 'COMPLEX') addMod('pest', 'Complex landscape: +$3/visit', 3, 'up');
  else if (landscapeComplexity === 'MODERATE') addMod('pest', 'Moderate landscape: $0/visit', 0, 'info');
  else if (landscapeComplexity === 'SIMPLE') addMod('pest', 'Simple landscape: -$5/visit', -5, 'down');
  else addMod('pest', `${landscapeComplexity || 'Simple'} landscape: $0/visit`, 0, 'info');

  // Water proximity
  const waterAdj = (nearWater && nearWater !== 'NONE' && nearWater !== 'NO' && nearWater !== false) ? 3 : 0;
  if (waterAdj > 0) addMod('pest', `Near water: +$3/visit`, waterAdj, 'up');
  else addMod('pest', 'No water nearby: $0/visit', 0, 'info');

  // Driveway
  if (hasLargeDriveway) addMod('pest', 'Large driveway: +$3/visit', 3, 'up');
  else addMod('pest', 'Standard driveway: $0/visit', 0, 'info');

  // Indoor treatment
  if (indoor) addMod('pest', 'Indoor treatment: +$15/visit', 15, 'up');
  else addMod('pest', 'Exterior only: $0/visit', 0, 'info');

  // Urgency
  if (urgency === 'SOON') addMod('one-time', `Urgency (Soon): +25%`, 25, 'up');
  else if (urgency === 'URGENT') addMod('one-time', `Urgency (Emergency): +50%`, 50, 'up');
  else addMod('one-time', 'Routine service: standard pricing', 0, 'info');

  // Property type adjustment
  const ptLower = (propertyType || '').toLowerCase();
  let propTypeAdj = 0;
  let propTypeLabel = 'Single Family';
  if (ptLower.includes('townhome') || ptLower.includes('town home') || ptLower.includes('townhouse')) {
    if (ptLower.includes('interior') || ptLower.includes('inner')) { propTypeAdj = -12; propTypeLabel = 'Townhome (interior)'; }
    else { propTypeAdj = -8; propTypeLabel = 'Townhome (end unit)'; }
  } else if (ptLower.includes('duplex')) { propTypeAdj = -10; propTypeLabel = 'Duplex'; }
  else if (ptLower.includes('condo')) {
    if (ptLower.includes('upper') || ptLower.includes('2nd') || ptLower.includes('3rd') || stories > 1) { propTypeAdj = -22; propTypeLabel = 'Condo (upper floor)'; }
    else { propTypeAdj = -18; propTypeLabel = 'Condo (ground floor)'; }
  }
  addMod('pest', `${propTypeLabel}: ${propTypeAdj >= 0 ? '+' : ''}$${propTypeAdj}/visit`, propTypeAdj, propTypeAdj < 0 ? 'down' : 'info');

  const pestBaseAdjustment = (fpEff) => {
    let adj = pestInterp(fpEff, pestFootprintBrackets);
    if (shrubDensity === 'LIGHT') adj -= 5;
    else if (shrubDensity === 'HEAVY') adj += 6;
    if (hasPoolCage) adj += cageAdjBySize[cageSize];
    if (treeDensity === 'LIGHT') adj -= 5;
    else if (treeDensity === 'HEAVY') adj += 6;
    if (landscapeComplexity === 'COMPLEX') adj += 3;
    else if (landscapeComplexity === 'SIMPLE') adj -= 5;
    if (nearWater && nearWater !== 'NONE' && nearWater !== 'NO' && nearWater !== false) adj += 3;
    if (hasLargeDriveway) adj += 3;
    if (indoor) adj += 15;
    return adj + propTypeAdj;
  };
  const initialRoachPrice = (type, fpEff, standalone = false) => {
    const t = String(type || '').toUpperCase();
    if (t === 'REGULAR') {
      if (standalone) {
        if (fpEff < 1500) return 202.50;
        if (fpEff < 2501) return 239;
        return 289;
      }
      if (fpEff < 1500) return 119;
      if (fpEff < 2501) return 139;
      return 169;
    }
    if (t === 'GERMAN') {
      if (fpEff < 1500) return 169;
      if (fpEff < 2501) return 199;
      return 249;
    }
    return 0;
  };

  // Recurring customer
  if (isRC) addMod('one-time', 'Recurring customer: -15% one-time services', null, 'down');

  // Roach modifier — first-visit knockdown fee; recurring per-visit stays clean.
  if (svcPest && roachMod === 'GERMAN') addMod('one-time', 'Initial German roach knockdown: one-time fee', null, 'up');
  else if (svcPest && roachMod === 'REGULAR') addMod('one-time', 'Initial native roach knockdown: one-time fee', null, 'up');

  /* ═══════════ RECURRING ═══════════ */
  let hasRec = false;

  /* ── LAWN ────────────────────────────────────────────────── */
  if (svcLawn && !isCommercial && lotSqFt > 0) {
    hasRec = true;

    const hardscape = estimateHardscape();
    const oa = Math.max(0, Math.round(lotSqFt - footprint - hardscape));

    // ── Complexity score ──
    let sc = 0;
    if (hasPool) sc += 2;
    if (hasPoolCage) sc += 2;
    if (hasLargeDriveway) sc += 2;
    if (shrubDensity === 'MODERATE') sc += 1; else if (shrubDensity === 'HEAVY') sc += 2;
    if (treeDensity === 'MODERATE') sc += 1; else if (treeDensity === 'HEAVY') sc += 2;
    if (landscapeComplexity === 'MODERATE') sc += 1; else if (landscapeComplexity === 'COMPLEX') sc += 2;
    // Bed coverage estimate from bed area ratio
    if (bedArea > 0 && lotSqFt > 0) {
      const bedRatio = bedArea / lotSqFt;
      if (bedRatio >= 0.20) sc += 3;
      else if (bedRatio >= 0.10) sc += 1;
    }

    // ── Smoothed turf factor (~5% per point) ──
    const tfTable = [0.78, 0.73, 0.68, 0.63, 0.58, 0.53, 0.48, 0.43, 0.38, 0.33];
    const tf = tfTable[Math.min(sc, 9)];
    const lp = LAWN_PRICES[grassType] || LAWN_PRICES.st_augustine;
    const lsf = turfArea.turfSf;
    const selectedFreq = resolveLawnFreq(lawnFreq);

    const freqs = [
      { name: '4x applications/yr', v: 4 },
      { name: '6x applications/yr', v: 6 },
      { name: '9x applications/yr', v: 9 },
      { name: '12x applications/yr', v: 12 },
    ];
    // Same complexity-minutes the server applies to the lawn cost floor, so the
    // preview matches the server-authoritative price (Decision #2).
    const lawnComplexityMin = lawnComplexityMinutes({ landscapeComplexity, shrubDensity, hasLargeDriveway });
    R.lawn = [];
    freqs.forEach((f) => {
      const freqIdx = LAWN_FREQS.indexOf(f.v);
      const marketPrice = lawnLookup(lp, lsf, freqIdx);
      const floorPrice = calcLawnFloorPrice(lsf, grassType, f.v, { complexityMinutes: lawnComplexityMin });
      const marketAnnual = marketPrice.monthly * 12;
      const floorApplied = floorPrice.costFloorAnnual > marketAnnual;
      const ann = floorApplied ? floorPrice.ann : marketAnnual;
      const mo = Math.round(ann / 12 * 100) / 100;
      const pa = Math.round(ann / f.v * 100) / 100;
      const rec = f.v === selectedFreq, dim = !rec;
      R.lawn.push({
        pa,
        v: f.v,
        ann,
        mo,
        name: f.name,
        recommended: rec,
        dimmed: dim,
        pricingBasis: floorApplied ? LAWN_PRICING_V2.pricingMode : marketPrice.pricingBasis,
        pricingSource: floorApplied ? 'COST_FLOOR' : marketPrice.pricingSource,
        marketMonthly: marketPrice.monthly,
        marketAnnual,
        costFloorAnnual: floorPrice.costFloorAnnual,
        costFloorApplied: floorApplied,
        costs: floorPrice.costs,
      });
    });
    const selectedLawn = R.lawn.find(t => t.recommended) || R.lawn.find(t => t.v === 9) || R.lawn[1];
    wgServices.push({
      name: 'Lawn Care',
      service: 'lawn_care',
      mo: selectedLawn.mo,
      perTreatment: selectedLawn.pa,
      visitsPerYear: selectedLawn.v,
      discountable: true,
      discountEligible: true,
      waveGuardDiscountEligible: true,
      waveGuardTierEligible: true,
      countsTowardWaveGuardTier: true,
      discount: {
        discountable: true,
        requestedDiscountPercent: 0,
        appliedDiscountPercent: 0,
        effectiveDiscount: 0,
      },
      pricingVersion: selectedLawn.costs?.pricingVersion || LAWN_PRICING_V2.pricingVersion,
      pricingSource: selectedLawn.pricingSource,
    });
    const customQuoteFlag = lsf > LAWN_TABLE_MAX_SQFT;
    if (customQuoteFlag) {
      addLawnCustomQuoteNote();
    }
    R.lawnMeta = {
      lsf, sc, tf, oa, grassType, grassCode: lp.code, grassName: lp.name, hardscape,
      turfEstimated: turfArea.turfEstimated,
      turfConfidence: turfArea.turfConfidence,
      turfBasis: turfArea.turfBasis,
      customQuoteFlag,
      pricingBasis: selectedLawn.pricingBasis,
      pricingSource: selectedLawn.pricingSource,
    };
  }

  /* ── PEST — multi-frequency ──────────────────────────────── */
  if (svcPest && !isCommercial) {
    hasRec = true;
    const fpEff = footprint > 0 ? footprint : 2500; // default SWFL home fallback when sqft unknown
    const adj = pestBaseAdjustment(fpEff);
    const pp = Math.max(89, 117 + adj);
    const roachAddOn = 0;
    R.pestTiers = [];
    pestFrequencyTiers.forEach(ft => {
      const perApp = Math.round((pp * ft.disc + roachAddOn) * 100) / 100;
      const ann = Math.round(perApp * ft.f * 100) / 100;
      const mo = Math.round(ann / 12 * 100) / 100;
      R.pestTiers.push({ pa: perApp, apps: ft.f, ann, mo, init: 99, rOG: roachAddOn, roachAddOn, label: ft.label, recommended: ft.rec, dimmed: !ft.rec });
      if (ft.f === pestFreq) {
        R.pest = { pa: perApp, apps: ft.f, ann, mo, init: 99, rOG: roachAddOn, roachAddOn, label: ft.label };
      }
    });
    R.pestRoachMod = roachMod;
    R.pestInitialRoachPrice = initialRoachPrice(roachMod, fpEff, false);
    wgServices.push({ name: 'Pest (' + R.pest.label + ')', service: 'pest_control', mo: R.pest.mo, perTreatment: R.pest.pa, visitsPerYear: R.pest.apps });
  }

  /* ── TREE & SHRUB ────────────────────────────────────────── */
  if (svcTs && !isCommercial && lotSqFt > 0) {
    hasRec = true;
    let eb = bedArea;
    if (eb <= 0) {
      let bp = shrubDensity === 'HEAVY' ? 0.25 : shrubDensity === 'MODERATE' ? 0.18 : 0.10;
      if (landscapeComplexity === 'COMPLEX') bp += 0.05;
      // v1.5: raised cap from 8,000 to 12,000 — 1-acre heavy-shrub properties can exceed 10k sf beds
      eb = Math.min(12000, Math.round(lotSqFt * bp));
      fieldVerify.push('bed area');
    }
    // Tree count mirrors server v4.6 semantics: an explicit count (including
    // 0) is authoritative; only a MISSING count falls back to a treeDensity
    // estimate (heavy 10 / moderate 6 / light 3 / none 0 — constants.js
    // TREE_SHRUB.treeDensityCounts).
    let et;
    if (_treeCount === '' || _treeCount === null || _treeCount === undefined) {
      et = treeDensity === 'HEAVY' ? 10 : treeDensity === 'MODERATE' ? 6 : treeDensity === 'LIGHT' ? 3 : 0;
      if (et > 0) fieldVerify.push('tree count');
    } else {
      et = treeCount;
    }
    // v1.5: access difficulty adds time for gate access, narrow side yards, split beds
    const accessMin = accessDifficulty === 'DIFFICULT' ? 15 : accessDifficulty === 'MODERATE' ? 8 : 0;
    const osm = Math.max(25, 20 + Math.round(eb / 500) + Math.round(et * 1.5) + accessMin);
    const lpv = LABOR * ((osm + 10) / 60);
    // Tiers mirror the server engine (constants.js TREE_SHRUB): 6-visit
    // Standard is the mandated default (protocol six_x); 4-visit Light
    // (protocol four_x) is the downsell for clean / low-pest-history beds.
    // 9x Enhanced and 12x Premium are retired.
    // v4.6 material model is ANNUAL and protocol-derived:
    //   (fixed $15 + $4/tree + $0.055/bed sqft) * tierFactor (Light 0.75)
    // and price targets a 45% admin-INCLUSIVE margin:
    //   annual = (materials + labor + $51 admin) / (1 - 0.45)
    // Floors are backstops only (Light $22/mo, Standard $35/mo) and Light's
    // floor must stay <= 2/3 of Standard's.
    const TS_ADMIN_ANNUAL = 51;
    const tst = [
      { n: 'Light', v: 4, f: 22, mf: 0.75 },
      { n: 'Standard', v: 6, f: 35, mf: 1 },
    ];
    R.ts = [];
    R.tsMeta = { eb, et, bedAreaIsEstimated };
    tst.forEach((t, i) => {
      const mc = Math.max(t.v * 10, (15 + 4 * et + 0.055 * eb) * t.mf);
      const lc = lpv * t.v;
      // Mirror server rounding exactly: round monthly first, annual = mo*12.
      const baseAnn = (mc + lc + TS_ADMIN_ANNUAL) / 0.55;
      const mo = Math.max(t.f, Math.round(baseAnn / 12 * 100) / 100);
      const ann = Math.round(mo * 12 * 100) / 100;
      const pa = Math.round(ann / t.v * 100) / 100;
      // Standard (index 1) is the mandated default recommendation.
      const rec = i === 1, dim = i !== 1;
      R.ts.push({ pa, v: t.v, ann, mo, name: t.n, recommended: rec, dimmed: dim });
    });
    wgServices.push({ name: 'Tree & Shrub', service: 'tree_shrub', mo: R.ts[1].mo, perTreatment: R.ts[1].pa, visitsPerYear: R.ts[1].v });
  }

  /* ── PALM INJECTION ──────────────────────────────────────── */
  if (svcInjection && !isCommercial) {
    hasRec = true;
    const integerPalmCount = (value) => {
      const n = Number(value);
      return Number.isInteger(n) && n > 0 ? n : 0;
    };
    // Service-level count is the number of palms treated for this line. Property
    // palm count is only a prefill/default; never fall back to one palm or a
    // 30% satellite estimate because that hides missing measurement data.
    const ip = integerPalmCount(_palmTreatmentCount) || integerPalmCount(_injectablePalms) || integerPalmCount(_palmCount);
    if (!ip) {
      fieldVerify.push('injectable palm count');
      return { error: 'Palm count is required for palm injection pricing.' };
    } else {
      const palmEstimated = !integerPalmCount(_palmTreatmentCount) && !integerPalmCount(_injectablePalms);
      if (palmEstimated) fieldVerify.push('injectable palm count');
      // Client fallback mirrors the server adapter's explicit combo/medium protocol.
      const palmPerApp = 75;
      const appsPerYear = 2;
      const perVisit = Math.max(ip * palmPerApp, 75);
      const inja = perVisit * appsPerYear, injMo = Math.round(inja / 12 * 100) / 100;
      R.injection = {
        palms: ip,
        ann: inja,
        mo: injMo,
        estimated: palmEstimated,
        pricePerPalm: palmPerApp,
        appsPerYear,
        palmSize: 'medium',
        perVisit,
        detail: `Nutrition + Insecticide · medium palms · $${palmPerApp}/palm · ${appsPerYear}/yr${perVisit > ip * palmPerApp ? ` · $${perVisit} visit minimum applied` : ''}`,
      };
    }
    // Palm injection is excluded from WaveGuard percent discounts and does not
    // count toward tier qualification — billed separately like rodent bait.
  }

  /* ── MOSQUITO ────────────────────────────────────────────── */
  if (svcMosquito && !isCommercial && lotSqFt > 0) {
    hasRec = true;
    const categoryOrder = ['SMALL', 'QUARTER', 'THIRD', 'HALF', 'ACRE'];
    const grossLotCategory = lotSqFt >= 43560 ? 'ACRE'
      : lotSqFt >= 21780 ? 'HALF'
        : lotSqFt >= 14520 ? 'THIRD'
          : lotSqFt >= 10890 ? 'QUARTER'
            : 'SMALL';
    const treatableSqFt = Math.max(0, Math.round(lotSqFt - footprint - estimateHardscape()));
    const treatableCategory = treatableSqFt >= 35000 ? 'ACRE'
      : treatableSqFt >= 18000 ? 'HALF'
        : treatableSqFt >= 12000 ? 'THIRD'
          : treatableSqFt >= 8000 ? 'QUARTER'
            : 'SMALL';
    const sz = categoryOrder[Math.max(
      categoryOrder.indexOf(treatableCategory),
      categoryOrder.indexOf(grossLotCategory) - 1
    )];
    let pr = 1.0;
    if (treeDensity === 'HEAVY') pr += 0.15;
    else if (treeDensity === 'MODERATE') pr += 0.05;
    if (landscapeComplexity === 'COMPLEX') pr += 0.10;
    else if (landscapeComplexity === 'MODERATE') pr += 0.05;
    if (hasPool) pr += 0.05;
    if (nearWater) pr += 0.10;
    // v1.5: irrigation creates standing water in valve boxes, low spots, overflow areas
    if (hasIrrigation) pr += 0.08;
    if (sz === 'ACRE') pr += 0.15;
    else if (sz === 'HALF') pr += 0.05;
    pr = Math.min(2.0, Math.round(pr * 100) / 100);
    const bp = {
      SMALL: [105, 90],
      QUARTER: [115, 100],
      THIRD: [130, 115],
      HALF: [155, 135],
      ACRE: [195, 175],
    };
    const b = bp[sz] || bp.SMALL;
    const ri = (pr >= 1.30 || nearWater || treeDensity === 'HEAVY') ? 1 : 0;
    const mt = [
      { n: 'Seasonal Mosquito Program (9 visits)', pv: Math.round(b[0] * pr), v: 9, tier: 'seasonal9' },
      { n: 'Monthly Mosquito Program (12 visits)', pv: Math.round(b[1] * pr), v: 12, tier: 'monthly12' },
    ];
    R.mq = [];
    R.mqMeta = { pr, sz, ri, treatableSqFt, grossLotCategory };
    mt.forEach((t, i) => {
      const ann = t.pv * t.v;
      const mo = Math.round(ann / 12 * 100) / 100;
      const rec = i === ri, dim = i !== ri;
      R.mq.push({ pv: t.pv, v: t.v, ann, mo, n: t.n, recommended: rec, dimmed: dim });
    });
    wgServices.push({ name: 'Mosquito (' + R.mq[ri].n + ')', service: 'mosquito', mo: R.mq[ri].mo, perTreatment: R.mq[ri].pv, visitsPerYear: R.mq[ri].v });
  }

  /* ── TERMITE BAIT ────────────────────────────────────────── */
  if (svcTermiteBait && !isCommercial) {
    const fpEff = termiteFootprintSqFt || footprint;
    const layout = termiteBaitComplexity || (landscapeComplexity === 'MODERATE' ? 'moderate' : landscapeComplexity === 'COMPLEX' ? 'complex' : 'standard');
    const pm = (layout === 'moderate' || layout === 'complex') ? 1.35 : 1.25;
    const perim = termitePerimeterLF || (fpEff > 0 ? Math.round(4 * Math.sqrt(fpEff) * pm) : 0);
    if (perim > 0) {
      hasRec = true;
      const sta = Math.max(8, Math.ceil(perim / 10));
      const ai = Math.round((sta * (13.16 + 5.25 + 0.75)) * 1.45);
      const ti = Math.round((sta * (22.05 + 5.25 + 0.75)) * 1.45);
      const bmo = termiteMonitoringTier === 'premier' ? 35 : 35;
      const pmo = 65;
      R.tmBait = {
        selectedSystem: termiteBaitSystem,
        system: termiteBaitSystem,
        selectedMonitoringTier: termiteMonitoringTier,
        monitoringTier: termiteMonitoringTier,
        ai,
        ti,
        bmo,
        pmo,
        perim,
        sta,
        measurements: {
          footprintSqFt: { value: fpEff || null, source: termiteFootprintSqFt ? 'manual_override' : 'property_footprint' },
          perimeterLF: { value: perim, source: termitePerimeterLF ? 'manual_override' : 'computed_from_footprint' },
        },
      };
      wgServices.push({
        name: termiteMonitoringTier === 'premier' ? 'Termite Bait (Premier)' : 'Termite Bait (Basic)',
        service: 'termite_bait',
        mo: termiteMonitoringTier === 'premier' ? 65 : 35,
        perTreatment: null,
        visitsPerYear: null,
      });
    } else {
      R.tmBait = {
        quoteRequired: true,
        requiresMeasurement: true,
        manualReviewReasons: ['missing_termite_footprint'],
      };
    }
  }

  /* ── RODENT BAIT ─────────────────────────────────────────── */
  if (svcRodentBait && !isCommercial) {
    hasRec = true;
    // v1.5: matrix classification — both footprint AND lot matter for rodent pressure
    // A 2,600sf home on a 40,000sf lot has very different pressure than 2,600sf on 10,000sf
    const fpEff = footprint > 0 ? footprint : 2500;
    let rodentScore = 0;
    if (fpEff >= 2500) rodentScore += 2; else if (fpEff >= 1800) rodentScore += 1;
    if (lotSqFt >= 20000) rodentScore += 2; else if (lotSqFt >= 12000) rodentScore += 1;
    if (nearWater) rodentScore += 1;
    if (treeDensity === 'HEAVY') rodentScore += 1;
    const rmo = rodentScore >= 3 ? 69 : rodentScore <= 1 ? 49 : 59;
    R.rodBaitMo = rmo;
    R.rodBaitSize = rodentScore >= 3 ? 'Large' : rodentScore <= 1 ? 'Small' : 'Medium';
    R.rodBaitScore = rodentScore;
  }

  /* ═══════════ ONE-TIME ═══════════ */
  let hasOT = false, otItems = [];

  /* ── One-Time Pest ───────────────────────────────────────── */
  if (svcOnetimePest && !isCommercial) {
    hasOT = true;
    const fpEff = footprint > 0 ? footprint : 2500;
    // Mirror the server engine (server/services/pricing-engine): one-time =
    // quarterly base × 2.2, never below $199. The quarterly base already encodes
    // every property metric, so one-time scales proportionally. Anchor on the
    // QUARTERLY base (frequency-independent), never R.pest.pa (discounted per-app).
    // The trailing clamp keeps the loyalty perk from dropping one-time to/below a
    // recurring customer's visit-1 cost (quarterly + $99 setup) — strictly above
    // (+1, whole-dollar prices), matching the server engine.
    const quarterlyBase = Math.max(89, 117 + pestBaseAdjustment(fpEff));
    let fp = Math.max(199, otP(Math.max(199, Math.round(quarterlyBase * 2.2))));
    if (fp <= quarterlyBase + 99) fp = quarterlyBase + 100;
    otItems.push({
      service: 'one_time_pest',
      name: 'One-Time Pest Control',
      displayName: 'One-Time Pest Control',
      label: 'One-Time Pest Control',
      price: fp,
      detail: indoor ? 'Interior + exterior' : 'Exterior (+ interior add-on)',
    });
  }

  /* ── One-Time Lawn ───────────────────────────────────────── */
  if (svcOnetimeLawn && !isCommercial && lotSqFt > 0) {
    hasOT = true;
    const lp = LAWN_PRICES[grassType] || LAWN_PRICES.st_augustine;
    const selectedFreq = resolveLawnFreq(lawnFreq);
    const selectedFreqIdx = LAWN_FREQS.indexOf(selectedFreq);
    const baselinePrice = lawnLookup(lp, turfArea.turfSf, selectedFreqIdx >= 0 ? selectedFreqIdx : 2);
    const baselineMonthly = baselinePrice.monthly;
    if (baselinePrice.pricingBasis === 'EXTRAPOLATED_ABOVE_TABLE_MAX') addLawnCustomQuoteNote();
    const baselinePerApp = Math.round((baselineMonthly * 12) / selectedFreq * 100) / 100;
    let bl = Math.max(115, Math.round(baselinePerApp * 1.50));
    let tm = 1.0, tl = 'Fertilization';
    if (otLawnType === 'WEED') { tm = 1.12; tl = 'Weed Control'; }
    else if (otLawnType === 'PEST') { tm = 1.30; tl = 'Lawn Pest'; }
    else if (otLawnType === 'FUNGICIDE') { tm = 1.38; tl = 'Fungicide'; }
    const fp = Math.max(115, otP(Math.max(115, Math.round(bl * tm))));
    otItems.push({ name: 'OT Lawn (' + tl + ')', price: fp, detail: 'Single visit', lawnType: tl });
  }

  /* ── One-Time Mosquito ───────────────────────────────────── */
  if (svcOnetimeMosquito && !isCommercial && lotSqFt > 0) {
    hasOT = true;
    const treatableSqFt = Math.max(0, Math.round(lotSqFt - footprint - estimateHardscape()));
    // Mirrors the server-authoritative one-time mosquito band
    // (server/services/pricing-engine/constants.js ONE_TIME.mosquito, repriced
    // 2026-06 to the SW-FL single-visit market). Buckets and the over-acre
    // increment ($40 / 10k sf over an acre) must stay in sync with the server so
    // the previewed price matches what the server actually charges.
    let p = 99;
    if (treatableSqFt > 43560) p = 269 + Math.ceil((treatableSqFt - 43560) / 10000) * 40;
    else if (treatableSqFt > 32000) p = 269;
    else if (treatableSqFt > 24000) p = 239;
    else if (treatableSqFt > 16000) p = 199;
    else if (treatableSqFt > 11000) p = 159;
    else if (treatableSqFt > 7500) p = 129;
    const addOns = mosquitoStationCount * 75 + mosquitoDunkCount * 15;
    const fp = Math.round((p + addOns) * rD);
    const detailParts = [];
    if (mosquitoStationCount > 0) detailParts.push(`${mosquitoStationCount} stations`);
    if (mosquitoDunkCount > 0) detailParts.push(`${mosquitoDunkCount} Bti dunks`);
    otItems.push({ name: 'OT Mosquito', price: fp, detail: detailParts.join(' + ') || 'Rain re-spray guarantee' });
  }

  /* ── Plugging ────────────────────────────────────────────── */
  if (svcPlugging && !isCommercial && plugArea > 0) {
    hasOT = true;
    const cpp = 19.99 / 18, ir = 150;
    let ppsf, sl;
    if (plugSpacing == 6) { ppsf = 4; sl = '6" Premium'; }
    else if (plugSpacing == 9) { ppsf = 1.78; sl = '9" Standard'; }
    else { ppsf = 1; sl = '12" Economy'; }
    const tp = Math.ceil(plugArea * ppsf), tr = Math.ceil(tp / 18);
    const fp = otP(Math.max(250, Math.round((tp * cpp + (tp / ir) * LABOR) / (1 - 0.45))));
    const ps = Math.round(fp / plugArea * 100) / 100;
    otItems.push({ name: 'Plugging', price: fp, detail: plugArea.toLocaleString() + ' sf | ' + tp.toLocaleString() + ' plugs | $' + ps + '/sf', spacing: sl, plugArea, plugSpacing, warn6: plugSpacing == 6 });
  }

  /* ── Top Dressing ────────────────────────────────────────── */
  const hasTurfEstimate = turfArea.turfSf !== undefined && turfArea.turfSf !== null && turfArea.turfSf !== '';
  const lawnEst = hasTurfEstimate
    ? turfArea.turfSf
    : (R.lawn ? Math.round(lotSqFt * 0.55 * (R.lawn[2] ? 0.65 : 0.55)) : Math.round(lotSqFt * 0.35));
  const topDressingLawnEst = svcLawn ? lawnEst : Math.round(lawnEst * 0.65);
  if (svcTopdress && !isCommercial && topDressingLawnEst > 0) {
    hasOT = true;
    const lk = topDressingLawnEst / 1000;
    // Server pricing is authoritative; keep these constants synced with
    // server/services/pricing-engine/constants.js. Divisor 0.35 means cost is
    // 35% of price, a 65% target gross margin.
    const e8 = otP(Math.max(250, Math.round((lk * 1.04 * 4.09 + lk * 2.62 + LABOR * (topDressingLawnEst / 130 + 30) / 60) / 0.40)));
    const e4 = otP(Math.max(450, Math.round((lk * 2.08 * 4.09 + lk * 5.24 + LABOR * (topDressingLawnEst / 130 * 1.5 + 45) / 60) / 0.35)));
    R.td = e8;
    otItems.push({ name: 'Top Dressing', price: e8, detail: 'St. Augustine standard', depth: '1/8"' });
    R.tdTiers = [
      { name: '1/8" Depth', price: e8, detail: 'St. Augustine standard' },
      { name: '1/4" Depth', price: e4, detail: 'Bermuda / leveling — 2x material' },
    ];
  }

  /* ── Dethatching ─────────────────────────────────────────── */
  if (svcDethatch && !isCommercial && lawnEst > 0) {
    hasOT = true;
    const dth = priceDethatchingClient(lawnEst, {
      cleanupLevel: dethatchingCleanupLevel || 'none',
      debrisRemovalIncluded: dethatchingDebrisRemovalIncluded,
      access: dethatchingAccess || dethatchingAccessDifficulty || 'easy',
      grassType: _grassType || grassType,
      track: grassType,
      managerApproved: dethatchingManagerApproved,
      managerApprovalReason: dethatchingManagerApprovalReason,
      thatchProbe1Inches,
      thatchProbe2Inches,
      thatchProbe3Inches,
      thatchDepthInches,
      thatchMeasurementSource,
      manuallyEnteredLawnSqFt: _measuredTurfSf || null,
    });
    const sp = dth.quoteRequired ? null : otP(dth.price);
    R.dth = sp;
    R.dthMeta = { ...dth, price: sp, baseEstimatePrice: dth.estimatedPrice ?? dth.price };
    (dth.manualReviewReasons || []).forEach(addManualReviewReason);
    (dth.warnings || []).forEach(addRoutingWarning);
    otItems.push({
      ...dth,
      name: 'Dethatching',
      price: sp,
      baseEstimatePrice: dth.estimatedPrice ?? dth.price,
      detail: dth.detail || 'One-time service',
    });
  }

  /* ── Trenching ───────────────────────────────────────────── */
  if (svcTrenching && !isCommercial) {
    const layout = (landscapeComplexity === 'MODERATE' || landscapeComplexity === 'COMPLEX') ? 1.35 : 1.25;
    const estimatedPerim = footprint > 0 ? Math.round(4 * Math.sqrt(footprint) * layout) : 0;
    const perim = trenchingPerimeterLF || (trenchingEstimateFromFootprint ? estimatedPerim : 0);
    if (perim > 0) {
      hasOT = true;
      let cl;
      let dl;
      let cp;
      if (hasTrenchingConcreteLF) {
        cl = Math.min(Math.round(trenchingConcreteLF), Math.round(perim));
        dl = hasTrenchingDirtLF && Math.abs((trenchingDirtLF + trenchingConcreteLF) - perim) <= Math.max(5, perim * 0.02)
          ? Math.round(trenchingDirtLF)
          : Math.max(0, Math.round(perim - cl));
        cp = cl / perim;
      } else {
        cp = hasTrenchingConcretePct ? trenchingConcretePct : 0.25;
        if (!hasTrenchingConcretePct) {
          if (hasPoolCage) cp = 0.35;
          else if (hasPool) cp = 0.30;
          if (hasLargeDriveway) cp += 0.05;
        }
        cp = Math.min(0.60, cp);
        cl = Math.round(perim * cp);
        dl = Math.round(perim - cl);
      }
      const productKey = normalizeTrenchingProductKey(trenchingProductKey);
      const product = TRENCHING_TERMITICIDE_PRODUCTS[productKey];
      const applicationRate = normalizeTrenchingRate(trenchingApplicationRate);
      const depth = toPositiveNumber(trenchingDepthFt) || 1;
      const concretePad = 0.20;
      const dirtFinishedGallons = dl * 0.4 * depth;
      const concreteFinishedGallons = cl * 0.4 * depth * (1 + concretePad);
      const finishedGallons = dirtFinishedGallons + concreteFinishedGallons;
      const productOzPerFinishedGallon = applicationRate === 'high' ? product.highOzPerGal : product.standardOzPerGal;
      const productOz = finishedGallons * productOzPerFinishedGallon;
      const allocatedChemicalCost = productOz * (product.containerCost / product.containerOz);
      const included = TRENCHING_TERMITICIDE_PRODUCTS.taurus_sc;
      const includedChemicalCost = finishedGallons * included.standardOzPerGal * (included.containerCost / included.containerOz);
      const chemicalPremiumCost = Math.max(0, allocatedChemicalCost - includedChemicalCost);
      const productSurcharge = Math.round(chemicalPremiumCost * 1.45);
      const baseInstallPrice = Math.max(600, dl * 10 + cl * 14);
      const warrantyTier = normalizeTrenchingWarranty(trenchingWarrantyTier, product);
      const warrantyPct = warrantyTier === 'five_year_repair_retreat' ? 0.25 : warrantyTier === 'three_year_repair_retreat' ? 0.15 : 0;
      const warrantyAdder = Math.round((baseInstallPrice + productSurcharge) * warrantyPct);
      const warrantyBlocked = product.chemistryType === 'repellent_pyrethroid' && warrantyTier === 'five_year_repair_retreat';
      const fp = warrantyBlocked ? null : otP(baseInstallPrice + productSurcharge + warrantyAdder);
      const labelConfirmed = trenchingLabelConfirmed === true || trenchingLabelConfirmed === 'true';
      if (warrantyBlocked) {
        R.trenchQuoteRequired = {
          quoteRequired: true,
          manualReviewReasons: ['five_year_warranty_not_allowed_for_repellent_default'],
          productKey,
          productLabel: product.label,
        };
      } else {
        R.trench = { price: fp, ren: 325, dl, cl, perim, cp, productKey, productLabel: product.label };
      }
      otItems.push({
        name: 'Trenching',
        price: fp,
        detail: dl + ' LF dirt + ' + cl + ' LF concrete | ' + product.shortLabel,
        productKey,
        productLabel: product.label,
        activeIngredient: product.activeIngredient,
        chemistryType: product.chemistryType,
        positioning: product.positioning,
        applicationRate,
        trenchDepthFt: depth,
        dirtFinishedGallons: Math.round(dirtFinishedGallons * 100) / 100,
        concreteFinishedGallons: Math.round(concreteFinishedGallons * 100) / 100,
        finishedGallons: Math.round(finishedGallons * 100) / 100,
        productOz: Math.round(productOz * 100) / 100,
        allocatedChemicalCost: Math.round(allocatedChemicalCost * 100) / 100,
        includedChemicalCost: Math.round(includedChemicalCost * 100) / 100,
        productSurcharge,
        baseInstallPrice,
        warrantyTier,
        warrantyAdder,
        labelConfirmed,
        warningText: product.warning,
        requiresManualReview: !labelConfirmed || applicationRate === 'high' ||
          (product.chemistryType === 'repellent_pyrethroid' && warrantyTier === 'three_year_repair_retreat'),
        quoteRequired: warrantyBlocked,
      });
    } else {
      R.trenchQuoteRequired = { quoteRequired: true, requiresMeasurement: true, manualReviewReasons: ['missing_termite_perimeter_lf'] };
      otItems.push({ name: 'Trenching', price: null, detail: 'Perimeter LF required', quoteRequired: true });
    }
  }

  /* ── Bora-Care ───────────────────────────────────────────── */
  if (svcBoracare && !isCommercial && bcSqft > 0) {
    hasOT = true;
    const BC_GAL = 91.98, BC_COV = 275, BC_EQUIP = 17.50;
    const gal = Math.max(3, Math.ceil(bcSqft / BC_COV));
    // v1.5: raised labor cap from 6 to 10 hrs — 4,500+ sf attics are multi-day in SWFL heat
    const isMultiDay = bcSqft > 4500;
    const lhr = isMultiDay
      ? Math.min(10, Math.max(6, 1.5 + bcSqft / 800))  // more aggressive rate for large attics
      : Math.min(6, Math.max(2, 1.5 + bcSqft / 1000));
    const cost = gal * BC_GAL + lhr * LABOR + BC_EQUIP;
    const fp = otP(Math.round(cost / 0.45));
    const detail = '~' + bcSqft.toLocaleString() + ' sf | ' + gal + ' gal | ' + lhr.toFixed(1) + ' hrs' + (isMultiDay ? ' (multi-day)' : '');
    otItems.push({ name: 'Bora-Care', price: fp, detail, atticIsEstimated, bcSqft, gal, lhr, isMultiDay });
  } else if (svcBoracare && !isCommercial) {
    otItems.push({ name: 'Bora-Care', price: null, detail: 'Attic/raw wood sqft required', quoteRequired: true });
  }

  /* ── Pre-Slab Termiticide ────────────────────────────────── */
  if (svcPreslab && !isCommercial && psSqft > 0) {
    hasOT = true;
    const productKey = normalizePreSlabProductKey(preslabProductKey);
    const product = PRE_SLAB_TERMITICIDE_PRODUCTS[productKey];
    const vol = normalizePreSlabVolume(preslabVolume);
    const jobContext = normalizePreSlabJobContext(preslabJobContext, vol.key);
    const contextualMinimum = lookupPreSlabMinimum(psSqft, jobContext);
    const productOz = psSqft / 10 * product.productOzPer10SqFt;
    const units = Math.max(1, Math.ceil(productOz / product.containerOz));
    const chemicalCostPerOz = product.containerCost / product.containerOz;
    const allocatedProductCost = productOz * chemicalCostPerOz;
    const fullContainerProductCost = units * product.containerCost;
    const lhr = Math.min(5, Math.max(1, 0.5 + psSqft / 1500));
    const laborCost = lhr * LABOR;
    const equipCost = 15;
    const complianceAdminCost = PRE_SLAB_COMPLIANCE_ADMIN_COST;
    const driveCost = PRE_SLAB_INCLUDE_DRIVE_COST_BY_CONTEXT[jobContext] ? LABOR * DRIVE / 60 : 0;
    const cost = allocatedProductCost + laborCost + equipCost + complianceAdminCost + driveCost;
    const rawPrice = Math.round(cost / product.marginDivisor);
    const priceBeforeVolumeDiscount = Math.max(rawPrice, contextualMinimum.floor);
    const priceAfterVolumeDiscount = Math.max(
      Math.round(priceBeforeVolumeDiscount * vol.multiplier),
      contextualMinimum.floor,
    );
    const warranty = normalizePreSlabWarranty(preslabWarranty);
    const warrAdd = warranty.tier === 'EXTENDED' ? 200 : 0;
    const basePreSlabPrice = priceAfterVolumeDiscount;
    const fp = basePreSlabPrice + warrAdd;
    const labelConfirmed = preslabLabelConfirmed === true || preslabLabelConfirmed === 'true';
    const warrantyStatus = warranty.tier === 'EXTENDED'
      ? 'Extended 5-year warranty'
      : warranty.label;
    const detail = [
      psSqft.toLocaleString() + ' sf',
      product.shortLabel,
      Math.round(productOz * 100) / 100 + ' oz',
      units + (units === 1 ? ' unit' : ' units'),
      warrantyStatus,
      vol.key !== 'none' ? 'vol disc' : null,
    ].filter(Boolean).join(' | ');
    otItems.push({
      name: 'Pre-Slab',
      displayName: 'Pre-Slab Termiticide Treatment',
      price: fp,
      detail,
      psSqft,
      productKey,
      productLabel: product.label,
      activeIngredient: product.activeIngredient,
      chemistryType: product.chemistryType,
      positioning: product.positioning,
      productOz: Math.round(productOz * 100) / 100,
      units,
      btl: units,
      containersRequired: units,
      containerOz: product.containerOz,
      containerCost: product.containerCost,
      chemicalCostPerOz: Math.round(chemicalCostPerOz * 10000) / 10000,
      allocatedProductCost: Math.round(allocatedProductCost * 100) / 100,
      productCost: Math.round(allocatedProductCost * 100) / 100,
      fullContainerProductCost: Math.round(fullContainerProductCost * 100) / 100,
      laborHrs: Math.round(lhr * 100) / 100,
      laborCost: Math.round(laborCost * 100) / 100,
      equipCost,
      complianceAdminCost,
      driveCost: Math.round(driveCost * 100) / 100,
      includeDriveCost: PRE_SLAB_INCLUDE_DRIVE_COST_BY_CONTEXT[jobContext] === true,
      cost: Math.round(cost * 100) / 100,
      rawPrice,
      jobContext,
      preSlabJobContext: jobContext,
      preSlabJobContextLabel: PRE_SLAB_JOB_CONTEXT_LABELS[jobContext] || PRE_SLAB_JOB_CONTEXT_LABELS.standalone,
      contextualFloor: contextualMinimum.floor,
      contextualMinimumBasis: contextualMinimum.basis,
      floorBeforeVolumeDiscount: contextualMinimum.floor,
      floorAfterVolumeDiscount: contextualMinimum.floor,
      priceBeforeVolumeDiscount,
      priceAfterVolumeDiscount,
      volDisc: vol.key !== 'none',
      volumeDiscount: vol.key,
      volumeDiscountMultiplier: vol.multiplier,
      basePrice: basePreSlabPrice,
      warrAdd,
      warrantyTier: warranty.tier,
      warrantyLabel: warranty.label,
      warrantyStatus,
      warrantyExtendedSelected: warranty.tier === 'EXTENDED',
      labelConfirmed,
      requiresManualReview: !labelConfirmed,
      manualReviewReasons: labelConfirmed ? [] : ['pre_slab_label_confirmation_required'],
      certificateOfComplianceRequired: true,
      warningText: product.warning,
    });
  } else if (svcPreslab && !isCommercial) {
    otItems.push({ name: 'Pre-Slab', price: null, detail: 'Slab sqft required', quoteRequired: true });
  }

  /* ── Foam Drill ──────────────────────────────────────────── */
  if (svcFoam && !isCommercial) {
    hasOT = true;
    const FM_CAN = 39.08, FM_BITS = 8;
    const { pointCount: fmPts, tier: t } = resolveFoamDrillTier(_foamPoints);
    const cost = t.c * FM_CAN + t.l * LABOR + FM_BITS;
    const fp = otP(Math.max(250, Math.round(cost / 0.45)));
    otItems.push({ name: 'Foam Drill', price: fp, detail: t.c + ' cans | ~$' + Math.round(fp / fmPts) + '/point', tierName: t.n });
  }

  /* ── Rodent Trapping ─────────────────────────────────────── */
  if (svcRodentTrap && !isCommercial) {
    hasOT = true;
    let p = 350;
    p += interpolate(footprint, [
      { at: 800, adj: -25 }, { at: 1500, adj: -10 }, { at: 2000, adj: 0 },
      { at: 2500, adj: 20 }, { at: 3000, adj: 40 }, { at: 4000, adj: 65 },
    ]);
    p += interpolate(lotSqFt, [
      { at: 5000, adj: 0 }, { at: 10000, adj: 10 },
      { at: 15000, adj: 20 }, { at: 25000, adj: 35 },
    ]);
    const fp = otP(Math.max(350, p));
    otItems.push({ name: 'Trapping', price: fp, detail: 'Setup + check visits' });
  }

  /* ── Initial Roach Knockdown (from pest roach modifier) ─── */
  if (R.pest && (roachMod === 'GERMAN' || roachMod === 'REGULAR')) {
    hasOT = true;
    const fpEff = footprint > 0 ? footprint : 2500;
    const fp = initialRoachPrice(roachMod, fpEff, false);
    otItems.push({
      service: 'pest_initial_roach',
      name: roachMod === 'GERMAN' ? 'Initial German Roach Knockdown' : 'Initial Native Roach Knockdown',
      price: fp,
      detail: roachMod === 'GERMAN' ? 'First-visit gel bait + IGR' : 'First-visit knockdown',
      requestedRoachType: roachMod,
      roachType: roachMod === 'GERMAN' ? 'german' : 'regular',
      standalone: false,
      autoFiredFromRecurringPest: true,
      source: 'recurring_pest_roach_activity',
      noRecurringDiscount: true,
    });
  }

  /* ═══════════ SPECIALTY ═══════════ */
  let specItems = [...commercialManualSpecItems];

  /* ── Flea ────────────────────────────────────────────────── */
  if (svcFlea && !isCommercial) {
    let fi = 225, ff = 125;
    fi += interpolate(footprint, [
      { at: 800, adj: -25 }, { at: 1200, adj: -15 }, { at: 1500, adj: -5 },
      { at: 2000, adj: 0 }, { at: 2500, adj: 15 }, { at: 3000, adj: 25 },
      { at: 4000, adj: 40 },
    ]);
    ff += interpolate(footprint, [
      { at: 800, adj: -15 }, { at: 1200, adj: -10 }, { at: 1500, adj: -3 },
      { at: 2000, adj: 0 }, { at: 2500, adj: 8 }, { at: 3000, adj: 15 },
      { at: 4000, adj: 25 },
    ]);
    fi += interpolate(lotSqFt, [
      { at: 3000, adj: -15 }, { at: 5000, adj: -5 }, { at: 7500, adj: 0 },
      { at: 10000, adj: 10 }, { at: 15000, adj: 20 }, { at: 25000, adj: 35 },
    ]);
    ff += interpolate(lotSqFt, [
      { at: 3000, adj: -8 }, { at: 5000, adj: -3 }, { at: 7500, adj: 0 },
      { at: 10000, adj: 5 }, { at: 15000, adj: 12 }, { at: 25000, adj: 20 },
    ]);
    if (treeDensity === 'HEAVY') { fi += 20; ff += 10; }
    else if (treeDensity === 'MODERATE') { fi += 10; ff += 5; }
    if (landscapeComplexity === 'COMPLEX') { fi += 15; ff += 10; }
    else if (landscapeComplexity === 'MODERATE') { fi += 5; ff += 5; }
    fi = Math.max(185, fi);
    ff = Math.max(95, ff);
    specItems.push({ name: 'Flea (2-visit)', price: otP(fi + ff), det: '$' + fi + ' + $' + ff });
  }

  /* ── Wasp ────────────────────────────────────────────────── */
  if (svcWasp && !isCommercial) {
    let wp = 150;
    wp += interpolate(treeNum, [{ at: 0, adj: 0 }, { at: 1, adj: 10 }, { at: 2, adj: 25 }]);
    if (landscapeComplexity === 'COMPLEX') wp += 15;
    else if (landscapeComplexity === 'MODERATE') wp += 5;
    wp += interpolate(lotSqFt, [
      { at: 5000, adj: 0 }, { at: 10000, adj: 5 },
      { at: 15000, adj: 15 }, { at: 25000, adj: 25 },
    ]);
    wp = Math.max(150, wp);
    if (R.pest) {
      specItems.push({ name: 'Wasp/Bee', price: 0, det: 'Included on ' + R.pest.label + ' program', onProg: true });
    } else {
      specItems.push({ name: 'Wasp/Bee', price: otP(wp), det: 'Standalone removal' });
    }
  }

  /* ── Roach (standalone specialty) ────────────────────────── */
  if (svcRoach && !isCommercial) {
    const rt = roachType;
    if (rt === 'REGULAR') {
      if (R.pestRoachMod !== 'REGULAR') {
        const fpEff = footprint > 0 ? footprint : 2500;
        specItems.push({
          service: 'pest_initial_roach',
          name: 'Standalone Native Cockroach Treatment',
          price: initialRoachPrice(rt, fpEff, true),
          det: 'Standalone knockdown',
          source: 'standalone_native_cockroach_treatment',
          standalone: true,
          roachType: 'regular',
          noRecurringDiscount: true,
        });
      } else {
        addSkippedService({
          skippedDuplicateRoachLine: true,
          skippedService: 'standalone_native_cockroach_treatment',
          skippedReason: 'recurring_pest_initial_roach_already_covers_regular_roach',
        });
      }
    } else {
      // Severity-based, all-in flat pricing — footprint no longer factors in and
      // there is no separate setup charge. Mirrors server priceGermanRoach.
      const GERMAN_ROACH_TIERS = {
        light: { price: 350, visits: 2 },
        moderate: { price: 450, visits: 3 },
        heavy: { price: 550, visits: 4 },
      };
      const sevAlias = {
        light: 'light', low: 'light',
        moderate: 'moderate', medium: 'moderate',
        heavy: 'heavy', high: 'heavy', severe: 'heavy',
      };
      const rawSev = String(roachSeverity || '').trim().toLowerCase();
      const tierKey = GERMAN_ROACH_TIERS[sevAlias[rawSev]] ? sevAlias[rawSev] : 'light';
      const tier = GERMAN_ROACH_TIERS[tierKey];
      const price = tier.price;
      const visits = tier.visits;
      const warning = 'German initial knockdown and German Roach Cleanout are both selected. Verify this is intentional.';
      if (R.pestRoachMod === 'GERMAN') {
        addManualReviewReason('german_roach_initial_and_cleanout_both_selected');
        addRoutingWarning(warning);
      }
      specItems.push({
        service: 'german_roach',
        name: `German Roach Cleanout — ${visits} Visit Program`,
        price,
        det: 'Gel+IGR+monitoring',
        source: 'german_roach_cleanout_selected',
        pricingModel: 'german_roach_severity_tier_cleanout',
        severity: tierKey,
        visits,
        setupCharge: 0,
        total: price,
        noRecurringDiscount: true,
        requiresManualReview: R.pestRoachMod === 'GERMAN',
        manualReviewReasons: R.pestRoachMod === 'GERMAN'
          ? ['german_roach_initial_and_cleanout_both_selected']
          : [],
        warnings: R.pestRoachMod === 'GERMAN' ? [warning] : [],
      });
    }
  }

  /* ── Bed Bug ─────────────────────────────────────────────── */
  if (svcBedbug && !isCommercial) {
    // Deprecated v1 fallback only. Source of truth is server/services/pricing-engine/
    // priceBedBugTreatment. TODO(2026-05-16, pricing-owner): remove after all
    // estimate surfaces use POST /admin/pricing-config/estimate for bed bugs.
    const rm = bedbugRooms;
    const meth = String(bedbugMethod || '').trim().toUpperCase();
    if (!['CHEMICAL', 'HEAT', 'HYBRID'].includes(meth)) {
      throw new Error('Invalid bedbugMethod. Use CHEMICAL, HEAT, or HYBRID.');
    }
    if (meth === 'HYBRID') {
      throw new Error('HYBRID bed bug pricing is server-only in the deprecated v1 estimator.');
    }
    const sev = bedbugSeverity || 'light';
    const prep = bedbugPrepStatus || 'ready';
    const occ = bedbugOccupancyType || 'singleFamily';
    if (sev !== 'light' || prep !== 'ready' || occ !== 'singleFamily') {
      throw new Error('Deprecated v1 bed bug pricing only supports light/ready/singleFamily; use server pricing endpoint.');
    }
    if (meth === 'HEAT' && String(bedbugHeatScope || 'ROOMS_ONLY').trim().toUpperCase() !== 'ROOMS_ONLY') {
      throw new Error('Whole-home bed bug heat pricing is server-only in the deprecated v1 estimator.');
    }
    if (meth === 'HEAT' && bedbugEquipment === 'SUBCONTRACT') {
      throw new Error('Subcontract bed bug heat pricing is server-only in the deprecated v1 estimator.');
    }
    if (bedbugSubcontractCost !== undefined && bedbugSubcontractCost !== null && bedbugSubcontractCost !== '') {
      throw new Error('Subcontract bed bug inputs are server-only in the deprecated v1 estimator.');
    }
    const bedBugP = (b) => Math.round(b * urgMult);
    if (meth === 'CHEMICAL') {
      const lv1 = 45 + Math.max(0, (rm - 1) * 30) + 30 + DRIVE;
      const lv2 = 25 + Math.max(0, (rm - 1) * 20) + DRIVE;
      const mpr = 50.42;
      let cp = Math.round((mpr * rm + LABOR * (lv1 / 60) + mpr * rm * 0.5 + LABOR * (lv2 / 60)) / 0.35 * 100) / 100;
      const fl = 400 + (rm - 1) * 250;
      if (cp < fl) cp = fl;
      if (footprint > 2500) cp = Math.round(cp * 1.10);
      else if (footprint > 1800) cp = Math.round(cp * 1.05);
      specItems.push({ name: 'Bed Bug Chemical', price: bedBugP(cp), det: rm + ' room' + (rm > 1 ? 's' : '') + ', 2 visits' });
    }
    if (meth === 'HEAT') {
      let hpr = rm === 1 ? 1000 : rm === 2 ? 850 : 750;
      let hp = hpr * rm;
      // v1.5: in-house heat adds equipment cost (heaters, fans, monitoring)
      // Subcontract rate already includes equipment in the per-room price
      if (bedbugEquipment === 'INHOUSE') {
        const equipCost = 150 + (rm - 1) * 75; // heater rental/depreciation + fans + monitors
        hp += equipCost;
      }
      if (footprint > 2500) hp = Math.round(hp * 1.10);
      else if (footprint < 1200) hp = Math.round(hp * 0.95);
      const fp = bedBugP(hp);
      specItems.push({ name: 'Bed Bug Heat', price: fp, det: rm + ' room' + (rm > 1 ? 's' : '') + ' — ' + fmtInt(fp / rm) + '/room' + (bedbugEquipment === 'INHOUSE' ? ' (in-house)' : '') });
    }
  }

  /* ── Exclusion ───────────────────────────────────────────── */
  if (svcExclusion && !isCommercial && (exS + exM + exA) > 0) {
    const sc = exS * 37.50 + exM * 75 + exA * 150;
    let ep = Math.max(150, Math.round(sc));
    let insp = exW ? 0 : 85;
    const tp = otP(ep) + insp;
    let tl = 'Basic';
    if (exA > 0) tl = 'Advanced (Roof)';
    else if (exM > 0) tl = 'Moderate';
    specItems.push({ name: 'Rodent Exclusion', price: tp, det: tl + ' — ' + (exS + exM + exA) + ' points' + (insp > 0 ? ' + $85 inspect' : '') + (exW ? ' (waived)' : '') });
  }

  /* ═══════════ WAVEGUARD TOTALS ═══════════ */
  let ac = 0, ra = 0;
  // Track per-line revenue for margin check
  const lineItems = [];
  const selectedRecurringLawn = R.lawn ? (R.lawn.find(t => t.recommended) || R.lawn.find(t => t.v === 9) || R.lawn[1]) : null;
  if (selectedRecurringLawn) { ac++; ra += selectedRecurringLawn.ann; lineItems.push({ name: 'Lawn Care', service: 'lawn_care', ann: selectedRecurringLawn.ann, discountable: true }); }
  if (R.pest) { ac++; ra += R.pest.ann; lineItems.push({ name: 'Pest Control', service: 'pest_control', ann: R.pest.ann, discountable: true }); }
  if (R.ts) { ac++; ra += R.ts[1].ann; lineItems.push({ name: 'Tree & Shrub', service: 'tree_shrub', ann: R.ts[1].ann, discountable: true }); }
  // Palm Injection intentionally excluded from WaveGuard tier count + discounted total —
  // not a qualifying service, not eligible for percent bundle discount.
  if (R.mq) {
    const ri = R.mqMeta?.ri ?? 1;
    if (R.mq[ri]) { ac++; ra += R.mq[ri].ann; lineItems.push({ name: 'Mosquito', service: 'mosquito', ann: R.mq[ri].ann, discountable: true }); }
  }
  if (R.tmBait && !R.tmBait.quoteRequired && !R.tmBait.requiresMeasurement) {
    const termiteMonthly = termiteMonitoringTier === 'premier' ? 65 : 35;
    ac++;
    ra += termiteMonthly * 12;
    lineItems.push({ name: 'Termite Bait', service: 'termite_bait', ann: termiteMonthly * 12, discountable: true });
  }

  // WaveGuard tier discounts — must match server
  // pricing-engine/constants.WAVEGUARD.tiers (see docs/pricing/POLICY.md).
  // Platinum was 0.18 here for ages while the server quoted 0.20, so
  // Platinum customers were activated 2pp below their quoted discount.
  // This file is deprecated (Session 11 retirement); kept in sync as a
  // hardcoded literal until then since the server constants can't be
  // imported into the browser bundle.
  let wt = 'Bronze', wd = 0;
  if (ac >= 4) { wt = 'Platinum'; wd = 0.20; }
  else if (ac === 3) { wt = 'Gold'; wd = 0.15; }
  else if (ac === 2) { wt = 'Silver'; wd = 0.10; }
  else if (ac === 1) { wt = 'Bronze'; wd = 0; }
  if (R.injection) {
    const annualBeforeCredits = R.injection.ann;
    const flatCreditAnnual = wt === 'Gold' || wt === 'Platinum'
      ? Math.min(annualBeforeCredits, R.injection.palms * 10)
      : 0;
    const annualAfterCredits = Math.round((annualBeforeCredits - flatCreditAnnual) * 100) / 100;
    const monthlyAfterCredits = Math.round(annualAfterCredits / 12 * 100) / 100;
    R.injection = {
      ...R.injection,
      ann: annualAfterCredits,
      mo: monthlyAfterCredits,
      annualBeforeCredits,
      flatCreditAnnual,
      annualAfterCredits,
      monthlyAfterCredits,
    };
  }
  const waveGuardDiscountableAnnual = lineItems
    .filter(li => li.discountable !== false)
    .reduce((sum, li) => sum + li.ann, 0);
  const da = Math.round(waveGuardDiscountableAnnual * wd * 100) / 100;
  const recurringAnnualAfterWaveGuard = Math.round((ra - da) * 100) / 100;
  const md = inputs.manualDiscount;
  let manualDiscountAmount = 0;
  let manualDiscountInfo = null;
  const manualDiscountableRecurringAnnual = waveGuardDiscountableAnnual - da;
  if (md && Number(md.value) > 0) {
    const v = Number(md.value);
    if (md.type === 'PERCENT') {
      if (v > 100) throw new Error('Manual percentage discount cannot exceed 100');
      manualDiscountAmount = Math.round(manualDiscountableRecurringAnnual * (v / 100) * 100) / 100;
    } else {
      manualDiscountAmount = Math.round(v * 100) / 100;
    }
    const requestedAmount = manualDiscountAmount;
    manualDiscountAmount = Math.min(manualDiscountAmount, manualDiscountableRecurringAnnual);
    manualDiscountInfo = {
      ...md,
      type: md.type === 'PERCENT' ? 'PERCENT' : 'FIXED',
      value: v,
      requestedAmount,
      amount: manualDiscountAmount,
      label: md.label || (md.type === 'PERCENT' ? `Discount (${v}%)` : `Discount -$${v.toFixed(2)}`),
      discountableBase: manualDiscountableRecurringAnnual,
      capped: requestedAmount > manualDiscountAmount,
      capReason: requestedAmount > manualDiscountAmount ? 'discountable_base' : null,
      scope: 'recurring_annual_after_waveguard',
      stackingOrder: 'after_waveguard',
    };
  }
  const ad = Math.round((recurringAnnualAfterWaveGuard - manualDiscountAmount) * 100) / 100;
  const mm = Math.round(ad / 12 * 100) / 100;

  // Discounts are reported as commercial terms only. They do not block or warn
  // estimates based on a hypothetical after-discount margin.
  const marginWarnings = [];

  let ot = 0;
  otItems.forEach(i => ot += i.price);
  specItems.forEach(s => { if (!s.onProg) ot += s.price; });
  let tmInstall = R.tmBait ? ((termiteBaitSystem === 'trelona' ? R.tmBait.ti : R.tmBait.ai) || 0) : 0;
  ot = Math.round(ot * 100) / 100;

  const rba = R.rodBaitMo ? R.rodBaitMo * 12 : 0;
  const palmAnn = R.injection ? R.injection.ann : 0;
  const palmMo = R.injection ? R.injection.mo : 0;
  const totalOT = ot + tmInstall;
  const y1 = Math.round((ad + rba + palmAnn + totalOT) * 100) / 100;
  const y2 = Math.round((ad + rba + palmAnn + (R.trench && !R.trench.quoteRequired && !R.trench.requiresMeasurement ? 325 : 0)) * 100) / 100;
  const y2mo = Math.round(y2 / 12 * 100) / 100;

  return {
    property: {
      type: propertyType,
      propertyType,
      isCommercial,
      commercialSubtype: inputs.commercialSubtype || null,
      commercialPricingMode: inputs.commercialPricingMode || "manual_quote",
      homeSqFt,
      lotSqFt,
      stories,
      footprint,
      turfSf: turfArea.turfSf,
      turfEstimated: turfArea.turfEstimated,
      turfConfidence: turfArea.turfConfidence,
      turfBasis: turfArea.turfBasis,
      pool: hasPool,
      poolCage: hasPoolCage,
      driveway: hasLargeDriveway,
      shrubs: shrubDensity,
      trees: treeDensity,
      complexity: landscapeComplexity,
      nearWater,
    },
    recurring: {
      services: wgServices,
      monthlyTotal: mm,
      annualBeforeDiscount: ra,
      annualAfterDiscount: ad,
      waveGuardTier: wt,
      discount: wd,
      savings: da,
      rodentBaitMo: R.rodBaitMo || 0,
      palmInjectionMo: palmMo,
      palmInjectionAnn: palmAnn,
      serviceCount: ac,
      // Tier commitment: if customer cancels services and drops below tier threshold,
      // downstream billing should reconcile to the new tier rate retroactively for that period.
      // tierServiceMin: minimum services required to maintain this tier
      tierServiceMin: wt === 'Platinum' ? 4 : wt === 'Gold' ? 3 : wt === 'Silver' ? 2 : 1,
      marginWarnings,
    },
    oneTime: {
      items: otItems,
      specItems: specItems
        .filter(s => !s.onProg && (s.quoteRequired || s.price > 0))
        .map(s => ({
          name: s.name,
          price: s.price,
          service: s.service,
          detail: s.detail || s.det,
          quoteRequired: !!s.quoteRequired,
          reason: s.reason,
          commercialPricingMode: s.commercialPricingMode,
          isCommercial: !!s.isCommercial,
          commercialSubtype: s.commercialSubtype || null,
          originalRequestedService: s.originalRequestedService || null,
          requiresManualReview: !!s.requiresManualReview,
          autoQuoteRequiresAdminApproval: !!s.autoQuoteRequiresAdminApproval,
          manualReviewReasons: s.manualReviewReasons || [],
          warnings: s.warnings || [],
          source: s.source,
          pricingModel: s.pricingModel,
          visits: s.visits,
          setupCharge: s.setupCharge,
          total: s.total,
          standalone: s.standalone,
          autoFiredFromRecurringPest: s.autoFiredFromRecurringPest,
          requestedRoachType: s.requestedRoachType,
          roachType: s.roachType,
          severity: s.severity,
          noRecurringDiscount: s.noRecurringDiscount,
          taxable: s.taxable,
          taxCategory: s.taxCategory || null,
          pricingConfidence: s.pricingConfidence || null,
        })),
      tmInstall,
      total: totalOT,
      otSubtotal: ot,
    },
    totals: { year1: y1, year2: y2, year2mo: y2mo, manualDiscount: manualDiscountInfo },
    manualDiscount: manualDiscountInfo,
    results: R,
    specItems, // full array including onProg items for display
    pricingMetadata,
    routingMetadata: pricingMetadata,
    fieldVerify,
    notes,
    urgency,
    urgLabel,
    urgMult,
    isRecurringCustomer: isRC,
    hasRecurring: hasRec || ac > 0,
    hasOneTime: hasOT,
    modifiers,
  };
}
