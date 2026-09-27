const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const database = (...args) => mockDatabase(...args);
  database.transaction = (...args) => mockDatabase.transaction(...args);
  database.raw = (...args) => mockDatabase.raw(...args);
  Object.defineProperty(database, 'client', { get: () => mockDatabase.client });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Reservation = require('../services/billing-email-reservation');
const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');

const postgres = SKIP ? describe.skip : describe;
const schema = `billing_email_reservation_${randomUUID().replaceAll('-', '')}`;
let admin;

function context({ customerId, invoiceId, eventKey, ledgerId, source = 'late_payment_checker' }) {
  return {
    schema_version: 1,
    customer_id: customerId,
    invoice_id: invoiceId,
    category: 'billing',
    source_entry_point: source,
    notificationEventKey: eventKey,
    collections_ledger_id: ledgerId,
    ...(source === 'invoice_followup_sequence'
      ? { followup_sequence_id: 'sequence-1', rendered_amount: '89.00' }
      : {}),
  };
}

function message(replay, overrides = {}) {
  return {
    id: randomUUID(),
    template_key: 'billing.notice',
    recipient_type: 'customer',
    recipient_id: replay.customer_id,
    recipient_email_snapshot: 'qa@example.invalid',
    trigger_event_id: replay.notificationEventKey,
    idempotency_key: `billing_channel_email:${replay.notificationEventKey}:email`,
    payload_snapshot: { __billing_replay_context: replay },
    categories: JSON.stringify(['billing']),
    provider_message_id: null,
    provider_handoff_phase: null,
    status: null,
    error_message: null,
    provider_retry_exhausted_at: null,
    sent_at: null,
    delivered_at: null,
    opened_at: null,
    clicked_at: null,
    ...overrides,
  };
}

function ledger({ id = randomUUID(), customerId, invoiceId, eventKey, channel = 'email',
  source = 'late_payment_checker', metadata = {} }) {
  return {
    id,
    customer_id: customerId,
    channel,
    purpose: 'late_payment',
    invoice_ids: JSON.stringify([invoiceId]),
    source,
    occurred_at: new Date(),
    metadata: JSON.stringify({ notificationEventKey: eventKey, ...metadata }),
  };
}

