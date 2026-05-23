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
