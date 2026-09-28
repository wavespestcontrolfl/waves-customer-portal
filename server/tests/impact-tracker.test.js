jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ getPr: jest.fn() }));

const tracker = require('../services/seo/impact-tracker');
const GitHubClient = require('../services/content-astro/github-client');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { computeVerdict } = tracker;
const { median, clicksPct, positionDelta, etDayAnchor, parseAstroPrNumber, resolveRunPageUrl, aeoVerdict, normalizeQueryCohort, queryLift, domainFromUrl } = tracker._internals;

describe('normalizeQueryCohort — frozen target-query cohort', () => {
  test('trims, dedupes case-insensitively, drops empties, caps at 3', () => {
    expect(normalizeQueryCohort([
      ' bed bug treatment bradenton ',
      'Bed Bug Treatment Bradenton',
      '',
      null,
      'pest control parrish',
      'lawn care venice',
      'termite inspection sarasota',
    ])).toEqual(['bed bug treatment bradenton', 'pest control parrish', 'lawn care venice']);
  });
  test('accepts {query} objects and non-array input', () => {
    expect(normalizeQueryCohort([{ query: 'flea treatment' }, { query: null }])).toEqual(['flea treatment']);
    expect(normalizeQueryCohort(null)).toEqual([]);
    expect(normalizeQueryCohort('not-an-array')).toEqual([]);
  });
});

describe('queryLift — blogr-style before/after per target query', () => {
  test('prefers page position over site position on both sides', () => {
    const r = queryLift({
      baseline: { page: { position: 18 }, site: { position: 12 } },
      window: { page: { position: 8, clicks: 40, impressions: 900 }, site: { position: 9 } },
    });
    expect(r.before_position).toBe(18);
    expect(r.after_position).toBe(8);
    expect(r.position_delta).toBe(10); // positive = moved up
    expect(r.clicks).toBe(40);
    expect(r.impressions).toBe(900);
  });
  test('new article: before falls back to sitewide position (another page ranked)', () => {
    const r = queryLift({
      baseline: { page: { position: null }, site: { position: 22 } },
      window: { page: { position: 6, clicks: 12, impressions: 300 } },
    });
    expect(r.before_position).toBe(22);
    expect(r.position_delta).toBe(16);
  });
  test('after is strictly page-scoped — a ranking sibling page must not read as this article ranking', () => {
    const r = queryLift({
      baseline: { page: { position: null }, site: { position: 15 } },
      window: { page: { position: null, clicks: 0, impressions: 0 }, site: { position: 14 } },
    });
    expect(r.after_position).toBeNull();
    expect(r.position_delta).toBeNull();
    expect(r.clicks).toBe(0);
  });
  test('site was not ranking at all → before null, delta null', () => {
    const r = queryLift({
      baseline: { page: { position: null }, site: { position: null } },
      window: { page: { position: 7, clicks: 5, impressions: 100 } },
    });
    expect(r.before_position).toBeNull();
    expect(r.after_position).toBe(7);
    expect(r.position_delta).toBeNull();
  });
  test('no data at all → all nulls / zeros', () => {
    const r = queryLift({});
    expect(r.before_position).toBeNull();
    expect(r.after_position).toBeNull();
    expect(r.position_delta).toBeNull();
    expect(r.clicks).toBe(0);
  });
});

describe('domainFromUrl', () => {
  test('strips www and handles bad input', () => {
    expect(domainFromUrl('https://www.wavespestcontrol.com/blog/x/')).toBe('wavespestcontrol.com');
    expect(domainFromUrl('/blog/relative/')).toBeNull();
  });
});

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

