const {
  calculatePropertyProfile,
  generateEstimate,
  normalizeGrassType,
  priceLawnCare,
  priceOneTimeLawn,
} = require('../services/pricing-engine');
const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');
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
    // Owner 2026-07-17 ("forget all pricing floors"): the 35% cost floor is
    // default-OFF, so a 25,000 sqft lawn prices off the extrapolated market
    // table instead of riding the margin floor above it.
    expect(lawn.pricingBasis).toBe('EXTRAPOLATED_ABOVE_TABLE_MAX');
    expect(lawn.selected.pricingBasis).toBe('EXTRAPOLATED_ABOVE_TABLE_MAX');
    expect(lawn.selected.costFloorApplied).toBe(false);
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
    // 8,000 sqft keeps the MARKET_TABLE vs COST_FLOOR source plumbing
    // visible. The floor is re-armed explicitly here (useLawnCostFloor
    // defaults false since the 2026-07-17 owner ruling) because this test
    // pins the provenance labels the floor path emits when selected.
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

  test('small lawn prices off the market table — the $50 program minimum is disarmed (owner 2026-07-17)', () => {
    const property = calculatePropertyProfile(baseInput({
      homeSqFt: 2720,
      lotSqFt: 7200,
      measuredTurfSf: 2870,
      features: { complexity: 'simple' },
    }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    // Owner 2026-07-17 ("forget all pricing floors"): programMinimumMonthly is
    // 0, so the $564/yr market cell that used to floor at $600/$603 is now the
    // sold price as-is: $564/yr ÷ 9 apps = $62.67/app.
    expect(lawn.selected.perApp).toBe(62.67);
    expect(lawn.selected.annual).toBe(564);
    expect(lawn.selected.pricingSource).toBe('MARKET_TABLE');
    expect(lawn.selected.programMinimumApplied).toBe(false);
    expect(lawn.selected.costFloorApplied).toBe(false);
    // Cost-floor MATH still runs for reporting and sits below market here.
    expect(lawn.selected.costFloorAnnual).toBeLessThan(lawn.selected.marketAnnual);
    expect(lawn.margin).toBeGreaterThan(0.44); // 0.447 on the $564 market price (reserve-folded budgets, #2812)
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
    // Owner 2026-07-17 ("forget all pricing floors"): the $564 market cell no
    // longer floors at $600 — it sells at $564/yr ($62.67/app) and Silver 10%
    // applies IN FULL: $564 × 0.90 = $507.60/yr = $42.30/mo. The post-discount
    // program-minimum guard is inert (never set), so no discount cap.
    expect(lawn.perApp).toBe(62.67);
    expect(lawn.annual).toBe(564);
    expect(lawn.annualAfterDiscount).toBe(507.6);
    expect(lawn.monthlyAfterDiscount).toBe(42.3);
    expect(lawn.programMinimumGuardApplied).toBeUndefined();
    expect(lawn.discountCapped).toBeUndefined();
    expect(lawn.pricingSource).toBe('MARKET_TABLE');
    expect(lawn.programMinimumApplied).toBe(false);
    expect(lawn.costFloorApplied).toBe(false);
  });

  test('cost floor (re-armed) uses annual material budgets by grass type (not $8/K fallback)', () => {
    // Owner 2026-07-17 ("forget all pricing floors"): useLawnCostFloor now
    // defaults FALSE, so floor selection never happens on a real quote. This
    // test re-arms it explicitly because it pins the floor-derivation math
    // itself — material budgets must differ by grass type, not the $8/K
    // fallback — which still feeds minimumCollectedAnnualPrice reporting.
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4492 }));

    const stAug = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9, useLawnCostFloor: true });
    const bermuda = priceLawnCare(property, { track: 'bermuda', lawnFreq: 9, useLawnCostFloor: true });
    const zoysia = priceLawnCare(property, { track: 'zoysia', lawnFreq: 9, useLawnCostFloor: true });

    // St. Augustine enhanced at 4,492 sqft: 35% collected-margin floor with
    // spot reserves folded in (#2812) lands at $621/yr = $69/app. The old
    // ride-up to the $600 program minimum is gone (minimum is now $0).
    expect(stAug.selected.perApp).toBe(69);
    expect(stAug.selected.costFloorApplied).toBe(true);

    // Bermuda enhanced remains market-table priced because market is above the floor.
    expect(bermuda.selected.perApp).toBe(68);
    expect(bermuda.selected.costFloorApplied).toBe(false);

    // Zoysia enhanced carries the largest reserve budget (#2812 fold), which
    // pushes its floor above the market table — floor-priced when re-armed.
    expect(zoysia.selected.perApp).toBe(73);
    expect(zoysia.selected.costFloorApplied).toBe(true);

    // Per-grass-type budgets, not a flat $/K: three distinct floor dollars.
    // (Recomputed on the folded budgets — see PLACEHOLDER pins below.)
    expect(stAug.selected.costFloorAnnual).toBeCloseTo(613.67, 2);
    expect(bermuda.selected.costFloorAnnual).toBeCloseTo(598.31, 2);
    expect(zoysia.selected.costFloorAnnual).toBeCloseTo(648.99, 2);
  });

  test('dense route St. Augustine enhanced sells the market price below the folded reporting floor', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4250 }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    // Owner 2026-07-17 ("forget all pricing floors"): the $576/yr market
    // cell IS the customer price ($64/app, $48/mo). The cost-floor MATH
    // still reports — with spot reserves folded in (#2812) the reporting
    // floor (~$593.72 minimum-collected, costs ~$385.92) sits ABOVE the
    // market price, so the reported margin (0.33) is below the 35% target.
    // Nothing lifts the price: this is exactly the surfaced-not-enforced
    // case the owner reviews in the estimator.
    expect(lawn.selected.perApp).toBe(64);
    expect(lawn.annual).toBe(576);
    expect(lawn.monthly).toBe(48);
    expect(lawn.selected.costFloorApplied).toBe(false);
    expect(lawn.costs.total).toBeGreaterThanOrEqual(385);
    expect(lawn.costs.total).toBeLessThan(386);
    expect(lawn.minimumCollectedAnnualPrice).toBeGreaterThanOrEqual(593);
    expect(lawn.minimumCollectedAnnualPrice).toBeLessThan(594);
    expect(lawn.margin).toBeCloseTo(0.33, 2);
    expect(lawn.pricingBasis).toBe('TABLE_INTERPOLATION');
    expect(lawn.pricingSource).toBe('MARKET_TABLE');
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
    expect(lawn.annual).toBe(576);
    // Owner 2026-07-17 ("forget all pricing floors"): the program minimum is
    // disarmed, so Silver 10% applies IN FULL — $576 × 0.90 = $518.40/yr =
    // $43.20/mo. The guard/cap fields are never set anymore.
    expect(lawn.annualAfterDiscount).toBe(518.4);
    expect(lawn.monthlyAfterDiscount).toBe(43.2);
    expect(lawn.programMinimumGuardApplied).toBeUndefined();
    expect(lawn.discountCapped).toBeUndefined();
    expect(lawn.requestedDiscountPct).toBeUndefined();
    expect(lawn.actualDiscountPct).toBeUndefined();
    expect(lawn.discount).toMatchObject({
      discountable: true,
      requestedDiscountPercent: 0.10,
      appliedDiscountPercent: 0.10,
      effectiveDiscount: 0.10,
    });
  });

  test('re-armed: WaveGuard cannot discount lawn below its 35% collected-margin floor', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 5012,
      useLawnCostFloor: true,
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
    // An at-floor cap is NOT a breach — the report signal stays quiet.
    expect(lawn.belowMarginFloor).toBe(false);
    expect(estimate.marginWarnings.find((w) => w.type === 'waveguard_discount_below_margin_floor'))
      .toBeUndefined();
  });

  test('a WaveGuard-discounted lawn line below 35% surfaces the report-only signal while disarmed', () => {
    // Same bundle, floors disarmed: Silver discounts the 5,012 sqft lawn
    // line below its collected-margin floor. Nothing caps it — but the
    // estimator gets the same belowMarginFloor / finalMargin signals pest
    // and tree/shrub emit, plus a Pricing Review Note via marginWarnings
    // (codex P2, round 7 on #2827).
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 5012,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(lawn.marginFloorGuardApplied).toBeUndefined();
    expect(lawn.discountCapped).toBeFalsy();
    const collectedMargin = (lawn.annualAfterDiscount - lawn.costs.total)
      / lawn.annualAfterDiscount;
    expect(collectedMargin).toBeLessThan(0.35);
    expect(lawn.belowMarginFloor).toBe(true);
    expect(lawn.finalMargin).toBeCloseTo(Math.round(collectedMargin * 1000) / 1000, 3);
    const warning = estimate.marginWarnings.find((w) => (
      w.service === 'lawn_care' && w.type === 'waveguard_discount_below_margin_floor'
    ));
    expect(warning).toBeTruthy();
    expect(warning.message).toContain('price stands as discounted');
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

    // Owner 2026-07-17 ("forget all pricing floors"): lawn takes the full
    // Silver 10% ($576 → $518.40), so the manual-discount base is pest
    // 421.20 + lawn 518.40 = 939.60.
    expect(lawn.annualAfterDiscount).toBe(518.4);
    expect(estimate.summary.manualDiscount.discountableBase).toBeCloseTo(939.6, 2);
    // With no floor to protect, the 10% manual discount (93.96) applies in
    // full, uncapped — no lawn_program_minimum cap exists anymore.
    expect(estimate.summary.manualDiscount.amount).toBe(93.96);
    expect(estimate.summary.manualDiscount.capped).toBe(false);
    expect(estimate.summary.manualDiscount.capReason).toBeNull();
    expect(estimate.summary.manualDiscount.eligibleServices).toContain('lawn_care_enhanced');
    expect(estimate.summary.manualDiscount.excludedServices).not.toContain('lawn_care_enhanced');
  });

  // Re-armed variants of the #2795 margin-guard suite (useLawnCostFloor
  // arms cost-floor selection AND the post-discount margin-floor caps —
  // disarmed by default since the 2026-07-17 owner ruling; the machinery is
  // kept and these pins prove a re-arm restores the full #2795 behavior).
  test('re-armed: manual lawn discounts are capped at the collected-margin floor before persistence', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 5012,
      useLawnCostFloor: true,
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

  test('re-armed: manual discount audit allocates non-lawn-first — floored lawn keeps its price, pest absorbs the cut', () => {
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
      useLawnCostFloor: true,
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

  test('re-armed: a manual discount inside non-lawn headroom raises no margin warning and leaves lawn audit fields at the floor', () => {
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 5012,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
      useLawnCostFloor: true,
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

  test('re-armed: monthly CEILs when the WaveGuard lawn margin floor binds (never rebuilds a cent under the floor)', () => {
    // 4,632 sqft: margin floor $601.45/yr. 601.45/12 = 50.1208… — nearest-cent
    // rounding gives $50.12/mo which rebuilds $601.44/yr, a cent UNDER the
    // protected floor. The public ladder ceils this case
    // (clampLawnLadderEntry), so the engine must emit $50.13 to stay
    // cent-identical with what the customer sees and accepts.
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4632,
      useLawnCostFloor: true,
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

  test('re-armed: summary monthly CEILs when a manual discount pins lawn exactly on its margin floor', () => {
    // Lawn-only at 4,632 sqft ($603 authored, $601.45 floor): a 50% manual
    // discount clamps to the $1.55 of headroom, leaving the plan billing the
    // floor. round(601.45/12) = $50.12 would understate it; the stored
    // monthly_total must carry the ladder's $50.13.
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4632,
      useLawnCostFloor: true,
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

  test('a manual discount on a lawn-only estimate applies in full — program minimum disarmed (owner 2026-07-17)', () => {
    // Lawn-only, standard/6x at 4,500 sqft: the $38/mo bracket cell used to
    // floor to $50/mo ($600/yr) and zero out the manual discount's recurring
    // slice. Owner 2026-07-17 ("forget all pricing floors"): the cell sells
    // at its market $456/yr, and the 10% manual discount ($45.60) applies in
    // full — no lawn_program_minimum cap, plan bills $410.40.
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4500,
      services: {
        lawn: { track: 'st_augustine', lawnFreq: 6 },
      },
      manualDiscount: { type: 'PERCENT', value: 10 },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');
    expect(lawn.annual).toBe(456);
    expect(lawn.programMinimumApplied).toBe(false);
    expect(estimate.summary.manualDiscount.recurringAmount).toBe(45.6);
    expect(estimate.summary.manualDiscount.capped).toBe(false);
    expect(estimate.summary.manualDiscount.capReason).toBeNull();
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(410.4);
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

  test('a deep lawn-only manual discount surfaces the below-margin warning while disarmed (report-only)', () => {
    // 4,500 sqft standard/6x: market $456/yr, 50% manual → $228 collected.
    // Nothing caps it (floors disarmed), but the owner still gets the
    // "looks low" signal — the same warn path pest/tree lines already have
    // (codex P2 on the #2827 main-merge: guardedLineCost had no lawn branch).
    const estimate = generateEstimate(baseInput({
      measuredTurfSf: 4500,
      services: { lawn: { track: 'st_augustine', lawnFreq: 6 } },
      manualDiscount: { type: 'PERCENT', value: 50 },
    }));
    const lawn = estimate.lineItems.find(i => i.service === 'lawn_care');

    expect(estimate.summary.manualDiscount.capped).toBe(false);
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(228);
    expect(lawn.manualFinalAnnual).toBe(228);
    expect(lawn.manualFinalMargin).toBeLessThan(0.35);
    expect(lawn.manualMarginWarning).toBe(true);
    const warning = estimate.marginWarnings.find((w) => (
      w.service === 'lawn_care' && w.type === 'manual_discount_below_margin_floor'
    ));
    expect(warning).toBeTruthy();
  });

  test('re-armed: the live DB switch arms cost-floor selection for direct priceLawnCare callers', () => {
    // Direct callers (weekly invariant sweep, public lawn assessment,
    // snapshots) pass no option — the destructuring default reads the live
    // lawn_pricing_v2.useLawnCostFloor switch so a no-deploy re-arm reaches
    // them exactly like generateEstimate (codex P2 on the #2827 main-merge).
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const prior = LAWN_PRICING_V2.useLawnCostFloor;
    LAWN_PRICING_V2.useLawnCostFloor = true;
    try {
      const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });
      // Same fixture as the disarmed default pin below: floor $591.25 sits
      // above the $588 market cell, so armed selection must take the floor.
      expect(lawn.selected.costFloorApplied).toBe(true);
      expect(lawn.selected.pricingSource).toBe('COST_FLOOR');
      expect(lawn.selected.annual).toBeGreaterThan(588);
    } finally {
      LAWN_PRICING_V2.useLawnCostFloor = prior;
    }
  });

  test('the engine stamps its resolved cost-floor arm state into pricingMetadata', () => {
    // The stamp is the authoritative record of what priced the saved result
    // — estimate-public reads it first so a later global switch flip can't
    // change how a sent quote replays (codex P2, round 8 on #2827).
    const disarmed = generateEstimate(baseInput({
      measuredTurfSf: 4500,
      services: { lawn: { track: 'st_augustine', lawnFreq: 9 } },
    }));
    expect(disarmed.pricingMetadata.lawnCostFloorArmed).toBe(false);

    const armed = generateEstimate(baseInput({
      measuredTurfSf: 4500,
      useLawnCostFloor: true,
      services: { lawn: { track: 'st_augustine', lawnFreq: 9 } },
    }));
    expect(armed.pricingMetadata.lawnCostFloorArmed).toBe(true);
  });

  test('useLawnCostFloor defaults to false — cost-floor math is reporting-only (owner 2026-07-17)', () => {
    const property = calculatePropertyProfile(baseInput({ measuredTurfSf: 4500 }));
    const lawn = priceLawnCare(property, { track: 'st_augustine', lawnFreq: 9 });

    // The floor math still runs and is emitted for margin reporting…
    expect(lawn.selected.costFloorAnnual).toBeGreaterThan(0);
    // …and here it sits ABOVE the market cell ($591.25 vs $588) — yet the
    // quote stays market-priced, proving the default is disarmed.
    expect(lawn.selected.costFloorAnnual).toBeGreaterThan(lawn.selected.marketAnnual);
    expect(lawn.selected.costFloorApplied).toBe(false);
    expect(lawn.selected.pricingSource).toBe('MARKET_TABLE');
    expect(lawn.selected.annual).toBe(588);
  });
});
