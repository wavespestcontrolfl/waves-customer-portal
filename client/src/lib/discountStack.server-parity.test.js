/**
 * Slice 2 of the #4405 split (slice 1 = #4568, server engine). The client
 * mirror in ./discountStack.js is a hand port of
 * server/services/discount-stack.js's canonical-order arithmetic — this
 * test doesn't trust that port by inspection, it runs the SAME randomized
 * fixture set through both modules directly (the server module is required
 * straight from its source, not reimplemented here) and asserts identical
 * results down to the cent, for every discount kind, slot, cap, and scope
 * combination the engine supports.
 *
 * Deterministic, dependency-free PRNG (mulberry32), same technique as
 * server/tests/discount-stack-canonical-order-property.test.js — a failing
 * seed is reproducible without a fixture file.
 */
import { describe, expect, test } from 'vitest';
import serverStackModule from '../../../server/services/discount-stack.js';
import {
  stackDiscounts as clientStackDiscounts,
  stackVisitDiscounts as clientStackVisitDiscounts,
  stackDocumentDiscounts as clientStackDocumentDiscounts,
} from './discountStack';

const {
  stackDiscounts: serverStackDiscounts,
  stackVisitDiscounts: serverStackVisitDiscounts,
  stackDocumentDiscounts: serverStackDocumentDiscounts,
} = serverStackModule;

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

function randInt(rand, lo, hi) {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

function randMoney(rand, lo, hi) {
  return Math.round((rand() * (hi - lo) + lo) * 100) / 100;
}

let nextId = 0;
// Both engines take the SAME camelCase term shape natively (server callers
// already normalize to this; the client's normalize() layer is idempotent
// on it) — this generator deliberately produces that shared shape so any
// divergence is a real engine bug, not a shape-reading difference. The
// client's own dual-shape acceptance (catalog rows, the camelCase stamp
// shape) is covered separately below and by discountStack.test.js's
// "accepts the camelCase stamp shape too" / catalog-row fixtures.
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
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    discount.eligibleLines = idx.slice(0, size).sort((a, b) => a - b);
  }
  return discount;
}

describe('client discountStack.js matches server discount-stack.js on the same random fixtures', () => {
  test('stackDiscounts — 500 randomized flat stacks', () => {
    const rand = mulberry32(20260921);
    for (let t = 0; t < 500; t++) {
      const base = randMoney(rand, 1, 500);
      const count = randInt(rand, 0, 6);
      const terms = Array.from({ length: count }, () => randomDiscount(rand, { allowScope: false, allowSlot: true }));
      const compound = rand() < 0.85;

      const clientResult = clientStackDiscounts(base, terms, { compound });
      const serverResult = serverStackDiscounts(base, terms, { compound });

      expect(clientResult).toEqual(serverResult);
    }
  });

  test('stackVisitDiscounts — 500 randomized visit stacks (lines + appointment slot)', () => {
    const rand = mulberry32(31415926);
    for (let t = 0; t < 500; t++) {
      const numLines = randInt(rand, 1, 4);
      const lines = Array.from({ length: numLines }, () => ({
        gross: randMoney(rand, 1, 300),
        lineDiscount: rand() < 0.6 ? randomDiscount(rand, { allowScope: false, allowSlot: false }) : null,
        eligible: rand() < 0.85,
      }));
      const appointmentDiscount = rand() < 0.6 ? randomDiscount(rand, { allowScope: false, allowSlot: false }) : null;
      const compound = rand() < 0.85;

      const clientResult = clientStackVisitDiscounts({ lines, appointmentDiscount, compound });
      const serverResult = serverStackVisitDiscounts({ lines, appointmentDiscount, compound });

      expect(clientResult).toEqual(serverResult);
    }
  });

  test('stackDocumentDiscounts — 500 randomized documents (per-line terms + scoped document terms)', () => {
    const rand = mulberry32(271828182);
    for (let t = 0; t < 500; t++) {
      const numLines = randInt(rand, 1, 4);
      const lines = Array.from({ length: numLines }, () => ({
        gross: randMoney(rand, 1, 300),
        terms: rand() < 0.5
          ? Array.from({ length: randInt(rand, 1, 2) }, () => randomDiscount(rand, { allowScope: false, allowSlot: false }))
          : [],
      }));
      const termCount = randInt(rand, 0, 5);
      const documentTerms = Array.from({ length: termCount }, () => randomDiscount(rand, { allowScope: true, allowSlot: false, numLines }));

      const clientResult = clientStackDocumentDiscounts({ lines, documentTerms });
      const serverResult = serverStackDocumentDiscounts({ lines, documentTerms });

      expect(clientResult).toEqual(serverResult);
    }
  });

  // The client's own dual-shape acceptance: a raw catalog row
  // (discount_type/max_discount_dollars snake_case) must resolve to the
  // exact same dollars as the server gets from the camelCase-normalized
  // equivalent a route handler would have built from that same row.
  test('client catalog-row shape matches the server camelCase-normalized equivalent', () => {
    const catalogRow = { discount_type: 'percentage', amount: 12, max_discount_dollars: 9, id: 'promo-row' };
    const camelEquivalent = { discountType: 'percentage', amount: 12, maxDiscountDollars: 9, id: 'promo-row' };
    const clientResult = clientStackDiscounts(150, [catalogRow]);
    const serverResult = serverStackDiscounts(150, [camelEquivalent]);
    expect(clientResult).toEqual(serverResult);
  });
});
