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

  test('active customer-facing tiers are light, standard, and enhanced (9x un-retired 2026-07-23)', () => {
    expect(Object.keys(constants.TREE_SHRUB.tiers)).toEqual(['light', 'standard', 'enhanced']);
    expect(constants.TREE_SHRUB.tiers.enhanced).toEqual(expect.objectContaining({ frequency: 9 }));
    expect(constants.TREE_SHRUB.tiers.premium).toBeUndefined();
    // Standard remains the mandated default + recommendation — Enhanced is
    // an upsell only.
    expect(constants.TREE_SHRUB.defaultTier).toBe('standard');
    expect(constants.TREE_SHRUB.recommendedTier).toBe('standard');
  });

  test('legacy premium request maps to the 6-visit standard plan with warning', () => {
    const quote = priceTreeShrub({ bedArea: 2000, treeCount: 0 }, { tier: 'premium' });

    expect(quote.legacyTierRequested).toBe('premium');
    expect(quote.tier).toBe('standard');
    expect(quote.frequency).toBe(6);
    expect(quote.warnings).toContain('Premium Tree & Shrub has been retired; the 6-visit Standard plan was used.');
  });

  test('enhanced request prices the active 9-visit tier at 1.25x standard material', () => {
    const quote = priceTreeShrub({ bedArea: 2000, treeCount: 0 }, { tier: 'enhanced' });

    expect(quote.legacyTierRequested).toBeFalsy();
    expect(quote.tier).toBe('enhanced');
    expect(quote.frequency).toBe(9);
    expect(quote.materialModel.tierFactor).toBe(1.25);
    expect(quote.warnings).not.toContain('Enhanced (9-visit) Tree & Shrub has been retired; the 6-visit Standard plan was used.');
  });

  test('standard 2,000 sqft worked example (v4.6)', () => {
    const quote = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, access: 'easy' },
      { tier: 'standard' }
    );

    // materials = max(60, (15 + 4*0 + 0.055*2000) * 1) = 125
    // labor     = 35 * (25+10)/60 * 6 = 122.50
    // annual    = (247.50 + 51) / 0.55 = 542.73/yr → 45.23/mo → 542.76
    expect(quote.frequency).toBe(6);
    expect(quote.onSiteMin).toBe(25);
    expect(quote.costs.materialCost).toBeCloseTo(125, 2);
    expect(quote.costs.laborCost).toBeCloseTo(122.50, 2);
    expect(quote.monthly).toBeCloseTo(45.23, 2);
    expect(quote.annual).toBeCloseTo(542.76, 2);
    expect(quote.baseMargin).toBeCloseTo(0.450, 3);
  });

  test('light 2,000 sqft worked example (v4.6)', () => {
    const quote = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, access: 'easy' },
      { tier: 'light' }
    );

    // materials = max(40, 125 * 0.75) = 93.75
    // labor     = 35 * (25+10)/60 * 4 = 81.67
    // annual    = (175.42 + 51) / 0.55 = 411.67/yr → 34.31/mo → 411.72
    expect(quote.frequency).toBe(4);
    expect(quote.onSiteMin).toBe(25);
    expect(quote.costs.materialCost).toBeCloseTo(93.75, 2);
    expect(quote.costs.laborCost).toBeCloseTo(81.67, 2);
    expect(quote.monthly).toBeCloseTo(34.31, 2);
    expect(quote.annual).toBeCloseTo(411.72, 2);
    expect(quote.baseMargin).toBeCloseTo(0.450, 3);
  });

  test('audit reference quote: 350 sqft beds + 6 trees reprices from $100 to ~$76/application', () => {
    // The June 2026 audit case (estimate token e9077c1f...): the v4.5 engine
    // floored this property at $50/mo = $100/application. v4.6 prices it from
    // the formula at a true 45% margin.
    const quote = priceTreeShrub(
      { bedArea: 350, treeCount: 6, lotSqFt: 10187 },
      { tier: 'standard' }
    );

    // materials = max(60, 15 + 4*6 + 0.055*350 = 58.25) = 60
    // onSite    = max(25, 20 + 1 + 9) = 30 → labor 23.33/visit → 140/yr
    // annual    = (200 + 51) / 0.55 = 456.36 → 38.03/mo → 76.06/application
    expect(quote.monthly).toBeCloseTo(38.03, 2);
    expect(quote.annual).toBeCloseTo(456.36, 2);
    expect(quote.perApp).toBeCloseTo(76.06, 2);
    expect(quote.baseMargin).toBeCloseTo(0.450, 3);
  });

  test('treeCount adds a per-tree material term, not just labor minutes', () => {
    const without = priceTreeShrub({ bedArea: 2000, treeCount: 0 }, { tier: 'standard' });
    const withTrees = priceTreeShrub({ bedArea: 2000, treeCount: 5 }, { tier: 'standard' });

    // +5 trees = +$20/yr materials (perTreeAnnual $4) on top of the labor delta.
    expect(withTrees.costs.materialCost - without.costs.materialCost).toBeCloseTo(20, 2);
    expect(withTrees.onSiteMin).toBeGreaterThan(without.onSiteMin);
  });

  test('missing treeCount falls back to treeDensity estimate with a warning', () => {
    const quote = priceTreeShrub(
      { bedArea: 1000, treeDensity: 'moderate' },
      { tier: 'standard' }
    );

    expect(quote.treeCount).toBe(6);
    expect(quote.treeCountSource).toBe('density_estimate');
    expect(quote.warnings).toContain('Tree count was not provided; estimated 6 trees from moderate tree density.');
  });

  test('features.trees density enum also feeds the treeCount fallback', () => {
    const quote = priceTreeShrub(
      { bedArea: 1000, features: { trees: 'heavy' } },
      { tier: 'standard' }
    );

    expect(quote.treeCount).toBe(10);
    expect(quote.treeCountSource).toBe('density_estimate');
  });

  test('generateEstimate path honors the density fallback when no tree count exists anywhere', () => {
    // Codex P1 on PR #1699: estimate-engine used to synthesize
    // `treeCount: ... ?? 0`, so density-only properties priced as zero trees
    // and lost the v4.6 per-tree material + labor term.
    const estimate = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      bedArea: 2000,
      propertyType: 'single_family',
      features: { shrubs: 'light', trees: 'moderate', complexity: 'simple' },
      services: {
        treeShrub: { tier: 'standard', access: 'easy' },
      },
    });
    const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
    expect(ts.treeCount).toBe(6);
    expect(ts.treeCountSource).toBe('density_estimate');
    // 6 density-estimated trees = +$24/yr materials over a bare 2,000 sqft bed.
    expect(ts.costs.materialCost).toBeCloseTo(149, 2);
  });

  test('generateEstimate path keeps an explicit service-line zero authoritative', () => {
    const estimate = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      bedArea: 2000,
      propertyType: 'single_family',
      features: { shrubs: 'light', trees: 'moderate', complexity: 'simple' },
      services: {
        treeShrub: { tier: 'standard', access: 'easy', treeCount: 0 },
      },
    });
    const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
    expect(ts.treeCount).toBe(0);
    expect(ts.treeCountSource).toBe('explicit');
  });

  test('explicit zero treeCount is authoritative and skips the density fallback', () => {
    const quote = priceTreeShrub(
      { bedArea: 1000, treeCount: 0, treeDensity: 'heavy' },
      { tier: 'standard' }
    );

    expect(quote.treeCount).toBe(0);
    expect(quote.treeCountSource).toBe('explicit');
  });

  test('unfloored quotes land exactly on the 45% admin-inclusive margin target', () => {
    for (const input of [
      { bedArea: 350, treeCount: 6 },
      { bedArea: 2000, treeCount: 8 },
      { bedArea: 4000, treeCount: 10, access: 'moderate' },
    ]) {
      const quote = priceTreeShrub(input, { tier: 'standard' });
      const displayed = (quote.annual - quote.costs.directCost - quote.costs.adminCost) / quote.annual;
      // Rounding the monthly to cents moves the realized margin by <0.1pt.
      expect(displayed).toBeGreaterThanOrEqual(0.449);
      expect(displayed).toBeLessThanOrEqual(0.451);
      expect(quote.marginTarget).toBe(0.45);
    }
  });

  test('Light annual is cheaper than Standard but per-application is honestly higher', () => {
    // Fixed labor + admin spread over fewer visits: the downsell saves money
    // annually while costing more per application. This is intentional —
    // surfaces should show annual side-by-side rather than bending the math.
    const light = priceTreeShrub({ bedArea: 350, treeCount: 6 }, { tier: 'light' });
    const standard = priceTreeShrub({ bedArea: 350, treeCount: 6 }, { tier: 'standard' });

    expect(light.annual).toBeLessThan(standard.annual);
    expect(light.perApp).toBeGreaterThan(standard.perApp);
    expect(light.monthly).toBeLessThan(standard.monthly);
  });

  test('post-discount margin guard is report-only: unsafe Tree & Shrub discount applies uncapped (owner ruling 2026-07-17)', () => {
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
    // Owner ruling 2026-07-17 ("forget all pricing floors"): the guard no
    // longer lifts the price — it only reports the margin shortfall.
    expect(treeShrub.marginGuardApplied).toBe(false);
    expect(treeShrub.discountCapped).toBe(false);
    expect(treeShrub.actualDiscountPct).toBeCloseTo(0.40, 3);
    expect(treeShrub.finalAnnual).toBeCloseTo(325.80, 2); // $543 list × (1 − 0.40), uncapped
    expect(treeShrub.finalMargin).toBeCloseTo(0.084, 3); // well below 35%, price stands
    expect(treeShrub.belowMarginFloor).toBe(true);
    // Auto WaveGuard discounts still never raise margin warnings; the
    // warn-only path for MANUAL discounts in estimate-engine is unchanged.
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
    expect(quote.annual).toBeCloseTo(542.76, 2);
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
    expect(quote.availableTiers).toEqual(['light', 'standard', 'enhanced']);
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
    // materials = max(60, 15 + 0.055*1000) = 70 (features.trees 'light' → 3-tree fallback adds $12)
    expect(quote.costs.materialCost).toBeCloseTo(82, 2);
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

  describe('post-discount margin guard (report-only since owner ruling 2026-07-17)', () => {
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

    test('reported margin uses directCost + adminCost (not directCost alone)', () => {
      constants.WAVEGUARD.tiers.platinum.discount = 0.40;
      const estimate = generateEstimate(makeBaseEstimateInput());
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      // Owner ruling 2026-07-17: no lift, so minAnnualForMargin is no longer
      // stamped — the guard only reports margin against the all-in cost basis.
      expect(ts.minAnnualForMargin).toBeUndefined();
      const allInMargin =
        (ts.finalAnnual - ts.costs.directCost - ts.costs.adminCost) / ts.finalAnnual;
      expect(ts.finalMargin).toBeCloseTo(allInMargin, 3);
      // directCost alone would report ~24% here; admin-inclusive is ~8.4% —
      // pin that the report is admin-inclusive.
      const directOnlyMargin = (ts.finalAnnual - ts.costs.directCost) / ts.finalAnnual;
      expect(Math.abs(ts.finalMargin - directOnlyMargin)).toBeGreaterThan(0.05);
      expect(ts.belowMarginFloor).toBe(true);
    });

    test('displayed margin may fall below 35% — the engine reports it instead of lifting (owner ruling 2026-07-17)', () => {
      constants.WAVEGUARD.tiers.platinum.discount = 0.40;
      const estimate = generateEstimate(makeBaseEstimateInput());
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      const displayedMargin =
        (ts.finalAnnual - ts.costs.directCost - ts.costs.adminCost) / ts.finalAnnual;
      // 40% off drives the collected margin to ~8.4%; the price stands and the
      // shortfall is surfaced only via finalMargin / belowMarginFloor.
      expect(displayedMargin).toBeLessThan(constants.TREE_SHRUB.marginFloor);
      expect(displayedMargin).toBeCloseTo(0.0838, 3);
      expect(ts.finalMargin).toBeCloseTo(displayedMargin, 3);
      expect(ts.belowMarginFloor).toBe(true);
    });

    test('guard never raises the discounted price above the original undiscounted annual', () => {
      // 90% discount pushes the price absurdly low; since the 2026-07-17
      // owner ruling the guard no longer lifts it back — this pin only asserts
      // the discounted price can never exceed the original list price.
      constants.WAVEGUARD.tiers.platinum.discount = 0.90;
      const estimate = generateEstimate(makeBaseEstimateInput());
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      expect(ts.finalAnnual).toBeLessThanOrEqual(ts.preDiscountAnnual);
    });

    test('only guarded services (Tree & Shrub, Pest, Lawn) carry guard fields', () => {
      constants.WAVEGUARD.tiers.platinum.discount = 0.40;
      const estimate = generateEstimate(makeBaseEstimateInput());
      for (const item of estimate.lineItems) {
        // Tree & Shrub and Pest Control carry (report-only since the
        // 2026-07-17 owner ruling) margin-guard fields; the lawn program
        // minimum is now 0, so Lawn carries no guard fields.
        if (item.service === 'tree_shrub' || item.service === 'pest_control') continue;
        if (item.service === 'lawn_care') {
          expect(item.marginGuardApplied).toBeUndefined();
          continue;
        }
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

  describe('tier lineup (9x enhanced un-retired 2026-07-23; premium stays retired)', () => {
    test('active tier list is light, standard, enhanced', () => {
      expect(Object.keys(constants.TREE_SHRUB.tiers).sort()).toEqual(['enhanced', 'light', 'standard']);
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

    test('incoming enhanced tier prices the 9-visit tier with no deprecation warning', () => {
      const quote = priceTreeShrub({ bedArea: 2000 }, { tier: 'enhanced' });
      expect(quote.tier).toBe('enhanced');
      expect(quote.frequency).toBe(9);
      expect(quote.legacyTierRequested).toBeFalsy();
      expect(quote.warningCodes || []).not.toContain(TS_ENHANCED_DEPRECATED_WARNING_CODE);
    });

    test('enhanced prices above standard: 9 visits of labor + 1.25x material', () => {
      const enhanced = priceTreeShrub({ bedArea: 2000, treeCount: 0 }, { tier: 'enhanced' });
      const standard = priceTreeShrub({ bedArea: 2000, treeCount: 0 }, { tier: 'standard' });
      expect(enhanced.monthly).toBeGreaterThan(standard.monthly);
      expect(enhanced.materialModel.tierFactor).toBe(1.25);
      expect(standard.materialModel.tierFactor).toBe(1);
      // Per-visit stays cheaper than standard per-visit is NOT guaranteed
      // (labor dominates); the invariant that matters is annual ordering.
      expect(enhanced.annual).toBeGreaterThan(standard.annual);
    });
  });

  describe('config parity (constants vs active DB migration)', () => {
    // Code constants stay authoritative; this test catches drift if anyone
    // edits one surface without the other. The active runtime config is the
    // JSONB pricing_config updated by the v4.6 reprice migration.
    const fs = require('fs');
    const path = require('path');
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260612000025_tree_shrub_reprice_45_margin.js'),
      'utf8'
    );
    const legacySrc = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260414000011_pricing_config.js'),
      'utf8'
    );

    function migrationNumber(key) {
      // First occurrence wins — the pricing_config updates array sits above
      // the changelog payloads in the migration source.
      const re = new RegExp(`\\b${key}:\\s*([0-9.]+)`);
      const m = migrationSrc.match(re);
      if (!m) throw new Error(`pricing_config migration missing ${key}`);
      return Number(m[1]);
    }
    function legacyValue(key) {
      const re = new RegExp(`config_key:\\s*'${key}',\\s*config_value:\\s*([0-9.]+)`);
      const m = legacySrc.match(re);
      if (!m) throw new Error(`pricing_config seed missing ${key}`);
      return Number(m[1]);
    }

    test('material model terms match between code and migration', () => {
      expect(migrationNumber('fixed')).toBe(constants.TREE_SHRUB.materialModel.fixedAnnual);
      expect(migrationNumber('per_tree')).toBe(constants.TREE_SHRUB.materialModel.perTreeAnnual);
      expect(migrationNumber('per_sqft')).toBe(constants.TREE_SHRUB.materialModel.perSqFtAnnual);
      expect(migrationNumber('light_factor')).toBe(constants.TREE_SHRUB.materialModel.lightFactor);
    });

    test('monthly floors match between code and migration', () => {
      expect(migrationNumber('light')).toBe(constants.TREE_SHRUB.tiers.light.monthlyFloor);
      expect(migrationNumber('standard')).toBe(constants.TREE_SHRUB.tiers.standard.monthlyFloor);
    });

    test('margin target matches and carries the admin-inclusive semantics marker', () => {
      expect(migrationNumber('value')).toBe(constants.TREE_SHRUB.marginTarget);
      expect(migrationSrc).toContain("semantics: 'margin_admin_inclusive'");
    });

    test('changelog category satisfies the pricing_changelog_category_check constraint', () => {
      // Deploy bd3a4b3f failed because category 'rate' violated the DB check
      // constraint (20260417000004_pricing_changelog.js). Pin the allowed set
      // so a bad category never takes down a deploy again.
      const ALLOWED = ['bug', 'leak', 'rule', 'cost', 'architecture', 'documentation', 'infrastructure'];
      const m = migrationSrc.match(/category:\s*'([a-z]+)'/);
      expect(m).not.toBeNull();
      expect(ALLOWED).toContain(m[1]);
    });

    test('admin annual + margin floor match between code and legacy seed', () => {
      expect(legacyValue('ADMIN_ANNUAL')).toBe(constants.GLOBAL.ADMIN_ANNUAL);
      expect(legacyValue('MARGIN_FLOOR')).toBe(constants.GLOBAL.MARGIN_FLOOR);
    });

    test('premium stays retired; enhanced is active (un-retired 2026-07-23)', () => {
      expect(constants.TREE_SHRUB.tiers.enhanced).toEqual(expect.objectContaining({ frequency: 9 }));
      expect(constants.TREE_SHRUB.tiers.premium).toBeUndefined();
    });
  });

  describe('monthly floor semantics (v4.6 backstops)', () => {
    test('floors are backstops the formula minimum already clears', () => {
      // Even the smallest possible job (minimum on-site labor + material
      // floors) prices above the monthly floor from the formula, so the
      // floor should never silently set the price.
      const minimalStandard = priceTreeShrub({ bedArea: 1, treeCount: 0 }, { tier: 'standard' });
      const minimalLight = priceTreeShrub({ bedArea: 1, treeCount: 0 }, { tier: 'light' });
      expect(minimalStandard.monthly).toBeGreaterThanOrEqual(constants.TREE_SHRUB.tiers.standard.monthlyFloor);
      expect(minimalLight.monthly).toBeGreaterThanOrEqual(constants.TREE_SHRUB.tiers.light.monthlyFloor);
      // And the price is the formula's, not the floor constant.
      expect(minimalStandard.monthly).toBeCloseTo(35.38, 2);
    });

    test('light floor stays <= 2/3 of standard floor so a floored Light never exceeds Standard per month', () => {
      const { light, standard } = constants.TREE_SHRUB.tiers;
      expect(light.monthlyFloor).toBeLessThanOrEqual((2 / 3) * standard.monthlyFloor);
    });
  });

  describe('WaveGuard discount interaction at the 45% list margin', () => {
    function estimateInput(services) {
      return {
        homeSqFt: 2000,
        stories: 1,
        lotSqFt: 10000,
        bedArea: 2000,
        propertyType: 'single_family',
        zone: 'A',
        features: { shrubs: 'light', trees: 'light', complexity: 'simple' },
        services,
      };
    }

    test('Platinum (20%) is no longer clamped — the 35% post-discount guard is report-only (owner ruling 2026-07-17)', () => {
      // 1 - 0.55/0.80 = 31.25% collected margin — below the 35% floor. The
      // old v4.6 policy clamped this; since the 2026-07-17 owner ruling the
      // full 20% applies and the shortfall is only reported.
      const estimate = generateEstimate(estimateInput({
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
        treeShrub: { tier: 'standard', access: 'easy', treeCount: 0 },
        mosquito: { tier: 'monthly12' },
      }));
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      expect(estimate.waveGuard.tier).toBe('platinum');
      expect(ts.discountCapped).toBe(false);
      expect(ts.marginGuardApplied).toBe(false);
      expect(ts.actualDiscountPct).toBeCloseTo(0.20, 3);
      expect(ts.finalMargin).toBeCloseTo(0.313, 3);
      expect(ts.finalMargin).toBeLessThan(0.35);
      expect(ts.belowMarginFloor).toBe(true);
    });

    test('Gold (15%) survives the guard uncapped', () => {
      // 1 - 0.55/0.85 = 35.3% collected margin — clears the 35% guard.
      const estimate = generateEstimate(estimateInput({
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
        treeShrub: { tier: 'standard', access: 'easy', treeCount: 0 },
      }));
      const ts = estimate.lineItems.find(i => i.service === 'tree_shrub');
      expect(estimate.waveGuard.tier).toBe('gold');
      expect(ts.discountCapped).toBe(false);
      expect(ts.actualDiscountPct).toBeCloseTo(0.15, 3);
      expect(ts.finalMargin).toBeGreaterThanOrEqual(0.35 - 1e-9);
    });
  });
});

describe('Tree & Shrub v4.7 knobs (density / palm reserve / callback reserve)', () => {
  // Every knob ships NEUTRAL — these tests flip constants directly (the same
  // object db-bridge mutates) and restore after each test.
  const TS = () => constants.TREE_SHRUB;
  const originalDensity = { ...constants.TREE_SHRUB.densityFactors };
  const originalReserve = { ...constants.TREE_SHRUB.routinePalmCareReserve };
  const originalCallback = constants.TREE_SHRUB.callbackReservePerVisit;

  afterEach(() => {
    constants.TREE_SHRUB.densityFactors = { ...originalDensity };
    constants.TREE_SHRUB.routinePalmCareReserve = { ...originalReserve };
    constants.TREE_SHRUB.callbackReservePerVisit = originalCallback;
  });

  test('neutral defaults change nothing: worked example matches v4.6 numbers exactly', () => {
    expect(TS().densityFactors).toEqual({ light: 1, moderate: 1, heavy: 1 });
    expect(TS().routinePalmCareReserve).toEqual({ perPalmAnnual: 0, minutesPerPalmVisit: 0 });
    expect(TS().callbackReservePerVisit).toBe(0);

    // Same fixture as the "standard 2,000 sqft worked example (v4.6)" above,
    // with density + PROPERTY-level palm signals present — both must be
    // inert at neutral (property palms never fed T&S pricing pre-v4.7).
    const quote = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, access: 'easy', shrubDensity: 'heavy', palmCount: 12 },
      { tier: 'standard' }
    );
    // material = max(60, 15 + 0 + 0.055*2000) = 125; onSite = max(25, 20+4+0+0) = 25 (heavy inert)
    expect(quote.costs.materialCost).toBe(125);
    expect(quote.onSiteMin).toBe(25);
    expect(quote.costs.palmReserveCost).toBe(0);
    expect(quote.costs.callbackReserveCost).toBe(0);
    expect(quote.densityFactor).toBe(1);
    expect(quote.palmCount).toBe(12);
    expect(quote.palmCountSource).toBe('property');
    expect(quote.palmReserveActive).toBe(false);
  });

  test('unarmed reserve: SERVICE-LINE palms fold into the tree terms — a split "10 palms" prices byte-identically to the pre-split treeCount 10 (pre-push P0)', () => {
    // The intent prompt used to classify stated palms as treeCount; the
    // producer split must not change a single dollar until the reserve arms.
    for (const tier of ['light', 'standard', 'enhanced']) {
      const preSplit = priceTreeShrub({ bedArea: 2000, access: 'easy' }, { tier, treeCount: 10 });
      const postSplit = priceTreeShrub({ bedArea: 2000, access: 'easy' }, { tier, treeCount: 0, palmCount: 10 });
      expect(postSplit.monthly).toBe(preSplit.monthly);
      expect(postSplit.annual).toBe(preSplit.annual);
      expect(postSplit.costs.materialCost).toBe(preSplit.costs.materialCost);
      expect(postSplit.onSiteMin).toBe(preSplit.onSiteMin);
      expect(postSplit.materialTreeCount).toBe(10);
      expect(postSplit.laborTreeCount).toBe(10);
      expect(postSplit.costs.palmReserveCost).toBe(0);
    }
    // The ≥15 gate keeps tripping for large palm counts while unarmed.
    const manyPalms = priceTreeShrub({ bedArea: 2000, access: 'easy' }, { tier: 'standard', treeCount: 0, palmCount: 20 });
    expect(manyPalms.manualReviewReasons).toContain('tree_count_at_or_above_15');
  });

  test('stated palms REPLACE a density-inferred tree count instead of stacking on it (pre-push P0 r8)', () => {
    // Pre-split, "10 palms" arrived as an EXPLICIT treeCount 10, so the
    // treeDensity fallback never fired. Post-split the same call leaves
    // treeCount absent and the resolver infers from lookup density — adding
    // the folded palms on top would price 16 legacy trees for a 10-palm job.
    const preSplit = priceTreeShrub(
      { bedArea: 2000, access: 'easy', treeDensity: 'moderate' },
      { tier: 'standard', treeCount: 10 }
    );
    const postSplit = priceTreeShrub(
      { bedArea: 2000, access: 'easy', treeDensity: 'moderate' },
      { tier: 'standard', palmCount: 10 }
    );
    expect(postSplit.treeCountSource).toBe('density_estimate');
    expect(postSplit.materialTreeCount).toBe(10);
    expect(postSplit.laborTreeCount).toBe(10);
    expect(postSplit.annual).toBe(preSplit.annual);
    expect(postSplit.costs.materialCost).toBe(preSplit.costs.materialCost);

    // A caller-stated NON-palm count is real signal and still adds.
    const both = priceTreeShrub(
      { bedArea: 2000, access: 'easy', treeDensity: 'moderate' },
      { tier: 'standard', treeCount: 3, palmCount: 10 }
    );
    expect(both.materialTreeCount).toBe(13);
  });

  test('ARMED: the density-inferred count is suppressed too — no phantom trees billed on top of the reserve (pre-push P0 r9)', () => {
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    // 10 stated palms + moderate lookup density: the inferred trees may BE
    // those palms, so they must not bill alongside the reserve.
    const inferred = priceTreeShrub(
      { bedArea: 2000, access: 'easy', treeDensity: 'moderate' },
      { tier: 'standard', palmCount: 10 }
    );
    expect(inferred.materialTreeCount).toBe(0);
    expect(inferred.laborTreeCount).toBe(0);
    // material = (15 + 0 + 110) + 6*10 — no phantom per-tree charge.
    expect(inferred.costs.materialCost).toBeCloseTo(125 + 60, 5);
    expect(inferred.onSiteMin).toBe(20 + 4 + 10);
    // A caller-stated non-palm count still bills.
    const stated = priceTreeShrub(
      { bedArea: 2000, access: 'easy', treeDensity: 'moderate' },
      { tier: 'standard', treeCount: 3, palmCount: 10 }
    );
    expect(stated.materialTreeCount).toBe(3);
  });

  test('ARMED: PROPERTY palms + treeDensity (the normal lookup shape) do not double-bill as inferred trees (pre-push P0 r10)', () => {
    const property = { bedArea: 2000, access: 'easy', treeDensity: 'moderate', palmCount: 10 };
    // Unarmed: property palms don't price, so the inferred trees stay — the
    // unchanged pre-v4.7 charge.
    const unarmed = priceTreeShrub(property, { tier: 'standard' });
    expect(unarmed.materialTreeCount).toBe(6);
    // Armed: the reserve prices those palms, so the inference is suppressed.
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    const armed = priceTreeShrub(property, { tier: 'standard' });
    expect(armed.materialTreeCount).toBe(0);
    expect(armed.laborTreeCount).toBe(0);
    expect(armed.costs.materialCost).toBeCloseTo(125 + 60, 5);
  });

  test('armed reserve: property-sourced palms trip the high-count review gate they now price (pre-push P1 r8)', () => {
    const property = { bedArea: 2000, access: 'easy', palmCount: 20 };
    // Unarmed: property palms don't price, so they don't gate either —
    // unchanged pre-v4.7 behavior.
    expect(priceTreeShrub(property, { tier: 'standard' }).manualReviewReasons)
      .not.toContain('tree_count_at_or_above_15');
    // Armed: they drive real material/labor, so a 20-palm property must not
    // auto-price a big job without review.
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    expect(priceTreeShrub(property, { tier: 'standard' }).manualReviewReasons)
      .toContain('tree_count_at_or_above_15');
  });

  test('armed reserve: palms leave the tree terms and price via the reserve only — never both', () => {
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    const quote = priceTreeShrub({ bedArea: 2000, access: 'easy' }, { tier: 'standard', treeCount: 3, palmCount: 10 });
    expect(quote.palmReserveActive).toBe(true);
    expect(quote.materialTreeCount).toBe(3);
    expect(quote.laborTreeCount).toBe(3);
    // material: (15 + 4*3 + 110)*1 + 6*10 — the $4 per-tree term bills 3, not 13.
    expect(quote.costs.materialCost).toBeCloseTo(15 + 12 + 110 + 60, 5);
    // minutes: 20 + 4 + round(3*1.5)=5 + 10 palm minutes.
    expect(quote.onSiteMin).toBe(20 + 4 + 5 + 10);
  });

  test('the two reserve legs arm INDEPENDENTLY — a half-armed config never deletes the unreplaced leg (pre-push P0 r7)', () => {
    const baseline = priceTreeShrub({ bedArea: 2000, access: 'easy' }, { tier: 'standard', treeCount: 0, palmCount: 10 });

    // MATERIAL only: palm material comes from the reserve, palm LABOR still
    // rides the legacy tree minutes — the labor must not vanish.
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 0 };
    const materialOnly = priceTreeShrub({ bedArea: 2000, access: 'easy' }, { tier: 'standard', treeCount: 0, palmCount: 10 });
    expect(materialOnly.palmMaterialArmed).toBe(true);
    expect(materialOnly.palmLaborArmed).toBe(false);
    expect(materialOnly.materialTreeCount).toBe(0);
    expect(materialOnly.laborTreeCount).toBe(10);
    expect(materialOnly.onSiteMin).toBe(baseline.onSiteMin);
    expect(materialOnly.costs.materialCost).toBeCloseTo(15 + 110 + 60, 5);

    // LABOR only: palm minutes come from the reserve, palm MATERIAL still
    // rides the legacy per-tree term — the material must not vanish.
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 0, minutesPerPalmVisit: 1 };
    const laborOnly = priceTreeShrub({ bedArea: 2000, access: 'easy' }, { tier: 'standard', treeCount: 0, palmCount: 10 });
    expect(laborOnly.palmMaterialArmed).toBe(false);
    expect(laborOnly.palmLaborArmed).toBe(true);
    expect(laborOnly.materialTreeCount).toBe(10);
    expect(laborOnly.laborTreeCount).toBe(0);
    expect(laborOnly.costs.materialCost).toBe(baseline.costs.materialCost);
    expect(laborOnly.costs.palmReserveCost).toBe(0);
    // 10 palms x 1 min replaces round(10*1.5)=15 legacy minutes.
    expect(laborOnly.onSiteMin).toBe(20 + 4 + 10);

    // Neither half-armed config may price BELOW the fully-unarmed quote.
    expect(materialOnly.annual).toBeGreaterThanOrEqual(baseline.annual);
    expect(laborOnly.costs.materialCost).toBeGreaterThanOrEqual(0);
  });

  test('density factor multiplies the measured-bed terms only (per-sqft material + bed minutes)', () => {
    TS().densityFactors.heavy = 1.3;
    const heavy = priceTreeShrub(
      { bedArea: 2000, treeCount: 4, access: 'easy', shrubDensity: 'heavy' },
      { tier: 'standard' }
    );
    const moderate = priceTreeShrub(
      { bedArea: 2000, treeCount: 4, access: 'easy', shrubDensity: 'moderate' },
      { tier: 'standard' }
    );
    // per-sqft term scales: 0.055*2000*1.3 = 143 vs 110; fixed + per-tree terms don't.
    expect(heavy.costs.materialCost - moderate.costs.materialCost).toBeCloseTo(33, 5);
    // bed minutes scale: round(4*1.3)=5 vs 4 — fixed/tree/access minutes don't.
    expect(heavy.onSiteMin - moderate.onSiteMin).toBe(1);
    expect(heavy.densityFactor).toBe(1.3);
    // Unknown/missing density resolves moderate → factor 1.
    const unknownDensity = priceTreeShrub({ bedArea: 2000, treeCount: 4, access: 'easy' }, { tier: 'standard' });
    expect(unknownDensity.densityFactor).toBe(1);
  });

  test('palm reserve adds annual material outside the tier factor and per-visit minutes', () => {
    TS().routinePalmCareReserve.perPalmAnnual = 6;
    TS().routinePalmCareReserve.minutesPerPalmVisit = 1;
    const quote = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, access: 'easy', palmCount: 8 },
      { tier: 'enhanced' }
    );
    expect(quote.costs.palmReserveCost).toBe(48);
    // Outside the tier factor: enhanced material = (15 + 0.055*2000)*1.25 + 48,
    // NOT (…+48)*1.25.
    expect(quote.costs.materialCost).toBeCloseTo((15 + 110) * 1.25 + 48, 5);
    // Labor: +8 palm minutes per visit on top of the 20+4 base (>25 floor).
    expect(quote.onSiteMin).toBe(20 + 4 + 8);
    expect(quote.materialModel.perPalmAnnual).toBe(6);
  });

  test('palm count reads property-level sources and treats absent/invalid as zero', () => {
    TS().routinePalmCareReserve.perPalmAnnual = 6;
    const inventory = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, palmInventory: { palmCount: 5 } },
      { tier: 'standard' }
    );
    expect(inventory.palmCount).toBe(5);
    expect(inventory.costs.palmReserveCost).toBe(30);
    for (const bad of [{}, { palmCount: 'many' }, { palmCount: -3 }, { palmCount: 2.5 }]) {
      const quote = priceTreeShrub({ bedArea: 2000, treeCount: 0, ...bad }, { tier: 'standard' });
      expect(quote.palmCount).toBe(0);
      expect(quote.palmCountSource).toBe('none');
      expect(quote.costs.palmReserveCost).toBe(0);
    }
  });

  test('callback reserve books per visit into direct cost (lawn-engine-style knob)', () => {
    TS().callbackReservePerVisit = 2;
    const quote = priceTreeShrub({ bedArea: 2000, treeCount: 0, access: 'easy' }, { tier: 'standard' });
    expect(quote.costs.callbackReserveCost).toBe(12);
    // direct = material 125 + labor 6*35*(35/60) — plus the 12.
    expect(quote.costs.directCost).toBeCloseTo(125 + 6 * 35 * (35 / 60) + 12, 2);
  });
});

