// ============================================================
// property-calculator.js — Property measurement calculations
// ============================================================
const {
  HARDSCAPE, HARDSCAPE_ADDITIONS, BED_DENSITY, BED_AREA_CAP, TURF_FACTORS,
  MOSQUITO,
} = require('./constants');

function calculateFootprint(homeSqFt, stories) {
  const sqft = Number(homeSqFt) || 0;
  return Math.round(sqft / Math.max(1, Number(stories) || 1));
}

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

function estimateHardscape(lotSqFt, propertyType, features = {}) {
  const type = propertyType || 'single_family';
  let fn = HARDSCAPE.single_family;
  if (type === 'commercial') fn = HARDSCAPE.commercial;
  else if (type.includes('townhome') || type === 'duplex') fn = HARDSCAPE.townhome;
  else if (type.includes('condo')) fn = HARDSCAPE.condo;

  let hs = fn(lotSqFt);
  if (features.poolCage) hs += HARDSCAPE_ADDITIONS.poolCage;
  else if (features.pool) hs += HARDSCAPE_ADDITIONS.poolNoCage;
  if (features.largeDriveway) hs += HARDSCAPE_ADDITIONS.largeDriveway;
  return Math.round(hs);
}

function calculateComplexityScore(features = {}) {
  let score = 0;
  if (features.pool || features.poolCage) score += 2;
  if (features.poolCage) score += 2;  // cage adds extra
  if (features.largeDriveway) score += 2;
  if (features.shrubs === 'heavy') score += 2;
  else if (features.shrubs === 'moderate') score += 1;
  if (features.trees === 'heavy') score += 2;
  else if (features.trees === 'moderate') score += 1;
  if (features.complexity === 'complex') score += 2;
  else if (features.complexity === 'moderate') score += 1;
  if (features.bedRatio >= 0.20) score += 3;
  else if (features.bedRatio >= 0.10) score += 1;
  return Math.min(score, TURF_FACTORS.length - 1);
}

function estimateLawnSqFt(lotSqFt, footprint, hardscape, features = {}) {
  const outdoorArea = lotSqFt - footprint - hardscape;
  if (outdoorArea <= 0) return 0;
  const score = calculateComplexityScore(features);
  const turfFactor = TURF_FACTORS[score];
  return Math.round(outdoorArea * turfFactor);
}

