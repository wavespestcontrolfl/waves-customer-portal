jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ getPr: jest.fn() }));

const tracker = require('../services/seo/impact-tracker');
const GitHubClient = require('../services/content-astro/github-client');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { computeVerdict } = tracker;
const { median, clicksPct, positionDelta, etDayAnchor, parseAstroPrNumber, resolveRunPageUrl, aeoVerdict } = tracker._internals;

describe('aeoVerdict — answer-engine visibility feedback', () => {
  test('too few observation days → insufficient_data', () => {
    expect(aeoVerdict({ observedDays: 3, wavesHitDays: 0 }).verdict).toBe('insufficient_data');
    expect(aeoVerdict({ observedDays: 3, wavesHitDays: 2 }).nowCited).toBeNull();
  });
  test('enough days, Waves never cited → still_absent', () => {
    const r = aeoVerdict({ observedDays: 10, wavesHitDays: 0 });
    expect(r.verdict).toBe('still_absent');
    expect(r.nowCited).toBe(false);
  });
  test('enough days, Waves cited at least once → now_cited', () => {
    const r = aeoVerdict({ observedDays: 10, wavesHitDays: 4 });
    expect(r.verdict).toBe('now_cited');
    expect(r.nowCited).toBe(true);
  });
  test('observedDays exactly at the minimum still produces a verdict', () => {
    expect(aeoVerdict({ observedDays: 5, wavesHitDays: 1, minObservations: 5 }).verdict).toBe('now_cited');
  });
});

describe('impact-tracker pure helpers', () => {
  test('median handles odd/even/empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  test('positionDelta is positive when position improves (number drops)', () => {
    expect(positionDelta(15, 10)).toBe(5);
    expect(positionDelta(10, 14)).toBe(-4);
  });
  test('clicksPct', () => {
    expect(clicksPct(50, 80)).toBe(60);
    expect(clicksPct(0, 5)).toBe(500); // guards divide-by-zero with max(base,1)
  });

  test('resolves PR-backed run URLs from brief/opportunity/draft payload fields', () => {
    expect(parseAstroPrNumber('https://github.com/wavespestcontrolfl/astro/pull/124')).toBe(124);
    expect(resolveRunPageUrl({
      published_url: null,
      brief_target_url: null,
      opportunity_page_url: null,
      draft_payload: JSON.stringify({ url: '/blog/pr-test/' }),
    })).toBe('/blog/pr-test/');
    expect(resolveRunPageUrl({
      published_url: null,
      brief_target_url: '/pest-control-sarasota-fl/',
      opportunity_page_url: '/fallback/',
    })).toBe('/pest-control-sarasota-fl/');
  });
});

describe('etDayAnchor — ET-safe window math', () => {
  test('a date-only string stays on its ET calendar day after +14d (not slipped early)', () => {
    // measurement_start stored as a plain calendar date.
    const day14 = etDateString(addETDays(etDayAnchor('2026-05-28'), 14));
    expect(day14).toBe('2026-06-11');
  });
  test('a pg Date at UTC midnight resolves to the intended ET calendar day', () => {
    // node-pg returns `date` columns as a Date at UTC midnight.
    const pgDate = new Date('2026-05-28T00:00:00.000Z');
    const day21 = etDateString(addETDays(etDayAnchor(pgDate), 21));
    expect(day21).toBe('2026-06-18');
  });
});

describe('computeVerdict (diff-in-diff)', () => {
  const ctrlFlat = [{ position_delta: 0, clicks_pct: 5 }, { position_delta: 0, clicks_pct: 0 }];

  test('page improves while controls are flat → improved', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 50, impressions: 2000 },
      window: { position: 10, clicks: 80, impressions: 2200 },
      controlDeltas: ctrlFlat,
    });
    expect(r.verdict).toBe('improved');
    expect(r.estimated_lift_position).toBeGreaterThanOrEqual(2);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test('page and controls improve equally → neutral (rising tide removed)', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 50, impressions: 2000 },
      window: { position: 10, clicks: 80, impressions: 2200 },
      controlDeltas: [{ position_delta: 5, clicks_pct: 60 }, { position_delta: 5, clicks_pct: 60 }],
    });
    expect(r.verdict).toBe('neutral');
    expect(Math.abs(r.estimated_lift_position)).toBeLessThan(2);
  });

  test('clicks jump well above control → improved on clicks alone', () => {
    const r = computeVerdict({
      baseline: { position: 8, clicks: 100, impressions: 5000 },
      window: { position: 8, clicks: 160, impressions: 5200 },
      controlDeltas: [{ position_delta: 0, clicks_pct: 10 }, { position_delta: 0, clicks_pct: 8 }],
    });
    expect(r.verdict).toBe('improved');
    expect(r.estimated_lift_clicks_pct).toBeGreaterThanOrEqual(20);
  });

  test('page drops while controls flat → regressed', () => {
    const r = computeVerdict({
      baseline: { position: 12, clicks: 60, impressions: 3000 },
      window: { position: 16, clicks: 40, impressions: 2800 },
      controlDeltas: ctrlFlat,
    });
    expect(r.verdict).toBe('regressed');
    expect(r.estimated_lift_position).toBeLessThanOrEqual(-3);
  });

  test('thin baseline impressions → insufficient_data', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 2, impressions: 12 },
      window: { position: 9, clicks: 5, impressions: 20 },
      controlDeltas: ctrlFlat,
    });
    expect(r.verdict).toBe('insufficient_data');
  });

  test('no control pages → insufficient_data', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 50, impressions: 2000 },
      window: { position: 9, clicks: 90, impressions: 2200 },
      controlDeltas: [],
    });
    expect(r.verdict).toBe('insufficient_data');
  });

  test('large lift but low confidence (thin data) → neutral, not improved', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 4, impressions: 40 },
      window: { position: 8, clicks: 9, impressions: 40 },
      controlDeltas: [{ position_delta: 0, clicks_pct: 0 }],
    });
    expect(r.confidence).toBeLessThan(0.7);
    expect(r.verdict).toBe('neutral');
  });
});

