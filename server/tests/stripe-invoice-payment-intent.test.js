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
    expect(stripeClient.paymentIntents.create.mock.calls[0][1].idempotencyKey).toContain('pi_canceled');
    expect(stripeClient.paymentIntents.create.mock.calls[1][1].idempotencyKey).toContain('_replacement_');
    expect(updateInvoice).toHaveBeenCalledWith({
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_fresh',
    });
  });
});
