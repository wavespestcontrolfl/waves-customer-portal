/**
 * StripeService.charge records when a synchronous success settled
 * (Codex #4996 r14). Readers date Stripe money only by the settlement moment
 * its writer stamps from Stripe, so a charge that succeeds in-request must
 * carry one instead of waiting on the succeeded webhook, which can race the
 * insert and miss it. An off-session intent is created, confirmed and charged
 * in one request, so its own creation is that moment — including for an
 * idempotent replay of an intent that succeeded earlier.
 */
describe('StripeService.charge settlement moment', () => {
  let inserted;
  let stripeClient;

  function load({ methodType = 'card', intent }) {
    jest.resetModules();
    inserted = null;
    const customer = { id: 'cust-1', stripe_customer_id: 'cus_1', autopay_payment_method_id: 'pm-1', ach_status: null };
    const method = { id: 'pm-1', customer_id: 'cust-1', processor: 'stripe', autopay_enabled: true, stripe_payment_method_id: 'pm_stripe_1',
      method_type: methodType, card_brand: methodType === 'card' ? 'visa' : null, card_funding: methodType === 'card' ? 'debit' : null,
      exp_month: '12', exp_year: '2035', ach_status: methodType === 'card' ? null : 'verified' };
    const query = (table) => {
      const chain = {};
      for (const name of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'whereRaw', 'orderBy']) chain[name] = jest.fn(() => chain);
      chain.first = jest.fn(async () => ({ customers: customer, payment_methods: method }[table] || null));
      chain.update = jest.fn(async () => 1);
      chain.insert = jest.fn((payload) => {
        if (table === 'payments') inserted = payload;
        return { returning: jest.fn(async () => [{ id: 'pay-1', ...payload }]) };
      });
      return chain;
    };
    const db = jest.fn(query);
    db.transaction = jest.fn(async (callback) => {
      const trx = jest.fn(query);
      trx.raw = jest.fn(async () => undefined);
      return callback(trx);
    });
    db.raw = jest.fn();
    stripeClient = { paymentIntents: { create: jest.fn(async () => intent) }, paymentMethods: { retrieve: jest.fn() } };
    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const StripeService = require('../services/stripe');
    jest.spyOn(StripeService, 'ensureStripeCustomer').mockResolvedValue('cus_1');
    return StripeService;
  }

  const succeededAt = 1789900000; // an intent that succeeded well before this run (a replay)

  test('a card charge that succeeded in-request carries the intent\'s own time as its settlement moment', async () => {
    const StripeService = load({ intent: { id: 'pi_1', status: 'succeeded', created: succeededAt, latest_charge: { id: 'ch_1', receipt_url: null } } });
    await StripeService.charge('cust-1', 89, 'WaveGuard Monthly', { billed_month: '2026-09' }, 'autopay_monthly_cust-1_2026-09');

    expect(inserted).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_1' });
    expect(JSON.parse(inserted.metadata)).toMatchObject({ billed_month: '2026-09', settled_event_at: new Date(succeededAt * 1000).toISOString() });
  });

  test('a bank charge still processing carries none — the succeeded webhook stamps it as it clears', async () => {
    const StripeService = load({ methodType: 'us_bank_account',
      intent: { id: 'pi_2', status: 'processing', created: succeededAt, latest_charge: { id: 'ch_2', receipt_url: null } } });
    await StripeService.charge('cust-1', 89, 'WaveGuard Monthly', {}, 'autopay_monthly_cust-1_2026-09');

    expect(inserted).toMatchObject({ status: 'processing' });
    expect(JSON.parse(inserted.metadata)).not.toHaveProperty('settled_event_at');
  });
});

