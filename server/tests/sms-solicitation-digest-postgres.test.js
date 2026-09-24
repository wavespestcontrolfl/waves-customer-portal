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
      CREATE TEMP TABLE sms_log (id uuid, customer_id uuid, direction text, from_phone text, to_phone text,
        message_body text, metadata jsonb, created_at timestamptz, message_type text, status text, twilio_sid text);
      CREATE TEMP TABLE message_drafts (id uuid PRIMARY KEY, sms_log_id uuid, customer_id uuid, flags jsonb,
        intent text, sent_at timestamptz);
      CREATE TEMP TABLE messaging_audit_log (id uuid DEFAULT gen_random_uuid(), provider_message_id text,
        channel text, metadata jsonb, created_at timestamptz DEFAULT now());
      CREATE TEMP TABLE agent_decisions (id uuid, workflow text, detected_intent text, status text,
        entity_id uuid, customer_id uuid, created_at timestamptz, input_snapshot jsonb);
      CREATE TEMP TABLE blocked_numbers (id uuid PRIMARY KEY, number varchar(32));
    `);
  });
  afterAll(async () => { await mockPg?.rollback(); await database?.destroy(); });
  beforeEach(async () => {
    await mockPg.raw('TRUNCATE sms_log, message_drafts, messaging_audit_log, agent_decisions');
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
