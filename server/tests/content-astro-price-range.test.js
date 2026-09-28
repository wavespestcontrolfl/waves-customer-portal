// Cost-guide price card (owner D1, 2026-09-27): the autonomous publisher sets
// `price_range` deterministically, and the Astro build FAILS on an unknown
// key — so every mapped key must be one the portal's own public pricing feed
// publishes, and anything else must fail closed to "no price_range".
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { costGuidePriceRange, applyCostGuidePriceRange, SERVICE_PRICE_KEYS, GATED_ROW_INTENTS } = require('../services/content-astro/price-range');
const { computePublicPricingRanges, PURCHASE_GATED_ROWS } = require('../services/pricing-engine/public-ranges');
const { COMMERCIAL_RISK_TYPES, COMMERCIAL_RISK_TYPE_TERMS } = require('../services/pricing-engine/commercial-risk-type');

const cost = (overrides = {}) => ({ post_type: 'cost', category: 'pest-control', title: 'What It Costs', ...overrides });

describe('costGuidePriceRange', () => {
  test('every mapped key is published by the portal pricing feed (a renamed key fails here, not in the hub build)', () => {
    const published = new Set(computePublicPricingRanges({ refresh: true }).services.map((row) => row.key));
    const mapped = new Set(SERVICE_PRICE_KEYS.flatMap((rule) => rule.keys));
    expect([...mapped].filter((key) => !published.has(key))).toEqual([]);
  });

  test('no mapped key is purchase-gated: a frozen key would outlive the gate (set derived from public-ranges)', () => {
    const gated = Object.keys(PURCHASE_GATED_ROWS);
    expect(gated.length).toBeGreaterThan(0);
    const mapped = new Set(SERVICE_PRICE_KEYS.flatMap((rule) => rule.keys));
    expect(gated.filter((key) => mapped.has(key))).toEqual([]);
  });

  test('a post naming a gated product gets NO card — never another product\'s prices; every gated row has an intent rule', () => {
    expect(Object.keys(PURCHASE_GATED_ROWS).filter((key) => !GATED_ROW_INTENTS[key])).toEqual([]);
    // Even a feed that publishes the gated rows (gate on) yields nothing.
    const everything = new Set([...SERVICE_PRICE_KEYS.flatMap((rule) => rule.keys), ...Object.keys(PURCHASE_GATED_ROWS)]);
    for (const primary_keyword of ['termite bond cost', 'termite bait station rental cost', 'leased termite bait stations cost']) {
      expect(costGuidePriceRange(cost({ primary_keyword }), { knownKeys: everything })).toBeNull();
      expect(costGuidePriceRange(cost({ primary_keyword }))).toBeNull();
    }
    // Property tenancy wording without station context is not the rental product.
    expect(costGuidePriceRange(cost({ primary_keyword: 'termite treatment cost for rental properties' })))
      .toEqual(['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching']);
    expect(costGuidePriceRange(cost({ primary_keyword: 'termite treatment cost for a leased home' })))
      .toEqual(['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching']);
  });

  test('commercial property buckets (canonical commercial-risk-type terms) get no card, before any residential rule', () => {
    expect(COMMERCIAL_RISK_TYPES.filter((bucket) => !(COMMERCIAL_RISK_TYPE_TERMS[bucket.value] || []).length)).toEqual([]);
    for (const primary_keyword of [
      'hotel pest control cost', 'retail pest control cost', 'HOA pest control cost', 'multifamily pest control cost',
      'apartment complex termite treatment cost', 'restaurant rodent control cost', 'warehouse rodent exclusion cost',
      'daycare pest control cost', 'office building pest control cost', 'commercial pest control cost',
    ]) {
      expect(costGuidePriceRange(cost({ primary_keyword }))).toBeNull();
    }
    // A commercial title also blocks a residential-looking keyword.
    expect(costGuidePriceRange(cost({ primary_keyword: 'pest control cost', title: 'Pest Control Pricing for Hotels' }))).toBeNull();
  });

  const TERMITE_ALL = ['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching'];
  const RODENT_ALL = ['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion'];
  // A post naming a priced variant gets ONLY that variant's row(s); a post
  // naming just the family gets the family's rows.
  test.each([
    // termite
    ['termite treatment cost', TERMITE_ALL],
    ['termite trenching cost', ['termite_trenching']],
    ['liquid termite barrier cost', ['termite_trenching']],
    ['termite bait station cost', ['termite_bait_install', 'termite_bait_monitoring']],
    ['termite bait installation cost', ['termite_bait_install']],
    ['termite bait monitoring cost', ['termite_bait_monitoring']],
    ['termite foam treatment cost', ['foam_drill']],
    ['quarterly termite foam program cost', ['recurring_foam']],
    ['pre-slab termite treatment cost', ['pre_slab_termiticide']],
    ['bora-care treatment cost', ['bora_care']],
    ['wdo inspection cost', ['wdo_inspection']],
    ['wood-destroying organism report cost', ['wdo_inspection']],
    ['wdo letter cost for a real estate closing', ['wdo_inspection']],
    // Wood-destroying wording without inspection context is not the WDO report.
    ['wood-destroying termite treatment cost', TERMITE_ALL],
    // Tenancy wording is not the rented-station product (gated products: see below).
    ['termite treatment cost for rental properties', TERMITE_ALL],
    ['termite treatment cost for a leased home', TERMITE_ALL],
    // rodent
    ['rodent control cost', RODENT_ALL],
    ['how much do rats cost to remove', RODENT_ALL],
    ['rodent exclusion cost', ['rodent_exclusion']],
    ['rodent trapping cost', ['rodent_trapping']],
    ['rodent bait station cost', ['rodent_bait_program']],
    ['rat droppings cleanup cost', ['rodent_sanitation']],
    ['rodent inspection cost', ['rodent_inspection']],
    ['rodent guarantee cost', ['rodent_guarantee']],
    ['trap-only rodent monitoring cost', ['trap_only_retainer']],
    ['rodent wire mesh exclusion cost', ['rodent_wire_mesh']],
    ['roof-entry bird box cost', ['rodent_bird_boxes']],
    ['palm rat removal cost', RODENT_ALL],
    ['roof rat removal cost', RODENT_ALL],
    ['palm rat treatment cost', RODENT_ALL],
    // roaches
    ['german cockroach treatment cost', ['german_roach_cleanout', 'german_roach_initial']],
    ['german roach cleanout cost', ['german_roach_cleanout']],
    ['german roach initial service cost', ['german_roach_initial']],
    ['palmetto bug treatment cost', ['cockroach_treatment']],
    // mosquito
    ['mosquito control cost', ['mosquito_program', 'one_time_mosquito']],
    ['one-time mosquito treatment cost', ['one_time_mosquito']],
    ['mosquito program cost', ['mosquito_program']],
    // lawn
    ['lawn care cost', ['lawn_care_program', 'one_time_lawn']],
    ['one-time lawn treatment cost', ['one_time_lawn']],
    ['lawn care program cost', ['lawn_care_program']],
    ['chinch bug treatment cost', ['lawn_pest_knockdown']],
    ['lawn dethatching cost', ['dethatching']],
    ['lawn plugging cost', ['lawn_plugging']],
    ['top dressing cost', ['top_dressing']],
    // general pest
    ['pest control cost', ['general_pest_quarterly', 'one_time_pest']],
    ['one-time pest control cost', ['one_time_pest']],
    ['quarterly pest control cost', ['general_pest_quarterly']],
    ['single-family home pest control cost', ['general_pest_quarterly', 'one_time_pest']],
    ['one-time rat exterminator cost', RODENT_ALL],
    // General-pest species (pest-identification library, service_key 'pest').
    ['ant control cost', ['general_pest_quarterly', 'one_time_pest']],
    ['spider treatment cost', ['general_pest_quarterly', 'one_time_pest']],
    ['silverfish control cost', ['general_pest_quarterly', 'one_time_pest']],
    ['carpenter ant treatment cost', ['general_pest_quarterly', 'one_time_pest']],
    ['one-time ant treatment cost', ['one_time_pest']],
    ['stink bug control plan cost', ['general_pest_quarterly']],
    ['palmetto treatment cost', ['cockroach_treatment']],
    // single-row services
    ['bed bug treatment cost', ['bed_bug_treatment']],
    ['flea treatment cost', ['flea_elimination']],
    ['wasp nest removal cost', ['wasp_hornet_removal']],
    ['palm tree injection cost', ['palm_injection']],
    ['palm injection cost', ['palm_injection']],
    ['palm fertilizer cost', ['palm_injection']],
    ['tree and shrub care cost', ['tree_shrub_care']],
  ])('a cost guide for "%s" gets exactly its named row(s)', (primary_keyword, expected) => {
    expect(costGuidePriceRange(cost({ primary_keyword }))).toEqual(expected);
  });

  test('the primary keyword decides on its own; the title only when the keyword names no service; the category never', () => {
    expect(costGuidePriceRange(cost({ primary_keyword: 'pest control cost', title: 'Pest Control Costs With Termite Treatment' })))
      .toEqual(['general_pest_quarterly', 'one_time_pest']);
    expect(costGuidePriceRange(cost({ primary_keyword: 'cost guide venice', title: 'What Rodent Exclusion Costs in Venice' })))
      .toEqual(['rodent_exclusion']);
    // Named no service → no card, even filed under a priced category.
    expect(costGuidePriceRange(cost({ primary_keyword: 'price guide venice', title: 'Price Guide for Venice Homes', category: 'lawn-care' })))
      .toBeNull();
  });

  test('no card where the feed has no honest row: commercial work, standalone termite inspections', () => {
    expect(costGuidePriceRange(cost({ primary_keyword: 'commercial pest control cost' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'restaurant pest control cost' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'termite inspection cost', category: 'termite' }))).toBeNull();
    // Not a Waves pest (library not_a_pest species, the saw-palmetto plant),
    // or wood-destroying wording with no row: no card.
    expect(costGuidePriceRange(cost({ primary_keyword: 'love bug control cost' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'saw palmetto trimming cost' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'wood-destroying beetle treatment cost' }))).toBeNull();
    // Palms and trees without care context: no card (not a care-program guide).
    expect(costGuidePriceRange(cost({ primary_keyword: 'palm tree removal cost' }))).toBeNull();
    // A no-row keyword stops there — the title does not reopen it.
    expect(costGuidePriceRange(cost({ primary_keyword: 'termite inspection cost', title: 'Termite Treatment Costs' }))).toBeNull();
    expect(costGuidePriceRange(cost({ primary_keyword: 'pest control cost', title: 'Commercial Pest Control Pricing' }))).toBeNull();
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
