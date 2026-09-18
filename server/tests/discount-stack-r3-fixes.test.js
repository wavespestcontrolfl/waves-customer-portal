/**
 * PR #4405 Codex round 3 — the two shared-module fixes in
 * services/discount-stack.js.
 *
 * 1. (P2) allocateProRata rounded every preliminary share independently, so
 *    several could round UP and together exceed the amount being split,
 *    leaving the last line a NEGATIVE share. $0.02 over four equal lines
 *    produces $0.01/$0.01/$0.01/-$0.01. Downstream that lands as a negative
 *    appointment share on a visit line, and addonOnlyTotal drops it,
 *    misbilling a covered-series add-on by a cent.
 *
 * 2. (P1, via invoice.js) stackDocumentDiscounts had no per-term line
 *    scoping — every document term reached every line. The invoice replay of
 *    a scheduled appointment discount narrowed by discount_service_key_filter
 *    therefore spread across all lines and moved the base the OTHER lines'
 *    percentages compound on.
 */
const {
  stackDocumentDiscounts,
  stackVisitDiscounts,
} = require('../services/discount-stack');

describe('allocateProRata never hands out a negative share (r3 P2)', () => {
  test('a $0.02 fixed document credit over four equal lines stays nonnegative and sums exactly', () => {
    // Pre-fix each of the first three shares rounds up to $0.01, so the
    // last line is handed $0.02 - $0.03 = -$0.01 and its net comes back
    // ABOVE its own gross.
    const res = stackDocumentDiscounts({
      lines: [
        { gross: 1, terms: [] },
        { gross: 1, terms: [] },
        { gross: 1, terms: [] },
        { gross: 1, terms: [] },
      ],
      documentTerms: [{ discountType: 'fixed_amount', amount: 0.02 }],
    });
    const taken = res.lines.map((l) => Math.round((1 - l.net) * 100) / 100);
    taken.forEach((share) => expect(share).toBeGreaterThanOrEqual(0));
    res.lines.forEach((l) => expect(l.net).toBeLessThanOrEqual(1));
    expect(Math.round(taken.reduce((a, b) => a + b, 0) * 100) / 100).toBe(0.02);
    expect(res.documentTerms[0].dollars).toBe(0.02);
  });

  test('the visit stack allocates a fixed appointment credit nonnegatively too', () => {
    const res = stackVisitDiscounts({
      lines: [
        { gross: 1, lineDiscount: null, eligible: true },
        { gross: 1, lineDiscount: null, eligible: true },
        { gross: 1, lineDiscount: null, eligible: true },
        { gross: 1, lineDiscount: null, eligible: true },
      ],
      appointmentDiscount: { discountType: 'fixed_amount', amount: 0.02 },
      compound: true,
    });
    const shares = res.lines.map((l) => l.appointmentDiscountDollars);
    shares.forEach((share) => expect(share).toBeGreaterThanOrEqual(0));
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100)
      .toBe(res.appointmentDiscountDollars);
  });

  test('an ordinary split is unchanged — $30 over two equal $100 lines is $15/$15', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 100, terms: [] }],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30 }],
    });
    expect(res.lines.map((l) => l.net)).toEqual([85, 85]);
  });
});

describe('stackDocumentDiscounts honors per-term eligibleLines (r3 P1)', () => {
  test('a scoped $30 credit lands only on its own line, leaving the other line’s percentage on the full gross', () => {
    const res = stackDocumentDiscounts({
      lines: [
        // line 0: primary $100 with its own 10% discount
        { gross: 100, terms: [{ discountType: 'percentage', amount: 10 }] },
        // line 1: a $100 add-on, the only line the credit reaches
        { gross: 100, terms: [] },
      ],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30, eligibleLines: [1] }],
    });
    // The credit comes entirely off line 1, so line 0's 10% is still $10.
    expect(res.lines[0].termDollars[0]).toBe(10);
    expect(res.lines[0].net).toBe(90);
    expect(res.lines[1].net).toBe(70);
    expect(res.documentTerms[0].dollars).toBe(30);
  });

  test('unscoped is the old behavior: the same credit spread over both lines drops the 10% to $8.50', () => {
    const res = stackDocumentDiscounts({
      lines: [
        { gross: 100, terms: [{ discountType: 'percentage', amount: 10 }] },
        { gross: 100, terms: [] },
      ],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30 }],
    });
    // $15 off each line, then 10% of the remaining $85 = $8.50 — exactly the
    // number the scoped case must NOT produce.
    expect(res.lines[0].termDollars[0]).toBe(8.5);
  });

  test('a scope that matches no line takes $0 rather than spreading everywhere', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 100, terms: [] }],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30, eligibleLines: [] }],
    });
    expect(res.documentTerms[0].dollars).toBe(0);
    expect(res.lines.map((l) => l.net)).toEqual([100, 100]);
  });

  test('two document terms still compound in order when both are unscoped', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }],
      documentTerms: [
        { discountType: 'fixed_amount', amount: 20 },
        { discountType: 'fixed_amount', amount: 30 },
      ],
    });
    expect(res.documentTerms.map((t) => t.dollars)).toEqual([20, 30]);
    expect(res.lines[0].net).toBe(50);
  });

  test('a fixed term never takes more than its own pool holds', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 10, terms: [] }, { gross: 100, terms: [] }],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30, eligibleLines: [0] }],
    });
    expect(res.documentTerms[0].dollars).toBe(10);
    expect(res.lines.map((l) => l.net)).toEqual([0, 100]);
  });
});
