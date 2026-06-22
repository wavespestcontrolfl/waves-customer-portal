// ============================================================
// db-bridge.js — Syncs admin-editable pricing constants from DB
// Reads pricing_config table (JSONB) and applies to engine constants
// Called on server startup; re-syncs every 60s on next estimate
// ============================================================
const constants = require('./constants');
const r = (val) => Math.round(val * constants.PROCESSING_ADJUSTMENT);
const money = (val) => Math.round(Number(val) * constants.PROCESSING_ADJUSTMENT * 100) / 100;

function readFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function setNumber(target, key, value, transform = Number) {
  const parsed = readFiniteNumber(value);
  if (parsed !== undefined) target[key] = transform(parsed);
}

function setBoolean(target, key, value) {
  if (typeof value === 'boolean') target[key] = value;
}

function setString(target, key, value) {
  if (typeof value === 'string' && value.trim()) target[key] = value.trim();
}

function setStringArray(target, key, value) {
  if (!Array.isArray(value)) return;
  const strings = value.map(v => String(v).trim()).filter(Boolean);
  if (strings.length) target[key] = strings;
}

function mergePlainObject(target, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  Object.assign(target, value);
}

function deepMergePlainObject(target, value) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      target[key] &&
      child &&
      typeof target[key] === 'object' &&
      typeof child === 'object' &&
      !Array.isArray(target[key]) &&
      !Array.isArray(child)
    ) {
      deepMergePlainObject(target[key], child);
    } else {
      target[key] = child;
    }
  }
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function isPositiveNumber(value) {
  return isFiniteNumber(value) && Number(value) > 0;
}

function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && Number(value) >= 0;
}

function isTerminalInfinity(value) {
  return value === Infinity || value === 'Infinity';
}

function validateSortedBrackets(errors, name, rows, key, valueKey, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push(`${name} must contain at least one bracket`);
    return;
  }
  let previous = -Infinity;
  rows.forEach((row, index) => {
    const rawBound = row?.[key];
    const bound = rawBound === Infinity || rawBound === 'Infinity' || rawBound === null
      ? Infinity
      : Number(rawBound);
    if (!(Number.isFinite(bound) || (options.allowTerminalInfinity && bound === Infinity))) {
      errors.push(`${name}[${index}].${key} must be finite${options.allowTerminalInfinity ? ' or terminal Infinity' : ''}`);
    }
    if (bound < previous) errors.push(`${name} must be sorted ascending`);
    previous = bound;
    if (!isFiniteNumber(row?.[valueKey])) errors.push(`${name}[${index}].${valueKey} must be finite`);
  });
  if (options.requireTerminalInfinity) {
    const last = rows[rows.length - 1]?.[key];
    if (!(last === Infinity || last === 'Infinity' || last === null)) {
      errors.push(`${name} must end with Infinity`);
    }
  }
}

function requirePalmTierSizes(errors, treatment, name) {
  const sizes = new Set((treatment?.tiers || []).map(t => t.size));
  for (const size of ['small', 'medium', 'large']) {
    if (!sizes.has(size)) errors.push(`PALM.treatments.${name}.tiers must include ${size}`);
  }
}

