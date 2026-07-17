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
});
