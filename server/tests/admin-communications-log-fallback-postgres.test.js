// Opt-in SQL + route verification on a private local QA database (same
// harness as sms-spam-block-postgres.test.js). Temporary synthetic tables
// only; all writes roll back. No provider is callable.
//
// Covers the codex #4213 P2 finding: GET /log's unlinked-sender customer
// fallback (resolveSmsLogCustomerFallbacks / findSingleCustomerForPhone,
// admin-communications.js) keyed and resolved solely by the contact's last
// ten digits, so an unlinked international sender that happens to share its
// final ten digits with an unrelated US customer (e.g. +442079460958 vs
// +12079460958) was returned wearing that US customer's name and id. The
// fix applies the same NANP-vs-international identity rule the client's
// smsThreadKey and the inbound-sms-read blocked-numbers query already use
// (server/utils/phone.js:phoneIdentityKey / phoneMatchDigits).
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/twilio-failure-alerts', () => ({}));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/sms-suggest-mode', () => ({ HUMAN_REPLY_TYPES: ['manual', 'ai_approved', 'ai_revised'] }));
jest.mock('../services/sms-auto-send', () => ({}));
jest.mock('../services/messaging/send-customer-message', () => ({}));
jest.mock('../services/sendgrid-mail', () => ({}));
jest.mock('../services/ops-digest', () => ({}));
jest.mock('../utils/known-caller-phone', () => ({ findKnownCallerCustomer: jest.fn(async () => null) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => req.headers.authorization === 'Bearer qa'
    ? next() : res.sendStatus(401),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-communications');
const connection = process.env.UNREAD_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
let server;
let baseUrl;
const app = express();
app.use(express.json());
app.use('/communications', router);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

async function insertThread({
  contactPhone,
  ourEndpoint = '+19415550199',
  body = 'Synthetic inbound',
  metadata = {},
  twilioSid = null,
}) {
  const conversationId = randomUUID();
  await mockPg('conversations').insert({
    id: conversationId, channel: 'sms', our_endpoint_id: ourEndpoint,
    unknown_contact: true, contact_phone: contactPhone,
  });
  await mockPg('messages').insert({
    id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
    body, author_type: 'customer', metadata: JSON.stringify(metadata), twilio_sid: twilioSid,
    created_at: new Date(),
  });
  return conversationId;
}

async function getLog(query = '') {
  const response = await fetch(`${baseUrl}/communications/log${query}`, {
    headers: { Authorization: 'Bearer qa' },
  });
  return { status: response.status, body: await response.json() };
}

postgres('GET /log unlinked-sender customer fallback — NANP vs international identity', () => {
  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a private QA database');
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    mockPg = await database.transaction();
    await mockPg.raw(`
      CREATE TEMP TABLE customers (id uuid PRIMARY KEY, phone text, first_name text, last_name text, deleted_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE conversations (id uuid PRIMARY KEY, customer_id uuid, channel text, our_endpoint_id text, contact_phone text, unknown_contact boolean DEFAULT false);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, conversation_id uuid, channel text, direction text, body text,
        media jsonb DEFAULT '[]', author_type text, delivery_status text, message_type text, is_read boolean, read_at timestamptz,
        metadata jsonb DEFAULT '{}', twilio_sid text, created_at timestamptz DEFAULT now());
      CREATE TEMP TABLE sms_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), twilio_sid text, direction text,
        message_type text, status text, customer_id uuid, from_phone text, to_phone text, message_body text,
        metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now());
      CREATE TEMP TABLE messaging_audit_log (id bigserial PRIMARY KEY, provider_message_id text, channel text,
        metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now());
      CREATE TEMP TABLE message_drafts (id uuid PRIMARY KEY, intent text, sms_log_id uuid);
      CREATE TEMP TABLE blocked_numbers (id uuid PRIMARY KEY, number text);
      CREATE TEMP TABLE inbound_sms_optout_receipts (
        message_sid text PRIMARY KEY, phone text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
    `);
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await mockPg?.rollback(); await database?.destroy();
  });
  beforeEach(async () => {
    await mockPg.raw('TRUNCATE customers, conversations, messages, sms_log, messaging_audit_log, message_drafts, blocked_numbers, inbound_sms_optout_receipts');
  });

  test('pending search returns the matching peer history with the unanswered row first', async () => {
    const conversationId = await insertThread({ contactPhone: '+19415559870', body: 'Can you confirm the visit?' });
    const pending = await mockPg('messages').where({ conversation_id: conversationId }).first();
    await mockPg('messages').insert({
      id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'outbound',
      body: 'Earlier estimate details', message_type: 'reminder', delivery_status: 'sent',
      created_at: new Date(new Date(pending.created_at).getTime() - 1000),
    });
    await insertThread({ contactPhone: '+19415559871', body: 'A different pending question?' });
    const first = await getLog('?needsResponse=true&search=estimate&limit=1');
    expect(first.status).toBe(200);
    expect(first.body.messages.map(row => row.id)).toEqual([pending.id]);
    expect(first.body.hasMore).toBe(true);
    const second = await getLog('?needsResponse=true&search=estimate&limit=1&page=2');
    expect(second.status).toBe(200);
    expect(second.body.messages.map(row => row.body)).toEqual(['Earlier estimate details']);
    expect(second.body.hasMore).toBe(false);

    await mockPg('messages').where({ id: pending.id }).update({ is_read: true });
    expect((await getLog('?needsResponse=true&search=estimate')).body.messages).toHaveLength(2);
    await mockPg('messages').insert({
      id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'outbound',
      body: 'Confirmed.', message_type: 'manual', delivery_status: 'sent',
      created_at: new Date(new Date(pending.created_at).getTime() + 1000),
    });
    expect((await getLog('?needsResponse=true&search=estimate')).body.messages).toEqual([]);
  });

  test('pending search supports multiple matching rows across multiple peers', async () => {
    await insertThread({ contactPhone: '+19415559870', body: 'Can you confirm the estimate?' });
    await insertThread({ contactPhone: '+19415559871', body: 'Can you revise the estimate?' });
    const result = await getLog('?needsResponse=true&search=estimate');
    expect(result.status).toBe(200);
    expect(result.body.messages).toHaveLength(2);
  });

  test('pending search does not match recruiting-only history hidden from the reader', async () => {
    const conversationId = await insertThread({ contactPhone: '+19415559870', body: 'Can you confirm the visit?' });
    await mockPg('messages').insert({
      id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'outbound',
      body: 'Private interview link', message_type: 'job_invite', delivery_status: 'sent',
    });
    const result = await getLog('?needsResponse=true&search=interview');
    expect(result.status).toBe(200);
    expect(result.body.messages).toEqual([]);
  });

  test('an unlinked +44 sender sharing a US customer\'s last 10 digits resolves to NO customer', async () => {
    await mockPg('customers').insert({
      id: randomUUID(), phone: '+12079460958', first_name: 'Dana', last_name: 'Ordway',
    });
    await insertThread({ contactPhone: '+442079460958', body: 'Synthetic UK inbound' });

    const { status, body } = await getLog();
    expect(status).toBe(200);
    const msg = body.messages.find((m) => m.body === 'Synthetic UK inbound');
    expect(msg).toBeDefined();
    expect(msg.customerId).toBeNull();
    expect(msg.customerName).toBeNull();
  });

  test.each([
    ['+19415551234', 'stored +1 E.164'],
    ['9415551234', 'stored bare 10-digit'],
    ['(941) 555-1234', 'stored formatted'],
  ])('the existing US customer still resolves from its own number (%s — %s)', async (storedPhone) => {
    const customerId = randomUUID();
    await mockPg('customers').insert({
      id: customerId, phone: storedPhone, first_name: 'Priya', last_name: 'Nassif',
    });
    await insertThread({ contactPhone: '+19415551234', body: 'Synthetic US inbound' });

    const { status, body } = await getLog();
    expect(status).toBe(200);
    const msg = body.messages.find((m) => m.body === 'Synthetic US inbound');
    expect(msg).toBeDefined();
    expect(msg.customerId).toBe(customerId);
    expect(msg.customerName).toBe('Priya Nassif');
  });

  test('both an international sender and its unrelated US last-10 match resolve independently in the same page', async () => {
    const usCustomerId = randomUUID();
    await mockPg('customers').insert({
      id: usCustomerId, phone: '+12079460958', first_name: 'Dana', last_name: 'Ordway',
    });
    await insertThread({ contactPhone: '+442079460958', body: 'Synthetic UK inbound', ourEndpoint: '+19415550199' });
    await insertThread({ contactPhone: '+12079460958', body: 'Synthetic matching US inbound', ourEndpoint: '+19415550299' });

    const { body } = await getLog();
    const uk = body.messages.find((m) => m.body === 'Synthetic UK inbound');
    const us = body.messages.find((m) => m.body === 'Synthetic matching US inbound');
    expect(uk.customerId).toBeNull();
    expect(us.customerId).toBe(usCustomerId);
    expect(us.customerName).toBe('Dana Ordway');
  });

  test('malformed draft metadata stays a normal log row instead of raising an invalid UUID error', async () => {
    await insertThread({
      contactPhone: '+19415559876',
      body: 'Malformed draft metadata',
      metadata: { draft_id: 'not-a-uuid' },
      twilioSid: 'SM-malformed',
    });
    const { status, body } = await getLog();
    expect(status).toBe(200);
    expect(body.messages.find((message) => message.body === 'Malformed draft metadata')).toBeDefined();
  });

  test('projects the exact canonical inbound anchor and provider handoff time for an approved draft', async () => {
    const conversationId = randomUUID();
    const inboundMessageId = randomUUID();
    const inboundLogId = randomUUID();
    const draftId = randomUUID();
    const outboundMessageId = randomUUID();
    await mockPg('conversations').insert({
      id: conversationId, channel: 'sms', our_endpoint_id: '+19415550199',
      unknown_contact: true, contact_phone: '+19415559878',
    });
    await mockPg('messages').insert([
      {
        id: inboundMessageId, conversation_id: conversationId, channel: 'sms', direction: 'inbound',
        body: 'Can you check the gate?', author_type: 'customer', twilio_sid: 'SM-anchor-exact',
        created_at: '2026-09-23T12:00:00Z',
      },
      {
        id: outboundMessageId, conversation_id: conversationId, channel: 'sms', direction: 'outbound',
        body: 'Yes, we can.', author_type: 'admin', twilio_sid: 'SM-reply-exact',
        message_type: 'ai_approved', delivery_status: 'sent', created_at: '2026-09-23T12:00:10Z',
      },
    ]);
    await mockPg('sms_log').insert([
      {
        id: inboundLogId, twilio_sid: 'SM-anchor-exact', direction: 'inbound',
        message_type: 'inbound', status: 'received', created_at: '2026-09-23T12:00:00Z',
      },
      {
        twilio_sid: 'SM-reply-exact', direction: 'outbound', message_type: 'ai_approved',
        status: 'sent', metadata: { draft_id: draftId }, created_at: '2026-09-23T12:00:04Z',
      },
    ]);
    await mockPg('message_drafts').insert({ id: draftId, intent: 'reply', sms_log_id: inboundLogId });

    const { status, body } = await getLog();
    expect(status).toBe(200);
    const reply = body.messages.find((item) => item.id === outboundMessageId);
    expect(reply).toMatchObject({
      responseIsAnswer: true,
      responseReplyToMessageId: inboundMessageId,
      responseCreatedAt: '2026-09-23T12:00:04.000Z',
      createdAt: '2026-09-23T12:00:10.000Z',
    });
  });

  test('fails closed when a draft anchor has duplicate canonical inbound twins', async () => {
    const conversationId = randomUUID();
    const inboundLogId = randomUUID();
    const draftId = randomUUID();
    const outboundMessageId = randomUUID();
    await mockPg('conversations').insert({
      id: conversationId, channel: 'sms', our_endpoint_id: '+19415550199',
      unknown_contact: true, contact_phone: '+19415559879',
    });
    await mockPg('messages').insert([
      ...[randomUUID(), randomUUID()].map((id) => ({
        id, conversation_id: conversationId, channel: 'sms', direction: 'inbound',
        body: 'Duplicate canonical twin', author_type: 'customer', twilio_sid: 'SM-anchor-duplicate',
      })),
      {
        id: outboundMessageId, conversation_id: conversationId, channel: 'sms', direction: 'outbound',
        body: 'Draft reply', author_type: 'admin', twilio_sid: 'SM-reply-duplicate',
        message_type: 'ai_revised', delivery_status: 'sent',
      },
    ]);
    await mockPg('sms_log').insert([
      { id: inboundLogId, twilio_sid: 'SM-anchor-duplicate', direction: 'inbound', status: 'received' },
      {
        twilio_sid: 'SM-reply-duplicate', direction: 'outbound', message_type: 'ai_revised',
        status: 'sent', metadata: { draft_id: draftId },
      },
    ]);
    await mockPg('message_drafts').insert({ id: draftId, intent: 'reply', sms_log_id: inboundLogId });

    const { status, body } = await getLog();
    expect(status).toBe(200);
    expect(body.messages.find((item) => item.id === outboundMessageId)).toMatchObject({
      responseIsAnswer: false,
      responseReplyToMessageId: null,
    });
  });

  test('loads prior outbound context set-wise for courtesy classification', async () => {
    const conversationId = randomUUID();
    await mockPg('conversations').insert({
      id: conversationId, channel: 'sms', our_endpoint_id: '+19415550199',
      unknown_contact: true, contact_phone: '+19415559877',
    });
    const insertMessage = (createdAt, direction, body) => mockPg('messages').insert({
      id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction, body,
      author_type: direction === 'inbound' ? 'customer' : 'admin',
      delivery_status: direction === 'outbound' ? 'sent' : 'received',
      message_type: direction === 'outbound' ? 'manual' : 'inbound', created_at: createdAt,
    });
    await insertMessage('2026-09-23T12:00:00Z', 'outbound', 'Does 9am work?');
    await insertMessage('2026-09-23T12:01:00Z', 'inbound', 'Okay');
    await insertMessage('2026-09-23T12:02:00Z', 'outbound', 'Your service is complete. Reply STOP to opt out.');
    await insertMessage('2026-09-23T12:03:00Z', 'inbound', 'Thanks!');

    const { status, body } = await getLog();
    expect(status).toBe(200);
    expect(body.messages.find((message) => message.body === 'Okay').courtesyOnly).toBe(false);
    expect(body.messages.find((message) => message.body === 'Thanks!').courtesyOnly).toBe(true);
  });

  test.each([true, false])(
    'projects a delayed receipt-backed STOP before a later question (legacy row: %s)',
    async (withLegacyStop) => {
      const conversationId = randomUUID();
      const contactPhone = '+19415559880';
      await mockPg('conversations').insert({
        id: conversationId, channel: 'sms', our_endpoint_id: '+19415550199',
        unknown_contact: true, contact_phone: contactPhone,
      });
      await mockPg('inbound_sms_optout_receipts').insert({
        message_sid: 'SM-delayed-stop', phone: contactPhone, applied_at: '2026-09-23T12:01:00Z',
      });
      await mockPg('messages').insert([
        {
          id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
          body: 'Can you still come Friday?', author_type: 'customer', message_type: 'inbound',
          twilio_sid: 'SM-real-question', created_at: '2026-09-23T12:02:00Z',
        },
        {
          id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
          body: 'STOP', author_type: 'customer', message_type: 'inbound',
          twilio_sid: 'SM-delayed-stop', created_at: '2026-09-23T12:03:00Z',
        },
      ]);
      if (withLegacyStop) {
        await mockPg('sms_log').insert({
          twilio_sid: 'SM-delayed-stop', direction: 'inbound', message_type: 'opt_out',
          status: 'received', created_at: '2026-09-23T12:03:00Z',
        });
      }

      const { status, body } = await getLog();
      expect(status).toBe(200);
      expect(body.messages.find((message) => message.body === 'STOP')).toMatchObject({
        messageType: 'inbound',
        responseMessageType: 'opt_out',
        createdAt: '2026-09-23T12:01:00.000Z',
      });
      expect(body.messages.find((message) => message.body === 'Can you still come Friday?')).toMatchObject({
        responseMessageType: 'inbound',
        createdAt: '2026-09-23T12:02:00.000Z',
      });
    },
  );
});
