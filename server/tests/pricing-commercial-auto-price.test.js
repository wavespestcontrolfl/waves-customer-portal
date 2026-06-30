// Commercial auto-pricing (lawn + tree/shrub) — cost-buildup pricers.
// Owner directive 2026-06-28: all commercial auto-prices (no size cap) and the
// estimate is shown to the lead instantly with an "estimated, confirmed on
// site" disclaimer. These golden anchors lock the approved numbers so any
// future drift (or a constant tweak) is caught.
const {
  priceCommercialLawn,
  priceCommercialTreeShrub,
  priceCommercialPest,
  priceCommercialMosquito,
  priceCommercialTermiteBait,
  priceCommercialRodentBait,
} = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine');

describe('priceCommercialLawn — cost-buildup auto-pricer', () => {
  test('golden anchors by turf area (approved 2026-06-28)', () => {
    expect(priceCommercialLawn({ turfSf: 10000 }).annual).toBeCloseTo(1504.24, 2);
    expect(priceCommercialLawn({ turfSf: 50000 }).annual).toBeCloseTo(5286.06, 2);
    expect(priceCommercialLawn({ turfSf: 150000 }).annual).toBeCloseTo(14740.61, 2);
  });

  test('hits a 45% target margin when the minimum does not bind', () => {
    const r = priceCommercialLawn({ turfSf: 50000 });
    expect(r.margin).toBeCloseTo(0.45, 2);
    expect(r.marginFloorOk).toBe(true);
    expect(r.monthly).toBeCloseTo(r.annual / 12, 1);
    expect(r.perApp).toBeCloseTo(r.annual / r.frequency, 1);
  });

  test('applies the commercial account minimum on tiny turf', () => {
    const r = priceCommercialLawn({ turfSf: 5000 });
    expect(r.annual).toBe(1200);
    expect(r.minApplied).toBe(true);
  });

  test('is an estimated, instantly-shown, untaxed line (FL lawn treatment)', () => {
    const r = priceCommercialLawn({ turfSf: 20000 }, { commercialSubtype: 'office_retail' });
    expect(r).toMatchObject({
      service: 'commercial_lawn',
      quoteRequired: false,
      requiresManualReview: false,
      estimatedPricing: true,
      commercialPricingMode: 'auto_estimate',
      taxable: false,
      taxCategory: 'lawn_spraying_or_treatment',
      commercialSubtype: 'office_retail',
    });
    expect(r.disclaimer).toMatch(/confirmed on site/i);
    expect(r.detail).toMatch(/confirmed on site/i);
  });

  test('no size cap — very large turf keeps pricing linearly and flags low confidence', () => {
    const big = priceCommercialLawn({ turfSf: 500000 });
    expect(big.annual).toBeGreaterThan(priceCommercialLawn({ turfSf: 150000 }).annual);
    expect(big.quoteRequired).toBe(false);
    expect(big.pricingConfidence).toBe('LOW');
  });

  test('falls back to a lot-based turf estimate when no turf is measured', () => {
    const r = priceCommercialLawn({ lotSqFt: 100000 });
    expect(r.turfBasis).toBe('commercialLotFallback');
    expect(r.turfSf).toBe(45000);
    expect(r.annual).toBeGreaterThan(0);
  });

  test('respects an explicit measured-zero turf (does not invent a lot estimate)', () => {
    // Turf measured as absent (all-hardscape lot) is authoritative — price at
    // the account minimum, NOT lot * 0.45. (Regression for Codex R11 P1.)
    const r = priceCommercialLawn({ turfSf: 0, lotSqFt: 100000 });
    expect(r.turfSf).toBe(0);
    expect(r.turfBasis).toBe('turfSf');
    expect(r.annual).toBe(1200);
  });
});

