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
  stackVisitDiscounts,
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

describe('cross-export agreement — the same discounts, the same order, the same total, whichever export you call', () => {
  test('the exact reported repro: stackDocumentDiscounts now agrees with stackDiscounts in both orders', () => {
    const termsA = [
      { discountType: 'percentage', amount: 10 },
      { discountType: 'percentage', amount: 50, maxDiscountDollars: 10 },
    ];
    const termsB = [termsA[1], termsA[0]]; // reversed input order, same two discounts

    const sdA = stackDiscounts(100, termsA);
    const sdB = stackDiscounts(100, termsB);
    const docA = stackDocumentDiscounts({ lines: [{ gross: 100, terms: [] }], documentTerms: termsA });
    const docB = stackDocumentDiscounts({ lines: [{ gross: 100, terms: [] }], documentTerms: termsB });

    // Both exports, both input orders: the same $81 net (before this fix,
    // stackDocumentDiscounts gave $80 for termsA and $81 for termsB —
    // order-dependent AND disagreeing with stackDiscounts' own $81).
    expect(sdA.net).toBe(81);
    expect(sdB.net).toBe(81);
    expect(docA.lines[0].net).toBe(81);
    expect(docB.lines[0].net).toBe(81);

    // Per-term dollars still map back to each export's own input order,
    // and the two exports agree on that mapping too.
    expect(sdA.items.map((i) => i.dollars)).toEqual([9, 10]);
    expect(docA.documentTerms.map((t) => t.dollars)).toEqual([9, 10]);
    expect(sdB.items.map((i) => i.dollars)).toEqual([10, 9]);
    expect(docB.documentTerms.map((t) => t.dollars)).toEqual([10, 9]);
  });

  test('a scoped document term keeps its own eligibleLines and result slot through the reordering', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 100, terms: [] }],
      documentTerms: [
        { discountType: 'percentage', amount: 10, eligibleLines: [0] }, // smaller rate, listed first
        { discountType: 'percentage', amount: 50, maxDiscountDollars: 10, eligibleLines: [1] }, // larger rate, processed first
      ],
    });
    // Canonical order processes the 50% term first, but it only ever
    // reaches line 1 (its own scope) — line 0 still gets exactly its own
    // 10%, unaffected by which term compounds first.
    expect(res.lines.map((l) => l.net)).toEqual([90, 90]);
    expect(res.documentTerms.map((t) => t.dollars)).toEqual([10, 10]); // mapped back to input order
  });

  test('stackVisitDiscounts agrees where it actually delegates: a LINE\'s own multi-term stack (via stackDocumentDiscounts, which calls stackDiscounts for line terms) matches stackDiscounts directly', () => {
    // stackVisitDiscounts itself has only ONE discount slot per line (no
    // multi-percentage order to canonicalize there — see the P2 fix in
    // this same round, which only touched stackDiscounts/stackOrder and
    // stackDocumentDiscounts' document-term pass). Where this module DOES
    // delegate multiple same-line percentages to stackDiscounts — a
    // document line's own `terms` list, in stackDocumentDiscounts' step 3
    // — it must still agree with calling stackDiscounts on that same list
    // directly, in both input orders.
    const termsA = [
      { discountType: 'percentage', amount: 10 },
      { discountType: 'percentage', amount: 50, maxDiscountDollars: 10 },
    ];
    const termsB = [termsA[1], termsA[0]];
    const sdA = stackDiscounts(100, termsA);
    const sdB = stackDiscounts(100, termsB);
    const lineA = stackDocumentDiscounts({ lines: [{ gross: 100, terms: termsA }], documentTerms: [] });
    const lineB = stackDocumentDiscounts({ lines: [{ gross: 100, terms: termsB }], documentTerms: [] });
    expect(lineA.lines[0].net).toBe(sdA.net);
    expect(lineB.lines[0].net).toBe(sdB.net);
    expect(lineA.lines[0].net).toBe(lineB.lines[0].net);
  });
});