// The saved-card invoice charge takes no PaymentIntent advisory lock, so the
// succeeded webhook can race it past the row it records (Codex #4996 r14).
describe('StripeService.chargeInvoiceWithSavedCard settlement moment', () => {
  function load({ methodType = 'card', intent, autoCredit = 0, creditError = null,
    checkoutIntent = null, cancelResult = null, submissionError = null }) {
    jest.resetModules();
    const state = { inserted: null, attempt: null, createObservedAttempt: null };
    const invoice = { id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', status: 'sent', subtotal: '100.00', total: '100.00',
      discount_amount: '0.00', credit_applied: '0.00', payer_id: null, stripe_payment_intent_id: checkoutIntent?.id || null };
    const method = { id: 'pm-1', customer_id: 'cust-1', method_type: methodType, processor: 'stripe', stripe_payment_method_id: 'pm_stripe_1',
      card_funding: methodType === 'card' ? 'debit' : null, ach_status: methodType === 'card' ? null : 'verified', last_four: '4242' };
    // Permissive: every read the charge path makes resolves, and the rows it writes are captured.
    const db = jest.fn((table) => {
      const chain = {};
      for (const name of ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereNull', 'orWhereColumn', 'forUpdate',
        'orderBy', 'orderByRaw', 'select', 'andWhere', 'whereExists', 'leftJoin', 'join', 'limit', 'modify', 'skipLocked']) {
        chain[name] = jest.fn((arg) => { if (['where', 'orWhere'].includes(name) && typeof arg === 'function') arg.call(chain, chain); return chain; });
      }
      chain.first = jest.fn(async () => ({ invoices: invoice, payment_methods: method, customers: { id: 'cust-1', stripe_customer_id: 'cus-1' },
        stripe_invoice_charge_attempts: state.attempt }[table] || null));
      chain.insert = jest.fn((payload) => {
        if (table === 'stripe_invoice_charge_attempts') state.attempt = { ...payload, id: 'att-1', created_at: new Date(), resolved_at: null };
        if (table === 'payments') state.inserted = payload;
        return chain;
      });
      chain.returning = jest.fn(async () => (table === 'payments' ? [{ id: 'pay-1', ...state.inserted }] : [state.attempt || { id: 'row-1' }]));
      chain.update = jest.fn(async (payload) => {
        if (table === 'stripe_invoice_charge_attempts' && state.attempt) {
          if (payload.submitted_at && submissionError) throw submissionError;
          Object.assign(state.attempt, payload);
        }
        return 1;
      });
      chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return chain;
    });
    db.transaction = jest.fn(async (callback) => callback(db));
    db.fn = { now: jest.fn(() => 'NOW') };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    db.schema = { hasTable: jest.fn(async () => false), hasColumn: jest.fn(async () => false) };
    jest.doMock('../models/db', () => db);
    const stripeClient = { paymentIntents: {
      retrieve: jest.fn(async () => checkoutIntent),
      cancel: jest.fn(async () => cancelResult),
      create: jest.fn(async () => {
        state.createObservedAttempt = { ...state.attempt };
        return intent;
      }),
    },
      paymentMethods: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() } };
    const applyAccountCreditToInvoice = jest.fn(async (options) => {
      if (creditError) throw creditError;
      invoice.credit_applied = String(autoCredit);
      return { applied: autoCredit, fullyCovered: false, options };
    });
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: autoCredit > 0 } }));
    jest.doMock('../services/customer-credit', () => ({
      customerAutoApplyEnabled: jest.fn(async () => autoCredit > 0),
      applyAccountCreditToInvoice,
    }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    return { StripeService: require('../services/stripe'), state, stripeClient, applyAccountCreditToInvoice };
  }
  const succeededAt = 1789900000;

  test('a card charge that succeeded in-request carries the intent\'s own time as its settlement moment', async () => {
    const { StripeService, state } = load({ intent: { id: 'pi_saved', status: 'succeeded', created: succeededAt, latest_charge: 'ch_saved' } });
    await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1');

    expect(state.inserted).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_saved' });
    expect(JSON.parse(state.inserted.metadata)).toMatchObject({ source: 'admin_card_on_file', settled_event_at: new Date(succeededAt * 1000).toISOString() });
  });

  test('a bank charge still processing carries none', async () => {
    const { StripeService, state } = load({ methodType: 'us_bank_account',
      intent: { id: 'pi_saved_bank', status: 'processing', created: succeededAt, latest_charge: 'ch_saved_bank' } });
    await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1');

    expect(state.inserted).toMatchObject({ status: 'processing' });
    expect(JSON.parse(state.inserted.metadata)).not.toHaveProperty('settled_event_at');
  });

  test('the saved-card charge excludes only its own claim and still applies ordinary account credit', async () => {
    const { StripeService, stripeClient, applyAccountCreditToInvoice } = load({
      autoCredit: 25,
      intent: { id: 'pi_saved_credit', status: 'succeeded', created: succeededAt, latest_charge: 'ch_saved_credit' },
    });

    await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1');

    expect(applyAccountCreditToInvoice).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      currentChargeAttemptId: 'att-1',
    }, expect.any(Function));
    expect(stripeClient.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7500 }),
      expect.any(Object),
    );
  });

  test('a competing potentially settling payment aborts the claimed charge before Stripe', async () => {
    const conflict = Object.assign(new Error('older card payment can still settle'), {
      code: 'STRIPE_CHARGE_IN_PROGRESS',
      statusCode: 409,
      savedCardPending: true,
    });
    const { StripeService, stripeClient } = load({
      autoCredit: 25,
      creditError: conflict,
      intent: { id: 'pi_must_not_run', status: 'succeeded', created: succeededAt, latest_charge: 'ch_must_not_run' },
    });

    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1'))
      .rejects.toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS' });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('a verified checkout cancellation is durably bound to the attempt before its replacement is submitted', async () => {
    const checkoutIntent = { id: 'pi_checkout_old', status: 'requires_payment_method' };
    const { StripeService, state, stripeClient } = load({
      checkoutIntent,
      cancelResult: { id: checkoutIntent.id, status: 'canceled' },
      intent: { id: 'pi_saved_replacement', status: 'succeeded', created: succeededAt, latest_charge: 'ch_saved_replacement' },
    });

    await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1');

    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith(checkoutIntent.id);
    expect(state.createObservedAttempt).toMatchObject({
      canceled_checkout_payment_intent_id: checkoutIntent.id,
      amount: 100,
      submitted_at: expect.any(Date),
    });
  });

  test('an exact checkout retrieve already proving canceled is saved without another cancellation call', async () => {
    const checkoutIntent = { id: 'pi_checkout_old', status: 'canceled' };
    const { StripeService, state, stripeClient } = load({
      checkoutIntent,
      intent: { id: 'pi_saved_replacement', status: 'succeeded', created: succeededAt, latest_charge: 'ch_saved_replacement' },
    });

    await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1');

    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(state.createObservedAttempt).toMatchObject({
      canceled_checkout_payment_intent_id: checkoutIntent.id,
      submitted_at: expect.any(Date),
    });
  });

  test('a retrieve response for a different intent cannot authorize a replacement', async () => {
    const { StripeService, state, stripeClient } = load({
      checkoutIntent: { id: 'pi_checkout_old', status: 'requires_payment_method' },
      intent: { id: 'pi_must_not_submit', status: 'succeeded', created: succeededAt, latest_charge: 'ch_must_not_submit' },
    });
    stripeClient.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_checkout_other', status: 'canceled' });

    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1'))
      .rejects.toThrow('Could not verify the previous payment for this invoice');
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(state.attempt?.submitted_at).toBeFalsy();
  });

  test.each([
    ['no cancellation result', null],
    ['a different intent', { id: 'pi_checkout_other', status: 'canceled' }],
    ['a non-canceled result', { id: 'pi_checkout_old', status: 'requires_payment_method' }],
  ])('does not submit the replacement when Stripe returns %s', async (_description, cancelResult) => {
    const checkoutIntent = { id: 'pi_checkout_old', status: 'requires_payment_method' };
    const { StripeService, state, stripeClient } = load({
      checkoutIntent,
      cancelResult,
      intent: { id: 'pi_must_not_submit', status: 'succeeded', created: succeededAt, latest_charge: 'ch_must_not_submit' },
    });

    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1'))
      .rejects.toThrow('Could not verify the previous checkout was canceled');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(state.attempt?.submitted_at).toBeFalsy();
    expect(state.attempt?.canceled_checkout_payment_intent_id).toBeFalsy();
  });

  test('a failed durable evidence write prevents replacement submission', async () => {
    const checkoutIntent = { id: 'pi_checkout_old', status: 'requires_payment_method' };
    const { StripeService, stripeClient } = load({
      checkoutIntent,
      cancelResult: { id: checkoutIntent.id, status: 'canceled' },
      submissionError: new Error('attempt update failed'),
      intent: { id: 'pi_must_not_submit', status: 'succeeded', created: succeededAt, latest_charge: 'ch_must_not_submit' },
    });

    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1'))
      .rejects.toThrow('attempt update failed');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });
});
