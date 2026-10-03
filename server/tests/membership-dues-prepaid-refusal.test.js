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
  test('the coverage check and the marker write are ONE helper under the month lock, called before anything else writes, and a covered month answers 409 naming the invoice', () => {
    const callAt = route.indexOf('recordPrepaidUnderDuesLock(req.params.id');
    expect(callAt).toBeGreaterThan(0);
    expect(route.indexOf('prepaid_amount: amt')).toBeGreaterThan(callAt);
    expect(route).toMatch(/if \(coveringDues\) return res\.status\(409\)\.json\(duesCoversPrepaidRefusal\(coveringDues\)\);/);
    // No separate unlocked pre-check remains in the route.
    expect(route).not.toMatch(/await duesInvoiceCoveringPlanVisit\(req\.params\.id\);\s*\n\s*if \(coveringDues\)/);
  });

  test('the helper takes the dues-month lock FIRST, re-reads coverage under it, writes the marker, then re-verifies the visit\'s month and customer', () => {
    const helper = source.slice(source.indexOf('async function recordPrepaidUnderDuesLock'), source.indexOf('function duesCoversPrepaidRefusal'));
    const lockAt = helper.indexOf('acquireMembershipDuesMonthLock(trx');
    const coverAt = helper.indexOf('findLiveStampedDuesInvoice(trx');
    const writeAt = helper.indexOf('writeStamp(trx)');
    const verifyAt = helper.indexOf("trx('scheduled_services').where({ id: serviceId }).first('customer_id', 'scheduled_date')");
    expect(lockAt).toBeGreaterThan(0);
    expect(coverAt).toBeGreaterThan(lockAt);
    expect(writeAt).toBeGreaterThan(coverAt);
    expect(verifyAt).toBeGreaterThan(writeAt);
    expect(helper).toMatch(/err\.status = 409/);
  });

  test('a receipt-requested marker whose month got covered before the receipt mint undoes the marker it wrote (only that one) and refuses the same way', () => {
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
