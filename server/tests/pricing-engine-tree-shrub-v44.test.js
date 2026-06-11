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

  test('active customer-facing tiers include only light and standard', () => {
    expect(Object.keys(constants.TREE_SHRUB.tiers)).toEqual(['light', 'standard']);
    expect(constants.TREE_SHRUB.tiers.enhanced).toBeUndefined();
    expect(constants.TREE_SHRUB.tiers.premium).toBeUndefined();
  });

  test('legacy premium request maps to the 6-visit standard plan with warning', () => {
    const quote = priceTreeShrub({ bedArea: 2000, treeCount: 0 }, { tier: 'premium' });

    expect(quote.legacyTierRequested).toBe('premium');
    expect(quote.tier).toBe('standard');
    expect(quote.frequency).toBe(6);
    expect(quote.warnings).toContain('Premium Tree & Shrub has been retired; the 6-visit Standard plan was used.');
  });

  test('legacy enhanced request maps to the 6-visit standard plan with warning', () => {
    const quote = priceTreeShrub({ bedArea: 2000, treeCount: 0 }, { tier: 'enhanced' });

    expect(quote.legacyTierRequested).toBe('enhanced');
    expect(quote.tier).toBe('standard');
    expect(quote.frequency).toBe(6);
    expect(quote.warnings).toContain('Enhanced (9-visit) Tree & Shrub has been retired; the 6-visit Standard plan was used.');
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

  test('light 2,000 sqft worked example', () => {
    const quote = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, access: 'easy' },
      { tier: 'light' }
    );

    expect(quote.frequency).toBe(4);
    expect(quote.onSiteMin).toBe(25);
    expect(quote.costs.materialCost).toBeCloseTo(150, 2);
    expect(quote.costs.laborCost).toBeCloseTo(81.67, 2);
    expect(quote.monthly).toBeCloseTo(44.90, 2);
    expect(quote.annual).toBeCloseTo(538.80, 2);
    expect(quote.baseMargin).toBeCloseTo(0.475, 3);
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

  test('6-visit standard is the mandated default recommendation regardless of property signals', () => {
    expect(recommendTreeShrubTier({
      bedArea: 1000,
      shrubDensity: 'light',
      complexity: 'simple',
      treeCount: 0,
      access: 'easy',
    })).toBe('standard');

    // High-signal properties no longer auto-escalate to a 9x tier — 6x is the mandate.
    expect(recommendTreeShrubTier({ bedArea: 2000, shrubDensity: 'light' })).toBe('standard');
    expect(recommendTreeShrubTier({ bedArea: 1000, shrubDensity: 'heavy' })).toBe('standard');
    expect(recommendTreeShrubTier({ bedArea: 1000, overallPestPressure: 'HIGH' })).toBe('standard');
  });

  test('default tier resolution never auto-escalates on tree count or access', () => {
    expect(priceTreeShrub({ bedArea: 1000 }, { treeCount: 10 }).tier).toBe('standard');
    expect(priceTreeShrub({ bedArea: 1000 }, { access: 'difficult' }).tier).toBe('standard');
  });

  test('default tier resolution stays on standard even under high V2 pest pressure', () => {
    const estimate = generateEstimate({
      homeSqFt: 1000,
      lotSqFt: 5000,
      bedArea: 1000,
      overallPestPressure: 'VERY_HIGH',
      features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
      services: { treeShrub: {} },
    });

    const treeShrub = estimate.lineItems.find(item => item.service === 'tree_shrub');
    expect(treeShrub.tier).toBe('standard');
    expect(treeShrub.recommendedTier).toBe('standard');
  });

  test('light tier is selectable as an explicit downsell', () => {
    const quote = priceTreeShrub({ bedArea: 1000 }, { tier: 'light' });
    expect(quote.tier).toBe('light');
    expect(quote.frequency).toBe(4);
    expect(quote.availableTiers).toEqual(['light', 'standard']);
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
    TS_ENHANCED_DEPRECATED_WARNING_CODE,
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

    test('only guarded services (Tree & Shrub, Pest) carry margin-guard fields', () => {
      constants.WAVEGUARD.tiers.platinum.discount = 0.40;
      const estimate = generateEstimate(makeBaseEstimateInput());
      for (const item of estimate.lineItems) {
        // Tree & Shrub and Pest Control are both auto-discount margin-guarded.
        if (item.service === 'tree_shrub' || item.service === 'pest_control') continue;
        expect(item.marginGuardApplied).toBeUndefined();
        expect(item.discountCapped).toBeUndefined();
      }
      // Pest, when present, is guarded too (fields are defined, even if no cap fired).
      const pest = estimate.lineItems.find(i => i.service === 'pest_control');
      if (pest) {
        expect(typeof pest.marginGuardApplied).toBe('boolean');
        expect(typeof pest.discountCapped).toBe('boolean');
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

    test('generateEstimate preserves lot_based bedAreaSource through calculatePropertyProfile', () => {
      // Regression for Codex P2 #2 on PR #960: before this fix, the
      // production generateEstimate path always reported bedAreaSource:
      // 'estimated' for lot-derived inferences because
      // calculatePropertyProfile labeled the lot-density branch 'estimated'
      // and then priceTreeShrub's explicit-bedArea path could not recover
      // the lot-based provenance. A lot-only quote must now surface
      // 'lot_based' so admin tooling can distinguish a customer-confirmed
      // estimate from a lot-density inference.
      const estimate = generateEstimate({
        homeSqFt: 1800,
        stories: 1,
        lotSqFt: 10000,
        propertyType: 'single_family',
        features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
        services: {
          treeShrub: { tier: 'standard', access: 'easy', treeCount: 0 },
        },
      });
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      expect(ts.bedAreaSource).toBe('lot_based');
      expect(ts.bedAreaUsed).toBeGreaterThan(0);
      expect(ts.bedAreaCapped).toBe(false);
    });

    test('generateEstimate preserves cap metadata when property-calculator pre-caps oversized estimatedBedAreaSf', () => {
      // Regression for Codex P2 review on PR #960: generateEstimate runs
      // calculatePropertyProfile first, which converts estimatedBedAreaSf:
      // 9000 into bedArea: 8000 + bedAreaCapped: true. The T&S pricer must
      // honor that upstream cap signal — otherwise production estimates for
      // very large landscapes silently miss bed_area_cap_reached.
      const estimate = generateEstimate({
        homeSqFt: 2400,
        stories: 1,
        lotSqFt: 30000,
        estimatedBedAreaSf: 9000,
        propertyType: 'single_family',
        features: { shrubs: 'heavy', trees: 'moderate', complexity: 'moderate' },
        services: {
          treeShrub: { tier: 'standard', access: 'easy', treeCount: 0 },
        },
      });
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      expect(ts.bedAreaUsed).toBe(8000);
      expect(ts.bedAreaCapped).toBe(true);
      expect(ts.uncappedBedAreaEstimate).toBe(9000);
      expect(ts.manualReview).toBe(true);
      expect(ts.manualReviewReasons).toContain('bed_area_cap_reached');
      expect(ts.manualReviewReasons).toContain('bed_area_at_or_above_8000');
    });

    test('generateEstimate preserves cap metadata when lot-density estimate exceeds the cap', () => {
      // Same regression scope but via the lot-derived path:
      // calculatePropertyProfile derives ~13,500 from a 60k lot with heavy
      // shrubs + complex landscape, then caps to 8,000 with the raw value
      // recorded as uncappedBedAreaEstimate.
      const estimate = generateEstimate({
        homeSqFt: 2400,
        stories: 1,
        lotSqFt: 60000,
        propertyType: 'single_family',
        features: { shrubs: 'heavy', trees: 'moderate', complexity: 'complex' },
        services: {
          treeShrub: { tier: 'standard', access: 'easy', treeCount: 0 },
        },
      });
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      expect(ts.bedAreaUsed).toBe(8000);
      expect(ts.bedAreaCapped).toBe(true);
      expect(ts.uncappedBedAreaEstimate).toBeGreaterThan(8000);
      expect(ts.manualReviewReasons).toContain('bed_area_cap_reached');
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
    ])('recommendation stays on standard but surfaces the full-program signal (%o)', (input, reasonCode) => {
      const result = evaluateTreeShrubTierRecommendation(input);
      // 6x is the mandate — signals no longer flip the tier, only annotate it.
      expect(result.recommendedTier).toBe('standard');
      expect(result.recommendationReasons).toContain(reasonCode);
    });

    test('fallback bed area still surfaces the conservative-default signals', () => {
      // No bedArea, no estimatedBedArea, no lotSqFt ⇒ resolver/recommender
      // both fall back to 2,000 sqft. The recommendation stays on the mandated
      // 6x standard, but admin/customer surfaces must still see that the
      // signal came from conservative defaults.
      const result = evaluateTreeShrubTierRecommendation({});
      expect(result.recommendedTier).toBe('standard');
      expect(result.recommendationReasons).toContain('bed_area_at_or_above_2000');
      expect(result.recommendationReasons).toContain('fallback_bed_area_used');
    });

    test('priceTreeShrub surfaces selectedTier / recommendedTier / recommendationReasons', () => {
      const quote = priceTreeShrub({ bedArea: 2500 }, { tier: 'standard' });
      expect(quote.selectedTier).toBe('standard');
      expect(quote.recommendedTier).toBe('standard');
      expect(quote.recommendationReasons).toContain('bed_area_at_or_above_2000');
    });
  });

  describe('retired tier deprecation (enhanced + premium → standard)', () => {
    test('active tier list excludes enhanced and premium', () => {
      expect(Object.keys(constants.TREE_SHRUB.tiers).sort()).toEqual(['light', 'standard']);
      expect(constants.TREE_SHRUB.tiers.enhanced).toBeUndefined();
      expect(constants.TREE_SHRUB.tiers.premium).toBeUndefined();
    });

    test('incoming premium tier maps to standard with a structured warning code', () => {
      const quote = priceTreeShrub({ bedArea: 2000 }, { tier: 'premium' });
      expect(quote.tier).toBe('standard');
      expect(quote.frequency).toBe(6);
      expect(quote.legacyTierRequested).toBe('premium');
      expect(quote.warningCodes).toBeDefined();
      expect(quote.warningCodes).toContain(TS_PREMIUM_DEPRECATED_WARNING_CODE);
      expect(TS_PREMIUM_DEPRECATED_WARNING_CODE).toBe('tree_shrub_premium_deprecated_mapped_to_standard');
    });

    test('incoming enhanced tier maps to standard with a structured warning code', () => {
      const quote = priceTreeShrub({ bedArea: 2000 }, { tier: 'enhanced' });
      expect(quote.tier).toBe('standard');
      expect(quote.frequency).toBe(6);
      expect(quote.legacyTierRequested).toBe('enhanced');
      expect(quote.warningCodes).toContain(TS_ENHANCED_DEPRECATED_WARNING_CODE);
      expect(TS_ENHANCED_DEPRECATED_WARNING_CODE).toBe('tree_shrub_enhanced_deprecated_mapped_to_standard');
    });

    test('retired 9x/12x material rates are not used by the active pricer', () => {
      // Retired tier requests must price at the active 6x standard rate.
      const premium = priceTreeShrub({ bedArea: 2000 }, { tier: 'premium' });
      const enhanced = priceTreeShrub({ bedArea: 2000 }, { tier: 'enhanced' });
      expect(premium.materialRate).toBe(constants.TREE_SHRUB.tiers.standard.materialRate);
      expect(enhanced.materialRate).toBe(constants.TREE_SHRUB.tiers.standard.materialRate);
      expect(premium.materialRate).not.toBe(0.220);
      expect(enhanced.materialRate).not.toBe(0.190);
    });
  });

  describe('config parity (constants vs active DB migration)', () => {
    // Code constants stay authoritative; this test catches drift if anyone
    // edits one surface without the other. The active runtime config is the
    // JSONB pricing_config updated by the 6-visit-mandate migration.
    const fs = require('fs');
    const path = require('path');
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260611000001_tree_shrub_six_visit_mandate.js'),
      'utf8'
    );
    const legacySrc = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260414000011_pricing_config.js'),
      'utf8'
    );

    function migrationNumber(key) {
      const re = new RegExp(`'${key}':\\s*([0-9.]+)`);
      const m = migrationSrc.match(re);
      if (!m) throw new Error(`pricing_config migration missing ${key}`);
      return Number(m[1]);
    }
    function migrationFloor(tier) {
      const re = new RegExp(`\\b${tier}:\\s*([0-9.]+)`);
      const m = migrationSrc.match(re);
      if (!m) throw new Error(`pricing_config migration missing floor ${tier}`);
      return Number(m[1]);
    }
    function legacyValue(key) {
      const re = new RegExp(`config_key:\\s*'${key}',\\s*config_value:\\s*([0-9.]+)`);
      const m = legacySrc.match(re);
      if (!m) throw new Error(`pricing_config seed missing ${key}`);
      return Number(m[1]);
    }

    test('light material rate matches between code and migration', () => {
      expect(migrationNumber('4x_light')).toBe(constants.TREE_SHRUB.tiers.light.materialRate);
    });

    test('standard material rate matches between code and migration', () => {
      expect(migrationNumber('6x_standard')).toBe(constants.TREE_SHRUB.tiers.standard.materialRate);
    });

    test('monthly floors match between code and migration', () => {
      expect(migrationFloor('light')).toBe(constants.TREE_SHRUB.tiers.light.monthlyFloor);
      expect(migrationFloor('standard')).toBe(constants.TREE_SHRUB.tiers.standard.monthlyFloor);
    });

    test('admin annual + margin floor match between code and legacy seed', () => {
      expect(legacyValue('ADMIN_ANNUAL')).toBe(constants.GLOBAL.ADMIN_ANNUAL);
      expect(legacyValue('MARGIN_FLOOR')).toBe(constants.GLOBAL.MARGIN_FLOOR);
    });

    test('retired tiers are not instantiated as active', () => {
      expect(constants.TREE_SHRUB.tiers.enhanced).toBeUndefined();
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
