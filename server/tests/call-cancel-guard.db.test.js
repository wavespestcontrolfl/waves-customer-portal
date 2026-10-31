/**
 * GATE_CALL_CANCEL_GUARD through PostgreSQL (owner 2026-10-30). A new lead agreed a visit on a 12:52 AM call that did
 * not book, canceled on a 7:08 AM call while nothing was booked, and the office booked her at 11:22 from New
 * Appointment, which showed nothing about the cancel. Pinned here, with real queries inside a rolled-back transaction:
 * the notice answers the customer's latest real conversation when its newest cancel card still stands, and the route
 * answers {enabled:false} with the gate off. Synthetic names and numbers only. Skips without DATABASE_URL.
 */
const SKIP = !process.env.DATABASE_URL;

jest.setTimeout(60000);
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = null;
    req.techRole = 'admin';
    next();
  },
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const { latestCancelCall } = require('../services/call-cancel-guard');

const GATE = 'GATE_CALL_CANCEL_GUARD';
const describeDb = SKIP ? describe.skip : describe;
const NOW = new Date('2026-10-30T15:30:00Z');
const at = (iso) => new Date(iso);

describeDb('call cancel guard (PostgreSQL)', () => {
  let database; let trx; let server; let base;
  const savedGate = process.env[GATE];

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/admin/schedule', require('../routes/admin-schedule'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
    if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
  });
  beforeEach(async () => {
    process.env[GATE] = 'true';
    trx = await database.transaction();
    mockConn = trx;
  });
  afterEach(async () => { await trx.rollback(); });

  let seq = 0;
  async function customer() {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Pat', last_name: 'Sampleton', phone: `+1941555${String(4000 + (seq += 1))}` });
    return id;
  }
  async function call(customerId, createdAt, over = {}) {
    const id = randomUUID();
    await trx('call_log').insert({
      id, customer_id: customerId, twilio_call_sid: `CA${id.replace(/-/g, '')}`, from_phone: '+19415550101',
      processing_status: 'processed', review_status: 'open', created_at: at(createdAt), direction: 'inbound',
      metadata: JSON.stringify({ stir_verstat: 'TN-Validation-Passed-A' }),
      ai_extraction_enriched: JSON.stringify({ service_request: { primary_service_category: 'pest_general' } }), ...over,
    });
    return id;
  }
  async function card(callLogId, reasonCode, over = {}) {
    const [row] = await trx('triage_items').insert({
      call_log_id: callLogId, category: 'time_ambiguous', reason_code: reasonCode, status: 'open',
      summary: reasonCode === 'cancellation_request' ? 'Pat called to cancel the visit for this afternoon.' : 'The agreed day needs review.',
      ...over,
    }).returning('*');
    return row;
  }
  // The 10-30 shape: a 12:52 AM booking ask, then a 7:08 AM cancel.
  async function canceledLead() {
    const customerId = await customer();
    const askCall = await call(customerId, '2026-10-30T04:52:00Z');
    const ask = await card(askCall, 'ambiguous_scheduling');
    const cancelCall = await call(customerId, '2026-10-30T11:08:00Z');
    const cancel = await card(cancelCall, 'cancellation_request');
    return { customerId, askCall, ask, cancelCall, cancel };
  }

  describe('the New Appointment notice', () => {
    test('the latest processed call was the cancel: its time and the card summary', async () => {
      const { customerId, cancelCall } = await canceledLead();
      expect(await latestCancelCall(customerId, { now: NOW })).toEqual({
        callId: cancelCall, at: '2026-10-30T11:08:00.000Z', summary: 'Pat called to cancel the visit for this afternoon.',
      });
    });

    test('a later real conversation hides it; later voicemails and spam do not, even when marked processed', async () => {
      const { customerId } = await canceledLead();
      await call(customerId, '2026-10-30T12:00:00Z', { processing_status: 'voicemail' });
      await call(customerId, '2026-10-30T12:10:00Z', { answered_by: 'voicemail' });
      await call(customerId, '2026-10-30T12:20:00Z', { ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: true } }) });
      await call(customerId, '2026-10-30T12:30:00Z', { ai_extraction_enriched: JSON.stringify({ spam_verdict: { spam_kind: 'robocall' } }) });
      expect(await latestCancelCall(customerId, { now: NOW })).not.toBeNull();
      await call(customerId, '2026-10-30T13:00:00Z');
      expect(await latestCancelCall(customerId, { now: NOW })).toBeNull();
    });

    test('a dismissed cancel card shows nothing', async () => {
      const { customerId, cancel } = await canceledLead();
      await trx('triage_items').where({ id: cancel.id }).update({ status: 'dismissed' });
      expect(await latestCancelCall(customerId, { now: NOW })).toBeNull();
    });

    test('the newest cancel card decides: an older resolved one does not outweigh a newer dismissal', async () => {
      const { customerId, cancelCall, cancel } = await canceledLead();
      await trx('triage_items').where({ id: cancel.id }).update({ status: 'resolved', created_at: at('2026-10-30T11:09:00Z') });
      const newer = await card(cancelCall, 'cancellation_request', { status: 'dismissed', created_at: at('2026-10-30T11:30:00Z') });
      expect(await latestCancelCall(customerId, { now: NOW })).toBeNull();
      await trx('triage_items').where({ id: newer.id }).update({ status: 'resolved' });
      expect(await latestCancelCall(customerId, { now: NOW })).toMatchObject({ callId: cancelCall });
    });

    test('a cancel older than 14 days, or no cancel at all, shows nothing', async () => {
      const { customerId } = await canceledLead();
      expect(await latestCancelCall(customerId, { now: new Date('2026-11-14T12:00:00Z') })).toBeNull();
      const plain = await customer();
      await card(await call(plain, '2026-10-30T10:00:00Z'), 'not_confirmed');
      expect(await latestCancelCall(plain, { now: NOW })).toBeNull();
    });

    test('route: gate on answers the call, gate off answers {enabled:false}, a bad id is a 400', async () => {
      const customerId = await customer();
      const cancelCall = await call(customerId, new Date(Date.now() - 3600 * 1000).toISOString());
      await card(cancelCall, 'cancellation_request');
      const get = async (q) => { const r = await fetch(`${base}/admin/schedule/cancel-call-notice${q}`); return { status: r.status, body: await r.json() }; };
      const on = await get(`?customerId=${customerId}`);
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({ enabled: true, call: { callId: cancelCall } });
      expect((await get('?customerId=nope')).status).toBe(400);
      delete process.env[GATE];
      expect((await get(`?customerId=${customerId}`)).body).toEqual({ enabled: false, call: null });
    });
  });

});
