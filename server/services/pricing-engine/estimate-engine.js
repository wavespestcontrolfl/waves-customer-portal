// ============================================================
// estimate-engine.js — Waves Estimate Engine (Orchestrator)
// Combines property calculation, service pricing, and discounts
// into a complete customer estimate
// ============================================================
const { GLOBAL, WAVEGUARD, ZONES, URGENCY } = require('./constants');
const { calculatePropertyProfile } = require('./property-calculator');
const { deriveModifiers, deriveNotes } = require('./modifiers');
const {
  pricePestControl, priceLawnCare, priceTreeShrub, pricePalmInjection,
  priceMosquito, priceTermiteBait, priceRodentBait, priceRodentTrapping,
  priceOneTimePest, priceOneTimeLawn, priceOneTimeMosquito,
  priceTrenching, priceBoraCare, pricePreSlabTermidor,
  priceGermanRoach, priceBedBug, priceWDO, priceFlea,
  priceTopDressing, priceDethatching,
} = require('./service-pricing');
const {
  determineWaveGuardTier, getEffectiveDiscount, applyDiscount, validateEstimateDiscounts,
} = require('./discount-engine');

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
  // Prefer derived zone multiplier (supports A/B/C/D) with legacy ZONES fallback
  const zone = ZONES[input.zone] || ZONES.UNKNOWN;
  const zoneMult = modifiers.zoneMult || zone.multiplier;

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
    result.annual = Math.round(result.annual * zoneMult);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    result.perApp = Math.round(result.annual / result.visitsPerYear * 100) / 100;
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
    result.annual = Math.round(result.annual * zoneMult);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
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
  if (services.bedBug) {
    const result = priceBedBug(
      services.bedBug.rooms || 1,
      services.bedBug.method || 'chemical',
      property.footprint
    );
    lineItems.push(result);
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

  // ── 4. Determine WaveGuard tier ────────────────────────────
  const waveGuardTier = determineWaveGuardTier(activeServiceKeys);

  // ── 5. Apply discounts to each line item ───────────────────
  const paymentMethod = input.paymentMethod || 'card';

  for (const item of lineItems) {
    const serviceKey = resolveDiscountKey(item);
    const isOneTime = !item.annual; // One-time services have .price, not .annual

    const discount = getEffectiveDiscount(serviceKey, waveGuardTier, {
      promoDiscount: input.promoDiscount || 0,
      frequencyDiscount: item.freqMult ? (1 - item.freqMult) : 0,
      isRecurringCustomer,
      isOneTimeService: isOneTime,
      paymentMethod,
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
    zone: { key: input.zone || 'UNKNOWN', ...zone },

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

    // Payment
    paymentMethod,
    achSavings: paymentMethod === 'us_bank_account'
      ? Math.round(year1Total * 0.03)
      : 0,

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
  if (item.maxWaveGuardDiscount !== undefined && item.maxWaveGuardDiscount !== null) {
    return `${item.service}_capped`;
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
