const { generateEstimate } = require('../services/pricing-engine');

function pestLine(input) {
  const result = generateEstimate({
    propertyType: 'single_family',
    zone: 'A',
    stories: 1,
    services: { pest: { frequency: 'quarterly' } },
    ...input,
  });
  return result.lineItems.find(item => item.service === 'pest_control');
}

describe('pest production burden pricing inputs', () => {
  test('pool cage size replaces the flat cage adder', () => {
    const base = {
      homeSqFt: 2500,
      lotSqFt: 10000,
      features: {
        pool: true,
        poolCage: true,
        shrubs: 'moderate',
        trees: 'moderate',
        complexity: 'moderate',
      },
    };

    expect(pestLine({ ...base, features: { ...base.features, poolCageSize: 'small' } }).additionalAdj).toBe(5);
    expect(pestLine({ ...base, features: { ...base.features, poolCageSize: 'medium' } }).additionalAdj).toBe(8);
    expect(pestLine({ ...base, features: { ...base.features, poolCageSize: 'large' } }).additionalAdj).toBe(12);
    expect(pestLine({ ...base, features: { ...base.features, poolCageSize: 'oversized' } }).additionalAdj).toBe(18);
  });

  test('lot size is shadow diagnostics only for recurring pest pricing', () => {
    const base = {
      homeSqFt: 2500,
      features: {
        pool: false,
        poolCage: false,
        shrubs: 'moderate',
        trees: 'moderate',
        complexity: 'moderate',
      },
    };
    const baselineLot = pestLine({ ...base, lotSqFt: 7500 });
    const eightThousandLot = pestLine({ ...base, lotSqFt: 8000 });

    expect(eightThousandLot.basePrice).toBe(baselineLot.basePrice);
    expect(eightThousandLot.additionalAdj).toBe(baselineLot.additionalAdj);
    expect(eightThousandLot.productionDiagnostics.breakdown.lot).toBe(0.2);
  });

  test('production diagnostics are shadow-only and scale with large pool-cage properties', () => {
    const standard = pestLine({
      homeSqFt: 2528,
      lotSqFt: 7501,
      features: {
        pool: true,
        poolCage: false,
        shrubs: 'moderate',
        trees: 'moderate',
        complexity: 'moderate',
      },
    });
    const heavy = pestLine({
      homeSqFt: 4233,
      lotSqFt: 24394,
      features: {
        pool: true,
        poolCage: true,
        poolCageSize: 'large',
        shrubs: 'moderate',
        trees: 'moderate',
        complexity: 'moderate',
      },
    });

    expect(standard.productionDiagnostics.pricingMode).toBe('shadow_only');
    expect(heavy.productionDiagnostics.pricingMode).toBe('shadow_only');
    expect(heavy.productionDiagnostics.estimatedMinutes).toBeGreaterThan(standard.productionDiagnostics.estimatedMinutes);
    expect(heavy.productionDiagnostics.breakdown.poolCage).toBe(12);
  });

  test('flags inferred cage size and large lots for manual pricing review', () => {
    const line = pestLine({
      homeSqFt: 4233,
      lotSqFt: 24394,
      storiesSource: 'default',
      features: {
        pool: true,
        poolCage: true,
        shrubs: 'moderate',
        trees: 'moderate',
        complexity: 'moderate',
      },
    });

    expect(line.productionDiagnostics.pricingConfidence).toBe('medium');
    expect(line.productionDiagnostics.manualReview).toBe(true);
    expect(line.productionDiagnostics.poolCageSize).toBe('medium');
    expect(line.productionDiagnostics.poolCageSizeSource).toBe('inferred');
    expect(line.productionDiagnostics.poolCageSizeInferred).toBe(true);
    expect(line.productionDiagnostics.reviewReasons).toEqual(expect.arrayContaining([
      'stories_estimated',
      'pool_cage_size_inferred',
      'large_lot',
    ]));
    expect(line.productionDiagnostics.manualReviewReasons).toEqual(line.productionDiagnostics.reviewReasons);
  });

  test('does not flag manually confirmed story count as estimated', () => {
    const line = pestLine({
      homeSqFt: 2500,
      lotSqFt: 7500,
      stories: 1,
      storiesSource: 'manual',
      features: {
        pool: true,
        poolCage: true,
        poolCageSize: 'medium',
        shrubs: 'moderate',
        trees: 'moderate',
        complexity: 'moderate',
      },
    });

    expect(line.productionDiagnostics.reviewReasons).not.toContain('stories_estimated');
    expect(line.productionDiagnostics.poolCageSizeSource).toBe('explicit');
    expect(line.productionDiagnostics.poolCageSizeInferred).toBe(false);
  });

  test('marks missing dimensions and extreme production burden as low confidence', () => {
    const line = pestLine({
      homeSqFt: 0,
      lotSqFt: 50000,
      features: {
        pool: true,
        poolCage: true,
        poolCageSize: 'oversized',
        shrubs: 'heavy',
        trees: 'heavy',
        complexity: 'complex',
      },
      outbuildingCount: 3,
    });

    expect(line.productionDiagnostics.pricingConfidence).toBe('low');
    expect(line.productionDiagnostics.manualReview).toBe(true);
    expect(line.productionDiagnostics.reviewReasons).toEqual(expect.arrayContaining([
      'missing_home_sqft',
      'very_large_lot',
      'oversized_pool_cage',
      'estimated_service_time_60_plus',
    ]));
  });
});
