// The Tree & Shrub "Service Details" guide must not contradict the live T&S protocol
// (granular calendar feeding, no Dominion, selective root-zone insect use, palm
// fertilizer, tree-size answer) or its own header ban on deep-root claims. Owner 2026-10-26.
jest.mock('../models/db', () => jest.fn());
const { SERVICE_DETAILS_COPY } = require('../services/estimate-service-details');

const tsCopy = SERVICE_DETAILS_COPY.tree_shrub;
const tsText = JSON.stringify(tsCopy);

describe('tree & shrub guide matches the protocol', () => {
  test.each([
    'deep-root applications',
    'soil drenches',
    'Foliar feeding delivers',
    'product-dominion-2l.png',
    'a mature oak can be treated',
    'quoted by palm species',
  ])('no longer says "%s"', (phrase) => {
    expect(tsText).not.toContain(phrase);
  });

  test('has no productImages block (the protocol never names Dominion)', () => {
    expect(tsCopy.productImages).toBeUndefined();
    expect(tsText).not.toMatch(/Dominion/i);
  });

  test.each([
    'Slow-release granular feedings: palm fertilizer spread under the canopy, and a bed and shrub feeding in spring and late fall, outside the summer limits. Iron or manganese only where new growth shows a shortage',
    'Mostly through the soil: slow-release palm fertilizer under the canopy, a bed and shrub feeding in spring and late fall, and iron or manganese only where new growth shows a shortage. A yellow plant gets a look before any extra nutrient, because yellow has a dozen causes and most are not hunger.',
    'On tree size: root-zone insect treatments reach large trees, and we use them only where a pest history calls for it, within each product\'s yearly label limit; foliar and contact applications are limited to canopy we can reach safely and effectively from the ground.',
    'Palms get controlled-release palm fertilizer on the program, at least three months apart, using analyses',
    'quoted by the treatment needed, palm size, and the number of palms',
  ])('says "%s"', (phrase) => {
    expect(tsText).toContain(phrase);
  });
});
