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
  function load({ methodType = 'card', intent }) {
    jest.resetModules();
    const state = { inserted: null, attempt: null };
    const invoice = { id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', status: 'sent', subtotal: '100.00', total: '100.00',
      discount_amount: '0.00', credit_applied: '0.00', payer_id: null, stripe_payment_intent_id: null };
    const method = { id: 'pm-1', customer_id: 'cust-1', method_type: methodType, processor: 'stripe', stripe_payment_method_id: 'pm_stripe_1',
      card_funding: methodType === 'card' ? 'debit' : null, ach_status: methodType === 'card' ? null : 'verified', last_four: '4242' };
    // Permissive: every read the charge path makes resolves, and the rows it writes are captured.
    const db = jest.fn((table) => {
      const chain = {};
      for (const name of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereColumn', 'forUpdate',
        'orderBy', 'select', 'andWhere', 'whereExists', 'leftJoin', 'join', 'limit', 'modify', 'skipLocked']) {
        chain[name] = jest.fn((arg) => { if (name === 'where' && typeof arg === 'function') arg.call(chain); return chain; });
      }
      chain.first = jest.fn(async () => ({ invoices: invoice, payment_methods: method, customers: { id: 'cust-1', stripe_customer_id: 'cus-1' },
        stripe_invoice_charge_attempts: state.attempt }[table] || null));
      chain.insert = jest.fn((payload) => {
        if (table === 'stripe_invoice_charge_attempts') state.attempt = { ...payload, id: 'att-1', created_at: new Date(), resolved_at: null };
        if (table === 'payments') state.inserted = payload;
        return chain;
      });
      chain.returning = jest.fn(async () => (table === 'payments' ? [{ id: 'pay-1', ...state.inserted }] : [state.attempt || { id: 'row-1' }]));
      chain.update = jest.fn(async (payload) => { if (table === 'stripe_invoice_charge_attempts' && state.attempt) Object.assign(state.attempt, payload); return 1; });
      chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return chain;
    });
    db.transaction = jest.fn(async (callback) => callback(db));
    db.fn = { now: jest.fn(() => 'NOW') };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    db.schema = { hasTable: jest.fn(async () => false), hasColumn: jest.fn(async () => false) };
    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => ({ paymentIntents: { retrieve: jest.fn(), cancel: jest.fn(), create: jest.fn(async () => intent) },
      paymentMethods: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() } })));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: false } }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    return { StripeService: require('../services/stripe'), state };
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
});
