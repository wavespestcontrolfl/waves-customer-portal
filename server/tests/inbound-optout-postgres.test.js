// Isolated synthetic schema only; no providers or application records.
jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { randomUUID } = require('node:crypto');
const { applyInboundOptout } = require('../services/messaging/inbound-optout');
const { lockSmsPhone } = require('../utils/customer-comms-lock');
const migration = require('../models/migrations/20260917000002_inbound_sms_optout_receipts');
const connection = process.env.DATABASE_URL;
const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

suite('inbound STOP application receipts (PostgreSQL)', () => {
  const schema = `optout_${randomUUID().replaceAll('-', '')}`;
  const phone = '+12025550101';
  const input = { messageSid: 'SM-synthetic-stop', phone, customerId: 'synthetic-customer',
    reason: 'opt_out_keyword', source: 'synthetic-test', capturedBody: 'STOP' };
  let admin;
  let database;
  beforeAll(async () => {
    const url = new URL(connection);
    const qa = process.env.WAVES_LOCAL_DEV === '1' && process.env.WAVES_WORKTREE_ID
      && url.pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!qa && !ci) throw new Error('Use only owned synthetic QA or isolated CI PostgreSQL.');
    admin = require('knex')({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    database = require('knex')({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    await migration.up(database);
    await database.schema.createTable('messaging_suppression', t => {
      t.text('phone').primary(); t.text('reason'); t.text('source'); t.text('captured_body');
      t.boolean('active'); t.timestamp('created_at'); t.timestamp('cleared_at');
    });
    await database.schema.createTable('recipient_optin', t => {
      t.text('phone_key').primary(); t.text('status'); t.timestamp('declined_at'); t.timestamp('updated_at');
    });
    await database.schema.createTable('notification_prefs', t => {
      t.text('customer_id').primary(); t.boolean('sms_enabled');
    });
  });
  beforeEach(async () => {
    for (const table of ['inbound_sms_optout_receipts', 'messaging_suppression', 'recipient_optin', 'notification_prefs']) {
      await database(table).del();
    }
    await database('recipient_optin').insert({ phone_key: '2025550101', status: 'confirmed' });
    await database('notification_prefs').insert({ customer_id: input.customerId, sms_enabled: true });
  });
  afterAll(async () => {
    await database?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  const consent = async () => ({
    suppression: await database('messaging_suppression').where({ phone }).first(),
    recipient: (await database('recipient_optin').first()).status,
    enabled: (await database('notification_prefs').first()).sms_enabled,
    receipts: (await database('inbound_sms_optout_receipts')).length,
  });

  test('two concurrent deliveries apply a STOP once', async () => {
    const results = await Promise.all([applyInboundOptout(input, database), applyInboundOptout(input, database)]);
    expect(results.map(result => result.applied).sort()).toEqual([false, true]);
    expect(await consent()).toMatchObject({ suppression: { active: true }, recipient: 'declined', enabled: false, receipts: 1 });
  });

  test('a retry waits for START, then leaves its consent unchanged', async () => {
    await applyInboundOptout(input, database);
    const start = await database.transaction();
    let retry;
    try {
      await lockSmsPhone(start, phone);
      await start('messaging_suppression').where({ phone }).update({ active: false });
      await start('recipient_optin').update({ status: 'confirmed' });
      await start('notification_prefs').update({ sms_enabled: true });
      retry = applyInboundOptout(input, database);
      await start.commit();
      expect(await retry).toEqual({ applied: false });
      expect(await consent()).toMatchObject({ suppression: { active: false }, recipient: 'confirmed', enabled: true, receipts: 1 });
    } finally { if (!start.isCompleted()) await start.rollback(); await retry; }
  });

  test.each([
    ['messaging_suppression', 'NOT active'],
    ['recipient_optin', "status <> 'declined'"],
    ['notification_prefs', 'sms_enabled'],
    ['inbound_sms_optout_receipts', "message_sid <> 'SM-synthetic-stop'"],
  ])('a %s failure rolls back every consent write and receipt', async (table, check) => {
    await database.raw(`ALTER TABLE ?? ADD CONSTRAINT synthetic_failure CHECK (${check})`, [table]);
    try {
      await expect(applyInboundOptout(input, database)).rejects.toThrow();
      expect(await consent()).toEqual({ suppression: undefined, recipient: 'confirmed', enabled: true, receipts: 0 });
    } finally { await database.raw('ALTER TABLE ?? DROP CONSTRAINT synthetic_failure', [table]); }
    expect(await applyInboundOptout(input, database)).toEqual({ applied: true });
  });
});
