// resolveAlertsForExemptCustomer: a customer the prepay exemption now covers
// must not keep a stale, pre-coverage payment_expiry alert in front of the
// operator — the admin-compliance active-alert reader returns every
// resolved=false row and nothing else resolves payment_expiry alerts.
// Best-effort: alert bookkeeping must never fail the scan.
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.schema = { hasColumn: jest.fn(async () => true) };
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((x) => x);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendPaymentMethodExpiring: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const paymentExpiry = require('../services/workflows/payment-expiry');

function chain(calls, { updateResult = 0, throwOnUpdate = false } = {}) {
  const q = {};
  ['where', 'orWhere', 'andWhere'].forEach((m) => {
    q[m] = jest.fn((...a) => { calls.push([m, ...a]); if (typeof a[0] === 'function') a[0].call(q, q); return q; });
  });
  q.update = jest.fn(async (patch) => {
    calls.push(['update', patch]);
    if (throwOnUpdate) throw new Error('inventory_alerts down');
    return updateResult;
  });
  return q;
}

beforeEach(() => jest.clearAllMocks());

describe('PaymentExpiry.resolveAlertsForExemptCustomer', () => {
  test('resolves open payment_expiry alerts keyed by customer_id OR the insert-shape reference_id', async () => {
    const calls = [];
    db.mockImplementation(() => chain(calls, { updateResult: 2 }));
    await paymentExpiry.resolveAlertsForExemptCustomer('cust-1');
    expect(calls).toEqual(expect.arrayContaining([
      ['where', { alert_type: 'payment_expiry', resolved: false }],
      ['where', 'customer_id', 'cust-1'],
      ['orWhere', 'reference_id', 'cust-1'],
    ]));
    const update = calls.find((c) => c[0] === 'update');
    expect(update[1]).toMatchObject({ resolved: true });
    expect(update[1].resolved_at).toBeDefined();
  });

  test('without a reference_id column (base migration shape) it matches customer_id only', async () => {
    db.schema.hasColumn.mockResolvedValueOnce(false);
    const calls = [];
    db.mockImplementation(() => chain(calls, { updateResult: 1 }));
    await paymentExpiry.resolveAlertsForExemptCustomer('cust-1');
    expect(calls).toEqual(expect.arrayContaining([['where', 'customer_id', 'cust-1']]));
    expect(calls.find((c) => c[0] === 'orWhere')).toBeUndefined();
  });

  test('a lookup/update failure is swallowed (never fails the scan) and logged', async () => {
    const calls = [];
    db.mockImplementation(() => chain(calls, { throwOnUpdate: true }));
    await expect(paymentExpiry.resolveAlertsForExemptCustomer('cust-1')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
