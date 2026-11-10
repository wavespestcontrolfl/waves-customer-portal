/**
 * First review ask (owner 2026-10-26): the completion panel's send-time preview also says whether the
 * visit's customer was never asked for a review (`firstReviewAsk`). No visit named: the key is absent and
 * the answer is as before. A re-service and an unknown visit are never a first ask (firstAskLockVisit answers null;
 * its rule is in review-first-ask-lock.test.js).
 */
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const q = {
      columnInfo: jest.fn().mockResolvedValue({ report_template_version: {} }),
      where() { return this; },
      first: () => Promise.resolve(undefined),
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
  firstAskLockVisit: jest.fn(),
  alreadyReviewedForVisit: jest.fn(),
  firstAskOptOutReasons: jest.fn(() => ['complaint_on_site', 'already_left_review']),
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

beforeEach(() => {
  ReviewService.customerNeverAskedForReview.mockReset().mockResolvedValue(true);
  ReviewService.firstAskLockVisit.mockReset().mockResolvedValue({ customer_id: 'cust-1' });
  ReviewService.alreadyReviewedForVisit.mockReset().mockResolvedValue(null);
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

describe('GET /admin/reviews/send-time-preview, first review ask', () => {
  test('no visit named: no firstReviewAsk key', async () => {
    expect(await preview({ serviceType: 'Pest' })).not.toHaveProperty('firstReviewAsk');
  });

  test('a visit whose customer was never asked: firstReviewAsk true', async () => {
    const out = await preview({ serviceType: 'Pest', serviceId: 'svc-1' });
    expect(out.firstReviewAsk).toBe(true);
    expect(ReviewService.firstAskLockVisit).toHaveBeenCalledWith('svc-1');
    expect(ReviewService.customerNeverAskedForReview).toHaveBeenCalledWith('cust-1');
    expect(out.bucket).toBe('legacy:+120m');
  });

  test('a customer asked before: firstReviewAsk false', async () => {
    ReviewService.customerNeverAskedForReview.mockResolvedValue(false);
    expect((await preview({ serviceType: 'Pest', serviceId: 'svc-1' })).firstReviewAsk).toBe(false);
  });

  test('a re-service visit or an unknown visit: firstReviewAsk false', async () => {
    ReviewService.firstAskLockVisit.mockResolvedValue(null);
    expect((await preview({ serviceType: 'Pest', serviceId: 'svc-1' })).firstReviewAsk).toBe(false);
    expect(ReviewService.customerNeverAskedForReview).not.toHaveBeenCalled();
  });
});

// GATE_REVIEW_ASK_AT_VISIT (owner 2026-11-01): the preview names the switch, so the completion panel stops saying
// that an unpaid invoice's review text waits for the payment. Gate off: the key is absent.
describe('GET /admin/reviews/send-time-preview with GATE_REVIEW_ASK_AT_VISIT', () => {
  const askAtVisitWas = process.env.GATE_REVIEW_ASK_AT_VISIT;
  afterEach(() => { if (askAtVisitWas === undefined) delete process.env.GATE_REVIEW_ASK_AT_VISIT; else process.env.GATE_REVIEW_ASK_AT_VISIT = askAtVisitWas; });

  test('gate off: no askAtVisit key', async () => {
    delete process.env.GATE_REVIEW_ASK_AT_VISIT;
    expect(await preview({ serviceType: 'Pest' })).not.toHaveProperty('askAtVisit');
  });

  test('gate on: askAtVisit true', async () => {
    process.env.GATE_REVIEW_ASK_AT_VISIT = 'true';
    expect((await preview({ serviceType: 'Pest' })).askAtVisit).toBe(true);
  });
});

// GATE_REVIEW_ALREADY_REVIEWED (owner 2026-11-04): with a visit named, the preview also says whether the customer is
// marked as already reviewed and which off reasons a first ask may carry. Gate off, or no visit named: both keys absent.
describe('GET /admin/reviews/send-time-preview with GATE_REVIEW_ALREADY_REVIEWED', () => {
  const alreadyWas = process.env.GATE_REVIEW_ALREADY_REVIEWED;
  afterEach(() => { if (alreadyWas === undefined) delete process.env.GATE_REVIEW_ALREADY_REVIEWED; else process.env.GATE_REVIEW_ALREADY_REVIEWED = alreadyWas; });

  test('gate off: no alreadyReviewed or firstAskReasons key, and the reader is never asked', async () => {
    delete process.env.GATE_REVIEW_ALREADY_REVIEWED;
    const out = await preview({ serviceType: 'Pest', serviceId: 'svc-1' });
    expect(out).not.toHaveProperty('alreadyReviewed');
    expect(out).not.toHaveProperty('firstAskReasons');
    expect(ReviewService.alreadyReviewedForVisit).not.toHaveBeenCalled();
  });

  test('no visit named: neither key', async () => {
    process.env.GATE_REVIEW_ALREADY_REVIEWED = 'true';
    const out = await preview({ serviceType: 'Pest' });
    expect(out).not.toHaveProperty('alreadyReviewed');
    expect(out).not.toHaveProperty('firstAskReasons');
  });

  test('a marked customer: the mark with its date, and both off reasons', async () => {
    process.env.GATE_REVIEW_ALREADY_REVIEWED = 'true';
    ReviewService.alreadyReviewedForVisit.mockResolvedValue({ reviewedOn: '2025-01-01' });
    const out = await preview({ serviceType: 'Pest', serviceId: 'svc-1' });
    expect(out.alreadyReviewed).toEqual({ reviewedOn: '2025-01-01' });
    expect(out.firstAskReasons).toEqual(['complaint_on_site', 'already_left_review']);
    expect(ReviewService.alreadyReviewedForVisit).toHaveBeenCalledWith('svc-1');
  });

  test('a customer not marked: alreadyReviewed null (the key is there)', async () => {
    process.env.GATE_REVIEW_ALREADY_REVIEWED = 'true';
    const out = await preview({ serviceType: 'Pest', serviceId: 'svc-1' });
    expect(out).toHaveProperty('alreadyReviewed', null);
  });
});

