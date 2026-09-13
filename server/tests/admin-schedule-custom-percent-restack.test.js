/**
 * PR #4405 Codex round 2, P1 — reconstructPrimaryLineSlot must preserve
 * CUSTOM/VARIABLE percentage semantics when it restacks an untouched
 * primary-line slot.
 *
 * Round 1 taught the helper to reconstruct a stored percentage instead of
 * flattening it into a fixed credit, but it would only trust the term when
 * the catalog row's own `amount` still EQUALLED the stored amount. Custom
 * and variable presets can never satisfy that: the whole point of
 * custom_percent / custom_dollar / variable_* is that the operator types
 * the number per use, so the catalog row's `amount` stays 0 and the entered
 * value lives on the visit. Every such stored slot therefore fell through
 * to the frozen-dollar branch, and the exact round-1 bug came back for them:
 * a stored custom 10% on $100 plus a new $30 appointment credit previews
 * $63 and saved $60.
 *
 * The predicate is now isVariableOrCustomDiscountPreset in
 * services/discount-stack.js — ONE copy, also used by the invoice service's
 * lineItemDiscountTerm, so the two surfaces cannot drift apart again.
 */
process.env.GATE_DISCOUNT_STACKING = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));

const {
  reconstructPrimaryLineSlot,
  calculateVisitFinancialsForAddons,
} = require('../routes/admin-schedule')._test;
const { isVariableOrCustomDiscountPreset } = require('../services/discount-stack');

function fakeConn(row) {
  return () => ({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) });
}

// The catalog shapes a custom/variable preset actually has: a type, a key,
// and an `amount` of 0 because the operator supplies it per use.
const CUSTOM_PERCENT_ROW = {
  discount_type: 'percentage', discount_key: 'custom_percent', amount: 0, max_discount_dollars: null,
};
const VARIABLE_PERCENT_ROW = {
  discount_type: 'variable_percentage', discount_key: 'seasonal_promo', amount: 0, max_discount_dollars: null,
};
const CUSTOM_DOLLAR_ROW = {
  discount_type: 'fixed_amount', discount_key: 'custom_dollar', amount: 0, max_discount_dollars: null,
};

describe('isVariableOrCustomDiscountPreset (the one shared predicate)', () => {
  test('recognizes every custom/variable shape and no ordinary catalog row', () => {
    expect(isVariableOrCustomDiscountPreset(CUSTOM_PERCENT_ROW)).toBe(true);
    expect(isVariableOrCustomDiscountPreset(VARIABLE_PERCENT_ROW)).toBe(true);
    expect(isVariableOrCustomDiscountPreset(CUSTOM_DOLLAR_ROW)).toBe(true);
    expect(isVariableOrCustomDiscountPreset({ discount_type: 'variable_amount', amount: 25 })).toBe(true);
    // An ordinary preset carries its own positive amount and is NOT custom.
    expect(isVariableOrCustomDiscountPreset({ discount_type: 'percentage', discount_key: 'loyalty', amount: 10 })).toBe(false);
    expect(isVariableOrCustomDiscountPreset({ discount_type: 'fixed_amount', discount_key: 'promo', amount: 30 })).toBe(false);
    expect(isVariableOrCustomDiscountPreset(null)).toBe(false);
  });
});

describe('reconstructPrimaryLineSlot — custom/variable presets (r2 P1)', () => {
  test('a stored CUSTOM 10% reconstructs as a percentage even though the catalog amount is 0', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: {
        line_discount_id: 'custom-1',
        line_discount_type: 'percentage',
        line_discount_amount: 10,
        line_discount_dollars: 10,
      },
      conn: fakeConn(CUSTOM_PERCENT_ROW),
    });
    expect(slot).toEqual({ discountType: 'percentage', discountAmount: 10, maxDiscountDollars: null });
  });

  test('the worked case: $100 line, stored CUSTOM 10%, plus a new $30 appointment credit → $63, not $60', async () => {
    const primaryLineSlot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: {
        line_discount_id: 'custom-1',
        line_discount_type: 'percentage',
        line_discount_amount: 10,
        line_discount_dollars: 10,
      },
      conn: fakeConn(CUSTOM_PERCENT_ROW),
    });
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 90,
      primaryGross: 100,
      primaryLineDiscount: primaryLineSlot,
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, []);
    expect(financials.price).toBe(63);
    // Pre-fix: the equality check failed on amount 0 !== 10 and the slot
    // collapsed to a frozen $10 credit — the reported $60.
    const collapsed = calculateVisitFinancialsForAddons({
      primaryNet: 90,
      primaryGross: 100,
      primaryLineDiscount: { discountType: 'fixed_amount', discountAmount: 10 },
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, []);
    expect(collapsed.price).toBe(60);
  });

  test('a variable_percentage preset reconstructs with the catalog CAP, not an uncapped term', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: {
        line_discount_id: 'var-1',
        line_discount_type: 'variable_percentage',
        line_discount_amount: 50,
        line_discount_dollars: 20,
      },
      conn: fakeConn({ ...VARIABLE_PERCENT_ROW, max_discount_dollars: 20 }),
    });
    expect(slot).toEqual({ discountType: 'variable_percentage', discountAmount: 50, maxDiscountDollars: 20 });
  });

  test('the TYPE still has to match: a custom preset retyped since the stamp falls back to the frozen dollars', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: {
        line_discount_id: 'custom-1',
        line_discount_type: 'percentage',
        line_discount_amount: 10,
        line_discount_dollars: 10,
      },
      conn: fakeConn(CUSTOM_DOLLAR_ROW), // retyped to fixed_amount
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 10 });
  });

  test('gate OFF: a stored custom percentage still backs out as a plain dollar credit', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: false,
      existing: {
        line_discount_id: 'custom-1',
        line_discount_type: 'percentage',
        line_discount_amount: 10,
        line_discount_dollars: 10,
      },
      conn: () => { throw new Error('gate off must not read the catalog'); },
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 10 });
  });
});

/**
 * Round-3 fallback P1 — normalizeDiscountAmount was a THIRD hand-written copy
 * of the custom/variable detection (feeding calculateDiscountDollars, which
 * resolveLineDiscount and the checkout mint both depend on). It now calls the
 * one shared predicate, so a new custom shape cannot land in two of three
 * places. These cases pin the behavior the predicate has to keep.
 */
describe('normalizeDiscountAmount honors the operator amount via the shared predicate', () => {
  const { normalizeDiscountAmount } = require('../routes/admin-schedule')._test;

  test('a variable_percentage preset takes the operator amount, not the catalog 0', () => {
    expect(normalizeDiscountAmount({ discount_type: 'variable_percentage', amount: 0 }, 15)).toBe(15);
  });

  test('a seeded custom_percent row takes the operator amount', () => {
    expect(normalizeDiscountAmount(
      { discount_type: 'percentage', discount_key: 'custom_percent', amount: 0 }, 12,
    )).toBe(12);
  });

  test('a zero-amount fixed row takes the operator amount', () => {
    expect(normalizeDiscountAmount({ discount_type: 'fixed_amount', amount: 0 }, 25)).toBe(25);
  });

  test('an ordinary priced preset IGNORES a client-supplied amount', () => {
    expect(normalizeDiscountAmount(
      { discount_type: 'percentage', discount_key: 'loyalty', amount: 10 }, 99,
    )).toBe(10);
  });

  test('a custom preset with no operator amount falls back to the catalog value', () => {
    expect(normalizeDiscountAmount(
      { discount_type: 'percentage', discount_key: 'custom_percent', amount: 0 }, '',
    )).toBe(0);
  });
});
