/**
 * Action-aware minimum score (blog floor) — new_supporting_blog opportunities
 * clear a lower, env-tunable floor (AUTONOMOUS_BLOG_MIN_SCORE, default
 * THRESHOLDS.blogMinScoreToAct) while every other action type keeps the
 * global minScoreToAct. Covers the helper, the miner persist gate, and the
 * claimNext/peek SQL so all three gates agree — a floor honored at persist
 * but not at claim (or vice versa) silently starves the lane.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { THRESHOLDS, minScoreToActFor } = require('../services/content/scoring-config');
const queue = require('../services/content/opportunity-queue');

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTONOMOUS_BLOG_MIN_SCORE;
  delete process.env.AUTONOMOUS_REWRITE_MIN_SCORE;
});

describe('minScoreToActFor', () => {
  test('non-blog action types keep the global floor', () => {
    expect(minScoreToActFor('refresh_existing_page')).toBe(THRESHOLDS.minScoreToAct);
    expect(minScoreToActFor('rewrite_title_meta')).toBe(THRESHOLDS.minScoreToAct);
    expect(minScoreToActFor('add_internal_links')).toBe(THRESHOLDS.minScoreToAct);
    expect(minScoreToActFor(null)).toBe(THRESHOLDS.minScoreToAct);
  });

  test('new_supporting_blog defaults to the blog floor', () => {
    expect(minScoreToActFor('new_supporting_blog')).toBe(THRESHOLDS.blogMinScoreToAct);
  });

  test('AUTONOMOUS_BLOG_MIN_SCORE overrides the blog floor', () => {
    process.env.AUTONOMOUS_BLOG_MIN_SCORE = '50';
    expect(minScoreToActFor('new_supporting_blog')).toBe(50);
  });

  test('override is clamped to [20, minScoreToAct] and ignores junk', () => {
    process.env.AUTONOMOUS_BLOG_MIN_SCORE = '5';
    expect(minScoreToActFor('new_supporting_blog')).toBe(20);
    process.env.AUTONOMOUS_BLOG_MIN_SCORE = '90';
    expect(minScoreToActFor('new_supporting_blog')).toBe(THRESHOLDS.minScoreToAct);
    process.env.AUTONOMOUS_BLOG_MIN_SCORE = 'junk';
    expect(minScoreToActFor('new_supporting_blog')).toBe(THRESHOLDS.blogMinScoreToAct);
  });

  test('AUTONOMOUS_REWRITE_MIN_SCORE lowers the rewrite floor; unset keeps the global (lane dark)', () => {
    // Default already asserted above: rewrite_title_meta == global floor.
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '60';
    expect(minScoreToActFor('rewrite_title_meta')).toBe(60);
    // Other actions unaffected by the rewrite env.
    expect(minScoreToActFor('refresh_existing_page')).toBe(THRESHOLDS.minScoreToAct);
    expect(minScoreToActFor('new_supporting_blog')).toBe(THRESHOLDS.blogMinScoreToAct);
  });

  test('rewrite override clamps to [20, minScoreToAct] and ignores junk', () => {
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '5';
    expect(minScoreToActFor('rewrite_title_meta')).toBe(20);
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '90';
    expect(minScoreToActFor('rewrite_title_meta')).toBe(THRESHOLDS.minScoreToAct);
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = 'junk';
    expect(minScoreToActFor('rewrite_title_meta')).toBe(THRESHOLDS.minScoreToAct);
  });
});

// Minimal knex-chain fake for the queue methods under test.
function chainResolving(rows) {
  const q = {
    where: jest.fn(() => q),
    whereNot: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    orderBy: jest.fn(() => q),
    limit: jest.fn(() => q),
    select: jest.fn(() => Promise.resolve(rows)),
    update: jest.fn(() => Promise.resolve(0)),
  };
  return q;
}

describe('claimNext action-aware floor', () => {
  test('default call: blog rows clear at the blog floor while others need the global floor', async () => {
    db.mockImplementation(() => chainResolving([])); // recoverStaleClaims
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({});

    const [sql, bindings] = db.raw.mock.calls[0];
    expect(sql).toMatch(/score >= CASE WHEN action_type = 'new_supporting_blog' OR \(bucket = 'listicle_family' AND action_type = 'refresh_existing_page'\) THEN \?::numeric WHEN action_type = 'rewrite_title_meta' OR \(bucket = 'link_boost' AND signal_metadata->>'source_bucket' = 'ctr_rewrite'\) THEN \?::numeric ELSE \?::numeric END/);
    // bindings: [claimed_at, maxAttempts, blogFloor, rewriteFloor,
    // minScore] — the lifetime-claim-budget filter binds between the claim
    // timestamp and the score floors.
    expect(bindings[1]).toBe(5);
    expect(bindings[2]).toBe(THRESHOLDS.blogMinScoreToAct);
    expect(bindings[3]).toBe(THRESHOLDS.minScoreToAct); // rewrite floor default = global (dark)
    expect(bindings[4]).toBe(THRESHOLDS.minScoreToAct);
  });

  test('an explicitly LOWER caller minScore applies to every action type', async () => {
    db.mockImplementation(() => chainResolving([]));
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({ minScore: 0 });

    const [, bindings] = db.raw.mock.calls[0];
    expect(bindings[2]).toBe(0);
    expect(bindings[3]).toBe(0);
    expect(bindings[4]).toBe(0);
  });

  test('an explicitly HIGHER caller minScore restricts blogs too (no blog-floor leak on --min-score=90)', async () => {
    db.mockImplementation(() => chainResolving([]));
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({ minScore: 90 });

    const [, bindings] = db.raw.mock.calls[0];
    expect(bindings[2]).toBe(90);
    expect(bindings[3]).toBe(90);
    expect(bindings[4]).toBe(90);
  });

  test('env-tuned blog floor flows into the claim bindings', async () => {
    process.env.AUTONOMOUS_BLOG_MIN_SCORE = '50';
    db.mockImplementation(() => chainResolving([]));
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({});

    const [, bindings] = db.raw.mock.calls[0];
    expect(bindings[2]).toBe(50);
  });

  test('env-tuned rewrite floor flows into the claim bindings (persist and claim gates agree)', async () => {
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '60';
    db.mockImplementation(() => chainResolving([]));
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({});

    const [, bindings] = db.raw.mock.calls[0];
    expect(bindings[3]).toBe(60);
    expect(bindings[4]).toBe(THRESHOLDS.minScoreToAct);
  });
});

describe('peek action-aware floor', () => {
  test('peek at the default uses the same CASE floor so previews match claims', async () => {
    const q = chainResolving([]);
    db.mockImplementation(() => q);

    await queue.peek({ minScore: THRESHOLDS.minScoreToAct });

    expect(q.whereRaw).toHaveBeenCalledWith(
      expect.stringMatching(/CASE WHEN action_type = 'new_supporting_blog' OR \(bucket = 'listicle_family' AND action_type = 'refresh_existing_page'\) THEN \?::numeric WHEN action_type = 'rewrite_title_meta' OR \(bucket = 'link_boost' AND signal_metadata->>'source_bucket' = 'ctr_rewrite'\) THEN \?::numeric ELSE \?::numeric END/),
      [THRESHOLDS.blogMinScoreToAct, THRESHOLDS.minScoreToAct, THRESHOLDS.minScoreToAct],
    );
  });

  test('peek with an explicit override applies it to blogs too', async () => {
    const q = chainResolving([]);
    db.mockImplementation(() => q);

    await queue.peek({ minScore: 90 });

    expect(q.whereRaw).toHaveBeenCalledWith(expect.any(String), [90, 90, 90]);
  });

  test('peek without minScore applies no floor (unchanged behavior)', async () => {
    const q = chainResolving([]);
    db.mockImplementation(() => q);

    await queue.peek({});

    // peek always applies the availability-window filter (operator-seeded
    // rows can carry a future available_at — see intercept-brief-seeder),
    // but no score floor unless an explicit minScore is passed.
    const rawClauses = q.whereRaw.mock.calls.map((c) => c[0]);
    expect(rawClauses.some((c) => /CASE WHEN action_type/.test(c))).toBe(false);
  });
});

describe('miner persistAll action-aware gate', () => {
  const miner = require('../services/seo/gsc-opportunity-miner');

  function opp(over = {}) {
    return {
      bucket: 'seasonal_rising',
      action_type: 'new_supporting_blog',
      query: 'exterminator near me',
      page_url: null,
      service: 'pest',
      city: null,
      score: 49,
      score_breakdown: {},
      signal_metadata: {},
      dedupe_key: `k-${over.query || over.score || Math.abs(over.score ?? 0)}-${over.action_type || 'blog'}-${JSON.stringify(over).length}`,
      ...over,
    };
  }

  test('persists blog rows at/above the blog floor, drops below it; non-blog still needs the global floor', async () => {
    db.raw.mockResolvedValue({ rowCount: 1 });

    const persisted = await miner.persistAll([
      opp({ score: 49, dedupe_key: 'blog-49' }),                                  // blog ≥45 → kept
      opp({ score: 44, dedupe_key: 'blog-44' }),                                  // blog <45 → dropped
      opp({ score: 69, action_type: 'rewrite_title_meta', dedupe_key: 'rw-69' }), // non-blog <75 → dropped
      opp({ score: 87, action_type: 'refresh_existing_page', dedupe_key: 'rf-87' }), // non-blog ≥75 → kept
    ]);

    expect(persisted).toBe(2);
    const persistedKeys = db.raw.mock.calls.map(([, b]) => b).map((b) => b[12]);
    expect(persistedKeys).toContain('blog-49');
    expect(persistedKeys).toContain('rf-87');
    expect(persistedKeys).not.toContain('blog-44');
    expect(persistedKeys).not.toContain('rw-69');
  });

  test('AUTONOMOUS_REWRITE_MIN_SCORE admits rewrite rows at the tuned floor', async () => {
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '60';
    db.raw.mockResolvedValue({ rowCount: 1 });

    const persisted = await miner.persistAll([
      opp({ score: 69, action_type: 'rewrite_title_meta', page_url: 'https://x/p/', dedupe_key: 'rw-69-open' }), // ≥60 → kept
      opp({ score: 55, action_type: 'rewrite_title_meta', page_url: 'https://x/q/', dedupe_key: 'rw-55' }),      // <60 → dropped
      opp({ score: 69, action_type: 'refresh_existing_page', page_url: 'https://x/r/', dedupe_key: 'rf-69' }),   // refresh keeps global 75 → dropped
    ]);

    expect(persisted).toBe(1);
    const persistedKeys = db.raw.mock.calls.map(([, b]) => b).map((b) => b[12]);
    expect(persistedKeys).toContain('rw-69-open');
    expect(persistedKeys).not.toContain('rw-55');
    expect(persistedKeys).not.toContain('rf-69');
  });

  test('a ctr_rewrite-derived link_boost companion inherits the rewrite floor (both gates move together)', async () => {
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '60';
    db.raw.mockResolvedValue({ rowCount: 1 });

    const persisted = await miner.persistAll([
      // Companion carries the parent's score by design — it must clear
      // the parent's floor, not the global one, or the parent persists
      // while its promised link boost silently dies.
      opp({
        score: 69,
        bucket: 'link_boost',
        action_type: 'add_internal_links',
        page_url: 'https://x/p/',
        signal_metadata: { source_bucket: 'ctr_rewrite' },
        dedupe_key: 'lb-from-rewrite-69',
      }),
      // A decay_refresh-derived companion keeps the global floor.
      opp({
        score: 69,
        bucket: 'link_boost',
        action_type: 'add_internal_links',
        page_url: 'https://x/q/',
        signal_metadata: { source_bucket: 'decay_refresh' },
        dedupe_key: 'lb-from-decay-69',
      }),
    ]);

    expect(persisted).toBe(1);
    const persistedKeys = db.raw.mock.calls.map(([, b]) => b).map((b) => b[12]);
    expect(persistedKeys).toContain('lb-from-rewrite-69');
    expect(persistedKeys).not.toContain('lb-from-decay-69');
  });

  // Reconciliation harness: records every where/whereNotIn/whereIn/update
  // so the tests can assert exactly which rows a run would retire.
  function reconcileHarness(staleRows) {
    const updates = [];
    const locks = [];
    db.mockImplementation((table) => {
      const q = {
        _filters: null, _notIn: null, _in: null,
        where: jest.fn((f) => { q._filters = f; return q; }),
        whereNot: jest.fn(() => q),
        whereNotIn: jest.fn((c, v) => { q._notIn = [c, v]; return q; }),
        whereIn: jest.fn((c, v) => { q._in = [c, v]; return q; }),
        whereRaw: jest.fn(() => q),
        whereNotNull: jest.fn(() => q),
        // Two shapes share this builder: `select(...)` awaited directly
        // (the live-parent companion protection lookup) and
        // `select(...).forUpdate()` (the reconciliation, which LOCKS the
        // rows it is about to retire and then updates them by locked key,
        // so predicate and update target are asserted apart).
        select: jest.fn(() => q),
        then: (resolve, reject) => Promise.resolve(
          q._filters?.bucket === 'ctr_rewrite' ? staleRows : []
        ).then(resolve, reject),
        forUpdate: jest.fn(() => {
          locks.push({ table, filters: q._filters, notIn: q._notIn });
          return Promise.resolve(q._filters?.bucket === 'ctr_rewrite' ? staleRows : []);
        }),
        update: jest.fn((u) => {
          updates.push({ table, filters: q._filters, notIn: q._notIn, in: q._in, updates: u });
          return Promise.resolve(1);
        }),
      };
      return q;
    });
    db.raw.mockResolvedValue({ rowCount: 1 });
    return { updates, locks };
  }

  const staleRow = {
    dedupe_key: 'ctr_rewrite::pest::_::https://x/old-page/',
    page_url: 'https://x/old-page/',
    service: 'pest',
    city: null,
  };

  test('a moved ctr_rewrite target retires the superseded row and its companion by EXACT key', async () => {
    // The ranking URL for a query moves A → B between mines. B queues
    // under a new dedupe key (page_url is in the key), so A's pending row
    // would stay claimable for 14 days and rewrite a page the current
    // evidence no longer selects.
    const { updates, locks } = reconcileHarness([staleRow]);

    await miner.persistAll([
      opp({
        score: 87,
        bucket: 'ctr_rewrite',
        action_type: 'rewrite_title_meta',
        query: 'plaster bagworm',
        service: 'pest',
        city: null,
        page_url: 'https://x/new-page/',
        dedupe_key: 'ctr::new-page',
      }),
    ]);

    // Selection: pending rows for the query that are NOT the current
    // target — taken under FOR UPDATE so a concurrent claim cannot slip
    // between the read and the retirement.
    const lock = locks.find((l) => l.filters?.bucket === 'ctr_rewrite');
    expect(lock.filters).toMatchObject({ bucket: 'ctr_rewrite', query: 'plaster bagworm', status: 'pending' });
    expect(lock.notIn).toEqual(['dedupe_key', ['ctr::new-page']]);

    const retirements = updates.filter((u) => u.updates.skip_reason === 'ctr_rewrite_target_moved');
    expect(retirements).toHaveLength(2);
    // 1. the parent, updated by the exact LOCKED key
    expect(retirements[0].in).toEqual(['dedupe_key', [staleRow.dedupe_key]]);
    expect(retirements[0].updates.status).toBe('expired'); // revivable, not sticky-skipped
    // 2. the companion by EXACT dedupe key — never by page, since a
    //    link_boost key carries no query and is shared across queries.
    expect(retirements[1].filters).toMatchObject({ bucket: 'link_boost', status: 'pending' });
    expect(retirements[1].in[0]).toBe('dedupe_key');
    expect(retirements[1].in[1]).toEqual(['link_boost::pest::_::https://x/old-page/']);
  });

  test('a query with NO actionable target this run retires all of its pending rewrites', async () => {
    // Coverage vanished / CTR recovered / materiality failed → page_url
    // null. The previous target must not stay claimable just because the
    // new candidate is non-actionable.
    const { updates, locks } = reconcileHarness([staleRow]);

    await miner.persistAll([
      opp({
        score: 87,
        bucket: 'ctr_rewrite',
        action_type: 'do_not_publish',
        query: 'plaster bagworm',
        page_url: null,
        dedupe_key: 'ctr::no-target',
      }),
    ]);

    expect(updates.some((u) => u.updates.skip_reason === 'ctr_rewrite_target_moved')).toBe(true);
    // No active key to exclude — every pending row for the query goes.
    const lock = locks.find((l) => l.filters?.bucket === 'ctr_rewrite');
    expect(lock.filters).toMatchObject({ bucket: 'ctr_rewrite', query: 'plaster bagworm', status: 'pending' });
    expect(lock.notIn).toBe(null);
  });

  test('a BELOW-FLOOR candidate does not defend its stored row (stale higher score would stay claimable)', async () => {
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '60';
    const { updates, locks } = reconcileHarness([staleRow]);

    await miner.persistAll([
      opp({
        score: 40, // under the 60 floor → persistAll drops it
        bucket: 'ctr_rewrite',
        action_type: 'rewrite_title_meta',
        query: 'plaster bagworm',
        service: 'pest',
        city: null,
        page_url: 'https://x/new-page/',
        dedupe_key: 'ctr::weak',
      }),
    ]);

    expect(updates.some((u) => u.updates.skip_reason === 'ctr_rewrite_target_moved')).toBe(true);
    // Nothing persisted, so nothing defends the query: no key exclusion.
    const lock = locks.find((l) => l.filters?.bucket === 'ctr_rewrite');
    expect(lock.notIn).toBe(null);
  });

  test("a decay_refresh parent's companion is protected even when the per-run cap omitted it", async () => {
    const { updates } = reconcileHarness([staleRow]);

    await miner.persistAll([
      opp({
        score: 87,
        bucket: 'ctr_rewrite',
        action_type: 'rewrite_title_meta',
        query: 'plaster bagworm',
        service: 'pest',
        city: null,
        page_url: 'https://x/new-page/',
        dedupe_key: 'ctr::new-page',
      }),
      // Live decay_refresh parent on the OLD page — its link-boost
      // companion shares the stale row's companion key and must survive,
      // even though LINK_BOOST_MAX_PER_RUN emitted no link_boost row.
      opp({
        score: 87,
        bucket: 'decay_refresh',
        action_type: 'refresh_existing_page',
        query: null,
        service: 'pest',
        city: null,
        page_url: 'https://x/old-page/',
        dedupe_key: 'decay::old-page',
      }),
    ]);

    const companionRetirements = updates.filter((u) => u.updates.skip_reason === 'ctr_rewrite_target_moved'
      && u.filters?.bucket === 'link_boost');
    expect(companionRetirements).toHaveLength(0);
  });

  test('a BELOW-FLOOR same-page parent does not protect the companion it can no longer justify', async () => {
    // Symmetric to the parent-row rule: persistAll drops the below-floor
    // parent, so its previously-persisted companion must not be shielded
    // — it would stay claimable at its stale higher score while the
    // parent row is being retired.
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '60';
    const { updates } = reconcileHarness([staleRow]);

    await miner.persistAll([
      opp({
        score: 87,
        bucket: 'ctr_rewrite',
        action_type: 'rewrite_title_meta',
        query: 'plaster bagworm',
        service: 'pest',
        city: null,
        page_url: 'https://x/new-page/',
        dedupe_key: 'ctr::new-page',
      }),
      // Same page as the stale row, but below the 60 floor → dropped by
      // persistAll, so it defends nothing.
      opp({
        score: 45,
        bucket: 'ctr_rewrite',
        action_type: 'rewrite_title_meta',
        query: 'bagworms florida',
        service: 'pest',
        city: null,
        page_url: 'https://x/old-page/',
        dedupe_key: 'ctr::old-page-weak',
      }),
    ]);

    // The companion is NOT shielded by the below-floor parent: it is
    // retired, keyed exactly. (The harness hands the same stale row to
    // every query's lock, so the retirement can be issued more than once;
    // what matters is that it happens and targets the right key.)
    const companionRetirements = updates.filter((u) => u.updates.skip_reason === 'ctr_rewrite_target_moved'
      && u.filters?.bucket === 'link_boost');
    expect(companionRetirements.length).toBeGreaterThanOrEqual(1);
    for (const r of companionRetirements) {
      expect(r.in).toEqual(['dedupe_key', ['link_boost::pest::_::https://x/old-page/']]);
    }
  });

  test('a companion still referenced by another live candidate is preserved', async () => {
    // Two queries legitimately target the same page; the companion key
    // carries no query, so retiring it for one query would delete the
    // other's still-valid work. The protection covers candidates whose
    // companion the per-run cap omitted, hence it is derived from the
    // rewrite candidates themselves.
    const { updates } = reconcileHarness([staleRow]);

    await miner.persistAll([
      opp({
        score: 87,
        bucket: 'ctr_rewrite',
        action_type: 'rewrite_title_meta',
        query: 'plaster bagworm',
        service: 'pest',
        city: null,
        page_url: 'https://x/new-page/',
        dedupe_key: 'ctr::new-page',
      }),
      // Another query still points at the OLD page → its companion lives.
      opp({
        score: 87,
        bucket: 'ctr_rewrite',
        action_type: 'rewrite_title_meta',
        query: 'bagworms florida',
        service: 'pest',
        city: null,
        page_url: 'https://x/old-page/',
        dedupe_key: 'ctr::old-page-other-query',
      }),
    ]);

    const companionRetirements = updates.filter((u) => u.updates.skip_reason === 'ctr_rewrite_target_moved'
      && u.filters?.bucket === 'link_boost');
    expect(companionRetirements).toHaveLength(0);
  });

  test('recovered-query sweep expires pending rewrites the bucket no longer emits', async () => {
    // A query whose CTR climbed back, or whose impressions/position left
    // the gates, vanishes from mineCtrRewrite entirely — per-query
    // reconciliation never sees it, so the lane sweep must.
    const { updates, locks } = reconcileHarness([staleRow]);

    await miner._sweepRecoveredCtrRewrites([
      opp({
        bucket: 'ctr_rewrite',
        action_type: 'rewrite_title_meta',
        query: 'still qualifying',
        service: 'pest',
        city: null,
        page_url: 'https://x/live/',
        dedupe_key: 'ctr::live',
      }),
    ]);

    const lock = locks.find((l) => l.filters?.bucket === 'ctr_rewrite');
    expect(lock.filters).toMatchObject({ bucket: 'ctr_rewrite', status: 'pending' });
    // Only queries the bucket no longer emits are swept.
    expect(lock.notIn).toEqual(['query', ['still qualifying']]);

    const sweeps = updates.filter((u) => u.updates.skip_reason === 'ctr_rewrite_signal_recovered');
    expect(sweeps.length).toBeGreaterThanOrEqual(1);
    expect(sweeps[0].in).toEqual(['dedupe_key', [staleRow.dedupe_key]]);
    expect(sweeps[0].updates.status).toBe('expired'); // revivable when the signal returns
  });

  test('a companion is protected by a LIVE QUEUE parent absent from this batch (errored/dipped bucket)', async () => {
    // decay_refresh errors this run, or its signal dips: its pending
    // refresh row is not in the batch, but it is still in the queue and
    // still needs its shared companion.
    const updates = [];
    db.mockImplementation((table) => {
      const q = {
        _filters: null, _notIn: null, _in: null,
        where: jest.fn((f) => { q._filters = f; return q; }),
        whereNot: jest.fn(() => q), whereNotIn: jest.fn((c, v) => { q._notIn = [c, v]; return q; }),
        whereIn: jest.fn((c, v) => { q._in = [c, v]; return q; }),
        whereRaw: jest.fn(() => q), whereNotNull: jest.fn(() => q),
        select: jest.fn(() => q),
        // The live-parent lookup (no bucket filter) returns a refresh row
        // on the SAME page as the stale rewrite row.
        then: (res, rej) => Promise.resolve(
          q._filters?.bucket === 'ctr_rewrite'
            ? [staleRow]
            : [{ page_url: 'https://x/old-page/', service: 'pest', city: null }]
        ).then(res, rej),
        forUpdate: jest.fn(() => Promise.resolve(q._filters?.bucket === 'ctr_rewrite' ? [staleRow] : [])),
        update: jest.fn((u) => {
          updates.push({ table, filters: q._filters, in: q._in, updates: u });
          return Promise.resolve(1);
        }),
      };
      return q;
    });
    db.raw.mockResolvedValue({ rowCount: 1 });

    await miner.persistAll([
      opp({
        score: 87, bucket: 'ctr_rewrite', action_type: 'rewrite_title_meta',
        query: 'plaster bagworm', service: 'pest', city: null,
        page_url: 'https://x/new-page/', dedupe_key: 'ctr::new-page',
      }),
    ]);

    // Parent row retired (updated by its locked key), companion spared by
    // the live queue parent.
    const retirements = updates.filter((u) => u.updates.skip_reason === 'ctr_rewrite_target_moved');
    expect(retirements.some((u) => u.in?.[1]?.includes(staleRow.dedupe_key))).toBe(true);
    expect(retirements.filter((u) => u.filters?.bucket === 'link_boost')).toHaveLength(0);
  });

  test('recovered-query sweep rethrows so a failure rolls back the persist transaction', async () => {
    db.mockImplementation(() => {
      const q = {
        where: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        select: jest.fn(() => q),
        forUpdate: jest.fn(() => Promise.reject(new Error('boom'))),
      };
      return q;
    });

    await expect(miner._sweepRecoveredCtrRewrites([])).rejects.toThrow('boom');
  });

  test('demoted near-me candidate below floor expires its stale pending blog row (rollout hygiene)', async () => {
    const updates = [];
    db.mockImplementation((table) => {
      const q = {
        where: jest.fn((f) => { q._filters = f; return q; }),
        update: jest.fn((u) => { updates.push({ table, filters: q._filters, updates: u }); return Promise.resolve(1); }),
      };
      return q;
    });
    db.raw.mockResolvedValue({ rowCount: 1 });

    // near-me query demoted to do_not_publish by actionForOpportunity →
    // score 49 < 75 non-blog floor → dropped, but the stale pending
    // new_supporting_blog row sharing the dedupe_key must be expired
    const persisted = await miner.persistAll([
      opp({ score: 49, action_type: 'do_not_publish', query: 'exterminator near me', dedupe_key: 'nearme-49' }),
    ]);

    expect(persisted).toBe(0);
    const cleanup = updates.find((u) => u.table === 'opportunity_queue');
    expect(cleanup.filters).toMatchObject({
      dedupe_key: 'nearme-49',
      status: 'pending',
      action_type: 'new_supporting_blog',
    });
    expect(cleanup.updates).toMatchObject({ status: 'skipped', skip_reason: 'transactional_query_not_blog_material' });
  });
});
