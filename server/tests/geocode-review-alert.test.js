jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  const qb = () => { throw new Error('db must not be touched when loaders are injected'); };
  qb.raw = () => { throw new Error('db.raw must not be touched when loaders are injected'); };
  return qb;
});
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => {}) }));
jest.mock('../services/ops-digest', () => ({
  deliverOpsDigest: jest.fn(async () => ({ channel: 'in_app' })),
  inAppEnabled: jest.fn(() => true),
}));

const { deliverOpsDigest, inAppEnabled } = require('../services/ops-digest');
const { retireIfClean } = require('../services/ops-digest-fall-off');
const {
  runGeocodeReviewAlert,
  _private: { composeGeocodeReviewAlert },
} = require('../services/geocode-review-alert');

const row = (customerId, status, name = 'Test Customer') => ({ customerId, status, name });

beforeEach(() => {
  jest.clearAllMocks();
  inAppEnabled.mockReturnValue(true);
  process.env.GATE_GEOCODE_REVIEW = 'true';
  delete process.env.GEOCODE_REVIEW_ALERT_DISABLED;
  delete process.env.GEOCODE_REVIEW_ALERT_EMAIL;
});

afterAll(() => { delete process.env.GATE_GEOCODE_REVIEW; });

describe('composeGeocodeReviewAlert', () => {
  test('an empty queue composes nothing', () => {
    expect(composeGeocodeReviewAlert([])).toBeNull();
  });

  test('two short lines: a count headline and a per-problem summary', () => {
    const out = composeGeocodeReviewAlert([
      row('c1', 'needs_pin'), row('c2', 'needs_pin'), row('c3', 'needs_details'),
    ]);
    expect(out.headline).toBe("Address review: 3 customers can't book online");
    expect(out.summary).toBe('2 need a pin · 1 address incomplete');
    expect(out.count).toBe(3);
  });

  test('a single customer reads in the singular', () => {
    expect(composeGeocodeReviewAlert([row('c1', 'outside_area')]).headline)
      .toBe("Address review: 1 customer can't book online");
  });

  // A customer moving to a different problem is new work for staff, so the
  // item key carries the status and the ring-on-change test sees a new key.
  test('item keys carry the blocking status, so a status change is a new item', () => {
    const before = composeGeocodeReviewAlert([row('c1', 'needs_pin')]);
    const after = composeGeocodeReviewAlert([row('c1', 'outside_area')]);
    expect(before.itemKeys).toEqual(['c1:needs_pin']);
    expect(after.itemKeys).toEqual(['c1:outside_area']);
  });
});

describe('runGeocodeReviewAlert', () => {
  test('gate off: nothing is read or posted', async () => {
    delete process.env.GATE_GEOCODE_REVIEW;
    const loadBlockedReviews = jest.fn(async () => [row('c1', 'needs_pin')]);
    const result = await runGeocodeReviewAlert({ loadBlockedReviews });
    expect(result).toEqual({ skipped: 'gated_off' });
    expect(loadBlockedReviews).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('an empty queue retires the standing bell', async () => {
    const result = await runGeocodeReviewAlert({ loadBlockedReviews: async () => [] });
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(retireIfClean).toHaveBeenCalledWith('geocode-review', { lockKey: 'ops-digest:geocode-review' });
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('a blocked customer posts one rolling bell linking to the queue, keyed per customer', async () => {
    const result = await runGeocodeReviewAlert({
      loadBlockedReviews: async () => [row('c1', 'needs_pin'), row('c2', 'outside_area')],
    });
    expect(result.sent).toBe(true);
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const call = deliverOpsDigest.mock.calls[0][0];
    expect(call).toMatchObject({
      key: 'geocode-review',
      link: '/admin/customers',
      dedupeKey: 'ops-digest:geocode-review',
      refreshOnDedupe: true,
      fallOff: true,
      count: 2,
      itemKeys: ['c1:needs_pin', 'c2:outside_area'],
      headline: "Address review: 2 customers can't book online",
    });
  });

  test('the kill switch stops the post but still reports what it would have sent', async () => {
    process.env.GEOCODE_REVIEW_ALERT_DISABLED = '1';
    const result = await runGeocodeReviewAlert({ loadBlockedReviews: async () => [row('c1', 'needs_pin')] });
    expect(result.skipped).toBe('disabled');
    expect(result.count).toBe(1);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('a failed queue read is reported, never posted as an empty queue', async () => {
    const result = await runGeocodeReviewAlert({ loadBlockedReviews: async () => { throw new Error('boom'); } });
    expect(result).toEqual({ skipped: 'query_failed' });
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('with the in-app bell dark, the email fallback is throttled to one per window', async () => {
    inAppEnabled.mockReturnValue(false);
    const result = await runGeocodeReviewAlert({
      loadBlockedReviews: async () => [row('c1', 'needs_pin')],
      emailFallbackRecently: async () => true,
    });
    expect(result.skipped).toBe('recent_send');
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('a non-internal recipient is refused (owner inboxes only)', async () => {
    process.env.GEOCODE_REVIEW_ALERT_EMAIL = 'someone@example.com';
    const result = await runGeocodeReviewAlert({ loadBlockedReviews: async () => [row('c1', 'needs_pin')] });
    expect(result.skipped).toBe('recipient');
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });
});