function computeTurfArea(input, fallback = {}) {
  if (hasNonNegativeNumber(input.measuredTurfSf)) {
    const measured = Number(input.measuredTurfSf);
    return {
      turfSf: measured,
      turfEstimated: false,
      turfConfidence: 'HIGH',
      turfBasis: 'measuredTurfSf',
      turfFlags: [],
    };
  }

  if (hasNonNegativeNumber(input.lawnSqFt)) {
    const lawnSqFt = Number(input.lawnSqFt);
    return {
      turfSf: lawnSqFt,
      turfEstimated: false,
      turfConfidence: 'HIGH',
      turfBasis: 'lawnSqFt',
      turfFlags: [],
    };
  }

  const estimated = toPositiveNumber(input.estimatedTurfSf);
  if (estimated > 0) {
    return {
      turfSf: estimated,
      turfEstimated: true,
      turfConfidence: 'MEDIUM',
      turfBasis: 'estimatedTurfSf',
      turfFlags: [],
    };
  }

  const lotSqFt = toPositiveNumber(input.lotSqFt);
  if (lotSqFt <= 0) {
    return {
      turfSf: 0,
      turfEstimated: true,
      turfConfidence: 'LOW',
      turfBasis: 'lotFallback',
      turfFlags: ['FIELD_VERIFY_TURF_SQFT'],
    };
  }

  const hasLotBasedTurfFields =
    hasNonNegativeNumber(input.imperviousSurfacePercent) ||
    hasNonNegativeNumber(input.imperviosSurfacePercent) ||
    hasNonNegativeNumber(input.estimatedBedAreaSf) ||
    hasNonNegativeNumber(input.estimatedBedAreaPercent);

  const hasFallbackTurf =
    fallback.turfSf !== undefined &&
    fallback.turfSf !== null &&
    fallback.turfSf !== '' &&
    Number.isFinite(Number(fallback.turfSf)) &&
    Number(fallback.turfSf) >= 0;

  if (!hasLotBasedTurfFields && hasFallbackTurf) {
    return {
      turfSf: Number(fallback.turfSf),
      turfEstimated: true,
      turfConfidence: 'LOW',
      turfBasis: 'legacyHardscapeEstimate',
      turfFlags: ['FIELD_VERIFY_TURF_SQFT'],
    };
  }

  const rawImperviousPct = hasNonNegativeNumber(input.imperviousSurfacePercent)
    ? input.imperviousSurfacePercent
    : (hasNonNegativeNumber(input.imperviosSurfacePercent) ? input.imperviosSurfacePercent : 20);
  const imperviousPct = toNonNegativeNumber(rawImperviousPct, 20);
  const imperviousFraction = Math.min(1, Math.max(0, imperviousPct / 100));
  const turfOpenArea = Math.max(0, Math.round(lotSqFt * (1 - imperviousFraction)));
  const hasEstimatedBedPercent = hasNonNegativeNumber(input.estimatedBedAreaPercent);
  const hasBedArea = hasNonNegativeNumber(input.bedArea);
  const hasEstimatedBedArea = hasNonNegativeNumber(input.estimatedBedAreaSf);
  const explicitBedArea = hasBedArea
    ? Number(input.bedArea)
    : (hasEstimatedBedArea ? Number(input.estimatedBedAreaSf) : null);
  const bedArea = hasEstimatedBedPercent
    ? Math.max(0, Math.round(turfOpenArea * (Number(input.estimatedBedAreaPercent) / 100)))
    : (explicitBedArea !== null ? explicitBedArea : Math.round(turfOpenArea * 0.15));

  return {
    turfSf: Math.max(0, Math.round(turfOpenArea - bedArea)),
    turfEstimated: true,
    turfConfidence: 'LOW',
    turfBasis: 'lotFallback',
    turfOpenArea,
    turfFlags: ['FIELD_VERIFY_TURF_SQFT'],
  };
}

function estimateBedArea(lotSqFt, shrubDensity = 'moderate', complexity = 'standard', options = {}) {
  const density = BED_DENSITY[shrubDensity] || BED_DENSITY.moderate;
  let pct = density.basePct;
  if (complexity === 'complex' || complexity === 'moderate') pct += density.complexAdd;
  const raw = Math.round(lotSqFt * pct);
  // `uncapped: true` returns the raw lot-density estimate so callers can
  // preserve uncappedBedAreaEstimate when the cap fires. Default behavior
  // (caller passes nothing) is unchanged: always cap at BED_AREA_CAP.
  if (options && options.uncapped) return raw;
  return Math.min(raw, BED_AREA_CAP);
}

function calculatePerimeter(footprint, complexity = 'standard') {
  const mult = (complexity === 'complex' || complexity === 'moderate') ? 1.35 : 1.25;
  return Math.round(4 * Math.sqrt(footprint) * mult);
}

function getLotCategory(lotSqFt) {
  if (lotSqFt < 10890) return 'SMALL';
  if (lotSqFt < 14520) return 'QUARTER';
  if (lotSqFt < 21780) return 'THIRD';
  if (lotSqFt < 43560) return 'HALF';
  return 'ACRE';
}

function getMosquitoTreatableCategory(mosquitoTreatableSqFt, grossLotCategory) {
  const categories = MOSQUITO.lotCategories;
  const rawIndex = categories.findIndex(c => mosquitoTreatableSqFt <= c.maxSqFt);
  const treatableIndex = rawIndex >= 0 ? rawIndex : categories.length - 1;
  const grossIndex = Math.max(0, categories.findIndex(c => c.key === grossLotCategory));
  const guardedIndex = Math.max(
    treatableIndex,
    grossIndex - (MOSQUITO.grossLotGuardrailMaxDrop || 1)
  );
  return categories[Math.min(guardedIndex, categories.length - 1)].key;
}

