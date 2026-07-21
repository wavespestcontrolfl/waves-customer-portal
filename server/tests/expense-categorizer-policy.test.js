/**
 * Unit tests for the server-owned partial-deduction policy in
 * expense-categorizer.js. This policy is the single source of truth for all
 * three expense-recording paths — POST /expenses, POST
 * /expenses/auto-categorize, and the email invoice-processor (where every
 * prod expense actually originates) — so the guarantee it encodes is:
 * the deducted percentage comes from the MATCHED CATEGORY, never from the
 * untrusted (email/AI-influenced) model output.
 */
const {
  sanitizeDeductiblePercent,
  categoryDeductibleAmount,
  CATEGORY_DEDUCTIBLE_PCT,
} = require('../services/expense-categorizer');

describe('categoryDeductibleAmount — category-derived partial deduction', () => {
  test('meals category yields the 50% limitation regardless of model output', () => {
    expect(categoryDeductibleAmount('Meals & Entertainment', 100)).toBe(50);
    expect(categoryDeductibleAmount('Meals & Entertainment', 63.21)).toBe(31.61);
  });

  test('a full-deduction category returns null (leave the amount alone)', () => {
    expect(categoryDeductibleAmount('Supplies', 100)).toBeNull();
    expect(categoryDeductibleAmount('Insurance', 500)).toBeNull();
  });

  test('an unknown / null category name returns null', () => {
    expect(categoryDeductibleAmount(undefined, 100)).toBeNull();
    expect(categoryDeductibleAmount(null, 100)).toBeNull();
    expect(categoryDeductibleAmount('meals & entertainment', 100)).toBeNull(); // case-sensitive: canonical name only
  });

  test('coerces string amounts and rounds to cents', () => {
    expect(categoryDeductibleAmount('Meals & Entertainment', '80.01')).toBe(40.01);
    expect(categoryDeductibleAmount('Meals & Entertainment', 0)).toBe(0);
  });

  test('every mapped percent survives the sanitize allow-list (no inert policy)', () => {
    // A percent added to the map without a matching sanctioned policy would be
    // silently dropped — assert the map and the allow-list stay in lockstep.
    for (const [name, pct] of Object.entries(CATEGORY_DEDUCTIBLE_PCT)) {
      expect(sanitizeDeductiblePercent(pct)).toBe(pct);
      expect(categoryDeductibleAmount(name, 100)).toBe(pct);
    }
  });
});
