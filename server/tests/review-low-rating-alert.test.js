// Bad-review bell (Clef second wave idea 7, owner CW-D4): one needs-you item
// open for every unanswered 1-3 star Google review written since the lane's
// first live run, raised and closed by a pass after every review sync.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockEpisodes = { raiseAdminAlertWithReopen: jest.fn(), openAdminAlertKeys: jest.fn(), closeAdminAlertKeys: jest.fn(), openAdminAlertMetadata: jest.fn() };
jest.mock('../services/admin-alert-episodes', () => mockEpisodes);
const mockLock = { held: false, fail: false };
jest.mock('../utils/cron-lock', () => ({ runExclusive: async (name, fn) => { if (mockLock.fail) throw new Error('advisory lock query failed'); return mockLock.held ? { skipped: true, reason: 'lease_held' } : fn(); } }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: (id) => id === 'test-cust' }));

const { composeAdminAlert } = require('../services/admin-alert-compose');
const { lowRatingAlertSpec, composeForReview, syncLowRatingReviewAlerts } = require('../services/review-low-rating-alert');

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const base = { reviewId: R1, starRating: 2, reviewerName: 'Pat Example', customerId: null };
const original = process.env.GATE_REVIEW_ALERT;
const BOUNDARY = '2026-10-01T00:00:00.000Z';

// A minimal knex stand-in: system_settings holds the boundary, google_reviews
// returns `reviews` (or, inside the raise's transaction, `recheck` when given:
// what a re-read sees by then); every where() on the reviews query is recorded.
function fakeConn({ reviews = [], boundary = BOUNDARY, recheck = null } = {}) {
  const seen = { reviewWheres: [], settingsInserts: [], locked: [] };
  const settings = boundary ? { value: boundary } : null;
  const make = (inTrx) => {
    const conn = (table) => {
      let idFilter = null;
      let shared = false;
      const b = {
        where(...a) {
          if (typeof a[0] === 'function') a[0](b);
          else if (a[0] === 'id') idFilter = a[1];
          else if (table === 'google_reviews' && !inTrx) seen.reviewWheres.push(a);
          return b;
        },
        whereBetween(...a) { if (!inTrx) seen.reviewWheres.push(['between', ...a]); return b; },
        whereNull(...a) { if (!inTrx) seen.reviewWheres.push(['null', ...a]); return b; },
        orWhereNull() { return b; }, orWhereNot() { return b; },
        whereRaw(...a) { if (!inTrx) seen.reviewWheres.push(['raw', ...a]); return b; },
        forShare() { shared = true; return b; },
        first: async () => (table === 'system_settings' ? settings : null),
        select() { return b; },
        insert(row) { seen.settingsInserts.push(row); return { onConflict: () => ({ ignore: async () => {} }) }; },
        then(res, rej) {
          if (table !== 'google_reviews') return Promise.resolve([]).then(res, rej);
          const pool = inTrx && recheck ? recheck : reviews;
          if (shared) seen.locked.push(idFilter);
          return Promise.resolve(idFilter ? pool.filter((r) => r.id === idFilter) : pool).then(res, rej);
        },
      };
      return b;
    };
    conn.raw = async () => ({ rows: [{ now: new Date(BOUNDARY) }] });
    conn.transaction = async (fn) => fn(make(true));
    return conn;
  };
  return { conn: make(false), seen };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_REVIEW_ALERT = 'true';
  mockEpisodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n1', rang: true });
  mockEpisodes.openAdminAlertKeys.mockResolvedValue([]);
  mockEpisodes.closeAdminAlertKeys.mockResolvedValue(0);
  mockEpisodes.openAdminAlertMetadata.mockResolvedValue([]);
});
afterAll(() => { if (original === undefined) delete process.env.GATE_REVIEW_ALERT; else process.env.GATE_REVIEW_ALERT = original; });

describe('lowRatingAlertSpec', () => {
  test('1, 2 and 3 stars; 4, 5, 0 and junk are not', () => {
    for (const s of [1, 2, 3]) expect(lowRatingAlertSpec({ ...base, starRating: s })).not.toBeNull();
    for (const s of [4, 5, 0, null, 'x', 2.5]) expect(lowRatingAlertSpec({ ...base, starRating: s })).toBeNull();
  });

  test('passes the admin notification rules as written and deep-links to the review under every response state', () => {
    const composed = composeAdminAlert(lowRatingAlertSpec(base));
    expect(composed.headline).toBe('Customers — read a 2-star Google review');
    expect(composed.why).toBe('Pat Example left 2 stars on Google; reply to it or dismiss it on the Reviews page.');
    expect(composed.link).toBe(`/admin/reviews?responded=all&review=${R1}`);
    expect(composed.metadata).toMatchObject({ severity: 'needs-you', doneWhen: 'review_replied_or_dismissed', who: 'person' });
    expect(composeAdminAlert(lowRatingAlertSpec({ ...base, starRating: 1, reviewerName: '' })).why).toBe('A reviewer left 1 star on Google; reply to it or dismiss it on the Reviews page.');
  });

  test('a display name that breaks the alert rules falls back to "A reviewer"; a plain name is kept', () => {
    const why = (name) => composeForReview({ id: R1, star_rating: 2, reviewer_name: name, customer_id: null }).why;
    expect(why('Pat Example')).toMatch(/^Pat Example left 2 stars/);
    for (const name of ['Pat 😀 Example', 'Great job!', 'pat_example_99', 'J. R. Smith', 'A'.repeat(80), 'Pat [Home]']) {
      expect({ name, why: why(name) }).toEqual({ name, why: 'A reviewer left 2 stars on Google; reply to it or dismiss it on the Reviews page.' });
    }
  });

  test('a linked review is about its customer; an unlinked one is a check on the review', () => {
    expect(lowRatingAlertSpec({ ...base, customerId: 'cust-9' }).subject).toEqual({ type: 'customer', id: 'cust-9' });
    expect(lowRatingAlertSpec(base).subject).toEqual({ type: 'check', id: R1 });
  });
});

