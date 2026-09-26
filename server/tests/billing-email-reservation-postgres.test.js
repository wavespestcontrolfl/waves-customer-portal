const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const database = (...args) => mockDatabase(...args);
  database.transaction = (...args) => mockDatabase.transaction(...args);
  database.raw = (...args) => mockDatabase.raw(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Reservation = require('../services/billing-email-reservation');
const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');

const postgres = SKIP ? describe.skip : describe;
const schema = `billing_email_reservation_${randomUUID().replaceAll('-', '')}`;
let admin;

function context({ customerId, invoiceId, eventKey, ledgerId }) {
  return {
    schema_version: 1,
    customer_id: customerId,
    invoice_id: invoiceId,
    category: 'billing',
    source_entry_point: 'late_payment_checker',
    notificationEventKey: eventKey,
    collections_ledger_id: ledgerId,
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
      table.string('provider_handoff_phase');
      table.string('status');
      table.text('error_message');
      table.timestamp('provider_retry_exhausted_at', { useTz: true });
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
  }, 30000);

  afterEach(async () => {
    await mockDatabase('email_message_events').del();
    await mockDatabase('email_messages').del();
    await mockDatabase('collections_contact_ledger').del();
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

    await expect(Reservation.markBillingEmailReservationDelivered(
      message(context({ customerId, invoiceId, eventKey, ledgerId: email.id }), { sent_at: new Date() }), mockDatabase,
    )).resolves.toBe(true);
    await expect(Reservation.markBillingEmailReservationDelivered(
      message(context({ customerId, invoiceId, eventKey, ledgerId: sibling.id }), { sent_at: new Date() }), mockDatabase,
    )).resolves.toBe(false);
    await expect(Reservation.markBillingEmailReservationDelivered(
      message(context({ customerId, invoiceId, eventKey, ledgerId: wrongSource.id }), { sent_at: new Date() }), mockDatabase,
    )).resolves.toBe(false);

    const rows = await mockDatabase('collections_contact_ledger').orderBy('channel');
    expect(rows.find((row) => row.id === email.id).metadata.delivered).toBe(true);
    expect(rows.find((row) => row.id === sibling.id).metadata.delivered).toBeUndefined();
    expect(rows.find((row) => row.id === wrongSource.id).metadata.delivered).toBeUndefined();
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
    expect(first.find((event) => event.metadata.notificationEventKey === terminalEvent).complete).toBe(false);
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
