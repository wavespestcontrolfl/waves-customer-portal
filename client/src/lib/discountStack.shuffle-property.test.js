/**
 * Client mirror of server/tests/discount-stack-canonical-order-property.test.js
 * (see that file's header for the full history of Codex rounds this closes —
 * a canonicalizer that only sorts by SOME of a discount's attributes still
 * lets the attributes it ignores make the total order-dependent). Same
 * generator technique, same per-id assertion tool, fewer trials — the client
 * suite runs on every save/commit and doesn't need the server file's full
 * 15,000-trial sweep to catch a real regression in the client's own
 * stackOrder/normalize port.
 */
import { describe, expect, test } from 'vitest';
import { stackDiscounts, stackDocumentDiscounts, stackVisitDiscounts } from './discountStack';

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
// 80% carry a unique id (per-id dollar stability under a shuffle is only a
// meaningful claim for identified terms); 20% are anonymous, exercising the
// identified-before-anonymous tiebreak.
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

describe('property: shuffling term order never changes the total, any per-line net, or any per-id dollar figure (client mirror)', () => {
  test('stackDiscounts — 2000 random flat stacks', () => {
    const rand = mulberry32(20260921);
    for (let t = 0; t < 2000; t++) {
      const base = randMoney(rand, 1, 500);
      const count = randInt(rand, 1, 6);
      const terms = Array.from({ length: count }, () => randomDiscount(rand, { allowScope: false, allowSlot: true }));
      const shuffled = shuffle(rand, terms);

      const r1 = stackDiscounts(base, terms);
      const r2 = stackDiscounts(base, shuffled);

      expect(r2.net).toBe(r1.net);
      expect(r2.totalDollars).toBe(r1.totalDollars);
      expectSameDollarsById(byId(r1.items, terms), byId(r2.items, shuffled));
    }
  });

  test('stackDocumentDiscounts — 2000 random multi-line documents, lines carrying their own terms AND document terms', () => {
    const rand = mulberry32(45678901);
    for (let t = 0; t < 2000; t++) {
      const numLines = randInt(rand, 1, 4);
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

      for (let i = 0; i < numLines; i++) {
        expect(r2.lines[i].net).toBe(r1.lines[i].net);
      }
      expectSameDollarsById(byId(r1.documentTerms, documentTerms), byId(r2.documentTerms, shuffledDocTerms));
    }
  });

  test('stackVisitDiscounts — 1000 random trials shuffling which slot (line vs appointment) carries the fixed credit', () => {
    const rand = mulberry32(13579);
    for (let t = 0; t < 1000; t++) {
      const numLines = randInt(rand, 1, 4);
      const lines = Array.from({ length: numLines }, () => ({
        gross: randMoney(rand, 1, 300),
        lineDiscount: rand() < 0.6 ? randomDiscount(rand, { allowScope: false, allowSlot: false }) : null,
        eligible: rand() < 0.85,
      }));
      const appointmentDiscount = rand() < 0.7 ? randomDiscount(rand, { allowScope: false, allowSlot: false }) : null;

      // Shuffling here means: run the SAME set of lines/appointment discount
      // twice, once through the normal call and once with the lines array
      // itself reordered — the visit model's per-line results must follow
      // their own line, not their array position.
      const shuffledOrder = shuffle(rand, lines.map((_, i) => i));
      const shuffledLines = shuffledOrder.map((i) => lines[i]);

      const r1 = stackVisitDiscounts({ lines, appointmentDiscount });
      const r2 = stackVisitDiscounts({ lines: shuffledLines, appointmentDiscount });

      expect(r2.total).toBe(r1.total);
      expect(r2.appointmentDiscountDollars).toBe(r1.appointmentDiscountDollars);
      shuffledOrder.forEach((originalIdx, newIdx) => {
        expect(r2.lines[newIdx]).toEqual(r1.lines[originalIdx]);
      });
    }
  });
});
