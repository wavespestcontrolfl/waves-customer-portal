const {
  priceTermiteBait,
  priceTrenching,
  priceBoraCare,
  pricePreSlabTermiticide,
  pricePreSlabTermidor,
  normalizeTrenchingTermiticideProduct,
  normalizeTrenchingApplicationRate,
  normalizePreSlabTermiticideProduct,
} = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');

// Rows the deprecated client engine (client/src/lib/estimateEngine.js calculateEstimate) wrote before the bottle swap, frozen from
// main (a68674a9eb: Talak at $41.57 / 96 oz on both bifenthrin keys, the full trench volume) for a 2,400 sq ft one-story home on a
// 9,000 sq ft lot, with the lower Taurus cost the trench describe below configures ($30 / 78 oz). The client source now prices the
// new bottle and the label's half volume, so it can no longer write them (pre-push audit at the tenth push). Their one-time rows
// carry a name and no service.
const CLIENT_ROWS = {
  // svcPreslab: true, preslabSqft: 6832, preslabProductKey: 'talstar_p'
  preSlab: {
    name: 'Pre-Slab', displayName: 'Pre-Slab Termiticide Treatment', price: 993,
    detail: '6,832 sf | Talak 7.9 F | 683.2 oz | 8 units | Basic 1-yr warranty', psSqft: 6832, productKey: 'talstar_p',
    productLabel: 'Talak 7.9 F - Bifenthrin', activeIngredient: 'bifenthrin', chemistryType: 'repellent_pyrethroid',
    positioning: 'standard_repellent', productOz: 683.2, units: 8, btl: 8, containersRequired: 8, containerOz: 96,
    containerCost: 41.57, chemicalCostPerOz: 0.433, allocatedProductCost: 295.84, productCost: 295.84,
    fullContainerProductCost: 332.56, laborHrs: 5, laborCost: 175, equipCost: 15, complianceAdminCost: 25, driveCost: 11.67,
    includeDriveCost: true, cost: 522.51, rawPrice: 987, usageStepSqFt: 100, usageStepPricedSqFt: 6900, usageStepPrice: 993,
    jobContext: 'standalone', preSlabJobContext: 'standalone', preSlabJobContextLabel: 'Standalone one-off job',
    contextualFloor: 510, contextualMinimumBasis: 'Standalone one-off job, over 1,250 sqft', floorBeforeVolumeDiscount: 510,
    floorAfterVolumeDiscount: 510, priceBeforeVolumeDiscount: 993, priceAfterVolumeDiscount: 993, volDisc: false,
    volumeDiscount: 'none', volumeDiscountMultiplier: 1, basePrice: 993, warrAdd: 0, warrantyTier: 'BASIC',
    warrantyLabel: 'Basic 1-yr warranty', warrantyStatus: 'Basic 1-yr warranty', warrantyExtendedSelected: false,
    labelConfirmed: false, requiresManualReview: true, manualReviewReasons: ['pre_slab_label_confirmation_required'],
    certificateOfComplianceRequired: true,
    warningText: 'Bifenthrin repellent barrier (Atticus Talak 7.9 F, EPA 91234-145). Confirm the Talak label supports pre-construction subterranean termite treatment.',
  },
  // svcTrenching: true, trenchingPerimeterLF: 400, trenchingProductKey: 'talstar_p', trenchingApplicationRate: 'high'
  trench: {
    name: 'Trenching', price: 4996, detail: '300 LF dirt + 100 LF concrete | Talak 7.9 F', productKey: 'talstar_p',
    productLabel: 'Talak 7.9 F - Bifenthrin', activeIngredient: 'bifenthrin', chemistryType: 'repellent_pyrethroid',
    positioning: 'standard_repellent', applicationRate: 'high', trenchDepthFt: 0.5, dirtFinishedGallons: 60,
    concreteFinishedGallons: 24, finishedGallons: 84, productOz: 168, allocatedChemicalCost: 72.75, includedChemicalCost: 25.85,
    productSurcharge: 68, baseInstallBeforePremium: 4400, trenchDepthPriceMultiplier: 1, highRatePriceMultiplier: 1.12,
    baseInstallPrice: 4928, warrantyTier: 'none', warrantyAdder: 0, labelConfirmed: false,
    warningText: 'Bifenthrin repellent barrier (Atticus Talak 7.9 F). Do not attach long repair-and-retreat warranty without admin approval.',
    requiresManualReview: true, quoteRequired: false,
  },
};
const REPLAY_DEPS = { needsSync: () => false, syncConstantsFromDB: async () => {}, withTrustedCatalogPricing: async (inputs) => inputs, translateV2CallToV1Input: null };