describe('Tree & Shrub v4.7 density source eligibility + admin validation', () => {
  const originalDensity = { ...constants.TREE_SHRUB.densityFactors };
  afterEach(() => {
    constants.TREE_SHRUB.densityFactors = { ...originalDensity };
  });

  test('density factor never applies to lot_based or fallback bed areas (already/never density-scaled)', () => {
    constants.TREE_SHRUB.densityFactors.heavy = 1.3;
    // lot_based: estimateTreeShrubBedAreaFromLot already scaled the bed by
    // density (heavy = 25% of lot) — a factor here would double-apply.
    const lotBased = priceTreeShrub(
      { lotSqFt: 10000, shrubDensity: 'heavy', treeCount: 0, access: 'easy' },
      { tier: 'standard' }
    );
    expect(lotBased.bedAreaSource).toBe('lot_based');
    expect(lotBased.densityFactor).toBe(1);
    // fallback: the 2,000 default is a guess, not a measurement.
    const fallback = priceTreeShrub(
      { shrubDensity: 'heavy', treeCount: 0, access: 'easy' },
      { tier: 'standard' }
    );
    expect(fallback.bedAreaSource).toBe('fallback');
    expect(fallback.densityFactor).toBe(1);
    // explicit measurement: the factor applies.
    const explicit = priceTreeShrub(
      { bedArea: 2000, shrubDensity: 'heavy', treeCount: 0, access: 'easy' },
      { tier: 'standard' }
    );
    expect(explicit.bedAreaSource).toBe('explicit');
    expect(explicit.densityFactor).toBe(1.3);
  });

  test('admin PUT validation bounds the v4.7 knobs (strict numbers, no boolean coercion)', () => {
    const { validatePricingConfigData } = require('../routes/admin-pricing-config');
    const ok = (data) => validatePricingConfigData('ts_material_rates', data).ok;
    expect(ok({ density_heavy: 1.3, palm_per_palm_annual: 6, palm_minutes_per_visit: 1, callback_reserve_per_visit: 2 })).toBe(true);
    expect(ok({ fixed: 15, per_tree: 4, per_sqft: 0.055, light_factor: 0.75 })).toBe(true);
    // db-bridge applies fixed/per_tree/per_sqft only when > 0 — a stored 0
    // would audit success while quotes keep the prior value (P1 r6).
    expect(ok({ fixed: 0 })).toBe(false);
    expect(ok({ per_tree: 0 })).toBe(false);
    expect(ok({ per_sqft: 0 })).toBe(false);
    // The v4.7 knobs legitimately accept 0 (bridge rebases + applies >= 0).
    expect(ok({ palm_per_palm_annual: 0, callback_reserve_per_visit: 0 })).toBe(true);
    expect(ok({ density_heavy: 5 })).toBe(false);
    expect(ok({ density_light: 0.2 })).toBe(false);
    expect(ok({ palm_per_palm_annual: 500 })).toBe(false);
    expect(ok({ palm_minutes_per_visit: 45 })).toBe(false);
    expect(ok({ callback_reserve_per_visit: true })).toBe(false); // Number(true)=1 must NOT slip through
    expect(ok({ palm_per_palm_annual: '6' })).toBe(false); // strict numbers, no numeric strings
    expect(ok({ callback_reserve_per_visit: null })).toBe(false);
    // A null/array payload would wipe the DB-authoritative row (P1 r12).
    expect(ok(null)).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok('nope')).toBe(false);
  });
});

