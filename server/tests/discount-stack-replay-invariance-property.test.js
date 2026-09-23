/**
 * Coordinator scope extension (round 3): the shuffle-invariance property
 * tests (discount-stack-canonical-order-property.test.js) prove the
 * canonical order is a stable TOTAL ORDER for a FRESH set of terms — but
 * they never modeled what happens when a term gets SAVED, then REPLAYS
 * on a later edit. A frozen term's discountType/amount always collapse
 * to a flat {fixed_amount, <its own clamped dollars>} for RESOLUTION
 * (every "stored" branch across every caller), which used to ALSO decide
 * its canonical-order RANK/VALUE/CAP — so a term that got clamped on its
 * first save could silently reorder against an unrelated sibling on a
 * later, otherwise-unchanged resubmit, changing the invoice's total.
 *
 * Pre-push audit P0 (two rounds, both reproduced as dedicated tests
 * below): a $90 line credit clamped to $50 on a $50 line, competing
 * against an $80 document credit, totaled $20 fresh and $46.67 replayed
 * — the frozen $50 sorted AFTER the $80 (by clamped dollars) when the
 * original $90 rate had sorted BEFORE it. A 50%-of-remainder document
 * credit, once frozen into a flat $50 fixed replay, jumped from the
 * percent pass into the fixed pass entirely, running before a line
 * credit it never competed with when fresh.
 *
 * The fix: sortKind/sortValue/sortCap (see resolveSortKind/Value/Cap's
 * own comments in discount-stack.js) — a term's canonical-order identity,
 * captured once at its FIRST resolution and carried forward unchanged on
 * every later "freeze" this file's helper below performs, mirroring
 * exactly what server/services/invoice.js does by persisting
 * stack_sort_kind/_value/_cap onto the saved line item.
 *
 * This file's property: for ANY random fixture, freezing every term at
 * its OWN first-resolve sort key and dollars, then replaying, produces
 * BYTE-IDENTICAL per-term dollars and per-line nets to the fresh
 * resolve — not just "the same total," which a swapped allocation could
 * still satisfy. A second freeze-and-replay cycle (freezing the REPLAY's
 * own output) must also match — genuine idempotence, not a one-step
 * coincidence.
 */
const {
  stackDiscounts,
  stackDocumentDiscounts,
  stackVisitDiscounts,
} = require('../services/discount-stack');

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

