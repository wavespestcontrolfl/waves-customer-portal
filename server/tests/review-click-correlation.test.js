jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { findLikelyReviewers, findConfidentClickMatch, describeClickOffset } = require('../services/review-click-correlation');

const REVIEW_AT = '2026-08-07T18:00:00.000Z';

function clickRow(overrides = {}) {
  return {
    customer_id: 'cust-1',
    redirected_at: '2026-08-07T17:30:00.000Z',
    google_review_clicked: true,
    google_location: 'bradenton',
    first_name: 'Jane',
    last_name: 'Doe',
    phone: '+19415550100',
    email: 'jane@example.com',
    address_line1: '1 Main St',
    address_line2: null,
    city: 'Bradenton',
    state: 'FL',
    zip: '34205',
    has_left_google_review: false,
    ...overrides,
  };
}

// Chainable capture mock: filters are SQL-side in prod, so the mock returns
// the configured rows verbatim and records where() args for window assertions.
function makeConn({ clickRows = [], linkedRows = [], failClicks = false, failLinked = false } = {}) {
  const captured = { where: [], whereRaw: [] };
  const conn = (table) => {
    const isClicks = String(table).startsWith('review_requests');
    const q = {};
    const chain = () => q;
    q.join = chain;
    q.whereNull = chain;
    q.whereNotNull = chain;
    q.orderBy = chain;
    q.orderByRaw = chain;
    q.limit = chain;
    q.whereIn = chain;
    q.where = (...args) => {
      if (isClicks) captured.where.push(args);
      return q;
    };
    q.whereRaw = (...args) => {
      if (isClicks) captured.whereRaw.push(args);
      return q;
    };
    q.select = () => {
      if (isClicks) {
        return failClicks ? Promise.reject(new Error('boom')) : Promise.resolve(clickRows);
      }
      return failLinked ? Promise.reject(new Error('linked boom')) : Promise.resolve(linkedRows);
    };
    return q;
  };
  conn.captured = captured;
  return conn;
}

describe('describeClickOffset', () => {
  test('formats minutes, hours, days, and direction', () => {
    expect(describeClickOffset(23 * 60000)).toBe('23m before');
    expect(describeClickOffset(-(3 * 60 + 10) * 60000)).toBe('3h 10m after');
    expect(describeClickOffset((2 * 1440 + 4 * 60) * 60000)).toBe('2d 4h before');
    expect(describeClickOffset(0)).toBe('0m before');
  });
});

