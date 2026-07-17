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

  test('lot fallback above plausible outdoor area downgrades to legacy hardscape estimate', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2576,
      stories: 1,
      lotSqFt: 14006,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 0,
      estimatedBedAreaPercent: 10,
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    }));

    expect(property.turfSf).toBe(8139);
    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
    expect(property.turfOpenArea).toBe(10435);
    expect(property.turfFlags).toEqual(expect.arrayContaining([
      'FIELD_VERIFY_TURF_SQFT',
      'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX',
    ]));
  });

  test('estimated zero bed area with a real footprint still caps impossible lot fallback', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2576,
      stories: 1,
      lotSqFt: 14006,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 10,
      estimatedBedAreaSf: 0,
      bedAreaSource: 'estimated',
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    }));

    expect(property.turfSf).toBe(8139);
    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
    expect(property.turfOpenArea).toBe(10435);
    expect(property.turfFlags).toEqual(expect.arrayContaining([
      'FIELD_VERIFY_TURF_SQFT',
      'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX',
    ]));
  });

  test('translated estimated zero bed area still caps when copied into bedArea', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2576,
      stories: 1,
      lotSqFt: 14006,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 10,
      estimatedBedAreaSf: 0,
      bedArea: 0,
      bedAreaSource: 'estimated',
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    }));

    expect(property.turfSf).toBe(8139);
    expect(property.turfBasis).toBe('legacyHardscapeEstimate');
    expect(property.turfOpenArea).toBe(10435);
    expect(property.turfFlags).toEqual(expect.arrayContaining([
      'FIELD_VERIFY_TURF_SQFT',
      'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX',
    ]));
  });

  test('positive estimated bed area preserves explicit lot fallback math', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 0,
      estimatedBedAreaSf: 500,
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    }));

    expect(property.turfSf).toBe(9500);
    expect(property.turfBasis).toBe('lotFallback');
    expect(property.turfOpenArea).toBe(10000);
    expect(property.turfFlags).toEqual(['FIELD_VERIFY_TURF_SQFT']);
  });

  test('positive estimated bed area alias preserves explicit lot fallback math', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 0,
      bedArea: 500,
      bedAreaSource: 'estimated',
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    }));

    expect(property.turfSf).toBe(9500);
    expect(property.turfBasis).toBe('lotFallback');
    expect(property.turfOpenArea).toBe(10000);
    expect(property.turfFlags).toEqual(['FIELD_VERIFY_TURF_SQFT']);
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
    // The county turf prior does NOT fire here — this record has no parsed
    // extra-features roll (imperviousKnown=false), and the prior requires
    // county-COMPLETE facts. Pricing keeps the legacy fallback path.
    expect(profile.countyTurfPriorSf).toBeNull();
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
    expect(lawn.pricingBasis).toBe('THIRTY_FIVE_MARGIN_FLOOR');
    expect(lawn.selected.pricingBasis).toBe('THIRTY_FIVE_MARGIN_FLOOR');
    expect(lawn.selected.marketSource).toBe('EXTRAPOLATED_TABLE');
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
    // 8,000 sqft: the enhanced market cell ($68/mo) clears the $50 program
    // minimum, so the MARKET_TABLE vs COST_FLOOR source plumbing stays visible.
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 8000 }));
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

  test('default tiers expose 6/9/12 application options (4x retired 2026-07-09)', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    expect(lawn.tiers).toHaveLength(3);
    expect(lawn.tiers.map(t => t.tier)).toEqual(['standard', 'enhanced', 'premium']);
    expect(lawn.tiers.every(t => t.label)).toBe(true);
    expect(lawn.tiers[0].label).toBe('6x applications/yr');
    expect(lawn.tiers[1].label).toBe('9x applications/yr');
    expect(lawn.tiers[2].label).toBe('12x applications/yr');
  });

  test('includeHiddenTiers preserves the full lawn tier list', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, {
      track: 'st_augustine', lawnFreq: 9, includeHiddenTiers: true,
    });

    expect(lawn.tiers).toHaveLength(4);
    expect(lawn.tiers.map(t => t.tier)).toEqual(['basic', 'standard', 'enhanced', 'premium']);
    expect(lawn.tiers.map(t => t.label)).toEqual(['4x applications/yr', '6x applications/yr', '9x applications/yr', '12x applications/yr']);
  });

  test('small lawn pricing floors at the $50 program minimum when the market cell sits below it', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2720,
      lotSqFt: 7200,
      measuredTurfSf: 2870,
      features: { complexity: 'simple' },
    }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    // Market $564/yr and cost floor both sit below the $600 program minimum
    // → $603/yr (ceil'd to a clean 9-app multiple), $67/app.
    expect(lawn.selected.perApp).toBe(67);
    expect(lawn.selected.pricingSource).toBe('PROGRAM_MINIMUM');
    expect(lawn.selected.costFloorApplied).toBe(false);
    expect(lawn.selected.costFloorAnnual).toBeLessThan(lawn.selected.marketAnnual);
    expect(lawn.margin).toBeGreaterThan(0.45);
  });

  test('reviewed 2,870 sqft estimate stays at 9 applications and Silver-discounted market price', () => {
    const estimate = generateEstimate(baseInput({
      homeSqFt: 2720,
      lotSqFt: 7200,
      measuredTurfSf: 2870,
      features: { complexity: 'simple' },
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(estimate.waveGuard).toMatchObject({
      tier: 'silver',
      qualifyingCount: 2,
    });
    expect(lawn.frequency).toBe(9);
    // The $564 market cell floors at the $600 program minimum ($603 ceil'd
    // to a 9-app multiple); Silver 10% would land at $542.70 — below the
    // floor, so the discount caps right back at $600 (owner 2026-07-09).
    expect(lawn.perApp).toBe(67);
    expect(lawn.annual).toBe(603);
    expect(lawn.annualAfterDiscount).toBe(600);
    expect(lawn.monthlyAfterDiscount).toBe(50);
    expect(lawn.programMinimumGuardApplied).toBe(true);
    expect(lawn.discountCapped).toBe(true);
    expect(lawn.pricingSource).toBe('PROGRAM_MINIMUM');
    expect(lawn.costFloorApplied).toBe(false);
  });

  test('cost floor uses annual material budgets by grass type (not $8/K fallback)', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4492 }));

    const stAug = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });
    const bermuda = priceLawnCare(property, { track: 'bermuda', lawnFreq: 9 });
    const zoysia = priceLawnCare(property, { track: 'zoysia', lawnFreq: 9 });

    // St. Augustine enhanced at 4,492 sqft uses the 35% collected-margin floor
    // ($594/yr), which then rides up to the $600 program minimum ($603/9-app).
    expect(stAug.selected.perApp).toBe(67);
    expect(stAug.selected.costFloorApplied).toBe(true);

    // Bermuda enhanced remains market-table priced because market is above the floor.
    expect(bermuda.selected.perApp).toBe(68);
    expect(bermuda.selected.costFloorApplied).toBe(false);

    // Zoysia enhanced has a higher material budget but still lands below market.
    expect(zoysia.selected.perApp).toBe(68);
    expect(zoysia.selected.costFloorApplied).toBe(false);
  });

  test('dense route St. Augustine enhanced quote prices off the market table just above the 35% floor', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4250 }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    // Under the 35% floor the cost floor (~$572/yr) drops below the market
    // table (~$576/yr) — but both sit below the $600 program minimum, which
    // is the final customer price ($603 ceil'd to a clean 9-app multiple).
    expect(lawn.selected.perApp).toBe(67);
    expect(lawn.annual).toBe(603);
    expect(lawn.monthly).toBe(50.25);
    expect(lawn.costs.total).toBeGreaterThanOrEqual(371);
    expect(lawn.costs.total).toBeLessThan(372);
    expect(lawn.minimumCollectedAnnualPrice).toBeGreaterThanOrEqual(571);
    expect(lawn.minimumCollectedAnnualPrice).toBeLessThan(572);
    expect(lawn.margin).toBeGreaterThanOrEqual(0.35);
    expect(lawn.pricingBasis).toBe('PROGRAM_MINIMUM_MONTHLY');
    expect(lawn.selected.marketAnnual).toBe(576);
  });

  test('Lawn V2 receives WaveGuard percent discounts', () => {
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
    expect(lawn.annual).toBe(603);
    // Silver 10% would land at $542.70/yr — below the $600/yr program
    // minimum, so only the slice down to the floor applies (603 → 600 is an
    // effective 0.5%).
    expect(lawn.annualAfterDiscount).toBe(600);
    expect(lawn.monthlyAfterDiscount).toBe(50);
    expect(lawn.programMinimumGuardApplied).toBe(true);
    expect(lawn.discountCapped).toBe(true);
    expect(lawn.requestedDiscountPct).toBe(0.10);
    expect(lawn.actualDiscountPct).toBe(0.005);
    expect(lawn.discount).toMatchObject({
      discountable: true,
      requestedDiscountPercent: 0.10,
      appliedDiscountPercent: 0.10,
      effectiveDiscount: 0.10,
    });
  });

  test('WaveGuard cannot discount lawn below its 35% collected-margin floor', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 5012,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(lawn.minimumCollectedAnnualPrice).toBeGreaterThan(600);
    expect(lawn.annualAfterDiscount).toBeCloseTo(lawn.minimumCollectedAnnualPrice, 2);
    expect(lawn.marginFloorGuardApplied).toBe(true);
    expect(lawn.discountCapped).toBe(true);
    const collectedMargin = (lawn.annualAfterDiscount - lawn.costs.total)
      / lawn.annualAfterDiscount;
    expect(collectedMargin).toBeGreaterThanOrEqual(0.35 - 0.0001);
  });

  test('manual recurring discounts include WaveGuard-discounted Lawn V2 pricing', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4250,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
      manualDiscount: { type: 'PERCENT', value: 10 },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    // Lawn holds at the $600 floor post-WaveGuard, so the manual-discount
    // base is pest 421.20 + lawn 600 = 1021.20.
    expect(lawn.annualAfterDiscount).toBe(600);
    expect(estimate.summary.manualDiscount.discountableBase).toBeCloseTo(1021.2, 2);
    // 10% (102.12) fits inside the non-lawn headroom (1021.20 − 600 protected
    // = 421.20), so the manual discount applies in full, uncapped.
    expect(estimate.summary.manualDiscount.amount).toBe(102.12);
    expect(estimate.summary.manualDiscount.capReason).not.toBe('lawn_program_minimum');
    expect(estimate.summary.manualDiscount.eligibleServices).toContain('lawn_care_enhanced');
    expect(estimate.summary.manualDiscount.excludedServices).not.toContain('lawn_care_enhanced');
  });

  test('manual lawn discounts are capped at the collected-margin floor before persistence', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 5012,
      services: { lawn: { track: 'st_augustine', lawnFreq: 9 } },
      manualDiscount: { type: 'PERCENT', value: 50 },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(lawn.minimumCollectedAnnualPrice).toBeGreaterThan(600);
    expect(estimate.summary.recurringAnnualAfterDiscount)
      .toBeGreaterThanOrEqual(lawn.minimumCollectedAnnualPrice - 0.01);
    expect(estimate.summary.manualDiscount).toEqual(expect.objectContaining({
      capped: true,
      capReason: 'lawn_margin_floor',
    }));
    expect(estimate.marginWarnings.find((warning) => (
      warning.service === 'lawn_care' && warning.type === 'manual_discount_below_margin_floor'
    ))).toBeUndefined();
  });

  test('manual discount audit allocates non-lawn-first: floored lawn keeps its price, pest absorbs the cut', () => {
    // 5,012 sqft: lawn is WaveGuard-capped at its $630.82 margin floor (zero
    // headroom); pest holds $421.20 after Silver. A 30% manual discount
    // ($315.61) fits entirely inside the non-lawn headroom, so the aggregate
    // guard lets it through uncapped — the per-line audit must attribute ALL
    // of it to pest, not proportionally smear it across the protected lawn.
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 5012,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
      manualDiscount: { type: 'PERCENT', value: 30, source: 'test', eligibilityConfirmed: true },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');
    const pest = estimate.lineItems.find(i => i.service === 'pest_control');

    expect(lawn.annualAfterDiscount).toBeCloseTo(lawn.minimumCollectedAnnualPrice, 2);
    expect(estimate.summary.manualDiscount.capped).toBe(false);
    // Lawn's audited final never dips below its floor — its price never moved.
    expect(lawn.manualFinalAnnual).toBeCloseTo(lawn.minimumCollectedAnnualPrice, 2);
    expect(lawn.manualMarginWarning).toBeUndefined();
    expect(estimate.marginWarnings.find((warning) => warning.service === 'lawn_care'))
      .toBeUndefined();
    // Pest absorbs the FULL pooled cut (421.20 − 315.61 = 105.59) and the
    // margin warning reports that share truthfully — a proportional split
    // (≈$126 share) would have hidden the below-floor pest margin entirely.
    expect(pest.manualFinalAnnual).toBeCloseTo(pest.annualAfterDiscount - estimate.summary.manualDiscount.amount, 2);
    expect(pest.manualMarginWarning).toBe(true);
    expect(pest.manualFinalMargin).toBeLessThan(0.35);
    const warning = estimate.marginWarnings.find((w) => (
      w.service === 'pest_control' && w.type === 'manual_discount_below_margin_floor'
    ));
    expect(warning).toBeTruthy();
    expect(warning.manualDiscountShare).toBeCloseTo(estimate.summary.manualDiscount.amount, 2);
  });

  test('a manual discount inside non-lawn headroom raises no margin warning and leaves lawn audit fields at the floor', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 5012,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
      manualDiscount: { type: 'PERCENT', value: 10, source: 'test', eligibilityConfirmed: true },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');
    const pest = estimate.lineItems.find(i => i.service === 'pest_control');

    expect(estimate.summary.manualDiscount.capped).toBe(false);
    expect(lawn.manualFinalAnnual).toBeGreaterThanOrEqual(lawn.minimumCollectedAnnualPrice - 0.01);
    expect(lawn.manualMarginWarning).toBeUndefined();
    expect(pest.manualFinalAnnual).toBeCloseTo(pest.annualAfterDiscount - estimate.summary.manualDiscount.amount, 2);
    // Pest still clears the 35% margin floor under full absorption.
    expect(pest.manualFinalMargin).toBeGreaterThanOrEqual(0.35);
    expect(estimate.marginWarnings.find((w) => w.type === 'manual_discount_below_margin_floor'))
      .toBeUndefined();
  });

  test('monthly CEILs when the WaveGuard lawn margin floor binds (never rebuilds a cent under the floor)', () => {
    // 4,632 sqft: margin floor $601.45/yr. 601.45/12 = 50.1208… — nearest-cent
    // rounding gives $50.12/mo which rebuilds $601.44/yr, a cent UNDER the
    // protected floor. The public ladder ceils this case
    // (clampLawnLadderEntry), so the engine must emit $50.13 to stay
    // cent-identical with what the customer sees and accepts.
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4632,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(lawn.marginFloorGuardApplied).toBe(true);
    expect(lawn.annualAfterDiscount).toBeCloseTo(lawn.minimumCollectedAnnualPrice, 2);
    // Fixture guard: this floor must round DOWN at the cent, or the case
    // can't distinguish ceil from round.
    expect(Math.round(lawn.annualAfterDiscount / 12 * 100) / 100)
      .toBeLessThan(Math.ceil(lawn.annualAfterDiscount / 12 * 100) / 100);
    // Same ceiling expression as the public ladder (estimate-public.js
    // clampLawnLadderEntry).
    expect(lawn.monthlyAfterDiscount).toBe(Math.ceil((lawn.annualAfterDiscount / 12) * 100) / 100);
    expect(lawn.monthlyAfterDiscount * 12).toBeGreaterThanOrEqual(lawn.annualAfterDiscount);
    // Summary follows the same rule while the floor is pinned.
    expect(estimate.summary.recurringMonthlyAfterDiscount * 12)
      .toBeGreaterThanOrEqual(estimate.summary.recurringAnnualAfterDiscount);
  });

  test('summary monthly CEILs when a manual discount pins lawn exactly on its margin floor', () => {
    // Lawn-only at 4,632 sqft ($603 authored, $601.45 floor): a 50% manual
    // discount clamps to the $1.55 of headroom, leaving the plan billing the
    // floor. round(601.45/12) = $50.12 would understate it; the stored
    // monthly_total must carry the ladder's $50.13.
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4632,
      services: { lawn: { track: 'st_augustine', lawnFreq: 9 } },
      manualDiscount: { type: 'PERCENT', value: 50, source: 'test', eligibilityConfirmed: true },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(estimate.summary.manualDiscount.capReason).toBe('lawn_margin_floor');
    expect(estimate.summary.recurringAnnualAfterDiscount)
      .toBeCloseTo(lawn.minimumCollectedAnnualPrice, 2);
    expect(estimate.summary.recurringMonthlyAfterDiscount)
      .toBe(Math.ceil((estimate.summary.recurringAnnualAfterDiscount / 12) * 100) / 100);
    expect(estimate.summary.recurringMonthlyAfterDiscount * 12)
      .toBeGreaterThanOrEqual(estimate.summary.recurringAnnualAfterDiscount);
    // Audit field sits exactly on the floor, never below.
    expect(lawn.manualFinalAnnual).toBeCloseTo(lawn.minimumCollectedAnnualPrice, 2);
  });

  test('a manual discount on a lawn-only estimate is capped at the program minimum (recurring slice)', () => {
    // Lawn-only, standard/6x at 4,500 sqft: the $38/mo bracket cell floors to
    // $50/mo ($600/yr). The whole recurring base is floor-protected, so a 10%
    // manual discount has zero recurring room — the recurring slice caps to 0
    // and the plan bills the floor.
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4500,
      services: {
        lawn: { track: 'st_augustine', lawnFreq: 6 },
      },
      manualDiscount: { type: 'PERCENT', value: 10 },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');
    expect(lawn.annual).toBe(600);
    expect(lawn.programMinimumApplied).toBe(true);
    expect(estimate.summary.manualDiscount.recurringAmount).toBe(0);
    expect(estimate.summary.manualDiscount.capped).toBe(true);
    expect(estimate.summary.manualDiscount.capReason).toBe('lawn_program_minimum');
    expect(estimate.summary.recurringAnnualAfterDiscount).toBeGreaterThanOrEqual(600);
  });

  test('requesting the retired 4-application tier falls back to enhanced (quarterly retired 2026-07-09)', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, {
      track: 'st_augustine', tier: 'basic', lawnFreq: 4,
    });

    expect(lawn.tiers).toHaveLength(3);
    expect(lawn.tiers.map(t => t.tier)).toEqual(['standard', 'enhanced', 'premium']);
    expect(lawn.selected.tier).toBe('enhanced');
    expect(lawn.tier).toBe('enhanced');
    expect(lawn.frequency).toBe(9);

    // Legacy/admin flows can still price the retired tier explicitly.
    const withHidden = priceLawnCare(property, {
      track: 'st_augustine', tier: 'basic', lawnFreq: 4, includeHiddenTiers: true,
    });
    expect(withHidden.selected.tier).toBe('basic');
    expect(withHidden.frequency).toBe(4);
  });

  test('useLawnCostFloor defaults to true for recurring lawn', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    // With cost floor on by default and material budgets, most tiers will show COST_FLOOR
    expect(lawn.selected.costFloorAnnual).toBeGreaterThan(0);
  });
});
