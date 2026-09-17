/**
 * Pre-push audit — two P1 money-math defects found in the carried
 * services/discount-stack.js (slice 1 of #4405), both reproduced and fixed
 * in the same commit as these tests.
 *
 * 1. discountStepDollars computed a percentage as `remaining * (amount /
 *    100)` in ordinary floating point, then rounded the DOLLAR result. That
 *    intermediate product can land one ulp below the true half-cent
 *    boundary (20.70 * 0.05 === 1.0349999999999999 in IEEE754 double), so
 *    an ordinary round-half-up on the corrupted value rounds DOWN to
 *    $1.03 instead of the correct $1.04. Fixed by moving the whole
 *    computation into integer cents / basis points before any division,
 *    so the rounding boundary is decided by the true mathematical value,
 *    never by float representation noise.
 *
 * 2. allocateProRata's old "last line takes the undistributed remainder"
 *    technique kept every share >= 0 and the total exactly right, but
 *    never bounded an individual share by that line's own remaining
 *    balance — a proportional split could round a share UP past what a
 *    small line actually has left. Fixed with floor-then-largest-
 *    remainder allocation in integer cents, each share explicitly capped
 *    at weightOf(line) (every caller already passes the line's own
 *    balance as the weight), with the rounding leftover redistributed only
 *    to lines that still have headroom.
 */
const {
  stackDiscounts,
  stackVisitDiscounts,
  stackDocumentDiscounts,
} = require('../services/discount-stack');

describe('P1 #1 — percentage math no longer drifts across the half-cent boundary', () => {
  test('5% of $20.70 is the half-up $1.04, not $1.03 (the exact reported repro)', () => {
    const result = stackDiscounts(20.70, [{ discountType: 'percentage', amount: 5 }]);
    expect(result.items[0].dollars).toBe(1.04);
    expect(result.net).toBe(19.66);
  });

  test('50% of $0.05 is $0.03 (half-up of the exact $0.025 midpoint)', () => {
    const result = stackDiscounts(0.05, [{ discountType: 'percentage', amount: 50 }]);
    expect(result.items[0].dollars).toBe(0.03);
  });

  test('a base with sub-cent precision is normalized to the nearest cent (half-up) before the percentage applies', () => {
    // 1.005 is not exactly representable in IEEE754 double — it stores as
    // 1.00499999999999989..., so Math.round(1.005 * 100) is 100, the same
    // normalize-to-nearest-cent rule `cents()` already applies everywhere
    // else in this module. Documented here rather than silently assumed:
    // this function never operates on sub-cent dollars, only on what they
    // round to first.
    const result = stackDiscounts(1.005, [{ discountType: 'percentage', amount: 20 }]);
    expect(result.items[0].dollars).toBe(0.2); // 20% of the normalized $1.00
  });

  test('a normal, evenly-divisible case is unchanged — 10% of $111 is still $11.10', () => {
    expect(stackDiscounts(111, [{ discountType: 'percentage', amount: 10 }]).items[0].dollars).toBe(11.1);
  });

  test('stacked percentages still compound through the fixed helper — 10% then 5% off $111 is $16.10', () => {
    const result = stackDiscounts(111, [
      { discountType: 'percentage', amount: 10 },
      { discountType: 'percentage', amount: 5 },
    ]);
    expect(result.totalDollars).toBe(16.1);
  });

  test('a line percentage inside stackVisitDiscounts also lands on the half-up boundary correctly', () => {
    const result = stackVisitDiscounts({
      lines: [{ gross: 20.70, lineDiscount: { discountType: 'percentage', amount: 5 }, eligible: true }],
      appointmentDiscount: null,
    });
    expect(result.lines[0].lineDiscountDollars).toBe(1.04);
    expect(result.lines[0].net).toBe(19.66);
  });

  test('a document-term percentage inside stackDocumentDiscounts also lands on the half-up boundary correctly', () => {
    // A document-level percentage term deliberately has no per-line
    // allocation (see stackDocumentDiscounts step 4's own comment — no
    // consumer needs a per-line share of it today), so it reports its
    // total via documentTerms[].dollars without touching line.net; this
    // test only checks that total crosses the money-math fix correctly,
    // not the (unrelated, pre-existing, out of scope for this fix) net
    // behavior.
    const result = stackDocumentDiscounts({
      lines: [{ gross: 20.70, terms: [] }],
      documentTerms: [{ discountType: 'percentage', amount: 5 }],
    });
    expect(result.documentTerms[0].dollars).toBe(1.04);
  });
});

