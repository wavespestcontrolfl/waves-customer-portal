// Bad-review bell (Clef second wave idea 7, owner CW-D4): one needs-you item
// open for every unanswered 1-3 star Google review written since the lane's
// first live run, raised and closed by a pass after every review sync.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockEpisodes = { raiseAdminAlertWithReopen: jest.fn(), openAdminAlertKeys: jest.fn(), closeAdminAlertKeys: jest.fn() };
jest.mock('../services/admin-alert-episodes', () => mockEpisodes);
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: (id) => id === 'test-cust' }));

const { composeAdminAlert } = require('../services/admin-alert-compose');
const { lowRatingAlertSpec, composeForReview, syncLowRatingReviewAlerts } = require('../services/review-low-rating-alert');

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const base = { reviewId: R1, starRating: 2, reviewerName: 'Pat Example', customerId: null };
const original = process.env.GATE_REVIEW_ALERT;
const BOUNDARY = '2026-10-01T00:00:00.000Z';

// A minimal knex stand-in: system_settings holds the boundary, google_reviews
// returns `reviews`; every where() on the reviews query is recorded.
function fakeConn({ reviews = [], boundary = BOUNDARY } = {}) {
  const seen = { reviewWheres: [], settingsInserts: [] };
  const settings = boundary ? { value: boundary } : null;
  const conn = (table) => {
    const b = {
      where(...a) { if (typeof a[0] === 'function') a[0](b); else if (table === 'google_reviews') seen.reviewWheres.push(a); return b; },
      whereBetween(...a) { seen.reviewWheres.push(['between', ...a]); return b; },
      whereNull(...a) { seen.reviewWheres.push(['null', ...a]); return b; },
      orWhereNull() { return b; }, orWhereNot() { return b; }, whereRaw(...a) { seen.reviewWheres.push(['raw', ...a]); return b; },
      first: async () => (table === 'system_settings' ? settings : null),
      select: async () => (table === 'google_reviews' ? reviews : []),
      insert(row) { seen.settingsInserts.push(row); return { onConflict: () => ({ ignore: async () => {} }) }; },
    };
    return b;
  };
  conn.raw = async () => ({ rows: [{ now: new Date(BOUNDARY) }] });
  return { conn, seen };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_REVIEW_ALERT = 'true';
  mockEpisodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n1', rang: true });
  mockEpisodes.openAdminAlertKeys.mockResolvedValue([]);
  mockEpisodes.closeAdminAlertKeys.mockResolvedValue(0);
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
