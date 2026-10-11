/**
 * One lock order for every reactivation / revision of an open estimate: the estimate ROW lock first,
 * then the per-customer estimate lock (utils/customer-estimate-lock.js, a leaf), and no other lock
 * after it. The booking takes the same lock after its customer / comms / series locks.
 */
const fs = require('fs');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');
const LOCK = 'lockCustomerEstimates(trx';
const LOCKS_AFTER = /pg_advisory_xact_lock|lockCustomerComms\(|lockInspectionCreditCustomer\(/;

// [name, file, how the estimate row is locked before the leaf lock]
const SITES = [
  ['public-quote refresh', '../routes/public-quote', 'lockCustomerEstimates(trx, estFields.customer_id)', /\.forUpdate\(\)/],
  ['admin unarchive', '../routes/admin-estimates', "where({ id: req.params.id }).forUpdate().first('id');", null],
  ['admin proposal revival', '../routes/admin-estimates', 'if (revivingBid) await require', /const locked = await trx\('estimates'\)\.where\(\{ id: estimate\.id \}\)\.forUpdate\(\)/],
  ['extendEstimate', '../services/estimate-extension', 'lockCustomerEstimates(trx, estimate.customer_id)', /\.forUpdate\(\)/],
  ['reviseAdminEstimate', '../services/admin-estimate-persistence', 'lockCustomerEstimates(trx, lockedPrior.customer_id)', /const lockedPrior = await trx\('estimates'\)/],
  ['customer service opt-in / opt-out', '../routes/estimate-public', 'lockCustomerEstimates(trx, estimate.customer_id)', /lockEstimateOwnerForUpdate\(trx, estimate\)/],
  ['agent reprice', '../services/intelligence-bar/estimate-tools', 'lockCustomerEstimates(trx, estimate.customer_id)', /where\(\{ id: estimateId \}\)\.forUpdate\(\)/],
];

describe('customer estimate lock order (row lock first, then the leaf lock)', () => {
  test.each(SITES)('%s locks the estimate row before the per-customer lock', (name, rel, anchor, rowLock) => {
    const src = read(rel);
    const at = src.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    if (name === 'admin unarchive') {
      const unarchive = src.indexOf("router.post('/:id/unarchive'");
      const row = src.indexOf("where({ id: req.params.id }).forUpdate().first('id');", unarchive);
      const leaf = src.indexOf(LOCK, unarchive);
      expect(row).toBeGreaterThan(unarchive);
      expect(leaf).toBeGreaterThan(row);
      return;
    }
    const before = src.slice(Math.max(0, at - 12000), at);
    expect(before).toMatch(rowLock);
  });

  test.each(SITES.filter((s) => s[0] !== 'admin unarchive'))('%s takes no other lock after the leaf lock', (name, rel, anchor) => {
    const src = read(rel);
    const at = src.indexOf(anchor);
    const after = src.slice(at + anchor.length, at + anchor.length + 400);
    expect(after).not.toMatch(LOCKS_AFTER);
  });

  test('the admin unarchive no longer takes the advisory lock before the row', () => {
    const src = read('../routes/admin-estimates');
    const unarchive = src.indexOf("router.post('/:id/unarchive'");
    const tx = src.indexOf('db.transaction(async (trx) => {', unarchive);
    expect(src.slice(tx, tx + 200)).toContain("forUpdate().first('id')");
  });

  test('the lead-webhook triage rewrite takes the per-customer lock inside its own transaction', () => {
    const src = read('../routes/lead-webhook');
    const at = src.indexOf('lockCustomerEstimates(trx, customer.id);');
    expect(at).toBeGreaterThan(-1);
    const after = src.slice(at, at + 600);
    expect(after).toMatch(/trx\('estimates'\)/);
    expect(after).not.toMatch(LOCKS_AFTER);
  });

  test('an unlinked estimate insert locks the customer the accept would resolve, before the insert', () => {
    const src = read('../services/email/email-actions');
    const lock = src.indexOf('lockCustomerEstimates(trx, prospectiveOwnerId)');
    const insert = src.indexOf('customer_id: null', lock);
    expect(lock).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(lock);
    expect(src.slice(0, lock)).toMatch(/resolveProspectiveAcceptCustomer\(/);
  });
});
