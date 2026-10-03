/**
 * B08: a prepaid marker on a plan visit whose month a stamped dues invoice
 * already bills has nowhere to land (the covered visit mints no invoice of its
 * own), so the route REFUSES it, naming the invoice the payment belongs on,
 * rather than recording cash/Zelle off the payment ledger. Source-order checks
 * here; the lookup itself runs against Postgres in
 * membership-dues-once-per-month-postgres.test.js.
 */
const { readFileSync } = require('fs');
const path = require('path');

const source = readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
const routeStart = source.indexOf("router.post('/:id/prepaid'");
const route = source.slice(routeStart, source.indexOf("router.delete('/:id/prepaid'", routeStart));

describe('POST /:id/prepaid on a dues-covered plan visit', () => {
  test('the dues check runs BEFORE the prepaid stamp is written, and refuses with a 409 naming the invoice', () => {
    const checkAt = route.indexOf('await duesInvoiceCoveringPlanVisit(req.params.id)');
    const stampAt = route.indexOf('prepaid_amount: amt');
    expect(checkAt).toBeGreaterThan(0);
    expect(stampAt).toBeGreaterThan(checkAt);
    expect(route).toMatch(/if \(coveringDues\) return res\.status\(409\)\.json\(duesCoversPrepaidRefusal\(coveringDues\)\);/);
  });

  test('a month covered between the check and the receipt mint undoes the marker it wrote (only that one) and refuses the same way', () => {
    expect(route).toMatch(/receipt\.reason === 'membership_dues_covered'/);
    expect(route).toMatch(/\.where\(\{ id: req\.params\.id, prepaid_at: updated\[0\]\.prepaid_at \}\)\s*\n\s*\.update\(\{ prepaid_amount: null, prepaid_method: null, prepaid_note: null, prepaid_at: null \}\)/);
    expect(route.indexOf("receipt.reason === 'membership_dues_covered'")).toBeLessThan(route.indexOf('res.json({ success: true, ...updated[0], receipt })'));
  });

  test('the refusal body carries a stable code and the invoice to take the payment on', () => {
    const helper = source.slice(source.indexOf('function duesCoversPrepaidRefusal'), source.indexOf('async function mintOrReuseScheduledServiceInvoice'));
    expect(helper).toContain("code: 'membership_dues_invoice_covers'");
    expect(helper).toContain('invoice_id: duesInvoice.id');
    expect(helper).toMatch(/Record the payment on invoice \$\{label\}/);
  });
});
