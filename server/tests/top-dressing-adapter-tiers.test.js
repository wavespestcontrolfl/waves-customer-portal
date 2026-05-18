const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

describe('top dressing adapter tiers', () => {
  test('maps server-authoritative 1/8 and 1/4 tiers for the admin estimate UI', () => {
    const estimate = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 8000,
      measuredTurfSf: 8000,
      propertyType: 'single_family',
      zone: 'A',
      features: {
        shrubs: 'moderate',
        trees: 'moderate',
        complexity: 'moderate',
        pool: false,
        poolCage: false,
        largeDriveway: false,
        nearWater: false,
      },
      services: {
        lawn: { track: 'st_augustine', tier: 'standard' },
        topDressing: { depth: 'eighth' },
      },
      recurringCustomer: false,
      paymentMethod: 'card',
    });

    const mapped = mapV1ToLegacyShape(estimate);
    const topDressingItem = mapped.oneTime.items.find(
      (item) => item.service === 'top_dressing',
    );

    expect(topDressingItem).toMatchObject({
      name: 'Top Dressing',
      price: 271,
    });
    expect(mapped.results.tdTiers).toEqual([
      { name: '1/8" Depth', price: 271, detail: 'St. Augustine standard' },
      { name: '1/4" Depth', price: 543, detail: 'Bermuda / leveling — 2x material' },
    ]);
  });

  test('maps recurring-customer one-time discounts onto both Top Dressing tiers', () => {
    const estimate = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 8000,
      measuredTurfSf: 8000,
      propertyType: 'single_family',
      zone: 'A',
      features: {
        shrubs: 'moderate',
        trees: 'moderate',
        complexity: 'moderate',
        pool: false,
        poolCage: false,
        largeDriveway: false,
        nearWater: false,
      },
      services: {
        lawn: { track: 'st_augustine', tier: 'standard' },
        topDressing: { depth: 'eighth' },
      },
      recurringCustomer: true,
      paymentMethod: 'card',
    });

    const mapped = mapV1ToLegacyShape(estimate);
    const topDressingItem = mapped.oneTime.items.find(
      (item) => item.service === 'top_dressing',
    );

    expect(mapped.isRecurringCustomer).toBe(true);
    expect(topDressingItem).toMatchObject({
      name: 'Top Dressing',
      price: 230.35,
    });
    expect(mapped.oneTime.total).toBe(230.35);
    expect(mapped.results.tdTiers).toEqual([
      { name: '1/8" Depth', price: 230.35, detail: 'St. Augustine standard' },
      { name: '1/4" Depth', price: 461.55, detail: 'Bermuda / leveling — 2x material' },
    ]);
  });
});
