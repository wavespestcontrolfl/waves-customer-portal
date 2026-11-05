/**
 * Audit A13 (2026-11-04): GET /admin/reviews/send-time-preview?serviceId= says whether a visit's customer was
 * ever asked for a review. A technician may name only a visit in its own current/recent window; any other
 * visit id gets 404. An admin may name any visit.
 */
let mockOwnVisit = null;
const mockWhere = jest.fn();
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const q = {
      columnInfo: jest.fn().mockResolvedValue({ report_template_version: {} }),
      where(...args) { mockWhere(...args); return this; },
      whereNotIn() { return this; },
      first: () => Promise.resolve(mockOwnVisit),
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
  mockOwnVisit = null;
  mockWhere.mockClear();
  ReviewService.customerNeverAskedForReview.mockReset().mockResolvedValue(true);
  ReviewService.firstAskLockVisit.mockReset().mockResolvedValue({ customer_id: 'cust-1' });
});

// Runs the route's own scope check, then the handler when the check passes (the two auth layers before them are skipped).
async function preview(req) {
  const router = require('../routes/admin-reviews');
  const stack = router.stack.find((layer) => layer.route?.path === '/send-time-preview').route.stack;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  let passed = false;
  await stack.at(-2).handle(req, res, (err) => { if (err) throw err; passed = true; });
  if (!passed) return res;
  const next = jest.fn();
  await stack.at(-1).handle(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

describe('GET /admin/reviews/send-time-preview serviceId scope', () => {
  const tech = { techRole: 'technician', technicianId: 'tech-1' };

  test('a technician naming a visit outside its own window gets 404 and no answer', async () => {
    mockOwnVisit = undefined;
    const res = await preview({ ...tech, query: { serviceType: 'Pest', serviceId: 'foreign-visit' } });
    expect(res.statusCode).toBe(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Visit not found' });
    expect(mockWhere).toHaveBeenCalledWith('scheduled_services.technician_id', 'tech-1');
    expect(ReviewService.firstAskLockVisit).not.toHaveBeenCalled();
  });

  test('a technician naming its own visit still gets the preview', async () => {
    mockOwnVisit = { id: 'svc-1' };
    const res = await preview({ ...tech, query: { serviceType: 'Pest', serviceId: 'svc-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json.mock.calls[0][0]).toHaveProperty('bucket');
  });

  test('a technician with no serviceId still gets the preview', async () => {
    const res = await preview({ ...tech, query: { serviceType: 'Pest' } });
    expect(res.statusCode).toBe(200);
  });

  test('an admin naming any visit is not checked', async () => {
    mockOwnVisit = undefined;
    const res = await preview({ techRole: 'admin', query: { serviceType: 'Pest', serviceId: 'any-visit' } });
    expect(res.statusCode).toBe(200);
    expect(mockWhere).not.toHaveBeenCalledWith('scheduled_services.technician_id', expect.anything());
  });
});