describe('slot precedence — line before document, even when the document rate is higher', () => {
  test('the exact reported repro: $100 base, line 10%, document 50% capped at $10, agrees at $80 across all three exports, both input orders', () => {
    const line10 = { discountType: 'percentage', amount: 10 }; // slot defaults to 'line'
    const doc50 = { discountType: 'percentage', amount: 50, maxDiscountDollars: 10, slot: 'document' };

    // stackDiscounts: the `slot` tag is what lets a flat call reproduce
    // the line-before-document precedence at all — without it there is
    // nothing to tell it these two percentages don't share a slot, and it
    // falls back to pure rate order (50% would run first).
    const sdLineFirst = stackDiscounts(100, [line10, doc50]);
    const sdDocFirst = stackDiscounts(100, [doc50, line10]);
    expect(sdLineFirst.net).toBe(80);
    expect(sdDocFirst.net).toBe(80);
    // Per-term dollars still map back to each call's own input order.
    expect(sdLineFirst.items.map((i) => i.dollars)).toEqual([10, 10]);
    expect(sdDocFirst.items.map((i) => i.dollars)).toEqual([10, 10]);

    // stackDocumentDiscounts: the line's own 10% is a LINE term, the 50%
    // (capped $10) is a DOCUMENT term — slots come from where each term
    // lives, not a `slot` field.
    const docRes = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [{ discountType: 'percentage', amount: 10 }] }],
      documentTerms: [{ discountType: 'percentage', amount: 50, maxDiscountDollars: 10 }],
    });
    expect(docRes.lines[0].net).toBe(80);

    // stackVisitDiscounts: the line discount is the line slot, the
    // appointment discount is the document slot.
    const visitRes = stackVisitDiscounts({
      lines: [{ gross: 100, lineDiscount: { discountType: 'percentage', amount: 10 }, eligible: true }],
      appointmentDiscount: { discountType: 'percentage', amount: 50, maxDiscountDollars: 10 },
    });
    expect(visitRes.total).toBe(80);
  });

  test('a capped document percentage never gets to compound on the pre-line-discount base, proving the cap itself respects precedence', () => {
    // Line 20% (uncapped), document 80% capped at $5, base $100. If rate
    // ruled the document 80% would run FIRST (before the line's 20% ever
    // touches the base) and net would be $100 - $5 - 20%-of-$95($19) =
    // $76. Slot precedence runs the line's 20% first instead: $100 - $20
    // = $80, then the document's 80%-of-$80 ($64) caps at $5 -> net $75.
    const line20 = { discountType: 'percentage', amount: 20 };
    const doc80Capped = { discountType: 'percentage', amount: 80, maxDiscountDollars: 5, slot: 'document' };

    const sd = stackDiscounts(100, [line20, doc80Capped]);
    expect(sd.net).toBe(75);
    expect(sd.items.map((i) => i.dollars)).toEqual([20, 5]);

    const docRes = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [line20] }],
      documentTerms: [{ discountType: 'percentage', amount: 80, maxDiscountDollars: 5 }],
    });
    expect(docRes.lines[0].net).toBe(75);

    const visitRes = stackVisitDiscounts({
      lines: [{ gross: 100, lineDiscount: line20, eligible: true }],
      appointmentDiscount: { discountType: 'percentage', amount: 80, maxDiscountDollars: 5 },
    });
    expect(visitRes.total).toBe(75);
  });

  test('with no slot marked at all, behavior is exactly the pre-existing rate-only order (backward compatible)', () => {
    // Neither term claims a slot, so both default to 'line' — precedence
    // never enters into it, and pure rate order (the prior round's fix)
    // still decides: the 50% (capped $10) still runs first here, unlike
    // the marked-document case above.
    const result = stackDiscounts(100, [
      { discountType: 'percentage', amount: 10 },
      { discountType: 'percentage', amount: 50, maxDiscountDollars: 10 },
    ]);
    expect(result.net).toBe(81); // matches the pre-slot-fix stackDiscounts total
    expect(result.items.map((i) => i.dollars)).toEqual([9, 10]);
  });

  test('multiple percentages within the SAME slot still sort by rate, only across slots does slot win', () => {
    // Two line percentages (15%, 5%) and one document percentage (30%
    // capped at $4): both line terms resolve first (rate order between
    // them: 15% then 5%), then the document term on the remainder.
    const terms = [
      { discountType: 'percentage', amount: 5 }, // line, listed first
      { discountType: 'percentage', amount: 30, maxDiscountDollars: 4, slot: 'document' },
      { discountType: 'percentage', amount: 15 }, // line, listed last
    ];
    const result = stackDiscounts(200, terms);
    // Line phase: 15% of 200 = 30, remaining 170; 5% of 170 = 8.5,
    // remaining 161.5. Document phase: 30% of 161.5 = 48.45, capped at 4.
    expect(result.items.map((i) => i.dollars)).toEqual([8.5, 4, 30]);
    expect(result.net).toBe(157.5);
  });
});

