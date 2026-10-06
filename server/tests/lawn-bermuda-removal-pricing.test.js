/**
 * Lawn bermuda removal, pricing side (GATE_LAWN_BERMUDA_REMOVAL, owner 2026-10-06).
 *
 * Pins: the estimate add-on stays St. Augustine only; the add-on's two yearly sprays count in the lawn cost, margin and the mapped
 * estimate result; the cost never moves a cost floor; gate off is the old output.
 * Cost per spray = $4.50 per 1,000 sq ft (whole lawn) + (10 + 2.5 per 1,000 sq ft)
 * minutes at the $35 loaded labor rate; two sprays a year.
 */
const { priceLawnCare } = require('../services/pricing-engine/service-pricing');
const { LAWN_BERMUDA_REMOVAL_COST } = require('../services/pricing-engine/constants');

const PROPERTY_5K = { turfSf: 5000 };
// 2 x (4.50 x 5 + ((10 + 2.5 x 5) / 60) x 35) = 2 x (22.5 + 13.125)
const COST_5K = 71.25;
const ADDER_5K = 25;

describe('lawn bermuda removal pricing', () => {
  const saved = { suppression: process.env.GATE_BERMUDA_SUPPRESSION, removal: process.env.GATE_LAWN_BERMUDA_REMOVAL };
  beforeEach(() => { process.env.GATE_BERMUDA_SUPPRESSION = 'true'; delete process.env.GATE_LAWN_BERMUDA_REMOVAL; });
  afterAll(() => {
    for (const [name, value] of [['GATE_BERMUDA_SUPPRESSION', saved.suppression], ['GATE_LAWN_BERMUDA_REMOVAL', saved.removal]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const price = (track, bermudaSuppression = true) => priceLawnCare(PROPERTY_5K, { track, tier: 'enhanced', bermudaSuppression });

  test('the cost constants are the owner prices of 2026-10-06 ($2.82 + $1.61 + $0.07 per 1,000 sq ft)', () => {
    expect(LAWN_BERMUDA_REMOVAL_COST).toMatchObject({ spraysPerYear: 2, productPer1000Sqft: 4.5, laborMinutesBase: 10, laborMinutesPer1000Sqft: 2.5 });
    expect(Math.round((0.03 * 94 + 0.55 * (93.88 / 32) + 0.07) * 100) / 100).toBe(4.5);
  });

  describe('the estimate add-on stays St. Augustine only (owner has given no Zoysia wording)', () => {
    test.each([false, true])('Zoysia, Bermuda and Bahia are ineligible with the removal gate %p: price unchanged, the old note, no add-on cost', (gate) => {
      if (gate) process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
      for (const track of ['zoysia', 'bermuda', 'bahia']) {
        const base = price(track, false);
        const requested = price(track);
        expect(requested.bermudaSuppression).toBeNull();
        expect(requested.annual).toBe(base.annual);
        expect(requested.costs).toEqual(base.costs);
        expect(requested.notes.join(' ')).toMatch(/St\. Augustine lawns only/);
        expect(requested.notes.join(' ')).not.toMatch(/Zoysia/);
      }
    });

    test('St. Augustine is priced with the adder whatever the removal gate says', () => {
      for (const gate of [undefined, 'true']) {
        if (gate) process.env.GATE_LAWN_BERMUDA_REMOVAL = gate; else delete process.env.GATE_LAWN_BERMUDA_REMOVAL;
        expect(price('st_augustine').bermudaSuppression).toEqual({ perApp: ADDER_5K });
      }
    });
  });

  describe('cost and margin', () => {
    test('gate off: costs, margin and floors are exactly what they were with the add-on', () => {
      const withAddon = price('st_augustine');
      const plain = price('st_augustine', false);
      expect(withAddon.costs).toEqual(plain.costs);
      expect(withAddon.costs.annualBermudaRemoval).toBeUndefined();
      expect(withAddon.tiers.every((t) => t.bermudaRemovalAnnualCost === undefined)).toBe(true);
    });

    test.each(['st_augustine'])('gate on, %s: two sprays of product plus labor join the cost and lower the margin', (track) => {
      process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
      const plain = price(track, false);
      const withAddon = price(track);
      expect(withAddon.costs.annualBermudaRemoval).toBe(COST_5K);
      expect(withAddon.costs.total).toBeCloseTo(plain.costs.total + COST_5K, 2);
      // Revenue rose by the adder x visits; the margin is (annual - cost) / annual on the new numbers.
      const expected = (withAddon.annual - withAddon.costs.total) / withAddon.annual;
      expect(withAddon.margin).toBeCloseTo(expected, 3);
      expect(withAddon.tiers.every((t) => t.bermudaRemovalAnnualCost === COST_5K)).toBe(true);
    });

    test('the add-on never moves a cost floor (floor details, floor annual and minimum collected price are identical)', () => {
      process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
      const plain = price('st_augustine', false);
      const withAddon = price('st_augustine');
      expect(withAddon.costFloorAnnual).toBe(plain.costFloorAnnual);
      expect(withAddon.minimumCollectedAnnualPrice).toBe(plain.minimumCollectedAnnualPrice);
      for (const tier of withAddon.tiers) {
        const baseTier = plain.tiers.find((t) => t.tier === tier.tier);
        expect(tier.costFloorDetails).toEqual(baseTier.costFloorDetails);
        expect(tier.costFloorAnnual).toBe(baseTier.costFloorAnnual);
      }
      // Armed floors price off the floor, then the adder rides on top: still the floor + adder.
      const armedPlain = priceLawnCare(PROPERTY_5K, { track: 'st_augustine', tier: 'enhanced', useLawnCostFloor: true });
      const armed = priceLawnCare(PROPERTY_5K, { track: 'st_augustine', tier: 'enhanced', useLawnCostFloor: true, bermudaSuppression: true });
      expect(armed.annual).toBeCloseTo(armedPlain.annual + ADDER_5K * armed.frequency, 2);
    });

    test('cost scales with lawn size', () => {
      process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
      const big = priceLawnCare({ turfSf: 10000 }, { track: 'st_augustine', tier: 'enhanced', bermudaSuppression: true });
      // 2 x (4.50 x 10 + ((10 + 25) / 60) x 35)
      expect(big.costs.annualBermudaRemoval).toBe(Math.round(2 * (45 + (35 / 60) * 35) * 100) / 100);
    });

    test('the mapped estimate result carries the cost and the per-tier margin counts it', () => {
      process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
      const pricingEngine = require('../services/pricing-engine');
      const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
      const run = (bermudaSuppression) => mapV1ToLegacyShape(pricingEngine.generateEstimate({
        turfSf: 5000, homeSqFt: 2000,
        services: { lawn: { track: 'st_augustine', tier: 'enhanced', bermudaSuppression } },
      })).results;
      const withAddon = run(true);
      const plain = run(false);
      const k = withAddon.lawnMeta.lsf / 1000;
      expect(withAddon.lawnMeta.costs.annualBermudaRemoval).toBe(Math.round(2 * (4.5 * k + ((10 + 2.5 * k) / 60) * 35) * 100) / 100);
      expect(plain.lawnMeta.costs.annualBermudaRemoval).toBeUndefined();
      const tier = withAddon.lawn.find((t) => t.recommended);
      const withoutAddonCost = 1 - (withAddon.lawnMeta.costs.total - withAddon.lawnMeta.costs.annualBermudaRemoval) / tier.ann;
      expect(tier.prov.margin).toBeLessThan(withoutAddonCost);
      expect(tier.prov.margin).toBeCloseTo((tier.ann - (withAddon.lawnMeta.costs.total)) / tier.ann, 2);
    });
  });
});
