// Completion decides the invoice amount from the customer's billing type read
// at entry. A lane edit (customer page, Intelligence Bar card) that commits
// before the mint must not settle on the old lane: the mint's in-lock check
// (billing-lane.js refuseBillingLaneDriftInTrx) refuses with a retryable 409.
jest.mock('../models/db', () => jest.fn());

const fs = require('fs');
const path = require('path');
const { refuseBillingLaneDriftInTrx } = require('../services/billing-lane');

const trxReturning = (row) => {
  const q = { where: () => q, first: async () => row };
  return jest.fn(() => q);
};
const SVC = { customer_id: 'c1', cust_billing_mode: 'monthly_membership', cust_per_application_fee: null };

describe('refuseBillingLaneDriftInTrx', () => {
  test('the billing type moved since entry: 409 BILLING_LANE_CHANGED', async () => {
    await expect(refuseBillingLaneDriftInTrx(trxReturning({ billing_mode: 'per_application', per_application_fee: '147.00' }), SVC))
      .rejects.toMatchObject({ status: 409, code: 'BILLING_LANE_CHANGED' });
  });

  test('a per-application fee that moved refuses; one that did not, or a fee on another lane, passes', async () => {
    const svc = { ...SVC, cust_billing_mode: 'per_application', cust_per_application_fee: '91.00' };
    await expect(refuseBillingLaneDriftInTrx(trxReturning({ billing_mode: 'per_application', per_application_fee: '147.00' }), svc))
      .rejects.toMatchObject({ code: 'BILLING_LANE_CHANGED' });
    await expect(refuseBillingLaneDriftInTrx(trxReturning({ billing_mode: 'per_application', per_application_fee: 91 }), svc)).resolves.toBeUndefined();
    await expect(refuseBillingLaneDriftInTrx(trxReturning({ billing_mode: 'monthly_membership', per_application_fee: '12.00' }), SVC)).resolves.toBeUndefined();
  });

  test('an unchanged lane, a null lane on both sides, and an entry read without the lane columns pass', async () => {
    await expect(refuseBillingLaneDriftInTrx(trxReturning({ billing_mode: 'monthly_membership', per_application_fee: null }), SVC)).resolves.toBeUndefined();
    await expect(refuseBillingLaneDriftInTrx(trxReturning({ billing_mode: null }), { customer_id: 'c1', cust_billing_mode: null })).resolves.toBeUndefined();
    const trx = trxReturning({ billing_mode: 'per_visit' });
    await expect(refuseBillingLaneDriftInTrx(trx, { customer_id: 'c1' })).resolves.toBeUndefined();
    expect(trx).not.toHaveBeenCalled();
  });
});

test('completion runs the check in BOTH mint lanes, inside the mint transaction (recheckInTrx)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  expect(src.match(/recheckInTrx: mintRecheckInTrx,/g)).toHaveLength(2);
  expect(src).toMatch(/const mintRecheckInTrx = async \(trx\) => \{[\s\S]{0,260}await refuseBillingLaneDriftInTrx\(trx, svc\);/);
});

describe('Codex rounds 6 and 7 on #6118: the lane is judged on the locked rows of the transaction that completes the visit', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const persistStart = src.indexOf('const persistRecord = async (trx) => {');

  test('an unpriced monthly visit (nothing to mint) with a switch to per-application refuses: the check needs no invoice decision', async () => {
    const trx = trxReturning({ billing_mode: 'per_application', per_application_fee: '147.00' });
    await expect(refuseBillingLaneDriftInTrx(trx, SVC))
      .rejects.toMatchObject({ status: 409, statusCode: 409, code: 'BILLING_LANE_CHANGED' });
  });

  test('a lane switch landing after the entry read is refused inside the completing transaction, after the customer FOR SHARE and visit FOR UPDATE locks and before any write', () => {
    const customerLock = src.indexOf('.forShare()', persistStart);
    const visitLock = src.indexOf("await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();", persistStart);
    const check = src.indexOf('await refuseBillingLaneDriftInTrx(trx, svc);', persistStart);
    const firstVisitWrite = src.indexOf("await trx('scheduled_services').where({ id: svc.id }).update(scheduledServiceUpdate);", persistStart);
    expect(persistStart).toBeGreaterThan(0);
    expect(customerLock).toBeGreaterThan(persistStart);
    expect(visitLock).toBeGreaterThan(customerLock);
    expect(check).toBeGreaterThan(visitLock);
    expect(check).toBeLessThan(firstVisitWrite);
  });

  test('Codex round 12 on #6118: the same transaction that commits the visit as completed marks the attempt side_effects_running, the durable mark the billing-type edit fences on', () => {
    const check = src.indexOf('await refuseBillingLaneDriftInTrx(trx, svc);', persistStart);
    const mark = src.indexOf('await CompletionAttempts.markCompletionAttemptSideEffectsPending(', persistStart);
    const end = src.indexOf('await withTrackedServicePhotoTransaction({', persistStart);
    expect(mark).toBeGreaterThan(check);
    expect(mark).toBeLessThan(end);
    // Written on the transaction handle (not a separate connection), and cleared only by the final write or a release.
    expect(src.slice(mark, mark + 600)).toMatch(/\n\s+trx\n\s*\);/);
  });

  test('there is no standalone check left outside the completing transaction (the old pre-decision transaction is gone)', () => {
    expect(src).not.toMatch(/db\.transaction\(\(trx\) => refuseBillingLaneDriftInTrx/);
  });

  test('the record transaction\'s catch answers the drift with 409 BILLING_LANE_CHANGED and fails the attempt, so the retry starts clean', () => {
    const branch = src.indexOf("err.code === 'BILLING_LANE_CHANGED'");
    expect(branch).toBeGreaterThan(0);
    expect(src.slice(branch, branch + 400)).toMatch(/markCompletionAttemptFailed\(completionAttempt, err, db\)[\s\S]*status: 409[\s\S]*code: 'BILLING_LANE_CHANGED'/);
  });

  test('a drift refused inside the mint releases for resume with a 409, never the non-blocking "bill by hand" finalize', () => {
    const branch = src.indexOf("invErr?.code === 'BILLING_LANE_CHANGED' && !invoice?.id");
    const nonBlocking = src.indexOf('Auto-invoice failed (non-blocking)');
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(nonBlocking);
    expect(src.slice(branch, branch + 700)).toMatch(/releaseCompletionAttemptForResume\(completionAttempt, invErr\)[\s\S]*status: 409[\s\S]*code: 'BILLING_LANE_CHANGED'/);
  });
});