describe('syncLowRatingReviewAlerts', () => {
  test('gate off: nothing read, raised or closed', async () => {
    delete process.env.GATE_REVIEW_ALERT;
    const { conn, seen } = fakeConn();
    expect(await syncLowRatingReviewAlerts({ conn })).toMatchObject({ skipped: 'gate_off' });
    expect(seen.reviewWheres).toEqual([]);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('reads only reviews that need an answer, written since the first live run', async () => {
    const { conn, seen } = fakeConn();
    await syncLowRatingReviewAlerts({ conn });
    expect(seen.reviewWheres).toContainEqual(['between', 'star_rating', [1, 3]]);
    expect(seen.reviewWheres).toContainEqual(['review_created_at', '>=', new Date(BOUNDARY)]);
    expect(seen.reviewWheres).toContainEqual(['null', 'missing_since']);
    expect(seen.reviewWheres.find((w) => w[0] === 'raw')[1]).toMatch(/\[DRAFT\]/);
  });

  test('the first live run stores its instant once; a later run reuses it', async () => {
    const first = fakeConn({ boundary: null });
    await syncLowRatingReviewAlerts({ conn: first.conn });
    expect(first.seen.settingsInserts).toHaveLength(1);
    expect(first.seen.settingsInserts[0]).toMatchObject({ key: 'review_low_rating_alert_activated_at' });
    const later = fakeConn();
    await syncLowRatingReviewAlerts({ conn: later.conn });
    expect(later.seen.settingsInserts).toHaveLength(0);
  });

  test('raises (or reopens) one item per review, keyed per review, with the customer at the top level for test-account suppression', async () => {
    const { conn } = fakeConn({ reviews: [{ id: R1, star_rating: 1, reviewer_name: 'Pat Example', customer_id: 'cust-9' }] });
    const out = await syncLowRatingReviewAlerts({ conn });
    const [category, title, body, opts] = mockEpisodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('review_low_rating');
    expect(title).toBe('Customers — read a 1-star Google review');
    expect(body).toMatch(/^Pat Example left 1 star on Google/);
    expect(opts).toMatchObject({ dedupeKey: `review-low-rating:${R1}`, link: `/admin/reviews?responded=all&review=${R1}`, metadata: { reviewId: R1, customerId: 'cust-9', starRating: 1, severity: 'needs-you' } });
    expect(opts).not.toHaveProperty('bell'); // never forced: the owner can silence the category
    expect(out).toMatchObject({ raised: 1, failed: 0 });
  });

  test('closes every open item whose review no longer needs an answer, and only those', async () => {
    mockEpisodes.openAdminAlertKeys.mockResolvedValue([`review-low-rating:${R1}`, `review-low-rating:${R2}`]);
    mockEpisodes.closeAdminAlertKeys.mockResolvedValue(1);
    const { conn } = fakeConn({ reviews: [{ id: R1, star_rating: 2, reviewer_name: 'Pat Example', customer_id: null }] });
    const out = await syncLowRatingReviewAlerts({ conn });
    expect(mockEpisodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn, [`review-low-rating:${R2}`], 'review answered', expect.objectContaining({ resolution: expect.any(String) }));
    expect(out.closed).toBe(1);
  });

  test('a review linked to an internal test account is left out, so an item raised before the link is closed', async () => {
    mockEpisodes.openAdminAlertKeys.mockResolvedValue([`review-low-rating:${R1}`]);
    mockEpisodes.closeAdminAlertKeys.mockResolvedValue(1);
    const { conn } = fakeConn({ reviews: [{ id: R1, star_rating: 2, reviewer_name: 'Pat Example', customer_id: 'test-cust' }] });
    const out = await syncLowRatingReviewAlerts({ conn });
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn, [`review-low-rating:${R1}`], 'review answered', expect.any(Object));
    expect(out.closed).toBe(1);
  });

  test('re-reads and share-locks each review in the raise transaction: one answered meanwhile never rings, and its item closes', async () => {
    mockEpisodes.openAdminAlertKeys.mockResolvedValue([`review-low-rating:${R1}`]);
    const listed = [{ id: R1, google_review_id: 'g-1', star_rating: 2, reviewer_name: 'Pat', customer_id: null }];
    const { conn, seen } = fakeConn({ reviews: listed, recheck: [] });
    await syncLowRatingReviewAlerts({ conn });
    expect(seen.locked).toEqual([R1]);
    expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(mockEpisodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn, [`review-low-rating:${R1}`], 'review answered', expect.any(Object));
  });

  test('an open item is matched on either identity: a re-inserted row keeps its key by Google id, an adopted row by row id', async () => {
    const NEW_ID = '33333333-3333-4333-8333-333333333333';
    mockEpisodes.openAdminAlertMetadata.mockResolvedValue([{ dedupeKey: `review-low-rating:${R1}`, reviewId: R1, googleReviewId: 'places_p_1' }]);
    mockEpisodes.openAdminAlertKeys.mockResolvedValue([`review-low-rating:${R1}`]);
    // fresh Places re-pull: new row id, same google_review_id
    const { conn } = fakeConn({ reviews: [{ id: NEW_ID, google_review_id: 'places_p_1', star_rating: 2, reviewer_name: 'Pat', customer_id: null }] });
    await syncLowRatingReviewAlerts({ conn });
    expect(mockEpisodes.raiseAdminAlertWithReopen.mock.calls[0][3].dedupeKey).toBe(`review-low-rating:${R1}`);
    expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    // GBP adoption: same row id, new google_review_id
    mockEpisodes.raiseAdminAlertWithReopen.mockClear();
    const adopted = fakeConn({ reviews: [{ id: R1, google_review_id: 'accounts/1/locations/2/reviews/r', star_rating: 2, reviewer_name: 'Pat', customer_id: null }] });
    await syncLowRatingReviewAlerts({ conn: adopted.conn });
    expect(mockEpisodes.raiseAdminAlertWithReopen.mock.calls[0][3]).toMatchObject({ dedupeKey: `review-low-rating:${R1}`, metadata: { googleReviewId: 'accounts/1/locations/2/reviews/r' } });
  });

  test('the linkage is the version: linking a customer quietly refreshes the standing item (never re-rings)', async () => {
    const { conn } = fakeConn({ reviews: [{ id: R1, google_review_id: 'g-1', star_rating: 2, reviewer_name: 'Pat', customer_id: 'cust-7' }] });
    await syncLowRatingReviewAlerts({ conn });
    const opts = mockEpisodes.raiseAdminAlertWithReopen.mock.calls[0][3];
    expect(opts).toMatchObject({ dedupeVersion: 'customer:cust-7', refreshOnDedupe: true, metadata: { customerId: 'cust-7', subject: { type: 'customer', id: 'cust-7' } } });
    // a FUNCTION returning false: notification-service rings on any non-function value
    expect(typeof opts.ringOnRefresh).toBe('function');
    expect(opts.ringOnRefresh()).toBe(false);
    // ...and the real notification service reads it as "do not ring" (a bare false would ring)
    const { resolveRingOnRefresh } = jest.requireActual('../services/notification-service')._private;
    await expect(resolveRingOnRefresh(opts.ringOnRefresh, {}, {})).resolves.toBe(false);
    await expect(resolveRingOnRefresh(false, {}, {})).resolves.toBe(true);
  });

  test('a failing lock never fails the review sync: the pass returns an error result', async () => {
    mockLock.fail = true;
    try {
      const { conn } = fakeConn({ reviews: [{ id: R1, google_review_id: 'g-1', star_rating: 2, reviewer_name: 'Pat', customer_id: null }] });
      await expect(syncLowRatingReviewAlerts({ conn })).resolves.toMatchObject({ error: true });
      expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    } finally { mockLock.fail = false; }
  });

  test('one pass at a time: a pass that finds the lock held raises and closes nothing', async () => {
    mockLock.held = true;
    try {
      mockEpisodes.openAdminAlertKeys.mockResolvedValue([`review-low-rating:${R1}`]);
      const { conn } = fakeConn({ reviews: [{ id: R2, google_review_id: 'g-2', star_rating: 2, reviewer_name: 'Pat', customer_id: null }] });
      expect(await syncLowRatingReviewAlerts({ conn })).toMatchObject({ skipped: 'busy' });
      expect(mockEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
      expect(mockEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    } finally { mockLock.held = false; }
  });

  test('a failed write is counted and retried next pass (the review is still there), never thrown', async () => {
    mockEpisodes.raiseAdminAlertWithReopen.mockRejectedValue(new Error('db down'));
    const { conn } = fakeConn({ reviews: [{ id: R1, star_rating: 2, reviewer_name: 'Pat', customer_id: null }] });
    await expect(syncLowRatingReviewAlerts({ conn })).resolves.toMatchObject({ failed: 1 });
    mockEpisodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n2', rang: true });
    await expect(syncLowRatingReviewAlerts({ conn })).resolves.toMatchObject({ raised: 1, failed: 0 });
  });

  test('the category rings by default and the owner can silence it', () => {
    const policy = require('../services/notification-bell-policy');
    expect(policy.DEFAULT_ON_CATEGORIES.has('review_low_rating')).toBe(true);
    expect(policy.OVERRIDABLE_CATEGORY_SET.has('review_low_rating')).toBe(true);
  });
});
