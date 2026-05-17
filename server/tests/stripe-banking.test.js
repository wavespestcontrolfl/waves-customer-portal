describe('stripe banking service', () => {
  let db;
  let stripeClient;
  let insertedRows;
  let payoutUpdate;
  let service;

  beforeEach(() => {
    jest.resetModules();
    insertedRows = null;
    payoutUpdate = null;

    stripeClient = {
      balance: { retrieve: jest.fn() },
      balanceTransactions: { list: jest.fn() },
      payouts: { create: jest.fn(), list: jest.fn() },
    };

    db = jest.fn((table) => {
      if (table === 'stripe_payouts') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({ id: 'local-payout-1', stripe_payout_id: 'po_123', amount: '120.00' }),
          update: jest.fn((patch) => { payoutUpdate = patch; return Promise.resolve(1); }),
          insert: jest.fn(() => ({
            onConflict: jest.fn(() => ({
              merge: jest.fn().mockResolvedValue(1),
            })),
          })),
        };
      }
      if (table === 'stripe_payout_transactions') {
        return {
          where: jest.fn().mockReturnThis(),
          del: jest.fn().mockResolvedValue(1),
          insert: jest.fn((rows) => { insertedRows = rows; return Promise.resolve(rows); }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });
    db.transaction = jest.fn(async (callback) => callback(db));

    jest.doMock('../models/db', () => db);
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_123', apiVersion: '2024-06-20' }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('stripe', () => jest.fn(() => stripeClient));

    service = require('../services/stripe-banking');
  });

  test('syncPayoutTransactions paginates every Stripe balance transaction page', async () => {
    stripeClient.balanceTransactions.list
      .mockResolvedValueOnce({
        data: [{ id: 'txn_1', source: 'po_source', type: 'charge', amount: 10000, fee: 300, net: 9700, created: 1770000000 }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'txn_2', source: 'po_source', type: 'charge', amount: 2500, fee: 75, net: 2425, created: 1770000100 }],
        has_more: false,
      });

    await service.syncPayoutTransactions('po_123');

    expect(stripeClient.balanceTransactions.list).toHaveBeenCalledTimes(2);
    expect(stripeClient.balanceTransactions.list).toHaveBeenNthCalledWith(2, {
      payout: 'po_123',
      limit: 100,
      starting_after: 'txn_1',
    });
    expect(insertedRows).toHaveLength(2);
    expect(payoutUpdate).toEqual({ fee_total: 3.75, transaction_count: 2 });
  });

  test('createInstantPayout validates available balance and upserts returned payout', async () => {
    let insertPayload;
    let conflictColumn;
    let mergeCalled = false;
    db.mockImplementation((table) => {
      if (table !== 'stripe_payouts') throw new Error(`Unexpected table ${table}`);
      return {
        insert: jest.fn((payload) => {
          insertPayload = payload;
          return {
            onConflict: jest.fn((column) => {
              conflictColumn = column;
              return {
                merge: jest.fn(() => {
                  mergeCalled = true;
                  return Promise.resolve(1);
                }),
              };
            }),
          };
        }),
      };
    });
    stripeClient.balance.retrieve.mockResolvedValue({ available: [{ currency: 'usd', amount: 10000 }] });
    stripeClient.payouts.create.mockResolvedValue({
      id: 'po_new',
      amount: 5000,
      currency: 'usd',
      status: 'pending',
      arrival_date: 1770000000,
      created: 1770000000,
      type: 'bank_account',
      description: 'Instant payout',
    });

    const result = await service.createInstantPayout(50, {
      requestedBy: 'admin-1',
      idempotencyKey: 'ipo_test_key_123',
    });

    expect(stripeClient.payouts.create).toHaveBeenCalledWith(
      {
        amount: 5000,
        currency: 'usd',
        method: 'instant',
        description: 'Instant payout',
        metadata: { waves_requested_by: 'admin-1' },
      },
      { idempotencyKey: 'ipo_test_key_123' },
    );
    expect(insertPayload.stripe_payout_id).toBe('po_new');
    expect(conflictColumn).toBe('stripe_payout_id');
    expect(mergeCalled).toBe(true);
    expect(result.amount).toBe(50);
    expect(result.fee_estimate).toBe(0.75);
  });

  test('createStandardPayout creates a standard payout with no instant fee estimate', async () => {
    let insertPayload;
    db.mockImplementation((table) => {
      if (table !== 'stripe_payouts') throw new Error(`Unexpected table ${table}`);
      return {
        insert: jest.fn((payload) => {
          insertPayload = payload;
          return {
            onConflict: jest.fn(() => ({
              merge: jest.fn().mockResolvedValue(1),
            })),
          };
        }),
      };
    });
    stripeClient.balance.retrieve.mockResolvedValue({ available: [{ currency: 'usd', amount: 10000 }] });
    stripeClient.payouts.create.mockResolvedValue({
      id: 'po_standard',
      amount: 7500,
      currency: 'usd',
      status: 'pending',
      arrival_date: 1770000000,
      created: 1770000000,
      method: 'standard',
      type: 'bank_account',
      description: 'Standard payout',
      metadata: { waves_requested_by: 'admin-1' },
    });

    const result = await service.createStandardPayout(75, {
      requestedBy: 'admin-1',
      idempotencyKey: 'spo_test_key_123',
    });

    expect(stripeClient.payouts.create).toHaveBeenCalledWith(
      {
        amount: 7500,
        currency: 'usd',
        method: 'standard',
        description: 'Standard payout',
        metadata: { waves_requested_by: 'admin-1' },
      },
      { idempotencyKey: 'spo_test_key_123' },
    );
    expect(insertPayload.method).toBe('standard');
    expect(result).toMatchObject({ amount: 75, method: 'standard', fee_estimate: 0 });
  });

  test('createStandardPayout lets valid idempotent retries reach Stripe when local balance changed', async () => {
    let insertPayload;
    db.mockImplementation((table) => {
      if (table !== 'stripe_payouts') throw new Error(`Unexpected table ${table}`);
      return {
        insert: jest.fn((payload) => {
          insertPayload = payload;
          return {
            onConflict: jest.fn(() => ({
              merge: jest.fn().mockResolvedValue(1),
            })),
          };
        }),
      };
    });
    stripeClient.balance.retrieve.mockResolvedValue({ available: [{ currency: 'usd', amount: 0 }] });
    stripeClient.payouts.create.mockResolvedValue({
      id: 'po_standard_retry',
      amount: 7500,
      currency: 'usd',
      status: 'pending',
      arrival_date: 1770000000,
      created: 1770000000,
      method: 'standard',
      type: 'bank_account',
      description: 'Standard payout',
      metadata: {},
    });

    const result = await service.createStandardPayout(75, {
      idempotencyKey: 'spo_retry_key_123',
    });

    expect(stripeClient.payouts.create).toHaveBeenCalledWith(
      {
        amount: 7500,
        currency: 'usd',
        method: 'standard',
        description: 'Standard payout',
      },
      { idempotencyKey: 'spo_retry_key_123' },
    );
    expect(insertPayload.stripe_payout_id).toBe('po_standard_retry');
    expect(result).toMatchObject({ payout_id: 'po_standard_retry', amount: 75, method: 'standard' });
  });

  test('createInstantPayout rejects amounts over available Stripe balance', async () => {
    stripeClient.balance.retrieve.mockResolvedValue({ available: [{ currency: 'usd', amount: 2500 }] });

    await expect(service.createInstantPayout(50)).rejects.toThrow('exceeds available Stripe balance');
    expect(stripeClient.payouts.create).not.toHaveBeenCalled();
  });
});
