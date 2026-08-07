/**
 * Round-15 watchdog coverage: agent-facing surfaces must treat rows Google
 * removed (missing_since stamped) as gone.
 *
 * 1. Intelligence Bar submit_review_reply — the UPDATE itself carries
 *    `missing_since IS NULL`, so a stamp landing between the read and the
 *    write (hourly reconciliation race) cannot save a reply on a removed row.
 * 2. BI get_review_snapshot — the no-_stats fallback aggregate and the
 *    newThisWeek count exclude stamped rows.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-flagship' }));
jest.mock('../config/locations', () => ({
  WAVES_LOCATIONS: [
    { id: 'bradenton', name: 'Bradenton' },
    { id: 'sarasota', name: 'Sarasota' },
  ],
}));
jest.mock('../services/customer-stages', () => ({
  whereLiveCustomer: (qb) => qb,
  CONVERSION_DATE_SQL: 'NOW()',
}));

const state = {
  rows: { google_reviews: [] },
  // Test hook: fires after the first .first() read on google_reviews, so a
  // test can stamp the row in the read-then-write window.
  afterFirstRead: null,
};

jest.mock('../models/db', () => {
  function makeQuery(table) {
    const q = { filters: [], limit: null, count: false, first: false, selects: [] };
    const api = {
      where(a, b, c) {
        if (a && typeof a === 'object' && typeof a !== 'function') {
          q.filters.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (typeof a === 'function') {
          const branches = [];
          const groupApi = {
            whereNull(col) { branches.push((r) => r[col] == null); return groupApi; },
            orWhere(col, op, val) {
              if (op === 'like') {
                const prefix = String(val).replace(/%$/, '');
                branches.push((r) => typeof r[col] === 'string' && r[col].startsWith(prefix));
              } else {
                branches.push((r) => r[col] === op);
              }
              return groupApi;
            },
          };
          a.call(groupApi);
          q.filters.push((r) => branches.some((b) => b(r)));
        } else if (c !== undefined) {
          if (b === '!=') q.filters.push((r) => r[a] !== c);
          else if (b === '>=') q.filters.push((r) => r[a] >= c);
          else if (b === '<=') q.filters.push((r) => r[a] <= c);
          else q.filters.push((r) => r[a] === c);
        } else {
          q.filters.push((r) => r[a] === b);
        }
        return api;
      },
      whereNull(col) { q.filters.push((r) => r[col] == null); return api; },
      whereNotNull(col) { q.filters.push((r) => r[col] != null); return api; },
      modify(fn, ...args) { fn(api, ...args); return api; },
      select(...cols) { q.selects = cols; return api; },
      limit(n) { q.limit = n; return api; },
      count() { q.count = true; return api; },
      orderBy() { return api; },
      first() { q.first = true; return api; },
      update(record) {
        const matched = state.rows[table].filter((r) => q.filters.every((f) => f(r)));
        matched.forEach((r) => Object.assign(r, record));
        return Promise.resolve(matched.length);
      },
      then(resolve, reject) {
        try {
          // Reads return detached copies (as knex does) — the race test's
          // hook mutates the canonical row without changing an already-read result.
          let out = state.rows[table]
            .filter((r) => q.filters.every((f) => f(r)))
            .map((r) => ({ ...r }));
          let result;
          if (q.count) {
            result = q.first ? { count: out.length } : [{ count: out.length }];
          } else if (q.selects.some((s) => s && s.__raw && s.__raw.includes('COUNT(*)'))) {
            const rated = out.filter((r) => typeof r.star_rating === 'number');
            const avg = rated.length
              ? (rated.reduce((s, r) => s + r.star_rating, 0) / rated.length).toFixed(1)
              : null;
            result = { total: String(out.length), rating: avg };
            if (!q.first) result = [result];
          } else {
            if (q.limit != null) out = out.slice(0, q.limit);
            result = q.first ? out[0] : out;
          }
          if (q.first && table === 'google_reviews' && !q.count && typeof state.afterFirstRead === 'function') {
            const hook = state.afterFirstRead;
            state.afterFirstRead = null;
            hook();
          }
          return Promise.resolve(result).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).then(resolve, reject);
        }
      },
    };
    return api;
  }
  const db = (table) => makeQuery(table);
  db.raw = (sql) => ({ __raw: sql });
  return db;
});

const { executeReviewTool } = require('../services/intelligence-bar/review-tools');
const { executeBITool } = require('../services/bi-agent-tools');

// Rolling-window fixtures derive from the clock (AGENTS.md: no hardcoded
// dates that rot past a cutoff); historical rows stay fixed — they are
// permanently outside any future seven-day window.
const daysAgoIso = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function liveReview(overrides = {}) {
  return {
    id: overrides.id || 'rev-1',
    reviewer_name: 'Pat Tester',
    star_rating: 5,
    review_text: 'Great service',
    review_reply: null,
    missing_since: null,
    created_at: daysAgoIso(1),
    ...overrides,
  };
}

function statsRow(locationId, { totalReviews, rating, syncedDaysAgo }) {
  return {
    id: `stats-${locationId}`,
    reviewer_name: '_stats',
    location_id: locationId,
    star_rating: 5,
    review_text: JSON.stringify({ rating, totalReviews }),
    review_reply: null,
    missing_since: null,
    synced_at: daysAgoIso(syncedDaysAgo),
    created_at: daysAgoIso(syncedDaysAgo),
  };
}

beforeEach(() => {
  state.rows.google_reviews = [];
  state.afterFirstRead = null;
});

describe('Intelligence Bar submit_review_reply — missing_since lockout', () => {
  test('rejects a row already stamped at read time', async () => {
    state.rows.google_reviews = [liveReview({ missing_since: '2026-08-07T09:00:00Z' })];

    const result = await executeReviewTool('submit_review_reply', {
      review_id: 'rev-1', reply_text: 'Thanks!',
    });

    expect(result.error).toMatch(/removed from Google/);
    expect(state.rows.google_reviews[0].review_reply).toBeNull();
  });

  test('race: a stamp landing between the read and the update blocks the write', async () => {
    const row = liveReview();
    state.rows.google_reviews = [row];
    // The hourly reconciliation stamps the row right after the pre-check read.
    state.afterFirstRead = () => { row.missing_since = '2026-08-07T10:00:00Z'; };

    const result = await executeReviewTool('submit_review_reply', {
      review_id: 'rev-1', reply_text: 'Thanks!',
    });

    expect(result.error).toMatch(/removed from Google/);
    expect(row.review_reply).toBeNull();
  });

  test('live row still accepts the reply', async () => {
    const row = liveReview();
    state.rows.google_reviews = [row];

    const result = await executeReviewTool('submit_review_reply', {
      review_id: 'rev-1', reply_text: 'Thanks so much!',
    });

    expect(result.success).toBe(true);
    expect(row.review_reply).toBe('Thanks so much!');
  });
});

describe('BI get_review_snapshot — stamped rows excluded', () => {
  test('fallback aggregate, newThisWeek, and unresponded sample count live rows only', async () => {
    state.rows.google_reviews = [
      liveReview({ id: 'a', star_rating: 5, created_at: daysAgoIso(1) }),
      liveReview({ id: 'b', star_rating: 5, created_at: '2026-01-01T12:00:00Z' }),
      liveReview({ id: 'c', star_rating: 4, created_at: '2026-01-02T12:00:00Z' }),
      // Removed this week: would previously inflate every number below.
      liveReview({
        id: 'd', star_rating: 1, created_at: daysAgoIso(1),
        missing_since: daysAgoIso(0.5),
      }),
    ];

    const snapshot = await executeBITool('get_review_snapshot', {});

    expect(snapshot.totalReviews).toBe(3);
    expect(snapshot.rating).toBe('4.7');
    expect(snapshot.newThisWeek).toBe(1);
    expect(snapshot.unrespondedCount).toBe(3);
    expect(snapshot.unresponded.map((r) => r.name)).not.toContain('_stats');
  });

  test('stale _stats rows are ignored — live fallback wins', async () => {
    state.rows.google_reviews = [
      // Stale snapshot (3 days old) with inflated totals for both locations.
      statsRow('bradenton', { totalReviews: 500, rating: 4.9, syncedDaysAgo: 3 }),
      statsRow('sarasota', { totalReviews: 300, rating: 4.8, syncedDaysAgo: 3 }),
      liveReview({ id: 'a', star_rating: 5 }),
      liveReview({ id: 'b', star_rating: 4 }),
    ];

    const snapshot = await executeBITool('get_review_snapshot', {});

    expect(snapshot.totalReviews).toBe(2);
    expect(snapshot.rating).toBe('4.5');
  });

  test('partial fresh _stats (one location stale) also falls back', async () => {
    state.rows.google_reviews = [
      statsRow('bradenton', { totalReviews: 500, rating: 4.9, syncedDaysAgo: 0.1 }),
      statsRow('sarasota', { totalReviews: 300, rating: 4.8, syncedDaysAgo: 3 }),
      liveReview({ id: 'a', star_rating: 5 }),
    ];

    const snapshot = await executeBITool('get_review_snapshot', {});

    expect(snapshot.totalReviews).toBe(1);
    expect(snapshot.rating).toBe('5.0');
  });

  test('fresh but malformed _stats payload falls back to live rows', async () => {
    state.rows.google_reviews = [
      statsRow('bradenton', { totalReviews: 500, rating: 4.9, syncedDaysAgo: 0.1 }),
      { ...statsRow('sarasota', { totalReviews: 300, rating: 4.8, syncedDaysAgo: 0.1 }), review_text: '{not json' },
      liveReview({ id: 'a', star_rating: 4 }),
    ];

    const snapshot = await executeBITool('get_review_snapshot', {});

    expect(snapshot.totalReviews).toBe(1);
    expect(snapshot.rating).toBe('4.0');
  });

  test('fresh and complete _stats snapshot is used', async () => {
    state.rows.google_reviews = [
      statsRow('bradenton', { totalReviews: 500, rating: 4.9, syncedDaysAgo: 0.1 }),
      statsRow('sarasota', { totalReviews: 300, rating: 4.7, syncedDaysAgo: 0.2 }),
      liveReview({ id: 'a', star_rating: 3 }),
    ];

    const snapshot = await executeBITool('get_review_snapshot', {});

    expect(snapshot.totalReviews).toBe(800);
    expect(snapshot.rating).toBe('4.8');
  });
});
