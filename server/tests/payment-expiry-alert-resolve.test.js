// resolveAlertsForExemptCustomers: customers the prepay exemption now covers
// must not keep stale, pre-coverage payment_expiry alerts in front of the
// operator — the admin-compliance active-alert reader returns every
// resolved=false row and nothing else resolves payment_expiry alerts.
// Reconciled against the FULL exemption set (not the expiring-card rows), so
// an exempt customer who replaced or disabled the old card still resolves.
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
jest.mock('../services/annual-prepay-renewals', () => ({
  getCardExpiryExemptions: jest.fn(async () => ({ customerIds: new Set(), chargeMethodIdsByCustomer: new Map() })),
}));
jest.mock('../services/card-expiry-exemptions', () => ({
  emptyCardExpiryExemptions: jest.fn(() => ({ customerIds: new Set(), chargeMethodIdsByCustomer: new Map() })),
  isCardExpiryExemptMethod: jest.fn(() => false),
  cardExpiryAlertResolvableCustomerIds: jest.fn(() => new Set()),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const paymentExpiry = require('../services/workflows/payment-expiry');

function chain(rows, calls, { throwOnUpdate = false } = {}) {
  const q = {};
  ['where', 'orWhere', 'andWhere', 'whereIn'].forEach((m) => {
    q[m] = jest.fn((...a) => { calls.push([m, ...a]); if (typeof a[0] === 'function') a[0].call(q, q); return q; });
  });
  q.select = jest.fn(async (...a) => { calls.push(['select', ...a]); return rows; });
  q.update = jest.fn(async (patch) => {
    calls.push(['update', patch]);
    if (throwOnUpdate) throw new Error('inventory_alerts down');
    return rows.length;
  });
  return q;
}

beforeEach(() => jest.clearAllMocks());

describe('PaymentExpiry.resolveAlertsForExemptCustomers', () => {
  const openAlerts = [
    { id: 'a1', customer_id: 'cust-1', reference_id: null },
    { id: 'a2', customer_id: null, reference_id: 'cust-1' }, // insert-shape key
    { id: 'a3', customer_id: 'cust-2', reference_id: null }, // not exempt — stays open
  ];

  test('resolves open payment_expiry alerts keyed by customer_id OR the insert-shape reference_id, exempt customers only', async () => {
    const calls = [];
    db.mockImplementation(() => chain(openAlerts, calls));
    await paymentExpiry.resolveAlertsForExemptCustomers(new Set(['cust-1']));
    expect(calls).toEqual(expect.arrayContaining([
      ['where', { alert_type: 'payment_expiry', resolved: false }],
      ['whereIn', 'id', ['a1', 'a2']],
    ]));
    const update = calls.find((c) => c[0] === 'update');
    expect(update[1]).toMatchObject({ resolved: true });
    expect(update[1].resolved_at).toBeDefined();
  });

  test('without a reference_id column (base migration shape) it matches customer_id only', async () => {
    db.schema.hasColumn.mockResolvedValueOnce(false);
    const calls = [];
    db.mockImplementation(() => chain([{ id: 'a1', customer_id: 'cust-1' }], calls));
    await paymentExpiry.resolveAlertsForExemptCustomers(new Set(['cust-1']));
    expect(calls).toEqual(expect.arrayContaining([['select', ['id', 'customer_id']], ['whereIn', 'id', ['a1']]]));
  });

  test('no exempt customers, or none with open alerts → no update at all', async () => {
    const calls = [];
    db.mockImplementation(() => chain(openAlerts, calls));
    await paymentExpiry.resolveAlertsForExemptCustomers(new Set());
    expect(calls).toEqual([]);
    await paymentExpiry.resolveAlertsForExemptCustomers(new Set(['cust-9']));
    expect(calls.find((c) => c[0] === 'update')).toBeUndefined();
  });

  test('a lookup/update failure is swallowed (never fails the scan) and logged', async () => {
    const calls = [];
    db.mockImplementation(() => chain(openAlerts, calls, { throwOnUpdate: true }));
    await expect(paymentExpiry.resolveAlertsForExemptCustomers(new Set(['cust-1']))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('PaymentExpiry.checkExpiringCards routing outcome', () => {
  let originalResolve;

  function query(rows = [], { first = null, insert } = {}) {
    const q = {};
    for (const method of ['join', 'from', 'where', 'andWhere', 'whereNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orWhere', 'orWhereExists', 'orWhereNotIn']) {
      q[method] = jest.fn((arg) => {
        if (typeof arg === 'function') arg.call(q);
        return q;
      });
    }
    q.select = jest.fn(() => q);
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    q.first = jest.fn(async () => first);
    q.insert = insert || jest.fn(async () => [1]);
    return q;
  }

  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-09-24T15:00:00Z'));
    originalResolve = paymentExpiry.resolveAlertsForExemptCustomers;
  });
  afterAll(() => {
    paymentExpiry.resolveAlertsForExemptCustomers = originalResolve;
    jest.useRealTimers();
  });

  test.each(['email', 'push'])('7-day %s delivery records its actual channel and uses the stage cooldown', async (channel) => {
    const interactionInsert = jest.fn(async () => [1]);
    paymentExpiry.resolveAlertsForExemptCustomers = jest.fn(async () => {});
    require('../services/messaging/send-customer-message').sendCustomerMessage
      .mockResolvedValueOnce({ sent: true, channel, deliveryOutcome: 'accepted' });
    require('../services/sms-template-renderer').renderSmsTemplate.mockResolvedValueOnce('expiry body');
    require('../services/payment-lifecycle-email').sendPaymentMethodExpiring.mockResolvedValueOnce({ ok: true });
    db.mockImplementation((table) => {
      if (table === 'payment_methods as pm') return query([{
        id: 'pm-1', customer_id: 'cust-1', last_four: '4242', exp_month: '9', exp_year: '2026', card_brand: 'Visa',
      }]);
      if (table === 'customers') return query([], { first: {
        id: 'cust-1', first_name: 'Pat', last_name: 'Customer', phone: '+19415550100', billing_mode: null,
      } });
      if (table === 'sms_log') return query([], { first: null });
      if (table === 'inventory_alerts') return query();
      if (table === 'customer_interactions') return query([], { insert: interactionInsert });
      throw new Error(`Unexpected table ${table}`);
    });

    await expect(paymentExpiry.checkExpiringCards()).resolves.toMatchObject({ notified: 1 });
    expect(db.raw).toHaveBeenCalledWith("NOW() - (? * INTERVAL '1 day')", [7]);
    expect(interactionInsert).toHaveBeenCalledWith(expect.objectContaining({
      interaction_type: `${channel}_outbound`, channel,
    }));
  });
});