describe('AEO feedback loop covers aeo_question_gap', () => {
  const { aeoQueryIdsForRun } = tracker._internals;
  function fakeDb(rowsByTable) {
    const calls = [];
    const database = (table) => {
      const q = { table, filters: [] };
      q.where = (...a) => { q.filters.push(['where', ...a]); return q; };
      q.whereIn = (...a) => { q.filters.push(['whereIn', ...a]); return q; };
      q.whereRaw = (...a) => { q.filters.push(['whereRaw', ...a]); return q; };
      q.select = async () => { calls.push(q); return rowsByTable[table] || []; };
      q.update = async () => 1;
      return q;
    };
    return { database, calls };
  }

  test('a question row watches exactly its own active managed query; aeo_gap keeps city×service', async () => {
    const { database, calls } = fakeDb({ seo_llm_mention_queries: [{ id: 42 }] });
    const question = 'How do I get rid of German cockroaches in my Florida home — should I hire a professional?';
    expect(await aeoQueryIdsForRun(database, { bucket: 'aeo_question_gap', query: question })).toEqual([42]);
    expect(calls[0].filters).toEqual([['where', { active: true, query: question }]]);
    expect(await aeoQueryIdsForRun(database, { bucket: 'aeo_question_gap', query: null })).toEqual([]);
    await aeoQueryIdsForRun(database, { bucket: 'aeo_gap', city: 'Sarasota', service: 'pest' });
    expect(calls[1].filters.map((f) => f[0])).toEqual(['where', 'whereRaw', 'whereRaw']);
  });

  test.each([
    ['query-id', 'seo_llm_mention_queries'],
    ['run-context', 'autonomous_runs as r'],
  ])('a transient %s lookup failure throws instead of freezing an incomplete impact row; the retry records the cohort', async (_label, failingTable) => {
    let lookupFails = true;
    const inserts = [];
    // Chainable fake: every builder method returns the chain; awaiting it
    // resolves per table.
    const database = (table) => {
      const chain = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            const value = table === 'seo_llm_mention_queries'
              ? (lookupFails && failingTable === table ? Promise.reject(new Error('connection reset')) : Promise.resolve([{ id: 42 }]))
              : Promise.resolve([]);
            return value.then.bind(value);
          }
          if (prop === 'first') {
            return async () => {
              if (table !== 'autonomous_runs as r') return undefined;
              if (lookupFails && failingTable === table) throw new Error('connection reset');
              return { bucket: 'aeo_question_gap', query: 'Q?', city: null, service: 'pest' };
            };
          }
          if (prop === 'insert') return (row) => { inserts.push(row); return chain; };
          if (prop === 'returning') return async () => [inserts[inserts.length - 1]];
          return () => chain;
        },
      });
      return chain;
    };
    database.raw = (sql) => sql;
    const args = { db: database, runId: 'run-1', pageUrl: 'https://www.wavespestcontrol.com/termite/termite-bond/' };
    await expect(tracker.snapshotBaseline(args)).rejects.toThrow('connection reset');
    expect(inserts).toHaveLength(0); // nothing frozen — sweepNewlyLive retries this run
    lookupFails = false;
    await tracker.snapshotBaseline(args);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ bucket: 'aeo_question_gap', aeo_query_ids: JSON.stringify([42]) });
  });

  test('a question-gap verdict counts only the engines that originally missed the target', async () => {
    const page = 'https://www.wavespestcontrol.com/termite/termite-bond/';
    const deployed = new Date(Date.now() - 40 * 86400_000);
    const day = (n) => etDateString(addETDays(new Date(), -n));
    const obs = (platform, n, cited) => ({ llm_platform: platform, check_date: day(n), measurement_version: 2, answer_available: true,
      citations_complete: true, waves_cited_urls: JSON.stringify(cited ? [page] : []) });
    const run = async (mentions, bucket = 'aeo_question_gap') => {
      const updates = [];
      const database = (table) => {
        const f = {};
        const q = {
          where(a, b) { if (typeof a === 'string') f[a] = b; return q; },
          whereIn(c, v) { f[c] = v; return q; },
          join() { return q; },
          first: async () => ({ signal_metadata: { engines_missing: [{ platform: 'chatgpt' }, { platform: 'gemini' }, { platform: 'claude' }] } }),
          select: async () => {
            if (table === 'content_optimization_impact') {
              return [{ id: 1, bucket, run_id: 'run-1', page_url: page, aeo_query_ids: [7], deployed_at: deployed }];
            }
            return mentions.filter((m) => !f.llm_platform || f.llm_platform.includes(m.llm_platform));
          },
          update: async (u) => { updates.push(u); return 1; },
        };
        return q;
      };
      await tracker.checkAeoVisibility({ db: database });
      return updates[0];
    };
    // Perplexity already cited the target when the question qualified; its
    // later hits alone are not a treatment success.
    const alreadyCiting = [1, 2, 3, 4, 5].map((n) => obs('perplexity', n, true));
    const missingStillAbsent = [1, 2, 3, 4, 5].map((n) => obs('chatgpt', n, false));
    expect(await run([...alreadyCiting, ...missingStillAbsent])).toMatchObject({ aeo_verdict: 'still_absent', aeo_now_cited: false });
    expect(await run(alreadyCiting)).toMatchObject({ aeo_verdict: 'insufficient_data' });
    // An originally missing engine citing the target is.
    const recovered = [...missingStillAbsent.slice(1), obs('gemini', 1, true)];
    expect(await run([...alreadyCiting, ...recovered])).toMatchObject({ aeo_verdict: 'now_cited', aeo_now_cited: true });
    // aeo_gap keeps its all-engine evaluator.
    expect(await run(alreadyCiting, 'aeo_gap')).toMatchObject({ aeo_verdict: 'now_cited' });
  });

  test('citation rechecks select both AEO buckets', async () => {
    const { database, calls } = fakeDb({ content_optimization_impact: [] });
    await tracker.checkAeoVisibility({ db: database });
    expect(calls[0].filters[0]).toEqual(['whereIn', 'bucket', ['aeo_gap', 'aeo_question_gap']]);
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

describe('launchVerdict — net-new pages, no baseline to diff against', () => {
  const { launchVerdict } = tracker;
  const L = (impressions, clicks, position) => launchVerdict({ window: { impressions, clicks, position } });

  test('a real launch that earns traffic reads as improved', () => {
    // The prod page that exposed this: 8,283 impressions, filed as
    // insufficient_data by the diff regime because it had no "before".
    expect(L(8283, 120, 8).verdict).toBe('improved');
    expect(L(166, 3, 14).verdict).toBe('improved');
  });

  test('impressions alone are enough when the page is actually ranking', () => {
    expect(L(60, 0, 12).verdict).toBe('improved');
  });

  test('registered but going nowhere is neutral, not a failure to measure', () => {
    expect(L(60, 0, null).verdict).toBe('neutral');   // volume, no rank, no clicks
    expect(L(60, 0, 55).verdict).toBe('neutral');     // ranking too deep to matter
    expect(L(10, 2, 9).verdict).toBe('neutral');      // clicks prove it is real, volume too thin to call
  });

  test('genuinely nothing yet is insufficient_data', () => {
    expect(L(0, 0, null).verdict).toBe('insufficient_data');
    expect(L(12, 0, null).verdict).toBe('insufficient_data');
  });

  test('NEVER regressed — pausedBuckets counts those, and a dud launch must not pause a lane', () => {
    const matrix = [[0, 0, null], [5, 0, 90], [60, 0, null], [8283, 120, 1], [29, 0, 3], [30, 0, 21]];
    for (const [i, c, pos] of matrix) expect(L(i, c, pos).verdict).not.toBe('regressed');
  });

  test('confidence reflects volume, and lift stays null (a diff-regime concept)', () => {
    expect(L(200, 5, 3).confidence).toBe(1);
    expect(L(50, 0, 10).confidence).toBe(0.25);
    expect(L(8283, 120, 8).estimated_lift_position).toBeNull();
    expect(L(8283, 120, 8).estimated_lift_clicks_pct).toBeNull();
  });
});

describe('computeVerdict routing — chosen by the DATA, never by action_type', () => {
  test('ZERO baseline presence → launch regime, so a page that earned traffic is graded', () => {
    expect(computeVerdict({
      baseline: { impressions: 0, clicks: 0, position: 0 },
      window: { impressions: 900, clicks: 20, position: 6 },
      controlDeltas: [],
    }).verdict).toBe('improved');
  });

  test('a THIN but present baseline is NOT a launch — a decline there must not read as improved', () => {
    // 29 impressions is thin, not absent. Grading it on absolute window
    // traffic would call this decline (pos 5 -> 25, clicks 3 -> 1) an
    // improvement, clear its lift, and disable regression pausing for it.
    const r = computeVerdict({
      baseline: { impressions: 29, clicks: 3, position: 5 },
      window: { impressions: 40, clicks: 1, position: 25 },
      controlDeltas: [{ position_delta: 0, clicks_pct: 0 }],
    });
    expect(r.verdict).toBe('insufficient_data');
    expect(r.verdict).not.toBe('improved');
  });

  test('isEmptyBaseline is zero on EVERY axis, not just impressions', () => {
    const { isEmptyBaseline } = tracker;
    expect(isEmptyBaseline({ impressions: 0, clicks: 0, position: 0 })).toBe(true);
    expect(isEmptyBaseline({})).toBe(true);
    expect(isEmptyBaseline({ impressions: 0, clicks: 0, position: 18 })).toBe(false);
    expect(isEmptyBaseline({ impressions: 0, clicks: 2, position: 0 })).toBe(false);
    expect(isEmptyBaseline({ impressions: 5, clicks: 0, position: 0 })).toBe(false);
  });

  test('a page WITH a real baseline is never treated as a launch, even if it declined', () => {
    // The trap: new_supporting_blog can UPDATE an existing slug, so routing on
    // action_type would ignore this 2,000-impression baseline and score an
    // obvious decline as a successful launch.
    const r = computeVerdict({
      baseline: { position: 6, clicks: 300, impressions: 2000 },
      window: { position: 22, clicks: 40, position_: null, impressions: 1500 },
      controlDeltas: [{ position_delta: 0, clicks_pct: 0 }, { position_delta: 0, clicks_pct: 2 }],
    });
    expect(r.verdict).toBe('regressed');
    expect(r.estimated_lift_position).not.toBeNull();
  });

  test('a REFRESH still gets the control-adjusted diff regime', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 50, impressions: 2000 },
      window: { position: 10, clicks: 80, impressions: 2200 },
      controlDeltas: [{ position_delta: 0, clicks_pct: 5 }, { position_delta: 0, clicks_pct: 0 }],
    });
    expect(r.verdict).toBe('improved');
    expect(r.estimated_lift_position).not.toBeNull();
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

  test('thin baseline impressions → insufficient_data (unchanged: thin is not absent)', () => {
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

  // A query failure is otherwise indistinguishable from "nothing is paused".
  // Fine for the runner (it has downstream gates and must not stall on a
  // blip); NOT fine for a caller that would act on the empty result.
  describe('lookup failure', () => {
    const explodingDb = () => {
      const builder = {
        where: () => builder, whereNotNull: () => builder, groupBy: () => builder, select: () => builder,
        count: () => Promise.reject(new Error('connection terminated')),
      };
      return () => builder;
    };

    test('defaults to an empty list so the runner keeps drafting', async () => {
      await expect(tracker.pausedBuckets({ db: explodingDb() })).resolves.toEqual([]);
    });

    test('strict:true propagates it so a caller that would act on [] can stand down', async () => {
      await expect(tracker.pausedBuckets({ db: explodingDb(), strict: true }))
        .rejects.toThrow('connection terminated');
    });
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
            brief_target_keyword: 'Bed Bug Treatment Bradenton',
            opportunity_page_url: null,
            opportunity_query: 'bed bug treatment bradenton',
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
    // Target-keyword + mined query collapse into one frozen cohort entry
    // (case-insensitive dedupe), each carrying page + site baselines.
    const cohort = JSON.parse(insertedImpacts[0].query_cohort);
    expect(cohort).toHaveLength(1);
    expect(cohort[0].query).toBe('Bed Bug Treatment Bradenton');
    expect(cohort[0].baseline).toHaveProperty('page');
    // Relative page URL → no resolvable domain → sitewide aggregation is
    // skipped (null), never a cross-network aggregate.
    expect(cohort[0].baseline.site).toBeNull();
    expect(result).toEqual({ created: 1, scanned: 1 });
  });
});

describe('selectControlPages — zero-baseline guard', () => {
  // 2026-08-08: all 28 impact rows showed count:0 controls. Root cause was the
  // 0.4x–2.5x band around a zero launch baseline — [0, 0] excludes every page
  // by construction, so the query was a guaranteed-empty scan that read as
  // "control selection broken". Launches never use controls; skip the work.
  test('a launch-regime page (0 baseline impressions) returns [] without querying', async () => {
    const database = jest.fn(() => { throw new Error('db must not be queried for a zero-impression baseline'); });
    await expect(tracker.selectControlPages(database, {
      pageUrl: '/blog/new-page/',
      serviceCategory: 'pest',
      cityTarget: null,
      baselineImpressions: 0,
      startDate: '2026-07-01',
      endDate: '2026-07-28',
    })).resolves.toEqual([]);
    expect(database).not.toHaveBeenCalled();
  });

  test('a real baseline still queries, band-filters, and excludes optimized pages', async () => {
    const sums = [
      { page_url: '/a/', impressions: 50 },   // in band [40, 250]
      { page_url: '/b/', impressions: 400 },  // out of band
      { page_url: '/c/', impressions: 90 },   // in band but already optimized
    ];
    const database = jest.fn((table) => (table === 'gsc_pages'
      ? chain({ sumResult: sums })
      : chain({ selectResult: [{ page_url: '/c/' }] })));
    await expect(tracker.selectControlPages(database, {
      pageUrl: '/blog/target/',
      serviceCategory: null,
      cityTarget: null,
      baselineImpressions: 100,
      startDate: '2026-07-01',
      endDate: '2026-07-28',
    })).resolves.toEqual(['/a/']);
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
