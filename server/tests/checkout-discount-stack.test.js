/**
 * Dispatch checkout mint (POST /api/admin/schedule/:id/invoice) — every
 * discount extra stacks on the services base under the one rule and one
 * WaveGuard tier per checkout. Source-pattern guards: the mint runs inside
 * the technician-scoped invoice transaction the unit harness can't drive.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

describe('checkout discount stacking', () => {
  test('discount extras are stacked together, not each resolved against the full base', () => {
    expect(src).toMatch(/const stacked = stackDiscounts\(extraDiscountBase, discountLines\.map\(/);
    expect(src).not.toMatch(/calculateDiscountDollars\(discount, extraDiscountBase/);
    // Each row is clamped to the stacked dollars (an older sheet's additive
    // number never wins).
    expect(src).toMatch(/const resolvedDollars = stacked\.items\[discountIndex\+\+\]\.dollars;[\s\S]{0,900}Math\.min\(submittedDollars, resolvedDollars\)/);
  });

  test('the whole lane rides GATE_DISCOUNT_STACKING — dark keeps the legacy math and passthrough', () => {
    expect(src).toMatch(/const checkoutStacking = isEnabled\('discountStacking'\);/);
    expect(src).toMatch(/\}\), \{ compound: checkoutStacking \}\);/);
    expect(src).toMatch(/if \(!checkoutStacking && !discount\) \{[\s\S]{0,400}Legacy: a custom \(id-less\) row passed through verbatim/);
  });

  test('one WaveGuard tier per checkout, checked before any line is minted', () => {
    expect(src).toMatch(/assertStackGroups\(discountLines\.map\(\(e\) => \(e\.discount_id[\s\S]{0,160}spansAll: true \}\)/);
  });

  test('the tier guard sees one entry per POSTED row, so the same tier twice is caught', () => {
    // discountCatalogRows is keyed by id — feeding its values would collapse
    // a duplicate and let two tier rows through.
    expect(src).toMatch(/assertStackGroups\(discountLines\.map\(\(e\) => \(e\.discount_id/);
  });

  test('an operator-entered rate on a variable / custom row is bounded before it reaches the stack', () => {
    expect(src).toMatch(/function boundCheckoutDiscountAmount\(row, amount\) \{[\s\S]{0,320}Math\.min\(100, value\)/);
    expect(src).toMatch(/const checkoutDiscountAmountOf = \(discount, e\) => \(checkoutStacking\s*\n\s*\? boundCheckoutDiscountAmount\(discount, normalizeDiscountAmount\(discount, e\.discount_amount\)\)/);
    expect(src).toMatch(/amount: checkoutDiscountAmountOf\(discount, e\),\s*\n\s*maxDiscountDollars: discount\.max_discount_dollars,/);
    expect(src).toMatch(/discount_amount: checkoutDiscountAmountOf\(discount, e\),\s*\n\s*discount_dollars: dollars,/);
  });

  test('gate off, a catalog row resolves from its own amount only — the posted rate is never read', () => {
    // Before this lane the mint passed `discount.amount` as the client amount
    // and stamped `Number(discount.amount) || 0`, so a custom_percent /
    // custom_dollar preset (DB amount 0) resolved to $0 and was skipped. That
    // is a pre-existing bug, and it stays dark on purpose: honoring the
    // operator-entered rate rides GATE_DISCOUNT_STACKING with the rest of the
    // lane, so gate off is byte-identical to main.
    expect(src).toMatch(/const checkoutDiscountAmountOf = \(discount, e\) => \(checkoutStacking\s*\n[^\n]*\n\s*: Number\(discount\.amount\) \|\| 0\);/);
    // The only reads of the posted rate on a catalog row go through that
    // helper — no bare `normalizeDiscountAmount(discount, e.discount_amount)`
    // survives outside it.
    const bareReads = src.match(/normalizeDiscountAmount\(discount, e\.discount_amount\)/g) || [];
    expect(bareReads).toHaveLength(1);
    expect(src).toMatch(/const checkoutDiscountAmountOf[^\n]*\n[^\n]*normalizeDiscountAmount\(discount, e\.discount_amount\)/);
  });

  test('a custom (id-less) percentage keeps its shape so it compounds like a catalog row', () => {
    expect(src).toMatch(/discount_type: e\?\.discount_type \? String\(e\.discount_type\)\.slice\(0, 30\) : null,/);
    expect(src).toMatch(/\? \{ discountType: e\.discount_type, amount: e\.discount_amount \|\| 0 \}\s*\n\s*: \{ discountType: 'fixed_amount', amount: Math\.abs\(Number\(e\.amount\) \|\| 0\) \}/);
  });
});
