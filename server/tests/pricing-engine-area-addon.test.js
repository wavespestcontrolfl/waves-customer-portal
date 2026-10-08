const { priceAreaAddOn } = require('../services/pricing-engine');
const { AREA_ADDONS, GLOBAL } = require('../services/pricing-engine/constants');

// Owner rulings 2026-10-08: one cost-plus add-on pricer, 60% target at the
// top of each area tier, own visit by default, no recurring-customer perk.
describe('area add-on treatment pricing', () => {
  test.each([
    ['bed_pre_emergent', 1000, 99, 69],
    ['bed_pre_emergent', 2000, 139, 109],
    ['bed_pre_emergent', 3500, 199, 169],
    ['lawn_insect_spot', 1000, 79, 49],
    ['lawn_insect_spot', 2000, 99, 69],
    ['lawn_insect_spot', 3500, 119, 89],
    ['fire_ant_yard', 3000, 99, 69],
    ['fire_ant_yard', 5000, 129, 99],
    ['fire_ant_yard', 8000, 169, 139],
    ['lawn_insect_preventive', 3000, 99, 69],
    ['lawn_insect_preventive', 5000, 119, 89],
    ['lawn_insect_preventive', 8000, 149, 119],
    ['hardscape_weed', 1000, 119, 89],
  ])('%s at %i sq ft is $%i own visit and $%i same trip', (key, areaSqFt, ownVisit, sameTrip) => {
    expect(priceAreaAddOn(key, { areaSqFt }).price).toBe(ownVisit);
    expect(priceAreaAddOn(key, { areaSqFt, visitContext: 'sameTripAddOn' }).price).toBe(sameTrip);
  });

  test('every priced tier keeps at least the target margin in both visit contexts', () => {
    for (const [key, cfg] of Object.entries(AREA_ADDONS.items)) {
      for (const areaSqFt of cfg.tiers || [undefined]) {
        for (const visitContext of ['standalone', 'sameTripAddOn']) {
          const line = priceAreaAddOn(key, { areaSqFt, visitContext });
          expect(line.margin).toBeGreaterThanOrEqual(AREA_ADDONS.targetMargin);
          expect(line.price % 10).toBe(9);
        }
      }
    }
  });

  test('an area inside a tier prices at the top of that tier', () => {
    const line = priceAreaAddOn('lawn_insect_spot', { areaSqFt: 1200 });
    expect(line).toMatchObject({ price: 99, tierSqFt: 2000, areaSqFt: 1200 });
  });

  test('a same-trip add-on drops only the drive cost', () => {
    const own = priceAreaAddOn('fire_ant_yard', { areaSqFt: 5000 });
    const same = priceAreaAddOn('fire_ant_yard', { areaSqFt: 5000, visitContext: 'sameTripAddOn' });
    expect(own.costs.driveMin).toBe(GLOBAL.DRIVE_TIME);
    expect(same.costs.driveMin).toBe(0);
    expect(own.costs.material).toBe(same.costs.material);
    expect(own.costs.perApplication - same.costs.perApplication)
      .toBeCloseTo(GLOBAL.DRIVE_TIME * GLOBAL.LABOR_RATE / 60, 2);
  });

  test('web sweep is one flat labor-only job with no area', () => {
    const line = priceAreaAddOn('web_sweep');
    expect(line).toMatchObject({ price: 89, tierSqFt: null, areaSqFt: null });
    expect(line.costs.material).toBe(0);
    expect(priceAreaAddOn('web_sweep', { visitContext: 'sameTripAddOn' }).price).toBe(59);
  });

  test('two bed pre-emergent applications price at twice one application', () => {
    const line = priceAreaAddOn('bed_pre_emergent', { areaSqFt: 1000, applications: 2 });
    expect(line).toMatchObject({ price: 198, perApplication: 99, applications: 2 });
  });

  test('the line never takes a discount pass', () => {
    expect(priceAreaAddOn('web_sweep')).toMatchObject({ service: 'area_addon', discountable: false });
  });

  test('an area above the largest tier is a custom quote, not an extrapolated price', () => {
    const line = priceAreaAddOn('bed_pre_emergent', { areaSqFt: 3501 });
    expect(line).toMatchObject({
      price: null,
      requiresCustomQuote: true,
      customQuoteReason: 'area_addon_area_above_largest_tier',
    });
  });

  test('more applications than the yearly limit is a custom quote', () => {
    // Arena reaches its yearly label limit in one full-rate application.
    const line = priceAreaAddOn('lawn_insect_spot', { areaSqFt: 1000, applications: 2 });
    expect(line).toMatchObject({
      price: null,
      requiresCustomQuote: true,
      customQuoteReason: 'area_addon_applications_above_yearly_limit',
    });
  });

  test('bad input is a 400 pricing error', () => {
    expect(() => priceAreaAddOn('aeration', { areaSqFt: 1000 })).toThrow(/addOnKey must be one of/);
    expect(() => priceAreaAddOn('fire_ant_yard', {})).toThrow(/areaSqFt is required/);
    expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: -5 })).toThrow(/areaSqFt is required/);
    expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000, visitContext: 'builderBatch' }))
      .toThrow(/visitContext must be one of/);
    expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000, applications: 0 }))
      .toThrow(/applications must be a whole number/);
  });
});
