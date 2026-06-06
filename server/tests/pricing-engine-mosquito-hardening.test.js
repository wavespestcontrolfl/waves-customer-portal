const {
  priceMosquito,
  priceOneTimeMosquito,
  resolveMosquitoTreatableArea,
  resolveMosquitoLotCategory,
} = require('../services/pricing-engine');

describe('mosquito pricing hardening', () => {
  const baseProperty = {
    lotCategory: 'QUARTER',
    mosquitoTreatableSqFt: 10000,
    features: {
      trees: 'moderate',
      complexity: 'moderate',
      pool: true,
      nearWater: false,
      irrigation: true,
    },
  };

  test('prices protocol example A with forced monthly program metadata', () => {
    const result = priceMosquito(baseProperty, { tier: 'monthly12' });

    expect(result.pressureMultiplier).toBeCloseTo(1.23, 6);
    expect(result.selectedProgram).toBe('monthly12');
    expect(result.selectedTier).toBe('monthly12');
    expect(result.recommendedProgram).toBe('seasonal9');
    expect(result.recommendedTier).toBe('seasonal9');
    expect(result.tierWasForced).toBe(true);
    expect(result.perVisit).toBe(77);
    expect(result.annual).toBe(924);
    expect(result.monthly).toBe(77);
    expect(result.tiers.find(t => t.tier === 'monthly12')).toEqual(expect.objectContaining({
      selected: true,
      recommended: false,
      isSelected: true,
      isRecommended: false,
    }));
    expect(result.tiers.find(t => t.tier === 'seasonal9')).toEqual(expect.objectContaining({
      selected: false,
      recommended: true,
      pressureRecommended: true,
    }));
  });

  test('prices protocol example B with graduated water replacing binary nearWater', () => {
    const result = priceMosquito({
      lotCategory: 'HALF',
      mosquitoTreatableSqFt: 25000,
      features: {
        trees: 'heavy',
        complexity: 'complex',
        nearWater: true,
        irrigation: true,
      },
    }, {
      modifiers: { mosquitoWaterMult: 1.20 },
      stationCount: 4,
      dunkCount: 2,
    });

    expect(result.pressureMultiplier).toBeCloseTo(1.656, 6);
    expect(result.recommendedProgram).toBe('monthly12');
    expect(result.selectedProgram).toBe('monthly12');
    expect(result.perVisit).toBe(116);
    expect(result.annual).toBe(1556);
    expect(result.monthly).toBe(129.67);
    expect(result.addOns.annualAddOns).toBe(164);
  });

  test('recurring add-ons are added once annually', () => {
    const result = priceMosquito({
      lotCategory: 'SMALL',
      mosquitoTreatableSqFt: 6000,
      features: {},
    }, {
      tier: 'seasonal9',
      stationCount: 1,
      dunkCount: 1,
    });

    expect(result.perVisit).toBe(66);
    expect(result.visits).toBe(9);
    expect(result.addOns.stationAddOn).toBe(39);
    expect(result.addOns.dunkAddOn).toBe(4);
    expect(result.annual).toBe(66 * 9 + 39 + 4);
  });

  test('normalizes mosquito program aliases, whitespace, and unknown program behavior', () => {
    const property = { lotCategory: 'SMALL', mosquitoTreatableSqFt: 6000, features: {} };

    expect(priceMosquito(property, { tier: ' monthly12 ' })).toEqual(expect.objectContaining({
      selectedProgram: 'monthly12',
      visits: 12,
    }));
    expect(priceMosquito(property, { tier: 'Seasonal' })).toEqual(expect.objectContaining({
      selectedProgram: 'seasonal9',
      visits: 9,
    }));
    expect(priceMosquito(property, { tier: 'bronze' })).toEqual(expect.objectContaining({
      selectedProgram: 'seasonal9',
    }));
    expect(priceMosquito(property, { tier: 'scion' })).toEqual(expect.objectContaining({
      selectedProgram: 'monthly12',
    }));
    expect(priceMosquito(property, { tier: 'platinum' })).toEqual(expect.objectContaining({
      selectedProgram: 'monthly12',
    }));
    expect(() => priceMosquito(property, { tier: 'not_a_program' })).toThrow(/Unknown mosquito program/);
  });

  test('normalizes water multiplier and avoids double-counting nearWater', () => {
    const nearWaterOnly = priceMosquito({
      lotCategory: 'SMALL',
      mosquitoTreatableSqFt: 6000,
      features: { nearWater: true },
    }, { tier: 'seasonal9' });
    const waterOnly = priceMosquito({
      lotCategory: 'SMALL',
      mosquitoTreatableSqFt: 6000,
      features: {},
    }, { tier: 'seasonal9', modifiers: { mosquitoWaterMult: 1.20 } });
    const both = priceMosquito({
      lotCategory: 'SMALL',
      mosquitoTreatableSqFt: 6000,
      features: { nearWater: true },
    }, { tier: 'seasonal9', modifiers: { mosquitoWaterMult: 1.20 } });
    const invalid = priceMosquito({
      lotCategory: 'SMALL',
      mosquitoTreatableSqFt: 6000,
      features: {},
    }, { tier: 'seasonal9', modifiers: { mosquitoWaterMult: 'bad' } });
    const belowOne = priceMosquito({
      lotCategory: 'SMALL',
      mosquitoTreatableSqFt: 6000,
      features: {},
    }, { tier: 'seasonal9', modifiers: { mosquitoWaterMult: 0.75 } });
    const capped = priceMosquito({
      lotCategory: 'ACRE',
      mosquitoTreatableSqFt: 43560,
      features: { trees: 'heavy', complexity: 'complex', pool: true, nearWater: true, irrigation: true },
    }, { tier: 'monthly12', modifiers: { mosquitoWaterMult: 99 } });

    expect(nearWaterOnly.pressureMultiplier).toBeCloseTo(1.10, 6);
    expect(waterOnly.pressureMultiplier).toBeCloseTo(1.20, 6);
    expect(both.pressureMultiplier).toBeCloseTo(1.20, 6);
    expect(invalid.waterMultiplier).toBe(1);
    expect(invalid.warnings).toContain('invalid_mosquito_water_multiplier_defaulted');
    expect(belowOne.waterMultiplier).toBe(1);
    expect(belowOne.warnings).toContain('mosquito_water_multiplier_below_one_defaulted');
    expect(capped.waterMultiplier).toBe(2);
    expect(capped.pressureMultiplier).toBe(2);
    expect(capped.warnings).toContain('mosquito_water_multiplier_clamped');
    expect(capped.manualReviewReasons).toContain('pressure_cap_reached');
  });

  test('resolves mosquito treatable area sources and lot category guardrail metadata', () => {
    expect(resolveMosquitoTreatableArea({
      mosquitoTreatableSqFt: 14000,
      lotSqFt: 20000,
    })).toEqual(expect.objectContaining({
      mosquitoTreatableSqFt: 14000,
      source: 'explicit_mosquito_treatable_sqft',
      confidence: 'high',
      requiresManualReview: false,
    }));

    expect(resolveMosquitoTreatableArea({
      lotSqFt: 14000,
      footprint: 2500,
      hardscape: 1500,
    })).toEqual(expect.objectContaining({
      mosquitoTreatableSqFt: 10000,
      source: 'computed_lot_minus_footprint_hardscape',
      confidence: 'medium',
    }));

    expect(resolveMosquitoTreatableArea({ mosquitoLotCategory: 'HALF' })).toEqual(expect.objectContaining({
      mosquitoTreatableSqFt: 25000,
      source: 'lot_category_proxy',
      requiresManualReview: true,
      manualReviewReasons: expect.arrayContaining(['missing_mosquito_treatable_area']),
    }));

    expect(resolveMosquitoTreatableArea({})).toEqual(expect.objectContaining({
      mosquitoTreatableSqFt: 0,
      source: 'missing_or_zero_fallback',
      missingAreaData: true,
      requiresManualReview: true,
    }));

    expect(resolveMosquitoTreatableArea({
      mosquitoTreatableSqFt: 0,
      mosquitoLotCategory: 'ACRE',
    })).toEqual(expect.objectContaining({
      mosquitoTreatableSqFt: 0,
      source: 'missing_or_zero_fallback',
      missingAreaData: true,
      requiresManualReview: true,
    }));

    const category = resolveMosquitoLotCategory({
      lotCategory: 'ACRE',
      lotSqFt: 6000,
      footprint: 0,
      hardscape: 0,
    });
    expect(category).toEqual(expect.objectContaining({
      lotCategory: 'HALF',
      originalLotCategory: 'SMALL',
      adjustedLotCategory: 'HALF',
      lotCategoryGuardrailApplied: true,
      manualReviewReasons: expect.arrayContaining(['mosquito_lot_category_guardrail_applied']),
    }));
  });

  test('recurring pricing uses resolved treatable area and flags missing area', () => {
    const result = priceMosquito({
      mosquitoLotCategory: 'HALF',
      features: {},
    }, { tier: 'seasonal9' });

    expect(result.lotCategory).toBe('HALF');
    expect(result.mosquitoTreatableSqFt).toBe(25000);
    expect(result.mosquitoTreatableSqFtSource).toBe('lot_category_proxy');
    expect(result.requiresManualReview).toBe(true);
    expect(result.manualReviewReasons).toContain('missing_mosquito_treatable_area');
  });

  test('one-time protocol examples and missing-area metadata are stable', () => {
    const exampleC = priceOneTimeMosquito({ mosquitoTreatableSqFt: 14000 }, {
      stationCount: 2,
      dunkCount: 0,
      isRecurringCustomer: true,
    });
    expect(exampleC).toEqual(expect.objectContaining({
      areaBucket: 'LARGE',
      basePrice: 159,
      stationAddOnTotal: 150,
      subtotalBeforeRecurringCustomerDiscount: 309,
      recurringCustomerDiscountRate: 0.15,
      price: 263,
      recurringCustomerDiscountAmount: 46,
    }));

    const exampleD = priceOneTimeMosquito({ mosquitoTreatableSqFt: 65000 });
    expect(exampleD).toEqual(expect.objectContaining({
      areaBucket: 'OVER_ACRE',
      overageSqFt: 21440,
      incrementCount: 3,
      basePrice: 389,
      requiresManualReview: true,
      price: 389,
      manualReviewReasons: expect.arrayContaining(['over_acre_mosquito_treatment']),
    }));

    const missing = priceOneTimeMosquito({});
    expect(missing.areaBucket).toBe('SMALL');
    expect(missing.requiresManualReview).toBe(true);
    expect(missing.missingAreaData).toBe(true);
    expect(missing.manualReviewReasons).toContain('missing_mosquito_treatable_area');
    expect(missing.mosquitoTreatableSqFtSource).toBe('missing_or_zero_fallback');

    const derivedAcreFromMissingLot = priceOneTimeMosquito({
      mosquitoTreatableSqFt: 0,
      mosquitoLotCategory: 'ACRE',
    });
    expect(derivedAcreFromMissingLot.areaBucket).toBe('SMALL');
    expect(derivedAcreFromMissingLot.price).toBe(99);
    expect(derivedAcreFromMissingLot.requiresManualReview).toBe(true);
    expect(derivedAcreFromMissingLot.manualReviewReasons).toContain('missing_mosquito_treatable_area');
  });

  test('add-on counts preserve pricing behavior while returning warnings', () => {
    const recurring = priceMosquito({
      lotCategory: 'SMALL',
      mosquitoTreatableSqFt: 6000,
      features: {},
    }, {
      tier: 'seasonal9',
      stationCount: -2,
      dunkCount: 'abc',
    });
    expect(recurring.addOns.stationCount).toBe(0);
    expect(recurring.addOns.dunkCount).toBe(0);
    expect(recurring.warnings).toEqual(expect.arrayContaining([
      'negative_station_count_clamped',
      'invalid_dunk_count_defaulted',
    ]));

    const oneTime = priceOneTimeMosquito({ mosquitoTreatableSqFt: 8000 }, {
      stationCount: 2.6,
      dunkCount: 3.2,
    });
    expect(oneTime.stationCount).toBe(3);
    expect(oneTime.dunkCount).toBe(3);
    expect(oneTime.warnings).toEqual(expect.arrayContaining([
      'fractional_station_count_rounded',
      'fractional_dunk_count_rounded',
    ]));
  });
});
