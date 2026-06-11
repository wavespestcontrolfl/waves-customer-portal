/**
 * Unit tests for the pure helpers exported by gsc-opportunity-miner.
 *
 * No DB / no network. Each test calls the bare function with controlled
 * inputs and asserts the deterministic output. The async bucket miners
 * are not exercised here — they hit gsc_queries/gsc_pages and are
 * validated by the smoke-test script against real data.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const {
  normalizeCity,
  inferServiceFromQuery,
  inferServiceFromUrl,
  inferCityFromUrl,
  inferCityFromQuery,
  canonicalizePageUrl,
  inferPageType,
  recomputeCtr,
  gscOpportunityScore,
  localRevenueScore,
  conversionIntentScore,
  impressionsBoost,
  actionForOpportunity,
  dedupeKey,
  scoreOpportunity,
} = require('../services/seo/gsc-opportunity-miner')._internals;

const { WEIGHTS } = require('../services/content/scoring-config');

// ── normalizeCity ────────────────────────────────────────────────────

describe('normalizeCity', () => {
  test.each([
    ['bradenton', 'Bradenton'],
    ['Bradenton', 'Bradenton'],
    ['lakewood_ranch', 'Lakewood Ranch'],
    ['lakewood-ranch', 'Lakewood Ranch'],
    ['Port Charlotte', 'Port Charlotte'],
  ])('canonicalizes %j → %j', (input, expected) => {
    expect(normalizeCity(input)).toBe(expected);
  });

  test.each([
    ['local_intent', null],
    ['unknown', null],
    ['none', null],
    ['', null],
    [null, null],
    [undefined, null],
    ['tampa', null], // not a Waves service city
  ])('rejects non-city / overload values: %j → %j', (input, expected) => {
    expect(normalizeCity(input)).toBe(expected);
  });
});

// ── inferServiceFromQuery ────────────────────────────────────────────

describe('inferServiceFromQuery', () => {
  test('matches termite-specific terms', () => {
    expect(inferServiceFromQuery('termite inspection bradenton')).toBe('termite');
    expect(inferServiceFromQuery('wdo report')).toBe('termite');
  });
  test('matches rodent variants', () => {
    expect(inferServiceFromQuery('rat in attic')).toBe('rodent');
    expect(inferServiceFromQuery('mice control near me')).toBe('rodent');
  });
  test('falls back to generic pest for "exterminator"', () => {
    expect(inferServiceFromQuery('exterminator bradenton fl')).toBe('pest');
  });
  test('matches lawn for fertilizer / aeration', () => {
    expect(inferServiceFromQuery('lawn fertilizer service')).toBe('lawn');
    expect(inferServiceFromQuery('lawn aeration sarasota')).toBe('lawn');
  });
  test('returns null for non-service queries', () => {
    expect(inferServiceFromQuery('best restaurants bradenton')).toBeNull();
    expect(inferServiceFromQuery('')).toBeNull();
    expect(inferServiceFromQuery(null)).toBeNull();
  });
});

// ── inferServiceFromUrl + inferCityFromUrl ──────────────────────────

describe('URL inference', () => {
  test('reads service from city-service slug', () => {
    expect(inferServiceFromUrl('https://www.wavespestcontrol.com/mosquito-control-bradenton-fl/')).toBe('mosquito');
    expect(inferServiceFromUrl('https://www.wavespestcontrol.com/termite-inspection-sarasota-fl/')).toBe('termite');
  });
  test('reads city from city-service slug', () => {
    expect(inferCityFromUrl('https://www.wavespestcontrol.com/pest-control-bradenton-fl/')).toBe('Bradenton');
    expect(inferCityFromUrl('https://www.wavespestcontrol.com/lawn-care-lakewood-ranch-fl/')).toBe('Lakewood Ranch');
  });
  test('returns null on non-service URLs', () => {
    expect(inferServiceFromUrl('https://www.wavespestcontrol.com/about/')).toBeNull();
    expect(inferCityFromUrl('https://www.wavespestcontrol.com/about/')).toBeNull();
  });
});

// ── canonicalizePageUrl (collapse GBP/UTM tracking-link variants) ───
describe('canonicalizePageUrl', () => {
  test('strips a GBP/UTM tracking query so it collapses to the canonical path', () => {
    expect(canonicalizePageUrl(
      'https://www.wavespestcontrol.com/pest-control-sarasota-fl/?utm_source=gbp&utm_medium=organic&utm_campaign=website-link&utm_content=sarasota-profile'
    )).toBe('https://www.wavespestcontrol.com/pest-control-sarasota-fl/');
  });

  test('a clean URL is unchanged (and matches its tracking variant)', () => {
    const clean = 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/';
    expect(canonicalizePageUrl(clean)).toBe(clean);
    expect(canonicalizePageUrl(`${clean}?utm_source=gbp`)).toBe(clean);
  });

  test('strips a fragment as well', () => {
    expect(canonicalizePageUrl('https://x/p/#section')).toBe('https://x/p/');
  });

  test('passes through null/empty without throwing', () => {
    expect(canonicalizePageUrl(null)).toBeNull();
    expect(canonicalizePageUrl('')).toBe('');
  });
});

// ── inferPageType (URL fallback per Step-0 finding) ─────────────────

describe('inferPageType', () => {
  test('honors declared page_type when present', () => {
    expect(inferPageType('https://x/blog/foo/', 'service')).toBe('service');
  });
  test('detects /blog/ URLs even when declared is null', () => {
    expect(inferPageType('https://www.wavespestcontrol.com/blog/get-rid-of-ghost-ants/', null)).toBe('blog');
  });
  test('detects city-service slug as city', () => {
    expect(inferPageType('https://www.wavespestcontrol.com/pest-control-bradenton-fl/', null)).toBe('city');
  });
  test('detects static pages', () => {
    expect(inferPageType('https://www.wavespestcontrol.com/about/', null)).toBe('static');
  });
});

// ── recomputeCtr (Step-0 trust issue) ───────────────────────────────

describe('recomputeCtr', () => {
  test('uses clicks/impressions, not stored ctr', () => {
    expect(recomputeCtr(10, 100)).toBeCloseTo(0.1);
    expect(recomputeCtr(0, 100)).toBe(0);
    expect(recomputeCtr(5, 0)).toBe(0);   // divide-by-zero protection
    expect(recomputeCtr(null, null)).toBe(0);
  });
});

// ── scoring math ────────────────────────────────────────────────────

describe('impressionsBoost', () => {
  test('higher impressions → higher boost', () => {
    expect(impressionsBoost(500)).toBe(1.0);
    expect(impressionsBoost(200)).toBe(0.85);
    expect(impressionsBoost(100)).toBe(0.7);
    expect(impressionsBoost(60)).toBe(0.55);
  });
  test('below threshold → zero boost', () => {
    expect(impressionsBoost(10)).toBe(0);
    expect(impressionsBoost(0)).toBe(0);
  });
});

describe('gscOpportunityScore', () => {
  test('striking_distance: closer to top = higher', () => {
    const closeIn = gscOpportunityScore('striking_distance', 4, 1.0);
    const farOut = gscOpportunityScore('striking_distance', 15, 1.0);
    expect(closeIn).toBeGreaterThan(farOut);
  });
  test('unknown bucket returns 0', () => {
    expect(gscOpportunityScore('made_up_bucket', 5, 1.0)).toBe(0);
  });
  test('aeo_gap scales with impressions boost', () => {
    expect(gscOpportunityScore('aeo_gap', 20, 1.0))
      .toBeGreaterThan(gscOpportunityScore('aeo_gap', 20, 0.55));
  });
});

describe('localRevenueScore', () => {
  test('termite > pest > tree-shrub', () => {
    expect(localRevenueScore('termite')).toBeGreaterThan(localRevenueScore('pest'));
    expect(localRevenueScore('pest')).toBeGreaterThan(localRevenueScore('tree-shrub'));
  });
  test('unknown service uses default weight (0.5 × W)', () => {
    expect(localRevenueScore('chimney-sweep')).toBe(Math.round(WEIGHTS.localRevenue * 0.5));
  });
});

describe('conversionIntentScore', () => {
  test('emergency intent scores highest', () => {
    expect(conversionIntentScore('emergency pest control near me')).toBe(WEIGHTS.conversionIntent);
  });
  test('transactional intent scores high', () => {
    expect(conversionIntentScore('pest control cost bradenton'))
      .toBeGreaterThan(conversionIntentScore('signs of termite damage'));
  });
  test('informational intent scores low', () => {
    expect(conversionIntentScore('how to identify a termite'))
      .toBeLessThan(WEIGHTS.conversionIntent * 0.5);
  });
});

// ── actionForOpportunity ────────────────────────────────────────────

describe('actionForOpportunity', () => {
  test('near-me / transactional queries NEVER become blog posts (operator directive 2026-06-11)', () => {
    for (const q of ['exterminator near me', 'rat removal near me', 'pest control near-me', 'exterminator nearby', 'NEAR ME exterminator']) {
      expect(actionForOpportunity({ bucket: 'seasonal_rising', query: q })).toBe('do_not_publish');
      expect(actionForOpportunity({ bucket: 'striking_distance', query: q })).toBe('do_not_publish');
      expect(actionForOpportunity({ bucket: 'no_content_yet', query: q })).toBe('do_not_publish');
      expect(actionForOpportunity({ bucket: 'aeo_gap', query: q })).toBe('do_not_publish');
    }
  });
  test('near-me WITH city+service routes to the city-service lane instead of being dropped', () => {
    expect(actionForOpportunity({ bucket: 'seasonal_rising', query: 'exterminator near me sarasota', city: 'Sarasota', service: 'pest' }))
      .toBe('create_or_refresh_city_service_page');
  });
  test('near-me queries with an existing page still refresh — proximity terms are fine on PAGES', () => {
    expect(actionForOpportunity({ bucket: 'seasonal_rising', query: 'exterminator near me', page_url: 'x' }))
      .toBe('refresh_existing_page');
    expect(actionForOpportunity({ bucket: 'striking_distance', query: 'pest control near me', city: 'Bradenton', service: 'pest' }))
      .toBe('create_or_refresh_city_service_page');
  });
  test('informational queries keep the blog action', () => {
    expect(actionForOpportunity({ bucket: 'seasonal_rising', query: 'how to read a termite bond' }))
      .toBe('new_supporting_blog');
    expect(actionForOpportunity({ bucket: 'seasonal_rising', query: 'do i have to use hometeam pest defense' }))
      .toBe('new_supporting_blog');
  });
  test('cannibalization always do_not_publish', () => {
    expect(actionForOpportunity({ bucket: 'cannibalization', query: 'x', service: 'pest', city: 'Bradenton' }))
      .toBe('do_not_publish');
  });
  test('page_type_mismatch always do_not_publish (human review)', () => {
    expect(actionForOpportunity({ bucket: 'page_type_mismatch', page_url: 'x', service: 'pest', city: 'Bradenton' }))
      .toBe('do_not_publish');
  });
  test('ctr_rewrite with page → rewrite_title_meta', () => {
    expect(actionForOpportunity({ bucket: 'ctr_rewrite', page_url: 'x', service: 'pest', city: 'Bradenton' }))
      .toBe('rewrite_title_meta');
  });
  test('decay_refresh with page → refresh_existing_page', () => {
    expect(actionForOpportunity({ bucket: 'decay_refresh', page_url: 'x', service: 'pest', city: 'Bradenton' }))
      .toBe('refresh_existing_page');
  });
  test('local_gap → create_or_refresh_city_service_page', () => {
    expect(actionForOpportunity({ bucket: 'local_gap', service: 'pest', city: 'Bradenton' }))
      .toBe('create_or_refresh_city_service_page');
  });
  test('striking_distance: page present → refresh', () => {
    expect(actionForOpportunity({
      bucket: 'striking_distance', page_url: 'x', service: 'pest', city: 'Bradenton',
    })).toBe('refresh_existing_page');
  });
  test('striking_distance: no page + city+service → city service page', () => {
    expect(actionForOpportunity({
      bucket: 'striking_distance', service: 'pest', city: 'Bradenton',
    })).toBe('create_or_refresh_city_service_page');
  });
  test('striking_distance: no page + no city → supporting blog', () => {
    expect(actionForOpportunity({
      bucket: 'striking_distance', service: 'pest',
    })).toBe('new_supporting_blog');
  });
  test('aeo_gap: page present → refresh_existing_page', () => {
    expect(actionForOpportunity({
      bucket: 'aeo_gap', page_url: '/pest-control-bradenton-fl/', service: 'pest', city: 'Bradenton',
    })).toBe('refresh_existing_page');
  });
  test('aeo_gap: no page + city+service → city service page', () => {
    expect(actionForOpportunity({
      bucket: 'aeo_gap', service: 'pest', city: 'Bradenton',
    })).toBe('create_or_refresh_city_service_page');
  });
});

// ── dedupeKey ───────────────────────────────────────────────────────

describe('dedupeKey', () => {
  test('stable for same inputs regardless of order', () => {
    const k1 = dedupeKey({ bucket: 'striking_distance', service: 'pest', city: 'Bradenton', query: 'pest control bradenton' });
    const k2 = dedupeKey({ bucket: 'striking_distance', service: 'pest', city: 'Bradenton', query: 'pest control bradenton' });
    expect(k1).toBe(k2);
  });
  test('different buckets → different keys', () => {
    const a = dedupeKey({ bucket: 'striking_distance', service: 'pest', city: 'Bradenton', query: 'x' });
    const b = dedupeKey({ bucket: 'ctr_rewrite', service: 'pest', city: 'Bradenton', query: 'x' });
    expect(a).not.toBe(b);
  });
  test('handles missing fields without throwing', () => {
    expect(() => dedupeKey({ bucket: 'no_content_yet', service: 'pest', query: 'x' })).not.toThrow();
  });
  test('lowercases / slugs city for stability', () => {
    const a = dedupeKey({ bucket: 'local_gap', service: 'pest', city: 'Lakewood Ranch' });
    expect(a).toContain('lakewood-ranch');
  });
});

// ── scoreOpportunity integration of breakdown ───────────────────────

describe('scoreOpportunity', () => {
  test('cannibalization gets cannibalizationRisk penalty applied', () => {
    const o = { bucket: 'cannibalization', service: 'pest', query: 'pest control', city: 'Bradenton' };
    const { total, breakdown } = scoreOpportunity(o, { position: 5, impressions: 200 });
    expect(breakdown._penalty).toBe(WEIGHTS.cannibalizationRisk);
    expect(total).toBeLessThan(
      Object.entries(breakdown).filter(([k]) => k !== '_penalty').reduce((a, [, v]) => a + v, 0)
    );
  });
  test('local_gap gets contentGap bonus', () => {
    const o = { bucket: 'local_gap', service: 'pest', city: 'Bradenton' };
    const { breakdown } = scoreOpportunity(o, { position: 25, impressions: 200 });
    expect(breakdown.contentGap).toBe(WEIGHTS.contentGap);
  });
  test('decay_refresh gets refreshLift bonus', () => {
    const o = { bucket: 'decay_refresh', service: 'pest', page_url: '/x/' };
    const { breakdown } = scoreOpportunity(o, { position: 8, impressions: 300 });
    expect(breakdown.refreshLift).toBe(WEIGHTS.refreshLift);
  });
  test('aeo_gap: strong gap (competitors + demand) clears the 75 floor', () => {
    const o = { bucket: 'aeo_gap', service: 'pest', city: 'Bradenton', page_url: '/pest-control-bradenton-fl/' };
    const { total, breakdown } = scoreOpportunity(o, { position: 20, impressions: 500, gapStrength: 1.0 });
    expect(breakdown.aeoGap).toBe(WEIGHTS.aeoGap);
    expect(total).toBeGreaterThanOrEqual(75);
  });
  test('aeo_gap: weak gap (no competitors, thin demand) stays below the floor', () => {
    const o = { bucket: 'aeo_gap', service: 'lawn', city: 'Venice' };
    const { total } = scoreOpportunity(o, { position: 20, impressions: 60, gapStrength: 0.5 });
    expect(total).toBeLessThan(75);
  });
  test('aeo_gap bonus scales with gap_strength', () => {
    const o = { bucket: 'aeo_gap', service: 'pest', city: 'Bradenton' };
    const weak = scoreOpportunity(o, { position: 20, impressions: 200, gapStrength: 0.5 }).breakdown.aeoGap;
    const strong = scoreOpportunity(o, { position: 20, impressions: 200, gapStrength: 1.0 }).breakdown.aeoGap;
    expect(strong).toBeGreaterThan(weak);
  });
  test('higher impressions → higher total score (ceteris paribus)', () => {
    const o = { bucket: 'striking_distance', service: 'pest', query: 'pest control bradenton', city: 'Bradenton' };
    const low = scoreOpportunity(o, { position: 6, impressions: 60 }).total;
    const high = scoreOpportunity(o, { position: 6, impressions: 500 }).total;
    expect(high).toBeGreaterThan(low);
  });
});