describe('priceCommercialTreeShrub — cost-buildup auto-pricer', () => {
  test('golden anchors by bed area, 10 trees (approved 2026-06-28, incl. route drive)', () => {
    expect(priceCommercialTreeShrub({ bedArea: 2000 }, { treeCount: 10 }).annual).toBeCloseTo(1364.55, 2);
    expect(priceCommercialTreeShrub({ bedArea: 5000 }, { treeCount: 10 }).annual).toBeCloseTo(2190.91, 2);
    expect(priceCommercialTreeShrub({ bedArea: 20000 }, { treeCount: 10 }).annual).toBeCloseTo(6322.73, 2);
  });

  test('cost buildup includes route drive time (6 trips)', () => {
    const r = priceCommercialTreeShrub({ bedArea: 5000 }, { treeCount: 10 });
    expect(r.costs.driveCost).toBeCloseTo(52.5, 2); // 35/hr * 15min/60 * 6 visits
    expect(r.costs.directCost).toBeCloseTo(
      r.costs.materialCost + r.costs.laborCost + r.costs.driveCost, 2
    );
  });

  test('is an estimated, instantly-shown, untaxed ornamental line', () => {
    const r = priceCommercialTreeShrub({ bedArea: 6000 }, { treeCount: 12, commercialSubtype: 'hoa_common_area_commercial' });
    expect(r).toMatchObject({
      service: 'commercial_tree_shrub',
      quoteRequired: false,
      requiresManualReview: false,
      estimatedPricing: true,
      commercialPricingMode: 'auto_estimate',
      taxable: false,
      taxCategory: 'lawn_spraying_or_treatment',
    });
    expect(r.margin).toBeCloseTo(0.45, 2);
    expect(r.disclaimer).toMatch(/confirmed on site/i);
  });

  test('resolves bed area UNCAPPED for commercial (no residential 8000 sqft cap)', () => {
    const r = priceCommercialTreeShrub({ lotSqFt: 200000 });
    expect(r.bedAreaSource).toBe('lot_based');
    expect(r.bedArea).toBeGreaterThan(8000);
    expect(r.annual).toBeGreaterThan(priceCommercialTreeShrub({ bedArea: 8000 }).annual);
  });

  test('a literal treeCount:0 override does not suppress the property/features fallback', () => {
    // Public quote adapters may pass treeCount: 0 to mean "omitted" — it must
    // not zero out the per-tree material term. (Regression for Codex R3 P1-2.)
    expect(priceCommercialTreeShrub({ bedArea: 5000, treeCount: 8 }, { treeCount: 0 }).treeCount).toBe(8);
    expect(priceCommercialTreeShrub({ bedArea: 5000, features: { treeCount: 3 } }, {}).treeCount).toBe(3);
    // A positive override still wins.
    expect(priceCommercialTreeShrub({ bedArea: 5000, treeCount: 8 }, { treeCount: 5 }).treeCount).toBe(5);
  });

  test('estimates tree count from tree-density enum when no numeric count exists', () => {
    // Public quote enrichment supplies features.trees as a density string, not a
    // count — map it via TREE_SHRUB.treeDensityCounts instead of pricing zero
    // trees. (Regression for Codex R6 P1-2.)
    expect(priceCommercialTreeShrub({ bedArea: 5000, features: { trees: 'moderate' } }, {}).treeCount).toBe(6);
    expect(priceCommercialTreeShrub({ bedArea: 5000, treeDensity: 'heavy' }, { treeCount: 0 }).treeCount).toBe(10);
    // A positive numeric count still beats the density estimate.
    expect(priceCommercialTreeShrub({ bedArea: 5000, features: { trees: 'heavy' } }, { treeCount: 4 }).treeCount).toBe(4);
  });

  test('applies the commercial ornamental account minimum on tiny beds', () => {
    const r = priceCommercialTreeShrub({ bedArea: 200 }, { treeCount: 0 });
    expect(r.annual).toBe(900);
    expect(r.minApplied).toBe(true);
  });

  test('respects an explicit measured-zero bed area (does not invent a lot estimate)', () => {
    // Beds measured as absent are authoritative — price at the minimum, not a
    // lot-density estimate. (Regression for Codex R11 P1.)
    const r = priceCommercialTreeShrub({ bedArea: 0, lotSqFt: 100000 }, { treeCount: 0 });
    expect(r.bedArea).toBe(0);
    expect(r.bedAreaSource).toBe('explicit');
    expect(r.annual).toBe(900);
  });
});

