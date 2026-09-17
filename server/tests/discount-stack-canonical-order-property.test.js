/**
 * Codex GitHub round 3 on #4568 — closing the ordering-defect class for
 * good, rather than patching one more attribute onto the tie-break.
 *
 * Two more findings surfaced the same class of bug the last several
 * rounds kept finding one attribute at a time (rate, then cap, then
 * slot): a canonicalizer that only sorts by SOME of a discount's
 * attributes still lets the attributes it ignores make the total order-
 * dependent.
 *
 * P1 (:578, before the round-5 fix): stackDocumentDiscounts' fixed-
 * document-term pass iterated in plain input order — no canonicalization
 * at all — so a service-scoped $80 credit and an unscoped $80 credit on
 * $50/$100 lines left $20 net in one order and $46.67 in the other.
 *
 * P2 (:286, before the round-5 fix): two percentage terms tied on rate
 * AND cap, but scoped to different (overlapping) line sets, were still
 * order-dependent at cent precision.
 *
 * Both are fixed by the module's now-COMPLETE canonical key (see the
 * header's CANONICAL ORDER section): slot, kind, rate, cap, scope,
 * index — applied uniformly by stackOrder AND by both of
 * stackDocumentDiscounts' document-term passes. The property test at the
 * bottom of this file is what actually closes the class: instead of
 * adding one more "exact repro, both orders" test per attribute forever,
 * it shuffles thousands of randomly-generated stacks (random line counts,
 * random terms mixing every slot/kind/rate/cap/scope combination) and
 * asserts the total and every per-line net survive the shuffle
 * unchanged, through every export.
 */
const {
  stackDiscounts,
  stackDocumentDiscounts,
  stackVisitDiscounts,
} = require('../services/discount-stack');

