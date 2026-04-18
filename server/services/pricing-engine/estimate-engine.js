// ============================================================
// estimate-engine.js — Waves Estimate Engine (Orchestrator)
// Combines property calculation, service pricing, and discounts
// into a complete customer estimate
// ============================================================
const { GLOBAL, WAVEGUARD, ZONES, URGENCY, SPECIALTY } = require('./constants');
const { calculatePropertyProfile } = require('./property-calculator');
const { deriveModifiers, deriveNotes, zoneMultiplier } = require('./modifiers');
const {
  pricePestControl, priceLawnCare, priceTreeShrub, pricePalmInjection,
  priceMosquito, priceTermiteBait, priceRodentBait, priceRodentTrapping,
  priceOneTimePest, priceOneTimeLawn, priceOneTimeMosquito,
  priceTrenching, priceBoraCare, pricePreSlabTermidor,
  priceGermanRoach, priceBedBug, priceWDO, priceFlea,
  priceTopDressing, priceDethatching,
  pricePlugging, priceFoamDrill, priceStingingInsect, priceExclusion, priceRodentGuarantee,
  calculatePluggingPrice, calculateFoamPrice, calculateStingingPrice,
  calculateExclusionPrice, calculateRodentGuaranteeCombo,
} = require('./service-pricing');
const {
  determineWaveGuardTier, getEffectiveDiscount, applyDiscount, validateEstimateDiscounts,
} = require('./discount-engine');

// ── Startup assertion — zone alignment ────────────────────────
// Fail-fast at module load if constants.ZONES drifts from
// modifiers.zoneMultiplier(). Without this, future edits to one
// source and not the other would silently misprice quotes until
// a regression test happened to notice.
for (const zone of ['A', 'B', 'C', 'D']) {
  const cz = ZONES[zone];
  if (!cz) {
    throw new Error(`[pricing-engine startup] Zone ${zone} missing from constants.ZONES`);
  }
  const mz = zoneMultiplier(zone);
  if (Math.abs(cz.multiplier - mz) > 0.0001) {
    throw new Error(
      `[pricing-engine startup] Zone ${zone} multiplier mismatch: ` +
      `constants.ZONES=${cz.multiplier}, modifiers.zoneMultiplier=${mz}`
    );
  }
}

