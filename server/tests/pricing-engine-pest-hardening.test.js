const {
  calculatePropertyProfile,
  generateEstimate,
  quickQuote,
  pricePestControl,
  pricePestInitialRoach,
  priceOneTimePest,
  priceGermanRoach,
  priceWDO,
  priceFlea,
  priceWasp,
  priceStingingInsect,
  normalizePestFrequency,
  normalizePestPricingVersion,
  normalizeRoachType,
  normalizePestPropertyType,
  resolvePestFootprint,
  determineWaveGuardTier,
  getEffectiveDiscount,
  applyDiscount,
  constants,
  validatePestPricingConfig,
  syncConstantsFromDB,
} = require('../services/pricing-engine');

function property(overrides = {}) {
  return calculatePropertyProfile({
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'moderate' },
    ...overrides,
  });
}

describe('pest-control pricing hardening', () => {
  test('protocol recurring pest example A remains unchanged', () => {
    const line = pricePestControl(property(), {
      frequency: 'quarterly',
      roachType: 'none',
    });

    expect(line).toEqual(expect.objectContaining({
      footprintAdj: 0,
      additionalAdj: 0,
      propAdj: 0,
      basePrice: 117,
      roachAddOn: 0,
      freqMult: 1,
      visitsPerYear: 4,
      perApp: 117,
      annual: 468,
      monthly: 39,
      marginFloorOk: true,
      requiresManualReview: false,
    }));
    expect(line.costs.materialPerVisit).toBeCloseTo(6.67, 2);
    expect(line.costs.onSiteLaborCost).toBeCloseTo(14.58, 2);
    expect(line.costs.driveLaborCost).toBeCloseTo(11.67, 2);
    expect(line.costs.annualCost).toBe(183);
    expect(line.margin).toBeCloseTo(0.61, 2);
  });

  test('protocol recurring pest example B auto-attaches German roach knockdown', () => {
    const estimate = generateEstimate({
      homeSqFt: 3200,
      stories: 1,
      lotSqFt: 10000,
      propertyType: 'single_family',
      features: {
        complexity: 'complex',
        poolCage: true,
        poolCageSize: 'large',
        trees: 'heavy',
        shrubs: 'moderate',
        nearWater: true,
      },
      services: { pest: { frequency: 'monthly', version: 'v1', roachType: 'german' } },
    });
    const pest = estimate.lineItems.find(line => line.service === 'pest_control');
    const roach = estimate.lineItems.find(line => line.service === 'pest_initial_roach');

    expect(pest).toEqual(expect.objectContaining({
      footprintAdj: 7,
      additionalAdj: 24,
      basePrice: 148,
      roachAddOn: 0,
      freqMult: 0.70,
      visitsPerYear: 12,
      perApp: 103.60,
      annual: 1243.20,
      monthly: 103.60,
      roachType: 'german',
    }));
    expect(roach).toEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      roachType: 'german',
      price: 249,
      footprintBracket: '2500+',
    }));
  });

  test('missing and invalid pest footprints use fallback with manual-review metadata', () => {
    const missing = pricePestControl({ propertyType: 'single_family', features: {} }, {});
    const invalid = pricePestControl({ footprint: 0, propertyType: 'single_family', features: {} }, {});

    expect(missing.footprintUsed).toBe(2000);
    expect(missing.footprintSource).toBe('fallback_2000');
    expect(missing.requiresManualReview).toBe(true);
    expect(missing.manualReviewReasons).toContain('missing_pest_footprint_fallback');

    expect(invalid.footprintUsed).toBe(2000);
    expect(invalid.footprintSource).toBe('invalid_or_zero_footprint_fallback');
    expect(invalid.requiresManualReview).toBe(true);
    expect(invalid.manualReviewReasons).toContain('invalid_or_zero_pest_footprint');
  });

  test('frequency, version, roach, property type, and aliases normalize with warnings', () => {
    expect(normalizePestFrequency('bi-monthly')).toEqual(expect.objectContaining({
      frequency: 'bimonthly',
      frequencyWasDefaulted: false,
    }));
    expect(normalizePestFrequency('nonsense').frequencyWarnings).toContain('invalid_pest_frequency_defaulted_to_quarterly');
    expect(normalizePestPricingVersion('bad').pricingVersionWarnings).toContain('invalid_pest_pricing_version_defaulted_to_v1');
    expect(normalizeRoachType('palmetto').roachType).toBe('regular');
    expect(normalizeRoachType('kitchen').roachType).toBe('german');
    expect(normalizeRoachType('mystery').roachWarnings).toContain('invalid_roach_type_defaulted_to_none');
    expect(normalizePestPropertyType('single family').propertyType).toBe('single_family');
    expect(normalizePestPropertyType('warehouse').propertyTypeWarnings).toContain('invalid_property_type_defaulted_to_single_family');
  });

  test('pool-cage default, explicit sizes, attached garage, and pest age adjustment are auditable', () => {
    const base = { footprint: 2000, propertyType: 'single_family', features: {} };

    expect(pricePestControl({ ...base, features: { poolCage: true } }, {}).additionalAdj).toBe(10);
    expect(pricePestControl({ ...base, features: { poolCage: true } }, {}).warnings).toContain('pool_cage_size_missing_default_adjustment_used');
    expect(pricePestControl({ ...base, features: { poolCage: true, poolCageSize: 'bogus' } }, {}).additionalAdj).toBe(10);
    expect(pricePestControl({ ...base, features: { poolCage: true, poolCageSize: 'medium' } }, {}).additionalAdj).toBe(8);
    expect(pricePestControl({ ...base, features: { poolCage: true, poolCageSize: 'large' } }, {}).additionalAdj).toBe(12);
    expect(pricePestControl({ ...base, features: { pool: true, poolCage: false } }, {}).additionalAdj).toBe(0);

    const originalAttachedGarage = constants.PEST.additionalAdjustments.attachedGarage;
    try {
      constants.PEST.additionalAdjustments.attachedGarage = 17;
      expect(pricePestControl({ ...base, attachedGarage: true }, {}).attachedGarageAdj).toBe(17);
      expect(pricePestControl({ ...base, features: { attachedGarage: true } }, {}).attachedGarageAdj).toBe(17);
    } finally {
      constants.PEST.additionalAdjustments.attachedGarage = originalAttachedGarage;
    }

    const clamped = pricePestControl(base, { modifiers: { pestAgeAdj: 200 } });
    expect(clamped.pestAgeAdj).toBe(75);
    expect(clamped.pestAgeAdjWarnings).toContain('pest_age_adjustment_clamped');
    expect(pricePestControl(base, { modifiers: { pestAgeAdj: 'old' } }).pestAgeAdjWarnings)
      .toContain('invalid_pest_age_adjustment_defaulted_to_zero');
  });

  test('initial roach knockdown preserves scale brackets and fallback metadata', () => {
    expect(pricePestInitialRoach({ footprint: 1499 }, { roachType: 'regular' }).price).toBe(119);
    expect(pricePestInitialRoach({ footprint: 1500 }, { roachType: 'regular' }).price).toBe(139);
    expect(pricePestInitialRoach({ footprint: 2500 }, { roachType: 'regular' }).price).toBe(139);
    expect(pricePestInitialRoach({ footprint: 2501 }, { roachType: 'regular' }).price).toBe(169);
    expect(pricePestInitialRoach({ footprint: 1499 }, { roachType: 'german' }).price).toBe(169);
    expect(pricePestInitialRoach({ footprint: 1500 }, { roachType: 'german' }).price).toBe(199);
    expect(pricePestInitialRoach({ footprint: 2500 }, { roachType: 'german' }).price).toBe(199);
    expect(pricePestInitialRoach({ footprint: 2501 }, { roachType: 'german' }).price).toBe(249);

    expect(pricePestInitialRoach({ footprint: 1499 }, { roachType: 'regular', standalone: true }).price).toBe(202.50);
    expect(pricePestInitialRoach({ footprint: 1500 }, { roachType: 'regular', standalone: true }).price).toBe(239);
    expect(pricePestInitialRoach({ footprint: 2500 }, { roachType: 'regular', standalone: true }).price).toBe(239);
    expect(pricePestInitialRoach({ footprint: 1800 }, { roachType: 'regular', standalone: true })).toEqual(expect.objectContaining({
      scaleKey: 'regular_standalone',
      price: 239,
      footprintBracket: '<2501',
      margin: 0.88,
    }));
    expect(pricePestInitialRoach({ footprint: 2501 }, { roachType: 'regular', standalone: true }).price).toBe(289);

    const fallback = pricePestInitialRoach({}, { roachType: 'regular' });
    expect(fallback.footprintUsed).toBe(2000);
    expect(fallback.requiresManualReview).toBe(true);
    expect(fallback.manualReviewReasons).toContain('missing_pest_footprint_fallback');
    expect(pricePestInitialRoach({ footprint: 2000 }, { roachType: 'mystery' })).toBeNull();
  });

  test('roach routing uses normalized roach type and does not double-charge specialty German Roach', () => {
    const regular = generateEstimate({ homeSqFt: 1800, stories: 1, lotSqFt: 7500, services: { pest: { roachType: 'palmetto' } } });
    expect(regular.lineItems.filter(line => line.service === 'pest_initial_roach')).toHaveLength(1);
    expect(regular.lineItems.find(line => line.service === 'pest_initial_roach')).toEqual(expect.objectContaining({
      roachType: 'regular',
      autoFiredFromRecurringPest: true,
      source: 'recurring_pest_roach_activity',
      standalone: false,
    }));

    const none = generateEstimate({ homeSqFt: 1800, stories: 1, lotSqFt: 7500, services: { pest: { roachType: 'none' } } });
    expect(none.lineItems.filter(line => line.service === 'pest_initial_roach')).toHaveLength(0);

    const unknown = generateEstimate({ homeSqFt: 1800, stories: 1, lotSqFt: 7500, services: { pest: { roachType: 'dragon' } } });
    expect(unknown.lineItems.find(line => line.service === 'pest_control').warnings).toContain('invalid_roach_type_defaulted_to_none');
    expect(unknown.lineItems.filter(line => line.service === 'pest_initial_roach')).toHaveLength(0);

    const specialty = generateEstimate({ homeSqFt: 2800, stories: 1, lotSqFt: 10000, services: { germanRoach: true } });
    expect(specialty.lineItems.filter(line => line.service === 'german_roach')).toHaveLength(1);
    expect(specialty.lineItems.filter(line => line.service === 'pest_initial_roach')).toHaveLength(0);
    expect(specialty.lineItems.filter(line => line.service === 'german_roach_initial')).toHaveLength(0);
    expect(specialty.summary.oneTimeTotal).toBe(0);
    expect(specialty.summary.specialtyTotal).toBe(350);
    expect(specialty.summary.year1Total).toBe(350);
    expect(quickQuote({ homeSqFt: 2800, stories: 1, lotSqFt: 10000, services: { germanRoach: true } }).services).toContainEqual(
      expect.objectContaining({ name: 'german_roach', price: 350 })
    );

    const directDuplicate = generateEstimate({
      homeSqFt: 1800,
      stories: 1,
      lotSqFt: 7500,
      services: {
        pest: { roachType: 'regular' },
        pestInitialRoach: { roachType: 'regular' },
      },
    });
    expect(directDuplicate.lineItems.filter(line => line.service === 'pest_initial_roach')).toHaveLength(1);
    expect(directDuplicate.pricingMetadata).toEqual(expect.objectContaining({
      skippedDuplicateRoachLine: true,
      skippedReason: 'recurring_pest_initial_roach_already_covers_regular_roach',
    }));

    const germanOverlap = generateEstimate({
      homeSqFt: 2800,
      stories: 1,
      lotSqFt: 10000,
      services: {
        pest: { roachType: 'german' },
        germanRoach: true,
      },
    });
    expect(germanOverlap.pricingMetadata.manualReviewReasons).toContain('german_roach_initial_and_cleanout_both_selected');
    expect(germanOverlap.lineItems.find(line => line.service === 'german_roach')).toEqual(expect.objectContaining({
      requiresManualReview: true,
      manualReviewReasons: expect.arrayContaining(['german_roach_initial_and_cleanout_both_selected']),
    }));
  });

  test('roach specialty and initial lines are excluded from percentage discounts', () => {
    const silver = determineWaveGuardTier(['pest_control', 'lawn_care']);
    ['pest_initial_roach', 'german_roach', 'german_roach_initial'].forEach((serviceKey) => {
      const discount = getEffectiveDiscount(serviceKey, silver, {
        isRecurringCustomer: true,
        isOneTimeService: true,
      });
      expect(discount.effectiveDiscount).toBe(0);
      expect(discount.appliedDiscounts).toContainEqual(expect.objectContaining({ type: 'exclusion' }));
      expect(discount.appliedDiscounts).not.toContainEqual(expect.objectContaining({ type: 'waveguard' }));
      expect(discount.appliedDiscounts).not.toContainEqual(expect.objectContaining({ type: 'recurring_customer_one_time_perk' }));
    });

    const recurringRoach = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      recurringCustomer: true,
      services: { pest: { frequency: 'quarterly', roachType: 'regular' } },
    });
    const initialRoach = recurringRoach.lineItems.find(line => line.service === 'pest_initial_roach');
    expect(initialRoach.priceAfterDiscount).toBe(initialRoach.price);
    expect(initialRoach.discount.appliedDiscounts).toContainEqual(expect.objectContaining({ type: 'exclusion' }));

    const germanCleanout = generateEstimate({
      homeSqFt: 2800,
      stories: 1,
      lotSqFt: 10000,
      recurringCustomer: true,
      services: { germanRoach: true },
    });
    const germanLine = germanCleanout.lineItems.find(line => line.service === 'german_roach');
    expect(germanLine.priceAfterDiscount).toBe(germanLine.price);
    expect(germanLine.totalAfterDiscount ?? germanLine.total).toBe(350);
    expect(germanLine.discount.appliedDiscounts).toContainEqual(expect.objectContaining({ type: 'exclusion' }));
    expect(germanCleanout.summary.specialtyTotal).toBe(350);
  });

  test('one-time pest protocol example and invalid recurring baseline guard are stable', () => {
    const p = property();
    const result = priceOneTimePest(p, { urgency: 'SOON', isRecurringCustomer: true });

    expect(result).toEqual(expect.objectContaining({
      basePrice: 117,
      baseSource: 'computed_quarterly_baseline',
      preUrgencyPrice: 257,
      urgencyMultiplier: 1.25,
      subtotalBeforeRecurringCustomerDiscount: 321,
      price: 273,
      recurringCustomerDiscountAmount: 48,
    }));

    const guarded = priceOneTimePest(p, { recurringPestPerApp: 'bad' });
    expect(guarded.baseSource).toBe('computed_quarterly_baseline');
    expect(guarded.warnings).toContain('invalid_recurring_pest_per_app_ignored');
  });

  test('German Roach severity tiers and WDO boundaries preserve valid pricing', () => {
    // Footprint no longer factors in; severity drives the all-in flat price.
    expect(priceGermanRoach({ footprint: 2800 })).toEqual(expect.objectContaining({
      source: 'german_roach_cleanout_selected',
      pricingModel: 'german_roach_severity_tier_cleanout',
      legacyPricingModel: 'german_roach_three_visit_cleanout',
      severity: 'light',
      severityWasDefaulted: true,
      price: 350,
      setupCharge: 0,
      total: 350,
      visits: 2,
      label: 'German Roach Cleanout — 2 Visit Program',
    }));
    expect(priceGermanRoach({ footprint: 800 }, { severity: 'medium' })).toEqual(expect.objectContaining({
      severity: 'moderate',
      severityWasDefaulted: false,
      price: 450,
      total: 450,
      visits: 3,
    }));
    expect(priceGermanRoach({ footprint: 5500 }, { severity: 'heavy' })).toEqual(expect.objectContaining({
      severity: 'heavy',
      price: 550,
      total: 550,
      visits: 4,
    }));
    // 'severe' collapses into the heavy tier.
    expect(priceGermanRoach({}, { severity: 'severe' })).toEqual(expect.objectContaining({
      severity: 'heavy',
      price: 550,
      visits: 4,
    }));

    expect(priceWDO({ footprint: 2500 }).price).toBe(175);
    expect(priceWDO({ footprint: 2501 }).price).toBe(200);
    expect(priceWDO({ footprint: 3500 }).price).toBe(200);
    expect(priceWDO({ footprint: 3501 }).price).toBe(225);
    const fallback = priceWDO({});
    expect(fallback.price).toBe(175);
    expect(fallback.requiresManualReview).toBe(true);
  });

  test('flea exterior area source handling is surfaced at top level', () => {
    const confirmed = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });
    expect(confirmed.areaSource).toBe('CONFIRMED_SQ_FT');
    expect(confirmed.requiresManualReview).toBe(false);

    const ai = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'AI_ESTIMATE',
    });
    expect(ai.total).toBe(505);
    expect(ai.warnings).toContain('flea_exterior_area_ai_estimate_needs_confirmation');
    expect(ai.requiresManualReview).toBe(true);

    const unknown = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'UNKNOWN',
    });
    expect(unknown.adjustments.exteriorArea.total).toBe(0);
    expect(unknown.requiresManualReview).toBe(true);

    const custom = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      fleaExteriorAreaSqFt: 25000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });
    expect(custom.requiresCustomQuote).toBe(true);
    expect(custom.requiresManualReview).toBe(true);
  });

  test('Wasp helper centralizes bundled one-nest policy without zeroing high-risk removals', () => {
    expect(priceWasp({}, { tier: 1, hasRecurringPest: true })).toEqual(expect.objectContaining({
      service: 'wasp',
      price: 0,
      freeWithRecurringPestApplied: true,
    }));
    const highRisk = priceWasp({}, {
      tier: 1,
      hasRecurringPest: true,
      height: 'HIGH',
      removal: 'HONEYCOMB',
    });
    expect(highRisk.price).toBeGreaterThan(0);
    expect(highRisk.freeWithRecurringPestApplied).toBe(false);
    expect(highRisk.warnings).toContain('wasp_bundle_not_applied_to_high_risk_removal');

    const legacyHighRisk = priceStingingInsect({
      species: 'PAPER_WASP',
      tier: 1,
      removal: 'HONEYCOMB',
      hasRecurringPest: true,
    });
    expect(legacyHighRisk.price).toBeGreaterThan(0);
    expect(legacyHighRisk.includedOnProgram).toBe(false);
    expect(legacyHighRisk.warnings).toContain('wasp_bundle_not_applied_to_high_risk_removal');
  });

  test('active pest pricing config validates required DB-overlay surfaces', () => {
    expect(validatePestPricingConfig(constants).valid).toBe(true);

    const original = constants.PEST.additionalAdjustments.attachedGarage;
    try {
      delete constants.PEST.additionalAdjustments.attachedGarage;
      const result = validatePestPricingConfig(constants);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('PEST.additionalAdjustments.attachedGarage is required');
    } finally {
      constants.PEST.additionalAdjustments.attachedGarage = original;
    }
  });

  test('invalid pest DB overlay is rejected and restored', async () => {
    const originalBase = constants.PEST.base;
    const db = (table) => ({
      select: jest.fn(async () => table === 'pricing_config'
        ? [{ config_key: 'pest_base', data: { base: -1, floor: 89 } }]
        : []),
      orderBy: jest.fn(function orderBy() { return this; }),
      then: (resolve) => resolve([]),
    });
    db.schema = {
      hasTable: jest.fn(async (table) => table === 'pricing_config'),
    };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(syncConstantsFromDB(db)).resolves.toBe(false);
      expect(constants.PEST.base).toBe(originalBase);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('shared footprint resolver prefers valid aliases before fallback', () => {
    expect(resolvePestFootprint({ footprintSqFt: 1800 })).toEqual(expect.objectContaining({
      footprint: 1800,
      source: 'footprintSqFt',
      wasDefaulted: false,
    }));
    expect(resolvePestFootprint({ footprint: 0, homeSqFt: 1600 })).toEqual(expect.objectContaining({
      footprint: 1600,
      source: 'homeSqFt',
      wasDefaulted: false,
    }));
    expect(resolvePestFootprint({ homeSqFt: 4000, stories: 2 })).toEqual(expect.objectContaining({
      footprint: 2000,
      source: 'homeSqFt',
      wasDefaulted: false,
    }));
    expect(resolvePestFootprint({ livingAreaSqFt: 3600, stories: 3 })).toEqual(expect.objectContaining({
      footprint: 1200,
      source: 'livingAreaSqFt',
      wasDefaulted: false,
    }));

    const directPest = pricePestControl({
      homeSqFt: 4000,
      stories: 2,
      lotSqFt: 10000,
      propertyType: 'single_family',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'moderate' },
    });
    expect(directPest.footprintUsed).toBe(2000);
    expect(directPest.footprintSource).toBe('homeSqFt');
  });

  test('generated estimates preserve explicit measured footprint over derived home footprint', () => {
    const estimate = generateEstimate({
      homeSqFt: 4000,
      footprintSqFt: 1800,
      stories: 1,
      lotSqFt: 10000,
      propertyType: 'single_family',
      services: { pest: { frequency: 'quarterly' } },
    });
    const pest = estimate.lineItems.find(line => line.service === 'pest_control');

    expect(estimate.property.footprint).toBe(1800);
    expect(pest.footprintUsed).toBe(1800);
    expect(pest.footprintSource).toBe('footprint');
    expect(pest.footprintAdj).toBe(-4);
  });

  test('footprints under 1750 get the full -$5 bracket', () => {
    const pest = pricePestControl(property({ homeSqFt: 1635 }), {
      frequency: 'quarterly',
      roachType: 'none',
    });

    expect(pest.footprintAdj).toBe(-5);
    expect(pest.basePrice).toBe(112);
    expect(pest.perApp).toBe(112);
  });
});
