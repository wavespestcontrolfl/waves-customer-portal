const {
  calculatePropertyProfile,
  generateEstimate,
  normalizeGrassType,
  priceLawnCare,
  priceOneTimeLawn,
} = require('../services/pricing-engine');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

function baseInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    services: {},
    paymentMethod: 'card',
    ...overrides,
  };
}

describe('lawn pricing production follow-up', () => {
  test('grass aliases normalize to active lawn tracks', () => {
    expect(normalizeGrassType('A')).toBe('st_augustine');
    expect(normalizeGrassType('B')).toBe('st_augustine');
    expect(normalizeGrassType('ST_AUGUSTINE')).toBe('st_augustine');
    expect(normalizeGrassType('BERMUDA')).toBe('bermuda');
    expect(normalizeGrassType('ZOYSIA')).toBe('zoysia');
    expect(normalizeGrassType('BAHIA')).toBe('bahia');

    const lawn = priceLawnCare(calculatePropertyProfile(baseInput({ measuredTurfSf: 4000 })), { track: 'B' });
    expect(lawn.grassType).toBe('St. Augustine');
    expect(lawn.grassCode).toBe('A');
  });

  test('imperviousSurfacePercent 0 remains 0 instead of falling back to 20', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 0,
      measuredTurfSf: 0,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 0,
      estimatedBedAreaSf: 1000,
    }));

    expect(property.turfOpenArea).toBe(10000);
    expect(property.turfSf).toBe(9000);
    expect(property.turfBasis).toBe('lotFallback');
    expect(property.turfFlags).toContain('FIELD_VERIFY_TURF_SQFT');
  });

  test('profile builder preserves corrected imperviousSurfacePercent 0 through pricing', () => {
    const profile = buildEnrichedProfile(
      {
        formattedAddress: '123 Main St',
        propertyType: 'Single Family',
        squareFootage: 0,
        lotSize: 10000,
        stories: 1,
      },
      {
        imperviousSurfacePercent: 0,
        estimatedTurfSf: 0,
        estimatedBedAreaSf: 1000,
      },
      null,
      null
    );
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: profile.homeSqFt,
      lotSqFt: profile.lotSqFt,
      estimatedTurfSf: profile.estimatedTurfSf,
      estimatedBedAreaSf: profile.estimatedBedAreaSf,
      imperviousSurfacePercent: profile.imperviousSurfacePercent,
      imperviosSurfacePercent: profile.imperviosSurfacePercent,
    }));

    expect(profile.imperviousSurfacePercent).toBe(0);
    expect(profile.imperviosSurfacePercent).toBe(0);
    expect(property.turfOpenArea).toBe(10000);
    expect(property.turfSf).toBe(9000);
  });

  test('correct imperviousSurfacePercent overrides legacy typo and legacy typo still works', () => {
    const currentWins = calculatePropertyProfile(baseInput({
      homeSqFt: 0,
      imperviousSurfacePercent: 25,
      imperviosSurfacePercent: 50,
      estimatedBedAreaSf: 500,
    }));
    const legacyOnly = calculatePropertyProfile(baseInput({
      homeSqFt: 0,
      imperviosSurfacePercent: 50,
      estimatedBedAreaSf: 500,
    }));

    expect(currentWins.turfOpenArea).toBe(7500);
    expect(currentWins.turfSf).toBe(7000);
    expect(legacyOnly.turfOpenArea).toBe(5000);
    expect(legacyOnly.turfSf).toBe(4500);
  });

  test('one-time lawn market baseline is consistent with and without recurring LAWN when cost floor is enabled', () => {
    const common = baseInput({
      measuredTurfSf: 6000,
      recurringCustomer: false,
      useLawnCostFloor: true,
      lawnMaterialCostPerK: 250,
      services: {
        oneTimeLawn: { treatmentType: 'weed', lawnFreq: 6 },
      },
    });
    const withoutRecurring = generateEstimate(common);
    const withRecurring = generateEstimate({
      ...common,
      services: {
        lawn: { track: 'st_augustine', lawnFreq: 6, useLawnCostFloor: true, lawnMaterialCostPerK: 250 },
        oneTimeLawn: { treatmentType: 'weed', lawnFreq: 6 },
      },
    });

    const otWithout = withoutRecurring.lineItems.find(i => i.service === 'one_time_lawn');
    const otWith = withRecurring.lineItems.find(i => i.service === 'one_time_lawn');
    expect(otWith.price).toBe(otWithout.price);
    expect(otWith.baselinePricingSource).toBe('MARKET_TABLE');
  });

  test('one-time lawn still scales by turf size and fungicide remains higher than fertilization', () => {
    const small = priceOneTimeLawn(calculatePropertyProfile(baseInput({ measuredTurfSf: 3000 })), {
      treatmentType: 'fert',
      isRecurringCustomer: false,
    });
    const large = priceOneTimeLawn(calculatePropertyProfile(baseInput({ measuredTurfSf: 15000 })), {
      treatmentType: 'fert',
      isRecurringCustomer: false,
    });
    const fert = priceOneTimeLawn(calculatePropertyProfile(baseInput({ measuredTurfSf: 5000 })), {
      treatmentType: 'fert',
      isRecurringCustomer: false,
    });
    const fungicide = priceOneTimeLawn(calculatePropertyProfile(baseInput({ measuredTurfSf: 5000 })), {
      treatmentType: 'fungicide',
      isRecurringCustomer: false,
    });

    expect(large.price).toBeGreaterThan(small.price);
    expect(fungicide.price).toBeGreaterThan(fert.price);
  });

  test('explicit zero turf stays zero instead of falling back to default lawn size', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 0,
      measuredTurfSf: 0,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 100,
      estimatedBedAreaSf: 0,
    }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    expect(property.turfSf).toBe(0);
    expect(lawn.turfSf).toBe(0);
    expect(lawn.lawnSqFt).toBe(0);
  });

  test('zero legacy hardscape turf estimate is preserved instead of replaced by lot fallback', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 9000,
      lotSqFt: 9500,
    }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
    expect(property.turfSf).toBe(0);
    expect(lawn.turfSf).toBe(0);
  });

  test('cost floor callback reserve recognizes property lookup risk enums', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4000 }));
    const safe = priceLawnCare(
      { ...property, maintenanceCondition: 'AVERAGE', overallPestPressure: 'MODERATE' },
      { track: 'st_augustine', lawnFreq: 9, useLawnCostFloor: true }
    );
    const risky = priceLawnCare(
      { ...property, maintenanceCondition: 'DEFERRED', overallPestPressure: 'VERY_HIGH' },
      { track: 'st_augustine', lawnFreq: 9, useLawnCostFloor: true }
    );

    expect(risky.selected.costFloorAnnual).toBeGreaterThan(safe.selected.costFloorAnnual);
  });

  test('large lawn custom quote warning is visible at top level', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 25000,
      services: { lawn: { track: 'st_augustine', lawnFreq: 9 } },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(lawn.customQuoteFlag).toBe(true);
    expect(lawn.pricingBasis).toBe('EXTRAPOLATED_ABOVE_TABLE_MAX');
    expect(estimate.notes).toContainEqual({
      type: 'LAWN_CUSTOM_QUOTE',
      text: 'Turf area exceeds 20,000 sq ft. Pricing was extrapolated and requires field verification/custom quote.',
      priority: 'HIGH',
    });
  });

  test('large one-time lawn only quote carries custom quote warning and extrapolated baseline source', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 25000,
      services: { oneTimeLawn: { treatmentType: 'weed', lawnFreq: 9 } },
    }));
    const otLawn = estimate.lineItems.find(i => i.service === 'one_time_lawn');

    expect(otLawn.customQuoteFlag).toBe(true);
    expect(otLawn.baselinePricingBasis).toBe('EXTRAPOLATED_ABOVE_TABLE_MAX');
    expect(otLawn.baselinePricingSource).toBe('EXTRAPOLATED_TABLE');
    expect(estimate.notes).toContainEqual({
      type: 'LAWN_CUSTOM_QUOTE',
      text: 'Turf area exceeds 20,000 sq ft. Pricing was extrapolated and requires field verification/custom quote.',
      priority: 'HIGH',
    });
  });

  test('turf field verification only surfaces when turf-priced services are selected', () => {
    const pestOnly = generateEstimate(baseInput({
      measuredTurfSf: 0,
      estimatedTurfSf: 0,
      services: { pest: { frequency: 'quarterly' } },
    }));
    const lawn = generateEstimate(baseInput({
      measuredTurfSf: 0,
      estimatedTurfSf: 0,
      services: { lawn: { track: 'st_augustine', lawnFreq: 9 } },
    }));

    expect(pestOnly.property.turfFlags).toContain('FIELD_VERIFY_TURF_SQFT');
    expect(pestOnly.fieldVerify).not.toContain('FIELD_VERIFY_TURF_SQFT');
    expect(lawn.fieldVerify).toContain('FIELD_VERIFY_TURF_SQFT');
  });

  test('cost-floor pricing source is explicit per tier and selected tier', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4000 }));
    const market = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9, useLawnCostFloor: false });
    const floor = priceLawnCare(property, {
      track: 'st_augustine',
      lawnFreq: 9,
      useLawnCostFloor: true,
      lawnMaterialCostPerK: 250,
    });

    expect(market.selected.pricingSource).toBe('MARKET_TABLE');
    expect(floor.selected.costFloorApplied).toBe(true);
    expect(floor.selected.pricingSource).toBe('COST_FLOOR');
    expect(floor.pricingSource).toBe('COST_FLOOR');
  });
});
