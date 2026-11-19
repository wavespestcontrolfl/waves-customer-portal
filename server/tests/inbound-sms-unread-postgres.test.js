// Opt-in SQL regression against a verified dev/preview private QA database.
// No application DATABASE_URL is read. Objects in this private database
// roll back with the transaction; this checks the count query, not migrations.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  // A nested transaction is a savepoint on the suite transaction.
  db.transaction = (work) => mockPg.transaction(work);
  return db;
});
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
const mockBellClear = jest.fn(async () => 0);
jest.mock('../services/notification-service', () => ({
  markInboundSmsReadAdmin: (...args) => mockBellClear(...args), markApplicantRepliesReadAdmin: async () => 0, scopeAdminFeedToRole: (query) => query,
}));
const { randomUUID } = require('node:crypto');
const { createSmsResponseTables } = require('./fixtures/sms-response-postgres');
const { countUnreadInboundSms, markAllInboundSmsRead } = require('../services/inbound-sms-read');
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

  // Owner 2026-11-19 ("Mark Texts Read" A): the Messages badge passes unreadOnly.
  test('the unread-only count drops a read text; a thread with one unread text still counts; the full list keeps both', async () => {
    const first = await seed();
    const second = await seed({ phone: '+19415550101' });
    await seed({ phone: '+19415550101', ours: '+19415550191', read: null });
    expect(await countUnreadInboundSms({ unreadOnly: true })).toEqual({ conversations: 2, messages: 3 });
    await mockPg('messages').where({ conversation_id: first }).update({ is_read: true });
    await mockPg('messages').where({ conversation_id: second }).update({ is_read: true });
    expect(await countUnreadInboundSms({ unreadOnly: true })).toEqual({ conversations: 1, messages: 1 });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 2, messages: 3 });
  });

  // Owner 2026-11-19 ("Mark Texts Read" A): Mark all read on real SQL.
  const logger = require('../services/logger');
  async function readColumns() {
    await mockPg.raw(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at timestamptz,
      ADD COLUMN IF NOT EXISTS read_by_admin_user_id uuid, ADD COLUMN IF NOT EXISTS updated_at timestamptz;
      ALTER TABLE sms_log ADD COLUMN IF NOT EXISTS is_read boolean;
      CREATE TABLE IF NOT EXISTS notifications (id uuid PRIMARY KEY, recipient_type text, category text, link text,
        read_at timestamptz, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
      TRUNCATE sms_log, notifications`);
    logger.warn.mockClear();
  }
  async function text(key, {
    phone = '+19415550100', ours = '+19415550190', createdAt = '2026-11-19T11:00:00Z', type = 'inbound', sid = null,
    customerId = null, read = false, metadata = {},
  } = {}) {
    const conversationId = randomUUID();
    await mockPg('conversations').insert({ id: conversationId, customer_id: customerId, contact_phone: phone, our_endpoint_id: ours, channel: 'sms' });
    const id = randomUUID();
    await mockPg('messages').insert({
      id, conversation_id: conversationId, channel: 'sms', direction: 'inbound', is_read: read, body: key,
      message_type: type, delivery_status: 'received', twilio_sid: sid, created_at: createdAt, metadata,
    });
    return id;
  }
  const readIds = async () => new Set(await mockPg('messages').where({ is_read: true }).pluck('id'));

  test('Mark all read covers the shown time to the microsecond and an opt-out shown earlier, never later texts, internal phones, recruiting replies or blocked senders', async () => {
    await readColumns();
    const shown = await text('newest shown', { createdAt: '2026-11-19T12:00:00.123456Z' });
    const optOut = await text('opt-out shown earlier', { phone: '+19415550101', createdAt: '2026-11-19T12:05:00Z', sid: 'SM-optout' });
    await mockPg('inbound_sms_optout_receipts').insert({ message_sid: 'SM-optout', phone: '+19415550101', applied_at: '2026-11-19T11:59:00Z' });
    const later = await text('arrived after the list loaded', { phone: '+19415550102', createdAt: '2026-11-19T12:00:00.124001Z' });
    const internal = await text('internal phone', { phone: '+19415550199' });
    const recruiting = await text('applicant reply', { phone: '+19415550103', type: 'job_applicant_reply' });
    const blockedText = await text('blocked sender', { phone: '+19415550104' });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: '(941) 555-0104' });
    // A customer's second phone shares the thread; the inbox names it by the linked legacy row's sender.
    const customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, phone: '+19415550105' });
    const secondPhone = await text('from the blocked second phone', { phone: '+19415550105', customerId, sid: 'SM-second' });
    await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'inbound', from_phone: '+19415550106', to_phone: '+19415550190', twilio_sid: 'SM-second', created_at: '2026-11-19T11:00:00Z' });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: '+19415550106' });
    // A backlog reset read this one and tagged it for rollback.
    const resetTagged = await text('read by a backlog reset', { phone: '+19415550107', read: true, metadata: { backlog_reset: { at: '2026-11-01' } } });
    // The client shows the newest text at millisecond precision.
    const result = await markAllInboundSmsRead({ readBefore: new Date('2026-11-19T12:00:00.123Z'), role: 'admin', excludePhones: ['+19415550199'] });
    expect(result.updated).toBe(2);
    // Every statement in the writer ran, bell reconciliation included.
    expect(logger.warn).not.toHaveBeenCalled();
    const read = await readIds();
    expect([shown, optOut, later, internal, recruiting, blockedText, secondPhone].map((id) => read.has(id)))
      .toEqual([true, true, false, false, false, false, false]);
    const reset = await mockPg('messages').where({ id: resetTagged }).first('is_read', 'metadata');
    expect(reset).toEqual({ is_read: true, metadata: {} });
  });

  test("a row's Mark read reads that sender on every line, never a second phone sharing the thread; a digitless block hides no contactless text", async () => {
    await readColumns();
    const customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, phone: '+19415550120' });
    const fromPrimary = await text('from the primary phone', { phone: '+19415550120', customerId, sid: 'SM-primary', createdAt: '2026-11-19T11:30:00Z' });
    const fromSecond = await text('from the second phone', { phone: '+19415550120', customerId, sid: 'SM-second-phone', createdAt: '2026-11-19T11:20:00Z' });
    await mockPg('sms_log').insert({ id: randomUUID(), customer_id: customerId, direction: 'inbound', from_phone: '+19415550121', to_phone: '+19415550190', twilio_sid: 'SM-second-phone', created_at: '2026-11-19T11:20:00Z' });
    const otherLine = await text('older, on another business line', { phone: '+19415550120', ours: '+19415550191', createdAt: '2026-11-01T09:00:00Z' });
    const contactless = await text('no phone on the thread', { phone: null, createdAt: '2026-11-19T10:00:00Z' });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: 'anonymous' });

    expect((await markAllInboundSmsRead({ readBefore: new Date('2026-11-19T11:30:00Z'), role: 'admin', contactPhone: '+19415550120' })).updated).toBe(2);
    let read = await readIds();
    expect([fromPrimary, otherLine, fromSecond, contactless].map((id) => read.has(id))).toEqual([true, true, false, false]);

    expect((await markAllInboundSmsRead({ readBefore: new Date('2026-11-19T11:30:00Z'), role: 'admin' })).updated).toBe(2);
    read = await readIds();
    expect([fromSecond, contactless].map((id) => read.has(id))).toEqual([true, true]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a Mark all read retry finishes the bell of a text an earlier read left live', async () => {
    await readColumns();
    mockBellClear.mockClear();
    const customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, phone: '+19415550130' });
    const belled = await text('read, bell still live', { phone: '+19415550130', customerId, sid: 'SM-belled', read: true });
    await text('read, bell done', { phone: '+19415550131', customerId, sid: 'SM-done', read: true });
    await mockPg('notifications').insert({
      id: randomUUID(), recipient_type: 'admin', category: 'inbound_sms', link: `/admin/communications?thread=${customerId}`, read_at: null,
      metadata: { payload: { twilioSid: 'SM-belled' } },
    });
    const result = await markAllInboundSmsRead({ readBefore: new Date('2026-11-19T12:00:00Z'), role: 'admin' });
    expect(result.updated).toBe(0);
    const sids = mockBellClear.mock.calls.flatMap(([args]) => args.twilioSids || []);
    expect(sids).toContain('SM-belled');
    expect(sids).not.toContain('SM-done');
    expect((await readIds()).has(belled)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
