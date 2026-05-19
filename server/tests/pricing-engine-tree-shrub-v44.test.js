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
    // Lot-based fallthrough now reports its own source so admin tooling can
    // distinguish a customer-confirmed estimate from a lot-density inference.
    expect(quote.bedAreaSource).toBe('lot_based');
    expect(quote.bedAreaUsed).toBe(1000);
    expect(quote.bedAreaCapped).toBe(false);
    expect(quote.costs.materialCost).toBeCloseTo(110, 2);
  });
});

describe('Tree & Shrub estimator hardening', () => {
  const {
    constants,
    generateEstimate,
    priceTreeShrub,
    evaluateTreeShrubTierRecommendation,
    resolveTreeShrubBedArea,
    TS_PREMIUM_DEPRECATED_WARNING_CODE,
  } = require('../services/pricing-engine');

  describe('post-discount margin guard', () => {
    const originalPlatinumDiscount = constants.WAVEGUARD.tiers.platinum.discount;
    afterEach(() => {
      constants.WAVEGUARD.tiers.platinum.discount = originalPlatinumDiscount;
    });

    function makeBaseEstimateInput(overrides = {}) {
      return {
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
        ...overrides,
      };
    }

    test('guard uses directCost + adminCost (not directCost alone)', () => {
      constants.WAVEGUARD.tiers.platinum.discount = 0.40;
      const estimate = generateEstimate(makeBaseEstimateInput());
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      const expectedMin = (ts.costs.directCost + ts.costs.adminCost) /
        (1 - constants.TREE_SHRUB.marginFloor);
      // ceilMoney → match to within a cent.
      expect(ts.minAnnualForMargin).toBeCloseTo(Math.ceil(expectedMin * 100) / 100, 2);
      // Implied finalAnnual must clear the protected floor.
      expect(ts.finalAnnual).toBeGreaterThanOrEqual(ts.minAnnualForMargin);
    });

    test('displayed margin never falls below 35% when a discount is applied', () => {
      constants.WAVEGUARD.tiers.platinum.discount = 0.40;
      const estimate = generateEstimate(makeBaseEstimateInput());
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      const displayedMargin =
        (ts.finalAnnual - ts.costs.directCost - ts.costs.adminCost) / ts.finalAnnual;
      expect(displayedMargin).toBeGreaterThanOrEqual(constants.TREE_SHRUB.marginFloor - 1e-9);
      expect(ts.finalMargin).toBeGreaterThanOrEqual(0.35);
    });

    test('guard never raises the discounted price above the original undiscounted annual', () => {
      // 90% discount would push the price absurdly low; guard should lift it
      // back to the margin floor, but never above the original list price.
      constants.WAVEGUARD.tiers.platinum.discount = 0.90;
      const estimate = generateEstimate(makeBaseEstimateInput());
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      expect(ts.finalAnnual).toBeLessThanOrEqual(ts.preDiscountAnnual);
    });

    test('non-Tree & Shrub services are not touched by the T&S guard', () => {
      constants.WAVEGUARD.tiers.platinum.discount = 0.40;
      const estimate = generateEstimate(makeBaseEstimateInput());
      for (const item of estimate.lineItems) {
        if (item.service === 'tree_shrub') continue;
        // Only T&S should carry marginGuardApplied / discountCapped fields.
        expect(item.marginGuardApplied).toBeUndefined();
        expect(item.discountCapped).toBeUndefined();
      }
    });
  });

  describe('bed-area metadata', () => {
    test('explicit bed area is preserved and reported as explicit', () => {
      const quote = priceTreeShrub({ bedArea: 3500 }, { tier: 'standard' });
      expect(quote.bedAreaUsed).toBe(3500);
      expect(quote.bedAreaSource).toBe('explicit');
      expect(quote.bedAreaCapped).toBe(false);
      expect(quote.manualReview).toBe(false);
      expect(quote.manualReviewReasons).toEqual([]);
    });

    test('estimated bed area is reported as estimated', () => {
      const quote = priceTreeShrub({ estimatedBedAreaSf: 2200 }, { tier: 'standard' });
      expect(quote.bedAreaUsed).toBe(2200);
      expect(quote.bedAreaSource).toBe('estimated');
      expect(quote.bedAreaCapped).toBe(false);
    });

    test('lot-based bed area is reported as lot_based', () => {
      const quote = priceTreeShrub(
        { lotSqFt: 10000, features: { shrubs: 'light', complexity: 'simple' } },
        { tier: 'standard' }
      );
      expect(quote.bedAreaSource).toBe('lot_based');
      expect(quote.bedAreaUsed).toBe(1000);
    });

    test('fallback path triggers missing_bed_area_fallback', () => {
      const quote = priceTreeShrub({}, { tier: 'standard' });
      expect(quote.bedAreaSource).toBe('fallback');
      expect(quote.bedAreaUsed).toBe(2000);
      expect(quote.manualReview).toBe(true);
      expect(quote.manualReviewReasons).toContain('missing_bed_area_fallback');
    });

    test('lot-based cap reports uncapped estimate and bed_area_cap_reached', () => {
      // Heavy shrubs + complex landscape on a 40k lot ⇒ raw ≈ 12,000 sqft,
      // which exceeds the 8,000 BED_AREA_CAP.
      const quote = priceTreeShrub(
        { lotSqFt: 40000, features: { shrubs: 'heavy', complexity: 'complex' } },
        { tier: 'standard' }
      );
      expect(quote.bedAreaSource).toBe('lot_based');
      expect(quote.bedAreaUsed).toBe(8000);
      expect(quote.bedAreaCapped).toBe(true);
      expect(quote.uncappedBedAreaEstimate).toBeGreaterThan(8000);
      expect(quote.manualReview).toBe(true);
      expect(quote.manualReviewReasons).toContain('bed_area_cap_reached');
      expect(quote.manualReviewReasons).toContain('bed_area_at_or_above_8000');
    });

    test('tree_count_at_or_above_15 trips manual review even with explicit bed area', () => {
      const quote = priceTreeShrub({ bedArea: 1500 }, { tier: 'standard', treeCount: 16 });
      expect(quote.manualReview).toBe(true);
      expect(quote.manualReviewReasons).toContain('tree_count_at_or_above_15');
    });

    test('difficult access with large bed area trips difficult_access_large_bed_area', () => {
      const quote = priceTreeShrub({ bedArea: 4500 }, { tier: 'standard', access: 'difficult' });
      expect(quote.manualReview).toBe(true);
      expect(quote.manualReviewReasons).toContain('difficult_access_large_bed_area');
    });

    test('resolveTreeShrubBedArea is exported and returns the same metadata used by the pricer', () => {
      const info = resolveTreeShrubBedArea({ bedArea: 1500 });
      expect(info.bedArea).toBe(1500);
      expect(info.bedAreaSource).toBe('explicit');
      expect(info.pricingConfidence).toBe('high');
    });
  });

  describe('tier recommendation reasons', () => {
    test('standard recommendation has empty reason list', () => {
      const result = evaluateTreeShrubTierRecommendation({
        bedArea: 1000,
        shrubDensity: 'light',
        complexity: 'simple',
        treeCount: 0,
        access: 'easy',
      });
      expect(result.recommendedTier).toBe('standard');
      expect(result.recommendationReasons).toEqual([]);
    });

    test.each([
      [{ bedArea: 2000 }, 'bed_area_at_or_above_2000'],
      [{ bedArea: 1000, shrubDensity: 'heavy' }, 'heavy_density'],
      [{ bedArea: 1000, complexity: 'complex' }, 'moderate_or_complex_property'],
      [{ bedArea: 1000, treeCount: 10 }, 'tree_count_at_or_above_8'],
      [{ bedArea: 1000, access: 'difficult' }, 'difficult_access'],
      [{ bedArea: 1000, overallPestPressure: 'HIGH' }, 'high_pest_pressure'],
    ])('enhanced recommendation includes the matching reason code (%o)', (input, reasonCode) => {
      const result = evaluateTreeShrubTierRecommendation(input);
      expect(result.recommendedTier).toBe('enhanced');
      expect(result.recommendationReasons).toContain(reasonCode);
    });

    test('fallback bed area surfaces both the 2,000 trigger and fallback_bed_area_used', () => {
      // No bedArea, no estimatedBedArea, no lotSqFt ⇒ resolver/recommender
      // both fall back to 2,000 sqft. That hits the 2,000 escalation, so
      // enhanced is recommended — but admin/customer surfaces must see that
      // the trigger was conservative defaults.
      const result = evaluateTreeShrubTierRecommendation({});
      expect(result.recommendedTier).toBe('enhanced');
      expect(result.recommendationReasons).toContain('bed_area_at_or_above_2000');
      expect(result.recommendationReasons).toContain('fallback_bed_area_used');
    });

    test('priceTreeShrub surfaces selectedTier / recommendedTier / recommendationReasons', () => {
      const quote = priceTreeShrub({ bedArea: 2500 }, { tier: 'standard' });
      expect(quote.selectedTier).toBe('standard');
      expect(quote.recommendedTier).toBe('enhanced');
      expect(quote.recommendationReasons).toContain('bed_area_at_or_above_2000');
    });
  });

  describe('premium tier deprecation', () => {
    test('active tier list excludes premium', () => {
      expect(Object.keys(constants.TREE_SHRUB.tiers).sort()).toEqual(['enhanced', 'standard']);
      expect(constants.TREE_SHRUB.tiers.premium).toBeUndefined();
    });

    test('incoming premium tier maps to enhanced with a structured warning code', () => {
      const quote = priceTreeShrub({ bedArea: 2000 }, { tier: 'premium' });
      expect(quote.tier).toBe('enhanced');
      expect(quote.frequency).toBe(9);
      expect(quote.legacyTierRequested).toBe('premium');
      expect(quote.warningCodes).toBeDefined();
      expect(quote.warningCodes).toContain(TS_PREMIUM_DEPRECATED_WARNING_CODE);
      expect(TS_PREMIUM_DEPRECATED_WARNING_CODE).toBe('tree_shrub_premium_deprecated_mapped_to_enhanced');
    });

    test('deprecated premium config (TS_MATERIAL_RATE_12X) is not used by the active pricer', () => {
      // Premium request must NOT pick up the deprecated 0.220 material rate.
      const quote = priceTreeShrub({ bedArea: 2000 }, { tier: 'premium' });
      expect(quote.materialRate).toBe(constants.TREE_SHRUB.tiers.enhanced.materialRate);
      expect(quote.materialRate).not.toBe(0.220);
    });
  });

  describe('config parity (constants vs DB seed defaults)', () => {
    // Code constants stay authoritative; this test catches drift if anyone
    // edits one surface without the other.
    const fs = require('fs');
    const path = require('path');
    const migrationPath = path.join(
      __dirname, '..', 'models', 'migrations', '20260414000011_pricing_config.js'
    );
    const migrationSrc = fs.readFileSync(migrationPath, 'utf8');

    function seedValue(key) {
      const re = new RegExp(`config_key:\\s*'${key}',\\s*config_value:\\s*([0-9.]+)`);
      const m = migrationSrc.match(re);
      if (!m) throw new Error(`pricing_config seed missing ${key}`);
      return Number(m[1]);
    }

    test('standard material rate matches between code and seed', () => {
      expect(seedValue('TS_MATERIAL_RATE_6X')).toBe(constants.TREE_SHRUB.tiers.standard.materialRate);
    });

    test('enhanced material rate matches between code and seed', () => {
      expect(seedValue('TS_MATERIAL_RATE_9X')).toBe(constants.TREE_SHRUB.tiers.enhanced.materialRate);
    });

    test('standard monthly floor matches between code and seed', () => {
      expect(seedValue('TS_FLOOR_STANDARD')).toBe(constants.TREE_SHRUB.tiers.standard.monthlyFloor);
    });

    test('enhanced monthly floor matches between code and seed', () => {
      expect(seedValue('TS_FLOOR_ENHANCED')).toBe(constants.TREE_SHRUB.tiers.enhanced.monthlyFloor);
    });

    test('admin annual + margin floor match between code and seed', () => {
      expect(seedValue('ADMIN_ANNUAL')).toBe(constants.GLOBAL.ADMIN_ANNUAL);
      expect(seedValue('MARGIN_FLOOR')).toBe(constants.GLOBAL.MARGIN_FLOOR);
    });

    test('deprecated premium keys remain in seed but are not promoted into active tiers', () => {
      // Presence is fine (legacy migrations are immutable). What matters is
      // that the runtime engine never instantiates them as active.
      expect(seedValue('TS_MATERIAL_RATE_12X')).toBe(0.220);
      expect(seedValue('TS_FLOOR_PREMIUM')).toBe(80);
      expect(constants.TREE_SHRUB.tiers.premium).toBeUndefined();
    });
  });

  describe('monthly floor semantics', () => {
    test('base monthly is the pre-discount list price floor', () => {
      // Tiny landscape that would otherwise price below the $50 standard floor.
      const quote = priceTreeShrub({ bedArea: 100 }, { tier: 'standard' });
      expect(quote.monthly).toBe(constants.TREE_SHRUB.tiers.standard.monthlyFloor);
      expect(quote.annual).toBe(quote.monthly * 12);
    });
  });
});
