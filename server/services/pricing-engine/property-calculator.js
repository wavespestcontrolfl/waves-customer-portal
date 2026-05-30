// ============================================================
// property-calculator.js — Property measurement calculations
// ============================================================
const {
  HARDSCAPE, HARDSCAPE_ADDITIONS, BED_DENSITY, BED_AREA_CAP, TURF_FACTORS,
  MOSQUITO,
} = require('./constants');

const PLAUSIBLE_TURF_OVERAGE_TOLERANCE_SF = 250;
const PLAUSIBLE_TURF_OVERAGE_TOLERANCE_RATIO = 0.05;

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

function isAffirmative(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  return ['YES', 'TRUE', 'Y', '1'].includes(String(value || '').trim().toUpperCase());
}

function hasAffirmative(...values) {
  return values.some(isAffirmative);
}

function isPresenceValue(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return false;
  return !['NO', 'NONE', 'FALSE', 'N', '0', 'UNKNOWN'].includes(raw);
}

function hasPresenceValue(...values) {
  return values.some(isPresenceValue);
}

function normalizeFeatureEnum(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw || undefined;
}

function normalizeFeatureInputs(input = {}) {
  const raw = input.features || {};
  const features = { ...raw };

  features.poolCage = hasAffirmative(raw.poolCage, raw.hasPoolCage, input.poolCage, input.hasPoolCage);
  features.pool = hasAffirmative(raw.pool, raw.hasPool, input.pool, input.hasPool) || features.poolCage;
  features.largeDriveway = hasAffirmative(raw.largeDriveway, raw.hasLargeDriveway, input.largeDriveway, input.hasLargeDriveway);

  const poolCageSize = raw.poolCageSize ?? input.poolCageSize;
  if (poolCageSize !== undefined && poolCageSize !== null && poolCageSize !== '') {
    features.poolCageSize = poolCageSize;
  }

  features.shrubs = normalizeFeatureEnum(raw.shrubs || raw.shrubDensity || input.shrubDensity || features.shrubs);
  features.trees = normalizeFeatureEnum(raw.trees || raw.treeDensity || input.treeDensity || features.trees);
  features.complexity = normalizeFeatureEnum(raw.complexity || raw.landscapeComplexity || input.landscapeComplexity || features.complexity);
  features.nearWater = hasPresenceValue(raw.nearWater, input.nearWater);
  features.attachedGarage = hasAffirmative(raw.attachedGarage, input.attachedGarage);

  return features;
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
    const hasKnownMaxEstimatedTurfSf = input.maxEstimatedTurfSfKnown === true &&
      hasNonNegativeNumber(input.maxEstimatedTurfSf);
    const maxEstimatedTurfSf = hasKnownMaxEstimatedTurfSf ? Number(input.maxEstimatedTurfSf) : 0;
    if (hasKnownMaxEstimatedTurfSf && estimated > maxEstimatedTurfSf) {
      const overage = estimated - maxEstimatedTurfSf;
      const tolerance = Math.max(
        PLAUSIBLE_TURF_OVERAGE_TOLERANCE_SF,
        maxEstimatedTurfSf * PLAUSIBLE_TURF_OVERAGE_TOLERANCE_RATIO
      );
      if (overage <= tolerance) {
        return {
          turfSf: maxEstimatedTurfSf,
          turfEstimated: true,
          turfConfidence: 'MEDIUM',
          turfBasis: 'plausibleMaxTurfCap',
          turfOpenArea: maxEstimatedTurfSf,
          turfFlags: ['FIELD_VERIFY_TURF_SQFT', 'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX'],
        };
      }
      const hasFallbackTurf =
        fallback.turfSf !== undefined &&
        fallback.turfSf !== null &&
        fallback.turfSf !== '' &&
        Number.isFinite(Number(fallback.turfSf)) &&
        Number(fallback.turfSf) >= 0;
      const fallbackTurfSf = hasFallbackTurf
        ? Math.min(Number(fallback.turfSf), maxEstimatedTurfSf)
        : maxEstimatedTurfSf;
      return {
        turfSf: fallbackTurfSf,
        turfEstimated: true,
        turfConfidence: 'LOW',
        turfBasis: hasFallbackTurf ? 'legacyHardscapeEstimate' : 'plausibleMaxTurfCap',
        turfOpenArea: maxEstimatedTurfSf,
        turfFlags: ['FIELD_VERIFY_TURF_SQFT', 'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX'],
      };
    }
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
  const hasExplicitBedArea = hasNonNegativeNumber(input.bedArea);

  const hasFallbackTurf =
    fallback.turfSf !== undefined &&
    fallback.turfSf !== null &&
    fallback.turfSf !== '' &&
    Number.isFinite(Number(fallback.turfSf)) &&
    Number(fallback.turfSf) >= 0;

  if (!hasLotBasedTurfFields && hasFallbackTurf) {
    const hasKnownMaxEstimatedTurfSf = input.maxEstimatedTurfSfKnown === true &&
      hasNonNegativeNumber(input.maxEstimatedTurfSf);
    const maxEstimatedTurfSf = hasKnownMaxEstimatedTurfSf ? Number(input.maxEstimatedTurfSf) : 0;
    const shouldCapFallback = !hasExplicitBedArea && hasKnownMaxEstimatedTurfSf;
    const fallbackTurfSf = shouldCapFallback
      ? Math.min(Number(fallback.turfSf), maxEstimatedTurfSf)
      : Number(fallback.turfSf);
    const turfFlags = ['FIELD_VERIFY_TURF_SQFT'];
    if (shouldCapFallback && Number(fallback.turfSf) > maxEstimatedTurfSf) {
      turfFlags.push('TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX');
    }
    return {
      turfSf: fallbackTurfSf,
      turfEstimated: true,
      turfConfidence: 'LOW',
      turfBasis: 'legacyHardscapeEstimate',
      turfOpenArea: shouldCapFallback ? maxEstimatedTurfSf : undefined,
      turfFlags,
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
  const lotFallbackTurfSf = Math.max(0, Math.round(turfOpenArea - bedArea));
  const hasKnownMaxEstimatedTurfSf = input.maxEstimatedTurfSfKnown === true &&
    hasNonNegativeNumber(input.maxEstimatedTurfSf);
  const maxEstimatedTurfSf = hasKnownMaxEstimatedTurfSf ? Number(input.maxEstimatedTurfSf) : 0;
  if (!hasBedArea && !hasEstimatedBedArea && hasKnownMaxEstimatedTurfSf && lotFallbackTurfSf > maxEstimatedTurfSf) {
    const overage = lotFallbackTurfSf - maxEstimatedTurfSf;
    const tolerance = Math.max(
      PLAUSIBLE_TURF_OVERAGE_TOLERANCE_SF,
      maxEstimatedTurfSf * PLAUSIBLE_TURF_OVERAGE_TOLERANCE_RATIO
    );
    const cappedTurfSf = overage <= tolerance
      ? maxEstimatedTurfSf
      : (hasFallbackTurf ? Math.min(Number(fallback.turfSf), maxEstimatedTurfSf) : maxEstimatedTurfSf);
    return {
      turfSf: cappedTurfSf,
      turfEstimated: true,
      turfConfidence: overage <= tolerance ? 'MEDIUM' : 'LOW',
      turfBasis: overage <= tolerance || !hasFallbackTurf ? 'plausibleMaxTurfCap' : 'legacyHardscapeEstimate',
      turfOpenArea: maxEstimatedTurfSf,
      turfFlags: ['FIELD_VERIFY_TURF_SQFT', 'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX'],
    };
  }

  return {
    turfSf: lotFallbackTurfSf,
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

const MOSQUITO_CATEGORY_PROXY_SQFT = {
  SMALL: 6000,
  QUARTER: 10000,
  THIRD: 15000,
  HALF: 25000,
  ACRE: 43560,
};

function mosquitoCategoryKeys() {
  return (MOSQUITO.lotCategories || []).map(c => c.key);
}

function isValidMosquitoLotCategory(value) {
  return mosquitoCategoryKeys().includes(value);
}

function deriveMosquitoLotCategoryFromArea(mosquitoTreatableSqFt) {
  const sqft = Math.max(0, Math.round(Number(mosquitoTreatableSqFt) || 0));
  const category = (MOSQUITO.lotCategories || []).find(c => sqft <= c.maxSqFt);
  return category?.key || (MOSQUITO.lotCategories || [])[MOSQUITO.lotCategories.length - 1]?.key || null;
}

function uniqueList(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function resolveMosquitoTreatableArea(property = {}) {
  const manualReviewReasons = [];
  const warnings = [];
  const explicit = Number(property.mosquitoTreatableSqFt);
  const explicitIsPositive = Number.isFinite(explicit) && explicit > 0;
  const lotSqFt = Number(property.lotSqFt);
  const footprint = Number(property.footprintSqFt ?? property.footprint);
  const hardscape = Number(property.hardscape);
  const hasPositiveLot = Number.isFinite(lotSqFt) && lotSqFt > 0;
  const hasMosquitoTreatableValue = property.mosquitoTreatableSqFt !== undefined &&
    property.mosquitoTreatableSqFt !== null &&
    property.mosquitoTreatableSqFt !== '';
  const derivedZeroWithoutLotData = hasMosquitoTreatableValue && !explicitIsPositive && !hasPositiveLot;
  const computedFootprint = Number.isFinite(footprint) && footprint >= 0 ? footprint : 0;
  const computedHardscape = Number.isFinite(hardscape) && hardscape >= 0 ? hardscape : 0;
  const fallbackTreatableSqFt = hasPositiveLot
    ? Math.max(0, Math.round(lotSqFt - computedFootprint - computedHardscape))
    : 0;
  const mosquitoLotCategory = !derivedZeroWithoutLotData && isValidMosquitoLotCategory(property.mosquitoLotCategory)
    ? property.mosquitoLotCategory
    : null;
  const grossLotCategory = isValidMosquitoLotCategory(property.lotCategory)
    ? property.lotCategory
    : null;

  let mosquitoTreatableSqFt;
  let source;
  let confidence;

  if (explicitIsPositive) {
    mosquitoTreatableSqFt = Math.round(explicit);
    source = 'explicit_mosquito_treatable_sqft';
    confidence = 'high';
  } else if (fallbackTreatableSqFt > 0) {
    mosquitoTreatableSqFt = fallbackTreatableSqFt;
    source = 'computed_lot_minus_footprint_hardscape';
    confidence = 'medium';
  } else if (mosquitoLotCategory) {
    mosquitoTreatableSqFt = MOSQUITO_CATEGORY_PROXY_SQFT[mosquitoLotCategory];
    source = 'lot_category_proxy';
    confidence = 'low';
    manualReviewReasons.push('missing_mosquito_treatable_area');
  } else if (grossLotCategory) {
    mosquitoTreatableSqFt = MOSQUITO_CATEGORY_PROXY_SQFT[grossLotCategory];
    source = 'gross_lot_proxy';
    confidence = 'low';
    manualReviewReasons.push('missing_mosquito_treatable_area');
  } else {
    mosquitoTreatableSqFt = 0;
    source = 'missing_or_zero_fallback';
    confidence = 'low';
    manualReviewReasons.push('missing_mosquito_treatable_area');
  }

  const missingAreaData = source !== 'explicit_mosquito_treatable_sqft' &&
    source !== 'computed_lot_minus_footprint_hardscape';

  return {
    mosquitoTreatableSqFt,
    source,
    confidence,
    requiresManualReview: manualReviewReasons.length > 0,
    manualReviewReasons: uniqueList(manualReviewReasons),
    warnings,
    lotCategoryFromArea: deriveMosquitoLotCategoryFromArea(mosquitoTreatableSqFt),
    fallbackTreatableSqFt,
    missingAreaData,
  };
}

function resolveMosquitoLotCategory(property = {}, areaResolution = resolveMosquitoTreatableArea(property)) {
  const manualReviewReasons = [];
  const warnings = [];
  const requestedMosquitoCategory = property.mosquitoLotCategory;
  const explicitMosquitoCategory = isValidMosquitoLotCategory(requestedMosquitoCategory)
    ? requestedMosquitoCategory
    : null;
  const grossLotCategory = isValidMosquitoLotCategory(property.lotCategory)
    ? property.lotCategory
    : null;

  if (requestedMosquitoCategory && !explicitMosquitoCategory) {
    manualReviewReasons.push('invalid_mosquito_lot_category');
    warnings.push('invalid_mosquito_lot_category');
  }

  if (explicitMosquitoCategory) {
    return {
      lotCategory: explicitMosquitoCategory,
      grossLotCategory,
      lotCategorySource: 'explicit_mosquito_lot_category',
      lotCategoryGuardrailApplied: false,
      manualReviewReasons,
      warnings,
    };
  }

  let lotCategory = null;
  let lotCategorySource = 'unknown';
  if (areaResolution.mosquitoTreatableSqFt > 0) {
    lotCategory = areaResolution.lotCategoryFromArea ||
      deriveMosquitoLotCategoryFromArea(areaResolution.mosquitoTreatableSqFt);
    lotCategorySource = areaResolution.source === 'gross_lot_proxy'
      ? 'gross_lot_category_fallback'
      : 'derived_from_treatable_area';
  } else if (grossLotCategory) {
    lotCategory = grossLotCategory;
    lotCategorySource = 'gross_lot_category_fallback';
  }

  let lotCategoryGuardrailApplied = false;
  let originalLotCategory = lotCategory;
  let adjustedLotCategory = lotCategory;
  if (
    lotCategory &&
    grossLotCategory &&
    areaResolution.source !== 'explicit_mosquito_treatable_sqft'
  ) {
    const categories = MOSQUITO.lotCategories || [];
    const lotIndex = categories.findIndex(c => c.key === lotCategory);
    const grossIndex = categories.findIndex(c => c.key === grossLotCategory);
    const maxDrop = Number.isFinite(Number(MOSQUITO.grossLotGuardrailMaxDrop))
      ? Number(MOSQUITO.grossLotGuardrailMaxDrop)
      : 1;
    const minimumIndex = Math.max(0, grossIndex - maxDrop);
    if (lotIndex >= 0 && grossIndex >= 0 && lotIndex < minimumIndex) {
      adjustedLotCategory = categories[minimumIndex].key;
      lotCategory = adjustedLotCategory;
      lotCategoryGuardrailApplied = true;
      manualReviewReasons.push('mosquito_lot_category_guardrail_applied');
    }
  }

  return {
    lotCategory,
    grossLotCategory,
    lotCategorySource,
    lotCategoryGuardrailApplied,
    originalLotCategory,
    adjustedLotCategory,
    manualReviewReasons: uniqueList(manualReviewReasons),
    warnings: uniqueList(warnings),
  };
}

function calculatePropertyProfile(input) {
  const explicitFootprint = toPositiveNumber(input.footprintSqFt ?? input.footprint);
  const footprint = explicitFootprint || calculateFootprint(input.homeSqFt, input.stories || 1);
  const explicitPerimeter = toPositiveNumber(input.perimeterLF ?? input.perimeterLf ?? input.perimeter);
  const normalizedFeatures = normalizeFeatureInputs(input);
  const hardscape = estimateHardscape(input.lotSqFt, input.propertyType, normalizedFeatures);
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
  const features = { ...normalizedFeatures, bedRatio };
  const legacyLawnEstimate = estimateLawnSqFt(input.lotSqFt, footprint, hardscape, features);
  const hasPlausibleMaxTurfSf = toPositiveNumber(input.lotSqFt) > 0;
  const plausibleMaxTurfSf = Math.max(0, Math.round((Number(input.lotSqFt) || 0) - footprint - hardscape));
  const turfArea = computeTurfArea(
    { ...turfInput, maxEstimatedTurfSf: plausibleMaxTurfSf, maxEstimatedTurfSfKnown: hasPlausibleMaxTurfSf },
    { turfSf: legacyLawnEstimate }
  );
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
      features.shrubs,
      features.complexity,
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
  const perimeter = explicitPerimeter || calculatePerimeter(footprint, features.complexity);
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
    features,
    // v2 enriched fields — consumed by modifiers.deriveModifiers()
    yearBuilt: input.yearBuilt || null,
    constructionMaterial: input.constructionMaterial || null,
    foundationType: input.foundationType || null,
    roofType: input.roofType || null,
    nearWater: input.nearWater || (features.nearWater ? 'CLOSE' : 'NONE'),
    waterDistance: input.waterDistance || null,
    isHOA: !!input.isHOA,
    hoaFee: input.hoaFee || null,
    isRental: !!input.isRental,
    isNewHomeowner: !!input.isNewHomeowner,
    fenceType: input.fenceType || null,
    outbuildingCount: input.outbuildingCount || 0,
    attachedGarage: !!features.attachedGarage,
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
  getLotCategory, getMosquitoTreatableCategory, deriveMosquitoLotCategoryFromArea,
  resolveMosquitoTreatableArea, resolveMosquitoLotCategory, calculatePropertyProfile,
};
