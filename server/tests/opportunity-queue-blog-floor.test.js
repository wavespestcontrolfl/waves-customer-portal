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
const { routeIdentity } = require('../services/seo/gsc-opportunity-miner')._internals;

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
    expect(sql).toMatch(/score >= CASE WHEN action_type = 'new_supporting_blog' OR \(bucket = 'listicle_family' AND action_type = 'refresh_existing_page'\) OR \(bucket = 'no_content_yet' AND action_type = 'create_or_refresh_city_service_page'\) THEN \?::numeric WHEN action_type = 'rewrite_title_meta' OR \(bucket = 'link_boost' AND signal_metadata->>'source_bucket' = 'ctr_rewrite'\) THEN \?::numeric ELSE \?::numeric END/);
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
      expect.stringMatching(/CASE WHEN action_type = 'new_supporting_blog' OR \(bucket = 'listicle_family' AND action_type = 'refresh_existing_page'\) OR \(bucket = 'no_content_yet' AND action_type = 'create_or_refresh_city_service_page'\) THEN \?::numeric WHEN action_type = 'rewrite_title_meta' OR \(bucket = 'link_boost' AND signal_metadata->>'source_bucket' = 'ctr_rewrite'\) THEN \?::numeric ELSE \?::numeric END/),
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

  // Only the canonical 28-day mine may RETIRE rows, so tests that exercise
  // reconciliation must declare themselves canonical the way mineAll does.
  const persistCanonical = (opps) => miner.persistAll(opps, null, { canonicalMine: true });

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
    db.raw.mockResolvedValue({ rowCount: 1, rows: [{ domain: 'x' }] });

    const persisted = await persistCanonical([
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
    db.raw.mockResolvedValue({ rowCount: 1, rows: [{ domain: 'x' }] });

    const persisted = await persistCanonical([
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
    db.raw.mockResolvedValue({ rowCount: 1, rows: [{ domain: 'x' }] });

    const persisted = await persistCanonical([
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
  const SWEPT_BUCKETS = new Set(['ctr_rewrite', 'no_content_yet']);
  const SINCE = '2026-07-15'; // any since → the sweep consults coverage

  function reconcileHarness(staleRows) {
    const updates = [];
    const locks = [];
    const selects = [];
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
        then: (resolve, reject) => {
          selects.push({ table, filters: q._filters, notIn: q._notIn, in: q._in });
          return Promise.resolve(
            SWEPT_BUCKETS.has(q._filters?.bucket) ? staleRows : []
          ).then(resolve, reject);
        },
        forUpdate: jest.fn(() => {
          locks.push({ table, filters: q._filters, notIn: q._notIn, in: q._in });
          // The sweep's authoritative lock is key-scoped (parents AND
          // companions in one statement); everything it locks is returned.
          if (q._in?.[0] === 'dedupe_key') {
            return Promise.resolve(q._in[1].map((k) => ({ dedupe_key: k })));
          }
          return Promise.resolve(SWEPT_BUCKETS.has(q._filters?.bucket) ? staleRows : []);
        }),
        update: jest.fn((u) => {
          updates.push({ table, filters: q._filters, notIn: q._notIn, in: q._in, updates: u });
          return Promise.resolve(1);
        }),
      };
      return q;
    });
    // db.raw serves the persist upsert (rowCount) AND
    // _queryPageMapCoveredDomains (rows). staleRow's page host is 'x'.
    db.raw.mockResolvedValue({ rowCount: 1, rows: [{ domain: 'x' }, { domain: 'wavespestcontrol.com' }] });
    return { updates, locks, selects };
  }

  const staleRow = {
    dedupe_key: 'ctr_rewrite::pest::_::https://x/old-page/',
    page_url: 'https://x/old-page/',
    service: 'pest',
    city: null,
  };

  test('the sweep retires pending rows whose dedupe key this mine did not re-emit', async () => {
    // ONE mechanism now: a moved target, a recovered signal, a query that
    // became served, and lost map evidence all present identically — the
    // stored key is simply absent from this mine's persistable set.
    const { updates, selects } = reconcileHarness([staleRow]);

    await miner._sweepRecoveredQueries('ctr_rewrite', [
      opp({
        score: 87, bucket: 'ctr_rewrite', action_type: 'rewrite_title_meta',
        query: 'still qualifying', service: 'pest', city: null,
        page_url: 'https://x/live/', dedupe_key: 'ctr::live',
      }),
    ], null, null, new Set(), SINCE);

    // Keyed on dedupe keys, not query strings: one query can produce
    // several (query, service, city, intent) tuples, and a surviving
    // tuple must not shelter a sibling whose evidence disappeared.
    const probe = selects.find((x) => x.filters?.bucket === 'ctr_rewrite');
    expect(probe.notIn).toEqual(['dedupe_key', ['ctr::live']]);

    const sweeps = updates.filter((u) => u.updates.skip_reason === 'ctr_rewrite_signal_recovered');
    expect(sweeps.length).toBeGreaterThanOrEqual(1);
    expect(sweeps[0].in[1]).toContain(staleRow.dedupe_key);
    expect(sweeps[0].updates.status).toBe('expired'); // revivable when the signal returns
  });

  test('a BELOW-FLOOR candidate does not defend its stored row (stale higher score would stay claimable)', async () => {
    process.env.AUTONOMOUS_REWRITE_MIN_SCORE = '60';
    const { selects } = reconcileHarness([staleRow]);

    await miner._sweepRecoveredQueries('ctr_rewrite', [
      opp({
        score: 40, // under the 60 floor → persistAll drops it → defends nothing
        bucket: 'ctr_rewrite', action_type: 'rewrite_title_meta',
        query: 'plaster bagworm', service: 'pest', city: null,
        page_url: 'https://x/new-page/', dedupe_key: 'ctr::weak',
      }),
    ], null, null, new Set(), SINCE);

    const probe = selects.find((x) => x.filters?.bucket === 'ctr_rewrite');
    expect(probe.notIn).toBe(null); // no live keys at all
  });

  test('a companion queued BEFORE seo_actions claimed its page is retired', async () => {
    // The derivation-time fence only covers companions minted this run; a
    // page can acquire an open legacy action afterwards, leaving both
    // mechanisms independently claimable.
    const updates = [];
    db.mockImplementation(() => {
      const q = {
        _filters: null, _in: null,
        where: jest.fn((f) => { q._filters = f; return q; }),
        whereNotNull: jest.fn(() => q), whereNot: jest.fn(() => q),
        whereIn: jest.fn((c, v) => { q._in = [c, v]; return q; }),
        whereNotIn: jest.fn(() => q), whereRaw: jest.fn(() => q),
        select: jest.fn(() => q),
        then: (res, rej) => Promise.resolve([]).then(res, rej),
        forUpdate: jest.fn(() => Promise.resolve([
          { dedupe_key: 'lb::owned', page_url: 'https://x/owned/' },
          { dedupe_key: 'lb::ours', page_url: 'https://x/ours/' },
        ])),
        update: jest.fn((u) => { updates.push({ in: q._in, updates: u }); return Promise.resolve(1); }),
      };
      return q;
    });

    await miner._retireLegacyOwnedCompanions(null, new Set([routeIdentity('https://x/owned/')]));

    expect(updates).toHaveLength(1);
    expect(updates[0].in).toEqual(['dedupe_key', ['lb::owned']]); // only the owned page
    expect(updates[0].updates).toMatchObject({ status: 'expired', skip_reason: 'seo_actions_owns_page' });
  });

  test('rows on a domain WITHOUT fresh coverage are never swept', async () => {
    // ctr_rewrite mines every property, so one stale spoke sync makes that
    // property's queries vanish from the candidate set entirely — they
    // never reach exemptQueries — and their pending rows would read as
    // recovered. A row is judged only when ITS page's domain is covered.
    const { updates } = reconcileHarness([staleRow]);
    // Coverage excludes staleRow's host ('x').
    db.raw.mockResolvedValue({ rowCount: 1, rows: [{ domain: 'wavespestcontrol.com' }] });

    await miner._sweepRecoveredQueries('ctr_rewrite', [], null, null, new Set(), SINCE);

    expect(updates.filter((u) => u.updates?.skip_reason === 'ctr_rewrite_signal_recovered')).toHaveLength(0);
  });

  test('the sweep also covers no_content_yet (its stale rows CREATE pages)', async () => {
    const { updates } = reconcileHarness([staleRow]);

    await miner._sweepRecoveredQueries('no_content_yet', [
      opp({
        score: 60, bucket: 'no_content_yet', action_type: 'new_supporting_blog',
        query: 'live gap', service: 'pest', city: null, page_url: null,
        dedupe_key: 'ncy::live',
      }),
    ], null, null, new Set(), SINCE);

    expect(updates.some((u) => u.updates.skip_reason === 'no_content_yet_signal_recovered')).toBe(true);
  });

  test('parents and companions are locked in ONE statement (no claim can slip between)', async () => {
    // Locking parents, running more queries, then locking companions left
    // a gap in which claimNext (FOR UPDATE SKIP LOCKED) could claim a
    // companion — the later select would omit it and only the parent
    // would be expired, leaving a claimed orphan doing obsolete link work.
    const order = [];
    db.mockImplementation(() => {
      const q = {
        _filters: null, _in: null, _notIn: null,
        where: jest.fn((f) => { if (typeof f === 'object') q._filters = f; return q; }),
        whereNot: jest.fn(() => q), whereNotIn: jest.fn((c, v) => { q._notIn = [c, v]; return q; }),
        whereIn: jest.fn((c, v) => { q._in = [c, v]; return q; }),
        whereRaw: jest.fn(() => q), whereNotNull: jest.fn(() => q),
        select: jest.fn(() => q),
        then: (res, rej) => {
          order.push('probe(unlocked)');
          return Promise.resolve(q._filters?.bucket === 'ctr_rewrite' ? [staleRow] : []).then(res, rej);
        },
        forUpdate: jest.fn(() => {
          order.push(`lock:${(q._in?.[1] || []).length}keys`);
          return Promise.resolve((q._in?.[1] || []).map((k) => ({ dedupe_key: k })));
        }),
        update: jest.fn(() => { order.push('expire'); return Promise.resolve(1); }),
      };
      return q;
    });
    db.raw.mockResolvedValue({ rowCount: 1, rows: [{ domain: 'x' }] });

    await miner._sweepRecoveredQueries('ctr_rewrite', [], null, null, new Set(), SINCE);

    // Exactly ONE lock, covering the parent AND its companion, then one
    // expiry — no second lock after any intervening statement.
    expect(order.filter((o) => o.startsWith('lock:'))).toEqual(['lock:2keys']);
    expect(order[order.length - 1]).toBe('expire');
  });

  test('a companion is protected by a LIVE QUEUE parent absent from this batch (errored/dipped bucket)', async () => {
    // decay_refresh errors this run, or its signal dips: its refresh row
    // is not in the batch, but it is still in the queue and still needs
    // its shared companion. The rows being retired are excluded from that
    // lookup so they cannot shield their own companions.
    const updates = [];
    db.mockImplementation((table) => {
      const q = {
        _filters: null, _in: null, _notIn: null,
        where: jest.fn((f) => { q._filters = f; return q; }),
        whereNot: jest.fn(() => q),
        whereNotIn: jest.fn((c, v) => { q._notIn = [c, v]; return q; }),
        whereIn: jest.fn((c, v) => { q._in = [c, v]; return q; }),
        whereRaw: jest.fn(() => q), whereNotNull: jest.fn(() => q),
        select: jest.fn(() => q),
        then: (res, rej) => {
          const excluded = new Set(q._notIn?.[0] === 'dedupe_key' ? q._notIn[1] : []);
          const live = [
            { page_url: 'https://x/old-page/', service: 'pest', city: null, dedupe_key: 'decay::old' },
            { page_url: staleRow.page_url, service: staleRow.service, city: staleRow.city, dedupe_key: staleRow.dedupe_key },
          ].filter((r) => !excluded.has(r.dedupe_key));
          return Promise.resolve(q._filters?.bucket === 'ctr_rewrite' ? [staleRow] : live).then(res, rej);
        },
        forUpdate: jest.fn(() => Promise.resolve(
          q._in?.[0] === 'dedupe_key'
            ? q._in[1].map((k) => ({ dedupe_key: k }))
            : (q._filters?.bucket === 'ctr_rewrite' ? [staleRow] : [])
        )),
        update: jest.fn((u) => {
          updates.push({ table, filters: q._filters, in: q._in, updates: u });
          return Promise.resolve(1);
        }),
      };
      return q;
    });
    db.raw.mockResolvedValue({ rowCount: 1, rows: [{ domain: 'x' }] });

    await miner._sweepRecoveredQueries('ctr_rewrite', [], null, null, new Set(), SINCE);

    // Parent retired; the companion is spared by the unrelated live
    // parent, so its key never enters the locked/expired set.
    const expired = updates.flatMap((u) => u.in?.[1] || []);
    expect(expired).toContain(staleRow.dedupe_key);
    expect(expired.some((k) => String(k).startsWith('link_boost::'))).toBe(false);
  });


  test('recovered-query sweep rethrows so a failure rolls back the persist transaction', async () => {
    db.mockImplementation(() => {
      const q = {
        where: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        select: jest.fn(() => q),
        then: (res, rej) => Promise.reject(new Error('boom')).then(res, rej),
        forUpdate: jest.fn(() => Promise.reject(new Error('boom'))),
      };
      return q;
    });

    await expect(miner._sweepRecoveredQueries('ctr_rewrite', [], null, null, new Set(), SINCE)).rejects.toThrow('boom');
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
    db.raw.mockResolvedValue({ rowCount: 1, rows: [{ domain: 'x' }] });

    // near-me query demoted to do_not_publish by actionForOpportunity →
    // score 49 < 75 non-blog floor → dropped, but the stale pending
    // new_supporting_blog row sharing the dedupe_key must be expired
    const persisted = await persistCanonical([
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
