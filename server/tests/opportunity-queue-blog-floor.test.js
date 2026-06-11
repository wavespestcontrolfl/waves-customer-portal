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
});

// Minimal knex-chain fake for the queue methods under test.
function chainResolving(rows) {
  const q = {
    where: jest.fn(() => q),
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
    expect(sql).toMatch(/score >= CASE WHEN action_type = 'new_supporting_blog' THEN \?::numeric ELSE \?::numeric END/);
    // bindings: [claimed_at, blogFloor, minScore]
    expect(bindings[1]).toBe(THRESHOLDS.blogMinScoreToAct);
    expect(bindings[2]).toBe(THRESHOLDS.minScoreToAct);
  });

  test('an explicitly LOWER caller minScore applies to every action type', async () => {
    db.mockImplementation(() => chainResolving([]));
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({ minScore: 0 });

    const [, bindings] = db.raw.mock.calls[0];
    expect(bindings[1]).toBe(0);
    expect(bindings[2]).toBe(0);
  });

  test('an explicitly HIGHER caller minScore restricts blogs too (no blog-floor leak on --min-score=90)', async () => {
    db.mockImplementation(() => chainResolving([]));
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({ minScore: 90 });

    const [, bindings] = db.raw.mock.calls[0];
    expect(bindings[1]).toBe(90);
    expect(bindings[2]).toBe(90);
  });

  test('env-tuned blog floor flows into the claim bindings', async () => {
    process.env.AUTONOMOUS_BLOG_MIN_SCORE = '50';
    db.mockImplementation(() => chainResolving([]));
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({});

    const [, bindings] = db.raw.mock.calls[0];
    expect(bindings[1]).toBe(50);
  });
});

describe('peek action-aware floor', () => {
  test('peek at the default uses the same CASE floor so previews match claims', async () => {
    const q = chainResolving([]);
    db.mockImplementation(() => q);

    await queue.peek({ minScore: THRESHOLDS.minScoreToAct });

    expect(q.whereRaw).toHaveBeenCalledWith(
      expect.stringMatching(/CASE WHEN action_type = 'new_supporting_blog' THEN \?::numeric ELSE \?::numeric END/),
      [THRESHOLDS.blogMinScoreToAct, THRESHOLDS.minScoreToAct],
    );
  });

  test('peek with an explicit override applies it to blogs too', async () => {
    const q = chainResolving([]);
    db.mockImplementation(() => q);

    await queue.peek({ minScore: 90 });

    expect(q.whereRaw).toHaveBeenCalledWith(expect.any(String), [90, 90]);
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
});
