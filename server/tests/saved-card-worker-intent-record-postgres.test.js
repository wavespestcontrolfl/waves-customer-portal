// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or a local disposable database.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../config/stripe-config', () => ({ secretKey: null }));
const { randomUUID } = require('node:crypto');

postgres('saved-card worker payment and verified cancellation records (PostgreSQL)', () => {
  let database;
  let trx;
  let stripeService;
  let authentication;
  let customerId;
  let invoiceId;
  let attemptId;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local or CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    stripeService = require('../services/stripe');
    authentication = require('../services/invoice-payment-authentication');
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    invoiceId = randomUUID();
    attemptId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    await trx('invoices').insert({ id: invoiceId, customer_id: customerId, invoice_number: `S1-${invoiceId.slice(0, 12)}`,
      token: randomUUID(), status: 'processing', subtotal: 100, total: 100, line_items: '[]' });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function insertAttempt(fields = {}) {
    await trx('stripe_invoice_charge_attempts').insert({ id: attemptId, invoice_id: invoiceId,
      stripe_payment_method_id: 'pm_saved', idempotency_key: attemptId, status: 'claimed', ...fields });
  }
  const attemptRow = () => trx('stripe_invoice_charge_attempts').where({ id: attemptId }).first();
  const canceledIntent = (id, extra = {}) => ({
    id,
    status: 'canceled',
    payment_method: 'pm_saved',
    metadata: { source: 'admin_card_on_file', waves_invoice_id: invoiceId, waves_customer_id: customerId, saved_card_attempt_id: attemptId },
    ...extra,
  });
  const awaiting = async () => (await authentication.whereAwaitingAuthentication(
    trx('stripe_invoice_charge_attempts').where({ id: attemptId }), 'stripe_invoice_charge_attempts',
  ).first('id'))?.id === attemptId;

  test('the worker records the PaymentIntent its own create returned, once', async () => {
    await insertAttempt();
    await stripeService.markInvoiceSavedCardChargeAttempt(attemptId, { status: 'ambiguous', stripe_payment_intent_id: 'pi_worker', resolved_at: null });
    expect(await attemptRow()).toMatchObject({ status: 'ambiguous', stripe_payment_intent_id: 'pi_worker', worker_payment_intent_id: 'pi_worker' });
    await stripeService.markInvoiceSavedCardChargeAttempt(attemptId, { stripe_payment_intent_id: 'pi_worker' });
    await expect(stripeService.markInvoiceSavedCardChargeAttempt(attemptId, { status: 'claimed', resolved_at: null }))
      .resolves.toBeUndefined();
    expect((await attemptRow()).worker_payment_intent_id).toBe('pi_worker');
  });

  test('a later write never replaces the worker PaymentIntent already recorded', async () => {
    await insertAttempt({ worker_payment_intent_id: 'pi_first' });
    await stripeService.markInvoiceSavedCardChargeAttempt(attemptId, { stripe_payment_intent_id: 'pi_second' });
    expect(await attemptRow()).toMatchObject({ worker_payment_intent_id: 'pi_first', stripe_payment_intent_id: 'pi_second' });
  });

  test('a webhook that already closed the attempt on the same PaymentIntent gains the worker ID; a different one does not', async () => {
    await insertAttempt({ status: 'failed', stripe_payment_intent_id: 'pi_webhook', resolved_at: new Date() });
    await stripeService.markInvoiceSavedCardChargeAttempt(attemptId, { status: 'ambiguous', stripe_payment_intent_id: 'pi_webhook', resolved_at: null });
    expect(await attemptRow()).toMatchObject({ status: 'failed', stripe_payment_intent_id: 'pi_webhook', worker_payment_intent_id: 'pi_webhook' });

    await trx('stripe_invoice_charge_attempts').where({ id: attemptId }).update({ worker_payment_intent_id: null, stripe_payment_intent_id: 'pi_webhook_only' });
    await expect(stripeService.markInvoiceSavedCardChargeAttempt(attemptId, { status: 'ambiguous', stripe_payment_intent_id: 'pi_other', resolved_at: null }))
      .rejects.toMatchObject({ code: 'STRIPE_CHARGE_ATTEMPT_FENCE_LOST' });
    expect(await attemptRow()).toMatchObject({ stripe_payment_intent_id: 'pi_webhook_only', worker_payment_intent_id: null });
  });

  test('the submission marker and the ambiguous timeout record the canceled checkout and the timeout time', async () => {
    await insertAttempt();
    await stripeService.commitInvoiceSavedCardChargeSubmission({
      attemptId, amount: 42.5, creditAppliedDelta: 0, creditAppliedTotal: 0, canceledCheckoutPaymentIntentId: 'pi_checkout_old', database: trx,
    });
    expect(await attemptRow()).toMatchObject({ canceled_checkout_payment_intent_id: 'pi_checkout_old' });
    await stripeService.markInvoiceSavedCardChargeAttempt(attemptId, { status: 'ambiguous', worker_create_timed_out_at: new Date(), resolved_at: null });
    expect((await attemptRow()).worker_create_timed_out_at).toBeInstanceOf(Date);
  });

  test('an authentication-required decline records the worker PaymentIntent and keeps the hold', async () => {
    await insertAttempt();
    await expect(stripeService.resolveNoFundsSavedCardChargeAttempt({
      attemptId, invoiceId, failureMessage: 'authentication required', declineCode: 'authentication_required',
      authenticationIntentId: 'pi_authentication',
    })).resolves.toMatchObject({ resolved: true });
    expect(await attemptRow()).toMatchObject({
      status: 'failed', decline_code: 'authentication_required',
      stripe_payment_intent_id: null, worker_payment_intent_id: 'pi_authentication',
    });
    expect(await awaiting()).toBe(true);
    // The termite renewal reads a non-null stripe_payment_intent_id as "presented to the
    // customer"; recording the worker's PaymentIntent must not make a decline look presented.
    const { whereAttemptPresented } = require('../services/termite-annual-renewal-charge')._private;
    const presented = await whereAttemptPresented(trx('stripe_invoice_charge_attempts as a').where('a.id', attemptId)).first('a.id');
    expect(presented).toBeUndefined();
  });

  test('a webhook that closed the decline first still gets the worker PaymentIntent, without a PI of its own replaced', async () => {
    await insertAttempt({ status: 'failed', decline_code: 'authentication_required', resolved_at: new Date(), stripe_payment_intent_id: 'pi_webhook' });
    await stripeService.resolveNoFundsSavedCardChargeAttempt({
      attemptId, invoiceId, failureMessage: 'authentication required', declineCode: 'authentication_required',
      authenticationIntentId: 'pi_authentication',
    });
    expect(await attemptRow()).toMatchObject({ stripe_payment_intent_id: 'pi_webhook', worker_payment_intent_id: 'pi_authentication' });
    // The two identities differ, so the hold stays until reconciliation.
    expect(await awaiting()).toBe(true);
  });

  test('a signed cancellation is recorded on the exact attempt and releases nothing', async () => {
    await insertAttempt({ status: 'failed', decline_code: 'authentication_required', resolved_at: new Date(),
      stripe_payment_intent_id: 'pi_auth', worker_payment_intent_id: 'pi_auth' });
    expect(await awaiting()).toBe(true);
    await authentication.recordAuthenticationCancellation(canceledIntent('pi_auth'), require('../models/db'));
    expect(await attemptRow()).toMatchObject({ authentication_canceled_intent_id: 'pi_auth', status: 'failed' });
    expect(await trx('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'processing' });
    // Record only: the cancellation, worker and provider IDs agree, so the predicate itself reads it as cleared.
    expect(await awaiting()).toBe(false);
  });

  test('control: the fixture itself accepts an exact cancellation', async () => {
    await insertAttempt({ status: 'ambiguous' });
    await authentication.recordAuthenticationCancellation(canceledIntent('pi_auth'), require('../models/db'));
    expect((await attemptRow()).authentication_canceled_intent_id).toBe('pi_auth');
  });

  // Each intent is built inside the test, after beforeEach assigned the fixture IDs,
  // so every case fails on its own field and not on UUID validation.
  const withMetadata = (patch) => (intent) => ({ ...intent, metadata: { ...intent.metadata, ...patch } });
  test.each([
    ['another PaymentIntent already bound by the worker', { worker_payment_intent_id: 'pi_other' }, (intent) => intent],
    ['another card', {}, (intent) => ({ ...intent, payment_method: 'pm_other' })],
    ['a different attempt', {}, withMetadata({ saved_card_attempt_id: randomUUID() })],
    ['a PaymentIntent that is not canceled', {}, (intent) => ({ ...intent, status: 'requires_action' })],
    ['an intent from another source', {}, withMetadata({ source: 'pay_page' })],
  ])('a cancellation for %s records nothing', async (_label, fields, override) => {
    await insertAttempt({ status: 'ambiguous', ...fields });
    await authentication.recordAuthenticationCancellation(override(canceledIntent('pi_auth')), require('../models/db'));
    expect((await attemptRow()).authentication_canceled_intent_id).toBeNull();
  });

  test('a cancellation that arrives before the worker binds is kept as a candidate, and the hold stays until the worker names the same PaymentIntent', async () => {
    await insertAttempt({ status: 'failed', decline_code: 'authentication_required', resolved_at: new Date() });
    await authentication.recordAuthenticationCancellation(canceledIntent('pi_early'), require('../models/db'));
    expect(await attemptRow()).toMatchObject({ authentication_canceled_intent_id: 'pi_early', worker_payment_intent_id: null });
    expect(await awaiting()).toBe(true);
  });

  test('a cancellation recorded after the invoice changed owner follows only a proven merge', async () => {
    const otherCustomer = randomUUID();
    await trx('customers').insert({ id: otherCustomer, first_name: 'Synthetic', last_name: 'Other',
      email: `${otherCustomer}@example.invalid`, phone: `fixture-${otherCustomer.slice(0, 8)}`,
      address_line1: '200 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    await insertAttempt({ status: 'ambiguous' });
    await trx('invoices').where({ id: invoiceId }).update({ customer_id: otherCustomer });
    await authentication.recordAuthenticationCancellation(canceledIntent('pi_auth'), require('../models/db'));
    expect((await attemptRow()).authentication_canceled_intent_id).toBeNull();
  });

  test('the five migrations add their columns to the attempts table', async () => {
    const columns = await trx.raw(`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stripe_invoice_charge_attempts' AND column_name = ANY(?)`, [[
      'authentication_canceled_intent_id', 'canceled_checkout_payment_intent_id', 'stripe_payment_intent_bound_at',
      'worker_payment_intent_id', 'worker_create_timed_out_at']]);
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'authentication_canceled_intent_id', 'canceled_checkout_payment_intent_id', 'stripe_payment_intent_bound_at',
      'worker_create_timed_out_at', 'worker_payment_intent_id',
    ]);
  });
});
