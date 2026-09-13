// Real query regression using temporary synthetic tables in a private QA DB.
// The actual SMS/provider services are inert, and every write rolls back.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  return db;
});
jest.mock('../services/twilio', () => ({ isKnownOwnerPhone: (phone) => phone === '+19415550199' }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({}));
jest.mock('../services/conversations', () => ({}));
jest.mock('../services/sms-media', () => ({}));
jest.mock('../services/twilio-failure-alerts', () => ({}));
const { randomUUID } = require('node:crypto');
const { hasOutboundHistory } = require('../routes/twilio-webhook')._internals;
const connection = process.env.SMS_COMPLIANCE_QA_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
const sid = 'SM' + 'a'.repeat(32);

postgres('SMS compliance history identity and delivery evidence', () => {
  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    mockPg = await database.transaction();
    await mockPg.raw(`
      CREATE TEMP TABLE sms_log (id uuid, direction text, from_phone text, to_phone text, status text, message_type text, metadata jsonb);
      CREATE TEMP TABLE conversations (id uuid PRIMARY KEY, contact_phone text);
      CREATE TEMP TABLE messages (id uuid, conversation_id uuid, channel text, direction text, delivery_status text, message_type text, twilio_sid text, metadata jsonb);
      CREATE TEMP TABLE messaging_suppression (id uuid, phone text, active boolean);
    `);
  });
  afterAll(async () => { await mockPg?.rollback(); await database?.destroy(); });
  beforeEach(async () => { await mockPg.raw('TRUNCATE sms_log, messages, conversations, messaging_suppression'); });

  async function legacy(phone, overrides = {}) {
    await mockPg('sms_log').insert({ id: randomUUID(), direction: 'outbound', from_phone: '+19415550190',
      to_phone: phone, status: 'sent', message_type: 'manual', ...overrides });
  }
  async function unified(phone, overrides = {}) {
    const conversationId = randomUUID();
    await mockPg('conversations').insert({ id: conversationId, contact_phone: phone });
    await mockPg('messages').insert({ id: randomUUID(), conversation_id: conversationId,
      channel: 'sms', direction: 'outbound', delivery_status: 'sent', message_type: 'manual', twilio_sid: sid, ...overrides });
  }

  test.each([
    ['+12079460958', '+442079460958'],
    ['+442079460958', '+12079460958'],
  ])('history for %s never qualifies %s in either store or suppression', async (known, stranger) => {
    await legacy(known);
    expect(await hasOutboundHistory(known)).toBe(true);
    expect(await hasOutboundHistory(stranger)).toBe(false);
    await mockPg('sms_log').del();
    await unified(known);
    expect(await hasOutboundHistory(known)).toBe(true);
    expect(await hasOutboundHistory(stranger)).toBe(false);
    await mockPg('messages').del();
    await mockPg('messaging_suppression').insert({ id: randomUUID(), phone: known, active: true });
    expect(await hasOutboundHistory(known)).toBe(true);
    expect(await hasOutboundHistory(stranger)).toBe(false);
  });

  test('formatted domestic history remains eligible', async () => {
    await legacy('(941) 555-0100');
    expect(await hasOutboundHistory('+19415550100')).toBe(true);
  });

  test.each([
    { from_phone: 'push' },
    { metadata: JSON.stringify({ channel: 'push' }) },
  ])('a legacy push proof is not an SMS delivery: %j', async (overrides) => {
    await legacy('+19415550100', overrides);
    expect(await hasOutboundHistory('+19415550100')).toBe(false);
  });

  test('a unified push touchpoint is excluded; a real Twilio fallback remains eligible', async () => {
    await unified('+19415550100', { twilio_sid: null });
    expect(await hasOutboundHistory('+19415550100')).toBe(false);
    await mockPg('messages').update({ twilio_sid: sid });
    expect(await hasOutboundHistory('+19415550100')).toBe(true);
    await mockPg('messages').update({ delivery_status: 'failed' });
    expect(await hasOutboundHistory('+19415550100')).toBe(false);
  });

  test('operator manual alerts are excluded but existing suppression can be cleared', async () => {
    await legacy('+19415550199');
    await unified('+19415550199');
    expect(await hasOutboundHistory('+19415550199')).toBe(false);
    await mockPg('messaging_suppression').insert({ id: randomUUID(), phone: '+19415550199', active: true });
    expect(await hasOutboundHistory('+19415550199')).toBe(true);
  });

  // codex #4211 P2: the current-phone operator check above is a fast path
  // only — it re-derives from live env vars, so a number that WAS the
  // operator's before ADAM_PHONE changed and the number was reassigned no
  // longer trips it. TwilioService.sendSMS durably stamps
  // metadata.to_owner_phone_at_send at the moment of send instead, so the
  // exclusion survives a later env change regardless of the phone's CURRENT
  // status (isKnownOwnerPhone here only matches +19415550199 — this row's
  // phone is a different, never-owner number).
  test('a durable owner-phone-at-send stamp is excluded even for a number that is not currently the operator', async () => {
    await legacy('+19415550177', { message_type: 'manual', metadata: JSON.stringify({ to_owner_phone_at_send: true }) });
    expect(await hasOutboundHistory('+19415550177')).toBe(false);
    await mockPg('sms_log').del();
    await unified('+19415550177', { metadata: JSON.stringify({ to_owner_phone_at_send: true }) });
    expect(await hasOutboundHistory('+19415550177')).toBe(false);
  });

  // codex #4211 P1: the toll-free AI number answers first-contact strangers
  // by design, including a vendor robotext. Without this exclusion, that
  // reply becomes real outbound evidence that legitimizes the robotexter's
  // next footer-bearing text on every OTHER Waves line too.
  test.each(['ai_assistant', 'ai_assistant_reply'])(
    'an AI assistant auto-reply (%s) is not customer-facing evidence', async (messageType) => {
      await legacy('+19415550188', { message_type: messageType });
      expect(await hasOutboundHistory('+19415550188')).toBe(false);
      await mockPg('sms_log').del();
      await unified('+19415550188', { message_type: messageType });
      expect(await hasOutboundHistory('+19415550188')).toBe(false);
    },
  );
});
