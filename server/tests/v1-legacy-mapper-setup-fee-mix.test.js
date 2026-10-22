// #6438 / EST-2026-1185: the WaveGuard setup fee belongs only to a solo pest
// or solo mosquito plan (owner 2026-10-21: "waived if they do multiple
// services"). The mapper is the writer of oneTime.membershipFee and
// oneTime.total, so a bundle must not cache a fee nobody bills.
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

const property = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };

describe('v1 legacy mapper setup fee by plan mix', () => {
  test('a solo pest plan keeps the setup fee in its one-time total', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate({ ...property, services: { pest: { frequency: 'quarterly' } } }));
    expect(mapped.oneTime.membershipFee).toBeGreaterThan(0);
    expect(mapped.oneTime.total).toBeGreaterThanOrEqual(mapped.oneTime.membershipFee);
  });

  test('a pest + mosquito bundle caches no setup fee and leaves it out of the totals', () => {
    const solo = mapV1ToLegacyShape(generateEstimate({ ...property, services: { pest: { frequency: 'quarterly' } } }));
    const bundle = mapV1ToLegacyShape(generateEstimate({
      ...property,
      services: { pest: { frequency: 'quarterly' }, mosquito: {} },
    }));
    expect(bundle.recurring.services.length).toBeGreaterThan(1);
    expect(bundle.oneTime.membershipFee).toBe(0);
    expect(bundle.oneTime.total).toBe(Math.round((solo.oneTime.total - solo.oneTime.membershipFee) * 100) / 100);
    expect(bundle.totals.year1).toBe(Math.round((bundle.totals.year2 + bundle.oneTime.total) * 100) / 100);
  });
});
