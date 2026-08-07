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
  deriveLinkBoost,
  listicleFamilyKey,
  clusterListicleFamilies,
  listicleFamilyDedupeKey,
  listicleFamilyEligible,
  resolveListicleFamilyServiceCity,
  classifierQuerySupported,
  listicleFamilyRefreshDedupeKey,
  listicleFamilyRepReachable,
  buildListicleFamilyRefreshOpp,
  canonicalizeServiceCategory,
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
  test('link_boost with page → add_internal_links; without page → do_not_publish', () => {
    expect(actionForOpportunity({ bucket: 'link_boost', page_url: 'x', service: 'pest', city: 'Bradenton' }))
      .toBe('add_internal_links');
    expect(actionForOpportunity({ bucket: 'link_boost', query: 'pest control bradenton' }))
      .toBe('do_not_publish');
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

// ── deriveLinkBoost ─────────────────────────────────────────────────

describe('deriveLinkBoost', () => {
  const ctrParent = (over = {}) => ({
    bucket: 'ctr_rewrite',
    action_type: 'rewrite_title_meta',
    query: 'termite inspection sarasota',
    page_url: '/termite-control-sarasota-fl/',
    service: 'termite',
    city: 'Sarasota',
    score: 88,
    score_breakdown: { base: 88 },
    signal_metadata: { impressions: 400, ctr: 0.01 },
    ...over,
  });
  const decayParent = (over = {}) => ({
    bucket: 'decay_refresh',
    action_type: 'refresh_existing_page',
    query: null,
    page_url: '/pest-control-bradenton-fl/',
    service: 'pest',
    city: 'Bradenton',
    score: 80,
    score_breakdown: { base: 80 },
    signal_metadata: { decay_pct: 0.4 },
    ...over,
  });

  test('a ctr_rewrite parent spawns an add_internal_links companion that inherits its signal', () => {
    const [opp, ...rest] = deriveLinkBoost([ctrParent()], { cap: 10 });
    expect(rest).toHaveLength(0);
    expect(opp.bucket).toBe('link_boost');
    expect(opp.action_type).toBe('add_internal_links');
    expect(opp.page_url).toBe('/termite-control-sarasota-fl/');
    expect(opp.query).toBe('termite inspection sarasota');
    expect(opp.score).toBe(88);
    expect(opp.score_breakdown.derivedFrom).toBe('ctr_rewrite');
    expect(opp.signal_metadata.source_bucket).toBe('ctr_rewrite');
    expect(opp.dedupe_key).toContain('link_boost');
  });

  test('decay_refresh parents derive too (null query is fine)', () => {
    const [opp] = deriveLinkBoost([decayParent()], { cap: 10 });
    expect(opp.action_type).toBe('add_internal_links');
    expect(opp.query).toBeNull();
    expect(opp.signal_metadata.source_bucket).toBe('decay_refresh');
  });

  test('parents without a page_url derive nothing — there is no page to boost', () => {
    expect(deriveLinkBoost([ctrParent({ page_url: null, action_type: 'do_not_publish' })], { cap: 10 }))
      .toHaveLength(0);
  });

  test('do_not_publish parents derive nothing even if a page_url slipped through', () => {
    expect(deriveLinkBoost([ctrParent({ action_type: 'do_not_publish' })], { cap: 10 }))
      .toHaveLength(0);
  });

  test('two parents on the same page+segment collapse to one companion, keeping the higher score', () => {
    const a = ctrParent({ page_url: '/pest-control-bradenton-fl/', service: 'pest', city: 'Bradenton', score: 82 });
    const b = decayParent({ score: 91 });
    const out = deriveLinkBoost([a, b], { cap: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(91);
    expect(out[0].signal_metadata.source_bucket).toBe('decay_refresh');
  });

  test('cap keeps only the highest-scoring companions; cap 0 disables the lane', () => {
    const parents = [
      ctrParent({ page_url: '/a/', score: 70 }),
      ctrParent({ page_url: '/b/', score: 95 }),
      ctrParent({ page_url: '/c/', score: 85 }),
    ];
    const capped = deriveLinkBoost(parents, { cap: 2 });
    expect(capped.map((o) => o.page_url)).toEqual(['/b/', '/c/']);
    expect(deriveLinkBoost(parents, { cap: 0 })).toHaveLength(0);
  });

  test('near-me parent queries still derive — anchors only wrap text that already exists on hub pages', () => {
    const [opp] = deriveLinkBoost([ctrParent({ query: 'exterminator near me sarasota' })], { cap: 10 });
    expect(opp.action_type).toBe('add_internal_links');
  });

  test('the occupied-keys loader counts sticky-SKIPPED rows too (Codex round 4 — skipped keys re-consumed cap slots every mine)', () => {
    // With skipped sticky in the upsert, a skipped link-boost key that is
    // not excluded gets re-derived every mine, burns one of the
    // LINK_BOOST_MAX_PER_RUN slots, and persists right back as skipped —
    // enough skipped top pages starve the lane entirely.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/seo/gsc-opportunity-miner'), 'utf8');
    expect(src).toMatch(/whereIn\('status', \['claimed', 'done', 'pending_review', 'skipped'\]\)/);
  });

  test('excludeKeys rotates the cap past occupied rows instead of starving lower-scoring pages', () => {
    const parents = [
      ctrParent({ page_url: '/a/', score: 95 }),
      ctrParent({ page_url: '/b/', score: 85 }),
      ctrParent({ page_url: '/c/', score: 70 }),
    ];
    // First run: cap 2 → the top two pages.
    const firstRun = deriveLinkBoost(parents, { cap: 2 });
    expect(firstRun.map((o) => o.page_url)).toEqual(['/a/', '/b/']);
    // Next run: those rows are claimed/done/pending_review → the cap is
    // spent on the next qualifying page rather than re-emitting them.
    const occupied = new Set(firstRun.map((o) => o.dedupe_key));
    const secondRun = deriveLinkBoost(parents, { cap: 2, excludeKeys: occupied });
    expect(secondRun.map((o) => o.page_url)).toEqual(['/c/']);
  });

  test('companions derived after the facts boost inherit the boosted parent score', () => {
    // mineAll boosts parent scores in place BEFORE deriving (Codex P2):
    // mutate the parent like _applyFactsReadinessBoost does, then derive.
    const parent = decayParent({ score: 65, score_breakdown: { base: 65 } });
    parent.score += 15;
    parent.score_breakdown.factsReady = 15;
    const [opp] = deriveLinkBoost([parent], { cap: 10 });
    expect(opp.score).toBe(80);
    expect(opp.score_breakdown.factsReady).toBe(15);
  });
});

describe('persistAll upsert binding integrity (07-31 regression)', () => {
  // knex counts binding placeholders across the WHOLE raw string — SQL
  // comments included. A "?" inside the upsert's comment block shipped
  // 07-30 and broke every daily mine ("Expected 13 bindings, saw 15"),
  // silently starving the blog queue. Assert the raw SQL's placeholder
  // count matches the bindings array exactly.
  test('placeholder count in the upsert SQL matches the bindings array', async () => {
    const db = require('../models/db');
    const calls = [];
    db.raw = jest.fn((sql, bindings) => {
      calls.push({ sql, bindings });
      return Promise.resolve({ rowCount: 1 });
    });
    const { GscOpportunityMiner } = require('../services/seo/gsc-opportunity-miner');
    const miner = new GscOpportunityMiner();
    const persisted = await miner.persistAll([{
      bucket: 'striking_distance',
      action_type: 'new_supporting_blog',
      query: 'test query',
      page_url: null,
      service: 'pest',
      city: 'sarasota',
      score: 90,
      score_breakdown: { base: 90 },
      signal_metadata: { source: 'test' },
      dedupe_key: 'test:binding:integrity',
    }]);
    expect(persisted).toBe(1);
    expect(calls.length).toBe(1);
    const placeholders = (calls[0].sql.match(/\?/g) || []).length;
    expect(placeholders).toBe(calls[0].bindings.length);

    // Frozen rows (claimed/done/pending_review/skipped) must skip the
    // conflict-update ENTIRELY — identity AND score/metadata/action all
    // derive from the CURRENT representative, and pairing them with a
    // frozen row's processed identity corrupts the record (pre-push r7).
    expect(calls[0].sql).toMatch(
      /DO UPDATE[\s\S]*WHERE opportunity_queue\.status NOT IN \('claimed', 'done', 'pending_review', 'skipped'\)/
    );
  });

  test('a family refresh yields to another bucket refreshing the same page in one batch (Codex r19)', async () => {
    const db = require('../models/db');
    const calls = [];
    db.raw = jest.fn((sql, bindings) => {
      calls.push({ sql, bindings });
      return Promise.resolve({ rowCount: 1 });
    });
    const { GscOpportunityMiner } = require('../services/seo/gsc-opportunity-miner');
    const miner = new GscOpportunityMiner();
    const page = 'https://wavespestcontrol.com/blog/termite-signs/';
    const fam = {
      bucket: 'listicle_family', action_type: 'refresh_existing_page',
      query: 'signs of termites florida', page_url: page, service: 'termite', city: null,
      score: 60, score_breakdown: {}, signal_metadata: {}, dedupe_key: 'listicle_family::page::x',
    };
    const boosted = {
      bucket: 'striking_distance', action_type: 'refresh_existing_page',
      query: 'termite signs', page_url: page, service: 'termite', city: null,
      score: 76, score_breakdown: {}, signal_metadata: {}, dedupe_key: 'striking_distance::t::_::x',
    };
    // Facts-boosted striking refresh clears its floor → the family yields:
    // one refresh per page per batch.
    const persisted = await miner.persistAll([fam, boosted]);
    expect(persisted).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].bindings[12]).toBe('striking_distance::t::_::x');
    // Alone, the same family refresh persists normally.
    calls.length = 0;
    expect(await miner.persistAll([fam])).toBe(1);
    expect(calls[0].bindings[12]).toBe('listicle_family::page::x');
    // Family REFRESH query-level arbitration (r27): an ordinary edit of
    // the same query targeting a DIFFERENT page still wins.
    calls.length = 0;
    const famRefreshOtherPage = {
      bucket: 'listicle_family', action_type: 'refresh_existing_page',
      query: 'signs of termites florida', page_url: 'https://wavespestcontrol.com/blog/other-page/',
      service: 'termite', city: null, score: 60, score_breakdown: {},
      signal_metadata: { family_queries: ['termite signs'] },
      dedupe_key: 'listicle_family::page::other',
    };
    const crossPage = await miner.persistAll([famRefreshOtherPage, boosted]);
    expect(crossPage).toBe(1);
    expect(calls[0].bindings[12]).toBe('striking_distance::t::_::x');
    // Family BLOG arbitration (r21): a floor-clearing ordinary refresh
    // whose query is one of the family's variants suppresses the family
    // blog too — same intent, different keys.
    calls.length = 0;
    const famBlog = {
      bucket: 'listicle_family', action_type: 'new_supporting_blog',
      query: 'signs of termites florida', page_url: null, service: 'termite', city: null,
      score: 60, score_breakdown: {},
      // family_queries is the COMPLETE set arbitration reads — the deep
      // variant beyond the capped family_variants must still match.
      signal_metadata: {
        family_variants: [{ query: 'other phrasing', impressions: 30 }],
        family_queries: ['other phrasing', 'termite signs'],
      },
      dedupe_key: 'listicle_family::fam::y',
    };
    const blogPersisted = await miner.persistAll([famBlog, boosted]);
    expect(blogPersisted).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].bindings[12]).toBe('striking_distance::t::_::x');
    // Frozen-aware arbitration (r20): the lookup lives in
    // _arbitratedRefreshPages — a candidate whose dedupe row is done or
    // skipped lands nothing and must not suppress the family refresh.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/seo/gsc-opportunity-miner'), 'utf8');
    const arbSrc = src.slice(src.indexOf('async _arbitratedRefreshPages'), src.indexOf('async _sweepStaleFamilyRows'));
    expect(arbSrc).toMatch(/whereIn\('status', \['done', 'skipped'\]\)/);
    expect(arbSrc).toMatch(/!frozenKeys\.has\(o\.dedupe_key\)/);
  });

  test('a frozen-row conflict (rowCount 0) does not count as persisted', async () => {
    const db = require('../models/db');
    // The WHERE guard makes Postgres report rowCount 0 when the conflicting
    // row is claimed/done/pending_review/skipped — admin responses and
    // scheduler logs must not report the untouched row as persisted.
    db.raw = jest.fn(() => Promise.resolve({ rowCount: 0 }));
    const { GscOpportunityMiner } = require('../services/seo/gsc-opportunity-miner');
    const miner = new GscOpportunityMiner();
    const persisted = await miner.persistAll([{
      bucket: 'listicle_family',
      action_type: 'new_supporting_blog',
      query: 'kinds of ants in florida',
      page_url: null,
      service: 'pest',
      city: null,
      score: 50,
      score_breakdown: { base: 50 },
      signal_metadata: { impressions: 60 },
      dedupe_key: 'listicle_family::fam::ants+florida+kinds',
    }]);
    expect(persisted).toBe(0);
  });
});

