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
 * ROUND 7 — two more instances of the SAME class, which is why the
 * property test below was widened rather than given a fourth one-off
 * "exact repro" test:
 *
 * P1 (:560): the fixed-credit pass split fixed credits into "every
 * line's own fixed term first, unconditionally" THEN "document fixed
 * terms, in canonical order" — a line-first split that bypassed the
 * header's own "fixed dollar credits, any slot, first" rule whenever a
 * document credit was WIDER than a line's own credit. Fixed in
 * stackVisitDiscounts and stackDocumentDiscounts alike by merging line-
 * scope and document-scope fixed credits into ONE canonically-ordered
 * pass, each line's own fixed term tagged with a synthetic single-line
 * scope purely so the SAME scope comparator governs both.
 *
 * P2 (:382): two distinct catalog discounts tied on slot/kind/value/cap/
 * scope fell back to input position, so DiscountEngine's own per-
 * discount bookkeeping (usage totals rolled up by id) could attribute a
 * different dollar figure to the same discount id depending on picker
 * order. Fixed with an IDENTITY tiebreak (id / discount_key) that runs
 * before index — a term with no identity at all still falls through to
 * index, unchanged from before this round.
 *
 * Both are fixed by the module's now-COMPLETE canonical key (see the
 * header's CANONICAL ORDER section): slot, kind, value, cap, scope,
 * IDENTITY, index — applied uniformly by stackOrder and by every fixed/
 * non-fixed pass in stackVisitDiscounts and stackDocumentDiscounts
 * alike. The property test below is what actually closes the class:
 * every generated term now carries a unique id (so per-term dollar
 * stability under a shuffle is a meaningful, checkable claim rather than
 * "ties may legitimately swap credit," which round 3's version of this
 * file had to concede for anonymous terms), and lines now carry their
 * OWN random fixed/percent terms alongside document terms — round 3's
 * generator never mixed the two, which is exactly why P1 (:560) shipped
 * undetected for two more rounds after the class was first "closed."
 *
 * ROUND 8 — one more instance, found in the IDENTITY step itself rather
 * than a missing attribute:
 *
 * P2 (:339): compareDiscountIdentity returned 0 (a tie) whenever EITHER
 * side lacked an identity — not just when BOTH did. That is not a valid
 * comparator: mixing a catalog-backed term with a legacy/constructed one
 * carrying neither id nor discount_key made anonymous-vs-identified pairs
 * intransitive, so a stack of three tied terms (identified b, anonymous,
 * identified a) let b end up credited $10 or $9, and a $8.10 or $10,
 * purely from shuffling the SAME three terms — index-based tiebreaking
 * has no fixed point to anchor the anonymous term against when its
 * comparisons against BOTH identified terms return 0. Fixed by giving
 * missing identities a deterministic position: every identified term
 * sorts before every anonymous term (arbitrary, but fixed and stated
 * once), identified terms among themselves by identity string, anonymous
 * terms among themselves left tied (falling through to index, same as
 * before this round) since two anonymous terms have no comparator-visible
 * way to distinguish them at all. The property test generator now makes
 * 20% of terms anonymous (no id) specifically so the shuffle invariant
 * exercises this mixed case at scale, not just the one hand-written repro.
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