describe('Tree & Shrub v4.7 palm count service-line passthrough', () => {
  const originalReserve = { ...constants.TREE_SHRUB.routinePalmCareReserve };
  afterEach(() => {
    constants.TREE_SHRUB.routinePalmCareReserve = { ...originalReserve };
  });

  test('services.treeShrub.palmCount reaches the reserve through generateEstimate', () => {
    constants.TREE_SHRUB.routinePalmCareReserve.perPalmAnnual = 6;
    const estimate = generateEstimate({
      property: { homeSqFt: 2000, lotSqFt: 8000, bedArea: 2000 },
      services: { treeShrub: { tier: 'standard', treeCount: 2, palmCount: 10 } },
    });
    const ts = estimate.lineItems.find((li) => li.service === 'tree_shrub');
    expect(ts.palmCount).toBe(10);
    expect(ts.palmCountSource).toBe('service_line');
    expect(ts.treeCount).toBe(2);
    expect(ts.costs.palmReserveCost).toBe(60);
  });

  test('palm count clamps at the 200 residential bound with a warning; fractions read as zero', () => {
    constants.TREE_SHRUB.routinePalmCareReserve.perPalmAnnual = 6;
    const clamped = priceTreeShrub({ bedArea: 2000, treeCount: 0, palmCount: 9999 }, { tier: 'standard' });
    expect(clamped.palmCount).toBe(200);
    expect(clamped.costs.palmReserveCost).toBe(1200);
    expect(clamped.warnings.some((w) => w.includes('clamped to 200'))).toBe(true);
    const fractional = priceTreeShrub({ bedArea: 2000, treeCount: 0, palmCount: 2.5 }, { tier: 'standard' });
    expect(fractional.palmCount).toBe(0);
  });

  test('service-line palm count wins over the property record; absent falls back to property', () => {
    constants.TREE_SHRUB.routinePalmCareReserve.perPalmAnnual = 6;
    const override = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, palmCount: 4 },
      { tier: 'standard', palmCount: 9 }
    );
    expect(override.palmCount).toBe(9);
    expect(override.palmCountSource).toBe('service_line');
    const fallback = priceTreeShrub(
      { bedArea: 2000, treeCount: 0, palmCount: 4 },
      { tier: 'standard' }
    );
    expect(fallback.palmCount).toBe(4);
    expect(fallback.palmCountSource).toBe('property');
  });
});