describe('findLikelyReviewers', () => {
  test('returns [] without a valid review timestamp', async () => {
    const conn = makeConn({ clickRows: [clickRow()] });
    expect(await findLikelyReviewers({}, { conn })).toEqual([]);
    expect(await findLikelyReviewers({ review_created_at: 'not-a-date' }, { conn })).toEqual([]);
  });

  test('ranks by click proximity and dedupes to each customer\'s nearest click', async () => {
    const conn = makeConn({
      clickRows: [
        clickRow({ customer_id: 'far', redirected_at: '2026-08-07T10:00:00.000Z', first_name: 'Far' }),
        clickRow({ customer_id: 'near', redirected_at: '2026-08-07T17:40:00.000Z', first_name: 'Near' }),
        // same customer, older click — the nearer one must win
        clickRow({ customer_id: 'near', redirected_at: '2026-08-07T09:00:00.000Z', first_name: 'Near' }),
      ],
    });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT, location_id: 'bradenton' }, { conn });
    expect(result.map((r) => r.customerId)).toEqual(['near', 'far']);
    expect(result[0].clickedAt).toBe('2026-08-07T17:40:00.000Z');
    expect(result[0].clickOffsetLabel).toBe('20m before');
    expect(result[0].clickedBeforeReview).toBe(true);
  });

  test('excludes customers already linked to a synced Google review', async () => {
    const conn = makeConn({
      clickRows: [
        clickRow({ customer_id: 'linked' }),
        clickRow({ customer_id: 'open', redirected_at: '2026-08-07T16:00:00.000Z' }),
      ],
      linkedRows: [{ customer_id: 'linked' }],
    });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT }, { conn });
    expect(result.map((r) => r.customerId)).toEqual(['open']);
  });

  test('excludes clicks that targeted a different location; annotates match/null, already-flagged, after-review', async () => {
    const conn = makeConn({
      clickRows: [
        // Sarasota-link click 1 minute before a Bradenton review — anti-evidence,
        // must not outrank anyone (codex r2)
        clickRow({ customer_id: 'mismatch', google_location: 'sarasota', redirected_at: '2026-08-07T17:59:00.000Z' }),
        clickRow({ customer_id: 'a', google_location: 'bradenton' }),
        clickRow({ customer_id: 'b', google_location: null, redirected_at: '2026-08-07T19:00:00.000Z', has_left_google_review: true }),
      ],
    });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT, location_id: 'bradenton' }, { conn });
    expect(result.map((r) => r.customerId).sort()).toEqual(['a', 'b']);
    const a = result.find((r) => r.customerId === 'a');
    const b = result.find((r) => r.customerId === 'b');
    expect(a.locationMatch).toBe(true);
    expect(a.alreadyFlagged).toBe(false);
    expect(b.locationMatch).toBeNull();
    expect(b.alreadyFlagged).toBe(true);
    expect(b.clickedBeforeReview).toBe(false);
    expect(b.clickOffsetLabel).toBe('1h after');
  });

  test('excludes optimistic legacy redirect stamps (redirected_at without google_review_clicked)', async () => {
    const conn = makeConn({
      clickRows: [
        // legacy promoter path: redirected_at stamped before any navigation
        clickRow({ customer_id: 'optimistic', google_review_clicked: false, redirected_at: '2026-08-07T17:58:00.000Z' }),
        clickRow({ customer_id: 'real' }),
      ],
    });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT, location_id: 'bradenton' }, { conn });
    expect(result.map((r) => r.customerId)).toEqual(['real']);
  });

  test('respects the limit option', async () => {
    const conn = makeConn({
      clickRows: ['a', 'b', 'c'].map((id, i) =>
        clickRow({ customer_id: id, redirected_at: `2026-08-07T17:${10 + i}:00.000Z` })),
    });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT }, { conn, limit: 2 });
    expect(result).toHaveLength(2);
  });

  test('queries a 72h-before / 6h-after window over EITHER observed click', async () => {
    const conn = makeConn({ clickRows: [] });
    await findLikelyReviewers({ review_created_at: REVIEW_AT }, { conn });
    const windowClause = conn.captured.whereRaw.find((args) =>
      String(args[0]).includes('rr.redirected_at') && String(args[0]).includes('rr.last_redirected_at'));
    const reviewMs = Date.parse(REVIEW_AT);
    const [start, end, start2, end2] = windowClause[1];
    expect(start.getTime()).toBe(reviewMs - 72 * 3600 * 1000);
    expect(end.getTime()).toBe(reviewMs + 6 * 3600 * 1000);
    expect(start2.getTime()).toBe(start.getTime());
    expect(end2.getTime()).toBe(end.getTime());
  });

  test('a qualifying pre-review first click survives a post-review revisit', async () => {
    const conn = makeConn({
      clickRows: [clickRow({
        redirected_at: '2026-08-07T17:50:00.000Z', // 10m before the review
        last_redirected_at: '2026-08-07T19:00:00.000Z', // revisited 1h after
      })],
    });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT, location_id: 'bradenton' }, { conn });
    expect(result[0].clickedAt).toBe('2026-08-07T17:50:00.000Z');
    expect(result[0].clickedBeforeReview).toBe(true);
  });

  test('a repeat click correlates by last_redirected_at, not the first-click claim', async () => {
    const conn = makeConn({
      clickRows: [clickRow({
        redirected_at: '2026-08-04T17:30:00.000Z', // first click, 3d earlier
        last_redirected_at: '2026-08-07T17:50:00.000Z', // tapped again 10m before posting
        last_google_location: 'bradenton',
      })],
    });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT, location_id: 'bradenton' }, { conn });
    expect(result[0].clickedAt).toBe('2026-08-07T17:50:00.000Z');
    expect(result[0].clickOffsetLabel).toBe('10m before');
  });

  test('fails open (empty list + warn log) when the click query errors', async () => {
    const conn = makeConn({ failClicks: true });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT }, { conn });
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('returns [] when the linked-review exclusion lookup errors — never suggests without the exclusion', async () => {
    const conn = makeConn({ clickRows: [clickRow()], failLinked: true });
    const result = await findLikelyReviewers({ review_created_at: REVIEW_AT }, { conn });
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('findConfidentClickMatch', () => {
  const REVIEW = { review_created_at: REVIEW_AT, location_id: 'bradenton' };

  test('matches a sole location-stamped clicker shortly before the review', async () => {
    const conn = makeConn({ clickRows: [clickRow()] }); // 30m before, bradenton
    const match = await findConfidentClickMatch(REVIEW, { conn });
    expect(match).toEqual({
      customerId: 'cust-1',
      clickedAt: '2026-08-07T17:30:00.000Z',
      clickOffsetMs: 30 * 60000,
      clickOffsetLabel: '30m before',
    });
  });

  test('refuses when a second customer clicked anywhere in the window — even location-unstamped', async () => {
    const conn = makeConn({
      clickRows: [
        clickRow(),
        clickRow({ customer_id: 'cust-2', google_location: null, redirected_at: '2026-08-05T12:00:00.000Z' }),
      ],
    });
    expect(await findConfidentClickMatch(REVIEW, { conn })).toBeNull();
  });

  test('refuses when the only OTHER clicker in the window is an already-linked customer (raw-count ambiguity)', async () => {
    // The suggestion list hides the linked clicker, leaving one visible
    // candidate — but a linked customer can still review another location's
    // profile, so the raw window holds two competing clicks. Never confident.
    const conn = makeConn({
      clickRows: [
        clickRow(),
        clickRow({ customer_id: 'cust-linked', redirected_at: '2026-08-07T17:00:00.000Z' }),
      ],
      linkedRows: [{ customer_id: 'cust-linked' }],
    });
    expect((await findLikelyReviewers(REVIEW, { conn })).map(r => r.customerId)).toEqual(['cust-1']);
    expect(await findConfidentClickMatch(REVIEW, { conn })).toBeNull();
  });

  test('refuses a sole clicker already marked as having reviewed (manual flag not ours to reverse)', async () => {
    const conn = makeConn({ clickRows: [clickRow({ has_left_google_review: true })] });
    expect(await findConfidentClickMatch(REVIEW, { conn })).toBeNull();
  });

  test('accepts a repeat clicker whose LATEST tap is inside the 12h bound', async () => {
    const conn = makeConn({
      clickRows: [clickRow({
        redirected_at: '2026-08-04T17:30:00.000Z', // first click, days earlier
        last_redirected_at: '2026-08-07T17:55:00.000Z', // re-tap 5m before posting
        last_google_location: 'bradenton', // stamped WITH the re-tap
      })],
    });
    const match = await findConfidentClickMatch(REVIEW, { conn });
    expect(match?.customerId).toBe('cust-1');
    expect(match?.clickOffsetLabel).toBe('5m before');
  });

  test('refuses a location-unstamped sole clicker (null is not a match)', async () => {
    const conn = makeConn({ clickRows: [clickRow({ google_location: null })] });
    expect(await findConfidentClickMatch(REVIEW, { conn })).toBeNull();
  });

  test('refuses when the review carries no location to corroborate against', async () => {
    // locationMatch is null without a review location_id — never confident.
    const conn = makeConn({ clickRows: [clickRow()] });
    expect(await findConfidentClickMatch({ review_created_at: REVIEW_AT }, { conn })).toBeNull();
  });

  test('refuses a click AFTER the review posted', async () => {
    const conn = makeConn({ clickRows: [clickRow({ redirected_at: '2026-08-07T19:00:00.000Z' })] });
    expect(await findConfidentClickMatch(REVIEW, { conn })).toBeNull();
  });

  test('refuses a click more than 12h before the review', async () => {
    const conn = makeConn({ clickRows: [clickRow({ redirected_at: '2026-08-07T05:00:00.000Z' })] }); // 13h before
    expect(await findConfidentClickMatch(REVIEW, { conn })).toBeNull();
  });

  test('accepts a click just inside the 12h bound', async () => {
    const conn = makeConn({ clickRows: [clickRow({ redirected_at: '2026-08-07T06:30:00.000Z' })] }); // 11h30m before
    const match = await findConfidentClickMatch(REVIEW, { conn });
    expect(match?.customerId).toBe('cust-1');
  });

  test('fails toward the manual queue (null) on query error', async () => {
    const conn = makeConn({ failClicks: true });
    expect(await findConfidentClickMatch(REVIEW, { conn })).toBeNull();
  });

  test('fails closed when the raw scan fills SCAN_LIMIT (older clicks may be truncated out)', async () => {
    // 200 rows, all one customer — sole by count, but the scan may have
    // dropped a second customer's older click. Never confident.
    const conn = makeConn({
      clickRows: Array.from({ length: 200 }, (_, i) =>
        clickRow({ redirected_at: new Date(Date.parse(REVIEW_AT) - (i + 1) * 60000).toISOString() })),
    });
    expect(await findConfidentClickMatch(REVIEW, { conn })).toBeNull();
  });
});
