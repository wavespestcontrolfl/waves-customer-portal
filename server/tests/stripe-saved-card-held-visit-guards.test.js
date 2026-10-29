// chargeInvoiceWithSavedCard's locked guards added for the termite annual
// plan charged after installation (GitHub Codex #5816 r4): a held visit paid
// another way, and an authorizing agreement that is no longer signed, both
// refuse inside the charge transaction, before Stripe. Same mock shape as the
// requireHeldTermId case in stripe-saved-card-quote.test.js.
describe('chargeInvoiceWithSavedCard — held-visit and signed-agreement guards', () => {
  beforeEach(() => { jest.resetModules(); });

  function load({ visit, contract, appliedMarker = null, record = { status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'completed' }) } }) {
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
        if (table === 'service_records') return record;
        if (table === 'annual_prepay_terms') return { status: 'payment_pending', prepay_invoice_id: 'inv-1' };
        if (table === 'customer_contracts') return contract;
        // Only the applied-prepayment marker lookup (it binds 'scheduled_service_prepaid') sees the marker.
        if (table === 'payments') return markerLookup ? appliedMarker : null;
        return null;
      });
      let markerLookup = false;
      const plainWhereRaw = chain.whereRaw;
      chain.whereRaw = jest.fn((sql, bindings) => {
        if (Array.isArray(bindings) && bindings.includes('scheduled_service_prepaid')) markerLookup = true;
        return plainWhereRaw(sql, bindings);
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

  // requirePerformedVisit reads the visit's latest record under the visit lock (closeoutPerformedForCharge). The one opt-in
  // exception, allowIssuedInvoiceCloseoutFor (the Auto Pay hold charge): the issued-invoice closeout job's own record for
  // THIS invoice counts as performed. Everything else refuses exactly as before.
  describe('requirePerformedVisit and allowIssuedInvoiceCloseoutFor', () => {
    const performedGuards = { requireSelfPayScheduledServiceId: 'svc-1', requireCompletedVisit: true, requirePerformedVisit: true };
    const notes = (fields) => ({ status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'completed', ...fields }) });
    const closeoutFor = (invoiceId) => notes({ backfill: true, invoiceAlreadySent: true, issuedInvoiceCloseout: { invoiceId, trigger: 'sent', completedAt: '2026-10-29T14:00:00.000Z' } });
    const refused = async (record, opts) => {
      const { StripeService, stripeClient } = load({ visit: heldVisit, contract: null, record });
      await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { ...performedGuards, ...opts }))
        .rejects.toMatchObject({ code: 'VISIT_NOT_COMPLETED', message: expect.stringContaining('not a performed visit') });
      expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    };
    const proceeds = async (record, opts) => {
      const { StripeService, stripeClient } = load({ visit: heldVisit, contract: null, record });
      await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { ...performedGuards, ...opts }))
        .rejects.not.toMatchObject({ code: 'VISIT_NOT_COMPLETED' });
      expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
    };

    test.each([
      ['a backfill closeout', notes({ backfill: true })],
      ['an issued-invoice closeout, without the option', closeoutFor('inv-1')],
      ['inspection_only', notes({ visitOutcome: 'inspection_only' })],
      ['customer_declined', notes({ visitOutcome: 'customer_declined' })],
      ['incomplete', notes({ visitOutcome: 'incomplete' })],
      ['a record that is not completed', { status: 'in_progress', structured_notes: '{}' }],
      ['no record', null],
    ])('%s refuses, unchanged', async (_label, record) => {
      await refused(record, {});
    });

    test('a performed closeout is charged, unchanged', async () => {
      await proceeds(notes({}), {});
    });

    test('the option lets the issued-invoice closeout of THIS invoice count as performed', async () => {
      await proceeds(closeoutFor('inv-1'), { allowIssuedInvoiceCloseoutFor: 'inv-1' });
    });

    test.each([
      ['a manual backfill with no marker', notes({ backfill: true })],
      ['a marker naming another invoice', closeoutFor('inv-9')],
      ['a marked closeout whose outcome is inspection_only', { status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'inspection_only', backfill: true, issuedInvoiceCloseout: { invoiceId: 'inv-1' } }) }],
    ])('with the option, %s still refuses', async (_label, record) => {
      await refused(record, { allowIssuedInvoiceCloseoutFor: 'inv-1' });
    });

    test('the option names the invoice being charged: another invoice id never widens the rule', async () => {
      await refused(closeoutFor('inv-9'), { allowIssuedInvoiceCloseoutFor: 'inv-9' });
    });
  });

  // requireNoUnappliedVisitPrepayment (the Auto Pay hold charge, every lane): billing-lane visitCarriesUnappliedPrepayment
  // under the visit lock, the same predicate the extended anchor check uses.
  describe('requireNoUnappliedVisitPrepayment', () => {
    const guards = { requireSelfPayScheduledServiceId: 'svc-1', requireCompletedVisit: true };
    const prepaidVisit = { ...heldVisit, prepaid_method: 'cash', prepaid_amount: '40.00' };

    test('a cash prepayment on the visit that no payment marker applied to this invoice refuses before Stripe', async () => {
      const { StripeService, stripeClient } = load({ visit: prepaidVisit, contract: null });
      await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { ...guards, requireNoUnappliedVisitPrepayment: true }))
        .rejects.toMatchObject({ code: 'UNAPPLIED_VISIT_PREPAYMENT' });
      expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    });

    test.each([
      ['the option is off (every other caller)', prepaidVisit, null, false],
      ['the prepayment was applied to this invoice (marker payment)', prepaidVisit, { id: 'pay-1' }, true],
      ['the stamp is the annual-prepay invoice marker', { ...heldVisit, prepaid_method: 'annual_prepay_invoice', prepaid_amount: '40.00' }, null, true],
      ['no prepayment amount', { ...heldVisit, prepaid_method: 'cash', prepaid_amount: null }, null, true],
    ])('%s: the charge proceeds to Stripe', async (_label, visit, appliedMarker, option) => {
      const { StripeService, stripeClient } = load({ visit, contract: null, appliedMarker });
      await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { ...guards, requireNoUnappliedVisitPrepayment: option }))
        .rejects.not.toMatchObject({ code: 'UNAPPLIED_VISIT_PREPAYMENT' });
      expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
    });
  });
});