describe('Tree & Shrub v4.7 commercial + draft-review interactions', () => {
  test('commercial keeps the PRE-SPLIT plant classification — stated palms are never priced as zero plants', () => {
    const commercialProperty = { propertyType: 'commercial', homeSqFt: 8000, lotSqFt: 40000, bedArea: 4000 };
    const withPalms = generateEstimate({
      ...commercialProperty,
      services: { treeShrub: { palmCount: 12 } },
    });
    const asTrees = generateEstimate({
      ...commercialProperty,
      services: { treeShrub: { treeCount: 12 } },
    });
    const a = withPalms.lineItems.find((li) => li.service === 'commercial_tree_shrub');
    const b = asTrees.lineItems.find((li) => li.service === 'commercial_tree_shrub');
    expect(a).toBeTruthy();
    expect(a.annual).toBe(b.annual);
    // Trees and palms both stated add up on the commercial path.
    const both = generateEstimate({
      ...commercialProperty,
      services: { treeShrub: { treeCount: 4, palmCount: 8 } },
    }).lineItems.find((li) => li.service === 'commercial_tree_shrub');
    expect(both.annual).toBe(b.annual);
  });

  test('a palm-only residential draft is fully quoted, not review-blocked for a missing tree count', () => {
    const draftPriv = require('../services/estimator-engine/draft-builder')._private
      || require('../services/estimator-engine/draft-builder')._test;
    const lineRequiresReview = draftPriv.lineRequiresReview;
    // Palm-only: treeCountSource is default_zero but the palms ARE the
    // plant count for this line — provided they actually priced (a
    // service-line count folds into the legacy terms; see the GH-review
    // block below for the property-sourced case that must stay blocked).
    expect(lineRequiresReview({ service: 'tree_shrub', treeCountSource: 'default_zero', palmCount: 10, palmCountSource: 'service_line', annual: 400 })).toBe(false);
    // Neither count → still review-blocked (the pricer quoted fixed costs only).
    expect(lineRequiresReview({ service: 'tree_shrub', treeCountSource: 'default_zero', annual: 400 })).toBe(true);
    expect(lineRequiresReview({ service: 'tree_shrub', treeCountSource: 'default_zero', palmCount: 0, annual: 400 })).toBe(true);
  });
});

