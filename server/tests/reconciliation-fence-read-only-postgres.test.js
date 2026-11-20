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
const canceledCheckoutMigration = require('../models/migrations/20261119090100_saved_card_canceled_checkout');
const provenanceMigration = require('../models/migrations/20261119160000_saved_card_intent_binding_provenance');
const workerIdentityMigration = require('../models/migrations/20261119190000_original_saved_card_payment_intent');
const { recordAuthenticationCancellation, recordAuthenticationSettlement, verifySavedCardCancellation } = require('../services/invoice-payment-authentication');
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
  let schedulePrepaidCollectionFence;
  let resolveMetadataCanceledSavedCardAttempt;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await app.schema.createTable('customers', (t) => {
      t.uuid('id').primary();
      t.decimal('account_credits', 12, 2).defaultTo(0);
    });
    await app.schema.createTable('invoices', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id');
      t.string('status');
      t.string('invoice_number');
      t.string('payment_method');
      t.decimal('total');
      t.decimal('credit_applied', 12, 2).defaultTo(0);
      t.date('due_date');
      t.timestamp('viewed_at');
      t.timestamp('paid_at');
      t.timestamp('ach_processing_notified_at');
      t.timestamp('updated_at');
      t.string('stripe_payment_intent_id');
    });
    await app.schema.createTable('customer_merge_journal', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('winner_customer_id').notNullable();
      t.uuid('loser_customer_id').notNullable();
      t.jsonb('repointed').notNullable().defaultTo('{}');
      t.jsonb('repointed_ids');
      t.timestamp('undone_at');
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
      t.decimal('credit_applied_delta', 12, 2).defaultTo(0);
      t.decimal('credit_applied_total', 12, 2).defaultTo(0);
      t.decimal('amount', 12, 2);
      t.text('error_message');
      t.timestamp('submitted_at');
      t.timestamp('resolved_at');
      t.timestamp('created_at');
      t.timestamp('updated_at');
    });
    await app.schema.createTable('stripe_orphan_charges', (t) => {
      t.uuid('invoice_id');
      t.boolean('resolved');
      t.timestamp('resolved_at');
      t.text('resolution_notes');
      t.string('stripe_payment_intent_id');
    });
    await app.schema.createTable('payments', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id');
      t.string('status');
      t.string('processor');
      t.uuid('payment_method_id');
      t.decimal('amount', 12, 2);
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
    await canceledCheckoutMigration.up(app);
    await provenanceMigration.up(app);
    await workerIdentityMigration.up(app);
    await require('../models/migrations/20261119190100_saved_card_worker_timeout').up(app);
    StripeService = require('../services/stripe');
    ({ schedulePrepaidCollectionFence } = require('../routes/admin-schedule')._test);
    ({ _resolveMetadataCanceledSavedCardAttempt: resolveMetadataCanceledSavedCardAttempt } = require('../routes/stripe-webhook'));
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
      id: attemptId, invoice_id: invoiceId, stripe_payment_method_id: intent.payment_method,
      created_at: new Date(), updated_at: new Date(),
      status: 'failed', decline_code: 'authentication_required', resolved_at: new Date(),
    });
    return { invoiceId, attemptId, intent, customerId };
  }

  async function bindAttempt(conn, { attemptId, intentId }) {
    await conn('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      stripe_payment_intent_id: intentId,
      worker_payment_intent_id: intentId,
      stripe_payment_intent_bound_at: new Date(),
      updated_at: new Date(),
    });
  }

  async function recordInvoiceMerge(conn, { invoiceId, loserId, winnerId, invoiceIds = [invoiceId], undone = false }) {
    await conn('customer_merge_journal').insert({
      loser_customer_id: loserId,
      winner_customer_id: winnerId,
      repointed: JSON.stringify({ 'invoices.customer_id': invoiceIds.length }),
      repointed_ids: JSON.stringify({ version: 1, tables: { 'invoices.customer_id': invoiceIds } }),
      undone_at: undone ? new Date() : null,
    });
    await conn('invoices').where({ id: invoiceId }).update({ customer_id: winnerId });
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
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    await bindAttempt(app, { attemptId, intentId: intent.id });
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
    await attempt().update({ decline_code: 'card_declined' }); // an older webhook overwrote both fields
    await recordAuthenticationCancellation({ ...intent, id: 'pi_different' }, app);
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    expect(await attempt().first()).toMatchObject({ worker_payment_intent_id: intent.id });
  });

  test('Schedule invoice posting holds a null-PI authentication attempt until exact cancellation evidence', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });
    const lockedFence = () => app.transaction(async (trx) => {
      const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
      expect(invoice.stripe_payment_intent_id).toBeNull();
      return schedulePrepaidCollectionFence(invoice.id, trx);
    });

    await expect(lockedFence()).resolves.toMatchObject({
      reason: 'payment_in_flight', code: 'STRIPE_CHARGE_IN_PROGRESS',
    });
    // A cancellation candidate for another PI is not evidence for this charge.
    await attempt().update({ authentication_canceled_intent_id: 'pi_mismatched' });
    await expect(lockedFence()).resolves.toMatchObject({ reason: 'payment_in_flight' });

    // The same attempt and PI is the one cancellation that releases Schedule.
    await bindAttempt(app, { attemptId, intentId: intent.id });
    await recordAuthenticationCancellation(intent, app);
    await expect(lockedFence()).resolves.toBeNull();
  });

  test('Schedule commits a stale submitted claim promotion while refusing invoice posting', async () => {
    const f = await staleClaim({ submitted: true });
    await app('invoices').insert({ id: f.invoiceId, customer_id: randomUUID(), status: 'sent', total: 25 });
    const held = await app.transaction(async (trx) => {
      await trx('invoices').where({ id: f.invoiceId }).forUpdate().first();
      return schedulePrepaidCollectionFence(f.invoiceId, trx);
    });
    expect(held).toMatchObject({ reason: 'payment_in_flight', code: 'STRIPE_AMBIGUOUS_OUTCOME' });
    expect(await app('stripe_invoice_charge_attempts').where({ id: f.id }).first('status'))
      .toMatchObject({ status: 'ambiguous' });
  });

  test('metadata-only cancellation releases only the exact worker-bound parked attempt and is idempotent', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const attemptId = randomUUID();
    const intent = {
      id: `pi_${attemptId.replaceAll('-', '')}`,
      status: 'canceled',
      payment_method: 'pm_worker_bound',
      metadata: {
        source: 'admin_card_on_file', saved_card_attempt_id: attemptId,
        waves_invoice_id: invoiceId, waves_customer_id: customerId,
      },
    };
    await app('customers').insert({ id: customerId });
    await app('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'processing', invoice_number: invoiceId,
      total: 25, credit_applied: 0, due_date: '2099-01-01', stripe_payment_intent_id: null,
    });
    await app('stripe_invoice_charge_attempts').insert({
      id: attemptId, invoice_id: invoiceId, status: 'ambiguous',
      stripe_payment_method_id: intent.payment_method,
      stripe_payment_intent_id: intent.id,
      worker_payment_intent_id: intent.id,
      created_at: new Date(),
    });

    await expect(resolveMetadataCanceledSavedCardAttempt(intent, app)).resolves.toBe(true);
    expect(await app('invoices').where({ id: invoiceId }).first())
      .toMatchObject({ status: 'sent', stripe_payment_intent_id: null });
    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first())
      .toMatchObject({ status: 'failed', stripe_payment_intent_id: intent.id, worker_payment_intent_id: intent.id });
    await expect(resolveMetadataCanceledSavedCardAttempt(intent, app)).resolves.toBe(false);
  });

  test.each([
    ['no original-worker binding', null, 'retry'],
    ['a different original-worker PI', 'pi_other_worker', 'refuse'],
  ])('metadata-only cancellation preserves the parked hold with %s', async (_label, workerPaymentIntentId, outcome) => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const attemptId = randomUUID();
    const intent = {
      id: `pi_${attemptId.replaceAll('-', '')}`,
      status: 'canceled',
      payment_method: 'pm_unproven',
      metadata: {
        source: 'admin_card_on_file', saved_card_attempt_id: attemptId,
        waves_invoice_id: invoiceId, waves_customer_id: customerId,
      },
    };
    await app('customers').insert({ id: customerId });
    await app('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'processing', invoice_number: invoiceId,
      total: 25, due_date: '2099-01-01', stripe_payment_intent_id: null,
    });
    await app('stripe_invoice_charge_attempts').insert({
      id: attemptId, invoice_id: invoiceId, status: 'ambiguous',
      stripe_payment_method_id: intent.payment_method,
      stripe_payment_intent_id: intent.id,
      worker_payment_intent_id: workerPaymentIntentId,
      created_at: new Date(),
    });

    if (outcome === 'retry') {
      await expect(resolveMetadataCanceledSavedCardAttempt(intent, app)).rejects.toMatchObject({
        code: 'SAVED_CARD_WORKER_INTENT_PENDING',
      });
    } else {
      await expect(resolveMetadataCanceledSavedCardAttempt(intent, app)).resolves.toBe(false);
    }
    expect(await app('invoices').where({ id: invoiceId }).first('status'))
      .toEqual({ status: 'processing' });
    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first('status', 'resolved_at'))
      .toEqual({ status: 'ambiguous', resolved_at: null });
  });

  test('metadata cancellation resolves its worker attempt without replacing a collectible invoice live checkout', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const attemptId = randomUUID();
    const intent = {
      id: `pi_${attemptId.replaceAll('-', '')}`,
      status: 'canceled',
      payment_method: 'pm_worker_bound',
      metadata: {
        source: 'admin_card_on_file', saved_card_attempt_id: attemptId,
        waves_invoice_id: invoiceId, waves_customer_id: customerId,
      },
    };
    await app('customers').insert({ id: customerId });
    await app('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'sent', invoice_number: invoiceId,
      total: 25, credit_applied: 0, due_date: '2099-01-01',
      stripe_payment_intent_id: 'pi_live_checkout',
    });
    await app('stripe_invoice_charge_attempts').insert({
      id: attemptId, invoice_id: invoiceId, status: 'ambiguous',
      stripe_payment_method_id: intent.payment_method,
      stripe_payment_intent_id: intent.id,
      worker_payment_intent_id: intent.id,
      created_at: new Date(),
    });

    await expect(resolveMetadataCanceledSavedCardAttempt(intent, app)).resolves.toBe(true);
    expect(await app('invoices').where({ id: invoiceId }).first())
      .toMatchObject({ status: 'sent', stripe_payment_intent_id: 'pi_live_checkout' });
    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first())
      .toMatchObject({ status: 'failed', stripe_payment_intent_id: intent.id });
  });

  test('metadata cancellation transfers reserved credit to a replacement live checkout', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const attemptId = randomUUID();
    const intent = {
      id: `pi_${attemptId.replaceAll('-', '')}`,
      status: 'canceled',
      payment_method: 'pm_worker_bound_credit',
      metadata: {
        source: 'admin_card_on_file', saved_card_attempt_id: attemptId,
        waves_invoice_id: invoiceId, waves_customer_id: customerId,
      },
    };
    await app('customers').insert({ id: customerId, account_credits: 0 });
    await app('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'sent', invoice_number: invoiceId,
      total: 100, credit_applied: 25, due_date: '2099-01-01',
      stripe_payment_intent_id: 'pi_live_checkout_after_credit',
    });
    await app('stripe_invoice_charge_attempts').insert({
      id: attemptId, invoice_id: invoiceId, status: 'ambiguous',
      stripe_payment_method_id: intent.payment_method,
      stripe_payment_intent_id: intent.id,
      worker_payment_intent_id: intent.id,
      amount: 75,
      credit_applied_delta: 25,
      credit_applied_total: 25,
      created_at: new Date(),
    });

    await expect(resolveMetadataCanceledSavedCardAttempt(intent, app)).resolves.toBe(true);
    expect(await app('invoices').where({ id: invoiceId }).first())
      .toMatchObject({
        status: 'sent',
        credit_applied: '25.00',
        stripe_payment_intent_id: 'pi_live_checkout_after_credit',
      });
    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first())
      .toMatchObject({ status: 'failed', resolved_at: expect.any(Date), stripe_payment_intent_id: intent.id });
    expect(await app('customers').where({ id: customerId }).first())
      .toMatchObject({ account_credits: '0.00' });
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();

    // The webhook event is processed once. A redelivery is a no-op, and the
    // replacement remains correctly priced from the retained invoice credit.
    await expect(resolveMetadataCanceledSavedCardAttempt(intent, app)).resolves.toBe(false);
    expect(await app('invoices').where({ id: invoiceId }).first())
      .toMatchObject({
        credit_applied: '25.00',
        stripe_payment_intent_id: 'pi_live_checkout_after_credit',
      });
  });

  test.each(['waves_invoice_id', 'saved_card_attempt_id', 'waves_customer_id'])(
    'metadata cancellation rejects malformed %s before a PostgreSQL UUID comparison', async (field) => {
      const intent = {
        id: 'pi_malformed_metadata',
        status: 'canceled',
        payment_method: 'pm_saved',
        metadata: {
          source: 'admin_card_on_file',
          waves_invoice_id: randomUUID(),
          saved_card_attempt_id: randomUUID(),
          waves_customer_id: randomUUID(),
          [field]: 'not-a-uuid',
        },
      };
      await expect(resolveMetadataCanceledSavedCardAttempt(intent, app)).resolves.toBe(false);
    },
  );

  test('additive migration holds exact IDs copied by the published cancellation backfill', async () => {
    await app.transaction(async (trx) => {
      await migration.down(trx);
      const historicalExact = await authenticationFixture(trx);
      await trx('stripe_invoice_charge_attempts').where({ id: historicalExact.attemptId })
        .update({ stripe_payment_intent_id: historicalExact.intent.id, updated_at: new Date() });
      const unbound = await authenticationFixture(trx);
      const blocked = await authenticationFixture(trx);
      const event = (pi, processed = true) => ({
        event_type: 'payment_intent.canceled', processed, payload: JSON.stringify({ object: pi }),
      });
      await trx('stripe_webhook_events').insert([
        event(historicalExact.intent), event(unbound.intent), event(blocked.intent, false),
        event({ ...blocked.intent, metadata: { ...blocked.intent.metadata, waves_customer_id: historicalExact.customerId } }),
      ]);
      await migration.up(trx);
      await provenanceMigration.up(trx);
      await trx('stripe_webhook_events').del();
      expect(await trx('stripe_invoice_charge_attempts').where({ id: historicalExact.attemptId }).first())
        .toMatchObject({
          authentication_canceled_intent_id: historicalExact.intent.id,
          stripe_payment_intent_id: historicalExact.intent.id,
          stripe_payment_intent_bound_at: null,
        });
      expect(await verdict(historicalExact.invoiceId, trx, { checkout: true }))
        .toMatchObject({ chargeAttemptId: historicalExact.attemptId });
      expect(await trx('stripe_invoice_charge_attempts').where({ id: unbound.attemptId }).first())
        .toMatchObject({
          authentication_canceled_intent_id: unbound.intent.id,
          stripe_payment_intent_id: unbound.intent.id,
          stripe_payment_intent_bound_at: null,
        });
      expect(await verdict(unbound.invoiceId, trx, { checkout: true }))
        .toMatchObject({ chargeAttemptId: unbound.attemptId });
      expect(await verdict(blocked.invoiceId, trx, { checkout: true })).toMatchObject({ chargeAttemptId: blocked.attemptId });
    });
  });

  test('a legacy failure webhook cannot establish the original PI even when the cancellation arrives later', async () => {
    await app.transaction(async (trx) => {
      await migration.down(trx);
      await trx.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
        table.dropColumn('stripe_payment_intent_bound_at');
      });
      await trx.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
        table.string('authentication_canceled_intent_id');
      });
      const copied = await authenticationFixture(trx);
      const independent = await authenticationFixture(trx);
      await trx('stripe_invoice_charge_attempts').where({ id: copied.attemptId }).update({
        stripe_payment_intent_id: copied.intent.id,
        authentication_canceled_intent_id: copied.intent.id,
      });
      await trx('stripe_invoice_charge_attempts').where({ id: independent.attemptId }).update({
        stripe_payment_intent_id: independent.intent.id, updated_at: new Date(),
      });

      await provenanceMigration.up(trx);
      expect(await trx('stripe_invoice_charge_attempts').where({ id: copied.attemptId }).first())
        .toMatchObject({ stripe_payment_intent_bound_at: null });
      expect(await verdict(copied.invoiceId, trx, { checkout: true }))
        .toMatchObject({ chargeAttemptId: copied.attemptId });
      expect(await trx('stripe_invoice_charge_attempts').where({ id: independent.attemptId }).first())
        .toMatchObject({ stripe_payment_intent_bound_at: null });
      await recordAuthenticationCancellation(independent.intent, trx);
      expect(await verdict(independent.invoiceId, trx, { checkout: true }))
        .toMatchObject({ chargeAttemptId: independent.attemptId });
    });
  });

  test.each([['claimed', true], ['claimed', false], ['ambiguous', true], ['ambiguous', false]])(
    'pre-migration %s bank return requires the original worker ledger row (matches %s)', async (status, matches) => {
    const { attemptId, invoiceId, intent, customerId } = await authenticationFixture(app);
    const savedMethod = randomUUID();
    await app('customers').insert({ id: customerId, account_credits: 0 });
    await app('invoices').where({ id: invoiceId }).update({
      payment_method: 'us_bank_account', status: 'processing', stripe_payment_intent_id: intent.id, credit_applied: 0,
    });
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });
    await attempt().update({ status, resolved_at: null, decline_code: null, amount: 25,
      created_at: new Date('2020-01-01'), submitted_at: new Date('2020-01-01'), payment_method_id: savedMethod, stripe_payment_intent_id: status === 'claimed' ? null : intent.id });
    await app('payments').insert({ id: randomUUID(), stripe_payment_intent_id: intent.id, processor: 'stripe',
      payment_method_id: matches ? savedMethod : null, amount: 25, customer_id: customerId,
      metadata: { invoice_id: invoiceId }, status: 'failed' });
    expect(await StripeService.resolveFailedInvoiceSavedCardChargeAttempt({ attemptId, invoiceId, customerId,
      stripePaymentIntentId: intent.id, bankReturnAmountCents: 2500, declineCode: 'bank_return', database: app })).toBe(matches);
    expect(await attempt().first()).toMatchObject({ status: matches ? 'failed' : status, worker_payment_intent_id: null });
    expect(await app('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: matches ? 'sent' : 'processing' });
  });

  test('a pre-migration bank return follows a row-proven invoice merge', async () => {
    const oldOwner = randomUUID();
    const currentOwner = randomUUID();
    const { attemptId, invoiceId, intent } = await authenticationFixture(app, oldOwner);
    const savedMethod = randomUUID();
    await app('customers').insert([
      { id: oldOwner, account_credits: 0 },
      { id: currentOwner, account_credits: 0 },
    ]);
    await recordInvoiceMerge(app, { invoiceId, loserId: oldOwner, winnerId: currentOwner });
    await app('invoices').where({ id: invoiceId }).update({
      payment_method: 'us_bank_account', status: 'processing', stripe_payment_intent_id: intent.id, credit_applied: 0,
    });
    await app('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      status: 'ambiguous', resolved_at: null, decline_code: null, amount: 25,
      created_at: new Date('2020-01-01'), payment_method_id: savedMethod, stripe_payment_intent_id: intent.id,
      worker_payment_intent_id: null,
    });
    await app('payments').insert({
      id: randomUUID(), stripe_payment_intent_id: intent.id, processor: 'stripe',
      payment_method_id: savedMethod, amount: 25, customer_id: currentOwner,
      metadata: { invoice_id: invoiceId }, status: 'failed',
    });

    await expect(StripeService.resolveFailedInvoiceSavedCardChargeAttempt({
      attemptId,
      invoiceId,
      customerId: currentOwner,
      originalCustomerId: oldOwner,
      stripePaymentIntentId: intent.id,
      bankReturnAmountCents: 2500,
      declineCode: 'bank_return',
      database: app,
    })).resolves.toBe(true);

    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first())
      .toMatchObject({ status: 'failed', worker_payment_intent_id: null, stripe_payment_intent_id: intent.id });
    expect(await app('invoices').where({ id: invoiceId }).first())
      .toMatchObject({ customer_id: currentOwner, status: 'sent', stripe_payment_intent_id: null });
  });

  test.each([true, false])('cancellation checks the recorded customer transfer under lock (proven %s)', async (proven) => {
    const { attemptId, invoiceId, intent, customerId } = await authenticationFixture(app);
    const currentOwner = randomUUID();
    await app('customers').insert({ id: currentOwner, account_credits: 0 });
    await recordInvoiceMerge(app, { invoiceId, loserId: customerId, winnerId: currentOwner, invoiceIds: proven ? [invoiceId] : [] });
    await app('invoices').where({ id: invoiceId }).update({ status: 'processing', stripe_payment_intent_id: intent.id });
    await app('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      status: 'ambiguous', resolved_at: null, worker_payment_intent_id: intent.id, stripe_payment_intent_id: intent.id,
    });
    const result = await StripeService.resolveFailedInvoiceSavedCardChargeAttempt({ attemptId, invoiceId, customerId: currentOwner,
      originalCustomerId: customerId, stripePaymentIntentId: intent.id, database: app });
    expect(result).toBe(proven);
    expect(await app('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: proven ? 'sent' : 'processing' });
  });

  test('retains a worker authentication decline with no returned intent after a definitive failure webhook', async () => {
    const { attemptId, invoiceId } = await authenticationFixture(app);
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });
    await attempt().update({ decline_code: 'card_declined', stripe_payment_intent_id: 'pi_webhook_only' });
    await StripeService.resolveNoFundsSavedCardChargeAttempt({
      attemptId, invoiceId, declineCode: 'authentication_required', failureMessage: 'authentication required', database: app,
    });
    expect(await attempt().first()).toMatchObject({
      decline_code: 'authentication_required', worker_payment_intent_id: null, stripe_payment_intent_id: 'pi_webhook_only',
    });
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
  });

  test.each(['card_declined', 'authentication_required'])('a preceding %s webhook for another PI preserves both identities and keeps checkout held', async (declineCode) => {
    const { attemptId, invoiceId, intent } = await authenticationFixture(app);
    await app('stripe_invoice_charge_attempts').where({ id: attemptId }).update({ stripe_payment_intent_id: 'pi_webhook', decline_code: declineCode });
    const worker = (authenticationIntentId) => StripeService.resolveNoFundsSavedCardChargeAttempt({
      attemptId, invoiceId, declineCode: 'authentication_required', authenticationIntentId, database: app,
    });
    await worker(intent.id);
    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first())
      .toMatchObject({ worker_payment_intent_id: intent.id, stripe_payment_intent_id: 'pi_webhook' });
    await recordAuthenticationCancellation({ ...intent, id: 'pi_webhook' }, app);
    await recordAuthenticationCancellation(intent, app);
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    expect(await worker('pi_webhook')).toBe(false);
    await expect(StripeService.claimInvoiceSavedCardCharge({
      database: app, invoiceId, paymentMethodId: randomUUID(), stripePaymentMethodId: 'pm_other', attemptId: randomUUID(),
    })).rejects.toMatchObject({ chargeAttemptId: attemptId, statusCode: 409 });
    expect(await verdict(invoiceId, app, {})).toBeNull(); // settlement of received money still runs
  });

  test.each([true, false])('a successful webhook followed by a worker authentication response preserves the settlement (same intent %s)', async (sameIntent) => {
    const { attemptId, invoiceId, intent } = await authenticationFixture(app);
    const observed = sameIntent ? intent.id : 'pi_existing_settlement';
    const attempts = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });
    await attempts().update({ status: 'succeeded', stripe_payment_intent_id: observed, decline_code: null });
    await StripeService.resolveNoFundsSavedCardChargeAttempt({
      attemptId, invoiceId, declineCode: 'authentication_required', authenticationIntentId: intent.id, database: app,
    });
    expect(await attempts().first()).toMatchObject({ status: 'succeeded', stripe_payment_intent_id: observed,
      worker_payment_intent_id: sameIntent ? null : intent.id });
    const staleId = randomUUID();
    await app('stripe_invoice_charge_attempts').insert({
      id: staleId, invoice_id: invoiceId, status: 'claimed', created_at: new Date('2020-01-01'),
    });
    const hold = await verdict(invoiceId, app, { checkout: true });
    if (sameIntent) expect(hold).toBeNull();
    else expect(hold).toMatchObject({ chargeAttemptId: attemptId, statusCode: 409 });
  });

  test('a create-returned nonterminal PI binds in one write and can bind after its exact webhook wins', async () => {
    const workerFirst = await authenticationFixture(app);
    const workerFirstAttempt = () => app('stripe_invoice_charge_attempts').where({ id: workerFirst.attemptId });
    await workerFirstAttempt().update({
      status: 'claimed', decline_code: null, resolved_at: null,
      stripe_payment_intent_id: null, stripe_payment_intent_bound_at: null,
    });
    await StripeService.markInvoiceSavedCardChargeAttempt(workerFirst.attemptId, {
      status: 'ambiguous',
      stripe_payment_intent_id: workerFirst.intent.id,
      resolved_at: null,
    }, app);
    expect(await workerFirstAttempt().first()).toMatchObject({
      status: 'ambiguous',
      stripe_payment_intent_id: workerFirst.intent.id,
      stripe_payment_intent_bound_at: expect.any(Date),
    });

    const webhookFirst = await authenticationFixture(app);
    const webhookFirstAttempt = () => app('stripe_invoice_charge_attempts').where({ id: webhookFirst.attemptId });
    await webhookFirstAttempt().update({
      stripe_payment_intent_id: webhookFirst.intent.id,
      stripe_payment_intent_bound_at: null,
    });
    await StripeService.markInvoiceSavedCardChargeAttempt(webhookFirst.attemptId, {
      status: 'ambiguous',
      stripe_payment_intent_id: webhookFirst.intent.id,
      resolved_at: null,
    }, app);
    expect(await webhookFirstAttempt().first()).toMatchObject({
      status: 'failed',
      stripe_payment_intent_id: webhookFirst.intent.id,
      stripe_payment_intent_bound_at: expect.any(Date),
      resolved_at: expect.any(Date),
    });

    const webhookOnly = await authenticationFixture(app);
    await app('stripe_invoice_charge_attempts').where({ id: webhookOnly.attemptId }).update({
      stripe_payment_intent_id: 'pi_webhook_only',
      stripe_payment_intent_bound_at: null,
    });
    await expect(StripeService.markInvoiceSavedCardChargeAttempt(webhookOnly.attemptId, {
      status: 'ambiguous',
      stripe_payment_intent_id: 'pi_different_worker_response',
      resolved_at: null,
    }, app)).rejects.toMatchObject({ code: 'STRIPE_CHARGE_ATTEMPT_FENCE_LOST' });
    expect(await app('stripe_invoice_charge_attempts').where({ id: webhookOnly.attemptId }).first())
      .toMatchObject({ stripe_payment_intent_id: 'pi_webhook_only', worker_payment_intent_id: 'pi_different_worker_response' });
  });

  test('a different worker PI is retained beside an already-succeeded webhook outcome', async () => {
    const { attemptId } = await authenticationFixture(app);
    const resolvedAt = new Date('2026-11-19T15:00:00.000Z');
    await app('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      status: 'succeeded',
      resolved_at: resolvedAt,
      stripe_payment_intent_id: 'pi_webhook_settled',
      worker_payment_intent_id: null,
      error_message: null,
    });

    await expect(StripeService.markInvoiceSavedCardChargeAttempt(attemptId, {
      status: 'ambiguous', stripe_payment_intent_id: 'pi_worker_returned', resolved_at: null,
    }, app)).rejects.toMatchObject({ code: 'STRIPE_CHARGE_ATTEMPT_FENCE_LOST' });

    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first()).toMatchObject({
      status: 'succeeded',
      resolved_at: resolvedAt,
      stripe_payment_intent_id: 'pi_webhook_settled',
      worker_payment_intent_id: 'pi_worker_returned',
      error_message: 'Conflicting saved-card PaymentIntents require reconciliation',
    });
  });

  test('a failure webhook waiting on the worker-bound attempt cannot refund credit or attach a different intent', async () => {
    const { customerId, invoiceId, attemptId, intent } = await authenticationFixture(app);
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });
    await app('customers').insert({ id: customerId, account_credits: 40 });
    await app('invoices').where({ id: invoiceId }).update({ credit_applied: 25 });
    await attempt().update({ status: 'ambiguous', resolved_at: null, decline_code: null, credit_applied_total: 25, credit_applied_delta: 25 });
    const writer = await app.transaction();
    try {
      await StripeService.markInvoiceSavedCardChargeAttempt(attemptId, {
        status: 'ambiguous', stripe_payment_intent_id: intent.id,
      }, writer);
      let resolved;
      const failure = await commitWithWaitingCheckout(writer, async (database) => {
        resolved = await StripeService.resolveFailedInvoiceSavedCardChargeAttempt({
          attemptId, invoiceId, customerId, stripePaymentIntentId: 'pi_unrelated', declineCode: 'authentication_required', database,
        });
      });
      expect(failure).toBeNull();
      expect(resolved).toBe(false);
      const saved = await attempt().first();
      expect(saved).toMatchObject({ status: 'ambiguous', stripe_payment_intent_id: intent.id, stripe_payment_intent_bound_at: expect.any(Date) });
      const invoice = await app('invoices').where({ id: invoiceId }).first();
      expect(invoice.status).toBe('sent');
      expect(Number(invoice.credit_applied)).toBe(25);
      expect(Number((await app('customers').where({ id: customerId }).first()).account_credits)).toBe(40);
    } finally {
      if (!writer.isCompleted()) await writer.rollback();
    }
  });

  test('a signed cancellation follows the active row-precise invoice merge chain', async () => {
    const oldOwner = randomUUID();
    const middleOwner = randomUUID();
    const currentOwner = randomUUID();
    const { invoiceId, attemptId, intent } = await authenticationFixture(app, oldOwner);
    await recordInvoiceMerge(app, { invoiceId, loserId: oldOwner, winnerId: middleOwner });
    await recordInvoiceMerge(app, { invoiceId, loserId: middleOwner, winnerId: currentOwner });

    await recordAuthenticationCancellation(intent, app);
    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first())
      .toMatchObject({ authentication_canceled_intent_id: intent.id, stripe_payment_intent_id: null });
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
  });

  test('an operator can preview and record a merged invoice cancellation with uppercase UUIDs in Stripe metadata', async () => {
    const oldOwner = randomUUID();
    const { invoiceId, attemptId, intent } = await authenticationFixture(app, oldOwner);
    await bindAttempt(app, { attemptId, intentId: intent.id });
    await recordInvoiceMerge(app, { invoiceId, loserId: oldOwner, winnerId: randomUUID() });
    const stripeIntent = { ...intent, metadata: { ...intent.metadata,
      waves_invoice_id: invoiceId.toUpperCase(),
      saved_card_attempt_id: attemptId.toUpperCase(),
    } };
    const stripe = { paymentIntents: { retrieve: jest.fn().mockResolvedValue(stripeIntent) } };
    const options = { stripe, attemptId, intentId: intent.id };

    await expect(inReadOnly((database) => verifySavedCardCancellation({ ...options, database })))
      .resolves.toMatchObject({ result: 'cancellation_verified' });
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    await expect(verifySavedCardCancellation({ ...options, database: app, execute: true }))
      .resolves.toMatchObject({ result: 'cancellation_recorded' });
    await expect(verifySavedCardCancellation({ ...options, database: app, execute: true }))
      .resolves.toMatchObject({ result: 'cancellation_recorded' });
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledTimes(3);
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
  });

  test('customer changes without one unambiguous active row-precise chain cannot release the hold', async () => {
    async function refusalFixture() {
      const fixture = await authenticationFixture(app);
      const winnerId = randomUUID();
      const attempt = () => app('stripe_invoice_charge_attempts').where({ id: fixture.attemptId }).first();
      return { ...fixture, winnerId, attempt };
    }

    const manual = await refusalFixture();
    await app('invoices').where({ id: manual.invoiceId }).update({ customer_id: manual.winnerId });
    await recordAuthenticationCancellation(manual.intent, app);
    expect(await manual.attempt()).toMatchObject({ authentication_canceled_intent_id: null });

    const countOnly = await refusalFixture();
    await app('customer_merge_journal').insert({
      loser_customer_id: countOnly.customerId, winner_customer_id: countOnly.winnerId,
      repointed: JSON.stringify({ 'invoices.customer_id': 1 }), repointed_ids: null,
    });
    await app('invoices').where({ id: countOnly.invoiceId }).update({ customer_id: countOnly.winnerId });
    await recordAuthenticationCancellation(countOnly.intent, app);
    expect(await countOnly.attempt()).toMatchObject({ authentication_canceled_intent_id: null });

    const undone = await refusalFixture();
    await recordInvoiceMerge(app, {
      invoiceId: undone.invoiceId, loserId: undone.customerId, winnerId: undone.winnerId, undone: true,
    });
    await recordAuthenticationCancellation(undone.intent, app);
    expect(await undone.attempt()).toMatchObject({ authentication_canceled_intent_id: null });

    const wrongRow = await refusalFixture();
    await recordInvoiceMerge(app, {
      invoiceId: wrongRow.invoiceId, loserId: wrongRow.customerId, winnerId: wrongRow.winnerId,
      invoiceIds: [randomUUID()],
    });
    await recordAuthenticationCancellation(wrongRow.intent, app);
    expect(await wrongRow.attempt()).toMatchObject({ authentication_canceled_intent_id: null });

    const ambiguous = await refusalFixture();
    await recordInvoiceMerge(app, {
      invoiceId: ambiguous.invoiceId, loserId: ambiguous.customerId, winnerId: ambiguous.winnerId,
    });
    await app('customer_merge_journal').insert({
      loser_customer_id: ambiguous.customerId, winner_customer_id: ambiguous.winnerId,
      repointed: JSON.stringify({ 'invoices.customer_id': 1 }),
      repointed_ids: JSON.stringify({ version: 1, tables: { 'invoices.customer_id': [ambiguous.invoiceId] } }),
    });
    await recordAuthenticationCancellation(ambiguous.intent, app);
    expect(await ambiguous.attempt()).toMatchObject({ authentication_canceled_intent_id: null });
  });

  test.each(['fork', 'cycle'])('a %s in the active invoice transfers keeps a different owner on hold', async (shape) => {
    const { invoiceId, attemptId, intent, customerId } = await authenticationFixture(app);
    const owner = randomUUID();
    await recordInvoiceMerge(app, { invoiceId, loserId: customerId, winnerId: owner });
    const next = shape === 'fork'
      ? { loserId: customerId, winnerId: randomUUID() }
      : { loserId: owner, winnerId: customerId };
    await recordInvoiceMerge(app, { invoiceId, ...next });
    await app('invoices').where({ id: invoiceId }).update({ customer_id: owner });
    await recordAuthenticationCancellation(intent, app);
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
  });

  test('a proven merge does not relax the immutable PaymentIntent or card checks', async () => {
    const oldOwner = randomUUID();
    const { invoiceId, attemptId, intent } = await authenticationFixture(app, oldOwner);
    await recordInvoiceMerge(app, { invoiceId, loserId: oldOwner, winnerId: randomUUID() });
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });

    await attempt().update({ stripe_payment_intent_id: 'pi_immutable' });
    await recordAuthenticationCancellation(intent, app);
    expect(await attempt().first()).toMatchObject({ authentication_canceled_intent_id: null });
    await attempt().update({ stripe_payment_intent_id: null, stripe_payment_intent_bound_at: null });
    await recordAuthenticationCancellation({ ...intent, payment_method: 'pm_other' }, app);
    expect(await attempt().first()).toMatchObject({ authentication_canceled_intent_id: null });

    await attempt().update({ authentication_canceled_intent_id: 'pi_previousCandidate' });
    await recordAuthenticationCancellation(intent, app);
    expect(await attempt().first()).toMatchObject({
      stripe_payment_intent_id: null, authentication_canceled_intent_id: 'pi_previousCandidate',
    });
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    // Once the charging worker binds the exact PI, its verified cancellation
    // is conclusive even if a different, unbound candidate arrived first.
    await bindAttempt(app, { attemptId, intentId: intent.id });
    await recordAuthenticationCancellation(intent, app);
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
  });

  test('an operator cannot turn duplicate old cancellation evidence into an authoritative PI binding', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    const stripe = { paymentIntents: { retrieve: jest.fn().mockResolvedValue(intent) } };
    const options = { stripe, attemptId, intentId: intent.id };
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId }).first();
    await recordAuthenticationCancellation(intent, app);
    const before = await attempt();
    await expect(inReadOnly((database) => verifySavedCardCancellation({ ...options, database })))
      .rejects.toThrow('does not match');
    expect(await attempt()).toEqual(before);
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });

    const record = () => verifySavedCardCancellation({ ...options, database: app, execute: true });
    await expect(record()).rejects.toThrow('does not match');
    await expect(record()).rejects.toThrow('does not match');
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledTimes(3);
    expect(await attempt()).toMatchObject({
      authentication_canceled_intent_id: intent.id,
      stripe_payment_intent_id: null,
      stripe_payment_intent_bound_at: null,
    });
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
  });

  test('a failed Stripe lookup, a live intent or mismatched evidence keeps the original hold', async () => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    await bindAttempt(app, { attemptId, intentId: intent.id });
    const retrieve = jest.fn();
    const verify = () => verifySavedCardCancellation({
      database: app, stripe: { paymentIntents: { retrieve } }, attemptId, intentId: intent.id, execute: true,
    });
    retrieve.mockRejectedValueOnce(new Error('unavailable'));
    await expect(verify()).rejects.toThrow('unavailable');
    const mismatches = [
      { id: 'pi_different' }, { status: 'requires_action' }, { status: 'succeeded' },
      { payment_method: 'pm_other' },
      ...Object.keys(intent.metadata).map((key) => ({ metadata: { ...intent.metadata, [key]: randomUUID() } })),
    ];
    for (const mismatch of mismatches) {
      retrieve.mockResolvedValueOnce({ ...intent, ...mismatch });
      await expect(verify()).rejects.toThrow();
    }
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId });
    expect(await attempt().first()).toMatchObject({ stripe_payment_intent_id: intent.id, authentication_canceled_intent_id: null });
    await attempt().update({ authentication_canceled_intent_id: 'pi_previousCandidate' });
    retrieve.mockResolvedValueOnce(intent);
    await expect(verify()).resolves.toMatchObject({ result: 'cancellation_recorded' });
    expect(await attempt().first()).toMatchObject({ stripe_payment_intent_id: intent.id, authentication_canceled_intent_id: intent.id });
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
    await attempt().update({ authentication_canceled_intent_id: null });

    // The local binding changes while Stripe is answering. Execute must
    // check that binding again even after an earlier successful preview.
    retrieve.mockResolvedValueOnce(intent).mockImplementationOnce(async () => {
      await attempt().update({ stripe_payment_intent_id: 'pi_other', stripe_payment_intent_bound_at: new Date() });
      return intent;
    });
    await verifySavedCardCancellation({ database: app, stripe: { paymentIntents: { retrieve } }, attemptId, intentId: intent.id });
    await expect(verify()).rejects.toThrow();
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
    await bindAttempt(app, { attemptId, intentId: intent.id });
    retrieve.mockResolvedValueOnce({ ...intent, payment_method: null });
    await verify();
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
  });

  test.each([
    ['an operator', 'operator'],
    ['a signed webhook', 'signed webhook'],
  ])('%s cancellation waits for a concurrent invoice owner change and keeps the old owner held', async (_label, source) => {
    const { invoiceId, attemptId, intent } = await authenticationFixture(app);
    if (source === 'operator') await bindAttempt(app, { attemptId, intentId: intent.id });
    const stripe = { paymentIntents: { retrieve: jest.fn().mockResolvedValue(intent) } };
    const change = await app.transaction();
    try {
      await change('invoices').where({ id: invoiceId }).update({ customer_id: randomUUID() });
      const refusal = await commitWithWaitingCheckout(change, (database) => source === 'operator'
        ? verifySavedCardCancellation({ database, stripe, attemptId, intentId: intent.id, execute: true })
        : recordAuthenticationCancellation(intent, database));
      if (source === 'operator') expect(refusal?.message).toMatch(/does not match/);
      else expect(refusal).toBeNull();
    } finally {
      if (!change.isCompleted()) await change.rollback();
    }
    expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
  }, 15000);

  test.each([
    ['an operator', 'operator'],
    ['a signed webhook', 'signed webhook'],
  ])('%s cancellation waits for a row-precise merge, then records against its committed owner', async (_label, source) => {
    const { invoiceId, attemptId, intent, customerId } = await authenticationFixture(app);
    if (source === 'operator') await bindAttempt(app, { attemptId, intentId: intent.id });
    const stripe = { paymentIntents: { retrieve: jest.fn().mockResolvedValue(intent) } };
    const merge = await app.transaction();
    try {
      await recordInvoiceMerge(merge, { invoiceId, loserId: customerId, winnerId: randomUUID() });
      await commitWithWaitingCheckout(merge, (database) => source === 'operator'
        ? verifySavedCardCancellation({ database, stripe, attemptId, intentId: intent.id, execute: true })
        : recordAuthenticationCancellation(intent, database));
    } finally {
      if (!merge.isCompleted()) await merge.rollback();
    }
    expect(await app('stripe_invoice_charge_attempts').where({ id: attemptId }).first())
      .toMatchObject({
        authentication_canceled_intent_id: intent.id,
        stripe_payment_intent_id: source === 'operator' ? intent.id : null,
      });
    if (source === 'operator') expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
    else expect(await verdict(invoiceId, app, { checkout: true })).toMatchObject({ chargeAttemptId: attemptId });
  }, 15000);

  test('only the locally settled authentication challenge stays resolved when a dispute reopens its invoice', async () => {
    const { invoiceId, attemptId, intent, customerId } = await authenticationFixture(app);
    const paid = { ...intent, status: 'succeeded', amount: 2000, amount_received: 2000 };
    await app('stripe_invoice_charge_attempts').where({ id: attemptId }).update({ amount: 20, credit_applied_total: 5 });
    const invoice = () => app('invoices').where({ id: invoiceId });
    const attempt = () => app('stripe_invoice_charge_attempts').where({ id: attemptId }).first();
    const settle = (pi = paid) => app.transaction((trx) => recordAuthenticationSettlement(pi, trx));
    await invoice().update({ status: 'paid', stripe_payment_intent_id: paid.id });
    await settle();
    expect((await attempt()).status).toBe('failed');
    await app('payments').insert({ id: randomUUID(), customer_id: customerId, status: 'paid', amount: 20, processor: 'stripe', stripe_payment_intent_id: paid.id });
    await settle();
    expect((await attempt()).status).toBe('failed');
    await invoice().update({ credit_applied: 5 });
    await settle({ ...paid, amount_received: 1999 });
    expect((await attempt()).status).toBe('failed');
    await settle({ ...paid, payment_method: 'pm_wrong' });
    await settle({ ...paid, metadata: { ...paid.metadata, saved_card_attempt_id: randomUUID() } });
    await settle({ ...paid, status: 'processing' });
    expect((await attempt()).status).toBe('failed');
    const payment = () => app('payments').where({ stripe_payment_intent_id: paid.id });
    await payment().update({ processor: 'manual' });
    await settle();
    expect((await attempt()).status).toBe('failed');
    await payment().update({ processor: 'stripe', metadata: { invoice_id: randomUUID() } });
    await settle();
    expect((await attempt()).status).toBe('failed');
    await payment().update({ metadata: { invoice_id: invoiceId } });
    await expect(app.transaction(async (trx) => {
      await recordAuthenticationSettlement(paid, trx);
      throw new Error('settlement rolled back');
    })).rejects.toThrow('settlement rolled back');
    expect((await attempt()).status).toBe('failed');
    await settle();
    await settle();
    expect(await attempt()).toMatchObject({ status: 'succeeded', stripe_payment_intent_id: paid.id, decline_code: null });
    await invoice().update({ status: 'sent', stripe_payment_intent_id: null });
    await app('payments').where({ stripe_payment_intent_id: paid.id }).update({ status: 'disputed' });
    expect(await verdict(invoiceId, app, { checkout: true })).toBeNull();
  });

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
        status: 'failed', resolved_at: new Date(), decline_code: 'authentication_required',
        stripe_payment_intent_id: nextIntent.id, worker_payment_intent_id: nextIntent.id, stripe_payment_intent_bound_at: new Date(),
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
        worker_payment_intent_id: intent.id, stripe_payment_intent_bound_at: new Date(),
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

  test('a saved-card retry commits a locked stale-submitted promotion before returning its conflict', async () => {
    const invoiceId = randomUUID();
    const customerId = randomUUID();
    const staleAttemptId = randomUUID();
    const retryAttemptId = randomUUID();
    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    await app('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'sent', invoice_number: invoiceId, total: 25,
    });
    await app('stripe_invoice_charge_attempts').insert({
      id: staleAttemptId,
      invoice_id: invoiceId,
      status: 'claimed',
      submitted_at: staleAt,
      created_at: staleAt,
      updated_at: staleAt,
      idempotency_key: `inv_card_on_file_${invoiceId}_${staleAttemptId}`,
    });

    await expect(StripeService.claimInvoiceSavedCardCharge({
      invoiceId,
      paymentMethodId: randomUUID(),
      stripePaymentMethodId: 'pm_retry',
      attemptId: retryAttemptId,
      database: app,
    })).rejects.toMatchObject({
      code: 'STRIPE_AMBIGUOUS_OUTCOME',
      chargeAttemptId: staleAttemptId,
      reconciliationRequired: true,
    });

    expect(await app('stripe_invoice_charge_attempts').where({ id: staleAttemptId }).first())
      .toMatchObject({ status: 'ambiguous', resolved_at: null });
    expect(await app('stripe_invoice_charge_attempts').where({ id: retryAttemptId }).first()).toBeUndefined();
  });

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