describe('cap tie-break — same rate, different caps, resolves deterministically (the tighter cap first)', () => {
  test('the exact reported repro: $100 at 50% capped $10 plus 50% uncapped nets $45 in both orders, across every place stackOrder is used', () => {
    const capped = { discountType: 'percentage', amount: 50, maxDiscountDollars: 10 };
    const uncapped = { discountType: 'percentage', amount: 50 };

    // stackDiscounts directly, both input orders.
    const sdA = stackDiscounts(100, [capped, uncapped]);
    const sdB = stackDiscounts(100, [uncapped, capped]);
    expect(sdA.net).toBe(45);
    expect(sdB.net).toBe(45);
    // Per-term dollars still map back to each call's own input order: the
    // capped term always takes $10 (it resolves first regardless of which
    // position it was listed in), the uncapped term takes the rest ($45).
    expect(sdA.items.map((i) => i.dollars)).toEqual([10, 45]);
    expect(sdB.items.map((i) => i.dollars)).toEqual([45, 10]);

    // stackDocumentDiscounts: both as document-level terms, both orders.
    const docA = stackDocumentDiscounts({ lines: [{ gross: 100, terms: [] }], documentTerms: [capped, uncapped] });
    const docB = stackDocumentDiscounts({ lines: [{ gross: 100, terms: [] }], documentTerms: [uncapped, capped] });
    expect(docA.lines[0].net).toBe(45);
    expect(docB.lines[0].net).toBe(45);

    // stackDocumentDiscounts: both as ONE line's own terms, both orders —
    // exercises the same stackOrder fix through step 1/3's stackDiscounts
    // delegation instead of step 4's document-term loop.
    const lineA = stackDocumentDiscounts({ lines: [{ gross: 100, terms: [capped, uncapped] }], documentTerms: [] });
    const lineB = stackDocumentDiscounts({ lines: [{ gross: 100, terms: [uncapped, capped] }], documentTerms: [] });
    expect(lineA.lines[0].net).toBe(45);
    expect(lineB.lines[0].net).toBe(45);
  });

  test('stackVisitDiscounts has no same-slot tie to break — one discount slot per line and per appointment means two same-rate percentages can never compound on the same base there', () => {
    // The cap tie-break lives inside stackOrder, which stackVisitDiscounts
    // never calls (it hand-computes each of its four steps directly) —
    // there is no way to hand a stackVisitDiscounts line or appointment
    // slot a SECOND percentage to tie against the first. What IS shared is
    // discountStepDollars' own cap handling, so a single capped percentage
    // through stackVisitDiscounts still agrees with the same single
    // discount through stackDiscounts.
    const capped = { discountType: 'percentage', amount: 50, maxDiscountDollars: 10 };
    const visitRes = stackVisitDiscounts({
      lines: [{ gross: 100, lineDiscount: capped, eligible: true }],
      appointmentDiscount: null,
    });
    const sdRes = stackDiscounts(100, [capped]);
    expect(visitRes.lines[0].lineDiscountDollars).toBe(sdRes.items[0].dollars);
    expect(visitRes.lines[0].lineDiscountDollars).toBe(10);
  });

  test('a three-term equal-rate case: ascending cap order (tightest first, uncapped last) wins regardless of how the caller lists them', () => {
    const tight = { discountType: 'percentage', amount: 40, maxDiscountDollars: 5 };
    const loose = { discountType: 'percentage', amount: 40, maxDiscountDollars: 15 };
    const open = { discountType: 'percentage', amount: 40 };

    for (const order of [
      [tight, loose, open],
      [open, tight, loose],
      [loose, open, tight],
      [open, loose, tight],
    ]) {
      const result = stackDiscounts(300, order);
      // Canonical processing is always tight($5) -> loose($15) -> open
      // (40% of the $280 left = $112), for a $132 total / $168 net,
      // however the caller ordered the same three terms.
      expect(result.totalDollars).toBe(132);
      expect(result.net).toBe(168);
      // Each term's own reported dollars still matches its OWN identity
      // (found by object reference) rather than its input position.
      const dollarsFor = (term) => result.items[order.indexOf(term)].dollars;
      expect(dollarsFor(tight)).toBe(5);
      expect(dollarsFor(loose)).toBe(15);
      expect(dollarsFor(open)).toBe(112);
    }
  });

  test('caps ONLY break ties at equal rate — a higher rate still runs first even against a much tighter cap', () => {
    const higherRateTightCap = { discountType: 'percentage', amount: 90, maxDiscountDollars: 1 };
    const lowerRateUncapped = { discountType: 'percentage', amount: 10 };
    const result = stackDiscounts(100, [lowerRateUncapped, higherRateTightCap]);
    // Rate still decides first: 90% of $100 capped at $1 resolves before
    // the 10% — the cap tie-break never overrides an actual rate
    // difference, it only breaks a genuine tie.
    expect(result.items.map((i) => i.dollars)).toEqual([9.9, 1]);
  });
});