describe('Tree & Shrub v4.7 leg independence for inferred trees + tier-row parity', () => {
  const originalReserve = { ...constants.TREE_SHRUB.routinePalmCareReserve };
  afterEach(() => {
    constants.TREE_SHRUB.routinePalmCareReserve = { ...originalReserve };
  });

  test('half-armed configs suppress the inferred trees only on the ARMED leg (pre-push P0 r11)', () => {
    const property = { bedArea: 2000, access: 'easy', treeDensity: 'moderate', palmCount: 10 };
    const unarmed = priceTreeShrub(property, { tier: 'standard' });
    expect(unarmed.materialTreeCount).toBe(6);
    expect(unarmed.laborTreeCount).toBe(6);

    // LABOR-only armed: palm minutes come from the reserve, so the labor leg
    // drops the inferred trees — but the MATERIAL leg still bills them,
    // exactly as it did before the knob was touched.
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 0, minutesPerPalmVisit: 1 };
    const laborOnly = priceTreeShrub(property, { tier: 'standard' });
    expect(laborOnly.materialTreeCount).toBe(6);
    expect(laborOnly.laborTreeCount).toBe(0);
    expect(laborOnly.costs.materialCost).toBe(unarmed.costs.materialCost);

    // MATERIAL-only armed: the mirror image — labor keeps its trees.
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 0 };
    const materialOnly = priceTreeShrub(property, { tier: 'standard' });
    expect(materialOnly.materialTreeCount).toBe(0);
    expect(materialOnly.laborTreeCount).toBe(6);
    expect(materialOnly.onSiteMin).toBe(unarmed.onSiteMin);
  });

  test('alternate-tier rows price the SAME job: palms reach every ts row (pre-push P0 r11)', () => {
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    const estimate = generateEstimate({
      homeSqFt: 2000,
      lotSqFt: 8000,
      bedArea: 2000,
      services: { treeShrub: { tier: 'standard', palmCount: 10 } },
    });
    const ts = estimate.lineItems.find((li) => li.service === 'tree_shrub');
    expect(ts.palmCount).toBe(10);
    // Every alternate-tier row must reflect those 10 palms — priced directly
    // at the same tier, the annual must match the row's annual.
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const legacy = mapV1ToLegacyShape(estimate);
    for (const row of legacy.results.ts) {
      const direct = priceTreeShrub(
        { bedArea: 2000, access: 'easy' },
        { tier: row.tier, palmCount: 10 }
      );
      expect(row.ann).toBe(Math.round(direct.annual));
    }
  });
});