// ── Generate Complete Estimate ────────────────────────────────
function generateEstimate(input) {
  // ── 1. Calculate property profile ──────────────────────────
  const property = calculatePropertyProfile({
    homeSqFt: input.homeSqFt,
    stories: input.stories,
    lotSqFt: input.lotSqFt,
    lawnSqFt: input.lawnSqFt,
    bedArea: input.bedArea,
    propertyType: input.propertyType,
    features: input.features || {},
    // v2 enriched fields (optional — null-safe)
    yearBuilt: input.yearBuilt,
    constructionMaterial: input.constructionMaterial,
    foundationType: input.foundationType,
    roofType: input.roofType,
    nearWater: input.nearWater,
    waterDistance: input.waterDistance,
    serviceZone: input.serviceZone || input.zone,
    isHOA: input.isHOA,
    hoaFee: input.hoaFee,
    isRental: input.isRental,
    isNewHomeowner: input.isNewHomeowner,
    fenceType: input.fenceType,
    outbuildingCount: input.outbuildingCount,
    attachedGarage: input.attachedGarage,
  });

  // ── 2. Derive property-driven pricing modifiers (v2 port) ─
  const modifiers = deriveModifiers(property);
  const structuralNotes = deriveNotes(property);

  // ── 3. Zone multiplier ────────────────────────────────────
  // Strict use of modifiers.zoneMult (deriveModifiers always returns a value —
  // defaults to 1.0 for unknown zones). constants.ZONES is no longer consulted
  // here; it's now only a reference table verified against modifiers at startup.
  const zoneMult = modifiers.zoneMult;
  if (typeof zoneMult !== 'number') {
    throw new Error(`No zone multiplier derived for zone ${input.zone}`);
  }

  // ── 3. Price each requested service ────────────────────────
  const services = input.services || {};
  const lineItems = [];
  const activeServiceKeys = [];

  // Pest Control
  if (services.pest) {
    const result = pricePestControl(property, {
      frequency: services.pest.frequency || 'quarterly',
      pricingVersion: services.pest.version || 'v1',
      roachType: services.pest.roachType || 'none',
      modifiers,
    });
    // 2-decimal rounding matches v2 (pricing-engine-v2.js:758-760).
    result.annual = Math.round(result.annual * zoneMult * 100) / 100;
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    result.perApp = Math.round(result.annual / result.visitsPerYear * 100) / 100;
    if (Array.isArray(result.tiers)) {
      result.tiers = result.tiers.map(t => {
        const zAnn = Math.round(t.annual * zoneMult * 100) / 100;
        return {
          ...t,
          perApp: Math.round(t.perApp * zoneMult * 100) / 100,
          annual: zAnn,
          monthly: Math.round(zAnn / 12 * 100) / 100,
        };
      });
    }
    lineItems.push(result);
    activeServiceKeys.push('pest_control');
  }

  // Lawn Care
  if (services.lawn) {
    const result = priceLawnCare(property, {
      track: services.lawn.track || 'st_augustine',
      tier: services.lawn.tier || 'enhanced',
      shadeClassification: services.lawn.shadeClassification || 'FULL_SUN',
    });
    // Lawn brackets are zone-agnostic in v2's calcLawn (pricing-engine-v2.js:557+);
    // dropping the zone mult here preserves parity so Session 11a's engine swap
    // doesn't silently raise lawn prices on Zone B/C/D customers.
    lineItems.push(result);
    activeServiceKeys.push('lawn_care');
  }

  // Tree & Shrub
  if (services.treeShrub) {
    const result = priceTreeShrub(property, {
      tier: services.treeShrub.tier || 'enhanced',
      access: services.treeShrub.access || 'easy',
      treeCount: services.treeShrub.treeCount || property.features?.treeCount || 0,
    });
    result.annual = Math.round(result.annual * zoneMult);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    lineItems.push(result);
    activeServiceKeys.push('tree_shrub');
  }

  // Palm Injection
  if (services.palm) {
    const result = pricePalmInjection(property, {
      palmCount: services.palm.palmCount || 1,
      treatmentType: services.palm.treatmentType || 'combo',
      customPricePerPalm: services.palm.customPricePerPalm,
    });
    result.annual = Math.round(result.annual * zoneMult);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    lineItems.push(result);
    // Palm does NOT add to activeServiceKeys for tier determination
  }

  // Mosquito
  if (services.mosquito) {
    const result = priceMosquito(property, {
      tier: services.mosquito.tier || 'silver',
      modifiers,
    });
    result.annual = Math.round(result.annual * zoneMult);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    lineItems.push(result);
    activeServiceKeys.push('mosquito');
  }

  // Termite Bait
  if (services.termite) {
    const result = priceTermiteBait(property, {
      system: services.termite.system || 'trelona',
      monitoringTier: services.termite.monitoringTier || 'basic',
      modifiers,
    });
    result.annual = Math.round(result.annual * zoneMult);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    lineItems.push(result);
    activeServiceKeys.push('termite_bait');
  }

  // Rodent Bait
  if (services.rodentBait) {
    const result = priceRodentBait(property, { modifiers });
    result.annual = Math.round(result.annual * zoneMult);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    lineItems.push(result);
    // Rodent does NOT add to activeServiceKeys for tier determination
  }

  // ── One-Time Services ──────────────────────────────────────
  const isRecurringCustomer = activeServiceKeys.length > 0;

  if (services.oneTimePest) {
    const result = priceOneTimePest(property, {
      urgency: services.oneTimePest.urgency || 'NONE',
      afterHours: services.oneTimePest.afterHours || false,
      isRecurringCustomer,
      recurringPestPerApp: services.pest ? lineItems.find(l => l.service === 'pest_control')?.perApp : null,
      roachType: services.oneTimePest.roachType || 'none',
    });
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }

  if (services.oneTimeLawn) {
    const result = priceOneTimeLawn(property, {
      treatmentType: services.oneTimeLawn.treatmentType || 'weed',
      urgency: services.oneTimeLawn.urgency || 'NONE',
      afterHours: services.oneTimeLawn.afterHours || false,
      isRecurringCustomer,
      hasRecurringLawn: !!services.lawn,
    });
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }

  if (services.oneTimeMosquito) {
    const result = priceOneTimeMosquito(property);
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }

  // Specialty services
  if (services.rodentTrapping) {
    const result = priceRodentTrapping(property);
    lineItems.push(result);
  }
  if (services.trenching) {
    const result = priceTrenching(property);
    lineItems.push(result);
  }
  if (services.germanRoach) {
    const result = priceGermanRoach(property);
    lineItems.push(result);
  }
  if (services.boraCare) {
    const result = priceBoraCare(services.boraCare.atticSqFt || property.footprint);
    lineItems.push(result);
  }
  if (services.preSlab) {
    const result = pricePreSlabTermidor(
      services.preSlab.slabSqFt || property.footprint,
      services.preSlab.volumeDiscount || 'none'
    );
    if (services.preSlab.warranty === 'EXTENDED') {
      result.price += SPECIALTY.preSlabTermidor.warrantyExtended;
      result.warrantyAdd = SPECIALTY.preSlabTermidor.warrantyExtended;
    }
    lineItems.push(result);
  }
  if (services.bedBug) {
    const rooms = services.bedBug.rooms || 1;
    const method = services.bedBug.method || 'chemical';
    const result = priceBedBug(rooms, method, property.footprint);
    if (result.methods) {
      // 'both' composite → split into two flat line items for pipeline
      result.methods.forEach(m => lineItems.push({
        service: m.method === 'Heat' ? 'bed_bug_heat' : 'bed_bug_chemical',
        rooms,
        price: m.price,
        detail: m.detail,
      }));
    } else {
      lineItems.push(result);
    }
  }
  if (services.wdo) {
    const result = priceWDO(property.footprint);
    lineItems.push(result);
  }
  if (services.flea) {
    const result = priceFlea(property);
    lineItems.push(result);
  }
  if (services.topDressing) {
    const result = priceTopDressing(
      property.lawnSqFt,
      services.topDressing.depth || 'eighth',
      !!services.lawn
    );
    lineItems.push(result);
  }
  if (services.dethatching) {
    const result = priceDethatching(property.lawnSqFt);
    lineItems.push(result);
  }
  if (services.plugging) {
    const result = pricePlugging(
      services.plugging.area || property.lawnSqFt,
      services.plugging.spacing || 12,
      {
        urgency: services.plugging.urgency || 'ROUTINE',
        afterHours: services.plugging.afterHours || false,
      }
    );
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }
  if (services.foam) {
    const result = priceFoamDrill(services.foam.points || 5, {
      urgency: services.foam.urgency || 'ROUTINE',
      afterHours: services.foam.afterHours || false,
    });
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }
  if (services.stinging) {
    const result = priceStingingInsect({
      species: services.stinging.species || 'PAPER_WASP',
      tier: services.stinging.tier || 2,
      removal: services.stinging.removal || 'NONE',
      aggressive: services.stinging.aggressive || 'NO',
      height: services.stinging.height || 'GROUND',
      confined: services.stinging.confined || 'NO',
      urgency: services.stinging.urgency || 'ROUTINE',
      afterHours: services.stinging.afterHours || false,
      hasRecurringPest: !!services.pest,
    });
    if (!result.includedOnProgram) result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }
  if (services.exclusion) {
    const result = priceExclusion({
      simple: services.exclusion.simple || 0,
      moderate: services.exclusion.moderate || 0,
      advanced: services.exclusion.advanced || 0,
      waiveInspection: services.exclusion.waiveInspection || false,
      urgency: services.exclusion.urgency || 'ROUTINE',
      afterHours: services.exclusion.afterHours || false,
    });
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }
  // Rodent Guarantee fires automatically when BOTH trap + exclusion are present
  if (services.rodentTrapping && services.exclusion) {
    const exc = services.exclusion;
    if ((exc.simple || 0) + (exc.moderate || 0) + (exc.advanced || 0) > 0) {
      lineItems.push(priceRodentGuarantee());
    }
  }

  // ── Spec-version services (v2 missing-services spec, Apr 2026) ──
  if (services.rodentPlugging) {
    const result = calculatePluggingPrice(services.rodentPlugging);
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }
  if (services.termiteFoam) {
    const result = calculateFoamPrice(services.termiteFoam);
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }
  if (services.stingingV2) {
    const result = calculateStingingPrice(services.stingingV2);
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }
  if (services.exclusionV2) {
    const result = calculateExclusionPrice({
      sqft: services.exclusionV2.sqft || property.footprint,
      stories: services.exclusionV2.stories || property.stories,
      roofType: services.exclusionV2.roofType || property.roofType,
      entryPointsFound: services.exclusionV2.entryPointsFound,
      includesScreening: services.exclusionV2.includesScreening,
      constructionType: services.exclusionV2.constructionType || property.constructionMaterial,
    });
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }
  if (services.rodentGuaranteeCombo) {
    const result = calculateRodentGuaranteeCombo({
      sqft: services.rodentGuaranteeCombo.sqft || property.footprint,
      stories: services.rodentGuaranteeCombo.stories || property.stories,
      roofType: services.rodentGuaranteeCombo.roofType || property.roofType,
      entryPointsFound: services.rodentGuaranteeCombo.entryPointsFound,
      includesScreening: services.rodentGuaranteeCombo.includesScreening,
      constructionType: services.rodentGuaranteeCombo.constructionType || property.constructionMaterial,
      baitStationTier: services.rodentGuaranteeCombo.baitStationTier,
      stationCount: services.rodentGuaranteeCombo.stationCount,
      guaranteeTerm: services.rodentGuaranteeCombo.guaranteeTerm || 12,
    });
    result.price = Math.round(result.price * zoneMult);
    lineItems.push(result);
  }

  // ── 4. Determine WaveGuard tier ────────────────────────────
  const waveGuardTier = determineWaveGuardTier(activeServiceKeys);

  // ── 5. Apply discounts to each line item ───────────────────
  // paymentMethod is no longer a pricing input (ACH discount retired in an
  // earlier session) but is still echoed in the output payload below for
  // downstream card-processing-fee display.
  const paymentMethod = input.paymentMethod || 'card';

  for (const item of lineItems) {
    const serviceKey = resolveDiscountKey(item);
    const isOneTime = !item.annual; // One-time services have .price, not .annual

    const discount = getEffectiveDiscount(serviceKey, waveGuardTier, {
      isRecurringCustomer,
      isOneTimeService: isOneTime,
    });

    item.discount = discount;

    if (item.annual) {
      item.annualBeforeDiscount = item.annual;
      item.annualAfterDiscount = applyDiscount(item.annual, discount);
      item.monthlyAfterDiscount = Math.round(item.annualAfterDiscount / 12 * 100) / 100;
    } else if (item.price) {
      item.priceBeforeDiscount = item.price;
      item.priceAfterDiscount = applyDiscount(item.price, discount);
    } else if (item.total) {
      item.totalBeforeDiscount = item.total;
      item.totalAfterDiscount = applyDiscount(item.total, discount);
    }
  }

  // ── 6. Calculate totals ────────────────────────────────────
  const recurringItems = lineItems.filter(i => i.annual);
  const oneTimeItems = lineItems.filter(i => i.price && !i.annual);
  const specialtyItems = lineItems.filter(i => i.total && !i.annual);

  const recurringAnnualBefore = recurringItems.reduce((sum, i) => sum + (i.annualBeforeDiscount || 0), 0);
  const recurringAnnualAfter = recurringItems.reduce((sum, i) => sum + (i.annualAfterDiscount || i.annual || 0), 0);
  const recurringMonthlyAfter = Math.round(recurringAnnualAfter / 12 * 100) / 100;

  const oneTimeTotal = oneTimeItems.reduce((sum, i) => sum + (i.priceAfterDiscount || i.price || 0), 0);
  const specialtyTotal = specialtyItems.reduce((sum, i) => sum + (i.totalAfterDiscount || i.total || 0), 0);

  // Installation costs (termite)
  const installationTotal = recurringItems
    .filter(i => i.installation)
    .reduce((sum, i) => sum + i.installation.price, 0);

  const year1Total = recurringAnnualAfter + oneTimeTotal + specialtyTotal + installationTotal;
  const year2Total = recurringAnnualAfter; // + trenching renewal if applicable
  const trenchingRenewal = lineItems.find(i => i.service === 'trenching')?.renewal || 0;
  const year2WithRenewal = year2Total + trenchingRenewal;

  // ── 7. Validate margins ────────────────────────────────────
  const marginWarnings = validateEstimateDiscounts(lineItems, waveGuardTier);

  // ── 8. Build estimate output ───────────────────────────────
  return {
    // Property
    property,
    zone: (() => {
      const zoneKey = (input.serviceZone || input.zone || 'UNKNOWN').toUpperCase();
      const info = ZONES[zoneKey] || ZONES.UNKNOWN;
      return { key: zoneKey, name: info.name, multiplier: zoneMult };
    })(),

    // WaveGuard
    waveGuard: {
      ...waveGuardTier,
      activeServices: activeServiceKeys,
    },

    // Line items
    lineItems,

    // Summary
    summary: {
      recurringAnnualBeforeDiscount: recurringAnnualBefore,
      recurringAnnualAfterDiscount: recurringAnnualAfter,
      recurringMonthlyAfterDiscount: recurringMonthlyAfter,
      waveGuardSavings: recurringAnnualBefore - recurringAnnualAfter,
      oneTimeTotal,
      specialtyTotal,
      installationTotal,
      year1Total: Math.round(year1Total),
      year2Annual: Math.round(year2WithRenewal),
      year2Monthly: Math.round(year2WithRenewal / 12 * 100) / 100,
    },

    // Payment — a 3% processing fee is added at checkout for card payments.
    // ACH pays the quoted price. No ACH "discount" is presented anymore.
    paymentMethod,
    cardProcessingFeeRate: 0.03,
    cardProcessingFeeEstimate: Math.round(year1Total * 0.03),
    achSavings: 0,

    // Warnings
    marginWarnings,

    // Property-driven modifiers & structural notes (v2 port)
    modifiers,
    structuralNotes,

    // Metadata
    generatedAt: new Date().toISOString(),
    pricingVersion: 'v4.2',
    notes: [],
  };
}

// ── Resolve discount key from service result ──────────────────
function resolveDiscountKey(item) {
  if (item.service === 'lawn_care') {
    const tier = item.tier || 'enhanced';
    if (tier === 'enhanced' || tier === 'premium') return `lawn_care_${tier}`;
    return 'lawn_care';
  }
  return item.service;
}

// ── Quick Quote (simplified for common scenarios) ─────────────
function quickQuote(input) {
  const estimate = generateEstimate(input);
  return {
    monthly: estimate.summary.recurringMonthlyAfterDiscount,
    annual: estimate.summary.recurringAnnualAfterDiscount,
    year1: estimate.summary.year1Total,
    tier: estimate.waveGuard.tier,
    savings: estimate.summary.waveGuardSavings,
    services: estimate.lineItems.map(i => ({
      name: i.service,
      monthly: i.monthlyAfterDiscount || null,
      price: i.priceAfterDiscount || i.totalAfterDiscount || null,
    })),
  };
}

module.exports = { generateEstimate, quickQuote };
