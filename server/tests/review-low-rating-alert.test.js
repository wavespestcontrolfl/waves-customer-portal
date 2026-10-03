// Bad-review bell (Clef second wave idea 7, owner CW-D4): a NEW 1-3 star
// Google review written in the last 7 days rings one needs-you bell.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRaise = jest.fn();
jest.mock('../services/admin-alert-compose', () => ({ ...jest.requireActual('../services/admin-alert-compose'), raiseAdminAlert: (...a) => mockRaise(...a) }));

const { composeAdminAlert } = jest.requireActual('../services/admin-alert-compose');
const { lowRatingAlertSpec, notifyLowRatingReview } = require('../services/review-low-rating-alert');

const NOW = new Date('2026-10-03T12:00:00Z');
const base = { reviewId: 'rev-1', starRating: 2, reviewerName: 'Pat Example', customerId: null, reviewCreatedAt: '2026-10-02T09:00:00Z', now: NOW };
const original = process.env.GATE_REVIEW_ALERT;

beforeEach(() => { jest.clearAllMocks(); process.env.GATE_REVIEW_ALERT = 'true'; mockRaise.mockResolvedValue({ id: 'n1' }); });
afterAll(() => { if (original === undefined) delete process.env.GATE_REVIEW_ALERT; else process.env.GATE_REVIEW_ALERT = original; });

describe('lowRatingAlertSpec', () => {
  test('1, 2 and 3 stars ring; 4, 5, 0 and junk do not', () => {
    for (const s of [1, 2, 3]) expect(lowRatingAlertSpec({ ...base, starRating: s })).not.toBeNull();
    for (const s of [4, 5, 0, null, 'x', 2.5]) expect(lowRatingAlertSpec({ ...base, starRating: s })).toBeNull();
  });

  test('only a review written in the last 7 days: an old review on a first sync never rings', () => {
    expect(lowRatingAlertSpec({ ...base, reviewCreatedAt: '2026-09-27T12:00:00Z' })).not.toBeNull();
    expect(lowRatingAlertSpec({ ...base, reviewCreatedAt: '2026-09-20T12:00:00Z' })).toBeNull();
    expect(lowRatingAlertSpec({ ...base, reviewCreatedAt: null })).toBeNull();
    expect(lowRatingAlertSpec({ ...base, reviewCreatedAt: 'not a date' })).toBeNull();
  });

  test('passes the admin notification rules as written: headline, why, link, done-when; never quotes the review', () => {
    const spec = lowRatingAlertSpec(base);
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Customers — read a 2-star Google review');
    expect(composed.why).toBe('Pat Example left 2 stars on Google; reply to it or dismiss it on the Reviews page.');
    expect(composed.link).toBe('/admin/reviews');
    expect(composed.metadata).toMatchObject({ severity: 'needs-you', doneWhen: 'review_replied_or_dismissed', who: 'person' });
    expect(composeAdminAlert(lowRatingAlertSpec({ ...base, starRating: 1, reviewerName: '' })).why).toBe('A reviewer left 1 star on Google; reply to it or dismiss it on the Reviews page.');
  });

  test('a linked review is about its customer; an unlinked one is a check on the review', () => {
    expect(lowRatingAlertSpec({ ...base, customerId: 'cust-9' }).subject).toEqual({ type: 'customer', id: 'cust-9' });
    expect(lowRatingAlertSpec(base).subject).toEqual({ type: 'check', id: 'rev-1' });
  });
});

describe('notifyLowRatingReview', () => {
  test('gate off: no bell', async () => {
    delete process.env.GATE_REVIEW_ALERT;
    expect(await notifyLowRatingReview(base)).toEqual({ rang: false, reason: 'gate_off' });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('rings once per review: needs-you, deduped by the review id, in its own owner-silenceable category', async () => {
    expect(await notifyLowRatingReview(base)).toEqual({ rang: true });
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('review_low_rating');
    expect(spec.severity).toBe('needs-you');
    expect(opts).toMatchObject({ dedupeKey: 'review-low-rating:rev-1', metadata: { reviewId: 'rev-1', starRating: 2 } });
    expect(opts).not.toHaveProperty('bell'); // never forced: the owner can silence the category
    const policy = jest.requireActual('../services/notification-bell-policy');
    expect(policy.DEFAULT_ON_CATEGORIES.has('review_low_rating')).toBe(true);
    expect(policy.OVERRIDABLE_CATEGORY_SET.has('review_low_rating')).toBe(true);
  });

  test('a 5-star review and an old one: no bell', async () => {
    await notifyLowRatingReview({ ...base, starRating: 5 });
    await notifyLowRatingReview({ ...base, reviewCreatedAt: '2026-01-01T00:00:00Z' });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a bell failure is logged and returned, never thrown into the review sync', async () => {
    mockRaise.mockRejectedValue(new Error('db down'));
    await expect(notifyLowRatingReview(base)).resolves.toEqual({ rang: false, reason: 'error' });
  });
});
