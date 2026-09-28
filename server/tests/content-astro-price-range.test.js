// Cost-guide price card (owner D1, 2026-09-27): the autonomous publisher sets
// `price_range` deterministically, and the Astro build FAILS on an unknown
// key — so every mapped key must be one the portal's own public pricing feed
// publishes, and anything else must fail closed to "no price_range".
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { costGuidePriceRange, SERVICE_PRICE_KEYS } = require('../services/content-astro/price-range');
const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');

const cost = (overrides = {}) => ({ post_type: 'cost', category: 'pest-control', title: 'What It Costs', ...overrides });

describe('costGuidePriceRange', () => {
  test('every mapped key is published by the portal pricing feed (a renamed key fails here, not in the hub build)', () => {
    // termite_bond publishes only behind its purchase gate; with the gate off
    // it is dropped at publish time like any other unpublished key.
    const prior = process.env.GATE_TERMITE_BOND_OPTION;
    process.env.GATE_TERMITE_BOND_OPTION = 'true';
    try {
      const published = new Set(computePublicPricingRanges({ refresh: true }).services.map((row) => row.key));
      const mapped = new Set(SERVICE_PRICE_KEYS.flatMap((rule) => rule.keys));
      expect([...mapped].filter((key) => !published.has(key))).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.GATE_TERMITE_BOND_OPTION;
      else process.env.GATE_TERMITE_BOND_OPTION = prior;
      computePublicPricingRanges({ refresh: true });
    }
  });

  test.each([
    ['termite treatment cost', ['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching']],
    ['how much do rats cost to remove', ['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion']],
    ['bed bug treatment cost', ['bed_bug_treatment']],
    ['flea treatment cost', ['flea_elimination']],
    ['wasp nest removal cost', ['wasp_hornet_removal']],
    ['mosquito control cost', ['mosquito_program', 'one_time_mosquito']],
    ['lawn care cost', ['lawn_care_program', 'one_time_lawn']],
    ['pest control cost', ['general_pest_quarterly', 'one_time_pest']],
    // A product the feed prices on its own row wins over its family's plans.
    ['wdo inspection cost', ['wdo_inspection']],
    ['rodent inspection cost', ['rodent_inspection']],
    ['german cockroach treatment cost', ['german_roach_cleanout', 'german_roach_initial']],
    ['chinch bug treatment cost', ['lawn_pest_knockdown']],
    ['lawn dethatching cost', ['dethatching']],
  ])('a cost guide for "%s" gets that service\'s keys from the live feed', (primary_keyword, expected) => {
    expect(costGuidePriceRange(cost({ primary_keyword }))).toEqual(expected);
  });

  test('the title names the service when the keyword does not; the category alone never does', () => {
    expect(costGuidePriceRange(cost({ primary_keyword: 'cost guide venice', title: 'What Rodent Control Costs in Venice' })))
      .toEqual(['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion']);
    // Named no service → no card, even filed under a priced category.
    expect(costGuidePriceRange(cost({ primary_keyword: 'price guide venice', title: 'Price Guide for Venice Homes', category: 'lawn-care' })))
      .toBeNull();
  });

  test('no card where the feed has no honest row: commercial work, standalone termite inspections', () => {
    expect(costGuidePriceRange(cost({ primary_keyword: 'commercial pest control cost' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'restaurant pest control cost' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'termite inspection cost', category: 'termite' }))).toBeNull();
  });

  test('a non-cost post gets no price_range, whatever it is about', () => {
    expect(costGuidePriceRange({ post_type: 'diagnostic', category: 'termite', primary_keyword: 'termite treatment cost' })).toBeNull();
    expect(costGuidePriceRange({ category: 'termite', primary_keyword: 'termite treatment cost' })).toBeNull();
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
