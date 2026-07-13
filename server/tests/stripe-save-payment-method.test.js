describe('StripeService.savePaymentMethod', () => {
  let stripeClient;
  let dbMock;
  let insertedRecord;

  beforeEach(() => {
    jest.resetModules();
    insertedRecord = null;

    stripeClient = {
      paymentMethods: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'pm_stripe_123',
          customer: 'cus_123',
          type: 'card',
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
          },
        }),
        attach: jest.fn().mockResolvedValue({ id: 'pm_stripe_123' }),
      },
    };

    const customerQuery = {
      where: jest.fn(() => customerQuery),
      first: jest.fn().mockResolvedValue({
        id: 'cust_123',
        stripe_customer_id: 'cus_123',
        first_name: 'Pat',
        last_name: 'Customer',
      }),
    };

    const paymentMethodQuery = {
      insert: jest.fn((record) => {
        insertedRecord = record;
        return {
          returning: jest.fn().mockResolvedValue([{ id: 'pm_db_123', ...record }]),
        };
      }),
      where: jest.fn(() => paymentMethodQuery),
      whereNot: jest.fn(() => paymentMethodQuery),
      update: jest.fn().mockResolvedValue(1),
    };

    const trxMock = jest.fn((table) => {
      if (table === 'payment_methods') return paymentMethodQuery;
      throw new Error(`Unexpected trx table: ${table}`);
    });

    dbMock = jest.fn((table) => {
      if (table === 'customers') return customerQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });
    dbMock.transaction = jest.fn(async (callback) => callback(trxMock));

    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({
      secretKey: 'sk_test_mock',
      publishableKey: 'pk_test_mock',
    }));
    jest.doMock('../services/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    jest.doMock('../models/db', () => dbMock);
  });

  test('does not make a saved payment method chargeable for autopay by default', async () => {
    const StripeService = require('../services/stripe');

    const saved = await StripeService.savePaymentMethod('cust_123', 'pm_stripe_123');

    expect(saved.autopay_enabled).toBe(false);
    expect(insertedRecord).toEqual(expect.objectContaining({
      customer_id: 'cust_123',
      stripe_payment_method_id: 'pm_stripe_123',
      is_default: true,
      autopay_enabled: false,
    }));
  });

  test('only marks the saved method chargeable when enableAutopay is explicit', async () => {
    const StripeService = require('../services/stripe');

    const saved = await StripeService.savePaymentMethod('cust_123', 'pm_stripe_123', {
      enableAutopay: true,
    });

    expect(saved.autopay_enabled).toBe(true);
    expect(insertedRecord.autopay_enabled).toBe(true);
  });
});