describe('termite measurement overrides and safeguards', () => {
  test('termite bait keeps existing valid pricing example', () => {
    const result = priceTermiteBait(
      { footprint: 2000, features: { complexity: 'standard' } },
      { system: 'advance', monitoringTier: 'basic' }
    );

    expect(result.perimeter).toBe(224);
    expect(result.stations).toBe(23);
    expect(result.installation.price).toBe(639);
    // 23 stations -> 21-25 bracket $34/mo (owner 2026-07-28 station brackets).
    expect(result.monitoring.monthly).toBe(34);
    expect(result.monitoring.annual).toBe(408);
    expect(result.measurements.footprintSqFt.source).toBe('property_footprint');
    expect(result.measurements.perimeterLF.source).toBe('computed_from_footprint');
  });

  test('termite bait falls back to property complexity unless layout is explicit', () => {
    const auto = translateV2CallToV1Input(
      { homeSqFt: 2000, stories: 1, lotSqFt: 8000, landscapeComplexity: 'COMPLEX' },
      ['TERMITE_BAIT'],
      { termiteBaitSystem: 'advance' }
    );
    const autoEstimate = generateEstimate(auto);
    const autoBait = autoEstimate.lineItems.find((item) => item.service === 'termite_bait');

    expect(autoBait.complexity).toBe('complex');
    expect(autoBait.perimeter).toBe(241);
    expect(autoBait.stations).toBe(25);
    expect(autoBait.installation.price).toBe(695);

    const explicitStandard = translateV2CallToV1Input(
      { homeSqFt: 2000, stories: 1, lotSqFt: 8000, landscapeComplexity: 'COMPLEX' },
      ['TERMITE_BAIT'],
      { termiteBaitSystem: 'advance', termiteBaitComplexity: 'standard' }
    );
    const standardEstimate = generateEstimate(explicitStandard);
    const standardBait = standardEstimate.lineItems.find((item) => item.service === 'termite_bait');

    expect(standardBait.complexity).toBe('standard');
    expect(standardBait.perimeter).toBe(224);
    expect(standardBait.stations).toBe(23);
    expect(standardBait.installation.price).toBe(639);
  });

  test('termite bait accepts manual perimeter override and avoids NaN on missing measurements', () => {
    const override = priceTermiteBait(
      { footprint: 2000 },
      { system: 'advance', measurements: { perimeterLF: 300 } }
    );

    expect(override.perimeter).toBe(300);
    expect(override.perimeterSource).toBe('manual_override');
    expect(override.stations).toBe(30);
    expect(override.installation.price).toBeGreaterThan(639);
    expect(override.manualReviewReasons).toContain('termite_perimeter_manual_override_used');

    const propertyPerimeter = priceTermiteBait(
      { footprint: 2000, perimeter: 300, perimeterSource: 'property_perimeter' },
      { system: 'advance' }
    );
    expect(propertyPerimeter.perimeter).toBe(300);
    expect(propertyPerimeter.perimeterSource).toBe('property_perimeter');
    expect(propertyPerimeter.stations).toBe(30);

    const missing = priceTermiteBait({}, { system: 'unknown' });
    expect(missing.quoteRequired).toBe(true);
    expect(missing.requiresMeasurement).toBe(true);
    expect(missing.manualReviewReasons).toContain('missing_termite_footprint');
    expect(Number.isNaN(missing.perimeter)).toBe(false);
    // Unknown systems fall back to the Trelona-only menu default (owner 2026-07-28).
    expect(missing.selectedSystem).toBe('trelona');
    expect(missing.measurementWarnings).toContain('invalid_termite_system_defaulted_to_trelona');
  });

  test('trenching keeps existing valid example and supports manual concrete LF', () => {
    // largeDriveway is retired estimator-wide (2026-07-30): the flag stays in
    // the fixture to pin that it no longer adds to the concrete split — the
    // pool cage alone sets 0.35.
    const existing = priceTrenching({
      perimeter: 240,
      features: { poolCage: true, largeDriveway: true },
    });

    expect(existing.concretePct).toBe(0.35);
    expect(existing.dirtLF).toBe(156);
    expect(existing.concreteLF).toBe(84);
    expect(existing.price).toBe(2736);
    expect(existing.renewal).toBe(325);
    expect(existing.productKey).toBe('taurus_sc');
    expect(existing.productSurcharge).toBe(0);
    expect(existing.baseInstallPrice).toBe(2736);
    // Default trench depth is now the 0.5 ft baseline (×1.0 install premium), so
    // finished gallons halve vs. the retired 1.0 ft default; base price is unchanged.
    expect(existing.trenchDepthPriceMultiplier).toBe(1);
    expect(existing.highRatePriceMultiplier).toBe(1);
    // (156 dirt + 84 concrete × 1.2 pad) × 4 gal/10LF × 0.5 ft depth
    expect(existing.finishedGallons).toBe(51.36);

    const manual = priceTrenching({}, {
      measurements: { perimeterLF: 240, concreteLF: 120 },
    });
    expect(manual.concretePct).toBe(0.5);
    expect(manual.dirtLF).toBe(120);
    expect(manual.concreteLF).toBe(120);
    expect(manual.price).toBe(2880);
    expect(manual.concreteLFSource).toBe('manual_override');

    const allDirt = priceTrenching({}, {
      measurements: { perimeterLF: 240, concreteLF: 0 },
    });
    expect(allDirt.concretePct).toBe(0);
    expect(allDirt.concreteLF).toBe(0);
    expect(allDirt.dirtLF).toBe(240);
    expect(allDirt.price).toBe(2400);
    expect(allDirt.concreteLFSource).toBe('manual_override');
  });

  test('trench depth and high application rate scale the install price (Phase 2 premiums)', () => {
    const measured = {
      measurements: { perimeterLF: 240, concreteLF: 96 },
      productKey: 'taurus_sc',
      labelConfirmed: true,
    };
    const shallow = priceTrenching({}, { ...measured, trenchDepthFt: 0.5 });
    const medium = priceTrenching({}, { ...measured, trenchDepthFt: 1 });
    const deep = priceTrenching({}, { ...measured, trenchDepthFt: 1.5 });

    // Baseline 0.5 ft leaves the $2,784 LF install model untouched.
    expect(shallow.trenchDepthPriceMultiplier).toBe(1);
    expect(shallow.baseInstallBeforePremium).toBe(2784);
    expect(shallow.baseInstallPrice).toBe(2784);
    expect(shallow.price).toBe(2784);

    // 1.0 ft = +15%, 1.5 ft = +30% on the install model (owner-approved "Moderate").
    expect(medium.trenchDepthPriceMultiplier).toBe(1.15);
    expect(medium.baseInstallPrice).toBe(3202); // round(2784 × 1.15)
    expect(medium.price).toBe(3202);
    expect(deep.trenchDepthPriceMultiplier).toBe(1.3);
    expect(deep.baseInstallPrice).toBe(3619); // round(2784 × 1.30)
    expect(deep.price).toBe(3619);

    // High/problem-soil application rate = +12% install premium (isolated on baseInstallPrice;
    // the pre-existing high-rate chemical surcharge stacks on top of this in the total price).
    const highRate = priceTrenching({}, { ...measured, trenchDepthFt: 0.5, applicationRate: 'high' });
    expect(highRate.highRatePriceMultiplier).toBe(1.12);
    expect(highRate.baseInstallPrice).toBe(3118); // round(2784 × 1.0 × 1.12)
  });

  test('trenching normalizes products, rates, and chemical cost per LF', () => {
    expect(normalizeTrenchingTermiticideProduct('termidor sc').productKey).toBe('termidor_sc');
    expect(normalizeTrenchingTermiticideProduct('basf').productKey).toBe('termidor_sc');
    expect(normalizeTrenchingTermiticideProduct('fipronil').productKey).toBe('taurus_sc');
    expect(normalizeTrenchingTermiticideProduct('bifen i/t').productKey).toBe('bifen_it');
    expect(normalizeTrenchingTermiticideProduct('talstar pro').productKey).toBe('talstar_p');
    expect(normalizeTrenchingTermiticideProduct('talak').productKey).toBe('talstar_p');
    expect(normalizeTrenchingApplicationRate('0.06%').applicationRate).toBe('standard');
    expect(normalizeTrenchingApplicationRate('problem soil').applicationRate).toBe('high');

    // Pin depth to 1 ft so the documented per-LF chemical costs are independent
    // of the 0.5 ft default (chemical volume scales linearly with trench depth).
    const base = { measurements: { perimeterLF: 100, dirtLF: 100, concreteLF: 0 }, concreteVolumePadPct: 0, trenchDepthFt: 1 };
    // SiteOne member prices read 2026-11-01: Termidor SC $174.72 and Taurus SC $95 per 78 oz, x 0.32 oz per LF.
    expect(priceTrenching({}, { ...base, productKey: 'termidor_sc' }).chemicalCostPerLF).toBeCloseTo(0.72, 2);
    expect(priceTrenching({}, { ...base, productKey: 'taurus_sc' }).chemicalCostPerLF).toBeCloseTo(0.39, 2);
    // bifen_it is the same bottle as talstar_p (owner 2026-10-25; LESCO Crosscheck Plus since 2026-11-18).
    expect(priceTrenching({}, { ...base, productKey: 'bifen_it' }).chemicalCostPerLF).toBeCloseTo(0.1, 2);
    // talstar_p is the LESCO Crosscheck Plus bottle: $30.90 / 128 fl oz x 0.4 oz per LF = $0.10.
    expect(priceTrenching({}, { ...base, productKey: 'talstar_p' }).chemicalCostPerLF).toBeCloseTo(0.1, 2);
  });

  test('trenching Termidor premium surcharges while Bifen never discounts below LF model', () => {
    const termidor = priceTrenching({}, {
      measurements: { perimeterLF: 240, dirtLF: 144, concreteLF: 96 },
      productKey: 'termidor_sc',
      labelConfirmed: true,
    });
    // Chemical figures reflect the 0.5 ft baseline default (half the retired 1.0 ft).
    expect(termidor.finishedGallons).toBe(51.84);
    expect(termidor.productOz).toBeCloseTo(41.47, 2);
    expect(termidor.allocatedChemicalCost).toBeCloseTo(92.9, 2);
    expect(termidor.includedChemicalCost).toBeCloseTo(50.51, 2);
    expect(termidor.chemicalPremiumCost).toBeCloseTo(42.39, 2);
    expect(termidor.productSurcharge).toBe(61);
    expect(termidor.price).toBe(termidor.baseInstallPrice + termidor.productSurcharge);

    const bifen = priceTrenching({}, {
      measurements: { perimeterLF: 240, dirtLF: 144, concreteLF: 96 },
      productKey: 'bifen_it',
      labelConfirmed: true,
    });
    expect(bifen.allocatedChemicalCost).toBeLessThan(bifen.includedChemicalCost);
    expect(bifen.chemicalPremiumCost).toBe(0);
    expect(bifen.productSurcharge).toBe(0);
    expect(bifen.price).toBe(2784);
    expect(bifen.warnings).toContain('Repellent pyrethroid barrier; not equivalent to non-repellent fipronil.');
  });

  // The Crosscheck Plus label (EPA 10404-120; the Talak 7.9 F label says the same) allows the 0.12% termite dilution only at half
  // the 0.06% volume, so the active ingredient per foot stays the 0.06% amount (pre-push audit 9). Fipronil labels allow 0.125% at
  // the full volume.
  test('a bifenthrin high rate is the stronger dilution at a reduced volume: the same product per foot and the same price', () => {
    const measurements = { perimeterLF: 400, dirtLF: 400, concreteLF: 0 };
    const trench = (extra) => priceTrenching({}, { measurements, productKey: 'talstar_p', labelConfirmed: true, ...extra });
    const standard = trench({});
    const high = trench({ applicationRate: 'high' });
    expect(standard).toMatchObject({ finishedGallons: 80, productOzPerFinishedGallon: 1, productOz: 80, concentrationLabel: '0.06%', price: 4000 });
    expect(high).toMatchObject({ finishedGallons: 40, dirtFinishedGallons: 40, productOzPerFinishedGallon: 2, productOz: 80, concentrationLabel: 'high_rate' });
    expect(high.allocatedChemicalCost).toBe(standard.allocatedChemicalCost);
    expect(high.includedChemicalCost).toBe(standard.includedChemicalCost); // the install price includes the labeled volume
    expect(high.price).toBe(4480); // the +12% install premium, as before
    expect(high.warnings.join(' ')).toMatch(/reduced finished volume, the same active ingredient per foot/);
    // The label's two conditions for a reduced volume, named on the line by the engine that applies it; a check sent without the
    // Crosscheck Plus bottle mark does not count (pre-push audit 29). The reduced volume stays in review whatever the label check: the
    // estimate tool's box confirms the label rate and trench depth, and cannot see the configured dilution (pre-push audit at the
    // second push).
    expect(high.warnings.join(' '))
      .toMatch(/only where the soil will not accept the labeled volume and a continuous barrier can still be achieved/);
    expect(high).toMatchObject({ requiresManualReview: true, labelConfirmed: false });
    expect(high.manualReviewReasons).toEqual(expect.arrayContaining(['label_confirmation_required', 'reduced_volume_confirmation_required']));
    const confirmed = trench({ applicationRate: 'high', labelBottle: 'lesco_crosscheck_plus' });
    expect(confirmed).toMatchObject({ labelConfirmed: true, requiresManualReview: true });
    expect(confirmed.manualReviewReasons).not.toContain('label_confirmation_required');
    expect(confirmed.manualReviewReasons).toContain('reduced_volume_confirmation_required');
    expect(standard.manualReviewReasons || []).not.toContain('reduced_volume_confirmation_required'); // the labeled volume
    const products = require('../services/pricing-engine/constants').SPECIALTY.trenching.products;
    const savedHigh = products.talstar_p.productOzPerFinishedGallonAtHighRate;
    // The label charts one adjustment, its 0.12% dilution (2 fl oz a finished gallon) at half the volume, whatever the configured
    // rates: a configured high dilution off that chart keeps the full volume, as on main, even when the standard rate moves with it
    // (0.75 and 1.5 keep the 1:2 ratio, not the label's dilution); the label's own 2 oz keeps the half volume when only the
    // standard rate moves (pre-push audits 20 and 21).
    const savedStandard = products.talstar_p.productOzPerFinishedGallonAtStandardRate;
    try {
      products.talstar_p.productOzPerFinishedGallonAtHighRate = 1.5;
      const fullHigh = trench({ applicationRate: 'high', labelBottle: 'lesco_crosscheck_plus' });
      expect(fullHigh).toMatchObject({ finishedGallons: 80, productOz: 120, labelConfirmed: true });
      // The full volume: no reduced-volume warning and no reduced-volume review (the configured high rate decides it, not the tool).
      expect(fullHigh.warnings.join(' ')).not.toMatch(/reduced finished volume/);
      expect(fullHigh.manualReviewReasons).not.toContain('reduced_volume_confirmation_required');
      expect(fullHigh.manualReviewReasons).toContain('off_label_amount_confirmation_required'); // 6 fl oz, not the label's 4
      products.talstar_p.productOzPerFinishedGallonAtStandardRate = 0.75;
      const movedPair = trench({ applicationRate: 'high' });
      expect(movedPair).toMatchObject({ finishedGallons: 80, productOz: 120 });
      expect(movedPair.warnings.join(' ')).not.toMatch(/reduced finished volume/);
      products.talstar_p.productOzPerFinishedGallonAtHighRate = 2;
      expect(trench({ applicationRate: 'high' })).toMatchObject({ finishedGallons: 40, productOz: 80 });
      // A standard rate configured at the label's 2 oz halves the volume too, and that line stays in review like every reduced
      // volume, whatever its label check (pre-push audit 30).
      products.talstar_p.productOzPerFinishedGallonAtStandardRate = 2;
      const standardAtTwo = trench({ labelBottle: 'lesco_crosscheck_plus' });
      expect(standardAtTwo).toMatchObject({ finishedGallons: 40, productOz: 80, labelConfirmed: true, requiresManualReview: true });
      expect(standardAtTwo.manualReviewReasons).toContain('reduced_volume_confirmation_required');
    } finally {
      products.talstar_p.productOzPerFinishedGallonAtHighRate = savedHigh;
      products.talstar_p.productOzPerFinishedGallonAtStandardRate = savedStandard;
    }
    // The half volume is a fact of a label that was read. The code field outlives a config rename, so a product renamed to another
    // bottle keeps the full volume; the earlier Talak 7.9 F label carries the same chart (pre-push audit 22).
    const savedLabel = products.talstar_p.label;
    try {
      for (const other of ['Crosscheck G - Bifenthrin', 'Bifen I/T']) {
        products.talstar_p.label = other;
        const renamed = trench({ applicationRate: 'high' });
        expect(renamed).toMatchObject({ finishedGallons: 80, productOz: 160 });
        expect(renamed.warnings.join(' ')).not.toMatch(/reduced finished volume/);
      }
      for (const read of ['Talak 7.9 F - Bifenthrin', 'LESCO Cross Check Plus']) {
        products.talstar_p.label = read;
        expect(trench({ applicationRate: 'high' })).toMatchObject({ finishedGallons: 40, productOz: 80 });
      }
    } finally {
      products.talstar_p.label = savedLabel;
    }
    const taurus = priceTrenching({}, { measurements, productKey: 'taurus_sc', applicationRate: 'high', labelConfirmed: true });
    expect(taurus).toMatchObject({ finishedGallons: 80, productOz: 128 });
    expect(taurus.warnings).toContain('High/problem-soil rate increases chemical usage and requires label confirmation.');
    // A custom dilution is a manual override (sent to review). The chart's own dilution typed in prices what the high rate does
    // (pre-push audit 12), at either rate; a stronger one is off the chart and keeps the full volume, with no label-adjustment
    // warning (pre-push audit 20).
    // The label names the dilution the volume was priced at: the high rate's, at either rate (pre-push audit 28).
    expect(trench({ applicationRate: 'high', customProductOzPerFinishedGallon: 2 }))
      .toMatchObject({ finishedGallons: 40, productOz: 80, requiresManualReview: true, concentrationLabel: 'high_rate' });
    expect(trench({ customProductOzPerFinishedGallon: 2 }))
      .toMatchObject({ finishedGallons: 40, productOz: 80, requiresManualReview: true, concentrationLabel: 'high_rate' });
    const offChart = trench({ customProductOzPerFinishedGallon: 4 });
    expect(offChart).toMatchObject({ finishedGallons: 80, productOz: 320, requiresManualReview: true });
    expect(offChart.warnings.join(' ')).not.toMatch(/reduced finished volume/);
    // A weaker one keeps the labeled volume: the rule never adds finished gallons.
    expect(trench({ customProductOzPerFinishedGallon: 0.5 }))
      .toMatchObject({ finishedGallons: 80, productOz: 40, requiresManualReview: true });
  });

  // The chart halves the label's own volume, 4.0 gal per 10 LF per foot of depth (production's setting, read 2026-11-20). A configured
  // volume off the chart keeps it at the high rate: half of it is not the label's reduced volume, and would price too little product
  // (pre-push audit at the fourth push).
  // The label's amount is 4 fl oz of concentrate per 10 LF per foot of depth (its 0.06% at the full volume, its 0.12% at half). Any
  // dilution and volume that put down another amount go to review whatever the label check, at either rate (pre-push audits at the
  // eighth and tenth pushes: the standard 1 fl oz a gallon at 3 gal puts down 3 fl oz).
  test('a configured trench volume off the label chart keeps that volume, and any amount off the label goes to review', () => {
    const trenching = require('../services/pricing-engine/constants').SPECIALTY.trenching;
    const saved = trenching.finishedGallonsPer10LFPerFtDepth;
    const savedStandard = trenching.products.talstar_p.productOzPerFinishedGallonAtStandardRate;
    const measurements = { perimeterLF: 400, dirtLF: 400, concreteLF: 0 };
    const trench = (extra = { applicationRate: 'high' }) => priceTrenching({}, {
      measurements, productKey: 'talstar_p', labelConfirmed: true, labelBottle: 'lesco_crosscheck_plus', ...extra,
    });
    try {
      trenching.finishedGallonsPer10LFPerFtDepth = 3; // 400 LF x 0.3 x 0.5 ft = 60 labeled gallons
      const offChart = trench();
      expect(offChart).toMatchObject({ finishedGallons: 60, productOz: 120, labelConfirmed: true, requiresManualReview: true });
      expect(offChart.warnings.join(' ')).not.toMatch(/reduced finished volume/);
      expect(offChart.warnings.join(' ')).toMatch(/put down 6 fl oz of concentrate per 10 linear feet per foot of depth, not the label's 4 fl oz/);
      expect(offChart.manualReviewReasons).not.toContain('reduced_volume_confirmation_required');
      expect(offChart.manualReviewReasons).toContain('off_label_amount_confirmation_required');
      // The label's 0.06% (1 fl oz a gallon) at 3 gal puts down 3 fl oz: in review too, with its checked label box.
      const standardOffChart = trench({});
      expect(standardOffChart).toMatchObject({ finishedGallons: 60, productOz: 60, labelConfirmed: true, requiresManualReview: true });
      expect(standardOffChart.manualReviewReasons).toContain('off_label_amount_confirmation_required');
      expect(standardOffChart.warnings.join(' ')).toMatch(/put down 3 fl oz of concentrate .* not the label's 4 fl oz/);
      expect(standardOffChart.concentrationLabel).toBe('0.06%');
      trenching.products.talstar_p.productOzPerFinishedGallonAtStandardRate = 2; // the eighth push's case: the standard rate at 0.12%
      const standardAtTwo = trench({});
      expect(standardAtTwo).toMatchObject({ finishedGallons: 60, productOz: 120, labelConfirmed: true, requiresManualReview: true });
      expect(standardAtTwo.manualReviewReasons).toContain('off_label_amount_confirmation_required');
      // The line names the dilution it priced, the high rate's, not the standard 0.06% (pre-push audit at the ninth push).
      expect(standardAtTwo.concentrationLabel).toBe('high_rate');
      expect(offChart.concentrationLabel).toBe('high_rate');
      trenching.finishedGallonsPer10LFPerFtDepth = 4; // the chart's volume: a standard rate moved off 1 fl oz is off the label too
      trenching.products.talstar_p.productOzPerFinishedGallonAtStandardRate = 0.8;
      expect(trench({}).manualReviewReasons).toContain('off_label_amount_confirmation_required');
      trenching.products.talstar_p.productOzPerFinishedGallonAtStandardRate = savedStandard;
      const onChart = trench(); // 80 labeled gallons, halved: 4 fl oz per 10 LF per foot of depth
      expect(onChart).toMatchObject({ finishedGallons: 40, productOz: 80 });
      expect(onChart.manualReviewReasons).toContain('reduced_volume_confirmation_required');
      expect(onChart.manualReviewReasons).not.toContain('off_label_amount_confirmation_required');
      const standard = trench({}); // production's setting: the label's amount, so no amount review
      expect(standard).toMatchObject({ finishedGallons: 80, productOz: 80, labelConfirmed: true });
      expect(standard.manualReviewReasons).not.toContain('off_label_amount_confirmation_required');
      expect(standard.warnings.join(' ')).not.toMatch(/fl oz of concentrate/);
    } finally {
      trenching.finishedGallonsPer10LFPerFtDepth = saved;
      trenching.products.talstar_p.productOzPerFinishedGallonAtStandardRate = savedStandard;
    }
  });

  test('trenching high rate and warranty restrictions surface review and quote gates', () => {
    const highRate = priceTrenching({}, {
      measurements: { perimeterLF: 100, dirtLF: 100, concreteLF: 0 },
      productKey: 'taurus_sc',
      applicationRate: 'high',
      labelConfirmed: false,
    });
    expect(highRate.productOzPerFinishedGallon).toBe(1.6);
    expect(highRate.requiresManualReview).toBe(true);
    expect(highRate.manualReviewReasons).toEqual(expect.arrayContaining([
      'high_rate_termite_trenching_selected',
      'label_confirmation_required',
    ]));

    const explicitMissingLabelConfirmation = priceTrenching({}, {
      measurements: { perimeterLF: 100, dirtLF: 100, concreteLF: 0 },
      productKey: 'taurus_sc',
    });
    expect(explicitMissingLabelConfirmation.requiresManualReview).toBe(true);
    expect(explicitMissingLabelConfirmation.manualReviewReasons).toContain('label_confirmation_required');

    const legacyPayload = priceTrenching({ perimeter: 100 });
    expect(legacyPayload.manualReviewReasons || []).not.toContain('label_confirmation_required');
    // A bifenthrin bottle always needs its label confirmed, a legacy payload's configured default included (pre-push audit 13).
    const trenchCfg = require('../services/pricing-engine/constants').SPECIALTY.trenching;
    const savedDefault = trenchCfg.defaultProductKey;
    trenchCfg.defaultProductKey = 'bifen_it';
    try {
      const legacyBifenthrin = priceTrenching({ perimeterLF: 200 }, {});
      expect(legacyBifenthrin).toMatchObject({ productKey: 'bifen_it', labelConfirmed: false, requiresManualReview: true });
      expect(legacyBifenthrin.manualReviewReasons).toContain('label_confirmation_required');
    } finally {
      trenchCfg.defaultProductKey = savedDefault;
    }

    const depthOverride = priceTrenching({ perimeter: 100 }, {
      trenchDepthFt: 1.5,
      labelConfirmed: true,
    });
    expect(depthOverride.requiresManualReview).toBe(true);
    expect(depthOverride.manualReviewReasons).toContain('trench_depth_manual_override_used');

    const taurusFiveYear = priceTrenching({}, {
      measurements: { perimeterLF: 100, dirtLF: 100, concreteLF: 0 },
      productKey: 'taurus_sc',
      warrantyTier: 'five_year_repair_retreat',
      labelConfirmed: true,
    });
    expect(taurusFiveYear.quoteRequired).toBe(false);
    expect(taurusFiveYear.warrantyAdder).toBe(Math.round(taurusFiveYear.priceBeforeWarranty * 0.25));

    const bifenThreeYear = priceTrenching({}, {
      measurements: { perimeterLF: 100, dirtLF: 100, concreteLF: 0 },
      productKey: 'bifen_it',
      warrantyTier: 'three_year_repair_retreat',
      labelConfirmed: true,
    });
    expect(bifenThreeYear.requiresManualReview).toBe(true);
    expect(bifenThreeYear.quoteRequired).toBe(false);
    expect(bifenThreeYear.manualReviewReasons).toContain('long_warranty_on_repellent_termiticide_requires_review');

    const talstarFiveYear = priceTrenching({}, {
      measurements: { perimeterLF: 100, dirtLF: 100, concreteLF: 0 },
      productKey: 'talstar_p',
      warrantyTier: 'five_year_repair_retreat',
      labelConfirmed: true,
    });
    expect(talstarFiveYear.quoteRequired).toBe(true);
    expect(talstarFiveYear.price).toBeNull();
    expect(talstarFiveYear.manualReviewReasons).toContain('five_year_warranty_not_allowed_for_repellent_default');
  });

  test('trenching does not produce false floor quote from missing or invalid LF data', () => {
    const missing = priceTrenching({}, {});
    expect(missing.quoteRequired).toBe(true);
    expect(missing.requiresMeasurement).toBe(true);
    expect(missing.price).toBeNull();
    expect(missing.manualReviewReasons).toContain('missing_termite_perimeter_lf');

    const invalid = priceTrenching({}, {
      measurements: { perimeterLF: 240, concreteLF: 300 },
    });
    expect(invalid.quoteRequired).toBe(true);
    expect(invalid.requiresManualReview).toBe(true);
    expect(invalid.manualReviewReasons).toContain('concrete_lf_exceeds_perimeter');

    const invalidDirt = priceTrenching({}, {
      measurements: { perimeterLF: 240, dirtLF: 300 },
    });
    expect(invalidDirt.quoteRequired).toBe(true);
    expect(invalidDirt.requiresMeasurement).toBe(true);
    expect(invalidDirt.price).toBeNull();
    expect(invalidDirt.manualReviewReasons).toContain('invalid_trenching_dirt_lf');
  });

  test('BoraCare keeps valid examples, accepts manual override, and guards missing attic sqft', () => {
    const small = priceBoraCare(2000);
    expect(small.gallons).toBe(8);
    expect(small.laborHrs).toBe(3.5);
    expect(small.price).toBe(1946);

    const large = priceBoraCare(6000);
    expect(large.gallons).toBe(22);
    expect(large.laborHrs).toBe(9);
    expect(large.price).toBe(5236);

    const override = priceBoraCare(
      { atticSqFt: 1500 },
      { measurements: { atticSqFt: 2000 } }
    );
    expect(override.atticSqFt).toBe(2000);
    expect(override.atticSqFtSource).toBe('manual_override');

    const missing = priceBoraCare({}, {});
    expect(missing.quoteRequired).toBe(true);
    expect(missing.price).toBeNull();
    expect(missing.manualReviewReasons).toContain('missing_boracare_attic_sqft');
  });

  test('BoraCare folds surface treatment (linear ft × height) into the treated area', () => {
    // Surface-only job: 100 LF × default 8 ft = 800 sqft. No attic input required.
    const surfaceOnly = priceBoraCare({}, { surfaceLinearFt: 100 });
    expect(surfaceOnly.quoteRequired).toBe(false);
    expect(surfaceOnly.atticSqFt).toBeNull();
    expect(surfaceOnly.surfaceLinearFt).toBe(100);
    expect(surfaceOnly.surfaceHeightFt).toBe(8);
    expect(surfaceOnly.surfaceSqFt).toBe(800);
    expect(surfaceOnly.totalSqFt).toBe(800);
    expect(surfaceOnly.manualReviewReasons).not.toContain('missing_boracare_attic_sqft');
    // Surface-only jobs price on actual gallons + actual labor (no attic 3-gal /
    // 2-hr floors): 800 sqft → 3 gal, 800/640 = 1.25 hr (display-rounded to 1.3;
    // price uses the exact value).
    expect(surfaceOnly.gallons).toBe(3);
    expect(surfaceOnly.laborHrs).toBe(1.3);
    expect(surfaceOnly.price).toBe(749);
    // The same area through the attic path keeps its 2-hr-floored labor curve,
    // so a surface-only job must NOT equal the attic-equivalent price.
    const equiv800 = priceBoraCare(800);
    expect(surfaceOnly.price).not.toBe(equiv800.price);

    // A small surface job no longer inherits the attic 3-gallon / 2-hour floors:
    // 20 LF × 8 ft = 160 sqft → 1 gal, 0.25 hr (640 sf/hr, display-rounded to
    // 0.3), ~$263 (was $808).
    const smallSurface = priceBoraCare({}, { surfaceLinearFt: 20, surfaceHeightFt: 8 });
    expect(smallSurface.totalSqFt).toBe(160);
    expect(smallSurface.gallons).toBe(1);
    expect(smallSurface.laborHrs).toBe(0.3);
    expect(smallSurface.price).toBe(263);

    // minJobPrice floors a truck-roll: a tiny job never prices below $150.
    const tinySurface = priceBoraCare({}, { surfaceLinearFt: 1, surfaceHeightFt: 1 });
    expect(tinySurface.price).toBeGreaterThanOrEqual(150);

    // Custom surface height overrides the 8 ft default.
    const tallSurface = priceBoraCare({}, { surfaceLinearFt: 100, surfaceHeightFt: 10 });
    expect(tallSurface.surfaceHeightFt).toBe(10);
    expect(tallSurface.totalSqFt).toBe(1000);

    // Attic + surface combine; price matches the summed area through the attic path.
    const combined = priceBoraCare({ atticSqFt: 1200 }, { surfaceLinearFt: 100, surfaceHeightFt: 8 });
    expect(combined.atticSqFt).toBe(1200);
    expect(combined.surfaceSqFt).toBe(800);
    expect(combined.totalSqFt).toBe(2000);
    expect(combined.price).toBe(priceBoraCare(2000).price);

    // Legacy wall* aliases are still accepted on input.
    const legacyAlias = priceBoraCare({}, { wallLinearFt: 100, wallHeightFt: 8 });
    expect(legacyAlias.surfaceLinearFt).toBe(100);
    expect(legacyAlias.surfaceSqFt).toBe(800);
    expect(legacyAlias.price).toBe(surfaceOnly.price);

    // Invalid surface linear ft flags review but still prices the attic portion.
    const badSurface = priceBoraCare({ atticSqFt: 2000 }, { surfaceLinearFt: -5 });
    expect(badSurface.totalSqFt).toBe(2000);
    expect(badSurface.requiresManualReview).toBe(true);
    expect(badSurface.manualReviewReasons).toContain('invalid_boracare_surface_linear_ft');

    // Invalid surface height defaults to 8 ft but still flags review.
    const badHeight = priceBoraCare({}, { surfaceLinearFt: 100, surfaceHeightFt: 0 });
    expect(badHeight.surfaceHeightFt).toBe(8);
    expect(badHeight.totalSqFt).toBe(800);
    expect(badHeight.requiresManualReview).toBe(true);
    expect(badHeight.manualReviewReasons).toContain('invalid_boracare_surface_height_defaulted');

    // A rejected attic value with valid surface input must stay visible for
    // review — not be silently treated as merely absent.
    const badAtticWithSurface = priceBoraCare({ atticSqFt: -10 }, { surfaceLinearFt: 100 });
    expect(badAtticWithSurface.totalSqFt).toBe(800);
    expect(badAtticWithSurface.requiresManualReview).toBe(true);
    expect(badAtticWithSurface.manualReviewReasons).toContain('invalid_boracare_attic_sqft');

    // A truly missing attic with valid surface input prices cleanly (no noise).
    const surfaceNoAttic = priceBoraCare({}, { surfaceLinearFt: 100 });
    expect(surfaceNoAttic.requiresManualReview).toBe(false);
    expect(surfaceNoAttic.manualReviewReasons).toHaveLength(0);

    // Route flow: attic + surface both arrive via options (manual override). An
    // invalid attic option with valid surface input must still flag review.
    const invalidAtticOption = priceBoraCare({}, { atticSqFt: -10, surfaceLinearFt: 100 });
    expect(invalidAtticOption.totalSqFt).toBe(800);
    expect(invalidAtticOption.requiresManualReview).toBe(true);
    expect(invalidAtticOption.manualReviewReasons).toContain('invalid_boracare_attic_sqft');
  });

  test('Pre-Slab Termiticide normalizes products and aliases', () => {
    expect(normalizePreSlabTermiticideProduct('termidor_sc').productKey).toBe('termidor_sc');
    expect(normalizePreSlabTermiticideProduct('termidor sc').productKey).toBe('termidor_sc');
    expect(normalizePreSlabTermiticideProduct('taurus').productKey).toBe('taurus_sc');
    expect(normalizePreSlabTermiticideProduct('bifen i/t').productKey).toBe('bifen_it');
    expect(normalizePreSlabTermiticideProduct('talstar professional').productKey).toBe('talstar_p');
    expect(normalizePreSlabTermiticideProduct('Atticus Talak').productKey).toBe('talstar_p');
    expect(normalizePreSlabTermiticideProduct('fipronil', { legacyPayload: true }).productKey).toBe('termidor_sc');
    expect(normalizePreSlabTermiticideProduct('bifenthrin', { legacyPayload: true }).productKey).toBe('bifen_it');

    const unknownNew = normalizePreSlabTermiticideProduct('unknown product');
    expect(unknownNew.productKey).toBe('termidor_sc');
    expect(unknownNew.requiresManualReview).toBe(true);
    expect(unknownNew.manualReviewReasons).toContain('invalid_pre_slab_termiticide_product');

    const unknownLegacy = normalizePreSlabTermiticideProduct('unknown product', { legacyPayload: true });
    expect(unknownLegacy.productKey).toBe('termidor_sc');
    expect(unknownLegacy.requiresManualReview).toBe(false);
    expect(unknownLegacy.warnings).toContain('unknown_legacy_pre_slab_product_defaulted_to_termidor_sc');
  });

  test('Pre-Slab Termiticide uses product-ounce pricing for 2,500 sqft', () => {
    const termidor = pricePreSlabTermiticide(2500, { productKey: 'termidor_sc', labelConfirmed: true });
    expect(termidor.productOz).toBe(200);
    expect(termidor.units).toBe(3);
    expect(termidor.productCost).toBe(448);
    expect(termidor.price).toBe(1087);

    const taurus = pricePreSlabTermiticide(2500, { productKey: 'taurus_sc', labelConfirmed: true });
    expect(taurus.productOz).toBe(200);
    expect(taurus.units).toBe(3);
    expect(taurus.productCost).toBe(243.59);
    expect(taurus.price).toBe(701);

    // bifen_it is the same bottle as talstar_p (owner 2026-10-25): LESCO Crosscheck Plus, 128 fl oz at $30.90 (2026-11-18).
    const bifen = pricePreSlabTermiticide(2500, { productKey: 'bifen_it', labelConfirmed: true });
    expect(bifen.productOz).toBe(250);
    expect(bifen.units).toBe(2);
    expect(bifen.productCost).toBe(60.35);
    expect(bifen.rawPrice).toBe(355);
    expect(bifen.price).toBe(510);

    // talstar_p is the LESCO Crosscheck Plus bottle: 128 fl oz at $30.90.
    const talak = pricePreSlabTermiticide(2500, { productKey: 'talstar_p', labelConfirmed: true });
    expect(talak.productLabel).toBe('Crosscheck Plus - Bifenthrin');
    expect(talak.productOz).toBe(250);
    expect(talak.units).toBe(2);
    expect(talak.productCost).toBe(60.35);
    expect(talak.rawPrice).toBe(355);
    expect(talak.price).toBe(510);
  });

  test('Pre-Slab Termiticide uses contextual small-slab minimums', () => {
    const standalone = pricePreSlabTermiticide(100, {
      productKey: 'bifen_it',
      jobContext: 'standalone',
      labelConfirmed: true,
    });
    expect(standalone.productOz).toBe(10);
    expect(standalone.productCost).toBe(2.41);
    expect(standalone.contextualFloor).toBe(191);
    expect(standalone.price).toBe(191);
    expect(standalone.price).not.toBe(600);

    const builderBatch = pricePreSlabTermiticide(100, {
      productKey: 'bifen_it',
      jobContext: 'builderBatch',
      labelConfirmed: true,
    });
    expect(builderBatch.contextualFloor).toBe(128);
    expect(builderBatch.price).toBe(146);
    expect(builderBatch.price).not.toBe(600);

    const sameTripAddOn = pricePreSlabTermiticide(100, {
      productKey: 'bifen_it',
      jobContext: 'sameTripAddOn',
      labelConfirmed: true,
    });
    expect(sameTripAddOn.contextualFloor).toBe(106);
    expect(sameTripAddOn.price).toBe(146);
    expect(sameTripAddOn.price).not.toBe(600);
  });

  test('Pre-Slab Termiticide steps price with usage every 100 sqft (hybrid: contextual floors kept)', () => {
    // 82 sqft prices as a full 100-sqft bucket. Termidor's stepped cost-plus
    // ($198) clears the $191 floor; the cheap bifenthrins stay floored.
    const termidorSmall = pricePreSlabTermiticide(82, { productKey: 'termidor_sc', labelConfirmed: true });
    expect(termidorSmall.usageStepSqFt).toBe(100);
    expect(termidorSmall.usageStepPricedSqFt).toBe(100);
    expect(termidorSmall.price).toBe(198);
    // Reported quantities stay actual-usage, not the bucket.
    expect(termidorSmall.productOz).toBe(6.56);

    const talstarSmall = pricePreSlabTermiticide(82, { productKey: 'talstar_p', labelConfirmed: true });
    expect(talstarSmall.usageStepPricedSqFt).toBe(100);
    expect(talstarSmall.price).toBe(191);

    // The two real estimates that triggered the change (85 and 175 sqft,
    // Talstar, both $191) stay at $191 — the hybrid never prices below the
    // old schedule.
    expect(pricePreSlabTermiticide(85, { productKey: 'talstar_p', labelConfirmed: true }).price).toBe(191);
    expect(pricePreSlabTermiticide(175, { productKey: 'talstar_p', labelConfirmed: true }).price).toBe(191);

    // 191 sqft now steps: Termidor prices the 200-sqft bucket, and Taurus
    // separates from the bifenthrins instead of all collapsing to the floor.
    expect(pricePreSlabTermiticide(191, { productKey: 'termidor_sc', labelConfirmed: true }).price).toBe(231);
    expect(pricePreSlabTermiticide(191, { productKey: 'taurus_sc', labelConfirmed: true }).price).toBe(201);
    expect(pricePreSlabTermiticide(191, { productKey: 'talstar_p', labelConfirmed: true }).price).toBe(191);

    // Contextual floor still wins where the stepped cost-plus is below it.
    const talstarMid = pricePreSlabTermiticide(750, { productKey: 'talstar_p', labelConfirmed: true });
    expect(talstarMid.usageStepPricedSqFt).toBe(800);
    expect(talstarMid.price).toBe(276);

    // An exact bucket edge is not rounded up.
    const exact = pricePreSlabTermiticide(200, { productKey: 'termidor_sc', labelConfirmed: true });
    expect(exact.usageStepPricedSqFt).toBe(200);
    expect(exact.usageStepPrice).toBe(exact.rawPrice);

    // No table cap: steps keep working at 10,000 sqft (labor capped at 5 hrs).
    const huge = pricePreSlabTermiticide(9950, { productKey: 'talstar_p', labelConfirmed: true });
    expect(huge.usageStepPricedSqFt).toBe(10000);
    expect(huge.laborHrs).toBe(5);
    expect(huge.price).toBe(884);

    // Volume discounts apply to the stepped price (10plus implies the
    // builder-batch context: no drive cost, $128 floor at this size).
    const volume = pricePreSlabTermiticide(191, {
      productKey: 'termidor_sc',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(volume.priceBeforeVolumeDiscount).toBe(209);
    expect(volume.price).toBe(178);

    // Kill switch: usageStepSqFt = 0 restores the flat pre-step behavior.
    const cfg = require('../services/pricing-engine/constants').SPECIALTY.preSlabTermiticide;
    const savedStep = cfg.usageStepSqFt;
    try {
      cfg.usageStepSqFt = 0;
      const flat = pricePreSlabTermiticide(82, { productKey: 'termidor_sc', labelConfirmed: true });
      expect(flat.usageStepSqFt).toBe(0);
      expect(flat.usageStepPricedSqFt).toBeNull();
      expect(flat.price).toBe(191);
    } finally {
      cfg.usageStepSqFt = savedStep;
    }
  });

  test('Pre-Slab Termiticide applies volume floors, warranty metadata, and measurement guards', () => {
    const termidorTenPlus = pricePreSlabTermiticide(1800, {
      productKey: 'termidor_sc',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(termidorTenPlus.units).toBe(2);
    expect(termidorTenPlus.price).toBe(677);
    expect(termidorTenPlus.volumeDiscountMultiplier).toBe(0.85);

    const taurusTenPlus = pricePreSlabTermiticide(1800, {
      productKey: 'taurus_sc',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(taurusTenPlus.price).toBe(441);

    const bifenTenPlus = pricePreSlabTermiticide(1800, {
      productKey: 'bifen_it',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(bifenTenPlus.contextualFloor).toBe(425);
    expect(bifenTenPlus.priceBeforeVolumeDiscount).toBe(425);
    expect(bifenTenPlus.price).toBe(425);

    const talstarTenPlus = pricePreSlabTermiticide(1800, {
      productKey: 'talstar_p',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(talstarTenPlus.priceBeforeVolumeDiscount).toBe(425);
    expect(talstarTenPlus.price).toBe(425);

    const override = pricePreSlabTermiticide({}, {
      productKey: 'termidor_sc',
      measurements: { slabSqFt: 2500 },
      includeWarrantyExtended: true,
      labelConfirmed: true,
    });
    expect(override.slabSqFt).toBe(2500);
    expect(override.slabSqFtSource).toBe('manual_override');
    expect(override.price).toBe(1257);
    expect(override.warrantyExtendedSelected).toBe(true);
    expect(override.warrantyExtendedPrice).toBe(170);
    expect(override.addOns[0].code).toBe('pre_slab_extended_warranty');
    expect(override.certificateOfComplianceRequired).toBe(true);

    const noWarranty = pricePreSlabTermiticide(1800, {
      productKey: 'termidor_sc',
      warranty: 'NONE',
      labelConfirmed: true,
    });
    expect(noWarranty.warrantyTier).toBe('none');
    expect(noWarranty.warrantyLabel).toBe('No warranty');
    expect(noWarranty.warrantyExtendedSelected).toBe(false);
    expect(noWarranty.warrantyAdder).toBe(0);
    expect(noWarranty.price).toBe(noWarranty.treatmentPrice);
    expect(noWarranty.addOns).toEqual([]);

    const missing = pricePreSlabTermiticide({}, {});
    expect(missing.quoteRequired).toBe(true);
    expect(missing.price).toBeNull();
    expect(missing.manualReviewReasons).toContain('missing_pre_slab_sqft');

    const unconfirmed = pricePreSlabTermiticide(2500, { productKey: 'termidor_sc', labelConfirmed: false });
    expect(unconfirmed.requiresManualReview).toBe(true);
    expect(unconfirmed.manualReviewReasons).toContain('pre_slab_label_confirmation_required');

    const legacy = pricePreSlabTermidor(2500, 'none');
    expect(legacy.productKey).toBe('termidor_sc');
    expect(legacy.legacyService).toBe('pre_slab_termidor');
    expect(legacy.price).toBe(1087);
  });

  test('estimate engine and v1 adapter carry termite measurement metadata', () => {
    const v1Input = translateV2CallToV1Input(
      { homeSqFt: 4000, stories: 2, lotSqFt: 8000 },
      ['TERMITE_BAIT', 'TRENCHING', 'BORACARE', 'PRESLAB'],
      {
        termiteFootprintSqFt: 2000,
        termitePerimeterLF: 300,
        trenchingPerimeterLF: 240,
        trenchingConcretePct: 40,
        trenchingProductKey: 'termidor_sc',
        trenchingApplicationRate: 'high',
        trenchingDepthFt: 1.5,
        trenchingWarrantyTier: 'five_year_repair_retreat',
        trenchingLabelConfirmed: true,
        boracareSqft: 2000,
        preslabSqft: 2500,
        preslabProductKey: 'taurus_sc',
        preslabWarranty: 'EXTENDED',
        preslabLabelConfirmed: true,
      }
    );
    const estimate = generateEstimate(v1Input);
    const trench = estimate.lineItems.find((item) => item.service === 'trenching');
    const preslab = estimate.lineItems.find((item) => item.service === 'pre_slab_termiticide');

    expect(trench.measurements.perimeterLF.source).toBe('manual_override');
    expect(trench.concretePct).toBe(0.4);
    expect(trench.productKey).toBe('termidor_sc');
    expect(trench.applicationRate).toBe('high');
    expect(trench.trenchDepthFt).toBe(1.5);
    expect(preslab.warrantyExtendedSelected).toBe(true);
    expect(preslab.productKey).toBe('taurus_sc');
    expect(preslab.addOns[0].price).toBe(170);

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.results.tmBait.measurements.perimeterLF.source).toBe('manual_override');
    const mappedTrench = mapped.oneTime.items.find((item) => item.service === 'trenching');
    expect(mappedTrench.measurements.concretePct.value).toBe(0.4);
    expect(mappedTrench.productKey).toBe('termidor_sc');
    expect(mappedTrench.applicationRate).toBe('high');
    expect(mappedTrench.trenchDepthFt).toBe(1.5);
    expect(mappedTrench.productSurcharge).toBeGreaterThan(0);
    expect(mappedTrench.warrantyTier).toBe('five_year_repair_retreat');
    expect(mappedTrench.warrantyAdder).toBeGreaterThan(0);
    expect(mappedTrench.labelConfirmed).toBe(true);
    expect(mappedTrench.certificateOfTreatmentRequired).toBe(true);
    expect(mappedTrench.detail).toContain('Termidor');
    const mappedPreSlab = mapped.oneTime.specItems.find((item) => item.service === 'pre_slab_termiticide');
    expect(mappedPreSlab.productKey).toBe('taurus_sc');
    expect(mappedPreSlab.labelConfirmed).toBe(true);
    expect(mappedPreSlab.certificateOfComplianceRequired).toBe(true);
    expect(mappedPreSlab.warrantyTier).toBe('extended');
    expect(mappedPreSlab.warrantyAdder).toBe(170);
    expect(mappedPreSlab.detail).toContain('Taurus');
    expect(mappedPreSlab.addOns[0].price).toBe(170);

    const noWarrantyInput = translateV2CallToV1Input(
      { homeSqFt: 2400, stories: 1, lotSqFt: 9000 },
      ['PRESLAB'],
      {
        preslabSqft: 1800,
        preslabProductKey: 'termidor_sc',
        preslabWarranty: 'NONE',
        preslabLabelConfirmed: true,
      }
    );
    const noWarrantyMapped = mapV1ToLegacyShape(generateEstimate(noWarrantyInput));
    const mappedNoWarrantyPreSlab = noWarrantyMapped.oneTime.specItems.find((item) => item.service === 'pre_slab_termiticide');
    expect(mappedNoWarrantyPreSlab.warrantyTier).toBe('none');
    expect(mappedNoWarrantyPreSlab.warrantyAdder).toBe(0);
    expect(mappedNoWarrantyPreSlab.detail).toContain('No warranty');
  });

  test('estimate engine does not silently use computed perimeter for trenching', () => {
    const estimate = generateEstimate({
      homeSqFt: 2400,
      stories: 1,
      lotSqFt: 9000,
      propertyType: 'single_family',
      services: { trenching: true },
    });

    const trench = estimate.lineItems.find((item) => item.service === 'trenching');
    expect(trench.quoteRequired).toBe(true);
    expect(trench.price).toBeNull();
    expect(trench.manualReviewReasons).toContain('missing_termite_perimeter_lf');
    expect(estimate.summary.year2Annual).toBe(0);

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.oneTime.items.find((item) => item.service === 'trenching')).toBeUndefined();
    const mappedTrench = mapped.oneTime.specItems.find((item) => item.service === 'trenching');
    expect(mappedTrench.quoteRequired).toBe(true);
    expect(mappedTrench.price).toBeNull();
    expect(mappedTrench.requiresMeasurement).toBe(true);
    expect(mapped.results.trench).toBeUndefined();
  });

  test('v2 adapter does not promote computed perimeter to measured trenching LF', () => {
    const v1Input = translateV2CallToV1Input(
      {
        homeSqFt: 2400,
        stories: 1,
        lotSqFt: 9000,
        footprint: 2400,
        perimeter: 248,
        perimeterSource: 'computed_from_footprint',
      },
      ['TRENCHING'],
      {}
    );

    expect(v1Input.perimeterLF).toBeUndefined();
    expect(v1Input.perimeterSource).toBe('computed_from_footprint');

    const estimate = generateEstimate(v1Input);
    const trench = estimate.lineItems.find((item) => item.service === 'trenching');
    expect(trench.quoteRequired).toBe(true);
    expect(trench.price).toBeNull();

    const allowComputed = translateV2CallToV1Input(
      {
        homeSqFt: 2400,
        stories: 1,
        lotSqFt: 9000,
        footprint: 2400,
        perimeter: 248,
        perimeterSource: 'computed_from_footprint',
      },
      ['TRENCHING'],
      { trenchingEstimateFromFootprint: true }
    );
    const allowedEstimate = generateEstimate(allowComputed);
    const pricedTrench = allowedEstimate.lineItems.find((item) => item.service === 'trenching');
    expect(pricedTrench.quoteRequired).not.toBe(true);
    expect(pricedTrench.perimeter).toBeGreaterThan(0);
  });

  test('v2 adapter defaults trenching depth to the 0.5 ft baseline (no +15% on depth-less estimates)', () => {
    const v1Input = translateV2CallToV1Input(
      { homeSqFt: 2400, stories: 1, lotSqFt: 9000 },
      ['TRENCHING'],
      {
        trenchingPerimeterLF: 240,
        trenchingConcreteLF: 96,
        trenchingLabelConfirmed: true,
        // no trenchingDepthFt — must fall back to the 0.5 ft canonical baseline,
        // not the retired 1.0 ft (+15%) tier with doubled chemical volume.
      }
    );
    expect(v1Input.services.trenching.trenchDepthFt).toBe(0.5);

    const estimate = generateEstimate(v1Input);
    const trench = estimate.lineItems.find((item) => item.service === 'trenching');
    expect(trench.trenchDepthFt).toBe(0.5);
    expect(trench.trenchDepthPriceMultiplier).toBe(1);
    // 144 LF dirt + 96 LF concrete at the baseline → the unchanged LF install model.
    expect(trench.baseInstallPrice).toBe(2784);
    expect(trench.price).toBe(2784);
  });

  test('missing termite bait measurement is not listed as priced recurring service', () => {
    const estimate = generateEstimate({
      lotSqFt: 9000,
      propertyType: 'single_family',
      services: { termiteBait: true },
    });

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.results.tmBait).toEqual(expect.objectContaining({
      quoteRequired: true,
      requiresMeasurement: true,
    }));
    expect(mapped.recurring.services.find((service) => service.service === 'termite_bait')).toBeUndefined();
    expect(mapped.quoteRequiredItems.find((item) => item.service === 'termite_bait')).toEqual(expect.objectContaining({
      quoteRequired: true,
    }));
  });
});

describe('termite bait per-application cadence (owner 2026-07-20)', () => {
  test('pricer emits visitsPerYear + perApp, exact against the annual', () => {
    const basic = priceTermiteBait(
      { footprint: 2000, features: { complexity: 'standard' } },
      { system: 'advance', monitoringTier: 'basic' }
    );
    expect(basic.visitsPerYear).toBe(4);
    // 34 x 12 / 4 — agrees to the cent with intervalPriceFromAnnual(408).
    expect(basic.perApp).toBe(102);

    const premier = priceTermiteBait(
      { footprint: 2000, features: { complexity: 'standard' } },
      { system: 'advance', monitoringTier: 'premier' }
    );
    expect(premier.visitsPerYear).toBe(4);
    // Premier is retired: the tier input no longer changes price.
    expect(premier.perApp).toBe(102);
  });

  test('mapper forwards perApp/visitsPerYear onto the persisted recurring row', () => {
    const input = translateV2CallToV1Input(
      { homeSqFt: 2000, stories: 1, lotSqFt: 8000 },
      ['TERMITE_BAIT'],
      { termiteBaitSystem: 'advance' }
    );
    const mapped = mapV1ToLegacyShape(generateEstimate(input));
    const row = mapped.recurring.services.find((svc) => svc.service === 'termite_bait');
    expect(row).toBeTruthy();
    expect(row.perTreatment).toBe(102);
    expect(row.visitsPerYear).toBe(4);
    expect(row.mo).toBe(34);
  });
});

// Owner 2026-11-18: talstar_p and bifen_it name LESCO Crosscheck Plus under the same keys, so a bifenthrin label check saved before
// the swap (an engineRequest or engine input without the bottle mark) was made for the earlier bottle. The server replay of such a
// request, with no builder involved, must bring its label review back. The engine enforces it, so every caller follows.
describe('saved bifenthrin label checks follow the bottle on server replay', () => {
  const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
  const saved = (options) => ({
    engineRequest: {
      profile: { homeSqFt: 2400, stories: 1, lotSqFt: 9000 },
      selectedServices: ['TRENCHING', 'PRESLAB'],
      options: { trenchingPerimeterLF: 240, trenchingLabelConfirmed: true, preslabSqft: 2500, preslabLabelConfirmed: true, ...options },
    },
  });
  const replayLines = async (estData) => {
    const replay = await serverRecomputeFromEstimateData(estData, { replaySavedPricingKnobs: true, needsSync: () => false });
    expect(replay.recomputed).toBe(true);
    const items = replay.rawEngineResult.lineItems;
    return {
      trench: items.find((item) => item.service === 'trenching'),
      preslab: items.find((item) => item.service === 'pre_slab_termiticide'),
    };
  };

  test.each([
    ['talstar_p', 'talstar_p'], ['bifen_it', 'bifen_it'], ['crosscheck', 'talstar_p'], ['talak', 'talstar_p'],
  ])('a %s check saved without the mark reprices with its label review back on; with the mark it counts', async (key, resolved) => {
    const old = await replayLines(saved({ trenchingProductKey: key, preslabProductKey: key }));
    expect(old.trench).toMatchObject({ productKey: resolved, labelConfirmed: false });
    expect(old.trench.manualReviewReasons).toContain('label_confirmation_required');
    expect(old.preslab).toMatchObject({ productKey: resolved, labelConfirmed: false });
    expect(old.preslab.manualReviewReasons).toContain('pre_slab_label_confirmation_required');

    const marked = await replayLines(saved({ trenchingProductKey: key, preslabProductKey: key, bifenthrinLabelBottle: 'lesco_crosscheck_plus' }));
    expect(marked.trench.labelConfirmed).toBe(true);
    expect(marked.trench.manualReviewReasons).not.toContain('label_confirmation_required');
    expect(marked.preslab.labelConfirmed).toBe(true);
    expect(marked.preslab.manualReviewReasons).not.toContain('pre_slab_label_confirmation_required');
  });

  test('fipronil checks count without the mark; an unticked bifenthrin box stays unticked with it', async () => {
    const fipronil = await replayLines(saved({ trenchingProductKey: 'taurus_sc', preslabProductKey: 'termidor_sc' }));
    expect(fipronil.trench.labelConfirmed).toBe(true);
    expect(fipronil.preslab.labelConfirmed).toBe(true);
    const unticked = await replayLines(saved({
      trenchingProductKey: 'talstar_p', preslabProductKey: 'bifen_it', trenchingLabelConfirmed: false, preslabLabelConfirmed: false,
      bifenthrinLabelBottle: 'lesco_crosscheck_plus',
    }));
    expect(unticked.trench.labelConfirmed).toBe(false);
    expect(unticked.preslab.labelConfirmed).toBe(false);
  });

  test('another bottle mark does not count for Crosscheck Plus', async () => {
    const other = await replayLines(saved({ trenchingProductKey: 'talstar_p', preslabProductKey: 'talstar_p', bifenthrinLabelBottle: 'atticus_talak' }));
    expect(other.trench.labelConfirmed).toBe(false);
    expect(other.preslab.labelConfirmed).toBe(false);
  });

  // The public and lead paths store the engine input itself (engineInputs), which replays with no translator: the engine's own rule
  // brings the review back for a bifenthrin check stored without the mark, and keeps one stored since (the translator writes the
  // mark into the engine input it builds).
  test('a stored engineInputs bifenthrin check reprices with its review back on unless the engine input carries the mark', async () => {
    const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
    const { profile, selectedServices, options } = saved({
      trenchingProductKey: 'bifen_it', preslabProductKey: 'talak', bifenthrinLabelBottle: 'lesco_crosscheck_plus',
    }).engineRequest;
    const stored = JSON.parse(JSON.stringify(translateV2CallToV1Input(profile, selectedServices, options)));
    expect(stored.services.trenching.labelBottle).toBe('lesco_crosscheck_plus');
    expect(stored.services.preSlabTermiticide.labelBottle).toBe('lesco_crosscheck_plus');
    const kept = await replayLines({ engineInputs: stored });
    expect(kept.trench).toMatchObject({ productKey: 'bifen_it', labelConfirmed: true });
    expect(kept.preslab).toMatchObject({ productKey: 'talstar_p', labelConfirmed: true });

    const before = JSON.parse(JSON.stringify(stored));
    delete before.services.trenching.labelBottle;
    delete before.services.preSlabTermiticide.labelBottle;
    const old = await replayLines({ engineInputs: before });
    expect(old.trench).toMatchObject({ productKey: 'bifen_it', labelConfirmed: false });
    expect(old.trench.manualReviewReasons).toContain('label_confirmation_required');
    expect(old.preslab).toMatchObject({ productKey: 'talstar_p', labelConfirmed: false });
    expect(old.preslab.manualReviewReasons).toContain('pre_slab_label_confirmation_required');
  });

  // A legacy payload never asked for a label check, so the wrapper defaults to one. Nobody made that default for the Crosscheck Plus
  // bottle, so it counts for fipronil only.
  test('a legacy pre-slab default check counts for fipronil only; a bifenthrin legacy quote asks for the Crosscheck Plus check', () => {
    const sp = require('../services/pricing-engine/service-pricing');
    const legacy = (options) => sp.pricePreSlabTermidor({ slabSqFt: 2500 }, { productKey: 'talstar_p', ...options });
    expect(legacy({ productKey: 'termidor_sc' })).toMatchObject({ labelConfirmed: true, requiresManualReview: false });
    expect(legacy({})).toMatchObject({ labelConfirmed: false, requiresManualReview: true });
    expect(legacy({}).manualReviewReasons).toContain('pre_slab_label_confirmation_required');
    // The bottle mark alone is not a check (pre-push audit 8): the caller sent no confirmation.
    expect(legacy({ labelBottle: sp.BIFENTHRIN_LABEL_BOTTLE })).toMatchObject({ labelConfirmed: false, requiresManualReview: true });
    expect(legacy({ productKey: 'bifenthrin', labelBottle: sp.BIFENTHRIN_LABEL_BOTTLE }).labelConfirmed).toBe(false);
    expect(legacy({ labelConfirmed: true }).labelConfirmed).toBe(false);
    expect(legacy({ labelConfirmed: true, labelBottle: sp.BIFENTHRIN_LABEL_BOTTLE }).labelConfirmed).toBe(true);
  });

  // The migration leaves a product an admin edited away from the Talak values alone, so the configured product can still name Talak:
  // a check made for Crosscheck Plus never counts for it, pre-slab (its catalog link names the bottle) or trenching (its label does).
  test('a Crosscheck Plus label check never counts for a configured product that still names Talak', () => {
    const sp = require('../services/pricing-engine/service-pricing');
    const { SPECIALTY } = require('../services/pricing-engine/constants');
    const pre = SPECIALTY.preSlabTermiticide.products.talstar_p;
    const trench = SPECIALTY.trenching.products.bifen_it;
    const saved = [{ ...pre }, { ...trench }];
    const checked = { labelConfirmed: true, labelBottle: sp.BIFENTHRIN_LABEL_BOTTLE };
    const counts = () => [
      sp.pricePreSlabTermiticide({ slabSqFt: 2500 }, { productKey: 'talstar_p', ...checked }).labelConfirmed,
      sp.priceTrenching({ footprint: 2000 }, { perimeterLF: 200, productKey: 'bifen_it', ...checked }).labelConfirmed,
    ];
    try {
      expect(counts()).toEqual([true, true]);
      // A partial overlay: a configured Talak label over the code's Crosscheck Plus catalog link (pre-push audit 9).
      Object.assign(pre, { label: 'Talak 7.9 F - Bifenthrin' });
      expect(counts()).toEqual([false, true]);
      Object.assign(pre, { catalogProductName: 'Atticus Talak 7.9 F' });
      Object.assign(trench, { label: 'Talak 7.9 F - Bifenthrin' });
      expect(counts()).toEqual([false, false]);
      // A name counts only when it is this bottle's (pre-push audit 11): the inventory spelling does, another Crosscheck product does not.
      Object.assign(pre, saved[0], { catalogProductName: 'LESCO Cross Check Plus' });
      Object.assign(trench, saved[1], { label: 'LESCO Cross Check Plus' });
      expect(counts()).toEqual([true, true]);
      Object.assign(pre, { catalogProductName: 'LESCO Crosscheck G' });
      Object.assign(trench, { label: 'Crosscheck G - Bifenthrin' });
      expect(counts()).toEqual([false, false]);
    } finally {
      Object.assign(pre, saved[0]);
      Object.assign(trench, saved[1]);
    }
    expect(counts()).toEqual([true, true]);
  });

  // Public price ranges sweep every product with a label check made for its current bottle; a bifenthrin row priced without the
  // mark would leave the range (its review makes the pre-slab value NaN).
  test('the public price ranges count the label check on both bifenthrin products (the sweep carries the mark)', () => {
    const sp = require('../services/pricing-engine/service-pricing');
    const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
    const preslab = jest.spyOn(sp, 'pricePreSlabTermiticide');
    const trench = jest.spyOn(sp, 'priceTrenching');
    try {
      computePublicPricingRanges({ refresh: true });
      const bifenthrin = (spy) => spy.mock.results.map((r) => r.value).filter((r) => ['talstar_p', 'bifen_it'].includes(r.productKey));
      expect(bifenthrin(preslab).length).toBeGreaterThan(0);
      expect(bifenthrin(trench).length).toBeGreaterThan(0);
      for (const r of [...bifenthrin(preslab), ...bifenthrin(trench)]) expect(r.labelConfirmed).toBe(true);
      expect(bifenthrin(preslab).every((r) => !r.requiresManualReview)).toBe(true);
    } finally {
      preslab.mockRestore();
      trench.mockRestore();
    }
  });
});

// Owner 2026-11-18: the bifenthrin bottle moved from Talak ($41.57 / 96 oz) to LESCO Crosscheck Plus ($30.90 / 128 oz) under the
// same keys. A slab quote already sent keeps the container cost it priced with on every replay; a fresh quote prices the new bottle.
describe('a sent pre-slab quote keeps the container cost it priced with', () => {
  const replay = require('../services/estimate-tree-shrub-knob-replay');
  const PROFILE = { homeSqFt: 2400, stories: 1, lotSqFt: 9000, propertyType: 'single_family' };
  const input = (extra = {}) => ({ ...PROFILE, services: { preSlabTermiticide: { productKey: 'talstar_p', slabSqFt: 6832, ...extra } } });
  const TALAK = { productKey: 'talstar_p', containerCost: 41.57, containerOz: 96 };
  const slabLine = (estimate) => estimate.lineItems.find((line) => ['pre_slab_termiticide', 'pre_slab_termidor'].includes(line.service));
  // A quote priced before the swap: the engine line under the Talak cost basis, as the engine wrote it then.
  const oldQuote = () => generateEstimate({ ...input(), preSlabTermiticidePricingKnobs: TALAK });

  // A figure set on the service wins; the pin fills only the figure the service leaves unset.
  test('the pin reproduces the earlier price, for the product it names only; a cost on the service still wins', () => {
    expect(slabLine(generateEstimate(input()))).toMatchObject({ price: 743 });
    expect(slabLine(oldQuote())).toMatchObject({ price: 993, containerCost: 41.57, containerOz: 96 });
    expect(slabLine(generateEstimate({ ...input(), preSlabTermiticidePricingKnobs: { ...TALAK, productKey: 'termidor_sc' } })))
      .toMatchObject({ price: 743, containerCost: 30.9, containerOz: 128 });
    const custom = input({ customContainerCost: 30.9, customContainerOz: 128 });
    expect(slabLine(generateEstimate({ ...custom, preSlabTermiticidePricingKnobs: TALAK }))).toMatchObject({ price: 743 });
    const customSize = input({ customContainerOz: 128 });
    expect(slabLine(generateEstimate({ ...customSize, preSlabTermiticidePricingKnobs: TALAK }))).toMatchObject({ containerCost: 41.57, containerOz: 128 });
    const customCost = input({ customContainerCost: 30.9 });
    expect(slabLine(generateEstimate({ ...customCost, preSlabTermiticidePricingKnobs: TALAK }))).toMatchObject({ containerCost: 30.9, containerOz: 96 });
    const samePin = input({ customContainerCost: 41.57, customContainerOz: 96 });
    expect(slabLine(generateEstimate({ ...samePin, preSlabTermiticidePricingKnobs: TALAK }))).toMatchObject({ price: 993 });
  });

  test.each([['preSlabTermidor'], ['pre_slab_termidor']])('the legacy %s service keeps the earlier price too, on the engine and the public replay', (key) => {
    const { extractEngineInputs } = require('../routes/estimate-public');
    const legacy = { ...PROFILE, services: { [key]: { productKey: 'talstar_p', slabSqFt: 6832 } } };
    expect(slabLine(generateEstimate(legacy)).price).toBe(743);
    const sent = generateEstimate({ ...legacy, preSlabTermiticidePricingKnobs: TALAK });
    expect(slabLine(sent).price).toBe(993);
    expect(slabLine(generateEstimate(extractEngineInputs({ engineInputs: legacy, engineResult: sent }))).price).toBe(993);
  });

  test('a legacy ingredient name resolves as the legacy pricer resolves it, so its pin still applies', () => {
    const legacy = { ...PROFILE, services: { preSlabTermidor: { productKey: 'bifenthrin', slabSqFt: 6832 } } };
    const pin = { ...TALAK, productKey: 'bifen_it' };
    expect(slabLine(generateEstimate(legacy)).price).toBe(743);
    expect(slabLine(generateEstimate({ ...legacy, preSlabTermiticidePricingKnobs: pin })).price).toBe(993);
  });

  test('the signal reads the cost basis from the raw engine line and from the mapped one-time item', () => {
    const engineResult = oldQuote();
    expect(replay.preSlabTermiticideKnobSignalForReplay({ engineInputs: input(), engineResult })).toEqual(TALAK);
    expect(replay.preSlabTermiticideKnobSignalForReplay({ result: mapV1ToLegacyShape(engineResult) })).toEqual(TALAK);
    // A mapped item saved before it stored containerCost derives the cost, to the cent, from its container count and total.
    const saved = mapV1ToLegacyShape(engineResult);
    [...saved.oneTime.items, ...saved.oneTime.specItems].forEach((item) => delete item.containerCost);
    expect(replay.preSlabTermiticideKnobSignalForReplay({ result: saved })).toEqual(TALAK);
    expect(replay.preSlabTermiticideKnobSignalForReplay({ result: mapV1ToLegacyShape(generateEstimate({ ...PROFILE, services: {} })) })).toBeNull();
    expect(replay.preSlabTermiticideKnobSignalForReplay({ engineResult: { lineItems: [{ service: 'pre_slab_termiticide', productKey: 'talstar_p' }] } })).toBeNull();
    expect(replay.preSlabTermiticideKnobSignalForReplay({})).toBeNull();
    const legacyRow = { service: 'pre_slab_termidor', productKey: 'termidor_sc', containerCost: 174.72, containerOz: 78 };
    expect(replay.preSlabTermiticideKnobSignalForReplay({ engineResult: { lineItems: [legacyRow] } }))
      .toEqual({ productKey: 'termidor_sc', containerCost: 174.72, containerOz: 78 });
  });

  // Seven $30.905 containers store a $216.33 total, whose quotient is not the cost: the mapped item stores the cost itself, so the
  // replay of a quote priced with fractional cents keeps its price (pre-push audit at the eighth push).
  test('a container cost with fractional cents replays exactly from the mapped item', () => {
    const products = require('../services/pricing-engine/constants').SPECIALTY.preSlabTermiticide.products;
    const savedCost = products.talstar_p.containerCost;
    const quote = input({ slabSqFt: 7900 });
    let quoted;
    try {
      products.talstar_p.containerCost = 30.905;
      quoted = generateEstimate(quote);
    } finally {
      products.talstar_p.containerCost = savedCost;
    }
    expect(slabLine(quoted)).toMatchObject({ price: 788, containersRequired: 7, containerCost: 30.905 });
    const pin = replay.preSlabTermiticideKnobSignalForReplay({ result: mapV1ToLegacyShape(quoted) });
    expect(pin).toEqual({ productKey: 'talstar_p', containerCost: 30.905, containerOz: 128 });
    expect(slabLine(generateEstimate({ ...quote, preSlabTermiticidePricingKnobs: pin })).price).toBe(788);
  });

  test('the public replay of an old quote keeps its price; a copy of the pin inside the stored inputs never prices', () => {
    const { extractEngineInputs } = require('../routes/estimate-public');
    expect(slabLine(generateEstimate(extractEngineInputs({ engineInputs: input(), engineResult: oldQuote() }))).price).toBe(993);
    // No stored pre-slab row to read: the replay sets no pin, and the copy planted in the stored inputs is cleared, not priced.
    const planted = { engineInputs: { ...input(), preSlabTermiticidePricingKnobs: TALAK } };
    expect(extractEngineInputs(planted).preSlabTermiticidePricingKnobs).toBeUndefined();
    expect(slabLine(generateEstimate(extractEngineInputs(planted))).price).toBe(743);
  });

  // A row the deprecated client engine wrote ('Pre-Slab', no service) holds the same cost basis (pre-push audit 8).
  test('a quote the client engine priced keeps its container cost on both replay paths', async () => {
    const row = CLIENT_ROWS.preSlab;
    const stored = { engineInputs: input(), result: { oneTime: { items: [row] } } };
    expect(replay.preSlabTermiticideKnobSignalForReplay(stored)).toEqual(TALAK);
    const { extractEngineInputs } = require('../routes/estimate-public');
    expect(slabLine(generateEstimate(extractEngineInputs(stored))).price).toBe(993);
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    expect(slabLine((await serverRecomputeFromEstimateData(stored, { ...REPLAY_DEPS, replaySavedPricingKnobs: true })).rawEngineResult).price).toBe(993);
    // A serviceless row of another name, and a row that names another service, are not this line.
    const other = { result: { oneTime: { items: [{ ...row, name: 'Bora-Care' }, { ...row, service: 'bora_care' }] } } };
    expect(replay.preSlabTermiticideKnobSignalForReplay(other)).toBeNull();
  });

  test('the authoritative recompute keeps an old quote only on a declared replay; a posted save prices the new bottle', async () => {
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const deps = REPLAY_DEPS;
    const stored = { engineInputs: { ...input(), preSlabTermiticidePricingKnobs: TALAK }, engineResult: oldQuote() };
    const replayed = await serverRecomputeFromEstimateData(stored, { ...deps, replaySavedPricingKnobs: true });
    expect(slabLine(replayed.rawEngineResult).price).toBe(993);
    const posted = await serverRecomputeFromEstimateData(stored, deps);
    expect(slabLine(posted.rawEngineResult).price).toBe(743);
    const { CLIENT_IDENTITY_FIELDS } = require('../services/estimate-client-identity-fields');
    expect(CLIENT_IDENTITY_FIELDS).toContain('preSlabTermiticidePricingKnobs');
  });

  // Under the code-default costs the included Taurus costs more per finished gallon than either bottle, so no trench quote carries
  // a product surcharge; a lower configured Taurus cost can make one (the trench pin below).
  test('under the code-default costs the bottle never moves a trench price, at either rate', () => {
    const products = require('../services/pricing-engine/constants').SPECIALTY.trenching.products;
    const saved = { ...products.talstar_p };
    const prices = () => ['standard', 'high'].flatMap((applicationRate) => [120, 260].map((perimeterLF) => priceTrenching(
      { footprint: 2400 }, { perimeterLF, productKey: 'talstar_p', applicationRate },
    ).price));
    const crosscheck = prices();
    try {
      Object.assign(products.talstar_p, { label: 'Talak 7.9 F - Bifenthrin', containerCost: 41.57, containerOz: 96 });
      expect(prices()).toEqual(crosscheck);
    } finally {
      Object.assign(products.talstar_p, saved);
    }
    expect(crosscheck.every((price) => price > 0)).toBe(true);
  });
});

describe('a sent trench quote keeps the product surcharge it priced with', () => {
  const replay = require('../services/estimate-tree-shrub-knob-replay');
  const products = require('../services/pricing-engine/constants').SPECIALTY.trenching.products;
  const PROFILE = { homeSqFt: 2400, stories: 1, lotSqFt: 9000, propertyType: 'single_family' };
  const input = (extra = {}) => ({ ...PROFILE, services: { trenching: { perimeterLF: 400, productKey: 'talstar_p', applicationRate: 'high', ...extra } } });
  const trenchLine = (estimate) => estimate.lineItems.find((line) => line.service === 'trenching');
  const saved = { taurus: { ...products.taurus_sc }, talstar: { ...products.talstar_p } };
  // A lower configured Taurus cost ($30 / 78 oz, the included chemistry): the earlier bottle cost more per labeled finished gallon than
  // the included one, so the sent quote carried a product surcharge the new bottle does not. The high rate uses the standard amount
  // of product (0.12% at half the volume), so its surcharge is the standard rate's.
  beforeEach(() => { Object.assign(products.taurus_sc, { containerCost: 30, containerOz: 78 }); });
  afterEach(() => {
    Object.assign(products.taurus_sc, saved.taurus);
    Object.assign(products.talstar_p, saved.talstar);
  });
  const sentQuote = (extra = {}, bottle = {}) => {
    Object.assign(products.talstar_p, { label: 'Talak 7.9 F - Bifenthrin', containerCost: 41.57, containerOz: 96, ...bottle });
    try {
      return generateEstimate(input(extra));
    } finally {
      Object.assign(products.talstar_p, saved.talstar);
    }
  };
  const PIN = { productKey: 'talstar_p', applicationRate: 'high', productOz: 84, productSurcharge: 15 };
  const priced = (extra, knobs) => trenchLine(generateEstimate({ ...input(extra), trenchingTermiticidePricingKnobs: knobs }));

  test('the engine keeps the stored surcharge for the same product, rate and product oz only', () => {
    expect(trenchLine(sentQuote())).toMatchObject({ price: 4943, productSurcharge: 15, productOz: 84 });
    expect(trenchLine(generateEstimate(input()))).toMatchObject({ price: 4928, productSurcharge: 0 });
    expect(priced({}, PIN).price).toBe(4943);
    expect(priced({}, { ...PIN, productKey: 'bifen_it' }).price).toBe(4928);
    expect(priced({}, { ...PIN, applicationRate: 'standard' }).price).toBe(4928);
    expect(priced({ perimeterLF: 420 }, PIN).productSurcharge).toBe(0);
  });

  // At a reduced volume the oz alone cannot tell the job: the high rate's 84 oz on 400 LF is also the full-volume oz a 200 LF quote
  // stored before the volume adjustment. A replay re-prices the stored inputs of the same estimate, so the pin prices the line and
  // the same job keeps its sent price (pre-push audit 16). A pin for another product oz is skipped at any volume.
  test('a reduced-volume line keeps the pinned surcharge; a pin for another product oz is skipped', () => {
    expect(priced({}, PIN)).toMatchObject({ price: 4943, productOz: 84, productSurcharge: 15 });
    expect(priced({ perimeterLF: 800 }, { ...PIN, productOz: 168, productSurcharge: 68 })).toMatchObject({ productOz: 168, productSurcharge: 68 });
    const standard = { applicationRate: 'standard' };
    const fresh = trenchLine(generateEstimate(input(standard)));
    const pin = { productKey: 'talstar_p', applicationRate: 'standard', productOz: fresh.productOz, productSurcharge: fresh.productSurcharge + 7 };
    expect(priced(standard, pin)).toMatchObject({ productSurcharge: fresh.productSurcharge + 7 });
    expect(priced(standard, { ...pin, productOz: fresh.productOz + 1 })).toMatchObject({ price: fresh.price, productSurcharge: fresh.productSurcharge });
  });

  // A replay re-prices the stored inputs, custom ones included, and each custom input still takes the rest of its cost basis from
  // config (a custom cost divides by the configured container oz): the swap moves them too (pre-push audit 8: a custom rate of 2 oz a
  // finished gallon, at the half volume the label's chart gives it).
  test.each([
    ['a custom rate', { applicationRate: 'standard', customProductOzPerFinishedGallon: 2 }, { sent: 4415, fresh: 4400, productOz: 84, productSurcharge: 15 }],
    ['a custom product cost', { customProductCost: 41.57 }, { sent: 4943, fresh: 4930, productOz: 84, productSurcharge: 15 }],
    ['a custom container size', { customContainerOz: 96 }, { sent: 4943, fresh: 4930, productOz: 84, productSurcharge: 15 }],
  ])('a quote with %s keeps its sent surcharge on replay', (_label, extra, want) => {
    const sent = trenchLine(sentQuote(extra));
    expect(sent).toMatchObject({ price: want.sent, productOz: want.productOz, productSurcharge: want.productSurcharge });
    expect(trenchLine(generateEstimate(input(extra))).price).toBe(want.fresh);
    const pin = { productKey: 'talstar_p', applicationRate: sent.applicationRate, productOz: want.productOz, productSurcharge: want.productSurcharge };
    expect(priced(extra, pin).price).toBe(want.sent);
  });

  // A row the deprecated client engine wrote ('Trenching', no service) holds the same four fields (pre-push audit 8). Main's client
  // priced the high rate at the full volume, so its pin matches that volume, and both replay paths keep its $4,996 (pre-push audit
  // at the tenth push).
  test('a quote the client engine priced keeps its surcharge on both replay paths', async () => {
    const row = CLIENT_ROWS.trench;
    const stored = { engineInputs: input(), result: { oneTime: { items: [row] } } };
    expect(replay.trenchingKnobSignalForReplay(stored)).toEqual({ ...PIN, productOz: 168, productSurcharge: 68 });
    const { extractEngineInputs } = require('../routes/estimate-public');
    expect(trenchLine(generateEstimate(extractEngineInputs(stored))).price).toBe(4996);
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    expect(trenchLine((await serverRecomputeFromEstimateData(stored, { ...REPLAY_DEPS, replaySavedPricingKnobs: true })).rawEngineResult).price).toBe(4996);
    const other = { result: { oneTime: { items: [{ ...row, name: 'Bora-Care' }, { ...row, service: 'bora_care' }] } } };
    expect(replay.trenchingKnobSignalForReplay(other)).toBeNull();
  });

  // A blank stored figure is no pin: Number(null) and Number('') are 0, so a row missing its surcharge must never replay as a
  // confirmed $0 that keeps today's surcharge off the line (pre-push audit 17). A zero the row holds is a real pin.
  test('a blank stored surcharge or product oz is no pin, in the reader and in the engine', () => {
    const line = trenchLine(sentQuote());
    const signal = (extra) => replay.trenchingKnobSignalForReplay({ engineResult: { lineItems: [{ ...line, ...extra }] } });
    expect(signal({})).toEqual(PIN);
    expect(signal({ productSurcharge: '15', productOz: '84' })).toEqual(PIN);
    for (const blank of [null, '', ' ', undefined, false]) {
      expect(signal({ productSurcharge: blank })).toBeNull();
      expect(signal({ productOz: blank })).toBeNull();
    }
    expect(signal({ productSurcharge: 0 })).toEqual({ ...PIN, productSurcharge: 0 });
    // Under the bottle that carries a $15 surcharge: a blank pin prices today's $15; a zero pin keeps the $0 it was sent with.
    Object.assign(products.talstar_p, { label: 'Talak 7.9 F - Bifenthrin', containerCost: 41.57, containerOz: 96 });
    try {
      for (const blank of [null, '']) {
        expect(priced({}, { ...PIN, productSurcharge: blank })).toMatchObject({ price: 4943, productSurcharge: 15 });
      }
      expect(priced({}, { ...PIN, productSurcharge: 0 })).toMatchObject({ price: 4928, productSurcharge: 0 });
    } finally {
      Object.assign(products.talstar_p, saved.talstar);
    }
  });

  test('the signal reads the raw engine line and the mapped one-time item', () => {
    const engineResult = sentQuote();
    expect(replay.trenchingKnobSignalForReplay({ engineInputs: input(), engineResult })).toEqual(PIN);
    expect(replay.trenchingKnobSignalForReplay({ result: mapV1ToLegacyShape(engineResult) })).toEqual(PIN);
    expect(replay.trenchingKnobSignalForReplay({ engineResult: { lineItems: [{ service: 'trenching', productKey: 'talstar_p' }] } })).toBeNull();
    expect(replay.trenchingKnobSignalForReplay({})).toBeNull();
  });

  // A high-rate quote priced before the label fix used the full labeled volume (main's math: 168 oz for 400 LF at 2 oz a finished
  // gallon). Its pin matches that volume, so both replay paths keep its sent surcharge (pre-push audit 10).
  test('a quote priced at the full volume before the label fix keeps its sent price on both replay paths', async () => {
    const engineResult = sentQuote({}, { labelHalfVolumeOzPerFinishedGallon: undefined });
    const pin = { ...PIN, productOz: 168, productSurcharge: 68 };
    expect(trenchLine(engineResult)).toMatchObject({ price: 4996, finishedGallons: 84, ...pin });
    const stored = { engineInputs: input(), engineResult };
    expect(replay.trenchingKnobSignalForReplay(stored)).toEqual(pin);
    expect(replay.trenchingKnobSignalForReplay({ result: mapV1ToLegacyShape(engineResult) })).toEqual(pin);
    const { extractEngineInputs } = require('../routes/estimate-public');
    expect(trenchLine(generateEstimate(extractEngineInputs(stored))).price).toBe(4996);
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    expect(trenchLine((await serverRecomputeFromEstimateData(stored, { ...REPLAY_DEPS, replaySavedPricingKnobs: true })).rawEngineResult).price).toBe(4996);
    expect(priced({}, { ...pin, productOz: 336 }).price).toBe(4928); // any other oz is another quote: it prices fresh
    // A custom rate priced the full volume then too: 336 oz at 4 oz a finished gallon keeps its sent $4,573.
    const custom = { applicationRate: 'standard', customProductOzPerFinishedGallon: 4 };
    expect(trenchLine(sentQuote(custom, { labelHalfVolumeOzPerFinishedGallon: undefined }))).toMatchObject({ price: 4573, productOz: 336, productSurcharge: 173 });
    expect(priced(custom, { ...pin, applicationRate: 'standard', productOz: 336, productSurcharge: 173 }).price).toBe(4573);
  });

  test('both replay paths keep the sent price; a posted save and a planted copy price the new bottle', async () => {
    const { extractEngineInputs } = require('../routes/estimate-public');
    const engineResult = sentQuote();
    expect(trenchLine(generateEstimate(extractEngineInputs({ engineInputs: input(), engineResult }))).price).toBe(4943);
    const planted = { engineInputs: { ...input(), trenchingTermiticidePricingKnobs: PIN } };
    expect(extractEngineInputs(planted).trenchingTermiticidePricingKnobs).toBeUndefined();
    expect(trenchLine(generateEstimate(extractEngineInputs(planted))).price).toBe(4928);
    const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
    const deps = REPLAY_DEPS;
    const stored = { engineInputs: { ...input(), trenchingTermiticidePricingKnobs: PIN }, engineResult };
    expect(trenchLine((await serverRecomputeFromEstimateData(stored, { ...deps, replaySavedPricingKnobs: true })).rawEngineResult).price).toBe(4943);
    expect(trenchLine((await serverRecomputeFromEstimateData(stored, deps)).rawEngineResult).price).toBe(4928);
    const { CLIENT_IDENTITY_FIELDS } = require('../services/estimate-client-identity-fields');
    expect(CLIENT_IDENTITY_FIELDS).toContain('trenchingTermiticidePricingKnobs');
  });
});
