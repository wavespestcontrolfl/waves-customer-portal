const {
  calculatePropertyProfile,
  generateEstimate,
  normalizeGrassType,
  priceLawnCare,
  priceOneTimeLawn,
} = require('../services/pricing-engine');
const { buildEnrichedProfile, needsTurfManualConfirmation } = require('../routes/property-lookup-v2');

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

  test('large AI-only turf requires manual confirmation for turf-priced services', () => {
    const profile = {
      lotSqFt: 46609,
      estimatedTurfSf: 28000,
      aiConfidence: 52,
      treeDensity: 'HEAVY',
      nearWater: 'POND_ON_PROPERTY',
    };

    const required = needsTurfManualConfirmation(profile, ['LAWN']);
    const pestOnly = needsTurfManualConfirmation(profile, ['PEST']);
    const pluggingFallback = needsTurfManualConfirmation(profile, ['PLUGGING']);
    const pluggingManualArea = needsTurfManualConfirmation(profile, ['PLUGGING'], { plugArea: 1000 });
    const lawnWithPlugArea = needsTurfManualConfirmation(profile, ['LAWN', 'PLUGGING'], { plugArea: 1000 });
    const confirmed = needsTurfManualConfirmation({ ...profile, measuredTurfSf: 15000 }, ['LAWN']);

    expect(required).toMatchObject({
      field: 'measuredTurfSf',
      threshold: 20000,
      estimatedTurfSf: 28000,
    });
    expect(required.reasons).toEqual(expect.arrayContaining([
      'AI confidence 52%',
      'heavy tree canopy',
      'water adjacency',
    ]));
    expect(pestOnly).toBeNull();
    expect(pluggingFallback).toMatchObject({
      field: 'measuredTurfSf',
      estimatedTurfSf: 28000,
    });
    expect(pluggingManualArea).toBeNull();
    expect(lawnWithPlugArea).toMatchObject({
      field: 'measuredTurfSf',
      estimatedTurfSf: 28000,
    });
    expect(confirmed).toBeNull();
  });

  test('profile builder flags suspicious large turf estimates from obstructed imagery', () => {
    const profile = buildEnrichedProfile(
      {
        formattedAddress: '21803 Deer Pointe Crossing',
        propertyType: 'Single Family',
        squareFootage: 2932,
        lotSize: 46609,
        stories: 1,
      },
      {
        estimatedTurfSf: 28000,
        confidenceScore: 52,
        treeDensity: 'HEAVY',
        nearWater: 'POND_ON_PROPERTY',
      },
      null,
      null
    );

    expect(profile.fieldVerifyFlags).toContainEqual(expect.objectContaining({
      field: 'estimatedTurfSf',
      priority: 'HIGH',
    }));
  });

  test('pricing rejects AI turf estimates above plausible lot outdoor area', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2576,
      stories: 1,
      lotSqFt: 14006,
      estimatedTurfSf: 12605,
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    }));

    expect(property.turfSf).toBeLessThan(12605);
    expect(property.turfSf).toBe(8139);
    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
    expect(property.turfConfidence).toBe('LOW');
    expect(property.turfFlags).toEqual(expect.arrayContaining([
      'FIELD_VERIFY_TURF_SQFT',
      'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX',
    ]));
  });

  test('minor AI turf overages cap to plausible max instead of legacy fallback', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      estimatedTurfSf: 7200,
    }));

    expect(property.turfSf).toBe(7125);
    expect(property.turfBasis).toBe('plausibleMaxTurfCap');
    expect(property.turfConfidence).toBe('MEDIUM');
    expect(property.turfFlags).toEqual(expect.arrayContaining([
      'FIELD_VERIFY_TURF_SQFT',
      'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX',
    ]));
  });

  test('top-level pool cage and landscape flags reduce inferred turf area', () => {
    const plain = calculatePropertyProfile(baseInput({
      homeSqFt: 2576,
      stories: 1,
      lotSqFt: 14006,
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    }));
    const withTopLevelFlags = calculatePropertyProfile(baseInput({
      homeSqFt: 2576,
      stories: 1,
      lotSqFt: 14006,
      pool: 'YES',
      poolCage: 'YES',
      hasLargeDriveway: true,
      shrubDensity: 'HEAVY',
      treeDensity: 'HEAVY',
      landscapeComplexity: 'COMPLEX',
      features: {},
    }));

    expect(withTopLevelFlags.features.pool).toBe(true);
    expect(withTopLevelFlags.features.poolCage).toBe(true);
    expect(withTopLevelFlags.features.largeDriveway).toBe(true);
    expect(withTopLevelFlags.features.shrubs).toBe('heavy');
    expect(withTopLevelFlags.features.trees).toBe('heavy');
    expect(withTopLevelFlags.features.complexity).toBe('complex');
    expect(withTopLevelFlags.hardscape).toBe(plain.hardscape + 900);
    expect(withTopLevelFlags.turfSf).toBeLessThan(plain.turfSf);
  });

  test('top-level feature selections override nested false defaults', () => {
    const property = calculatePropertyProfile(baseInput({
      poolCage: 'YES',
      hasLargeDriveway: true,
      nearWater: 'ADJACENT',
      attachedGarage: true,
      features: {
        pool: false,
        poolCage: false,
        largeDriveway: false,
        nearWater: false,
        attachedGarage: false,
      },
    }));

    expect(property.features.pool).toBe(true);
    expect(property.features.poolCage).toBe(true);
    expect(property.features.largeDriveway).toBe(true);
    expect(property.features.nearWater).toBe(true);
    expect(property.features.attachedGarage).toBe(true);
  });

  test('zero plausible turf max still rejects positive AI turf estimates', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 9000,
      stories: 1,
      lotSqFt: 9500,
      estimatedTurfSf: 5000,
    }));

    expect(property.turfSf).toBe(0);
    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
    expect(property.turfFlags).toEqual(expect.arrayContaining([
      'FIELD_VERIFY_TURF_SQFT',
      'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX',
    ]));
  });

  test('graduated water proximity feature values remain water-adjacent', () => {
    const property = calculatePropertyProfile(baseInput({
      features: { nearWater: 'ADJACENT' },
    }));

    expect(property.features.nearWater).toBe(true);
    expect(property.nearWater).toBe('CLOSE');
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

  test('blank corrected impervious value does not override valid legacy typo', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 0,
      imperviousSurfacePercent: '',
      imperviosSurfacePercent: 50,
      estimatedBedAreaSf: 0,
    }));

    expect(property.turfOpenArea).toBe(5000);
    expect(property.turfSf).toBe(5000);
  });

  test('lot fallback preserves explicit zero bed area', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 0,
      imperviousSurfacePercent: 0,
      estimatedBedAreaSf: 0,
    }));

    expect(property.turfOpenArea).toBe(10000);
    expect(property.turfSf).toBe(10000);
    expect(property.bedArea).toBe(0);
  });

  test('blank lot-derived turf fields fall back to legacy hardscape estimate', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 9000,
      lotSqFt: 9500,
      estimatedTurfSf: '',
      imperviousSurfacePercent: '',
      imperviosSurfacePercent: null,
      estimatedBedAreaSf: '',
      estimatedBedAreaPercent: null,
    }));

    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
    expect(property.turfSf).toBe(0);
  });

  test('manual legacy bedArea takes precedence over estimated bed area in turf fallback', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 0,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 20,
      bedArea: 1000,
      estimatedBedAreaSf: 4000,
    }));

    expect(property.bedArea).toBe(1000);
    expect(property.turfOpenArea).toBe(8000);
    expect(property.turfSf).toBe(7000);
  });

  test('legacy bedArea alone still uses legacy hardscape turf estimate', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2000,
      lotSqFt: 10000,
      bedArea: 1000,
    }));

    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
    expect(property.turfOpenArea).toBeUndefined();
    expect(property.turfSf).toBeLessThan(6000);
  });

  test('explicit zero measured turf overrides estimated turf', () => {
    const property = calculatePropertyProfile(baseInput({
      measuredTurfSf: 0,
      estimatedTurfSf: 5000,
    }));

    expect(property.turfSf).toBe(0);
    expect(property.lawnSqFt).toBe(0);
    expect(property.turfEstimated).toBe(false);
    expect(property.turfBasis).toBe('measuredTurfSf');
  });

  test('profile builder does not convert missing bed estimate into verified zero', () => {
    const profile = buildEnrichedProfile(
      {
        formattedAddress: '123 Main St',
        propertyType: 'Single Family',
        squareFootage: 0,
        lotSize: 10000,
        stories: 1,
      },
      {
        imperviousSurfacePercent: 20,
        estimatedTurfSf: 0,
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

    expect(profile.estimatedBedAreaSf).toBeUndefined();
    expect(property.turfOpenArea).toBe(8000);
    expect(property.turfSf).toBe(6800);
  });

  test('profile builder leaves missing impervious fields undefined', () => {
    const profile = buildEnrichedProfile(
      {
        formattedAddress: '123 Main St',
        propertyType: 'Single Family',
        squareFootage: 2000,
        lotSize: 10000,
        stories: 1,
      },
      {
        estimatedTurfSf: 0,
      },
      null,
      null
    );
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: profile.homeSqFt,
      lotSqFt: profile.lotSqFt,
      estimatedTurfSf: profile.estimatedTurfSf,
      imperviousSurfacePercent: profile.imperviousSurfacePercent,
      imperviosSurfacePercent: profile.imperviosSurfacePercent,
    }));

    expect(profile.imperviousSurfacePercent).toBeUndefined();
    expect(profile.imperviosSurfacePercent).toBeUndefined();
    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
  });

  test('profile builder copies legacy impervious value into corrected field', () => {
    const profile = buildEnrichedProfile(
      {
        formattedAddress: '123 Main St',
        propertyType: 'Single Family',
        squareFootage: 0,
        lotSize: 10000,
        stories: 1,
      },
      {
        imperviosSurfacePercent: 25,
        estimatedTurfSf: 0,
        estimatedBedAreaSf: 0,
      },
      null,
      null
    );

    expect(profile.imperviousSurfacePercent).toBe(25);
    expect(profile.imperviosSurfacePercent).toBe(25);
  });

  test('profile builder ignores blank corrected impervious when legacy typo is valid', () => {
    const profile = buildEnrichedProfile(
      {
        formattedAddress: '123 Main St',
        propertyType: 'Single Family',
        squareFootage: 0,
        lotSize: 10000,
        stories: 1,
      },
      {
        imperviousSurfacePercent: '',
        imperviosSurfacePercent: 35,
        estimatedTurfSf: 0,
        estimatedBedAreaSf: 0,
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

    expect(profile.imperviousSurfacePercent).toBe(35);
    expect(profile.imperviosSurfacePercent).toBe(35);
    expect(property.turfOpenArea).toBe(6500);
    expect(property.turfSf).toBe(6500);
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
    expect(lawn.pricingBasis).toBe('FIFTY_FIVE_MARGIN_FLOOR');
    expect(lawn.marketAnnual).toBeGreaterThan(0);
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
      estimatedTurfSf: 0,
      services: { pest: { frequency: 'quarterly' } },
    }));
    const lawn = generateEstimate(baseInput({
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

  test('default tiers are 3 (standard/enhanced/premium) — basic is hidden', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    expect(lawn.tiers).toHaveLength(3);
    expect(lawn.tiers.map(t => t.tier)).toEqual(['standard', 'enhanced', 'premium']);
    expect(lawn.tiers.every(t => t.label)).toBe(true);
    expect(lawn.tiers[0].label).toBe('6 Applications');
    expect(lawn.tiers[1].label).toBe('9 Applications');
    expect(lawn.tiers[2].label).toBe('12 Applications');
  });

  test('includeHiddenTiers exposes basic tier for admin/manager override', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, {
      track: 'st_augustine', lawnFreq: 9, includeHiddenTiers: true,
    });

    expect(lawn.tiers).toHaveLength(4);
    expect(lawn.tiers[0].tier).toBe('basic');
    expect(lawn.tiers[0].label).toBe('4 Applications');
  });

  test('cost floor uses annual material budgets by grass type (not $8/K fallback)', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4492 }));

    const stAug = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });
    const bermuda = priceLawnCare(property, { track: 'bermuda', lawnFreq: 9 });
    const zoysia = priceLawnCare(property, { track: 'zoysia', lawnFreq: 9 });

    // St. Augustine enhanced at 4,492 sqft uses the 55% collected-margin floor.
    expect(stAug.selected.perApp).toBe(95);

    // Bermuda enhanced at 4,492 sqft uses the 55% collected-margin floor.
    expect(bermuda.selected.perApp).toBe(95);

    // Zoysia enhanced at 4,492 sqft has a slightly higher material budget.
    expect(zoysia.selected.perApp).toBe(97);
  });

  test('dense route St. Augustine enhanced quote uses 55% floor as final customer price', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4250 }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    expect(lawn.selected.perApp).toBe(92);
    expect(lawn.annual).toBe(828);
    expect(lawn.monthly).toBe(69);
    expect(lawn.costs.total).toBeGreaterThanOrEqual(371);
    expect(lawn.costs.total).toBeLessThan(372);
    expect(lawn.minimumCollectedAnnualPriceFor55).toBeGreaterThanOrEqual(826);
    expect(lawn.minimumCollectedAnnualPriceFor55).toBeLessThan(827);
    expect(lawn.margin).toBeGreaterThanOrEqual(0.55);
    expect(lawn.pricingBasis).toBe('FIFTY_FIVE_MARGIN_FLOOR');
    expect(lawn.selected.marketAnnual).toBeGreaterThan(lawn.annual);
  });

  test('Lawn V2 is net floor pricing and does not receive WaveGuard percent discounts', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4250,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(estimate.waveGuard).toMatchObject({
      tier: 'silver',
      qualifyingCount: 2,
      activeServices: ['pest_control', 'lawn_care'],
    });
    expect(lawn.annual).toBe(828);
    expect(lawn.annualAfterDiscount).toBe(828);
    expect(lawn.discount).toMatchObject({
      discountable: false,
      requestedDiscountPercent: 0.10,
      appliedDiscountPercent: 0,
      effectiveDiscount: 0,
      policy: 'LAWN_V2_NET_55_FLOOR_PRICE',
    });
  });

  test('manual recurring discounts exclude Lawn V2 net floor pricing', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4250,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
      manualDiscount: { type: 'PERCENT', value: 10 },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(lawn.annualAfterDiscount).toBe(828);
    expect(estimate.summary.manualDiscount.discountableBase).toBe(421.2);
    expect(estimate.summary.manualDiscount.amount).toBe(42.12);
    expect(estimate.summary.manualDiscount.excludedServices).toContain('lawn_care_enhanced');
  });

  test('requesting hidden tier without includeHiddenTiers falls back to enhanced', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, {
      track: 'st_augustine', tier: 'basic', lawnFreq: 4,
    });

    expect(lawn.tiers).toHaveLength(3);
    expect(lawn.tiers.map(t => t.tier)).toEqual(['standard', 'enhanced', 'premium']);
    expect(lawn.selected.tier).toBe('enhanced');
    expect(lawn.tier).toBe('enhanced');
    expect(lawn.frequency).toBe(9);
  });

  test('useLawnCostFloor defaults to true for recurring lawn', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    // With cost floor on by default and material budgets, most tiers will show COST_FLOOR
    expect(lawn.selected.costFloorAnnual).toBeGreaterThan(0);
  });
});