// ── answer_gap helpers ───────────────────────────────────────────────

describe('answer_gap analysis helpers', () => {
  const {
    answerGapStem,
    stemmedTokenSet,
    queryContentTerms,
    extractHeadings,
    termCoverage,
    classifyAnswerGapQueries,
  } = require('../services/seo/gsc-opportunity-miner')._internals;

  describe('answerGapStem', () => {
    test.each([
      ['ants', 'ant'],
      ['flies', 'fly'],
      ['grass', 'grass'], // -ss never stripped
      ['is', 'is'],       // too short to strip
      ['termites', 'termite'],
    ])('%j → %j', (input, expected) => {
      expect(answerGapStem(input)).toBe(expected);
    });
  });

  describe('queryContentTerms', () => {
    test('drops stopwords, interrogatives, cities, and fl/florida', () => {
      const terms = queryContentTerms('how to get rid of sugar ants in sarasota fl');
      expect(Array.from(terms).sort()).toEqual(['ant', 'rid', 'sugar']);
    });
    test('drops multi-word city tokens (lakewood ranch)', () => {
      const terms = queryContentTerms('lawn care lakewood ranch cost');
      expect(terms.has('lakewood')).toBe(false);
      expect(terms.has('ranch')).toBe(false);
      expect(terms.has('lawn')).toBe(true);
      expect(terms.has('cost')).toBe(true);
    });
    test('pure city/stopword query yields no terms', () => {
      expect(queryContentTerms('sarasota fl').size).toBe(0);
    });
  });

  describe('extractHeadings', () => {
    test('captures H2–H4, ignores H1 and deeper', () => {
      const body = [
        '# Title', '## Sugar Ant Control', 'text', '### When To Treat',
        '#### Edge Case', '##### Too Deep', '## Final',
      ].join('\n');
      expect(extractHeadings(body)).toEqual([
        'Sugar Ant Control', 'When To Treat', 'Edge Case', 'Final',
      ]);
    });
  });

  describe('termCoverage', () => {
    test('fraction of query terms present in the text set', () => {
      const set = stemmedTokenSet('sugar ant control guide');
      expect(termCoverage(new Set(['sugar', 'ant']), set)).toBe(1);
      expect(termCoverage(new Set(['sugar', 'bait']), set)).toBe(0.5);
      expect(termCoverage(new Set(), set)).toBe(0);
    });
  });

  describe('classifyAnswerGapQueries', () => {
    const body = [
      '## Sugar Ant Control',
      'Sugar ants (ghost ants) trail along kitchen counters…',
      '## Our Treatment Process',
      'We inspect, treat, and follow up.',
    ].join('\n');

    test('a query covered by a heading counts as answered', () => {
      const { unanswered, answered_count } = classifyAnswerGapQueries(
        [{ query: 'sugar ant control sarasota', impressions: 100, clicks: 2, position: 12 }],
        body
      );
      expect(answered_count).toBe(1);
      expect(unanswered).toHaveLength(0);
    });

    test('an uncovered query surfaces with coverage detail', () => {
      const { unanswered } = classifyAnswerGapQueries(
        [{ query: 'do ant baits work outdoors', impressions: 80, clicks: 1, position: 14 }],
        body
      );
      expect(unanswered).toHaveLength(1);
      expect(unanswered[0].query).toBe('do ant baits work outdoors');
      expect(unanswered[0].heading_coverage).toBeLessThan(0.6);
      expect(unanswered[0].body_term_coverage).toBeGreaterThanOrEqual(0);
    });

    test('near-duplicate phrasings collapse to the higher-impression one', () => {
      const { unanswered } = classifyAnswerGapQueries(
        [
          { query: 'lawn sod webworms', impressions: 90, clicks: 1, position: 15 },
          { query: 'sod webworm lawn', impressions: 30, clicks: 0, position: 18 },
        ],
        body
      );
      expect(unanswered).toHaveLength(1);
      expect(unanswered[0].query).toBe('lawn sod webworms');
    });

    test('pure city/stopword queries are neither answered nor unanswered', () => {
      const { unanswered, answered_count } = classifyAnswerGapQueries(
        [{ query: 'sarasota fl', impressions: 500, clicks: 0, position: 11 }],
        body
      );
      expect(unanswered).toHaveLength(0);
      expect(answered_count).toBe(0);
    });
  });
});

