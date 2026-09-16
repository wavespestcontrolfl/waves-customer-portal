/**
 * PR #4405 Codex round 4, P0 — enabling GATE_DISCOUNT_STACKING must not
 * re-price visits that were already saved under the legacy regime.
 * AGENTS.md: "existing DB rows must keep working; breaking them is P0."
 *
 * A visit stored gate-OFF with a line percentage AND a fixed appointment
 * credit carries legacy economics (line discounts first, then the credit over
 * the eligible nets). Routing those same stored slots through the live
 * compound stack re-prices the row: the reported case is a $100 primary +
 * $100 add-on with 10% off the add-on and a $30 credit moving from $160 to
 * $161.50 merely by saving NOTES.
 *
 * Which regime produced a stored row is not recorded anywhere, so it cannot
 * be known at save time. What can be decided is that a save which changes
 * NEITHER the prices NOR any discount must not change the money: the stored
 * numbers are that row's economics under whichever regime wrote them, so
 * preserving them is correct either way. A save that DOES touch a price or a
 * discount still recomputes live — uniform economics for already-stored rows
 * edited that way needs a persisted regime marker (a migration), which is an
 * owner decision and is deliberately NOT guessed at here.
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
const { stackVisitDiscounts } = require('../services/discount-stack');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

describe('the regime gap this P0 reports is real', () => {
  test('the same stored slots total $160 legacy and $161.50 compounded', () => {
    const lines = () => ([
      { gross: 100, lineDiscount: null, eligible: true },
      { gross: 100, lineDiscount: { discountType: 'percentage', amount: 10 }, eligible: true },
    ]);
    const appointmentDiscount = { discountType: 'fixed_amount', amount: 30 };
    expect(stackVisitDiscounts({ lines: lines(), appointmentDiscount, compound: false }).total).toBe(160);
    expect(stackVisitDiscounts({ lines: lines(), appointmentDiscount, compound: true }).total).toBe(161.5);
  });
});

describe('wiring: an unrelated save preserves the stored economics', () => {
  // The guard and its three writes are structural — the unit harness cannot
  // drive the whole update-details transaction, so the wiring is pinned in
  // source the same way the sibling P0s in
  // admin-schedule-stamp-total-consistency.test.js are.
  const editPathAt = src.indexOf('await presetEligibilityCheck([');

  test('the guard requires an untouched save: no discount inputs, unchanged prices, unchanged add-on set', () => {
    const guard = src.slice(
      src.indexOf('const moneyInputsUnchanged ='),
      src.indexOf('const financials = calculateVisitFinancialsForAddons({', editPathAt),
    );
    expect(guard).toMatch(/!discountInputsPosted/);
    // Prices must match what is stored, primary and every add-on.
    expect(guard).toMatch(/moneyValuesDiffer\(primaryGross,\s*existing\?\.primary_line_price\)/);
    expect(guard).toMatch(/moneyValuesDiffer\(l\.base,\s*stored\.base_price\)/);
    // An add-on added or removed is a money change.
    expect(guard).toMatch(/normalizedAddons\.length === existingAddonRows\.length/);
    // Only meaningful with the gate ON and a real stored total to preserve.
    expect(guard).toMatch(/legacyEconomicsPreserved\s*=\s*stacking/);
    expect(guard).toMatch(/Number\.isFinite\(storedTotal\)/);
  });

  test('a touched save is NOT preserved — the guard is not a blanket freeze', () => {
    const guard = src.slice(
      src.indexOf('const moneyInputsUnchanged ='),
      src.indexOf('const financials = calculateVisitFinancialsForAddons({', editPathAt),
    );
    // discountInputsPosted is the edit route's own "this save touched a
    // discount" signal (primary slot posted, appointment type posted, or any
    // add-on carrying a discount id), so any discount edit recomputes live.
    expect(src).toMatch(/const discountInputsPosted = primaryLineDiscountProvided \|\| discountType !== undefined/);
    expect(guard).not.toMatch(/legacyEconomicsPreserved\s*=\s*true/);
  });

  test('all three money columns are preserved together, never one without the others', () => {
    const region = src.slice(editPathAt, src.indexOf('// An untouched primary line slot keeps its line_discount_* columns', editPathAt));
    // The line stamp, the visit total and the appointment-discount stamp must
    // all key off the SAME condition — preserving one without the others is
    // exactly the stamp-vs-total split the r1 P0 was about.
    const uses = region.match(/legacyEconomicsPreserved/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    expect(region).toMatch(/updates\.line_discount_dollars = existing\?\.line_discount_dollars/);
    expect(region).toMatch(/\?\s*storedTotal/);
    expect(region).toMatch(/existing\?\.discount_dollars/);
  });

  test('the stored total is read so it CAN be preserved', () => {
    const fields = src.slice(src.indexOf('const existingFields = ['), src.indexOf("if (cols.discount_id) existingFields.push('discount_id');"));
    expect(fields).toMatch(/'estimated_price'/);
    expect(fields).toMatch(/'discount_dollars'/);
    expect(fields).toMatch(/'primary_line_price'/);
  });
});
