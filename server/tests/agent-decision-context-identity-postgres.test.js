// AG-02: an Agent Review decision's context (texts, calls, the human reply the
// form prefills) and the training example saved from it keep one customer's
// history. Real migrated PostgreSQL, synthetic records, rolled back after every
// test. Runs in the DB-gated CI step or a local disposable database.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  requireAdmin: (_req, _res, next) => next(),
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'admin-1', name: 'Test Admin' };
    req.technicianId = 'admin-1';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const { randomUUID } = require('node:crypto');
const express = require('express');

postgres('agent decision context identity boundary (PostgreSQL)', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  let a;
  let b;
  const SHARED = '+19415550142';
  const t0 = new Date('2040-01-10T16:00:00Z');
  const at = (minutes) => new Date(t0.getTime() + minutes * 60000);

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', ''].includes(url.hostname)) throw new Error('Use a disposable local or CI database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    const app = express();
    app.use(express.json());
    app.use('/admin/agent-decisions', require('../routes/admin-agent-decisions'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/admin/agent-decisions`;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    a = randomUUID();
    b = randomUUID();
  });
  afterEach(async () => {
    await trx.rollback();
    require('../models/db').connection = database;
  });

  const customer = (id, first, phone, extra = {}) => trx('customers').insert({
    id, first_name: first, last_name: 'Synthetic', phone, email: `${id}@example.invalid`,
    address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, ...extra,
  });
  const sms = async (customerId, direction, body, minutes, over = {}) => {
    const id = randomUUID();
    await trx('sms_log').insert({
      id,
      customer_id: customerId,
      direction,
      from_phone: direction === 'inbound' ? SHARED : '+19415550100',
      to_phone: direction === 'inbound' ? '+19415550100' : SHARED,
      message_body: body,
      message_type: direction === 'outbound' ? 'manual' : 'conversational',
      status: direction === 'outbound' ? 'sent' : 'received',
      created_at: at(minutes),
      ...over,
    });
    return id;
  };
  const call = async (customerId, minutes) => {
    const id = randomUUID();
    await trx('call_log').insert({ id, customer_id: customerId, direction: 'inbound', from_phone: SHARED, to_phone: '+19415550100', created_at: at(minutes) });
    return id;
  };
  const decide = async (customerId, triggerId) => {
    const id = randomUUID();
    await trx('agent_decisions').insert({
      id, workflow: 'customer_sms_triage', agent_name: 'test-agent', decision_version: 'test',
      customer_id: customerId, sms_log_id: triggerId, source_channel: 'sms',
      input_snapshot: JSON.stringify({ sms: { body: 'Can you come Tuesday?' } }),
    });
    return id;
  };
  const readContext = async (decisionId) => {
    const res = await fetch(`${baseUrl}/${decisionId}/context`);
    expect(res.status).toBe(200);
    return (await res.json()).context;
  };
  const ids = (rows) => rows.map((row) => row.id);

  test('shared phone: B-linked texts, calls and B\'s later reply stay out of A\'s context; unlinked rows are omitted', async () => {
    await customer(a, 'Alex', SHARED);
    await customer(b, 'Blake', SHARED);
    const trigger = await sms(a, 'inbound', 'A asks for Tuesday', 0);
    const bInbound = await sms(b, 'inbound', 'B asks for Friday', 1);
    const bReply = await sms(b, 'outbound', 'B reply: Friday works', 2);
    const unlinked = await sms(null, 'inbound', 'unlinked on the shared phone', 3);
    const aReply = await sms(a, 'outbound', 'A reply: Tuesday works', 4);
    const aCall = await call(a, 5);
    const bCall = await call(b, 6);
    const unlinkedCall = await call(null, 7);
    const context = await readContext(await decide(a, trigger));

    expect(ids(context.smsThread).sort()).toEqual([trigger, aReply].sort());
    expect(ids(context.smsThread)).not.toContain(bInbound);
    expect(ids(context.smsThread)).not.toContain(bReply);
    expect(ids(context.smsThread)).not.toContain(unlinked);
    expect(context.actualHumanReply.id).toBe(aReply);
    expect(ids(context.calls)).toEqual([aCall]);
    expect(ids(context.calls)).not.toContain(bCall);
    expect(ids(context.calls)).not.toContain(unlinkedCall);
  });

  test('shared phone: with only B\'s reply after the trigger, no human reply is prefilled', async () => {
    await customer(a, 'Alex', SHARED);
    await customer(b, 'Blake', SHARED);
    const trigger = await sms(a, 'inbound', 'A asks for Tuesday', 0);
    await sms(b, 'outbound', 'B reply: Friday works', 2);
    const context = await readContext(await decide(a, trigger));
    expect(ids(context.smsThread)).toEqual([trigger]);
    expect(context.actualHumanReply).toBeFalsy();
  });

  test('shared phone: an unlinked trigger text still shows (matched by id) and A\'s later reply, not B\'s, is prefilled', async () => {
    await customer(a, 'Alex', SHARED);
    await customer(b, 'Blake', SHARED);
    const trigger = await sms(null, 'inbound', 'unlinked text under review', 0);
    const unlinkedOther = await sms(null, 'inbound', 'another unlinked text', 1);
    const bReply = await sms(b, 'outbound', 'B reply: Friday works', 2);
    const aReply = await sms(a, 'outbound', 'A reply: Tuesday works', 3);
    const context = await readContext(await decide(a, trigger));

    expect(ids(context.smsThread)).toEqual([trigger, aReply]);
    expect(context.smsThread[0].isTrigger).toBe(true);
    expect(ids(context.smsThread)).not.toContain(unlinkedOther);
    expect(ids(context.smsThread)).not.toContain(bReply);
    expect(context.actualHumanReply.id).toBe(aReply);
  });

  test('A alone has the phone: unlinked rows are included, rows linked to B (reassigned history) are not', async () => {
    await customer(a, 'Alex', SHARED);
    await customer(b, 'Blake', '+19415550177');
    const trigger = await sms(a, 'inbound', 'A asks for Tuesday', 0);
    const unlinkedReply = await sms(null, 'outbound', 'unlinked reply on A\'s phone', 2);
    const bReply = await sms(b, 'outbound', 'B reply from before the reassignment', 1);
    const unlinkedCall = await call(null, 3);
    const bCall = await call(b, 4);
    const context = await readContext(await decide(a, trigger));

    expect(ids(context.smsThread)).toEqual([trigger, unlinkedReply]);
    expect(ids(context.smsThread)).not.toContain(bReply);
    expect(context.actualHumanReply.id).toBe(unlinkedReply);
    expect(ids(context.calls)).toEqual([unlinkedCall]);
    expect(ids(context.calls)).not.toContain(bCall);
  });

  test('a deleted customer on the same phone does not make the number shared', async () => {
    await customer(a, 'Alex', SHARED);
    await customer(b, 'Blake', SHARED, { deleted_at: at(-60) });
    const trigger = await sms(a, 'inbound', 'A asks for Tuesday', 0);
    const unlinkedReply = await sms(null, 'outbound', 'unlinked reply', 1);
    const context = await readContext(await decide(a, trigger));
    expect(ids(context.smsThread)).toEqual([trigger, unlinkedReply]);
  });

  test('no known customer keeps phone-only behavior', async () => {
    await customer(b, 'Blake', SHARED);
    const trigger = await sms(null, 'inbound', 'unknown number asks', 0);
    const bReply = await sms(b, 'outbound', 'B-linked row on the same phone', 1);
    const unlinkedReply = await sms(null, 'outbound', 'unlinked row on the same phone', 2);
    const bCall = await call(b, 3);
    const unlinkedCall = await call(null, 4);
    const context = await readContext(await decide(null, trigger));

    expect(ids(context.smsThread)).toEqual([trigger, bReply, unlinkedReply]);
    expect(context.actualHumanReply.id).toBe(bReply);
    expect(ids(context.calls).sort()).toEqual([bCall, unlinkedCall].sort());
  });

  test('the saved training example carries none of B\'s texts or calls', async () => {
    await customer(a, 'Alex', SHARED);
    await customer(b, 'Blake', SHARED);
    const trigger = await sms(a, 'inbound', 'A asks for Tuesday', 0);
    const bReply = await sms(b, 'outbound', 'B reply: Friday works', 1);
    const aReply = await sms(a, 'outbound', 'A reply: Tuesday works', 2);
    const aCall = await call(a, 3);
    const bCall = await call(b, 4);
    const decisionId = await decide(a, trigger);
    const res = await fetch(`${baseUrl}/${decisionId}/reply-training`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replyVerdict: 'edited', finalReply: 'Tuesday works for us.', actualReply: 'A reply: Tuesday works' }),
    });
    expect(res.status).toBe(200);
    const saved = await trx('reply_training_examples').where({ source_agent_decision_id: decisionId }).first();
    const snapshot = saved.context_snapshot;

    expect(saved.customer_id).toBe(a);
    expect(ids(snapshot.smsThread).sort()).toEqual([trigger, aReply].sort());
    expect(ids(snapshot.smsThread)).not.toContain(bReply);
    expect(ids(snapshot.recentCalls)).toEqual([aCall]);
    expect(ids(snapshot.recentCalls)).not.toContain(bCall);
    expect(JSON.stringify(snapshot)).not.toContain('B reply');
  });
});
