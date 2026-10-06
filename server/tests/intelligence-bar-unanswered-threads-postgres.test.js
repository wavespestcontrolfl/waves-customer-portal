// get_unanswered_threads against real PostgreSQL, in a rollback-only transaction on a
// private schema (same shape as intelligence-bar-cancel-queued-message-postgres.test.js).
// Skips cleanly with no DATABASE_URL. Synthetic customers only — no real names.
//
// The tool's inbound query joins customers (which also has created_at), so a bare
// column reference threw `column reference "created_at" is ambiguous` on a real
// schema; the mocked-knex suites never saw it.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const { executeCommsTool } = require('../services/intelligence-bar/comms-tools');
jest.setTimeout(30000);

postgres('get_unanswered_threads (real PostgreSQL)', () => {
  let database;
  let trx;
  let schema;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error("Use disposable CI or this worktree's private QA database");
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    schema = `unanswered_threads_${randomUUID().replaceAll('-', '')}`;
    await trx.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['sms_log', 'customers']) {
      await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    db.connection = trx;
  });

  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  let phoneSeq = 0;
  async function customer(firstName) {
    const id = randomUUID();
    const suffix = String(1000 + (phoneSeq += 1));
    const phone = `+1941555${suffix}`;
    await trx('customers').insert({
      id, first_name: firstName, last_name: 'Fixture', phone,
      email: `synthetic.${suffix}@example.com`,
      address_line1: '1 Synthetic Test Way', city: 'Bradenton', state: 'FL', zip: '34208',
    });
    return { id, phone };
  }

  const minutesAgo = (m) => new Date(Date.now() - m * 60000);

  async function inbound(cust, body, ageMinutes) {
    await trx('sms_log').insert({
      id: randomUUID(), customer_id: cust.id, direction: 'inbound', from_phone: cust.phone, to_phone: '+19413529161',
      message_body: body, message_type: 'inbound', status: 'received', created_at: minutesAgo(ageMinutes),
    });
  }

  async function outbound(cust, body, ageMinutes, overrides = {}) {
    await trx('sms_log').insert({
      id: randomUUID(), customer_id: cust.id, direction: 'outbound', from_phone: '+19413529161', to_phone: cust.phone,
      message_body: body, message_type: 'manual', status: 'sent', created_at: minutesAgo(ageMinutes),
      ...overrides,
    });
  }

  test('lists a customer whose inbound text has no reply, with the customer joined, and does not list one that was answered', async () => {
    const waiting = await customer('Waiting');
    const answered = await customer('Answered');
    await inbound(waiting, 'Synthetic: are you coming Tuesday?', 30);
    await inbound(answered, 'Synthetic: thanks for the visit', 40);
    await outbound(answered, 'Synthetic: you are welcome', 20);

    const out = await executeCommsTool('get_unanswered_threads', {});
    expect(out.error).toBeUndefined();
    expect(out.total).toBe(1);
    expect(out.unanswered_threads).toHaveLength(1);
    expect(out.unanswered_threads[0]).toMatchObject({
      customer_id: waiting.id, customer: 'Waiting Fixture', last_message: 'Synthetic: are you coming Tuesday?',
    });
  });

  test('a canceled reply never reached the customer, so it does not count as an answer (#5943)', async () => {
    const cust = await customer('Canceled');
    await inbound(cust, 'Synthetic: can you reschedule?', 60);
    await outbound(cust, 'Synthetic: sure, how about Friday?', 30, { status: 'canceled' });

    const out = await executeCommsTool('get_unanswered_threads', {});
    expect(out.error).toBeUndefined();
    expect(out.unanswered_threads.map(t => t.customer_id)).toEqual([cust.id]);
  });

  test('a reply that was sent after a canceled one still answers the thread', async () => {
    const cust = await customer('Resent');
    await inbound(cust, 'Synthetic: can you reschedule?', 60);
    await outbound(cust, 'Synthetic: first try', 40, { status: 'canceled' });
    await outbound(cust, 'Synthetic: second try', 20, { status: 'sent' });

    const out = await executeCommsTool('get_unanswered_threads', {});
    expect(out.error).toBeUndefined();
    expect(out.total).toBe(0);
  });

  test('an outbound text sent BEFORE the inbound does not answer it, and an old inbound is outside the window', async () => {
    const early = await customer('Early');
    const old = await customer('Old');
    await outbound(early, 'Synthetic: earlier text', 90);
    await inbound(early, 'Synthetic: a later question', 30);
    await inbound(old, 'Synthetic: a very old question', 60 * 24 * 10);

    const out = await executeCommsTool('get_unanswered_threads', { hours_back: 48 });
    expect(out.error).toBeUndefined();
    expect(out.unanswered_threads.map(t => t.customer_id)).toEqual([early.id]);
  });
});
