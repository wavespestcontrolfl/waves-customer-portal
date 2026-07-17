describe('StripeService.quoteInvoiceSavedCardCharge', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('uses live funding and the shared surcharge math for the displayed total', async () => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', status: 'draft', total: '250.00', credit_applied: '0.00', payer_id: null,
    };
    const card = {
      id: 'pm-1', customer_id: 'cust-1', method_type: 'card', stripe_payment_method_id: 'pm_stripe_1', card_funding: null,
    };
    const query = (row) => {
      const chain = {
        where: jest.fn(() => chain),
        first: jest.fn().mockResolvedValue(row),
      };
      return chain;
    };
    const db = jest.fn((table) => {
      if (table === 'invoices') return query(invoice);
      if (table === 'payment_methods') return query(card);
      throw new Error(`Unexpected table: ${table}`);
    });
    const stripeClient = {
      paymentMethods: {
        retrieve: jest.fn().mockResolvedValue({ id: 'pm_stripe_1', type: 'card', card: { funding: 'credit' } }),
      },
    };

    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: false } }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    const StripeService = require('../services/stripe');
    const quote = await StripeService.quoteInvoiceSavedCardCharge('inv-1', 'pm-1');

    expect(stripeClient.paymentMethods.retrieve).toHaveBeenCalledWith('pm_stripe_1');
    expect(quote).toEqual(expect.objectContaining({
      base: 250,
      surcharge: 7.25,
      total: 257.25,
      rateBps: 290,
      funding: 'credit',
    }));
  });

  test('rejects a stale expected total before cancelling an abandoned pay-session intent', async () => {
    const invoice = {
      id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', status: 'draft',
      total: '250.00', credit_applied: '0.00', payer_id: null,
      stripe_payment_intent_id: 'pi-old',
    };
    const card = {
      id: 'pm-1', customer_id: 'cust-1', method_type: 'card',
      stripe_payment_method_id: 'pm_stripe_1', card_funding: 'debit', last_four: '4242',
    };
    let chargeAttempt = null;
    const db = jest.fn((table) => {
      const chain = {};
      ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'orWhereColumn', 'forUpdate'].forEach((method) => {
        chain[method] = jest.fn((arg) => {
          if (method === 'where' && typeof arg === 'function') arg.call(chain);
          return chain;
        });
      });
      chain.first = jest.fn(async () => {
        if (table === 'invoices') return invoice;
        if (table === 'payment_methods') return card;
        if (table === 'customers') return { id: 'cust-1', stripe_customer_id: 'cus-1' };
        if (table === 'stripe_invoice_charge_attempts') return chargeAttempt;
        return null;
      });
      chain.insert = jest.fn((payload) => {
        if (table === 'stripe_invoice_charge_attempts') {
          chargeAttempt = { ...payload, created_at: new Date(), resolved_at: null };
        }
        return chain;
      });
      chain.returning = jest.fn(async () => (chargeAttempt ? [chargeAttempt] : []));
      chain.update = jest.fn(async (payload) => {
        if (table === 'stripe_invoice_charge_attempts' && chargeAttempt) Object.assign(chargeAttempt, payload);
        return 1;
      });
      return chain;
    });
    db.transaction = jest.fn(async (callback) => callback(db));
    db.fn = { now: jest.fn(() => 'NOW') };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));

    const stripeClient = {
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({ id: 'pi-old', status: 'requires_payment_method' }),
        cancel: jest.fn().mockResolvedValue({ id: 'pi-old', status: 'canceled' }),
        create: jest.fn(),
      },
    };
    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: false } }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    const StripeService = require('../services/stripe');
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { expectedTotal: 999 }))
      .rejects.toThrow('Invoice amount changed after the payment quote');
    expect(stripeClient.paymentIntents.retrieve).toHaveBeenCalledWith('pi-old');
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });
});