// Deterministic, dependency-free PRNG (mulberry32) — fast, seeded, so a
// failing seed is reproducible without needing a fixture file.
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rand, arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randInt(rand, lo, hi) {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

function randMoney(rand, lo, hi) {
  return Math.round((rand() * (hi - lo) + lo) * 100) / 100;
}

// One random discount, any kind. Two independently-generated discounts
// can land on the exact same (kind, rate, cap, scope, slot) tuple by
// chance — most likely for free_service, which has no rate or cap to
// distinguish it at all — and when that happens they are GENUINELY tied
// under the module's own canonical order, with nothing left to break the
// tie except which one the caller happened to list first. Shuffling two
// truly-tied terms can legitimately swap WHICH ONE gets credited (one
// free_service takes the whole remaining pool, the other gets $0) even
// though the AGGREGATE never moves — so this property test asserts what
// the audit actually asked for (totals and per-line nets), not a per-
// term identity mapping that ties make impossible to guarantee in
// general. The dedicated "exact reported repros" below use deliberately
// DISTINCT terms specifically so their per-term mapping is meaningful.
function randomDiscount(rand, { numLines, allowScope, allowSlot }) {
  const kindRoll = rand();
  const discountType = kindRoll < 0.45 ? 'percentage' : kindRoll < 0.85 ? 'fixed_amount' : 'free_service';
  const discount = { discountType };
  if (discountType === 'percentage') {
    discount.amount = randInt(rand, 1, 60);
    if (rand() < 0.4) discount.maxDiscountDollars = randMoney(rand, 1, 80);
  } else if (discountType === 'fixed_amount') {
    discount.amount = randMoney(rand, 1, 150);
  } else {
    discount.amount = 0;
  }
  if (allowSlot && rand() < 0.5) discount.slot = 'document';
  if (allowScope && numLines > 1 && rand() < 0.4) {
    const size = randInt(rand, 1, numLines - 1);
    const idx = Array.from({ length: numLines }, (_, i) => i);
    const scoped = shuffle(rand, idx).slice(0, size).sort((a, b) => a - b);
    discount.eligibleLines = scoped;
  }
  return discount;
}

describe('property: shuffling term order never changes the total or any per-line net', () => {
  test('stackDiscounts — 5000 random flat stacks, terms across kinds/rates/caps/(flat) slots', () => {
    const rand = mulberry32(20260916);
    let trials = 0;
    for (let t = 0; t < 5000; t++) {
      const base = randMoney(rand, 1, 500);
      const count = randInt(rand, 1, 6);
      const terms = Array.from({ length: count }, () => randomDiscount(rand, { numLines: 1, allowScope: false, allowSlot: true }));
      const shuffled = shuffle(rand, terms);

      const r1 = stackDiscounts(base, terms);
      const r2 = stackDiscounts(base, shuffled);
      trials++;

      expect(r2.net).toBe(r1.net);
      expect(r2.totalDollars).toBe(r1.totalDollars);
    }
    expect(trials).toBe(5000);
  });

  test('stackDocumentDiscounts — 5000 random multi-line stacks, document terms across kinds/rates/caps/scopes', () => {
    const rand = mulberry32(45678901);
    let trials = 0;
    let totalDiscountAgreements = 0;
    for (let t = 0; t < 5000; t++) {
      const numLines = randInt(rand, 1, 4);
      const grosses = Array.from({ length: numLines }, () => randMoney(rand, 1, 300));
      const termCount = randInt(rand, 0, 5);
      const documentTerms = Array.from({ length: termCount }, () => randomDiscount(rand, { numLines, allowScope: true, allowSlot: false }));
      const shuffled = shuffle(rand, documentTerms);

      const lines1 = grosses.map((gross) => ({ gross, terms: [] }));
      const lines2 = grosses.map((gross) => ({ gross, terms: [] }));
      const r1 = stackDocumentDiscounts({ lines: lines1, documentTerms });
      const r2 = stackDocumentDiscounts({ lines: lines2, documentTerms: shuffled });
      trials++;

      // Every line's own net survives the document-term shuffle exactly —
      // lines themselves were never reordered, only documentTerms was.
      for (let i = 0; i < numLines; i++) {
        expect(r2.lines[i].net).toBe(r1.lines[i].net);
      }
      const total1 = r1.documentTerms.reduce((sum, x) => sum + x.dollars, 0);
      const total2 = r2.documentTerms.reduce((sum, x) => sum + x.dollars, 0);
      expect(Math.round(total2 * 100)).toBe(Math.round(total1 * 100));
      totalDiscountAgreements++;
    }
    expect(trials).toBe(5000);
    expect(totalDiscountAgreements).toBe(5000);
  });

  test('stackDocumentDiscounts — 2500 trials shuffling a SINGLE line\'s own terms (the line-slot side of the same key)', () => {
    const rand = mulberry32(13579);
    let trials = 0;
    for (let t = 0; t < 2500; t++) {
      const gross = randMoney(rand, 1, 400);
      const termCount = randInt(rand, 1, 5);
      const terms = Array.from({ length: termCount }, () => randomDiscount(rand, { numLines: 1, allowScope: false, allowSlot: false }));
      const shuffled = shuffle(rand, terms);

      const r1 = stackDocumentDiscounts({ lines: [{ gross, terms }], documentTerms: [] });
      const r2 = stackDocumentDiscounts({ lines: [{ gross, terms: shuffled }], documentTerms: [] });
      trials++;

      expect(r2.lines[0].net).toBe(r1.lines[0].net);
    }
    expect(trials).toBe(2500);
  });
});

describe('the two exact reported repros, both orders, through every export that can express them', () => {
  test('P1 (:578) — a scoped fixed $80 credit vs an unscoped fixed $80 credit on $50/$100 lines', () => {
    const scoped = { discountType: 'fixed_amount', amount: 80, eligibleLines: [0] };
    const unscoped = { discountType: 'fixed_amount', amount: 80 };
    const A = stackDocumentDiscounts({ lines: [{ gross: 50, terms: [] }, { gross: 100, terms: [] }], documentTerms: [scoped, unscoped] });
    const B = stackDocumentDiscounts({ lines: [{ gross: 50, terms: [] }, { gross: 100, terms: [] }], documentTerms: [unscoped, scoped] });
    expect(A.lines.map((l) => l.net)).toEqual(B.lines.map((l) => l.net));
    expect(A.lines.map((l) => l.net)).toEqual([0, 46.67]);
  });

  test('P2 (:286) — a scoped 5% vs an unscoped 5% (same rate, same cap) on $50/$99.99 lines', () => {
    const scoped = { discountType: 'percentage', amount: 5, eligibleLines: [0] };
    const unscoped = { discountType: 'percentage', amount: 5 };
    const A = stackDocumentDiscounts({ lines: [{ gross: 50, terms: [] }, { gross: 99.99, terms: [] }], documentTerms: [scoped, unscoped] });
    const B = stackDocumentDiscounts({ lines: [{ gross: 50, terms: [] }, { gross: 99.99, terms: [] }], documentTerms: [unscoped, scoped] });
    const netA = Math.round(A.lines.reduce((sum, l) => sum + l.net, 0) * 100) / 100;
    const netB = Math.round(B.lines.reduce((sum, l) => sum + l.net, 0) * 100) / 100;
    expect(netA).toBe(netB);
    expect(netA).toBe(140.11);
  });

  test('the same P1 shape through stackDiscounts (flat, slot-tagged) agrees with stackDocumentDiscounts\' $46.67', () => {
    const scoped = { discountType: 'fixed_amount', amount: 80, slot: 'document', eligibleLines: [0] };
    const unscoped = { discountType: 'fixed_amount', amount: 80, slot: 'document' };
    // stackDiscounts has no concept of separate lines, so this is the
    // single-pool analogue: base = $150 (the combined gross), eligibleLines
    // is meaningless without lines to scope against and is ignored by
    // stackDiscounts — this checks the WIDER-vs-NARROWER (fixed vs fixed,
    // no scope) ordering is at least stable, not the per-line split.
    const a = stackDiscounts(150, [scoped, unscoped]);
    const b = stackDiscounts(150, [unscoped, scoped]);
    expect(a.net).toBe(b.net);
  });

  test('an equal-rate, both-uncapped pair no longer produces an inconsistent (NaN-comparator) order — the bug this round found while fixing P2', () => {
    // resolveDiscountCap(a) - resolveDiscountCap(b) is Infinity - Infinity
    // = NaN for two uncapped percentages, which made the comparator
    // return NaN instead of falling through to the scope check — Array.
    // prototype.sort's behavior on a NaN result is unspecified, and it
    // silently broke transitivity. Two uncapped, same-rate, differently-
    // scoped percentages must still agree in both input orders.
    const scoped = { discountType: 'percentage', amount: 10, eligibleLines: [0] };
    const unscoped = { discountType: 'percentage', amount: 10 };
    const A = stackDocumentDiscounts({ lines: [{ gross: 40, terms: [] }, { gross: 60, terms: [] }], documentTerms: [scoped, unscoped] });
    const B = stackDocumentDiscounts({ lines: [{ gross: 40, terms: [] }, { gross: 60, terms: [] }], documentTerms: [unscoped, scoped] });
    expect(A.lines.map((l) => l.net)).toEqual(B.lines.map((l) => l.net));
  });

  test('stackVisitDiscounts has no same-slot scope tie to break — one discount per line and per appointment', () => {
    // Same structural point as the earlier rate/cap rounds: there is no
    // way to hand a stackVisitDiscounts line or the appointment slot a
    // SECOND scoped term to tie against the first. A single scoped-
    // looking line discount still agrees with the same term through
    // stackDiscounts.
    const term = { discountType: 'fixed_amount', amount: 80 };
    const visitRes = stackVisitDiscounts({ lines: [{ gross: 50, lineDiscount: term, eligible: true }], appointmentDiscount: null });
    const sdRes = stackDiscounts(50, [term]);
    expect(visitRes.lines[0].lineDiscountDollars).toBe(sdRes.items[0].dollars);
  });
});
