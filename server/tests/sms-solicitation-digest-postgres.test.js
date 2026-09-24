// Opt-in query regression on a verified private QA PostgreSQL database.
// Only temporary synthetic tables are used, then the transaction rolls back.
jest.mock('../models/db', () => ({ raw: (...args) => mockPg.raw(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({}));
jest.mock('../services/ops-digest', () => ({
  deliverOpsDigest: () => { throw new Error('No delivery in SQL verification'); },
}));

const { _private: { loadUnansweredThreads } } = require('../services/unworked-comms-watcher');
const { findOpenCommsExceptions } = require('../services/completion-comms-guard');
const { randomUUID } = require('node:crypto');
const connection = process.env.SMS_SOLICITATION_QA_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
let now;

postgres('solicitation evidence in the unanswered digest (PostgreSQL)', () => {
  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) {
      throw new Error('Use a verified private worktree QA database');
    }
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    mockPg = await database.transaction();
    await mockPg.raw(`
      CREATE TEMP TABLE customers (id uuid PRIMARY KEY, phone text, first_name text, last_name text, deleted_at timestamptz);
      CREATE TEMP TABLE conversations (id uuid PRIMARY KEY, customer_id uuid, channel text,
        contact_phone text, our_endpoint_id text);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, conversation_id uuid, channel text, direction text,
        body text, media jsonb DEFAULT '[]', metadata jsonb DEFAULT '{}', message_type text,
        delivery_status text, twilio_sid text, is_read boolean, created_at timestamptz);
      CREATE TEMP TABLE sms_log (id uuid, customer_id uuid, direction text, from_phone text, to_phone text,
        message_body text, metadata jsonb, created_at timestamptz, message_type text, status text, twilio_sid text);
      CREATE TEMP TABLE message_drafts (id uuid PRIMARY KEY, sms_log_id uuid, customer_id uuid, flags jsonb,
        intent text, sent_at timestamptz);
      CREATE TEMP TABLE messaging_audit_log (id uuid DEFAULT gen_random_uuid(), provider_message_id text,
        channel text, metadata jsonb, created_at timestamptz DEFAULT now());
      CREATE TEMP TABLE agent_decisions (id uuid, workflow text, detected_intent text, status text,
        entity_id uuid, customer_id uuid, created_at timestamptz, input_snapshot jsonb);
      CREATE TEMP TABLE blocked_numbers (id uuid PRIMARY KEY, number varchar(32));
      CREATE TEMP TABLE inbound_sms_optout_receipts (
        message_sid text PRIMARY KEY, phone text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  });
  afterAll(async () => { await mockPg?.rollback(); await database?.destroy(); });
  beforeEach(async () => {
    await mockPg.raw(`TRUNCATE messages, conversations, customers, sms_log, message_drafts,
      messaging_audit_log, agent_decisions, blocked_numbers, inbound_sms_optout_receipts`);
    now = Date.now();
  });

  function seed(peer, metadata, age = 1000, endpoint = '+12025550199') {
    return mockPg('sms_log').insert({
      direction: 'inbound', from_phone: `+1${peer}`, to_phone: endpoint,
      message_body: 'Synthetic inbound requiring attention',
      metadata: metadata === null ? null : JSON.stringify(metadata),
      created_at: new Date(now - age), message_type: 'inbound', status: 'received',
    });
  }

  test('ordinary, shadow and low-confidence evidence remain actionable', async () => {
    await seed('2025550101', null);
    await seed('2025550102', { spam_verdict: { solicitation: true, mode: 'shadow' } });
    await seed('2025550103', { spam_verdict: { solicitation: true, confidence: 0.8, enforced: false } });
    await seed('2025550104', { spam_verdict: { enforced: true } });
    const rows = await loadUnansweredThreads(new Date(now));
    expect(rows.map((row) => row.peer).sort()).toEqual(['2025550101', '2025550102', '2025550103']);
  });

  test('the latest enforced pitch retires older inbound without hiding a later genuine reply', async () => {
    await seed('2025550101', null, 2000);
    await seed('2025550101', { spam_verdict: { enforced: true } });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
    await seed('2025550101', { spam_verdict: { solicitation: false, enforced: false } }, 100);
    expect((await loadUnansweredThreads(new Date(now))).map((row) => row.peer)).toEqual(['2025550101']);
  });

  test('enforcement on one business line leaves another conversation actionable', async () => {
    await seed('2025550101', null, 2000, '+12025550198');
    await seed('2025550101', { spam_verdict: { enforced: true } });
    expect(await loadUnansweredThreads(new Date(now))).toHaveLength(1);
  });

  test('approved replies clear only the exact latest inbound named by their draft', async () => {
    const peer = '+12025550120';
    const endpoint = '+12025550199';
    const olderId = randomUUID();
    const latestId = randomUUID();
    const draftId = randomUUID();
    await mockPg('sms_log').insert([
      { id: olderId, direction: 'inbound', from_phone: peer, to_phone: endpoint,
        message_body: 'Older question', created_at: new Date(now - 3000), message_type: 'inbound', status: 'received' },
      { id: latestId, direction: 'inbound', from_phone: peer, to_phone: endpoint,
        message_body: 'Latest question', created_at: new Date(now - 2000), message_type: 'inbound', status: 'received' },
      { id: randomUUID(), direction: 'outbound', from_phone: endpoint, to_phone: peer,
        message_body: 'Approved response', metadata: { draft_id: draftId },
        created_at: new Date(now - 1000), message_type: 'ai_approved', status: 'sent' },
    ]);
    await mockPg('message_drafts').insert({ id: draftId, sms_log_id: olderId, intent: 'reply' });

    expect((await loadUnansweredThreads(new Date(now))).map((row) => row.message_body))
      .toEqual(['Latest question']);
    await mockPg('message_drafts').where({ id: draftId }).update({ sms_log_id: latestId });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
  });

  test('a canonical approved reply can close a legacy-only inbound anchor', async () => {
    const peer = '+12025550124';
    const endpoint = '+12025550199';
    const inboundId = randomUUID();
    const draftId = randomUUID();
    const conversationId = randomUUID();
    const outboundSid = 'SM-canonical-reply-to-legacy-inbound';
    await mockPg('sms_log').insert([
      { id: inboundId, direction: 'inbound', from_phone: peer, to_phone: endpoint,
        message_body: 'Legacy-only question', created_at: new Date(now - 2000),
        message_type: 'inbound', status: 'received' },
      { id: randomUUID(), direction: 'outbound', from_phone: endpoint, to_phone: peer,
        message_body: 'Approved answer', twilio_sid: outboundSid, created_at: new Date(now - 1000),
        message_type: 'ai_approved', status: 'delivered' },
    ]);
    await mockPg('message_drafts').insert({ id: draftId, sms_log_id: inboundId, intent: 'reply' });
    await mockPg('messaging_audit_log').insert({
      provider_message_id: outboundSid, channel: 'sms', metadata: { draft_id: draftId },
      created_at: new Date(now),
    });
    await mockPg('conversations').insert({
      id: conversationId, channel: 'sms', contact_phone: peer, our_endpoint_id: endpoint,
    });
    await mockPg('messages').insert({
      id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'outbound',
      body: 'Approved answer', message_type: 'ai_approved', delivery_status: 'delivered',
      twilio_sid: outboundSid, created_at: new Date(now - 1000),
    });

    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
  });

  test('latest audit provenance precedes legacy metadata and malformed audit evidence fails closed', async () => {
    const peer = '+12025550121';
    const endpoint = '+12025550199';
    const inboundId = randomUUID();
    const draftId = randomUUID();
    const conflictingId = randomUUID();
    const sid = 'SM-audit-exact-anchor';
    await mockPg('sms_log').insert([
      { id: inboundId, direction: 'inbound', from_phone: peer, to_phone: endpoint,
        message_body: 'Question with audit reply', created_at: new Date(now - 2000), message_type: 'inbound', status: 'received' },
      { id: randomUUID(), direction: 'outbound', from_phone: endpoint, to_phone: peer,
        message_body: 'Approved response', twilio_sid: sid,
        created_at: new Date(now - 1000), message_type: 'ai_revised', status: 'delivered' },
    ]);
    await mockPg('message_drafts').insert([
      { id: draftId, sms_log_id: inboundId, intent: 'reply' },
      { id: conflictingId, sms_log_id: randomUUID(), intent: 'reply' },
    ]);

    expect(await loadUnansweredThreads(new Date(now))).toHaveLength(1);
    await mockPg('messaging_audit_log').insert({
      provider_message_id: sid, channel: 'sms', metadata: { draft_id: draftId },
      created_at: new Date(now),
    });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
    await mockPg('sms_log').where({ twilio_sid: sid }).update({ metadata: { draft_id: conflictingId } });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
    await mockPg('sms_log').where({ twilio_sid: sid }).update({ metadata: { draft_id: draftId } });
    await mockPg('messaging_audit_log').insert({
      provider_message_id: sid, channel: 'sms', metadata: { draft_id: 'malformed' },
      created_at: new Date(now + 1000),
    });
    expect(await loadUnansweredThreads(new Date(now))).toHaveLength(1);
  });

  test('manual replies retain thread behavior while proactive follow_up does not answer', async () => {
    const peer = '+12025550122';
    const endpoint = '+12025550199';
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'inbound', from_phone: peer, to_phone: endpoint,
      message_body: 'Please answer me', created_at: new Date(now - 3000), message_type: 'inbound', status: 'received',
    });
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: endpoint, to_phone: peer,
      message_body: 'Checking in proactively', created_at: new Date(now - 2000), message_type: 'follow_up', status: 'sent',
    });
    expect(await loadUnansweredThreads(new Date(now))).toHaveLength(1);
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: endpoint, to_phone: peer,
      message_body: 'Manual answer', created_at: new Date(now - 1000), message_type: 'manual', status: 'sent',
    });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
  });

  test('a durable receipt suppresses legacy work even when both STOP writes failed', async () => {
    await seed('2025550130', null, 3000);
    await mockPg('inbound_sms_optout_receipts').insert({
      message_sid: 'SM-receipt-only-stop', phone: '+12025550130',
      applied_at: new Date(now - 2000),
    });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);

    await seed('2025550130', null, 1000);
    expect((await loadUnansweredThreads(new Date(now))).map((row) => row.peer))
      .toEqual(['2025550130']);
  });

  test('a delayed canonical STOP retry keeps the question after its receipt actionable', async () => {
    const peer = '+12025550131';
    const endpoint = '+12025550199';
    const conversationId = randomUUID();
    const questionSid = 'SM-question-after-stop-receipt';
    const stopSid = 'SM-delayed-stop-retry';
    await mockPg('conversations').insert({
      id: conversationId, channel: 'sms', contact_phone: peer, our_endpoint_id: endpoint,
    });
    await mockPg('inbound_sms_optout_receipts').insert({
      message_sid: stopSid, phone: peer, applied_at: new Date(now - 3000),
    });
    await mockPg('messages').insert([
      { id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
        body: 'Can you still come tomorrow?', message_type: 'inbound', delivery_status: 'received',
        twilio_sid: questionSid, created_at: new Date(now - 2000) },
      { id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
        body: 'STOP', message_type: null, delivery_status: 'received',
        twilio_sid: stopSid, created_at: new Date(now - 1000) },
    ]);
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'inbound', from_phone: peer, to_phone: endpoint,
      message_body: 'Can you still come tomorrow?', message_type: 'inbound', status: 'received',
      twilio_sid: questionSid, created_at: new Date(now - 2000),
    });

    expect((await loadUnansweredThreads(new Date(now))).map((row) => row.message_body))
      .toEqual(['Can you still come tomorrow?']);
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'inbound', from_phone: peer, to_phone: endpoint,
      message_body: 'STOP', message_type: 'opt_out', status: 'received',
      twilio_sid: stopSid, created_at: new Date(now - 1000),
    });
    expect((await loadUnansweredThreads(new Date(now))).map((row) => row.message_body))
      .toEqual(['Can you still come tomorrow?']);
  });

  test('a late receipt cannot move an earlier canonical STOP past a later question', async () => {
    const peer = '+12025550133';
    const endpoint = '+12025550199';
    const conversationId = randomUUID();
    const stopSid = 'SM-stop-before-late-receipt';
    await mockPg('conversations').insert({
      id: conversationId, channel: 'sms', contact_phone: peer, our_endpoint_id: endpoint,
    });
    await mockPg('messages').insert([
      { id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
        body: 'STOP', message_type: 'opt_out', delivery_status: 'received',
        twilio_sid: stopSid, created_at: new Date(now - 3000) },
      { id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
        body: 'I have a new question', message_type: 'inbound', delivery_status: 'received',
        twilio_sid: 'SM-question-after-canonical-stop', created_at: new Date(now - 2000) },
    ]);
    await mockPg('inbound_sms_optout_receipts').insert({
      message_sid: stopSid, phone: peer, applied_at: new Date(now - 1000),
    });

    expect((await loadUnansweredThreads(new Date(now))).map((row) => row.message_body))
      .toEqual(['I have a new question']);
  });

  test('context-aware courtesy keeps Okay actionable when it answers a question', async () => {
    const peer = '+12025550132';
    const endpoint = '+12025550199';
    await mockPg('sms_log').insert([
      { id: randomUUID(), direction: 'outbound', from_phone: endpoint, to_phone: peer,
        message_body: 'Please confirm someone will be home.', message_type: 'reminder',
        status: 'delivered', created_at: new Date(now - 2000) },
      { id: randomUUID(), direction: 'inbound', from_phone: peer, to_phone: endpoint,
        message_body: 'Okay', metadata: {}, message_type: 'inbound', status: 'received',
        created_at: new Date(now - 1000) },
    ]);
    expect((await loadUnansweredThreads(new Date(now))).map((row) => row.message_body))
      .toEqual(['Okay']);
    await mockPg('sms_log').where({ direction: 'inbound', from_phone: peer })
      .update({ metadata: { courtesyOnly: true } });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
  });

  test('latest selection spans canonical and legacy-only inbound sources', async () => {
    const peer = '+12025550134';
    const endpoint = '+12025550199';
    const conversationId = randomUUID();
    await mockPg('conversations').insert({
      id: conversationId, channel: 'sms', contact_phone: peer, our_endpoint_id: endpoint,
    });
    await mockPg('messages').insert({
      id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
      body: 'Older canonical question', message_type: 'inbound', delivery_status: 'received',
      twilio_sid: 'SM-older-canonical-question', created_at: new Date(now - 3000),
    });
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'inbound', from_phone: peer, to_phone: endpoint,
      message_body: 'Thanks!', metadata: { courtesyOnly: true }, message_type: 'inbound',
      status: 'received', created_at: new Date(now - 2000),
    });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);

    await mockPg.raw('TRUNCATE messages, conversations, sms_log');
    const reverseConversationId = randomUUID();
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'inbound', from_phone: peer, to_phone: endpoint,
      message_body: 'Older legacy question', message_type: 'inbound', status: 'received',
      created_at: new Date(now - 3000),
    });
    await mockPg('conversations').insert({
      id: reverseConversationId, channel: 'sms', contact_phone: peer, our_endpoint_id: endpoint,
    });
    await mockPg('messages').insert({
      id: randomUUID(), conversation_id: reverseConversationId, channel: 'sms', direction: 'inbound',
      body: 'Thanks!', metadata: { courtesyOnly: true }, message_type: 'inbound',
      delivery_status: 'received', twilio_sid: 'SM-newer-canonical-courtesy',
      created_at: new Date(now - 2000),
    });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
  });

  test('cutoff limits inbound candidates while later replies and STOP still clear them', async () => {
    const endpoint = '+12025550199';
    const cutoff = new Date(now - 2000);
    await mockPg('sms_log').insert([
      { id: randomUUID(), direction: 'inbound', from_phone: '+12025550135', to_phone: endpoint,
        message_body: 'Please answer', message_type: 'inbound', status: 'received',
        created_at: new Date(now - 3000) },
      { id: randomUUID(), direction: 'inbound', from_phone: '+12025550136', to_phone: endpoint,
        message_body: 'Can you call?', message_type: 'inbound', status: 'received',
        created_at: new Date(now - 3000) },
    ]);
    expect(await loadUnansweredThreads(cutoff)).toHaveLength(2);

    await mockPg('sms_log').insert([
      { id: randomUUID(), direction: 'outbound', from_phone: endpoint, to_phone: '+12025550135',
        message_body: 'Manual reply after cutoff', message_type: 'manual', status: 'sent',
        created_at: new Date(now - 1000) },
      { id: randomUUID(), direction: 'inbound', from_phone: '+12025550136', to_phone: endpoint,
        message_body: 'STOP', message_type: 'opt_out', status: 'received',
        created_at: new Date(now - 1000) },
    ]);
    expect(await loadUnansweredThreads(cutoff)).toEqual([]);
  });

  test('watcher lookback, cap, total and unique customer association remain intact', async () => {
    const customerId = randomUUID();
    await mockPg('customers').insert({
      id: customerId, phone: '+12025550140', first_name: 'Synthetic', last_name: 'Customer',
    });
    for (let i = 0; i < 13; i += 1) {
      await seed(String(2025550140 + i), null, 1000 + i);
    }
    const current = await loadUnansweredThreads(new Date(now));
    expect(current).toHaveLength(12);
    expect(current[0]).toMatchObject({
      peer: '2025550140', customer_id: customerId, customer_name: 'Synthetic Customer',
      total_count: '13',
    });
    await mockPg('customers').insert({
      id: randomUUID(), phone: '+12025550140', first_name: 'Duplicate', last_name: 'Customer',
    });
    expect((await loadUnansweredThreads(new Date(now)))[0]).toMatchObject({
      peer: '2025550140', customer_id: null, customer_name: null,
    });

    await mockPg.raw('TRUNCATE sms_log, customers');
    await seed('2025550199', null, 31 * 24 * 60 * 60 * 1000);
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
    expect(await loadUnansweredThreads(new Date(now), { includeExpired: true })).toHaveLength(1);
  });

  test('completion Leg B lateral projection enforces the same exact legacy anchor', async () => {
    const customerId = randomUUID();
    const serviceId = randomUUID();
    const inboundId = randomUUID();
    const draftId = randomUUID();
    const legacyDraftId = randomUUID();
    const sid = 'SM-completion-exact-anchor';
    await mockPg('sms_log').insert([
      { id: inboundId, customer_id: customerId, direction: 'inbound', from_phone: '+12025550123',
        to_phone: '+12025550199', message_body: 'Latest completion question',
        created_at: new Date(now - 2000), message_type: 'inbound', status: 'received' },
      { id: randomUUID(), customer_id: customerId, direction: 'outbound', from_phone: '+12025550199',
        to_phone: '+12025550123', message_body: 'Approved answer', twilio_sid: sid,
        metadata: { draft_id: legacyDraftId }, created_at: new Date(now - 1000),
        message_type: 'ai_approved', status: 'delivered' },
    ]);
    await mockPg('message_drafts').insert([
      { id: draftId, sms_log_id: inboundId, intent: 'reply' },
      { id: legacyDraftId, sms_log_id: randomUUID(), intent: 'reply' },
    ]);
    await mockPg('messaging_audit_log').insert({
      provider_message_id: sid, channel: 'sms', metadata: { draft_id: draftId },
      created_at: new Date(now),
    });

    const exact = await findOpenCommsExceptions({ customerId, serviceId, knex: mockPg });
    expect(exact.unansweredInbound).toBeNull();
    await mockPg('message_drafts').where({ id: draftId }).update({ sms_log_id: randomUUID() });
    const wrong = await findOpenCommsExceptions({ customerId, serviceId, knex: mockPg });
    expect(wrong.unansweredInbound?.id).toBe(inboundId);
    await mockPg('message_drafts').where({ id: draftId }).update({ sms_log_id: inboundId });
    await mockPg('sms_log').where({ twilio_sid: sid }).update({ metadata: { draft_id: draftId } });
    await mockPg('messaging_audit_log').insert({
      provider_message_id: sid, channel: 'sms', metadata: { draft_id: 'malformed' },
      created_at: new Date(now + 1000),
    });
    const malformed = await findOpenCommsExceptions({ customerId, serviceId, knex: mockPg });
    expect(malformed.unansweredInbound?.id).toBe(inboundId);
  });
});