let nextId = 0;
// One random discount, any kind. 80% carry a unique id (round 7 — this is
// what makes per-term dollar stability under a shuffle a meaningful,
// always-checkable property instead of one that ties make impossible to
// guarantee in general); 20% are ANONYMOUS — no id, no discount_key — a
// legacy/constructed term the round-8 fix specifically targets: mixing
// identified and anonymous terms in one tied stack used to make the
// comparator non-transitive (see the top comment).
function randomDiscount(rand, { allowScope, allowSlot, numLines }) {
  const kindRoll = rand();
  const discountType = kindRoll < 0.45 ? 'percentage' : kindRoll < 0.85 ? 'fixed_amount' : 'free_service';
  const discount = { discountType };
  if (rand() < 0.8) discount.id = `term-${nextId++}`;
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

// Maps a result's items/documentTerms array (parallel to the INPUT array
// it came from) back to a Map keyed by each term's own id — the per-term
// assertion tool every property test below uses instead of comparing by
// array position, which a shuffle deliberately scrambles. Anonymous terms
// (no id) are deliberately left OUT of this map: two anonymous terms that
// also tie on kind/value/cap/scope have no comparator-visible way to tell
// them apart at all (identity is a tiebreak, not a magic distinguisher for
// terms that never carried one), so which one a shuffle credits can
// legitimately swap — the round-8 fix guarantees a DETERMINISTIC position
// for the anonymous GROUP relative to identified terms, not a stable
// identity for each anonymous term individually. Every IDENTIFIED term's
// own dollars must still be stable regardless of how many anonymous terms
// are mixed in, which is exactly what this filtered map checks.
function byId(resultItems, inputTerms) {
  const map = new Map();
  inputTerms.forEach((term, i) => {
    if (term.id !== undefined) map.set(term.id, resultItems[i].dollars);
  });
  return map;
}

function expectSameDollarsById(map1, map2) {
  expect(map1.size).toBe(map2.size);
  for (const [id, dollars] of map1) {
    expect(map2.get(id)).toBe(dollars);
  }
}

describe('property: shuffling term order never changes the total, any per-line net, or any per-id dollar figure', () => {
  test('stackDiscounts — 5000 random flat stacks, terms across kinds/values/caps/(flat) slots', () => {
    const rand = mulberry32(20260916);
    let trials = 0;
    for (let t = 0; t < 5000; t++) {
      const base = randMoney(rand, 1, 500);
      const count = randInt(rand, 1, 6);
      const terms = Array.from({ length: count }, () => randomDiscount(rand, { allowScope: false, allowSlot: true }));
      const shuffled = shuffle(rand, terms);

      const r1 = stackDiscounts(base, terms);
      const r2 = stackDiscounts(base, shuffled);
      trials++;

      expect(r2.net).toBe(r1.net);
      expect(r2.totalDollars).toBe(r1.totalDollars);
      // Every term carries a unique id now (round 7): per-id dollars must
      // survive the shuffle exactly, not just the aggregate.
      expectSameDollarsById(byId(r1.items, terms), byId(r2.items, shuffled));
    }
    expect(trials).toBe(5000);
  });

  test('stackDocumentDiscounts — 5000 random multi-line stacks, LINES carrying their own terms AND document terms across kinds/values/caps/scopes (round 7: the generator that would have caught :560)', () => {
    const rand = mulberry32(45678901);
    let trials = 0;
    for (let t = 0; t < 5000; t++) {
      const numLines = randInt(rand, 1, 4);
      // Round 7: each line gets a 50% chance of carrying 1-2 of its OWN
      // terms (any kind, including fixed) — round 3's generator always
      // used terms:[], which is exactly why a line-fixed-vs-document-
      // fixed ordering bug (:560) shipped undetected through two more
      // rounds after this file first claimed to "close the class."
      const lineTermSets = Array.from({ length: numLines }, () => (
        rand() < 0.5
          ? Array.from({ length: randInt(rand, 1, 2) }, () => randomDiscount(rand, { allowScope: false, allowSlot: false }))
          : []
      ));
      const grosses = Array.from({ length: numLines }, () => randMoney(rand, 1, 300));
      const termCount = randInt(rand, 0, 5);
      const documentTerms = Array.from({ length: termCount }, () => randomDiscount(rand, { allowScope: true, allowSlot: false, numLines }));
      const shuffledDocTerms = shuffle(rand, documentTerms);

      const buildLines = (termSets) => grosses.map((gross, i) => ({ gross, terms: termSets[i].slice() }));
      const r1 = stackDocumentDiscounts({ lines: buildLines(lineTermSets), documentTerms });
      const r2 = stackDocumentDiscounts({ lines: buildLines(lineTermSets), documentTerms: shuffledDocTerms });
      trials++;

      // Every line's own net survives the document-term shuffle exactly —
      // lines' own terms were never reordered, only documentTerms was.
      for (let i = 0; i < numLines; i++) {
        expect(r2.lines[i].net).toBe(r1.lines[i].net);
      }
      // Every document term's own dollars survive by id too, not just the
      // per-line net aggregate.
      expectSameDollarsById(byId(r1.documentTerms, documentTerms), byId(r2.documentTerms, shuffledDocTerms));
      // And every LINE term's own dollars, read off termDollars by the
      // same id-tracking technique (each line's terms weren't shuffled,
      // but a wider document term running before or after them, per
      // canonical order, must still leave the SAME per-term result).
      for (let i = 0; i < numLines; i++) {
        expectSameDollarsById(byId(r1.lines[i].termDollars.map((dollars) => ({ dollars })), lineTermSets[i]), byId(r2.lines[i].termDollars.map((dollars) => ({ dollars })), lineTermSets[i]));
      }
    }
    expect(trials).toBe(5000);
  });

  test('stackDocumentDiscounts — 2500 trials shuffling a SINGLE line\'s own terms (the line-slot side of the same key)', () => {
    const rand = mulberry32(13579);
    let trials = 0;
    for (let t = 0; t < 2500; t++) {
      const gross = randMoney(rand, 1, 400);
      const termCount = randInt(rand, 1, 5);
      const terms = Array.from({ length: termCount }, () => randomDiscount(rand, { allowScope: false, allowSlot: false }));
      const shuffled = shuffle(rand, terms);

      const r1 = stackDocumentDiscounts({ lines: [{ gross, terms }], documentTerms: [] });
      const r2 = stackDocumentDiscounts({ lines: [{ gross, terms: shuffled }], documentTerms: [] });
      trials++;

      expect(r2.lines[0].net).toBe(r1.lines[0].net);
      expectSameDollarsById(
        byId(r1.lines[0].termDollars.map((dollars) => ({ dollars })), terms),
        byId(r2.lines[0].termDollars.map((dollars) => ({ dollars })), shuffled),
      );
    }
    expect(trials).toBe(2500);
  });

  test('stackVisitDiscounts — 2500 random trials shuffling which slot (line vs appointment) carries the fixed credit (round 7: the generator that would have caught the stackVisitDiscounts side of :560)', () => {
    const rand = mulberry32(24681012);
    let trials = 0;
    for (let t = 0; t < 2500; t++) {
      const numLines = randInt(rand, 1, 3);
      const grosses = Array.from({ length: numLines }, () => randMoney(rand, 1, 300));
      // Randomly assign each line either its own fixed credit or none,
      // and independently decide whether an appointment fixed credit
      // exists — every arrangement is a valid input regardless of how
      // many fixed credits end up in which slot.
      const lineDiscounts = grosses.map(() => (rand() < 0.5 ? { discountType: 'fixed_amount', amount: randMoney(rand, 1, 150) } : null));
      const appt = rand() < 0.6 ? { discountType: 'fixed_amount', amount: randMoney(rand, 1, 150) } : null;

      const buildLines = () => grosses.map((gross, i) => ({ gross, lineDiscount: lineDiscounts[i], eligible: true }));
      // "Shuffle" here means: run it once, then run an independent method
      // (stackDocumentDiscounts, treating each line credit as a LINE term
      // and the appointment credit as an unscoped DOCUMENT term) on the
      // mathematically equivalent input, and require the two exports
      // agree — the cross-export check IS the shuffle-equivalent property
      // for a model that has only one slot per line, so there's no
      // literal array to reorder.
      const visitRes = stackVisitDiscounts({ lines: buildLines(), appointmentDiscount: appt });
      const docLines = grosses.map((gross, i) => ({ gross, terms: lineDiscounts[i] ? [lineDiscounts[i]] : [] }));
      const docTerms = appt ? [appt] : [];
      const docRes = stackDocumentDiscounts({ lines: docLines, documentTerms: docTerms });
      trials++;

      const visitTotal = Math.round(visitRes.total * 100);
      const docTotal = Math.round(docRes.lines.reduce((sum, l) => sum + l.net, 0) * 100);
      expect(visitTotal).toBe(docTotal);
    }
    expect(trials).toBe(2500);
  });
});

describe('the exact reported repros, both orders and both slot assignments, through every export that can express them', () => {
  test('P1 (:578, round 5) — a scoped fixed $80 credit vs an unscoped fixed $80 credit on $50/$100 lines', () => {
    const scoped = { discountType: 'fixed_amount', amount: 80, eligibleLines: [0] };
    const unscoped = { discountType: 'fixed_amount', amount: 80 };
    const A = stackDocumentDiscounts({ lines: [{ gross: 50, terms: [] }, { gross: 100, terms: [] }], documentTerms: [scoped, unscoped] });
    const B = stackDocumentDiscounts({ lines: [{ gross: 50, terms: [] }, { gross: 100, terms: [] }], documentTerms: [unscoped, scoped] });
    expect(A.lines.map((l) => l.net)).toEqual(B.lines.map((l) => l.net));
    expect(A.lines.map((l) => l.net)).toEqual([0, 46.67]);
  });

  test('P1 (:560, round 7) — a LINE-scope $80 credit vs a DOCUMENT-scope $80 credit on $50/$100 lines, through stackDocumentDiscounts', () => {
    const lineFixed = { discountType: 'fixed_amount', amount: 80 };
    const docFixed = { discountType: 'fixed_amount', amount: 80 };
    // Slot assignment 1: the $80 on line 0 is the LINE's own term, the
    // other $80 is a DOCUMENT term reaching both lines.
    const res1 = stackDocumentDiscounts({
      lines: [{ gross: 50, terms: [lineFixed] }, { gross: 100, terms: [] }],
      documentTerms: [docFixed],
    });
    expect(res1.lines.map((l) => l.net)).toEqual([0, 46.67]);

    // Slot assignment 2 (swapped): now line 1 carries its own $80 and the
    // document term still reaches both — same total shape, mirrored line.
    const res2 = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [] }, { gross: 50, terms: [docFixed] }],
      documentTerms: [lineFixed],
    });
    expect(res2.lines.map((l) => l.net)).toEqual([46.67, 0]);
  });

  test('P1 (:560, round 7) — the same shape through stackVisitDiscounts: a line fixed credit vs an appointment fixed credit', () => {
    const res = stackVisitDiscounts({
      lines: [
        { gross: 50, lineDiscount: { discountType: 'fixed_amount', amount: 80 }, eligible: true },
        { gross: 100, lineDiscount: null, eligible: true },
      ],
      appointmentDiscount: { discountType: 'fixed_amount', amount: 80 },
    });
    expect(res.total).toBe(46.67);

    // Mirror: the SAME two (gross, discount) pairs, just on the other
    // line — the appointment credit (wider, reaching both lines) still
    // runs first regardless of which physical line index holds the
    // narrower line credit, so the total is unchanged by the mirror.
    // (Swapping ONLY the discount without its gross would NOT be a valid
    // mirror here — the two lines carry different gross amounts, so that
    // would change which balance the credit competes for; this keeps
    // each gross paired with its own discount and just relabels the
    // lines.)
    const mirrored = stackVisitDiscounts({
      lines: [
        { gross: 100, lineDiscount: null, eligible: true },
        { gross: 50, lineDiscount: { discountType: 'fixed_amount', amount: 80 }, eligible: true },
      ],
      appointmentDiscount: { discountType: 'fixed_amount', amount: 80 },
    });
    expect(mirrored.total).toBe(46.67);
  });

  test('P2 (:286, round 5) — a scoped 5% vs an unscoped 5% (same rate, same cap) on $50/$99.99 lines', () => {
    const scoped = { discountType: 'percentage', amount: 5, eligibleLines: [0] };
    const unscoped = { discountType: 'percentage', amount: 5 };
    const A = stackDocumentDiscounts({ lines: [{ gross: 50, terms: [] }, { gross: 99.99, terms: [] }], documentTerms: [scoped, unscoped] });
    const B = stackDocumentDiscounts({ lines: [{ gross: 50, terms: [] }, { gross: 99.99, terms: [] }], documentTerms: [unscoped, scoped] });
    const netA = Math.round(A.lines.reduce((sum, l) => sum + l.net, 0) * 100) / 100;
    const netB = Math.round(B.lines.reduce((sum, l) => sum + l.net, 0) * 100) / 100;
    expect(netA).toBe(netB);
    expect(netA).toBe(140.11);
  });

  test('P2 (:382, round 7) — two DISTINCT catalog discounts, identical in rate/cap/scope, keep their per-id dollars under reversal', () => {
    const discountA = { id: 'discount-A', discountType: 'percentage', amount: 10 };
    const discountB = { id: 'discount-B', discountType: 'percentage', amount: 10 };

    // Through stackDiscounts directly.
    const flatForward = stackDiscounts(100, [discountA, discountB]);
    const flatReversed = stackDiscounts(100, [discountB, discountA]);
    expect(flatForward.items[0].dollars).toBe(flatReversed.items[1].dollars); // A's own figure, either position
    expect(flatForward.items[1].dollars).toBe(flatReversed.items[0].dollars); // B's own figure, either position

    // Through stackDocumentDiscounts as document terms.
    const docForward = stackDocumentDiscounts({ lines: [{ gross: 100, terms: [] }], documentTerms: [discountA, discountB] });
    const docReversed = stackDocumentDiscounts({ lines: [{ gross: 100, terms: [] }], documentTerms: [discountB, discountA] });
    expect(docForward.documentTerms[0].dollars).toBe(docReversed.documentTerms[1].dollars);
    expect(docForward.documentTerms[1].dollars).toBe(docReversed.documentTerms[0].dollars);
  });

  test('P2 (:339, round 8) — the exact reported mixed case: identified b, an ANONYMOUS term, and identified a, all tied at 10% on $100', () => {
    // Before round 8, compareDiscountIdentity returned 0 whenever EITHER
    // side lacked an identity, which is not a valid comparator: it made
    // anonymous-vs-identified pairs intransitive, so shuffling the SAME
    // three terms let identified b end up crediting $10 or $9, and
    // identified a $8.10 or $10, purely from which pairwise comparisons
    // the sort happened to run. The fix gives every identified term a
    // fixed position ahead of every anonymous term, so both orders below
    // — and every other permutation of the same three terms — land on
    // the identical canonical sequence: a ($10, identified, alphabetically
    // first) → b ($9, identified, second) → the anonymous term ($8.10,
    // last, since it has no identity to place it ahead of either).
    const identifiedA = { id: 'a', discountType: 'percentage', amount: 10 };
    const identifiedB = { id: 'b', discountType: 'percentage', amount: 10 };
    const anonymous = { discountType: 'percentage', amount: 10 };

    const orderOne = stackDiscounts(100, [identifiedB, anonymous, identifiedA]);
    const orderTwo = stackDiscounts(100, [anonymous, identifiedA, identifiedB]);

    expect(orderOne.items.map((i) => i.dollars)).toEqual([9, 8.1, 10]); // [b, anonymous, a]
    expect(orderTwo.items.map((i) => i.dollars)).toEqual([8.1, 10, 9]); // [anonymous, a, b]

    // Same claim, read back per-identity rather than per-array-position:
    // b is always $9 and a is always $10, regardless of where the
    // anonymous term sits or which order the caller used.
    expect(orderOne.items[0].dollars).toBe(orderTwo.items[2].dollars); // b
    expect(orderOne.items[2].dollars).toBe(orderTwo.items[1].dollars); // a
  });

  test('the same P1 (:578) shape through stackDiscounts (flat, slot-tagged) agrees with stackDocumentDiscounts\' $46.67', () => {
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

  test('an equal-rate, both-uncapped pair no longer produces an inconsistent (NaN-comparator) order — the bug round 5 found while fixing P2', () => {
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
});
