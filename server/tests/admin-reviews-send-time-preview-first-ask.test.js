/**
 * GATE_REVIEW_FIRST_ASK_LOCK (owner 2026-10-26): the completion panel's send-time preview also says whether the
 * visit's customer was never asked for a review (`firstReviewAsk`). Gate off, or no visit named: the key is absent and
 * the answer is as before. A re-service (callback) visit and an unknown visit are never a first ask.
 */
const mockVisit = { current: null };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {
      columnInfo: jest.fn().mockResolvedValue({ report_template_version: {} }),
      where() { return this; },
      first: () => Promise.resolve(table === 'scheduled_services' ? mockVisit.current : undefined),
    };
    return q;
  });
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/review-request', () => ({
  LEGACY_REVIEW_DELAY_MINUTES: 120,
  REVIEW_AFTER_REPORT_DELAY_MINUTES: 10,
  customerNeverAskedForReview: jest.fn(),
  __private: { reviewCadenceTickMinutes: () => [14, 44], LEGACY_REVIEW_TICK_MINUTES: [0, 15, 30, 45], calculateReviewSendPlan: jest.fn() },
}));
jest.mock('../services/google-business', () => ({}));
jest.mock('../services/review-incentives', () => ({}));
jest.mock('../services/review-reply/publisher', () => ({}));
jest.mock('../services/review-reply/drafter', () => ({}));
jest.mock('../services/review-reply/grounding', () => ({}));
jest.mock('../services/review-reply/runner', () => ({}));
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn() }));
jest.mock('../services/twilio', () => ({}));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), wasLockSkipped: (r) => r?.skipped === true, settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ReviewService = require('../services/review-request');

const gateWas = process.env.GATE_REVIEW_FIRST_ASK_LOCK;
afterEach(() => { if (gateWas === undefined) delete process.env.GATE_REVIEW_FIRST_ASK_LOCK; else process.env.GATE_REVIEW_FIRST_ASK_LOCK = gateWas; });
beforeEach(() => {
  ReviewService.customerNeverAskedForReview.mockReset().mockResolvedValue(true);
  mockVisit.current = { customer_id: 'cust-1', is_callback: false };
});

async function preview(query) {
  const router = require('../routes/admin-reviews');
  const handler = router.stack.find((layer) => layer.route?.path === '/send-time-preview').route.stack.at(-1).handle;
  const res = { json: jest.fn() };
  const next = jest.fn();
  await handler({ query }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0];
}

describe('GET /admin/reviews/send-time-preview with GATE_REVIEW_FIRST_ASK_LOCK', () => {
  test('gate off: no firstReviewAsk key, and the helper is never asked', async () => {
    delete process.env.GATE_REVIEW_FIRST_ASK_LOCK;
    const out = await preview({ serviceType: 'Pest', serviceId: 'svc-1' });
    expect(out).not.toHaveProperty('firstReviewAsk');
    expect(ReviewService.customerNeverAskedForReview).not.toHaveBeenCalled();
  });

  test('gate on, no visit named: no firstReviewAsk key', async () => {
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    expect(await preview({ serviceType: 'Pest' })).not.toHaveProperty('firstReviewAsk');
  });

  test('gate on, a visit whose customer was never asked: firstReviewAsk true', async () => {
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    const out = await preview({ serviceType: 'Pest', serviceId: 'svc-1' });
    expect(out.firstReviewAsk).toBe(true);
    expect(ReviewService.customerNeverAskedForReview).toHaveBeenCalledWith('cust-1');
    expect(out.bucket).toBe('legacy:+120m');
  });

  test('gate on, a customer asked before: firstReviewAsk false', async () => {
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    ReviewService.customerNeverAskedForReview.mockResolvedValue(false);
    expect((await preview({ serviceType: 'Pest', serviceId: 'svc-1' })).firstReviewAsk).toBe(false);
  });

  test('gate on, a re-service visit or an unknown visit: firstReviewAsk false', async () => {
    process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true';
    mockVisit.current = { customer_id: 'cust-1', is_callback: true };
    expect((await preview({ serviceType: 'Pest', serviceId: 'svc-1' })).firstReviewAsk).toBe(false);
    mockVisit.current = undefined;
    ReviewService.customerNeverAskedForReview.mockResolvedValue(false);
    expect((await preview({ serviceType: 'Pest', serviceId: 'svc-1' })).firstReviewAsk).toBe(false);
  });
});
