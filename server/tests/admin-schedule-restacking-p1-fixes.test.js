/**
 * update-details, GATE_DISCOUNT_STACKING on — Codex round-1 P1 fixes on
 * PR #4405 (multi-discount stacking), r1 P1s plus the round-1 P0 escalation
 * on reconstructPrimaryLineSlot (see admin-schedule-stamp-total-consistency
 * .test.js for the full stamp-vs-total P0 scenarios):
 *
 *  1. reconstructPrimaryLineSlot — an untouched primary-line discount is
 *     reconstructed from the STORED type/amount (percentage stays
 *     percentage) instead of always being flattened into a frozen fixed
 *     dollar credit, so restacking it against another discount this save
 *     touches compounds the same way the client preview does. Worked case:
 *     a $100 line with a stored 10% discount, plus a new $30 appointment
 *     credit, previews AND saves $63 (not $60). It is now ASYNC: a
 *     reconstructed percentage/variable term is incomplete without its cap
 *     (max_discount_dollars), which scheduled_services has no column for —
 *     the only source is the catalog row line_discount_id names, so the
 *     helper re-reads it (no eligibility check) and only trusts the cap
 *     when the catalog row's type/amount still match what's stored;
 *     otherwise it falls back to the frozen dollar credit rather than
 *     reconstruct a possibly-uncapped term.
 *
 *  2. addonDiscountStampPreserved — the add-on "preserved stamp" bypass
 *     (skip resolveLineDiscount / manualEligibilityFailures for an
 *     unrelated save) now also requires the line's gross price to be
 *     unchanged. A changed gross forces re-resolution, so a discount with a
 *     minimum subtotal cannot survive on a line just cut below that floor.
 *
 * Both fixes are gate-scoped: with GATE_DISCOUNT_STACKING dark,
 * reconstructPrimaryLineSlot is byte-identical to the pre-lane behavior
 * (always a fixed-dollar back-out, no catalog lookup at all) — pinned in
 * discount-stacking-gate.test.js and re-asserted here directly against the
 * extracted helper.
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

// A fake `conn` for reconstructPrimaryLineSlot's catalog re-read —
// independent of the global `db` mock so each test states its own catalog
// row (or asserts none is ever read) without touching mockReturnValueOnce
// ordering.
function fakeConn(row) {
  return () => ({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) });
}
function neverQuery() {
  return () => { throw new Error('reconstructPrimaryLineSlot must not query the catalog here'); };
}

beforeEach(() => jest.clearAllMocks());

describe('reconstructPrimaryLineSlot (P1 #1 — preserve the stored type when restacking)', () => {
  test('stacking ON, a stored PERCENTAGE line discount reconstructs as percentage, not a frozen fixed credit', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'promo-1', line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 10 },
      conn: fakeConn({ discount_type: 'percentage', amount: 10, max_discount_dollars: null }),
    });
    expect(slot).toEqual({ discountType: 'percentage', discountAmount: 10, maxDiscountDollars: null });
  });

  test('the worked case: $100 line, stored 10% discount, restacked with a new $30 fixed appointment credit → $63, not $60', async () => {
    // Reconstruct the untouched primary slot the way update-details does.
    const primaryLineSlot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'promo-1', line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 10 },
      conn: fakeConn({ discount_type: 'percentage', amount: 10, max_discount_dollars: null }),
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

  test('stacking OFF: byte-identical legacy fixed-dollar back-out, even when a percentage type/amount are stored — no catalog read at all', async () => {
    // A row can carry line_discount_type='percentage' from when the gate was
    // on; flipping the gate off must not change what an untouched save
    // reconstructs — the dark path only ever knew a plain dollar credit.
    const slot = await reconstructPrimaryLineSlot({
      stacking: false,
      existing: { line_discount_id: 'promo-1', line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 10 },
      conn: neverQuery(),
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 10 });
  });

  test('stacking ON but nothing of that shape stored (legacy row, dollars only): falls back to the fixed-dollar back-out, no catalog read', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_type: null, line_discount_amount: null, line_discount_dollars: 15 },
      conn: neverQuery(),
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 15 });
  });

  test('nothing stored at all → null (no line discount)', async () => {
    expect(await reconstructPrimaryLineSlot({ stacking: true, existing: null, conn: neverQuery() })).toBeNull();
    expect(await reconstructPrimaryLineSlot({ stacking: true, existing: {}, conn: neverQuery() })).toBeNull();
  });

  test('a stored FIXED-amount slot round-trips as fixed, not just via the dollars fallback', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'promo-fixed', line_discount_type: 'fixed_amount', line_discount_amount: 25, line_discount_dollars: 25 },
      conn: fakeConn({ discount_type: 'fixed_amount', amount: 25, max_discount_dollars: null }),
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 25, maxDiscountDollars: null });
  });
});

describe('reconstructPrimaryLineSlot — carrying the cap through (P1 #2, escalated to P0)', () => {
  test('a 50% discount capped at $20 on a $100 line reconstructs WITH the cap, not uncapped', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'promo-cap', line_discount_type: 'percentage', line_discount_amount: 50, line_discount_dollars: 20 },
      conn: fakeConn({ discount_type: 'percentage', amount: 50, max_discount_dollars: 20 }),
    });
    expect(slot).toEqual({ discountType: 'percentage', discountAmount: 50, maxDiscountDollars: 20 });

    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 80,
      primaryGross: 100,
      primaryLineDiscount: slot,
      primaryServiceKey: 'k', primaryServiceCategory: 'c',
      appointmentDiscount: null,
    }, []);
    // Uncapped, 50% of $100 is $50 — the cap must hold it at $20.
    expect(financials.lines[0].lineDiscountDollars).toBe(20);
    expect(financials.price).toBe(80);

    // Sanity: the pre-fix reconstruction (type+amount, no cap) is exactly
    // the uncapped-overcharge bug this finding reports.
    const buggySlot = { discountType: 'percentage', discountAmount: 50 };
    const buggyFinancials = calculateVisitFinancialsForAddons({
      primaryNet: 80, primaryGross: 100, primaryLineDiscount: buggySlot,
      primaryServiceKey: 'k', primaryServiceCategory: 'c', appointmentDiscount: null,
    }, []);
    expect(buggyFinancials.lines[0].lineDiscountDollars).toBe(50);
  });

  test('a missing/retired catalog row falls back to the frozen dollar credit rather than an unconfirmed cap', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'retired-promo', line_discount_type: 'percentage', line_discount_amount: 50, line_discount_dollars: 20 },
      conn: fakeConn(null), // the catalog row is gone
    });
    // Falls back to the historically-frozen $20, not a reconstructed
    // (possibly uncapped) 50%.
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 20 });
  });

  test('a catalog row whose terms drifted since (preset edited) falls back to frozen dollars, never the NEW terms', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'promo-edited', line_discount_type: 'percentage', line_discount_amount: 50, line_discount_dollars: 20 },
      // The catalog preset is now 60% capped at $40 — different from what
      // was actually granted on this visit.
      conn: fakeConn({ discount_type: 'percentage', amount: 60, max_discount_dollars: 40 }),
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 20 });
  });

  test('no line_discount_id at all: the cap can never be confirmed, so it falls back to frozen dollars without querying', async () => {
    const slot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_type: 'percentage', line_discount_amount: 50, line_discount_dollars: 20 },
      conn: neverQuery(),
    });
    expect(slot).toEqual({ discountType: 'fixed_amount', discountAmount: 20 });
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
    expect(block).toMatch(/primaryLineSlot\s*=\s*await\s+reconstructPrimaryLineSlot\(/);
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
