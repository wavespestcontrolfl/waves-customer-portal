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
        update: jest.fn().mockImplementation(async (id, params) => ({
          id,
          status: 'requires_payment_method',
          client_secret: `${id}_secret`,
          ...params,
        })),
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
      amount: 7500,
      payment_method_types: ['card'],
      metadata: expect.objectContaining({
        selected_method_category: 'card',
        base_amount: '75',
        card_surcharge: '0',
      }),
    }));
    expect(stripeClient.paymentIntents.create.mock.calls[0][1].idempotencyKey).toContain('pi_canceled');
    expect(stripeClient.paymentIntents.create.mock.calls[1][1].idempotencyKey).toContain('_replacement_');
    expect(updateInvoice).toHaveBeenCalledWith({
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_fresh',
    });
  });

  test('reuses an already-bound open PaymentIntent instead of failing setup', async () => {
    invoiceRow.stripe_payment_intent_id = 'pi_open';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_open',
      status: 'requires_payment_method',
      metadata: { waves_invoice_id: invoiceRow.id },
    });

    const StripeService = require('../services/stripe');
    const result = await StripeService.createInvoicePaymentIntent(invoiceRow.id);

    expect(result.paymentIntentId).toBe('pi_open');
    expect(result.clientSecret).toBe('pi_open_secret');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_open', expect.objectContaining({
      amount: 7500,
      payment_method_types: ['card'],
      setup_future_usage: '',
      metadata: expect.objectContaining({
        waves_invoice_id: invoiceRow.id,
        selected_method_category: 'card',
        base_amount: '75',
        card_surcharge: '0',
      }),
    }));
    expect(stripeClient.paymentIntents.update.mock.calls[0][1]).not.toHaveProperty('currency');
    expect(updateInvoice).toHaveBeenCalledWith({
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_open',
    });
  });

  test('setup returns a client-safe conflict when a bound PaymentIntent is already in progress', async () => {
    invoiceRow.stripe_payment_intent_id = 'pi_processing';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_processing',
      status: 'processing',
      metadata: { waves_invoice_id: invoiceRow.id },
    });

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toMatchObject({
        message: 'Invoice payment is already in progress',
        statusCode: 409,
      });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
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
        retrieve: jest.fn().mockResolvedValue({ id: 'pi_invoice', status: 'requires_payment_method' }),
        create: jest.fn().mockImplementation(async (params) => ({
          id: 'pi_replacement',
          client_secret: 'cs_replacement',
          ...params,
        })),
        cancel: jest.fn().mockResolvedValue({ id: 'pi_invoice', status: 'canceled' }),
      },
    };

    const rootInvoiceQuery = {
      where: jest.fn(() => rootInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
    };
    // Transaction-scoped invoice query: supports the forUpdate read and the
    // guarded repoint update used by replaceInvoicePaymentIntentForTender.
    const trxInvoiceQuery = {
      where: jest.fn(() => trxInvoiceQuery),
      forUpdate: jest.fn(() => trxInvoiceQuery),
      whereNotIn: jest.fn(() => trxInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
      update: jest.fn().mockResolvedValue(1),
    };
    dbMock = jest.fn(table => {
      if (table === 'invoices') return rootInvoiceQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });
    dbMock.transaction = jest.fn(async (cb) => {
      const trx = jest.fn(table => {
        if (table === 'invoices') return trxInvoiceQuery;
        throw new Error(`Unexpected trx table: ${table}`);
      });
      return cb(trx);
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

  test('card-family updates keep the PaymentIntent at base amount (surcharge deferred to /finalize)', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card');

    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_invoice', expect.objectContaining({
      amount: 7500,
      payment_method_types: ['card'],
      metadata: expect.objectContaining({
        selected_method_category: 'card',
        base_amount: '75',
        card_surcharge: '0',
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

  test('tender switch blocked by an attached PM recreates the PaymentIntent for the new tender', async () => {
    stripeClient.paymentIntents.update.mockRejectedValueOnce(new Error(
      'The allowed types provided (card) are incompatible with the attached PaymentMethod on the PaymentIntent. Please replace the PaymentMethod first or include us_bank_account in the allowed types.',
    ));
    const StripeService = require('../services/stripe');

    const result = await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card');

    // Fresh PI minted for the selected tender, lock preserved.
    expect(stripeClient.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 7500,
        payment_method_types: ['card'],
        metadata: expect.objectContaining({ selected_method_category: 'card', card_surcharge: '0' }),
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('invoice_pi_replace_') }),
    );
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_invoice');
    expect(stripeClient.paymentIntents.cancel.mock.invocationCallOrder[0])
      .toBeLessThan(stripeClient.paymentIntents.create.mock.invocationCallOrder[0]);
    expect(result).toEqual(expect.objectContaining({
      replaced: true,
      paymentIntentId: 'pi_replacement',
      clientSecret: 'cs_replacement',
      total: 75,
      surcharge: 0,
    }));
  });

  test('tender switch will not cancel a PaymentIntent that is already processing', async () => {
    stripeClient.paymentIntents.update.mockRejectedValueOnce(new Error(
      'The allowed types provided (card) are incompatible with the attached PaymentMethod on the PaymentIntent.',
    ));
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_invoice', status: 'processing' });
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card'),
    ).rejects.toThrow(/already in progress/);
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  test('tender switch fails closed when the stale PI cannot be canceled before replacement', async () => {
    stripeClient.paymentIntents.update.mockRejectedValueOnce(new Error(
      'The allowed types provided (card) are incompatible with the attached PaymentMethod on the PaymentIntent.',
    ));
    stripeClient.paymentIntents.cancel.mockRejectedValueOnce(new Error(
      'You cannot cancel this PaymentIntent because it has a status of processing.',
    ));
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card'),
    ).rejects.toThrow(/already in progress/);
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_invoice');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('tender switch fails closed when the stale PI status cannot be read', async () => {
    stripeClient.paymentIntents.update.mockRejectedValueOnce(new Error(
      'The allowed types provided (card) are incompatible with the attached PaymentMethod on the PaymentIntent.',
    ));
    stripeClient.paymentIntents.retrieve.mockRejectedValueOnce(new Error('Stripe API unavailable'));
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card'),
    ).rejects.toThrow(/could not verify the existing payment status/i);
    // Never repoint the invoice or cancel the old PI when status is unknown.
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
  });
});
