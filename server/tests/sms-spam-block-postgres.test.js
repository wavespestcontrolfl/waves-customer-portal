// Opt-in SQL + route verification on a private local QA database. Temporary
// synthetic tables only; all writes roll back. No provider is callable.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/twilio-failure-alerts', () => ({}));
jest.mock('../services/sms-media', () => ({}));
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
const { _private: { loadUnansweredThreads } } = require('../services/unworked-comms-watcher');
const router = require('../routes/admin-communications');
const { findKnownCallerCustomer } = require('../utils/known-caller-phone');
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
async function block(number) {
  const response = await fetch(`${baseUrl}/communications/blocked-numbers`, {
    method: 'POST', headers: { Authorization: 'Bearer qa', 'Content-Type': 'application/json' },
    body: JSON.stringify({ number }),
  });
  return { status: response.status, body: await response.json() };
}

postgres('SMS spam guard and digest SQL', () => {
  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a private QA database');
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    mockPg = await database.transaction();
    await mockPg.raw(`
      CREATE TEMP TABLE customers (id uuid PRIMARY KEY, phone text, first_name text, last_name text, deleted_at timestamptz);
      CREATE TEMP TABLE leads (id uuid PRIMARY KEY, phone text, first_name text, last_name text, status text, converted_at timestamptz, deleted_at timestamptz);
      CREATE TEMP TABLE blocked_numbers (number text PRIMARY KEY, block_type text, blocked_by uuid, reason text, auto_blocked boolean);
      CREATE TEMP TABLE sms_log (customer_id uuid, direction text, from_phone text, to_phone text, message_body text,
        metadata jsonb, created_at timestamptz, message_type text, status text);
      CREATE TEMP TABLE message_drafts (sms_log_id uuid, customer_id uuid, flags jsonb, sent_at timestamptz);
    `);
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await mockPg?.rollback(); await database?.destroy();
  });
  beforeEach(async () => {
    await mockPg.raw('TRUNCATE leads, blocked_numbers, sms_log');
    findKnownCallerCustomer.mockResolvedValue(null);
  });

  test.each([
    ['+12079460958', '+442079460958'],
    ['+442079460958', '+12079460958'],
  ])('blocking %s preserves the unrelated %s digest item', async (blocked, ordinary) => {
    await mockPg('blocked_numbers').insert({ number: blocked });
    await mockPg('sms_log').insert([blocked, ordinary].map((phone) => ({
      direction: 'inbound', from_phone: phone, to_phone: '+19415550199',
      message_body: phone === ordinary ? 'Synthetic service request' : 'Synthetic vendor pitch',
      created_at: new Date(Date.now() - 1000), message_type: 'inbound', status: 'received',
    })));
    const rows = await loadUnansweredThreads();
    expect(rows.map((row) => row.message_body)).toEqual(['Synthetic service request']);
  });

  test.each(['reply', 'STOP'])('a blocked domestic %s cannot clear an international thread', async (kind) => {
    const domestic = '+12079460958';
    const international = '+442079460958';
    const ours = '+19415550199';
    await mockPg('blocked_numbers').insert({ number: domestic });
    await mockPg('sms_log').insert([
      { direction: 'inbound', from_phone: international, to_phone: ours,
        message_body: 'Synthetic service request', created_at: new Date(Date.now() - 3000), message_type: 'inbound', status: 'received' },
      { direction: kind === 'reply' ? 'outbound' : 'inbound',
        from_phone: kind === 'reply' ? ours : domestic, to_phone: kind === 'reply' ? domestic : ours,
        message_body: kind === 'reply' ? 'Synthetic response' : 'STOP', created_at: new Date(Date.now() - 1000),
        message_type: kind === 'reply' ? 'manual' : 'opt_out', status: kind === 'reply' ? 'sent' : 'received' },
    ]);
    expect((await loadUnansweredThreads()).map((row) => row.peer)).toEqual([international]);
  });

  test.each(['anonymous', '', '123', '+'])('rejects invalid block identity %j', async (number) => {
    expect((await block(number)).status).toBe(400);
    expect(await mockPg('blocked_numbers')).toEqual([]);
  });

  test('protects a live open lead but permits its soft-deleted row to be blocked', async () => {
    const id = randomUUID();
    await mockPg('leads').insert({ id, phone: '(941) 555-0100', status: 'new' });
    expect((await block('+19415550100')).body.code).toBe('LEAD_NUMBER');
    expect(await mockPg('blocked_numbers')).toEqual([]);
    await mockPg('leads').where({ id }).update({ deleted_at: new Date() });
    expect((await block('+19415550100')).status).toBe(200);
    expect(await mockPg('blocked_numbers').first()).toMatchObject({ number: '+19415550100', block_type: 'hard_block' });
  });

  test('an unrelated international lead does not prevent a domestic spam block', async () => {
    await mockPg('leads').insert({ id: randomUUID(), phone: '+442079460958', status: 'new' });
    expect((await block('+12079460958')).status).toBe(200);
    expect((await block('+442079460958')).body.code).toBe('LEAD_NUMBER');
  });

  test('a known customer is refused before any block is written', async () => {
    findKnownCallerCustomer.mockResolvedValue({ id: randomUUID() });
    expect((await block('+19415550100')).body.code).toBe('CUSTOMER_NUMBER');
    expect(await mockPg('blocked_numbers')).toEqual([]);
  });
});
