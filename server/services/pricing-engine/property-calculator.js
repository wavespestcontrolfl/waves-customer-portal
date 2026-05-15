// ============================================================
// property-calculator.js — Property measurement calculations
// ============================================================
const {
  HARDSCAPE, HARDSCAPE_ADDITIONS, BED_DENSITY, BED_AREA_CAP, TURF_FACTORS,
} = require('./constants');

function calculateFootprint(homeSqFt, stories) {
  return Math.round(homeSqFt / Math.max(1, stories));
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

  const rawImperviousPct = input.imperviousSurfacePercent ?? input.imperviosSurfacePercent ?? 20;
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

function estimateBedArea(lotSqFt, shrubDensity = 'moderate', complexity = 'standard') {
  const density = BED_DENSITY[shrubDensity] || BED_DENSITY.moderate;
  let pct = density.basePct;
  if (complexity === 'complex' || complexity === 'moderate') pct += density.complexAdd;
  return Math.min(Math.round(lotSqFt * pct), BED_AREA_CAP);
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

function calculatePropertyProfile(input) {
  const footprint = calculateFootprint(input.homeSqFt, input.stories || 1);
  const hardscape = estimateHardscape(input.lotSqFt, input.propertyType, input.features || {});
  const hasInputBedArea = hasNonNegativeNumber(input.bedArea);
  const hasEstimatedBedArea = hasNonNegativeNumber(input.estimatedBedAreaSf);
  const explicitBedArea = hasInputBedArea
    ? Number(input.bedArea)
    : (hasEstimatedBedArea ? Number(input.estimatedBedAreaSf) : null);
  const bedRatio = explicitBedArea !== null && input.lotSqFt > 0 ? explicitBedArea / input.lotSqFt : 0;
  const features = { ...(input.features || {}), bedRatio };
  const legacyLawnEstimate = estimateLawnSqFt(input.lotSqFt, footprint, hardscape, features);
  const turfArea = computeTurfArea(input, { turfSf: legacyLawnEstimate });
  const lawnSqFt = turfArea.turfSf;
  const bedArea = explicitBedArea !== null
    ? explicitBedArea
    : estimateBedArea(input.lotSqFt, (input.features || {}).shrubs, (input.features || {}).complexity);
  const perimeter = calculatePerimeter(footprint, (input.features || {}).complexity);
  const lotCategory = getLotCategory(input.lotSqFt);

  return {
    footprint, hardscape, lawnSqFt, turfSf: lawnSqFt,
    turfEstimated: turfArea.turfEstimated,
    turfConfidence: turfArea.turfConfidence,
    turfBasis: turfArea.turfBasis,
    turfOpenArea: turfArea.turfOpenArea,
    turfFlags: turfArea.turfFlags,
    bedArea, perimeter, lotCategory,
    complexityScore: calculateComplexityScore(features),
    homeSqFt: input.homeSqFt,
    lotSqFt: input.lotSqFt,
    stories: input.stories || 1,
    propertyType: input.propertyType || 'single_family',
    features: input.features || {},
    // v2 enriched fields — consumed by modifiers.deriveModifiers()
    yearBuilt: input.yearBuilt || null,
    constructionMaterial: input.constructionMaterial || null,
    foundationType: input.foundationType || null,
    roofType: input.roofType || null,
    nearWater: input.nearWater || (input.features?.nearWater ? 'CLOSE' : 'NONE'),
    waterDistance: input.waterDistance || null,
    serviceZone: input.serviceZone || input.zone || 'A',
    isHOA: !!input.isHOA,
    hoaFee: input.hoaFee || null,
    isRental: !!input.isRental,
    isNewHomeowner: !!input.isNewHomeowner,
    fenceType: input.fenceType || null,
    outbuildingCount: input.outbuildingCount || 0,
    attachedGarage: !!input.attachedGarage,
    maintenanceCondition: input.maintenanceCondition || null,
    overallPestPressure: input.overallPestPressure || null,
  };
}

module.exports = {
  calculateFootprint, estimateHardscape, calculateComplexityScore,
  estimateLawnSqFt, computeTurfArea, toNonNegativeNumber,
  estimateBedArea, calculatePerimeter,
  getLotCategory, calculatePropertyProfile,
};
