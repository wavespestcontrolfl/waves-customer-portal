// Opt-in regression against a private QA PostgreSQL database. No application
// DATABASE_URL is read. Objects in this dedicated database roll back after the suite.
const mockRawCalls = [];
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => { mockRawCalls.push(args); return mockPg.raw(...args); };
  return db;
});
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));

const { randomUUID } = require('node:crypto');
const { countUnreadInboundSms } = require('../services/inbound-sms-read');
const { loadPriorOutboundBodies } = require('../services/sms-response-policy');
const connection = process.env.UNREAD_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;

postgres('SMS needs-response count (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use a private worktree QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    mockPg = await database.transaction();
    await mockPg.raw(`
      CREATE TABLE customers (id uuid PRIMARY KEY, phone varchar(32));
      CREATE TABLE conversations (id uuid PRIMARY KEY, customer_id uuid, channel varchar(20), contact_phone varchar(32), our_endpoint_id varchar(100));
      CREATE TABLE messages (
        id uuid PRIMARY KEY, conversation_id uuid NOT NULL, channel varchar(20), direction varchar(12),
        body text, media jsonb DEFAULT '[]', metadata jsonb DEFAULT '{}', message_type varchar(30),
        delivery_status varchar(20), twilio_sid varchar(64), is_read boolean, created_at timestamptz NOT NULL
      );
      CREATE TABLE sms_log (
        id uuid PRIMARY KEY, customer_id uuid, direction varchar(12), from_phone varchar(32), to_phone varchar(32),
        message_body text, metadata jsonb, message_type varchar(30), status varchar(20), twilio_sid varchar(64), created_at timestamptz NOT NULL
      );
      CREATE TABLE blocked_numbers (id uuid PRIMARY KEY, number varchar(32));
      CREATE TABLE message_drafts (id uuid PRIMARY KEY, sms_log_id uuid, customer_id uuid, flags jsonb, intent text, sent_at timestamptz);
      CREATE TABLE messaging_audit_log (
        id uuid PRIMARY KEY, provider_message_id varchar(64), channel varchar(16), metadata jsonb, created_at timestamptz NOT NULL
      );
      CREATE INDEX messaging_audit_provider_message_id_idx ON messaging_audit_log (provider_message_id)
        WHERE provider_message_id IS NOT NULL;
    `);
  });
  afterAll(async () => { await mockPg?.rollback(); await database?.destroy(); });
  beforeEach(async () => {
    await mockPg.raw('TRUNCATE messages, conversations, customers, sms_log, blocked_numbers, message_drafts, messaging_audit_log');
    tick = new Date('2026-09-23T12:00:00.000Z');
  });

  let tick;
  async function seedEvent({
    phone = '+19415550100', ours = '+19415550190', customerId = null,
    direction = 'inbound', body = 'Can you call me?', messageType = direction === 'inbound' ? 'inbound' : 'manual',
    status = direction === 'inbound' ? 'received' : 'delivered', metadata = {}, media = [],
    legacy = true, read = false, auditMetadata = null,
  } = {}) {
    const createdAt = tick;
    tick = new Date(tick.getTime() + 1000);
    let resolvedCustomerId = customerId;
    if (customerId === 'new') {
      resolvedCustomerId = randomUUID();
      await mockPg('customers').insert({ id: resolvedCustomerId, phone });
    }
    let conversation = await mockPg('conversations').where({ customer_id: resolvedCustomerId, contact_phone: phone, our_endpoint_id: ours }).first();
    if (!conversation) {
      conversation = { id: randomUUID(), customer_id: resolvedCustomerId, channel: 'sms', contact_phone: phone, our_endpoint_id: ours };
      await mockPg('conversations').insert(conversation);
    }
    const sid = `SM${randomUUID().replace(/-/g, '')}`;
    await mockPg('messages').insert({
      id: randomUUID(), conversation_id: conversation.id, channel: 'sms', direction, body,
      media: JSON.stringify(media), metadata: JSON.stringify(metadata), message_type: messageType,
      delivery_status: status, twilio_sid: sid, is_read: read, created_at: createdAt,
    });
    if (legacy) {
      await mockPg('sms_log').insert({
        id: randomUUID(), customer_id: resolvedCustomerId, direction,
        from_phone: direction === 'inbound' ? phone : ours, to_phone: direction === 'inbound' ? ours : phone,
        message_body: body, metadata: JSON.stringify(metadata), message_type: messageType,
        status, twilio_sid: sid, created_at: createdAt,
      });
    }
    if (auditMetadata) {
      await mockPg('messaging_audit_log').insert({
        id: randomUUID(), provider_message_id: sid, channel: 'sms',
        metadata: JSON.stringify(auditMetadata), created_at: createdAt,
      });
    }
    return { customerId: resolvedCustomerId, sid };
  }

  test('ignores read markers and dedupes endpoint threads by peer', async () => {
    await seedEvent({ read: true });
    await seedEvent({ ours: '+19415550191', body: 'The side gate is locked' });
    await seedEvent({ phone: '+19415550101', body: 'There are ants again', read: true });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 2, messages: 3 });
  });

  test('courtesy closes old pending state and a later question reopens it', async () => {
    await seedEvent({ body: 'You missed the lanai' });
    await seedEvent({ body: 'Thanks!', metadata: { courtesyOnly: true } });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
    await seedEvent({ body: 'Can you come back tomorrow?' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });

  test('historical acknowledgments clear only with verified non-question context', async () => {
    await seedEvent({ direction: 'outbound', body: 'The work is complete. Reply STOP to opt out.' });
    await seedEvent({ body: 'Thanks!' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
    await seedEvent({ direction: 'outbound', body: 'Does 9am work?' });
    for (const body of ['Okay', '👍', 'Thanks!']) {
      await seedEvent({ body });
      expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    }
  });

  test('courtesy context excludes unknown, other-line, future, failed and stale outbound', async () => {
    await seedEvent({ body: 'Thanks!' });
    await seedEvent({ direction: 'outbound', messageType: 'reminder', body: 'Complete' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    tick = new Date(tick.getTime() + 25 * 60 * 60 * 1000);
    await seedEvent({ direction: 'outbound', ours: '+19415550191', body: 'Complete' });
    await seedEvent({ direction: 'outbound', status: 'failed', body: 'Complete' });
    await seedEvent({ direction: 'outbound', messageType: 'internal_alert', body: 'Complete' });
    await seedEvent({ body: 'Thanks!' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });

  test('an unknown business endpoint is excluded because no valid reply line exists', async () => {
    await seedEvent({ direction: 'outbound', ours: '', body: 'The work is complete' });
    await seedEvent({ ours: '', body: 'Thanks!' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('successful human reply closes; automated or failed outbound does not', async () => {
    await seedEvent({ body: 'Please call me' });
    await seedEvent({ direction: 'outbound', messageType: 'reminder', body: 'Appointment reminder' });
    await seedEvent({ direction: 'outbound', messageType: 'manual', status: 'failed', body: 'Failed reply' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    await seedEvent({ direction: 'outbound', messageType: 'manual', status: 'sent', body: 'Calling now' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('uses the provider handoff time when the unified outbound write lands after a newer inbound', async () => {
    await seedEvent({ body: 'Can you confirm the arrival window?' });
    const reply = await seedEvent({ direction: 'outbound', body: 'We will arrive at noon.' });
    await seedEvent({ body: 'Could you make it one instead?' });
    await mockPg('messages').where({ twilio_sid: reply.sid }).update({
      created_at: new Date(tick.getTime() + 60_000),
    });

    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });

  test('finds courtesy context by provider handoff when unified persistence lands after the inbound', async () => {
    const update = await seedEvent({ direction: 'outbound', body: 'Your service is complete.' });
    const thanks = await seedEvent({ body: 'Thanks!' });
    await mockPg('messages').where({ twilio_sid: update.sid }).update({
      created_at: new Date(tick.getTime() + 60_000),
    });
    const inbound = await mockPg('messages as m')
      .join('conversations as c', 'c.id', 'm.conversation_id')
      .where('m.twilio_sid', thanks.sid)
      .first(
        'm.id', 'm.direction', 'm.channel', 'm.created_at',
        'c.contact_phone', 'c.our_endpoint_id', 'c.customer_id',
      );

    const contexts = await loadPriorOutboundBodies(mockPg, [inbound]);
    expect(contexts.get(String(inbound.id))).toBe('Your service is complete.');
  });

  test('uses provider handoff time at the 24-hour courtesy boundary', async () => {
    const update = await seedEvent({ direction: 'outbound', body: 'Your service is complete.' });
    await mockPg('messages').where({ twilio_sid: update.sid }).update({
      created_at: new Date('2026-09-23T12:00:02.000Z'),
    });
    tick = new Date('2026-09-24T12:00:01.000Z');
    await seedEvent({ body: 'Okay' });

    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });

  test('an approved click-followup nudge does not answer, while a nearby manual reply does', async () => {
    await seedEvent({ body: 'Can you help with this?' });
    const draftId = randomUUID();
    await mockPg('message_drafts').insert({ id: draftId, intent: 'click_followup', sent_at: tick });
    await seedEvent({
      direction: 'outbound', messageType: 'ai_approved', status: 'sent',
      body: 'Checking in on your estimate', auditMetadata: { draft_id: draftId },
    });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    await seedEvent({ direction: 'outbound', messageType: 'manual', status: 'sent', body: 'Yes, we can help.', auditMetadata: { draft_id: 'not-a-uuid' } });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('approval sends require an exact inbound-anchored draft to clear an unanswered question', async () => {
    await seedEvent({ body: 'Please call me' });
    await seedEvent({ direction: 'outbound', messageType: 'ai_approved', body: 'Checking in' });
    await seedEvent({ direction: 'outbound', messageType: 'ai_revised', metadata: { draft_id: 'invalid' } });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    const proactiveDraftId = randomUUID();
    await mockPg('message_drafts').insert({ id: proactiveDraftId, intent: 'agent_ops_lead_followup' });
    await seedEvent({ direction: 'outbound', messageType: 'ai_approved', auditMetadata: { draft_id: proactiveDraftId } });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    const replyDraftId = randomUUID();
    await mockPg('message_drafts').insert({ id: replyDraftId, sms_log_id: randomUUID(), intent: 'customer_issue_needs_review' });
    await seedEvent({ direction: 'outbound', messageType: 'ai_approved', auditMetadata: { draft_id: replyDraftId } });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('audit provider-id index migration rolls down and up on the synthetic table', async () => {
    const migration = require('../models/migrations/20260923000002_messaging_audit_provider_message_index');
    await migration.down(mockPg);
    expect(await mockPg('pg_indexes').where({ indexname: 'messaging_audit_provider_message_id_idx' })).toHaveLength(0);
    await migration.up(mockPg);
    const rows = await mockPg('pg_indexes')
      .where({ indexname: 'messaging_audit_provider_message_id_idx' })
      .select('indexdef');
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('(provider_message_id)');
    expect(rows[0].indexdef).toContain('provider_message_id IS NOT NULL');
    const audits = Array.from({ length: 500 }, (_, i) => ({
      id: randomUUID(), provider_message_id: `SM-audit-${i}`, channel: 'sms', metadata: '{}',
      created_at: new Date(2026, 8, 1, 12, 0, i),
    }));
    await mockPg.batchInsert('messaging_audit_log', audits, 100);
    const explain = await mockPg.raw(`
      EXPLAIN (FORMAT JSON)
      SELECT metadata FROM messaging_audit_log
      WHERE provider_message_id = ? AND channel = 'sms'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `, ['SM-audit-499']);
    expect(JSON.stringify(explain.rows[0]['QUERY PLAN'])).toContain('messaging_audit_provider_message_id_idx');
  });

  test('reaction does not erase an ask, while STOP closes the peer', async () => {
    await seedEvent({ body: 'Please call me' });
    await seedEvent({ body: 'Liked “Please call me”', messageType: 'sms_reaction' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    await seedEvent({ body: 'STOP', messageType: 'opt_out' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('media overrides courtesy/spam retirement; later enforced spam retires', async () => {
    await seedEvent({ body: 'Thanks!', metadata: { courtesyOnly: true, spam_verdict: { enforced: true } }, media: [{ url: 'synthetic.jpg' }] });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    await seedEvent({ body: 'Pitch', metadata: { spam_verdict: { enforced: true } } });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('unified-only events count and legacy compliance type overlays its twin', async () => {
    await seedEvent({ body: 'Unified only question?', legacy: false });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
    await seedEvent({ direction: 'outbound', body: 'Unified only answer', status: 'queued', legacy: false });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
    await seedEvent({ body: 'Another question' });
    const stop = await seedEvent({ body: 'STOP', messageType: 'inbound' });
    await mockPg('sms_log').where({ twilio_sid: stop.sid }).update({ message_type: 'opt_out' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
    await seedEvent({ body: 'A later question?' });
    const canonicalStop = await seedEvent({ body: 'STOP', messageType: 'opt_out' });
    await mockPg('sms_log').where({ twilio_sid: canonicalStop.sid }).update({ message_type: null });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('a legacy-only STOP closes its canonical peer', async () => {
    await seedEvent({ body: 'Can you call me?' });
    const stop = await seedEvent({ body: 'STOP', messageType: 'opt_out' });
    await mockPg('messages').where({ twilio_sid: stop.sid }).del();

    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
  });

  test('preserves customer, blocked sender, and internal-phone scope', async () => {
    const owned = await seedEvent({ customerId: 'new' });
    await seedEvent({ phone: '+19415550101' });
    expect(await countUnreadInboundSms({ customerId: owned.customerId })).toEqual({ conversations: 1, messages: 1 });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: '(941) 555-0100' });
    expect(await countUnreadInboundSms({ customerId: owned.customerId })).toEqual({ conversations: 0, messages: 0 });
    expect(await countUnreadInboundSms({ excludePhones: ['+19415550101'] })).toEqual({ conversations: 0, messages: 0 });
  });

  test('a peer-wide STOP closes a customer-scoped question across duplicate customer records', async () => {
    const original = await seedEvent({ customerId: 'new', body: 'Can you call me?' });
    await seedEvent({ customerId: 'new', body: 'STOP', messageType: 'opt_out' });

    expect(await countUnreadInboundSms({ customerId: original.customerId })).toEqual({ conversations: 0, messages: 0 });
    await seedEvent({ customerId: original.customerId, body: 'Can you call tomorrow?' });
    expect(await countUnreadInboundSms({ customerId: original.customerId })).toEqual({ conversations: 1, messages: 1 });
  });

  test('canonical customer phone changes keep the badge aligned with the displayed thread', async () => {
    const owned = await seedEvent({ customerId: 'new', phone: '+19415550100' });
    await mockPg('conversations').where({ customer_id: owned.customerId }).update({ contact_phone: null });
    await mockPg('customers').where({ id: owned.customerId }).update({ phone: '+19415550101' });
    await seedEvent({ customerId: owned.customerId, phone: '+19415550101', direction: 'outbound', body: 'Reply on the current customer thread' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 0, messages: 0 });
    expect(await countUnreadInboundSms({ customerId: owned.customerId })).toEqual({ conversations: 0, messages: 0 });
    await seedEvent({ customerId: owned.customerId, phone: '+19415550101', body: 'Can you help again?' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });

  test('a STOP twin follows the canonical customer phone after identity changes', async () => {
    const owned = await seedEvent({ customerId: 'new', phone: '+19415550100', body: 'Can you call me?' });
    await seedEvent({ customerId: owned.customerId, phone: '+19415550100', body: 'STOP', messageType: 'opt_out' });
    await mockPg('conversations').where({ customer_id: owned.customerId }).update({ contact_phone: null });
    await mockPg('customers').where({ id: owned.customerId }).update({ phone: '+19415550101' });

    expect(await countUnreadInboundSms({ customerId: owned.customerId })).toEqual({ conversations: 0, messages: 0 });
  });

  test('international peers stay distinct when a NANP peer with matching last digits is blocked', async () => {
    await seedEvent({ phone: '+442079460958' });
    await seedEvent({ phone: '+12079460958' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 2, messages: 2 });
    await mockPg('blocked_numbers').insert({ id: randomUUID(), number: '+12079460958' });
    expect(await countUnreadInboundSms()).toEqual({ conversations: 1, messages: 1 });
  });

  test('planner materializes full-history events once on a moderately sized synthetic inbox', async () => {
    const conversations = [];
    const messages = [];
    const logs = [];
    for (let i = 0; i < 150; i += 1) {
      const conversationId = randomUUID();
      const sid = `SM${randomUUID().replace(/-/g, '')}`;
      const phone = `+1941${String(5550000 + i).padStart(7, '0')}`;
      const createdAt = new Date(2026, 8, 1, 12, 0, i);
      conversations.push({ id: conversationId, customer_id: null, contact_phone: phone, our_endpoint_id: '+19415550190' });
      messages.push({
        id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
        body: 'Synthetic question?', media: '[]', metadata: '{}', message_type: 'inbound',
        delivery_status: 'received', twilio_sid: sid, is_read: false, created_at: createdAt,
      });
      const current = messages[messages.length - 1];
      for (let history = 1; history <= 8; history += 1) messages.push({
        ...current, id: randomUUID(), twilio_sid: null, direction: 'outbound',
        body: 'Completed', message_type: 'manual', delivery_status: 'delivered',
        created_at: new Date(createdAt.getTime() - history * 60000),
      });
      logs.push({
        id: randomUUID(), customer_id: null, direction: 'inbound', from_phone: phone, to_phone: '+19415550190',
        message_body: 'Synthetic question?', metadata: '{}', message_type: 'inbound', status: 'received',
        twilio_sid: sid, created_at: createdAt,
      });
    }
    await mockPg.batchInsert('conversations', conversations, 100);
    await mockPg.batchInsert('messages', messages, 100);
    await mockPg.batchInsert('sms_log', logs, 100);
    await mockPg.raw('ANALYZE messages; ANALYZE conversations; ANALYZE sms_log');
    mockRawCalls.length = 0;
    await countUnreadInboundSms();
    const [sql, bindings] = mockRawCalls.find(([statement]) => statement.includes('WITH base_sms AS'));
    const explained = await mockPg.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, bindings);
    const plan = explained.rows[0]['QUERY PLAN'][0];
    expect(plan.Plan).toBeTruthy();
    // Materialize once so the human-reply and STOP anti-joins do not rescan
    // the complete message history for every pending peer.
    const nodes = [];
    const collect = node => { nodes.push(node); (node.Plans || []).forEach(collect); };
    collect(plan.Plan);
    const contextScans = nodes.filter(node => node['CTE Name'] === 'outbound_events' && node.Alias === 'prev');
    expect(contextScans).toHaveLength(1);
    expect(contextScans[0]['Actual Loops']).toBe(1);
  });
});