describe('priceCommercialPest — cost-buildup auto-pricer', () => {
  test('golden anchors by building footprint + perimeter (monthly cadence)', () => {
    expect(priceCommercialPest({ footprint: 3000, perimeter: 220 })).toMatchObject({
      service: 'commercial_pest',
      annual: 1424.73,
      monthly: 118.73,
      perApp: 118.73,
      visitsPerYear: 12,
    });
    expect(priceCommercialPest({ footprint: 10000, perimeter: 400 }).annual).toBe(2280);
    expect(priceCommercialPest({ footprint: 20000, perimeter: 600 }).annual).toBe(3472.73);
  });

  test('is FL-taxed and flat (never WaveGuard/recurring-% discountable)', () => {
    const r = priceCommercialPest({ footprint: 5000, perimeter: 280 });
    expect(r.taxable).toBe(true);
    expect(r.taxCategory).toBe('nonresidential_pest_control');
    expect(r.discountable).toBe(false);
    expect(r.excludeFromPctDiscount).toBe(true);
    expect(r.estimatedPricing).toBe(true);
    expect(r.quoteRequired).toBe(false);
    expect(r.requiresManualReview).toBe(false);
    expect(r.disclaimer).toMatch(/confirmed on site/i);
    expect(r.margin).toBeCloseTo(0.45, 2);
  });

  test('derives perimeter from footprint when none is supplied (square approximation)', () => {
    // perimeter = 4·√10000 = 400, so the priced result matches the explicit case.
    const derived = priceCommercialPest({ footprint: 10000 });
    expect(derived.perimeter).toBe(400);
    expect(derived.annual).toBe(2280);
  });

  test('prices off the building footprint resolved from homeSqFt through the engine', () => {
    const est = generateEstimate({
      propertyType: 'commercial',
      homeSqFt: 8000,
      lotSqFt: 40000,
      services: { pest: { frequency: 'quarterly' } },
    });
    const pest = est.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest).toBeTruthy();
    expect(pest.quoteRequired).toBe(false);
    expect(pest.annual).toBeGreaterThan(0);
    expect(pest.footprint).toBeGreaterThan(0);
  });

  test('falls back to a MANUAL quote when no real building footprint is available', () => {
    // Direct call: no building/home/footprint → resolvePestFootprint defaults to
    // 2,000 sqft, which must NOT auto-price (it would bill below the real
    // building). (Regression for the PR bot's P0.)
    const r = priceCommercialPest({ lotSqFt: 40000 });
    expect(r.quoteRequired).toBe(true);
    expect(r.requiresManualReview).toBe(true);
    expect(r.estimatedPricing).toBe(false);
    expect(r.annual).toBeNull();
    expect(r.manualReviewReasons).toContain('commercial_pest_missing_building_footprint');
  });

  test('a lot-only commercial pest estimate routes to a manual quote, not a priced line', () => {
    const est = generateEstimate({
      propertyType: 'commercial',
      lotSqFt: 40000,
      services: { pest: { frequency: 'quarterly' } },
    });
    const pest = est.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest).toBeTruthy();
    expect(pest.quoteRequired).toBe(true);
    // Not an active/priced service.
    expect(est.waveGuard.activeServices).not.toContain('commercial_pest');
  });

  test('buildingSizeMeasured:false (public synthetic 2,000 sqft) forces a manual pest quote', () => {
    // The public wizard seeds homeSqFt=2000 when the lookup found no building —
    // a real-looking footprint that must NOT auto-price commercial pest. The
    // public-quote route flags it via buildingSizeMeasured:false. (Regression for
    // the PR bot's synthetic-footprint P1.)
    const synthetic = generateEstimate({
      propertyType: 'commercial',
      homeSqFt: 2000,
      lotSqFt: 40000,
      buildingSizeMeasured: false,
      services: { pest: { frequency: 'quarterly' } },
    });
    const sPest = synthetic.lineItems.find((l) => l.service === 'commercial_pest');
    expect(sPest.quoteRequired).toBe(true);
    expect(synthetic.waveGuard.activeServices).not.toContain('commercial_pest');

    // A MEASURED 2,000 sqft building (flag true / admin undefined) still prices.
    const measured = generateEstimate({
      propertyType: 'commercial',
      homeSqFt: 2000,
      lotSqFt: 40000,
      buildingSizeMeasured: true,
      services: { pest: { frequency: 'quarterly' } },
    });
    expect(measured.lineItems.find((l) => l.service === 'commercial_pest').quoteRequired).toBe(false);

    // Direct-call: the option also forces manual even with a real footprint.
    expect(priceCommercialPest({ footprint: 2000 }, { buildingSizeMeasured: false }).quoteRequired).toBe(true);
  });
});