describe('P1 #2 — a pro-rata share never exceeds its own line\'s remaining balance', () => {
  test('the exact reported repro: an $0.08 credit over $0.04/$0.04/$0.04/$0.01 balances nets out to $0.05, not $0.06', () => {
    const gross = [0.04, 0.04, 0.04, 0.01];
    const res = stackDocumentDiscounts({
      lines: gross.map((g) => ({ gross: g, terms: [] })),
      documentTerms: [{ discountType: 'fixed_amount', amount: 0.08 }],
    });

    // The reported discount is unchanged — $0.08 was always the correct
    // amount to take off $0.13 of gross.
    expect(res.documentTerms[0].dollars).toBe(0.08);

    // No line's net goes negative or above its own gross (the concrete
    // manifestation of the bug: the $0.01 line was handed a $0.02 share).
    res.lines.forEach((line, i) => {
      expect(line.net).toBeGreaterThanOrEqual(0);
      expect(line.net).toBeLessThanOrEqual(gross[i]);
    });

    // The invariant the audit asked for directly: nets + what was taken
    // must reconcile exactly to the original gross, to the cent.
    const sumNets = Math.round(res.lines.reduce((sum, line) => sum + line.net, 0) * 100) / 100;
    const sumGross = Math.round(gross.reduce((sum, g) => sum + g, 0) * 100) / 100;
    expect(sumNets).toBe(0.05);
    expect(Math.round((sumNets + res.documentTerms[0].dollars) * 100) / 100).toBe(sumGross);
  });

  test('the same shape through stackVisitDiscounts\' appointment-credit allocation', () => {
    const gross = [0.04, 0.04, 0.04, 0.01];
    const res = stackVisitDiscounts({
      lines: gross.map((g) => ({ gross: g, lineDiscount: null, eligible: true })),
      appointmentDiscount: { discountType: 'fixed_amount', amount: 0.08 },
    });
    res.lines.forEach((line, i) => {
      expect(line.appointmentDiscountDollars).toBeLessThanOrEqual(gross[i]);
      expect(line.net).toBeGreaterThanOrEqual(0);
    });
    const sumShares = Math.round(res.lines.reduce((sum, line) => sum + line.appointmentDiscountDollars, 0) * 100) / 100;
    expect(sumShares).toBe(res.appointmentDiscountDollars);
    expect(res.total).toBe(0.05);
  });

  test('an evenly-divisible split is unchanged — $30 over two $100 lines is still exactly $15/$15', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 100, terms: [] }],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30 }],
    });
    expect(res.lines.map((l) => l.net)).toEqual([85, 85]);
  });

  test('a line already at its own cap absorbs no more than its balance even when several lines tie on weight', () => {
    // Four equal $0.01 lines, an $0.03 credit: 3 of the 4 lines each take
    // their full $0.01 (net $0) and the 4th is left untouched at $0.01 —
    // no line can ever be asked for more than its own $0.01, so nothing
    // here can round to a $0.0075-ish share and overshoot.
    const res = stackDocumentDiscounts({
      lines: [0.01, 0.01, 0.01, 0.01].map((g) => ({ gross: g, terms: [] })),
      documentTerms: [{ discountType: 'fixed_amount', amount: 0.03 }],
    });
    res.lines.forEach((line) => expect(line.net).toBeGreaterThanOrEqual(0));
    const nets = res.lines.map((l) => l.net).sort();
    expect(nets).toEqual([0, 0, 0, 0.01]);
    expect(res.documentTerms[0].dollars).toBe(0.03);
  });
});
