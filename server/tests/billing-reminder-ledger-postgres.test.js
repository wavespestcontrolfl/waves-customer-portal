// The retry snapshot and policy waiver are real JSONB writes, not mock queries.
let mockPg;
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/billing-email-reservation', () => ({
  repairAcceptedBillingEmailReservations: jest.fn(async () => new Set()),
}));
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => ({ allowed: true })),
}));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const Ledger = require('../services/collections/contact-ledger');
const { sendReminderChannels, reminderProgress } = require('../services/billing-reminder-delivery');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `reminder_ledger_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const source = 'previsit_balance_reminder';
let admin;

postgres('billing reminder retry bookkeeping', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await mockPg.schema.createTable('collections_contact_ledger', (table) => {
      table.increments('id'); table.uuid('customer_id'); table.jsonb('invoice_ids'); table.jsonb('metadata');
      table.timestamp('occurred_at', { useTz: true }); table.text('idempotency_key').unique();
      for (const key of ['channel', 'purpose', 'source']) table.text(key);
    });
  }, 30000);
  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => { await mockPg('collections_contact_ledger').del(); });

  test('only the winning retry replaces debt, without caller-written outcome stamps', async () => {
    const entry = await Ledger.recordContact({ customerId, channel: 'sms', purpose: 'balance_reminder',
      source, invoiceIds: ['old'], idempotencyKey: 'retry', metadata: { send_failed: true, keep: 'audit' } });
    const snapshots = ['a', 'b'].map((id) => ({ invoiceIds: [id], metadata: {
      quote: id, delivered: true, resolved: true, resolution: 'forged', send_failed: true,
    } }));
    const claims = await Promise.all(snapshots.map((snapshot) => Ledger.claimAttempt({ ...entry, reused: true }, snapshot)));
    expect(claims.filter((claim) => claim.allowed)).toHaveLength(1);
    const winner = snapshots[claims.findIndex((claim) => claim.allowed)];
    const saved = await mockPg('collections_contact_ledger').where({ id: entry.id }).first();
    expect(saved.invoice_ids).toEqual(winner.invoiceIds);
    expect(saved.metadata).toEqual({ keep: 'audit', quote: winner.metadata.quote, send_failed: false });
  });

  test.each(['delivered', 'resolved'])('a stale failed snapshot cannot reopen a %s reservation', async (stamp) => {
    const entry = await Ledger.recordContact({ customerId, channel: 'sms', purpose: 'balance_reminder',
      source, invoiceIds: ['old'], idempotencyKey: 'settled', metadata: { send_failed: true } });
    await mockPg('collections_contact_ledger').where({ id: entry.id })
      .update({ metadata: { send_failed: true, [stamp]: true } });
    await expect(Ledger.claimAttempt({ ...entry, reused: true }, { invoiceIds: ['new'], metadata: { quote: 'new' } }))
      .resolves.toEqual({ allowed: false, held: true });
    expect((await mockPg('collections_contact_ledger').where({ id: entry.id }).first()).invoice_ids).toEqual(['old']);
  });

  test('a newly allowed leg revokes persisted waivers before its failed send is retried', async () => {
    await Ledger.recordContact({ customerId, channel: 'push', purpose: 'balance_reminder', source,
      invoiceIds: ['old'], idempotencyKey: 'bell', metadata: {
        notificationEventKey: 'episode', delivered: true, policy_waived_channels: ['sms'],
      } });
    const send = jest.fn(async () => ({ sent: false, deliveryOutcome: 'not_sent' }));
    const result = await sendReminderChannels({ customerId, source, purpose: 'balance_reminder',
      eventKey: 'episode', channels: ['push', 'sms'], invoiceIds: ['new'], send });
    expect(result.complete).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const progress = await reminderProgress(customerId, source, ['push', 'sms']);
    expect(progress[0].waived.size).toBe(0);
    expect(progress[0].complete).toBe(false);
    const rows = await mockPg('collections_contact_ledger');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.channel === 'push').metadata.policy_waived_channels).toEqual([]);
    expect(rows.find((row) => row.channel === 'sms').invoice_ids).toEqual(['new']);
  });
});
