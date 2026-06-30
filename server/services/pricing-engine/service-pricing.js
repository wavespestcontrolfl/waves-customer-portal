// ============================================================
// service-pricing.js — All service line pricing calculations
// ============================================================
const {
  GLOBAL, PROPERTY_TYPE_ADJ, PEST, LAWN_TIERS, LAWN_SOLD_TIERS, LAWN_PRICING_V2, LAWN_FREQS,
  LAWN_TABLE_MAX_SQFT, LAWN_TRACK_DISPLAY, GRASS_TYPE_ALIASES, LAWN_BRACKETS,
  TREE_SHRUB, COMMERCIAL_LAWN, COMMERCIAL_TREE_SHRUB, COMMERCIAL_PEST,
  COMMERCIAL_MOSQUITO, COMMERCIAL_TERMITE_BAIT, COMMERCIAL_RODENT_BAIT,
  BED_DENSITY, BED_AREA_CAP, PALM, MOSQUITO, TERMITE, RODENT, ONE_TIME, SPECIALTY, BED_BUG, URGENCY,
  WAVEGUARD,
} = require('./constants');
const {
  resolveMosquitoTreatableArea,
  resolveMosquitoLotCategory,
} = require('./property-calculator');
// Single source of truth for the Lawn V2 cost-floor math, shared with the client
// estimate preview so the shown price and the billed price cannot drift.
const {
  lawnMaterialBudget,
  lawnMaterialCostPerVisit,
  lawnComplexityMinutes,
  computeLawnCostFloor,
} = require('@waves/lawn-cost-floor');

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundRatio(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

// ── Utility: Linear interpolation between brackets ────────────
function interpolate(value, brackets, valueKey = 0, resultKey = 1) {
  if (!brackets.length) return 0;
  if (value <= brackets[0][valueKey]) return brackets[0][resultKey];
  if (value >= brackets[brackets.length - 1][valueKey]) return brackets[brackets.length - 1][resultKey];
  for (let i = 0; i < brackets.length - 1; i++) {
    const lo = brackets[i], hi = brackets[i + 1];
    if (value >= lo[valueKey] && value <= hi[valueKey]) {
      const span = hi[valueKey] - lo[valueKey];
      if (span === 0) return lo[resultKey];
      const ratio = (value - lo[valueKey]) / span;
      return lo[resultKey] + ratio * (hi[resultKey] - lo[resultKey]);
    }
  }
  return brackets[brackets.length - 1][resultKey];
}

// ── Labor cost helper ─────────────────────────────────────────
function laborCost(onSiteMinutes) {
  return GLOBAL.LABOR_RATE * (GLOBAL.DRIVE_TIME + onSiteMinutes) / 60;
}

function uniqueList(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function positiveFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function parsePositiveMeasurement(value) {
  return positiveFiniteNumber(value);
}

function parseNonNegativeMeasurement(value) {
  if (!hasValue(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function positiveStories(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function livingAreaToFootprint(value, stories) {
  const parsed = positiveFiniteNumber(value);
  if (parsed === null) return null;
  return Math.max(1, Math.round(parsed / positiveStories(stories)));
}

function optionMeasurements(options = {}) {
  return options && typeof options.measurements === 'object' && options.measurements !== null
    ? options.measurements
    : {};
}

function collectManualOverride(options = {}, fieldNames = []) {
  const measurements = optionMeasurements(options);
  for (const field of fieldNames) {
    if (hasValue(options[field])) return options[field];
    if (hasValue(measurements[field])) return measurements[field];
  }
  return undefined;
}

function resolvePositiveMeasurement({
  manualValue,
  propertySources = [],
  manualReason = 'termite_measurement_manual_override_used',
  missingReason,
  invalidReason,
  manualSource = 'manual_override',
}) {
  const warnings = [];
  const manualReviewReasons = [];

  if (hasValue(manualValue)) {
    const parsed = parsePositiveMeasurement(manualValue);
    if (parsed !== null) {
      warnings.push(manualReason);
      manualReviewReasons.push(manualReason);
      return {
        value: parsed,
        source: manualSource,
        wasDefaulted: false,
        wasManualOverride: true,
        requiresMeasurement: false,
        requiresManualReview: true,
        manualReviewReasons,
        warnings,
      };
    }
    warnings.push(invalidReason);
    manualReviewReasons.push(invalidReason);
    return {
      value: null,
      source: manualSource,
      wasDefaulted: false,
      wasManualOverride: true,
      requiresMeasurement: true,
      requiresManualReview: true,
      manualReviewReasons,
      warnings,
    };
  }

  let sawInvalidPropertyValue = false;
  for (const [source, rawValue] of propertySources) {
    if (!hasValue(rawValue)) continue;
    const parsed = parsePositiveMeasurement(rawValue);
    if (parsed !== null) {
      return {
        value: parsed,
        source,
        wasDefaulted: false,
        wasManualOverride: false,
        requiresMeasurement: false,
        requiresManualReview: false,
        manualReviewReasons,
        warnings,
      };
    }
    sawInvalidPropertyValue = true;
  }

  const reason = sawInvalidPropertyValue ? invalidReason : missingReason;
  warnings.push(reason);
  manualReviewReasons.push(reason);
  return {
    value: null,
    source: 'missing',
    wasDefaulted: false,
    wasManualOverride: false,
    requiresMeasurement: true,
    requiresManualReview: true,
    manualReviewReasons,
    warnings,
  };
}

function normalizeTermiteComplexity(property = {}, options = {}) {
  const raw = normalizeToken(options.complexity || options.layoutComplexity || property.features?.complexity);
  if (raw === 'complex' || raw === 'moderate') return raw;
  return 'standard';
}

function normalizeTermiteSystem(value) {
  const requestedSystem = value;
  const raw = normalizeToken(value || 'advance');
  const aliases = {
    advance: 'advance',
    advanced: 'advance',
    active: 'advance',
    sentricon: 'advance',
    sentricon_recruit_hd: 'advance',
    trelona: 'trelona',
  };
  const selectedSystem = aliases[raw] || 'advance';
  const warnings = raw && !aliases[raw] ? ['invalid_termite_system_defaulted_to_advance'] : [];
  return { requestedSystem, selectedSystem, warnings };
}

function normalizeTermiteMonitoringTier(value) {
  const requestedMonitoringTier = value;
  const raw = normalizeToken(value || 'basic');
  const aliases = {
    basic: 'basic',
    standard: 'basic',
    premier: 'premier',
    premium: 'premier',
  };
  const selectedMonitoringTier = aliases[raw] || 'basic';
  const warnings = raw && !aliases[raw] ? ['invalid_termite_monitoring_tier_defaulted_to_basic'] : [];
  return { requestedMonitoringTier, selectedMonitoringTier, warnings };
}

function normalizePositiveTermiteModifier(value, fallback, warningName) {
  if (!hasValue(value)) return { value: fallback, warnings: [] };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { value: fallback, warnings: [warningName] };
  }
  return { value: parsed, warnings: [] };
}

function normalizeFiniteTermiteModifier(value, fallback, warningName) {
  if (!hasValue(value)) return { value: fallback, warnings: [] };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return { value: fallback, warnings: [warningName] };
  return { value: parsed, warnings: [] };
}

function measurementObject(value, source) {
  return { value, source: source || 'missing' };
}

function mergeMeasurementState(...states) {
  const warnings = uniqueList(states.flatMap(s => s?.warnings || []));
  const manualReviewReasons = uniqueList(states.flatMap(s => s?.manualReviewReasons || []));
  return {
    warnings,
    manualReviewReasons,
    requiresMeasurement: states.some(s => !!s?.requiresMeasurement),
    requiresManualReview: states.some(s => !!s?.requiresManualReview),
  };
}

function resolveTermiteFootprint(property = {}, options = {}) {
  const manualValue = collectManualOverride(options, ['footprintSqFt', 'footprint', 'buildingFootprintSqFt']);
  return resolvePositiveMeasurement({
    manualValue,
    missingReason: 'missing_termite_footprint',
    invalidReason: 'invalid_termite_footprint',
    propertySources: [
      ['property_footprint', property.footprint],
      ['property_footprint', property.footprintSqFt],
      ['property_alias', property.buildingFootprintSqFt],
      ['property_alias', property.structureFootprintSqFt],
      ['property_alias', property.livingAreaSqFt],
      ['property_alias', property.homeSqFt],
      ['property_alias', property.buildingSqFt],
    ],
  });
}

function resolveTermiteBaitPerimeter(property = {}, options = {}) {
  const manualValue = collectManualOverride(options, ['perimeterLF', 'perimeterLf', 'perimeter']);
  if (hasValue(manualValue)) {
    return resolvePositiveMeasurement({
      manualValue,
      missingReason: 'missing_termite_perimeter_lf',
      invalidReason: 'invalid_termite_perimeter_lf',
      manualReason: 'termite_perimeter_manual_override_used',
      propertySources: [],
    });
  }

  const propertyPerimeterWarnings = [];
  const propertyPerimeterReasons = [];
  const propertyPerimeterSources = [
    ['property_perimeter', property.perimeterLF],
    ['property_perimeter', property.perimeterLf],
    [property.perimeterSource || 'property_perimeter', property.perimeter],
  ];
  for (const [source, rawValue] of propertyPerimeterSources) {
    if (!hasValue(rawValue) || source === 'computed_from_footprint') continue;
    const parsed = parsePositiveMeasurement(rawValue);
    if (parsed !== null) {
      return {
        value: parsed,
        source: 'property_perimeter',
        wasDefaulted: false,
        wasManualOverride: false,
        requiresMeasurement: false,
        requiresManualReview: false,
        manualReviewReasons: [],
        warnings: [],
      };
    }
    propertyPerimeterWarnings.push('invalid_termite_perimeter_lf');
    propertyPerimeterReasons.push('invalid_termite_perimeter_lf');
  }

  const footprintResolution = resolveTermiteFootprint(property, options);
  if (footprintResolution.value === null) return footprintResolution;

  const complexity = normalizeTermiteComplexity(property, options);
  const perimMult = (complexity === 'complex' || complexity === 'moderate')
    ? TERMITE.perimeterMultiplier.complex
    : TERMITE.perimeterMultiplier.standard;
  return {
    value: Math.round(4 * Math.sqrt(footprintResolution.value) * perimMult),
    source: 'computed_from_footprint',
    wasDefaulted: false,
    wasManualOverride: false,
    requiresMeasurement: false,
    requiresManualReview: footprintResolution.requiresManualReview || propertyPerimeterReasons.length > 0,
    manualReviewReasons: uniqueList([...footprintResolution.manualReviewReasons, ...propertyPerimeterReasons]),
    warnings: uniqueList([...footprintResolution.warnings, ...propertyPerimeterWarnings]),
    computedFromFootprintSqFt: footprintResolution.value,
  };
}

function resolvePropertyPerimeter(property = {}, options = {}) {
  const allowComputedPerimeter = !!(
    options.allowComputedPerimeterFromFootprint ||
    options.estimateFromFootprint ||
    options.useComputedPerimeter
  );
  const perimeterSourceIsComputed = property.perimeterSource === 'computed_from_footprint';
  const propertyPerimeter = perimeterSourceIsComputed && !allowComputedPerimeter
    ? undefined
    : property.perimeter;
  return resolvePositiveMeasurement({
    manualValue: collectManualOverride(options, ['perimeterLF', 'perimeterLf', 'perimeter']),
    missingReason: 'missing_termite_perimeter_lf',
    invalidReason: 'invalid_termite_perimeter_lf',
    manualReason: 'perimeter_lf_manual_override_used',
    propertySources: [
      [perimeterSourceIsComputed ? 'computed_from_footprint' : 'property_perimeter', propertyPerimeter],
      ['property_perimeter', property.perimeterLF],
      ['property_perimeter', property.perimeterLf],
    ],
  });
}

function normalizeConcretePct(value) {
  if (!hasValue(value)) return null;
  let parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return { value: null, warnings: ['invalid_trenching_concrete_pct'] };
  if (parsed > 1) parsed /= 100;
  if (parsed > SPECIALTY.trenching.concretePctCap) {
    return {
      value: SPECIALTY.trenching.concretePctCap,
      warnings: ['concrete_pct_clamped'],
    };
  }
  return { value: parsed, warnings: [] };
}

function resolveFeatureConcretePct(property = {}) {
  const f = property.features || {};
  let concretePct = SPECIALTY.trenching.concretePctBase;
  if (f.poolCage) concretePct = SPECIALTY.trenching.concretePctCage;
  else if (f.pool) concretePct = SPECIALTY.trenching.concretePctPool;
  if (f.largeDriveway) concretePct += SPECIALTY.trenching.concretePctDriveway;
  return Math.min(concretePct, SPECIALTY.trenching.concretePctCap);
}

function resolveTrenchingMeasurements(property = {}, options = {}) {
  const perimeterResolution = resolvePropertyPerimeter(property, options);
  const warnings = [...perimeterResolution.warnings];
  const manualReviewReasons = [...perimeterResolution.manualReviewReasons];

  if (perimeterResolution.value === null) {
    return {
      perimeter: null,
      perimeterSource: perimeterResolution.source,
      perimeterWasManualOverride: perimeterResolution.wasManualOverride,
      concretePct: null,
      concretePctSource: 'missing',
      concreteLF: null,
      concreteLFSource: 'missing',
      dirtLF: null,
      dirtLFSource: 'missing',
      measurementWarnings: uniqueList(warnings),
      requiresMeasurement: true,
      requiresManualReview: true,
      manualReviewReasons: uniqueList(manualReviewReasons),
    };
  }

  const perimeter = perimeterResolution.value;
  const manualConcreteLF = collectManualOverride(options, ['concreteLF', 'concreteLf', 'concreteSlabLF', 'slabDrillLF']);
  const manualDirtLF = collectManualOverride(options, ['dirtLF', 'dirtLf']);
  const manualConcretePct = collectManualOverride(options, ['concretePct', 'concretePercentage']);
  let concreteLF = null;
  let concreteLFSource = 'missing';
  let dirtLF = null;
  let dirtLFSource = 'missing';
  let concretePct = null;
  let concretePctSource = 'missing';
  let invalidConcreteLF = false;
  let invalidDirtLF = false;

  if (hasValue(manualConcreteLF)) {
    const parsedConcreteLF = parseNonNegativeMeasurement(manualConcreteLF);
    if (parsedConcreteLF === null) {
      warnings.push('invalid_trenching_concrete_lf');
      manualReviewReasons.push('invalid_trenching_concrete_lf');
      invalidConcreteLF = true;
    } else if (parsedConcreteLF > perimeter) {
      warnings.push('concrete_lf_exceeds_perimeter');
      manualReviewReasons.push('concrete_lf_exceeds_perimeter');
      invalidConcreteLF = true;
      concreteLF = parsedConcreteLF;
      concreteLFSource = 'manual_override';
    } else {
      concreteLF = parsedConcreteLF;
      concreteLFSource = 'manual_override';
      concretePct = roundRatio(concreteLF / perimeter);
      concretePctSource = 'manual_override';
      dirtLF = Math.max(0, Math.round(perimeter - concreteLF));
      dirtLFSource = 'derived_from_perimeter_minus_concrete_lf';
      warnings.push('concrete_lf_manual_override_used');
      manualReviewReasons.push('concrete_lf_manual_override_used');
    }
  }

  if (!invalidConcreteLF && concreteLF === null && hasValue(manualDirtLF)) {
    const parsedDirtLF = parseNonNegativeMeasurement(manualDirtLF);
    if (parsedDirtLF === null || parsedDirtLF > perimeter) {
      warnings.push('invalid_trenching_dirt_lf');
      manualReviewReasons.push('invalid_trenching_dirt_lf');
      invalidDirtLF = true;
    } else {
      dirtLF = parsedDirtLF;
      dirtLFSource = 'manual_override';
      concreteLF = Math.max(0, Math.round(perimeter - dirtLF));
      concreteLFSource = 'derived_from_perimeter_minus_dirt_lf';
      concretePct = roundRatio(concreteLF / perimeter);
      concretePctSource = 'derived_from_dirt_lf';
      warnings.push('termite_measurement_manual_override_used');
      manualReviewReasons.push('termite_measurement_manual_override_used');
    }
  }

  if (!invalidConcreteLF && !invalidDirtLF && hasValue(manualConcreteLF) && hasValue(manualDirtLF)) {
    const parsedConcreteLF = parseNonNegativeMeasurement(manualConcreteLF);
    const parsedDirtLF = parseNonNegativeMeasurement(manualDirtLF);
    if (parsedConcreteLF !== null && parsedDirtLF !== null && Math.abs((parsedConcreteLF + parsedDirtLF) - perimeter) > 5) {
      warnings.push('trenching_lf_sum_mismatch');
      manualReviewReasons.push('trenching_lf_sum_mismatch');
    }
  }

  if (!invalidConcreteLF && !invalidDirtLF && concreteLF === null) {
    const normalizedPct = normalizeConcretePct(manualConcretePct);
    if (normalizedPct && normalizedPct.value !== null) {
      concretePct = normalizedPct.value;
      concretePctSource = 'manual_override';
      warnings.push(...normalizedPct.warnings, 'termite_measurement_manual_override_used');
      manualReviewReasons.push(...normalizedPct.warnings, 'termite_measurement_manual_override_used');
    } else if (normalizedPct && normalizedPct.value === null) {
      warnings.push(...normalizedPct.warnings);
      manualReviewReasons.push(...normalizedPct.warnings);
      concretePct = resolveFeatureConcretePct(property);
      concretePctSource = 'feature_estimate';
    } else {
      concretePct = resolveFeatureConcretePct(property);
      concretePctSource = 'feature_estimate';
    }
    concretePct = roundRatio(concretePct);
    concreteLF = Math.round(perimeter * concretePct);
    concreteLFSource = concretePctSource === 'manual_override' ? 'derived_from_manual_pct' : 'feature_estimate';
    dirtLF = Math.round(perimeter * (1 - concretePct));
    dirtLFSource = concretePctSource === 'manual_override' ? 'derived_from_manual_pct' : 'feature_estimate';
  }

  const requiresMeasurement = invalidConcreteLF || invalidDirtLF || perimeterResolution.requiresMeasurement;
  const requiresManualReview = requiresMeasurement || warnings.length > 0 || perimeterResolution.requiresManualReview;
  return {
    perimeter,
    perimeterSource: perimeterResolution.source,
    perimeterWasManualOverride: perimeterResolution.wasManualOverride,
    concretePct,
    concretePctSource,
    concreteLF,
    concreteLFSource,
    dirtLF,
    dirtLFSource,
    measurementWarnings: uniqueList(warnings),
    requiresMeasurement,
    requiresManualReview,
    manualReviewReasons: uniqueList(manualReviewReasons),
  };
}

function resolveBoraCareSqFt(input, options = {}) {
  if (typeof input !== 'object' && hasValue(input)) {
    const parsed = parsePositiveMeasurement(input);
    if (parsed !== null) {
      return {
        value: parsed,
        source: 'direct_argument',
        wasDefaulted: false,
        wasManualOverride: false,
        requiresMeasurement: false,
        requiresManualReview: false,
        manualReviewReasons: [],
        warnings: [],
      };
    }
    return {
      value: null,
      source: 'direct_argument',
      wasDefaulted: false,
      wasManualOverride: false,
      requiresMeasurement: true,
      requiresManualReview: true,
      manualReviewReasons: ['invalid_boracare_attic_sqft'],
      warnings: ['invalid_boracare_attic_sqft'],
    };
  }
  const property = input && typeof input === 'object' ? input : {};
  const manualValue = collectManualOverride(options, ['atticSqFt', 'atticAreaSqFt', 'rawWoodSqFt', 'woodTreatmentSqFt']);
  return resolvePositiveMeasurement({
    manualValue,
    missingReason: 'missing_boracare_attic_sqft',
    invalidReason: 'invalid_boracare_attic_sqft',
    propertySources: [
      ['property_attic_sqft', property.atticSqFt],
      ['property_attic_sqft', property.atticAreaSqFt],
      ['property_alias', property.rawWoodSqFt],
      ['property_alias', property.woodTreatmentSqFt],
    ],
  });
}

// Surface treatment is measured by linear feet of an accessible run (wall,
// foundation, framing, block), converted to treatable area via surface height
// (linear ft × height). The result is folded into the BoraCare area so
// coverage/labor/margin math is unchanged. Returns surfaceSqFt 0 (and no
// warnings) when no surface input is present — surface treatment is optional.
// Legacy `wall*` aliases are still accepted on input for back-compat.
function resolveBoraCareSurfaceSqFt(input, options = {}) {
  const property = input && typeof input === 'object' ? input : {};
  const linearRaw = collectManualOverride(options, ['surfaceLinearFt', 'boraCareSurfaceLinearFt', 'surfaceLinealFt', 'surfaceLF', 'wallLinearFt', 'boraCareWallLinearFt', 'wallLinealFt', 'wallLF'])
    ?? (hasValue(property.surfaceLinearFt) ? property.surfaceLinearFt : undefined)
    ?? (hasValue(property.boraCareSurfaceLinearFt) ? property.boraCareSurfaceLinearFt : undefined)
    ?? (hasValue(property.wallLinearFt) ? property.wallLinearFt : undefined)
    ?? (hasValue(property.boraCareWallLinearFt) ? property.boraCareWallLinearFt : undefined);

  if (!hasValue(linearRaw)) {
    return { surfaceSqFt: 0, surfaceLinearFt: null, surfaceHeightFt: null, source: 'none', warnings: [], invalid: false, heightInvalid: false };
  }

  const linear = parsePositiveMeasurement(linearRaw);
  if (linear === null) {
    return {
      surfaceSqFt: 0,
      surfaceLinearFt: null,
      surfaceHeightFt: null,
      source: 'invalid',
      warnings: ['invalid_boracare_surface_linear_ft'],
      invalid: true,
      heightInvalid: false,
    };
  }

  const heightRaw = collectManualOverride(options, ['surfaceHeightFt', 'boraCareSurfaceHeightFt', 'wallHeightFt', 'boraCareWallHeightFt'])
    ?? (hasValue(property.surfaceHeightFt) ? property.surfaceHeightFt : undefined)
    ?? (hasValue(property.boraCareSurfaceHeightFt) ? property.boraCareSurfaceHeightFt : undefined)
    ?? (hasValue(property.wallHeightFt) ? property.wallHeightFt : undefined)
    ?? (hasValue(property.boraCareWallHeightFt) ? property.boraCareWallHeightFt : undefined);

  const warnings = [];
  let heightInvalid = false;
  let height = parsePositiveMeasurement(heightRaw);
  if (height === null) {
    // A provided-but-invalid height (0, negative, non-numeric) defaults to 8 ft
    // but is flagged for review so the bad measurement is not silently priced.
    if (hasValue(heightRaw)) {
      warnings.push('invalid_boracare_surface_height_defaulted');
      heightInvalid = true;
    }
    height = SPECIALTY.boraCare.defaultSurfaceHeightFt;
  }

  return {
    surfaceSqFt: linear * height,
    surfaceLinearFt: linear,
    surfaceHeightFt: height,
    source: 'surface_linear_ft',
    warnings,
    invalid: false,
    heightInvalid,
  };
}

function resolvePreSlabSqFt(input, options = {}) {
  if (typeof input !== 'object' && hasValue(input)) {
    const parsed = parsePositiveMeasurement(input);
    if (parsed !== null) {
      return {
        value: parsed,
        source: 'direct_argument',
        wasDefaulted: false,
        wasManualOverride: false,
        requiresMeasurement: false,
        requiresManualReview: false,
        manualReviewReasons: [],
        warnings: [],
      };
    }
    return {
      value: null,
      source: 'direct_argument',
      wasDefaulted: false,
      wasManualOverride: false,
      requiresMeasurement: true,
      requiresManualReview: true,
      manualReviewReasons: ['invalid_pre_slab_sqft'],
      warnings: ['invalid_pre_slab_sqft'],
    };
  }
  const property = input && typeof input === 'object' ? input : {};
  const manualValue = collectManualOverride(options, ['slabSqFt', 'foundationSqFt', 'buildingSlabSqFt', 'newConstructionSlabSqFt']);
  return resolvePositiveMeasurement({
    manualValue,
    missingReason: 'missing_pre_slab_sqft',
    invalidReason: 'invalid_pre_slab_sqft',
    propertySources: [
      ['property_slab_sqft', property.slabSqFt],
      ['property_alias', property.foundationSqFt],
      ['property_alias', property.buildingSlabSqFt],
      ['property_alias', property.newConstructionSlabSqFt],
    ],
  });
}

function normalizePreSlabVolumeDiscount(value) {
  const requestedVolumeDiscount = value;
  const raw = normalizeToken(value || 'none');
  const aliases = {
    none: 'none',
    no_discount: 'none',
    '5': '5plus',
    '5plus': '5plus',
    '5_plus': '5plus',
    '5+': '5plus',
    five_plus: '5plus',
    fiveplus: '5plus',
    '10': '10plus',
    '10plus': '10plus',
    '10_plus': '10plus',
    '10+': '10plus',
    ten_plus: '10plus',
    tenplus: '10plus',
  };
  const volumeDiscount = aliases[raw] || 'none';
  return {
    requestedVolumeDiscount,
    volumeDiscount,
    warnings: raw && !aliases[raw] ? ['invalid_pre_slab_volume_discount_defaulted_to_none'] : [],
  };
}

function normalizePreSlabWarranty(value) {
  const requestedWarrantyTier = value;
  const raw = normalizeToken(value || 'basic');
  const aliases = {
    none: 'none',
    no: 'none',
    no_warranty: 'none',
    basic: 'basic',
    basic_1yr: 'basic',
    basic_1_year: 'basic',
    one_year: 'basic',
    one_year_included: 'basic',
    included: 'basic',
    extended: 'extended',
    extended_5yr: 'extended',
    extended_5_year: 'extended',
    five_year: 'extended',
    five_year_extended: 'extended',
    '5yr': 'extended',
    '5_year': 'extended',
  };
  const warrantyTier = aliases[raw] || 'basic';
  const labels = {
    none: 'No warranty',
    basic: 'Basic 1-yr warranty',
    extended: 'Extended 5-yr warranty',
  };
  return {
    requestedWarrantyTier,
    warrantyTier,
    warrantyLabel: labels[warrantyTier],
    warnings: raw && !aliases[raw] ? ['invalid_pre_slab_warranty_defaulted_to_basic'] : [],
  };
}

function normalizePreSlabJobContext(value, volumeDiscount = 'none') {
  const requestedJobContext = value;
  const raw = normalizeToken(value || '');
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
  const jobContext = aliases[raw] || (
    volumeDiscount === '5plus' || volumeDiscount === '10plus' ? 'builderBatch' : 'standalone'
  );
  return {
    requestedJobContext,
    jobContext,
    warnings: raw && !aliases[raw] ? ['invalid_pre_slab_job_context_defaulted'] : [],
  };
}

function lookupPreSlabMinimum(slabSqFt, jobContext) {
  const cfg = SPECIALTY.preSlabTermiticide || {};
  const minimums = cfg.minimums || {};
  const tiers = minimums[jobContext] || minimums.standalone || [{ maxSqFt: Infinity, floor: 600 }];
  const tier = tiers.find(row => Number(slabSqFt) <= Number(row.maxSqFt)) || tiers[tiers.length - 1];
  const labels = {
    standalone: 'Standalone one-off job',
    builderBatch: 'Builder batch / same site',
    sameTripAddOn: 'Same-trip add-on',
  };
  return {
    floor: Number(tier.floor) || 0,
    maxSqFt: tier.maxSqFt,
    basis: `${labels[jobContext] || labels.standalone}, ${Number(tier.maxSqFt) === Infinity ? 'over 1,250' : `up to ${tier.maxSqFt}`} sqft`,
  };
}

function normalizePreSlabTermiticideProduct(value, options = {}) {
  const cfg = SPECIALTY.preSlabTermiticide || {};
  const requestedProductKey = value;
  const defaultProductKey = cfg.defaultProductKey || 'termidor_sc';
  if (!hasValue(value)) {
    return {
      requestedProductKey,
      productKey: defaultProductKey,
      warnings: [],
      requiresManualReview: false,
      manualReviewReasons: [],
    };
  }

  const raw = normalizeToken(value).replace(/\//g, '_').replace(/_+/g, '_');
  const aliases = {
    termidor: 'termidor_sc',
    termidor_sc: 'termidor_sc',
    taurus: 'taurus_sc',
    taurus_sc: 'taurus_sc',
    bifen: 'bifen_it',
    bifen_it: 'bifen_it',
    bifen_i_t: 'bifen_it',
    talstar: 'talstar_p',
    talstar_p: 'talstar_p',
    talstar_professional: 'talstar_p',
  };
  if (options.legacyPayload || options.allowIngredientAliases) {
    aliases.fipronil = 'termidor_sc';
    aliases.bifenthrin = 'bifen_it';
  }
  const productKey = aliases[raw];
  if (productKey && cfg.products?.[productKey]) {
    return {
      requestedProductKey,
      productKey,
      warnings: [],
      requiresManualReview: false,
      manualReviewReasons: [],
    };
  }

  const warning = options.legacyPayload
    ? 'unknown_legacy_pre_slab_product_defaulted_to_termidor_sc'
    : 'unknown_pre_slab_termiticide_product_requires_review';
  return {
    requestedProductKey,
    productKey: defaultProductKey,
    warnings: [warning],
    requiresManualReview: !options.legacyPayload,
    manualReviewReasons: options.legacyPayload ? [] : ['invalid_pre_slab_termiticide_product'],
  };
}

function optionPositiveNumber(options = {}, key, fallback) {
  const parsed = positiveFiniteNumber(options[key]);
  return parsed !== null ? parsed : fallback;
}

function optionNonNegativeNumber(options = {}, key, fallback) {
  if (!hasValue(options[key])) return fallback;
  const parsed = Number(options[key]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionBooleanTrue(value) {
  return value === true || value === 'true' || value === 'TRUE' || value === 'YES' || value === 'yes';
}

function resolvePestFootprint(property = {}, options = {}) {
  const fallback = positiveFiniteNumber(options.fallback) || 2000;
  const manualReviewReasons = [];
  const warnings = [];
  const aliases = [
    ['footprint', property.footprint, positiveFiniteNumber],
    ['footprintSqFt', property.footprintSqFt, positiveFiniteNumber],
    ['homeSqFt', property.homeSqFt, value => livingAreaToFootprint(value, property.stories)],
    ['buildingSqFt', property.buildingSqFt, positiveFiniteNumber],
    ['livingAreaSqFt', property.livingAreaSqFt, value => livingAreaToFootprint(value, property.stories)],
  ];

  for (const [source, value, parser] of aliases) {
    const parsed = parser(value);
    if (parsed !== null) {
      return {
        footprint: parsed,
        source,
        wasDefaulted: false,
        requiresManualReview: false,
        manualReviewReasons,
        warnings,
      };
    }
  }

  const hadInvalidFootprint = aliases.some(([, value]) => hasValue(value));
  const reason = hadInvalidFootprint
    ? 'invalid_or_zero_pest_footprint'
    : 'missing_pest_footprint_fallback';
  manualReviewReasons.push(reason);
  warnings.push(reason);

  return {
    footprint: fallback,
    source: hadInvalidFootprint ? 'invalid_or_zero_footprint_fallback' : 'fallback_2000',
    wasDefaulted: true,
    requiresManualReview: true,
    manualReviewReasons,
    warnings,
  };
}

function normalizePestFrequency(value) {
  const requestedFrequency = value;
  const raw = normalizeToken(value);
  const aliases = {
    qtr: 'quarterly',
    quarter: 'quarterly',
    quarterly: 'quarterly',
    bi_monthly: 'bimonthly',
    bimonthly: 'bimonthly',
    every_other_month: 'bimonthly',
    monthly: 'monthly',
  };
  const frequency = aliases[raw] || 'quarterly';
  const frequencyWasDefaulted = raw ? !aliases[raw] : true;
  const frequencyWarnings = raw && !aliases[raw]
    ? ['invalid_pest_frequency_defaulted_to_quarterly']
    : [];
  return {
    requestedFrequency,
    frequency,
    frequencyWasDefaulted,
    frequencyWarnings,
    frequencySource: frequencyWasDefaulted ? 'defaulted' : 'requested',
  };
}

function normalizePestPricingVersion(value) {
  const requestedPricingVersion = value;
  const raw = normalizeToken(value);
  const allowed = { v1: 'v1', v2: 'v2' };
  const pricingVersion = allowed[raw] || 'v1';
  const pricingVersionWasDefaulted = raw ? !allowed[raw] : true;
  const pricingVersionWarnings = raw && !allowed[raw]
    ? ['invalid_pest_pricing_version_defaulted_to_v1']
    : [];
  return {
    requestedPricingVersion,
    pricingVersion,
    pricingVersionWasDefaulted,
    pricingVersionWarnings,
    pricingVersionSource: pricingVersionWasDefaulted ? 'defaulted' : 'requested',
  };
}

function normalizeRoachType(value) {
  const requestedRoachType = value;
  const raw = normalizeToken(value);
  const aliases = {
    none: 'none',
    no: 'none',
    false: 'none',
    regular: 'regular',
    palmetto: 'regular',
    american: 'regular',
    smoky: 'regular',
    smoky_brown: 'regular',
    australian: 'regular',
    florida_woods: 'regular',
    native: 'regular',
    roach: 'regular',
    cockroach: 'regular',
    german: 'german',
    kitchen: 'german',
    small_indoor: 'german',
    german_roach: 'german',
    german_cockroach: 'german',
  };
  const roachType = aliases[raw] || 'none';
  const roachTypeWasDefaulted = raw ? !aliases[raw] : true;
  const roachWarnings = raw && !aliases[raw]
    ? ['invalid_roach_type_defaulted_to_none']
    : [];
  return {
    requestedRoachType,
    roachType,
    roachTypeWasDefaulted,
    roachWarnings,
  };
}

function normalizeRoachSeverity(value) {
  const raw = normalizeToken(value);
  const aliases = {
    light: 'light',
    low: 'light',
    moderate: 'moderate',
    medium: 'moderate',
    heavy: 'heavy',
    high: 'heavy',
    severe: 'severe',
  };
  if (!raw) return { severity: null, warnings: [] };
  const severity = aliases[raw] || null;
  return {
    severity,
    warnings: severity ? [] : ['invalid_roach_severity_ignored'],
  };
}

function normalizePestDensity(value, field = 'density') {
  const raw = normalizeToken(value);
  const aliases = {
    none: 'none',
    no: 'none',
    light: 'light',
    low: 'light',
    sparse: 'light',
    moderate: 'moderate',
    medium: 'moderate',
    med: 'moderate',
    standard: 'moderate',
    heavy: 'heavy',
    high: 'heavy',
    dense: 'heavy',
  };
  const density = aliases[raw] || 'moderate';
  const defaulted = raw ? !aliases[raw] : false;
  const warning = field === 'trees'
    ? 'invalid_tree_density_defaulted_to_moderate'
    : field === 'shrubs'
      ? 'invalid_shrub_density_defaulted_to_moderate'
      : 'invalid_pest_density_defaulted_to_moderate';
  return {
    requested: value,
    value: density,
    wasDefaulted: defaulted,
    warnings: defaulted ? [warning] : [],
  };
}

function normalizePestComplexity(value) {
  const raw = normalizeToken(value);
  const aliases = {
    simple: 'simple',
    easy: 'simple',
    low: 'simple',
    moderate: 'moderate',
    medium: 'moderate',
    med: 'moderate',
    standard: 'moderate',
    normal: 'moderate',
    complex: 'complex',
    high: 'complex',
    heavy: 'complex',
  };
  const complexity = aliases[raw] || 'moderate';
  const defaulted = raw ? !aliases[raw] : false;
  return {
    requested: value,
    value: complexity,
    wasDefaulted: defaulted,
    warnings: defaulted ? ['invalid_pest_complexity_defaulted_to_moderate'] : [],
  };
}

function normalizePestPropertyType(value) {
  const requestedPropertyType = value;
  const raw = normalizeToken(value);
  const aliases = {
    single_family: 'single_family',
    singlefamily: 'single_family',
    townhouse_end: 'townhome_end',
    townhome_end: 'townhome_end',
    townhome_interior: 'townhome_interior',
    townhouse_interior: 'townhome_interior',
    duplex: 'duplex',
    condo_ground: 'condo_ground',
    ground_condo: 'condo_ground',
    condo_upper: 'condo_upper',
    upper_condo: 'condo_upper',
  };
  const propertyType = aliases[raw] || 'single_family';
  const propertyTypeWasDefaulted = raw ? !aliases[raw] : true;
  return {
    requestedPropertyType,
    propertyType,
    propertyTypeWasDefaulted,
    propertyTypeWarnings: raw && !aliases[raw]
      ? ['invalid_property_type_defaulted_to_single_family']
      : [],
  };
}

function normalizePestFeatures(features = {}) {
  const shrubs = normalizePestDensity(features.shrubs, 'shrubs');
  const trees = normalizePestDensity(features.trees, 'trees');
  const complexity = normalizePestComplexity(features.complexity);
  const featureWarnings = uniqueList([
    ...shrubs.warnings,
    ...trees.warnings,
    ...complexity.warnings,
  ]);

  return {
    normalizedFeatures: {
      ...features,
      shrubs: shrubs.value,
      trees: trees.value,
      complexity: complexity.value,
    },
    featureWarnings,
    featureNormalization: {
      shrubs,
      trees,
      complexity,
    },
  };
}

function normalizePestAgeAdjustment(value) {
  if (!hasValue(value)) {
    return { pestAgeAdj: 0, pestAgeAdjWarnings: [] };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return {
      pestAgeAdj: 0,
      pestAgeAdjWarnings: ['invalid_pest_age_adjustment_defaulted_to_zero'],
    };
  }
  const clamped = Math.max(-50, Math.min(75, parsed));
  return {
    pestAgeAdj: clamped,
    pestAgeAdjWarnings: clamped !== parsed ? ['pest_age_adjustment_clamped'] : [],
  };
}

function normalizePoolCageSize(value, hasPoolCage = false) {
  const raw = String(value || '').trim().toLowerCase();
  if (['small', 'medium', 'large', 'oversized'].includes(raw)) return raw;
  return hasPoolCage ? 'medium' : 'none';
}

function resolvePoolCagePricing(features = {}) {
  const hasPoolCage = !!features.poolCage;
  const rawSize = String(features.poolCageSize || '').trim().toLowerCase();
  if (!hasPoolCage) {
    return {
      adjustment: 0,
      poolCageSize: 'none',
      poolCageSizeSource: 'none',
      poolCageSizeInferred: false,
      warnings: [],
    };
  }
  const size = ['small', 'medium', 'large', 'oversized'].includes(rawSize) ? rawSize : null;
  if (!size) {
    return {
      adjustment: PEST.additionalAdjustments.poolCage || 0,
      poolCageSize: null,
      poolCageSizeSource: rawSize ? 'invalid' : 'missing',
      poolCageSizeInferred: true,
      warnings: ['pool_cage_size_missing_default_adjustment_used'],
    };
  }
  const key = {
    small: 'poolCageSmall',
    medium: 'poolCageMedium',
    large: 'poolCageLarge',
    oversized: 'poolCageOversized',
  }[size];
  return {
    adjustment: PEST.additionalAdjustments[key] ?? PEST.additionalAdjustments.poolCage,
    poolCageSize: size,
    poolCageSizeSource: 'explicit',
    poolCageSizeInferred: false,
    warnings: [],
  };
}

function poolCageAdjustment(features = {}) {
  return resolvePoolCagePricing(features).adjustment;
}

function hasAttachedGarageForPest(property = {}) {
  return !!(property.attachedGarage || property.features?.attachedGarage);
}

function mapPestProductionReason(reason) {
  return {
    stories_estimated: 'pest_production_stories_default_or_estimated',
    pool_cage_size_inferred: 'pest_pool_cage_size_inferred',
    large_lot: 'pest_large_lot_manual_review',
    very_large_lot: 'pest_low_confidence_large_lot',
    large_pool_cage: 'pest_large_or_oversized_pool_cage',
    oversized_pool_cage: 'pest_large_or_oversized_pool_cage',
    complex_heavy_vegetation: 'pest_complex_heavy_landscape',
    multiple_outbuildings: 'pest_multiple_outbuildings',
    estimated_service_time_45_plus: 'pest_estimated_minutes_above_manual_review_threshold',
    estimated_service_time_60_plus: 'pest_estimated_minutes_above_low_confidence_threshold',
  }[reason] || reason;
}

function combineManualReviewMetadata(...groups) {
  return uniqueList(groups.flatMap(group => group || []));
}

function confidenceRank(confidence) {
  return { high: 0, medium: 1, low: 2 }[confidence] ?? 0;
}

function lowerConfidence(a, b) {
  return confidenceRank(a) >= confidenceRank(b) ? a : b;
}

function calculatePestProductionDiagnostics(property) {
  const cfg = PEST.productionDiagnostics || {};
  const f = property.features || {};
  const footprint = Number(property.footprint) || 0;
  const lotSqFt = Number(property.lotSqFt) || 0;
  const homeSqFt = Number(property.homeSqFt) || 0;
  const storiesSource = String(property.storiesSource || '').toLowerCase();
  const poolCageSize = normalizePoolCageSize(f.poolCageSize, !!f.poolCage);
  const rawPoolCageSize = String(f.poolCageSize || '').trim().toLowerCase();
  const poolCageSizeInferred = !!f.poolCage && !['small', 'medium', 'large', 'oversized'].includes(rawPoolCageSize);
  const round1 = value => Math.round(value * 10) / 10;
  const outbuildingCount = Math.max(0, Math.floor(Number(property.outbuildingCount) || 0));

  const breakdown = {
    baseStop: cfg.baseStopMinutes || 20,
    footprint: round1(interpolate(footprint, cfg.footprintMinutes || [], 'sqft', 'minutes')),
    lot: round1(interpolate(lotSqFt, cfg.lotMinutes || [], 'sqft', 'minutes')),
    poolCage: f.poolCage ? (cfg.poolCageMinutes?.[poolCageSize] || 0) : 0,
    pool: !f.poolCage && f.pool ? (cfg.poolNoCageMinutes || 0) : 0,
    shrubs: cfg.shrubMinutes?.[f.shrubs] || 0,
    trees: cfg.treeMinutes?.[f.trees] || 0,
    complexity: cfg.complexityMinutes?.[f.complexity] || 0,
    largeDriveway: f.largeDriveway ? (cfg.largeDrivewayMinutes || 0) : 0,
    nearWater: f.nearWater ? (cfg.nearWaterMinutes || 0) : 0,
    attachedGarage: hasAttachedGarageForPest(property) ? (cfg.attachedGarageMinutes || 0) : 0,
    outbuildings: outbuildingCount * (cfg.outbuildingMinutes || 0),
  };

  const estimatedMinutes = Math.max(10, round1(Object.values(breakdown).reduce((sum, n) => sum + (Number(n) || 0), 0)));
  const manualReviewReasons = [];
  const lowConfidenceReasons = [];

  if (!homeSqFt || !footprint) lowConfidenceReasons.push('missing_home_sqft');
  if (!lotSqFt) lowConfidenceReasons.push('missing_lot_size');
  if (storiesSource === 'default' || storiesSource === 'estimated') manualReviewReasons.push('stories_estimated');
  if (poolCageSizeInferred) manualReviewReasons.push('pool_cage_size_inferred');
  if (lotSqFt > (cfg.lowConfidenceLotSqFt || 40000)) lowConfidenceReasons.push('very_large_lot');
  else if (lotSqFt > (cfg.manualReviewLotSqFt || 20000)) manualReviewReasons.push('large_lot');
  if (poolCageSize === 'oversized') lowConfidenceReasons.push('oversized_pool_cage');
  else if (poolCageSize === 'large') manualReviewReasons.push('large_pool_cage');
  if (f.complexity === 'complex' && (f.shrubs === 'heavy' || f.trees === 'heavy')) manualReviewReasons.push('complex_heavy_vegetation');
  if (outbuildingCount >= 2) manualReviewReasons.push('multiple_outbuildings');
  if (estimatedMinutes >= (cfg.lowConfidenceMinutes || 60)) lowConfidenceReasons.push('estimated_service_time_60_plus');
  else if (estimatedMinutes >= (cfg.manualReviewMinutes || 45)) manualReviewReasons.push('estimated_service_time_45_plus');

  const reviewReasons = [...new Set([...lowConfidenceReasons, ...manualReviewReasons])];
  const pricingConfidence = lowConfidenceReasons.length ? 'low' : manualReviewReasons.length ? 'medium' : 'high';

  return {
    estimatedMinutes,
    breakdown,
    poolCageSize,
    poolCageSizeSource: f.poolCage ? (poolCageSizeInferred ? 'inferred' : 'explicit') : 'none',
    poolCageSizeInferred,
    pricingMode: 'shadow_only',
    pricingConfidence,
    confidence: pricingConfidence,
    manualReview: reviewReasons.length > 0,
    reviewReasons,
    manualReviewReasons: reviewReasons,
    lowConfidenceReasons,
  };
}

// ── Urgency multiplier helper (matches v2 applyOT — urgency only, ────
// not recurring-customer discount which is handled by discount-engine) ─
function applyUrgency(price, urgency = 'ROUTINE', afterHours = false) {
  let mult = 1.0;
  if (urgency === 'SOON') mult = afterHours ? 1.50 : 1.25;
  else if (urgency === 'URGENT') mult = afterHours ? 2.0 : 1.50;
  return Math.round(price * mult);
}

function getOneTimeUrgencyMultiplier({ urgency = 'NONE', afterHours = false } = {}) {
  const key = String(urgency || 'NONE').toUpperCase();
  const cfg = URGENCY[key] || URGENCY.NONE;
  return afterHours ? (cfg.afterHours || cfg.standard || 1) : (cfg.standard || 1);
}

function applyOneTimeRecurringCustomerDiscount(price, { isRecurringCustomer = false } = {}) {
  const rate = isRecurringCustomer ? WAVEGUARD.recurringCustomerOneTimePerk : 0;
  const discounted = Math.round(price * (1 - rate));
  return {
    price: discounted,
    rate,
    amount: Math.max(0, Math.round(price) - discounted),
  };
}

function applyOneTimeFloor(price, floor) {
  return Math.max(floor, price);
}

function normalizeMosquitoProgramSelection(value) {
  const requestedTier = value;
  if (value == null || String(value).trim() === '') {
    return { requestedTier, normalizedRequestedTier: null, warnings: [] };
  }
  const raw = String(value).trim().toLowerCase();
  const aliases = {
    seasonal9: 'seasonal9',
    monthly12: 'monthly12',
    seasonal: 'seasonal9',
    monthly: 'monthly12',
    residual_seasonal: 'seasonal9',
    scion_seasonal: 'seasonal9',
    upgraded_seasonal: 'seasonal9',
    upgrade_seasonal: 'seasonal9',
    residual_monthly: 'monthly12',
    scion_monthly: 'monthly12',
    scion: 'monthly12',
    upgraded: 'monthly12',
    upgrade: 'monthly12',
    bronze: 'seasonal9',
    silver: 'monthly12',
    gold: 'monthly12',
    platinum: 'monthly12',
  };
  return {
    requestedTier,
    normalizedRequestedTier: aliases[raw] || raw,
    warnings: [],
  };
}

function normalizeMosquitoProgramKey(value) {
  return normalizeMosquitoProgramSelection(value).normalizedRequestedTier;
}

function normalizeMosquitoWaterMultiplier(value) {
  if (value == null || value === '') {
    return {
      waterMultiplier: 1.0,
      waterMultiplierSource: 'default',
      warnings: [],
    };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return {
      waterMultiplier: 1.0,
      waterMultiplierSource: 'defaulted_invalid',
      warnings: ['invalid_mosquito_water_multiplier_defaulted'],
    };
  }
  if (parsed < 1.0) {
    return {
      waterMultiplier: 1.0,
      waterMultiplierSource: 'defaulted_below_one',
      warnings: ['mosquito_water_multiplier_below_one_defaulted'],
    };
  }
  const upperBound = Number.isFinite(Number(MOSQUITO.pressureCap)) && Number(MOSQUITO.pressureCap) > 1
    ? Number(MOSQUITO.pressureCap)
    : 2.0;
  if (parsed > upperBound) {
    return {
      waterMultiplier: upperBound,
      waterMultiplierSource: 'clamped',
      warnings: ['mosquito_water_multiplier_clamped'],
    };
  }
  return {
    waterMultiplier: parsed,
    waterMultiplierSource: 'provided',
    warnings: [],
  };
}

function normalizeMosquitoAddOnCount(value, key) {
  if (value == null || value === '') return { count: 0, warnings: [] };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return {
      count: 0,
      warnings: [`invalid_${key}_count_defaulted`],
    };
  }
  if (parsed < 0) {
    return {
      count: 0,
      warnings: [`negative_${key}_count_clamped`],
    };
  }
  const rounded = Math.round(parsed);
  return {
    count: rounded,
    warnings: Number.isInteger(parsed) ? [] : [`fractional_${key}_count_rounded`],
  };
}

// ============================================================
// PEST CONTROL
// ============================================================
function pricePestControl(property, options = {}) {
  const {
    frequency: requestedFrequencyInput = 'quarterly',
    pricingVersion: requestedPricingVersionInput = 'v1',
    roachType: requestedRoachTypeInput = 'none',
    modifiers = {},
  } = options;

  const footprintResolution = resolvePestFootprint(property);
  const footprint = footprintResolution.footprint;
  const frequencyMeta = normalizePestFrequency(requestedFrequencyInput);
  const versionMeta = normalizePestPricingVersion(requestedPricingVersionInput);
  const roachMeta = normalizeRoachType(requestedRoachTypeInput);
  const propertyTypeMeta = normalizePestPropertyType(property.propertyType);
  const {
    normalizedFeatures,
    featureWarnings,
    featureNormalization,
  } = normalizePestFeatures(property.features || {});
  const pestAgeMeta = normalizePestAgeAdjustment(modifiers.pestAgeAdj);
  const poolCageMeta = resolvePoolCagePricing(normalizedFeatures);
  const attachedGarageAdj = hasAttachedGarageForPest({ ...property, features: normalizedFeatures })
    ? (PEST.additionalAdjustments.attachedGarage || 0)
    : 0;
  const warningList = uniqueList([
    ...footprintResolution.warnings,
    ...frequencyMeta.frequencyWarnings,
    ...versionMeta.pricingVersionWarnings,
    ...roachMeta.roachWarnings,
    ...propertyTypeMeta.propertyTypeWarnings,
    ...featureWarnings,
    ...pestAgeMeta.pestAgeAdjWarnings,
    ...poolCageMeta.warnings,
  ]);
  const footprintAdj = interpolate(
    footprint,
    PEST.footprintBrackets.map(b => [b.sqft, b.adj])
  );

  let additionalAdj = 0;
  const f = normalizedFeatures;
  if (f.indoor) additionalAdj += PEST.additionalAdjustments.indoor;
  if (f.shrubs === 'heavy') additionalAdj += PEST.additionalAdjustments.shrubs_heavy;
  else if (f.shrubs === 'moderate') additionalAdj += PEST.additionalAdjustments.shrubs_moderate;
  else if (f.shrubs === 'light') additionalAdj += (PEST.additionalAdjustments.shrubs_light || 0);
  if (f.poolCage) additionalAdj += poolCageMeta.adjustment;
  else if (f.pool) additionalAdj += PEST.additionalAdjustments.poolNoCage;
  if (f.trees === 'heavy') additionalAdj += PEST.additionalAdjustments.trees_heavy;
  else if (f.trees === 'moderate') additionalAdj += PEST.additionalAdjustments.trees_moderate;
  else if (f.trees === 'light') additionalAdj += (PEST.additionalAdjustments.trees_light || 0);
  if (f.complexity === 'complex') additionalAdj += PEST.additionalAdjustments.complexity_complex;
  else if (f.complexity === 'moderate') additionalAdj += (PEST.additionalAdjustments.complexity_moderate || 0);
  else if (f.complexity === 'simple') additionalAdj += (PEST.additionalAdjustments.complexity_simple || 0);
  if (f.nearWater) additionalAdj += PEST.additionalAdjustments.nearWater;
  if (f.largeDriveway) additionalAdj += PEST.additionalAdjustments.largeDriveway;
  additionalAdj += attachedGarageAdj;

  const propAdj = PROPERTY_TYPE_ADJ[propertyTypeMeta.propertyType] || 0;
  const ageAdj = pestAgeMeta.pestAgeAdj;
  let basePrice = Math.max(PEST.floor, PEST.base + Math.round(footprintAdj) + additionalAdj + propAdj + ageAdj);

  const roachMod = PEST.roachModifier[roachMeta.roachType] || 0;
  // Session 11a Step 2b-3: 2-decimal rounding matches v2 (pricing-engine-v2.js:743).
  const roachAddOn = Math.round(basePrice * roachMod * 100) / 100;

  const pricingVersion = versionMeta.pricingVersion;
  const frequency = frequencyMeta.frequency;
  const roachType = roachMeta.roachType;
  const freqDiscounts = pricingVersion === 'v2' ? PEST.frequencyDiscounts.v2 : PEST.frequencyDiscounts.v1;
  const freqMult = freqDiscounts[frequency] || 1.0;
  const visitsPerYear = PEST.frequencies[frequency] || 4;

  // 2-decimal rounding to match v2 (pricing-engine-v2.js:758). Prior integer
  // round was the source of $0.02/mo drift on bimonthly/monthly cadences vs
  // v2's live output.
  const perApp = Math.round((basePrice * freqMult + roachAddOn) * 100) / 100;
  const annual = Math.round(perApp * visitsPerYear * 100) / 100;
  const monthly = Math.round(annual / 12 * 100) / 100;

  // Cost estimate — fully allocated (on-site + drive time + chemicals)
  const chemCost = { talak: 1.30, taurus: 4.87, surfactant: 0.50 }; // per service
  const materialPerVisit = (roachType === 'german' ? 15 : roachType === 'regular' ? 10 : chemCost.talak + chemCost.taurus + chemCost.surfactant);
  const onSiteMin = frequency === 'monthly' ? 20 : 25;
  const onSiteLaborCost = GLOBAL.LABOR_RATE * onSiteMin / 60;
  const driveLaborCost = GLOBAL.LABOR_RATE * GLOBAL.DRIVE_TIME / 60;
  const directServiceCost = onSiteLaborCost + materialPerVisit; // no drive
  const fullyAllocatedCost = directServiceCost + driveLaborCost; // includes drive
  const annualCost = fullyAllocatedCost * visitsPerYear + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;

  // ── Tier array: quarterly / bimonthly / monthly pre-priced ──
  // Consumed by property-lookup-v2 /calculate-estimate and future tier UIs.
  const tiers = Object.keys(PEST.frequencies).map((freqKey) => {
    const v = PEST.frequencies[freqKey];
    const fm = freqDiscounts[freqKey] || 1.0;
    const pa = Math.round((basePrice * fm + roachAddOn) * 100) / 100;
    const ann = Math.round(pa * v * 100) / 100;
    return {
      frequency: freqKey,
      freq: v,
      perApp: pa,
      annual: ann,
      monthly: Math.round(ann / 12 * 100) / 100,
      label: freqKey === 'monthly' ? 'Monthly' : freqKey === 'bimonthly' ? 'Bi-Monthly' : 'Quarterly',
      recommended: freqKey === frequency,
      selected: freqKey === frequency,
      isSelected: freqKey === frequency,
      systemRecommended: false,
      isRecommended: false,
    };
  });

  const diagnosticsProperty = {
    ...property,
    footprint,
    propertyType: propertyTypeMeta.propertyType,
    attachedGarage: hasAttachedGarageForPest({ ...property, features: normalizedFeatures }),
    features: normalizedFeatures,
  };
  const productionDiagnostics = calculatePestProductionDiagnostics(diagnosticsProperty);
  const diagnosticsReasons = productionDiagnostics?.manualReviewReasons || productionDiagnostics?.reviewReasons || [];
  const mappedDiagnosticsReasons = diagnosticsReasons.map(mapPestProductionReason);
  const lowConfidenceReasons = productionDiagnostics?.lowConfidenceReasons || [];
  const pricingConfidence = footprintResolution.requiresManualReview
    ? lowerConfidence('low', productionDiagnostics?.pricingConfidence || 'high')
    : (productionDiagnostics?.pricingConfidence || 'high');
  const requiresManualReview = !!(
    footprintResolution.requiresManualReview ||
    productionDiagnostics?.manualReview ||
    pricingConfidence === 'medium' ||
    pricingConfidence === 'low'
  );
  const manualReviewReasons = combineManualReviewMetadata(
    footprintResolution.manualReviewReasons,
    diagnosticsReasons,
    mappedDiagnosticsReasons
  );
  const diagnosticEstimatedMinutes = productionDiagnostics?.estimatedMinutes;
  const diagnosticOnSiteLaborCost = Number.isFinite(Number(diagnosticEstimatedMinutes))
    ? GLOBAL.LABOR_RATE * Number(diagnosticEstimatedMinutes) / 60
    : null;
  const diagnosticAnnualCost = diagnosticOnSiteLaborCost === null
    ? null
    : Math.round((diagnosticOnSiteLaborCost + materialPerVisit + driveLaborCost) * visitsPerYear + GLOBAL.ADMIN_ANNUAL);
  const diagnosticMargin = diagnosticAnnualCost === null || annual <= 0
    ? null
    : Math.round(((annual - diagnosticAnnualCost) / annual) * 1000) / 1000;

  return {
    service: 'pest_control',
    basePrice, footprintAdj: Math.round(footprintAdj), additionalAdj, propAdj,
    roachType, requestedRoachType: roachMeta.requestedRoachType, roachTypeWasDefaulted: roachMeta.roachTypeWasDefaulted,
    roachAddOn, freqMult, frequency, visitsPerYear, pricingVersion,
    requestedFrequency: frequencyMeta.requestedFrequency,
    selectedFrequency: frequency,
    frequencySource: frequencyMeta.frequencySource,
    frequencyWasDefaulted: frequencyMeta.frequencyWasDefaulted,
    requestedPricingVersion: versionMeta.requestedPricingVersion,
    pricingVersionWasDefaulted: versionMeta.pricingVersionWasDefaulted,
    requestedPropertyType: propertyTypeMeta.requestedPropertyType,
    propertyType: propertyTypeMeta.propertyType,
    propertyTypeWasDefaulted: propertyTypeMeta.propertyTypeWasDefaulted,
    normalizedFeatures,
    featureNormalization,
    featureWarnings,
    pestAgeAdj: ageAdj,
    pestAgeAdjWarnings: pestAgeMeta.pestAgeAdjWarnings,
    poolCageSize: poolCageMeta.poolCageSize,
    poolCageSizeSource: poolCageMeta.poolCageSizeSource,
    poolCageSizeInferred: poolCageMeta.poolCageSizeInferred,
    attachedGarageAdj,
    perApp, annual, monthly,
    tiers,
    costs: {
      materialPerVisit: Math.round(materialPerVisit * 100) / 100,
      onSiteLaborCost: Math.round(onSiteLaborCost * 100) / 100,
      driveLaborCost: Math.round(driveLaborCost * 100) / 100,
      directServiceCost: Math.round(directServiceCost * 100) / 100,
      fullyAllocatedCost: Math.round(fullyAllocatedCost * 100) / 100,
      annualCost: Math.round(annualCost),
    },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
    initialFee: PEST.initialFee,
    footprintUsed: footprint,
    footprintSource: footprintResolution.source,
    footprintWasDefaulted: footprintResolution.wasDefaulted,
    requiresManualReview,
    manualReviewReasons,
    pricingConfidence,
    lowConfidenceReasons,
    warnings: warningList,
    productionDiagnostics,
    diagnosticEstimatedMinutes,
    diagnosticAnnualCost,
    diagnosticMargin,
    diagnosticMarginFloorOk: diagnosticMargin === null ? null : diagnosticMargin >= GLOBAL.MARGIN_FLOOR,
    diagnosticPricingMode: 'shadow_only',
  };
}

// ============================================================
// PEST — INITIAL ROACH KNOCKDOWN (one-time)
// ============================================================
// Auto-added by estimate-engine when recurring pest is booked with a
// non-none roach type. Covers the heavier visit-1 treatment cost
// regardless of whether the customer keeps the recurring program —
// closes the adverse-selection gap left by the old multiplicative
// roachModifier (which only paid back after ~3 visits).
//
// Sliding scale by footprint and species — German is materially harder
// than palmetto (longer visit, more product, multi-visit follow-up).
// The dedicated `priceGermanRoach` ($450+ multi-visit cleanout) is
// still available for severe colonies; this is the auto-fire for the
// everyday "I saw one or two" case.
function pricePestInitialRoach(property, options = {}) {
  const {
    roachType: requestedRoachTypeInput = 'none',
    severity: requestedSeverityInput,
    severitySource,
    standalone = false,
    autoFiredFromRecurringPest = false,
    source,
  } = options;
  const roachMeta = normalizeRoachType(requestedRoachTypeInput);
  const severityMeta = normalizeRoachSeverity(requestedSeverityInput);
  const roachType = roachMeta.roachType;
  if (roachType === 'none') return null;
  const footprintResolution = resolvePestFootprint(property);

  // Standalone Cockroach Treatment (without recurring pest) uses a higher
  // scale — no future visits to amortize the heavier visit-1 burden across.
  const scaleKey = standalone && roachType === 'regular' ? 'regular_standalone' : roachType;
  const scale = PEST.pestInitialRoach?.[scaleKey];
  if (!Array.isArray(scale) || scale.length === 0) return null;
  const footprint = footprintResolution.footprint;
  const bracket = scale.find((b) => footprint < b.sqft) || scale[scale.length - 1];
  const price = bracket.price;

  // Cost detail mirrors pricePestControl's costing block so the margin
  // panel can reason about the fee. Visit-1 burden estimate: heavier
  // chemical rotation + extra on-site labor at GLOBAL.LABOR_RATE.
  const extraMaterial = roachType === 'german' ? 25 : 20;
  const extraOnSiteMin = roachType === 'german' ? 25 : 15;
  const extraLabor = GLOBAL.LABOR_RATE * extraOnSiteMin / 60;
  const incrementalCost = extraMaterial + extraLabor;
  const margin = price > 0 ? (price - incrementalCost) / price : 0;

  const isGerman = roachType === 'german';
  const manualReviewReasons = uniqueList([
    ...footprintResolution.manualReviewReasons,
    ...(severityMeta.severity === 'severe' && !isGerman
      ? ['severe_native_roach_activity_manual_review']
      : []),
  ]);
  const warnings = uniqueList([
    ...footprintResolution.warnings,
    ...roachMeta.roachWarnings,
    ...severityMeta.warnings,
    ...(severityMeta.severity === 'severe' && isGerman
      ? ['Severe German roach activity should use German Roach Cleanout, not only Initial German Roach Knockdown.']
      : []),
  ]);
  return {
    service: 'pest_initial_roach',
    label: isGerman ? 'Initial German Roach Knockdown' : 'Initial Native Roach Knockdown',
    detail: isGerman
      ? 'Heavier first visit for German roaches (the small indoor / kitchen kind) — interior spray, gel bait at hot spots, and a growth regulator to break the breeding cycle.'
      : 'Heavier first visit for SWFL native roaches (American / palmetto, smoky brown, Australian, Florida woods) — interior spray, bait at hot spots, and perimeter granular.',
    price,
    requestedRoachType: roachMeta.requestedRoachType,
    roachType,
    roachTypeWasDefaulted: roachMeta.roachTypeWasDefaulted,
    severity: severityMeta.severity,
    severitySource: severitySource || (severityMeta.severity ? 'admin' : undefined),
    scaleKey,
    standalone: !!standalone,
    autoFiredFromRecurringPest: !!autoFiredFromRecurringPest,
    source: source || (autoFiredFromRecurringPest
      ? 'recurring_pest_roach_activity'
      : standalone ? 'standalone_native_cockroach_treatment' : 'pest_initial_roach_selected'),
    noRecurringDiscount: true,
    oneTime: true,
    footprintBracket: bracket.sqft === Infinity ? '2500+' : `<${bracket.sqft}`,
    footprintUsed: footprint,
    footprintSource: footprintResolution.source,
    footprintWasDefaulted: footprintResolution.wasDefaulted,
    requiresManualReview: footprintResolution.requiresManualReview || manualReviewReasons.length > 0,
    manualReviewReasons,
    warnings,
    costs: {
      extraMaterial,
      extraLaborMin: extraOnSiteMin,
      incrementalCost: Math.round(incrementalCost * 100) / 100,
    },
    margin: Math.round(margin * 1000) / 1000,
  };
}

// ============================================================
// LAWN CARE
// ============================================================
function normalizeGrassType(grassType) {
  const raw = String(grassType || '').trim();
  const upper = raw.toUpperCase();
  const compact = upper.replace(/[^A-Z0-9]/g, '');
  for (const [track, aliases] of Object.entries(GRASS_TYPE_ALIASES)) {
    if (raw === track) return track;
    for (const alias of aliases) {
      const aliasRaw = String(alias).trim();
      const aliasCompact = aliasRaw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (upper === aliasRaw.toUpperCase() || compact === aliasCompact) return track;
    }
  }
  return 'st_augustine';
}

function resolveLawnTier(tier, lawnFreq) {
  const freq = Number(lawnFreq);
  if (LAWN_FREQS.includes(freq)) {
    const match = Object.entries(LAWN_TIERS).find(([, cfg]) => cfg.freq === freq);
    if (match) return match[0];
  }
  return LAWN_TIERS[tier] ? tier : 'enhanced';
}

function lookupLawnBracket(lawnSqFt, tierIndex, track = 'st_augustine') {
  const brackets = LAWN_BRACKETS[track];
  if (!brackets || !brackets.length) {
    return { monthly: 0, pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
  }

  if (lawnSqFt <= brackets[0][0]) {
    return { monthly: brackets[0][tierIndex + 1], pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
  }
  if (lawnSqFt > LAWN_TABLE_MAX_SQFT) {
    const lo = brackets[brackets.length - 2];
    const hi = brackets[brackets.length - 1];
    const slope = (hi[tierIndex + 1] - lo[tierIndex + 1]) / (hi[0] - lo[0]);
    return {
      monthly: Math.round(hi[tierIndex + 1] + (lawnSqFt - hi[0]) * slope),
      pricingBasis: 'EXTRAPOLATED_ABOVE_TABLE_MAX',
      pricingSource: 'EXTRAPOLATED_TABLE',
    };
  }
  if (lawnSqFt >= brackets[brackets.length - 1][0]) {
    return { monthly: brackets[brackets.length - 1][tierIndex + 1], pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
  }

  for (let i = 0; i < brackets.length - 1; i++) {
    if (lawnSqFt >= brackets[i][0] && lawnSqFt <= brackets[i + 1][0]) {
      const lo = brackets[i], hi = brackets[i + 1];
      const ratio = (lawnSqFt - lo[0]) / (hi[0] - lo[0]);
      return {
        monthly: Math.round(lo[tierIndex + 1] + ratio * (hi[tierIndex + 1] - lo[tierIndex + 1])),
        pricingBasis: 'TABLE_INTERPOLATION',
        pricingSource: 'MARKET_TABLE',
      };
    }
  }
  return { monthly: brackets[brackets.length - 1][tierIndex + 1], pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
}

function calcLawnAnnualCostFloorDetails(lawnSqFt, track, visits, property = {}, options = {}) {
  const turfK = lawnSqFt / 1000;
  const materialCostPerK = Number.isFinite(Number(options.lawnMaterialCostPerK))
    ? Math.max(0, Number(options.lawnMaterialCostPerK))
    : 8;
  const laborMinutesBase = Number.isFinite(Number(options.lawnLaborMinutesBase))
    ? Math.max(0, Number(options.lawnLaborMinutesBase))
    : LAWN_PRICING_V2.laborMinutesBase;
  const laborMinutesPerK = Number.isFinite(Number(options.lawnLaborMinutesPerK))
    ? Math.max(0, Number(options.lawnLaborMinutesPerK))
    : LAWN_PRICING_V2.laborMinutesPer1000Sqft;
  const routeDensity = String(options.routeDensity || property.routeDensity || LAWN_PRICING_V2.defaultRouteDensity)
    .toUpperCase();
  const routeDriveMinutes = Number.isFinite(Number(options.routeDriveMinutes))
    ? Math.max(0, Number(options.routeDriveMinutes))
    : (Number.isFinite(Number(property.routeDriveMinutes))
      ? Math.max(0, Number(property.routeDriveMinutes))
      : (LAWN_PRICING_V2.routeDensityMinutes[routeDensity] ?? LAWN_PRICING_V2.routeDensityMinutes[LAWN_PRICING_V2.defaultRouteDensity]));
  const targetGrossMargin = Number.isFinite(Number(options.targetLawnGrossMargin))
    && Number(options.targetLawnGrossMargin) > 0
    && Number(options.targetLawnGrossMargin) < 1
    ? Number(options.targetLawnGrossMargin)
    : LAWN_PRICING_V2.targetCollectedMarginFloor;
  const features = property.features || {};
  const complexity = String(features.complexity || property.landscapeComplexity || '').toLowerCase();
  const shrubs = String(features.shrubs || property.shrubDensity || '').toLowerCase();
  const maintenance = String(property.maintenanceCondition || '').toUpperCase().replace(/[\s-]+/g, '_');
  const pressure = String(property.overallPestPressure || '').toUpperCase().replace(/[\s-]+/g, '_');
  const complexityMinutes = lawnComplexityMinutes({
    landscapeComplexity: complexity,
    shrubDensity: shrubs,
    hasLargeDriveway: features.largeDriveway,
    hasPrivacyFence: (property.fenceType || features.gate || features.accessDifficulty || '')
      .toString().toLowerCase().includes('privacy'),
  });
  const callbackReservePerVisit =
    LAWN_PRICING_V2.callbackReservePerVisitDefault +
    (['POOR', 'DEFERRED'].includes(maintenance) ? 5 : 0) +
    (['HIGH', 'SEVERE', 'VERY_HIGH'].includes(pressure) ? 5 : 0);

  const annualMaterialBudget = Number.isFinite(Number(options.annualMaterialBudget))
    ? Number(options.annualMaterialBudget)
    : null;
  // Material-per-visit: shared (unclamped) budget scaling, or the $/K fallback.
  const materialCostPerVisit = annualMaterialBudget !== null
    ? lawnMaterialCostPerVisit(annualMaterialBudget, lawnSqFt, visits)
    : turfK * materialCostPerK;
  const laborRate = LAWN_PRICING_V2.laborRateLoaded || GLOBAL.LABOR_RATE;
  const annualAdmin = Number.isFinite(Number(options.adminAnnual))
    ? Math.max(0, Number(options.adminAnnual))
    : LAWN_PRICING_V2.adminAnnualDefault;

  const floor = computeLawnCostFloor({
    lawnSqFt,
    visits,
    materialCostPerVisit,
    laborMinutesBase,
    laborMinutesPer1000Sqft: laborMinutesPerK,
    complexityMinutes,
    laborRate,
    routeDriveMinutes,
    callbackReservePerVisit,
    equipmentReservePerVisit: LAWN_PRICING_V2.equipmentReservePerVisit,
    adminAnnual: annualAdmin,
    targetGrossMargin,
  });
  return {
    annualMaterial: roundMoney(floor.annualMaterial),
    annualLabor: roundMoney(floor.annualLabor),
    annualDrive: roundMoney(floor.annualDrive),
    annualEquipment: roundMoney(floor.annualEquipment),
    annualCallbackReserve: roundMoney(floor.annualCallbackReserve),
    annualAdmin: roundMoney(floor.annualAdmin),
    annualCost: roundMoney(floor.annualCost),
    minimumCollectedAnnualPriceFor55: floor.minimumCollectedAnnualPriceFor55,
    laborMinutesPerVisit: roundMoney(floor.laborMinutesPerVisit),
    routeDriveMinutes,
    routeDensity,
    targetCollectedMarginFloor: targetGrossMargin,
    pricingMode: LAWN_PRICING_V2.pricingMode,
    pricingVersion: LAWN_PRICING_V2.pricingVersion,
  };
}

function calcLawnAnnualCostFloor(lawnSqFt, track, visits, property = {}, options = {}) {
  return calcLawnAnnualCostFloorDetails(lawnSqFt, track, visits, property, options).minimumCollectedAnnualPriceFor55;
}

function priceLawnCare(property, options = {}) {
  const {
    track = 'st_augustine',
    tier = 'enhanced',
    lawnFreq,
    useLawnCostFloor = true,
    includeHiddenTiers = false,
  } = options;

  const normalizedTrack = normalizeGrassType(track);
  const selectedTier = resolveLawnTier(tier, lawnFreq);
  const tierConfig = LAWN_TIERS[selectedTier];
  if (!tierConfig) throw new Error(`Unknown lawn tier: ${selectedTier}`);

  const hasTurfSf = property.turfSf !== undefined && property.turfSf !== null && property.turfSf !== '';
  const hasLawnSqFt = property.lawnSqFt !== undefined && property.lawnSqFt !== null && property.lawnSqFt !== '';
  const turfSqFt = Number(property.turfSf);
  const legacyLawnSqFt = Number(property.lawnSqFt);
  const lawnSqFt = hasTurfSf && Number.isFinite(turfSqFt) && turfSqFt >= 0
    ? turfSqFt
    : (hasLawnSqFt && Number.isFinite(legacyLawnSqFt) && legacyLawnSqFt >= 0 ? legacyLawnSqFt : 4500);

  // Annual material budget at the 4,500 sqft reference — sourced from the shared
  // @waves/lawn-cost-floor table (same data the client preview uses), keyed by
  // track → visits. Sun/shade is NOT a pricing input.
  const annualMaterial = lawnMaterialBudget(normalizedTrack, tierConfig.freq);

  // Labor: v4 protocol uses $26.96/visit across all tracks
  const laborPerVisit = 26.96;
  const annualLabor = laborPerVisit * tierConfig.freq;

  // Scale material by lawn size relative to reference (4500 sqft)
  const sizeRatio = Math.max(0.6, Math.min(2.5, lawnSqFt / 4500));
  const scaledMaterial = Math.round(annualMaterial * sizeRatio);

  const annualCost = scaledMaterial + annualLabor + GLOBAL.ADMIN_ANNUAL;

  // ── Tier array: 4 Apps / 6 Apps / 9 Apps / 12 Apps ──
  const TIER_LIST = includeHiddenTiers ? Object.keys(LAWN_TIERS) : LAWN_SOLD_TIERS;
  const allTiers = TIER_LIST.map((t) => {
    const tc = LAWN_TIERS[t];
    if (!tc) return null;
    const tierAnnualBudget = lawnMaterialBudget(normalizedTrack, tc.freq);
    const market = lookupLawnBracket(lawnSqFt, tc.index, normalizedTrack);
    const marketMonthly = market.monthly;
    const marketAnnual = Math.round(marketMonthly * 12);
    const costFloorOpts = { ...options };
    if (!Number.isFinite(Number(options.lawnMaterialCostPerK))) {
      costFloorOpts.annualMaterialBudget = tierAnnualBudget;
    }
    const costFloorDetails = calcLawnAnnualCostFloorDetails(lawnSqFt, normalizedTrack, tc.freq, property, costFloorOpts);
    const costFloorAnnual = costFloorDetails.minimumCollectedAnnualPriceFor55;
    const costFloorApplied = !!useLawnCostFloor && costFloorAnnual > marketAnnual;
    const ann = costFloorApplied ? Math.ceil(costFloorAnnual / tc.freq) * tc.freq : marketAnnual;
    const perApp = Math.round(ann / tc.freq * 100) / 100;
    return {
      tier: t,
      index: tc.index,
      visits: tc.freq,
      freq: tc.freq,
      perApp,
      annual: ann,
      monthly: Math.round(ann / 12 * 100) / 100,
      label: tc.label,
      recommended: t === selectedTier,
      pricingBasis: costFloorApplied ? LAWN_PRICING_V2.pricingMode : market.pricingBasis,
      pricingSource: costFloorApplied ? 'COST_FLOOR' : market.pricingSource,
      marketMonthly,
      marketAnnual,
      marketSource: market.pricingSource,
      costFloorAnnual,
      costFloorApplied,
      costFloorDetails,
      minimumCollectedAnnualPriceFor55: costFloorAnnual,
    };
  }).filter(Boolean);
  const tiers = includeHiddenTiers
    ? allTiers
    : allTiers.filter(t => !LAWN_TIERS[t.tier]?.hidden);
  const selected = tiers.find(t => t.tier === selectedTier) || tiers.find(t => t.tier === 'enhanced') || tiers[0];
  const monthly = selected.monthly;
  const annual = selected.annual;
  const perApp = selected.perApp;
  const selectedCosts = selected.costFloorDetails || {};
  const selectedAnnualCost = Number.isFinite(Number(selectedCosts.annualCost)) ? Number(selectedCosts.annualCost) : annualCost;
  const margin = annual > 0 ? (annual - selectedAnnualCost) / annual : 0;
  const customQuoteFlag = lawnSqFt > LAWN_TABLE_MAX_SQFT;
  const display = LAWN_TRACK_DISPLAY[normalizedTrack] || LAWN_TRACK_DISPLAY.st_augustine;

  return {
    service: 'lawn_care',
    track: normalizedTrack,
    grassCode: display.code,
    grassType: display.label,
    tier: selected.tier,
    lawnSqFt,
    turfSf: lawnSqFt,
    turfEstimated: property.turfEstimated,
    turfConfidence: property.turfConfidence,
    turfBasis: property.turfBasis,
    frequency: LAWN_TIERS[selected.tier]?.freq ?? tierConfig.freq,
    monthly, annual, perApp,
    tiers,
    selected,
    recommended: selected,
    wgMonthly: selected.monthly,
    pricingBasis: selected.pricingBasis,
    pricingSource: selected.pricingSource,
    customQuoteFlag,
    notes: customQuoteFlag
      ? [`Turf area exceeds ${LAWN_TABLE_MAX_SQFT.toLocaleString()} sq ft. Pricing was extrapolated and requires field verification/custom quote.`]
      : [],
    marketMonthly: selected.marketMonthly,
    marketAnnual: selected.marketAnnual,
    // Lawn V2 is cost-floor authoritative; the bracket table is reference-only.
    // Exposed as a nested object (per pricing spec) so consumers can show an
    // old-vs-new comparison without mistaking it for the charged price. Flat
    // marketMonthly/marketAnnual above are retained for back-compat.
    marketReference: {
      monthly: selected.marketMonthly,
      annual: selected.marketAnnual,
      perApp: Math.round((selected.marketAnnual / (LAWN_TIERS[selected.tier]?.freq ?? tierConfig.freq)) * 100) / 100,
      source: selected.marketSource || 'MARKET_TABLE',
    },
    costFloorAnnual: selected.costFloorAnnual,
    costFloorApplied: selected.costFloorApplied,
    costs: {
      annualMaterial: roundMoney(selectedCosts.annualMaterial ?? scaledMaterial),
      annualLabor: roundMoney(selectedCosts.annualLabor ?? annualLabor),
      annualDrive: roundMoney(selectedCosts.annualDrive ?? 0),
      annualEquipment: roundMoney(selectedCosts.annualEquipment ?? 0),
      annualCallbackReserve: roundMoney(selectedCosts.annualCallbackReserve ?? 0),
      annualAdmin: roundMoney(selectedCosts.annualAdmin ?? GLOBAL.ADMIN_ANNUAL),
      total: roundMoney(selectedAnnualCost),
    },
    minimumCollectedAnnualPriceFor55: selected.minimumCollectedAnnualPriceFor55,
    pricingMode: selectedCosts.pricingMode || (selected.costFloorApplied ? LAWN_PRICING_V2.pricingMode : undefined),
    pricingVersion: selectedCosts.pricingVersion || (selected.costFloorApplied ? LAWN_PRICING_V2.pricingVersion : undefined),
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
  };
}

// ============================================================
// TREE & SHRUB
// ============================================================
function hasNonNegativePricingNumber(value) {
  return value !== undefined &&
    value !== null &&
    value !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0;
}

function hasPositivePricingNumber(value) {
  return value !== undefined &&
    value !== null &&
    value !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0;
}

function normalizeTreeShrubEnum(value, fallback = '') {
  return String(value || fallback || '').trim().toLowerCase();
}

function getTreeShrubShrubDensity(property = {}) {
  return normalizeTreeShrubEnum(
    property.shrubDensity || property.features?.shrubs,
    'moderate'
  );
}

function getTreeShrubComplexity(property = {}) {
  return normalizeTreeShrubEnum(
    property.complexity || property.landscapeComplexity || property.features?.complexity,
    'standard'
  );
}

function normalizeTreeShrubPressure(value) {
  return normalizeTreeShrubEnum(value).replace(/[\s-]+/g, '_');
}

function hasKnownTreeShrubPressure(property = {}) {
  const directSignals = [
    property.pestPressure,
    property.diseasePressure,
    property.features?.pestPressure,
    property.features?.diseasePressure,
  ];
  for (const signal of directSignals) {
    if (signal === true) return true;
    const normalized = normalizeTreeShrubPressure(signal);
    if (normalized && !['false', 'no', 'none', 'low', 'unknown'].includes(normalized)) {
      return true;
    }
  }

  const overallPressure = normalizeTreeShrubPressure(
    property.overallPestPressure || property.features?.overallPestPressure
  );
  return ['high', 'very_high', 'severe'].includes(overallPressure);
}

function estimateTreeShrubBedAreaFromLot(property = {}) {
  const lotSqFt = Number(property.lotSqFt) || 0;
  if (lotSqFt <= 0) return null;

  const shrubDensity = getTreeShrubShrubDensity(property);
  const complexity = getTreeShrubComplexity(property);
  const density = BED_DENSITY[shrubDensity] || BED_DENSITY.moderate;
  let pct = density.basePct;
  if (complexity === 'complex' || complexity === 'moderate') pct += density.complexAdd;

  const rawBedArea = Math.max(0, Math.round(lotSqFt * pct));
  return {
    bedArea: Math.min(rawBedArea, BED_AREA_CAP),
    rawBedArea,
    capped: rawBedArea >= BED_AREA_CAP,
  };
}

function resolveTreeShrubBedArea(property = {}, warnings = []) {
  const sourceHint = normalizeTreeShrubEnum(property.bedAreaSource);
  if (sourceHint === 'fallback') {
    warnings.push('Tree & Shrub bed area was not provided; fallback 2,000 sqft was used.');
    return {
      bedArea: 2000,
      bedAreaSource: 'fallback',
      pricingConfidence: 'low',
      requiresManualReview: true,
    };
  }

  // Upstream cap metadata: calculatePropertyProfile may have already capped
  // an oversized estimated/lot-derived bed area down to BED_AREA_CAP and set
  // property.bedAreaCapped = true (+ optionally uncappedBedAreaEstimate).
  // Without this, the explicit-bedArea branch below would discard the cap
  // signal and silently miss bed_area_cap_reached for inputs like
  // estimatedBedAreaSf: 9000 routed through generateEstimate.
  const upstreamCapped = property.bedAreaCapped === true;
  const upstreamUncapped = hasPositivePricingNumber(property.uncappedBedAreaEstimate)
    ? Number(property.uncappedBedAreaEstimate)
    : undefined;

  if (hasPositivePricingNumber(property.bedArea)) {
    // Resolve source from the upstream hint so the lot-derived label from
    // calculatePropertyProfile survives the explicit-bedArea branch and
    // priceTreeShrub can distinguish a lot-density inference from a
    // customer-supplied estimate.
    let bedAreaSource;
    if (sourceHint === 'lot_based') bedAreaSource = 'lot_based';
    else if (sourceHint === 'estimated') bedAreaSource = 'estimated';
    else bedAreaSource = 'explicit';
    const pricingConfidence = bedAreaSource === 'explicit' ? 'high' : 'medium';
    return {
      bedArea: Number(property.bedArea),
      bedAreaSource,
      pricingConfidence,
      requiresManualReview: false,
      ...(upstreamCapped ? { capped: true } : {}),
      ...(upstreamCapped && upstreamUncapped !== undefined
        ? { uncappedBedAreaEstimate: upstreamUncapped }
        : {}),
    };
  }

  const estimatedBedAreaValue = hasPositivePricingNumber(property.estimatedBedArea)
    ? property.estimatedBedArea
    : property.estimatedBedAreaSf;
  if (hasPositivePricingNumber(estimatedBedAreaValue)) {
    const rawBedArea = Number(estimatedBedAreaValue);
    const localCapped = rawBedArea >= BED_AREA_CAP;
    const capped = localCapped || upstreamCapped;
    // Prefer upstream uncapped (the true raw input) when present, else the
    // raw value seen on this call.
    const uncapped = upstreamUncapped !== undefined
      ? upstreamUncapped
      : (localCapped ? rawBedArea : undefined);
    return {
      bedArea: Math.min(rawBedArea, BED_AREA_CAP),
      bedAreaSource: 'estimated',
      pricingConfidence: 'medium',
      requiresManualReview: false,
      capped,
      ...(capped && uncapped !== undefined ? { uncappedBedAreaEstimate: uncapped } : {}),
    };
  }

  const lotEstimate = estimateTreeShrubBedAreaFromLot(property);
  if (lotEstimate) {
    return {
      bedArea: lotEstimate.bedArea,
      bedAreaSource: 'lot_based',
      pricingConfidence: 'medium',
      requiresManualReview: false,
      capped: lotEstimate.capped,
      ...(lotEstimate.capped ? { uncappedBedAreaEstimate: lotEstimate.rawBedArea } : {}),
    };
  }

  warnings.push('Tree & Shrub bed area was not provided; fallback 2,000 sqft was used.');
  return {
    bedArea: 2000,
    bedAreaSource: 'fallback',
    pricingConfidence: 'low',
    requiresManualReview: true,
  };
}

// Internal: full recommendation result with reason codes. The recommended
// tier is always the mandated 6-visit Standard; the reason codes are advisory
// signals (admin UI, customer proposal) that the property warrants the full
// program rather than the Light downsell. `recommendTreeShrubTier` is the
// back-compat string-returning wrapper used by older callers and tests.
function evaluateTreeShrubTierRecommendation(property = {}) {
  // 6-visit Standard is the MANDATED default program (protocol six_x). We
  // always recommend it — the 4-visit Light tier (protocol four_x) is an
  // available downsell for clean / low-pest-history landscapes but is never
  // auto-recommended. The reason codes below are retained for admin/customer
  // surfaces as "signals the property warrants the full 6x program" (i.e.
  // reasons NOT to downsell to Light); they no longer change the tier.
  let bedArea = 0;
  let bedAreaFromFallback = false;
  if (hasPositivePricingNumber(property.bedArea)) {
    bedArea = Number(property.bedArea);
  } else if (hasPositivePricingNumber(property.estimatedBedArea)) {
    bedArea = Number(property.estimatedBedArea);
  } else if (hasPositivePricingNumber(property.estimatedBedAreaSf)) {
    bedArea = Number(property.estimatedBedAreaSf);
  } else {
    const lotEstimate = estimateTreeShrubBedAreaFromLot(property);
    if (lotEstimate && lotEstimate.bedArea > 0) {
      bedArea = lotEstimate.bedArea;
    } else {
      bedArea = 2000;
      bedAreaFromFallback = true;
    }
  }
  const heavyDensity = getTreeShrubShrubDensity(property) === 'heavy';
  const complex = ['moderate', 'complex'].includes(getTreeShrubComplexity(property));
  const highTreeCount = Number(property.treeCount || property.features?.treeCount || 0) >= 8;
  const difficultAccess = normalizeTreeShrubEnum(property.access || property.features?.access) === 'difficult';
  const knownPressure = hasKnownTreeShrubPressure(property);

  const reasons = [];
  if (bedArea >= 2000) reasons.push('bed_area_at_or_above_2000');
  if (heavyDensity) reasons.push('heavy_density');
  if (complex) reasons.push('moderate_or_complex_property');
  if (highTreeCount) reasons.push('tree_count_at_or_above_8');
  if (difficultAccess) reasons.push('difficult_access');
  if (knownPressure) reasons.push('high_pest_pressure');
  if (bedAreaFromFallback && bedArea >= 2000) reasons.push('fallback_bed_area_used');

  // Standard (6x) is the mandate — never auto-escalate or auto-downsell.
  const recommendedTier = TREE_SHRUB.recommendedTier || TREE_SHRUB.defaultTier || 'standard';

  return { recommendedTier, recommendationReasons: reasons };
}

function recommendTreeShrubTier(property = {}) {
  return evaluateTreeShrubTierRecommendation(property).recommendedTier;
}

// Structured warning codes for retired tiers. Emitted alongside the prose
// warning so downstream consumers (admin UI, log aggregation, dashboards) can
// match on a stable identifier. The legacy `premium` code is retained for
// back-compat; both retired tiers now map to the mandated 6-visit Standard.
const TS_PREMIUM_DEPRECATED_WARNING_CODE = 'tree_shrub_premium_deprecated_mapped_to_standard';
const TS_ENHANCED_DEPRECATED_WARNING_CODE = 'tree_shrub_enhanced_deprecated_mapped_to_standard';

function normalizeTreeShrubTier(requestedTier, warnings = [], warningCodes = []) {
  const normalized = normalizeTreeShrubEnum(requestedTier, TREE_SHRUB.defaultTier || 'standard');
  if (normalized === 'premium') {
    warnings.push('Premium Tree & Shrub has been retired; the 6-visit Standard plan was used.');
    warningCodes.push(TS_PREMIUM_DEPRECATED_WARNING_CODE);
    return { tier: 'standard', legacyTierRequested: 'premium' };
  }
  if (normalized === 'enhanced') {
    warnings.push('Enhanced (9-visit) Tree & Shrub has been retired; the 6-visit Standard plan was used.');
    warningCodes.push(TS_ENHANCED_DEPRECATED_WARNING_CODE);
    return { tier: 'standard', legacyTierRequested: 'enhanced' };
  }
  if (!TREE_SHRUB.tiers[normalized]) throw new Error(`Unknown T&S tier: ${requestedTier}`);
  return { tier: normalized, legacyTierRequested: null };
}

function priceTreeShrub(property, options = {}) {
  property = property || {};
  const warnings = [];
  const warningCodes = [];
  const access = normalizeTreeShrubEnum(options.access || property.access || property.features?.access, 'easy');
  // treeCount drives labor minutes AND the per-tree material term (v4.6).
  // When no count is supplied at all, fall back to an estimate from the
  // property's treeDensity enum instead of silently pricing zero trees.
  const treeCountRaw = options.treeCount ?? property.treeCount ?? property.features?.treeCount;
  let treeCount;
  let treeCountSource = 'explicit';
  if (treeCountRaw === undefined || treeCountRaw === null || String(treeCountRaw).trim() === '') {
    const treeDensity = normalizeTreeShrubEnum(
      property.treeDensity || property.features?.trees || property.features?.treeDensity, ''
    );
    const densityCount = TREE_SHRUB.treeDensityCounts?.[treeDensity];
    if (densityCount !== undefined && densityCount > 0) {
      treeCount = densityCount;
      treeCountSource = 'density_estimate';
      warnings.push(`Tree count was not provided; estimated ${densityCount} trees from ${treeDensity} tree density.`);
    } else {
      treeCount = 0;
      treeCountSource = treeDensity ? 'density_estimate' : 'default_zero';
    }
  } else {
    treeCount = Math.max(0, Number(treeCountRaw) || 0);
  }
  const recommendationInput = {
    ...property,
    access,
    treeCount,
    features: {
      ...(property.features || {}),
      access,
      treeCount,
    },
  };
  const { recommendedTier, recommendationReasons } = evaluateTreeShrubTierRecommendation(recommendationInput);
  const requestedTier = options.tier || recommendedTier;
  const { tier, legacyTierRequested } = normalizeTreeShrubTier(requestedTier, warnings, warningCodes);
  const tierConfig = TREE_SHRUB.tiers[tier];

  const bedAreaInfo = resolveTreeShrubBedArea(property, warnings);
  const bedArea = bedAreaInfo.bedArea;
  const bedAreaCapped = !!bedAreaInfo.capped;

  const accessMin = TREE_SHRUB.accessMinutes[access] || 0;
  const onSiteMin = Math.max(25, 20 + Math.round(bedArea / 500) + Math.round(treeCount * 1.5) + accessMin);

  const frequency = tierConfig.frequency;
  // Protocol-derived ANNUAL material model (v4.6); every term is already
  // amortized across the year — do NOT multiply by frequency. See
  // constants.js TREE_SHRUB block for the per-term derivation.
  const materialModel = TREE_SHRUB.materialModel || {};
  const tierMaterialFactor = tier === 'light' ? (materialModel.lightFactor ?? 0.75) : 1;
  const modeledMaterialCost = (
    (materialModel.fixedAnnual ?? 15)
    + (materialModel.perTreeAnnual ?? 4) * treeCount
    + (materialModel.perSqFtAnnual ?? 0.055) * bedArea
  ) * tierMaterialFactor;
  const materialCost = Math.max(frequency * 10, modeledMaterialCost);

  const laborPerVisit = GLOBAL.LABOR_RATE * ((onSiteMin + 10) / 60);
  const laborAnnual = laborPerVisit * frequency;

  const annualDirectCost = materialCost + laborAnnual;
  // Admin-INCLUSIVE margin target (v4.6): price = (direct + admin) / (1 - target).
  // The displayed margin below equals marginTarget exactly when no floor binds.
  const marginTarget = TREE_SHRUB.marginTarget ?? GLOBAL.MARGIN_TARGET_TS ?? 0.45;
  const baseAnnualPrice = (annualDirectCost + GLOBAL.ADMIN_ANNUAL) / (1 - marginTarget);
  const monthlyCalc = baseAnnualPrice / 12;
  // Monthly floor is a PRE-DISCOUNT list-price floor — discounts may take the
  // collected price below this floor, but only as far as the post-discount
  // T&S margin guard (discount-engine.js#applyMarginGuard) permits.
  const monthly = Math.max(tierConfig.monthlyFloor, roundMoney(monthlyCalc));
  const annual = roundMoney(monthly * 12);
  const internalPerVisitRevenue = roundMoney(annual / frequency);
  const baseMarginRaw = annual > 0 ? (annual - annualDirectCost - GLOBAL.ADMIN_ANNUAL) / annual : 0;
  const baseMargin = roundRatio(baseMarginRaw);

  // Manual review reasons — structured codes that mirror the prose warnings
  // already pushed into `warnings`. Reason codes are stable identifiers for
  // dashboards and routing logic; warnings stay human-readable.
  const manualReviewReasonsSet = new Set();
  if (bedAreaInfo.bedAreaSource === 'fallback' || bedAreaInfo.requiresManualReview) {
    manualReviewReasonsSet.add('missing_bed_area_fallback');
  }
  if (bedAreaCapped) {
    manualReviewReasonsSet.add('bed_area_cap_reached');
    warnings.push('Tree & Shrub bed area hit the estimator cap; manual review recommended.');
  }
  if (bedArea >= BED_AREA_CAP) {
    manualReviewReasonsSet.add('bed_area_at_or_above_8000');
    if (!bedAreaCapped) {
      warnings.push('Tree & Shrub bed area hit the estimator cap; manual review recommended.');
    }
  }
  if (treeCount >= 15) {
    manualReviewReasonsSet.add('tree_count_at_or_above_15');
    warnings.push('High tree count; manual review recommended.');
  }
  if (access === 'difficult' && bedArea >= 4000) {
    manualReviewReasonsSet.add('difficult_access_large_bed_area');
    warnings.push('Difficult access with large bed area; manual review recommended.');
  }
  const manualReviewReasons = [...manualReviewReasonsSet];
  const manualReview = manualReviewReasons.length > 0;

  return {
    service: 'tree_shrub',
    tier,
    selectedTier: tier,
    ...(legacyTierRequested ? { legacyTierRequested } : {}),
    recommendedTier,
    recommendationReasons,
    recommended: tier === recommendedTier,
    availableTiers: Object.keys(TREE_SHRUB.tiers),
    frequency,
    // Expose visitsPerYear (mirrors `frequency`) so cost/audit consumers that
    // key off visits — admin-pricing-config margin preview, estimate-pricing
    // -audit visitsFor — read the real cadence instead of a stale fallback.
    visitsPerYear: frequency,
    bedArea,
    bedAreaUsed: bedArea,
    bedAreaSource: bedAreaInfo.bedAreaSource,
    bedAreaCapped,
    ...(bedAreaInfo.uncappedBedAreaEstimate !== undefined
      ? { uncappedBedAreaEstimate: bedAreaInfo.uncappedBedAreaEstimate }
      : {}),
    pricingConfidence: bedAreaInfo.pricingConfidence,
    bedAreaConfidence: bedAreaInfo.pricingConfidence,
    treeCount,
    treeCountSource,
    access,
    onSiteMin,
    materialModel: {
      fixedAnnual: materialModel.fixedAnnual ?? 15,
      perTreeAnnual: materialModel.perTreeAnnual ?? 4,
      perSqFtAnnual: materialModel.perSqFtAnnual ?? 0.055,
      tierFactor: tierMaterialFactor,
    },
    monthly,
    annual,
    internalPerVisitRevenue,
    perApp: internalPerVisitRevenue,
    costs: {
      materialCost: roundMoney(materialCost),
      laborCost: roundMoney(laborAnnual),
      adminCost: GLOBAL.ADMIN_ANNUAL,
      directCost: roundMoney(annualDirectCost),
      totalWithAdmin: roundMoney(annualDirectCost + GLOBAL.ADMIN_ANNUAL),
      total: roundMoney(annualDirectCost + GLOBAL.ADMIN_ANNUAL),
    },
    marginTarget,
    baseMargin,
    margin: baseMargin,
    marginFloorOk: baseMarginRaw >= (TREE_SHRUB.marginFloor || GLOBAL.MARGIN_FLOOR),
    requiresManualReview: manualReview,
    manualReview,
    manualReviewReasons,
    warnings: [...new Set(warnings)],
    ...(warningCodes.length > 0 ? { warningCodes: [...new Set(warningCodes)] } : {}),
  };
}

// ============================================================
// COMMERCIAL LAWN — cost-buildup auto-pricer (constants COMMERCIAL_LAWN)
// ============================================================
// Reuses the shared lawn cost-floor arithmetic with commercial knobs. Prices
// ALL commercial turf (no size cap, owner directive 2026-06-28) and flags the
// result as an estimate to be confirmed on site. Turf basis is the same
// property.turfSf the residential pricer reads (profile-resolved: measured →
// lawnSqFt → satellite estimate → lot-derived), so accuracy on large commercial
// rides on the satellite estimate — hence pricingConfidence + the disclaimer.
function resolveCommercialTurfSqFt(property = {}) {
  const candidates = [
    ['turfSf', property.turfSf],
    ['lawnSqFt', property.lawnSqFt],
    ['estimatedTurfSf', property.estimatedTurfSf],
  ];
  for (const [basis, raw] of candidates) {
    // Respect an explicit numeric value INCLUDING 0 — turf measured as absent
    // (all-hardscape lot) is authoritative and must price at the account
    // minimum, not fall through to an invented lot-based estimate. Only a
    // genuinely missing value (null/undefined/'') falls through.
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      return {
        turfSf: n,
        turfBasis: property.turfBasis || basis,
        estimated: basis === 'turfSf' ? !!property.turfEstimated : true,
      };
    }
  }
  const lot = Number(property.lotSqFt);
  if (Number.isFinite(lot) && lot > 0) {
    // No measured/estimated turf: assume ~45% of the lot is maintained turf.
    return { turfSf: Math.round(lot * 0.45), turfBasis: 'commercialLotFallback', estimated: true };
  }
  return { turfSf: 8000, turfBasis: 'commercialDefault', estimated: true };
}

function priceCommercialLawn(property = {}, options = {}) {
  const cfg = COMMERCIAL_LAWN;
  const { turfSf, turfBasis, estimated } = resolveCommercialTurfSqFt(property);
  const visits = cfg.programVisits;
  const annualMaterial = cfg.materialAnnualPerK * (turfSf / 1000);
  const materialCostPerVisit = annualMaterial / visits;

  const floor = computeLawnCostFloor({
    lawnSqFt: turfSf,
    visits,
    materialCostPerVisit,
    laborMinutesBase: cfg.laborMinutesBase,
    laborMinutesPer1000Sqft: cfg.laborMinutesPerK,
    complexityMinutes: 0,
    laborRate: GLOBAL.LABOR_RATE,
    routeDriveMinutes: cfg.routeDriveMinutes,
    callbackReservePerVisit: cfg.callbackReservePerVisit,
    equipmentReservePerVisit: cfg.equipmentReservePerVisit,
    adminAnnual: cfg.adminAnnual,
    targetGrossMargin: cfg.targetGrossMargin,
  });

  const computedAnnual = floor.minimumCollectedAnnualPriceFor55;
  const minApplied = computedAnnual < cfg.minAnnual;
  const annual = roundMoney(Math.max(cfg.minAnnual, computedAnnual));
  const monthly = roundMoney(annual / 12);
  const perApp = roundMoney(annual / visits);
  const margin = annual > 0 ? roundRatio((annual - floor.annualCost) / annual) : 0;
  const pricingConfidence = (turfSf > cfg.lowConfidenceTurfSf || estimated) ? 'LOW' : 'MEDIUM';

  return {
    service: 'commercial_lawn',
    name: 'Commercial Lawn Treatment',
    originalRequestedService: 'lawn_care',
    propertyType: 'commercial',
    isCommercial: true,
    commercialSubtype: options.commercialSubtype || property.commercialSubtype || null,
    commercialPricingMode: 'auto_estimate',
    estimatedPricing: true,
    // Flat commercial pricing — never WaveGuard/recurring-discountable. Carried
    // so the accept/recurring helpers exclude it from % discounts even where a
    // service key normalizes to "lawn".
    discountable: false,
    excludeFromPctDiscount: true,
    quoteRequired: false,
    requiresManualReview: false,
    detail: 'Commercial turf program (fertilization + weed + insect control). Estimated from property data — final price confirmed on site.',
    disclaimer: 'Estimated from property data — final price confirmed on site.',
    turfSf,
    turfBasis,
    turfEstimated: estimated,
    frequency: visits,
    visitsPerYear: visits,
    monthly,
    annual,
    perApp,
    perVisit: perApp,
    pricingBasis: 'COMMERCIAL_COST_BUILDUP',
    pricingConfidence,
    minApplied,
    program: { fertApps: 4, preEmergentApps: 2, postEmergentApps: 4, insectApps: 2 },
    taxable: cfg.taxable,
    taxCategory: cfg.taxCategory,
    costs: {
      annualMaterial: roundMoney(floor.annualMaterial),
      annualLabor: roundMoney(floor.annualLabor),
      annualDrive: roundMoney(floor.annualDrive),
      annualCallbackReserve: roundMoney(floor.annualCallbackReserve),
      annualAdmin: roundMoney(floor.annualAdmin),
      total: roundMoney(floor.annualCost),
    },
    margin,
    marginFloorOk: margin >= cfg.targetGrossMargin - 0.01,
  };
}

// ============================================================
// COMMERCIAL PEST — cost-buildup auto-pricer (COMMERCIAL_PEST)
// ============================================================
// Building footprint (interior treatment) + perimeter (exterior barrier) drive
// the cost. Perimeter is taken from the profile when present, else derived from
// the footprint (square approximation) so the pricer is self-contained. Unlike
// commercial lawn/tree, commercial pest is TAXED in FL (the line carries
// taxable:true / taxCategory:'nonresidential_pest_control'; tax-calculator also
// applies 7% to commercial pest off isCommercial). Monthly is the commercial
// baseline cadence — the rep confirms the actual frequency on site.
function resolveCommercialPestFootprint(property = {}) {
  const res = resolvePestFootprint(property);
  const footprint = Number(res.footprint) || 0;
  // Perimeter: honor the profile-computed perimeter when positive, else derive
  // from the footprint (a square's perimeter = 4·√area) so a missing perimeter
  // never zeroes the exterior-barrier labor.
  const explicitPerimeter = Number(property.perimeter ?? property.perimeterLF ?? property.perimeterLf);
  const perimeter = Number.isFinite(explicitPerimeter) && explicitPerimeter > 0
    ? explicitPerimeter
    : (footprint > 0 ? 4 * Math.sqrt(footprint) : 0);
  return {
    footprint,
    perimeter,
    footprintSource: res.source,
    // True when resolvePestFootprint fell back to its 2,000 sqft default — i.e.
    // NO usable building size was supplied. Commercial pest prices off the
    // BUILDING footprint (interior treatment), which (unlike turf/bed) is NOT
    // lot-derivable, so a defaulted footprint can't auto-price (see below).
    defaulted: res.wasDefaulted === true,
  };
}

function priceCommercialPest(property = {}, options = {}) {
  const cfg = COMMERCIAL_PEST;
  const { footprint, perimeter, footprintSource, defaulted } = resolveCommercialPestFootprint(property);
  const visits = cfg.programVisits;

  // No real building size → DON'T auto-price (and bill/prepay) off the 2,000 sqft
  // fallback, which is unrelated to the actual building. Fall back to a manual
  // quote until a building/home/footprint sqft is provided. (Lawn/tree are
  // lot-derivable so they still auto-price; pest is not.) A caller can also force
  // this via buildingSizeMeasured:false — the public wizard sets it when the
  // building size is its synthetic confirm-step default, which would otherwise
  // resolve as a real footprint.
  if (defaulted || options.buildingSizeMeasured === false) {
    return {
      service: 'commercial_pest',
      name: 'Commercial Pest Control',
      originalRequestedService: 'pest_control',
      propertyType: 'commercial',
      isCommercial: true,
      commercialSubtype: options.commercialSubtype || property.commercialSubtype || null,
      commercialPricingMode: 'manual_quote',
      estimatedPricing: false,
      quoteRequired: true,
      requiresManualReview: true,
      autoQuoteRequiresAdminApproval: true,
      manualReviewReasons: ['commercial_pest_missing_building_footprint'],
      detail: 'Commercial pest pricing needs the building size — your Waves account manager will confirm the quote.',
      taxable: cfg.taxable,
      taxCategory: cfg.taxCategory,
      price: null,
      monthly: null,
      annual: null,
      perApp: null,
      pricingConfidence: 'LOW',
    };
  }

  const materialPerVisit = cfg.materialPerVisitBase
    + cfg.materialPerKSqFtPerVisit * (footprint / 1000);
  const onSiteMin = cfg.laborMinutesBase
    + cfg.laborMinutesPerKSqFt * (footprint / 1000)
    + cfg.laborMinutesPerimeterPer100Lf * (perimeter / 100);
  const laborPerVisit = GLOBAL.LABOR_RATE * ((onSiteMin + cfg.laborOverheadMinutesPerVisit) / 60);
  const drivePerVisit = GLOBAL.LABOR_RATE * (cfg.routeDriveMinutes / 60);

  const annualMaterial = materialPerVisit * visits;
  const annualLabor = laborPerVisit * visits;
  const annualDrive = drivePerVisit * visits;
  const annualCost = annualMaterial + annualLabor + annualDrive + cfg.adminAnnual;

  const computedAnnual = annualCost / (1 - cfg.targetGrossMargin);
  const minApplied = computedAnnual < cfg.minAnnual;
  const annual = roundMoney(Math.max(cfg.minAnnual, computedAnnual));
  const monthly = roundMoney(annual / 12);
  const perApp = roundMoney(annual / visits);
  const margin = annual > 0 ? roundRatio((annual - annualCost) / annual) : 0;
  const pricingConfidence = footprint > cfg.lowConfidenceFootprintSf ? 'LOW' : 'MEDIUM';

  return {
    service: 'commercial_pest',
    name: 'Commercial Pest Control',
    originalRequestedService: 'pest_control',
    propertyType: 'commercial',
    isCommercial: true,
    commercialSubtype: options.commercialSubtype || property.commercialSubtype || null,
    commercialPricingMode: 'auto_estimate',
    estimatedPricing: true,
    // Flat commercial pricing — never WaveGuard/recurring-discountable. Carried
    // so the accept/recurring helpers exclude it from % discounts even where a
    // service key normalizes to "pest".
    discountable: false,
    excludeFromPctDiscount: true,
    quoteRequired: false,
    requiresManualReview: false,
    detail: 'Commercial pest program (interior treatment + exterior barrier + monitoring). Estimated from property data — final price confirmed on site.',
    disclaimer: 'Estimated from property data — final price confirmed on site.',
    footprint,
    footprintUsed: footprint,
    footprintSource,
    footprintEstimated: false,
    perimeter: roundMoney(perimeter),
    frequency: visits,
    visitsPerYear: visits,
    onSiteMin: roundMoney(onSiteMin),
    monthly,
    annual,
    perApp,
    internalPerVisitRevenue: perApp,
    perVisit: perApp,
    pricingBasis: 'COMMERCIAL_COST_BUILDUP',
    pricingConfidence,
    minApplied,
    taxable: cfg.taxable,
    taxCategory: cfg.taxCategory,
    costs: {
      materialCost: roundMoney(annualMaterial),
      laborCost: roundMoney(annualLabor),
      driveCost: roundMoney(annualDrive),
      adminCost: cfg.adminAnnual,
      directCost: roundMoney(annualMaterial + annualLabor + annualDrive),
      total: roundMoney(annualCost),
    },
    margin,
    marginFloorOk: margin >= cfg.targetGrossMargin - 0.01,
  };
}

// ============================================================
// COMMERCIAL MOSQUITO / TERMITE-BAIT / RODENT-BAIT — cost-buildup auto-pricers
// ============================================================
// Same FL-taxed cost-buildup + return shape as commercial pest; each supplies
// its own per-visit material $ and on-site labor minutes (driven by treatable
// area / perimeter / footprint). Mosquito's driver (treatable area) is
// lot-derivable so it ALWAYS prices; termite/rodent price off the building
// footprint and fall back to a manual quote when no real building size exists
// (mirrors priceCommercialPest, incl. the buildingSizeMeasured:false override).

// Build a priced commercial pest-family line from the supplied per-visit
// material $ and on-site minutes. Identical buildup/margin/shape across the
// three services (45% target margin, account minimum, FL-taxed).
function buildCommercialPestFamilyLine({ cfg, materialPerVisit, onSiteMin, service, name, originalRequestedService, detail, extra = {} }) {
  const visits = cfg.programVisits;
  const laborPerVisit = GLOBAL.LABOR_RATE * ((onSiteMin + cfg.laborOverheadMinutesPerVisit) / 60);
  const drivePerVisit = GLOBAL.LABOR_RATE * (cfg.routeDriveMinutes / 60);
  const annualMaterial = materialPerVisit * visits;
  const annualLabor = laborPerVisit * visits;
  const annualDrive = drivePerVisit * visits;
  const annualCost = annualMaterial + annualLabor + annualDrive + cfg.adminAnnual;
  const computedAnnual = annualCost / (1 - cfg.targetGrossMargin);
  const minApplied = computedAnnual < cfg.minAnnual;
  const annual = roundMoney(Math.max(cfg.minAnnual, computedAnnual));
  const monthly = roundMoney(annual / 12);
  const perApp = roundMoney(annual / visits);
  const margin = annual > 0 ? roundRatio((annual - annualCost) / annual) : 0;
  return {
    service,
    name,
    originalRequestedService,
    propertyType: 'commercial',
    isCommercial: true,
    commercialPricingMode: 'auto_estimate',
    estimatedPricing: true,
    // Flat commercial pricing — never WaveGuard/recurring-discountable.
    discountable: false,
    excludeFromPctDiscount: true,
    quoteRequired: false,
    requiresManualReview: false,
    detail,
    disclaimer: 'Estimated from property data — final price confirmed on site.',
    frequency: visits,
    visitsPerYear: visits,
    onSiteMin: roundMoney(onSiteMin),
    monthly,
    annual,
    perApp,
    internalPerVisitRevenue: perApp,
    perVisit: perApp,
    pricingBasis: 'COMMERCIAL_COST_BUILDUP',
    minApplied,
    taxable: cfg.taxable,
    taxCategory: cfg.taxCategory,
    costs: {
      materialCost: roundMoney(annualMaterial),
      laborCost: roundMoney(annualLabor),
      driveCost: roundMoney(annualDrive),
      adminCost: cfg.adminAnnual,
      directCost: roundMoney(annualMaterial + annualLabor + annualDrive),
      total: roundMoney(annualCost),
    },
    margin,
    marginFloorOk: margin >= cfg.targetGrossMargin - 0.01,
    ...extra,
  };
}

// Manual-quote fallback when no real building size exists (termite/rodent only —
// mirrors priceCommercialPest's defaulted-footprint branch).
function commercialPestFamilyManualLine({ service, name, originalRequestedService, cfg, reason, detail, commercialSubtype }) {
  return {
    service,
    name,
    originalRequestedService,
    propertyType: 'commercial',
    isCommercial: true,
    commercialSubtype: commercialSubtype || null,
    commercialPricingMode: 'manual_quote',
    estimatedPricing: false,
    quoteRequired: true,
    requiresManualReview: true,
    autoQuoteRequiresAdminApproval: true,
    manualReviewReasons: [reason],
    detail,
    taxable: cfg.taxable,
    taxCategory: cfg.taxCategory,
    price: null,
    monthly: null,
    annual: null,
    perApp: null,
    pricingConfidence: 'LOW',
  };
}

function priceCommercialMosquito(property = {}, options = {}) {
  const cfg = COMMERCIAL_MOSQUITO;
  const area = resolveMosquitoTreatableArea(property);
  const treatableSqFt = Math.max(0, Number(area.mosquitoTreatableSqFt) || 0);
  return buildCommercialPestFamilyLine({
    cfg,
    materialPerVisit: cfg.materialPerVisitBase + cfg.materialPerKSqFtPerVisit * (treatableSqFt / 1000),
    onSiteMin: cfg.laborMinutesBase + cfg.laborMinutesPerKSqFt * (treatableSqFt / 1000),
    service: 'commercial_mosquito',
    name: 'Commercial Mosquito',
    originalRequestedService: 'mosquito',
    detail: 'Commercial mosquito program (exterior barrier + larvicide). Estimated from property data — final price confirmed on site.',
    extra: {
      commercialSubtype: options.commercialSubtype || property.commercialSubtype || null,
      treatableSqFt,
      treatableSource: area.source,
      pricingConfidence: (treatableSqFt > cfg.lowConfidenceTreatableSf || area.confidence === 'low') ? 'LOW' : 'MEDIUM',
    },
  });
}

function priceCommercialTermiteBait(property = {}, options = {}) {
  const cfg = COMMERCIAL_TERMITE_BAIT;
  const { footprint, perimeter, footprintSource, defaulted } = resolveCommercialPestFootprint(property);
  if (defaulted || options.buildingSizeMeasured === false) {
    return commercialPestFamilyManualLine({
      service: 'commercial_termite_bait',
      name: 'Commercial Termite Bait Monitoring',
      originalRequestedService: 'termite_bait',
      cfg,
      reason: 'commercial_termite_missing_building_footprint',
      detail: 'Commercial termite monitoring needs the building size — your Waves account manager will confirm the quote.',
      commercialSubtype: options.commercialSubtype || property.commercialSubtype,
    });
  }
  return buildCommercialPestFamilyLine({
    cfg,
    materialPerVisit: cfg.materialPerVisitBase + cfg.materialPer100LfPerVisit * (perimeter / 100),
    onSiteMin: cfg.laborMinutesBase + cfg.laborMinutesPer100Lf * (perimeter / 100),
    service: 'commercial_termite_bait',
    name: 'Commercial Termite Bait Monitoring',
    originalRequestedService: 'termite_bait',
    detail: 'Commercial termite bait-station monitoring (quarterly). Estimated from property data — final price confirmed on site.',
    extra: {
      commercialSubtype: options.commercialSubtype || property.commercialSubtype || null,
      footprint,
      perimeter: roundMoney(perimeter),
      footprintSource,
      pricingConfidence: footprint > cfg.lowConfidenceFootprintSf ? 'LOW' : 'MEDIUM',
    },
  });
}

function priceCommercialRodentBait(property = {}, options = {}) {
  const cfg = COMMERCIAL_RODENT_BAIT;
  const { footprint, footprintSource, defaulted } = resolveCommercialPestFootprint(property);
  if (defaulted || options.buildingSizeMeasured === false) {
    return commercialPestFamilyManualLine({
      service: 'commercial_rodent_bait',
      name: 'Commercial Rodent Bait Stations',
      originalRequestedService: 'rodent_bait',
      cfg,
      reason: 'commercial_rodent_missing_building_footprint',
      detail: 'Commercial rodent station pricing needs the building size — your Waves account manager will confirm the quote.',
      commercialSubtype: options.commercialSubtype || property.commercialSubtype,
    });
  }
  return buildCommercialPestFamilyLine({
    cfg,
    materialPerVisit: cfg.materialPerVisitBase + cfg.materialPerKSqFtPerVisit * (footprint / 1000),
    onSiteMin: cfg.laborMinutesBase + cfg.laborMinutesPerKSqFt * (footprint / 1000),
    service: 'commercial_rodent_bait',
    name: 'Commercial Rodent Bait Stations',
    originalRequestedService: 'rodent_bait',
    detail: 'Commercial rodent bait-station program (quarterly). Estimated from property data — final price confirmed on site.',
    extra: {
      commercialSubtype: options.commercialSubtype || property.commercialSubtype || null,
      footprint,
      footprintSource,
      pricingConfidence: footprint > cfg.lowConfidenceFootprintSf ? 'LOW' : 'MEDIUM',
    },
  });
}

// ============================================================
// COMMERCIAL TREE & SHRUB — cost-buildup auto-pricer (COMMERCIAL_TREE_SHRUB)
// ============================================================
// Bed area is resolved UNCAPPED for commercial (explicit → estimated → lot
// density), unlike residential which caps at BED_AREA_CAP, because commercial
// auto-pricing has no size cap.
function resolveCommercialBedArea(property = {}) {
  // No size cap for commercial: when calculatePropertyProfile already capped a
  // lot-derived/estimated bed area at BED_AREA_CAP (preserving the true value
  // as uncappedBedAreaEstimate), recover the uncapped figure — otherwise large
  // commercial beds would be underquoted at the 8,000 sqft residential cap.
  if (property.bedAreaCapped === true && Number(property.uncappedBedAreaEstimate) > 0) {
    return {
      bedArea: Number(property.uncappedBedAreaEstimate),
      bedBasis: property.bedAreaSource || 'lot_based',
      estimated: true,
    };
  }
  // Respect an explicit numeric bed area. A ZERO bed area is authoritative ONLY
  // when it's a deliberate/explicit measurement (all-hardscape lot, beds
  // measured as absent) — NOT an inferred/estimated zero. The admin V2 form
  // sends estimatedBedAreaSf: 0 as its blank default, which
  // calculatePropertyProfile resolves to bedArea: 0 with bedAreaSource:
  // 'estimated'; honoring that as "no beds" would underquote a real commercial
  // property at the $900 minimum, so an estimated/lot_based zero falls through
  // to the lot-density estimate instead. (A positive value is always honored.)
  if (property.bedArea !== null && property.bedArea !== undefined && property.bedArea !== '') {
    const explicit = Number(property.bedArea);
    const src = property.bedAreaSource;
    const isInferredZero = explicit === 0 && src && src !== 'explicit';
    if (Number.isFinite(explicit) && explicit >= 0 && !isInferredZero) {
      return {
        bedArea: explicit,
        bedBasis: src || 'explicit',
        estimated: src ? src !== 'explicit' : false,
      };
    }
  }
  // An estimated bed area is only authoritative when positive — an estimated
  // zero is the blank-default case above, never a real "no beds" measurement.
  const estRaw = property.estimatedBedArea ?? property.estimatedBedAreaSf;
  if (estRaw !== null && estRaw !== undefined && estRaw !== '') {
    const est = Number(estRaw);
    if (Number.isFinite(est) && est > 0) {
      return { bedArea: est, bedBasis: 'estimated', estimated: true };
    }
  }
  const lotEstimate = estimateTreeShrubBedAreaFromLot(property);
  if (lotEstimate && lotEstimate.rawBedArea > 0) {
    return { bedArea: lotEstimate.rawBedArea, bedBasis: 'lot_based', estimated: true };
  }
  return { bedArea: 3000, bedBasis: 'commercialDefault', estimated: true };
}

function priceCommercialTreeShrub(property = {}, options = {}) {
  const cfg = COMMERCIAL_TREE_SHRUB;
  const { bedArea, bedBasis, estimated } = resolveCommercialBedArea(property);
  // Tree count resolution (mirrors residential priceTreeShrub):
  //  1. Only a POSITIVE count is authoritative — callers (e.g. the public quote
  //     adapter) may pass treeCount: 0 to mean "omitted", which must NOT
  //     suppress the fallback or the per-tree material term is priced away.
  //  2. When no positive count exists, estimate from the tree-DENSITY enum
  //     (public quote enrichment supplies features.trees), instead of pricing
  //     zero trees on a light/moderate/heavy commercial property.
  const positiveTreeCount = [
    Number(options.treeCount),
    Number(property.treeCount),
    Number(property.features?.treeCount),
  ].find((n) => Number.isFinite(n) && n > 0);
  let treeCount;
  if (positiveTreeCount !== undefined) {
    treeCount = positiveTreeCount;
  } else {
    const treeDensity = normalizeTreeShrubEnum(
      property.treeDensity || property.features?.trees || property.features?.treeDensity, ''
    );
    const densityCount = TREE_SHRUB.treeDensityCounts?.[treeDensity];
    treeCount = (densityCount !== undefined && densityCount > 0) ? densityCount : 0;
  }
  treeCount = Math.max(0, Number(treeCount) || 0);
  const visits = cfg.programVisits;

  const annualMaterial = cfg.materialFixedAnnual
    + cfg.materialPerSqFtAnnual * bedArea
    + cfg.materialPerTreeAnnual * treeCount;

  const onSiteMin = cfg.laborMinutesBase
    + (bedArea / 100) * cfg.laborMinutesPerHundredSqFt
    + treeCount * cfg.laborMinutesPerTree;
  const laborPerVisit = GLOBAL.LABOR_RATE * ((onSiteMin + cfg.laborOverheadMinutesPerVisit) / 60);
  const drivePerVisit = GLOBAL.LABOR_RATE * (cfg.routeDriveMinutes / 60);
  const annualLabor = laborPerVisit * visits;
  const annualDrive = drivePerVisit * visits;

  const annualCost = annualMaterial + annualLabor + annualDrive + cfg.adminAnnual;
  const computedAnnual = annualCost / (1 - cfg.targetGrossMargin);
  const minApplied = computedAnnual < cfg.minAnnual;
  const annual = roundMoney(Math.max(cfg.minAnnual, computedAnnual));
  const monthly = roundMoney(annual / 12);
  const perApp = roundMoney(annual / visits);
  const margin = annual > 0 ? roundRatio((annual - annualCost) / annual) : 0;
  const pricingConfidence = (bedArea > cfg.lowConfidenceBedSf || estimated) ? 'LOW' : 'MEDIUM';

  return {
    service: 'commercial_tree_shrub',
    name: 'Commercial Tree & Shrub',
    originalRequestedService: 'tree_shrub',
    propertyType: 'commercial',
    isCommercial: true,
    commercialSubtype: options.commercialSubtype || property.commercialSubtype || null,
    commercialPricingMode: 'auto_estimate',
    estimatedPricing: true,
    // Flat commercial pricing — never WaveGuard/recurring-discountable. Carried
    // so the accept/recurring helpers exclude it from % discounts even where a
    // service key normalizes to "lawn".
    discountable: false,
    excludeFromPctDiscount: true,
    quoteRequired: false,
    requiresManualReview: false,
    detail: 'Commercial ornamental program (shrub/tree fertilization + insect + bed weed control). Estimated from property data — final price confirmed on site.',
    disclaimer: 'Estimated from property data — final price confirmed on site.',
    bedArea,
    bedAreaUsed: bedArea,
    bedAreaSource: bedBasis,
    bedAreaEstimated: estimated,
    treeCount,
    frequency: visits,
    visitsPerYear: visits,
    onSiteMin: roundMoney(onSiteMin),
    monthly,
    annual,
    perApp,
    internalPerVisitRevenue: perApp,
    perVisit: perApp,
    pricingBasis: 'COMMERCIAL_COST_BUILDUP',
    pricingConfidence,
    minApplied,
    taxable: cfg.taxable,
    taxCategory: cfg.taxCategory,
    costs: {
      materialCost: roundMoney(annualMaterial),
      laborCost: roundMoney(annualLabor),
      driveCost: roundMoney(annualDrive),
      adminCost: cfg.adminAnnual,
      directCost: roundMoney(annualMaterial + annualLabor + annualDrive),
      total: roundMoney(annualCost),
    },
    margin,
    marginFloorOk: margin >= cfg.targetGrossMargin - 0.01,
  };
}

// ============================================================
// PALM INJECTION
// ============================================================
const PALM_WARNING_TEXT = {
  nutrition: 'Corrective injection; not a replacement for full granular palm fertilization.',
  combo: 'Do not model as tank mix; separate compatible application steps.',
  fungal: 'Diagnosis/product-driven treatment.',
  lethalBronzing: 'Preventive program only; not a cure for symptomatic or positive palms.',
  treeAge: 'Annual value is annualized from a 24-month interval; perVisit is the event price.',
};

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isMissingPrice(value) {
  return value === null || value === undefined || value === '';
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw buildPricingError(`${name} must be a positive integer`, { field: name, value });
  }
  return value;
}

function hasPalmCountCandidate(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function parsePositivePalmInteger(value) {
  if (!hasPalmCountCandidate(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolvePalmCount(property = {}, options = {}) {
  const warnings = [];
  const manualReviewReasons = [];
  const invalidCandidates = [];
  const addInvalid = (source, value) => {
    invalidCandidates.push({ source, value });
    warnings.push('invalid_palm_count');
    manualReviewReasons.push('invalid_palm_count');
  };
  const readCandidate = (source, value) => {
    if (!hasPalmCountCandidate(value)) return null;
    const palmCount = parsePositivePalmInteger(value);
    if (palmCount) return { palmCount, source };
    addInvalid(source, value);
    return null;
  };

  const serviceDirectPresent = hasPalmCountCandidate(options.palmCount);
  const serviceMeasurementPresent = hasPalmCountCandidate(options.measurements?.palmCount);
  const propertyDirect = readCandidate('property_palm_count', property.palmCount);
  const propertyInventory = readCandidate('property_palm_inventory', property.palmInventory?.palmCount);

  // palmCount is required for every palm injection price. The service-level
  // value means palms treated for this line; property-level count is only a
  // default/prefill because not every palm on the property is necessarily treated.
  if (serviceDirectPresent) {
    const serviceDirect = readCandidate('service_manual_override', options.palmCount);
    if (serviceDirect) {
      warnings.push('palm_count_manual_override_used');
      const propertyPalmCount = propertyDirect?.palmCount ?? propertyInventory?.palmCount;
      const differs = parsePositivePalmInteger(propertyPalmCount) && serviceDirect.palmCount !== propertyPalmCount;
      if (differs) warnings.push('service_palm_count_differs_from_property_palm_count');
      return {
        ...serviceDirect,
        wasManualOverride: true,
        wasDefaulted: false,
        requiresMeasurement: false,
        requiresManualReview: false,
        manualReviewReasons: [...new Set(manualReviewReasons)],
        warnings: [...new Set(warnings)],
        servicePalmCountDiffersFromPropertyPalmCount: differs,
        propertyPalmCount: propertyPalmCount || undefined,
        invalidCandidates,
      };
    }
    return {
      palmCount: undefined,
      source: 'missing',
      wasManualOverride: false,
      wasDefaulted: false,
      requiresMeasurement: true,
      requiresManualReview: true,
      manualReviewReasons: [...new Set(manualReviewReasons)],
      warnings: [...new Set(warnings)],
      invalidCandidates,
    };
  }

  if (serviceMeasurementPresent) {
    const serviceMeasurement = readCandidate('service_manual_override', options.measurements.palmCount);
    if (serviceMeasurement) {
      warnings.push('palm_count_manual_override_used');
      const propertyPalmCount = propertyDirect?.palmCount ?? propertyInventory?.palmCount;
      const differs = parsePositivePalmInteger(propertyPalmCount) && serviceMeasurement.palmCount !== propertyPalmCount;
      if (differs) warnings.push('service_palm_count_differs_from_property_palm_count');
      return {
        ...serviceMeasurement,
        wasManualOverride: true,
        wasDefaulted: false,
        requiresMeasurement: false,
        requiresManualReview: false,
        manualReviewReasons: [...new Set(manualReviewReasons)],
        warnings: [...new Set(warnings)],
        servicePalmCountDiffersFromPropertyPalmCount: differs,
        propertyPalmCount: propertyPalmCount || undefined,
        invalidCandidates,
      };
    }
    return {
      palmCount: undefined,
      source: 'missing',
      wasManualOverride: false,
      wasDefaulted: false,
      requiresMeasurement: true,
      requiresManualReview: true,
      manualReviewReasons: [...new Set(manualReviewReasons)],
      warnings: [...new Set(warnings)],
      invalidCandidates,
    };
  }

  if (propertyDirect) {
    return {
      ...propertyDirect,
      wasManualOverride: false,
      wasDefaulted: true,
      requiresMeasurement: false,
      requiresManualReview: false,
      manualReviewReasons: [...new Set(manualReviewReasons)],
      warnings: [...new Set(warnings)],
      servicePalmCountDiffersFromPropertyPalmCount: false,
      invalidCandidates,
    };
  }

  if (propertyInventory) {
    return {
      ...propertyInventory,
      wasManualOverride: false,
      wasDefaulted: true,
      requiresMeasurement: false,
      requiresManualReview: false,
      manualReviewReasons: [...new Set(manualReviewReasons)],
      warnings: [...new Set(warnings)],
      servicePalmCountDiffersFromPropertyPalmCount: false,
      invalidCandidates,
    };
  }

  warnings.push('missing_palm_count');
  manualReviewReasons.push('missing_palm_count');
  return {
    palmCount: undefined,
    source: 'missing',
    wasManualOverride: false,
    wasDefaulted: false,
    requiresMeasurement: true,
    requiresManualReview: true,
    manualReviewReasons: [...new Set(manualReviewReasons)],
    warnings: [...new Set(warnings)],
    invalidCandidates,
  };
}

function assertPositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw buildPricingError(`${name} must be a positive number`, { field: name, value });
  }
  return value;
}

function assertEnum(value, allowedValues, name) {
  if (!allowedValues.includes(value)) {
    throw buildPricingError(`${name} must be one of: ${allowedValues.join(', ')}`, {
      field: name,
      value,
      allowedValues,
    });
  }
  return value;
}

function buildPricingError(message, metadata = {}) {
  const err = new Error(message);
  err.name = 'PricingError';
  err.status = 400;
  err.statusCode = 400;
  err.code = 'PRICING_VALIDATION_ERROR';
  err.isOperational = true;
  err.metadata = metadata;
  return err;
}

function assertCustomPriceIfPresent(customPricePerPalm) {
  if (isMissingPrice(customPricePerPalm)) return;
  if (typeof customPricePerPalm !== 'number' || !Number.isFinite(customPricePerPalm)) {
    throw new Error('customPricePerPalm must be a finite number');
  }
  if (customPricePerPalm < 0) {
    throw new Error('customPricePerPalm must be non-negative');
  }
}

function resolveQuotePrice(customPricePerPalm, floorPerPalm) {
  assertCustomPriceIfPresent(customPricePerPalm);
  if (isMissingPrice(customPricePerPalm)) {
    return {
      pricePerPalm: floorPerPalm,
      quoteFloorApplied: false,
      customPriceProvided: false,
    };
  }

  return {
    pricePerPalm: Math.max(customPricePerPalm, floorPerPalm),
    quoteFloorApplied: customPricePerPalm < floorPerPalm,
    customPriceProvided: true,
  };
}

function resolveAppsPerYear(treatment, options = {}) {
  if (!isMissingPrice(options.appsPerYear)) {
    return assertPositiveNumber(options.appsPerYear, 'appsPerYear');
  }
  if (!isMissingPrice(options.intervalMonths)) {
    return roundCurrency(12 / assertPositiveNumber(options.intervalMonths, 'intervalMonths'));
  }
  if (treatment.intervalMonths) {
    const intervalAppsPerYear = 12 / treatment.intervalMonths;
    if (typeof treatment.appsPerYear === 'number') return treatment.appsPerYear;
    return roundCurrency(intervalAppsPerYear);
  }
  if (typeof treatment.defaultAppsPerYear === 'number') return treatment.defaultAppsPerYear;
  if (typeof treatment.appsPerYear === 'number') return treatment.appsPerYear;
  throw new Error('appsPerYear could not be resolved for palm treatment');
}

function getTierByPalmSize(treatment, palmSize) {
  if (!palmSize) throw new Error('palmSize is required for this palm treatment');
  const tier = (treatment.tiers || []).find(t => t.size === palmSize);
  if (!tier) throw new Error('palmSize must be one of: small, medium, large');
  return tier;
}

function getTreeAgeTier(treatment, dbhInches) {
  return (treatment.tiers || []).find(t => t.dbhMax === null || dbhInches <= t.dbhMax);
}

function formatInterval(intervalMonths) {
  if (!intervalMonths) return undefined;
  const unit = intervalMonths === 1 ? 'month' : 'months';
  return `every ${intervalMonths} ${unit}`;
}

function shouldIncludePalmInternalCostBasis(options) {
  return options.includeInternalCostBasis === true
    && (options.internal === true || options.isInternal === true || options.admin === true || options.isAdmin === true);
}

function pricePalmInjection(property, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Palm injection options are required');
  }

  const { treatmentType, customPricePerPalm } = options;
  if (!treatmentType) throw new Error('Palm treatmentType is required');

  const treatment = PALM.treatments[treatmentType];
  if (!treatment) throw new Error(`Unknown palm treatment: ${treatmentType}`);

  const palmCount = assertPositiveInteger(options.palmCount, 'palmCount');
  assertCustomPriceIfPresent(customPricePerPalm);

  let palmSize;
  let dbhInches;
  let intervalMonths;
  let appsPerYear;
  let pricePerPalm;
  let quoteBased = treatment.quoteBased === true;
  let quoteFloorApplied = false;
  let customPriceProvided = false;
  const warnings = [];
  if (PALM_WARNING_TEXT[treatmentType]) warnings.push(PALM_WARNING_TEXT[treatmentType]);

  if (treatment.pricingType === 'fixed') {
    if (!isMissingPrice(options.appsPerYear)) {
      appsPerYear = assertPositiveNumber(options.appsPerYear, 'appsPerYear');
      if (!treatment.allowedAppsPerYear.includes(appsPerYear)) {
        throw new Error(`appsPerYear for ${treatmentType} must be one of: ${treatment.allowedAppsPerYear.join(', ')}`);
      }
    } else {
      appsPerYear = treatment.defaultAppsPerYear;
    }
    pricePerPalm = treatment.pricePerPalm;
  } else if (treatment.pricingType === 'tiered') {
    palmSize = options.palmSize;
    const tier = getTierByPalmSize(treatment, palmSize);
    appsPerYear = treatment.defaultAppsPerYear;

    const quoteFlags = treatment.quoteBasedWhen || [];
    const requiresQuotePrice = quoteFlags.some(flag => options[flag] === true);
    if (requiresQuotePrice) {
      if (isMissingPrice(customPricePerPalm)) {
        throw new Error(`customPricePerPalm is required for quote-based ${treatmentType} palm pricing`);
      }
      const quotePrice = resolveQuotePrice(customPricePerPalm, tier.pricePerPalm);
      pricePerPalm = quotePrice.pricePerPalm;
      quoteFloorApplied = quotePrice.quoteFloorApplied;
      customPriceProvided = quotePrice.customPriceProvided;
      quoteBased = true;
    } else {
      pricePerPalm = tier.pricePerPalm;
    }
  } else if (treatmentType === 'fungal') {
    if (options.diagnosisConfirmed !== true) {
      throw new Error('diagnosisConfirmed must be true for fungal palm treatment pricing');
    }
    if (!options.selectedProduct) {
      throw new Error('selectedProduct is required for fungal palm treatment pricing');
    }
    if (!treatment.products.includes(options.selectedProduct)) {
      throw new Error(`selectedProduct must be one of: ${treatment.products.join(', ')}`);
    }
    if (isMissingPrice(options.appsPerYear) && isMissingPrice(options.intervalMonths)) {
      throw new Error('fungal palm treatment pricing requires appsPerYear or intervalMonths');
    }
    intervalMonths = !isMissingPrice(options.intervalMonths)
      ? assertPositiveNumber(options.intervalMonths, 'intervalMonths')
      : undefined;
    appsPerYear = resolveAppsPerYear(treatment, options);
    const quotePrice = resolveQuotePrice(customPricePerPalm, treatment.floorPerPalm);
    pricePerPalm = quotePrice.pricePerPalm;
    quoteFloorApplied = quotePrice.quoteFloorApplied;
    customPriceProvided = quotePrice.customPriceProvided;
  } else if (treatmentType === 'lethalBronzing') {
    const palmStatus = options.palmStatus;
    if (!palmStatus) throw new Error('palmStatus is required for lethal bronzing palm pricing');
    if (treatment.ineligibleStatuses.includes(palmStatus)) {
      throw new Error('Palm is not eligible for lethal bronzing injection pricing and should be handled outside this service');
    }
    if (!treatment.eligibleStatuses.includes(palmStatus)) {
      throw new Error(`Unknown or invalid lethal bronzing palmStatus: ${palmStatus}`);
    }
    intervalMonths = treatment.intervalMonths;
    appsPerYear = resolveAppsPerYear(treatment);
    const quotePrice = resolveQuotePrice(customPricePerPalm, treatment.floorPerPalm);
    pricePerPalm = quotePrice.pricePerPalm;
    quoteFloorApplied = quotePrice.quoteFloorApplied;
    customPriceProvided = quotePrice.customPriceProvided;
  } else if (treatmentType === 'treeAge') {
    dbhInches = assertPositiveNumber(options.dbhInches, 'dbhInches');
    const tier = getTreeAgeTier(treatment, dbhInches);
    const tierFloor = tier.pricePerPalm || 110;
    if (tier.quoteBased && isMissingPrice(customPricePerPalm)) {
      throw new Error('customPricePerPalm is required for Tree-Age pricing above 20 DBH inches');
    }
    if ((options.product === 'Tree-Age R10' || options.restrictedUseProduct === true) && options.licensedApplicator !== true) {
      throw new Error('licensedApplicator is required for restricted-use Tree-Age product pricing');
    }
    intervalMonths = treatment.intervalMonths;
    appsPerYear = resolveAppsPerYear(treatment);
    const quotePrice = resolveQuotePrice(customPricePerPalm, tierFloor);
    pricePerPalm = quotePrice.pricePerPalm;
    quoteFloorApplied = quotePrice.quoteFloorApplied;
    customPriceProvided = quotePrice.customPriceProvided;
  } else {
    throw new Error(`Unsupported palm treatment pricing type: ${treatment.pricingType}`);
  }

  const rawPerVisit = roundCurrency(pricePerPalm * palmCount);
  const perVisit = roundCurrency(Math.max(rawPerVisit, PALM.minPerVisit));
  const minimumApplied = perVisit > rawPerVisit;
  const minimumShortfallPerVisit = minimumApplied ? roundCurrency(perVisit - rawPerVisit) : 0;
  const rawAnnual = roundCurrency(rawPerVisit * appsPerYear);
  const annualBeforeCredits = roundCurrency(perVisit * appsPerYear);
  const monthlyBeforeCredits = roundCurrency(annualBeforeCredits / 12);

  const result = {
    service: 'palm_injection',

    treatmentType,
    treatmentLabel: treatment.label,
    pricingType: treatment.pricingType,

    palmCount,
    palmSize,
    dbhInches,

    pricePerPalm: roundCurrency(pricePerPalm),
    quoteBased,
    quoteFloorApplied,
    customPriceProvided,

    appsPerYear,
    intervalMonths,
    minimumProgramMonths: treatment.minimumProgramMonths,

    rawPerVisit,
    perVisit,
    minimumApplied,
    minimumShortfallPerVisit,

    rawAnnual,
    annualBeforeCredits,
    monthlyBeforeCredits,

    annual: annualBeforeCredits,
    monthly: monthlyBeforeCredits,

    tierQualifier: PALM.tierQualifier,
    excludeFromPctDiscount: PALM.excludeFromPctDiscount,

    flatCredit: PALM.flatCreditPerPalm,
    flatCreditPerPalm: PALM.flatCreditPerPalm,
    flatCreditMinTier: PALM.flatCreditMinTier,

    warnings,
  };

  if (intervalMonths) {
    result.displayFrequency = formatInterval(intervalMonths);
    result.annualized = intervalMonths > 12;
  }
  if (options.selectedProduct) result.selectedProduct = options.selectedProduct;
  if (shouldIncludePalmInternalCostBasis(options)) result.internalCostBasis = PALM.internalCostBasis;

  return result;
}

// ============================================================
// MOSQUITO
// ============================================================
function priceMosquito(property, options = {}) {
  const {
    tier = null,
    modifiers = {},
    stationCount = 0,
    dunkCount = 0,
  } = options;

  property = property || {};
  const areaResolution = resolveMosquitoTreatableArea(property);
  const categoryResolution = resolveMosquitoLotCategory(property, areaResolution);
  const lotCategory = categoryResolution.lotCategory;
  const basePrices = MOSQUITO.basePrices[lotCategory];
  if (!basePrices) throw new Error(`Unknown lot category: ${lotCategory}`);
  const waterMeta = normalizeMosquitoWaterMultiplier((modifiers || {}).mosquitoWaterMult);
  const waterMultiplier = waterMeta.waterMultiplier;
  const hasGraduatedWaterMultiplier = waterMultiplier > 1.0;

  // Pressure multiplier
  let pressure = 1.00;
  const f = property.features || {};
  if (f.trees === 'heavy') pressure += MOSQUITO.pressureFactors.trees_heavy;
  else if (f.trees === 'moderate') pressure += MOSQUITO.pressureFactors.trees_moderate;
  if (f.complexity === 'complex') pressure += MOSQUITO.pressureFactors.complexity_complex;
  else if (f.complexity === 'moderate') pressure += MOSQUITO.pressureFactors.complexity_moderate;
  if (f.pool || f.poolCage) pressure += MOSQUITO.pressureFactors.pool;
  if (f.nearWater && !hasGraduatedWaterMultiplier) pressure += MOSQUITO.pressureFactors.nearWater;
  if (f.irrigation) pressure += MOSQUITO.pressureFactors.irrigation;
  if (lotCategory === 'ACRE') pressure += MOSQUITO.pressureFactors.lot_acre;
  else if (lotCategory === 'HALF') pressure += MOSQUITO.pressureFactors.lot_half;
  if (waterMultiplier && waterMultiplier !== 1.0) {
    pressure *= waterMultiplier;
  }
  const pressureBeforeCap = pressure;
  pressure = Math.min(pressure, MOSQUITO.pressureCap);

  const recommendationReasons = [];
  if (pressure >= 1.30) recommendationReasons.push('pressure_at_or_above_1_30');
  if (waterMultiplier >= 1.20) recommendationReasons.push('water_multiplier_at_or_above_1_20');
  if (f.trees === 'heavy') recommendationReasons.push('heavy_trees');
  const recommendedProgram = recommendationReasons.length > 0 ? 'monthly12' : 'seasonal9';
  if (recommendedProgram === 'seasonal9') recommendationReasons.push('seasonal_default_low_pressure');

  const programMeta = normalizeMosquitoProgramSelection(tier);
  const normalizedRequestedTier = programMeta.normalizedRequestedTier;
  const selectedProgram = normalizedRequestedTier || recommendedProgram;
  const tierIndex = MOSQUITO.programs.indexOf(selectedProgram);
  if (tierIndex < 0) throw new Error(`Unknown mosquito program: ${tier}`);
  const tierWasForced = !!normalizedRequestedTier && selectedProgram !== recommendedProgram;
  if (tierWasForced) recommendationReasons.push('forced_by_request');
  const basePrice = basePrices[tierIndex];

  const perVisit = Math.round(basePrice * pressure);
  const visits = MOSQUITO.tierVisits[selectedProgram];
  const stationMeta = normalizeMosquitoAddOnCount(stationCount, 'station');
  const dunkMeta = normalizeMosquitoAddOnCount(dunkCount, 'dunk');
  const stationQty = stationMeta.count;
  const dunkQty = dunkMeta.count;
  // Recurring mosquito add-ons are annual add-ons, not per-visit add-ons.
  const stationAddOn = stationQty * MOSQUITO.addOns.in2CareStation.price;
  const dunkAddOn = dunkQty * MOSQUITO.addOns.dunkTablet.price;
  const annualAddOns = stationAddOn + dunkAddOn;
  const annual = perVisit * visits + annualAddOns;
  const monthly = Math.round(annual / 12 * 100) / 100;

  // Cost estimate
  const treatableThousands = Math.max(1, areaResolution.mosquitoTreatableSqFt / 1000);
  const usage = MOSQUITO.productUsage;
  const costs = MOSQUITO.productCosts;
  const usesPrecisionAdulticide = false;
  const adulticideCost = usesPrecisionAdulticide
    ? (usage.scionBaseOz + usage.scionOzPer1000 * treatableThousands) * costs.scionOz
    : Math.max(usage.bifenthrinBaseOz, usage.bifenthrinOzPer1000 * treatableThousands) * costs.bifenthrinOz;
  const igrCost = usage.tekkoProOz * costs.tekkoProOz;
  const materialPerVisit = Math.round((adulticideCost + igrCost) * 100) / 100;
  const addOnCost = stationQty * costs.in2CareStation + dunkQty * costs.summitDunkTablet;
  const laborPerVisitCost = laborCost(30);
  const annualCost = (materialPerVisit + laborPerVisitCost) * visits + addOnCost + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;
  const marginFloorOk = margin >= GLOBAL.MARGIN_FLOOR;

  const tiers = MOSQUITO.programs.map((name, idx) => {
    const bp = basePrices[idx];
    const pv = Math.round(bp * pressure);
    const v = MOSQUITO.tierVisits[name];
    const ann = pv * v + annualAddOns;
    return {
      tier: name,
      perVisit: pv,
      visits: v,
      annual: ann,
      monthly: Math.round(ann / 12 * 100) / 100,
      name: MOSQUITO.programLabels[name] || name.charAt(0).toUpperCase() + name.slice(1),
      selected: name === selectedProgram,
      recommended: name === recommendedProgram,
      pressureRecommended: name === recommendedProgram,
      isSelected: name === selectedProgram,
      isRecommended: name === recommendedProgram,
    };
  });

  const manualReviewReasons = uniqueList([
    ...areaResolution.manualReviewReasons,
    ...categoryResolution.manualReviewReasons,
    pressureBeforeCap > MOSQUITO.pressureCap ? 'pressure_cap_reached' : null,
    marginFloorOk ? null : 'margin_below_floor',
    stationQty >= 6 ? 'high_station_count' : null,
    dunkQty >= 10 ? 'high_dunk_count' : null,
    lotCategory === 'ACRE' ? 'acre_or_larger_property' : null,
  ]);
  const warnings = uniqueList([
    ...areaResolution.warnings,
    ...categoryResolution.warnings,
    ...waterMeta.warnings,
    ...programMeta.warnings,
    ...stationMeta.warnings,
    ...dunkMeta.warnings,
  ]);

  return {
    service: 'mosquito',
    tier: selectedProgram,
    selectedProgram,
    selectedTier: selectedProgram,
    recommendedProgram,
    recommendedTier: recommendedProgram,
    recommendationReasons: uniqueList(recommendationReasons),
    requestedTier: tier,
    normalizedRequestedTier,
    tierWasForced,
    lotCategory,
    grossLotCategory: categoryResolution.grossLotCategory || property.lotCategory,
    lotCategorySource: categoryResolution.lotCategorySource,
    lotCategoryGuardrailApplied: categoryResolution.lotCategoryGuardrailApplied,
    originalLotCategory: categoryResolution.originalLotCategory,
    adjustedLotCategory: categoryResolution.adjustedLotCategory,
    mosquitoTreatableSqFt: areaResolution.mosquitoTreatableSqFt,
    mosquitoTreatableSqFtSource: areaResolution.source,
    mosquitoTreatableSqFtConfidence: areaResolution.confidence,
    fallbackTreatableSqFt: areaResolution.fallbackTreatableSqFt,
    missingAreaData: areaResolution.missingAreaData,
    basePrice, pressureMultiplier: pressure,
    pressureBeforeCap,
    perVisit, visits, annual, monthly,
    tiers,
    addOns: {
      stationCount: stationQty,
      dunkCount: dunkQty,
      stationAddOn,
      dunkAddOn,
      annualAddOns,
    },
    costs: {
      adulticide: usesPrecisionAdulticide ? 'Gamma-cyhalothrin' : 'Bifenthrin',
      igr: 'Pyriproxyfen + Novaluron',
      materialPerVisit,
      addOnCost: Math.round(addOnCost * 100) / 100,
      laborPerVisit: Math.round(laborPerVisitCost * 100) / 100,
      annualCost: Math.round(annualCost),
    },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk,
    requiresManualReview: manualReviewReasons.length > 0,
    manualReviewReasons,
    warnings,
    waterMultiplier,
    waterMultiplierSource: waterMeta.waterMultiplierSource,
  };
}

// ============================================================
// TERMITE BAIT STATIONS
// ============================================================
function priceTermiteBait(property, options = {}) {
  const {
    // Default switched to Advance Apr 2026 (was 'trelona') for competitive
    // doorstep pricing. Trelona remains available as the premium upgrade.
    system = 'advance',
    monitoringTier = 'basic',
    modifiers = {},
  } = options;

  property = property || {};
  const systemResolution = normalizeTermiteSystem(system);
  const monitoringResolution = normalizeTermiteMonitoringTier(monitoringTier);
  const selectedSystem = systemResolution.selectedSystem;
  const selectedMonitoringTier = monitoringResolution.selectedMonitoringTier;
  const footprintResolution = resolveTermiteFootprint(property, options);
  const perimeterResolution = resolveTermiteBaitPerimeter(property, options);
  const complexity = normalizeTermiteComplexity(property, options);
  const perimMult = (complexity === 'complex' || complexity === 'moderate')
    ? TERMITE.perimeterMultiplier.complex
    : TERMITE.perimeterMultiplier.standard;
  const computedPerimeter = footprintResolution.value !== null
    ? Math.round(4 * Math.sqrt(footprintResolution.value) * perimMult)
    : null;
  const footprintRequired = perimeterResolution.source !== 'manual_override';
  const measurementState = footprintRequired
    ? mergeMeasurementState(footprintResolution, perimeterResolution)
    : mergeMeasurementState(perimeterResolution);
  const constructionMult = normalizePositiveTermiteModifier(
    modifiers.termiteConstructionMult,
    1.0,
    'invalid_termite_construction_multiplier_defaulted_to_1'
  );
  const foundationAdj = normalizeFiniteTermiteModifier(
    modifiers.termiteFoundationAdj,
    0,
    'invalid_termite_foundation_adjustment_defaulted_to_0'
  );
  const measurementWarnings = uniqueList([
    ...measurementState.warnings,
    ...systemResolution.warnings,
    ...monitoringResolution.warnings,
    ...constructionMult.warnings,
    ...foundationAdj.warnings,
  ]);
  const manualReviewReasons = uniqueList([
    ...measurementState.manualReviewReasons,
    ...constructionMult.warnings,
    ...foundationAdj.warnings,
  ]);
  const mon = TERMITE.monitoring[selectedMonitoringTier] || TERMITE.monitoring.basic;

  if (perimeterResolution.value === null) {
    return {
      service: 'termite_bait',
      system: selectedSystem,
      selectedSystem,
      requestedSystem: systemResolution.requestedSystem,
      monitoringTier: selectedMonitoringTier,
      selectedMonitoringTier,
      requestedMonitoringTier: monitoringResolution.requestedMonitoringTier,
      complexity,
      footprintSqFt: footprintResolution.value,
      footprintSource: footprintResolution.source,
      perimeter: null,
      computedPerimeter,
      perimeterSource: perimeterResolution.source,
      perimeterWasManualOverride: perimeterResolution.wasManualOverride,
      stations: null,
      measurements: {
        footprintSqFt: measurementObject(footprintResolution.value, footprintResolution.source),
        perimeterLF: measurementObject(null, perimeterResolution.source),
      },
      measurementWarnings,
      requiresMeasurement: true,
      quoteRequired: true,
      requiresManualReview: true,
      manualReviewReasons: uniqueList([
        ...manualReviewReasons,
        ...(footprintRequired ? ['termite_quote_requires_field_verification'] : []),
      ]),
      inputSourceSummary: {
        footprintSqFt: footprintResolution.source,
        perimeterLF: perimeterResolution.source,
      },
      installation: {
        materialCost: 0,
        laborCost: 0,
        totalCost: 0,
        price: null,
        margin: 0,
      },
      monitoring: {
        monthly: 0,
        annual: 0,
        quotedMonthly: mon.monthly,
        quotedAnnual: mon.monthly * 12,
      },
      annual: 0,
      monthly: 0,
    };
  }

  const perimeter = perimeterResolution.value;
  const stations = Math.max(TERMITE.minStations, Math.ceil(perimeter / TERMITE.stationSpacing));

  const sys = TERMITE.systems[selectedSystem] || TERMITE.systems.advance;
  const conMult = constructionMult.value;
  const foundAdj = foundationAdj.value;
  const installMaterialCost = stations * (sys.stationCost + sys.laborMaterial + sys.misc);
  // 5 min per station — calibrated Apr 2026 against All U Need invoice
  // (21 Sentricon stations installed in 78 min by one tech = 3.7 min/sta).
  // Prior value was 0.25 hr (15 min/sta), ~4x the observed pace, which made
  // reported install margin look artificially negative under the 1.45x mult.
  const installLabor = stations * 0.083 * GLOBAL.LABOR_RATE;
  const installCost = installMaterialCost + installLabor;
  const installPrice = Math.round(installMaterialCost * TERMITE.installMultiplier * conMult + foundAdj);
  const installMargin = installPrice > 0 ? (installPrice - installCost) / installPrice : 0;

  const monitoringMonthly = mon.monthly;
  const monitoringAnnual = monitoringMonthly * 12;

  return {
    service: 'termite_bait',
    system: selectedSystem,
    selectedSystem,
    requestedSystem: systemResolution.requestedSystem,
    monitoringTier: selectedMonitoringTier,
    selectedMonitoringTier,
    requestedMonitoringTier: monitoringResolution.requestedMonitoringTier,
    complexity,
    footprintSqFt: footprintResolution.value,
    footprintSource: footprintResolution.source,
    perimeter,
    computedPerimeter,
    perimeterSource: perimeterResolution.source,
    perimeterWasManualOverride: perimeterResolution.wasManualOverride,
    stations,
    measurements: {
      footprintSqFt: measurementObject(footprintResolution.value, footprintResolution.source),
      perimeterLF: measurementObject(perimeter, perimeterResolution.source),
    },
    measurementWarnings,
    requiresMeasurement: false,
    requiresManualReview: measurementState.requiresManualReview || measurementWarnings.length > 0,
    manualReviewReasons,
    inputSourceSummary: {
      footprintSqFt: footprintResolution.source,
      perimeterLF: perimeterResolution.source,
    },
    installation: {
      materialCost: Math.round(installMaterialCost),
      laborCost: Math.round(installLabor),
      totalCost: Math.round(installCost),
      price: installPrice,
      margin: Math.round(installMargin * 1000) / 1000,
    },
    monitoring: {
      monthly: monitoringMonthly,
      annual: monitoringAnnual,
    },
    annual: monitoringAnnual,
    monthly: monitoringMonthly,
  };
}

// ============================================================
// RODENT BAIT STATIONS
// ============================================================
function priceRodentBait(property, options = {}) {
  const { modifiers = {}, postExclusion = false } = options;
  const footprint = property.footprint;
  const lotSqFt = property.lotSqFt;
  const f = property.features || {};

  let score = 0;
  if (footprint >= 2500) score += RODENT.baitScoreFactors.footprint_2500plus;
  else if (footprint >= 1800) score += RODENT.baitScoreFactors.footprint_1800plus;
  if (lotSqFt >= 20000) score += RODENT.baitScoreFactors.lot_20000plus;
  else if (lotSqFt >= 12000) score += RODENT.baitScoreFactors.lot_12000plus;
  if (f.nearWater) score += RODENT.baitScoreFactors.nearWater;
  if (f.trees === 'heavy') score += RODENT.baitScoreFactors.trees_heavy;
  // Tile roof (barrel-tile nesting harborage) bumps size tier
  if ((property.roofType || '').toUpperCase() === 'TILE') score += 1;

  let size, monthly;
  if (score <= 1) { size = 'small'; monthly = RODENT.baitMonthly.small.monthly; }
  else if (score <= 2) { size = 'medium'; monthly = RODENT.baitMonthly.medium.monthly; }
  else { size = 'large'; monthly = RODENT.baitMonthly.large.monthly; }

  // Add roof-type adjustment (annual) for additional stations on tile/metal roofs
  const roofAnnualAdj = (modifiers.rodentRoofAdj || 0);
  let annual = monthly * 12 + roofAnnualAdj;
  monthly = Math.round(annual / 12 * 100) / 100;

  // Cost estimate: quarterly visits (4/yr) — billed monthly to customer.
  // On-site time per visit is slightly longer than the old monthly model
  // because the tech inspects all stations in one pass instead of spreading
  // checks across the year.
  const visitsPerYear = RODENT.baitVisitsPerYear || 4;
  let onSiteMin = size === 'small' ? 25 : size === 'medium' ? 30 : 40;
  let materialPerVisit = size === 'small' ? 6 : size === 'medium' ? 9 : 12;
  let stationAmortAnnual = size === 'small' ? 30 : size === 'medium' ? 45 : 60;

  // POST-EXCLUSION MODIFIER — sealed structure = lighter scope
  // Three independent levers (per post-exclusion-modifier-spec.md):
  //   1. Station count   ~ -35% (perimeter only, floor 4 stations) → revenue-side ~0.65×
  //   2. Bait cost       ~ -20% (lower uptake on sealed structure)
  //   3. Labor           ~ -40% (no diagnostic, lighter visits)
  // Net combined revenue impact ≈ 0.72×. Floor rebased to $39/mo for new
  // quarterly-cadence base prices ($49/$59/$69).
  if (postExclusion) {
    const cfg = RODENT.baitPostExclusion || { multiplier: 0.72, floorMonthly: 39 };
    monthly = Math.max(cfg.floorMonthly, Math.round(monthly * cfg.multiplier * 100) / 100);
    annual = Math.round(monthly * 12);
    materialPerVisit = Math.round(materialPerVisit * 0.80 * 100) / 100;
    onSiteMin = Math.round(onSiteMin * 0.60);
  }

  const laborPerVisitCost = laborCost(onSiteMin);
  const annualCost =
    (materialPerVisit + laborPerVisitCost) * visitsPerYear
    + stationAmortAnnual
    + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;

  return {
    service: 'rodent_bait',
    score, size, monthly, annual,
    visitsPerYear,
    postExclusion,
    costs: {
      materialPerVisit,
      laborPerVisit: Math.round(laborPerVisitCost * 100) / 100,
      stationAmortAnnual,
      annualCost: Math.round(annualCost),
    },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
    tierQualifier: RODENT.tierQualifier,
    excludeFromPctDiscount: RODENT.excludeFromPctDiscount,
  };
}

// ============================================================
// RODENT TRAPPING (One-Time)
// ============================================================
// Standard = setup + 2 callbacks/checks. Unlimited = callbacks for the same
// active trapping job only. Trap-only monitoring is priced separately and is
// not a warranty.
//
// Inputs:
//   property: { footprint, lotSqFt, features }
//   options:
//     pressure: 'light' | 'normal' | 'moderate' | 'heavy' | 'severe'
//     emergency: boolean — same-day / urgent surcharge
//
// Pressure inferred from property.features when not provided:
//   trees=heavy + nearWater  → heavy
//   trees=heavy or nearWater → moderate
//   default                  → normal
function _bracketLookup(value, brackets, key) {
  for (const b of brackets) {
    if (value <= b[key]) return b;
  }
  return brackets[brackets.length - 1];
}

function priceRodentTrapping(property, options = {}) {
  const cfg = RODENT.trapping;
  const plan = options.plan === 'unlimited' || options.rodentTrappingPlan === 'unlimited'
    ? 'unlimited'
    : 'standard';
  const { emergency = false } = options;
  const includedCallbacks = plan === 'standard' ? Number(cfg.includedFollowUps) || 2 : 'unlimited';
  const unlimitedCallbacks = plan === 'unlimited';
  const callbacksUsed = Math.max(0, Math.floor(Number(options.callbacksUsed) || 0));
  const requestedExtraCallbacks = Math.max(0, Math.floor(Number(options.extraCallbackCount) || 0));
  const extraCallbackAllowed = plan === 'standard' && callbacksUsed >= includedCallbacks;
  const extraCallbackCount = extraCallbackAllowed ? requestedExtraCallbacks : 0;
  const extraCallbackPrice = extraCallbackCount * cfg.additionalFollowUpRate;
  const basePrice = unlimitedCallbacks ? cfg.unlimitedPrice : cfg.standardPrice;
  const trappingBasePrice = options.upgradeToUnlimited
    ? cfg.upgradeToUnlimitedPrice
    : basePrice;

  let emergencySurcharge = 0;
  if (emergency) {
    const pctSurcharge = trappingBasePrice * (cfg.emergencyMultiplier - 1);
    emergencySurcharge = Math.max(pctSurcharge, cfg.emergencyMinimumSurcharge);
  }

  const price = Math.round(trappingBasePrice + emergencySurcharge + extraCallbackPrice);
  const name = options.upgradeToUnlimited
    ? 'Rodent Trapping - Upgrade to Unlimited'
    : plan === 'unlimited'
      ? 'Rodent Trapping - Unlimited Callback'
      : 'Rodent Trapping - Standard';
  const warnings = [];
  if (requestedExtraCallbacks > 0 && !extraCallbackAllowed) {
    warnings.push('Extra callbacks can only be billed after the 2 included Standard callbacks/checks are used.');
  }
  if (plan === 'unlimited') {
    warnings.push('Unlimited callbacks apply to the same active trapping job only, not lifetime coverage or new infestations after job closure.');
  }
  const detail = options.upgradeToUnlimited
    ? 'Upgrade Standard Rodent Trapping to Unlimited Callback for the same active trapping job.'
    : cfg.invoiceDescriptions[plan];

  return {
    service: 'rodent_trapping',
    name,
    price,
    finalPrice: price,
    lineItems: [
      {
        service: 'rodent_trapping',
        name,
        price: trappingBasePrice,
        discountEligible: false,
        detail,
      },
      ...(emergencySurcharge > 0 ? [{
        service: 'rodent_trapping_emergency_surcharge',
        name: 'Emergency surcharge',
        price: Math.round(emergencySurcharge),
        discountEligible: false,
        detail: '20% or $75 minimum, whichever is greater.',
      }] : []),
      ...(extraCallbackCount > 0 ? [{
        service: 'rodent_trapping_extra_callback',
        name: 'Rodent Trapping - Extra Callback',
        count: extraCallbackCount,
        perVisit: cfg.additionalFollowUpRate,
        price: extraCallbackPrice,
        discountEligible: false,
        detail: `Additional callbacks after included visits are $${cfg.additionalFollowUpRate} each.`,
      }] : []),
    ],
    base: trappingBasePrice,
    trappingBasePrice,
    rodentTrappingPlan: plan,
    includedCallbacks,
    callbacksUsed,
    extraCallbackCount,
    extraCallbackPrice,
    extraCallbackAllowed,
    unlimitedCallbacks,
    emergency,
    emergencySurcharge: Math.round(emergencySurcharge),
    emergencySurchargeApplied: emergencySurcharge > 0,
    emergencySurchargeAmount: Math.round(emergencySurcharge),
    includedFollowUps: includedCallbacks,
    activeWindowDays: null,
    customRecommended: false,
    requiresCustomQuote: false,
    quoteRequired: false,
    customQuoteReason: null,
    reason: null,
    detail,
    invoiceDescription: detail,
    floorsApplied: [],
    discounts: [],
    warnings,
    warrantyEligible: false,
    pricingSource: 'rodent_trapping_revised_2026',
    pricingBasis: {
      standardPrice: cfg.standardPrice,
      unlimitedPrice: cfg.unlimitedPrice,
      upgradeToUnlimitedPrice: cfg.upgradeToUnlimitedPrice,
      extraCallbackRate: cfg.additionalFollowUpRate,
      emergencyMultiplier: cfg.emergencyMultiplier,
      emergencyMinimumSurcharge: cfg.emergencyMinimumSurcharge,
    },
  };
}

// ============================================================
// RODENT TRAPPING — ADDITIONAL FOLLOW-UP VISITS
// ============================================================
function priceRodentTrappingFollowups(count = 1, options = {}) {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return null;

  const cfg = RODENT.trapping;
  const callbacksUsed = Math.max(0, Math.floor(Number(options.callbacksUsed) || 0));
  const includedCallbacks = Number(cfg.includedFollowUps) || 2;
  if (options.plan === 'unlimited' || options.unlimitedCallbacks) {
    return {
      service: 'rodent_trapping_followup',
      count: n,
      perVisit: 0,
      price: 0,
      included: true,
      unlimitedCallbacks: true,
      detail: `${n} trap check${n === 1 ? '' : 's'} included for the same active trapping job`,
    };
  }
  const allowed = callbacksUsed >= includedCallbacks;

  return {
    service: 'rodent_trapping_followup',
    count: n,
    perVisit: allowed ? cfg.additionalFollowUpRate : 0,
    price: allowed ? n * cfg.additionalFollowUpRate : 0,
    included: !allowed,
    includedCallbacks,
    callbacksUsed,
    requiresCustomQuote: false,
    quoteRequired: false,
    customQuoteReason: null,
    reason: allowed ? null : 'Extra callbacks can only be billed after the 2 included Standard callbacks/checks are used.',
    detail: allowed
      ? `${n} extra callback${n === 1 ? '' : 's'} at $${cfg.additionalFollowUpRate} each`
      : `${n} callback${n === 1 ? '' : 's'} not billable until included callbacks/checks are used`,
  };
}

function priceTrapOnlyRetainer(options = {}) {
  const cfg = RODENT.trapOnlyRetainer;
  const planKey = cfg.plans[options.plan] ? options.plan : 'standard';
  const plan = cfg.plans[planKey];
  const billing = options.billing === 'monthly' ? 'monthly' : 'annual';
  const responseCallbacksUsed = Math.max(0, Math.floor(Number(options.responseCallbacksUsed) || 0));
  const requestedExtraCallbacks = Math.max(0, Math.floor(Number(options.extraCallbackCount) || 0));
  const extraCallbackCount = responseCallbacksUsed >= plan.responseCallbacksIncluded ? requestedExtraCallbacks : 0;
  const extraCallbackPrice = extraCallbackCount * cfg.extraCallbackRate;
  const annualPrepaid = billing === 'annual';
  const attachedToCompletedTrappingJob = !!options.attachedToCompletedTrappingJob || !!options.activeTrappingClosedAt;
  const waiveSetupFee = annualPrepaid || attachedToCompletedTrappingJob || !!options.waiveSetupFee;
  const setupFee = waiveSetupFee ? 0 : cfg.setupFee;
  const retainerPrice = annualPrepaid ? plan.annualPrice : plan.monthlyPrice;
  const finalPrice = retainerPrice + setupFee + extraCallbackPrice;
  const warnings = [cfg.warning];
  if (requestedExtraCallbacks > 0 && extraCallbackCount === 0) {
    warnings.push('Extra response callbacks can only be billed after included retainer response callbacks are used.');
  }

  return {
    service: 'trap_only_retainer',
    name: plan.label,
    trapOnlyRetainerPlan: planKey,
    trapOnlyRetainerBilling: billing,
    trapOnlyRetainerAnnualPrice: plan.annualPrice,
    trapOnlyRetainerMonthlyPrice: plan.monthlyPrice,
    trapOnlyScheduledVisitsIncluded: plan.scheduledVisitsIncluded,
    trapOnlyResponseCallbacksIncluded: plan.responseCallbacksIncluded,
    trapOnlyResponseCallbacksUsed: responseCallbacksUsed,
    trapOnlySetupFee: setupFee,
    trapOnlyActivationDate: options.activationDate || null,
    trapOnlyRenewalDate: options.renewalDate || null,
    price: finalPrice,
    subtotal: finalPrice,
    finalPrice,
    discounts: [],
    floorsApplied: [],
    warnings,
    warrantyEligible: false,
    rodentExclusionDeclined: true,
    discountEligible: false,
    excludedFromCoupons: true,
    excludedFromWaveGuardDiscounts: true,
    excludedFromBundleDiscounts: true,
    lineItems: [
      {
        service: 'trap_only_retainer',
        name: `${plan.label} - ${billing === 'annual' ? 'Annual prepaid' : 'Monthly, 12-month agreement'}`,
        price: retainerPrice,
        discountEligible: false,
        detail: billing === 'annual'
          ? `$${plan.annualPrice}/year. Includes ${plan.scheduledVisitsIncluded} scheduled checks and ${plan.responseCallbacksIncluded} response callbacks per year.`
          : `$${plan.monthlyPrice}/month with 12-month agreement. Includes ${plan.scheduledVisitsIncluded} scheduled checks and ${plan.responseCallbacksIncluded} response callbacks per year.`,
      },
      ...(setupFee > 0 ? [{
        service: 'trap_only_setup',
        name: 'Trap-only setup / inspection',
        price: setupFee,
        discountEligible: false,
      }] : []),
      ...(extraCallbackCount > 0 ? [{
        service: 'trap_only_extra_callback',
        name: 'Trap-only extra response callback',
        count: extraCallbackCount,
        perVisit: cfg.extraCallbackRate,
        price: extraCallbackPrice,
        discountEligible: false,
      }] : []),
    ],
    detail: 'Trap-only monitoring is not a rodent guarantee because exclusion was declined.',
    pricingSource: 'trap_only_monitoring_retainer_2026',
    pricingBasis: {
      setupFee: cfg.setupFee,
      extraCallbackRate: cfg.extraCallbackRate,
      plan,
    },
  };
}

function priceRodentWireMesh(options = {}) {
  const cfg = RODENT.wireMesh;
  const substrateKey = cfg.substrates[options.meshSubstrate] ? options.meshSubstrate : 'wood_soft';
  const substrate = cfg.substrates[substrateKey];
  const meshLinearFeet = Math.max(0, Number(options.meshLinearFeet) || 0);
  const measuredOrEstimated = options.measuredOrEstimated === 'measured' ? 'measured' : 'estimated';
  const meshBase = meshLinearFeet * substrate.ratePerLinearFoot;
  const basePrice = Math.max(meshBase, substrate.minimum);
  const storyMult = options.storyMultiplier || options.storyMult || 1;
  const roofMult = options.roofMultiplier || options.roofMult || 1;
  const constructionMult = options.constructionMultiplier || options.constructionMult || 1;
  const adjusted = Math.max(substrate.minimum, Math.round(basePrice * storyMult * roofMult * constructionMult));
  const warnings = [];
  const requiresFieldVerification = measuredOrEstimated === 'estimated' && (
    meshLinearFeet > 40 ||
    substrateKey === 'roofline_soffit_eave' ||
    substrateKey === 'tile_steep_fragile_roofline'
  );
  if (requiresFieldVerification) warnings.push('Field verification required before final quote.');
  if (substrate.customQuoteRecommended) warnings.push('Tile, steep, or fragile roofline mesh may require custom quote review.');

  return {
    service: 'rodent_wire_mesh',
    name: 'Rodent Wire Mesh Exclusion',
    meshLinearFeet,
    meshSubstrate: substrateKey,
    meshRatePerLinearFoot: substrate.ratePerLinearFoot,
    meshMinimum: substrate.minimum,
    meshMeasuredOrEstimated: measuredOrEstimated,
    measuredOrEstimated,
    meshPrice: adjusted,
    price: adjusted,
    subtotal: adjusted,
    finalPrice: adjusted,
    lineItems: [{
      service: 'rodent_wire_mesh',
      name: 'Wire mesh exclusion',
      price: adjusted,
      detail: `${meshLinearFeet} LF at $${substrate.ratePerLinearFoot}/LF (${substrate.label})`,
    }],
    discounts: [],
    floorsApplied: adjusted === substrate.minimum ? [{ service: 'rodent_wire_mesh', floor: substrate.minimum }] : [],
    warnings,
    requiresFieldVerification,
    customQuoteRecommended: !!substrate.customQuoteRecommended,
    warrantyEligible: true,
    pricingSource: 'rodent_wire_mesh_lf_2026',
    pricingBasis: { meshBase, substrate, storyMult, roofMult, constructionMult },
  };
}

function estimateRodentWireMeshLinearFeet(homeSqFt = 0) {
  const roundUpToNearest5 = (value) => Math.ceil(value / 5) * 5;
  const typicalMeshLF = roundUpToNearest5((Number(homeSqFt) || 0) / 100);
  return {
    typicalMeshLF,
    lightMeshLF: Math.max(10, roundUpToNearest5(typicalMeshLF * 0.65)),
    heavyMeshLF: roundUpToNearest5(typicalMeshLF * 1.40),
  };
}

function priceRodentBirdBoxes(options = {}) {
  const cfg = RODENT.birdBoxes;
  const type = cfg[options.birdBoxType] ? options.birdBoxType : 'standard_bird_box';
  const qty = Math.max(0, Math.floor(Number(options.birdBoxQuantity) || 0));
  if (qty === 0) return null;
  let price = 0;
  if (type === 'standard_bird_box') {
    price = cfg.standard_bird_box + Math.max(0, qty - 1) * cfg.additional_standard_same_visit;
  } else {
    price = cfg[type] * qty;
  }
  return {
    service: 'rodent_bird_box',
    name: 'Roof-entry cover / bird box',
    birdBoxType: type,
    birdBoxQuantity: qty,
    birdBoxPrice: price,
    price,
    subtotal: price,
    finalPrice: price,
    lineItems: [{
      service: 'rodent_bird_box',
      name: 'Roof-entry cover / bird box',
      count: qty,
      price,
      detail: type === 'standard_bird_box' && qty > 1
        ? `$${cfg.standard_bird_box} first standard box + $${cfg.additional_standard_same_visit} each additional same visit`
        : `${qty} ${type.replace(/_/g, ' ')} at $${cfg[type]} each`,
    }],
    discounts: [],
    floorsApplied: price / qty <= 195 ? [{ service: 'rodent_bird_box', floor: 195 }] : [],
    warnings: type === 'oversized_complex_custom' ? ['Complex roof-entry cover may require custom quote review.'] : [],
    warrantyEligible: true,
    pricingSource: 'rodent_bird_box_unit_2026',
    pricingBasis: { rates: cfg },
  };
}

// ============================================================
// RODENT SANITATION (bleach + wipe; CDC-aligned cleanup)
// ============================================================
// Three tiers — light / standard / heavy — with affected-sqft scaling
// and per-cu-ft contaminated-debris pricing.
//
// Inputs:
//   tier:                  'light' | 'standard' | 'heavy' (alias 'medium' → 'standard')
//   affectedSqFt:          actual cleanup area on site
//   insulationRemovalCuFt: contaminated debris volume to dispose
//   accessType:            'normal' | 'crawlspace' | 'tight' (heavy tier only)
//
// Pricing formula:
//   tier base
//   + max(0, affectedSqFt - includedSqFt)   * additionalPerSqFt
//   + max(0, debrisCuFt    - includedDebris) * additionalDebrisPerCuFt
//   * accessMultiplier (heavy tier)
//
// Heavy tier requires custom-quote review when debris > 25 cu ft (this is
// the cutoff at which most real attic insulation removal jobs need a sub
// or HEPA truck — we flag rather than silently underprice).
function priceSanitation(options = {}) {
  const {
    tier: rawTier = 'standard',
    affectedSqFt = 0,
    insulationRemovalCuFt = 0,
    accessType = 'normal',
  } = options;

  const aliasedTier = RODENT.sanitation.legacyAliases?.[rawTier] || rawTier;
  const cfg = RODENT.sanitation[aliasedTier];
  if (!cfg || aliasedTier === 'legacyAliases') {
    throw new Error(`Unknown sanitation tier: ${rawTier}`);
  }

  const sqFtOverage = Math.max(0, affectedSqFt - cfg.includedSqFt);
  const debrisOverage = Math.max(0, insulationRemovalCuFt - (cfg.includedDebrisCuFt || 0));
  const sqFtCharge = sqFtOverage * cfg.additionalPerSqFt;
  const debrisCharge = debrisOverage * (cfg.additionalDebrisPerCuFt || 0);

  let raw = cfg.base + sqFtCharge + debrisCharge;

  // Heavy-tier access multipliers
  let accessMult = 1.0;
  if (aliasedTier === 'heavy') {
    if (accessType === 'crawlspace') accessMult = cfg.crawlspaceMultiplier || 1.0;
    else if (accessType === 'tight') accessMult = cfg.tightAccessMultiplier || 1.0;
  }
  raw *= accessMult;

  const price = Math.max(cfg.floor, Math.round(raw / 5) * 5);

  // Flag for custom quote when debris exceeds heavy-tier ceiling
  const customQuoteRecommended = aliasedTier === 'heavy' && insulationRemovalCuFt > 25 + 25;

  return {
    service: 'rodent_sanitation',
    tier: aliasedTier,
    name: `Rodent Sanitation (${cfg.label})`,
    price,
    base: cfg.base,
    sqFtOverage,
    debrisOverage,
    sqFtCharge: Math.round(sqFtCharge * 100) / 100,
    debrisCharge: Math.round(debrisCharge),
    accessMult,
    customQuoteRecommended,
    detail: `${cfg.label} — ${cfg.durationMin} min | ${affectedSqFt} sf affected`
      + (debrisOverage > 0 ? ` | +${debrisOverage} cu ft debris` : '')
      + (accessMult > 1 ? ` | ${accessType} access ×${accessMult}` : ''),
  };
}

// ============================================================
// BAIT-STATION SETUP FEE (waived in standard recurring sign-up)
// ============================================================
// Returns 0 when waived (caller decides). Constant retained on the
// books so non-recurring edge cases can invoice it explicitly.
function priceBaitSetup(options = {}) {
  const { waived = true } = options;
  return {
    service: 'rodent_bait_setup',
    name: 'Bait Station Setup',
    price: waived ? 0 : RODENT.baitSetupFee,
    waived,
    detail: waived
      ? 'Waived with recurring plan'
      : `One-time $${RODENT.baitSetupFee} setup`,
  };
}

// ============================================================
// ONE-TIME PEST
// ============================================================
function priceOneTimePest(property, options = {}) {
  const {
    urgency = 'NONE',
    afterHours = false,
    isRecurringCustomer = false,
    recurringPestPerApp = null,
    roachType: requestedRoachTypeInput = 'none',
  } = options;

  const roachMeta = normalizeRoachType(requestedRoachTypeInput);
  const footprintResolution = resolvePestFootprint(property);
  const warnings = [...roachMeta.roachWarnings, ...footprintResolution.warnings];
  let base;
  let baseSource;
  let baselinePest = null;
  // `base` is always the QUARTERLY per-app rate. Callers passing
  // `recurringPestPerApp` MUST pass the quarterly per-app (== pest line
  // `basePrice`), never a discounted bimonthly/monthly per-app — otherwise the
  // one-time anchor is understated. `basePrice` is frequency-independent
  // (quarterly freqMult is 1.0, so quarterly perApp === basePrice), which is
  // why the estimate engine hands us `basePrice`.
  const recurringPerApp = Number(recurringPestPerApp);
  if (Number.isFinite(recurringPerApp) && recurringPerApp > 0) {
    const roachMod = PEST.roachModifier[roachMeta.roachType] || 0;
    // Legacy guard: roach modifiers are currently zero, but keep the backout
    // harmless if an old saved estimate or future config reintroduces a value.
    base = recurringPerApp / (1 + roachMod);
    baseSource = 'recurringPestPerApp';
  } else {
    if (hasValue(recurringPestPerApp)) warnings.push('invalid_recurring_pest_per_app_ignored');
    baselinePest = pricePestControl(property, { frequency: 'quarterly', roachType: 'none' });
    base = baselinePest.basePrice;
    baseSource = 'computed_quarterly_baseline';
  }

  // One-time = quarterly per-app × multiplier. The quarterly rate already
  // encodes all property metrics (footprint, lot, tree/shrub, pool/cage,
  // driveway, complexity, type, age), so one-time scales proportionally with
  // real job difficulty. multiplier >= 2 (+ the $199 floor) keeps a one-off
  // visit above a recurring customer's visit-1 cost ($99 setup + quarterly),
  // preserving the incentive to commit.
  const multiplier = Number.isFinite(Number(ONE_TIME.pest.multiplier)) && Number(ONE_TIME.pest.multiplier) > 0
    ? Number(ONE_TIME.pest.multiplier)
    : 1;
  const multipliedPrice = Math.round(base * multiplier);
  const preUrgencyPrice = applyOneTimeFloor(
    multipliedPrice,
    ONE_TIME.pest.floor
  );
  const urgencyMultiplier = getOneTimeUrgencyMultiplier({ urgency, afterHours });
  const discountBase = preUrgencyPrice * urgencyMultiplier;
  const discounted = applyOneTimeRecurringCustomerDiscount(discountBase, { isRecurringCustomer });
  let price = applyOneTimeFloor(discounted.price, ONE_TIME.pest.floor);

  // Recurring-incentive clamp. The 15% loyalty perk is applied AFTER the floor,
  // so on small homes (where the multiple sits near the floor) it could push a
  // one-time visit to/below a recurring customer's visit-1 cost (quarterly +
  // $99 setup) — making a one-off no more expensive than committing. Never let
  // that happen: one-time stays STRICTLY above recurring visit-1 (prices are
  // whole dollars, so +1 is the minimal strict margin). Only binds for recurring
  // customers on small homes with no urgency surcharge; for everyone else the
  // multiple already clears it (guaranteed by the db-bridge invariant).
  const recurringVisitOneCost = Math.round((base + (PEST.initialFee || 0)) * 100) / 100;
  const recurringIncentiveClampApplied = price <= recurringVisitOneCost;
  if (recurringIncentiveClampApplied) price = recurringVisitOneCost + 1;

  return {
    service: 'one_time_pest',
    price,
    urgency,
    afterHours,
    isRecurringCustomer,
    basePrice: Math.round(base * 100) / 100,
    quarterlyPerApp: Math.round(base * 100) / 100,
    multiplier,
    recurringVisitOneCost,
    recurringIncentiveClampApplied,
    baseSource,
    baselinePestBasePrice: baselinePest?.basePrice ?? null,
    selectedFloor: ONE_TIME.pest.floor,
    floorAppliedBeforeUrgency: preUrgencyPrice > multipliedPrice,
    floorAppliedAfterDiscount: price > discounted.price,
    requestedRoachType: roachMeta.requestedRoachType,
    roachType: roachMeta.roachType,
    roachTypeWasDefaulted: roachMeta.roachTypeWasDefaulted,
    preUrgencyPrice,
    urgencyMultiplier,
    subtotalBeforeRecurringCustomerDiscount: Math.round(discountBase),
    recurringCustomerDiscountRate: discounted.rate,
    recurringCustomerDiscountAmount: Math.max(0, Math.round(discountBase) - price),
    discountHandledByPricingFunction: true,
    footprintUsed: baselinePest?.footprintUsed ?? footprintResolution.footprint,
    footprintSource: baselinePest?.footprintSource ?? footprintResolution.source,
    footprintWasDefaulted: baselinePest?.footprintWasDefaulted ?? footprintResolution.wasDefaulted,
    requiresManualReview: !!(baselinePest?.requiresManualReview || footprintResolution.requiresManualReview),
    manualReviewReasons: combineManualReviewMetadata(baselinePest?.manualReviewReasons, footprintResolution.manualReviewReasons),
    warnings: uniqueList([...warnings, ...(baselinePest?.warnings || [])]),
  };
}

// ============================================================
// ONE-TIME LAWN
// ============================================================
function priceOneTimeLawn(property, options = {}) {
  const {
    treatmentType = 'weed',
    urgency = 'NONE',
    afterHours = false,
    isRecurringCustomer = false,
    track = 'st_augustine',
    tier = 'enhanced',
    lawnFreq,
  } = options;

  const normalizedTreatment = treatmentType === 'fertilization' ? 'fert' : treatmentType;
  const lawnResult = priceLawnCare(property, {
    track,
    tier,
    lawnFreq,
    useLawnCostFloor: false,
  });
  const base = Math.max(ONE_TIME.lawn.floor, Math.round(lawnResult.perApp * ONE_TIME.lawn.oneTimeMultiplier));

  const treatMult = ONE_TIME.lawn.treatmentMultipliers[normalizedTreatment] || 1.0;
  const preUrgencyPrice = applyOneTimeFloor(Math.round(base * treatMult), ONE_TIME.lawn.floor);
  const urgencyMultiplier = getOneTimeUrgencyMultiplier({ urgency, afterHours });
  const discountBase = preUrgencyPrice * urgencyMultiplier;
  const discounted = applyOneTimeRecurringCustomerDiscount(discountBase, { isRecurringCustomer });
  const price = applyOneTimeFloor(discounted.price, ONE_TIME.lawn.floor);

  return {
    service: 'one_time_lawn',
    price,
    treatmentType: normalizedTreatment,
    urgency,
    afterHours,
    isRecurringCustomer,
    basePrice: base,
    treatmentMultiplier: treatMult,
    preUrgencyPrice,
    urgencyMultiplier,
    subtotalBeforeRecurringCustomerDiscount: Math.round(discountBase),
    recurringCustomerDiscountRate: discounted.rate,
    recurringCustomerDiscountAmount: Math.max(0, Math.round(discountBase) - price),
    discountHandledByPricingFunction: true,
    baselinePerApp: lawnResult.perApp,
    baselinePricingBasis: lawnResult.pricingBasis,
    baselinePricingSource: lawnResult.pricingSource,
    customQuoteFlag: lawnResult.customQuoteFlag,
    notes: lawnResult.notes || [],
  };
}

// ============================================================
// ONE-TIME MOSQUITO
// ============================================================
function getOneTimeMosquitoAreaBucket(mosquitoTreatableSqFt) {
  const sqft = Math.max(0, Math.round(Number(mosquitoTreatableSqFt) || 0));
  if (sqft <= 7500) return 'SMALL';
  if (sqft <= 11000) return 'STANDARD';
  if (sqft <= 16000) return 'LARGE';
  if (sqft <= 24000) return 'XL';
  if (sqft <= 32000) return 'ESTATE';
  if (sqft <= 43560) return 'ACRE_CLASS';
  return 'OVER_ACRE';
}

function getOneTimeMosquitoBase(mosquitoTreatableSqFt) {
  const sqft = Math.max(0, Math.round(Number(mosquitoTreatableSqFt) || 0));
  const areaBucket = getOneTimeMosquitoAreaBucket(sqft);
  const base = ONE_TIME.mosquito[areaBucket] || ONE_TIME.mosquito.SMALL;
  if (areaBucket !== 'OVER_ACRE') {
    return { areaBucket, basePrice: base, requiresManualReview: false };
  }
  const overageSqFt = Math.max(0, sqft - 43560);
  const incrementCount = Math.ceil(overageSqFt / ONE_TIME.mosquito.overAcreIncrementSqFt);
  return {
    areaBucket,
    basePrice: base + incrementCount * ONE_TIME.mosquito.overAcreIncrementPrice,
    requiresManualReview: true,
    overageSqFt,
    incrementCount,
  };
}

function priceOneTimeMosquito(property, options = {}) {
  property = property || {};
  const areaResolution = resolveMosquitoTreatableArea(property);
  const mosquitoTreatableSqFt = Math.max(0, Math.round(areaResolution.mosquitoTreatableSqFt || 0));
  const base = getOneTimeMosquitoBase(mosquitoTreatableSqFt);
  const stationMeta = normalizeMosquitoAddOnCount(options.stationCount, 'station');
  const dunkMeta = normalizeMosquitoAddOnCount(options.dunkCount, 'dunk');
  const stationCount = stationMeta.count;
  const dunkCount = dunkMeta.count;
  const stationAddOnTotal = stationCount * ONE_TIME.mosquito.stationAddOn;
  const dunkAddOnTotal = dunkCount * ONE_TIME.mosquito.dunkAddOn;
  const subtotalBeforeRecurringCustomerDiscount = base.basePrice + stationAddOnTotal + dunkAddOnTotal;
  const discounted = applyOneTimeRecurringCustomerDiscount(subtotalBeforeRecurringCustomerDiscount, {
    isRecurringCustomer: !!options.isRecurringCustomer,
  });
  const price = discounted.price;
  const detailParts = [];
  if (stationCount > 0) detailParts.push(`${stationCount} mosquito station${stationCount === 1 ? '' : 's'} (+$${Math.round(stationAddOnTotal)})`);
  if (dunkCount > 0) detailParts.push(`${dunkCount} Bti dunk tablet${dunkCount === 1 ? '' : 's'} (+$${Math.round(dunkAddOnTotal)})`);
  const manualReviewReasons = uniqueList([
    ...areaResolution.manualReviewReasons,
    base.requiresManualReview ? 'over_acre_mosquito_treatment' : null,
    stationCount >= 6 ? 'high_station_count' : null,
    dunkCount >= 10 ? 'high_dunk_count' : null,
  ]);
  const warnings = uniqueList([
    ...areaResolution.warnings,
    ...stationMeta.warnings,
    ...dunkMeta.warnings,
  ]);
  return {
    service: 'one_time_mosquito',
    key: 'oneTimeMosquito',
    name: 'One-Time Mosquito Treatment',
    recurring: false,
    price,
    mosquitoTreatableSqFt,
    mosquitoTreatableSqFtSource: areaResolution.source,
    mosquitoTreatableSqFtConfidence: areaResolution.confidence,
    fallbackTreatableSqFt: areaResolution.fallbackTreatableSqFt,
    missingAreaData: areaResolution.missingAreaData,
    areaBucket: base.areaBucket,
    lotCategory: base.areaBucket,
    basePrice: base.basePrice,
    stationCount,
    stationAddOnTotal,
    dunkCount,
    dunkAddOnTotal,
    subtotalBeforeRecurringCustomerDiscount,
    recurringCustomerDiscountRate: discounted.rate,
    recurringCustomerDiscountAmount: discounted.amount,
    requiresManualReview: manualReviewReasons.length > 0,
    manualReviewReasons,
    warnings,
    overageSqFt: base.overageSqFt || 0,
    incrementCount: base.incrementCount || 0,
    detail: detailParts.join(' + '),
    addOns: {
      stationCount,
      dunkCount,
      stationAddOn: stationAddOnTotal,
      dunkAddOn: dunkAddOnTotal,
      stationAddOnTotal,
      dunkAddOnTotal,
    },
    discountHandledByPricingFunction: true,
  };
}

// ============================================================
// SPECIALTY SERVICES
// ============================================================

function normalizeTrenchingTermiticideProduct(value, options = {}) {
  const cfg = SPECIALTY.trenching || {};
  const requestedProductKey = value;
  const defaultProductKey = cfg.defaultProductKey || 'taurus_sc';
  if (!hasValue(value)) {
    return {
      requestedProductKey,
      productKey: defaultProductKey,
      warnings: [],
      requiresManualReview: false,
      manualReviewReasons: [],
    };
  }

  const raw = normalizeToken(value).replace(/\//g, '_').replace(/_+/g, '_');
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
  const productKey = aliases[raw];
  if (productKey && cfg.products?.[productKey]) {
    return {
      requestedProductKey,
      productKey,
      warnings: [],
      requiresManualReview: false,
      manualReviewReasons: [],
    };
  }

  const warning = options.legacyPayload
    ? 'unknown_legacy_trenching_product_defaulted_to_taurus_sc'
    : 'unknown_trenching_termiticide_product_requires_review';
  return {
    requestedProductKey,
    productKey: defaultProductKey,
    warnings: [warning],
    requiresManualReview: !options.legacyPayload,
    manualReviewReasons: options.legacyPayload ? [] : ['invalid_trenching_termiticide_product'],
  };
}

function normalizeTrenchingApplicationRate(value) {
  const requestedApplicationRate = value;
  if (!hasValue(value)) {
    return { requestedApplicationRate, applicationRate: SPECIALTY.trenching.defaultApplicationRate || 'standard', warnings: [] };
  }
  const raw = normalizeToken(value)
    .replace(/%/g, '')
    .replace(/\./g, '_')
    .replace(/_+/g, '_');
  const aliases = {
    standard: 'standard',
    regular: 'standard',
    '0_06': 'standard',
    standard_0_06: 'standard',
    high: 'high',
    high_rate: 'high',
    '0_125': 'high',
    '0_12': 'high',
    problem_soil: 'high',
    active_subterranean: 'high',
    formosan: 'high',
    asian_subterranean: 'high',
  };
  const applicationRate = aliases[raw] || 'standard';
  return {
    requestedApplicationRate,
    applicationRate,
    warnings: raw && !aliases[raw] ? ['invalid_trenching_application_rate_defaulted_to_standard'] : [],
  };
}

function defaultTrenchingWarrantyTier(product = {}) {
  return product.chemistryType === 'repellent_pyrethroid' ? 'none' : 'one_year_retreat';
}

function normalizeTrenchingWarrantyTier(value, product = {}) {
  const requestedWarrantyTier = value;
  if (!hasValue(value)) {
    return {
      requestedWarrantyTier,
      warrantyTier: defaultTrenchingWarrantyTier(product),
      warnings: [],
    };
  }
  const raw = normalizeToken(value).replace(/_+/g, '_');
  const aliases = {
    none: 'none',
    no_warranty: 'none',
    standard: 'one_year_retreat',
    one_year: 'one_year_retreat',
    '1_year': 'one_year_retreat',
    one_year_retreat: 'one_year_retreat',
    retreat: 'one_year_retreat',
    three_year: 'three_year_repair_retreat',
    '3_year': 'three_year_repair_retreat',
    three_year_repair_retreat: 'three_year_repair_retreat',
    repair_retreat_3_year: 'three_year_repair_retreat',
    five_year: 'five_year_repair_retreat',
    '5_year': 'five_year_repair_retreat',
    five_year_repair_retreat: 'five_year_repair_retreat',
    repair_retreat_5_year: 'five_year_repair_retreat',
  };
  return {
    requestedWarrantyTier,
    warrantyTier: aliases[raw] || defaultTrenchingWarrantyTier(product),
    warnings: raw && !aliases[raw] ? ['invalid_trenching_warranty_tier_defaulted'] : [],
  };
}

function priceTrenching(property = {}, options = {}) {
  const measurements = resolveTrenchingMeasurements(property || {}, options || {});
  const cfg = SPECIALTY.trenching;
  const hasExplicitTrenchingOptions = [
    'productKey',
    'applicationRate',
    'trenchDepthFt',
    'concreteVolumePadPct',
    'warrantyTier',
    'labelConfirmed',
    'customProductCost',
    'customProductOzPerFinishedGallon',
    'customContainerOz',
    'customPriceOverride',
  ].some((key) => hasValue(options[key])) || hasValue(options.measurements);
  const legacyTrenchingPayload = !hasExplicitTrenchingOptions;
  const explicitProductPayload = hasValue(options.productKey);
  const productResolution = normalizeTrenchingTermiticideProduct(options.productKey, {
    legacyPayload: !explicitProductPayload,
  });
  const product = cfg.products?.[productResolution.productKey] || cfg.products?.[cfg.defaultProductKey];
  const rateResolution = normalizeTrenchingApplicationRate(options.applicationRate);
  const rateConfig = cfg.applicationRates?.[rateResolution.applicationRate] || cfg.applicationRates?.standard || {};
  const productOzPerFinishedGallon = optionPositiveNumber(
    options,
    'customProductOzPerFinishedGallon',
    rateResolution.applicationRate === 'high'
      ? product.productOzPerFinishedGallonAtHighRate
      : product.productOzPerFinishedGallonAtStandardRate,
  );
  const containerCost = optionPositiveNumber(options, 'customProductCost', product.containerCost);
  const containerOz = optionPositiveNumber(options, 'customContainerOz', product.containerOz);
  const trenchDepthFt = optionPositiveNumber(options, 'trenchDepthFt', cfg.defaultTrenchDepthFt || 1);
  const concreteVolumePadPct = optionNonNegativeNumber(
    options,
    'concreteVolumePadPct',
    cfg.defaultConcreteVolumePadPct || 0,
  );
  const warrantyResolution = normalizeTrenchingWarrantyTier(options.warrantyTier, product);
  const warrantyTier = cfg.warrantyTiers?.[warrantyResolution.warrantyTier]
    ? warrantyResolution.warrantyTier
    : defaultTrenchingWarrantyTier(product);
  const warrantyConfig = cfg.warrantyTiers?.[warrantyTier] || cfg.warrantyTiers?.none || {};
  const labelConfirmed = optionBooleanTrue(options.labelConfirmed);
  const labelConfirmationRequiredForPayload = !legacyTrenchingPayload;
  const warningList = [
    ...(product.warnings || []),
    ...productResolution.warnings,
    ...rateResolution.warnings,
    ...warrantyResolution.warnings,
  ];
  if (rateResolution.applicationRate === 'high') {
    warningList.push('High/problem-soil rate increases chemical usage and requires label confirmation.');
  }
  if (product.chemistryType === 'repellent_pyrethroid') {
    warningList.push('Repellent pyrethroid barrier; not equivalent to non-repellent fipronil.');
  }
  if (measurements.concreteLF > 0 && concreteVolumePadPct > 0) {
    warningList.push('Concrete/slab drilling and rodding can consume additional finished solution; volume pad applied.');
  }
  const manualReviewReasons = [
    ...measurements.manualReviewReasons,
    ...productResolution.manualReviewReasons,
    ...rateResolution.warnings,
    ...warrantyResolution.warnings,
  ];
  if (rateConfig.requiresManualReview && rateConfig.manualReviewReason) {
    manualReviewReasons.push(rateConfig.manualReviewReason);
  }
  if (labelConfirmationRequiredForPayload && !labelConfirmed) {
    manualReviewReasons.push('label_confirmation_required');
  }
  if (hasValue(options.customProductCost) || hasValue(options.customProductOzPerFinishedGallon)) {
    manualReviewReasons.push('product_manual_override_used');
  }
  if (hasValue(options.trenchDepthFt) && Number(options.trenchDepthFt) !== Number(cfg.defaultTrenchDepthFt || 1)) {
    manualReviewReasons.push('trench_depth_manual_override_used');
  }
  if (hasValue(options.concreteVolumePadPct) && concreteVolumePadPct > (cfg.defaultConcreteVolumePadPct || 0)) {
    manualReviewReasons.push('significant_concrete_volume_pad_applied');
  }

  const chemistryAllowedForWarranty = (warrantyConfig.allowedChemistryTypes || []).includes(product.chemistryType);
  let warrantyQuoteRequired = false;
  if (!chemistryAllowedForWarranty && product.chemistryType === 'repellent_pyrethroid') {
    warningList.push('Long repair-and-retreat warranty on bifenthrin is high risk and requires admin approval or custom quote.');
    if (warrantyConfig.repellentQuoteRequired && !(
      options.allowWarrantyOverride || options.managerOverride || options.customManagerOverride
    )) {
      warrantyQuoteRequired = true;
    }
    if (warrantyConfig.manualReviewReason) {
      manualReviewReasons.push(warrantyConfig.manualReviewReason);
    }
  }

  const baseResult = {
    service: 'trenching',
    productKey: productResolution.productKey,
    productLabel: product.label,
    activeIngredient: product.activeIngredient,
    chemistryType: product.chemistryType,
    positioning: product.positioning,
    applicationRate: rateResolution.applicationRate,
    requestedApplicationRate: rateResolution.requestedApplicationRate,
    concentrationLabel: rateResolution.applicationRate === 'high'
      ? product.highConcentrationLabel || rateConfig.concentrationLabel
      : product.standardConcentrationLabel || rateConfig.concentrationLabel,
    trenchDepthFt,
    perimeter: measurements.perimeter,
    perimeterSource: measurements.perimeterSource,
    perimeterWasManualOverride: measurements.perimeterWasManualOverride,
    concretePct: measurements.concretePct,
    concretePctSource: measurements.concretePctSource,
    dirtLF: measurements.dirtLF,
    dirtLFSource: measurements.dirtLFSource,
    concreteLF: measurements.concreteLF,
    concreteLFSource: measurements.concreteLFSource,
    concreteVolumePadPct,
    dirtFinishedGallons: null,
    concreteFinishedGallons: null,
    finishedGallons: null,
    productOzPerFinishedGallon,
    productOz: null,
    chemicalCostPerOz: null,
    allocatedChemicalCost: null,
    includedChemicalCost: null,
    chemicalPremiumCost: null,
    productSurcharge: null,
    chemicalCostPerLF: null,
    containersRequired: null,
    baseInstallPrice: null,
    warrantyTier,
    requestedWarrantyTier: warrantyResolution.requestedWarrantyTier,
    warrantyLabel: warrantyConfig.label || warrantyTier,
    warrantyAdder: null,
    priceBeforeWarranty: null,
    price: null,
    labelConfirmed,
    requiresLabelConfirmation: true,
    certificateOfTreatmentRequired: true,
    warnings: uniqueList(warningList),
    measurements: {
      perimeterLF: measurementObject(measurements.perimeter, measurements.perimeterSource),
      concreteLF: measurementObject(measurements.concreteLF, measurements.concreteLFSource),
      dirtLF: measurementObject(measurements.dirtLF, measurements.dirtLFSource),
      concretePct: measurementObject(measurements.concretePct, measurements.concretePctSource),
    },
    measurementWarnings: uniqueList([
      ...measurements.measurementWarnings,
      ...productResolution.warnings,
      ...rateResolution.warnings,
      ...warrantyResolution.warnings,
    ]),
    requiresMeasurement: measurements.requiresMeasurement,
    requiresManualReview: manualReviewReasons.length > 0 ||
      measurements.requiresManualReview ||
      productResolution.requiresManualReview ||
      !!rateConfig.requiresManualReview ||
      rateResolution.warnings.length > 0 ||
      (labelConfirmationRequiredForPayload && !labelConfirmed) ||
      (!chemistryAllowedForWarranty && product.chemistryType === 'repellent_pyrethroid') ||
      hasValue(options.customProductCost) ||
      hasValue(options.customProductOzPerFinishedGallon) ||
      hasValue(options.customPriceOverride),
    manualReviewReasons: uniqueList(manualReviewReasons),
    inputSourceSummary: {
      perimeterLF: measurements.perimeterSource,
      concreteLF: measurements.concreteLFSource,
      dirtLF: measurements.dirtLFSource,
      concretePct: measurements.concretePctSource,
    },
    renewal: cfg.renewal,
    renewalFrequency: 'annual',
    renewalLabel: 'Annual trenching renewal',
  };

  if (measurements.requiresMeasurement) {
    return {
      ...baseResult,
      price: null,
      quoteRequired: true,
    };
  }

  const finishedGallonsPerLFPerFtDepth = (cfg.finishedGallonsPer10LFPerFtDepth || 4) / 10;
  const dirtFinishedGallons = measurements.dirtLF * finishedGallonsPerLFPerFtDepth * trenchDepthFt;
  const concreteFinishedGallons = measurements.concreteLF *
    finishedGallonsPerLFPerFtDepth *
    trenchDepthFt *
    (1 + concreteVolumePadPct);
  const finishedGallons = dirtFinishedGallons + concreteFinishedGallons;
  const productOz = finishedGallons * productOzPerFinishedGallon;
  const chemicalCostPerOz = containerCost / containerOz;
  const allocatedChemicalCost = productOz * chemicalCostPerOz;
  const includedProduct = cfg.products?.[cfg.defaultIncludedProductKey] || cfg.products?.[cfg.defaultProductKey] || product;
  const includedChemicalCost = finishedGallons *
    includedProduct.productOzPerFinishedGallonAtStandardRate *
    (includedProduct.containerCost / includedProduct.containerOz);
  const chemicalPremiumCost = Math.max(0, allocatedChemicalCost - includedChemicalCost);
  const productSurcharge = Math.round(chemicalPremiumCost * (cfg.productPremiumMultiplier || 1));
  const totalLF = Math.max(1, measurements.dirtLF + measurements.concreteLF);
  const chemicalCostPerLF = allocatedChemicalCost / totalLF;
  const containersRequired = Math.max(1, Math.ceil(productOz / containerOz));
  const baseInstallPrice = Math.max(
    cfg.floor,
    measurements.dirtLF * cfg.dirtPerLF + measurements.concreteLF * cfg.concretePerLF,
  );
  const priceBeforeWarranty = baseInstallPrice + productSurcharge;
  const warrantyAdder = Math.round(priceBeforeWarranty * (Number(warrantyConfig.priceAdderPct) || 0));
  const calculatedPrice = priceBeforeWarranty + warrantyAdder;
  const customPrice = positiveFiniteNumber(options.customPriceOverride);
  const price = warrantyQuoteRequired
    ? null
    : (customPrice !== null ? Math.round(customPrice) : calculatedPrice);
  const finalManualReviewReasons = customPrice !== null
    ? uniqueList([...manualReviewReasons, 'product_manual_override_used'])
    : uniqueList(manualReviewReasons);

  return {
    ...baseResult,
    dirtFinishedGallons: roundMoney(dirtFinishedGallons),
    concreteFinishedGallons: roundMoney(concreteFinishedGallons),
    finishedGallons: roundMoney(finishedGallons),
    productOz: roundMoney(productOz),
    chemicalCostPerOz: roundMoney(chemicalCostPerOz),
    allocatedChemicalCost: roundMoney(allocatedChemicalCost),
    includedChemicalCost: roundMoney(includedChemicalCost),
    chemicalPremiumCost: roundMoney(chemicalPremiumCost),
    productSurcharge,
    chemicalCostPerLF: roundMoney(chemicalCostPerLF),
    containersRequired,
    baseInstallPrice,
    warrantyAdder,
    priceBeforeWarranty,
    price,
    quoteRequired: warrantyQuoteRequired,
    requiresManualReview: baseResult.requiresManualReview || finalManualReviewReasons.length > 0,
    manualReviewReasons: finalManualReviewReasons,
  };
}

function priceBoraCare(input, options = {}) {
  const measurement = resolveBoraCareSqFt(input, options);
  const surface = resolveBoraCareSurfaceSqFt(input, options);

  const hasAttic = measurement.value !== null;
  const hasSurface = surface.surfaceSqFt > 0;
  // Attic input was provided (valid or invalid) when the resolver landed on a
  // source other than the synthetic 'missing'. An invalid property value also
  // resolves to source 'missing', so check the review reasons to tell a truly
  // absent attic apart from a rejected one — only the former may be suppressed.
  const atticInvalid = measurement.manualReviewReasons.includes('invalid_boracare_attic_sqft')
    || measurement.warnings.includes('invalid_boracare_attic_sqft');
  const atticTrulyMissing = measurement.source === 'missing' && !atticInvalid;
  // When surface treatment covers the job, a missing attic measurement is
  // expected and must not be surfaced as noise — but a rejected attic value
  // still needs review.
  const suppressAtticGaps = hasSurface && atticTrulyMissing;

  const warnings = [...surface.warnings];
  const manualReviewReasons = [];
  if (!suppressAtticGaps) {
    warnings.push(...measurement.warnings);
    manualReviewReasons.push(...measurement.manualReviewReasons);
  }
  if (surface.invalid) manualReviewReasons.push('invalid_boracare_surface_linear_ft');
  if (surface.heightInvalid) manualReviewReasons.push('invalid_boracare_surface_height_defaulted');

  const requiresMeasurement = !hasAttic && !hasSurface;
  const requiresManualReview = surface.invalid
    || surface.heightInvalid
    || (!suppressAtticGaps && measurement.requiresManualReview);

  const atticSqFt = hasAttic ? measurement.value : null;
  const surfaceSqFt = hasSurface ? surface.surfaceSqFt : null;
  const totalSqFt = (hasAttic ? measurement.value : 0) + (hasSurface ? surface.surfaceSqFt : 0);

  const baseResult = {
    service: 'bora_care',
    atticSqFt,
    atticSqFtSource: measurement.source,
    atticSqFtWasManualOverride: measurement.wasManualOverride,
    surfaceLinearFt: surface.surfaceLinearFt,
    surfaceHeightFt: surface.surfaceHeightFt,
    surfaceSqFt,
    totalSqFt: requiresMeasurement ? null : totalSqFt,
    measurements: {
      atticSqFt: measurementObject(atticSqFt, measurement.source),
      surfaceLinearFt: measurementObject(surface.surfaceLinearFt, surface.source),
      surfaceSqFt: measurementObject(surfaceSqFt, surface.source),
      totalSqFt: measurementObject(requiresMeasurement ? null : totalSqFt, hasSurface ? 'computed_attic_plus_surface' : measurement.source),
    },
    measurementWarnings: uniqueList(warnings),
    requiresMeasurement,
    requiresManualReview,
    manualReviewReasons: uniqueList(manualReviewReasons),
    inputSourceSummary: {
      atticSqFt: measurement.source,
      surfaceLinearFt: surface.source,
    },
  };

  if (requiresMeasurement) {
    return {
      ...baseResult,
      gallons: null,
      laborHrs: null,
      isMultiDay: false,
      cost: null,
      price: null,
      quoteRequired: true,
    };
  }

  // A surface-only job (linear-ft spray, no attic/raw-wood input) has none of
  // the attic-access overhead the floors were built for, so it prices on actual
  // gallons + actual labor and is floored at minJobPrice instead. Attic jobs
  // (attic-only or attic+surface) keep the proven 3-gallon / 2-hour floors.
  const surfaceOnly = !hasAttic;
  const gallonsFloor = surfaceOnly ? 1 : 3;
  const gallons = Math.max(gallonsFloor, Math.ceil(totalSqFt / SPECIALTY.boraCare.coverage));
  const isMultiDay = totalSqFt > 4500;
  const laborHrs = isMultiDay
    ? Math.min(10, Math.max(6, 1.5 + totalSqFt / 800))
    : surfaceOnly
      ? Math.min(6, totalSqFt / SPECIALTY.boraCare.surfaceLaborSqFtPerHour)
      : Math.min(6, Math.max(2, 1.5 + totalSqFt / 1000));
  const cost = gallons * SPECIALTY.boraCare.galCost + laborHrs * GLOBAL.LABOR_RATE + SPECIALTY.boraCare.equipCost;
  const rawPrice = Math.round(cost / SPECIALTY.boraCare.marginDivisor);
  const price = surfaceOnly ? Math.max(SPECIALTY.boraCare.minJobPrice, rawPrice) : rawPrice;

  return {
    ...baseResult,
    gallons,
    laborHrs: Math.round(laborHrs * 10) / 10,
    isMultiDay,
    cost: Math.round(cost),
    price,
    quoteRequired: false,
  };
}

function pricePreSlabTermiticide(input, options = {}) {
  if (options && typeof options !== 'object') {
    options = { volumeDiscount: options };
  }

  const cfg = SPECIALTY.preSlabTermiticide;
  const productResolution = normalizePreSlabTermiticideProduct(options.productKey, {
    legacyPayload: !!options.legacyPayload,
  });
  const product = cfg.products[productResolution.productKey] || cfg.products[cfg.defaultProductKey];
  const measurement = resolvePreSlabSqFt(input, options);
  const volumeResolution = normalizePreSlabVolumeDiscount(options.volumeDiscount || 'none');
  let warrantyResolution = normalizePreSlabWarranty(
    hasValue(options.warranty)
      ? options.warranty
      : (hasValue(options.warrantyTier) ? options.warrantyTier : options.preslabWarranty)
  );
  const volumeDiscountMultiplier = cfg.volumeDiscounts[volumeResolution.volumeDiscount] || 1.0;
  const jobContextResolution = normalizePreSlabJobContext(options.jobContext || options.preSlabJobContext, volumeResolution.volumeDiscount);
  const productOzPer10SqFt = optionPositiveNumber(options, 'customProductOzPer10SqFt', product.productOzPer10SqFt);
  const containerCost = optionPositiveNumber(options, 'customContainerCost', product.containerCost);
  const containerOz = optionPositiveNumber(options, 'customContainerOz', product.containerOz);
  const laborCfg = cfg.labor || {};
  const warrantyExtendedSelected = !!(
    options.includeWarrantyExtended ||
    options.warrantyExtended ||
    warrantyResolution.warrantyTier === 'extended'
  );
  if (warrantyExtendedSelected && warrantyResolution.warrantyTier !== 'extended') {
    warrantyResolution = {
      ...warrantyResolution,
      warrantyTier: 'extended',
      warrantyLabel: 'Extended 5-yr warranty',
    };
  }
  const warrantyExtendedPrice = warrantyExtendedSelected ? cfg.warrantyExtended : 0;
  const warrantyAdder = warrantyExtendedPrice;
  const labelConfirmed = optionBooleanTrue(options.labelConfirmed);
  const requiresLabelConfirmation = product.requiresLabelConfirmation === true;
  const labelManualReviewReasons = requiresLabelConfirmation && !labelConfirmed
    ? ['pre_slab_label_confirmation_required']
    : [];
  const warningList = uniqueList([
    ...(product.warnings || []),
    ...measurement.warnings,
    ...volumeResolution.warnings,
    ...productResolution.warnings,
    ...warrantyResolution.warnings,
    ...jobContextResolution.warnings,
  ]);
  const manualReviewReasons = uniqueList([
    ...measurement.manualReviewReasons,
    ...volumeResolution.warnings,
    ...productResolution.manualReviewReasons,
    ...warrantyResolution.warnings,
    ...jobContextResolution.warnings,
    ...labelManualReviewReasons,
  ]);
  const contextualMinimum = measurement.value === null
    ? lookupPreSlabMinimum(0, jobContextResolution.jobContext)
    : lookupPreSlabMinimum(measurement.value, jobContextResolution.jobContext);
  const floorBeforeVolumeDiscount = optionNonNegativeNumber(
    options,
    'customFloorBeforeVolumeDiscount',
    contextualMinimum.floor,
  );
  const floorAfterVolumeDiscount = optionNonNegativeNumber(
    options,
    'customFloorAfterVolumeDiscount',
    contextualMinimum.floor,
  );
  const baseResult = {
    service: 'pre_slab_termiticide',
    legacyService: productResolution.productKey === 'termidor_sc' ? 'pre_slab_termidor' : null,
    productKey: productResolution.productKey,
    requestedProductKey: productResolution.requestedProductKey,
    productLabel: product.label,
    activeIngredient: product.activeIngredient,
    chemistryType: product.chemistryType,
    positioning: product.positioning,
    slabSqFt: measurement.value,
    slabSqFtSource: measurement.source,
    slabSqFtWasManualOverride: measurement.wasManualOverride,
    productOzPer10SqFt,
    productOz: null,
    units: null,
    bottles: null,
    containersRequired: null,
    containerOz,
    containerCost,
    chemicalCostPerOz: roundMoney(containerCost / containerOz),
    allocatedProductCost: null,
    productCost: null,
    fullContainerProductCost: null,
    laborHrs: null,
    laborCost: null,
    equipCost: cfg.equipCost,
    complianceAdminCost: cfg.complianceAdminCost || 0,
    driveCost: null,
    includeDriveCost: cfg.includeDriveCostByContext?.[jobContextResolution.jobContext] === true,
    cost: null,
    marginDivisor: product.marginDivisor,
    targetMargin: 1 - product.marginDivisor,
    rawPrice: null,
    jobContext: jobContextResolution.jobContext,
    preSlabJobContext: jobContextResolution.jobContext,
    requestedJobContext: jobContextResolution.requestedJobContext,
    contextualFloor: contextualMinimum.floor,
    contextualMinimumBasis: contextualMinimum.basis,
    floorBeforeVolumeDiscount,
    floorAfterVolumeDiscount,
    priceBeforeVolumeDiscount: null,
    volumeDiscount: volumeResolution.volumeDiscount,
    requestedVolumeDiscount: volumeResolution.requestedVolumeDiscount,
    volumeDiscountMultiplier,
    volumeDiscountWarnings: volumeResolution.warnings,
    priceAfterVolumeDiscount: null,
    treatmentPrice: null,
    price: null,
    warrantyTier: warrantyResolution.warrantyTier,
    requestedWarrantyTier: warrantyResolution.requestedWarrantyTier,
    warrantyLabel: warrantyResolution.warrantyLabel,
    warrantyAdder,
    warrantyAdd: warrantyAdder,
    warrantyExtendedSelected,
    warrantyExtendedPrice,
    warrantyStatus: warrantyExtendedSelected ? 'Extended 5-year warranty' : 'No extended warranty selected',
    addOns: warrantyExtendedSelected
      ? [{
          code: 'pre_slab_extended_warranty',
          label: 'Extended warranty',
          price: warrantyExtendedPrice,
        }]
      : [],
    labelConfirmed,
    requiresLabelConfirmation,
    certificateOfComplianceRequired: true,
    requiresCertificateOfCompliance: true,
    warnings: warningList,
    measurementWarnings: uniqueList([
      ...measurement.warnings,
      ...volumeResolution.warnings,
      ...productResolution.warnings,
      ...jobContextResolution.warnings,
    ]),
    requiresMeasurement: measurement.requiresMeasurement,
    requiresManualReview: measurement.requiresManualReview ||
      volumeResolution.warnings.length > 0 ||
      productResolution.requiresManualReview ||
      jobContextResolution.warnings.length > 0 ||
      labelManualReviewReasons.length > 0,
    manualReviewReasons,
    measurements: {
      slabSqFt: measurementObject(measurement.value, measurement.source),
    },
    inputSourceSummary: {
      slabSqFt: measurement.source,
    },
  };

  if (measurement.value === null) {
    return {
      ...baseResult,
      quoteRequired: true,
    };
  }

  const slabSqFt = measurement.value;
  const productOz = slabSqFt / 10 * productOzPer10SqFt;
  const units = Math.max(1, Math.ceil(productOz / containerOz));
  const chemicalCostPerOz = containerCost / containerOz;
  const allocatedProductCost = productOz * chemicalCostPerOz;
  const fullContainerProductCost = units * containerCost;
  const laborHrs = Math.min(
    laborCfg.maxHours || 5,
    Math.max(laborCfg.minHours || 1, (laborCfg.baseHours || 0.5) + slabSqFt * (laborCfg.hoursPerSqFt || (1 / 1500))),
  );
  const laborCost = laborHrs * GLOBAL.LABOR_RATE;
  const complianceAdminCost = Number(cfg.complianceAdminCost || 0);
  const driveCost = cfg.includeDriveCostByContext?.[jobContextResolution.jobContext] === true
    ? GLOBAL.LABOR_RATE * GLOBAL.DRIVE_TIME / 60
    : 0;
  const cost = allocatedProductCost + laborCost + cfg.equipCost + complianceAdminCost + driveCost;
  const rawPrice = Math.round(cost / product.marginDivisor);
  const priceBeforeVolumeDiscount = Math.max(rawPrice, floorBeforeVolumeDiscount);
  const priceAfterVolumeDiscount = Math.max(
    Math.round(priceBeforeVolumeDiscount * volumeDiscountMultiplier),
    floorAfterVolumeDiscount,
  );
  const price = priceAfterVolumeDiscount + warrantyExtendedPrice;

  return {
    ...baseResult,
    productOz: roundMoney(productOz),
    units,
    bottles: units,
    containersRequired: units,
    chemicalCostPerOz: roundMoney(chemicalCostPerOz),
    allocatedProductCost: roundMoney(allocatedProductCost),
    productCost: roundMoney(allocatedProductCost),
    fullContainerProductCost: roundMoney(fullContainerProductCost),
    laborHrs: roundMoney(laborHrs),
    laborCost: roundMoney(laborCost),
    complianceAdminCost: roundMoney(complianceAdminCost),
    driveCost: roundMoney(driveCost),
    cost: roundMoney(cost),
    rawPrice,
    priceBeforeVolumeDiscount,
    priceAfterVolumeDiscount,
    treatmentPrice: priceAfterVolumeDiscount,
    price,
    quoteRequired: false,
  };
}

function pricePreSlabTermidor(input, volumeDiscount = 'none', extraOptions = {}) {
  let options = extraOptions || {};
  let discountInput = volumeDiscount;
  if (volumeDiscount && typeof volumeDiscount === 'object') {
    options = volumeDiscount;
    discountInput = options.volumeDiscount || 'none';
  } else if (extraOptions && typeof extraOptions === 'object' && hasValue(extraOptions.volumeDiscount)) {
    discountInput = extraOptions.volumeDiscount;
  }

  return pricePreSlabTermiticide(input, {
    ...options,
    legacyPayload: true,
    productKey: options.productKey || 'termidor_sc',
    volumeDiscount: discountInput,
    labelConfirmed: hasValue(options.labelConfirmed) ? options.labelConfirmed : true,
  });
}

function priceGermanRoach(property, options = {}) {
  const cfg = SPECIALTY.germanRoach;
  const severityMeta = normalizeRoachSeverity(options.severity);
  // 'severe' collapses into the top (heavy) tier; missing/invalid severity falls
  // back to the default tier. Footprint is intentionally not consulted.
  const requestedTier = severityMeta.severity === 'severe' ? 'heavy' : severityMeta.severity;
  const tierKey = cfg.tiers[requestedTier] ? requestedTier : cfg.defaultSeverity;
  const tier = cfg.tiers[tierKey];
  const severityWasDefaulted = !severityMeta.severity || !cfg.tiers[requestedTier];
  const price = tier.price;
  const visits = tier.visits;

  return {
    service: 'german_roach',
    label: `German Roach Cleanout — ${visits} Visit Program`,
    price,
    source: options.source || 'german_roach_cleanout_selected',
    pricingModel: 'german_roach_severity_tier_cleanout',
    legacyPricingModel: 'german_roach_three_visit_cleanout',
    severity: tierKey,
    severitySource: options.severitySource || (severityMeta.severity ? 'admin' : 'default'),
    severityWasDefaulted,
    noRecurringDiscount: true,
    setupCharge: 0,
    total: price,
    visits,
    warnings: uniqueList([...severityMeta.warnings]),
  };
}

// Legacy explicit German roach initial. The current v2 adapter uses
// pest_initial_roach for recurring German roach auto-fire; this remains for
// older direct engine callers that still pass services.germanRoachInitial.
function priceGermanRoachInitial(options = {}) {
  const {
    urgency = 'NONE',
    afterHours = false,
    isRecurringCustomer = false,
  } = options;
  const BASE = 100;
  const urgencyMult = afterHours
    ? (URGENCY[urgency] || URGENCY.NONE).afterHours || 1
    : (URGENCY[urgency] || URGENCY.NONE).standard;
  const rcDisc = isRecurringCustomer ? (1 - WAVEGUARD.recurringCustomerOneTimePerk) : 1;
  const price = Math.round(BASE * urgencyMult * rcDisc);
  return {
    service: 'german_roach_initial',
    name: 'German Roach Initial (3-Visit)',
    price,
    visits: 3,
  };
}

function normalizeBedBugEnum(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return String(value).trim().toUpperCase();
}

function readBedBugEnum(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return typeof value === 'string' ? value.trim() : value;
}

function readBedBugPropertyNumber(value) {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeBedBugOptions(property = {}, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw buildPricingError('Bed bug options are required', { field: 'options' });
  }

  const method = readBedBugEnum(options.method ?? options.bedbugMethod);
  if (!method) throw buildPricingError('Bed bug method is required', { field: 'method' });
  if (method === 'BOTH') {
    throw buildPricingError('Bed bug method BOTH is invalid; use HYBRID for heat plus targeted residual protection', {
      field: 'method',
      value: method,
    });
  }
  assertEnum(method, BED_BUG.allowedMethods, 'method');

  const roomsValue = options.rooms ?? options.bedbugRooms;
  if (roomsValue === null || roomsValue === undefined || roomsValue === '') {
    throw buildPricingError('Bed bug rooms is required', { field: 'rooms' });
  }
  const rooms = assertPositiveInteger(roomsValue, 'rooms');

  const severity = options.severity ?? options.bedbugSeverity;
  if (!severity) throw buildPricingError('Bed bug severity is required', { field: 'severity' });
  assertEnum(severity, Object.keys(BED_BUG.severity), 'severity');

  const prepStatus = options.prepStatus ?? options.bedbugPrepStatus;
  if (!prepStatus) throw buildPricingError('Bed bug prepStatus is required', { field: 'prepStatus' });
  assertEnum(prepStatus, Object.keys(BED_BUG.prepStatus), 'prepStatus');
  const quoteRequiredReason = BED_BUG.severity[severity].quoteRequired
    ? 'SEVERE_INFESTATION'
    : ((BED_BUG.prepStatus[prepStatus].quoteRequired || BED_BUG.prepStatus[prepStatus].allowed === false)
        ? 'PREP_REFUSED'
        : null);

  const occupancyType = options.occupancyType ?? options.bedbugOccupancyType;
  if (!occupancyType) throw buildPricingError('Bed bug occupancyType is required', { field: 'occupancyType' });
  assertEnum(occupancyType, Object.keys(BED_BUG.occupancyType), 'occupancyType');

  const hasOptionFootprint = options.footprint !== null &&
    options.footprint !== undefined &&
    options.footprint !== '';
  const propertyFootprint = property.footprint;
  const footprintValue = hasOptionFootprint
    ? options.footprint
    : (
        propertyFootprint === 0 || propertyFootprint === '0'
          ? undefined
          : propertyFootprint
      );
  const footprint = footprintValue === null || footprintValue === undefined || footprintValue === ''
    ? undefined
    : assertPositiveNumber(footprintValue, 'footprint');

  const storiesValue = options.stories ?? property.stories;
  const stories = storiesValue === null || storiesValue === undefined || storiesValue === ''
    ? undefined
    : assertPositiveInteger(storiesValue, 'stories');

  const equipmentValue = options.equipment ?? options.bedbugEquipment;
  const equipment = readBedBugEnum(equipmentValue);
  const heatScope = readBedBugEnum(options.heatScope ?? options.bedbugHeatScope);
  const warnings = [];
  let heatAreaSqFt;

  if (method === 'CHEMICAL') {
    if (equipment) warnings.push('Equipment was supplied for CHEMICAL bed bug pricing and was ignored.');
    if (heatScope) {
      assertEnum(heatScope, BED_BUG.heat.heatScope.allowed, 'heatScope');
      warnings.push('heatScope was supplied for CHEMICAL bed bug pricing and was ignored.');
    }
  } else {
    if (!equipment) throw buildPricingError('equipment is required for HEAT and HYBRID bed bug pricing', { field: 'equipment' });
    assertEnum(equipment, BED_BUG.heat.allowedEquipment, 'equipment');
    if (!heatScope) throw buildPricingError('heatScope is required for HEAT and HYBRID bed bug pricing', { field: 'heatScope' });
    assertEnum(heatScope, BED_BUG.heat.heatScope.allowed, 'heatScope');
    if (heatScope === 'WHOLE_HOME') {
      heatAreaSqFt = readBedBugPropertyNumber(
        options.heatAreaSqFt ?? options.heatSqFt ?? options.homeSqFt ?? property.homeSqFt ?? property.squareFootage,
      );
    }
  }

  const subcontractCostValue = options.subcontractCost ?? options.bedbugSubcontractCost;
  let subcontractCost;
  if (quoteRequiredReason) {
    if (method !== 'CHEMICAL' && equipment === 'SUBCONTRACT' && subcontractCostValue !== null && subcontractCostValue !== undefined && subcontractCostValue !== '') {
      subcontractCost = assertPositiveNumber(subcontractCostValue, 'subcontractCost');
    } else if (subcontractCostValue !== null && subcontractCostValue !== undefined && subcontractCostValue !== '') {
      warnings.push('subcontractCost was supplied for non-subcontract bed bug pricing and was ignored.');
    }

    return {
      method,
      rooms,
      footprint,
      heatAreaSqFt,
      stories,
      severity,
      prepStatus,
      occupancyType,
      equipment: method === 'CHEMICAL' ? undefined : equipment,
      heatScope: method === 'CHEMICAL' ? undefined : heatScope,
      subcontractCost,
      quoteRequiredReason,
      urgency: options.urgency ?? options.bedbugUrgency ?? 'standard',
      afterHours: options.afterHours ?? options.isAfterHours ?? false,
      includeInternalCostBasis: options.includeInternalCostBasis === true,
      isInternal: options.internal === true || options.isInternal === true || options.admin === true || options.isAdmin === true || options.debug === true,
      warnings,
    };
  }

  if (method !== 'CHEMICAL' && equipment === 'SUBCONTRACT') {
    subcontractCost = subcontractCostValue === null || subcontractCostValue === undefined || subcontractCostValue === ''
      ? undefined
      : assertPositiveNumber(subcontractCostValue, 'subcontractCost');
    if (subcontractCost === undefined) {
      throw buildPricingError('subcontractCost is required when equipment is SUBCONTRACT', {
        field: 'subcontractCost',
        reason: 'MISSING_VENDOR_COST',
      });
    }
  } else if (subcontractCostValue !== null && subcontractCostValue !== undefined && subcontractCostValue !== '') {
    warnings.push('subcontractCost was supplied for non-subcontract bed bug pricing and was ignored.');
  }

  if ((method === 'HEAT' || method === 'HYBRID') && heatScope === 'WHOLE_HOME' && footprint === undefined && heatAreaSqFt === undefined) {
    throw buildPricingError('footprint is required when heatScope is WHOLE_HOME', {
      field: 'footprint',
      reason: 'WHOLE_HOME_REQUIRES_FOOTPRINT',
    });
  }

  return {
    method,
    rooms,
    footprint,
    heatAreaSqFt,
    stories,
    severity,
    prepStatus,
    occupancyType,
    equipment: method === 'CHEMICAL' ? undefined : equipment,
    heatScope: method === 'CHEMICAL' ? undefined : heatScope,
    subcontractCost,
    urgency: options.urgency ?? options.bedbugUrgency ?? 'standard',
    afterHours: options.afterHours ?? options.isAfterHours ?? false,
    includeInternalCostBasis: options.includeInternalCostBasis === true,
    isInternal: options.internal === true || options.isInternal === true || options.admin === true || options.isAdmin === true || options.debug === true,
    warnings,
  };
}

function getStoryMultiplier(stories) {
  if (!stories) return 1;
  if (stories <= BED_BUG.stories.one.maxStories) return BED_BUG.stories.one.multiplier;
  if (stories <= BED_BUG.stories.two.maxStories) return BED_BUG.stories.two.multiplier;
  return BED_BUG.stories.threePlus.multiplier;
}

function getFootprintModifier(footprint, modifierRules = []) {
  if (footprint === undefined || footprint === null) return 1;
  for (const rule of modifierRules) {
    if (rule.minFootprintExclusive !== undefined && footprint > rule.minFootprintExclusive) return rule.multiplier;
    if (rule.maxFootprintExclusive !== undefined && footprint < rule.maxFootprintExclusive) return rule.multiplier;
  }
  return 1;
}

function getUrgencyMultiplier(options = {}) {
  const afterHours = options.afterHours === true || String(options.afterHours || '').toUpperCase() === 'YES';
  const key = String(options.urgency || 'standard').trim().replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (key === 'soonafterhours') return BED_BUG.urgencyMultipliers.soonAfterHours;
  if (key === 'emergencyafterhours' || key === 'urgentafterhours') return BED_BUG.urgencyMultipliers.emergencyAfterHours;
  if (key === 'soon') return afterHours ? BED_BUG.urgencyMultipliers.soonAfterHours : BED_BUG.urgencyMultipliers.soon;
  if (key === 'emergency' || key === 'urgent') return afterHours ? BED_BUG.urgencyMultipliers.emergencyAfterHours : BED_BUG.urgencyMultipliers.emergency;
  return BED_BUG.urgencyMultipliers.standard;
}

function getBedBugLaborRate() {
  const globalRate = Number(GLOBAL.LABOR_RATE);
  return Number.isFinite(globalRate) && globalRate > 0
    ? globalRate
    : BED_BUG.laborRate;
}

function getBedBugDriveMinutes() {
  const globalDrive = Number(GLOBAL.DRIVE_TIME);
  return Number.isFinite(globalDrive) && globalDrive >= 0
    ? globalDrive
    : BED_BUG.driveMinutes;
}

function roundPrice(value) {
  return Math.round(value);
}

function roundedRatio(value) {
  return Math.round(value * 1000) / 1000;
}

function getBedBugMultipliers(normalized, footprintRules) {
  return {
    footprint: getFootprintModifier(normalized.footprint, footprintRules),
    severity: BED_BUG.severity[normalized.severity].multiplier,
    prep: BED_BUG.prepStatus[normalized.prepStatus].multiplier,
    occupancy: BED_BUG.occupancyType[normalized.occupancyType].multiplier,
    stories: getStoryMultiplier(normalized.stories),
    urgency: getUrgencyMultiplier(normalized),
    recurring: 1,
  };
}

function applyBedBugMultipliers(basePrice, multipliers) {
  return basePrice
    * multipliers.footprint
    * multipliers.severity
    * multipliers.prep
    * multipliers.occupancy
    * multipliers.stories
    * multipliers.urgency;
}

function uniqueWarnings(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

function bedBugPrepWarnings(normalized) {
  return BED_BUG.prepStatus[normalized.prepStatus].warnings || [];
}

function bedBugMethodLabel(method) {
  if (method === 'CHEMICAL') return BED_BUG.chemical.label;
  if (method === 'HEAT') return BED_BUG.heat.label;
  if (method === 'HYBRID') return BED_BUG.hybrid.label;
  return 'Bed Bug Treatment';
}

function buildBedBugChemicalProtocol(includedVisits) {
  const chemical = BED_BUG.chemical;
  return {
    ...(chemical.protocol || {}),
    includedVisits,
    followUpDays: chemical.followUpDays,
  };
}

function buildBedBugHeatProtocol() {
  const heat = BED_BUG.heat;
  return {
    targetAmbientTempF: heat.protocol.targetAmbientTempF,
    requiredMinimumTempF: heat.protocol.requiredMinimumTempF,
    minimumHoldTimeMinutes: heat.protocol.minimumHoldTimeMinutes,
    minSensors: heat.protocol.minSensors,
    activeMonitoringRequired: heat.protocol.activeMonitoringRequired,
    requiresPrepChecklist: heat.protocol.requiresPrepChecklist,
    requiresHeatSensitiveItemPlan: heat.protocol.requiresHeatSensitiveItemPlan,
  };
}

function buildBedBugHybridProtocol(heatProtocol) {
  return {
    ...heatProtocol,
    ...(BED_BUG.hybrid.protocol || {}),
    postInspectionDays: BED_BUG.hybrid.postInspectionDays,
  };
}

function buildBedBugQuoteRequired(normalized, reason, warnings = []) {
  const label = `${bedBugMethodLabel(normalized.method)} — ${normalized.rooms} room(s) — Quote Required`;
  const detail = reason === 'PREP_REFUSED'
    ? 'Prep refused requires inspection/manager quote before treatment.'
    : 'Inspection and custom quote required before treatment.';
  return {
    service: BED_BUG.service,
    label,
    method: normalized.method,
    rooms: normalized.rooms,
    footprint: normalized.footprint,
    heatAreaSqFt: normalized.heatAreaSqFt,
    stories: normalized.stories,
    severity: normalized.severity,
    prepStatus: normalized.prepStatus,
    occupancyType: normalized.occupancyType,
    equipment: normalized.equipment,
    heatScope: normalized.heatScope,
    quoteRequired: true,
    reason,
    detail,
    warnings: uniqueWarnings(warnings, normalized.warnings, bedBugPrepWarnings(normalized)),
    treatmentLines: [],
    recurringDiscountEligible: false,
    maxRecurringDiscountPct: BED_BUG.maxRecurringDiscountPct,
    recurringDiscountApplied: 0,
    requiresInspection: true,
    requiresPrepChecklist: true,
    requiresCustomerAcknowledgement: true,
    warrantyEligible: false,
  };
}

function bedBugCommonResult(normalized, fields) {
  const warnings = uniqueWarnings(fields.warnings || [], normalized.warnings, bedBugPrepWarnings(normalized));
  const price = fields.price;
  return {
    service: BED_BUG.service,
    label: fields.label,
    method: normalized.method,
    rooms: normalized.rooms,
    footprint: normalized.footprint,
    heatAreaSqFt: normalized.heatAreaSqFt,
    stories: normalized.stories,
    severity: normalized.severity,
    prepStatus: normalized.prepStatus,
    occupancyType: normalized.occupancyType,
    equipment: normalized.equipment,
    heatScope: normalized.heatScope,
    quoteRequired: false,
    treatmentLines: (fields.treatmentLines || []).map(line => ({
      ...line,
      warnings: uniqueWarnings(line.warnings || [], warnings),
    })),
    basePrice: roundCurrency(fields.basePrice),
    totalBeforeDiscounts: price,
    totalAfterDiscounts: price,
    price,
    multipliers: fields.multipliers,
    recurringDiscountEligible: false,
    maxRecurringDiscountPct: BED_BUG.maxRecurringDiscountPct,
    recurringDiscountApplied: 0,
    requiresInspection: true,
    requiresPrepChecklist: true,
    requiresCustomerAcknowledgement: true,
    warrantyEligible: false,
    warnings,
    discountHandledByPricingFunction: true,
    recurringCustomerDiscountRate: 0,
    recurringCustomerDiscountAmount: 0,
    ...(fields.extra || {}),
  };
}

function resolveChemicalPrice(normalized) {
  const chemical = BED_BUG.chemical;
  const rooms = normalized.rooms;
  const extraRooms = rooms - 1;
  const severityConfig = BED_BUG.severity[normalized.severity];
  const laborRate = getBedBugLaborRate();
  const driveMinutes = getBedBugDriveMinutes();

  const visit1Minutes =
    chemical.visitMinutes.visit1.setupBase
    + chemical.visitMinutes.visit1.applicationBase
    + chemical.visitMinutes.visit1.perExtraRoom * extraRooms
    + driveMinutes;
  const visit2Minutes =
    chemical.visitMinutes.visit2.followUpBase
    + chemical.visitMinutes.visit2.perExtraRoom * extraRooms
    + driveMinutes;
  const visit1Material = chemical.materialPerRoomVisit1 * rooms;
  const visit2Material = chemical.materialPerRoomVisit1 * rooms * chemical.materialPerRoomVisit2Factor;

  let directCost =
    visit1Material
    + visit2Material
    + laborRate * visit1Minutes / 60
    + laborRate * visit2Minutes / 60;

  const includedVisits = Math.max(chemical.includedVisits, severityConfig.visits);
  if (includedVisits > 2) {
    const extraVisitCount = includedVisits - 2;
    const extraVisitMinutes =
      chemical.visitMinutes.extraFollowUp.followUpBase
      + chemical.visitMinutes.extraFollowUp.perExtraRoom * extraRooms
      + driveMinutes;
    const extraVisitMaterial =
      chemical.materialPerRoomVisit1
      * rooms
      * chemical.extraFollowUpMaterialFactor;
    directCost += extraVisitCount * (
      extraVisitMaterial
      + laborRate * extraVisitMinutes / 60
    );
  }

  const costRatioPrice = directCost / chemical.targetCostRatio;
  const minimumPrice = chemical.minimumBase + chemical.minimumAdditionalRoom * extraRooms;
  const baseChemicalPrice = Math.max(costRatioPrice, minimumPrice);
  const multipliers = getBedBugMultipliers(normalized, chemical.sizeModifiers);
  const price = roundPrice(applyBedBugMultipliers(baseChemicalPrice, multipliers));
  const warnings = uniqueWarnings(chemical.warnings);
  const protocol = buildBedBugChemicalProtocol(includedVisits);
  const estimatedGrossMargin = price > 0 ? roundedRatio((price - directCost) / price) : 0;

  return bedBugCommonResult(normalized, {
    label: `${chemical.label} — ${rooms} room(s), ${includedVisits} visit(s)`,
    basePrice: baseChemicalPrice,
    price,
    multipliers,
    warnings,
    treatmentLines: [{
      label: `${chemical.label} — ${rooms} room(s), ${includedVisits} visit(s)`,
      method: normalized.method,
      price,
      includedVisits,
      followUpDays: chemical.followUpDays,
      protocol,
      directCostEstimate: roundCurrency(directCost),
      costRatio: chemical.targetCostRatio,
      actualCostRatio: price > 0 ? roundedRatio(directCost / price) : 0,
      estimatedGrossMargin,
      warnings,
    }],
    extra: {
      includedVisits,
      followUpDays: chemical.followUpDays,
      directCostEstimate: roundCurrency(directCost),
      costRatio: chemical.targetCostRatio,
      actualCostRatio: price > 0 ? roundedRatio(directCost / price) : 0,
      estimatedGrossMargin,
      pricingModel: chemical.pricingModel,
      targetCostRatio: chemical.targetCostRatio,
      protocol,
    },
  });
}

function getHeatRoomRate(rooms) {
  if (rooms === 1) return BED_BUG.heat.roomRates.oneRoom;
  if (rooms === 2) return BED_BUG.heat.roomRates.twoRooms;
  return BED_BUG.heat.roomRates.threePlusRooms;
}

function resolveHeatPrice(property, normalized, options = {}) {
  const { applyCommonModifiers = true } = options;
  const heat = BED_BUG.heat;
  const rooms = normalized.rooms;
  const extraRooms = rooms - 1;
  const roomRate = getHeatRoomRate(rooms);
  let roomBasedPrice = roomRate * rooms;
  let equipmentFee = 0;
  let vendorBasedPrice;

  if (normalized.equipment === 'INHOUSE') {
    equipmentFee = heat.inHouseEquipmentFee.base + heat.inHouseEquipmentFee.perExtraRoom * extraRooms;
    roomBasedPrice += equipmentFee;
    roomBasedPrice = Math.max(roomBasedPrice, heat.minimums.inHouse);
  } else if (normalized.equipment === 'SUBCONTRACT') {
    vendorBasedPrice = normalized.subcontractCost * heat.subcontractMarkup;
    roomBasedPrice = Math.max(roomBasedPrice, vendorBasedPrice, heat.minimums.subcontract);
  }

  let sqftBasedPrice;
  let baseHeatPrice = roomBasedPrice;
  if (normalized.heatScope === 'WHOLE_HOME') {
    const sqftRate = normalized.equipment === 'INHOUSE'
      ? heat.sqftRates.inHouse
      : heat.sqftRates.subcontract;
    const heatAreaSqFt = normalized.heatAreaSqFt ?? normalized.footprint;
    sqftBasedPrice = heatAreaSqFt * sqftRate;
    baseHeatPrice = Math.max(roomBasedPrice, sqftBasedPrice);
  }

  const multipliers = getBedBugMultipliers(normalized, heat.sizeModifiers);
  const price = applyCommonModifiers
    ? roundPrice(applyBedBugMultipliers(baseHeatPrice, multipliers))
    : roundCurrency(baseHeatPrice);
  const warnings = uniqueWarnings(heat.warnings);
  const protocol = buildBedBugHeatProtocol();
  const line = {
    label: `${heat.label} — ${rooms} room(s) — ${normalized.equipment}`,
    method: normalized.method,
    price,
    includedTreatmentEvents: heat.includedTreatmentEvents,
    includePostInspection: heat.includePostInspection,
    postInspectionDays: heat.postInspectionDays,
    heatScope: normalized.heatScope,
    equipment: normalized.equipment,
    protocol,
    warnings,
  };

  const result = {
    label: line.label,
    basePrice: baseHeatPrice,
    price,
    multipliers,
    treatmentLines: [line],
    warnings,
    extra: {
      roomRate,
      roomBasedPrice: roundCurrency(roomBasedPrice),
      equipmentFee,
      vendorBasedPrice: vendorBasedPrice === undefined ? undefined : roundCurrency(vendorBasedPrice),
      sqftBasedPrice: sqftBasedPrice === undefined ? undefined : roundCurrency(sqftBasedPrice),
      includedTreatmentEvents: heat.includedTreatmentEvents,
      includePostInspection: heat.includePostInspection,
      postInspectionDays: heat.postInspectionDays,
      protocol: line.protocol,
    },
  };

  if (!applyCommonModifiers) return result;
  return bedBugCommonResult(normalized, result);
}

function resolveHybridPrice(property, normalized) {
  const heatBase = resolveHeatPrice(property, normalized, { applyCommonModifiers: false });
  const residualAddOnBase =
    BED_BUG.hybrid.residualAddOn.base
    + BED_BUG.hybrid.residualAddOn.perRoom * normalized.rooms;
  const combinedBase = heatBase.basePrice + residualAddOnBase;
  const multipliers = getBedBugMultipliers(normalized, BED_BUG.heat.sizeModifiers);
  const price = roundPrice(applyBedBugMultipliers(combinedBase, multipliers));
  const warnings = uniqueWarnings(BED_BUG.heat.warnings, BED_BUG.hybrid.warnings);
  const note = 'Hybrid is heat plus targeted residual protection, not a duplicate full chemical program.';
  const protocol = buildBedBugHybridProtocol(heatBase.treatmentLines[0].protocol);

  return bedBugCommonResult(normalized, {
    label: `${BED_BUG.hybrid.label} — ${normalized.rooms} room(s)`,
    basePrice: combinedBase,
    price,
    multipliers,
    warnings,
    treatmentLines: [{
      label: `${BED_BUG.hybrid.label} — ${normalized.rooms} room(s)`,
      method: normalized.method,
      price,
      includedTreatmentEvents: BED_BUG.heat.includedTreatmentEvents,
      heatEvent: true,
      residualApplication: true,
      residualAddOnBase,
      includePostInspection: BED_BUG.hybrid.includePostInspection,
      postInspectionDays: BED_BUG.hybrid.postInspectionDays,
      heatScope: normalized.heatScope,
      equipment: normalized.equipment,
      protocol,
      warnings,
      note,
    }],
    extra: {
      heatEvent: true,
      residualApplication: true,
      residualAddOnBase,
      combinedBase: roundCurrency(combinedBase),
      heatBasePrice: roundCurrency(heatBase.basePrice),
      includePostInspection: BED_BUG.hybrid.includePostInspection,
      postInspectionDays: BED_BUG.hybrid.postInspectionDays,
      protocol,
      note,
    },
  });
}

function priceBedBugTreatment(property, options) {
  const normalized = normalizeBedBugOptions(property, options);
  const footprintResolution = normalized.footprint
    ? {
        footprint: normalized.footprint,
        source: 'footprint',
        wasDefaulted: false,
        requiresManualReview: false,
        manualReviewReasons: [],
        warnings: [],
      }
    : resolvePestFootprint(property);
  const severityConfig = BED_BUG.severity[normalized.severity];
  const prepConfig = BED_BUG.prepStatus[normalized.prepStatus];

  if (severityConfig.quoteRequired) {
    const quote = buildBedBugQuoteRequired(normalized, 'SEVERE_INFESTATION', [
      'Severe bed bug infestations require inspection and custom quote.',
    ]);
    return {
      ...quote,
      footprintUsed: footprintResolution.footprint,
      footprintSource: footprintResolution.source,
      footprintWasDefaulted: footprintResolution.wasDefaulted,
      requiresManualReview: true,
      manualReviewReasons: combineManualReviewMetadata(footprintResolution.manualReviewReasons, ['SEVERE_INFESTATION']),
      warnings: uniqueWarnings(quote.warnings, footprintResolution.warnings),
    };
  }
  if (prepConfig.quoteRequired || prepConfig.allowed === false) {
    const quote = buildBedBugQuoteRequired(normalized, 'PREP_REFUSED', [
      'Prep refused requires inspection/manager quote before treatment.',
    ]);
    return {
      ...quote,
      footprintUsed: footprintResolution.footprint,
      footprintSource: footprintResolution.source,
      footprintWasDefaulted: footprintResolution.wasDefaulted,
      requiresManualReview: true,
      manualReviewReasons: combineManualReviewMetadata(footprintResolution.manualReviewReasons, ['PREP_REFUSED']),
      warnings: uniqueWarnings(quote.warnings, footprintResolution.warnings),
    };
  }

  let result;
  if (normalized.method === 'CHEMICAL') result = resolveChemicalPrice(normalized);
  else if (normalized.method === 'HEAT') result = resolveHeatPrice(property, normalized);
  else result = resolveHybridPrice(property, normalized);

  if (normalized.includeInternalCostBasis && normalized.isInternal) {
    result.internalCostBasis = BED_BUG.internalCostBasis;
  }
  result.footprintUsed = footprintResolution.footprint;
  result.footprintSource = footprintResolution.source;
  result.footprintWasDefaulted = footprintResolution.wasDefaulted;
  result.requiresManualReview = footprintResolution.requiresManualReview;
  result.manualReviewReasons = footprintResolution.manualReviewReasons;
  result.warnings = uniqueWarnings(result.warnings, footprintResolution.warnings);
  return result;
}

// Deprecated compatibility wrapper for old direct imports. New callers must
// use priceBedBugTreatment(property, options) with strict method/risk inputs.
function priceBedBug(rooms, method = 'CHEMICAL', footprint = 2000) {
  const normalizedMethod = normalizeBedBugEnum(method);
  if (normalizedMethod === 'BOTH') throw buildPricingError('Bed bug method BOTH is invalid; use HYBRID');
  assertEnum(normalizedMethod, BED_BUG.allowedMethods, 'method');
  return priceBedBugTreatment({ footprint, stories: 1 }, {
    rooms,
    method: normalizedMethod,
    severity: 'light',
    prepStatus: 'ready',
    occupancyType: 'singleFamily',
    equipment: normalizedMethod === 'CHEMICAL' ? undefined : 'INHOUSE',
    heatScope: normalizedMethod === 'CHEMICAL' ? undefined : 'ROOMS_ONLY',
  });
}

function priceWDO(input) {
  const property = typeof input === 'number' || typeof input === 'string'
    ? { footprint: input }
    : (input || {});
  const footprintResolution = resolvePestFootprint(property);
  const footprint = footprintResolution.footprint;
  for (const bracket of SPECIALTY.wdo.brackets) {
    if (footprint <= bracket.maxSqFt) {
      return {
        service: 'wdo_inspection',
        price: bracket.price,
        footprintUsed: footprint,
        footprintSource: footprintResolution.source,
        footprintWasDefaulted: footprintResolution.wasDefaulted,
        requiresManualReview: footprintResolution.requiresManualReview,
        manualReviewReasons: footprintResolution.manualReviewReasons,
        warnings: footprintResolution.warnings,
        bracketLabel: bracket.maxSqFt === Infinity ? '>3500' : `<=${bracket.maxSqFt}`,
      };
    }
  }
  const bracket = SPECIALTY.wdo.brackets[SPECIALTY.wdo.brackets.length - 1];
  return {
    service: 'wdo_inspection',
    price: bracket.price,
    footprintUsed: footprint,
    footprintSource: footprintResolution.source,
    footprintWasDefaulted: footprintResolution.wasDefaulted,
    requiresManualReview: footprintResolution.requiresManualReview,
    manualReviewReasons: footprintResolution.manualReviewReasons,
    warnings: footprintResolution.warnings,
    bracketLabel: '>3500',
  };
}

function normalizeFleaAreaSource(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (['AI_ESTIMATE', 'CONFIRMED_SQ_FT', 'MEASURED_TURF', 'MANUAL_OVERRIDE', 'UNKNOWN'].includes(raw)) return raw;
  return 'UNKNOWN';
}

function fleaSourceLabel(source) {
  return {
    AI_ESTIMATE: 'AI estimate',
    CONFIRMED_SQ_FT: 'Confirmed Sq Ft',
    MEASURED_TURF: 'Measured turf',
    MANUAL_OVERRIDE: 'Manual override',
    UNKNOWN: 'Unknown',
  }[source] || 'Unknown';
}

function priceFleaExterior(areaSqFt, options = {}) {
  const cfg = SPECIALTY.flea.exterior || {};
  const area = Math.max(0, Math.round(Number(areaSqFt) || 0));
  const source = normalizeFleaAreaSource(options.source || options.fleaExteriorAreaSource || 'UNKNOWN');
  const warningForZero = 'Treatable lawn area must be confirmed before exterior flea pricing.';
  if (cfg.enabled === false || area <= 0) {
    return { areaSqFt: area, source, sourceLabel: fleaSourceLabel(source), initial: 0, followUp: 0, total: 0, priced: false, requiresCustomQuote: false, customQuoteReason: null, warning: area <= 0 ? warningForZero : null, warnings: area <= 0 ? [warningForZero] : [], needsConfirmation: area <= 0 };
  }
  if (area > Number(cfg.maxSqFt || 20000)) {
    const reason = 'Exterior flea treatment over 20,000 sq ft requires a custom quote';
    const warning = 'Properties above 20,000 sq ft require a custom quote due to product volume and treatment time.';
    return { areaSqFt: area, source, sourceLabel: fleaSourceLabel(source), initial: 0, followUp: 0, total: 0, priced: false, requiresCustomQuote: true, customQuoteReason: reason, warning, warnings: [warning], needsConfirmation: true };
  }
  if (source === 'UNKNOWN') {
    const warning = 'Exterior flea pricing needs a confirmed treatable lawn area.';
    return { areaSqFt: area, source, sourceLabel: fleaSourceLabel(source), initial: 0, followUp: 0, total: 0, priced: false, requiresCustomQuote: false, customQuoteReason: null, warning, warnings: [warning], needsConfirmation: true };
  }
  const tier = (cfg.tiers || []).find(t => area >= Number(t.min) && area <= Number(t.max));
  if (!tier) {
    const reason = 'Exterior flea treatment over 20,000 sq ft requires a custom quote';
    const warning = 'Properties above 20,000 sq ft require a custom quote due to product volume and treatment time.';
    return { areaSqFt: area, source, sourceLabel: fleaSourceLabel(source), initial: 0, followUp: 0, total: 0, priced: false, requiresCustomQuote: true, customQuoteReason: reason, warning, warnings: [warning], needsConfirmation: true };
  }
  const initial = Math.round(Number(tier.initial) || 0);
  const followUp = Math.round(Number(tier.followUp) || 0);
  const warnings = source === 'AI_ESTIMATE'
    ? ['AI estimate detected. Please confirm before finalizing the quote.', 'flea_exterior_area_ai_estimate_needs_confirmation']
    : [];
  return { areaSqFt: area, source, sourceLabel: fleaSourceLabel(source), initial, followUp, total: initial + followUp, priced: true, requiresCustomQuote: false, customQuoteReason: null, warning: warnings[0] || null, warnings, needsConfirmation: source === 'AI_ESTIMATE' };
}

function getFleaUrgencyMultiplier(urgency, afterHours = false) {
  const raw = String(urgency || 'STANDARD').trim().toUpperCase();
  return getOneTimeUrgencyMultiplier({
    urgency: raw === 'ROUTINE' || raw === 'STANDARD' ? 'NONE' : raw,
    afterHours,
  });
}

function isTruthyPricingFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['TRUE', 'YES', 'Y', '1'].includes(String(value).trim().toUpperCase());
}

function fleaAdjustment(initial = 0, followUp = 0) {
  return { initial: Math.round(Number(initial) || 0), followUp: Math.round(Number(followUp) || 0) };
}

function normalizeFleaOfferKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['flea_knockdown_single', 'knockdown', 'single', 'one_visit'].includes(raw)) return 'flea_knockdown_single';
  return 'flea_elimination_two_visit';
}

function normalizeFleaComplexity(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['moderate', 'heavy'].includes(raw)) return raw;
  return 'light';
}

function fleaComplexityAdjustment(complexity, config = {}) {
  const configured = config?.[complexity] || {};
  if (configured.initial !== undefined || configured.followUp !== undefined || configured.followup !== undefined) {
    return fleaAdjustment(configured.initial, configured.followUp ?? configured.followup);
  }
  if (complexity === 'heavy') return fleaAdjustment(75, 35);
  if (complexity === 'moderate') return fleaAdjustment(35, 15);
  return fleaAdjustment(0, 0);
}

function fleaOfferConfig(cfg, offerKey) {
  const configured = Array.isArray(cfg.offers)
    ? cfg.offers.find(offer => offer?.offerKey === offerKey || offer?.offer_key === offerKey)
    : null;
  const defaults = offerKey === 'flea_knockdown_single'
    ? {
      service: 'flea_knockdown_single',
      displayName: 'Flea Knockdown Visit',
      visitCount: 1,
      warrantyType: 'none',
      baseInitial: 225,
      floorInitial: 185,
      baseFollowUp: 0,
      floorFollowUp: 0,
      packageFloor: 185,
      exteriorAddOnMode: 'initial_only',
    }
    : {
      service: 'flea_package',
      displayName: 'Flea Elimination Package',
      visitCount: 2,
      warrantyType: 'conditional_retreat',
      baseInitial: cfg.initial?.base ?? 225,
      floorInitial: cfg.initial?.floor ?? 185,
      baseFollowUp: cfg.followUp?.base ?? 125,
      floorFollowUp: cfg.followUp?.floor ?? 95,
      packageFloor: (cfg.initial?.floor ?? 185) + (cfg.followUp?.floor ?? 95),
      guaranteeWindowDaysAfterFollowUp: 30,
      maxIncludedRetreats: 1,
      exteriorAddOnMode: 'two_visit',
    };
  if (!configured) return defaults;
  return {
    ...defaults,
    ...configured,
    service: configured.service || configured.serviceKey || configured.service_key || defaults.service,
    displayName: configured.displayName || configured.display_name || defaults.displayName,
    visitCount: Number(configured.visitCount ?? configured.visit_count ?? defaults.visitCount) || defaults.visitCount,
    warrantyType: configured.warrantyType || configured.warranty_type || defaults.warrantyType,
    baseInitial: configured.baseInitial ?? configured.base_initial ?? defaults.baseInitial,
    floorInitial: configured.floorInitial ?? configured.floor_initial ?? defaults.floorInitial,
    baseFollowUp: configured.baseFollowUp ?? configured.base_follow_up ?? defaults.baseFollowUp,
    floorFollowUp: configured.floorFollowUp ?? configured.floor_follow_up ?? defaults.floorFollowUp,
    packageFloor: configured.packageFloor ?? configured.package_floor ?? defaults.packageFloor,
    exteriorAddOnMode: configured.exteriorAddOnMode || configured.exterior_add_on_mode || defaults.exteriorAddOnMode,
  };
}

function priceFlea(property = {}) {
  const cfg = SPECIALTY.flea;
  const services = property.services || {};
  const fleaOptions = typeof services.flea === 'object' && services.flea !== null ? services.flea : {};
  const offerKey = normalizeFleaOfferKey(
    property.fleaOfferKey
    ?? property.offerKey
    ?? services.fleaOfferKey
    ?? fleaOptions.offerKey
    ?? fleaOptions.fleaOfferKey
  );
  const offer = fleaOfferConfig(cfg, offerKey);
  const footprintResolution = resolvePestFootprint({
    ...property,
    homeSqFt: property.homeSqFt
      ? Math.round(Number(property.homeSqFt) / Number(property.stories || 1))
      : property.homeSqFt,
  });
  const footprint = footprintResolution.footprint;
  const lotSqFt = Number(property.lotSqFt ?? property.lotSizeSqFt ?? 7500) || 7500;
  const features = property.features || {};
  const treeDensity = String(property.treeDensity ?? features.trees ?? 'light').toLowerCase();
  const landscapeComplexity = String(property.landscapeComplexity ?? features.complexity ?? 'simple').toLowerCase();
  const infestationComplexity = normalizeFleaComplexity(
    property.fleaComplexity
    ?? property.infestationComplexity
    ?? services.fleaComplexity
    ?? fleaOptions.complexity
    ?? fleaOptions.fleaComplexity
  );
  const exteriorSourceSuspected = isTruthyPricingFlag(
    property.fleaExteriorSourceSuspected
    ?? property.exteriorSourceSuspected
    ?? services.fleaExteriorSourceSuspected
    ?? fleaOptions.exteriorSourceSuspected
  );
  const exteriorSelected = !!(property.fleaExterior || services.fleaExterior || fleaOptions.fleaExterior);
  const exteriorArea = Number(property.fleaExteriorAreaSqFt ?? services.fleaExteriorAreaSqFt ?? fleaOptions.fleaExteriorAreaSqFt ?? 0) || 0;
  const exteriorSource = normalizeFleaAreaSource(
    property.fleaExteriorAreaSource
    ?? services.fleaExteriorAreaSource
    ?? fleaOptions.fleaExteriorAreaSource
    ?? (exteriorSelected && exteriorArea > 0 ? 'MANUAL_OVERRIDE' : 'UNKNOWN')
  );
  const exterior = exteriorSelected ? priceFleaExterior(exteriorArea, { source: exteriorSource }) : priceFleaExterior(0, { source: exteriorSource });
  const hasPricedExteriorFleaSpray = exteriorSelected && exterior.priced === true;

  const footprintAdj = fleaAdjustment(
    interpolate(footprint, cfg.footprintAdjustments?.initial || [], 'at', 'adj'),
    interpolate(footprint, cfg.footprintAdjustments?.followUp || [], 'at', 'adj')
  );
  const lotAdj = fleaAdjustment(0, 0);
  const treeCfg = cfg.treeDensityAdjustments?.[treeDensity] || cfg.treeDensityAdjustments?.light || {};
  const complexityCfg = cfg.landscapeComplexityAdjustments?.[landscapeComplexity] || cfg.landscapeComplexityAdjustments?.simple || {};
  const treeDensityAdj = hasPricedExteriorFleaSpray ? fleaAdjustment(treeCfg.initial, treeCfg.followUp) : fleaAdjustment(0, 0);
  const landscapeComplexityAdj = hasPricedExteriorFleaSpray ? fleaAdjustment(complexityCfg.initial, complexityCfg.followUp) : fleaAdjustment(0, 0);
  const infestationComplexityAdj = fleaComplexityAdjustment(infestationComplexity, cfg.complexityAdjustments);

  const baseInitial = Math.round(Number(offer.baseInitial) || 225);
  const baseFollowUp = Math.round(Number(offer.baseFollowUp) || 0);
  const baseFloorInitial = Math.round(Number(offer.floorInitial) || 185);
  const baseFloorFollowUp = Math.round(Number(offer.floorFollowUp) || 0);
  const pricedExteriorInitial = offer.exteriorAddOnMode === 'none' ? 0 : exterior.initial;
  const pricedExteriorFollowUp = offer.exteriorAddOnMode === 'two_visit' ? exterior.followUp : 0;
  const rawInitial = Math.max(baseFloorInitial, baseInitial + footprintAdj.initial + lotAdj.initial + treeDensityAdj.initial + landscapeComplexityAdj.initial + infestationComplexityAdj.initial) + pricedExteriorInitial;
  const rawFollowUp = offer.visitCount > 1
    ? Math.max(baseFloorFollowUp, baseFollowUp + footprintAdj.followUp + lotAdj.followUp + treeDensityAdj.followUp + landscapeComplexityAdj.followUp + infestationComplexityAdj.followUp) + pricedExteriorFollowUp
    : 0;
  const urgencyMultiplier = getFleaUrgencyMultiplier(property.urgency ?? fleaOptions.urgency, property.afterHours ?? fleaOptions.afterHours);
  const isRecurringCustomer = (
    isTruthyPricingFlag(property.isRecurringCustomer)
    || isTruthyPricingFlag(property.recurringCustomer)
    || isTruthyPricingFlag(fleaOptions.isRecurringCustomer)
    || isTruthyPricingFlag(fleaOptions.recurringCustomer)
  );
  const rawTotal = rawInitial + rawFollowUp;
  const discounted = applyOneTimeRecurringCustomerDiscount(rawTotal, { isRecurringCustomer });
  const recurringCustomerMultiplier = 1 - discounted.rate;
  const packageFloor = Math.round(Number(offer.packageFloor) || (baseFloorInitial + baseFloorFollowUp));
  const discountedStandard = Math.max(packageFloor, discounted.price);
  const rushPremium = Math.round(rawTotal * Math.max(0, urgencyMultiplier - 1));
  const total = Math.round(discountedStandard + rushPremium);
  const initial = rawTotal > 0 ? Math.round(total * (rawInitial / rawTotal)) : 0;
  const followUp = total - initial;
  const exteriorDetail = exteriorSelected && exterior.areaSqFt > 0
    ? `Exterior flea spray — ${exterior.areaSqFt.toLocaleString()} sf${exterior.source === 'AI_ESTIMATE' ? ' AI estimate' : ''}`
    : null;
  const manualReviewReasons = [...footprintResolution.manualReviewReasons];
  if (exteriorSelected && exterior.source === 'UNKNOWN') {
    manualReviewReasons.push('flea_exterior_area_source_unknown');
  }
  if (exteriorSelected && exterior.source === 'AI_ESTIMATE') {
    manualReviewReasons.push('flea_exterior_area_ai_estimate_needs_confirmation');
  }
  if (exterior.requiresCustomQuote) {
    manualReviewReasons.push('flea_exterior_area_custom_quote_required');
  }
  const warnings = uniqueList([
    ...footprintResolution.warnings,
    ...(exteriorSelected ? (exterior.warnings || []) : []),
    ...(exteriorSourceSuspected && !exteriorSelected ? ['Exterior flea source suspected; guarantee scope is limited to treated interior areas.'] : []),
  ]);
  const guaranteeScope = exteriorSelected && hasPricedExteriorFleaSpray
    ? 'interior_and_treated_exterior_zones'
    : 'interior_only';
  const guaranteeExclusions = uniqueList([
    ...(exteriorSourceSuspected && !exteriorSelected ? ['exterior_source_declined'] : []),
    ...(offer.warrantyType === 'conditional_retreat'
      ? ['untreated_pets', 'prep_not_completed', 'missed_follow_up', 'untreated_or_inaccessible_areas', 'reintroduction_after_service']
      : []),
  ]);
  const warrantyLabel = offer.warrantyType === 'conditional_retreat'
    ? 'Conditional retreat guarantee'
    : 'No retreat warranty included';

  return {
    service: offer.service,
    serviceKey: 'flea',
    billingCadence: 'one_time',
    offerKey,
    pricingConfigKey: 'flea_2026_v1',
    visits: offer.visitCount,
    initial,
    followUp,
    total,
    base: { initial: baseInitial, followUp: baseFollowUp },
    adjustments: {
      footprint: footprintAdj,
      lot: lotAdj,
      treeDensity: treeDensityAdj,
      landscapeComplexity: landscapeComplexityAdj,
      infestationComplexity: infestationComplexityAdj,
      exteriorArea: { areaSqFt: exterior.areaSqFt, source: exterior.source, initial: pricedExteriorInitial, followUp: pricedExteriorFollowUp, total: pricedExteriorInitial + pricedExteriorFollowUp, status: exteriorSelected ? (exterior.priced ? 'priced' : 'requires_confirmation') : 'not_included' },
    },
    modifiers: { urgencyMultiplier, recurringCustomerMultiplier, rushPremium },
    display: {
      name: offer.visitCount > 1 ? 'Flea Elimination Package — 2 visits' : 'Flea Knockdown Visit',
      detail: offer.visitCount > 1 ? `$${initial} initial + $${followUp} follow-up` : '1 visit, no retreat warranty',
      exteriorDetail,
    },
    detail: offer.visitCount > 1 ? `$${initial} initial + $${followUp} follow-up` : '1 visit, no retreat warranty',
    exteriorDetail,
    scope: 'Exterior flea treatment is applied to eligible targeted outdoor areas where flea activity is likely, such as shaded pet resting areas, under decks, kennels, foundation edges, mulch beds, and other approved areas. Final treatment area is subject to technician confirmation and product label directions.',
    requiresCustomQuote: !!exterior.requiresCustomQuote,
    quoteRequired: !!exterior.requiresCustomQuote,
    customQuoteReason: exterior.customQuoteReason || null,
    reason: exterior.customQuoteReason || null,
    warning: warnings[0] || null,
    warnings,
    requiresManualReview: footprintResolution.requiresManualReview || !!(exteriorSelected && (exterior.needsConfirmation || exterior.requiresCustomQuote)),
    manualReviewReasons: uniqueList(manualReviewReasons),
    areaSource: exterior.source,
    footprintUsed: footprint,
    footprintSource: footprintResolution.source,
    footprintWasDefaulted: footprintResolution.wasDefaulted,
    infestationComplexity,
    warrantyType: offer.warrantyType,
    warrantyLabel,
    guaranteeWindowDaysAfterFollowUp: offer.guaranteeWindowDaysAfterFollowUp || null,
    maxIncludedRetreats: offer.maxIncludedRetreats || 0,
    guaranteeScope,
    guaranteeStatus: exteriorSourceSuspected && !exteriorSelected ? 'limited' : (offer.warrantyType === 'conditional_retreat' ? 'eligible_with_conditions' : 'none'),
    guaranteeExclusions,
    prepChecklistRequired: offer.warrantyType === 'conditional_retreat',
    petSourceAttestationRequired: offer.warrantyType === 'conditional_retreat',
    exteriorStatus: exteriorSelected ? (exterior.priced ? 'priced' : 'requires_confirmation') : 'not_included',
    raw: { initial: rawInitial, followUp: rawFollowUp, total: rawTotal },
    fleaExteriorZones: property.fleaExteriorZones || services.fleaExteriorZones || fleaOptions.fleaExteriorZones || [],
    discountHandledByPricingFunction: true,
    recurringCustomerDiscountRate: discounted.rate,
    subtotalBeforeRecurringCustomerDiscount: rawTotal,
    discountedStandard,
  };
}

function priceTopDressing(lawnSqFt, depth = 'eighth', hasRecurringLawn = false) {
  const lawnEst = hasRecurringLawn ? lawnSqFt : lawnSqFt * 0.65;
  const k = lawnEst / 1000;
  const cfg = SPECIALTY.topDressing[depth];

  let price;
  if (depth === 'eighth') {
    const materialCost = k * 1.04 * cfg.sandRate + k * cfg.deliveryRate;
    const laborMin = lawnEst / 130 + 30;
    const laborCostVal = GLOBAL.LABOR_RATE * laborMin / 60;
    price = Math.round((materialCost + laborCostVal) / cfg.marginDivisor);
  } else {
    const materialCost = k * 2.08 * cfg.sandRate + k * cfg.deliveryRate;
    const laborMin = lawnEst / 130 * 1.5 + 45;
    const laborCostVal = GLOBAL.LABOR_RATE * laborMin / 60;
    price = Math.round((materialCost + laborCostVal) / cfg.marginDivisor);
  }
  price = Math.max(cfg.floor, price);

  return { service: 'top_dressing', depth, lawnSqFt: Math.round(lawnEst), price };
}

function normalizeDethatchingChoice(value, choices, fallback, warningCode) {
  const raw = normalizeToken(value || fallback);
  if (Object.prototype.hasOwnProperty.call(choices || {}, raw)) {
    return { key: raw, warning: null };
  }
  return { key: fallback, warning: warningCode };
}

function normalizeDethatchingGrassType(options = {}) {
  const requestedGrassType = options.grassType ?? options.track ?? options.turfTrack ?? options.grassTrack;
  if (!hasValue(requestedGrassType)) {
    return {
      requestedGrassType,
      grassType: 'unknown',
      isStAugustine: false,
      isKnown: false,
      warnings: ['grass_type_not_recorded'],
    };
  }

  const raw = normalizeToken(requestedGrassType);
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
    parseNonNegativeMeasurement(options.thatchProbe1Inches),
    parseNonNegativeMeasurement(options.thatchProbe2Inches),
    parseNonNegativeMeasurement(options.thatchProbe3Inches),
  ];
  const validProbeValues = probeValues.filter(value => value !== null);
  const explicitDepth = parseNonNegativeMeasurement(options.thatchDepthInches);
  const averageDepth = explicitDepth !== null
    ? explicitDepth
    : (validProbeValues.length > 0
      ? validProbeValues.reduce((sum, value) => sum + value, 0) / validProbeValues.length
      : null);
  const warnings = [];
  if (validProbeValues.length > 0 && validProbeValues.length < 3) {
    warnings.push('partial_thatch_probe_readings');
  }
  if ((optionBooleanTrue(options.requireThatchDepth) || optionBooleanTrue(options.requireThatchProbe)) && averageDepth === null) {
    warnings.push('thatch_depth_not_recorded');
  }
  return {
    thatchDepthInches: averageDepth === null ? null : roundMoney(averageDepth),
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
  const raw = typeof value === 'string' ? normalizeToken(value) : '';
  return DETHATCHING_MANAGER_APPROVAL_REASONS.has(raw) ? raw : null;
}

function priceDethatching(lawnSqFt, options = {}) {
  const cfg = SPECIALTY.dethatching;
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
  const debrisRemovalRequested = optionBooleanTrue(options.debrisRemovalIncluded);
  const cleanupLevel = cleanupChoice.key === 'none' && debrisRemovalRequested ? 'light' : cleanupChoice.key;
  const cleanup = cfg.cleanup[cleanupLevel] || cfg.cleanup.none;
  const grass = normalizeDethatchingGrassType(options);
  const probe = resolveDethatchingProbe(options);
  const timeModel = cfg.timeModel || {};
  const basePrimaryMin = lawnEst / (timeModel.primaryPassSqFtPerMin || 100);
  const baseCrossMin = lawnEst / (timeModel.crossPassSqFtPerMin || 200);
  const setupMin = Number(timeModel.setupMin || 30);
  const cleanupMin = (lawnEst / 1000) * cleanup.minutesPer1K;
  const accessMin = cfg.accessMinutes[accessChoice.key] || 0;
  const timeMin = basePrimaryMin + baseCrossMin + setupMin + cleanupMin + accessMin;
  const laborCostVal = GLOBAL.LABOR_RATE * timeMin / 60;
  const materialCost = (lawnEst / 1000) * cfg.materialPer1K;
  const cleanupPriceAdder = (lawnEst / 1000) * cleanup.pricePer1K;
  const rawCost = laborCostVal + materialCost;
  const formulaBasePrice = Math.max(cfg.floor, Math.round(rawCost / cfg.marginDivisor));
  const compatibilityBasePrice = cleanupLevel === 'none' && accessChoice.key === 'easy'
    ? cfg.baseCompatibilityPrices?.[String(Math.round(lawnEst))]
    : undefined;
  const basePrice = Number.isFinite(Number(compatibilityBasePrice))
    ? Number(compatibilityBasePrice)
    : formulaBasePrice;
  const calculatedPrice = Math.round(basePrice + cleanupPriceAdder);
  const debrisRemovalIncluded = debrisRemovalRequested || cleanupLevel !== 'none';
  const managerApproved = optionBooleanTrue(options.managerApproved);
  const managerApprovalOverrideReason = normalizeDethatchingManagerApprovalReason(options.managerApprovalReason);
  const requiresManagerApproval = !!(cfg.manualReview?.stAugustineRequiresApproval && grass.isStAugustine);
  const warnings = uniqueList([
    cleanupChoice.warning,
    accessChoice.warning,
    ...grass.warnings,
    ...probe.warnings,
    cleanupLevel === 'none' && !debrisRemovalIncluded ? 'base_price_excludes_bagging_or_debris_hauling' : null,
    requiresManagerApproval ? 'Dethatching St. Augustine / Floratam can damage stolons. Manager approval required.' : null,
  ]);
  const manualReviewReasons = [];
  const largeLawnSqFt = Number(cfg.manualReview?.largeLawnSqFt || 10000);
  const heavyCleanupSqFt = Number(cfg.manualReview?.heavyCleanupSqFt || 6000);

  if (lawnEst >= largeLawnSqFt) manualReviewReasons.push('large_lawn_dethatching_manual_review');
  if (cleanupLevel === 'heavy' && lawnEst >= heavyCleanupSqFt) manualReviewReasons.push('heavy_cleanup_required');
  if (accessChoice.key === 'difficult') manualReviewReasons.push('difficult_access_dethatching');
  if (grass.grassType === 'unknown') manualReviewReasons.push('unknown_grass_dethatching_review');
  if ((optionBooleanTrue(options.requireThatchDepth) || optionBooleanTrue(options.requireThatchProbe)) && probe.thatchDepthInches === null) {
    manualReviewReasons.push('thatch_depth_not_recorded');
  }
  if (requiresManagerApproval && !managerApproved) {
    manualReviewReasons.push('st_augustine_dethatching_manager_approval_required');
  }
  if (requiresManagerApproval && managerApproved && !managerApprovalOverrideReason) {
    manualReviewReasons.push('st_augustine_dethatching_manager_approval_reason_missing');
  }
  if (optionBooleanTrue(options.isCommercial) || normalizeToken(options.propertyType) === 'commercial') {
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
  const manualReviewReasonList = uniqueList(manualReviewReasons);
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
    rawCost: roundMoney(rawCost),
    timeMin: roundMoney(timeMin),
    laborCost: roundMoney(laborCostVal),
    materialCost: roundMoney(materialCost),
    cleanupLevel,
    requestedCleanupLevel: cleanupChoice.key,
    cleanupLabel: cleanup.label,
    cleanupMin: roundMoney(cleanupMin),
    cleanupPriceAdder: roundMoney(cleanupPriceAdder),
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
      ...(cfg.equipment || {}),
      internalOnly: true,
    },
    detail: detailParts.join(' | '),
  };
}

// ============================================================
// PLUGGING (sod plug install by spacing)
// ============================================================
// Urgency handling matches v2 applyOT (urgency multiplier only — rc discount
// is applied downstream by the discount engine for one-time services).
function pricePlugging(lawnSqFt, spacing = 12, options = {}) {
  const { urgency = 'ROUTINE', afterHours = false } = options;
  const cfg = SPECIALTY.plugging;
  const ppsf = cfg.spacingRates[`${spacing}inch`] || cfg.spacingRates['12inch'];
  const label = spacing === 6 ? '6" Premium' : spacing === 9 ? '9" Standard' : '12" Economy';
  const totalPlugs = Math.ceil(lawnSqFt * ppsf);
  const trays = Math.ceil(totalPlugs / cfg.plugsPerTray);
  const cost = totalPlugs * cfg.costPerPlug + (totalPlugs / cfg.laborPerPlugs) * GLOBAL.LABOR_RATE;
  // v2 parity: raw floor 250 (not r'd), raw margin 1 - 0.45 = 0.55
  let price = Math.max(250, Math.round(cost / 0.55));
  price = applyUrgency(price, urgency, afterHours);
  const perSf = Math.round(price / Math.max(1, lawnSqFt) * 100) / 100;
  return {
    service: 'plugging',
    name: 'Lawn Plugging',
    price,
    detail: `${label} | ${lawnSqFt.toLocaleString()} sf | ${totalPlugs.toLocaleString()} plugs | $${perSf}/sf`,
    lawnSqFt, spacing, totalPlugs, trays, perSf, label,
    sodWarning: spacing === 6,
  };
}

// ============================================================
// FOAM & DRILL (termite perimeter injection)
// ============================================================
function resolveFoamDrillTier(points, tiers = SPECIALTY.foamDrill.tiers) {
  const pointCount = Number(points);
  if (!Number.isInteger(pointCount) || pointCount < 1) {
    throw new Error('Foam drill point count must be a positive whole number.');
  }
  const tier = tiers.find(t => pointCount <= t.maxPoints);
  if (!tier) {
    const max = tiers[tiers.length - 1]?.maxPoints || 0;
    throw new Error(`Foam drill point count ${pointCount} exceeds the configured ${max}-point maximum.`);
  }
  return { pointCount, tier };
}

function foamDrillTierLabel(tier) {
  return tier.label + (tier.maxPoints === 5 ? ' (1–5)' : tier.maxPoints === 10 ? ' (6–10)' : tier.maxPoints === 15 ? ' (11–15)' : '');
}

function priceFoamDrill(points = 5, options = {}) {
  const { urgency = 'ROUTINE', afterHours = false } = options;
  const cfg = SPECIALTY.foamDrill;
  const { pointCount, tier } = resolveFoamDrillTier(points, cfg.tiers);
  const cost = tier.cans * cfg.canCost + tier.laborHrs * GLOBAL.LABOR_RATE + cfg.bitsCost;
  // Floor removed (owner directive 2026-06-25): true tiered cost ÷ margin.
  let price = Math.max(cfg.floor, Math.round(cost / cfg.marginDivisor));
  price = applyUrgency(price, urgency, afterHours);
  const label = foamDrillTierLabel(tier);
  return {
    service: 'foam_drill',
    name: 'Drill-and-Foam Termite',
    price,
    detail: `${label} | ${tier.cans} can${tier.cans > 1 ? 's' : ''}`,
    points: pointCount, tier: label, cans: tier.cans,
  };
}

// Recurring spot-foam termite program. Per-visit price is the one-time foam
// cost basis (material + labor ÷ margin, NO floor) × cadence multiplier, so a
// more frequent cadence buys a deeper per-visit discount vs the one-time
// service. Returned as a recurring line item (.annual / .monthly) that is
// STANDALONE — the estimate engine does not add it to activeServiceKeys, and
// WAVEGUARD.excludedFromPercentDiscount[foam_recurring] keeps it out of the
// bundle % discount, so the cadence multiplier is its only discount.
function priceRecurringFoam(points = 5, options = {}) {
  const cfg = SPECIALTY.foamDrill;
  const rec = SPECIALTY.foamDrillRecurring;
  const { pointCount, tier } = resolveFoamDrillTier(points, cfg.tiers);
  // Normalize cadence aliases — the billing/estimate stack also uses the
  // bi_monthly key for the two-month cadence; without this a {cadence:'bi_monthly'}
  // caller/replay silently falls back to quarterly (4 visits at the quarterly
  // multiplier instead of the intended 6-visit bimonthly plan).
  const CADENCE_ALIASES = { bi_monthly: 'bimonthly', 'bi-monthly': 'bimonthly', bimonth: 'bimonthly' };
  const requestedCadence = options.cadence
    ? (CADENCE_ALIASES[String(options.cadence).toLowerCase()] || options.cadence)
    : options.cadence;
  const cadence = rec.cadenceMultipliers[requestedCadence] ? requestedCadence : rec.defaultCadence;
  const multiplier = rec.cadenceMultipliers[cadence];
  const visits = rec.frequencies[cadence];
  const cost = tier.cans * cfg.canCost + tier.laborHrs * GLOBAL.LABOR_RATE + cfg.bitsCost;
  const oneTimePerVisit = Math.round(cost / cfg.marginDivisor); // no floor
  const perVisit = Math.round(oneTimePerVisit * multiplier);
  const annual = perVisit * visits;
  const monthly = Math.round(annual / 12 * 100) / 100;
  const discountVsOneTime = Math.round((1 - multiplier) * 100);
  const cadenceLabel = { quarterly: 'Quarterly', bimonthly: 'Bimonthly', monthly: 'Monthly' }[cadence];
  const tierLabel = foamDrillTierLabel(tier);
  return {
    service: 'foam_recurring',
    name: `Recurring Foam Treatment (${cadenceLabel})`,
    annual,
    monthly,
    perVisit,
    perTreatment: perVisit,
    visitsPerYear: visits,
    cadence,
    // Drill-and-foam labor hours by tier (1.0–3.0h) → slot duration, so
    // self-booking reserves a long-enough window (estimate-slot-availability
    // durationForService) instead of the generic 45-min fallback.
    laborHours: tier.laborHrs,
    estimatedDurationMinutes: Math.round(tier.laborHrs * 60),
    // Owner directive: the cadence multiplier is foam_recurring's ONLY discount.
    // This flag keeps the annual-prepay calculator (estimate-converter
    // isNonDiscountableRecurringLine) from stacking the generic prepay % on top.
    discountable: false,
    oneTimePerVisit,
    discountVsOneTime,
    detail: `${tierLabel} | ${tier.cans} can${tier.cans > 1 ? 's' : ''} | ${visits} visits/yr | ${discountVsOneTime}% off one-time`,
    points: pointCount, tier: tierLabel, cans: tier.cans,
  };
}

// ============================================================
// STINGING INSECT (wasps, hornets, bees)
// ============================================================
function priceWasp(property = {}, options = {}) {
  const cfg = SPECIALTY.wasp;
  const rawTier = options.baseTier ?? options.tier ?? 2;
  let tierIndex = Number.isFinite(Number(rawTier))
    ? Math.max(0, Math.min(cfg.tiers.length - 1, Number(rawTier) - 1))
    : cfg.tiers.findIndex((_, idx) => normalizeToken(rawTier) === `tier_${idx + 1}`);
  if (tierIndex < 0) tierIndex = 1;
  const safeTierIndex = tierIndex;
  let basePrice = cfg.tiers[safeTierIndex];
  const addOns = [];
  const warnings = [];

  const addFlat = (name, amount) => {
    const value = Number(amount) || 0;
    if (value > 0) {
      basePrice += value;
      addOns.push({ name, amount: value });
    }
  };

  const aggressive = normalizeToken(options.aggressiveness ?? options.aggressive ?? 'NO').toUpperCase();
  if (aggressive === 'MILD') addFlat('aggressiveness', cfg.addons.aggressiveness[0]);
  else if (aggressive === 'HIGH') addFlat('aggressiveness', cfg.addons.aggressiveness[1]);
  else if (aggressive === 'EXTREME') addFlat('aggressiveness', cfg.addons.aggressiveness[2]);

  const height = normalizeToken(options.height ?? 'GROUND').toUpperCase();
  if (height === 'MID') addFlat('height', cfg.addons.height[0]);
  else if (height === 'HIGH') addFlat('height', cfg.addons.height[1]);

  const confined = normalizeToken(options.confinedSpace ?? options.confined ?? 'NO').toUpperCase();
  if (confined === 'YES' || confined === 'TRUE') {
    addFlat('confinedSpace', safeTierIndex + 1 >= 3 ? cfg.addons.confinedSpace[1] : cfg.addons.confinedSpace[0]);
  }

  const urgency = normalizeToken(options.urgency ?? 'ROUTINE').toUpperCase();
  if (options.sameDay === true || urgency === 'SOON') addFlat('sameDay', cfg.addons.sameDay);
  else if (options.urgent === true || urgency === 'URGENT') {
    basePrice = Math.round(basePrice * cfg.addons.urgent);
    addOns.push({ name: 'urgent', multiplier: cfg.addons.urgent });
  }
  if (options.afterHours === true) addFlat('afterHours', cfg.addons.afterHours);

  const removalKey = normalizeToken(options.removalType ?? options.removal ?? 'NONE');
  const removalPrice = cfg.removal?.[removalKey] || 0;
  if (removalPrice > 0) addOns.push({ name: `removal_${removalKey}`, amount: removalPrice });

  const hasRecurringPest = !!(options.hasRecurringPest ?? property.hasRecurringPest);
  const freeWithRecurringPest = options.freeWithRecurringPest ?? cfg.freeWithRecurringPest;
  const highRiskRemovalSelected = removalPrice > 0 || addOns.length > 0;
  const freeWithRecurringPestApplied = !!(
    freeWithRecurringPest &&
    hasRecurringPest &&
    safeTierIndex === 0 &&
    !highRiskRemovalSelected
  );
  if (freeWithRecurringPest && hasRecurringPest && highRiskRemovalSelected) {
    warnings.push('wasp_bundle_not_applied_to_high_risk_removal');
  }

  const subtotal = basePrice + removalPrice;
  const price = freeWithRecurringPestApplied ? 0 : subtotal;
  return {
    service: 'wasp',
    price,
    baseTier: safeTierIndex + 1,
    basePrice: cfg.tiers[safeTierIndex],
    addOns,
    freeWithRecurringPestApplied,
    requiresManualReview: false,
    manualReviewReasons: [],
    warnings,
    pricingBreakdown: {
      subtotal,
      removal: removalPrice,
      bundledCredit: freeWithRecurringPestApplied ? subtotal : 0,
    },
  };
}

function priceStingingInsect(options = {}) {
  const {
    species = 'PAPER_WASP', tier = 2, removal = 'NONE',
    aggressive = 'NO', height = 'GROUND', confined = 'NO',
    urgency = 'ROUTINE', afterHours = false,
    hasRecurringPest = false,
  } = options;
  const cfg = SPECIALTY.wasp;
  const speciesNames = {
    PAPER_WASP: 'Paper Wasps', YJ_AERIAL: 'Yellow Jackets (aerial)',
    YJ_GROUND: 'Yellow Jackets (ground)', MUD_DAUBER: 'Mud Daubers',
    HONEYBEE_NEW: 'Honeybees (new)', HONEYBEE_EST: 'Honeybees (established)',
    CARPENTER: 'Carpenter Bees', BALDFACED: 'Baldfaced Hornets',
    AFRICANIZED: 'Africanized Bees',
  };

  let price = cfg.tiers[Math.max(0, Math.min(cfg.tiers.length - 1, tier - 1))];
  const mods = [];
  // v2 parity: raw addon values (not r'd). Base tiers stay r'd-matched.
  if (aggressive === 'MILD') { price += 75; mods.push('+$75 aggressive'); }
  else if (aggressive === 'HIGH') { price += 150; mods.push('+$150 aggressive'); }
  else if (aggressive === 'EXTREME') { price += 200; mods.push('+$200 aggressive'); }

  if (height === 'MID') { price += 75; mods.push('+$75 height'); }
  else if (height === 'HIGH') { price += 150; mods.push('+$150 height'); }

  if (confined === 'YES') {
    const add = tier >= 3 ? 200 : 100;
    price += add; mods.push(`+$${add} confined`);
  }

  if (urgency === 'SOON') { price += 75; mods.push('+$75 same-day'); }
  else if (urgency === 'URGENT') { price = Math.round(price * 1.5); mods.push('+50% emergency'); }
  if (afterHours) { price += 75; mods.push('+$75 after-hours'); }

  let removalPrice = 0, removalLabel = '';
  // v2 parity: raw removal values
  if (removal === 'SMALL') { removalPrice = 75; removalLabel = 'Small nest'; }
  else if (removal === 'LARGE') { removalPrice = 250; removalLabel = 'Large comb'; }
  else if (removal === 'HONEYCOMB') { removalPrice = 375; removalLabel = 'Honeycomb extraction'; }
  else if (removal === 'RELOCATE') { removalPrice = 450; removalLabel = 'Live bee relocation'; }

  const total = price + removalPrice;
  const highRiskRemovalSelected = removalPrice > 0 || mods.length > 0;
  const includedOnProgram = cfg.freeWithRecurringPest && hasRecurringPest
    && (species === 'PAPER_WASP' || species === 'MUD_DAUBER') && tier <= 1
    && !highRiskRemovalSelected;
  const warnings = cfg.freeWithRecurringPest && hasRecurringPest && highRiskRemovalSelected
    ? ['wasp_bundle_not_applied_to_high_risk_removal']
    : [];

  return {
    service: 'stinging_insect',
    name: `Stinging Insect — ${speciesNames[species] || species}`,
    price: includedOnProgram ? 0 : total,
    detail: `Tier ${tier} — ${speciesNames[species] || species}${mods.length ? ' | ' + mods.join(', ') : ''}`,
    species, tier, mods,
    removal: removalPrice > 0 ? { name: removalLabel, price: removalPrice } : null,
    includedOnProgram,
    freeWithRecurringPestApplied: includedOnProgram,
    warnings,
  };
}

// ============================================================
// EXCLUSION (rodent entry-point sealing)
// ============================================================
// V1+V2 unified pricer: per-entry-point structure (V1) with home-size
// minimums and story/roof/construction multipliers (V2).
//
// Multipliers apply to the (moderate + advanced) subtotal only — simple
// interior gaps don't scale by structure access.
//
// Inputs:
//   simple/moderate/advanced: entry-point counts
//   specialty:                 specialty repair count (custom $275+ each)
//   homeSqFt:                  for minimum-floor lookup
//   stories:                   1 / 2 / 3+ (numeric)
//   roofType:                  shingle / flat / metal / tile / steep_or_fragile
//   constructionType:          block / stucco / frame / mixed
//   waiveInspection:           caller-controlled
//   hasServiceOptIn:           legacy auto-waive (any rodent service)
//   approvedTotalForWaiver:    waive if total approved work exceeds $995
//   urgency / afterHours:      passed to applyUrgency
function priceExclusion(options = {}) {
  const {
    simple = 0,
    moderate = 0,
    advanced = 0,
    specialty = 0,
    specialtyCustomTotal = 0,   // caller-supplied custom amount when specialty > 0
    homeSqFt = 2000,
    stories = 1,
    roofType = 'shingle',
    constructionType = 'block',
    waiveInspection = false,
    hasServiceOptIn = false,
    approvedTotalForWaiver = 0,
    urgency = 'ROUTINE', afterHours = false,
  } = options;

  const cfg = SPECIALTY.exclusion;
  const ins = RODENT.inspection || { fee: cfg.inspectionFee, waiveIfApprovedTotalOver: 995 };

  const simpleSubtotal = simple * cfg.perPoint.simple;
  const accessSubtotal = (moderate * cfg.perPoint.moderate) + (advanced * cfg.perPoint.advanced);

  const storiesNum = Number(stories) || 1;
  const storyKey = storiesNum >= 3 ? 'three' : (storiesNum === 2 ? 'two' : 'one');
  const storyMult = cfg.storyMultipliers?.[storyKey] ?? 1.0;
  const roofMult = cfg.roofMultipliers?.[roofType] ?? 1.0;
  const constructionMult = cfg.constructionMultipliers?.[constructionType] ?? 1.0;

  const accessAdjusted = accessSubtotal * storyMult * roofMult * constructionMult;

  // Specialty: caller may provide a custom total; otherwise charge the floor per unit
  const specialtyTotal = specialty > 0
    ? Math.max(specialtyCustomTotal, specialty * cfg.perPoint.specialtyMinimum)
    : 0;

  const rawSubtotal = simpleSubtotal + accessAdjusted + specialtyTotal;

  // Home-size minimum lookup
  const minBracket = _bracketLookup(homeSqFt, cfg.minimumsByHomeSqFt, 'maxSqFt');
  const minimumFloor = minBracket.minimum;

  const epSubtotal = Math.max(minimumFloor, Math.round(rawSubtotal / 10) * 10);
  const subtotalWithUrgency = applyUrgency(epSubtotal, urgency, afterHours);

  // Inspection waiver: explicit waive, OR any-rodent-service opt-in (legacy),
  // OR approved-total over the waiver threshold.
  const inspectionWaived =
    waiveInspection ||
    hasServiceOptIn ||
    (approvedTotalForWaiver >= ins.waiveIfApprovedTotalOver);
  const insp = inspectionWaived ? 0 : ins.fee;

  const total = subtotalWithUrgency + insp;

  let tier = 'Basic';
  if (advanced > 0) tier = 'Advanced (Roof)';
  else if (moderate > 0) tier = 'Moderate';
  if (specialty > 0) tier += ' + Specialty';

  const inspectDetail = insp > 0
    ? ` + $${insp} inspect`
    : (inspectionWaived ? ' (inspect waived)' : '');

  return {
    service: 'exclusion',
    name: 'Rodent Exclusion',
    price: total,
    detail: `${tier} — ${simple + moderate + advanced + specialty} points${inspectDetail}`,
    points: { simple, moderate, advanced, specialty },
    subtotalBeforeMin: Math.round(rawSubtotal),
    minimumFloor,
    inspectionFee: insp,
    inspectionWaived,
    tier,
    storyMult,
    roofMult,
    constructionMult,
    customRecommended: !!minBracket.customRecommended,
  };
}

// ============================================================
// RODENT EXCLUSION V2 (unified mesh-point + bird-box + linear-mesh)
// ============================================================
// Replaces legacy simple/moderate/advanced model and the separate
// rodentWireMesh / rodentBirdBoxes line items with a single unified
// calculation. Per-item difficulty is captured at input time — no
// blanket tile/roof multiplier applied to the whole property.
function priceRodentExclusionV2(options = {}) {
  const {
    standardWireMeshPoints = 0,
    advancedWireMeshPoints = 0,
    standardBirdBoxes = 0,
    tileHighBirdBoxes = 0,
    customBirdBoxes = 0,
    meshSoftLF = 0,
    meshConcreteLF = 0,
    waiveInspection = false,
    hasServiceOptIn = false,
    approvedTotalForWaiver = 0,
    urgency = 'ROUTINE',
    afterHours = false,
  } = options;

  const cfg = RODENT.exclusionV2;
  const ins = RODENT.inspection || { fee: cfg.inspectionFee, waiveIfApprovedTotalOver: 995 };

  const stdPts = Math.max(0, Number(standardWireMeshPoints) || 0);
  const advPts = Math.max(0, Number(advancedWireMeshPoints) || 0);
  const stdBoxes = Math.max(0, Number(standardBirdBoxes) || 0);
  const tileBoxes = Math.max(0, Number(tileHighBirdBoxes) || 0);
  const custBoxes = Math.max(0, Number(customBirdBoxes) || 0);
  const softLF = Math.max(0, Number(meshSoftLF) || 0);
  const hardLF = Math.max(0, Number(meshConcreteLF) || 0);

  const wireMeshPointSubtotal =
    stdPts * cfg.wireMeshPoints.standard +
    advPts * cfg.wireMeshPoints.advancedRoofHigh;

  const birdBoxSubtotal =
    stdBoxes * cfg.birdBoxes.standard +
    tileBoxes * cfg.birdBoxes.tileHighAccess +
    custBoxes * cfg.birdBoxes.customOversized;

  const linearMeshSubtotal =
    softLF * cfg.linearMesh.softRatePerLF +
    hardLF * cfg.linearMesh.hardRatePerLF;

  const totalLinearMeshLF = softLF + hardLF;

  const rawInstall =
    wireMeshPointSubtotal +
    birdBoxSubtotal +
    linearMeshSubtotal;

  const floor = totalLinearMeshLF > 0
    ? cfg.floors.includesLinearMesh
    : cfg.floors.pointOnly;

  const installPrice = Math.max(floor, Math.round(rawInstall));
  const installWithUrgency = applyUrgency(installPrice, urgency, afterHours);

  const inspectionWaived =
    waiveInspection ||
    hasServiceOptIn ||
    (approvedTotalForWaiver >= ins.waiveIfApprovedTotalOver);
  const inspectionFee = inspectionWaived ? 0 : ins.fee;

  const total = installWithUrgency + inspectionFee;

  const w = cfg.equivalentPointWeights;
  const equivalentExclusionPoints =
    stdPts * w.standardWireMeshPoint +
    advPts * w.advancedWireMeshPoint +
    stdBoxes * w.standardBirdBox +
    tileBoxes * w.tileHighBirdBox +
    custBoxes * w.customBirdBox +
    Math.ceil(totalLinearMeshLF / w.linearMeshLFPer);

  const totalItems = stdPts + advPts + stdBoxes + tileBoxes + custBoxes;

  const parts = [];
  if (stdPts + advPts > 0)
    parts.push(`${stdPts + advPts} wire-mesh point${stdPts + advPts !== 1 ? 's' : ''}`);
  if (stdBoxes + tileBoxes + custBoxes > 0)
    parts.push(`${stdBoxes + tileBoxes + custBoxes} bird-box exclusion${stdBoxes + tileBoxes + custBoxes !== 1 ? 's' : ''}`);
  if (totalLinearMeshLF > 0)
    parts.push(`${totalLinearMeshLF} LF mesh`);
  const inspectDetail = inspectionFee > 0
    ? ` + $${inspectionFee} inspect`
    : (inspectionWaived ? ' (inspect waived)' : '');
  const detail = parts.length > 0
    ? `${parts.join(', ')}${inspectDetail}`
    : `Rodent Exclusion${inspectDetail}`;

  return {
    service: 'rodent_exclusion',
    name: 'Rodent Exclusion',
    pricingVersion: 'RODENT_EXCLUSION_V2_MESH_BIRD_BOX',
    price: total,
    detail,

    quantities: {
      standardWireMeshPoints: stdPts,
      advancedWireMeshPoints: advPts,
      standardBirdBoxes: stdBoxes,
      tileHighBirdBoxes: tileBoxes,
      customBirdBoxes: custBoxes,
      meshSoftLF: softLF,
      meshConcreteLF: hardLF,
      totalLinearMeshLF,
    },

    subtotals: {
      wireMeshPointSubtotal,
      birdBoxSubtotal,
      linearMeshSubtotal,
      rawInstall,
    },

    floor,
    floorApplied: installPrice > rawInstall,
    inspectionFee,
    inspectionWaived,
    installPrice: installWithUrgency,
    total,

    equivalentExclusionPoints,
    warrantyEligible: true,
    exclusionCompleted: total > 0,
  };
}

// ============================================================
// RODENT INSPECTION (standalone diagnostic visit)
// ============================================================
// Creditable toward exclusion or full remediation when approved within 14
// days. Used when a customer wants a paid inspection without committing to
// remediation work upfront.
function priceRodentInspection() {
  const ins = RODENT.inspection;
  return {
    service: 'rodent_inspection',
    name: 'Rodent Inspection',
    price: ins.fee,
    creditableWithinDays: ins.creditableWithinDays,
    detail: `$${ins.fee} inspection (creditable for ${ins.creditableWithinDays} days toward remediation work)`,
  };
}

// ============================================================
// RODENT GUARANTEE (gated, 3 tiers by complexity)
// ============================================================
// Eligibility: trap + exclusion + (sanitation OR photo baseline) + no
// activity after final trap check. Caller passes the eligibility flags
// and home-complexity facts; we determine tier and price.
function priceRodentGuarantee(options = {}) {
  const {
    homeSqFt = 2000,
    stories = 1,
    roofType = 'shingle',
    sealedPoints = 0,
    equivalentExclusionPoints = null,
    totalLinearMeshLF = 0,
    eligibility = {},
  } = options;

  const cfg = RODENT.guarantee;

  // Eligibility check — caller signals each flag; missing = not eligible
  const required = cfg.eligibilityRequires;
  const missing = required.filter(flag => !eligibility[flag]);
  const eligible = missing.length === 0;

  // V2 callers pass equivalentExclusionPoints (weighted: bird boxes count
  // heavier); V1 callers pass raw sealedPoints. Use whichever is available.
  const effectivePoints = Number(equivalentExclusionPoints ?? sealedPoints) || 0;
  const meshLF = Number(totalLinearMeshLF) || 0;
  const storiesNum = Number(stories) || 1;
  const homeSqFtNum = Number(homeSqFt) || 0;

  let tier = 'standard';
  if (homeSqFtNum > 4000 || effectivePoints > 15 || meshLF > 150) {
    tier = 'estate';
  } else if (
    homeSqFtNum > 2500 ||
    storiesNum >= 2 ||
    roofType === 'tile' ||
    effectivePoints >= 9 ||
    (meshLF > 75 && meshLF <= 150)
  ) {
    tier = 'complex';
  }

  const price = cfg[tier];

  return {
    service: 'rodent_guarantee',
    name: `Rodent Guarantee (${tier})`,
    price,
    tier,
    eligible,
    eligibilityMissing: missing,
    effectivePoints,
    detail: eligible
      ? `$${price}/yr — 12-month re-entry warranty (${tier} tier)`
      : `INELIGIBLE — missing: ${missing.join(', ')}`,
  };
}

// ============================================================
// SPEC FUNCTIONS — Missing services pricing spec (April 2026)
// Distinct from legacy pest/lawn pricers above. Spec doc:
// ~/Downloads/missing-services-pricing-spec.md
// ============================================================

function _applyMargin(cost, targetMargin) {
  return cost / (1 - targetMargin);
}
function _round5(price) {
  return Math.round(price / 5) * 5;
}

// 1. Rodent Plugging (entry-point sealing)
function calculatePluggingPrice(config = {}) {
  const {
    entryPoints = 0,
    materialType = 'caulkSealant',
    isStandalone = true,
    accessDifficulty = 'standard',
  } = config;
  const MATERIAL_COSTS = { copperMesh: 0.85, steelWool: 0.40, xcluder: 1.50, caulkSealant: 0.30 };
  const MINUTES_PER_POINT = { standard: 3, difficult: 5 };
  const TRIP_CHARGE = isStandalone ? 45.00 : 0;
  const materialCost = entryPoints * (MATERIAL_COSTS[materialType] ?? 1.00);
  const laborMinutes = entryPoints * (MINUTES_PER_POINT[accessDifficulty] ?? 3);
  const laborCost = (laborMinutes / 60) * GLOBAL.LABOR_RATE;
  const MINIMUM_PRICE = isStandalone ? 95 : 45;
  const totalCost = materialCost + laborCost + TRIP_CHARGE;
  const price = Math.max(MINIMUM_PRICE, _applyMargin(totalCost, 0.65));
  return {
    service: 'rodent_plugging',
    name: 'Rodent Entry-Point Plugging',
    price: _round5(price),
    detail: `${entryPoints} pt${entryPoints === 1 ? '' : 's'} | ${materialType}${isStandalone ? ' | standalone' : ' | add-on'}`,
    materialCost: Math.round(materialCost * 100) / 100,
    laborCost: Math.round(laborCost * 100) / 100,
    tripCharge: TRIP_CHARGE,
    upsellExclusion: entryPoints >= 16,
  };
}

// 2. Termite Foam (Termidor Foam spot treatment)
function calculateFoamPrice(config = {}) {
  const {
    applicationPoints = 0,
    cansEstimated,
    isAddOnToLiquid = false,
    accessType = 'accessible',
  } = config;
  const FOAM_COST_PER_CAN = 30.00;
  const cans = cansEstimated || Math.max(1, Math.ceil(applicationPoints / 10));
  const materialCost = cans * FOAM_COST_PER_CAN;
  const MINUTES_PER_POINT = { accessible: 2, drillRequired: 4 };
  const laborMinutes = applicationPoints * (MINUTES_PER_POINT[accessType] ?? 2);
  const laborCost = (laborMinutes / 60) * GLOBAL.LABOR_RATE;
  const setupLabor = (10 / 60) * GLOBAL.LABOR_RATE;
  const BUNDLE_DISCOUNT = isAddOnToLiquid ? 0.15 : 0;
  const totalCost = materialCost + laborCost + setupLabor;
  const preDiscountPrice = _applyMargin(totalCost, 0.62);
  const price = preDiscountPrice * (1 - BUNDLE_DISCOUNT);
  // Owner directive 2026-06-25: foam minimum removed for all foam (mirrors foamDrill.floor 0);
  // true tiered cost/margin flows through. Clamp kept only to prevent a negative price.
  const MINIMUM_PRICE = 0;
  return {
    service: 'termite_foam',
    name: 'Termidor Foam Spot Treatment',
    price: Math.max(MINIMUM_PRICE, _round5(price)),
    detail: `${applicationPoints} pt${applicationPoints === 1 ? '' : 's'} | ${cans} can${cans === 1 ? '' : 's'}${isAddOnToLiquid ? ' | bundled (-15%)' : ''}`,
    materialCost: Math.round(materialCost * 100) / 100,
    laborCost: Math.round((laborCost + setupLabor) * 100) / 100,
    cansUsed: cans,
    bundleDiscount: BUNDLE_DISCOUNT > 0,
  };
}

// 3. Stinging Insect (multiplier-stack spec version)
function calculateStingingPrice(config = {}) {
  const {
    nestCount = 1,
    nestType = 'wasp',
    location = 'eave',
    isUrgent = false,
    isAfterHours = false,
  } = config;
  const NEST_TYPE_MULTIPLIER = { mudDauber: 1.0, wasp: 1.2, hornet: 1.5, yellowJacket: 1.8 };
  const LOCATION_MULTIPLIER = { ground: 1.0, eave: 1.1, tree: 1.2, wall: 1.4, attic: 1.5, high: 1.6 };
  const BASE_MATERIAL_PER_NEST = 12.00;
  const laborMinutes = 15 + (Math.max(0, nestCount - 1) * 8);
  const laborCost = (laborMinutes / 60) * GLOBAL.LABOR_RATE;
  const materialCost = nestCount * BASE_MATERIAL_PER_NEST;
  const typeMult = NEST_TYPE_MULTIPLIER[nestType] ?? 1.2;
  const locationMult = LOCATION_MULTIPLIER[location] ?? 1.0;
  const URGENT_SURCHARGE = isUrgent ? 1.25 : 1.0;
  const AFTER_HOURS_SURCHARGE = isAfterHours ? 1.50 : 1.0;
  const baseCost = materialCost + laborCost;
  const adjustedCost = baseCost * typeMult * locationMult;
  const preMarginPrice = _applyMargin(adjustedCost, 0.68);
  const price = preMarginPrice * URGENT_SURCHARGE * AFTER_HOURS_SURCHARGE;
  const MIN = isAfterHours ? 175 : isUrgent ? 125 : 95;
  return {
    service: 'stinging_insect_v2',
    name: `Stinging Insect — ${nestType}`,
    price: Math.max(MIN, _round5(price)),
    detail: `${nestCount} nest${nestCount === 1 ? '' : 's'} | ${nestType} | ${location}${isUrgent ? ' | urgent' : ''}${isAfterHours ? ' | after-hours' : ''}`,
    materialCost: Math.round(materialCost * 100) / 100,
    laborCost: Math.round(laborCost * 100) / 100,
    nestCount, nestType,
    surcharges: { urgent: isUrgent, afterHours: isAfterHours },
    riskLevel: typeMult >= 1.5 ? 'high' : 'moderate',
  };
}

// 4. Exclusion V2 (sqft-tiered, roof/construction-aware)
function calculateExclusionPrice(config = {}) {
  const {
    sqft = 0,
    stories = 1,
    roofType = 'shingle',
    entryPointsFound,
    includesScreening = false,
    constructionType = 'stucco',
  } = config;
  const estimatedPoints = entryPointsFound || (Math.ceil(sqft / 200) + (stories > 1 ? 8 : 0));
  const BLENDED_MATERIAL_PER_POINT = 3.50;
  const materialCost = estimatedPoints * BLENDED_MATERIAL_PER_POINT;
  const screeningCost = includesScreening ? (sqft * 0.015) + 45 : 0;
  const ROOF_MULTIPLIER = { shingle: 1.0, flat: 1.0, metal: 1.2, tile: 1.4 };
  const baseMinutesPerPoint = 5;
  const roofMult = ROOF_MULTIPLIER[roofType] ?? 1.0;
  const storyMult = stories > 1 ? 1.3 : 1.0;
  const laborMinutes = (estimatedPoints * baseMinutesPerPoint * roofMult * storyMult)
    + 30 + (includesScreening ? 45 : 0);
  const laborCost = (laborMinutes / 60) * GLOBAL.LABOR_RATE;
  const CONSTRUCTION_MULT = { block: 1.0, stucco: 1.1, frame: 1.2 };
  const constructionMult = CONSTRUCTION_MULT[constructionType] ?? 1.1;
  const totalCost = (materialCost + screeningCost + laborCost) * constructionMult;
  const price = _applyMargin(totalCost, 0.60);
  const MIN_BY_TIER = { small: 395, medium: 595, large: 895, xlarge: 1295 };
  const tier = sqft < 1500 ? 'small' : sqft < 2500 ? 'medium' : sqft < 4000 ? 'large' : 'xlarge';
  return {
    service: 'exclusion_v2',
    name: 'Full Rodent Exclusion',
    price: Math.max(MIN_BY_TIER[tier], _round5(price)),
    detail: `${tier} (${sqft} sf) | ${estimatedPoints} pts | ${roofType} roof, ${stories}-story${includesScreening ? ' | +screening' : ''}`,
    materialCost: Math.round((materialCost + screeningCost) * 100) / 100,
    laborCost: Math.round(laborCost * 100) / 100,
    estimatedPoints, tier,
    estimatedHours: Math.round(laborMinutes / 60 * 10) / 10,
    multiVisit: laborMinutes > 240,
  };
}

// 5. Rodent Guarantee Combo (Exclusion + Bait Stations + guarantee premium)
function calculateRodentGuaranteeCombo(config = {}) {
  const {
    sqft = 0, stories = 1, roofType = 'shingle', entryPointsFound,
    includesScreening = false, constructionType = 'stucco',
    baitStationTier = 'enhanced',
    stationCount,
    guaranteeTerm = 12,
  } = config;

  const exclusion = calculateExclusionPrice({
    sqft, stories, roofType, entryPointsFound, includesScreening, constructionType,
  });

  // Reuse legacy bait-station pricer (monthly) → quarterly.
  // Auto-flag postExclusion: combo context = sealed structure, lighter scope.
  const stations = stationCount || (Math.ceil(sqft / 500) + 2);
  const bait = priceRodentBait(
    { footprint: sqft, lawnSqFt: 0, lotSqFt: sqft, features: {}, roofType },
    { postExclusion: true }
  );
  const baitQuarterly = (bait.monthly || 0) * 3;

  const GUARANTEE_PREMIUM = { 12: 0.15, 24: 0.25 };
  const term = GUARANTEE_PREMIUM[guaranteeTerm] ? guaranteeTerm : 12;
  const guaranteePremiumRate = GUARANTEE_PREMIUM[term];
  const baitTotal = baitQuarterly * (term === 24 ? 8 : 4);
  const componentTotal = exclusion.price + baitTotal;
  const bundleDiscount = 0;
  const guaranteeSurcharge = componentTotal * guaranteePremiumRate;
  const totalPackagePrice = componentTotal + guaranteeSurcharge;

  const MINIMUM_COMBO = { 12: 695, 24: 995 };
  const finalPrice = Math.max(MINIMUM_COMBO[term], _round5(totalPackagePrice));
  const upfrontRevenue = exclusion.price + guaranteeSurcharge;

  return {
    service: 'rodent_guarantee_combo',
    name: `Rodent Guarantee Combo (${term} mo)`,
    price: finalPrice,
    detail: `Exclusion + ${stations} bait stations + ${term}-mo guarantee`,
    breakdown: {
      exclusionPrice: exclusion.price,
      baitStationQuarterly: baitQuarterly,
      baitStationTotal: baitTotal,
      bundleDiscount,
      baitExcludedFromBundleDiscount: true,
      guaranteePremium: guaranteePremiumRate,
      guaranteeSurcharge: _round5(guaranteeSurcharge),
    },
    guaranteeTerm: term,
    stationCount: stations,
    exclusionDetails: {
      estimatedPoints: exclusion.estimatedPoints,
      estimatedHours: exclusion.estimatedHours,
      multiVisit: exclusion.multiVisit,
    },
    upfrontRevenue: _round5(upfrontRevenue),
    recurringRevenue: baitQuarterly,
  };
}

// ============================================================
// RODENT BUNDLE DISCOUNTS (combo selector)
// ============================================================
// Given the priced components present in the estimate, returns the
// discount factor and floor that should apply, plus the bundle name.
// Returns null when no bundle qualifies.
function selectRodentBundle({ hasTrapping, hasExclusion, hasSanitation, sanitationTier }) {
  const cfg = RODENT.bundles;
  if (hasTrapping && hasExclusion && hasSanitation) {
    const tier = RODENT.sanitation.legacyAliases?.[sanitationTier] || sanitationTier || 'standard';
    const floor = cfg.fullRemediation.floors[tier] || cfg.fullRemediation.floors.standard;
    return { kind: 'fullRemediation', discount: cfg.fullRemediation.discount, floor };
  }
  if (hasTrapping && hasExclusion) {
    return { kind: 'trapExclusion', discount: cfg.trapExclusion.discount, floor: cfg.trapExclusion.floor };
  }
  if (hasTrapping && hasSanitation) {
    return { kind: 'trapSanitation', discount: cfg.trapSanitation.discount, floor: cfg.trapSanitation.floor };
  }
  return null;
}

function applyRodentBundle(componentTotal, bundle) {
  if (!bundle) return { discounted: componentTotal, savings: 0 };
  const discounted = componentTotal * (1 - bundle.discount);
  const floored = Math.max(bundle.floor, Math.round(discounted / 10) * 10);
  const finalTotal = Math.min(componentTotal, floored);
  return {
    discounted: finalTotal,
    savings: Math.max(0, Math.round(componentTotal - finalTotal)),
  };
}

module.exports = {
  pricePestControl, pricePestInitialRoach, priceLawnCare, priceTreeShrub,
  priceCommercialLawn, priceCommercialTreeShrub, priceCommercialPest,
  priceCommercialMosquito, priceCommercialTermiteBait, priceCommercialRodentBait, pricePalmInjection,
  priceMosquito, priceTermiteBait, priceRodentBait, priceRodentTrapping,
  priceRodentTrappingFollowups, priceSanitation, priceBaitSetup,
  priceRodentInspection, priceTrapOnlyRetainer, priceRodentWireMesh,
  estimateRodentWireMeshLinearFeet, priceRodentBirdBoxes,
  selectRodentBundle, applyRodentBundle,
  priceOneTimePest, priceOneTimeLawn, priceOneTimeMosquito,
  priceTrenching, priceBoraCare, pricePreSlabTermiticide, pricePreSlabTermidor,
  priceGermanRoach, priceGermanRoachInitial, priceBedBug, priceBedBugTreatment, priceWDO, priceFlea, priceFleaExterior,
  priceTopDressing, priceDethatching,
  pricePlugging, priceFoamDrill, priceRecurringFoam, priceWasp, priceStingingInsect, priceExclusion, priceRodentExclusionV2, priceRodentGuarantee,
  // Spec functions (Apr 2026)
  calculatePluggingPrice, calculateFoamPrice, calculateStingingPrice,
  calculateExclusionPrice, calculateRodentGuaranteeCombo,
  interpolate, laborCost,
  getOneTimeUrgencyMultiplier, applyOneTimeRecurringCustomerDiscount,
  applyOneTimeFloor, getOneTimeMosquitoAreaBucket, getOneTimeMosquitoBase,
  normalizeMosquitoProgramKey, normalizeMosquitoWaterMultiplier,
  normalizeGrassType, calcLawnAnnualCostFloor,
  recommendTreeShrubTier,
  evaluateTreeShrubTierRecommendation,
  resolveTreeShrubBedArea,
  resolvePestFootprint,
  parsePositiveMeasurement,
  resolveTermiteFootprint,
  resolveTermiteBaitPerimeter,
  resolveTrenchingMeasurements,
  resolvePalmCount,
  normalizeTrenchingTermiticideProduct,
  normalizeTrenchingApplicationRate,
  resolveBoraCareSqFt,
  resolvePreSlabSqFt,
  normalizePreSlabTermiticideProduct,
  normalizePestFrequency,
  normalizePestPricingVersion,
  normalizeRoachType,
  normalizeRoachSeverity,
  normalizePestDensity,
  normalizePestComplexity,
  normalizePestPropertyType,
  TS_PREMIUM_DEPRECATED_WARNING_CODE,
  TS_ENHANCED_DEPRECATED_WARNING_CODE,
};