let nextId = 0;
// Deliberately biased toward SMALL line gross / LARGE discount amounts
// relative to the canonical-order property test's own generator — the
// property under test here only matters when a term actually gets
// CLAMPED on its first resolve (an unclamped fixed term's sortValue
// equals its frozen dollars anyway, so replay stability would be trivial
// for it), so this generator forces that far more often.
function randomDiscount(rand, { allowScope, allowSlot, numLines }) {
  const kindRoll = rand();
  const discountType = kindRoll < 0.45 ? 'percentage' : kindRoll < 0.85 ? 'fixed_amount' : 'free_service';
  const discount = { discountType };
  if (rand() < 0.8) discount.id = `term-${nextId++}`;
  if (discountType === 'percentage') {
    discount.amount = randInt(rand, 1, 90);
    if (rand() < 0.4) discount.maxDiscountDollars = randMoney(rand, 1, 80);
  } else if (discountType === 'fixed_amount') {
    // Skewed high relative to the ~$10-60 line gross below, so a real
    // fraction of fixed terms clamp on their first resolve.
    discount.amount = randMoney(rand, 1, 120);
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

// The freeze step every caller (invoice.js, this round) performs: a
// term's ORIGINAL sort key rides forward as sortKind/sortValue/sortCap,
// while discountType/amount collapse to the flat {fixed_amount, <its own
// resolved dollars>} shape RESOLUTION always uses for a stored term.
// eligibleLines/slot/id are untouched — none of those change across a
// freeze in any real caller either.
//
// CRITICAL: the sort key is captured ONLY THE FIRST TIME a term freezes
// (`term.sortKind ?? term.discountType` — an already-frozen term carries
// its OWN sortKind forward unchanged, never re-derived from its now-
// collapsed discountType/amount). This mirrors invoice.js exactly:
// lineItemDiscountTerm stamps stack_sort_kind/_value/_cap onto an item
// ONLY on its first fresh resolve; every later resolve reads that SAME
// persisted value via frozenSortKeyFields, never re-stamping it. A test
// helper that re-derived the sort key from the CURRENT (already-frozen)
// term on a second freeze would defeat the entire property under test —
// re-deriving from a term whose discountType/amount are already the
// flat replay shape reintroduces exactly the instability this round
// fixes, in the test double rather than the production code.
function freezeTerm(term, dollars) {
  const frozen = {
    discountType: 'fixed_amount',
    amount: dollars,
    sortKind: term.sortKind ?? term.discountType,
    sortValue: term.sortValue ?? term.amount,
    sortCap: term.sortKind !== undefined ? term.sortCap : term.maxDiscountDollars,
  };
  if (Array.isArray(term.eligibleLines)) frozen.eligibleLines = term.eligibleLines;
  if (term.id !== undefined) frozen.id = term.id;
  if (term.slot) frozen.slot = term.slot;
  return frozen;
}

describe('property: freezing every term at its first-resolve sort key, then replaying, is idempotent', () => {
  test('stackDiscounts — 2000 random flat stacks, freeze-then-replay reproduces the fresh result exactly', () => {
    const rand = mulberry32(20260923);
    let trials = 0;
    for (let t = 0; t < 2000; t++) {
      const base = randMoney(rand, 10, 60);
      const count = randInt(rand, 1, 5);
      const terms = Array.from({ length: count }, () => randomDiscount(rand, { allowScope: false, allowSlot: false }));

      const fresh = stackDiscounts(base, terms);
      const frozen = terms.map((term, i) => freezeTerm(term, fresh.items[i].dollars));
      const replay = stackDiscounts(base, frozen);
      trials++;

      expect(replay.net).toBe(fresh.net);
      expect(replay.totalDollars).toBe(fresh.totalDollars);
      expect(replay.items.map((it) => it.dollars)).toEqual(fresh.items.map((it) => it.dollars));

      // A SECOND freeze/replay cycle (freezing the replay's own output)
      // must land on the identical fixed point — genuine idempotence.
      const frozenAgain = frozen.map((term, i) => freezeTerm(term, replay.items[i].dollars));
      const replayAgain = stackDiscounts(base, frozenAgain);
      expect(replayAgain.items.map((it) => it.dollars)).toEqual(fresh.items.map((it) => it.dollars));
    }
    expect(trials).toBe(2000);
  });

  test('stackDocumentDiscounts — 5000 random multi-line stacks (lines with their own terms, plus document terms across kinds/values/caps/scopes) — the invoice.js shape this round exists to fix', () => {
    const rand = mulberry32(918273645);
    let trials = 0;
    for (let t = 0; t < 5000; t++) {
      const numLines = randInt(rand, 1, 4);
      const lines = Array.from({ length: numLines }, () => {
        const gross = randMoney(rand, 10, 60);
        const termCount = rand() < 0.5 ? randInt(rand, 1, 2) : 0;
        const terms = Array.from({ length: termCount }, () => randomDiscount(rand, { allowScope: false, allowSlot: false, numLines }));
        return { gross, terms };
      });
      const docCount = randInt(rand, 0, 3);
      const documentTerms = Array.from({ length: docCount }, () => randomDiscount(rand, { allowScope: true, allowSlot: false, numLines }));

      const fresh = stackDocumentDiscounts({ lines, documentTerms });

      const frozenLines = lines.map((line, li) => ({
        gross: line.gross,
        terms: line.terms.map((term, ti) => freezeTerm(term, fresh.lines[li].termDollars[ti])),
      }));
      const frozenDocTerms = documentTerms.map((term, i) => freezeTerm(term, fresh.documentTerms[i].dollars));

      const replay = stackDocumentDiscounts({ lines: frozenLines, documentTerms: frozenDocTerms });
      trials++;

      expect(replay.lines.map((l) => l.net)).toEqual(fresh.lines.map((l) => l.net));
      expect(replay.lines.map((l) => l.termDollars)).toEqual(fresh.lines.map((l) => l.termDollars));
      expect(replay.documentTerms).toEqual(fresh.documentTerms);

      // Second cycle — idempotence, not a one-step coincidence.
      const frozenAgainLines = frozenLines.map((line, li) => ({
        gross: line.gross,
        terms: line.terms.map((term, ti) => freezeTerm(term, replay.lines[li].termDollars[ti])),
      }));
      const frozenAgainDocTerms = frozenDocTerms.map((term, i) => freezeTerm(term, replay.documentTerms[i].dollars));
      const replayAgain = stackDocumentDiscounts({ lines: frozenAgainLines, documentTerms: frozenAgainDocTerms });
      expect(replayAgain.lines.map((l) => l.termDollars)).toEqual(fresh.lines.map((l) => l.termDollars));
      expect(replayAgain.documentTerms).toEqual(fresh.documentTerms);
    }
    expect(trials).toBe(5000);
  });

  test('stackVisitDiscounts — 2000 random line+appointment stacks, freeze-then-replay reproduces the fresh result exactly', () => {
    const rand = mulberry32(554433221);
    let trials = 0;
    for (let t = 0; t < 2000; t++) {
      const numLines = randInt(rand, 1, 3);
      const lines = Array.from({ length: numLines }, () => ({
        gross: randMoney(rand, 10, 60),
        lineDiscount: rand() < 0.7 ? randomDiscount(rand, { allowScope: false, allowSlot: false }) : null,
        eligible: rand() < 0.85,
      }));
      const appointmentDiscount = rand() < 0.7 ? randomDiscount(rand, { allowScope: false, allowSlot: false }) : null;

      const fresh = stackVisitDiscounts({ lines, appointmentDiscount, compound: true });

      const frozenLines = lines.map((line, li) => ({
        gross: line.gross,
        eligible: line.eligible,
        lineDiscount: line.lineDiscount ? freezeTerm(line.lineDiscount, fresh.lines[li].lineDiscountDollars) : null,
      }));
      const frozenAppt = appointmentDiscount ? freezeTerm(appointmentDiscount, fresh.appointmentDiscountDollars) : null;

      const replay = stackVisitDiscounts({ lines: frozenLines, appointmentDiscount: frozenAppt, compound: true });
      trials++;

      expect(replay.total).toBe(fresh.total);
      expect(replay.appointmentDiscountDollars).toBe(fresh.appointmentDiscountDollars);
      expect(replay.lines.map((l) => l.lineDiscountDollars)).toEqual(fresh.lines.map((l) => l.lineDiscountDollars));
      expect(replay.lines.map((l) => l.net)).toEqual(fresh.lines.map((l) => l.net));
    }
    expect(trials).toBe(2000);
  });
});

describe('the auditor\'s own reproductions, pinned directly against the engine', () => {
  test('round 3 P0: $50/$100 lines, a $90 line-1 credit (clamps to $50) plus an $80 document credit — fresh totals $20; frozen replay ALSO totals $20, never the $46.67 the pre-fix reorder gave', () => {
    const lineTerm = { discountType: 'fixed_amount', amount: 90, id: 'line-credit' };
    const docTerm = { discountType: 'fixed_amount', amount: 80, id: 'doc-credit' };
    const lines = [{ gross: 50, terms: [lineTerm] }, { gross: 100, terms: [] }];

    const fresh = stackDocumentDiscounts({ lines, documentTerms: [docTerm] });
    const freshNet = fresh.lines.reduce((sum, l) => sum + l.net, 0);
    expect(Math.round(freshNet * 100) / 100).toBe(20);

    const frozenLines = [
      { gross: 50, terms: [freezeTerm(lineTerm, fresh.lines[0].termDollars[0])] },
      { gross: 100, terms: [] },
    ];
    const frozenDocTerms = [freezeTerm(docTerm, fresh.documentTerms[0].dollars)];
    const replay = stackDocumentDiscounts({ lines: frozenLines, documentTerms: frozenDocTerms });
    const replayNet = replay.lines.reduce((sum, l) => sum + l.net, 0);
    expect(Math.round(replayNet * 100) / 100).toBe(20);
    expect(replayNet).not.toBeCloseTo(46.67, 2);
  });

  test('round 1 P0: a $50 credit on line 1 plus a 50% invoice-wide discount on $50/$100 lines — fresh totals $50; frozen replay ALSO totals $50, never the $66.67 a pass-reclassification would give', () => {
    const lineTerm = { discountType: 'fixed_amount', amount: 50, id: 'line-credit' };
    const docTerm = { discountType: 'percentage', amount: 50, id: 'doc-pct' };
    const lines = [{ gross: 50, terms: [lineTerm] }, { gross: 100, terms: [] }];

    const fresh = stackDocumentDiscounts({ lines, documentTerms: [docTerm] });
    const freshNet = fresh.lines.reduce((sum, l) => sum + l.net, 0);
    expect(Math.round(freshNet * 100) / 100).toBe(50);

    const frozenLines = [
      { gross: 50, terms: [freezeTerm(lineTerm, fresh.lines[0].termDollars[0])] },
      { gross: 100, terms: [] },
    ];
    const frozenDocTerms = [freezeTerm(docTerm, fresh.documentTerms[0].dollars)];
    const replay = stackDocumentDiscounts({ lines: frozenLines, documentTerms: frozenDocTerms });
    const replayNet = replay.lines.reduce((sum, l) => sum + l.net, 0);
    expect(Math.round(replayNet * 100) / 100).toBe(50);
    expect(replayNet).not.toBeCloseTo(66.67, 2);
  });
});
