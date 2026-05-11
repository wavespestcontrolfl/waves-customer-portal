describe('StripeService.createInvoicePaymentIntent', () => {
  let invoiceRow;
  let updateInvoice;
  let stripeClient;
  let dbMock;
  let trxMock;

  beforeEach(() => {
    jest.resetModules();

    invoiceRow = {
      id: 'inv_123',
      invoice_number: 'WPC-2026-0060',
      status: 'viewed',
      total: '75.00',
      title: null,
      customer_id: 'cust_123',
      stripe_payment_intent_id: 'pi_canceled',
    };
    updateInvoice = jest.fn().mockResolvedValue(1);
    stripeClient = {
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'pi_canceled',
          status: 'canceled',
          metadata: { waves_invoice_id: invoiceRow.id },
        }),
        cancel: jest.fn(),
        create: jest.fn()
          .mockResolvedValueOnce({
            id: 'pi_canceled',
            status: 'canceled',
            client_secret: 'pi_canceled_secret',
          })
          .mockResolvedValueOnce({
            id: 'pi_fresh',
            status: 'requires_payment_method',
            client_secret: 'pi_fresh_secret',
          }),
      },
    };

    const rootInvoiceQuery = {
      where: jest.fn(() => rootInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
    };
    const lockedInvoiceQuery = {
      where: jest.fn(() => lockedInvoiceQuery),
      forUpdate: jest.fn(() => lockedInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
      whereNotIn: jest.fn(() => lockedInvoiceQuery),
      update: updateInvoice,
    };
    const paymentsQuery = {
      where: jest.fn(() => paymentsQuery),
      first: jest.fn().mockResolvedValue(null),
    };

    trxMock = jest.fn(table => {
      if (table === 'invoices') return lockedInvoiceQuery;
      if (table === 'payments') return paymentsQuery;
      throw new Error(`Unexpected trx table: ${table}`);
    });
    dbMock = jest.fn(table => {
      if (table === 'invoices') return rootInvoiceQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });
    dbMock.transaction = jest.fn(async callback => callback(trxMock));

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

  test('does not return a canceled idempotency replay when replacing an invoice PaymentIntent', async () => {
    const StripeService = require('../services/stripe');
    const result = await StripeService.createInvoicePaymentIntent(invoiceRow.id);

    expect(result.paymentIntentId).toBe('pi_fresh');
    expect(result.clientSecret).toBe('pi_fresh_secret');
    expect(stripeClient.paymentIntents.create).toHaveBeenCalledTimes(2);
    expect(stripeClient.paymentIntents.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      amount: 7799,
      payment_method_types: ['card'],
      metadata: expect.objectContaining({
        selected_method_category: 'card',
        base_amount: '75',
        card_surcharge: '2.99',
      }),
    }));
    expect(stripeClient.paymentIntents.create.mock.calls[0][1].idempotencyKey).toContain('pi_canceled');
    expect(stripeClient.paymentIntents.create.mock.calls[1][1].idempotencyKey).toContain('_replacement_');
    expect(updateInvoice).toHaveBeenCalledWith({
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_fresh',
    });
  });
});

describe('StripeService.updateInvoicePaymentIntentMethod', () => {
  let invoiceRow;
  let stripeClient;
  let dbMock;

  beforeEach(() => {
    jest.resetModules();

    invoiceRow = {
      id: 'inv_123',
      invoice_number: 'WPC-2026-0060',
      status: 'viewed',
      total: '75.00',
      customer_id: 'cust_123',
      stripe_payment_intent_id: 'pi_invoice',
    };
    stripeClient = {
      paymentIntents: {
        update: jest.fn().mockImplementation(async (id, params) => ({
          id,
          ...params,
        })),
      },
    };

    const rootInvoiceQuery = {
      where: jest.fn(() => rootInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
    };
    dbMock = jest.fn(table => {
      if (table === 'invoices') return rootInvoiceQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });

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

  test('card-family updates lock the PaymentIntent to card at the surcharged total', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card');

    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_invoice', expect.objectContaining({
      amount: 7799,
      payment_method_types: ['card'],
      metadata: expect.objectContaining({
        selected_method_category: 'card',
        base_amount: '75',
        card_surcharge: '2.99',
      }),
    }));
  });

  test('ACH updates lock the PaymentIntent to bank account at the base total', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'us_bank_account');

    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_invoice', expect.objectContaining({
      amount: 7500,
      payment_method_types: ['us_bank_account'],
      metadata: expect.objectContaining({
        selected_method_category: 'us_bank_account',
        base_amount: '75',
        card_surcharge: '0',
      }),
    }));
  });

  test('updates reject PaymentIntents that are not bound to the invoice', async () => {
    invoiceRow.stripe_payment_intent_id = 'pi_other';
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card'),
    ).rejects.toThrow(/does not belong/);
    expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
  });
});
