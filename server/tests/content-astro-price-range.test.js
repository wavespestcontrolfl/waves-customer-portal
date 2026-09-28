// Cost-guide price card (owner D1, 2026-09-27): the autonomous publisher sets
// `price_range` deterministically, and the Astro build FAILS on an unknown
// key — so every mapped key must be one the portal's own public pricing feed
// publishes, and anything else must fail closed to "no price_range".
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { costGuidePriceRange, SERVICE_PRICE_KEYS, CATEGORY_PRICE_KEYS } = require('../services/content-astro/price-range');
const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');

const cost = (overrides = {}) => ({ post_type: 'cost', category: 'pest-control', title: 'What It Costs', ...overrides });

describe('costGuidePriceRange', () => {
  test('every mapped key is published by the portal pricing feed (a renamed key fails here, not in the hub build)', () => {
    const published = new Set(computePublicPricingRanges({ refresh: true }).services.map((row) => row.key));
    const mapped = new Set([
      ...SERVICE_PRICE_KEYS.flatMap((rule) => rule.keys),
      ...Object.values(CATEGORY_PRICE_KEYS).flat(),
    ]);
    expect([...mapped].filter((key) => !published.has(key))).toEqual([]);
  });

  test.each([
    ['termite treatment cost', 'termite', ['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching']],
    ['rodent control cost', 'pest-control', ['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion']],
    ['bed bug treatment cost', 'pest-control', ['bed_bug_treatment']],
    ['flea treatment cost', 'pest-control', ['flea_elimination']],
    ['wasp nest removal cost', 'pest-control', ['wasp_hornet_removal']],
    ['mosquito control cost', 'mosquito', ['mosquito_program', 'one_time_mosquito']],
    ['lawn care cost', 'lawn-care', ['lawn_care_program', 'one_time_lawn']],
    ['pest control cost', 'pest-control', ['general_pest_quarterly', 'one_time_pest']],
  ])('a cost guide for "%s" gets its service keys from the live feed', (primary_keyword, category, expected) => {
    expect(costGuidePriceRange(cost({ primary_keyword, category }))).toEqual(expected);
  });

  test('the post keyword decides before its category, and the category is the fallback', () => {
    // A rodent cost guide filed under pest-control is a rodent guide.
    expect(costGuidePriceRange(cost({ primary_keyword: 'how much do rats cost to remove', category: 'pest-control' })))
      .toEqual(['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion']);
    // No service named in keyword or title → the category's keys.
    expect(costGuidePriceRange(cost({ primary_keyword: 'price guide venice', title: 'Price Guide for Venice Homes', category: 'lawn-care' })))
      .toEqual(['lawn_care_program', 'one_time_lawn']);
  });

  test('a non-cost post gets no price_range, whatever it is about', () => {
    expect(costGuidePriceRange({ post_type: 'diagnostic', category: 'termite', primary_keyword: 'termite treatment cost' })).toBeNull();
    expect(costGuidePriceRange({ category: 'termite', primary_keyword: 'termite treatment cost' })).toBeNull();
  });

  test('a cost guide with no mapped service gets no price_range', () => {
    expect(costGuidePriceRange(cost({ category: 'seasonal', primary_keyword: 'price guide venice', title: 'Price Guide' }))).toBeNull();
  });

  test('fails closed: a mapped key the feed does not publish is dropped, and none left means no price_range', () => {
    const termite = cost({ category: 'termite', primary_keyword: 'termite treatment cost' });
    expect(costGuidePriceRange(termite, { knownKeys: new Set(['termite_bait_install', 'termite_bait_monitoring']) }))
      .toEqual(['termite_bait_install', 'termite_bait_monitoring']);
    expect(costGuidePriceRange(termite, { knownKeys: new Set() })).toBeNull();
  });

  test('fails closed when the pricing feed cannot be computed', () => {
    jest.isolateModules(() => {
      jest.doMock('../services/pricing-engine/public-ranges', () => ({
        computePublicPricingRanges: () => { throw new Error('pricing constants unavailable'); },
      }));
      const isolated = require('../services/content-astro/price-range');
      expect(isolated.costGuidePriceRange(cost({ primary_keyword: 'pest control cost' }))).toBeNull();
    });
  });
});
