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
});
