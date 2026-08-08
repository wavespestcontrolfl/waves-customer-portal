const { priceMosquito } = require('../services/pricing-engine');
const { MOSQUITO, ONE_TIME } = require('../services/pricing-engine/constants');

// Mosquito cadence guard + the 2026-08-08 +5% reprice (owner directives).
//
// The Monthly-12 program's per-visit price sits ~7-12% under Seasonal-9 at
// every lot bucket by table design, but mosquito_base_prices is
// admin-editable with nothing else enforcing the relation — an inverted
// cell would silently sell the denser program at a per-visit premium while
// the cards present it as the value option. mosquitoBoundedBasePrice now
// clamps monthly12 <= seasonal9 at lookup time (client mirror in
// estimateEngine), the same class as the lawn 12x≤9x bound (2026-07-29).
//
// The +5% raise (rounded half-up) is pinned exactly: a silent drift of the
// fresh-env defaults away from the migrated DB rows fails here loudly.

function property(sqft) {
  return { mosquitoTreatableSqFt: sqft, lotSqFt: sqft + 4000, homeSqFt: 2200 };
}

function tiersByProgram(result) {
  const by = {};
  for (const t of result.tiers) by[t.tier] = t;
  return by;
}

afterEach(() => {
  // Tests below mutate the (module-singleton) table to simulate an admin
  // inversion — restore the shipped values.
  MOSQUITO.basePrices.SMALL = [77, 69];
});

describe('mosquito +5% reprice (owner 2026-08-08) — exact tables', () => {
  it('recurring base prices carry the raised values', () => {
    expect(MOSQUITO.basePrices).toMatchObject({
      SMALL: [77, 69],
      QUARTER: [80, 72],
      THIRD: [83, 77],
      HALF: [90, 81],
      ACRE: [102, 90],
    });
  });

  it('one-time buckets and the over-acre increment carry the raised values; add-ons unchanged', () => {
    expect(ONE_TIME.mosquito).toMatchObject({
      SMALL: 156,
      STANDARD: 177,
      LARGE: 198,
      XL: 219,
      ESTATE: 251,
      ACRE_CLASS: 282,
      OVER_ACRE: 282,
      overAcreIncrementSqFt: 10000,
      overAcreIncrementPrice: 42,
      // Product-cost-linked add-ons deliberately excluded from the raise.
      stationAddOn: 75,
      dunkAddOn: 15,
    });
  });

  it('the raise preserves the Monthly-vs-Seasonal discount at every bucket', () => {
    for (const [bucket, [seasonal, monthly]] of Object.entries(MOSQUITO.basePrices)) {
      expect(monthly).toBeLessThan(seasonal);
      // Shape stays in the designed band (~7-12%).
      const discount = 1 - monthly / seasonal;
      expect(discount).toBeGreaterThan(0.05);
      expect(discount).toBeLessThan(0.15);
      expect(bucket).toBeTruthy();
    }
  });
});

describe('mosquito cadence bound (monthly12 per-visit never above seasonal9)', () => {
  it('holds at every 500-sf step through the full table and both terminal extensions', () => {
    for (let sqft = 500; sqft <= 80000; sqft += 500) {
      const by = tiersByProgram(priceMosquito(property(sqft), { tier: 'seasonal9' }));
      expect(by.monthly12.perVisit).toBeLessThanOrEqual(by.seasonal9.perVisit);
    }
  });

  it('clamps an admin-inverted cell instead of selling the denser program at a premium', () => {
    // Simulate a bad admin edit: SMALL monthly12 raised above seasonal9.
    MOSQUITO.basePrices.SMALL = [77, 95];
    const by = tiersByProgram(priceMosquito(property(4000), { tier: 'monthly12' }));
    expect(by.monthly12.perVisit).toBeLessThanOrEqual(by.seasonal9.perVisit);
    // The selected-program headline price honors the same bound.
    const selected = priceMosquito(property(4000), { tier: 'monthly12' });
    expect(selected.perVisit).toBeLessThanOrEqual(by.seasonal9.perVisit);
  });

  it('annual revenue still rises with frequency at every bucket boundary size', () => {
    // 12 visits at the bounded per-visit always out-earns 9 — the guard can
    // never invert the program ANNUAL ordering either.
    for (const sqft of [4000, 10000, 15000, 25000, 40000]) {
      const by = tiersByProgram(priceMosquito(property(sqft), { tier: 'seasonal9' }));
      expect(by.monthly12.annual).toBeGreaterThan(by.seasonal9.annual);
    }
  });
});
