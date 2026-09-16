/**
 * Codex GitHub round 1 on #4568 — three more defects in
 * services/discount-stack.js, fixed here.
 *
 * 1. (P1) stackDocumentDiscounts' non-fixed (percentage / free_service)
 *    document-term pass ignored `eligibleLines` entirely, computing every
 *    such term against the total remainder across ALL lines.
 *    calculateVisitFinancialsForAddons already supports a service-scoped
 *    percentage appointment discount and the catalog has a service-scoped
 *    free_service preset — replaying either as a document term discounted
 *    an unrelated line, and a scoped free_service term could zero the
 *    WHOLE invoice instead of just its own line.
 *
 * 2. (P2) Percentage stacking depended on input order: rounding the
 *    running `remaining` to the nearest cent after each percentage step
 *    made 5% then 10% land a cent away from 10% then 5% on the same base,
 *    even though the two orders reach the identical total in exact math.
 *
 * 3. (P2) With compound:false (the gate-off / legacy path), several fixed
 *    discounts were each sized against the FULL base independently, so
 *    their sum could exceed the base — two $80/$50 fixed discounts on a
 *    $100 base reported totalDollars 130 with net stuck at its floor of 0,
 *    breaking the totalDollars === base - net invariant.
 */
const {
  stackDiscounts,
  stackDocumentDiscounts,
} = require('../services/discount-stack');

describe('P1 — eligibleLines is honored for percentage and free_service document terms', () => {
  test('a scoped 10% document term discounts only its eligible line, leaving the other untouched', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 100, terms: [] }],
      documentTerms: [{ discountType: 'percentage', amount: 10, eligibleLines: [0] }],
    });
    expect(res.lines.map((l) => l.net)).toEqual([90, 100]);
    expect(res.documentTerms[0].dollars).toBe(10);
  });

  test('a scoped free_service document term zeroes only its eligible line, not the whole invoice', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 50, terms: [] }],
      documentTerms: [{ discountType: 'free_service', amount: 0, eligibleLines: [1] }],
    });
    expect(res.lines.map((l) => l.net)).toEqual([100, 0]);
    expect(res.documentTerms[0].dollars).toBe(50);
  });

  test('an unscoped percentage document term is unchanged: it still reaches every line and totals the same', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 100, terms: [] }],
      documentTerms: [{ discountType: 'percentage', amount: 10 }],
    });
    expect(res.documentTerms[0].dollars).toBe(20); // 10% of the pooled $200
    expect(res.lines.map((l) => l.net)).toEqual([90, 90]); // spread pro rata
  });

  test('a scope that matches no line takes $0 rather than spreading everywhere, for a percentage term too', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 100, terms: [] }],
      documentTerms: [{ discountType: 'percentage', amount: 10, eligibleLines: [] }],
    });
    expect(res.documentTerms[0].dollars).toBe(0);
    expect(res.lines.map((l) => l.net)).toEqual([100, 100]);
  });

  test('a scoped percentage term does not move the base an unrelated line\'s own percentage compounds on (the r3 P1 failure, now also true for a percentage document term)', () => {
    const res = stackDocumentDiscounts({
      lines: [
        { gross: 100, terms: [{ discountType: 'percentage', amount: 10 }] }, // line 0: primary
        { gross: 100, terms: [] }, // line 1: add-on, the only line the doc term reaches
      ],
      documentTerms: [{ discountType: 'percentage', amount: 30, eligibleLines: [1] }],
    });
    // Line 0's own 10% is still exactly $10 — the scoped doc term on line 1
    // never touched line 0's base.
    expect(res.lines[0].termDollars[0]).toBe(10);
    expect(res.lines[0].net).toBe(90);
    expect(res.lines[1].net).toBe(70); // 100 - 30%
  });
});

