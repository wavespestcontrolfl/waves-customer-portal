const {
  constants,
  calculatePropertyProfile,
  generateEstimate,
  priceTreeShrub,
  recommendTreeShrubTier,
} = require('../services/pricing-engine');

describe('Tree & Shrub Pricing v4.4', () => {
  const originalPlatinumDiscount = constants.WAVEGUARD.tiers.platinum.discount;

  afterEach(() => {
    constants.WAVEGUARD.tiers.platinum.discount = originalPlatinumDiscount;
  });

  test('active customer-facing tiers include only standard and enhanced', () => {
    expect(Object.keys(constants.TREE_SHRUB.tiers)).toEqual(['standard', 'enhanced']);
    expect(constants.TREE_SHRUB.tiers.premium).toBeUndefined();
  });

  test('legacy premium request maps to enhanced with warning', () => {
    const quote = priceTreeShrub({ bedArea: 2000, treeCount: 0 }, { tier: 'premium' });

    expect(quote.legacyTierRequested).toBe('premium');
    expect(quote.tier).toBe('enhanced');
    expect(quote.frequency).toBe(9);
    expect(quote.warnings).toContain('Premium Tree & Shrub has been deprecated; Enhanced 9-visit plan was used.');
  });

  test('standard 2,000 sqft worked example', () => {
    const quote = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, access: 'easy' },
      { tier: 'standard' }
    );

    expect(quote.frequency).toBe(6);
    expect(quote.onSiteMin).toBe(25);
    expect(quote.costs.materialCost).toBeCloseTo(220, 2);
    expect(quote.costs.laborCost).toBeCloseTo(122.50, 2);
    expect(quote.monthly).toBeCloseTo(66.38, 2);
    expect(quote.annual).toBeCloseTo(796.56, 2);
    expect(quote.baseMargin).toBeCloseTo(0.506, 3);
  });

  test('enhanced 2,000 sqft worked example', () => {
    const quote = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, access: 'easy' },
      { tier: 'enhanced' }
    );

    expect(quote.frequency).toBe(9);
    expect(quote.onSiteMin).toBe(25);
    expect(quote.costs.materialCost).toBeCloseTo(380, 2);
    expect(quote.costs.laborCost).toBeCloseTo(183.75, 2);
    expect(quote.monthly).toBeCloseTo(109.25, 2);
    expect(quote.annual).toBeCloseTo(1311.00, 2);
    expect(quote.baseMargin).toBeCloseTo(0.531, 3);
  });

  test('post-discount margin guard caps unsafe Tree & Shrub discount', () => {
    constants.WAVEGUARD.tiers.platinum.discount = 0.40;

    const estimate = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      bedArea: 2000,
      propertyType: 'single_family',
      zone: 'A',
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
        treeShrub: { tier: 'standard', access: 'easy', treeCount: 0 },
        mosquito: { tier: 'monthly12' },
      },
    });

    const treeShrub = estimate.lineItems.find(item => item.service === 'tree_shrub');
    expect(treeShrub.requestedDiscountPct).toBeCloseTo(0.40, 3);
    expect(treeShrub.marginGuardApplied).toBe(true);
    expect(treeShrub.discountCapped).toBe(true);
    expect(treeShrub.finalMargin).toBeGreaterThanOrEqual(0.35);
    expect(treeShrub.actualDiscountPct).toBeLessThan(treeShrub.requestedDiscountPct);
    expect(treeShrub.finalAnnual).toBeGreaterThanOrEqual(treeShrub.minAnnualForMargin);
    expect(estimate.marginWarnings.some(w => w.service === 'tree_shrub')).toBe(false);
  });

  test('missing bed area uses low-confidence fallback and manual review', () => {
    const quote = priceTreeShrub({}, { tier: 'standard' });

    expect(quote.bedArea).toBe(2000);
    expect(quote.bedAreaSource).toBe('fallback');
    expect(quote.pricingConfidence).toBe('low');
    expect(quote.requiresManualReview).toBe(true);
    expect(quote.warnings).toContain('Tree & Shrub bed area was not provided; fallback 2,000 sqft was used.');
  });

  test('zero bed area sentinels do not bypass fallback pricing', () => {
    const quote = priceTreeShrub(
      { bedArea: 0, estimatedBedAreaSf: 0 },
      { tier: 'standard' }
    );

    expect(quote.bedArea).toBe(2000);
    expect(quote.bedAreaSource).toBe('fallback');
    expect(quote.pricingConfidence).toBe('low');
    expect(quote.requiresManualReview).toBe(true);
    expect(quote.annual).toBeCloseTo(796.56, 2);
    expect(quote.warnings).toContain('Tree & Shrub bed area was not provided; fallback 2,000 sqft was used.');
  });

  test('bed cap triggers manual review warning', () => {
    const quote = priceTreeShrub({ bedArea: 8000 }, { tier: 'standard' });

    expect(quote.requiresManualReview).toBe(true);
    expect(quote.warnings).toContain('Tree & Shrub bed area hit the estimator cap; manual review recommended.');
  });

  test('tier recommendation keeps light small landscapes standard and escalates higher-risk properties', () => {
    expect(recommendTreeShrubTier({
      bedArea: 1000,
      shrubDensity: 'light',
      complexity: 'simple',
      treeCount: 0,
      access: 'easy',
    })).toBe('standard');

    expect(recommendTreeShrubTier({ bedArea: 2000, shrubDensity: 'light' })).toBe('enhanced');
    expect(recommendTreeShrubTier({ bedArea: 1000, shrubDensity: 'heavy' })).toBe('enhanced');
    expect(recommendTreeShrubTier({ bedArea: 1000, overallPestPressure: 'HIGH' })).toBe('enhanced');
  });

  test('default tier recommendation uses option-level tree count and access', () => {
    expect(priceTreeShrub({ bedArea: 1000 }, { treeCount: 10 }).tier).toBe('enhanced');
    expect(priceTreeShrub({ bedArea: 1000 }, { access: 'difficult' }).tier).toBe('enhanced');
  });

  test('default tier recommendation uses V2 overall pest pressure', () => {
    const estimate = generateEstimate({
      homeSqFt: 1000,
      lotSqFt: 5000,
      bedArea: 1000,
      overallPestPressure: 'VERY_HIGH',
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
      services: { treeShrub: {} },
    });

    const treeShrub = estimate.lineItems.find(item => item.service === 'tree_shrub');
    expect(treeShrub.tier).toBe('enhanced');
    expect(treeShrub.recommendedTier).toBe('enhanced');
  });

  test('estimatedBedArea alias is normalized before turf fallback math', () => {
    const property = calculatePropertyProfile({
      homeSqFt: 0,
      lotSqFt: 10000,
      propertyType: 'single_family',
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 20,
      estimatedBedArea: 2000,
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    });

    expect(property.bedArea).toBe(2000);
    expect(property.bedAreaSource).toBe('estimated');
    expect(property.turfOpenArea).toBe(8000);
    expect(property.turfSf).toBe(6000);
  });

  test('zero estimated bed area sentinel is ignored by Tree & Shrub resolver when lot estimate is available', () => {
    const property = calculatePropertyProfile({
      homeSqFt: 0,
      lotSqFt: 10000,
      propertyType: 'single_family',
      estimatedTurfSf: 0,
      estimatedBedAreaSf: 0,
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
    });

    expect(property.bedArea).toBe(0);
    expect(property.bedAreaSource).toBe('estimated');

    const quote = priceTreeShrub(property, { tier: 'standard' });
    expect(quote.bedArea).toBe(1000);
    expect(quote.bedAreaSource).toBe('estimated');
    expect(quote.costs.materialCost).toBeCloseTo(110, 2);
  });
});
