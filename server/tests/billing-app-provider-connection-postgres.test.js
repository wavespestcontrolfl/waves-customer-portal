// Reproduce scheduler + bell transactions occupying a two-connection pool.
// The quote guard must use the bell transaction instead of waiting for a third.
let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
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
    });
    await mockPg.schema.createTable('notifications', (table) => {
      table.increments('id'); table.uuid('recipient_id'); table.jsonb('metadata');
      for (const key of ['recipient_type', 'category', 'title', 'body', 'icon', 'link']) table.text(key);
    });
    await mockPg('invoices').insert({ id: invoiceId, customer_id: customerId, due_cents: 4900 });
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
      // Payment after the bell commit is after that copy's delivery.
      await mockPg('invoices').where({ id: invoiceId }).update({ due_cents: 2500 });
      const retried = await NotificationService.notifyCustomer(customerId, 'billing', 'Balance due', 'Balance: $25.00', options);
      expect(retried).toMatchObject({ body: 'Balance: $49.00', deduped: true,
        push: { queued: false, accepted: 0, reason: 'dedupe_payload_changed' } });
      expect(await mockPg('notifications')).toHaveLength(1);
      expect(PushService.sendToCustomer).not.toHaveBeenCalled();
    } finally { transactionSpy.mockRestore(); }
  }, 15000);
});