describe('P2 — percentage stacking no longer depends on input order', () => {
  test('the exact reported repro: $99 at 5% then 10% totals the same as 10% then 5%', () => {
    const a = stackDiscounts(99, [
      { discountType: 'percentage', amount: 5 },
      { discountType: 'percentage', amount: 10 },
    ]);
    const b = stackDiscounts(99, [
      { discountType: 'percentage', amount: 10 },
      { discountType: 'percentage', amount: 5 },
    ]);
    expect(a.net).toBe(b.net);
    expect(a.totalDollars).toBe(b.totalDollars);
    expect(a.totalDollars).toBe(14.36);
    expect(a.net).toBe(84.64);
    // Per-term reporting still maps back to the CALLER's own input order —
    // only the compounding sequence is canonicalized, not which index a
    // dollar figure is reported against.
    expect(a.items.map((i) => i.dollars)).toEqual([4.46, 9.9]); // [5%'s cut, 10%'s cut]
    expect(b.items.map((i) => i.dollars)).toEqual([9.9, 4.46]); // [10%'s cut, 5%'s cut]
  });

  test('per-term dollars still sum exactly to totalDollars regardless of order', () => {
    for (const order of [[5, 10], [10, 5]]) {
      const result = stackDiscounts(99, order.map((amount) => ({ discountType: 'percentage', amount })));
      const sum = Math.round(result.items.reduce((s, i) => s + i.dollars, 0) * 100) / 100;
      expect(sum).toBe(result.totalDollars);
    }
  });

  test('three percentages in every permutation land on the identical total', () => {
    const rates = [5, 10, 15];
    const permute = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => (
      permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest])
    )));
    const totals = permute(rates).map((order) => (
      stackDiscounts(250, order.map((amount) => ({ discountType: 'percentage', amount }))).net
    ));
    expect(new Set(totals).size).toBe(1);
  });

  test('a normal single-percentage case, and dollar-credits-before-percentages, are unaffected', () => {
    expect(stackDiscounts(111, [{ discountType: 'percentage', amount: 10 }]).items[0].dollars).toBe(11.1);
    const result = stackDiscounts(111, [
      { discountType: 'percentage', amount: 10 },
      { discountType: 'fixed_amount', amount: 25 },
    ]);
    // Fixed still resolves first regardless of input position or the new
    // percent ordering: $111 - $25 = $86, then 10% of $86 = $8.60.
    expect(result.items.map((i) => i.dollars)).toEqual([8.6, 25]);
    expect(result.net).toBe(77.4);
  });
});

describe('P2 — compound:false (legacy) never lets the aggregate exceed the base', () => {
  test('the exact reported repro: two fixed $80/$50 discounts on a $100 base clamp to totalDollars 100, not 130', () => {
    const result = stackDiscounts(100, [
      { discountType: 'fixed_amount', amount: 80 },
      { discountType: 'fixed_amount', amount: 50 },
    ], { compound: false });
    expect(result.totalDollars).toBe(100);
    expect(result.net).toBe(0);
    expect(result.totalDollars).toBe(100 - result.net); // the invariant itself
    // Clamped in order: the first item keeps its full face value, the
    // second absorbs only what's left.
    expect(result.items.map((i) => i.dollars)).toEqual([80, 20]);
  });

  test('when the fixed discounts do NOT exceed the base, compound:false is unchanged', () => {
    const result = stackDiscounts(100, [
      { discountType: 'fixed_amount', amount: 30 },
      { discountType: 'fixed_amount', amount: 20 },
    ], { compound: false });
    expect(result.items.map((i) => i.dollars)).toEqual([30, 20]);
    expect(result.totalDollars).toBe(50);
    expect(result.net).toBe(50);
  });

  test('the same clamp applies to a percentage stacked with a fixed discount under compound:false', () => {
    // 60% of $100 = $60 (each resolved independently against the full
    // base, the defining legacy behavior), plus a $50 fixed credit would
    // be $110 face value on a $100 base — clamped to $100 total.
    const result = stackDiscounts(100, [
      { discountType: 'fixed_amount', amount: 50 },
      { discountType: 'percentage', amount: 60 },
    ], { compound: false });
    expect(result.totalDollars).toBe(100);
    expect(result.net).toBe(0);
    // Fixed still resolves before percentage in the clamp order: $50 keeps
    // its full face value, the 60%-of-$100 = $60 item is clamped to the
    // $50 left in the budget.
    expect(result.items.map((i) => i.dollars)).toEqual([50, 50]);
  });

  test('compound:true is unaffected by the compound:false clamp — it already bounds each step via the shrinking remaining', () => {
    const result = stackDiscounts(100, [
      { discountType: 'fixed_amount', amount: 80 },
      { discountType: 'fixed_amount', amount: 50 },
    ]); // compound: true (default)
    expect(result.items.map((i) => i.dollars)).toEqual([80, 20]);
    expect(result.totalDollars).toBe(100);
    expect(result.net).toBe(0);
  });
});
