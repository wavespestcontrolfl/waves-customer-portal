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
 * - Palm Injection: prefers manual injectable count, flags when estimated
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

export function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '$0.00';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtInt(n) {
  if (n === undefined || n === null || isNaN(n)) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString();
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
const LAWN_PRICES = {
  st_augustine: { name: 'St. Augustine', code: 'A', pts: [[0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],[5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],[10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250]] },
  bermuda:      { name: 'Bermuda',       code: 'C1', pts: [[0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,60,86],[6000,40,50,67,97],[7000,40,51,74,108],[8000,42,56,82,120],[10000,48,65,96,142],[12000,55,74,111,165],[15000,65,88,132,199],[20000,81,111,169,256]] },
  zoysia:       { name: 'Zoysia',        code: 'C2', pts: [[0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,61,87],[6000,40,50,68,98],[7000,40,52,75,110],[8000,42,56,83,121],[10000,49,66,97,144],[12000,56,75,112,167],[15000,66,89,134,202],[20000,83,112,171,259]] },
  bahia:        { name: 'Bahia',         code: 'D', pts: [[0,30,40,50,60],[3000,30,40,50,60],[3500,30,40,50,63],[4000,30,40,50,68],[5000,30,40,55,78],[6000,32,42,61,87],[7000,35,46,67,97],[8000,37,50,73,107],[10000,43,58,86,126],[12000,48,66,98,145],[15000,57,77,117,174],[20000,71,97,148,223]] },
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
    boracareSqft: bcSqft,
    preslabSqft: psSqft,
    preslabWarranty,
    preslabVolume,
    foamPoints: _foamPoints,
    roachType,
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
    injectablePalms: _injectablePalms, // manual override for injectable palm count
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

  if (homeSqFt <= 0 && lotSqFt <= 0) {
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
    { at: 2000, adj: 0 }, { at: 2500, adj: 3 }, { at: 3000, adj: 6 },
    { at: 4000, adj: 10 }, { at: 5500, adj: 16 },
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
      { name: '4x/yr', v: 4 },
      { name: '6x/yr', v: 6 },
      { name: '9x/yr', v: 9 },
      { name: '12x/yr', v: 12 },
    ];
    R.lawn = [];
    freqs.forEach((f, i) => {
      const price = lawnLookup(lp, lsf, i);
      const mo = price.monthly;
      const ann = mo * 12;
      const pa = Math.round(ann / f.v * 100) / 100;
      const rec = f.v === selectedFreq, dim = !rec;
      R.lawn.push({ pa, v: f.v, ann, mo, name: f.name, recommended: rec, dimmed: dim, pricingBasis: price.pricingBasis, pricingSource: price.pricingSource });
    });
    const selectedLawn = R.lawn.find(t => t.recommended) || R.lawn[2];
    wgServices.push({ name: 'Lawn Care', service: 'lawn_care', mo: selectedLawn.mo, perTreatment: selectedLawn.pa, visitsPerYear: selectedLawn.v });
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
    let et = treeCount || (treeDensity === 'HEAVY' ? 12 : treeDensity === 'MODERATE' ? 5 : 2);
    // v1.5: access difficulty adds time for gate access, narrow side yards, split beds
    const accessMin = accessDifficulty === 'DIFFICULT' ? 15 : accessDifficulty === 'MODERATE' ? 8 : 0;
    const osm = Math.max(25, 20 + Math.round(eb / 500) + Math.round(et * 1.5) + accessMin);
    const lpv = LABOR * ((osm + 10) / 60);
    // v1.6: material rates updated from SiteOne pricing audit (2× higher than original)
    const mps = { 6: 0.110, 9: 0.190, 12: 0.220 };
    const tst = [
      { n: 'Standard', v: 6, f: 50 },
      { n: 'Enhanced', v: 9, f: 65 },
      { n: 'Premium', v: 12, f: 80 },
    ];
    R.ts = [];
    R.tsMeta = { eb, et, bedAreaIsEstimated };
    tst.forEach((t, i) => {
      let mc = Math.max(t.v * 10, eb * mps[t.v]);
      let lc = lpv * t.v;
      let ann = Math.round((mc + lc) / 0.43 * 100) / 100;
      let mo = Math.round(ann / 12 * 100) / 100;
      if (mo < t.f) { mo = t.f; ann = t.f * 12; }
      const pa = Math.round(ann / t.v * 100) / 100;
      const rec = i === 1, dim = i !== 1;
      R.ts.push({ pa, v: t.v, ann, mo, name: t.n, recommended: rec, dimmed: dim });
    });
    wgServices.push({ name: 'Tree & Shrub (Enhanced)', service: 'tree_shrub', mo: R.ts[1].mo, perTreatment: R.ts[1].pa, visitsPerYear: R.ts[1].v });
  }

  /* ── PALM INJECTION ──────────────────────────────────────── */
  if (svcInjection && !isCommercial) {
    hasRec = true;
    // v1.5: prefer manual injectable count — the 30% estimate is unreliable
    // (10 Washingtonia + 2 Canary Islands = 12 palms but only 2 injectable)
    let ip;
    let palmEstimated = false;
    if (Number(_injectablePalms) > 0) {
      ip = Number(_injectablePalms);
    } else {
      let ep = palmCount || (treeDensity === 'HEAVY' ? 6 : treeDensity === 'MODERATE' ? 5 : 3);
      ip = Math.max(1, Math.round(ep * 0.30));
      palmEstimated = true;
      fieldVerify.push('injectable palm count');
    }
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
    hasRec = true;
    const fpEff = footprint > 0 ? footprint : 2500;
    let pm = (landscapeComplexity === 'MODERATE' || landscapeComplexity === 'COMPLEX') ? 1.35 : 1.25;
    const perim = Math.round(4 * Math.sqrt(fpEff) * pm);
    const sta = Math.max(8, Math.ceil(perim / 10));
    const hi = Math.round((sta * 8.69 + sta * 5.25 + sta * 0.75) * 1.75);
    const ai = Math.round((sta * 14 + sta * 5.25 + sta * 0.75) * 1.75);
    const ti = Math.round((sta * 24 + sta * 5.25 + sta * 0.75) * 1.75);
    R.tmBait = { hi, ai, ti, bmo: 35, pmo: 65, perim, sta };
    wgServices.push({ name: 'Termite Bait (Basic)', service: 'termite_bait', mo: 35, perTreatment: null, visitsPerYear: null });
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
    const bpp = R.pest ? R.pest.pa : Math.max(89, 117 + pestBaseAdjustment(fpEff));
    const fp = Math.max(199, otP(Math.max(199, Math.round(bpp * 1.75))));
    otItems.push({ name: 'OT Pest', price: fp, detail: indoor ? 'Interior + exterior' : 'Exterior (+ interior add-on)' });
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
    let p = 225;
    if (treatableSqFt > 43560) p = 475 + Math.ceil((treatableSqFt - 43560) / 10000) * 75;
    else if (treatableSqFt > 32000) p = 475;
    else if (treatableSqFt > 24000) p = 425;
    else if (treatableSqFt > 16000) p = 385;
    else if (treatableSqFt > 11000) p = 325;
    else if (treatableSqFt > 7500) p = 275;
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
    const dt = lawnEst / 100 + lawnEst / 200 + 30;
    const dc = LABOR * (dt / 60) + lawnEst / 1000 * 2.10;
    const sp = otP(Math.max(150, Math.round(dc / 0.40)));
    R.dth = sp;
    otItems.push({ name: 'Dethatching', price: sp, detail: 'One-time service' });
  }

  /* ── Trenching ───────────────────────────────────────────── */
  if (svcTrenching && !isCommercial && footprint > 0) {
    hasOT = true;
    let pm = (landscapeComplexity === 'MODERATE' || landscapeComplexity === 'COMPLEX') ? 1.35 : 1.25;
    const perim = Math.round(4 * Math.sqrt(footprint) * pm);
    let cp = 0.25;
    if (hasPoolCage) cp = 0.35;
    else if (hasPool) cp = 0.30;
    if (hasLargeDriveway) cp += 0.05;
    // v1.5: raised cap from 0.50 to 0.60 — full cage + 3-car garage can hit 55-60%
    cp = Math.min(0.60, cp);
    const dl = Math.round(perim * (1 - cp)), cl = Math.round(perim * cp);
    const fp = otP(Math.max(600, dl * 10 + cl * 14));
    R.trench = { price: fp, ren: 325, dl, cl };
    otItems.push({ name: 'Trenching', price: fp, detail: dl + ' LF dirt + ' + cl + ' LF concrete' });
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
  }

  /* ── Pre-Slab Termidor ───────────────────────────────────── */
  if (svcPreslab && !isCommercial && psSqft > 0) {
    hasOT = true;
    const PS_BTL = 152.10, PS_COV = 1250, PS_EQUIP = 15;
    const btl = Math.max(1, Math.ceil(psSqft / PS_COV));
    const lhr = Math.min(5, Math.max(1, 0.5 + psSqft / 1500));
    const cost = btl * PS_BTL + lhr * LABOR + PS_EQUIP;
    let price = Math.round(cost / 0.45);
    const vol = preslabVolume;
    if (vol === '10') price = Math.round(price * 0.85);
    else if (vol === '5') price = Math.round(price * 0.90);
    const warrAdd = preslabWarranty === 'EXTENDED' ? 200 : 0;
    const fp = otP(price) + warrAdd;
    otItems.push({ name: 'Pre-Slab', price: fp, detail: psSqft.toLocaleString() + ' sf | ' + btl + ' bottles' + (vol !== 'NONE' ? ' (vol disc)' : ''), psSqft, btl, volDisc: vol !== 'NONE', basePrice: otP(price), warrAdd });
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
        specItems.push({ name: 'Regular Roach', price: initialRoachPrice(rt, fpEff, true), det: 'Standalone knockdown' });
      }
    } else {
      let gp = 450 + interpolate(footprint, [
        { at: 800, adj: -40 }, { at: 1200, adj: -20 }, { at: 1500, adj: -10 },
        { at: 2000, adj: 0 }, { at: 2500, adj: 25 }, { at: 3000, adj: 50 },
        { at: 4000, adj: 85 },
      ]);
      specItems.push({ name: 'German Roach (3-visit)', price: otP(Math.max(400, gp)), det: 'Gel+IGR+monitoring' });
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
  const selectedRecurringLawn = R.lawn ? (R.lawn.find(t => t.recommended) || R.lawn[2]) : null;
  if (selectedRecurringLawn) { ac++; ra += selectedRecurringLawn.ann; lineItems.push({ name: 'Lawn Care', ann: selectedRecurringLawn.ann }); }
  if (R.pest) { ac++; ra += R.pest.ann; lineItems.push({ name: 'Pest Control', ann: R.pest.ann }); }
  if (R.ts) { ac++; ra += R.ts[1].ann; lineItems.push({ name: 'Tree & Shrub', ann: R.ts[1].ann }); }
  // Palm Injection intentionally excluded from WaveGuard tier count + discounted total —
  // not a qualifying service, not eligible for percent bundle discount.
  if (R.mq) {
    const ri = R.mqMeta?.ri ?? 1;
    if (R.mq[ri]) { ac++; ra += R.mq[ri].ann; lineItems.push({ name: 'Mosquito', ann: R.mq[ri].ann }); }
  }
  if (R.tmBait) { ac++; ra += 35 * 12; lineItems.push({ name: 'Termite Bait', ann: 420 }); }

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
  const da = Math.round(ra * wd * 100) / 100;
  const recurringAnnualAfterWaveGuard = Math.round((ra - da) * 100) / 100;
  const md = inputs.manualDiscount;
  let manualDiscountAmount = 0;
  let manualDiscountInfo = null;
  if (md && Number(md.value) > 0) {
    const v = Number(md.value);
    if (md.type === 'PERCENT') {
      if (v > 100) throw new Error('Manual percentage discount cannot exceed 100');
      manualDiscountAmount = Math.round(recurringAnnualAfterWaveGuard * (v / 100) * 100) / 100;
    } else {
      manualDiscountAmount = Math.round(v * 100) / 100;
    }
    const requestedAmount = manualDiscountAmount;
    manualDiscountAmount = Math.min(manualDiscountAmount, recurringAnnualAfterWaveGuard);
    manualDiscountInfo = {
      ...md,
      type: md.type === 'PERCENT' ? 'PERCENT' : 'FIXED',
      value: v,
      requestedAmount,
      amount: manualDiscountAmount,
      label: md.label || (md.type === 'PERCENT' ? `Discount (${v}%)` : `Discount -$${v.toFixed(2)}`),
      discountableBase: recurringAnnualAfterWaveGuard,
      capped: requestedAmount > manualDiscountAmount,
      capReason: requestedAmount > manualDiscountAmount ? 'discountable_base' : null,
      scope: 'recurring_annual_after_waveguard',
      stackingOrder: 'after_waveguard',
    };
  }
  const ad = Math.round((recurringAnnualAfterWaveGuard - manualDiscountAmount) * 100) / 100;
  const mm = Math.round(ad / 12 * 100) / 100;

  // Margin floor check - flag any line that drops below 35% margin at current tier discount
  // Loaded labor rate ~$35/hr, typical service 45-60 min = ~$30-35 labor + $10-15 materials = ~$45 COGS floor
  const MARGIN_FLOOR = 0.35;
  const marginWarnings = [];
  if (wd > 0) {
    lineItems.forEach(li => {
      const discountedAnn = li.ann * (1 - wd);
      // Estimate COGS at ~55% of pre-discount (conservative: labor + materials + drive)
      const estimatedCOGS = li.ann * 0.55;
      const margin = (discountedAnn - estimatedCOGS) / discountedAnn;
      if (margin < MARGIN_FLOOR) {
        marginWarnings.push({
          service: li.name,
          preDiscount: Math.round(li.ann),
          afterDiscount: Math.round(discountedAnn),
          estimatedMargin: Math.round(margin * 100),
          tier: wt,
        });
      }
    });
  }

  let ot = 0;
  otItems.forEach(i => ot += i.price);
  specItems.forEach(s => { if (!s.onProg) ot += s.price; });
  let tmInstall = R.tmBait ? R.tmBait.ti : 0; // default Trelona; hi=HexPro, ai=Advance also available
  ot = Math.round(ot * 100) / 100;

  const rba = R.rodBaitMo ? R.rodBaitMo * 12 : 0;
  const palmAnn = R.injection ? R.injection.ann : 0;
  const palmMo = R.injection ? R.injection.mo : 0;
  const totalOT = ot + tmInstall;
  const y1 = Math.round((ad + rba + palmAnn + totalOT) * 100) / 100;
  const y2 = Math.round((ad + rba + palmAnn + (R.trench ? 325 : 0)) * 100) / 100;
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
      marginWarnings, // any lines below 35% margin at this tier discount
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
