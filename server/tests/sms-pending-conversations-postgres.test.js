const mockRawCalls = [];
jest.mock('../models/db', () => {
  const db = (...args) => mockTrx(...args);
  db.raw = (...args) => { mockRawCalls.push(args); return mockTrx.raw(...args); };
  return db;
});

const { randomUUID } = require('node:crypto');
const { createSmsResponseTables } = require('./fixtures/sms-response-postgres');
const { loadPendingSmsConversations, countPendingSmsConversations } = require('../services/sms-pending-conversations');

const connection = process.env.UNREAD_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockTrx;
let tick;

postgres('pending SMS conversation query (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (url.hostname !== '127.0.0.1' || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Use a dedicated localhost waves_qa_<32hex> database');
    }
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    mockTrx = await database.transaction();
    await createSmsResponseTables(mockTrx);
    await mockTrx.raw('CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at DESC)');
  });

  afterAll(async () => { await mockTrx?.rollback(); await database?.destroy(); });

  beforeEach(async () => {
    await mockTrx.raw('TRUNCATE messages, conversations, customers, sms_log, blocked_numbers, message_drafts, messaging_audit_log, inbound_sms_optout_receipts');
    tick = new Date('2026-09-23T12:00:00.000Z');
    mockRawCalls.length = 0;
  });

  async function seed({
    phone = '+19415550100', ours = '+19415550190', customerId = null,
    direction = 'inbound', body = 'Can you call me?',
    messageType = direction === 'inbound' ? 'inbound' : 'manual',
    status = direction === 'inbound' ? 'received' : 'delivered',
    metadata = {}, media = [], legacy = true, read = false, auditMetadata = null,
  } = {}) {
    const createdAt = tick;
    tick = new Date(tick.getTime() + 1000);
    let ownerId = customerId;
    if (customerId === 'new') {
      ownerId = randomUUID();
      await mockTrx('customers').insert({ id: ownerId, phone });
    }
    let conversation = await mockTrx('conversations')
      .where({ customer_id: ownerId, contact_phone: phone, our_endpoint_id: ours }).first();
    if (!conversation) {
      conversation = { id: randomUUID(), customer_id: ownerId, channel: 'sms', contact_phone: phone, our_endpoint_id: ours };
      await mockTrx('conversations').insert(conversation);
    }
    const messageId = randomUUID();
    const sid = `SM${randomUUID().replaceAll('-', '')}`;
    await mockTrx('messages').insert({
      id: messageId, conversation_id: conversation.id, channel: 'sms', direction, body,
      media: JSON.stringify(media), metadata: JSON.stringify(metadata), message_type: messageType,
      delivery_status: status, twilio_sid: sid, is_read: read, created_at: createdAt,
    });
    let smsLogId = null;
    if (legacy) {
      smsLogId = randomUUID();
      await mockTrx('sms_log').insert({
        id: smsLogId, customer_id: ownerId, direction,
        from_phone: direction === 'inbound' ? phone : ours,
        to_phone: direction === 'inbound' ? ours : phone,
        message_body: body, metadata: JSON.stringify(metadata), message_type: messageType,
        status, twilio_sid: sid, created_at: createdAt,
      });
    }
    if (auditMetadata) await mockTrx('messaging_audit_log').insert({
      id: randomUUID(), provider_message_id: sid, channel: 'sms',
      metadata: JSON.stringify(auditMetadata), created_at: createdAt,
    });
    return { customerId: ownerId, conversationId: conversation.id, messageId, smsLogId, sid, createdAt };
  }

  test('ignores read state and dedupes endpoint candidates by canonical peer', async () => {
    await seed({ read: true });
    await seed({ ours: '+19415550191', body: 'The side gate is locked' });
    await seed({ phone: '+19415550101', body: 'There are ants again', read: true });
    await expect(countPendingSmsConversations({ includePending: true })).resolves.toMatchObject({
      conversations: 2, messages: 3, pendingMessageIds: expect.any(Array),
    });
  });

  test('a courtesy closer retires old state and a later question reopens it', async () => {
    await seed({ body: 'You missed the lanai' });
    await seed({ body: 'Thanks!', metadata: { courtesyOnly: true } });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
    await seed({ body: 'Can you come back tomorrow?' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
  });

  test('unstamped courtesy needs recent accepted non-question context on the same line', async () => {
    await seed({ direction: 'outbound', body: 'The work is complete. Reply STOP to opt out.' });
    await seed({ body: 'Thanks!' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
    await seed({ direction: 'outbound', body: 'Does 9am work?' });
    await seed({ body: 'Okay' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
    tick = new Date(tick.getTime() + 25 * 60 * 60 * 1000);
    await seed({ direction: 'outbound', ours: '+19415550191', body: 'Complete' });
    await seed({ direction: 'outbound', status: 'failed', body: 'Complete' });
    await seed({ direction: 'outbound', messageType: 'internal_alert', body: 'Complete' });
    await seed({ body: 'Thanks!' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
  });

  test('uses provider handoff time for reply ordering and courtesy context', async () => {
    await seed({ body: 'Can you confirm the window?' });
    const reply = await seed({ direction: 'outbound', body: 'We will arrive at noon.' });
    await seed({ body: 'Could you make it one instead?' });
    await mockTrx('messages').where({ twilio_sid: reply.sid }).update({ created_at: new Date(tick.getTime() + 60_000) });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });

    await mockTrx.raw('TRUNCATE messages, conversations, sms_log, message_drafts, messaging_audit_log');
    tick = new Date('2026-09-23T12:00:00.000Z');
    const update = await seed({ direction: 'outbound', body: 'Your service is complete.' });
    await seed({ body: 'Thanks!' });
    await mockTrx('messages').where({ twilio_sid: update.sid }).update({ created_at: new Date(tick.getTime() + 60_000) });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
  });

  test('only accepted manual reply types close a candidate; follow_up never does', async () => {
    await seed({ body: 'Please call me' });
    await seed({ direction: 'outbound', messageType: 'reminder', body: 'Reminder' });
    await seed({ direction: 'outbound', messageType: 'manual', status: 'failed', body: 'Failed' });
    await seed({ direction: 'outbound', messageType: 'follow_up', body: 'Proactive follow-up' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
    await seed({ direction: 'outbound', messageType: 'manual', status: 'sent', body: 'Calling now' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
  });

  test.each(['manual', 'ai_approved'])('a legacy-only %s reply closes canonical work for badge and digest', async (messageType) => {
    const candidate = await seed({ body: 'Please answer this question' });
    const metadata = {};
    if (messageType === 'ai_approved') {
      const draftId = randomUUID();
      await mockTrx('message_drafts').insert({
        id: draftId, sms_log_id: candidate.smsLogId, intent: 'customer_reply',
      });
      metadata.draft_id = draftId;
    }
    const reply = await seed({ direction: 'outbound', messageType, metadata });
    await mockTrx('messages').where({ twilio_sid: reply.sid }).del();

    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
    await expect(loadPendingSmsConversations({ includeLegacyOnly: true })).resolves.toEqual([]);
  });

  test('legacy-only inbound work remains watcher-only', async () => {
    const inbound = await seed({ body: 'Canonical persistence failed' });
    await mockTrx('messages').where({ twilio_sid: inbound.sid }).del();
    await expect(countPendingSmsConversations({ includePending: true })).resolves.toEqual({
      conversations: 0, messages: 0, pendingMessageIds: [],
    });
    await expect(loadPendingSmsConversations({ includeLegacyOnly: true })).resolves.toEqual([
      expect.objectContaining({ id: inbound.smsLogId, source: 'legacy' }),
    ]);
  });

  test.each([
    ['courtesy', 'Thanks!', { courtesyOnly: true }],
    ['spam', 'Synthetic pitch', { spam_verdict: { enforced: true } }],
  ])('a legacy-only %s closer retires canonical work and a newer canonical question reopens it', async (_kind, body, metadata) => {
    await seed({ body: 'Can you confirm the appointment?' });
    const closer = await seed({ body, metadata });
    await mockTrx('messages').where({ twilio_sid: closer.sid }).del();
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
    await expect(loadPendingSmsConversations({ includeLegacyOnly: true })).resolves.toEqual([]);

    const reopened = await seed({ body: 'Can you come tomorrow?' });
    await expect(countPendingSmsConversations({ includePending: true })).resolves.toEqual({
      conversations: 1, messages: 1, pendingMessageIds: [reopened.messageId],
    });
  });

  test('approval replies require an exact canonical anchor to the candidate', async () => {
    const oldInbound = await seed({ body: 'An older ask' });
    const candidate = await seed({ body: 'The current ask' });
    const wrongDraft = randomUUID();
    await mockTrx('message_drafts').insert({ id: wrongDraft, sms_log_id: oldInbound.smsLogId, intent: 'customer_reply' });
    await seed({ direction: 'outbound', messageType: 'ai_approved', auditMetadata: { draft_id: wrongDraft } });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });

    const exactDraft = randomUUID();
    await mockTrx('message_drafts').insert({ id: exactDraft, sms_log_id: candidate.smsLogId, intent: 'customer_reply' });
    await seed({ direction: 'outbound', messageType: 'ai_revised', auditMetadata: { draft_id: exactDraft } });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
  });

  test('null legacy draft evidence falls through to canonical while malformed evidence fails closed', async () => {
    const candidate = await seed({ body: 'Please answer this question' });
    const draftId = randomUUID();
    await mockTrx('message_drafts').insert({
      id: draftId, sms_log_id: candidate.smsLogId, intent: 'customer_reply',
    });
    const reply = await seed({
      direction: 'outbound', messageType: 'ai_approved', metadata: { draft_id: draftId },
    });
    await mockTrx('sms_log').where({ twilio_sid: reply.sid }).update({ metadata: { draft_id: null } });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });

    await mockTrx('sms_log').where({ twilio_sid: reply.sid }).update({ metadata: { draft_id: 'malformed' } });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
  });

  test('missing, proactive, and ambiguous draft provenance fail closed', async () => {
    const candidate = await seed({ body: 'Please help' });
    await seed({ direction: 'outbound', messageType: 'ai_approved' });
    const proactiveDraft = randomUUID();
    await mockTrx('message_drafts').insert({ id: proactiveDraft, sms_log_id: candidate.smsLogId, intent: 'click_followup' });
    await seed({ direction: 'outbound', messageType: 'ai_approved', auditMetadata: { draft_id: proactiveDraft } });
    const ambiguousDraft = randomUUID();
    await mockTrx('messages').insert({
      ...(await mockTrx('messages').where({ id: candidate.messageId }).first()), id: randomUUID(),
    });
    await mockTrx('message_drafts').insert({ id: ambiguousDraft, sms_log_id: candidate.smsLogId, intent: 'customer_reply' });
    await seed({ direction: 'outbound', messageType: 'ai_revised', auditMetadata: { draft_id: ambiguousDraft } });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
  });

  test('reaction preserves the ask; STOP closes every line and a later ask reopens', async () => {
    await seed({ body: 'Please call me' });
    await seed({ body: 'Liked “Please call me”', messageType: 'sms_reaction' });
    await seed({ ours: '+19415550191', body: 'Another line question?' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 2 });
    await seed({ body: 'STOP', messageType: 'opt_out' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
    await seed({ ours: '+19415550191', body: 'Actually, can you call?' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
  });

  test('legacy STOP and nullable legacy type preserve canonical STOP time', async () => {
    await seed({ body: 'Can you call me?' });
    const legacyOnly = await seed({ body: 'STOP', messageType: 'opt_out' });
    await mockTrx('messages').where({ twilio_sid: legacyOnly.sid }).del();
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });

    await seed({ body: 'A later question?' });
    const canonical = await seed({ body: 'STOP', messageType: 'opt_out' });
    await mockTrx('sms_log').where({ twilio_sid: canonical.sid }).update({ message_type: null, created_at: tick });
    await seed({ body: 'Question after STOP?' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
  });

  test('a durable STOP receipt covers a missing legacy log without shifting canonical chronology', async () => {
    await seed({ ours: '+19415550191', body: 'Can you call me?' });
    const stop = await seed({ body: 'Please stop texting me', messageType: null, legacy: false });
    await mockTrx('inbound_sms_optout_receipts').insert({
      message_sid: stop.sid, phone: '+19415550100', applied_at: stop.createdAt,
    });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });

    await seed({ ours: '+19415550191', body: 'Actually, can you call tomorrow?' });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
  });

  test('a late untyped STOP retry uses the earlier receipt boundary', async () => {
    await seed({ body: 'An older question?' });
    const appliedAt = tick;
    tick = new Date(tick.getTime() + 1000);
    const current = await seed({ ours: '+19415550191', body: 'A newer question?' });
    const retriedStop = await seed({ body: 'STOP', messageType: null, legacy: false });
    await mockTrx('inbound_sms_optout_receipts').insert({
      message_sid: retriedStop.sid, phone: '+19415550100', applied_at: appliedAt,
    });
    await expect(countPendingSmsConversations({ includePending: true })).resolves.toEqual({
      conversations: 1, messages: 1, pendingMessageIds: [current.messageId],
    });
  });

  test('media overrides courtesy and spam; enforced text-only spam retires', async () => {
    await seed({ body: 'Thanks!', metadata: { courtesyOnly: true, spam_verdict: { enforced: true } }, media: [{ url: 'synthetic.jpg' }] });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 1, messages: 1 });
    await seed({ body: 'Pitch', metadata: { spam_verdict: { enforced: true } } });
    await expect(countPendingSmsConversations()).resolves.toEqual({ conversations: 0, messages: 0 });
  });

  test('preserves customer, blocked, internal-phone, recruiting, and international scope', async () => {
    const owned = await seed({ customerId: 'new' });
    await seed({ phone: '+19415550101' });
    await seed({ phone: '+12079460958' });
    await seed({ phone: '+442079460958' });
    await seed({ phone: '+19415550102', messageType: 'job_applicant_reply' });
    await expect(countPendingSmsConversations({ customerId: owned.customerId })).resolves.toEqual({ conversations: 1, messages: 1 });
    await mockTrx('blocked_numbers').insert({ id: randomUUID(), number: '(941) 555-0100' });
    await expect(countPendingSmsConversations({ customerId: owned.customerId })).resolves.toEqual({ conversations: 0, messages: 0 });
    await mockTrx('blocked_numbers').insert({ id: randomUUID(), number: '+12079460958' });
    await expect(countPendingSmsConversations({ excludePhones: ['+19415550101'] })).resolves.toEqual({ conversations: 1, messages: 1 });
  });

  test.each(['receipt', 'legacy'])('a canonical STOP stays on its original phone after a customer phone change via %s', async (provenance) => {
    const oldQuestion = await seed({ customerId: 'new', body: 'Old phone question' });
    const newQuestion = await seed({ phone: '+19415550109', ours: '+19415550191', body: 'New phone question' });
    const stop = await seed({
      customerId: oldQuestion.customerId, ours: '+19415550192', body: 'STOP', messageType: 'opt_out',
    });
    await mockTrx('conversations').whereIn('id', [oldQuestion.conversationId, stop.conversationId])
      .update({ contact_phone: null });
    if (provenance === 'receipt') {
      await mockTrx('sms_log').where({ twilio_sid: stop.sid }).del();
      await mockTrx('inbound_sms_optout_receipts').insert({
        message_sid: stop.sid, phone: '+19415550100', applied_at: stop.createdAt,
      });
    }
    await mockTrx('customers').where({ id: oldQuestion.customerId }).update({ phone: '+19415550109' });

    await expect(countPendingSmsConversations({ includePending: true })).resolves.toEqual({
      conversations: 1, messages: 1, pendingMessageIds: [newQuestion.messageId],
    });
  });

  test('planner materializes outbound history once', async () => {
    const conversations = [];
    const messages = [];
    for (let i = 0; i < 100; i += 1) {
      const conversationId = randomUUID();
      const createdAt = new Date(2026, 8, 1, 12, 0, i);
      conversations.push({ id: conversationId, channel: 'sms', contact_phone: `+1941${String(5550000 + i).padStart(7, '0')}`, our_endpoint_id: '+19415550190' });
      messages.push({ id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound', body: 'Question?', media: '[]', metadata: '{}', message_type: 'inbound', delivery_status: 'received', created_at: createdAt });
      for (let h = 1; h <= 5; h += 1) messages.push({ ...messages.at(-1), id: randomUUID(), direction: 'outbound', body: 'Prior', message_type: 'reminder', delivery_status: 'delivered', created_at: new Date(createdAt - h * 60_000) });
    }
    await mockTrx.batchInsert('conversations', conversations, 100);
    await mockTrx.batchInsert('messages', messages, 100);
    await mockTrx.raw('ANALYZE messages; ANALYZE conversations');
    mockRawCalls.length = 0;
    await countPendingSmsConversations();
    const [sql, bindings] = mockRawCalls.find(([statement]) => statement.includes('WITH canonical_sms AS'));
    const explained = await mockTrx.raw(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, bindings);
    const nodes = [];
    const collect = node => { nodes.push(node); (node.Plans || []).forEach(collect); };
    collect(explained.rows[0]['QUERY PLAN'][0].Plan);
    const scans = nodes.filter(node => node['CTE Name'] === 'outbound_events' && node.Alias === 'prev');
    expect(scans).toHaveLength(1);
    expect(scans[0]['Actual Loops']).toBe(1);
  });
});
