/**
 * assertPrepayTotalMatchesPricing (server/routes/admin-schedule.js) —
 * GitHub round 4 P0 follow-up on PR #4656 ("the part that makes the P0
 * unfakeable"): POST /api/admin/schedule used to stamp
 * req.body.prepaid.totalAmount verbatim, with no server-side
 * recomputation against the actual per-visit price. This pins the pure
 * comparison function directly (unit-level, no route/db mocking needed —
 * the function takes exactly the inputs the route already has in scope:
 * pricing.finalPrice and plannedCount).
 */
const { assertPrepayTotalMatchesPricing } = require('../routes/admin-schedule')._test;

describe('assertPrepayTotalMatchesPricing', () => {
  test('$360 submitted when the server prices $80/visit x 4 = $320 -> throws a retryable 409 with the exact code', () => {
    expect(() => assertPrepayTotalMatchesPricing({ totalAmount: 360, finalPrice: 80, plannedCount: 4 }))
      .toThrow(expect.objectContaining({
        statusCode: 409, status: 409, isOperational: true, code: 'PREPAY_TOTAL_DIVERGED',
        message: expect.stringContaining('changed since this was previewed'),
      }));
  });

  test('a matching total ($320 submitted, $80 x 4 = $320 authoritative) never throws', () => {
    expect(() => assertPrepayTotalMatchesPricing({ totalAmount: 320, finalPrice: 80, plannedCount: 4 })).not.toThrow();
  });

  test('cent-level rounding noise (e.g. a $33.33/$33.33/$33.34 split summing to $100.00) does not false-positive', () => {
    expect(() => assertPrepayTotalMatchesPricing({ totalAmount: 100, finalPrice: 33.333333, plannedCount: 3 })).not.toThrow();
  });

  test('a one-cent-off submission still throws (not a loose/rounded comparison)', () => {
    expect(() => assertPrepayTotalMatchesPricing({ totalAmount: 320.01, finalPrice: 80, plannedCount: 4 }))
      .toThrow(expect.objectContaining({ code: 'PREPAY_TOTAL_DIVERGED' }));
  });
});
