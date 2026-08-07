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
    // Representative alone clears the floor → the query-level buckets can
    // already emit it; mining here too would queue two rows for one intent.
    expect(listicleFamilyEligible(fam({ variants: [{ impressions: 60 }, { impressions: 42 }], impressions: 102 }))).toBe(false);
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
    // Default (rep resolves a service): excluded — query buckets reach it.
    expect(listicleFamilyEligible(fam)).toBe(false);
    // Rep unresolvable (mineNoContentYet would skip it at !service): the
    // family stays eligible or its demand reaches NO bucket at all.
    expect(listicleFamilyEligible(fam, undefined, { repQualifiesQueryBucket: false })).toBe(true);
  });

  test('served families route to a page refresh, never a drop and never map-existence (query-page map)', () => {
    // Three-way r8/r9 contract: (1) the served test is page-level RANKING
    // within strikingDistancePositionMax, not map-row existence — every GSC
    // impression maps to whatever page happened to show, so existence alone
    // would kill nearly every family and leave the lane inert. (2) A served
    // family EMITS a family-aggregated refresh of the mapped page rather
    // than silently delegating to mineStrikingDistance, whose ≥50-imp
    // per-query floor every eligible variant fails by construction. (3) A
    // best page already in the top-3 (below strikingDistancePositionMin) is
    // won intent — dropped outright.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/seo/gsc-opportunity-miner'), 'utf8');
    const mineSrc = src.slice(src.indexOf('async mineListicleFamily'), src.indexOf('async mineNoContentYet'));
    expect(mineSrc).toMatch(/gsc_query_page_map/);
    expect(mineSrc).toMatch(/whereIn\('query', variantQueries\)/);
    expect(mineSrc).toMatch(/groupByRaw\(CANON_URL_SQL\)/); // per owned PAGE, not per query
    expect(mineSrc).toMatch(/sum\(position \* impressions\) \/ NULLIF\(sum\(impressions\), 0\) <= \?/);
    expect(mineSrc).toMatch(/THRESHOLDS\.strikingDistancePositionMax/);
    expect(mineSrc).not.toMatch(/\.distinct\('query'\)/); // existence-only check is the inert-lane bug
    expect(mineSrc).toMatch(/buildListicleFamilyRefreshOpp\(group\.entries, group\.service, group\.city\)/);
    expect(mineSrc).toMatch(/served\.hit\.position >= THRESHOLDS\.strikingDistancePositionMin/);
  });

  test('a served family becomes a striking_distance refresh of the mapped page with family provenance (Codex r9)', () => {
    const fam = {
      key: 'drought+florida+plants+tolerant',
      impressions: 102,
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
    const opp = buildListicleFamilyRefreshOpp([{ fam, served }], 'tree-shrub', null);
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
    // Page-keyed dedupe: two families served by the same page merge.
    expect(opp.dedupe_key).toContain('listicle_family::');
    expect(opp.dedupe_key).toContain(served.hit.page_url.slice(0, 60));
    // Router anchoring contract this bucket relies on.
    const routerSrc = require('fs').readFileSync(require.resolve('../services/content/decision-router'), 'utf8');
    expect(routerSrc).toMatch(/PAGE_ANCHORED_BUCKETS = new Set\(\[.*'listicle_family'.*\]\)/);
  });

  test('two families served by one page merge into a single refresh with combined provenance (Codex r11)', () => {
    const famA = {
      key: 'drought+florida+plants+tolerant',
      impressions: 102,
      variants: [
        { query: 'drought tolerant plants florida', impressions: 48, position: 12 },
        { query: 'florida drought tolerant plants', impressions: 30, position: 9 },
        { query: 'plants florida drought tolerant', impressions: 24, position: 15 },
      ],
    };
    const famB = {
      key: 'florida+native+plants+types',
      impressions: 64,
      variants: [
        { query: 'types of native plants florida', impressions: 40, position: 11 },
        { query: 'florida native plants types', impressions: 24, position: 13 },
      ],
    };
    const page = 'https://wavespestcontrol.com/blog/florida-native-plants/';
    const opp = buildListicleFamilyRefreshOpp([
      { fam: famA, served: { variant: famA.variants[1], hit: { page_url: page, position: 8.2 } } },
      { fam: famB, served: { variant: famB.variants[0], hit: { page_url: page, position: 6.1 } } },
    ], 'tree-shrub', null);
    // One row; page-keyed dedupe could never hold two — so BOTH families'
    // demand must ride in it or one is silently lost forever.
    expect(opp.signal_metadata.impressions).toBe(166);
    expect(opp.signal_metadata.family_count).toBe(2);
    expect(opp.signal_metadata.family_size).toBe(5);
    expect(opp.signal_metadata.family_keys).toEqual([famA.key, famB.key]); // impression-desc
    expect(opp.signal_metadata.family_key).toBe(famA.key); // primary = highest-impression family
    // Anchor query/position come from the best-ranking served variant.
    expect(opp.query).toBe('types of native plants florida');
    expect(opp.signal_metadata.avg_position).toBe(6.1);
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
  });

  test('served/unserved transitions retire the stale opposite row (Codex r10)', () => {
    // Earlier-run pending blog row + newly served family → the blog must be
    // skipped (family_intent_now_served) or it drafts the competing post
    // until expiry; mirror: page drops out of striking distance → the stale
    // pending refresh row is skipped (family_no_longer_served).
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/seo/gsc-opportunity-miner'), 'utf8');
    const mineSrc = src.slice(src.indexOf('async mineListicleFamily'), src.indexOf('async mineNoContentYet'));
    expect(mineSrc).toMatch(/skip_reason: 'family_intent_now_served'/);
    expect(mineSrc).toMatch(/dedupe_key: listicleFamilyDedupeKey\(fam\.key\)/);
    expect(mineSrc).toMatch(/skip_reason: 'family_no_longer_served'/);
    // Merged refresh rows carry family_keys; the mirror retirement must
    // match ANY member family — via jsonb_exists, never the bare
    // question-mark operator (knex binding trap).
    expect(mineSrc).toMatch(/jsonb_exists\(COALESCE\(signal_metadata->'family_keys', '\[\]'::jsonb\), \?\)/);
    // Automatic transitions retire to REVIVABLE 'expired', never sticky
    // 'skipped' — one ranking oscillation must not permanently suppress the
    // lane (the upsert revives expired rows by contract; Codex r11).
    expect((mineSrc.match(/status: 'expired', skip_reason: 'family_/g) || []).length).toBe(2);
    expect(mineSrc).not.toMatch(/status: 'skipped', skip_reason: 'family_/);
    // Both cleanups touch ONLY pending rows — frozen states stay records.
    expect(mineSrc).toMatch(/status: 'pending',\s*\n\s*action_type: 'new_supporting_blog'/);
    // And both are mutateQueue-guarded: mineAll({ persist: false }) is a
    // READ-ONLY preview (--no-persist, facts-population analysis) and must
    // never retire live queue work just for being inspected.
    expect(src).toMatch(/async mineListicleFamily\(since, \{ mutateQueue = true \} = \{\}\)/);
    expect(src).toMatch(/this\.mineListicleFamily\(since, \{ mutateQueue: persist \}\)/);
    expect((mineSrc.match(/if \(mutateQueue\) \{/g) || []).length).toBe(2);
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
});
