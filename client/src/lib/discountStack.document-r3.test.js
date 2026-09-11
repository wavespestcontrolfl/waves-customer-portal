/**
 * PR #4405 Codex round 3 — the client mirror of the invoice document stack.
 *
 * The preview used to stack each parent line in isolation, which was right
 * until a stored APPOINTMENT-level stamp (no parent line, reaching the whole
 * document) had to participate: a $100 invoice with a frozen $10 stamp plus
 * a fresh 5% line discount previewed $85 while the server saved $85.50.
 *
 * These are the same worked examples server/tests/discount-stack-r3-fixes
 * runs, so the two implementations stay in step.
 */
import { describe, it, expect } from 'vitest';
import { stackDocumentDiscounts, stackVisitDiscounts } from './discountStack';

describe('stackDocumentDiscounts (client mirror)', () => {
  it('compounds a line percentage after a frozen document stamp — $85.50, not $85', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [{ discountType: 'percentage', amount: 5 }] }],
      documentTerms: [{ discountType: 'fixed_amount', amount: 10 }],
    });
    expect(res.documentTerms[0].dollars).toBe(10);
    expect(res.lines[0].termDollars[0]).toBe(4.5);
    expect(res.lines[0].net).toBe(85.5);
  });

  it('a fixed document credit lands before line percentages — the $63 case', () => {
    const res = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [{ discountType: 'percentage', amount: 10 }] }],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30 }],
    });
    expect(res.lines[0].net).toBe(63);
  });

  it('honors per-term eligibleLines: a scoped $30 credit leaves the other line’s 10% at $10', () => {
    const res = stackDocumentDiscounts({
      lines: [
        { gross: 100, terms: [{ discountType: 'percentage', amount: 10 }] },
        { gross: 100, terms: [] },
      ],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30, eligibleLines: [1] }],
    });
    expect(res.lines[0].termDollars[0]).toBe(10);
    expect(res.lines[1].net).toBe(70);
  });

  it('unscoped, the same credit spreads and drops that 10% to $8.50', () => {
    const res = stackDocumentDiscounts({
      lines: [
        { gross: 100, terms: [{ discountType: 'percentage', amount: 10 }] },
        { gross: 100, terms: [] },
      ],
      documentTerms: [{ discountType: 'fixed_amount', amount: 30 }],
    });
    expect(res.lines[0].termDollars[0]).toBe(8.5);
  });

  it('a document percentage lands last, on the remainder across every line', () => {
    const res = stackDocumentDiscounts({
      lines: [
        { gross: 100, terms: [{ discountType: 'percentage', amount: 5 }] },
        { gross: 100, terms: [] },
      ],
      documentTerms: [{ discountType: 'percentage', amount: 10 }],
    });
    // line 0: 5% of $100 = $5 -> $95. Remainder $195, 10% = $19.50.
    expect(res.lines[0].termDollars[0]).toBe(5);
    expect(res.documentTerms[0].dollars).toBe(19.5);
  });
});

describe('allocateProRata never hands out a negative share (client mirror)', () => {
  it('a $0.02 credit over four equal lines stays nonnegative and sums exactly', () => {
    const res = stackDocumentDiscounts({
      lines: [
        { gross: 1, terms: [] }, { gross: 1, terms: [] },
        { gross: 1, terms: [] }, { gross: 1, terms: [] },
      ],
      documentTerms: [{ discountType: 'fixed_amount', amount: 0.02 }],
    });
    const taken = res.lines.map((l) => Math.round((1 - l.net) * 100) / 100);
    taken.forEach((share) => expect(share).toBeGreaterThanOrEqual(0));
    res.lines.forEach((l) => expect(l.net).toBeLessThanOrEqual(1));
    expect(Math.round(taken.reduce((a, b) => a + b, 0) * 100) / 100).toBe(0.02);
  });

  it('the visit stack allocates a fixed appointment credit nonnegatively too', () => {
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
    res.lines.forEach((l) => expect(l.net).toBeLessThanOrEqual(1));
    expect(res.total).toBe(3.98);
  });
});
