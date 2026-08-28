// StripeService.removeCard — the detach-refusal guards (Codex #2706 r2)
// were untested; and the cascadeAutopay option (owner ruling 2026-08-27):
// under the portal removal guard the route passes cascadeAutopay:false so
// removal never touches customers.autopay_*; the legacy default keeps the
// best-effort cascade for the gate-off path.

describe('StripeService.removeCard', () => {
  let stripeClient;
  let state;
  let customersUpdate;
  let deleted;

  function builder(table) {
    const conds = [];
    const b = {};
    const rows = () => (state[table] || []).filter((r) => conds.every((c) => c(r)));
    b.where = jest.fn((criteria) => {
      Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[k] === v));
      return b;
    });
    b.first = jest.fn(async () => rows()[0] || null);
    b.del = jest.fn(async () => { const n = rows().length; deleted.push(...rows().map((r) => r.id)); return n; });
    b.update = jest.fn(async (vals) => { if (table === 'customers') customersUpdate.push(vals); return 1; });
    b.insert = jest.fn(async () => [1]);
    return b;
  }

  beforeEach(() => {
    jest.resetModules();
    deleted = [];
    customersUpdate = [];
    state = {
      payment_methods: [{
        id: 'pm-db', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_stripe',
        method_type: 'card', ach_status: null, autopay_enabled: true, is_default: true,
      }],
      customers: [{ id: 'cust-1', autopay_enabled: true, autopay_payment_method_id: 'pm-db' }],
    };
    stripeClient = {
      paymentMethods: {
        detach: jest.fn().mockResolvedValue({ id: 'pm_stripe' }),
        retrieve: jest.fn().mockResolvedValue({ id: 'pm_stripe', customer: null }),
      },
      setupIntents: { cancel: jest.fn(), retrieve: jest.fn() },
    };
    const dbMock = jest.fn((table) => builder(table));
    dbMock.transaction = jest.fn(async (cb) => cb(dbMock));
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/autopay-log', () => ({ logAutopay: jest.fn().mockResolvedValue(null) }));
  });

  test('detach failure with the PM still attached → refuses, row kept, nothing cascaded', async () => {
    stripeClient.paymentMethods.detach.mockRejectedValue(new Error('rate limited'));
    stripeClient.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_stripe', customer: 'cus_1' });
    const StripeService = require('../services/stripe');
    await expect(StripeService.removeCard('cust-1', 'pm-db')).rejects.toThrow(/Could not remove the payment method/);
    expect(deleted).toEqual([]);
    expect(customersUpdate).toEqual([]);
  });

  test('detach failure but the PM is genuinely gone → proceeds with DB removal', async () => {
    stripeClient.paymentMethods.detach.mockRejectedValue(new Error('No such PaymentMethod attached'));
    stripeClient.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_stripe', customer: null });
    const StripeService = require('../services/stripe');
    await expect(StripeService.removeCard('cust-1', 'pm-db', { cascadeAutopay: false })).resolves.toEqual({ success: true });
    expect(deleted).toEqual(['pm-db']);
  });

  test('detach failure and the retrieve cannot verify → fails closed', async () => {
    stripeClient.paymentMethods.detach.mockRejectedValue(new Error('timeout'));
    stripeClient.paymentMethods.retrieve.mockRejectedValue(new Error('timeout'));
    const StripeService = require('../services/stripe');
    await expect(StripeService.removeCard('cust-1', 'pm-db')).rejects.toThrow(/Could not remove/);
    expect(deleted).toEqual([]);
  });

  test('accepts the caller transaction handle for every local read/write (the DELETE route locks across the detach)', async () => {
    const StripeService = require('../services/stripe');
    const trxTables = [];
    const trx = (table) => { trxTables.push(table); return builder(table); };
    await StripeService.removeCard('cust-1', 'pm-db', { cascadeAutopay: false, db: trx });
    expect(trxTables).toEqual(['payment_methods', 'payment_methods']);
    expect(deleted).toEqual(['pm-db']);
  });

  test('legacy cascade inside the caller trx runs under a SAVEPOINT — a failed customers update is contained, the delete survives', async () => {
    const StripeService = require('../services/stripe');
    let savepoints = 0;
    const sp = (table) => {
      const b = builder(table);
      if (table === 'customers') b.update = jest.fn(async () => { throw new Error('customers write failed'); });
      return b;
    };
    const trx = (table) => builder(table);
    trx.transaction = jest.fn(async (cb) => { savepoints += 1; return cb(sp); });
    await expect(StripeService.removeCard('cust-1', 'pm-db', { db: trx })).resolves.toEqual({ success: true });
    expect(savepoints).toBe(1);
    expect(deleted).toEqual(['pm-db']);
    expect(customersUpdate).toEqual([]);
  });

  test('cascadeAutopay:false (removal guard on) → detaches and NEVER writes customers.autopay_*', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.removeCard('cust-1', 'pm-db', { cascadeAutopay: false });
    expect(stripeClient.paymentMethods.detach).toHaveBeenCalledWith('pm_stripe');
    expect(deleted).toEqual(['pm-db']);
    expect(customersUpdate).toEqual([]);
  });

  test('legacy default (gate off) keeps the best-effort cascade for an autopay-flagged row', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.removeCard('cust-1', 'pm-db');
    expect(deleted).toEqual(['pm-db']);
    expect(customersUpdate).toEqual([{ autopay_enabled: false, autopay_payment_method_id: null }]);
  });
});