describe('priceCommercialMosquito / TermiteBait / RodentBait — cost-buildup auto-pricers', () => {
  test('mosquito golden anchor (treatable-area driven, 9 visits) + FL-taxed flat', () => {
    const r = priceCommercialMosquito({ mosquitoTreatableSqFt: 40000 });
    expect(r).toMatchObject({
      service: 'commercial_mosquito',
      annual: 1534.09,
      monthly: 127.84,
      visitsPerYear: 9,
      quoteRequired: false,
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
      discountable: false,
      excludeFromPctDiscount: true,
      estimatedPricing: true,
    });
  });

  test('mosquito prices off lot-derived treatable area (lot − footprint − hardscape)', () => {
    // Lot-only (no building) still prices off lot − footprint − hardscape.
    const r = priceCommercialMosquito({ lotSqFt: 60000 });
    expect(r.quoteRequired).toBe(false);
    expect(r.annual).toBeGreaterThan(0);
  });

  test('mosquito with a SYNTHETIC public lot (no real parcel) falls back to a MANUAL quote', () => {
    // The public wizard synthesizes lotSqFt = sqft × 4 when no real parcel data
    // exists, so the computed treatable area is fabricated. lotSizeMeasured:false
    // marks it — don't auto-price off it.
    const synthetic = priceCommercialMosquito({ lotSqFt: 32000 }, { lotSizeMeasured: false });
    expect(synthetic).toMatchObject({
      service: 'commercial_mosquito',
      quoteRequired: true,
      annual: null,
      manualReviewReasons: ['commercial_mosquito_missing_treatable_area'],
    });
    // A REAL lot (lotSizeMeasured true, or admin path where it's undefined) prices.
    expect(priceCommercialMosquito({ lotSqFt: 32000 }, { lotSizeMeasured: true }).quoteRequired).toBe(false);
    expect(priceCommercialMosquito({ lotSqFt: 32000 }).quoteRequired).toBe(false);
    // An explicit treatable area is real input — prices even if the lot is synthetic.
    expect(priceCommercialMosquito({ mosquitoTreatableSqFt: 30000 }, { lotSizeMeasured: false }).quoteRequired).toBe(false);
  });

  test('mosquito with a building size but NO outdoor-area data falls back to a MANUAL quote', () => {
    // Footprint only, no lot/treatable area, no lot category → treatable resolves
    // to 0 (missing_or_zero_fallback). Don't auto-price the bare account minimum
    // off 0 sqft — require a lot / treatable-area input via a manual quote.
    const r = priceCommercialMosquito({ footprintSqFt: 3000 });
    expect(r).toMatchObject({
      service: 'commercial_mosquito',
      originalRequestedService: 'mosquito',
      quoteRequired: true,
      annual: null,
      taxable: true,
      manualReviewReasons: ['commercial_mosquito_missing_treatable_area'],
    });
  });

  test('termite-bait golden anchor (perimeter-driven monitoring, 4 visits)', () => {
    const r = priceCommercialTermiteBait({ footprint: 10000, perimeter: 400 });
    expect(r).toMatchObject({ service: 'commercial_termite_bait', annual: 850.91, visitsPerYear: 4, taxable: true });
  });

  test('rodent-bait golden anchor (footprint-driven, 4 visits)', () => {
    const r = priceCommercialRodentBait({ footprint: 10000 });
    expect(r).toMatchObject({ service: 'commercial_rodent_bait', annual: 781.21, visitsPerYear: 4, taxable: true });
  });

  test('termite/rodent fall back to a MANUAL quote with no real building size', () => {
    for (const fn of [priceCommercialTermiteBait, priceCommercialRodentBait]) {
      const r = fn({ lotSqFt: 60000 }, { buildingSizeMeasured: false });
      expect(r.quoteRequired).toBe(true);
      expect(r.annual).toBeNull();
      expect(r.taxable).toBe(true);
    }
  });

  test('termite measurements override the property building size and unlock auto-pricing', () => {
    // Admin-measured perimeter on a lot-only estimate auto-prices (no manual quote)
    // even under buildingSizeMeasured:false — the operator measured the building.
    const measuredLotOnly = priceCommercialTermiteBait(
      { lotSqFt: 60000 },
      { buildingSizeMeasured: false, footprintSqFt: 10000, perimeterLF: 400 },
    );
    expect(measuredLotOnly).toMatchObject({ service: 'commercial_termite_bait', quoteRequired: false, annual: 850.91 });
    expect(measuredLotOnly.footprintSource).toBe('termite_measurement');
    // A divergent homeSqFt must NOT override the supplied termite measurement —
    // price equals the golden anchor, not whatever the home size would derive.
    const divergent = priceCommercialTermiteBait(
      { homeSqFt: 99999, stories: 1 },
      { footprintSqFt: 10000, perimeterLF: 400 },
    );
    expect(divergent.annual).toBe(850.91);
    expect(divergent.perimeter).toBe(400);
  });

  test('all three auto-price through the engine as taxable, flat, non-WaveGuard lines', () => {
    const est = generateEstimate({
      propertyType: 'commercial',
      homeSqFt: 10000,
      lotSqFt: 80000,
      services: { mosquito: { tier: 'monthly12' }, termite: {}, rodentBait: {} },
    });
    const byKey = Object.fromEntries(est.lineItems.map((l) => [l.service, l]));
    ['commercial_mosquito', 'commercial_termite_bait', 'commercial_rodent_bait'].forEach((k) => {
      expect(byKey[k]).toBeTruthy();
      expect(byKey[k].quoteRequired).toBe(false);
      expect(byKey[k].annual).toBeGreaterThan(0);
      expect(byKey[k].taxable).toBe(true);
    });
    // No residential pricers fired; flat (no WaveGuard discount on the recurring total).
    expect(byKey.mosquito).toBeUndefined();
    expect(byKey.termite_bait).toBeUndefined();
    expect(byKey.rodent_bait).toBeUndefined();
    expect(est.summary.recurringAnnualBeforeDiscount).toBeCloseTo(est.summary.recurringAnnualAfterDiscount, 0);
  });

  test('termite/rodent manual fallbacks keep their specific commercial service (not collapsed to commercial_pest)', () => {
    // Lot-only commercial estimate (no building footprint) → termite & rodent fall
    // to a manual quote. Each must keep its OWN service + originalRequestedService
    // + review reason: the engine pushes the pricer's service-specific manual line
    // rather than routing through the generic commercial_pest manual quote (which
    // would mislabel a termite/rodent request as commercial pest). Mosquito is
    // lot-derivable so it still prices.
    const est = generateEstimate({
      propertyType: 'commercial',
      lotSqFt: 40000,
      services: { mosquito: { tier: 'monthly12' }, termite: {}, rodentBait: {} },
    });
    const byKey = Object.fromEntries(est.lineItems.map((l) => [l.service, l]));
    expect(byKey.commercial_termite_bait).toMatchObject({
      quoteRequired: true,
      originalRequestedService: 'termite_bait',
      manualReviewReasons: ['commercial_termite_missing_building_footprint'],
    });
    expect(byKey.commercial_rodent_bait).toMatchObject({
      quoteRequired: true,
      originalRequestedService: 'rodent_bait',
      manualReviewReasons: ['commercial_rodent_missing_building_footprint'],
    });
    // The termite/rodent manual lines did NOT collapse into a commercial_pest quote.
    expect(byKey.commercial_pest).toBeUndefined();
    // Mosquito stays auto-priced (treatable area is lot-derivable).
    expect(byKey.commercial_mosquito).toMatchObject({ quoteRequired: false });
    expect(byKey.commercial_mosquito.annual).toBeGreaterThan(0);
  });
});