function calculatePropertyProfile(input) {
  const explicitFootprint = toPositiveNumber(input.footprintSqFt ?? input.footprint);
  const footprint = explicitFootprint || calculateFootprint(input.homeSqFt, input.stories || 1);
  const explicitPerimeter = toPositiveNumber(input.perimeterLF ?? input.perimeterLf ?? input.perimeter);
  const hardscape = estimateHardscape(input.lotSqFt, input.propertyType, input.features || {});
  const hasInputBedArea = hasNonNegativeNumber(input.bedArea);
  const estimatedBedAreaInput = hasNonNegativeNumber(input.estimatedBedAreaSf)
    ? input.estimatedBedAreaSf
    : input.estimatedBedArea;
  const hasEstimatedBedArea = hasNonNegativeNumber(estimatedBedAreaInput);
  const inputBedArea = hasInputBedArea ? Number(input.bedArea) : null;
  const providedEstimatedBedArea = hasEstimatedBedArea ? Number(estimatedBedAreaInput) : null;
  const explicitBedArea = inputBedArea !== null
    ? inputBedArea
    : providedEstimatedBedArea;
  const turfInput = hasEstimatedBedArea && !hasNonNegativeNumber(input.estimatedBedAreaSf)
    ? { ...input, estimatedBedAreaSf: estimatedBedAreaInput }
    : input;
  const bedRatio = explicitBedArea !== null && input.lotSqFt > 0 ? explicitBedArea / input.lotSqFt : 0;
  const features = { ...(input.features || {}), bedRatio };
  const legacyLawnEstimate = estimateLawnSqFt(input.lotSqFt, footprint, hardscape, features);
  const turfArea = computeTurfArea(turfInput, { turfSf: legacyLawnEstimate });
  const lawnSqFt = turfArea.turfSf;
  const sourceHint = String(input.bedAreaSource || '').trim().toLowerCase();
  const validSourceHint = ['explicit', 'estimated', 'lot_based', 'fallback'].includes(sourceHint) ? sourceHint : null;
  let bedArea;
  let bedAreaSource;
  let bedAreaPricingConfidence;
  let bedAreaCapped = false;
  // Raw uncapped estimate — preserved when capping fires so downstream
  // consumers (priceTreeShrub, admin review surfaces) can show what the
  // estimator wanted to use vs what BED_AREA_CAP allowed.
  let uncappedBedAreaEstimate;

  if (validSourceHint === 'fallback') {
    bedArea = 0;
    bedAreaSource = 'fallback';
    bedAreaPricingConfidence = 'low';
  } else if (inputBedArea !== null) {
    bedAreaSource = validSourceHint === 'estimated' ? 'estimated' : 'explicit';
    bedAreaPricingConfidence = bedAreaSource === 'estimated' ? 'medium' : 'high';
    if (bedAreaSource === 'estimated') {
      bedArea = Math.min(inputBedArea, BED_AREA_CAP);
      bedAreaCapped = inputBedArea >= BED_AREA_CAP;
      if (bedAreaCapped) uncappedBedAreaEstimate = inputBedArea;
    } else {
      bedArea = inputBedArea;
    }
  } else if (providedEstimatedBedArea !== null) {
    bedArea = Math.min(providedEstimatedBedArea, BED_AREA_CAP);
    bedAreaSource = 'estimated';
    bedAreaPricingConfidence = 'medium';
    bedAreaCapped = providedEstimatedBedArea >= BED_AREA_CAP;
    if (bedAreaCapped) uncappedBedAreaEstimate = providedEstimatedBedArea;
  } else if (toPositiveNumber(input.lotSqFt) > 0) {
    const rawLotBedArea = estimateBedArea(
      input.lotSqFt,
      (input.features || {}).shrubs,
      (input.features || {}).complexity,
      { uncapped: true }
    );
    bedArea = Math.min(rawLotBedArea, BED_AREA_CAP);
    // Lot-density inference is now distinguishable from a customer-supplied
    // estimate — `lot_based` is propagated through generateEstimate so the
    // T&S resolver and admin review surfaces can flag it differently.
    bedAreaSource = 'lot_based';
    bedAreaPricingConfidence = 'medium';
    bedAreaCapped = rawLotBedArea >= BED_AREA_CAP;
    if (bedAreaCapped) uncappedBedAreaEstimate = rawLotBedArea;
  } else {
    bedArea = 0;
    bedAreaSource = 'fallback';
    bedAreaPricingConfidence = 'low';
  }
  const perimeter = explicitPerimeter || calculatePerimeter(footprint, (input.features || {}).complexity);
  const perimeterSource = explicitPerimeter ? 'property_perimeter' : 'computed_from_footprint';
  const lotCategory = getLotCategory(input.lotSqFt);
  const mosquitoTreatableSqFt = Math.max(0, input.lotSqFt - footprint - hardscape);
  const mosquitoLotCategory = getMosquitoTreatableCategory(mosquitoTreatableSqFt, lotCategory);

  return {
    footprint, hardscape, lawnSqFt, turfSf: lawnSqFt,
    turfEstimated: turfArea.turfEstimated,
    turfConfidence: turfArea.turfConfidence,
    turfBasis: turfArea.turfBasis,
    turfOpenArea: turfArea.turfOpenArea,
    turfFlags: turfArea.turfFlags,
    bedArea,
    estimatedBedArea: bedAreaSource === 'estimated' ? bedArea : undefined,
    bedAreaSource,
    bedAreaPricingConfidence,
    bedAreaCapped,
    ...(uncappedBedAreaEstimate !== undefined ? { uncappedBedAreaEstimate } : {}),
    palmCount: input.palmCount,
    palmInventory: input.palmInventory,
    perimeter,
    perimeterSource,
    lotCategory,
    mosquitoTreatableSqFt, mosquitoLotCategory,
    complexityScore: calculateComplexityScore(features),
    homeSqFt: input.homeSqFt,
    lotSqFt: input.lotSqFt,
    stories: input.stories || 1,
    storiesSource: input.storiesSource || null,
    propertyType: input.propertyType || 'single_family',
    features: input.features || {},
    // v2 enriched fields — consumed by modifiers.deriveModifiers()
    yearBuilt: input.yearBuilt || null,
    constructionMaterial: input.constructionMaterial || null,
    foundationType: input.foundationType || null,
    roofType: input.roofType || null,
    nearWater: input.nearWater || (input.features?.nearWater ? 'CLOSE' : 'NONE'),
    waterDistance: input.waterDistance || null,
    isHOA: !!input.isHOA,
    hoaFee: input.hoaFee || null,
    isRental: !!input.isRental,
    isNewHomeowner: !!input.isNewHomeowner,
    fenceType: input.fenceType || null,
    outbuildingCount: input.outbuildingCount || 0,
    attachedGarage: !!(input.attachedGarage || input.features?.attachedGarage),
    footprintSqFt: input.footprintSqFt,
    buildingSqFt: input.buildingSqFt,
    livingAreaSqFt: input.livingAreaSqFt,
    atticSqFt: input.atticSqFt,
    atticAreaSqFt: input.atticAreaSqFt,
    rawWoodSqFt: input.rawWoodSqFt,
    woodTreatmentSqFt: input.woodTreatmentSqFt,
    slabSqFt: input.slabSqFt,
    foundationSqFt: input.foundationSqFt,
    buildingSlabSqFt: input.buildingSlabSqFt,
    newConstructionSlabSqFt: input.newConstructionSlabSqFt,
    maintenanceCondition: input.maintenanceCondition || null,
    overallPestPressure: input.overallPestPressure || null,
  };
}

module.exports = {
  calculateFootprint, estimateHardscape, calculateComplexityScore,
  estimateLawnSqFt, computeTurfArea, toNonNegativeNumber,
  estimateBedArea, calculatePerimeter,
  getLotCategory, getMosquitoTreatableCategory, calculatePropertyProfile,
};