describe('Tree & Shrub v4.7 quote-time knob snapshot (sent-estimate replay)', () => {
  const originalDensity = { ...constants.TREE_SHRUB.densityFactors };
  const originalReserve = { ...constants.TREE_SHRUB.routinePalmCareReserve };
  const originalCallback = constants.TREE_SHRUB.callbackReservePerVisit;
  afterEach(() => {
    constants.TREE_SHRUB.densityFactors = { ...originalDensity };
    constants.TREE_SHRUB.routinePalmCareReserve = { ...originalReserve };
    constants.TREE_SHRUB.callbackReservePerVisit = originalCallback;
  });

  test('every quote stamps the knob values it priced with', () => {
    const neutral = priceTreeShrub({ bedArea: 2000, access: 'easy' }, { tier: 'standard' });
    expect(neutral.pricingKnobs).toEqual({
      densityFactor: 1, perPalmAnnual: 0, minutesPerPalmVisit: 0, callbackReservePerVisit: 0,
    });
    constants.TREE_SHRUB.densityFactors.heavy = 1.3;
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    constants.TREE_SHRUB.callbackReservePerVisit = 2;
    const armed = priceTreeShrub({ bedArea: 2000, access: 'easy', shrubDensity: 'heavy' }, { tier: 'standard' });
    expect(armed.pricingKnobs).toEqual({
      densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2,
    });
  });

  test('a replayed snapshot beats a later admin flip — the sent price survives', () => {
    const sent = priceTreeShrub(
      { bedArea: 2000, access: 'easy', shrubDensity: 'heavy', palmCount: 10 },
      { tier: 'standard' }
    );
    // Admin flips every knob AFTER the estimate was sent.
    constants.TREE_SHRUB.densityFactors.heavy = 1.3;
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 25, minutesPerPalmVisit: 5 };
    constants.TREE_SHRUB.callbackReservePerVisit = 10;
    const liveReprice = priceTreeShrub(
      { bedArea: 2000, access: 'easy', shrubDensity: 'heavy', palmCount: 10 },
      { tier: 'standard' }
    );
    expect(liveReprice.annual).toBeGreaterThan(sent.annual); // the flip does bite fresh quotes
    const replay = priceTreeShrub(
      { bedArea: 2000, access: 'easy', shrubDensity: 'heavy', palmCount: 10 },
      { tier: 'standard', knobs: sent.pricingKnobs }
    );
    expect(replay.annual).toBe(sent.annual);
    expect(replay.costs.materialCost).toBe(sent.costs.materialCost);
    expect(replay.onSiteMin).toBe(sent.onSiteMin);
  });

  test('legacy estimates (no stamp) replay NEUTRAL — they could only have been priced with the knobs off', () => {
    const { estimateTreeShrubKnobSignal: signal } = require('../routes/estimate-public');
    expect(signal({ result: { lineItems: [{ service: 'tree_shrub' }] } })).toEqual({
      densityFactor: 1, perPalmAnnual: 0, minutesPerPalmVisit: 0, callbackReservePerVisit: 0,
    });
    // No T&S line at all → inject nothing (fresh quotes resolve live config).
    expect(signal({ result: { lineItems: [{ service: 'pest_control' }] } })).toBeNull();
  });
});