postgres('billing Email reservation reconciliation (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockDatabase = knex({ client: 'pg', connection: process.env.DATABASE_URL,
      searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockDatabase.schema.createTable('collections_contact_ledger', (table) => {
      table.uuid('id').primary();
      table.uuid('customer_id').notNullable();
      table.string('channel', 20).notNullable();
      table.string('purpose', 40).notNullable();
      table.jsonb('invoice_ids').notNullable();
      table.timestamp('occurred_at', { useTz: true }).notNullable();
      table.string('source', 60).notNullable();
      table.jsonb('metadata');
    });
    await mockDatabase.schema.createTable('email_messages', (table) => {
      table.uuid('id').primary();
      table.string('template_key');
      table.string('recipient_type');
      table.uuid('recipient_id');
      table.string('recipient_email_snapshot');
      table.string('trigger_event_id');
      table.string('idempotency_key');
      table.jsonb('payload_snapshot');
      table.jsonb('categories');
      table.string('provider_message_id');
      table.string('send_attempt_token');
      table.string('provider_handoff_attempt_token');
      table.string('provider_handoff_phase');
      table.string('status');
      table.text('error_message');
      table.timestamp('provider_retry_exhausted_at', { useTz: true });
      table.timestamp('provider_retry_next_at', { useTz: true });
      table.integer('provider_retry_count').notNullable().defaultTo(0);
      table.timestamp('queued_at', { useTz: true });
      table.timestamp('sent_at', { useTz: true });
      table.timestamp('delivered_at', { useTz: true });
      table.timestamp('opened_at', { useTz: true });
      table.timestamp('clicked_at', { useTz: true });
      table.timestamp('updated_at', { useTz: true });
    });
    await mockDatabase.schema.createTable('email_message_events', (table) => {
      table.uuid('id').primary().defaultTo(mockDatabase.raw('gen_random_uuid()'));
      table.uuid('email_message_id').notNullable();
      table.string('provider');
      table.string('provider_event_id');
      table.string('event_type').notNullable();
      table.jsonb('raw_event');
      table.timestamp('occurred_at', { useTz: true });
    });
    await mockDatabase.schema.createTable('scheduled_services', (table) => {
      table.uuid('id').primary();
      table.uuid('customer_id').notNullable();
      table.timestamp('balance_reminder_sent_at', { useTz: true });
      table.date('scheduled_date'); table.uuid('payer_id'); table.boolean('is_recurring');
      table.text('status'); table.text('service_type');
    });
    await mockDatabase.schema.createTable('customers', (table) => {
      table.uuid('id').primary(); table.timestamp('deleted_at'); table.decimal('monthly_rate'); table.integer('billing_day');
      for (const field of ['first_name', 'phone', 'billing_mode', 'waveguard_tier']) table.text(field);
    });
    await mockDatabase.schema.createTable('sms_templates', (table) => {
      table.text('template_key'); table.boolean('is_active');
    });
    await mockDatabase('sms_templates').insert({ template_key: 'previsit_balance_reminder', is_active: true });
  }, 30000);

  afterEach(async () => {
    await mockDatabase('email_message_events').del();
    await mockDatabase('email_messages').del();
    await mockDatabase('collections_contact_ledger').del();
    await mockDatabase('scheduled_services').del();
  });

  afterAll(async () => {
    await mockDatabase?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test('delivery stamps only the fully bound Email row', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const eventKey = `late-payment:${invoiceId}:14`;
    const email = ledger({ customerId, invoiceId, eventKey });
    const sibling = ledger({ customerId, invoiceId, eventKey, channel: 'sms' });
    const wrongSource = ledger({ customerId, invoiceId, eventKey, source: 'invoice_followup_sequence' });
    await mockDatabase('collections_contact_ledger').insert([email, sibling, wrongSource]);
    const accepted = [email, sibling, wrongSource].map((entry) => message(
      context({ customerId, invoiceId, eventKey, ledgerId: entry.id }),
      { sent_at: new Date() },
    ));
    await mockDatabase('email_messages').insert(accepted);

    await expect(Reservation.markBillingEmailReservationDelivered(
      accepted[0], mockDatabase,
    )).resolves.toBe(true);
    await expect(Reservation.markBillingEmailReservationDelivered(
      accepted[1], mockDatabase,
    )).resolves.toBe(false);
    await expect(Reservation.markBillingEmailReservationDelivered(
      accepted[2], mockDatabase,
    )).resolves.toBe(false);

    const rows = await mockDatabase('collections_contact_ledger').orderBy('channel');
    expect(rows.find((row) => row.id === email.id).metadata.delivered).toBe(true);
    expect(rows.find((row) => row.id === sibling.id).metadata.delivered).toBeUndefined();
    expect(rows.find((row) => row.id === wrongSource.id).metadata.delivered).toBeUndefined();
  });

  test.each([
    ['current-attempt read', 'email_messages', 'send_attempt_token', 'hidden_send_attempt_token'],
    ['ledger stamp', 'collections_contact_ledger', 'metadata', 'hidden_metadata'],
  ])('a failed accepted %s rolls back its savepoint and leaves the supplied transaction usable', async (
    _label, table, column, hiddenColumn,
  ) => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const eventKey = `late-payment:${invoiceId}:savepoint`;
    const email = ledger({ customerId, invoiceId, eventKey });
    const accepted = message(context({ customerId, invoiceId, eventKey, ledgerId: email.id }), {
      status: 'sent', sent_at: new Date(),
    });
    await mockDatabase('collections_contact_ledger').insert(email);
    await mockDatabase('email_messages').insert(accepted);

    await expect(mockDatabase.transaction(async (parentTrx) => {
      await parentTrx.schema.alterTable(table, (schemaTable) => schemaTable.renameColumn(column, hiddenColumn));
      await expect(Reservation.markBillingEmailReservationDelivered(accepted, parentTrx)).resolves.toBe(false);
      await expect(parentTrx.raw('SELECT 1 AS still_usable')).resolves.toMatchObject({ rows: [{ still_usable: 1 }] });
      await parentTrx.schema.alterTable(table, (schemaTable) => schemaTable.renameColumn(hiddenColumn, column));
    })).resolves.toBeUndefined();

    const untouched = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    expect(untouched.metadata.delivered).toBeUndefined();
  });

  function pauseAcceptedSnapshot() {
    let snapshotRead;
    let releaseSnapshot;
    const snapshotReady = new Promise((resolve) => { snapshotRead = resolve; });
    const resumed = new Promise((resolve) => { releaseSnapshot = resolve; });
    let outerEmailRead = true;
    const database = (table) => {
      if (table === 'email_messages' && outerEmailRead) {
        outerEmailRead = false;
        return { whereIn: async (column, values) => {
          const snapshot = await mockDatabase(table).whereIn(column, values);
          snapshotRead();
          await resumed;
          return snapshot;
        } };
      }
      return mockDatabase(table);
    };
    database.transaction = (...args) => mockDatabase.transaction(...args);
    database.raw = (...args) => mockDatabase.raw(...args);
    return { database, snapshotReady, releaseSnapshot };
  }

  test.each(['replaced token', 'cleared acceptance'])(
    'accepted repair does not stamp a stale snapshot after %s', async (change) => {
      const customerId = randomUUID();
      const invoiceId = randomUUID();
      const eventKey = `late-payment:${invoiceId}:repair-race`;
      const email = ledger({ customerId, invoiceId, eventKey });
      const accepted = message(context({ customerId, invoiceId, eventKey, ledgerId: email.id }), {
        status: 'sent', sent_at: new Date(), send_attempt_token: 'old-attempt',
      });
      await mockDatabase('collections_contact_ledger').insert(email);
      await mockDatabase('email_messages').insert(accepted);
      const loaded = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
      const paused = pauseAcceptedSnapshot();
      const repairing = Reservation.repairAcceptedBillingEmailReservations([loaded], paused.database);
      await paused.snapshotReady;
      try {
        await mockDatabase('email_messages').where({ id: accepted.id }).update(change === 'replaced token'
          ? { send_attempt_token: 'new-attempt' } : { sent_at: null, status: 'queued' });
        await mockDatabase('collections_contact_ledger').where({ id: email.id }).update({
          metadata: { notificationEventKey: eventKey, send_failed: true },
        });
      } finally { paused.releaseSnapshot(); }
      await expect(repairing).resolves.toEqual(new Set());
      const current = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
      expect(current.metadata).toMatchObject({ send_failed: true });
      expect(current.metadata.delivered).toBeUndefined();
      expect(loaded.metadata).toEqual(current.metadata);
    },
  );

  test('persisted invoice-followup replay repairs its invoice_followups reservation', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const eventKey = 'invoice-followup:sequence-1:day-3';
    const email = ledger({ customerId, invoiceId, eventKey, source: 'invoice_followups' });
    const stored = message(context({ customerId, invoiceId, eventKey, ledgerId: email.id,
      source: 'invoice_followup_sequence' }), { status: 'sent', sent_at: new Date() });
    await mockDatabase('collections_contact_ledger').insert(email);
    await mockDatabase('email_messages').insert(stored);

    const progress = await require('../services/billing-reminder-delivery')
      .reminderProgress(customerId, 'invoice_followups', ['email']);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ complete: true });
    expect(progress[0].delivered).toEqual(new Set(['email']));
    await expect(mockDatabase('collections_contact_ledger').where({ id: email.id }).first())
      .resolves.toMatchObject({ metadata: expect.objectContaining({ delivered: true }) });
  });

  test('terminal refusal resolves only Email and never claims delivery', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const eventKey = `late-payment:${invoiceId}:30`;
    const email = ledger({ customerId, invoiceId, eventKey });
    const sibling = ledger({ customerId, invoiceId, eventKey, channel: 'sms' });
    await mockDatabase('collections_contact_ledger').insert([email, sibling]);

    await expect(Reservation.resolveBillingEmailReservationRefusal(
      message(context({ customerId, invoiceId, eventKey, ledgerId: email.id })), mockDatabase,
    )).resolves.toBe(true);
    const rows = await mockDatabase('collections_contact_ledger').whereIn('id', [email.id, sibling.id]);
    expect(rows.find((row) => row.id === email.id).metadata).toMatchObject({
      send_failed: true, resolved: true, resolution: 'email_terminal_refusal',
    });
    expect(rows.find((row) => row.id === email.id).metadata.delivered).toBeUndefined();
    expect(rows.find((row) => row.id === sibling.id).metadata.resolved).toBeUndefined();
  });

  test('verified delivered handler stamps the bound Email reservation', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const eventKey = `late-payment:${invoiceId}:delivered`;
    const email = ledger({ customerId, invoiceId, eventKey });
    const sibling = ledger({ customerId, invoiceId, eventKey, channel: 'sms' });
    const stored = message(context({ customerId, invoiceId, eventKey, ledgerId: email.id }), {
      provider_message_id: 'provider-delivered', status: 'sent', sent_at: new Date(),
    });
    await mockDatabase('collections_contact_ledger').insert([email, sibling]);
    await mockDatabase('email_messages').insert(stored);

    await mockDatabase('email_messages').where({ id: stored.id }).update({ send_attempt_token: 'new-attempt' });
    await mockDatabase.transaction((trx) => handleEmailMessageEvent({ event: 'delivered' }, stored, trx));
    expect((await mockDatabase('collections_contact_ledger').where({ id: email.id }).first()).metadata.delivered).toBeUndefined();
    stored.send_attempt_token = 'new-attempt';
    await mockDatabase.transaction((trx) => handleEmailMessageEvent({
      event: 'delivered', email: stored.recipient_email_snapshot,
      sg_event_id: 'event-delivered', timestamp: Math.floor(Date.now() / 1000),
    }, stored, trx));

    const delivered = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    const untouched = await mockDatabase('collections_contact_ledger').where({ id: sibling.id }).first();
    expect(delivered.metadata.delivered).toBe(true);
    expect(untouched.metadata.delivered).toBeUndefined();
    await expect(mockDatabase('email_messages').where({ id: stored.id }).first())
      .resolves.toMatchObject({ status: 'delivered', delivered_at: expect.any(Date) });
  });

  async function requoteFixture({ delivered = false } = {}) {
    const customerId = randomUUID();
    const invoiceIds = [randomUUID(), randomUUID()];
    const appointmentId = randomUUID();
    const eventKey = `previsit-balance:${appointmentId}`;
    const email = ledger({ customerId, invoiceId: invoiceIds[0], eventKey,
      source: 'previsit_balance_reminder', metadata: { amount: 100, ...(delivered ? { delivered: true } : {}) } });
    email.invoice_ids = JSON.stringify(invoiceIds);
    const replay = { schema_version: 1, customer_id: customerId, category: 'billing',
      source_entry_point: 'previsit_balance_reminder', notificationEventKey: eventKey,
      collections_ledger_id: email.id, invoice_ids: invoiceIds, rendered_amount: '100.00',
      invoice_quotes: [{ id: invoiceIds[0], dueCents: 4000 }, { id: invoiceIds[1], dueCents: 6000 }],
      dues_cents: 0, selected_channels: ['email'],
      appointment_id: appointmentId, appointment_date: '2030-06-10', appointment_rendered_on: '2030-06-09',
      appointment_service_type: 'Pest Control' };
    const stopped = message(replay, { status: 'failed', provider_retry_exhausted_at: new Date(),
      send_attempt_token: 'old-attempt', provider_handoff_attempt_token: 'old-attempt',
      provider_handoff_phase: 'pending',
      error_message: `${Reservation.BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX}previsit-quote-changed` });
    await mockDatabase('collections_contact_ledger').insert(email);
    await mockDatabase('email_messages').insert(stopped);
    await mockDatabase('scheduled_services').insert({
      id: appointmentId, customer_id: customerId, balance_reminder_sent_at: new Date(),
    });
    return { customerId, invoiceIds, appointmentId, email, stopped };
  }

  async function withTwoConnections(run) {
    const prior = mockDatabase;
    const gate = process.env.PREVISIT_BALANCE_REMINDER;
    const limited = knex({ client: 'pg', connection: process.env.DATABASE_URL,
      searchPath: [schema], pool: { min: 0, max: 2 }, acquireConnectionTimeout: 2000 });
    mockDatabase = limited;
    process.env.PREVISIT_BALANCE_REMINDER = 'true';
    try { return await run(limited); } finally {
      mockDatabase = prior;
      if (gate === undefined) delete process.env.PREVISIT_BALANCE_REMINDER;
      else process.env.PREVISIT_BALANCE_REMINDER = gate;
      await limited.destroy();
    }
  }

  test('retirement waits for a newer producer snapshot, then recovers its idle claim with two connections', async () => {
    const { customerId, appointmentId, email, stopped } = await requoteFixture({ delivered: true });
    const newerClaim = new Date(Date.now() + 1000);
    await mockDatabase('scheduled_services').where({ id: appointmentId }).update({ balance_reminder_sent_at: newerClaim });
    await withTwoConnections(async (database) => {
      const { runExclusive } = require('../utils/cron-lock');
      await runExclusive('previsit-balance-reminder', async () => {
        // The public service must reuse this scheduler lease's connection.
        await expect(require('../services/previsit-balance-reminder').runSweep())
          .resolves.toMatchObject({ considered: 0 });
        const [snapshot] = await require('../services/billing-reminder-delivery')
          .reminderProgress(customerId, 'previsit_balance_reminder', ['email', 'sms']);
        expect(snapshot.delivered.has('email')).toBe(true);
        await expect(Reservation.releaseBillingEmailReservationForRequote(stopped, database)).resolves.toBe(false);
        await expect(database('collections_contact_ledger').where({ id: email.id }).first())
          .resolves.toMatchObject({ metadata: { delivered: true } });
        await expect(database('scheduled_services').where({ id: appointmentId }).first())
          .resolves.toMatchObject({ balance_reminder_sent_at: newerClaim });
        await expect(database('email_messages').where({ id: stopped.id }).first())
          .resolves.toMatchObject({ error_message: stopped.error_message });
      }, { recordHealth: false, waitForSlot: false });
      await expect(require('../services/transactional-email-provider-retry').recoverStaleClaims(new Date(), database))
        .resolves.toBe(1);
      await expect(database('scheduled_services').where({ id: appointmentId }).first())
        .resolves.toMatchObject({ balance_reminder_sent_at: null });
      await expect(database('collections_contact_ledger').where({ id: email.id }).first())
        .resolves.toMatchObject({ metadata: { send_failed: true } });
    });
  }, 30000);

  test('retirement cannot reopen a newer Email reservation before its adapter replaces the old token', async () => {
    const { email, stopped } = await requoteFixture();
    await mockDatabase('collections_contact_ledger').where({ id: email.id })
      .update({ metadata: mockDatabase.raw("metadata || '{\"send_failed\": true}'::jsonb") });
    await withTwoConnections(async (database) => {
      await require('../utils/cron-lock').runExclusive('previsit-balance-reminder', async () => {
        const ContactLedger = require('../services/collections/contact-ledger');
        const row = await database('collections_contact_ledger').where({ id: email.id }).first();
        await expect(ContactLedger.claimAttempt({ ...row, reused: true }, { metadata: { amount: 60 } }))
          .resolves.toEqual({ allowed: true });
        await expect(Reservation.releaseBillingEmailReservationForRequote(stopped, database)).resolves.toBe(false);
        await expect(database('collections_contact_ledger').where({ id: email.id }).first())
          .resolves.toMatchObject({ metadata: { amount: 60, send_failed: false } });
      }, { recordHealth: false, waitForSlot: false });
    });
  }, 30000);

  test('the retirement transaction prevents a direct sweep from taking any visit claim', async () => {
    const { appointmentId } = await requoteFixture({ delivered: true });
    await withTwoConnections(async (database) => {
      const held = await database.transaction();
      try {
        await held.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['cron:previsit-balance-reminder']);
        await expect(require('../services/previsit-balance-reminder').runSweep())
          .resolves.toEqual({ skipped: true, reason: 'lease_held' });
        await expect(database('scheduled_services').where({ id: appointmentId }).first())
          .resolves.toMatchObject({ balance_reminder_sent_at: expect.any(Date) });
      } finally { await held.rollback(); }
    });
  }, 30000);

  test('changed-quote repair reopens a delivered Email reservation and releases its visit claim', async () => {
    const { customerId, invoiceIds, appointmentId, email } = await requoteFixture({ delivered: true });
    const loaded = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    expect(loaded.metadata.delivered).toBe(true);
    await expect(Reservation.repairAcceptedBillingEmailReservations([loaded], mockDatabase))
      .resolves.toEqual(new Set());

    const reopened = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    expect(reopened.metadata).toMatchObject({ amount: 100, send_failed: true });
    expect(reopened.metadata.delivered).toBeUndefined();
    expect(loaded.metadata).toMatchObject({ amount: 100, send_failed: true });
    expect(loaded.metadata.delivered).toBeUndefined();
    await expect(mockDatabase('scheduled_services').where({ id: appointmentId }).first())
      .resolves.toMatchObject({ balance_reminder_sent_at: null });

    const [progress] = await require('../services/billing-reminder-delivery')
      .reminderProgress(customerId, 'previsit_balance_reminder', ['email']);
    expect(progress.complete).toBe(false);
    const ContactLedger = require('../services/collections/contact-ledger');
    await expect(ContactLedger.claimAttempt({ ...progress.entries[0], reused: true }, {
      invoiceIds: [invoiceIds[1]], metadata: { amount: 60 },
    })).resolves.toEqual({ allowed: true });
    const refreshed = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    expect(refreshed.invoice_ids).toEqual([invoiceIds[1]]);
    expect(refreshed.metadata).toMatchObject({ amount: 60, send_failed: false });
    expect(refreshed.metadata.delivered).toBeUndefined();
  });

  test('a stale accepted repair cannot restore delivery after a requote wins the Email-row lock', async () => {
    const { appointmentId, email, stopped } = await requoteFixture({ delivered: true });
    await mockDatabase('email_messages').where({ id: stopped.id }).update({
      status: 'sent', sent_at: new Date(), provider_retry_exhausted_at: null,
      provider_handoff_phase: 'started', error_message: null,
    });
    const loaded = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();

    const paused = pauseAcceptedSnapshot();
    const repairing = Reservation.repairAcceptedBillingEmailReservations([loaded], paused.database);
    await paused.snapshotReady;
    try {
      await mockDatabase('email_messages').where({ id: stopped.id }).update({
        status: stopped.status,
        sent_at: null,
        provider_retry_exhausted_at: stopped.provider_retry_exhausted_at,
        provider_retry_next_at: stopped.provider_retry_next_at,
        provider_handoff_phase: stopped.provider_handoff_phase,
        error_message: stopped.error_message,
      });
      const currentRequote = await mockDatabase('email_messages').where({ id: stopped.id }).first();
      await expect(Reservation.releaseBillingEmailReservationForRequote(currentRequote, mockDatabase)).resolves.toBe(true);
    } finally { paused.releaseSnapshot(); }

    await expect(repairing).resolves.toEqual(new Set());
    const finalLedger = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    expect(finalLedger.metadata).toMatchObject({ send_failed: true });
    expect(finalLedger.metadata.delivered).toBeUndefined();
    expect(loaded.metadata.delivered).toBeUndefined();
    await expect(mockDatabase('scheduled_services').where({ id: appointmentId }).first())
      .resolves.toMatchObject({ balance_reminder_sent_at: null });
  });

  test('changed-quote repair permits one fresh smaller quote without reopening its reclaimed attempt', async () => {
    const { customerId, invoiceIds, email, stopped } = await requoteFixture();
    const { reminderProgress } = require('../services/billing-reminder-delivery');
    const [progress] = await reminderProgress(customerId, 'previsit_balance_reminder', ['email']);
    expect(progress.complete).toBe(false);
    expect(progress.resolved.size).toBe(0);
    expect(progress.delivered.size).toBe(0);
    expect(progress.entries[0].metadata.send_failed).toBe(true);
    const ContactLedger = require('../services/collections/contact-ledger');
    const claims = await Promise.all([1, 2].map(() => ContactLedger.claimAttempt({
      ...progress.entries[0], reused: true,
    }, { invoiceIds: [invoiceIds[1]], metadata: { amount: 60 } })));
    expect(claims.filter((claim) => claim.allowed)).toHaveLength(1);
    await expect(Reservation.releaseBillingEmailReservationForRequote(stopped, mockDatabase)).resolves.toBe(false);
    const current = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    expect(current.metadata).toMatchObject({ send_failed: false, amount: 60 });
    expect(current.metadata.resolved).not.toBe(true);
    expect(current.invoice_ids).toEqual([invoiceIds[1]]);
    const retired = await mockDatabase('email_messages').where({ id: stopped.id }).first();
    expect(retired.error_message).toBe('Billing email old quote retired: previsit-quote-changed');
    expect(require('../services/email-template-library').shouldRetryExistingMessage(retired)).toBe(true);
    expect(retired.provider_handoff_phase).toBe('pending');
    expect(retired.provider_handoff_attempt_token).toBe(retired.send_attempt_token);
  });

  test('a failed repair acknowledgement rolls back the reservation and visit release', async () => {
    const { appointmentId, email, stopped } = await requoteFixture({ delivered: true });
    await mockDatabase.schema.alterTable('email_messages', (table) => table.renameColumn('updated_at', 'hidden_updated_at'));
    try {
      await expect(Reservation.releaseBillingEmailReservationForRequote(stopped, mockDatabase)).resolves.toBe(false);
      const held = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
      expect(held.metadata.send_failed).not.toBe(true);
      expect(held.metadata.delivered).toBe(true);
      await expect(mockDatabase('scheduled_services').where({ id: appointmentId }).first())
        .resolves.toMatchObject({ balance_reminder_sent_at: expect.any(Date) });
      const unrepaired = await mockDatabase('email_messages').where({ id: stopped.id }).first();
      expect(unrepaired.error_message).toBe(stopped.error_message);
    } finally {
      await mockDatabase.schema.alterTable('email_messages', (table) => table.renameColumn('hidden_updated_at', 'updated_at'));
    }
    // The visit is still claimed and therefore absent from the reminder
    // sweep. Only the existing retry worker can reach this durable refusal.
    const retry = require('../services/transactional-email-provider-retry');
    await expect(retry.recoverStaleClaims(new Date(), mockDatabase)).resolves.toBe(1);
    await expect(mockDatabase('scheduled_services').where({ id: appointmentId }).first())
      .resolves.toMatchObject({ balance_reminder_sent_at: null });
    const freshClaim = new Date();
    await mockDatabase('scheduled_services').where({ id: appointmentId }).update({ balance_reminder_sent_at: freshClaim });
    await expect(retry.recoverStaleClaims(new Date(), mockDatabase)).resolves.toBe(0);
    await expect(mockDatabase('scheduled_services').where({ id: appointmentId }).first())
      .resolves.toMatchObject({ balance_reminder_sent_at: freshClaim });
  });

  test('a missing pinned visit rolls back reopening the delivered reservation', async () => {
    const { appointmentId, email, stopped } = await requoteFixture({ delivered: true });
    await mockDatabase('scheduled_services').where({ id: appointmentId }).del();

    await expect(Reservation.releaseBillingEmailReservationForRequote(stopped, mockDatabase)).resolves.toBe(false);
    const held = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    expect(held.metadata).toMatchObject({ delivered: true, amount: 100 });
    expect(held.metadata.send_failed).toBeUndefined();
    await expect(mockDatabase('email_messages').where({ id: stopped.id }).first())
      .resolves.toMatchObject({ error_message: stopped.error_message });
  });

  test('an old quote marker cannot release a newer Email claim', async () => {
    const { email, stopped } = await requoteFixture();
    await mockDatabase('email_messages').where({ id: stopped.id }).update({ status: 'queued', send_attempt_token: 'new-attempt' });
    await expect(Reservation.releaseBillingEmailReservationForRequote(stopped, mockDatabase)).resolves.toBe(false);
    const held = await mockDatabase('collections_contact_ledger').where({ id: email.id }).first();
    expect(held.metadata.send_failed).not.toBe(true);
  });

  test('progress repairs accepted and terminal evidence while unknown attempts stay held', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const acceptedEvent = `late-payment:${invoiceId}:accepted`;
    const unknownEvent = `late-payment:${invoiceId}:unknown`;
    const terminalEvent = `late-payment:${invoiceId}:terminal`;
    const accepted = ledger({ customerId, invoiceId, eventKey: acceptedEvent });
    const unknown = ledger({ customerId, invoiceId, eventKey: unknownEvent });
    const terminal = ledger({ customerId, invoiceId, eventKey: terminalEvent });
    const sibling = ledger({ customerId, invoiceId, eventKey: terminalEvent, channel: 'sms' });
    await mockDatabase('collections_contact_ledger').insert([accepted, unknown, terminal, sibling]);
    await mockDatabase('email_messages').insert([
      message(context({ customerId, invoiceId, eventKey: acceptedEvent, ledgerId: accepted.id }), {
        sent_at: new Date(), status: 'blocked', provider_retry_exhausted_at: new Date(),
        error_message: `${Reservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}stale`,
      }),
      message(context({ customerId, invoiceId, eventKey: unknownEvent, ledgerId: unknown.id }), {
        status: 'blocked', error_message: `${Reservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}temporary`,
      }),
      message(context({ customerId, invoiceId, eventKey: terminalEvent, ledgerId: terminal.id }), {
        status: 'blocked', provider_retry_exhausted_at: new Date(),
        error_message: `${Reservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}ineligible`,
      }),
    ]);

    const first = await require('../services/billing-reminder-delivery')
      .reminderProgress(customerId, 'late_payment_checker', ['email']);
    expect(first.find((event) => event.metadata.notificationEventKey === acceptedEvent).complete).toBe(true);
    const terminalProgress = first.find((event) => event.metadata.notificationEventKey === terminalEvent);
    expect(terminalProgress.complete).toBe(true);
    expect(terminalProgress.resolved).toEqual(new Set(['email']));
    expect(terminalProgress.delivered.size).toBe(0);
    const ContactLedger = require('../services/collections/contact-ledger');
    // Even a caller holding the pre-repair failure snapshot cannot reclaim
    // the terminally resolved reservation after the repair commits.
    await expect(ContactLedger.claimAttempt({ id: terminal.id, reused: true,
      metadata: { send_failed: true } })).resolves.toMatchObject({ allowed: false });
    const second = await require('../services/billing-reminder-delivery')
      .reminderProgress(customerId, 'late_payment_checker', ['email']);
    expect(second.find((event) => event.metadata.notificationEventKey === terminalEvent).complete).toBe(true);
    const rows = await mockDatabase('collections_contact_ledger')
      .whereIn('id', [accepted.id, unknown.id, terminal.id, sibling.id]);
    expect(rows.find((row) => row.id === accepted.id).metadata.delivered).toBe(true);
    expect(rows.find((row) => row.id === unknown.id).metadata.delivered).toBeUndefined();
    expect(rows.find((row) => row.id === terminal.id).metadata).toMatchObject({ resolved: true });
    expect(rows.find((row) => row.id === terminal.id).metadata.delivered).toBeUndefined();
    expect(rows.find((row) => row.id === sibling.id).metadata.delivered).toBeUndefined();
    expect(rows.find((row) => row.id === sibling.id).metadata.resolved).toBeUndefined();
  });
});
