/**
 * assertPriceMatchesPricing (server/routes/admin-schedule.js) — Codex
 * pre-push audit P0 (round 6, blocked push 8 on PR #4656): POST
 * /api/admin/schedule bound the write to the previewed discount-stacking
 * REGIME (expected_discount_stacking) but not to the previewed DOLLAR
 * AMOUNT itself. A discount's own catalog amount can drift mid-session
 * (a $10 credit edited to $5) with the regime completely unchanged — the
 * client's live gate probe agrees, but buildAppointmentPricing still
 * recomputes a different pricing.finalPrice than what /preview showed
 * and the operator saw on screen. This pins the pure comparison function
 * directly, mirroring admin-schedule-prepay-total-gate.test.js exactly
 * (same shape as assertPrepayTotalMatchesPricing, unit-level, no
 * route/db mocking needed — the function takes exactly the inputs the
 * route already has in scope: req.body.expected_price and
 * pricing.finalPrice).
 */
const { assertPriceMatchesPricing } = require('../routes/admin-schedule')._test;

describe('assertPriceMatchesPricing', () => {
  test('$90 previewed when the server now prices $95 -> throws a retryable 409 with the exact code', () => {
    expect(() => assertPriceMatchesPricing({ expectedPrice: 90, finalPrice: 95 }))
      .toThrow(expect.objectContaining({
        statusCode: 409, status: 409, isOperational: true, code: 'PRICE_DIVERGED',
        message: expect.stringContaining('changed since this was previewed'),
      }));
  });

  test('a matching price ($90 previewed, $90 authoritative) never throws', () => {
    expect(() => assertPriceMatchesPricing({ expectedPrice: 90, finalPrice: 90 })).not.toThrow();
  });

  test('cent-level rounding noise does not false-positive', () => {
    expect(() => assertPriceMatchesPricing({ expectedPrice: 33.33, finalPrice: 33.333333 })).not.toThrow();
  });

  test('a one-cent-off submission still throws (not a loose/rounded comparison)', () => {
    expect(() => assertPriceMatchesPricing({ expectedPrice: 90.01, finalPrice: 90 }))
      .toThrow(expect.objectContaining({ code: 'PRICE_DIVERGED' }));
  });

  // undefined (no field sent) skips the check entirely — every existing
  // caller, and any client older than this round, stays byte-identical.
  test('expectedPrice undefined (field omitted) never throws, regardless of finalPrice', () => {
    expect(() => assertPriceMatchesPricing({ expectedPrice: undefined, finalPrice: 12345.67 })).not.toThrow();
  });
});
