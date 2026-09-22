/**
 * Coordinator scope extension (round 5): the server-side replay-
 * invariance property test (discount-stack-replay-invariance-property.test.js)
 * proved the SAME property against server/services/discount-stack.js —
 * but this client mirror was never independently tested the same way,
 * and it has one structural difference the server file doesn't:
 * normalize(), which stackDocumentDiscounts and stackVisitDiscounts both
 * run over EVERY term (docTerms, each line's own terms, appointmentDiscount)
 * at the top of the function, before resolveSortKind/Value/Cap ever see
 * them.
 *
 * Pre-push audit P0 (round 4 push): normalize() built a brand-new object
 * with only {discountType, amount, maxDiscountDollars, slot,
 * eligibleLines, id} — sortKind/sortValue/sortCap were silently dropped
 * on every call into either function, so the replay-stability fix (this
 * file's own resolveSortKind/Value/Cap) never actually reached a real
 * stackDocumentDiscounts/stackVisitDiscounts call. Reproduced exactly:
 * a frozen $50 line credit + a frozen 50% document discount on $50/$100
 * lines replayed $66.67 here while the server (no such normalize step)
 * correctly saved $50 — a preview/save mismatch. Fixed by having
 * normalize() pass sortKind/sortValue/sortCap through unchanged, like
 * every other camelCase-only field (id/slot/eligibleLines) it already
 * carries.
 *
 * This file is the client-side twin of the server's own property test —
 * same generator technique, same freeze-then-replay methodology, run
 * directly against THIS module's stackDiscounts/stackDocumentDiscounts/
 * stackVisitDiscounts, so a future normalize() regression (or any other
 * spot that quietly rebuilds a term and drops these fields) fails a test
 * here specifically, not just server-side.
 */
import { describe, expect, test } from "vitest";
import { stackDiscounts, stackDocumentDiscounts, stackVisitDiscounts } from "./discountStack.js";

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
function randomDiscount(rand, { allowScope, allowSlot, numLines }) {
  const kindRoll = rand();
  const discountType = kindRoll < 0.45 ? "percentage" : kindRoll < 0.85 ? "fixed_amount" : "free_service";
  const discount = { discountType };
  if (rand() < 0.8) discount.id = `term-${nextId++}`;
  if (discountType === "percentage") {
    discount.amount = randInt(rand, 1, 90);
    if (rand() < 0.4) discount.maxDiscountDollars = randMoney(rand, 1, 80);
  } else if (discountType === "fixed_amount") {
    discount.amount = randMoney(rand, 1, 120);
  } else {
    discount.amount = 0;
  }
  if (allowSlot && rand() < 0.5) discount.slot = "document";
  if (allowScope && numLines > 1 && rand() < 0.4) {
    const size = randInt(rand, 1, numLines - 1);
    const idx = Array.from({ length: numLines }, (_, i) => i);
    const scoped = shuffle(rand, idx).slice(0, size).sort((a, b) => a - b);
    discount.eligibleLines = scoped;
  }
  return discount;
}

// Mirrors the server test's own freezeTerm exactly: the sort key is
// captured ONLY the first time a term freezes (`term.sortKind ??
// term.discountType`), never re-derived from an already-frozen term's
// collapsed discountType/amount on a second cycle.
function freezeTerm(term, dollars) {
  const frozen = {
    discountType: "fixed_amount",
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

describe("client discountStack.js — property: freezing every term at its first-resolve sort key, then replaying, is idempotent", () => {
  test("stackDiscounts — 1000 random flat stacks, freeze-then-replay reproduces the fresh result exactly", () => {
    const rand = mulberry32(20260923);
    let trials = 0;
    for (let t = 0; t < 1000; t++) {
      const base = randMoney(rand, 10, 60);
      const count = randInt(rand, 1, 5);
      const terms = Array.from({ length: count }, () => randomDiscount(rand, { allowScope: false, allowSlot: false }));
      const fresh = stackDiscounts(base, terms);
      const frozen = terms.map((term, i) => freezeTerm(term, fresh.items[i].dollars));
      const replay = stackDiscounts(base, frozen);
      trials++;
      expect(replay.net).toBe(fresh.net);
      expect(replay.items.map((it) => it.dollars)).toEqual(fresh.items.map((it) => it.dollars));
    }
    expect(trials).toBe(1000);
  });

  test("stackDocumentDiscounts — 2500 random multi-line stacks, freeze-then-replay reproduces the fresh result exactly", () => {
    const rand = mulberry32(918273645);
    let trials = 0;
    for (let t = 0; t < 2500; t++) {
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
    }
    expect(trials).toBe(2500);
  });

  test("stackVisitDiscounts — 1000 random line+appointment stacks, freeze-then-replay reproduces the fresh result exactly", () => {
    const rand = mulberry32(554433221);
    let trials = 0;
    for (let t = 0; t < 1000; t++) {
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
      expect(replay.lines.map((l) => l.lineDiscountDollars)).toEqual(fresh.lines.map((l) => l.lineDiscountDollars));
    }
    expect(trials).toBe(1000);
  });
});

describe("the auditor's own reproductions, pinned directly against the client engine", () => {
  test("round-1 auditor repro: $50 line-1 credit + 50% invoice-wide on $50/$100 lines stays $50 on resubmit, never $66.67", () => {
    const lineTerm = { discountType: "fixed_amount", amount: 50, id: "line-credit" };
    const docTerm = { discountType: "percentage", amount: 50, id: "doc-pct" };
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

  test("round-2 auditor repro: $90 line-1 credit (clamps to $50) + $80 invoice-wide on $50/$100 lines stays $20 on resubmit, never $46.67", () => {
    const lineTerm = { discountType: "fixed_amount", amount: 90, id: "line-credit" };
    const docTerm = { discountType: "fixed_amount", amount: 80, id: "doc-credit" };
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
});
