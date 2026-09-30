// Reproduce scheduler + bell transactions occupying a two-connection pool.
// The quote guard must use the bell transaction instead of waiting for a third.
let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.raw = (...args) => mockPg.raw(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;

});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({
  sendToCustomer: jest.fn(async () => ({ subscriptions: 1, sent: 1, failed: 0, expired: 0, skipped: 0 })),
}));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const NotificationService = require('../services/notification-service');
const PushService = require('../services/push-notifications');
const { windowGuardFrom } = require('../services/messaging/push-channel-routing')._test;
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_app_connection_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const invoiceId = randomUUID();
let admin;

postgres('billing App quote guard under the scheduler connection limit', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema],
      pool: { min: 0, max: 2 }, acquireConnectionTimeout: 1500 });
    await mockPg.schema.createTable('invoices', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.integer('due_cents');
      table.text('status'); table.timestamp('sms_sent_at'); table.timestamp('email_sent_at'); table.timestamp('updated_at');
    });
    await mockPg.schema.createTable('notifications', (table) => {
      table.increments('id'); table.uuid('recipient_id'); table.jsonb('metadata');
      table.timestamp('created_at').defaultTo(mockPg.fn.now());
      for (const key of ['recipient_type', 'category', 'title', 'body', 'icon', 'link']) table.text(key);
    });
    await mockPg.schema.createTable('collections_contact_ledger', (table) => {
      table.uuid('id').primary().defaultTo(mockPg.raw('gen_random_uuid()')); table.jsonb('metadata'); table.timestamp('occurred_at');
      table.text('idempotency_key').unique(); table.uuid('customer_id'); table.jsonb('invoice_ids');
      for (const key of ['channel', 'purpose', 'source']) table.text(key);
    });
    await mockPg.schema.createTable('autopay_log', (table) => {
      table.increments('id'); table.uuid('customer_id'); table.text('event_type');
      table.integer('amount_cents'); table.uuid('payment_method_id'); table.uuid('payment_id');
      table.jsonb('details'); table.timestamp('created_at').defaultTo(mockPg.fn.now());
    });
    await mockPg.schema.createTable('email_messages', table => { table.text('idempotency_key'); table.text('status'); });
    await mockPg.schema.createTable('sms_log', table => {
      for (const key of ['id', 'direction', 'status', 'twilio_sid', 'from_phone']) table.text(key);
      table.jsonb('metadata');
    });
    await mockPg('invoices').insert({ id: invoiceId, customer_id: customerId, due_cents: 4900, status: 'sent' });
  }, 30000);
  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    await mockPg('notifications').del();
    await mockPg('autopay_log').del();
  });

  test('expired recurrence selects the latest matching durable progress with normalized card expiry', async () => {
    const methodId = randomUUID();
    const base = { customer_id: customerId, event_type: 'card_expired', payment_method_id: methodId };
    const insert = (createdAt, details) => mockPg('autopay_log').insert({
      ...base, created_at: createdAt, details: JSON.stringify(details),
    }).returning('id');
    await insert('2026-07-01T12:00:00Z', { reminder_stage: 'expired', exp_month: '7', exp_year: '26' });
    const [wanted] = await insert('2026-08-01T12:00:00Z', { reminder_stage: 'expired', exp_month: 7, exp_year: 2026 });
    await insert('2026-09-01T12:00:00Z', { reminder_stage: '7_day', exp_month: 7, exp_year: 2026 });
    await insert('2026-10-01T12:00:00Z', { reminder_stage: 'expired', exp_month: 8, exp_year: 2026 });
    await insert('2026-11-01T12:00:00Z', { reminder_stage: 'expired', exp_month: 7, exp_year: 2027 });
    const latest = await require('../services/autopay-log').latestExpiredCardProgress(customerId, methodId, '07', 2026);
    expect(latest).toMatchObject({ id: wanted.id, created_at: new Date('2026-08-01T12:00:00Z') });
    const [undated] = await mockPg('autopay_log').insert({ ...base, created_at: null,
      details: JSON.stringify({ reminder_stage: 'expired', exp_month: 7, exp_year: 2026 }),
    }).returning('id');
    expect(await require('../services/autopay-log').latestExpiredCardProgress(customerId, methodId, 7, 2026))
      .toMatchObject({ id: undated.id, created_at: null });
  });

  test.each([4900, 0])('reads the live %i-cent balance through the bell transaction', async (liveCents) => {
    await mockPg('invoices').where({ id: invoiceId }).update({ due_cents: liveCents });
    const scheduler = await mockPg.transaction();
    const quoteCheck = jest.fn(async ({ database = mockPg } = {}) => {
      const invoice = await database('invoices').where({ id: invoiceId, customer_id: customerId }).first();
      return { ok: invoice.due_cents === 4900 };
    });
    try {
      const result = await NotificationService.notifyCustomer(customerId, 'billing', 'Balance due', 'Balance: $49.00', {
        dedupeKey: `billing-quote:${invoiceId}`, awaitPush: true,
        pushOptions: { shouldContinue: windowGuardFrom(quoteCheck) },
      });
      expect(quoteCheck).toHaveBeenCalledTimes(1);
      expect(quoteCheck.mock.calls[0][0].database.isTransaction).toBe(true);
      if (liveCents === 4900) {
        expect(result).toMatchObject({ push: { accepted: 1 } });
        expect(await mockPg('notifications')).toHaveLength(1);
        expect(PushService.sendToCustomer).toHaveBeenCalledTimes(1);
      } else {
        expect(result).toMatchObject({ suppressed: true, reason: 'pre_send_check_blocked' });
        expect(await mockPg('notifications')).toHaveLength(0);
        expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      }
    } finally { await scheduler.rollback(); }
  }, 15000);

  test('a committed bell with a lost acknowledgement cannot authorize a changed native quote', async () => {
    await mockPg('invoices').where({ id: invoiceId }).update({ due_cents: 4900 });
    const database = require('../models/db');
    const transaction = database.transaction;
    const transactionSpy = jest.spyOn(database, 'transaction').mockImplementationOnce(async (...args) => {
      await transaction(...args);
      throw new Error('commit acknowledgement lost');
    });
    const options = { dedupeKey: `billing-quote:${invoiceId}`, awaitPush: true };
    try {
      const first = await NotificationService.notifyCustomer(customerId, 'billing', 'Balance due', 'Balance: $49.00', {
        ...options, pushOptions: { shouldContinue: windowGuardFrom(async ({ database }) => {
          const row = await database('invoices').where({ id: invoiceId }).forUpdate().first();
          return { ok: row.due_cents === 4900 };
        }) },
      });
      expect(first).toBeNull();
      expect(await mockPg('notifications')).toHaveLength(1);
      const visibleAt = new Date(Date.now() - 86400000);
      await mockPg('notifications').update({ created_at: visibleAt });
      // Payment after the bell commit is after that copy's delivery.
      await mockPg('invoices').where({ id: invoiceId }).update({ due_cents: 2500 });
      const retried = await NotificationService.notifyCustomer(customerId, 'billing', 'Balance due', 'Balance: $25.00', options);
      expect(retried.created_at).toEqual((await mockPg('notifications').first()).created_at);
      expect(retried).toMatchObject({ body: 'Balance: $49.00', deduped: true,
        push: { queued: false, accepted: 0, reason: 'dedupe_payload_changed' } });
      expect(await mockPg('notifications')).toHaveLength(1);
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
      // Progress repair must retain the original visible-event time, even
      // when the retry happens later with a different quote.
      await require('../services/autopay-log').logAutopay(customerId, 'pre_charge_reminder_sent', {
        createdAt: retried.created_at, details: { channel: 'push', delivery_repaired: true },
      });
      const progress = await mockPg('autopay_log').first();
      expect(progress.created_at).toEqual(visibleAt);
      expect(progress.amount_cents).toBeNull();
      const ledgerId = randomUUID();
      await mockPg('collections_contact_ledger').insert({ id: ledgerId, metadata: { send_failed: true },
        idempotency_key: `billing-app:${invoiceId}`, occurred_at: new Date() });
      expect(await require('../services/collections/contact-ledger').markDelivered({ id: ledgerId }, {
        occurredAt: retried.created_at,
      })).toBe(true);
      const ledger = await mockPg('collections_contact_ledger').where({ id: ledgerId }).first();
      expect(ledger.metadata.delivered).toBe(true);
      expect(ledger.occurred_at).toEqual(visibleAt);
      const contact = await require('../services/collections/contact-ledger').recordContact({
        customerId, channel: 'push', purpose: 'balance_reminder', source: 'app-qa', idempotencyKey: `billing-app:${invoiceId}`,
      });
      expect(contact.occurred_at).toEqual(visibleAt);
      expect((await mockPg('collections_contact_ledger').where({ id: ledgerId }).first()).occurred_at).toEqual(visibleAt);
      expect(await require('../services/collections/contact-ledger').claimAttempt(contact)).toMatchObject({ delivered: true, allowed: false });
    } finally { transactionSpy.mockRestore(); }
  }, 15000);
  test('an interrupted deferred contact refreshes its window before later delivery', async () => {
    const ContactLedger = require('../services/collections/contact-ledger');
    const originalAt = new Date(Date.now() - 2 * 86400000);
    const deliveredAt = new Date();
    const args = { customerId, channel: 'sms', purpose: 'late_payment', source: 'invoice_followup_replay',
      idempotencyKey: `followup-replay:${invoiceId}` };
    await ContactLedger.recordContact({ ...args, occurredAt: originalAt });
    const resumed = await ContactLedger.recordContact({ ...args, occurredAt: deliveredAt });
    expect(resumed.occurred_at).toEqual(deliveredAt);
    expect(await ContactLedger.markDelivered(resumed)).toBe(true);
    const settled = await ContactLedger.recordContact({ ...args, occurredAt: new Date(deliveredAt.getTime() + 86400000) });
    expect(settled.occurred_at).toEqual(deliveredAt);
    expect((await mockPg('collections_contact_ledger').where({ id: resumed.id }).first()).occurred_at).toEqual(deliveredAt);
  });
  test('a committed current bell settles invoice replay even without native proof', async () => {
    const key = `invoice:${invoiceId}:sent`;
    PushService.sendToCustomer.mockRejectedValueOnce(new Error('native delivery failed'));
    const bell = await NotificationService.notifyCustomer(customerId, 'invoice', 'Invoice ready', 'Open invoice', { dedupeKey: key, awaitPush: true });
    expect(bell.push.accepted).toBeUndefined();
    expect(await mockPg('sms_log')).toHaveLength(0);
    await require('../services/messaging/deferred-replay-registry').finalizeDeferredReplay('invoice_send_deferred', {
      invoice_id: invoiceId, partial_fanout_retry: true,
    });
    expect((await mockPg('invoices').where({ id: invoiceId }).first()).sms_sent_at).toEqual(bell.created_at);
  });

});