function validatePestPricingConfig(snapshot = constants) {
  const errors = [];
  const { PEST, PROPERTY_TYPE_ADJ, ONE_TIME, SPECIALTY, BED_BUG, TERMITE, MOSQUITO, PALM, WAVEGUARD } = snapshot;

  if (!isPositiveNumber(PEST.base)) errors.push('PEST.base must be positive');
  if (!isPositiveNumber(PEST.floor)) errors.push('PEST.floor must be positive');
  // NOTE: floor > base is intentionally allowed. The price is
  // `max(floor, base + adjustments)`, so a floor above base just raises the
  // minimum quote for small/low-adjustment properties while larger/adjusted
  // homes still exceed it — a valid "raise the minimum" config, not an error.
  if (!isNonNegativeNumber(PEST.initialFee)) errors.push('PEST.initialFee must be non-negative');
  validateSortedBrackets(errors, 'PEST.footprintBrackets', PEST.footprintBrackets, 'sqft', 'adj');

  for (const [key, value] of Object.entries(PEST.additionalAdjustments || {})) {
    if (!isFiniteNumber(value)) errors.push(`PEST.additionalAdjustments.${key} must be finite`);
  }
  if (!Object.prototype.hasOwnProperty.call(PEST.additionalAdjustments || {}, 'attachedGarage')) {
    errors.push('PEST.additionalAdjustments.attachedGarage is required');
  }
  for (const [key, value] of Object.entries(PROPERTY_TYPE_ADJ || {})) {
    if (!isFiniteNumber(value)) errors.push(`PROPERTY_TYPE_ADJ.${key} must be finite`);
  }
  for (const version of ['v1', 'v2']) {
    for (const frequency of ['quarterly', 'bimonthly', 'monthly']) {
      const mult = PEST.frequencyDiscounts?.[version]?.[frequency];
      if (!isFiniteNumber(mult)) {
        errors.push(`PEST.frequencyDiscounts.${version}.${frequency} is required`);
      } else if (!(Number(mult) > 0 && Number(mult) <= 1)) {
        // Per-visit multipliers must be in (0, 1] — quarterly is the 1.0
        // reference; deeper cadences discount per visit. A value >1, 0, or
        // negative would over/under-price or invert the price.
        errors.push(`PEST.frequencyDiscounts.${version}.${frequency} must be in (0, 1]`);
      }
    }
  }
  for (const frequency of ['quarterly', 'bimonthly', 'monthly']) {
    if (!isPositiveNumber(PEST.frequencies?.[frequency])) errors.push(`PEST.frequencies.${frequency} must be positive`);
  }
  for (const type of ['german', 'regular', 'none']) {
    if (!isFiniteNumber(PEST.roachModifier?.[type])) errors.push(`PEST.roachModifier.${type} must be finite`);
  }
  for (const scale of ['regular', 'german', 'regular_standalone']) {
    validateSortedBrackets(errors, `PEST.pestInitialRoach.${scale}`, PEST.pestInitialRoach?.[scale], 'sqft', 'price', {
      allowTerminalInfinity: true,
      requireTerminalInfinity: true,
    });
  }
  const diag = PEST.productionDiagnostics || {};
  for (const key of ['baseStopMinutes', 'manualReviewLotSqFt', 'lowConfidenceLotSqFt', 'manualReviewMinutes', 'lowConfidenceMinutes']) {
    if (!isPositiveNumber(diag[key])) errors.push(`PEST.productionDiagnostics.${key} must be positive`);
  }

  // one-time = max(otFloor, quarterlyPerApp × multiplier).
  if (!isPositiveNumber(ONE_TIME.pest?.multiplier)) errors.push('ONE_TIME.pest.multiplier must be positive');
  if (!isPositiveNumber(ONE_TIME.pest?.floor)) errors.push('ONE_TIME.pest.floor must be positive');
  // Combined incentive invariant: one-time must stay STRICTLY ABOVE a recurring
  // customer's visit-1 cost (PEST.floor quarterly + PEST.initialFee setup) for
  // every property — otherwise a one-off visit is no more expensive than
  // committing, and the incentive collapses. Both `multiplier` and `floor` are
  // admin-editable, so validate them together. Checked over the SAME dollar
  // rounding the pricer uses (`max(otFloor, round(q × multiplier))`), because a
  // near-boundary config can pass the unrounded math yet round down to a tie.
  // The minimum gap sits around the floor↔multiple transition (q* = otFloor /
  // multiplier); the floor regime decreases toward it and the multiple regime
  // increases away from it, so scanning [PEST.floor, ceil(q*)+2] covers the
  // whole reachable range — large quarterly bases only widen the gap.
  const otMult = Number(ONE_TIME.pest?.multiplier);
  const otFloor = Number(ONE_TIME.pest?.floor);
  if (isPositiveNumber(otMult) && isPositiveNumber(otFloor) && isPositiveNumber(PEST.floor) && isNonNegativeNumber(PEST.initialFee)) {
    const qMin = Math.floor(Number(PEST.floor));
    const qMax = Math.ceil(Math.max(Number(PEST.floor), otFloor / otMult)) + 2;
    const setup = Number(PEST.initialFee);
    let incentiveViolated = false;
    for (let q = qMin; q <= qMax; q++) {
      const oneTime = Math.max(otFloor, Math.round(q * otMult));
      if (!(oneTime > q + setup)) { incentiveViolated = true; break; }
    }
    if (incentiveViolated) {
      errors.push('ONE_TIME.pest floor/multiplier too low: one-time (after dollar rounding) must stay strictly above recurring visit-1 (PEST.floor + PEST.initialFee) for every property');
    }
  }

  const mosquitoCategories = Array.isArray(MOSQUITO.lotCategories) ? MOSQUITO.lotCategories : [];
  const mosquitoPrograms = Array.isArray(MOSQUITO.programs) ? MOSQUITO.programs : ['seasonal9', 'monthly12'];
  if (!mosquitoCategories.length) errors.push('MOSQUITO.lotCategories is required');
  let previousMosquitoMax = -Infinity;
  for (const [index, category] of mosquitoCategories.entries()) {
    if (!category?.key) errors.push(`MOSQUITO.lotCategories[${index}].key is required`);
    const maxSqFt = category?.maxSqFt;
    const normalizedMax = maxSqFt === Infinity || maxSqFt === 'Infinity' || maxSqFt === null
      ? Infinity
      : Number(maxSqFt);
    if (!(Number.isFinite(normalizedMax) || normalizedMax === Infinity)) {
      errors.push(`MOSQUITO.lotCategories[${index}].maxSqFt must be finite or Infinity`);
    }
    if (normalizedMax < previousMosquitoMax) errors.push('MOSQUITO.lotCategories must be sorted ascending');
    previousMosquitoMax = normalizedMax;
    const prices = MOSQUITO.basePrices?.[category?.key];
    if (!Array.isArray(prices) || prices.length < mosquitoPrograms.length) {
      errors.push(`MOSQUITO.basePrices.${category?.key} must include all programs`);
    } else {
      mosquitoPrograms.forEach((program, programIndex) => {
        if (!isPositiveNumber(prices[programIndex])) {
          errors.push(`MOSQUITO.basePrices.${category.key}.${program} must be positive`);
        }
      });
    }
  }
  for (const program of ['seasonal9', 'monthly12']) {
    if (!isPositiveNumber(MOSQUITO.tierVisits?.[program])) {
      errors.push(`MOSQUITO.tierVisits.${program} must be positive`);
    }
  }
  for (const [key, addOn] of Object.entries(MOSQUITO.addOns || {})) {
    if (!isNonNegativeNumber(addOn?.price)) errors.push(`MOSQUITO.addOns.${key}.price must be non-negative`);
    if (!isNonNegativeNumber(addOn?.cost)) errors.push(`MOSQUITO.addOns.${key}.cost must be non-negative`);
  }
  for (const [key, value] of Object.entries(MOSQUITO.pressureFactors || {})) {
    if (!isFiniteNumber(value)) errors.push(`MOSQUITO.pressureFactors.${key} must be finite`);
  }
  if (!isPositiveNumber(MOSQUITO.pressureCap)) errors.push('MOSQUITO.pressureCap must be positive');

  const onetimeMosquito = ONE_TIME.mosquito || {};
  for (const bucket of ['SMALL', 'STANDARD', 'LARGE', 'XL', 'ESTATE', 'ACRE_CLASS', 'OVER_ACRE']) {
    if (!isPositiveNumber(onetimeMosquito[bucket])) errors.push(`ONE_TIME.mosquito.${bucket} must be positive`);
  }
  if (!isPositiveNumber(onetimeMosquito.overAcreIncrementSqFt)) {
    errors.push('ONE_TIME.mosquito.overAcreIncrementSqFt must be positive');
  }
  if (!isPositiveNumber(onetimeMosquito.overAcreIncrementPrice)) {
    errors.push('ONE_TIME.mosquito.overAcreIncrementPrice must be positive');
  }
  if (!isNonNegativeNumber(onetimeMosquito.stationAddOn)) errors.push('ONE_TIME.mosquito.stationAddOn must be non-negative');
  if (!isNonNegativeNumber(onetimeMosquito.dunkAddOn)) errors.push('ONE_TIME.mosquito.dunkAddOn must be non-negative');

  const germanRoach = SPECIALTY.germanRoach || {};
  const germanRoachTiers = germanRoach.tiers || {};
  if (!germanRoach.defaultSeverity || !germanRoachTiers[germanRoach.defaultSeverity]) {
    errors.push('SPECIALTY.germanRoach.defaultSeverity must reference an existing tier');
  }
  ['light', 'moderate', 'heavy'].forEach((tierKey) => {
    const tier = germanRoachTiers[tierKey];
    if (!tier || !isPositiveNumber(tier.price)) {
      errors.push(`SPECIALTY.germanRoach.tiers.${tierKey}.price must be positive`);
    }
    if (!tier || !isPositiveNumber(tier.visits)) {
      errors.push(`SPECIALTY.germanRoach.tiers.${tierKey}.visits must be positive`);
    }
  });

  if (!Array.isArray(BED_BUG.allowedMethods) || !BED_BUG.allowedMethods.includes('HYBRID')) {
    errors.push('BED_BUG.allowedMethods must include HYBRID');
  }
  if (BED_BUG.recurringDiscountEligible !== false || Number(BED_BUG.maxRecurringDiscountPct) !== 0) {
    errors.push('BED_BUG must remain excluded from recurring discounts');
  }

  const flea = SPECIALTY.flea || {};
  if (!isPositiveNumber(flea.initial?.base) || !isPositiveNumber(flea.initial?.floor)) {
    errors.push('SPECIALTY.flea.initial base/floor must be positive');
  }
  if (!isPositiveNumber(flea.followUp?.base) || !isPositiveNumber(flea.followUp?.floor)) {
    errors.push('SPECIALTY.flea.followUp base/floor must be positive');
  }
  validateSortedBrackets(errors, 'SPECIALTY.flea.exterior.tiers', flea.exterior?.tiers, 'max', 'initial');

  const wasp = SPECIALTY.wasp || {};
  if (!Array.isArray(wasp.tiers) || wasp.tiers.some(v => !isPositiveNumber(v))) {
    errors.push('SPECIALTY.wasp.tiers must be positive');
  }
  for (const [key, value] of Object.entries(wasp.removal || {})) {
    if (!isNonNegativeNumber(value)) errors.push(`SPECIALTY.wasp.removal.${key} must be non-negative`);
  }

  validateSortedBrackets(errors, 'SPECIALTY.wdo.brackets', SPECIALTY.wdo?.brackets, 'maxSqFt', 'price', {
    allowTerminalInfinity: true,
    requireTerminalInfinity: true,
  });

  const exclusion = SPECIALTY.exclusion || {};
  for (const [key, value] of Object.entries(exclusion.perPoint || {})) {
    if (!isPositiveNumber(value)) errors.push(`SPECIALTY.exclusion.perPoint.${key} must be positive`);
  }

  if (!isPositiveNumber(TERMITE.stationSpacing)) errors.push('TERMITE.stationSpacing must be positive');
  if (!isPositiveNumber(TERMITE.minStations)) errors.push('TERMITE.minStations must be positive');
  if (!isPositiveNumber(TERMITE.installMultiplier)) errors.push('TERMITE.installMultiplier must be positive');
  for (const system of ['advance', 'trelona']) {
    for (const key of ['stationCost', 'laborMaterial', 'misc']) {
      if (!isNonNegativeNumber(TERMITE.systems?.[system]?.[key])) {
        errors.push(`TERMITE.systems.${system}.${key} must be non-negative`);
      }
    }
  }
  for (const tier of ['basic', 'premier']) {
    if (!isPositiveNumber(TERMITE.monitoring?.[tier]?.monthly)) {
      errors.push(`TERMITE.monitoring.${tier}.monthly must be positive`);
    }
  }

  const trenching = SPECIALTY.trenching || {};
  if (!isPositiveNumber(trenching.dirtPerLF)) errors.push('SPECIALTY.trenching.dirtPerLF must be positive');
  if (!isPositiveNumber(trenching.concretePerLF)) errors.push('SPECIALTY.trenching.concretePerLF must be positive');
  if (!isPositiveNumber(trenching.floor)) errors.push('SPECIALTY.trenching.floor must be positive');
  if (!isNonNegativeNumber(trenching.renewal)) errors.push('SPECIALTY.trenching.renewal must be non-negative');
  for (const key of ['concretePctBase', 'concretePctCage', 'concretePctPool', 'concretePctDriveway', 'concretePctCap']) {
    if (!isFiniteNumber(trenching[key]) || Number(trenching[key]) < 0 || Number(trenching[key]) > 1) {
      errors.push(`SPECIALTY.trenching.${key} must be between 0 and 1`);
    }
  }
  if (!trenching.products?.[trenching.defaultProductKey]) {
    errors.push('SPECIALTY.trenching.defaultProductKey must reference a configured product');
  }
  if (!trenching.products?.[trenching.defaultIncludedProductKey]) {
    errors.push('SPECIALTY.trenching.defaultIncludedProductKey must reference a configured product');
  }
  if (!isPositiveNumber(trenching.finishedGallonsPer10LFPerFtDepth)) {
    errors.push('SPECIALTY.trenching.finishedGallonsPer10LFPerFtDepth must be positive');
  }
  if (!isFiniteNumber(trenching.defaultConcreteVolumePadPct) ||
    Number(trenching.defaultConcreteVolumePadPct) < 0 ||
    Number(trenching.defaultConcreteVolumePadPct) > 1) {
    errors.push('SPECIALTY.trenching.defaultConcreteVolumePadPct must be between 0 and 1');
  }
  if (!isPositiveNumber(trenching.productPremiumMultiplier) || Number(trenching.productPremiumMultiplier) < 1) {
    errors.push('SPECIALTY.trenching.productPremiumMultiplier must be at least 1');
  }
  for (const key of ['termidor_sc', 'taurus_sc', 'bifen_it', 'talstar_p']) {
    const product = trenching.products?.[key] || {};
    if (!isPositiveNumber(product.containerCost)) {
      errors.push(`SPECIALTY.trenching.products.${key}.containerCost must be positive`);
    }
    if (!isPositiveNumber(product.containerOz)) {
      errors.push(`SPECIALTY.trenching.products.${key}.containerOz must be positive`);
    }
    if (!isPositiveNumber(product.productOzPerFinishedGallonAtStandardRate)) {
      errors.push(`SPECIALTY.trenching.products.${key}.productOzPerFinishedGallonAtStandardRate must be positive`);
    }
    if (!isPositiveNumber(product.productOzPerFinishedGallonAtHighRate) ||
      Number(product.productOzPerFinishedGallonAtHighRate) < Number(product.productOzPerFinishedGallonAtStandardRate)) {
      errors.push(`SPECIALTY.trenching.products.${key}.productOzPerFinishedGallonAtHighRate must be at least standard rate`);
    }
  }
  for (const [key, tier] of Object.entries(trenching.warrantyTiers || {})) {
    if (!isNonNegativeNumber(tier.priceAdderPct)) {
      errors.push(`SPECIALTY.trenching.warrantyTiers.${key}.priceAdderPct must be non-negative`);
    }
  }

  const boraCare = SPECIALTY.boraCare || {};
  if (!isPositiveNumber(boraCare.coverage)) errors.push('SPECIALTY.boraCare.coverage must be positive');
  if (!isPositiveNumber(boraCare.galCost)) errors.push('SPECIALTY.boraCare.galCost must be positive');
  if (!isPositiveNumber(boraCare.marginDivisor) || Number(boraCare.marginDivisor) >= 1) {
    errors.push('SPECIALTY.boraCare.marginDivisor must be positive and less than 1');
  }

  const preSlab = SPECIALTY.preSlabTermidor || {};
  if (!isPositiveNumber(preSlab.coverage)) errors.push('SPECIALTY.preSlabTermidor.coverage must be positive');
  if (!isPositiveNumber(preSlab.bottleCost)) errors.push('SPECIALTY.preSlabTermidor.bottleCost must be positive');
  if (!isPositiveNumber(preSlab.marginDivisor) || Number(preSlab.marginDivisor) >= 1) {
    errors.push('SPECIALTY.preSlabTermidor.marginDivisor must be positive and less than 1');
  }
  for (const key of ['none', '5plus', '10plus']) {
    if (!isPositiveNumber(preSlab.volumeDiscounts?.[key])) {
      errors.push(`SPECIALTY.preSlabTermidor.volumeDiscounts.${key} is required`);
    }
  }
  if (!isNonNegativeNumber(preSlab.warrantyExtended)) {
    errors.push('SPECIALTY.preSlabTermidor.warrantyExtended must be non-negative');
  }

  const preSlabTermiticide = SPECIALTY.preSlabTermiticide || {};
  const products = preSlabTermiticide.products || {};
  if (!products[preSlabTermiticide.defaultProductKey]) {
    errors.push('SPECIALTY.preSlabTermiticide.defaultProductKey must reference a configured product');
  }
  if (!isPositiveNumber(preSlabTermiticide.equipCost)) {
    errors.push('SPECIALTY.preSlabTermiticide.equipCost must be positive');
  }
  if (!isNonNegativeNumber(preSlabTermiticide.warrantyExtended)) {
    errors.push('SPECIALTY.preSlabTermiticide.warrantyExtended must be non-negative');
  }
  for (const key of ['none', '5plus', '10plus']) {
    if (!isPositiveNumber(preSlabTermiticide.volumeDiscounts?.[key])) {
      errors.push(`SPECIALTY.preSlabTermiticide.volumeDiscounts.${key} is required`);
    }
  }
  for (const context of ['standalone', 'builderBatch', 'sameTripAddOn']) {
    const tiers = preSlabTermiticide.minimums?.[context];
    if (!Array.isArray(tiers) || tiers.length === 0) {
      errors.push(`SPECIALTY.preSlabTermiticide.minimums.${context} is required`);
    } else {
      let previousMax = 0;
      tiers.forEach((tier, index) => {
        const terminal = isTerminalInfinity(tier.maxSqFt);
        const maxSqFt = terminal ? Infinity : Number(tier.maxSqFt);
        if (!terminal && !isPositiveNumber(tier.maxSqFt)) {
          errors.push(`SPECIALTY.preSlabTermiticide.minimums.${context}.${index}.maxSqFt must be positive`);
        }
        if (terminal && index !== tiers.length - 1) {
          errors.push(`SPECIALTY.preSlabTermiticide.minimums.${context}.${index}.maxSqFt terminal Infinity must be last`);
        }
        if (!terminal && Number.isFinite(maxSqFt) && maxSqFt <= previousMax) {
          errors.push(`SPECIALTY.preSlabTermiticide.minimums.${context} must be sorted by ascending maxSqFt`);
        }
        previousMax = maxSqFt;
        if (!isNonNegativeNumber(tier.floor)) {
          errors.push(`SPECIALTY.preSlabTermiticide.minimums.${context}.${index}.floor must be non-negative`);
        }
      });
      if (!isTerminalInfinity(tiers[tiers.length - 1]?.maxSqFt)) {
        errors.push(`SPECIALTY.preSlabTermiticide.minimums.${context} must end with terminal Infinity maxSqFt`);
      }
    }
    if (typeof preSlabTermiticide.includeDriveCostByContext?.[context] !== 'boolean') {
      errors.push(`SPECIALTY.preSlabTermiticide.includeDriveCostByContext.${context} must be boolean`);
    }
  }
  if (!isNonNegativeNumber(preSlabTermiticide.complianceAdminCost)) {
    errors.push('SPECIALTY.preSlabTermiticide.complianceAdminCost must be non-negative');
  }
  for (const key of ['termidor_sc', 'taurus_sc', 'bifen_it', 'talstar_p']) {
    const product = products[key] || {};
    if (!isPositiveNumber(product.containerCost)) {
      errors.push(`SPECIALTY.preSlabTermiticide.products.${key}.containerCost must be positive`);
    }
    if (!isPositiveNumber(product.containerOz)) {
      errors.push(`SPECIALTY.preSlabTermiticide.products.${key}.containerOz must be positive`);
    }
    if (!isPositiveNumber(product.productOzPer10SqFt)) {
      errors.push(`SPECIALTY.preSlabTermiticide.products.${key}.productOzPer10SqFt must be positive`);
    }
    if (!isPositiveNumber(product.marginDivisor) || Number(product.marginDivisor) >= 1) {
      errors.push(`SPECIALTY.preSlabTermiticide.products.${key}.marginDivisor must be positive and less than 1`);
    }
  }

  const palm = PALM || {};
  const palmTreatments = palm.treatments || palm.treatmentTypes || {};
  if (!isPositiveNumber(palm.minPerVisit)) errors.push('PALM.minPerVisit must be positive');
  if (!isNonNegativeNumber(palm.flatCreditPerPalm)) errors.push('PALM.flatCreditPerPalm must be non-negative');
  if (!WAVEGUARD?.tiers?.[palm.flatCreditMinTier]) errors.push('PALM.flatCreditMinTier must be a valid WaveGuard tier');
  if (palm.tierQualifier !== false) errors.push('PALM.tierQualifier must remain false');
  if (palm.excludeFromPctDiscount !== true) errors.push('PALM.excludeFromPctDiscount must remain true');

  for (const key of ['nutrition', 'insecticide', 'combo', 'fungal', 'lethalBronzing', 'treeAge']) {
    if (!palmTreatments[key]?.pricingType) errors.push(`PALM.treatments.${key}.pricingType is required`);
  }
  const nutrition = palmTreatments.nutrition || {};
  if (!isPositiveNumber(nutrition.pricePerPalm)) errors.push('PALM.treatments.nutrition.pricePerPalm must be positive');
  if (!Array.isArray(nutrition.allowedAppsPerYear) || !nutrition.allowedAppsPerYear.includes(1) || !nutrition.allowedAppsPerYear.includes(2)) {
    errors.push('PALM.treatments.nutrition.allowedAppsPerYear must include 1 and 2');
  }
  requirePalmTierSizes(errors, palmTreatments.insecticide, 'insecticide');
  requirePalmTierSizes(errors, palmTreatments.combo, 'combo');
  const fungal = palmTreatments.fungal || {};
  if (!isPositiveNumber(fungal.floorPerPalm)) errors.push('PALM.treatments.fungal.floorPerPalm must be positive');
  if (!Array.isArray(fungal.products) || !fungal.products.includes('PHOSPHO-Jet') || !fungal.products.includes('Propizol')) {
    errors.push('PALM.treatments.fungal.products must include PHOSPHO-Jet and Propizol');
  }
  const lethalBronzing = palmTreatments.lethalBronzing || {};
  if (!isPositiveNumber(lethalBronzing.floorPerPalm)) errors.push('PALM.treatments.lethalBronzing.floorPerPalm must be positive');
  if (Number(lethalBronzing.intervalMonths) !== 3) errors.push('PALM.treatments.lethalBronzing.intervalMonths must be 3');
  if (Number(lethalBronzing.appsPerYear) !== 4) errors.push('PALM.treatments.lethalBronzing.appsPerYear must be 4');
  if (Number(lethalBronzing.minimumProgramMonths) !== 24) errors.push('PALM.treatments.lethalBronzing.minimumProgramMonths must be 24');
  if (!Array.isArray(lethalBronzing.eligibleStatuses) || lethalBronzing.eligibleStatuses.length === 0) {
    errors.push('PALM.treatments.lethalBronzing.eligibleStatuses must be non-empty');
  }
  if (!Array.isArray(lethalBronzing.ineligibleStatuses) || lethalBronzing.ineligibleStatuses.length === 0) {
    errors.push('PALM.treatments.lethalBronzing.ineligibleStatuses must be non-empty');
  }
  const treeAge = palmTreatments.treeAge || {};
  if (!isPositiveNumber(treeAge.floorPerPalm)) errors.push('PALM.treatments.treeAge.floorPerPalm must be positive');
  if (Number(treeAge.intervalMonths) !== 24) errors.push('PALM.treatments.treeAge.intervalMonths must be 24');
  if (Number(treeAge.appsPerYear) !== 0.5) errors.push('PALM.treatments.treeAge.appsPerYear must be 0.5');
  const dbhMaxes = new Set((treeAge.tiers || []).map(t => t.dbhMax));
  for (const max of [10, 15, 20, null]) {
    if (!dbhMaxes.has(max)) errors.push(`PALM.treatments.treeAge.tiers must include DBH max ${max}`);
  }
  if (!palm.internalCostBasis || typeof palm.internalCostBasis !== 'object') {
    errors.push('PALM.internalCostBasis is required');
  }

  return { valid: errors.length === 0, errors };
}