describe('answer_gap scoring + action mapping', () => {
  test('gscOpportunityScore treats answer_gap like other page-anchored gaps (0.8×)', () => {
    expect(gscOpportunityScore('answer_gap', 15, 1.0)).toBe(Math.round(WEIGHTS.gscOpportunity * 0.8));
  });

  test('scoreOpportunity grants answer_gap BOTH contentGap and refreshLift', () => {
    const { breakdown } = scoreOpportunity(
      { bucket: 'answer_gap', query: 'do ant baits work outdoors', service: 'pest' },
      { position: 15, impressions: 600 }
    );
    expect(breakdown.contentGap).toBe(WEIGHTS.contentGap);
    expect(breakdown.refreshLift).toBe(WEIGHTS.refreshLift);
  });

  test('answer_gap maps to refresh_existing_page only with a target page', () => {
    expect(actionForOpportunity({ bucket: 'answer_gap', page_url: '/x/', query: 'q' }))
      .toBe('refresh_existing_page');
    expect(actionForOpportunity({ bucket: 'answer_gap', page_url: null, query: 'q' }))
      .toBe('do_not_publish');
  });
});

// ── listicle_family clustering + scoring + action mapping ────────────

describe('listicleFamilyKey', () => {
  test('word order and glue words do not split a family', () => {
    const a = listicleFamilyKey('drought tolerant plants florida');
    expect(listicleFamilyKey('florida drought tolerant plants')).toBe(a);
    expect(listicleFamilyKey('drought tolerant plants for florida')).toBe(a);
    expect(listicleFamilyKey('drought tolerant plants in florida')).toBe(a);
  });
  test('different content tokens are different families', () => {
    expect(listicleFamilyKey('drought resistant plants florida'))
      .not.toBe(listicleFamilyKey('drought tolerant plants florida'));
    expect(listicleFamilyKey('drought tolerant plants sarasota'))
      .not.toBe(listicleFamilyKey('drought tolerant plants florida'));
  });
  test('punctuation and repeated tokens normalize away; empty input → null', () => {
    expect(listicleFamilyKey('drought-tolerant plants, florida'))
      .toBe(listicleFamilyKey('drought tolerant plants florida'));
    expect(listicleFamilyKey('')).toBeNull();
    expect(listicleFamilyKey(null)).toBeNull();
  });
});

describe('clusterListicleFamilies', () => {
  const rows = [
    { query: 'drought tolerant plants florida', impressions: '48', avg_position: '17.2', service_category: 'lawn', city_target: null },
    { query: 'florida drought tolerant plants', impressions: '24', avg_position: '17.3', service_category: null, city_target: null },
    { query: 'drought tolerant plants for florida', impressions: '30', avg_position: '20.8', service_category: 'lawn', city_target: null },
    { query: 'kinds of ants in florida', impressions: '11', avg_position: '48.4', service_category: 'pest', city_target: null },
    { query: 'how to get rid of ants', impressions: '900', avg_position: '4.0', service_category: 'pest', city_target: null }, // not list-shaped
    { query: 'best plants for shade', impressions: '60', avg_position: '9.0', service_category: 'lawn', city_target: null }, // vendor-RE excluded
  ];

  test('merges variants, sums impressions, weights position, sorts variants by impressions', () => {
    const fams = clusterListicleFamilies(rows);
    const drought = fams.find((f) => f.variants.length === 3);
    expect(drought).toBeDefined();
    expect(drought.impressions).toBe(102);
    expect(drought.variants[0].query).toBe('drought tolerant plants florida');
    // Impressions-weighted: (48*17.2 + 24*17.3 + 30*20.8) / 102 ≈ 18.28
    expect(drought.position).toBeCloseTo(18.28, 1);
  });

  test('non-list-shaped and vendor-intent queries never enter a family', () => {
    const fams = clusterListicleFamilies(rows);
    const all = fams.flatMap((f) => f.variants.map((v) => v.query));
    expect(all).not.toContain('how to get rid of ants');
    expect(all).not.toContain('best plants for shade');
    expect(all).toContain('kinds of ants in florida'); // single-variant family still clustered (floor applied by the miner)
  });

  test('empty/undefined input → no families', () => {
    expect(clusterListicleFamilies([])).toEqual([]);
    expect(clusterListicleFamilies(undefined)).toEqual([]);
  });

  test('classification-split rows of ONE query merge into one variant (pre-push r7)', () => {
    // Source rows group by (query, service, city): a query whose
    // classification changed mid-window arrives as multiple rows. Those must
    // not count as separate variants — one real query would then satisfy the
    // ≥2-variant rule on its own.
    const fams = clusterListicleFamilies([
      { query: 'kinds of ants in florida', impressions: 30, avg_position: 10, service_category: 'pest', city_target: null },
      { query: 'kinds of ants in florida', impressions: 40, avg_position: 20, service_category: 'lawn', city_target: 'sarasota' },
    ]);
    expect(fams).toHaveLength(1);
    expect(fams[0].variants).toHaveLength(1); // one DISTINCT query = one variant
    const v = fams[0].variants[0];
    expect(v.impressions).toBe(70);
    expect(v.position).toBeCloseTo((10 * 30 + 20 * 40) / 70);
    expect(v.service_category).toBe('lawn'); // higher-impression classification wins
    expect(v.city_target).toBe('sarasota');
    // Constituent tuples preserved — the query miners admit PER tuple, so
    // reachability needs them individually (Codex r14).
    expect(v.tuples).toHaveLength(2);
    expect(v.tuples.map((t) => t.impressions).sort((a, b) => a - b)).toEqual([30, 40]);
    expect(fams[0].impressions).toBe(70);
    // A single distinct query can never clear the ≥2-variant rule.
    expect(listicleFamilyEligible(fams[0])).toBe(false);
  });

  test('classification winner compares INDIVIDUAL row impressions, not the cumulative sum', () => {
    // 30 + 25 merge first (cumulative 55); a later 40-row still wins the
    // classification because 40 is the highest individual row.
    const fams = clusterListicleFamilies([
      { query: 'kinds of ants in florida', impressions: 30, avg_position: 10, service_category: 'pest', city_target: null },
      { query: 'kinds of ants in florida', impressions: 25, avg_position: 12, service_category: 'lawn', city_target: null },
      { query: 'kinds of ants in florida', impressions: 40, avg_position: 14, service_category: 'tree_shrub', city_target: 'venice' },
    ]);
    expect(fams).toHaveLength(1);
    expect(fams[0].variants).toHaveLength(1);
    expect(fams[0].variants[0].impressions).toBe(95);
    expect(fams[0].variants[0].service_category).toBe('tree_shrub');
    expect(fams[0].variants[0].city_target).toBe('venice');
  });
});