describe('savePaymentMethod — duplicate-key race + requireAttached (portal ACH, Codex #2706 r1)', () => {
  let stripeClient;
  let dbMock;
  let existingRow;
  let insertError;
  let retrievedPm;

  beforeEach(() => {
    jest.resetModules();
    insertError = null;
    existingRow = {
      id: 'pm_db_existing',
      customer_id: 'cust_123',
      stripe_payment_method_id: 'pm_stripe_123',
      method_type: 'card',
    };
    retrievedPm = {
      id: 'pm_stripe_123',
      customer: 'cus_123',
      type: 'card',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    };

    stripeClient = {
      paymentMethods: {
        retrieve: jest.fn(async () => retrievedPm),
        attach: jest.fn().mockResolvedValue({ id: 'pm_stripe_123' }),
      },
    };

    const customerQuery = {
      where: jest.fn(() => customerQuery),
      first: jest.fn().mockResolvedValue({ id: 'cust_123', stripe_customer_id: 'cus_123' }),
    };
    const pmWriteQuery = {
      insert: jest.fn(() => ({
        returning: jest.fn(() => (insertError
          ? Promise.reject(insertError)
          : Promise.resolve([{ id: 'pm_db_new', customer_id: 'cust_123' }]))),
      })),
      where: jest.fn(() => pmWriteQuery),
      whereNot: jest.fn(() => pmWriteQuery),
      update: jest.fn().mockResolvedValue(1),
    };
    const pmReadQuery = {
      where: jest.fn(() => pmReadQuery),
      first: jest.fn(async () => existingRow),
    };
    const trxMock = jest.fn(() => pmWriteQuery);
    dbMock = jest.fn((table) => (table === 'customers' ? customerQuery : pmReadQuery));
    dbMock.transaction = jest.fn(async (cb) => cb(trxMock));

    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../models/db', () => dbMock);
  });

  test('duplicate-key insert reloads the row the racing writer created (POST /cards vs webhook)', async () => {
    insertError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const StripeService = require('../services/stripe');
    const saved = await StripeService.savePaymentMethod('cust_123', 'pm_stripe_123');
    expect(saved).toBe(existingRow);
  });

  test('duplicate-key with an ownership mismatch still fails closed', async () => {
    insertError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    existingRow = { ...existingRow, customer_id: 'cust_OTHER' };
    const StripeService = require('../services/stripe');
    await expect(StripeService.savePaymentMethod('cust_123', 'pm_stripe_123'))
      .rejects.toThrow('Failed to save payment method');
  });

  test('requireAttached refuses a DETACHED method with the typed sentinel — removed methods are never resurrected', async () => {
    retrievedPm = { ...retrievedPm, customer: null };
    const StripeService = require('../services/stripe');
    await expect(StripeService.savePaymentMethod('cust_123', 'pm_stripe_123', { requireAttached: true }))
      .rejects.toMatchObject({ code: 'PM_NOT_ATTACHED' });
    expect(stripeClient.paymentMethods.attach).not.toHaveBeenCalled();
  });

  test('requireAttached passes for a still-attached method (browser-died backstop keeps working)', async () => {
    const StripeService = require('../services/stripe');
    const saved = await StripeService.savePaymentMethod('cust_123', 'pm_stripe_123', { requireAttached: true, makeDefault: false });
    expect(saved.id).toBe('pm_db_new');
  });
});

describe('removeCard — detach must actually stick (portal ACH, Codex #2706 r2)', () => {
  let stripeClient;
  let dbMock;
  let deleted;
  let detachError;
  let retrievedAfterDetachFail;

  beforeEach(() => {
    jest.resetModules();
    deleted = false;
    detachError = null;
    retrievedAfterDetachFail = { id: 'pm_stripe_123', customer: 'cus_123' };

    stripeClient = {
      paymentMethods: {
        detach: jest.fn(async () => {
          if (detachError) throw detachError;
          return { id: 'pm_stripe_123' };
        }),
        retrieve: jest.fn(async () => retrievedAfterDetachFail),
      },
    };

    const pmQuery = {
      where: jest.fn(() => pmQuery),
      first: jest.fn().mockResolvedValue({
        id: 'pm_db_123',
        customer_id: 'cust_123',
        processor: 'stripe',
        stripe_payment_method_id: 'pm_stripe_123',
        autopay_enabled: false,
      }),
      del: jest.fn(async () => { deleted = true; return 1; }),
      update: jest.fn().mockResolvedValue(1),
    };
    dbMock = jest.fn(() => pmQuery);
    dbMock.transaction = jest.fn(async (cb) => cb(dbMock));

    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../models/db', () => dbMock);
  });

  test('transient detach failure with the PM still attached → removal FAILS CLOSED (no resurrection window)', async () => {
    detachError = new Error('stripe transient error');
    retrievedAfterDetachFail = { id: 'pm_stripe_123', customer: 'cus_123' };
    const StripeService = require('../services/stripe');
    await expect(StripeService.removeCard('cust_123', 'pm_db_123'))
      .rejects.toThrow('Could not remove the payment method');
    expect(deleted).toBe(false);
  });

  test('detach error but PM genuinely detached → removal proceeds', async () => {
    detachError = new Error('payment method is not attached');
    retrievedAfterDetachFail = { id: 'pm_stripe_123', customer: null };
    const StripeService = require('../services/stripe');
    await expect(StripeService.removeCard('cust_123', 'pm_db_123')).resolves.toEqual({ success: true });
    expect(deleted).toBe(true);
  });

  test('unverifiable state (retrieve also fails) → fail closed', async () => {
    detachError = new Error('stripe transient error');
    stripeClient.paymentMethods.retrieve = jest.fn(async () => { throw new Error('network'); });
    const StripeService = require('../services/stripe');
    await expect(StripeService.removeCard('cust_123', 'pm_db_123'))
      .rejects.toThrow('Could not remove the payment method');
    expect(deleted).toBe(false);
  });
});
