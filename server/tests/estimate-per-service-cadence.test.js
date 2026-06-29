const {
  nonPestTierBaseMap,
  comboPricingEntry,
  serviceCadenceComboKey,
  buildServiceCadenceCombos,
  bundleSectionLadderForService,
} = require('../routes/estimate-public');

// A pest + lawn bundle in the v1 (admin) shape. Silver tier (2 qualifying
// recurring services) → 10% WaveGuard discount. Lawn defaults to Enhanced (9x).
function pestLawnV1() {
  return {
    pestTiers: [
      { label: 'Quarterly', mo: 60, ann: 720, pa: 180, apps: 4 },
      { label: 'Bi-Monthly', mo: 80, ann: 960, pa: 160, apps: 6 },
      { label: 'Monthly', mo: 120, ann: 1440, pa: 120, apps: 12 },
    ],
    services: [
      { name: 'Pest Control', service: 'pest_control', mo: 60, ann: 720, perTreatment: 180, visitsPerYear: 4 },
      { name: 'Lawn Care', service: 'lawn_care', mo: 66.75, ann: 801, perTreatment: 89, visitsPerYear: 9 },
    ],
    discount: 0.10,
    manualDiscount: null,
  };
}

const LAWN_RESULT_STATS = {
  lawn: [
    { name: 'Basic', v: 4, mo: 35, ann: 420, pa: 105 },
    { name: 'Standard', v: 6, mo: 45.5, ann: 546, pa: 91 },
    { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
    { name: 'Premium', v: 12, mo: 89, ann: 1068, pa: 89 },
  ],
};

const QUARTERLY = { key: 'quarterly', label: 'Quarterly' };
const MONTHLY = { key: 'monthly', label: 'Monthly' };

describe('nonPestTierBaseMap — per-service tier price lookup from result rows', () => {
  test('maps lawn tier keys to their pre-discount base prices/visits', () => {
    const map = nonPestTierBaseMap(LAWN_RESULT_STATS);
    expect(Object.keys(map)).toEqual(['lawn_care']);
    expect(map.lawn_care.basic).toMatchObject({ mo: 35, ann: 420, pa: 105, v: 4 });
    expect(map.lawn_care.enhanced).toMatchObject({ mo: 66.75, v: 9, recommended: true });
    expect(map.lawn_care.premium).toMatchObject({ mo: 89, v: 12 });
  });

  test('returns {} when there are no non-pest tier rows', () => {
    expect(nonPestTierBaseMap({})).toEqual({});
    expect(nonPestTierBaseMap({ lawn: [] })).toEqual({});
  });
});

describe('comboPricingEntry — authoritative total via shapeFromV1', () => {
  const v1 = pestLawnV1();
  const tierBaseMap = nonPestTierBaseMap(LAWN_RESULT_STATS);

  test('the DEFAULT combo equals the existing bundle total (regression pin)', () => {
    // Default = pest Quarterly + lawn Enhanced (the recommended/stored tier).
    // Selecting Enhanced must reproduce today's number: pest 60*0.9 + lawn 66.75*0.9.
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, tierBaseMap, {
      pest_control: 'quarterly',
      lawn_care: 'enhanced',
    });
    const expected = Math.round((60 * 0.9 + 66.75 * 0.9) * 100) / 100; // 114.08
    expect(entry.monthly).toBe(expected);
  });

  test('pest Monthly + lawn Basic recomputes both contributions at 10% off', () => {
    const entry = comboPricingEntry(v1, MONTHLY, v1.pestTiers[2], {}, tierBaseMap, {
      pest_control: 'monthly',
      lawn_care: 'basic',
    });
    // pest 120*0.9 = 108 ; lawn 35*0.9 = 31.5 → 139.5
    expect(entry.monthly).toBe(139.5);
    expect(entry.annual).toBe(Math.round(139.5 * 12 * 100) / 100);
  });

  test('pest Quarterly + lawn Premium', () => {
    const entry = comboPricingEntry(v1, QUARTERLY, v1.pestTiers[0], {}, tierBaseMap, {
      pest_control: 'quarterly',
      lawn_care: 'premium',
    });
    // pest 60*0.9 = 54 ; lawn 89*0.9 = 80.1 → 134.1
    expect(entry.monthly).toBe(134.1);
  });
});

