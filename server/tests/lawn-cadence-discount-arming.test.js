const { priceLawnCare, priceOneTimeLawn } = require('../services/pricing-engine');
const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

// The cadence frequency discount's two runtime guards (codex #3274 r3):
//
// P1 — the -4%/-8% lookup caps ride lawn_pricing_v2.cadenceFreqDiscountArmed
// (in-code default true; migrate:down of 20260807120000 writes false, synced
// by db-bridge). Without the gate, the DOCUMENTED rollback restored the
// pre-discount bracket cells and the engine cap immediately re-clamped every
// lookup back to the discount — migrate:down was a silent no-op at runtime.
// The 2026-07-29 12x-never-above-9x bound is deliberately NOT gated: it
// pre-dates the discount and must survive its rollback.
//
// P2 — with the live useLawnCostFloor re-arm, each cadence floors
// independently, which could inverted the promised per-application ladder
// (floored 9x above 6x). The engine now resolves the three cadences together
// by LIFTING the lower-frequency legs (never dropping a leg below its own
// floor), gated on BOTH arms so disarmed floors and a rolled-back discount
// each keep their prior behavior bit-for-bit.

afterEach(() => {
  LAWN_PRICING_V2.cadenceFreqDiscountArmed = true;
});

function tiersByVisits(result) {
  const by = {};
  for (const t of result.tiers) by[t.visits] = t;
  return by;
}

describe('cadence discount arm switch (rollback semantics)', () => {
  it('disarming lifts the -4%/-8% caps off enhanced/premium lookups', () => {
    // 8,125 sqft st_augustine: each column rounds its interpolation
    // independently, so the runtime caps BIND here even on the discounted
    // in-code grid (armed 9x $89.33 / 12x $86 vs uncapped $90.67 / $87) —
    // the same class of lookup the caps would wrongly re-clamp after a
    // migrate:down restored the pre-discount cells. Disarming must release
    // both legs and never move the 6x anchor.
    const armed = tiersByVisits(priceLawnCare({ lawnSqFt: 8125 }, { tier: 'standard' }));
    LAWN_PRICING_V2.cadenceFreqDiscountArmed = false;
    const disarmed = tiersByVisits(priceLawnCare({ lawnSqFt: 8125 }, { tier: 'standard' }));

    expect(disarmed[6].perApp).toBe(armed[6].perApp);
    expect(disarmed[9].perApp).toBeGreaterThan(armed[9].perApp);
    expect(disarmed[12].perApp).toBeGreaterThan(armed[12].perApp);
  });

  it('disarmed keeps the pre-discount 12x-never-above-9x bound', () => {
    LAWN_PRICING_V2.cadenceFreqDiscountArmed = false;
    for (const sqft of [800, 3000, 5500, 8000, 12500, 20000]) {
      const by = tiersByVisits(priceLawnCare({ lawnSqFt: sqft }, { tier: 'standard' }));
      expect(by[12].perApp).toBeLessThanOrEqual(by[9].perApp + 0.01);
    }
  });

  it('an explicit true (or absent key) keeps the caps armed', () => {
    const armed = tiersByVisits(priceLawnCare({ lawnSqFt: 12500 }, { tier: 'standard' }));
    // matches the migration-applied grid: -4%/-8% off the 6x anchor
    expect(armed[9].perApp).toBeLessThanOrEqual(armed[6].perApp * 0.96 + 0.01);
    expect(armed[12].perApp).toBeLessThanOrEqual(armed[6].perApp * 0.92 + 0.01);
  });
});

