const {
  priceTermiteBait,
  priceTrenching,
  priceBoraCare,
  pricePreSlabTermidor,
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

  test('Pre-Slab Termidor keeps examples, supports manual slab sqft and extended warranty metadata', () => {
    const noDiscount = pricePreSlabTermidor(2500, 'none');
    expect(noDiscount.bottles).toBe(2);
    expect(noDiscount.laborHrs).toBe(2.2);
    expect(noDiscount.price).toBe(878);

    const tenPlus = pricePreSlabTermidor(1800, '10plus');
    expect(tenPlus.bottles).toBe(2);
    expect(tenPlus.laborHrs).toBe(1.7);
    expect(tenPlus.priceBeforeVolumeDiscount).toBe(842);
    expect(tenPlus.price).toBe(716);
    expect(tenPlus.volumeDiscountMultiplier).toBe(0.85);

    const override = pricePreSlabTermidor({}, {
      measurements: { slabSqFt: 2500 },
      includeWarrantyExtended: true,
    });
    expect(override.slabSqFt).toBe(2500);
    expect(override.slabSqFtSource).toBe('manual_override');
    expect(override.price).toBe(1078);
    expect(override.warrantyExtendedSelected).toBe(true);
    expect(override.warrantyExtendedPrice).toBe(200);
    expect(override.addOns[0].code).toBe('pre_slab_extended_warranty');

    const missing = pricePreSlabTermidor({}, {});
    expect(missing.quoteRequired).toBe(true);
    expect(missing.price).toBeNull();
    expect(missing.manualReviewReasons).toContain('missing_pre_slab_sqft');
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
        boracareSqft: 2000,
        preslabSqft: 2500,
        preslabWarranty: 'EXTENDED',
      }
    );
    const estimate = generateEstimate(v1Input);
    const trench = estimate.lineItems.find((item) => item.service === 'trenching');
    const preslab = estimate.lineItems.find((item) => item.service === 'pre_slab_termidor');

    expect(trench.measurements.perimeterLF.source).toBe('manual_override');
    expect(trench.concretePct).toBe(0.4);
    expect(preslab.warrantyExtendedSelected).toBe(true);
    expect(preslab.addOns[0].price).toBe(200);

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.results.tmBait.measurements.perimeterLF.source).toBe('manual_override');
    expect(mapped.oneTime.items.find((item) => item.service === 'trenching').measurements.concretePct.value).toBe(0.4);
    expect(mapped.oneTime.specItems.find((item) => item.service === 'pre_slab_termidor').addOns[0].price).toBe(200);
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
    const mappedTrench = mapped.oneTime.items.find((item) => item.service === 'trenching');
    expect(mappedTrench.quoteRequired).toBe(true);
    expect(mappedTrench.price).toBeNull();
    expect(mappedTrench.renewal).toBeUndefined();
    expect(mapped.results.trench).toBeUndefined();
  });
});
