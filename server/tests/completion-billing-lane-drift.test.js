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
