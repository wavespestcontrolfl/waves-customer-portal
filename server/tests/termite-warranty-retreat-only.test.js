// Owner ruling 2026-11-25 ("retreatment only until insurance confirms a cap"): Waves stops selling termite
// damage-repair coverage on new work. The trenching tier keys stay so saved estimates replay, and prices stay;
// what the tiers promise is retreatment only. This pins the customer- and staff-facing strings.
const constants = require('../services/pricing-engine/constants');
const { priceTrenching } = require('../services/pricing-engine/service-pricing');

describe('termite warranty is retreatment only', () => {
  const tiers = constants.SPECIALTY.trenching.warrantyTiers;

  test('no trenching tier label says repair, and the long tiers say retreat warranty', () => {
    for (const [key, tier] of Object.entries(tiers)) {
      expect(`${key}: ${tier.label}`.replace(key, '')).not.toMatch(/repair/i);
    }
    expect(tiers.three_year_repair_retreat.label).toBe('3-Year Retreat Warranty');
    expect(tiers.five_year_repair_retreat.label).toBe('5-Year Retreat Warranty');
  });

  test('tier keys and price adders are unchanged so saved estimates replay at the same price', () => {
    expect(tiers.none.priceAdderPct).toBe(0);
    expect(tiers.one_year_retreat.priceAdderPct).toBe(0);
    expect(tiers.three_year_repair_retreat.priceAdderPct).toBe(0.15);
    expect(tiers.five_year_repair_retreat.priceAdderPct).toBe(0.25);
  });

  test('trenching product warnings do not promise repair', () => {
    for (const product of Object.values(constants.SPECIALTY.trenching.products)) {
      expect((product.warnings || []).join(' ')).not.toMatch(/repair/i);
    }
  });

  test.each([
    ['three_year_repair_retreat', 'taurus_sc', '3-Year Retreat Warranty', 0.15],
    ['five_year_repair_retreat', 'taurus_sc', '5-Year Retreat Warranty', 0.25],
    ['three_year_repair_retreat', 'bifen_it', '3-Year Retreat Warranty', 0.15],
  ])('a %s quote on %s says retreatment only and keeps its price adder', (warrantyTier, productKey, label, pct) => {
    const quote = priceTrenching({}, {
      measurements: { perimeterLF: 100, dirtLF: 100, concreteLF: 0 }, productKey, warrantyTier, labelConfirmed: true,
    });
    expect(quote.warrantyTier).toBe(warrantyTier);
    expect(quote.warrantyLabel).toBe(label);
    expect(quote.warrantyAdder).toBe(Math.round(quote.priceBeforeWarranty * pct));
    const customerText = [quote.warrantyLabel, ...(quote.warnings || []), quote.warningText].filter(Boolean).join(' ');
    expect(customerText).not.toMatch(/repair/i);
  });
});