describe('Tree & Shrub v4.7 alternate-tier rows with palms + inferred trees', () => {
  const originalReserve = { ...constants.TREE_SHRUB.routinePalmCareReserve };
  afterEach(() => {
    constants.TREE_SHRUB.routinePalmCareReserve = { ...originalReserve };
  });

  const legacyRows = (estimate) => {
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    return mapV1ToLegacyShape(estimate).results.ts;
  };

  test('PROPERTY palms + treeDensity: every tier row matches its direct price (pre-push P0 r13)', () => {
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    const property = { homeSqFt: 2000, lotSqFt: 8000, bedArea: 2000, treeDensity: 'moderate', palmCount: 10 };
    const estimate = generateEstimate({ ...property, services: { treeShrub: { tier: 'standard' } } });
    for (const row of legacyRows(estimate)) {
      const direct = priceTreeShrub(property, { tier: row.tier });
      expect(row.ann).toBe(Math.round(direct.annual));
    }
  });

  test('SERVICE-LINE palms + treeDensity: every tier row matches its direct price', () => {
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    const property = { homeSqFt: 2000, lotSqFt: 8000, bedArea: 2000, treeDensity: 'moderate' };
    const estimate = generateEstimate({ ...property, services: { treeShrub: { tier: 'standard', palmCount: 10 } } });
    for (const row of legacyRows(estimate)) {
      const direct = priceTreeShrub(property, { tier: row.tier, palmCount: 10 });
      expect(row.ann).toBe(Math.round(direct.annual));
    }
  });

  test('UNARMED with service-line palms + treeDensity: tier rows still match (the neutral fold)', () => {
    const property = { homeSqFt: 2000, lotSqFt: 8000, bedArea: 2000, treeDensity: 'moderate' };
    const estimate = generateEstimate({ ...property, services: { treeShrub: { tier: 'standard', palmCount: 10 } } });
    for (const row of legacyRows(estimate)) {
      const direct = priceTreeShrub(property, { tier: row.tier, palmCount: 10 });
      expect(row.ann).toBe(Math.round(direct.annual));
    }
  });

  test('a caller-STATED tree count still replays as explicit across tier rows', () => {
    const property = { homeSqFt: 2000, lotSqFt: 8000, bedArea: 2000, treeDensity: 'moderate' };
    const estimate = generateEstimate({ ...property, services: { treeShrub: { tier: 'standard', treeCount: 4 } } });
    for (const row of legacyRows(estimate)) {
      const direct = priceTreeShrub(property, { tier: row.tier, treeCount: 4 });
      expect(row.ann).toBe(Math.round(direct.annual));
    }
  });
});

