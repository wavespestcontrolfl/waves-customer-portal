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
  const footprint = calculateFootprint(input.homeSqFt, input.stories || 1);
  const hardscape = estimateHardscape(input.lotSqFt, input.propertyType, input.features || {});
  const bedRatio = input.bedArea ? input.bedArea / input.lotSqFt : 0;
  const features = { ...(input.features || {}), bedRatio };
  const lawnSqFt = input.lawnSqFt || estimateLawnSqFt(input.lotSqFt, footprint, hardscape, features);
  const bedArea = input.bedArea || estimateBedArea(input.lotSqFt, (input.features || {}).shrubs, (input.features || {}).complexity);
  const perimeter = calculatePerimeter(footprint, (input.features || {}).complexity);
  const lotCategory = getLotCategory(input.lotSqFt);
  const mosquitoTreatableSqFt = Math.max(0, input.lotSqFt - footprint - hardscape);
  const mosquitoLotCategory = getMosquitoTreatableCategory(mosquitoTreatableSqFt, lotCategory);

  return {
    footprint, hardscape, lawnSqFt, bedArea, perimeter, lotCategory,
    mosquitoTreatableSqFt, mosquitoLotCategory,
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
  };
}

module.exports = {
  calculateFootprint, estimateHardscape, calculateComplexityScore,
  estimateLawnSqFt, estimateBedArea, calculatePerimeter,
  getLotCategory, getMosquitoTreatableCategory, calculatePropertyProfile,
};