describe('listicle_family scoring + action mapping', () => {
  test('gscOpportunityScore treats listicle_family like seasonal_rising (0.7×)', () => {
    expect(gscOpportunityScore('listicle_family', 18, 1.0)).toBe(Math.round(WEIGHTS.gscOpportunity * 0.7));
  });

  test('maps to new_supporting_blog unserved, refresh_existing_page when page-anchored; transactional still demoted', () => {
    expect(actionForOpportunity({ bucket: 'listicle_family', page_url: null, query: 'kinds of ants in florida' }))
      .toBe('new_supporting_blog');
    // Served family rides as a page-anchored refresh — same convention as answer_gap.
    expect(actionForOpportunity({ bucket: 'listicle_family', page_url: 'https://wavespestcontrol.com/blog/x/', query: 'kinds of ants in florida' }))
      .toBe('refresh_existing_page');
    // The wrapper's transactional demotion applies to this bucket like any other.
    expect(actionForOpportunity({ bucket: 'listicle_family', page_url: null, query: 'signs you need pest control near me' }))
      .toBe('do_not_publish');
  });

  test('service inference: horticultural plant families resolve to tree-shrub; bare "plants" does not', () => {
    expect(inferServiceFromQuery('drought tolerant plants florida')).toBe('tree-shrub');
    expect(inferServiceFromQuery('drought tolerant tropical plants')).toBe('tree-shrub');
    expect(inferServiceFromQuery('plants that grow in sandy soil and full sun florida')).toBe('tree-shrub');
    // mosquito wins by keyword order — repellent-plant lists stay mosquito content
    expect(inferServiceFromQuery('plants that repel mosquitoes')).toBe('mosquito');
    // Bare/unrelated "plants" senses must NOT resolve (Codex r4)
    expect(inferServiceFromQuery('types of house plants florida')).toBeNull();
    expect(inferServiceFromQuery('types of power plants florida')).toBeNull();
    // No Waves service → mineListicleFamily skips the family (off-topic guard)
    expect(inferServiceFromQuery('types of fish in florida')).toBeNull();
  });

  test('classifier categories canonicalize before enqueueing (tree_shrub → tree-shrub)', () => {
    expect(canonicalizeServiceCategory('tree_shrub')).toBe('tree-shrub');
    expect(canonicalizeServiceCategory('LAWN')).toBe('lawn');
    // 'specialty' (flea/tick/wasp…) has no facts-bank identity — it maps to
    // the general-pest service so city-qualified families draft instead of
    // parking facts_unmappable (Codex r6).
    expect(canonicalizeServiceCategory('specialty')).toBe('pest');
    expect(canonicalizeServiceCategory('unknown_bucket')).toBeNull();
    expect(canonicalizeServiceCategory(null)).toBeNull();
  });

  test('family-summed impressions clear the boost floor that individual variants miss', () => {
    expect(impressionsBoost(48)).toBe(0); // best single variant: below minImpressionsToScore
    expect(impressionsBoost(102)).toBeGreaterThan(0); // family sum: scores
  });

  test('earns contentGap weight, and the motivating family clears the 45 blog admission floor', () => {
    const { total, breakdown } = scoreOpportunity(
      { bucket: 'listicle_family', query: 'drought tolerant plants florida', service: 'lawn' },
      { position: 18, impressions: 450 }
    );
    expect(breakdown.contentGap).toBe(WEIGHTS.contentGap);
    // 450 impressions / informational lawn family — must clear blogMinScoreToAct
    // (45) or the bucket is silently inert (Codex r1 P1).
    expect(total).toBeGreaterThanOrEqual(45);
  });

  test('admission: rep-below-floor + sum-above-floor + outside top-3 + ≥2 variants', () => {
    const fam = (over = {}) => ({
      variants: [{ impressions: 48 }, { impressions: 30 }, { impressions: 24 }],
      impressions: 102,
      position: 18,
      ...over,
    });
    expect(listicleFamilyEligible(fam())).toBe(true);
    // A rep the query buckets will ACTUALLY emit excludes the family —
    // proven reachability only (r16: the hub-only rep-impressions
    // precondition undercounted cross-domain sums, so raw impressions no
    // longer auto-exclude).
    expect(listicleFamilyEligible(fam({ variants: [{ impressions: 60 }, { impressions: 42 }], impressions: 102 }), undefined, { repQualifiesQueryBucket: true })).toBe(false);
    expect(listicleFamilyEligible(fam({ variants: [{ impressions: 60 }, { impressions: 42 }], impressions: 102 }))).toBe(true);
    // Single-variant family → existing buckets' territory.
    expect(listicleFamilyEligible(fam({ variants: [{ impressions: 48 }] }))).toBe(false);
    // Family sum under the floor.
    expect(listicleFamilyEligible(fam({ impressions: 40, variants: [{ impressions: 25 }, { impressions: 15 }] }))).toBe(false);
    // Top-3 weighted position = won intent.
    expect(listicleFamilyEligible(fam({ position: 2.4 }))).toBe(false);
    // Representative itself ranks top-3 while a deep low-volume variant
    // drags the family average past the cutoff (Codex r7): still excluded.
    expect(listicleFamilyEligible(fam({
      position: 4.96,
      variants: [{ impressions: 48, position: 1 }, { impressions: 2, position: 100 }],
      impressions: 50,
    }))).toBe(false);
    // Position 0 (no data) does not trip the top-3 exclusion.
    expect(listicleFamilyEligible(fam({ position: 0 }))).toBe(true);
  });

  test('rep-over-floor exclusion requires the rep to actually qualify for a query bucket (Codex r11)', () => {
    const fam = {
      variants: [{ impressions: 51 }, { impressions: 49 }],
      impressions: 100,
      position: 18,
    };
    // Proven reachable: excluded — a query bucket will emit the rep.
    expect(listicleFamilyEligible(fam, undefined, { repQualifiesQueryBucket: true })).toBe(false);
    // Default (reachability unproven): eligible — the safe direction is
    // keeping the demand (Codex r11/r16).
    expect(listicleFamilyEligible(fam)).toBe(true);
    expect(listicleFamilyEligible(fam, undefined, { repQualifiesQueryBucket: false })).toBe(true);
  });

  test('rep reachability mirrors the REAL query-bucket admission conditions (Codex r12)', () => {
    const rep = (over = {}) => ({
      query: 'drought tolerant plants florida',
      impressions: 51,
      position: 20,
      service_category: null,
      city_target: null,
      ...over,
    });
    // Beyond 15 with no resolvable service (raw AND inferred blank) →
    // unreachable: mineNoContentYet skips !service.
    expect(listicleFamilyRepReachable(rep({ query: 'types of fish in florida' }), new Map())).toBe(false);
    // Striking-distance window (4-15): SQL admission alone is NOT
    // reachability (Codex r16) — the mirrored candidate must also clear
    // persistAll's action-aware floor, and at these signal levels a
    // striking_distance row scores ~32 (refresh floor 75 with a page,
    // blog floor 45 without): the family keeps the demand.
    expect(listicleFamilyRepReachable(rep({ position: 8 }), new Map([['tree-shrub::', 'https://x/']]))).toBe(false);
    expect(listicleFamilyRepReachable(rep({ position: 8, query: 'types of fish in florida' }), new Map())).toBe(false);
    // Beyond 15 with NO own page for the service+city → no_content_yet reaches it.
    expect(listicleFamilyRepReachable(rep({ position: 20 }), new Map())).toBe(true);
    // Beyond 15 but an own page EXISTS for the service+city →
    // no_content_yet skips it and striking_distance is out of window: NO
    // bucket emits the rep, so the family must stay eligible. The lookup
    // mirrors that miner's RAW-classifier-first keying (Codex r13): a raw
    // 'tree_shrub' classification must find the raw-keyed map entry.
    expect(listicleFamilyRepReachable(rep({ position: 20 }), new Map([['tree-shrub::', 'https://x/']]))).toBe(false);
    expect(listicleFamilyRepReachable(
      rep({ position: 20, service_category: 'tree_shrub' }),
      new Map([['tree_shrub::', 'https://x/']])
    )).toBe(false);
    // Seasonal-emittable rep → reachable regardless of position/own-page
    // (mineSeasonalRising emits it independently; Codex r13).
    expect(listicleFamilyRepReachable(
      rep({ position: 20 }),
      new Map([['tree-shrub::', 'https://x/']]),
      undefined,
      { seasonalEmittable: true }
    )).toBe(true);
    // Position 0 (no data) → not reachable through either window.
    expect(listicleFamilyRepReachable(rep({ position: 0 }), new Map())).toBe(false);
  });

  test('reachability judges tuples by the QUERY MINERS aggregation, not the family weighting (Codex r14)', () => {
    // 100 imps at plain-avg 54 (volatile daily rankings): the family's
    // weighted position may sit near 8, but mineStrikingDistance uses
    // avg(position)=54 (out of window) and mineNoContentYet skips on the
    // own page — NO bucket emits it, so the family must stay eligible.
    const volatile = {
      query: 'drought tolerant plants florida',
      impressions: 101,
      position: 8.9, // family weighting — must NOT decide reachability
      tuples: [{ impressions: 101, plainPosition: 54, service_category: 'tree_shrub', city_target: null }],
    };
    expect(listicleFamilyRepReachable(volatile, new Map([['tree_shrub::', 'https://x/']]))).toBe(false);
    // Same rep with no own page → no_content_yet emits (plain avg > 15).
    expect(listicleFamilyRepReachable(volatile, new Map())).toBe(true);
    // Split classification: 30+21 imps across two tuples — each tuple is
    // under the per-tuple ≥50 floor the query miners apply per group, so
    // neither miner emits despite the 51-imp total.
    const split = {
      query: 'drought tolerant plants florida',
      impressions: 51,
      position: 8,
      tuples: [
        { impressions: 30, plainPosition: 8, service_category: 'tree_shrub', city_target: null },
        { impressions: 21, plainPosition: 9, service_category: 'lawn', city_target: null },
      ],
    };
    expect(listicleFamilyRepReachable(split, new Map())).toBe(false);
    // In-window tuple over the SQL floor — but the mirrored candidate
    // scores ~32, under its persistence floor, so the query bucket would
    // mine-and-drop it: the family keeps the demand (Codex r16).
    const inWindow = {
      query: 'drought tolerant plants florida',
      impressions: 60,
      position: 8,
      tuples: [{ impressions: 60, plainPosition: 8, service_category: null, city_target: null }],
    };
    expect(listicleFamilyRepReachable(inWindow, new Map())).toBe(false);
  });

  test('classifier values need boundary-aware query evidence; refresh keys are page-stable (Codex r16)', () => {
    // The sync classifier's unbounded 'ant' tags "types of important
    // documents florida" as pest — revalidation rejects it, and with no
    // contextual inference either, the family dies at the !service guard.
    expect(classifierQuerySupported('pest', 'pest', 'types of important documents florida')).toBe(false);
    expect(classifierQuerySupported('pest', 'pest', 'kinds of ants in florida')).toBe(true);
    // The vocabulary derives from the sync's OWN SERVICE_PATTERNS (r17) —
    // every form the classifier can legitimately tag must validate:
    expect(classifierQuerySupported('pest', 'pest', 'signs of insect infestation')).toBe(true);
    expect(classifierQuerySupported('lawn', 'lawn', 'types of turf varieties')).toBe(true);
    expect(classifierQuerySupported('specialty', 'pest', 'types of bees in florida')).toBe(true);
    expect(classifierQuerySupported('specialty', 'pest', 'signs of fleas in sarasota')).toBe(true);
    expect(classifierQuerySupported('specialty', 'pest', 'types of important documents florida')).toBe(false);
    // Prefix semantics survive the boundary wrap ('termit' → termite).
    expect(classifierQuerySupported('termite', 'termite', 'signs of termite damage')).toBe(true);
    // Inflection-bounded tail (r18): word-start service tokens inside
    // unrelated words must not validate.
    expect(classifierQuerySupported('pest', 'pest', 'types of antique furniture florida')).toBe(false);
    expect(classifierQuerySupported('rodent', 'rodent', 'best rating for lawn companies')).toBe(false);
    expect(classifierQuerySupported('specialty', 'pest', 'beef prices florida')).toBe(false);
    // Legit inflections still validate ('fertiliz' stem → fertilizer).
    expect(classifierQuerySupported('lawn', 'lawn', 'types of lawn fertilizer florida')).toBe(true);
    // Homonym contexts void the variant's service evidence entirely in the
    // resolver (r21): full-word matches about something else.
    const homonymHelpers = {
      canonicalize: canonicalizeServiceCategory,
      inferService: inferServiceFromQuery,
      normCity: (c) => c || null,
      inferCity: () => null,
    };
    for (const q of ['types of software bugs', 'computer mouse types explained', 'palm reading signs meaning']) {
      expect(resolveListicleFamilyServiceCity({
        variants: [
          { query: q, service_category: 'pest', city_target: null },
          { query: `${q} florida`, service_category: 'pest', city_target: null },
        ],
      }, homonymHelpers).service).toBeNull();
    }
    // Narrowness: real service homonym-adjacent queries stay evidence.
    expect(resolveListicleFamilyServiceCity({
      variants: [{ query: 'best mouse trap placement attic', service_category: 'rodent', city_target: null }],
    }, homonymHelpers).service).toBe('rodent');
    expect(resolveListicleFamilyServiceCity({
      variants: [{ query: 'palm tree fertilizer schedule', service_category: 'tree_shrub', city_target: null }],
    }, homonymHelpers).service).toBe('tree-shrub');
    // Per-token inflections (r19): generic suffixes validated 'rates'
    // (rat+es) and 'tickers' (tick+ers) — the default is plural-s only.
    expect(classifierQuerySupported('rodent', 'rodent', 'reasons interest rates change')).toBe(false);
    expect(classifierQuerySupported('specialty', 'pest', 'types of stock tickers')).toBe(false);
    expect(classifierQuerySupported('rodent', 'rodent', 'types of rats in florida')).toBe(true);
    expect(classifierQuerySupported('specialty', 'pest', 'kinds of ticks on dogs')).toBe(true);
    expect(classifierQuerySupported('mosquito', 'mosquito', 'plants that repel mosquitoes')).toBe(true);
    // Resolver integration: unsupported classifier + no inference → null.
    const helpers = {
      canonicalize: canonicalizeServiceCategory,
      inferService: inferServiceFromQuery,
      normCity: (c) => c || null,
      inferCity: () => null,
    };
    expect(resolveListicleFamilyServiceCity({
      variants: [
        { query: 'types of important documents florida', service_category: 'pest', city_target: null },
        { query: 'florida types of important documents', service_category: 'pest', city_target: null },
      ],
    }, helpers).service).toBeNull();
    // Subgroup-stable refresh key: order-insensitive over the covered
    // family set (primary flips never mint a second row), distinct per
    // page AND per family set — a newly emerging family reopens a
    // completed subgroup under a new key (Codex r23).
    const page = 'https://wavespestcontrol.com/blog/florida-native-plants/';
    const k = (fams) => listicleFamilyRefreshDedupeKey(page, 'tree-shrub', null, fams);
    expect(k(['a', 'b'])).toBe(k(['b', 'a'])); // sorted — order-insensitive
    expect(k(['a', 'b'])).toContain('listicle_family::page::');
    expect(k(['a', 'b'])).not.toBe(k(['a', 'b', 'c'])); // new family → new key
    expect(k(['a', 'b'])).not.toBe(listicleFamilyRefreshDedupeKey('https://wavespestcontrol.com/blog/other/', 'tree-shrub', null, ['a', 'b']));
  });

  test('served families route to a page refresh, never a drop and never map-existence (query-page map)', () => {
    // Three-way r8/r9 contract: (1) the served test is page-level RANKING
    // within strikingDistancePositionMax, not map-row existence — every GSC
    // impression maps to whatever page happened to show, so existence alone
    // would kill nearly every family and leave the lane inert. (2) A served
    // family EMITS a family-aggregated refresh of the mapped page rather
    // than silently delegating to mineStrikingDistance, whose ≥50-imp
    // per-query floor every eligible variant fails by construction. (3) A
    // ONLY in-window (4-15) hits count as served — top-3 won-intent is
    // decided solely by the rep/aggregate admission checks, never by a
    // tiny variant's page hit (Codex r14).
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/seo/gsc-opportunity-miner'), 'utf8');
    const mineSrc = src.slice(src.indexOf('async mineListicleFamily'), src.indexOf('async mineNoContentYet'));
    expect(mineSrc).toMatch(/gsc_query_page_map/);
    expect(mineSrc).toMatch(/whereIn\('query', variantQueries\)/);
    // Family rows group by the query miners' EXACT tuple — intent_type
    // included, or an intent split under their per-group floor reads as
    // reachable when neither miner will emit (Codex r15).
    expect(mineSrc).toMatch(/groupBy\('query', 'service_category', 'city_target', 'intent_type'\)/);
    // Reachability reads CROSS-DOMAIN tuples (the query miners don't
    // filter domain; the family rows deliberately do — Codex r16) and the
    // seasonal admission for every rep.
    expect(mineSrc).toMatch(/_crossDomainRepTuples\(reachQueries, since\)/);
    expect(mineSrc).toMatch(/_seasonalEmittableQueries\(reachQueries, periodDays\)/);
    expect(src).toMatch(/async _crossDomainRepTuples\(queries, since\)/);
    // EVERY variant is reachability-checked — the query miners can emit
    // any of them on cross-domain totals or seasonal growth (Codex r17).
    expect(mineSrc).toMatch(/f\.variants\.some\(\(v\) => listicleFamilyRepReachable\(/);
    expect(mineSrc).toMatch(/groupByRaw\(CANON_URL_SQL\)/); // per owned PAGE, not per query
    expect(mineSrc).toMatch(/sum\(position \* impressions\) \/ NULLIF\(sum\(impressions\), 0\) <= \?/);
    expect(mineSrc).toMatch(/THRESHOLDS\.strikingDistancePositionMax/);
    expect(mineSrc).not.toMatch(/\.distinct\('query'\)/); // existence-only check is the inert-lane bug
    // One facts contract per refresh AND no starvation: subgroups by
    // (service, city) with their own stable keys, ONE emitted per page at
    // a time — frozen keys rotate to the next subgroup, in-flight keys
    // make later subgroups wait (Codex r22 + audit).
    expect(mineSrc).toMatch(/const pick = ranked\.find\(\(g\) => !frozen\.has\(g\.key\) && !coveredByFrozen\(g\)\)/);
    expect(mineSrc).toMatch(/r\.dedupe_key !== pick\.key/);
    expect(mineSrc).toMatch(/buildListicleFamilyRefreshOpp\(pick\.entries\)/);
    // Grouped by PAGE alone — mixed-classification families served by one
    // URL must never become multiple claimable rows editing the same page.
    expect(mineSrc).toMatch(/refreshGroups\.get\(served\.hit\.page_url\)/);
    expect(mineSrc).toMatch(/s\.hit && s\.hit\.position >= THRESHOLDS\.strikingDistancePositionMin/);
    // Window filter BEFORE the per-query page reduction — a top-3 page
    // must not shadow a refreshable in-window page (Codex r17).
    expect(mineSrc).toMatch(/if \(pos < THRESHOLDS\.strikingDistancePositionMin\) continue;/);
    // No second won-intent classifier inside the served branch.
    expect(mineSrc).not.toMatch(/if \(served\.hit\.position >= THRESHOLDS\.strikingDistancePositionMin\)/);
    // An answer_gap refresh already targeting the page fences the family
    // refresh — one claimable edit per page per cycle (Codex r18); the
    // fence set is floor-filtered where mineAll builds it.
    expect(mineSrc).toMatch(/if \(answerGapPages\.has\(served\.hit\.page_url\)\) continue;/);
    // Mine-time fence = LIVE in-flight rows only; same-batch candidates go
    // through frozen-aware persist arbitration instead (audit r21).
    expect(src).toMatch(/const answerGapPages = new Set\(\);/);
    expect(src).not.toMatch(/new Set\(\(buckets\.answer_gap \|\| \[\]\)/);
    // In-flight refresh rows from EVERY other bucket join the fence — an
    // occupied page can be absent from this run's batch (recovered
    // decay_refresh signal) but its still-open edit must not race a family
    // refresh (Codex r19/r20).
    expect(src).toMatch(/whereNot\('bucket', 'listicle_family'\)[\s\S]{0,120}whereIn\('status', \['pending', 'claimed', 'pending_review'\]\)[\s\S]{0,120}whereNotNull\('page_url'\)/);
    // The fence retains QUERIES too, and family blogs defer on them.
    expect(src).toMatch(/inflightRefreshQueries\.add\(String\(r\.query\)\.toLowerCase\(\)\)/);
    expect(mineSrc).toMatch(/inflightRefreshQueries\.has\(String\(v\.query \|\| ''\)\.toLowerCase\(\)\)/);
    // The sweep re-throws under a transaction (rollback beats half-state).
    expect(src).toMatch(/if \(trx\) throw err;/);
    // r24: the blocked topic behind specialty→pest survives into metadata,
    // completed supersets stay covered, and BOTH fences read every
    // unanswered query an answer_gap refresh will edit.
    const { extractSpecialtyTopic } = require('../services/seo/gsc-opportunity-miner')._internals;
    expect(extractSpecialtyTopic(['types of wasps in florida'])).toBe('wasp');
    expect(extractSpecialtyTopic(['signs of bed bugs sarasota'])).toBe('bed-bug');
    expect(extractSpecialtyTopic(['drought tolerant plants florida'])).toBeNull();
    expect(mineSrc).toMatch(/specialty_topic: extractSpecialtyTopic/);
    expect(mineSrc).toMatch(/const coveredByFrozen = \(g\) => frozenRows\.some/);
    expect(mineSrc).toMatch(/current\.every\(\(k\) => covered\.includes\(k\)\)/);
    expect(src).toMatch(/signal_metadata->'unanswered_queries' as unanswered_queries/);
    const arbSrc2 = src.slice(src.indexOf('async _arbitratedRefreshPages'), src.indexOf('async _sweepStaleFamilyRows'));
    expect(arbSrc2).toMatch(/unanswered_queries/);
    // r25: served mappings validate as EDITABLE Astro pages (same
    // loadExistingPageBody check as mineAnswerGap); unresolvable → the
    // family stays a blog candidate, and the runtime FAQ guards read
    // gsc_signal.specialty_topic.
    expect(mineSrc).toMatch(/loadExistingPageBody\(pageUrl\)/);
    expect(mineSrc).toMatch(/servedBy\.delete\(q\)/);
    // Fail-closed three-way (audit r25): confirmed non-editable → blog
    // fallback; I/O error → the family skips ENTIRELY (no duplicate blog
    // beside a possibly-live page); refresh-state lookup failure → NO
    // refresh emissions; the reconciliation lock covers empty batches.
    expect(mineSrc).toMatch(/state === 'error'/);
    expect(mineSrc).toMatch(/if \(served\.hit\.unresolved\) continue;/);
    expect(mineSrc).toMatch(/refreshStateAvailable \? refreshGroups\.entries\(\) : \[\]/);
    expect(src).toMatch(/familyRefreshState = null;/);
    // ...and the failure ALSO suppresses the destructive sweep.
    // Run state is invocation-LOCAL (r26): overlapping singleton runs must
    // not share the failure flag.
    expect(src).toMatch(/runState\.familyRefreshStateFailed = true;/);
    expect(src).toMatch(/&& !runState\.familyRefreshStateFailed/);
    expect(src).not.toMatch(/this\._familyRefreshStateFailed/);
    // ALL same-page editing actions arbitrate (rewrite_title_meta too).
    expect(src).toMatch(/PAGE_EDITING_ACTIONS = \['refresh_existing_page', 'rewrite_title_meta'\]/);
    // r27: bounded probes (biggest demand first; past-budget = unresolved),
    // URL-derived refresh cities, query-level refresh arbitration, and an
    // advisory lock covering the no-existing-row insert race.
    expect(mineSrc).toMatch(/const probeBudget = 25;/);
    expect(mineSrc).toMatch(/pageState\.get\(hit\.page_url\) \|\| 'error'/);
    expect(mineSrc).toMatch(/city: inferCityFromUrl\(served\.hit\.page_url\)/);
    expect(src).toMatch(/pg_advisory_xact_lock\(hashtext\('listicle_family_reconcile'\)\)/);
    // One-edit-per-page re-checked UNDER the transaction lock.
    expect(src).toMatch(/inflightPageKeys\.get\(o\.page_url\)/);
    expect(src).toMatch(/k !== o\.dedupe_key/);
    expect(src).toMatch(/lockEvenIfEmpty: sweepWillRun/);
    expect(src).toMatch(/if \(!hasFamily && !lockEvenIfEmpty\) return opportunities;/);
    const gateSrc = require('fs').readFileSync(require.resolve('../services/content/content-quality-gate'), 'utf8');
    expect(gateSrc).toMatch(/brief\?\.gsc_signal\?\.specialty_topic/);
    const runnerSrc = require('fs').readFileSync(require.resolve('../services/content/autonomous-runner'), 'utf8');
    expect(runnerSrc).toMatch(/brief\?\.gsc_signal\?\.specialty_topic/);
    // Blog↔refresh transitions defer while the family's prior work is
    // claimed or in review (Codex r20).
    expect(mineSrc).toMatch(/inflightFamily\.blogKeys\.has\(listicleFamilyDedupeKey\(fam\.key\)\)/);
    expect(mineSrc).toMatch(/inflightFamily\.refreshFamilyKeys\.has\(fam\.key\)/);
  });

  test('a served family becomes a striking_distance refresh of the mapped page with family provenance (Codex r9)', () => {
    const fam = {
      key: 'drought+florida+plants+tolerant',
      impressions: 102,
      position: 12.4,
      variants: [
        { query: 'drought tolerant plants florida', impressions: 48, position: 12 },
        { query: 'florida drought tolerant plants', impressions: 30, position: 9 },
        { query: 'plants florida drought tolerant', impressions: 24, position: 15 },
      ],
    };
    const served = {
      variant: fam.variants[1],
      hit: { page_url: 'https://wavespestcontrol.com/blog/florida-native-plants/', position: 8.2 },
    };
    const opp = buildListicleFamilyRefreshOpp([{ fam, served, service: 'tree-shrub', city: null }]);
    // Summed impressions sit beside the AGGREGATE family position; the
    // anchor page's own rank rides separately (Codex r13 P2).
    expect(opp.signal_metadata.avg_position).toBe(12.4);
    expect(opp.signal_metadata.family_avg_position).toBe(12.4);
    expect(opp.signal_metadata.page_position).toBe(8.2);
    expect(opp.service).toBe('tree-shrub');
    // listicle_family bucket, NOT striking_distance: PAGE_ANCHORED_BUCKETS
    // is what stops the SERP profiler swapping the refresh back into a
    // competing blog and keeps page_type 'refresh' with its hard
    // improvement_over_prior guard (Codex r10) — and the bucket keeps the
    // family contentGap/0.7× scoring.
    expect(opp.bucket).toBe('listicle_family');
    expect(opp.page_url).toBe(served.hit.page_url);
    expect(opp.query).toBe('florida drought tolerant plants');
    expect(opp.signal_metadata.impressions).toBe(102); // family-aggregated demand
    expect(opp.signal_metadata.source).toBe('listicle_family');
    expect(opp.signal_metadata.family_size).toBe(3);
    expect(opp.action_type).toBe('refresh_existing_page'); // refresh, not a competing post
    // Page-STABLE dedupe (r16): service/city churn can't mint a second key.
    expect(opp.dedupe_key).toContain('listicle_family::page::');
    expect(opp.dedupe_key).toContain(served.hit.page_url.slice(0, 60));
    // Router anchoring contract this bucket relies on.
    const routerSrc = require('fs').readFileSync(require.resolve('../services/content/decision-router'), 'utf8');
    expect(routerSrc).toMatch(/PAGE_ANCHORED_BUCKETS = new Set\(\[.*'listicle_family'.*\]\)/);
  });

  test('two families served by one page merge into a single refresh with combined provenance (Codex r11)', () => {
    const famA = {
      key: 'drought+florida+plants+tolerant',
      impressions: 102,
      position: 14,
      variants: [
        { query: 'drought tolerant plants florida', impressions: 48, position: 12 },
        { query: 'florida drought tolerant plants', impressions: 30, position: 9 },
        { query: 'plants florida drought tolerant', impressions: 24, position: 15 },
      ],
    };
    const famB = {
      key: 'florida+native+plants+types',
      impressions: 64,
      position: 11,
      variants: [
        { query: 'types of native plants florida', impressions: 40, position: 11 },
        { query: 'florida native plants types', impressions: 24, position: 13 },
      ],
    };
    const page = 'https://wavespestcontrol.com/blog/florida-native-plants/';
    const opp = buildListicleFamilyRefreshOpp([
      { fam: famA, served: { variant: famA.variants[1], hit: { page_url: page, position: 8.2 } }, service: 'lawn', city: null },
      { fam: famB, served: { variant: famB.variants[0], hit: { page_url: page, position: 6.1 } }, service: 'tree-shrub', city: 'Sarasota' },
    ]);
    // One row; page-keyed dedupe could never hold two — so BOTH families'
    // demand must ride in it or one is silently lost forever.
    expect(opp.signal_metadata.impressions).toBe(166);
    expect(opp.signal_metadata.family_count).toBe(2);
    expect(opp.signal_metadata.family_size).toBe(5);
    expect(opp.signal_metadata.family_keys).toEqual([famA.key, famB.key]); // impression-desc
    expect(opp.signal_metadata.family_key).toBe(famA.key); // primary = highest-impression family
    // Complete query set for arbitration (family_variants stays capped).
    expect(opp.signal_metadata.family_queries).toHaveLength(5);
    // Query, classification, and position anchor to the SAME entry — the
    // PRIMARY family — never a mix of the best-ranked family's query with
    // another family's service/city (Codex r13).
    expect(opp.query).toBe('florida drought tolerant plants');
    expect(opp.service).toBe('lawn');
    expect(opp.city).toBeNull();
    expect(opp.signal_metadata.page_position).toBe(8.2);
    // Aggregate position is impressions-weighted across BOTH families:
    // (14*102 + 11*64) / 166 = 12.8.
    expect(opp.signal_metadata.avg_position).toBe(12.8);
  });

  test('every merged family keeps at least one variant in family_variants (Codex r12)', () => {
    const big = (i) => ({ query: `variant ${i} drought tolerant plants florida`, impressions: 40 - i, position: 12 });
    const famA = {
      key: 'a+family',
      impressions: 180,
      variants: [big(0), big(1), big(2), big(3), big(4)], // five variants, all larger than B's
    };
    const famB = {
      key: 'b+family',
      impressions: 20,
      variants: [
        { query: 'types of native plants florida', impressions: 12, position: 11 },
        { query: 'florida native plants types', impressions: 8, position: 13 },
      ],
    };
    const page = 'https://wavespestcontrol.com/blog/florida-native-plants/';
    const opp = buildListicleFamilyRefreshOpp([
      { fam: famA, served: { variant: famA.variants[0], hit: { page_url: page, position: 9 } }, service: 'tree-shrub', city: null },
      { fam: famB, served: { variant: famB.variants[0], hit: { page_url: page, position: 9 } }, service: 'tree-shrub', city: null },
    ]);
    const queries = opp.signal_metadata.family_variants.map((v) => v.query);
    // Without the per-family guarantee, A's five variants fill the top-5
    // and B vanishes from the only row that can carry it.
    expect(queries).toContain('types of native plants florida');
  });

  test('served-family refresh clears the persistAll floor via the family exception (Codex r10)', async () => {
    const db = require('../models/db');
    const calls = [];
    db.raw = jest.fn((sql, bindings) => {
      calls.push({ sql, bindings });
      return Promise.resolve({ rowCount: 1 });
    });
    const { GscOpportunityMiner } = require('../services/seo/gsc-opportunity-miner');
    const miner = new GscOpportunityMiner();
    const refresh = (over = {}) => ({
      bucket: 'listicle_family',
      action_type: 'refresh_existing_page',
      query: 'drought tolerant plants florida',
      page_url: 'https://wavespestcontrol.com/blog/florida-native-plants/',
      service: 'tree-shrub',
      city: null,
      score: 60,
      score_breakdown: { base: 60 },
      signal_metadata: { source: 'listicle_family' },
      dedupe_key: 'listicle_family::tree-shrub::_::x',
      ...over,
    });
    // Family refresh at 60 persists (blog floor 45, not the global 75)...
    expect(await miner.persistAll([refresh()])).toBe(1);
    expect(calls.length).toBe(1);
    // ...while an ordinary refresh bucket at the same score is dropped.
    calls.length = 0;
    const dropped = await miner.persistAll([refresh({ bucket: 'striking_distance', dedupe_key: 'striking_distance::x' })]);
    expect(dropped).toBe(0);
    expect(calls.length).toBe(0);
    // Bounded exception: a demoted family row (do_not_publish) must not
    // ride the blog floor into the queue (Codex — floor is per-action).
    calls.length = 0;
    const demoted = await miner.persistAll([refresh({ action_type: 'do_not_publish', dedupe_key: 'listicle_family::demoted' })]);
    expect(demoted).toBe(0);
    expect(calls.length).toBe(0);
  });

  test('ALL stale-row transitions reconcile via the post-persist sweep; the mine loop never mutates the queue (Codex r10/r15)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/seo/gsc-opportunity-miner'), 'utf8');
    const mineSrc = src.slice(src.indexOf('async mineListicleFamily'), src.indexOf('async _arbitratedRefreshPages'));
    const sweepSrc = src.slice(src.indexOf('async _sweepStaleFamilyRows'), src.indexOf('async mineNoContentYet'));
    // The mine loop is READ-ONLY: retiring a row before its replacement
    // persisted was non-atomic — a failed upsert left old work retired
    // with no replacement queued. Every transition (blog↔refresh, page
    // change, ineligible/unresolvable/hubless exits) reconciles through
    // the sweep instead: a retired row's key is by definition absent from
    // the keys the current run emits.
    expect(mineSrc).not.toMatch(/\.update\(/);
    expect(mineSrc).not.toMatch(/db\('opportunity_queue'\)/);
    // Sweep: revivable 'expired' (skipped is sticky; oscillations must
    // revive), pending rows only, post-floor allowlist.
    expect(sweepSrc).toMatch(/skip_reason: 'family_signal_gone'/);
    expect(sweepSrc).toMatch(/status: 'expired'/);
    expect(sweepSrc).not.toMatch(/status: 'skipped'/);
    expect(sweepSrc).toMatch(/whereNotIn\('dedupe_key', persistableKeys\)/);
    expect(sweepSrc).toMatch(/o\.score >= \(familyFloorActions\.includes\(o\.action_type\)/);
    // Ordering + guards in mineAll: sweep ONLY after a successful
    // persistAll, only when the lane ran (gates on, no miner error).
    // Transactional (r22 audit): lock+revalidate predecessors, then upserts,
    // then sweep — all one transaction so concurrent claimNext can neither
    // race the transition nor observe it halfway.
    expect(src).toMatch(/await db\.transaction\(async \(trx\) => \{[\s\S]{0,900}_revalidateFamilyBatch\(trx, allOpportunities, \{ lockEvenIfEmpty: sweepWillRun \}\)[\s\S]{0,200}persisted = await this\.persistAll\(revalidated, trx\);[\s\S]{0,1100}_sweepStaleFamilyRows\([\s\S]{0,200}trx[\s\S]{0,40}\)/);
    expect(src).toMatch(/\.forUpdate\(\)/);
    // Non-family conflicts re-read INSIDE the transaction (audit r24) —
    // the pre-mine fence query alone left a producer race window.
    const revalSrc = src.slice(src.indexOf('async _revalidateFamilyBatch'), src.indexOf('async _sweepStaleFamilyRows'));
    expect(revalSrc).toMatch(/whereNot\('bucket', 'listicle_family'\)/);
    expect(revalSrc).toMatch(/conflictPages\.has\(o\.page_url\)/);
    expect(revalSrc).toMatch(/conflictQueries\.has\(String\(q\)\.toLowerCase\(\)\)/);
    expect(src).toMatch(/!errors\.listicle_family[\s\S]{0,140}CANONICAL_MINE_PERIOD_DAYS[\s\S]{0,140}isEnabled\('listicleFamilyMining'\) && isEnabled\('listicleBriefs'\)/);
    // Destructive sweeping only under the authoritative window — a manual
    // 7-day mine must not expire valid 28-day rows (Codex r20 P2).
    expect(src).toMatch(/periodDays === GscOpportunityMiner\.CANONICAL_MINE_PERIOD_DAYS/);
  });

  test('service resolves across EVERY variant, not just the representative (Codex r9)', () => {
    const helpers = {
      canonicalize: canonicalizeServiceCategory,
      inferService: inferServiceFromQuery,
      normCity: (c) => c || null,
      inferCity: () => null,
    };
    // Representative is the reordered variant the horticultural regex
    // misses; the second variant resolves tree-shrub — the family survives.
    const fam = {
      variants: [
        { query: 'plants florida drought tolerant', impressions: 26, service_category: null, city_target: null },
        { query: 'drought tolerant plants florida', impressions: 25, service_category: null, city_target: null },
      ],
    };
    expect(inferServiceFromQuery('plants florida drought tolerant')).toBeNull(); // the premise
    expect(resolveListicleFamilyServiceCity(fam, helpers).service).toBe('tree-shrub');
    // Off-topic families still resolve nothing from any variant.
    const offTopic = {
      variants: [
        { query: 'types of fish in florida', impressions: 30, service_category: null, city_target: null },
        { query: 'florida types of fish', impressions: 25, service_category: null, city_target: null },
      ],
    };
    expect(resolveListicleFamilyServiceCity(offTopic, helpers).service).toBeNull();
  });

  test('cityless families on hubless services are excluded at mine time (Codex r9 — hub_link_present would park them)', () => {
    // SERVICE_HUB_LINKS is intentionally empty for lawn and tree-shrub; a
    // cityless family there can never satisfy the hard gate and would
    // mine → draft → park forever. Mine-time exclusion is the same
    // fail-closed posture the brief builder documents; a statewide link
    // target (owner ruling) unlocks these.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/seo/gsc-opportunity-miner'), 'utf8');
    const mineSrc = src.slice(src.indexOf('async mineListicleFamily'), src.indexOf('async mineNoContentYet'));
    expect(mineSrc).toMatch(/SERVICE_HUB_LINKS/);
    expect(mineSrc).toMatch(/!city && \(!hublessServices \|\| hublessServices\.has\(service\)\)/);
    // The map derives from the brief builder's own export — single source
    // of truth, and lawn/tree-shrub are hubless there today.
    const { SERVICE_HUB_LINKS } = require('../services/content/content-brief-builder')._internals;
    expect(SERVICE_HUB_LINKS.lawn).toEqual([]);
    expect(SERVICE_HUB_LINKS['tree-shrub']).toEqual([]);
  });

  test('dedupe key is stable under representative/classification churn (family key, not query)', () => {
    const key = listicleFamilyKey('drought tolerant plants florida');
    const a = listicleFamilyDedupeKey(key);
    const b = listicleFamilyDedupeKey(listicleFamilyKey('florida drought tolerant plants'));
    expect(a).toBe(b); // variants trading first place never mint a new row
    expect(a).toContain('listicle_family::fam::');
    // Distinct local intent keys apart because the city token is IN the family key.
    expect(listicleFamilyDedupeKey(listicleFamilyKey('drought tolerant plants sarasota'))).not.toBe(a);
  });

  test('long family keys sharing a 120-char prefix do NOT collide (Codex r8 P2 — digest carries full identity)', () => {
    const prefix = 'a'.repeat(119) + '+';
    const k1 = prefix + 'saltgrass+tolerant';
    const k2 = prefix + 'zoysia+varieties';
    expect(k1.slice(0, 120)).toBe(k2.slice(0, 120)); // the old .slice(120) bug's exact shape
    expect(listicleFamilyDedupeKey(k1)).not.toBe(listicleFamilyDedupeKey(k2));
    // Determinism across runs — the stable-key property the bucket relies on.
    expect(listicleFamilyDedupeKey(k1)).toBe(listicleFamilyDedupeKey(k1));
    // Column budget: 200 chars.
    expect(listicleFamilyDedupeKey(k1).length).toBeLessThanOrEqual(200);
  });
});

describe('vendor synonyms excluded from listicle families (Codex r7 on #3255)', () => {
  const { isListicleQuery } = require('../services/content/listicle-query');
  test('provider-noun synonyms are vendor intent, never a family', () => {
    expect(isListicleQuery('10 pest control contractors in sarasota')).toBe(false);
    expect(isListicleQuery('5 lawn care businesses near bradenton')).toBe(false);
    expect(isListicleQuery('7 pest control firms compared')).toBe(false);
    expect(isListicleQuery('top mosquito repellent brands')).toBe(false);
    // Informational lists unaffected
    expect(isListicleQuery('7 signs of termite damage')).toBe(true);
  });

  test('punctuation-stripped 24/7 phrasing is cadence, never an item count (Codex r13)', () => {
    // GSC strips the slash: '24/7 pest control' arrives as '24 7 pest
    // control' — a numeric second token means cadence, and a 24-item brief
    // for an emergency-service query would be self-contradictory.
    expect(isListicleQuery('24 7 pest control')).toBe(false);
    expect(isListicleQuery('24 hour pest control')).toBe(false);
    expect(isListicleQuery('7 signs of termite damage')).toBe(true);
    // The cadence verdict is FINAL — an enumerable noun later in the query
    // must not resurrect it via the noun fallback, or the overlay mandates
    // exactly seven H2 items for a 7-day treatment query (Codex r16).
    expect(isListicleQuery('7 day termite treatment checklist')).toBe(false);
    // Hyphenated cadence must ENTER the guard, not skirt into the noun
    // fallback (Codex r18).
    expect(isListicleQuery('7-day termite treatment checklist')).toBe(false);
    expect(isListicleQuery('24-hour pest checklist')).toBe(false);
    // A hyphenated non-cadence count still reads as a listicle.
    expect(isListicleQuery('10-step termite prevention checklist')).toBe(true);
    // Noun fallback without a leading count is untouched.
    expect(isListicleQuery('termite treatment checklist')).toBe(true);
  });
});
