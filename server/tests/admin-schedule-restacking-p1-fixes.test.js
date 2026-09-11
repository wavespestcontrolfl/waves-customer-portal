/**
 * update-details, GATE_DISCOUNT_STACKING on — Codex round-1 P1 fixes on
 * PR #4405 (multi-discount stacking):
 *
 *  1. reconstructPrimaryLineSlot — an untouched primary-line discount is
 *     reconstructed from the STORED type/amount (percentage stays
 *     percentage) instead of always being flattened into a frozen fixed
 *     dollar credit, so restacking it against another discount this save
 *     touches compounds the same way the client preview does. Worked case:
 *     a $100 line with a stored 10% discount, plus a new $30 appointment
 *     credit, previews AND saves $63 (not $60).
 *
 *  2. addonDiscountStampPreserved — the add-on "preserved stamp" bypass
 *     (skip resolveLineDiscount / manualEligibilityFailures for an
 *     unrelated save) now also requires the line's gross price to be
 *     unchanged. A changed gross forces re-resolution, so a discount with a
 *     minimum subtotal cannot survive on a line just cut below that floor.
 *
 * Both fixes are gate-scoped: with GATE_DISCOUNT_STACKING dark,
 * reconstructPrimaryLineSlot is byte-identical to the pre-lane behavior
 * (always a fixed-dollar back-out) — pinned in discount-stacking-gate.test.js
 * and re-asserted here directly against the extracted helper.
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

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');
const {
  reconstructPrimaryLineSlot,
  addonDiscountStampPreserved,
  calculateVisitFinancialsForAddons,
  resolveLineDiscount,
} = require('../routes/admin-schedule')._test;

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

function discountQuery(discount) {
  return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(discount) };
}

beforeEach(() => jest.clearAllMocks());

describe('reconstructPrimaryLineSlot (P1 #1 — preserve the stored type when restacking)', () => {
  test('stacking ON, a stored PERCENTAGE line discount reconstructs as percentage, not a frozen fixed credit', () => {
    const slot = reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 10 },
    });
    expect(slot).toEqual({ discountType: 'percentage', discountAmount: 10 });
  });

  test('the worked case: $100 line, stored 10% discount, restacked with a new $30 fixed appointment credit → $63, not $60', () => {
    // Reconstruct the untouched primary slot the way update-details does.
    const primaryLineSlot = reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 10 },
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

    // Sanity: the PRE-FIX reconstruction (always fixed_amount off the
    // stored dollars) is exactly the $60 bug this finding reports.
    const buggySlot = { discountType: 'fixed_amount', discountAmount: 10 };
    const buggyFinancials = calculateVisitFinancialsForAddons({
      primaryNet: 90,
      primaryGross: 100,
      primaryLineDiscount: buggySlot,
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, []);
    expect(buggyFinancials.price).toBe(60);
  });

  test('stacking OFF: byte-identical legacy fixed-dollar back-out, even when a percentage type/amount are stored', () => {
    // A row can carry line_discount_type='percentage' from when the gate was
    // on; flipping the gate off must not change what an untouched save
    // reconstructs — the dark path only ever knew a plain dollar credit.
    const slot = reconstructPrimaryLineSlot({
      stacking: false,
      existing: { line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 10 },
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 10 });
  });

  test('stacking ON but nothing of that shape stored (legacy row, dollars only): falls back to the fixed-dollar back-out', () => {
    const slot = reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_type: null, line_discount_amount: null, line_discount_dollars: 15 },
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 15 });
  });

  test('nothing stored at all → null (no line discount)', () => {
    expect(reconstructPrimaryLineSlot({ stacking: true, existing: null })).toBeNull();
    expect(reconstructPrimaryLineSlot({ stacking: true, existing: {} })).toBeNull();
  });

  test('a stored FIXED-amount slot round-trips as fixed, not just via the dollars fallback', () => {
    const slot = reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_type: 'fixed_amount', line_discount_amount: 25, line_discount_dollars: 25 },
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 25 });
  });
});

describe('addonDiscountStampPreserved (P1 #2 — revalidate preserved discounts after price changes)', () => {
  const stored = { discount_id: 'promo-1', discount_type: 'percentage', discount_amount: 10, base_price: 100 };

  test('identical id/type/amount/gross → preserved (the unrelated-save bypass still works)', () => {
    expect(addonDiscountStampPreserved(stored, {
      discountId: 'promo-1', discountType: 'percentage', discountAmount: 10, gross: 100,
    })).toBe(true);
  });

  test('a changed gross price breaks the bypass even though id/type/amount match', () => {
    expect(addonDiscountStampPreserved(stored, {
      discountId: 'promo-1', discountType: 'percentage', discountAmount: 10, gross: 40,
    })).toBe(false);
  });

  test('a changed discount id, type, or amount already broke the bypass (unchanged behavior)', () => {
    expect(addonDiscountStampPreserved(stored, {
      discountId: 'promo-2', discountType: 'percentage', discountAmount: 10, gross: 100,
    })).toBe(false);
    expect(addonDiscountStampPreserved(stored, {
      discountId: 'promo-1', discountType: 'fixed_amount', discountAmount: 10, gross: 100,
    })).toBe(false);
    expect(addonDiscountStampPreserved(stored, {
      discountId: 'promo-1', discountType: 'percentage', discountAmount: 15, gross: 100,
    })).toBe(false);
  });

  test('no stored row → never preserved', () => {
    expect(addonDiscountStampPreserved(null, {
      discountId: 'promo-1', discountType: 'percentage', discountAmount: 10, gross: 100,
    })).toBe(false);
  });

  test('the minimum-subtotal case: a gross cut below the floor forces resolveLineDiscount to run and refuse it', async () => {
    const discount = {
      id: 'promo-1', name: 'Spring bundle', discount_type: 'percentage', amount: 10, min_subtotal: 75,
    };
    // The line's gross dropped from 100 (stored) to 40 — the preserved-stamp
    // bypass must NOT fire, so the route falls through to resolveLineDiscount.
    const preserved = addonDiscountStampPreserved(stored, {
      discountId: 'promo-1', discountType: 'percentage', discountAmount: 10, gross: 40,
    });
    expect(preserved).toBe(false);

    db.mockReturnValueOnce(discountQuery(discount));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue(['minimum subtotal $75']);

    await expect(resolveLineDiscount({ discountId: 'promo-1' }, 40, { id: 'customer-1' }, {
      serviceKey: 'mosquito_addon', serviceCategory: 'mosquito',
    })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/not eligible: minimum subtotal \$75/),
    });
    expect(DiscountEngine.manualEligibilityFailures).toHaveBeenCalledWith(
      discount,
      expect.objectContaining({ id: 'customer-1' }),
      expect.objectContaining({ subtotal: 40 })
    );
  });

  test('unchanged gross above the floor: the bypass still holds and resolveLineDiscount is never consulted', () => {
    const preserved = addonDiscountStampPreserved(stored, {
      discountId: 'promo-1', discountType: 'percentage', discountAmount: 10, gross: 100,
    });
    expect(preserved).toBe(true);
    expect(DiscountEngine.manualEligibilityFailures).not.toHaveBeenCalled();
  });
});

describe('wiring (source-pattern guards)', () => {
  // Structural, not literal: these match the helper name and the arguments
  // that actually matter, not whitespace/argument-literal formatting, so a
  // legitimate reformat of the call site doesn't turn CI red (the #4372
  // trap — an exact-string pin on a line a later refactor reformats).
  test('the primary-line untouched-slot reconstruction calls the extracted helper, not an inline literal', () => {
    const block = src.slice(
      src.indexOf('const primaryLineDiscountProvided = primaryLineDiscount !== undefined;'),
      src.indexOf('} else if (primaryLineDiscount && (primaryLineDiscount.discountId || primaryLineDiscount.id)) {')
    );
    expect(block).toMatch(/primaryLineSlot\s*=\s*reconstructPrimaryLineSlot\(/);
    // The helper needs both the gate flag and the stored row to decide
    // fixed-vs-type-aware; a call missing either would silently revert to
    // the always-percent or always-fixed bug.
    expect(block).toMatch(/reconstructPrimaryLineSlot\([^)]*\bstacking\b[^)]*\)/);
    expect(block).toMatch(/reconstructPrimaryLineSlot\([^)]*\bexisting\b[^)]*\)/);
  });

  test('the add-on preservedStamp check calls the extracted helper with the stored row and the current gross', () => {
    const block = src.slice(
      src.indexOf("const stored = a.discountId ? storedAddonFor(a, serviceName) : null;"),
      src.indexOf('if (stacking && a.discountId && !preservedStamp) {')
    );
    expect(block).toMatch(/addonDiscountStampPreserved\(\s*stored\s*,\s*\{[^}]*\}\s*\)/);
    // The call's second argument must carry `gross` — that's the P1 fix
    // (the bypass used to compare only id/type/amount, never the price).
    const call = block.match(/addonDiscountStampPreserved\(\s*stored\s*,\s*\{([^}]*)\}\s*\)/);
    expect(call).not.toBeNull();
    expect(call[1]).toMatch(/\bgross\b/);
  });

  test('the stored add-on row query selects base_price so the helper has a gross to compare against', () => {
    const block = src.slice(
      src.indexOf("const existingAddonRows = stacking && addons.some"),
      src.indexOf('const storedAddonFor =')
    );
    const select = block.match(/\.select\(([^)]*)\)/);
    expect(select).not.toBeNull();
    expect(select[1]).toMatch(/'discount_id'/);
    expect(select[1]).toMatch(/'discount_type'/);
    expect(select[1]).toMatch(/'discount_amount'/);
    expect(select[1]).toMatch(/'base_price'/);
  });
});