describe('serviceCadenceComboKey — stable composite key', () => {
  test('sorts keys so the composite is order-independent', () => {
    expect(serviceCadenceComboKey({ pest_control: 'monthly', lawn_care: 'basic' }))
      .toBe('lawn_care:basic|pest_control:monthly');
    expect(serviceCadenceComboKey({ lawn_care: 'basic', pest_control: 'monthly' }))
      .toBe('lawn_care:basic|pest_control:monthly');
  });
});

describe('buildServiceCadenceCombos — full combination ladder', () => {
  test('pest(3) × lawn(4) = 12 priced combinations, all keyed + summed', () => {
    const combos = buildServiceCadenceCombos(pestLawnV1(), {}, LAWN_RESULT_STATS);
    expect(combos).toHaveLength(12);
    // Spot-check a couple of combos against the hand math.
    const monthlyBasic = combos.find((c) => c.key === 'lawn_care:basic|pest_control:monthly');
    expect(monthlyBasic.monthly).toBe(139.5);
    const quarterlyEnhanced = combos.find((c) => c.key === 'lawn_care:enhanced|pest_control:quarterly');
    expect(quarterlyEnhanced.monthly).toBe(Math.round((60 * 0.9 + 66.75 * 0.9) * 100) / 100);
    // Every combo carries a selection for both axes.
    for (const c of combos) {
      expect(c.selection.pest_control).toBeTruthy();
      expect(c.selection.lawn_care).toBeTruthy();
    }
  });

  test('combo perServiceTreatments reflect the SELECTED tier (drives first-visit invoice)', () => {
    // The accept handler re-bases the first-application invoice on the selected
    // combo's perServiceTreatments — so they must carry the chosen tier's
    // per-visit price, not the default tier's. (Regression for the P0 where the
    // first invoice billed the default non-pest rows.)
    const combos = buildServiceCadenceCombos(pestLawnV1(), {}, LAWN_RESULT_STATS);
    const monthlyBasic = combos.find((c) => c.key === 'lawn_care:basic|pest_control:monthly');
    const lawnRow = monthlyBasic.perServiceTreatments.find((r) => /lawn/i.test(r.service || ''));
    expect(lawnRow.displayPrice).toBe(94.5); // basic per-app 105 * 0.9 (10% off)
    const quarterlyPremium = combos.find((c) => c.key === 'lawn_care:premium|pest_control:quarterly');
    const lawnRow2 = quarterlyPremium.perServiceTreatments.find((r) => /lawn/i.test(r.service || ''));
    expect(lawnRow2.displayPrice).toBe(80.1); // premium per-app 89 * 0.9
  });

  test('returns null when no non-pest service has more than one tier', () => {
    // Pest-only bundle: nothing extra to vary.
    const pestOnly = { pestTiers: pestLawnV1().pestTiers, services: [pestLawnV1().services[0]], discount: 0 };
    expect(buildServiceCadenceCombos(pestOnly, {}, {})).toBeNull();
  });
});

describe('bundleSectionLadderForService — non-pest section own-cadence slider', () => {
  const lawnSvc = { name: 'Lawn Care', service: 'lawn_care' };

  test('reprices each lawn tier post-WaveGuard discount, PRE manual (manual null)', () => {
    const ladder = bundleSectionLadderForService('lawn_care', { results: LAWN_RESULT_STATS }, lawnSvc, 0.10);
    expect(ladder.map((e) => e.key)).toEqual(['basic', 'standard', 'enhanced', 'premium']);
    const byKey = Object.fromEntries(ladder.map((e) => [e.key, e]));
    expect(byKey.basic.monthly).toBe(31.5); // 35 * 0.9
    expect(byKey.standard.monthly).toBe(40.95); // 45.5 * 0.9
    expect(byKey.premium.monthly).toBe(80.1); // 89 * 0.9
    // Manual discount is applied once at the bundle total, never per-section.
    for (const e of ladder) expect(e.manualDiscount).toBeNull();
  });

  test('no discount applied when the rate is 0 (Bronze / single-service)', () => {
    const ladder = bundleSectionLadderForService('lawn_care', { results: LAWN_RESULT_STATS }, lawnSvc, 0);
    const byKey = Object.fromEntries(ladder.map((e) => [e.key, e]));
    expect(byKey.basic.monthly).toBe(35);
    expect(byKey.premium.monthly).toBe(89);
  });

  test('returns null for a service with no tier rows / no extractor', () => {
    expect(bundleSectionLadderForService('lawn_care', { results: {} }, lawnSvc, 0.1)).toBeNull();
    expect(bundleSectionLadderForService('pest_control', { results: LAWN_RESULT_STATS }, {}, 0.1)).toBeNull();
  });
});
