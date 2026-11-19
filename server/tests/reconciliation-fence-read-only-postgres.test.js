// assertNoInvoiceChargeReconciliationPending({ readOnly: true }): the
// customer-dunning resolver and its dry-run read the pay page's sibling set
// inside a READ ONLY transaction. The writing fence releases or promotes
// stale saved-card claims; in a read-only transaction that UPDATE aborts the
// transaction (pre-push audit P1). Read-only mode must reach a verdict without
// writing, and must never conclude "released": a stale pre-submit claim's
// worker can still commit its submission, so it stays fenced (in progress). Runs in a disposable schema on a private QA / isolated CI
// database (skipped without APP_TEST_DATABASE_URL, run for real in CI).
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20261119081500_saved_card_authentication_cancellation');
const { recordAuthenticationCancellation, verifySavedCardCancellation } = require('../services/invoice-payment-authentication');
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => null) }));
jest.mock('../services/completion-balance-sweep', () => ({ dunningStoppedInvoiceIds: jest.fn(async () => new Set()) }));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}) }));

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `recon_fence_${randomUUID().replaceAll('-', '')}`;

postgres('reconciliation fence read-only mode (PostgreSQL)', () => {
  let admin;
  let app;
  let StripeService;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await app.schema.createTable('invoices', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id');
      t.string('status');
      t.string('invoice_number');
      t.decimal('total');
      t.string('stripe_payment_intent_id');
    });
    await app.schema.createTable('stripe_invoice_charge_attempts', (t) => {
      t.uuid('id').primary();
      t.uuid('invoice_id');
      t.uuid('payment_method_id');
      t.string('status');
      t.string('stripe_payment_intent_id');
      t.string('idempotency_key');
      t.string('decline_code');
      t.string('stripe_payment_method_id');
      t.text('error_message');
      t.timestamp('submitted_at');
      t.timestamp('resolved_at');
      t.timestamp('created_at');
      t.timestamp('updated_at');
    });
    await app.schema.createTable('stripe_orphan_charges', (t) => {
      t.uuid('invoice_id');
      t.boolean('resolved');
      t.string('stripe_payment_intent_id');
    });
    await app.schema.createTable('payments', (t) => {
      t.uuid('id').primary();
      t.string('status');
      t.string('stripe_payment_intent_id');
      t.jsonb('metadata');
      t.uuid('superseded_by_payment_id');
    });
    await app.schema.createTable('stripe_webhook_events', (t) => {
      t.string('event_type');
      t.boolean('processed');
      t.jsonb('payload');
    });
    await migration.up(app);
    StripeService = require('../services/stripe');
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  async function staleClaim({ submitted }) {
    const invoiceId = randomUUID();
    const id = randomUUID();
    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    await app('stripe_invoice_charge_attempts').insert({
      id, invoice_id: invoiceId, status: 'claimed', idempotency_key: `inv_card_on_file_${invoiceId}_${id}`,
      submitted_at: submitted ? staleAt : null, created_at: staleAt, updated_at: staleAt,
    });
    return { invoiceId, id };
  }

  async function inReadOnly(fn) {
    const trx = await app.transaction();
    try {
      await trx.raw('SET TRANSACTION READ ONLY');
      const out = await fn(trx);
      await trx.raw('SELECT 1'); // still usable after the fence ran
      return out;
    } finally {
      await trx.rollback().catch(() => {});
    }
  }

  const verdict = (invoiceId, database, opts) => StripeService
    .assertNoInvoiceChargeReconciliationPending(invoiceId, database, opts)
    .then(() => null, (e) => e);

  async function authenticationFixture(conn, customerId = randomUUID()) {
    const invoiceId = randomUUID();
    const attemptId = randomUUID();
    const intent = {
      id: `pi_${attemptId.replaceAll('-', '')}`, status: 'canceled', payment_method: 'pm_synthetic',
      metadata: { source: 'admin_card_on_file', saved_card_attempt_id: attemptId, waves_invoice_id: invoiceId, waves_customer_id: customerId },
    };
    await conn('invoices').insert({ id: invoiceId, customer_id: customerId, status: 'sent', invoice_number: invoiceId, total: 25 });
    await conn('stripe_invoice_charge_attempts').insert({
      id: attemptId, invoice_id: invoiceId, stripe_payment_method_id: intent.payment_method, created_at: new Date(),
      status: 'failed', decline_code: 'authentication_required', resolved_at: new Date(),
    });
    return { invoiceId, attemptId, intent, customerId };
  }

  async function commitWithWaitingCheckout(charge, checkout) {
    let identifyConnection;
    const connectionReady = new Promise((resolve) => { identifyConnection = resolve; });
    const operation = app.transaction(async (trx) => {
      const { rows: [connection] } = await trx.raw('SELECT pg_backend_pid() AS pid');
      identifyConnection(connection.pid);
      await checkout(trx);
    });
    const outcome = operation.then(() => null, (err) => err);
    // A refusal against the old, already-visible claim could look identical.
    // Observe this checkout blocked on the other backend before committing.
    const waitingPid = await connectionReady;
    const deadline = Date.now() + 5000;
    while (true) {
      const { rows: [lock] } = await charge.raw(
        'SELECT pg_backend_pid() = ANY(pg_blocking_pids(?::int)) AS blocked', [waitingPid],
      );
      if (lock.blocked) break;
      if (Date.now() >= deadline) throw new Error('Checkout did not wait for the invoice lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await charge.commit();
    return outcome;
  }

  test('an older authenticating attempt outranks a releasable stale claim until its own cancellation', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    const staleId = randomUUID();
    await app('stripe_invoice_charge_attempts').insert({
      id: staleId, invoice_id: invoiceId, status: 'claimed', created_at: new Date(Date.now() - 600_000),
    });
    await recordAuthenticationCancellation({ ...intent, status: 'processing' }, app);
    await recordAuthenticationCancellation({ ...intent, payment_method: 'pm_different' }, app);
    await recordAuthenticationCancellation({ ...intent, metadata: { ...intent.metadata, saved_card_attempt_id: staleId } }, app);
    expect(await inReadOnly((trx) => verdict(invoiceId, trx, { readOnly: true, checkout: true })))
      .toMatchObject({ chargeAttemptId: attemptId, statusCode: 409, savedCardPending: true });
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    expect((await app('stripe_invoice_charge_attempts').where({ id: staleId }).first()).status).toBe('claimed');
    await recordAuthenticationCancellation(intent, app);
    await recordAuthenticationCancellation(intent, app);
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
  });

  test('an early cancellation only clears the same intent when the decline is recorded later', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });
    await attempt().update({ status: 'claimed', decline_code: null, resolved_at: null });
    await recordAuthenticationCancellation({ ...intent, payment_method: null }, app);
    expect(await attempt().first()).toMatchObject({ authentication_canceled_intent_id: intent.id, stripe_payment_intent_id: null });
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS' });
    await StripeService.resolveNoFundsSavedCardChargeAttempt({
      database: app, invoiceId, attemptId, failureMessage: 'Card verification required',
      declineCode: 'authentication_required', authenticationIntentId: intent.id,
    });
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
    await attempt().update({ stripe_payment_intent_id: 'pi_different' });
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    expect(await verdict(invoiceId, app)).toBeNull(); // settlement of existing money still runs
    await recordAuthenticationCancellation({ ...intent, id: 'pi_different' }, app);
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
  });

  test('migration recovers only exact processed cancellations and retains them after event expiry', async () => {
    await app.transaction(async (trx) => {
      await migration.down(trx);
      const cleared = await authenticationFixture(trx);
      const blocked = await authenticationFixture(trx);
      const event = (pi, processed = true) => ({
        event_type: 'payment_intent.canceled', processed, payload: JSON.stringify({ object: pi }),
      });
      await trx('stripe_webhook_events').insert([
        event(cleared.intent), event(blocked.intent, false),
        event({ ...blocked.intent, metadata: { ...blocked.intent.metadata, waves_customer_id: cleared.customerId } }),
      ]);
      await migration.up(trx);
      await trx('stripe_webhook_events').del();
      expect(await verdict(cleared.invoiceId, trx, { checkout: true })).toBeNull();
      expect(await verdict(blocked.invoiceId, trx, { checkout: true })).toMatchObject({ chargeAttemptId: blocked.attemptId });
    });
  });

  test('an operator can preview and record one old cancellation without a retained webhook or a stored PI', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    const stripe = { paymentIntents: { retrieve: jest.fn().mockResolvedValue(intent) } };
    const options = { stripe, attemptId, intentId: intent.id };
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId }).first();
    const before = await attempt();
    expect(await inReadOnly((database) => verifySavedCardCancellation({ ...options, database })))
      .toMatchObject({ result: 'cancellation_verified' });
    expect(await attempt()).toEqual(before);
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });

    const record = () => verifySavedCardCancellation({ ...options, database: app, execute: true });
    await record();
    await record();
    expect(stripe.paymentIntents.retrieve.mock.calls).toEqual([[intent.id], [intent.id], [intent.id]]);
    expect(await attempt()).toEqual({ ...before, authentication_canceled_intent_id: intent.id, stripe_payment_intent_id: intent.id });
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
    const nextId = randomUUID();
    await app('stripe_invoice_charge_attempts').insert({
      id: nextId, invoice_id: invoiceId, status: 'failed', decline_code: 'authentication_required', resolved_at: new Date(),
    });
    await record();
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: nextId });
  });

  test('a failed Stripe lookup, a live intent or mismatched evidence keeps the original hold', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    const retrieve = jest.fn();
    const verify = () => verifySavedCardCancellation({
      database: app, stripe: { paymentIntents: { retrieve } }, attemptId, intentId: intent.id, execute: true,
    });
    retrieve.mockRejectedValueOnce(new Error('unavailable'));
    await expect(verify()).rejects.toThrow('unavailable');
    const mismatches = [
      { id: 'pi_different' }, { status: 'requires_action' }, { status: 'succeeded' },
      { payment_method: null }, { payment_method: 'pm_other' },
      ...Object.keys(intent.metadata).map((key) => ({ metadata: { ...intent.metadata, [key]: randomUUID() } })),
    ];
    for (const mismatch of mismatches) {
      retrieve.mockResolvedValueOnce({ ...intent, ...mismatch });
      await expect(verify()).rejects.toThrow();
    }
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });
    expect(await attempt().first()).toMatchObject({ stripe_payment_intent_id: null, authentication_canceled_intent_id: null });
    await attempt().update({ authentication_canceled_intent_id: 'pi_previousCandidate' });
    retrieve.mockResolvedValueOnce(intent);
    await expect(verify()).rejects.toThrow();
    expect(await attempt().first()).toMatchObject({ stripe_payment_intent_id: null, authentication_canceled_intent_id: 'pi_previousCandidate' });
    await attempt().update({ authentication_canceled_intent_id: null });

    // The local binding changes while Stripe is answering. Execute must
    // check that binding again even after an earlier successful preview.
    retrieve.mockResolvedValueOnce(intent).mockImplementationOnce(async () => {
      await attempt().update({ stripe_payment_intent_id: 'pi_other' });
      return intent;
    });
    await verifySavedCardCancellation({ database: app, stripe: { paymentIntents: { retrieve } }, attemptId, intentId: intent.id });
    await expect(verify()).rejects.toThrow();
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    await attempt().update({ stripe_payment_intent_id: intent.id });
    retrieve.mockResolvedValueOnce({ ...intent, payment_method: null });
    await verify();
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
  });

  test('an operator recording a cancellation waits for a concurrent invoice owner change and refuses the old owner', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    const stripe = { paymentIntents: { retrieve: jest.fn().mockResolvedValue(intent) } };
    const change = await app.transaction();
    try {
      await change('invoices').where({ id: invoiceId }).update({ customer_id: randomUUID() });
      const refusal = await commitWithWaitingCheckout(change, (database) => verifySavedCardCancellation({
        database, stripe, attemptId, intentId: intent.id, execute: true,
      }));
      expect(refusal?.message).toMatch(/does not match/);
    } finally {
      if (!change.isCompleted()) await change.rollback();
    }
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
  }, 15000);

  test('combined checkout waiting for a sibling lock sees the new authentication decline before collection', async () => {
    const { verifyAllocationLocked } = require('../services/pay-combined');
    const sibling = await authenticationFixture(app);
    const anchor = randomUUID();
    await app('invoices').insert({ id: anchor, customer_id: sibling.customerId, status: 'sent', total: 25 });
    const allocation = [anchor, sibling.invoiceId].map((invoiceId) => ({ invoiceId, cents: 2500 }));
    const collect = jest.fn();
    await app('stripe_invoice_charge_attempts').where({ id: sibling.attemptId }).update({ decline_code: 'insufficient_funds' });
    expect(await verdict(sibling.invoiceId, app, { checkout: true })).toBeNull();
    const nextId = randomUUID();
    const nextIntent = { ...sibling.intent, id: 'pi_next', metadata: { ...sibling.intent.metadata, saved_card_attempt_id: nextId } };
    await app('stripe_invoice_charge_attempts').insert({
      id: nextId, invoice_id: sibling.invoiceId, status: 'claimed', created_at: new Date(), stripe_payment_method_id: 'pm_synthetic',
    });
    const charge = await app.transaction();
    try {
      await charge('invoices').where({ id: sibling.invoiceId }).forUpdate().first();
      await charge('stripe_invoice_charge_attempts').where({ id: nextId }).update({
        status: 'failed', resolved_at: new Date(), decline_code: 'authentication_required', stripe_payment_intent_id: nextIntent.id,
      });
      const refusal = await commitWithWaitingCheckout(charge, async (trx) => {
        await verifyAllocationLocked(trx, allocation, { anchorInvoiceId: anchor, allowUnbound: true });
        collect();
      });
      expect(refusal).toMatchObject({ staleBalance: true, statusCode: 409 });
      expect(collect).not.toHaveBeenCalled();
    } finally {
      if (!charge.isCompleted()) await charge.rollback();
    }
    await recordAuthenticationCancellation(nextIntent, app);
    await app.transaction(async (trx) => {
      await verifyAllocationLocked(trx, allocation, { anchorInvoiceId: anchor, allowUnbound: true });
      collect();
    });
    expect(collect).toHaveBeenCalledTimes(1);
  }, 15000);

  test('a saved-card retry rechecks the locked invoice before inserting its own claim', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    const retry = { invoiceId, paymentMethodId: randomUUID(), stripePaymentMethodId: 'pm_retry', attemptId: randomUUID() };
    const attempt = (conn) => conn('stripe_invoice_charge_attempts').where({ id: attemptId });
    await attempt(app).update({ status: 'claimed', decline_code: null, resolved_at: null });
    const charge = await app.transaction();
    try {
      await charge('invoices').where({ id: invoiceId }).forUpdate().first();
      await attempt(charge).update({
        status: 'failed', decline_code: 'authentication_required', stripe_payment_intent_id: intent.id, resolved_at: new Date(),
      });
      const refusal = await commitWithWaitingCheckout(charge, (database) =>
        StripeService.claimInvoiceSavedCardCharge({ ...retry, database }));
      expect(refusal).toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS', chargeAttemptId: attemptId, statusCode: 409 });
    } finally {
      if (!charge.isCompleted()) await charge.rollback();
    }
    expect(await app('stripe_invoice_charge_attempts').where({ id: retry.attemptId }).first()).toBeUndefined();
    expect(await verdict(invoiceId, app, {})).toBeNull();
    await recordAuthenticationCancellation(intent, app);
    await expect(StripeService.claimInvoiceSavedCardCharge({ ...retry, database: app }))
      .resolves.toMatchObject({ id: retry.attemptId, invoice_id: invoiceId, status: 'claimed' });
    await expect(StripeService.claimInvoiceSavedCardCharge({ ...retry, attemptId: randomUUID(), database: app }))
      .rejects.toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS', chargeAttemptId: retry.attemptId });
  }, 15000);

  test('stale SUBMITTED claim: ambiguous verdict, no write, transaction stays usable', async () => {
    const f = await staleClaim({ submitted: true });
    const err = await inReadOnly((trx) => verdict(f.invoiceId, trx, { readOnly: true }));
    expect(err && err.code).toBe('STRIPE_AMBIGUOUS_OUTCOME');
    expect((await app('stripe_invoice_charge_attempts').where({ id: f.id }).first('status')).status).toBe('claimed');
  });

  test('stale PRE-SUBMIT claim: stays fenced as in progress (its worker may still commit), no write, transaction stays usable', async () => {
    const f = await staleClaim({ submitted: false });
    const err = await inReadOnly((trx) => verdict(f.invoiceId, trx, { readOnly: true }));
    expect(err && err.code).toBe('STRIPE_CHARGE_IN_PROGRESS');
    const row = await app('stripe_invoice_charge_attempts').where({ id: f.id }).first('status', 'resolved_at');
    expect(row).toMatchObject({ status: 'claimed', resolved_at: null });
  });

  test('fresh claim: in progress in read-only mode, no write', async () => {
    const invoiceId = randomUUID();
    const id = randomUUID();
    await app('stripe_invoice_charge_attempts').insert({
      id, invoice_id: invoiceId, status: 'claimed', idempotency_key: `inv_card_on_file_${invoiceId}_${id}`,
      created_at: new Date(), updated_at: new Date(),
    });
    const err = await inReadOnly((trx) => verdict(invoiceId, trx, { readOnly: true }));
    expect(err && err.code).toBe('STRIPE_CHARGE_IN_PROGRESS');
  });

  test('writing mode unchanged: a stale pre-submit claim is released', async () => {
    const f = await staleClaim({ submitted: false });
    expect(await verdict(f.invoiceId, app)).toBeNull();
    expect((await app('stripe_invoice_charge_attempts').where({ id: f.id }).first('status')).status).toBe('failed');
  });
});
