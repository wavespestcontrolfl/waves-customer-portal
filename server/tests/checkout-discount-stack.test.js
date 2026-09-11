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
    expect(src).toMatch(/assertStackGroups\(\[\.\.\.discountCatalogRows\.values\(\)\]\.map\(\(row\) => stackRowOf\(row, \{ spansAll: true \}\)\)\);/);
  });

  test('a custom (id-less) percentage keeps its shape so it compounds like a catalog row', () => {
    expect(src).toMatch(/discount_type: e\?\.discount_type \? String\(e\.discount_type\)\.slice\(0, 30\) : null,/);
    expect(src).toMatch(/\? \{ discountType: e\.discount_type, amount: e\.discount_amount \|\| 0 \}\s*\n\s*: \{ discountType: 'fixed_amount', amount: Math\.abs\(Number\(e\.amount\) \|\| 0\) \}/);
  });
});
