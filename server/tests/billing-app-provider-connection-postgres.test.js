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
      table.increments('id'); table.uuid('recipient_id'); table.jsonb('metadata'); table.timestamp('created_at').defaultTo(mockPg.fn.now());
      for (const key of ['recipient_type', 'category', 'title', 'body', 'icon', 'link']) table.text(key);
    });
    await mockPg.schema.createTable('collections_contact_ledger', table => {
      table.uuid('id').primary().defaultTo(mockPg.raw('gen_random_uuid()')); table.jsonb('metadata'); table.timestamp('occurred_at');
      table.text('idempotency_key').unique(); table.uuid('customer_id'); table.jsonb('invoice_ids');
      for (const key of ['channel', 'purpose', 'source']) table.text(key);
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
