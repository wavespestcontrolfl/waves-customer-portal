// EST-2026-1312 (2026-11-19): the customer estimate page titled a beehive line
// "One-Time Pest Control". The bee/wasp pricers emit stinging_insect and
// stinging_insect_v2, but the mapper's label table knew only stinging and
// stinging_v2, so the stored line kept its raw key as its name and the public
// page swapped that raw key for the pest category label.
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

const property = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };

describe('v1 legacy mapper names the bee and wasp lines', () => {
  test.each([
    ['stinging_insect', { stinging: { species: 'HONEYBEE_NEW', tier: 2 } }],
    ['stinging_insect_v2', { stingingV2: { nestCount: 1, nestType: 'wasp', location: 'eave' } }],
  ])('a %s line is stored as "Stinging Insect", not its raw key', (service, services) => {
    const mapped = mapV1ToLegacyShape(generateEstimate({ ...property, services }));
    const line = mapped.oneTime.specItems.find((item) => item.service === service);
    expect(line).toEqual(expect.objectContaining({ name: 'Stinging Insect' }));
    expect(line.price).toBeGreaterThan(0);
  });
});
