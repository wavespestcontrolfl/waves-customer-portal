// chargeInvoiceWithSavedCard's locked guards added for the termite annual
// plan charged after installation (GitHub Codex #5816 r4): a held visit paid
// another way, and an authorizing agreement that is no longer signed, both
// refuse inside the charge transaction, before Stripe. Same mock shape as the
// requireHeldTermId case in stripe-saved-card-quote.test.js.
describe('chargeInvoiceWithSavedCard — held-visit and signed-agreement guards', () => {
  beforeEach(() => { jest.resetModules(); });

  function load({ visit, contract }) {
    const invoice = {
      id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', status: 'draft',
      subtotal: '200.00', total: '200.00', discount_amount: '0.00',
      credit_applied: '0.00', payer_id: null, stripe_payment_intent_id: null,
    };
    const card = {
      id: 'pm-1', customer_id: 'cust-1', method_type: 'card',
      stripe_payment_method_id: 'pm_stripe_1', card_funding: 'debit', last_four: '4242',
    };
    let chargeAttempt = null;
    const db = jest.fn((table) => {
      const chain = {};
      ['where', 'whereNot', 'whereIn', 'orWhereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'orWhereColumn', 'forUpdate', 'orderBy'].forEach((method) => {
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
        if (table === 'scheduled_services') return visit;
        if (table === 'service_records') return { status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'completed' }) };
        if (table === 'annual_prepay_terms') return { status: 'payment_pending', prepay_invoice_id: 'inv-1' };
        if (table === 'customer_contracts') return contract;
        return null;
      });
      chain.insert = jest.fn((payload) => {
        if (table === 'stripe_invoice_charge_attempts') chargeAttempt = { ...payload, created_at: new Date(), resolved_at: null };
        return chain;
      });
      chain.returning = jest.fn(async () => (chargeAttempt ? [chargeAttempt] : []));
      chain.update = jest.fn(async (payload) => {
        if (table === 'stripe_invoice_charge_attempts' && chargeAttempt) Object.assign(chargeAttempt, payload);
        return 1;
      });
      chain.select = jest.fn(async () => { const row = await chain.first(); return row ? [row] : []; });
      return chain;
    });
    db.transaction = jest.fn(async (callback) => callback(db));
    db.fn = { now: jest.fn(() => 'NOW') };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));

    const stripeClient = { paymentIntents: { retrieve: jest.fn(), cancel: jest.fn(), create: jest.fn() } };
    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: false } }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
    return { StripeService: require('../services/stripe'), stripeClient };
  }

  const heldVisit = { id: 'svc-1', customer_id: 'cust-1', status: 'completed', paf_held_term_id: 'term-1', prepaid_method: null };
  const installationGuards = {
    requireSelfPayScheduledServiceId: 'svc-1', requireCompletedVisit: true, requirePerformedVisit: true, requireHeldTermId: 'term-1',
  };

  test('a held visit that was paid another way (cash / Zelle stamp on the locked row) refuses the charge', async () => {
    const { StripeService, stripeClient } = load({ visit: { ...heldVisit, prepaid_method: 'cash' }, contract: { id: 'contract-1', status: 'signed' } });

    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', installationGuards))
      .rejects.toMatchObject({ code: 'VISIT_NOT_COMPLETED', message: expect.stringContaining('paid another way') });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('a held visit that carries an invoice of its own refuses the charge (requireNoOtherVisitInvoice)', async () => {
    const { StripeService, stripeClient } = load({ visit: heldVisit, contract: { id: 'contract-1', status: 'signed' } });

    // The mock's invoices table answers every lookup with a row, the visit's own invoice included.
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { ...installationGuards, requireNoOtherVisitInvoice: true }))
      .rejects.toMatchObject({ code: 'VISIT_NOT_COMPLETED', message: expect.stringContaining('invoice of its own') });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test.each([
    ['cancelled', { id: 'contract-1', status: 'cancelled' }],
    ['missing', null],
  ])('an authorizing agreement that is %s refuses the charge (requireSignedContractId)', async (_label, contract) => {
    const { StripeService, stripeClient } = load({ visit: heldVisit, contract });

    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { ...installationGuards, requireSignedContractId: 'contract-1' }))
      .rejects.toMatchObject({ code: 'CONTRACT_NOT_SIGNED' });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });
});
