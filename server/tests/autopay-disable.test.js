// The shared Auto Pay-off path (services/autopay-disable.js), used by the
// customer portal PUT /billing/autopay and the Intelligence Bar's staff
// Auto Pay-off step. The portal route's own behavior is pinned by
// autopay-consent-scope.test.js; this pins the service both callers share.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/autopay-eligibility', () => ({ getChargeableAutopayMethod: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendAutopayDisabled: jest.fn().mockResolvedValue(null) }));

const { logAutopay } = require('../services/autopay-log');
const { getChargeableAutopayMethod } = require('../services/autopay-eligibility');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const { AUTOPAY_OFF_UPDATES, disableAutopayInTransaction, sendAutopayDisabledNotice } = require('../services/autopay-disable');

let customer;
let calls;
function fakeTrx() {
  return (table) => {
    const chain = {
      where: () => chain,
      forUpdate: () => { calls.push(`${table}:lock`); return chain; },
      first: async () => (table === 'customers' ? customer : undefined),
      update: async (patch) => { calls.push(`${table}:update`); chain.patch = patch; calls.push({ table, patch }); return 1; },
    };
    return chain;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  customer = { id: 'cust-1', autopay_enabled: true, autopay_payment_method_id: 'pm-1' };
  calls = [];
});

test('turning Auto Pay off: customer row locked FIRST, flags cleared, pause cleared, opt-out event committed in the same transaction', async () => {
  const trx = fakeTrx();
  const out = await disableAutopayInTransaction(trx, 'cust-1', { updates: { ...AUTOPAY_OFF_UPDATES }, details: { source: 'intelligence_bar', actor_id: 'admin-1' } });
  expect(out).toEqual({ transition: true, methodId: 'pm-1' });
  expect(calls.filter((c) => typeof c === 'string')).toEqual(['customers:lock', 'customers:update', 'payment_methods:update']);
  expect(calls.find((c) => c.table === 'customers').patch).toEqual({ autopay_enabled: false, autopay_paused_until: null, autopay_pause_reason: null });
  expect(calls.find((c) => c.table === 'payment_methods').patch).toEqual({ autopay_enabled: false });
  // The log row rides the SAME handle and is required: a failed insert rolls the disable back.
  expect(logAutopay).toHaveBeenCalledWith('cust-1', 'autopay_disabled', { details: { source: 'intelligence_bar', actor_id: 'admin-1' }, db: trx, required: true });
});

test('a transition is reported only for the call that flips enabled to disabled under the lock (NULL flag counts; explicit false does not)', async () => {
  customer.autopay_enabled = null;
  expect((await disableAutopayInTransaction(fakeTrx(), 'cust-1', { updates: { ...AUTOPAY_OFF_UPDATES } })).transition).toBe(true);
  customer.autopay_enabled = false;
  expect((await disableAutopayInTransaction(fakeTrx(), 'cust-1', { updates: { ...AUTOPAY_OFF_UPDATES } })).transition).toBe(false);
});

test('the method the notice names is the one in charge under the lock; with no pointer, the default+enabled fallback resolved BEFORE the flags clear', async () => {
  customer.autopay_payment_method_id = null;
  getChargeableAutopayMethod.mockResolvedValueOnce({ id: 'pm-fallback' });
  const trx = fakeTrx();
  const out = await disableAutopayInTransaction(trx, 'cust-1', { updates: { ...AUTOPAY_OFF_UPDATES } });
  expect(out.methodId).toBe('pm-fallback');
  expect(getChargeableAutopayMethod).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1' }), trx);
});

test('the portal can fold a method pointer or billing day into the same locked write', async () => {
  await disableAutopayInTransaction(fakeTrx(), 'cust-1', { updates: { ...AUTOPAY_OFF_UPDATES, autopay_payment_method_id: null, billing_day: 5 }, details: {} });
  expect(calls.find((c) => c.table === 'customers').patch).toEqual({ ...AUTOPAY_OFF_UPDATES, autopay_payment_method_id: null, billing_day: 5 });
});

test('a failed required event write rejects, so the surrounding transaction rolls the disable back', async () => {
  logAutopay.mockRejectedValueOnce(new Error('log down'));
  await expect(disableAutopayInTransaction(fakeTrx(), 'cust-1', { updates: { ...AUTOPAY_OFF_UPDATES } })).rejects.toThrow('log down');
});

test('the Auto Pay-off notice goes through the gated lifecycle sender and never rejects', async () => {
  await sendAutopayDisabledNotice({ customerId: 'cust-1', paymentMethodId: 'pm-1' });
  expect(PaymentLifecycleEmail.sendAutopayDisabled).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', paymentMethodId: 'pm-1', disabledAt: expect.any(Date) }));
  PaymentLifecycleEmail.sendAutopayDisabled.mockRejectedValueOnce(new Error('sendgrid down'));
  await expect(sendAutopayDisabledNotice({ customerId: 'cust-1', paymentMethodId: 'pm-1' })).resolves.toBeUndefined();
});
