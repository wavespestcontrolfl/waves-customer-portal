// Opt-in SQL regression against a verified dev/preview private QA database.
// No application DATABASE_URL is read. Objects in this private database
// roll back with the transaction; this checks the count query, not migrations.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));
const { randomUUID } = require('node:crypto');
const { createSmsResponseTables } = require('./fixtures/sms-response-postgres');
const { countUnreadInboundSms } = require('../services/inbound-sms-read');
const connection = process.env.UNREAD_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;

postgres('public SMS needs-response count (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use a private worktree QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    mockPg = await database.transaction();
    await createSmsResponseTables(mockPg);
  });
  afterAll(async () => { await mockPg?.rollback(); await database?.destroy(); });
  let tick;
  beforeEach(async () => {
    await mockPg.raw('TRUNCATE messages, conversations, customers, blocked_numbers');
    tick = Date.parse('2026-09-24T12:00:00Z');
  });

  async function seed({ phone = '+19415550100', customerPhone = null, ours = '+19415550190', read = false, channel = 'sms', direction = 'inbound' } = {}) {
    const customerId = customerPhone === null ? null : randomUUID();
    if (customerId) await mockPg('customers').insert({ id: customerId, phone: customerPhone });
    const conversationId = randomUUID();
    await mockPg('conversations').insert({ id: conversationId, customer_id: customerId, contact_phone: phone, our_endpoint_id: ours, channel: 'sms' });
    await mockPg('messages').insert({
      id: randomUUID(), conversation_id: conversationId, channel, direction, is_read: read,
      body: direction === 'inbound' ? 'Can you call me?' : 'Calling now.',
      message_type: direction === 'inbound' ? 'inbound' : 'manual',
      delivery_status: direction === 'inbound' ? 'received' : 'sent', created_at: new Date(tick += 1000),
    });
    return conversationId;
  }

  test('one contact using several business numbers counts as one inbox thread', async () => {
    await seed();
    await seed({ phone: '(941) 555-0100', ours: '+19415550191' });
    await seed({ phone: '9415550100', read: null });
    await seed({ phone: '+19415550101' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 2, messages: 3 });
  });

  test('uses contact/customer fallback and excludes peers without a reply number', async () => {
    await seed();
    await seed({ phone: '', customerPhone: '+19415550100' });
    await seed({ phone: null, customerPhone: '9415550100' });
    await seed({ phone: null });
    await seed({ phone: '' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });

  test('read questions remain pending while outbound, non-SMS and internal traffic are excluded', async () => {
    await seed();
    await seed({ phone: '+19415550101', read: true });
    await seed({ phone: '+19415550102', direction: 'outbound' });
    await seed({ phone: '+19415550103', channel: 'email' });
    const internal = '+19415550199';
    await seed({ phone: internal });
    await seed({ ours: internal });
    await seed({ phone: '+19415550104', customerPhone: internal });
    expect(await countUnreadInboundSms({ excludePhones: [internal] })).toEqual({ conversations: 2, messages: 2 });
  });

  test('a blocked sender stops counting; a NANP block matches the last-10 thread key, another country code only in full', async () => {
    await seed();
    await seed({ phone: '(941) 555-0100', ours: '+19415550191' });
    await seed({ phone: '+19415550101' });
    await seed({ phone: '+442079460958' });
    await seed({ phone: '+12079460958' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 4, messages: 5 });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: '+19415550100' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 3, messages: 3 });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: '+442079460958' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 2, messages: 2 });
  });

  test.each([
    ['+12079460958', '+442079460958'],
    ['+442079460958', '+12079460958'],
  ])('blocking %s preserves the unrelated %s sender', async (blocked, ordinary) => {
    await seed({ phone: blocked });
    await seed({ phone: ordinary });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 2, messages: 2 });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: blocked });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });

  test('a legacy digitless block does not hide contactless messages', async () => {
    await seed({ phone: null });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: 'anonymous' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('reading preserves pending questions, manual replies clear each line, and a new question reopens', async () => {
    const first = await seed();
    const second = await seed({ ours: '+19415550191' });
    await mockPg('messages').whereIn('conversation_id', [first, second]).update({ is_read: true });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 2 });
    await seed({ direction: 'outbound' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    await seed({ ours: '+19415550191', direction: 'outbound' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
    await seed();
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });
});