function assertValidPestPricingConfig(snapshot = constants) {
  const result = validatePestPricingConfig(snapshot);
  if (!result.valid) {
    throw new Error(`Invalid pest pricing config: ${result.errors.join('; ')}`);
  }
  return result;
}

function clonePricingObject(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  for (const [key, child] of Object.entries(value)) {
    clone[key] = clonePricingObject(child, seen);
  }
  return clone;
}

function replaceObjectInPlace(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function replaceValueInPlace(key, source) {
  const target = constants[key];
  if (Array.isArray(target) && Array.isArray(source)) {
    target.length = 0;
    target.push(...source);
    return;
  }
  if (
    target &&
    source &&
    typeof target === 'object' &&
    typeof source === 'object' &&
    !Array.isArray(target) &&
    !Array.isArray(source)
  ) {
    replaceObjectInPlace(target, source);
    return;
  }
  constants[key] = source;
}

function snapshotPricingConstants() {
  return clonePricingObject(constants);
}

function restorePricingConstants(snapshot) {
  if (!snapshot) return;
  for (const [key, source] of Object.entries(snapshot)) {
    replaceValueInPlace(key, source);
  }
}

function syncBedBugPricingConfig(bedBugConfig) {
  if (!bedBugConfig || typeof bedBugConfig !== 'object' || Array.isArray(bedBugConfig)) return;

  const target = constants.BED_BUG;
  setBoolean(target, 'recurringDiscountEligible', bedBugConfig.recurringDiscountEligible);
  setNumber(target, 'maxRecurringDiscountPct', bedBugConfig.maxRecurringDiscountPct);
  setStringArray(target, 'allowedMethods', bedBugConfig.allowedMethods);

  if (bedBugConfig.severity && typeof bedBugConfig.severity === 'object') {
    for (const [key, cfg] of Object.entries(bedBugConfig.severity)) {
      if (!target.severity[key] || !cfg || typeof cfg !== 'object') continue;
      setString(target.severity[key], 'label', cfg.label);
      setNumber(target.severity[key], 'visits', cfg.visits, Number);
      setNumber(target.severity[key], 'multiplier', cfg.multiplier);
      setBoolean(target.severity[key], 'quoteRequired', cfg.quoteRequired);
    }
  }

  if (bedBugConfig.prepStatus && typeof bedBugConfig.prepStatus === 'object') {
    for (const [key, cfg] of Object.entries(bedBugConfig.prepStatus)) {
      if (!target.prepStatus[key] || !cfg || typeof cfg !== 'object') continue;
      setString(target.prepStatus[key], 'label', cfg.label);
      setNumber(target.prepStatus[key], 'multiplier', cfg.multiplier);
      setBoolean(target.prepStatus[key], 'allowed', cfg.allowed);
      setBoolean(target.prepStatus[key], 'quoteRequired', cfg.quoteRequired);
      setStringArray(target.prepStatus[key], 'warnings', cfg.warnings);
    }
  }

  if (bedBugConfig.occupancyType && typeof bedBugConfig.occupancyType === 'object') {
    for (const [key, cfg] of Object.entries(bedBugConfig.occupancyType)) {
      if (!target.occupancyType[key] || !cfg || typeof cfg !== 'object') continue;
      setString(target.occupancyType[key], 'label', cfg.label);
      setNumber(target.occupancyType[key], 'multiplier', cfg.multiplier);
    }
  }

  if (bedBugConfig.stories && typeof bedBugConfig.stories === 'object') {
    for (const [key, cfg] of Object.entries(bedBugConfig.stories)) {
      if (!target.stories[key] || !cfg || typeof cfg !== 'object') continue;
      setNumber(target.stories[key], 'maxStories', cfg.maxStories, Number);
      setNumber(target.stories[key], 'multiplier', cfg.multiplier);
    }
  }

  if (bedBugConfig.urgencyMultipliers && typeof bedBugConfig.urgencyMultipliers === 'object') {
    for (const [key, value] of Object.entries(bedBugConfig.urgencyMultipliers)) {
      setNumber(target.urgencyMultipliers, key, value);
    }
  }

  const chemical = bedBugConfig.chemical || {};
  if (chemical && typeof chemical === 'object') {
    setString(target.chemical, 'label', chemical.label);
    setNumber(target.chemical, 'includedVisits', chemical.includedVisits, Number);
    setNumber(target.chemical, 'followUpDays', chemical.followUpDays, Number);
    setNumber(target.chemical, 'materialPerRoomVisit1', chemical.materialPerRoomVisit1 ?? chemical.material_per_room);
    setNumber(target.chemical, 'materialPerRoomVisit2Factor', chemical.materialPerRoomVisit2Factor);
    setNumber(target.chemical, 'extraFollowUpMaterialFactor', chemical.extraFollowUpMaterialFactor);
    setString(target.chemical, 'pricingModel', chemical.pricingModel);
    setNumber(target.chemical, 'targetCostRatio', chemical.targetCostRatio);
    setNumber(target.chemical, 'minimumBase', chemical.minimumBase ?? chemical.floor_base, money);
    setNumber(target.chemical, 'minimumAdditionalRoom', chemical.minimumAdditionalRoom ?? chemical.floor_per_extra_room, money);
    if (chemical.additionalFollowUpPrice) {
      setNumber(target.chemical.additionalFollowUpPrice, 'base', chemical.additionalFollowUpPrice.base, money);
      setNumber(target.chemical.additionalFollowUpPrice, 'perRoom', chemical.additionalFollowUpPrice.perRoom, money);
    }
    if (chemical.visitMinutes && typeof chemical.visitMinutes === 'object') {
      for (const [visitKey, cfg] of Object.entries(chemical.visitMinutes)) {
        if (!target.chemical.visitMinutes[visitKey] || !cfg || typeof cfg !== 'object') continue;
        for (const [field, value] of Object.entries(cfg)) {
          setNumber(target.chemical.visitMinutes[visitKey], field, value, Number);
        }
      }
    }
    if (Array.isArray(chemical.sizeModifiers)) target.chemical.sizeModifiers = chemical.sizeModifiers.map(rule => ({ ...rule }));
    if (chemical.productBasis) mergePlainObject(target.chemical.productBasis, chemical.productBasis);
    if (chemical.protocol) mergePlainObject(target.chemical.protocol, chemical.protocol);
    setStringArray(target.chemical, 'warnings', chemical.warnings);
  }

  const heat = bedBugConfig.heat || {};
  if (heat && typeof heat === 'object') {
    setString(target.heat, 'label', heat.label);
    setNumber(target.heat, 'includedTreatmentEvents', heat.includedTreatmentEvents, Number);
    setBoolean(target.heat, 'includePostInspection', heat.includePostInspection);
    setNumber(target.heat, 'postInspectionDays', heat.postInspectionDays, Number);
    setStringArray(target.heat, 'allowedEquipment', heat.allowedEquipment);
    if (heat.roomRates) {
      setNumber(target.heat.roomRates, 'oneRoom', heat.roomRates.oneRoom ?? heat.per_room_1, money);
      setNumber(target.heat.roomRates, 'twoRooms', heat.roomRates.twoRooms ?? heat.per_room_2, money);
      setNumber(target.heat.roomRates, 'threePlusRooms', heat.roomRates.threePlusRooms ?? heat.per_room_3, money);
    } else {
      setNumber(target.heat.roomRates, 'oneRoom', heat.per_room_1, money);
      setNumber(target.heat.roomRates, 'twoRooms', heat.per_room_2, money);
      setNumber(target.heat.roomRates, 'threePlusRooms', heat.per_room_3, money);
    }
    if (heat.inHouseEquipmentFee) {
      setNumber(target.heat.inHouseEquipmentFee, 'base', heat.inHouseEquipmentFee.base, money);
      setNumber(target.heat.inHouseEquipmentFee, 'perExtraRoom', heat.inHouseEquipmentFee.perExtraRoom, money);
    }
    setNumber(target.heat, 'subcontractMarkup', heat.subcontractMarkup);
    if (heat.minimums) {
      setNumber(target.heat.minimums, 'inHouse', heat.minimums.inHouse, money);
      setNumber(target.heat.minimums, 'subcontract', heat.minimums.subcontract, money);
    }
    if (heat.heatScope) setStringArray(target.heat.heatScope, 'allowed', heat.heatScope.allowed);
    if (heat.sqftRates) {
      setNumber(target.heat.sqftRates, 'inHouse', heat.sqftRates.inHouse);
      setNumber(target.heat.sqftRates, 'subcontract', heat.sqftRates.subcontract);
    }
    if (Array.isArray(heat.sizeModifiers)) target.heat.sizeModifiers = heat.sizeModifiers.map(rule => ({ ...rule }));
    if (heat.protocol) mergePlainObject(target.heat.protocol, heat.protocol);
    setStringArray(target.heat, 'warnings', heat.warnings);
  }

  const hybrid = bedBugConfig.hybrid || {};
  if (hybrid && typeof hybrid === 'object') {
    setString(target.hybrid, 'label', hybrid.label);
    setBoolean(target.hybrid, 'heatEvent', hybrid.heatEvent);
    setBoolean(target.hybrid, 'residualApplication', hybrid.residualApplication);
    setBoolean(target.hybrid, 'includePostInspection', hybrid.includePostInspection);
    setNumber(target.hybrid, 'postInspectionDays', hybrid.postInspectionDays, Number);
    if (hybrid.residualAddOn) {
      setNumber(target.hybrid.residualAddOn, 'base', hybrid.residualAddOn.base, money);
      setNumber(target.hybrid.residualAddOn, 'perRoom', hybrid.residualAddOn.perRoom, money);
    }
    if (hybrid.protocol) mergePlainObject(target.hybrid.protocol, hybrid.protocol);
    setStringArray(target.hybrid, 'warnings', hybrid.warnings);
  }
}

let _lastSync = 0;
const SYNC_INTERVAL = 60_000; // 1 minute cache

async function syncConstantsFromDB(dbInstance) {
  const db = dbInstance || require('../../models/db');
  let constantsSnapshot = null;

  try {
    const hasTable = await db.schema.hasTable('pricing_config');
    if (!hasTable) return false;

    // Check for JSONB 'data' column (route-created schema)
    const rows = await db('pricing_config').select('config_key', 'data');
    if (!rows.length || rows[0].data === undefined) return false;

    const config = {};
    for (const row of rows) {
      if (row.data != null) {
        config[row.config_key] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      }
    }
    if (Object.keys(config).length === 0) return false;
    constantsSnapshot = snapshotPricingConstants();

    // ── Global ───────────────────────────────────────────────
    if (config.global_labor_rate?.value) constants.GLOBAL.LABOR_RATE = config.global_labor_rate.value;
    if (config.global_drive_time?.value) constants.GLOBAL.DRIVE_TIME = config.global_drive_time.value;
    if (config.global_admin_annual?.value) constants.GLOBAL.ADMIN_ANNUAL = config.global_admin_annual.value;
    if (config.global_margin_floor?.value) {
      constants.GLOBAL.MARGIN_FLOOR = config.global_margin_floor.value;
      constants.TREE_SHRUB.marginFloor = config.global_margin_floor.value;
    }
    if (config.global_margin_target_ts?.value) {
      // v4.6 semantics change: the value is now an admin-INCLUSIVE margin
      // target, not a direct-cost ratio. A pre-migration row (0.43, ratio
      // semantics) applied as a margin would silently misprice, so the
      // migration stamps `semantics` and the bridge only honors rows that
      // carry the marker; unstamped rows fall back to the constants default.
      const tsTarget = Number(config.global_margin_target_ts.value);
      const tsSemanticsOk = config.global_margin_target_ts.semantics === 'margin_admin_inclusive';
      if (tsSemanticsOk && tsTarget > 0 && tsTarget < 1) {
        constants.GLOBAL.MARGIN_TARGET_TS = tsTarget;
        constants.TREE_SHRUB.marginTarget = tsTarget;
      }
    }
    if (config.global_conditional_ceiling?.value) constants.GLOBAL.CONDITIONAL_CEILING = config.global_conditional_ceiling.value;

    if (config.lawn_pricing_v2) {
      deepMergePlainObject(constants.LAWN_PRICING_V2, config.lawn_pricing_v2);
    }

    // ── Estimate acceptance deposit (flat per service class) ──
    if (config.estimate_deposit) {
      const recurring = Number(config.estimate_deposit.recurringAmount);
      const oneTime = Number(config.estimate_deposit.oneTimeAmount);
      if (Number.isFinite(recurring) && recurring > 0) constants.DEPOSIT.recurringAmount = r(recurring);
      if (Number.isFinite(oneTime) && oneTime > 0) constants.DEPOSIT.oneTimeAmount = r(oneTime);
    }

    // ── Pest Control ─────────────────────────────────────────
    if (config.pest_base) {
      if (config.pest_base.base) constants.PEST.base = r(config.pest_base.base);
      if (config.pest_base.floor) constants.PEST.floor = r(config.pest_base.floor);
      // Initial Roach Knockdown sliding scale — DB shape mirrors the constants:
      //   { regular: [{sqft, price}, ...], german: [{sqft, price}, ...],
      //     regular_standalone: [{sqft, price}, ...] }
      // Stored as an object so the admin Pricing Logic panel can re-tune the
      // brackets per-species without redeploying. Replace whole-cloth (no
      // partial merge) — we want admin edits to be authoritative.
      if (config.pest_base.initial_roach && typeof config.pest_base.initial_roach === 'object') {
        const ir = config.pest_base.initial_roach;
        const next = { ...constants.PEST.pestInitialRoach };
        for (const species of ['regular', 'german', 'regular_standalone']) {
          if (Array.isArray(ir[species])) {
            next[species] = ir[species].map((b) => ({
              sqft: b.sqft === null || b.sqft === 'Infinity' ? Infinity : Number(b.sqft),
              price: money(b.price),
            }));
          }
        }
        constants.PEST.pestInitialRoach = next;
      }
    }
    if (config.pest_features) {
      const f = config.pest_features;
      const adj = constants.PEST.additionalAdjustments;
      if (f.pool_cage != null) adj.poolCage = r(f.pool_cage);
      if (f.pool_cage_small != null) adj.poolCageSmall = r(f.pool_cage_small);
      if (f.pool_cage_medium != null) adj.poolCageMedium = r(f.pool_cage_medium);
      if (f.pool_cage_large != null) adj.poolCageLarge = r(f.pool_cage_large);
      if (f.pool_cage_oversized != null) adj.poolCageOversized = r(f.pool_cage_oversized);
      if (f.pool_no_cage != null) adj.poolNoCage = r(f.pool_no_cage);
      if (f.shrubs_heavy != null) adj.shrubs_heavy = r(f.shrubs_heavy);
      if (f.shrubs_moderate != null) adj.shrubs_moderate = r(f.shrubs_moderate);
      if (f.shrubs_light != null) adj.shrubs_light = f.shrubs_light >= 0 ? r(f.shrubs_light) : -r(Math.abs(f.shrubs_light));
      if (f.trees_heavy != null) adj.trees_heavy = r(f.trees_heavy);
      if (f.trees_moderate != null) adj.trees_moderate = r(f.trees_moderate);
      if (f.trees_light != null) adj.trees_light = f.trees_light >= 0 ? r(f.trees_light) : -r(Math.abs(f.trees_light));
      if (f.landscape_complex != null) adj.complexity_complex = f.landscape_complex >= 0 ? r(f.landscape_complex) : -r(Math.abs(f.landscape_complex));
      if (f.landscape_moderate != null) adj.complexity_moderate = f.landscape_moderate >= 0 ? r(f.landscape_moderate) : -r(Math.abs(f.landscape_moderate));
      if (f.landscape_simple != null) adj.complexity_simple = f.landscape_simple >= 0 ? r(f.landscape_simple) : -r(Math.abs(f.landscape_simple));
      if (f.near_water != null) adj.nearWater = f.near_water;
      if (f.large_driveway != null) adj.largeDriveway = f.large_driveway;
      if (f.indoor != null) adj.indoor = r(f.indoor);
      if (f.attached_garage != null) adj.attachedGarage = r(f.attached_garage);
    }
    if (config.pest_footprint?.breakpoints) {
      constants.PEST.footprintBrackets = config.pest_footprint.breakpoints.map(bp => ({
        sqft: bp.sqft,
        adj: bp.adj >= 0 ? r(bp.adj) : -r(Math.abs(bp.adj)),
      }));
    }
    if (config.pest_property_type) {
      for (const [type, val] of Object.entries(config.pest_property_type)) {
        if (constants.PROPERTY_TYPE_ADJ[type] !== undefined) {
          constants.PROPERTY_TYPE_ADJ[type] = val >= 0 ? r(val) : -r(Math.abs(val));
        }
      }
    }

    // ── Tree & Shrub ─────────────────────────────────────────
    if (config.ts_material_rates) {
      const rates = config.ts_material_rates;
      const model = constants.TREE_SHRUB.materialModel;
      // v4.6 material model keys. The legacy flat-rate keys ('4x_light' /
      // '6x_standard' $/sqft, plus retired 9x/12x) are ignored — a
      // pre-migration row simply leaves the constants defaults in place.
      if (model) {
        if (Number(rates.fixed) > 0) model.fixedAnnual = Number(rates.fixed);
        if (Number(rates.per_tree) > 0) model.perTreeAnnual = Number(rates.per_tree);
        if (Number(rates.per_sqft) > 0) model.perSqFtAnnual = Number(rates.per_sqft);
        if (Number(rates.light_factor) > 0 && Number(rates.light_factor) <= 1) {
          model.lightFactor = Number(rates.light_factor);
        }
      }
    }
    if (config.ts_monthly_floors) {
      for (const [tier, val] of Object.entries(config.ts_monthly_floors)) {
        if (constants.TREE_SHRUB.tiers[tier]) constants.TREE_SHRUB.tiers[tier].monthlyFloor = r(val);
      }
    }

    // ── Palm Injection ───────────────────────────────────────
    if (config.palm_pricing) {
      const p = config.palm_pricing;
      const tt = constants.PALM.treatments || constants.PALM.treatmentTypes;
      const setTier = (treatment, size, value) => {
        const tier = treatment?.tiers?.find(t => t.size === size);
        if (tier && value != null) tier.pricePerPalm = r(value);
      };
      if (p.nutrition != null) tt.nutrition.pricePerPalm = r(p.nutrition);
      if (p.nutrition_default_apps_per_year != null) {
        const apps = Number(p.nutrition_default_apps_per_year);
        if (Number.isFinite(apps) && apps > 0) tt.nutrition.defaultAppsPerYear = apps;
      }
      if (Array.isArray(p.nutrition_allowed_apps_per_year)) {
        const allowed = p.nutrition_allowed_apps_per_year
          .map(Number)
          .filter(v => Number.isFinite(v) && v > 0);
        if (allowed.length) tt.nutrition.allowedAppsPerYear = allowed;
      }
      setTier(tt.insecticide, 'small', p.insecticide_small ?? p.preventive_insecticide_small);
      setTier(tt.insecticide, 'medium', p.insecticide_medium ?? p.preventive_insecticide_medium);
      setTier(tt.insecticide, 'large', p.insecticide_large ?? p.preventive_insecticide_large);
      setTier(tt.combo, 'small', p.combo_small);
      setTier(tt.combo, 'medium', p.combo_medium);
      setTier(tt.combo, 'large', p.combo_large);
      if (p.fungal_floor != null) tt.fungal.floorPerPalm = r(p.fungal_floor);
      if (p.lethal_bronzing_floor) tt.lethalBronzing.floorPerPalm = r(p.lethal_bronzing_floor);
      if (p.tree_age_floor) {
        tt.treeAge.floorPerPalm = r(p.tree_age_floor);
        const firstTier = tt.treeAge.tiers?.find(t => t.dbhMax === 10);
        if (firstTier) firstTier.pricePerPalm = r(p.tree_age_floor);
      }
      if (p.min_per_visit != null) {
        const min = Number(p.min_per_visit);
        if (Number.isFinite(min) && min > 0) constants.PALM.minPerVisit = r(min);
      }
      if (p.flat_credit_per_palm != null) {
        const credit = Number(p.flat_credit_per_palm);
        if (Number.isFinite(credit) && credit >= 0) constants.PALM.flatCreditPerPalm = credit;
      }
      if (p.flat_credit_min_tier && constants.WAVEGUARD.tiers[p.flat_credit_min_tier]) {
        constants.PALM.flatCreditMinTier = p.flat_credit_min_tier;
      }
      if (typeof p.tier_qualifier === 'boolean') constants.PALM.tierQualifier = p.tier_qualifier;
      if (typeof p.exclude_from_pct_discount === 'boolean') constants.PALM.excludeFromPctDiscount = p.exclude_from_pct_discount;
    }

    // ── Termite ──────────────────────────────────────────────
    if (config.termite_install) {
      const t = config.termite_install;
      setNumber(constants.TERMITE, 'installMultiplier', t.multiplier ?? t.install_multiplier, Number);
      setNumber(constants.TERMITE, 'stationSpacing', t.station_spacing_ft ?? t.stationSpacing, Number);
      setNumber(constants.TERMITE, 'minStations', t.min_stations ?? t.minStations, Number);
      setNumber(constants.TERMITE.systems.advance, 'stationCost', t.advance_bait ?? t.advance_station_cost, Number);
      setNumber(constants.TERMITE.systems.trelona, 'stationCost', t.trelona_bait ?? t.trelona_station_cost, Number);
      const laborPerStation = t.labor_per_station ?? t.labor_material_per_station;
      if (laborPerStation != null) {
        constants.TERMITE.systems.advance.laborMaterial = Number(laborPerStation);
        constants.TERMITE.systems.trelona.laborMaterial = Number(laborPerStation);
      }
      if (t.misc_per_station != null) {
        constants.TERMITE.systems.advance.misc = Number(t.misc_per_station);
        constants.TERMITE.systems.trelona.misc = Number(t.misc_per_station);
      }
    }
    if (config.termite_monitoring) {
      if (config.termite_monitoring.basic) constants.TERMITE.monitoring.basic.monthly = r(config.termite_monitoring.basic);
      if (config.termite_monitoring.premier) constants.TERMITE.monitoring.premier.monthly = r(config.termite_monitoring.premier);
    }

    // ── Rodent ───────────────────────────────────────────────
    // Bait stations (recurring monthly)
    if (config.rodent_monthly) {
      const rm = config.rodent_monthly;
      if (rm.small) constants.RODENT.baitMonthly.small.monthly = r(rm.small);
      if (rm.medium) constants.RODENT.baitMonthly.medium.monthly = r(rm.medium);
      if (rm.large) constants.RODENT.baitMonthly.large.monthly = r(rm.large);
      if (rm.visits_per_year) constants.RODENT.baitVisitsPerYear = Number(rm.visits_per_year);
    }
    if (config.rodent_setup_fee?.value) {
      constants.RODENT.baitSetupFee = r(config.rodent_setup_fee.value);
    }
    if (config.rodent_post_exclusion) {
      const pe = config.rodent_post_exclusion;
      if (pe.multiplier) constants.RODENT.baitPostExclusion.multiplier = pe.multiplier;
      if (pe.floor_monthly) constants.RODENT.baitPostExclusion.floorMonthly = r(pe.floor_monthly);
    }

    // Inspection
    if (config.rodent_inspection) {
      const i = config.rodent_inspection;
      if (i.fee != null) constants.RODENT.inspection.fee = r(i.fee);
      if (i.creditable_within_days != null) constants.RODENT.inspection.creditableWithinDays = Number(i.creditable_within_days);
      if (i.waive_if_approved_total_over != null) constants.RODENT.inspection.waiveIfApprovedTotalOver = r(i.waive_if_approved_total_over);
    }

    // Trapping (new structure)
    if (config.rodent_trapping) {
      const t = config.rodent_trapping;
      if (t.standard_price != null) constants.RODENT.trapping.standardPrice = r(t.standard_price);
      if (t.unlimited_price != null) constants.RODENT.trapping.unlimitedPrice = r(t.unlimited_price);
      if (t.upgrade_to_unlimited_price != null) constants.RODENT.trapping.upgradeToUnlimitedPrice = r(t.upgrade_to_unlimited_price);
      if (t.base != null) constants.RODENT.trapping.base = r(t.base);
      if (t.floor != null) constants.RODENT.trapping.floor = r(t.floor);
      if (t.unlimited_floor != null) constants.RODENT.trapping.unlimitedFloor = r(t.unlimited_floor);
      if (t.ceiling_before_custom != null) constants.RODENT.trapping.ceilingBeforeCustom = r(t.ceiling_before_custom);
      if (t.included_followups != null) {
        constants.RODENT.trapping.includedFollowUps =
          String(t.included_followups).toLowerCase() === 'unlimited'
            ? 'unlimited'
            : Number(t.included_followups);
      }
      if (t.active_window_days != null) constants.RODENT.trapping.activeWindowDays = Number(t.active_window_days);
      if (t.additional_followup_rate != null) constants.RODENT.trapping.additionalFollowUpRate = r(t.additional_followup_rate);
      if (t.emergency_multiplier != null) constants.RODENT.trapping.emergencyMultiplier = Number(t.emergency_multiplier);
      if (t.emergency_minimum_surcharge != null) constants.RODENT.trapping.emergencyMinimumSurcharge = r(t.emergency_minimum_surcharge);
      if (Array.isArray(t.home_size_adjustments)) {
        constants.RODENT.trapping.homeSizeAdjustments = t.home_size_adjustments.map(b => ({
          maxSqFt: b.max_sqft === null || b.max_sqft === 'Infinity' ? Infinity : Number(b.max_sqft),
          adjustment: b.adjustment >= 0 ? r(b.adjustment) : -r(Math.abs(b.adjustment)),
          customRecommended: !!b.custom_recommended,
        }));
      }
      if (Array.isArray(t.lot_adjustments)) {
        constants.RODENT.trapping.lotAdjustments = t.lot_adjustments.map(b => ({
          maxLotSqFt: b.max_lot_sqft === null || b.max_lot_sqft === 'Infinity' ? Infinity : Number(b.max_lot_sqft),
          adjustment: b.adjustment >= 0 ? r(b.adjustment) : -r(Math.abs(b.adjustment)),
          customRecommended: !!b.custom_recommended,
        }));
      }
      if (t.pressure_adjustments && typeof t.pressure_adjustments === 'object') {
        for (const [key, val] of Object.entries(t.pressure_adjustments)) {
          if (constants.RODENT.trapping.pressureAdjustments[key] !== undefined) {
            constants.RODENT.trapping.pressureAdjustments[key] = val >= 0 ? r(val) : -r(Math.abs(val));
          }
        }
      }
    }

    if (config.rodent_trap_only_retainer) {
      const ret = config.rodent_trap_only_retainer;
      if (ret.setup_fee != null) constants.RODENT.trapOnlyRetainer.setupFee = r(ret.setup_fee);
      if (ret.extra_callback_rate != null) constants.RODENT.trapOnlyRetainer.extraCallbackRate = r(ret.extra_callback_rate);
      if (ret.plans && typeof ret.plans === 'object') {
        for (const [key, plan] of Object.entries(ret.plans)) {
          if (!constants.RODENT.trapOnlyRetainer.plans[key] || !plan) continue;
          if (plan.annual_price != null) constants.RODENT.trapOnlyRetainer.plans[key].annualPrice = r(plan.annual_price);
          if (plan.monthly_price != null) constants.RODENT.trapOnlyRetainer.plans[key].monthlyPrice = r(plan.monthly_price);
          if (plan.scheduled_visits_included != null) {
            constants.RODENT.trapOnlyRetainer.plans[key].scheduledVisitsIncluded = Number(plan.scheduled_visits_included);
          }
          if (plan.response_callbacks_included != null) {
            constants.RODENT.trapOnlyRetainer.plans[key].responseCallbacksIncluded = Number(plan.response_callbacks_included);
          }
        }
      }
    }

    if (config.rodent_wire_mesh?.substrates) {
      for (const [key, value] of Object.entries(config.rodent_wire_mesh.substrates)) {
        if (!constants.RODENT.wireMesh.substrates[key] || !value) continue;
        if (value.rate_per_linear_foot != null) {
          constants.RODENT.wireMesh.substrates[key].ratePerLinearFoot = r(value.rate_per_linear_foot);
        }
        if (value.minimum != null) constants.RODENT.wireMesh.substrates[key].minimum = r(value.minimum);
        if (typeof value.custom_quote_recommended === 'boolean') {
          constants.RODENT.wireMesh.substrates[key].customQuoteRecommended = value.custom_quote_recommended;
        }
      }
    }

    if (config.rodent_bird_boxes) {
      const bb = config.rodent_bird_boxes;
      for (const key of Object.keys(constants.RODENT.birdBoxes)) {
        if (bb[key] != null) constants.RODENT.birdBoxes[key] = r(bb[key]);
      }
    }

    // Sanitation (light / standard / heavy)
    if (config.rodent_sanitation) {
      const sa = config.rodent_sanitation;
      ['light', 'standard', 'heavy'].forEach(tier => {
        if (sa[tier]) {
          const t = sa[tier];
          if (t.base !== undefined) constants.RODENT.sanitation[tier].base = r(t.base);
          if (t.floor !== undefined) constants.RODENT.sanitation[tier].floor = r(t.floor);
          if (t.included_sqft !== undefined) constants.RODENT.sanitation[tier].includedSqFt = Number(t.included_sqft);
          if (t.additional_per_sqft !== undefined) constants.RODENT.sanitation[tier].additionalPerSqFt = Number(t.additional_per_sqft);
          if (t.included_debris_cuft !== undefined) constants.RODENT.sanitation[tier].includedDebrisCuFt = Number(t.included_debris_cuft);
          if (t.additional_debris_per_cuft !== undefined) constants.RODENT.sanitation[tier].additionalDebrisPerCuFt = r(t.additional_debris_per_cuft);
        }
      });
      if (sa.heavy) {
        if (sa.heavy.crawlspace_multiplier !== undefined) constants.RODENT.sanitation.heavy.crawlspaceMultiplier = Number(sa.heavy.crawlspace_multiplier);
        if (sa.heavy.tight_access_multiplier !== undefined) constants.RODENT.sanitation.heavy.tightAccessMultiplier = Number(sa.heavy.tight_access_multiplier);
      }
    }

    // Bundle discounts
    if (config.rodent_bundles) {
      const b = config.rodent_bundles;
      if (b.trap_exclusion) {
        if (b.trap_exclusion.discount != null) constants.RODENT.bundles.trapExclusion.discount = Number(b.trap_exclusion.discount);
        if (b.trap_exclusion.floor != null) constants.RODENT.bundles.trapExclusion.floor = r(b.trap_exclusion.floor);
      }
      if (b.trap_sanitation) {
        if (b.trap_sanitation.discount != null) constants.RODENT.bundles.trapSanitation.discount = Number(b.trap_sanitation.discount);
        if (b.trap_sanitation.floor != null) constants.RODENT.bundles.trapSanitation.floor = r(b.trap_sanitation.floor);
      }
      if (b.full_remediation) {
        if (b.full_remediation.discount != null) constants.RODENT.bundles.fullRemediation.discount = Number(b.full_remediation.discount);
        if (b.full_remediation.floors) {
          for (const tier of ['light', 'standard', 'heavy']) {
            if (b.full_remediation.floors[tier] != null) {
              constants.RODENT.bundles.fullRemediation.floors[tier] = r(b.full_remediation.floors[tier]);
            }
          }
        }
      }
    }

    // Guarantee tiers
    if (config.rodent_guarantee) {
      const g = config.rodent_guarantee;
      if (g.standard != null) constants.RODENT.guarantee.standard = r(g.standard);
      if (g.complex != null) constants.RODENT.guarantee.complex = r(g.complex);
      if (g.estate != null) constants.RODENT.guarantee.estate = r(g.estate);
      if (Array.isArray(g.eligibility_requires)) {
        constants.RODENT.guarantee.eligibilityRequires = g.eligibility_requires.map(String);
      }
    }

    if (config.rodent_waveguard || config.rodent_rules) {
      const rw = config.rodent_waveguard || config.rodent_rules;
      if (typeof rw.tier_qualifier === 'boolean') constants.RODENT.tierQualifier = rw.tier_qualifier;
      if (typeof rw.exclude_from_pct_discount === 'boolean') constants.RODENT.excludeFromPctDiscount = rw.exclude_from_pct_discount;
      if (rw.setup_credit != null) constants.RODENT.setupCredit = r(rw.setup_credit);
    }

    // ── WaveGuard ────────────────────────────────────────────
    if (config.waveguard_tiers) {
      for (const [tier, val] of Object.entries(config.waveguard_tiers)) {
        if (constants.WAVEGUARD.tiers[tier]) {
          if (val.discount !== undefined) constants.WAVEGUARD.tiers[tier].discount = val.discount;
          if (val.min_services !== undefined) constants.WAVEGUARD.tiers[tier].minServices = val.min_services;
        }
      }
    }

    // ── Mosquito ─────────────────────────────────────────────
    // Admin edits in the Pricing Logic Mosquito tab are authoritative. Legacy
    // rows used metal-tier keys; current rows use program keys.
    if (config.mosquito_base_prices) {
      const next = { ...constants.MOSQUITO.basePrices };
      for (const [lot, tierMap] of Object.entries(config.mosquito_base_prices)) {
        if (tierMap && typeof tierMap === 'object' && constants.MOSQUITO.basePrices[lot]) {
          const legacyProgramPrice = tierMap.silver ?? tierMap.monthly ?? tierMap.bronze;
          next[lot] = [
            r(Number(tierMap.seasonal9 ?? tierMap.seasonal ?? legacyProgramPrice ?? constants.MOSQUITO.basePrices[lot][0])),
            r(Number(tierMap.monthly12 ?? tierMap.monthly ?? legacyProgramPrice ?? constants.MOSQUITO.basePrices[lot][1])),
          ];
        }
      }
      constants.MOSQUITO.basePrices = next;
    }
    if (config.mosquito_visits) {
      if (config.mosquito_visits.seasonal9 != null || config.mosquito_visits.seasonal != null) {
        constants.MOSQUITO.tierVisits.seasonal9 = Number(config.mosquito_visits.seasonal9 ?? config.mosquito_visits.seasonal);
      }
      if (config.mosquito_visits.monthly12 != null || config.mosquito_visits.monthly != null) {
        constants.MOSQUITO.tierVisits.monthly12 = Number(config.mosquito_visits.monthly12 ?? config.mosquito_visits.monthly);
      }
    }
    if (config.mosquito_lot_sizes) {
      const smallMax = Number(config.mosquito_lot_sizes.SMALL?.maxSqFt ?? config.mosquito_lot_sizes.SMALL?.max_sqft);
      const halfMax = Number(config.mosquito_lot_sizes.HALF?.maxSqFt ?? config.mosquito_lot_sizes.HALF?.max_sqft);
      const isLegacyGrossLotSeed = smallMax === 10889 && halfMax === 43559;
      if (!isLegacyGrossLotSeed) {
        const next = constants.MOSQUITO.lotCategories.map(c => ({ ...c }));
        for (const c of next) {
          const cfg = config.mosquito_lot_sizes[c.key];
          const maxSqFt = cfg?.maxSqFt ?? cfg?.max_sqft;
          if (maxSqFt != null) c.maxSqFt = Number(maxSqFt) >= 999999 ? Infinity : Number(maxSqFt);
        }
        constants.MOSQUITO.lotCategories = next;
      }
    }
    if (config.mosquito_pressure) {
      const p = config.mosquito_pressure;
      const pf = constants.MOSQUITO.pressureFactors;
      // DB uses snake_case `near_water`; engine uses camelCase `nearWater`.
      // All other keys are snake_case in both places.
      const KEY_MAP = { near_water: 'nearWater' };
      for (const [k, v] of Object.entries(p)) {
        if (k === 'cap') continue;
        const target = KEY_MAP[k] || k;
        if (target in pf && typeof v === 'number') pf[target] = v;
      }
      if (typeof p.cap === 'number') constants.MOSQUITO.pressureCap = p.cap;
    }
    if (config.onetime_mosquito) {
      const next = { ...constants.ONE_TIME.mosquito };
      const legacyMap = {
        QUARTER: 'STANDARD',
        THIRD: 'LARGE',
        HALF: 'XL',
        ACRE: 'ACRE_CLASS',
      };
      for (const bucket of ['SMALL', 'STANDARD', 'LARGE', 'XL', 'ESTATE', 'ACRE_CLASS', 'OVER_ACRE']) {
        const legacyKey = Object.entries(legacyMap).find(([, mapped]) => mapped === bucket)?.[0];
        const raw = config.onetime_mosquito[bucket] ?? (legacyKey ? config.onetime_mosquito[legacyKey] : undefined);
        if (raw != null) next[bucket] = r(Number(raw));
      }
      if (config.onetime_mosquito.overAcreIncrementSqFt != null) {
        next.overAcreIncrementSqFt = Number(config.onetime_mosquito.overAcreIncrementSqFt);
      }
      if (config.onetime_mosquito.overAcreIncrementPrice != null) {
        next.overAcreIncrementPrice = r(Number(config.onetime_mosquito.overAcreIncrementPrice));
      }
      if (config.onetime_mosquito.stationAddOn != null) {
        next.stationAddOn = r(Number(config.onetime_mosquito.stationAddOn));
      }
      if (config.onetime_mosquito.dunkAddOn != null) {
        next.dunkAddOn = r(Number(config.onetime_mosquito.dunkAddOn));
      }
      constants.ONE_TIME.mosquito = next;
    }

    // ── One-Time / Specialty ─────────────────────────────────
    if (config.onetime_urgency) {
      if (config.onetime_urgency.soon) constants.URGENCY.SOON.standard = config.onetime_urgency.soon;
      if (config.onetime_urgency.soon_after_hours) constants.URGENCY.SOON.afterHours = config.onetime_urgency.soon_after_hours;
      if (config.onetime_urgency.urgent) constants.URGENCY.URGENT.standard = config.onetime_urgency.urgent;
      if (config.onetime_urgency.urgent_after_hours) constants.URGENCY.URGENT.afterHours = config.onetime_urgency.urgent_after_hours;
    }
    if (config.onetime_recurring_discount) {
      if (config.onetime_recurring_discount.discount != null) {
        constants.WAVEGUARD.recurringCustomerOneTimePerk = Number(config.onetime_recurring_discount.discount);
      } else if (config.onetime_recurring_discount.multiplier != null) {
        constants.WAVEGUARD.recurringCustomerOneTimePerk = 1 - Number(config.onetime_recurring_discount.multiplier);
      }
    }
    if (config.onetime_pest) {
      const ot = config.onetime_pest;
      if (ot.floor != null) constants.ONE_TIME.pest.floor = r(Number(ot.floor));
      // one-time = quarterlyPerApp × multiplier. Only read the `multiplier` key.
      // Legacy keys (`premium_multiplier` 1.2, `setup_equivalent`) are obsolete
      // and intentionally ignored — their values are incompatible with the pure
      // multiple (1.2 would fail the >= 2 guard). The companion migration writes
      // `multiplier` to every row before this code runs, so un-migrated rows
      // only occur transiently and safely fall back to the code default.
      if (ot.multiplier != null) {
        constants.ONE_TIME.pest.multiplier = Number(ot.multiplier);
      }
    }
    if (config.onetime_lawn) {
      const ot = config.onetime_lawn;
      if (ot.floor != null) constants.ONE_TIME.lawn.floor = r(Number(ot.floor));
      if (ot.fungicide_floor != null) constants.ONE_TIME.lawn.fungicideFloor = r(Number(ot.fungicide_floor));
      if (ot.recurringPerAppMultiplier != null || ot.markup_multiplier != null) {
        constants.ONE_TIME.lawn.oneTimeMultiplier = Number(ot.recurringPerAppMultiplier ?? ot.markup_multiplier);
      }
      if (ot.treatment_multipliers && typeof ot.treatment_multipliers === 'object') {
        constants.ONE_TIME.lawn.treatmentMultipliers = {
          ...constants.ONE_TIME.lawn.treatmentMultipliers,
          ...ot.treatment_multipliers,
        };
      }
      if (ot.fert_mult != null) constants.ONE_TIME.lawn.treatmentMultipliers.fert = Number(ot.fert_mult);
      if (ot.weed_mult != null) constants.ONE_TIME.lawn.treatmentMultipliers.weed = Number(ot.weed_mult);
      if (ot.pest_mult != null) constants.ONE_TIME.lawn.treatmentMultipliers.pest = Number(ot.pest_mult);
      if (ot.fungicide_mult != null) constants.ONE_TIME.lawn.treatmentMultipliers.fungicide = Number(ot.fungicide_mult);
    }
    if (config.onetime_trenching) {
      const ot = config.onetime_trenching;
      if (ot.per_lf_dirt != null) constants.SPECIALTY.trenching.dirtPerLF = r(Number(ot.per_lf_dirt));
      if (ot.per_lf_concrete != null) constants.SPECIALTY.trenching.concretePerLF = r(Number(ot.per_lf_concrete));
      if (ot.floor != null) constants.SPECIALTY.trenching.floor = r(Number(ot.floor));
      if (ot.renewal != null) constants.SPECIALTY.trenching.renewal = r(Number(ot.renewal));
      setNumber(constants.SPECIALTY.trenching, 'concretePctBase', ot.concretePctBase ?? ot.concrete_pct_base, Number);
      setNumber(constants.SPECIALTY.trenching, 'concretePctCage', ot.concretePctCage ?? ot.concrete_pct_cage, Number);
      setNumber(constants.SPECIALTY.trenching, 'concretePctPool', ot.concretePctPool ?? ot.concrete_pct_pool, Number);
      setNumber(constants.SPECIALTY.trenching, 'concretePctDriveway', ot.concretePctDriveway ?? ot.concrete_pct_driveway, Number);
      setNumber(constants.SPECIALTY.trenching, 'concretePctCap', ot.concretePctCap ?? ot.concrete_pct_cap, Number);
      setString(constants.SPECIALTY.trenching, 'defaultProductKey', ot.defaultProductKey ?? ot.default_product_key);
      setString(constants.SPECIALTY.trenching, 'defaultIncludedProductKey', ot.defaultIncludedProductKey ?? ot.default_included_product_key);
      setString(constants.SPECIALTY.trenching, 'defaultApplicationRate', ot.defaultApplicationRate ?? ot.default_application_rate);
      setNumber(constants.SPECIALTY.trenching, 'defaultTrenchDepthFt', ot.defaultTrenchDepthFt ?? ot.default_trench_depth_ft, Number);
      setNumber(constants.SPECIALTY.trenching, 'finishedGallonsPer10LFPerFtDepth', ot.finishedGallonsPer10LFPerFtDepth ?? ot.finished_gallons_per_10_lf_per_ft_depth, Number);
      setNumber(constants.SPECIALTY.trenching, 'defaultConcreteVolumePadPct', ot.defaultConcreteVolumePadPct ?? ot.default_concrete_volume_pad_pct, Number);
      setNumber(constants.SPECIALTY.trenching, 'productPremiumMultiplier', ot.productPremiumMultiplier ?? ot.product_premium_multiplier, Number);
      const trenchingProducts = ot.products || ot.product_costs || {};
      const applyTrenchingProductOverlay = (key, data = {}) => {
        const target = constants.SPECIALTY.trenching.products?.[key];
        if (!target || !data || typeof data !== 'object') return;
        setString(target, 'label', data.label);
        setString(target, 'activeIngredient', data.activeIngredient ?? data.active_ingredient);
        setString(target, 'chemistryType', data.chemistryType ?? data.chemistry_type);
        setString(target, 'positioning', data.positioning);
        setString(target, 'defaultWarrantyPositioning', data.defaultWarrantyPositioning ?? data.default_warranty_positioning);
        setString(target, 'warrantyRisk', data.warrantyRisk ?? data.warranty_risk);
        setString(target, 'standardConcentrationLabel', data.standardConcentrationLabel ?? data.standard_concentration_label);
        setString(target, 'highConcentrationLabel', data.highConcentrationLabel ?? data.high_concentration_label);
        setNumber(target, 'containerCost', data.containerCost ?? data.container_cost, Number);
        setNumber(target, 'containerOz', data.containerOz ?? data.container_oz, Number);
        setNumber(target, 'productOzPerFinishedGallonAtStandardRate', data.productOzPerFinishedGallonAtStandardRate ?? data.product_oz_per_finished_gallon_at_standard_rate, Number);
        setNumber(target, 'productOzPerFinishedGallonAtHighRate', data.productOzPerFinishedGallonAtHighRate ?? data.product_oz_per_finished_gallon_at_high_rate, Number);
        setStringArray(target, 'warnings', data.warnings);
      };
      ['termidor_sc', 'taurus_sc', 'bifen_it', 'talstar_p'].forEach((key) => {
        applyTrenchingProductOverlay(key, trenchingProducts[key] || ot[key]);
      });
      if (ot.applicationRates || ot.application_rates) {
        mergePlainObject(constants.SPECIALTY.trenching.applicationRates, ot.applicationRates || ot.application_rates);
      }
      if (ot.warrantyTiers || ot.warranty_tiers) {
        mergePlainObject(constants.SPECIALTY.trenching.warrantyTiers, ot.warrantyTiers || ot.warranty_tiers);
      }
    }
    if (config.onetime_boracare) {
      const bc = config.onetime_boracare;
      setNumber(constants.SPECIALTY.boraCare, 'galCost', bc.bc_gal ?? bc.galCost, Number);
      setNumber(constants.SPECIALTY.boraCare, 'coverage', bc.bc_cov ?? bc.coverage, Number);
      setNumber(constants.SPECIALTY.boraCare, 'equipCost', bc.bc_equip ?? bc.equipCost, Number);
      setNumber(constants.SPECIALTY.boraCare, 'marginDivisor', bc.marginDivisor ?? bc.margin_divisor, Number);
      setNumber(constants.SPECIALTY.boraCare, 'minJobPrice', bc.min_job_price ?? bc.minJobPrice, Number);
      setNumber(constants.SPECIALTY.boraCare, 'wallLaborSqFtPerHour', bc.wall_labor_sqft_per_hr ?? bc.wallLaborSqFtPerHour, Number);
    }
    if (config.onetime_preslab) {
      const ps = config.onetime_preslab;
      setNumber(constants.SPECIALTY.preSlabTermidor, 'bottleCost', ps.ps_btl ?? ps.bottleCost, Number);
      setNumber(constants.SPECIALTY.preSlabTermidor, 'coverage', ps.ps_cov ?? ps.coverage, Number);
      setNumber(constants.SPECIALTY.preSlabTermidor, 'equipCost', ps.ps_equip ?? ps.equipCost, Number);
      setNumber(constants.SPECIALTY.preSlabTermidor, 'marginDivisor', ps.marginDivisor ?? ps.margin_divisor, Number);
      if (ps.volumeDiscounts && typeof ps.volumeDiscounts === 'object') {
        Object.assign(constants.SPECIALTY.preSlabTermidor.volumeDiscounts, ps.volumeDiscounts);
        Object.assign(constants.SPECIALTY.preSlabTermiticide.volumeDiscounts, ps.volumeDiscounts);
      }
      if (ps.volume_discounts && typeof ps.volume_discounts === 'object') {
        Object.assign(constants.SPECIALTY.preSlabTermidor.volumeDiscounts, ps.volume_discounts);
        Object.assign(constants.SPECIALTY.preSlabTermiticide.volumeDiscounts, ps.volume_discounts);
      }
      setNumber(constants.SPECIALTY.preSlabTermidor, 'warrantyExtended', ps.warrantyExtended ?? ps.warranty_extended, money);
      const termiticide = constants.SPECIALTY.preSlabTermiticide;
      setString(termiticide, 'defaultProductKey', ps.defaultProductKey ?? ps.default_product_key);
      setNumber(termiticide, 'equipCost', ps.ps_equip ?? ps.equipCost ?? ps.equip_cost, Number);
      setNumber(termiticide, 'complianceAdminCost', ps.complianceAdminCost ?? ps.compliance_admin_cost, money);
      setNumber(termiticide, 'warrantyExtended', ps.warrantyExtended ?? ps.warranty_extended, money);
      // Contextual floors are stored as flat top-level array keys
      // (minimums_<context>) so the admin panel's inline table editor persists
      // them; a nested `minimums` / `minimums_by_context` object is still
      // accepted for back-compat.
      const flatMinimumKeyByContext = {
        standalone: 'minimums_standalone',
        builderBatch: 'minimums_builderBatch',
        sameTripAddOn: 'minimums_sameTripAddOn',
      };
      const nestedMinimumsOverlay = ps.minimums || ps.minimums_by_context;
      const nestedMinimums = nestedMinimumsOverlay && typeof nestedMinimumsOverlay === 'object' && !Array.isArray(nestedMinimumsOverlay)
        ? nestedMinimumsOverlay
        : {};
      for (const context of ['standalone', 'builderBatch', 'sameTripAddOn']) {
        const flatTiers = ps[flatMinimumKeyByContext[context]];
        const tiers = Array.isArray(flatTiers) ? flatTiers : nestedMinimums[context];
        if (!Array.isArray(tiers)) continue;
        termiticide.minimums[context] = tiers
          .map((tier) => ({
            maxSqFt: tier.maxSqFt === Infinity || tier.maxSqFt === 'Infinity' || tier.max_sqft === Infinity || tier.max_sqft === 'Infinity'
              ? 'Infinity'
              : Number(tier.maxSqFt ?? tier.max_sqft),
            floor: money(tier.floor ?? tier.minimum),
          }))
          .filter((tier) => (Number.isFinite(tier.maxSqFt) || tier.maxSqFt === Infinity || tier.maxSqFt === 'Infinity') && Number.isFinite(tier.floor));
      }
      const includeDriveOverlay = ps.includeDriveCostByContext || ps.include_drive_cost_by_context;
      if (includeDriveOverlay && typeof includeDriveOverlay === 'object' && !Array.isArray(includeDriveOverlay)) {
        for (const context of ['standalone', 'builderBatch', 'sameTripAddOn']) {
          setBoolean(termiticide.includeDriveCostByContext, context, includeDriveOverlay[context]);
        }
      }
      const productOverlays = ps.products || ps.product_costs || {};
      const productKeys = ['termidor_sc', 'taurus_sc', 'bifen_it', 'talstar_p'];
      const applyPreSlabProductOverlay = (key, data = {}) => {
        const target = termiticide.products?.[key];
        if (!target || !data || typeof data !== 'object') return;
        setString(target, 'label', data.label);
        setString(target, 'supplierSku', data.supplierSku ?? data.supplier_sku);
        setString(target, 'packageLabel', data.packageLabel ?? data.package_label);
        setString(target, 'activeIngredient', data.activeIngredient ?? data.active_ingredient);
        setString(target, 'chemistryType', data.chemistryType ?? data.chemistry_type);
        setString(target, 'positioning', data.positioning);
        setNumber(target, 'containerCost', data.containerCost ?? data.container_cost ?? data.bottleCost ?? data.bottle_cost, Number);
        setNumber(target, 'containerOz', data.containerOz ?? data.container_oz ?? data.bottleOz ?? data.bottle_oz, Number);
        setNumber(target, 'productOzPer10SqFt', data.productOzPer10SqFt ?? data.product_oz_per_10_sqft, Number);
        setNumber(target, 'marginDivisor', data.marginDivisor ?? data.margin_divisor, Number);
        setBoolean(target, 'requiresLabelConfirmation', data.requiresLabelConfirmation ?? data.requires_label_confirmation);
        setBoolean(target, 'requiresCertificateOfCompliance', data.requiresCertificateOfCompliance ?? data.requires_certificate_of_compliance);
        setStringArray(target, 'warnings', data.warnings);
      };
      productKeys.forEach((key) => {
        applyPreSlabProductOverlay(key, productOverlays[key] || ps[key]);
      });
      applyPreSlabProductOverlay('termidor_sc', {
        containerCost: ps.termidor_sc_container_cost ?? ps.termidorContainerCost ?? ps.ps_btl ?? ps.bottleCost,
        containerOz: ps.termidor_sc_container_oz ?? ps.termidorContainerOz,
        productOzPer10SqFt: ps.termidor_sc_product_oz_per_10_sqft,
      });
    }
    if (config.onetime_exclusion) {
      const ex = config.onetime_exclusion;
      if (ex.simple) constants.SPECIALTY.exclusion.perPoint.simple = r(ex.simple);
      if (ex.moderate) constants.SPECIALTY.exclusion.perPoint.moderate = r(ex.moderate);
      if (ex.advanced) constants.SPECIALTY.exclusion.perPoint.advanced = r(ex.advanced);
      if (ex.specialty_minimum) constants.SPECIALTY.exclusion.perPoint.specialtyMinimum = r(ex.specialty_minimum);
      if (ex.inspection) constants.SPECIALTY.exclusion.inspectionFee = r(ex.inspection);
      if (Array.isArray(ex.minimums_by_home_sqft)) {
        constants.SPECIALTY.exclusion.minimumsByHomeSqFt = ex.minimums_by_home_sqft.map(b => ({
          maxSqFt: b.max_sqft === null || b.max_sqft === 'Infinity' ? Infinity : Number(b.max_sqft),
          minimum: r(b.minimum),
          customRecommended: !!b.custom_recommended,
        }));
      }
      if (ex.story_multipliers && typeof ex.story_multipliers === 'object') {
        for (const [k, v] of Object.entries(ex.story_multipliers)) {
          if (constants.SPECIALTY.exclusion.storyMultipliers[k] !== undefined) {
            constants.SPECIALTY.exclusion.storyMultipliers[k] = Number(v);
          }
        }
      }
      if (ex.roof_multipliers && typeof ex.roof_multipliers === 'object') {
        for (const [k, v] of Object.entries(ex.roof_multipliers)) {
          if (constants.SPECIALTY.exclusion.roofMultipliers[k] !== undefined) {
            constants.SPECIALTY.exclusion.roofMultipliers[k] = Number(v);
          }
        }
      }
      if (ex.construction_multipliers && typeof ex.construction_multipliers === 'object') {
        for (const [k, v] of Object.entries(ex.construction_multipliers)) {
          if (constants.SPECIALTY.exclusion.constructionMultipliers[k] !== undefined) {
            constants.SPECIALTY.exclusion.constructionMultipliers[k] = Number(v);
          }
        }
      }
    }
    if (config.onetime_bed_bug) {
      syncBedBugPricingConfig(config.onetime_bed_bug);
    }
    if (config.onetime_flea) {
      const flea = config.onetime_flea;
      const target = constants.SPECIALTY.flea;
      const initial = flea.initial || {};
      const followUp = flea.followUp || flea.followup || {};
      setNumber(target.initial, 'base', initial.base ?? flea.initial_base, money);
      setNumber(target.initial, 'floor', initial.floor ?? flea.initial_floor, money);
      setNumber(target.followUp, 'base', followUp.base ?? flea.followup_base ?? flea.followUp_base, money);
      setNumber(target.followUp, 'floor', followUp.floor ?? flea.followup_floor ?? flea.followUp_floor, money);
      const syncFleaOfferPricing = (offer) => {
        if (offer.offerKey === 'flea_knockdown_single') {
          return {
            ...offer,
            baseInitial: target.initial.base,
            floorInitial: target.initial.floor,
            baseFollowUp: 0,
            floorFollowUp: 0,
            packageFloor: target.initial.floor,
          };
        }
        if (offer.offerKey === 'flea_elimination_two_visit') {
          return {
            ...offer,
            baseInitial: target.initial.base,
            floorInitial: target.initial.floor,
            baseFollowUp: target.followUp.base,
            floorFollowUp: target.followUp.floor,
            packageFloor: target.initial.floor + target.followUp.floor,
          };
        }
        return offer;
      };

      if (Array.isArray(flea.offers)) {
        target.offers = flea.offers.map(offer => syncFleaOfferPricing({
          ...offer,
          offerKey: offer.offerKey || offer.offer_key,
          displayName: offer.displayName || offer.display_name,
          billingCadence: offer.billingCadence || offer.billing_cadence,
          visitCount: Number(offer.visitCount ?? offer.visit_count ?? 1),
          warrantyType: offer.warrantyType || offer.warranty_type,
          exteriorAddOnMode: offer.exteriorAddOnMode || offer.exterior_add_on_mode,
        })).filter(offer => offer.offerKey);
      } else if (Array.isArray(target.offers)) {
        target.offers = target.offers.map(syncFleaOfferPricing);
      }

      if (flea.complexityAdjustments && typeof flea.complexityAdjustments === 'object') {
        for (const [key, value] of Object.entries(flea.complexityAdjustments)) {
          if (!value || typeof value !== 'object') continue;
          const current = target.complexityAdjustments[key] || {};
          target.complexityAdjustments[key] = {
            initial: value.initial !== undefined ? money(value.initial) : money(current.initial || 0),
            followUp: value.followUp !== undefined || value.followup !== undefined ? money(value.followUp ?? value.followup) : money(current.followUp || 0),
          };
        }
      }

      if (flea.exterior && typeof flea.exterior === 'object') {
        setBoolean(target.exterior, 'enabled', flea.exterior.enabled);
        setNumber(target.exterior, 'maxSqFt', flea.exterior.maxSqFt ?? flea.exterior.max_sqft, Number);
        if (Array.isArray(flea.exterior.tiers)) {
          target.exterior.tiers = flea.exterior.tiers
            .map(t => ({
              min: Number(t.min),
              max: Number(t.max),
              initial: money(t.initial),
              followUp: money(t.followUp ?? t.followup),
            }))
            .filter(t => Number.isFinite(t.min) && Number.isFinite(t.max));
        }
      }

      if (flea.footprint && typeof flea.footprint === 'object') {
        if (Array.isArray(flea.footprint.initial)) {
          target.footprintAdjustments.initial = flea.footprint.initial.map(b => ({ at: Number(b.at), adj: money(b.adj) }));
        }
        if (Array.isArray(flea.footprint.followUp)) {
          target.footprintAdjustments.followUp = flea.footprint.followUp.map(b => ({ at: Number(b.at), adj: money(b.adj) }));
        }
      }

      if (flea.lot && typeof flea.lot === 'object') {
        if (Array.isArray(flea.lot.initial)) {
          target.lotAdjustments.initial = flea.lot.initial.map(b => ({ at: Number(b.at), adj: money(b.adj) }));
        }
        if (Array.isArray(flea.lot.followUp)) {
          target.lotAdjustments.followUp = flea.lot.followUp.map(b => ({ at: Number(b.at), adj: money(b.adj) }));
        }
      }
    }

    // ── Lawn Care Brackets (all 4 grass tracks) ──────────────
    // Table: lawn_pricing_brackets (grass_track, sqft_bracket, tier, monthly_price)
    // Edited via Pricing Logic UI → GET/PUT /admin/pricing-config/lawn-brackets
    if (await db.schema.hasTable('lawn_pricing_brackets')) {
      const lawnRows = await db('lawn_pricing_brackets')
        .orderBy('grass_track').orderBy('sqft_bracket').orderBy('tier');
      if (lawnRows.length) {
        const TIER_INDEX = { basic: 0, standard: 1, enhanced: 2, premium: 3 };
        const byTrack = {};
        for (const row of lawnRows) {
          const track = row.grass_track;
          const sqft = Number(row.sqft_bracket);
          const idx = TIER_INDEX[row.tier];
          if (idx === undefined) continue;
          if (!byTrack[track]) byTrack[track] = new Map();
          if (!byTrack[track].has(sqft)) {
            byTrack[track].set(sqft, [sqft, 0, 0, 0, 0]);
          }
          byTrack[track].get(sqft)[idx + 1] = r(Number(row.monthly_price));
        }
        for (const [track, bracketMap] of Object.entries(byTrack)) {
          if (!constants.LAWN_BRACKETS[track]) continue;
          const sorted = [...bracketMap.values()].sort((a, b) => a[0] - b[0]);
          // Drop the sqft=0 seed row (lookup uses first bracket ≥ target)
          const filtered = sorted[0]?.[0] === 0 ? sorted.slice(1) : sorted;
          if (filtered.length) constants.LAWN_BRACKETS[track] = filtered;
        }
      }
    }

    assertValidPestPricingConfig(constants);

    _lastSync = Date.now();
    console.log(`[pricing-engine] Synced ${Object.keys(config).length} pricing configs from DB`);
    return true;
  } catch (err) {
    restorePricingConstants(constantsSnapshot);
    console.error('[pricing-engine] DB sync failed, using defaults:', err.message);
    return false;
  }
}

function needsSync() {
  return Date.now() - _lastSync > SYNC_INTERVAL;
}

function invalidatePricingConfigCache() {
  _lastSync = 0;
}

module.exports = {
  syncConstantsFromDB,
  needsSync,
  invalidatePricingConfigCache,
  validatePestPricingConfig,
  assertValidPestPricingConfig,
};