describe('cadence ladder under ARMED cost floors (lift resolution)', () => {
  // codex #3274 r3 P2 example: 12,000 sqft st_augustine with the live
  // useLawnCostFloor re-arm floors 9x to $137/app above 6x's floored
  // $129/app. The engine must resolve the three cadences together.
  it('floored cadences keep the promised per-application ladder', () => {
    const by = tiersByVisits(priceLawnCare({ lawnSqFt: 12000 }, { tier: 'standard', useLawnCostFloor: true }));
    expect(by[9].costFloorApplied).toBe(true);
    expect(by[9].perApp).toBeLessThanOrEqual(by[6].perApp * 0.96 + 0.02);
    expect(by[12].perApp).toBeLessThanOrEqual(by[6].perApp * 0.92 + 0.02);
    expect(by[12].perApp).toBeLessThanOrEqual(by[9].perApp + 0.01);
  });

  it('the lift only ever RAISES legs — no cadence lands below its own floor', () => {
    for (const sqft of [8000, 12000, 15000, 20000]) {
      const by = tiersByVisits(priceLawnCare({ lawnSqFt: sqft }, { tier: 'standard', useLawnCostFloor: true }));
      for (const v of [6, 9, 12]) {
        expect(by[v].annual).toBeGreaterThanOrEqual(Math.floor(by[v].costFloorAnnual));
        expect(by[v].annual).toBeGreaterThanOrEqual(by[v].marketAnnual);
      }
    }
  });

  it('lifted legs are flagged and carry lift provenance, not a market label (codex r4 P2)', () => {
    const by = tiersByVisits(priceLawnCare({ lawnSqFt: 12000 }, { tier: 'standard', useLawnCostFloor: true }));
    expect(by[6].cadenceLadderLiftApplied).toBe(true);
    // The lifted 6x annual exceeds its market annual, so labeling it
    // MARKET_TABLE would store a non-market price as market-derived.
    expect(by[6].annual).toBeGreaterThan(by[6].marketAnnual);
    expect(by[6].pricingSource).toBe('CADENCE_LADDER_LIFT');
    expect(by[6].pricingBasis).toBe(LAWN_PRICING_V2.pricingMode);
  });

  it('the legacy mapper carries the lift marker through to R.lawn (codex r4 P2)', () => {
    const result = priceLawnCare({ lawnSqFt: 12000 }, { tier: 'standard', useLawnCostFloor: true, includeHiddenTiers: false });
    const legacy = mapV1ToLegacyShape({
      lineItems: [result],
      totals: {},
      pricingVersion: 'test',
    });
    const lifted = (legacy.results?.lawn || legacy.lawn || []).find((t) => t.v === 6);
    expect(lifted).toBeTruthy();
    expect(lifted.cadenceLadderLiftApplied).toBe(true);
    expect(lifted.pricingSource).toBe('CADENCE_LADDER_LIFT');
  });

  it('disarmed floors change nothing (prod default path stays bit-identical)', () => {
    const by = tiersByVisits(priceLawnCare({ lawnSqFt: 12000 }, { tier: 'standard' }));
    for (const v of [6, 9, 12]) {
      expect(by[v].cadenceLadderLiftApplied).toBeUndefined();
      expect(by[v].annual).toBe(by[v].marketAnnual);
    }
  });

  it('a rolled-back discount skips the lift (pre-discount floor behavior)', () => {
    LAWN_PRICING_V2.cadenceFreqDiscountArmed = false;
    const by = tiersByVisits(priceLawnCare({ lawnSqFt: 12000 }, { tier: 'standard', useLawnCostFloor: true }));
    for (const v of [6, 9, 12]) {
      expect(by[v].cadenceLadderLiftApplied).toBeUndefined();
    }
  });
});

describe('one-time lawn anchors on the undiscounted 6x column (codex r4 P1)', () => {
  it('derives its base from the standard per-app, not the discounted selected cadence', () => {
    // 20,000 sqft st_augustine: 9x per-app fell 186.67 -> 174.67 under the
    // discount; the 6x anchor per-app (182) never moved. A standalone
    // treatment makes no frequency commitment and must not inherit the
    // recurring discount.
    const standardPerApp = tiersByVisits(priceLawnCare({ lawnSqFt: 20000 }, { tier: 'standard' }))[6].perApp;
    const ot = priceOneTimeLawn({ lawnSqFt: 20000 }, { treatmentType: 'weed' });
    expect(ot.baselinePerApp).toBe(standardPerApp);
  });

  it('the requested plan cadence no longer changes the one-time base', () => {
    const otDefault = priceOneTimeLawn({ lawnSqFt: 20000 }, { treatmentType: 'weed' });
    const otPremium = priceOneTimeLawn({ lawnSqFt: 20000 }, { treatmentType: 'weed', tier: 'premium', lawnFreq: 12 });
    expect(otPremium.price).toBe(otDefault.price);
    expect(otPremium.baselinePerApp).toBe(otDefault.baselinePerApp);
  });
});
