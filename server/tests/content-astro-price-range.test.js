// Cost-guide price card (owner D1, 2026-09-27): the autonomous publisher sets
// `price_range` deterministically, and the Astro build FAILS on an unknown
// key — so every mapped key must be one the portal's own public pricing feed
// publishes, and anything else must fail closed to "no price_range".
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { costGuidePriceRange, applyCostGuidePriceRange, CANONICAL_PRICE_PHRASES } = require('../services/content-astro/price-range');
const { computePublicPricingRanges, PURCHASE_GATED_ROWS } = require('../services/pricing-engine/public-ranges');
const { COMMERCIAL_RISK_TYPES, COMMERCIAL_RISK_TYPE_TERMS } = require('../services/pricing-engine/commercial-risk-type');

const cost = (overrides = {}) => ({ post_type: 'cost', category: 'pest-control', title: 'What It Costs', ...overrides });
const PHRASES = Object.entries(CANONICAL_PRICE_PHRASES);

describe('costGuidePriceRange (precision-first canonical phrases)', () => {
  test('every allowlisted key is published by the portal pricing feed (a renamed key fails here, not in the hub build)', () => {
    const published = new Set(computePublicPricingRanges({ refresh: true }).services.map((row) => row.key));
    const mapped = new Set(PHRASES.flatMap(([, keys]) => keys));
    expect([...mapped].filter((key) => !published.has(key))).toEqual([]);
  });

  test('no allowlisted key is purchase-gated: a frozen key would outlive the gate (set derived from public-ranges)', () => {
    const gated = Object.keys(PURCHASE_GATED_ROWS);
    expect(gated.length).toBeGreaterThan(0);
    expect(PHRASES.filter(([, keys]) => keys.some((key) => gated.includes(key)))).toEqual([]);
  });

  test('no allowlisted key is a monthly/yearly plan total — the card shows per-application or per-job prices (read from the feed row unit)', () => {
    const units = new Map(computePublicPricingRanges({ refresh: true }).services.map((row) => [row.key, row.unit]));
    const planTotals = [...units].filter(([, unit]) => /\bper (?:month|year)\b/.test(unit)).map(([key]) => key);
    expect(planTotals).toEqual(expect.arrayContaining(['tree_shrub_care']));
    expect(PHRASES.filter(([, keys]) => keys.some((key) => planTotals.includes(key)))).toEqual([]);
    expect(costGuidePriceRange(cost({ primary_keyword: 'tree and shrub care cost' }))).toBeNull();
    // A kept list loses a plan-total key too (checked against the live feed's unit).
    expect(applyCostGuidePriceRange(cost(), { price_range: ['tree_shrub_care', 'palm_injection'] }).price_range)
      .toEqual(['palm_injection']);
    expect(applyCostGuidePriceRange(cost(), { price_range: ['tree_shrub_care'] })).not.toHaveProperty('price_range');
  });

  test.each(PHRASES)('"%s" gets its rows bare, with a city/state/year suffix, and as a "how much does … cost" question', (phrase, keys) => {
    for (const primary_keyword of [
      phrase,
      `${phrase} cost`,
      `${phrase} cost bradenton fl`,
      `${phrase} prices in lakewood ranch`,
      `${phrase} cost 2026`,
      `how much does ${phrase} cost in sarasota`,
      `what is the average cost of ${phrase} in florida`,
      `${phrase} cost near me`,
    ]) {
      expect([primary_keyword, costGuidePriceRange(cost({ primary_keyword }))]).toEqual([primary_keyword, keys]);
    }
  });

  test('a keyword that is not exactly a canonical phrase gets NO card (the r5 cases and other free text)', () => {
    for (const primary_keyword of [
      // Codex r5: drywood is not subterranean pricing; a pest "in the lawn"
      // is not lawn care; a non-WDO inspection has no feed row.
      'drywood termite treatment cost',
      'fire ant treatment cost for a lawn',
      'ants in the lawn treatment cost',
      'spider treatment cost for lawns',
      'termite inspection cost',
      'termite inspection and treatment cost',
      // Earlier rounds: gated products, no-row services, loose wording.
      'termite bond cost',
      'termite bait station rental cost',
      'wood-destroying termite treatment cost',
      'palm rat removal cost',
      'ant control cost',
      'how much does it cost to get rid of termites',
      'price guide venice',
    ]) {
      expect([primary_keyword, costGuidePriceRange(cost({ primary_keyword }))]).toEqual([primary_keyword, null]);
    }
  });

  test('commercial wording (canonical commercial-risk-type terms) gets no card, in the keyword or the title', () => {
    expect(COMMERCIAL_RISK_TYPES.filter((bucket) => !(COMMERCIAL_RISK_TYPE_TERMS[bucket.value] || []).length)).toEqual([]);
    for (const primary_keyword of [
      'hotel pest control cost', 'retail pest control cost', 'HOA pest control cost', 'multifamily pest control cost',
      'commercial pest control cost', 'restaurant rodent control cost',
    ]) {
      expect(costGuidePriceRange(cost({ primary_keyword }))).toBeNull();
    }
    expect(costGuidePriceRange(cost({ primary_keyword: 'pest control cost', title: 'Pest Control Pricing for Hotels' }))).toBeNull();
    // Hyphenated / "&" terms normalize the same way the keyword and title do.
    expect(costGuidePriceRange(cost({ primary_keyword: 'pest control cost', title: 'Pest Control Costs for Multi-Family Properties' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'multi-family pest control cost' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'pest control cost', title: 'HOA & Common-Area Pest Control Costs' }))).toBeNull();
  });

  test('the primary keyword decides; the title is used only when the keyword is empty; the category never', () => {
    expect(costGuidePriceRange(cost({ primary_keyword: 'pest control cost', title: 'Pest Control Costs With Termite Treatment' })))
      .toEqual(['general_pest_quarterly', 'one_time_pest']);
    // A non-canonical keyword does not fall back to the title.
    expect(costGuidePriceRange(cost({ primary_keyword: 'cost guide venice', title: 'Rodent Exclusion Cost' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: '', title: 'Rodent Exclusion Cost in Venice, FL' }))).toEqual(['rodent_exclusion']);
    expect(costGuidePriceRange(cost({ primary_keyword: 'price guide venice', category: 'lawn-care' }))).toBeNull();
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

  test('a retained list keeps only keys the feed publishes now — never substituted; [] stays []', () => {
    const known = new Set(['termite_trenching', 'termite_bait_install', 'termite_bond']);
    const apply = (price_range, frontmatter = cost({ primary_keyword: 'termite treatment cost' })) =>
      applyCostGuidePriceRange({ ...frontmatter }, { price_range }, { knownKeys: known });
    // A renamed/removed key and a purchase-gated key (even while published) drop.
    expect(apply(['termite_trenching', 'renamed_key', 'termite_bond']).price_range).toEqual(['termite_trenching']);
    // Nothing left → the field is omitted, not replaced by the mapped keys.
    const allStale = apply(['renamed_key', 'termite_bond']);
    expect(allStale).not.toHaveProperty('price_range');
    // An explicit [] (owner cleared the card) stays [].
    expect(apply([]).price_range).toEqual([]);
    // Non-cost posts are checked too: a stale key breaks the build either way.
    expect(apply(['renamed_key'], { post_type: 'diagnostic' })).not.toHaveProperty('price_range');
  });

  test('a retained list is never shipped unchecked or deleted when the feed is down', () => {
    jest.isolateModules(() => {
      jest.doMock('../services/pricing-engine/public-ranges', () => ({
        computePublicPricingRanges: () => { throw new Error('pricing constants unavailable'); },
        PURCHASE_GATED_ROWS: jest.requireActual('../services/pricing-engine/public-ranges').PURCHASE_GATED_ROWS,
      }));
      const isolated = require('../services/content-astro/price-range');
      expect(() => isolated.applyCostGuidePriceRange(cost(), { price_range: ['termite_trenching'] }))
        .toThrow(expect.objectContaining({ code: 'BLOG_PRICE_FEED_UNAVAILABLE' }));
      // No retained list → simply no card.
      expect(isolated.applyCostGuidePriceRange(cost({ primary_keyword: 'pest control cost' }), null)).not.toHaveProperty('price_range');
    });
  });

  test('an incomplete feed (a row whose sweep errored) is treated as unavailable, never as "key removed"', () => {
    jest.isolateModules(() => {
      jest.doMock('../services/pricing-engine/public-ranges', () => ({
        // termite_trenching errored this sweep: it is missing from services
        // but still a real row.
        computePublicPricingRanges: () => ({
          services: [{ key: 'termite_bait_install' }, { key: 'termite_bait_monitoring' }],
          errors: [{ key: 'termite_trenching', message: 'engine signature changed' }],
        }),
        PURCHASE_GATED_ROWS: jest.requireActual('../services/pricing-engine/public-ranges').PURCHASE_GATED_ROWS,
      }));
      const isolated = require('../services/content-astro/price-range');
      expect(() => isolated.applyCostGuidePriceRange(cost(), { price_range: ['termite_trenching'] }))
        .toThrow(expect.objectContaining({ code: 'BLOG_PRICE_FEED_UNAVAILABLE' }));
      expect(isolated.costGuidePriceRange(cost({ primary_keyword: 'termite treatment cost' }))).toBeNull();
    });
  });

  test('fails closed when the pricing feed cannot be computed', () => {
    jest.isolateModules(() => {
      jest.doMock('../services/pricing-engine/public-ranges', () => ({
        computePublicPricingRanges: () => { throw new Error('pricing constants unavailable'); },
        PURCHASE_GATED_ROWS: jest.requireActual('../services/pricing-engine/public-ranges').PURCHASE_GATED_ROWS,
      }));
      const isolated = require('../services/content-astro/price-range');
      expect(isolated.costGuidePriceRange(cost({ primary_keyword: 'pest control cost' }))).toBeNull();
    });
  });
});
