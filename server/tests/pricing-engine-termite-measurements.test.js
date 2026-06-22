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

describe('termite measurement overrides and safeguards', () => {
  test('termite bait keeps existing valid pricing example', () => {
    const result = priceTermiteBait(
      { footprint: 2000, features: { complexity: 'standard' } },
      { system: 'advance', monitoringTier: 'basic' }
    );

    expect(result.perimeter).toBe(224);
    expect(result.stations).toBe(23);
    expect(result.installation.price).toBe(639);
    expect(result.monitoring.monthly).toBe(35);
    expect(result.monitoring.annual).toBe(420);
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
    expect(missing.selectedSystem).toBe('advance');
    expect(missing.measurementWarnings).toContain('invalid_termite_system_defaulted_to_advance');
  });

  test('trenching keeps existing valid example and supports manual concrete LF', () => {
    const existing = priceTrenching({
      perimeter: 240,
      features: { poolCage: true, largeDriveway: true },
    });

    expect(existing.concretePct).toBe(0.4);
    expect(existing.dirtLF).toBe(144);
    expect(existing.concreteLF).toBe(96);
    expect(existing.price).toBe(2784);
    expect(existing.renewal).toBe(325);
    expect(existing.productKey).toBe('taurus_sc');
    expect(existing.productSurcharge).toBe(0);
    expect(existing.baseInstallPrice).toBe(2784);
    expect(existing.finishedGallons).toBe(103.68);

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

  test('trenching normalizes products, rates, and chemical cost per LF', () => {
    expect(normalizeTrenchingTermiticideProduct('termidor sc').productKey).toBe('termidor_sc');
    expect(normalizeTrenchingTermiticideProduct('basf').productKey).toBe('termidor_sc');
    expect(normalizeTrenchingTermiticideProduct('fipronil').productKey).toBe('taurus_sc');
    expect(normalizeTrenchingTermiticideProduct('bifen i/t').productKey).toBe('bifen_it');
    expect(normalizeTrenchingTermiticideProduct('talstar pro').productKey).toBe('talstar_p');
    expect(normalizeTrenchingApplicationRate('0.06%').applicationRate).toBe('standard');
    expect(normalizeTrenchingApplicationRate('problem soil').applicationRate).toBe('high');

    const base = { measurements: { perimeterLF: 100, dirtLF: 100, concreteLF: 0 }, concreteVolumePadPct: 0 };
    expect(priceTrenching({}, { ...base, productKey: 'termidor_sc' }).chemicalCostPerLF).toBeCloseTo(1.54, 2);
    expect(priceTrenching({}, { ...base, productKey: 'taurus_sc' }).chemicalCostPerLF).toBeCloseTo(0.35, 2);
    expect(priceTrenching({}, { ...base, productKey: 'bifen_it' }).chemicalCostPerLF).toBeCloseTo(0.23, 2);
    expect(priceTrenching({}, { ...base, productKey: 'talstar_p' }).chemicalCostPerLF).toBeCloseTo(0.27, 2);
  });

  test('trenching Termidor premium surcharges while Bifen never discounts below LF model', () => {
    const termidor = priceTrenching({}, {
      measurements: { perimeterLF: 240, dirtLF: 144, concreteLF: 96 },
      productKey: 'termidor_sc',
      labelConfirmed: true,
    });
    expect(termidor.finishedGallons).toBe(103.68);
    expect(termidor.productOz).toBeCloseTo(82.94, 2);
    expect(termidor.allocatedChemicalCost).toBeCloseTo(398.77, 2);
    expect(termidor.includedChemicalCost).toBeCloseTo(90.39, 2);
    expect(termidor.chemicalPremiumCost).toBeCloseTo(308.38, 2);
    expect(termidor.productSurcharge).toBeGreaterThanOrEqual(447);
    expect(termidor.productSurcharge).toBeLessThanOrEqual(448);
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
    expect(termidor.price).toBe(1279);

    const taurus = pricePreSlabTermiticide(2500, { productKey: 'taurus_sc', labelConfirmed: true });
    expect(taurus.productOz).toBe(200);
    expect(taurus.units).toBe(3);
    expect(taurus.productCost).toBe(243.59);
    expect(taurus.price).toBe(825);

    const bifen = pricePreSlabTermiticide(2500, { productKey: 'bifen_it', labelConfirmed: true });
    expect(bifen.productOz).toBe(250);
    expect(bifen.units).toBe(2);
    expect(bifen.productCost).toBe(81.11);
    expect(bifen.rawPrice).toBe(464);
    expect(bifen.price).toBe(600);

    const talstar = pricePreSlabTermiticide(2500, { productKey: 'talstar_p', labelConfirmed: true });
    expect(talstar.productOz).toBe(250);
    expect(talstar.units).toBe(2);
    expect(talstar.productCost).toBe(76.15);
    expect(talstar.rawPrice).toBe(453);
    expect(talstar.price).toBe(600);
  });

  test('Pre-Slab Termiticide uses contextual small-slab minimums', () => {
    const standalone = pricePreSlabTermiticide(100, {
      productKey: 'bifen_it',
      jobContext: 'standalone',
      labelConfirmed: true,
    });
    expect(standalone.productOz).toBe(10);
    expect(standalone.productCost).toBe(3.24);
    expect(standalone.contextualFloor).toBe(225);
    expect(standalone.price).toBe(225);
    expect(standalone.price).not.toBe(600);

    const builderBatch = pricePreSlabTermiticide(100, {
      productKey: 'bifen_it',
      jobContext: 'builderBatch',
      labelConfirmed: true,
    });
    expect(builderBatch.contextualFloor).toBe(150);
    expect(builderBatch.price).toBe(174);
    expect(builderBatch.price).not.toBe(600);

    const sameTripAddOn = pricePreSlabTermiticide(100, {
      productKey: 'bifen_it',
      jobContext: 'sameTripAddOn',
      labelConfirmed: true,
    });
    expect(sameTripAddOn.contextualFloor).toBe(125);
    expect(sameTripAddOn.price).toBe(174);
    expect(sameTripAddOn.price).not.toBe(600);
  });

  test('Pre-Slab Termiticide applies volume floors, warranty metadata, and measurement guards', () => {
    const termidorTenPlus = pricePreSlabTermiticide(1800, {
      productKey: 'termidor_sc',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(termidorTenPlus.units).toBe(2);
    expect(termidorTenPlus.price).toBe(797);
    expect(termidorTenPlus.volumeDiscountMultiplier).toBe(0.85);

    const taurusTenPlus = pricePreSlabTermiticide(1800, {
      productKey: 'taurus_sc',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(taurusTenPlus.price).toBe(519);

    const bifenTenPlus = pricePreSlabTermiticide(1800, {
      productKey: 'bifen_it',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(bifenTenPlus.contextualFloor).toBe(500);
    expect(bifenTenPlus.priceBeforeVolumeDiscount).toBe(500);
    expect(bifenTenPlus.price).toBe(500);

    const talstarTenPlus = pricePreSlabTermiticide(1800, {
      productKey: 'talstar_p',
      volumeDiscount: '10plus',
      labelConfirmed: true,
    });
    expect(talstarTenPlus.priceBeforeVolumeDiscount).toBe(500);
    expect(talstarTenPlus.price).toBe(500);

    const override = pricePreSlabTermiticide({}, {
      productKey: 'termidor_sc',
      measurements: { slabSqFt: 2500 },
      includeWarrantyExtended: true,
      labelConfirmed: true,
    });
    expect(override.slabSqFt).toBe(2500);
    expect(override.slabSqFtSource).toBe('manual_override');
    expect(override.price).toBe(1479);
    expect(override.warrantyExtendedSelected).toBe(true);
    expect(override.warrantyExtendedPrice).toBe(200);
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
    expect(legacy.price).toBe(1279);
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
    expect(preslab.addOns[0].price).toBe(200);

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
    expect(mappedPreSlab.warrantyAdder).toBe(200);
    expect(mappedPreSlab.detail).toContain('Taurus');
    expect(mappedPreSlab.addOns[0].price).toBe(200);

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