describe('generateEstimate — commercial integration', () => {
  const commercialInput = {
    propertyType: 'commercial',
    commercialSubtype: 'office_retail',
    lotSqFt: 80000,
    homeSqFt: 12000,
    turfSf: 40000,
    bedArea: 6000,
    services: {
      lawn: { track: 'st_augustine' },
      treeShrub: { treeCount: 12 },
      pest: { frequency: 'quarterly' },
    },
  };

  test('prices commercial lawn + tree/shrub + pest (ALL commercial auto-prices)', () => {
    const est = generateEstimate(commercialInput);
    const byService = Object.fromEntries(est.lineItems.map((l) => [l.service, l]));

    expect(byService.commercial_lawn.quoteRequired).toBe(false);
    expect(byService.commercial_lawn.annual).toBeGreaterThan(0);
    expect(byService.commercial_tree_shrub.quoteRequired).toBe(false);
    expect(byService.commercial_tree_shrub.annual).toBeGreaterThan(0);
    // Pest now auto-prices too (owner directive 2026-06-29: ALL commercial auto).
    expect(byService.commercial_pest.quoteRequired).toBe(false);
    expect(byService.commercial_pest.annual).toBeGreaterThan(0);
    // Commercial pest is FL-taxed (nonresidential_pest_control), unlike lawn/tree.
    expect(byService.commercial_pest.taxable).toBe(true);
    expect(byService.commercial_pest.taxCategory).toBe('nonresidential_pest_control');
    // No residential pricers fired.
    expect(byService.lawn_care).toBeUndefined();
    expect(byService.tree_shrub).toBeUndefined();
    expect(byService.pest_control).toBeUndefined();
  });

  test('priced commercial lines roll into the recurring total without a WaveGuard discount', () => {
    const est = generateEstimate(commercialInput);
    const lawn = est.lineItems.find((l) => l.service === 'commercial_lawn');
    const ts = est.lineItems.find((l) => l.service === 'commercial_tree_shrub');
    const pest = est.lineItems.find((l) => l.service === 'commercial_pest');

    expect(est.summary.recurringAnnualAfterDiscount).toBeCloseTo(lawn.annual + ts.annual + pest.annual, 0);
    // Flat pricing — before == after (no WaveGuard / recurring-customer discount).
    expect(est.summary.recurringAnnualBeforeDiscount).toBeCloseTo(est.summary.recurringAnnualAfterDiscount, 0);
    expect(est.summary.waveGuardSavings).toBe(0);
    expect(est.waveGuard.activeServices).toEqual(
      expect.arrayContaining(['commercial_lawn', 'commercial_tree_shrub', 'commercial_pest'])
    );
  });

  test('commercial tree/shrub uses UNCAPPED bed area through the full estimate flow', () => {
    // calculatePropertyProfile caps lot-derived bed area at BED_AREA_CAP (8000)
    // and preserves the raw value as uncappedBedAreaEstimate. Commercial pricing
    // must recover the uncapped figure (no size cap) instead of underquoting at
    // 8,000 sqft. (Regression guard for the Codex P0.)
    const est = generateEstimate({
      propertyType: 'commercial',
      lotSqFt: 200000,
      homeSqFt: 20000,
      services: { treeShrub: {} },
    });
    const ts = est.lineItems.find((l) => l.service === 'commercial_tree_shrub');
    expect(ts.bedArea).toBeGreaterThan(8000);
    // A capped 8,000-sqft bed would price far lower.
    expect(ts.annual).toBeGreaterThan(priceCommercialTreeShrub({ bedArea: 8000 }).annual * 1.5);
  });

  test('commercial pricing consumes measured turf/bed inputs (not just lot-derived)', () => {
    // The public quote route passes property-lookup measurements
    // (estimatedTurfSf / estimatedBedAreaSf) into the engine for commercial; the
    // pricers must price off them rather than a lot-derived fallback.
    // (Contract guard for Codex R8 P0.)
    const est = generateEstimate({
      propertyType: 'commercial',
      lotSqFt: 80000,
      homeSqFt: 12000,
      estimatedTurfSf: 40000,
      estimatedBedAreaSf: 6000,
      services: { lawn: {}, treeShrub: {} },
    });
    const lawn = est.lineItems.find((l) => l.service === 'commercial_lawn');
    const ts = est.lineItems.find((l) => l.service === 'commercial_tree_shrub');
    expect(lawn.turfSf).toBe(40000);
    expect(lawn.turfBasis).toBe('estimatedTurfSf');
    expect(ts.bedArea).toBe(6000);
  });

  test('a blank/estimated zero bed area falls back to the lot estimate (not the $900 min)', () => {
    // The admin V2 form sends estimatedBedAreaSf: 0 as its blank default, which
    // calculatePropertyProfile resolves to bedArea: 0 / bedAreaSource:
    // 'estimated'. That inferred zero must NOT price at the ornamental minimum —
    // it falls through to the lot-density estimate so a real commercial property
    // with beds isn't underquoted. (Regression for the PR bot's P1.)
    const est = generateEstimate({
      propertyType: 'commercial',
      lotSqFt: 120000,
      homeSqFt: 12000,
      estimatedBedAreaSf: 0,
      services: { treeShrub: {} },
    });
    const ts = est.lineItems.find((l) => l.service === 'commercial_tree_shrub');
    expect(ts.bedArea).toBeGreaterThan(0);
    expect(ts.bedAreaSource).not.toBe('explicit');
    // A real lot-derived bed prices well above the $900 ornamental minimum.
    expect(ts.annual).toBeGreaterThan(900);
    expect(ts.minApplied).toBeFalsy();
  });

  test('a deliberate explicit zero bed area is still honored (all-hardscape lot)', () => {
    // Direct/explicit zero (no estimated source) stays authoritative — the
    // P1-B fix only redirects the inferred/estimated zero. (Guards R11.)
    const r = priceCommercialTreeShrub({ bedArea: 0, lotSqFt: 100000 }, { treeCount: 0 });
    expect(r.bedArea).toBe(0);
    expect(r.bedAreaSource).toBe('explicit');
    expect(r.annual).toBe(900);
  });

  test('residential estimate is unaffected (still uses residential pricers)', () => {
    const res = generateEstimate({
      propertyType: 'single_family',
      lotSqFt: 12000,
      homeSqFt: 2000,
      turfSf: 8000,
      services: { lawn: { track: 'st_augustine', tier: 'enhanced' }, treeShrub: { treeCount: 4 } },
    });
    const services = res.lineItems.map((l) => l.service);
    expect(services).toContain('lawn_care');
    expect(services).toContain('tree_shrub');
    expect(services).not.toContain('commercial_lawn');
    expect(services).not.toContain('commercial_tree_shrub');
  });
});