describe('pausedBuckets — confirmed-regression gating', () => {
  test('counts only verdict=regressed rows with a 21-day confirmation', async () => {
    const calls = { where: [], whereNotNull: [] };
    const builder = {
      where: (...a) => { calls.where.push(a); return builder; },
      whereNotNull: (c) => { calls.whereNotNull.push(c); return builder; },
      groupBy: () => builder,
      select: () => builder,
      count: () => Promise.resolve([{ bucket: 'thin_content', regressions: '3' }]),
    };
    const fakeDb = () => builder;
    const out = await tracker.pausedBuckets({ db: fakeDb });
    expect(calls.where).toContainEqual(['verdict', 'regressed']);
    expect(calls.whereNotNull).toContain('checked_21d_at');
    expect(out).toEqual([{ bucket: 'thin_content', regressions: 3 }]);
  });
});

describe('sweepNewlyLive', () => {
  test('baselines merged PR-backed runs that do not yet have published_url', async () => {
    GitHubClient.getPr.mockResolvedValue({
      number: 124,
      merged: true,
      merged_at: '2026-05-28T10:00:00Z',
      merge_commit_sha: 'abc123',
    });
    const updatedRuns = [];
    const insertedImpacts = [];

    function fakeDb(table) {
      if (table === 'autonomous_runs as r') {
        return chain({
          selectResult: [{
            run_id: 'run_pr_1',
            published_url: null,
            astro_pr_url: 'https://github.com/wavespestcontrolfl/astro/pull/124',
            completed_at: new Date('2026-05-28T09:00:00Z'),
            brief_target_url: '/blog/pr-test/',
            opportunity_page_url: null,
            draft_payload: JSON.stringify({ url: '/blog/pr-test/' }),
          }],
          firstResult: { bucket: 'decay_refresh' },
        });
      }
      if (table === 'autonomous_runs') {
        return chain({ updateSink: updatedRuns });
      }
      if (table === 'gsc_pages') {
        return chain({
          firstResult: { clicks: 0, impressions: 0, position: null, service_category: 'pest', city_target: null },
          sumResult: [],
        });
      }
      if (table === 'content_optimization_impact') {
        return chain({ selectResult: [], insertSink: insertedImpacts, countResult: [] });
      }
      return chain({});
    }
    fakeDb.raw = jest.fn((sql) => sql);

    const result = await tracker.sweepNewlyLive({ db: fakeDb, now: new Date('2026-05-28T12:00:00Z') });

    expect(GitHubClient.getPr).toHaveBeenCalledWith(124);
    expect(updatedRuns[0]).toEqual(expect.objectContaining({ published_url: '/blog/pr-test/' }));
    expect(insertedImpacts[0]).toEqual(expect.objectContaining({
      run_id: 'run_pr_1',
      page_url: '/blog/pr-test/',
      bucket: 'decay_refresh',
    }));
    expect(result).toEqual({ created: 1, scanned: 1 });
  });
});

function chain({ selectResult = [], firstResult = null, sumResult = [], insertSink = null, updateSink = null, countResult = [] } = {}) {
  const builder = {};
  ['leftJoin', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'where', 'andWhere', 'andWhereNot', 'groupBy', 'orderBy', 'whereRaw', 'onConflict', 'ignore'].forEach((method) => {
    builder[method] = jest.fn((arg, ...rest) => {
      if (typeof arg === 'function') arg(builder);
      return builder;
    });
  });
  builder.select = jest.fn(() => builder);
  builder.sum = jest.fn(() => Promise.resolve(sumResult));
  builder.count = jest.fn(() => Promise.resolve(countResult));
  builder.first = jest.fn(() => Promise.resolve(firstResult));
  builder.insert = jest.fn((payload) => {
    if (insertSink) insertSink.push(payload);
    return builder;
  });
  builder.update = jest.fn((payload) => {
    if (updateSink) updateSink.push(payload);
    return Promise.resolve(1);
  });
  builder.returning = jest.fn(() => Promise.resolve(insertSink ? [{ id: 'impact_1', ...insertSink[insertSink.length - 1] }] : []));
  builder.then = (resolve, reject) => Promise.resolve(selectResult).then(resolve, reject);
  return builder;
}
