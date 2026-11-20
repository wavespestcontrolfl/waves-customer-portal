const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20261119090000_saved_card_authentication_success_backfill');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `auth_success_backfill_${randomUUID().replaceAll('-', '')}`;

postgres('saved-card authentication success backfill (PostgreSQL)', () => {
  let admin;
  let app;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });

    await app.schema.createTable('invoices', (table) => {
      table.uuid('id').primary();
      table.uuid('customer_id').notNullable();
      table.string('status');
      table.string('stripe_payment_intent_id');
      table.decimal('total', 12, 2);
      table.decimal('credit_applied', 12, 2);
    });
    await app.schema.createTable('stripe_invoice_charge_attempts', (table) => {
      table.uuid('id').primary();
      table.uuid('invoice_id').notNullable();
      table.uuid('payment_method_id');
      table.string('stripe_payment_method_id').notNullable();
      table.string('status').notNullable();
      table.string('stripe_payment_intent_id');
      table.string('decline_code');
      table.text('error_message');
      table.string('authentication_canceled_intent_id');
      table.decimal('amount', 12, 2);
      table.decimal('credit_applied_delta', 12, 2);
      table.decimal('credit_applied_total', 12, 2);
      table.timestamp('resolved_at');
      table.timestamp('created_at');
      table.timestamp('updated_at');
    });
    await app.schema.createTable('payments', (table) => {
      table.uuid('id').primary();
      table.uuid('customer_id');
      table.uuid('payment_method_id');
      table.string('processor');
      table.string('stripe_payment_intent_id');
      table.string('status');
      table.decimal('amount', 12, 2);
      table.integer('base_amount_cents');
      table.integer('surcharge_amount_cents');
      table.jsonb('metadata');
    });
    await app.schema.createTable('stripe_webhook_events', (table) => {
      table.string('id').primary();
      table.string('event_type').notNullable();
      table.boolean('processed').notNullable();
      table.jsonb('payload');
    });
  });

  beforeEach(async () => {
    await app('stripe_webhook_events').del();
    await app('payments').del();
    await app('stripe_invoice_charge_attempts').del();
    await app('invoices').del();
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  async function fixture({
    paymentStatus = 'paid',
    invoiceStatus = 'paid',
    bindAttemptToIntent = false,
    bindLedgerMethod = false,
    includeEvent = true,
    attemptPatch = {},
    webhookPatch = {},
    eventPatch = {},
    eventMetadataPatch = {},
    paymentPatch = {},
    paymentMetadataPatch = {},
    paymentMethodAsObject = false,
    invoicePatch = {},
  } = {}) {
    const ids = {
      attemptId: randomUUID(),
      invoiceId: randomUUID(),
      customerId: randomUUID(),
      paymentMethodId: randomUUID(),
      stripePaymentMethodId: `pm_${randomUUID().replaceAll('-', '')}`,
      piId: `pi_${randomUUID().replaceAll('-', '')}`,
    };
    const now = new Date(Date.now() - 60_000);
    await app('invoices').insert({
      id: ids.invoiceId,
      customer_id: ids.customerId,
      status: invoiceStatus,
      stripe_payment_intent_id: invoiceStatus === 'paid' ? ids.piId : null,
      total: 100,
      credit_applied: 25,
      ...invoicePatch,
    });
    await app('stripe_invoice_charge_attempts').insert({
      id: ids.attemptId,
      invoice_id: ids.invoiceId,
      payment_method_id: ids.paymentMethodId,
      stripe_payment_method_id: ids.stripePaymentMethodId,
      status: 'failed',
      stripe_payment_intent_id: bindAttemptToIntent ? ids.piId : null,
      decline_code: 'authentication_required',
      error_message: 'Card verification required',
      resolved_at: now,
      created_at: now,
      updated_at: now,
      amount: 75,
      credit_applied_delta: 25,
      credit_applied_total: 25,
      ...attemptPatch,
    });
    await app('payments').insert({
      id: randomUUID(),
      customer_id: ids.customerId,
      payment_method_id: bindLedgerMethod ? ids.paymentMethodId : null,
      processor: 'stripe',
      stripe_payment_intent_id: ids.piId,
      status: paymentStatus,
      amount: 75,
      base_amount_cents: 7500,
      surcharge_amount_cents: 0,
      metadata: {
        invoice_id: ids.invoiceId,
        base_amount: 75,
        card_surcharge: 0,
        ...paymentMetadataPatch,
      },
      ...paymentPatch,
    });
    if (includeEvent) {
      await app('stripe_webhook_events').insert({
        id: `evt_${randomUUID().replaceAll('-', '')}`,
        event_type: 'payment_intent.succeeded',
        processed: true,
        payload: {
          object: {
            id: ids.piId,
            status: 'succeeded',
            amount: 7500,
            amount_received: 7500,
            payment_method: paymentMethodAsObject
              ? { id: ids.stripePaymentMethodId }
              : ids.stripePaymentMethodId,
            metadata: {
              source: 'admin_card_on_file',
              saved_card_attempt_id: ids.attemptId,
              waves_invoice_id: ids.invoiceId,
              waves_customer_id: ids.customerId,
              base_amount: '75',
              card_surcharge: '0',
              ...eventMetadataPatch,
            },
            ...eventPatch,
          },
        },
        ...webhookPatch,
      });
    }
    return ids;
  }

  const attempt = (id) => app('stripe_invoice_charge_attempts').where({ id }).first();

  test.each([
    ['paid', 'paid', false, false, true, {}],
    ['disputed', 'overdue', true, false, false, {}],
    ['refunded', 'refunded', false, true, false, { credit_applied: 0 }],
  ])('repairs retained attempt-specific success with exact locally settled %s evidence after the invoice is %s', async (
    paymentStatus,
    invoiceStatus,
    paymentMethodAsObject,
    bindAttemptToIntent,
    bindLedgerMethod,
    invoicePatch,
  ) => {
    const ids = await fixture({
      paymentStatus, invoiceStatus, paymentMethodAsObject, bindAttemptToIntent, bindLedgerMethod, invoicePatch,
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'succeeded',
      stripe_payment_intent_id: ids.piId,
      decline_code: null,
      error_message: null,
    });
  });

  test('repairs a captured surcharge only when the event, attempt, ledger parts and paid invoice agree', async () => {
    const ids = await fixture({
      invoicePatch: { total: 101.88 },
      attemptPatch: { amount: 76.88 },
      paymentPatch: { amount: 76.88, base_amount_cents: 7500, surcharge_amount_cents: 188 },
      eventPatch: { amount: 7688, amount_received: 7688 },
      eventMetadataPatch: { base_amount: '75', card_surcharge: '1.88' },
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'succeeded',
      stripe_payment_intent_id: ids.piId,
      decline_code: null,
    });
  });

  test.each([
    ['without a surcharge', {}],
    ['with a captured surcharge', {
      invoicePatch: { total: 101.88 },
      attemptPatch: { amount: 76.88 },
      paymentPatch: { amount: 76.88 },
      eventPatch: { amount: 7688, amount_received: 7688 },
      eventMetadataPatch: { base_amount: '75', card_surcharge: '1.88' },
    }],
  ])('repairs an older paid ledger %s when its optional component columns were never populated', async (
    _description,
    patches,
  ) => {
    const ids = await fixture({
      ...patches,
      paymentPatch: {
        ...patches.paymentPatch,
        base_amount_cents: null,
        surcharge_amount_cents: null,
      },
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'succeeded',
      stripe_payment_intent_id: ids.piId,
      decline_code: null,
    });
  });

  test.each([
    ['includes the earlier hand payment', 130, true],
    ['does not omit the earlier hand payment', 100, false],
  ])('a paid invoice %s in its durable total', async (_description, invoiceTotal, repaired) => {
    const ids = await fixture({ invoicePatch: { total: invoiceTotal } });
    await app('payments').insert({
      id: randomUUID(),
      customer_id: ids.customerId,
      amount: 30,
      status: 'paid',
      metadata: { invoice_id: ids.invoiceId, partial_payment: true },
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: repaired ? 'succeeded' : 'failed',
      decline_code: repaired ? null : 'authentication_required',
    });
  });

  test.each([
    ['disputed', 'overdue'],
    ['refunded', 'refunded'],
  ])('keeps %s evidence held when any immutable captured-money record disagrees', async (paymentStatus, invoiceStatus) => {
    const cases = [];
    cases.push(await fixture({ paymentStatus, invoiceStatus, eventPatch: { amount: 7400 } }));
    cases.push(await fixture({ paymentStatus, invoiceStatus, eventPatch: { amount_received: 7400 } }));
    cases.push(await fixture({ paymentStatus, invoiceStatus, attemptPatch: { amount: 74 } }));
    cases.push(await fixture({ paymentStatus, invoiceStatus, paymentPatch: { amount: 74 } }));
    cases.push(await fixture({ paymentStatus, invoiceStatus, paymentPatch: { base_amount_cents: 7400 } }));
    cases.push(await fixture({ paymentStatus, invoiceStatus, paymentPatch: { surcharge_amount_cents: 100 } }));

    await migration.up(app);

    for (const ids of cases) {
      expect(await attempt(ids.attemptId)).toMatchObject({
        status: 'failed',
        decline_code: 'authentication_required',
      });
    }
  });

  test.each([
    ['paid', 'paid'],
    ['disputed', 'overdue'],
    ['refunded', 'refunded'],
  ])('keeps a legacy PI binding with %s ledger evidence held after attempt-specific event expiry', async (
    paymentStatus,
    invoiceStatus,
  ) => {
    const ids = await fixture({
      paymentStatus,
      invoiceStatus,
      bindAttemptToIntent: true,
      includeEvent: false,
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'failed',
      stripe_payment_intent_id: ids.piId,
      decline_code: 'authentication_required',
      error_message: 'Card verification required',
    });
  });

  test.each([false, true])('keeps a paid ledger row held while its invoice is open (PI bound: %s)', async (bound) => {
    const ids = await fixture({
      paymentStatus: 'paid',
      invoiceStatus: 'overdue',
      bindAttemptToIntent: bound,
      includeEvent: !bound,
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_intent_id: bound ? ids.piId : null,
    });
  });

  test('keeps a paid ledger row held when the invoice was reopened but still carries the old PI', async () => {
    const ids = await fixture({ paymentStatus: 'paid', invoiceStatus: 'overdue' });
    await app('invoices').where({ id: ids.invoiceId }).update({ stripe_payment_intent_id: ids.piId });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_intent_id: null,
    });
  });

  test('keeps a paid ledger row held when the paid invoice points to a different PI', async () => {
    const ids = await fixture({ paymentStatus: 'paid', invoiceStatus: 'paid' });
    await app('invoices').where({ id: ids.invoiceId }).update({
      stripe_payment_intent_id: `pi_${randomUUID().replaceAll('-', '')}`,
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_intent_id: null,
    });
  });

  test('keeps every incomplete or contradictory candidate held', async () => {
    const cases = [];
    cases.push(await fixture({ attemptPatch: { decline_code: 'insufficient_funds' } }));
    cases.push(await fixture({ attemptPatch: { resolved_at: null } }));
    cases.push(await fixture({ attemptPatch: { stripe_payment_intent_id: 'pi_different' } }));
    cases.push(await fixture({ includeEvent: false }));
    cases.push(await fixture({ webhookPatch: { processed: false } }));
    cases.push(await fixture({ eventPatch: { status: 'processing' } }));
    cases.push(await fixture({ eventPatch: { amount: null } }));
    cases.push(await fixture({ eventPatch: { amount: 7400 } }));
    cases.push(await fixture({ eventPatch: { amount_received: null } }));
    cases.push(await fixture({ eventPatch: { amount_received: 7400 } }));
    cases.push(await fixture({ eventMetadataPatch: { base_amount: '74' } }));
    cases.push(await fixture({ eventMetadataPatch: { card_surcharge: '1' } }));
    cases.push(await fixture({ eventMetadataPatch: { base_amount: 'not-money' } }));
    cases.push(await fixture({ eventPatch: { payment_method: 'pm_different' } }));
    cases.push(await fixture({ eventMetadataPatch: { source: 'other_source' } }));
    cases.push(await fixture({ eventMetadataPatch: { saved_card_attempt_id: randomUUID() } }));
    cases.push(await fixture({ eventMetadataPatch: { waves_invoice_id: randomUUID() } }));
    cases.push(await fixture({ eventMetadataPatch: { waves_customer_id: randomUUID() } }));
    cases.push(await fixture({ paymentPatch: { customer_id: randomUUID() } }));
    cases.push(await fixture({ paymentPatch: { processor: null } }));
    cases.push(await fixture({ paymentPatch: { status: 'failed' } }));
    cases.push(await fixture({ paymentPatch: { amount: null } }));
    cases.push(await fixture({ paymentPatch: { amount: 74 } }));
    cases.push(await fixture({ paymentPatch: { base_amount_cents: 7400 } }));
    cases.push(await fixture({ paymentPatch: { surcharge_amount_cents: 100 } }));
    cases.push(await fixture({ paymentMetadataPatch: { invoice_id: randomUUID() } }));
    cases.push(await fixture({ paymentPatch: { payment_method_id: randomUUID() } }));
    cases.push(await fixture({ attemptPatch: { amount: null } }));
    cases.push(await fixture({ attemptPatch: { amount: 74 } }));
    cases.push(await fixture({ attemptPatch: { credit_applied_delta: null } }));
    cases.push(await fixture({ attemptPatch: { credit_applied_total: null } }));
    cases.push(await fixture({ attemptPatch: { credit_applied_delta: 26, credit_applied_total: 25 } }));
    cases.push(await fixture({ invoicePatch: { credit_applied: 0 } }));
    cases.push(await fixture({ invoicePatch: { total: 99 } }));

    await migration.up(app);

    for (const ids of cases) {
      expect(await attempt(ids.attemptId)).toMatchObject({
        status: 'failed',
        decline_code: expect.any(String),
      });
    }
  });

  test('refuses multiple candidate PIs and a PI linked to another invoice', async () => {
    const ambiguous = await fixture({ invoiceStatus: 'overdue' });
    const secondPi = `pi_${randomUUID().replaceAll('-', '')}`;
    await app('payments').insert({
      id: randomUUID(),
      customer_id: ambiguous.customerId,
      processor: 'stripe',
      stripe_payment_intent_id: secondPi,
      status: 'disputed',
      metadata: { invoice_id: ambiguous.invoiceId },
    });
    await app('stripe_webhook_events').insert({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      event_type: 'payment_intent.succeeded',
      processed: true,
      payload: {
        object: {
          id: secondPi,
          status: 'succeeded',
          payment_method: ambiguous.stripePaymentMethodId,
          metadata: {
            source: 'admin_card_on_file',
            saved_card_attempt_id: ambiguous.attemptId,
            waves_invoice_id: ambiguous.invoiceId,
            waves_customer_id: ambiguous.customerId,
          },
        },
      },
    });

    const crossLinked = await fixture({
      invoiceStatus: 'overdue', bindAttemptToIntent: true, includeEvent: false,
    });
    await app('payments').insert({
      id: randomUUID(),
      customer_id: randomUUID(),
      processor: 'stripe',
      stripe_payment_intent_id: crossLinked.piId,
      status: 'paid',
      metadata: { invoice_id: randomUUID() },
    });

    await migration.up(app);

    expect(await attempt(ambiguous.attemptId)).toMatchObject({ status: 'failed', stripe_payment_intent_id: null });
    expect(await attempt(crossLinked.attemptId)).toMatchObject({
      status: 'failed', stripe_payment_intent_id: crossLinked.piId,
    });
  });

  test.each([false, true])('two retained successes and one local settlement stay held (PI bound: %s)', async (bound) => {
    const ambiguous = await fixture({ invoiceStatus: 'overdue', bindAttemptToIntent: bound });
    const unrecordedPi = `pi_${randomUUID().replaceAll('-', '')}`;
    await app('stripe_webhook_events').insert({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      event_type: 'payment_intent.succeeded',
      processed: true,
      payload: {
        object: {
          id: unrecordedPi,
          status: 'succeeded',
          payment_method: ambiguous.stripePaymentMethodId,
          metadata: {
            source: 'admin_card_on_file',
            saved_card_attempt_id: ambiguous.attemptId,
            waves_invoice_id: ambiguous.invoiceId,
            waves_customer_id: ambiguous.customerId,
          },
        },
      },
    });

    await migration.up(app);

    expect(await attempt(ambiguous.attemptId)).toMatchObject({
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_intent_id: bound ? ambiguous.piId : null,
    });
    expect(await app('payments').where({ stripe_payment_intent_id: unrecordedPi })).toHaveLength(0);
  });

  test.each([
    ['captured cents', { amount: 7600, amount_received: 7600 }, { base_amount: '76', card_surcharge: '0' }],
    ['principal and surcharge parts', { amount: 7500, amount_received: 7500 }, { base_amount: '74', card_surcharge: '1' }],
  ])('keeps exact local settlement held when a duplicate success event conflicts on %s', async (
    _description,
    amountPatch,
    metadataPatch,
  ) => {
    const ids = await fixture();
    await app('stripe_webhook_events').insert({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      event_type: 'payment_intent.succeeded',
      processed: true,
      payload: {
        object: {
          id: ids.piId,
          status: 'succeeded',
          payment_method: ids.stripePaymentMethodId,
          ...amountPatch,
          metadata: {
            source: 'admin_card_on_file',
            saved_card_attempt_id: ids.attemptId,
            waves_invoice_id: ids.invoiceId,
            waves_customer_id: ids.customerId,
            ...metadataPatch,
          },
        },
      },
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'failed',
      decline_code: 'authentication_required',
    });
  });

  test.each([
    ['an exact duplicate', {}],
    ['a conflicting duplicate', { amount: 74, base_amount_cents: 7400 }],
  ])('keeps a PI with %s local ledger row held', async (_description, patch) => {
    const ids = await fixture();
    await app('payments').insert({
      id: randomUUID(),
      customer_id: ids.customerId,
      payment_method_id: null,
      processor: 'stripe',
      stripe_payment_intent_id: ids.piId,
      status: 'paid',
      amount: 75,
      base_amount_cents: 7500,
      surcharge_amount_cents: 0,
      metadata: { invoice_id: ids.invoiceId, base_amount: 75, card_surcharge: 0 },
      ...patch,
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'failed',
      decline_code: 'authentication_required',
    });
  });

  test('keeps exact success and ledger held when the retained PI also names a different attempt', async () => {
    const ids = await fixture({ bindAttemptToIntent: true });
    await app('stripe_webhook_events').insert({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      event_type: 'payment_intent.succeeded',
      processed: true,
      payload: {
        object: {
          id: ids.piId,
          status: 'succeeded',
          payment_method: ids.stripePaymentMethodId,
          metadata: {
            source: 'admin_card_on_file',
            saved_card_attempt_id: randomUUID(),
            waves_invoice_id: ids.invoiceId,
            waves_customer_id: ids.customerId,
          },
        },
      },
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_intent_id: ids.piId,
    });
  });

  test('keeps a bound success held when the same PI has exact cancellation evidence', async () => {
    const ids = await fixture({ bindAttemptToIntent: true });
    await app('stripe_invoice_charge_attempts').where({ id: ids.attemptId }).update({
      authentication_canceled_intent_id: ids.piId,
    });

    await migration.up(app);

    expect(await attempt(ids.attemptId)).toMatchObject({
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_intent_id: ids.piId,
      authentication_canceled_intent_id: ids.piId,
    });
  });

  test('is idempotent and its rollback never recreates a collectible hold', async () => {
    const ids = await fixture({ paymentStatus: 'refunded', invoiceStatus: 'refunded' });
    await migration.up(app);
    const repaired = await attempt(ids.attemptId);

    await migration.up(app);
    expect(await attempt(ids.attemptId)).toEqual(repaired);

    await migration.down(app);
    expect(await attempt(ids.attemptId)).toEqual(repaired);
  });
});