describe('Tree & Shrub v4.7 knob snapshot survives the mapped admin envelope', () => {
  const originalReserve = { ...constants.TREE_SHRUB.routinePalmCareReserve };
  afterEach(() => {
    constants.TREE_SHRUB.routinePalmCareReserve = { ...originalReserve };
  });

  test('mapV1ToLegacyShape carries pricingKnobs + palm inputs into tsMeta (admin V2 saves only this envelope)', () => {
    constants.TREE_SHRUB.routinePalmCareReserve = { perPalmAnnual: 6, minutesPerPalmVisit: 1 };
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const estimate = generateEstimate({
      homeSqFt: 2000, lotSqFt: 8000, bedArea: 2000,
      services: { treeShrub: { tier: 'standard', palmCount: 10 } },
    });
    const meta = mapV1ToLegacyShape(estimate).results.tsMeta;
    expect(meta.pricingKnobs).toEqual({
      densityFactor: 1, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 0,
    });
    expect(meta.palmCount).toBe(10);
    expect(meta.palmCountSource).toBe('service_line');
  });

  test('the replay signal reads the mapped stamp, and mapped T&S with no stamp replays NEUTRAL', () => {
    const { estimateTreeShrubKnobSignal: signal } = require('../routes/estimate-public');
    expect(signal({
      result: { results: { tsMeta: { pricingKnobs: { densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2 } } } },
    })).toEqual({ densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2 });
    // Mapped legacy T&S estimate saved before the knobs existed.
    expect(signal({ result: { results: { tsMeta: { eb: 2000, et: 3 } } } })).toEqual({
      densityFactor: 1, perPalmAnnual: 0, minutesPerPalmVisit: 0, callbackReservePerVisit: 0,
    });
    expect(signal({ result: { results: { ts: [{ tier: 'standard', ann: 600 }] } } })).toEqual({
      densityFactor: 1, perPalmAnnual: 0, minutesPerPalmVisit: 0, callbackReservePerVisit: 0,
    });
    // No T&S anywhere → inject nothing.
    expect(signal({ result: { results: { pest: {} } } })).toBeNull();
  });
});

describe('Tree & Shrub v4.7 GH review round 1 fixes', () => {
  test('unpriced PROPERTY palms stay in the draft review lane (GH P1)', () => {
    const { _private: draftPriv } = require('../services/estimator-engine/draft-builder');
    const base = { service: 'tree_shrub', treeCountSource: 'default_zero', annual: 400 };
    // Property palms with the reserve OFF price nothing — the fixed-cost
    // underquote this gate exists to catch.
    expect(draftPriv.lineRequiresReview({ ...base, palmCount: 8, palmCountSource: 'property', palmReserveActive: false })).toBe(true);
    // Service-line palms fold into the legacy terms, so they DO price.
    expect(draftPriv.lineRequiresReview({ ...base, palmCount: 8, palmCountSource: 'service_line', palmReserveActive: false })).toBe(false);
    // Once armed, property palms price through the reserve.
    expect(draftPriv.lineRequiresReview({ ...base, palmCount: 8, palmCountSource: 'property', palmReserveActive: true })).toBe(false);
    // No palms at all still blocks.
    expect(draftPriv.lineRequiresReview(base)).toBe(true);
  });

  test('the knob replay signal has ONE home shared by both authoritative paths (GH P1)', () => {
    const shared = require('../services/estimate-tree-shrub-knob-replay');
    const { estimateTreeShrubKnobSignal } = require('../routes/estimate-public');
    // estimate-public re-exports the shared implementation — no drift.
    expect(estimateTreeShrubKnobSignal).toBe(shared.treeShrubKnobSignalForReplay);
    const stamped = { result: { results: { tsMeta: { pricingKnobs: { densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2 } } } } };
    expect(shared.treeShrubKnobSignalForReplay(stamped)).toEqual({
      densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2,
    });
  });

  test('the server-authoritative recompute replays saved knobs ONLY for declared replays — never from client-posted data (GH P1 + pre-push P0)', async () => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const STAMPED = { densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2 };
    const estData = () => ({
      engineInputs: { homeSqFt: 2000, lotSqFt: 8000, bedArea: 2000, services: { treeShrub: { tier: 'standard' } } },
      result: { results: { tsMeta: { pricingKnobs: STAMPED } } },
    });
    const run = async (deps) => {
      let seenInput = null;
      await serverRecomputeFromEstimateData(deps.data || estData(), {
        translateV2CallToV1Input: null,
        needsSync: () => false,
        generateEstimate: (input) => { seenInput = input; return { lineItems: [], totals: {} }; },
        mapV1ToLegacyShape: () => ({ results: {} }),
        ...(deps.replay ? { replaySavedPricingKnobs: true } : {}),
      });
      return seenInput;
    };

    // Membership-lapse reconcile: a DECLARED replay of a persisted row.
    expect((await run({ replay: true }))?.treeShrubPricingKnobs).toEqual(STAMPED);

    // Create/revision save: estimateData is browser-controlled, so a posted
    // snapshot must NOT override the admin-only live pricing_config.
    expect((await run({}))?.treeShrubPricingKnobs).toBeUndefined();

    // Even on a declared replay, a client-CLAIMED value on the inputs is
    // stripped — only the server-derived snapshot may win.
    const forged = estData();
    forged.engineInputs.treeShrubPricingKnobs = {
      densityFactor: 0.5, perPalmAnnual: 0, minutesPerPalmVisit: 0, callbackReservePerVisit: 0,
    };
    expect((await run({ replay: true, data: forged }))?.treeShrubPricingKnobs).toEqual(STAMPED);
    // …and with no replay declared, the forged value is simply gone.
    const forgedNoReplay = estData();
    forgedNoReplay.engineInputs.treeShrubPricingKnobs = { densityFactor: 0.5 };
    expect((await run({ data: forgedNoReplay }))?.treeShrubPricingKnobs).toBeUndefined();
  });
});

describe('Tree & Shrub v4.7 GH review round 2 fixes', () => {
  test('the MAPPED stamp wins over a stale raw engineResult line (GH P1 r2)', () => {
    const { treeShrubKnobSignalForReplay } = require('../services/estimate-tree-shrub-knob-replay');
    // A revision rewrote result.results.tsMeta but left the agent draft's
    // original engineResult in place — the mapped stamp is authoritative.
    const signal = treeShrubKnobSignalForReplay({
      engineResult: {
        lineItems: [{ service: 'tree_shrub', pricingKnobs: { densityFactor: 1, perPalmAnnual: 0, minutesPerPalmVisit: 0, callbackReservePerVisit: 0 } }],
      },
      result: {
        results: { tsMeta: { pricingKnobs: { densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2 } } },
      },
    });
    expect(signal).toEqual({ densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2 });
    // With no mapped stamp, the raw line still answers.
    expect(treeShrubKnobSignalForReplay({
      engineResult: { lineItems: [{ service: 'tree_shrub', pricingKnobs: { densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2 } }] },
    })).toEqual({ densityFactor: 1.3, perPalmAnnual: 6, minutesPerPalmVisit: 1, callbackReservePerVisit: 2 });
  });
});
