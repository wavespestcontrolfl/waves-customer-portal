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

async function insertThread({ contactPhone, ourEndpoint = '+19415550199', body = 'Synthetic inbound' }) {
  const conversationId = randomUUID();
  await mockPg('conversations').insert({
    id: conversationId, channel: 'sms', our_endpoint_id: ourEndpoint,
    unknown_contact: true, contact_phone: contactPhone,
  });
  await mockPg('messages').insert({
    id: randomUUID(), conversation_id: conversationId, channel: 'sms', direction: 'inbound',
    body, author_type: 'customer', created_at: new Date(),
  });
  return conversationId;
}

async function getLog() {
  const response = await fetch(`${baseUrl}/communications/log`, {
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
        created_at timestamptz DEFAULT now());
    `);
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await mockPg?.rollback(); await database?.destroy();
  });
  beforeEach(async () => {
    await mockPg.raw('TRUNCATE customers, conversations, messages');
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
});
