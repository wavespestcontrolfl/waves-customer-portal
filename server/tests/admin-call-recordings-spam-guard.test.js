// Spam disposition guard — a number that belongs to a LIVE customer must never
// be hard-blocked from the call dropdown, and sms_log (the A2P/consent audit
// trail) must survive a legitimate spam block.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-call-recordings');

function chain(result) {
  const q = {};
  const self = () => q;
  for (const m of ['where', 'whereNull', 'whereRaw', 'orWhereRaw', 'leftJoin', 'select', 'onConflict', 'ignore', 'update']) q[m] = jest.fn(self);
  const resolve = () => (typeof result === 'function' ? result() : result);
  q.first = jest.fn(async () => resolve());
  q.limit = jest.fn(async () => { const r = resolve(); return r ? [r] : []; });
  q.del = jest.fn(async () => 1);
  q.insert = jest.fn(() => q);
  q.columnInfo = jest.fn(async () => ({ disposition: {} }));
  q.catch = jest.fn(async () => null);
  q.then = undefined;
  return q;
}

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/call-recordings', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return fn(baseUrl).finally(() => new Promise((r) => server.close(r)));
}

function setup({ call, linkedCustomer = null, phoneCustomer = null }) {
  const tables = {};
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.mockImplementation((table) => {
    const q = chain(
      table === 'call_log' ? call
        : table === 'customers' ? () => (q.where.mock.calls.some((c) => c[0] && c[0].id) ? linkedCustomer : phoneCustomer)
        : null,
    );
    // customers chain: first() resolves linked when .where({id}) was used, else phone match
    tables[table] = tables[table] || [];
    tables[table].push(q);
    return q;
  });
  return tables;
}

const CALL_ID = '11111111-1111-4111-8111-111111111111';
const CALL_SID = 'CA' + 'a'.repeat(32);
const CALL = { id: CALL_ID, twilio_call_sid: CALL_SID, direction: 'inbound', from_phone: '+19415551234', customer_id: null };

describe('PUT /calls/:id/disposition spam guard & validation (C2-29)', () => {
  beforeEach(() => {
    db.mockReset();
    jest.clearAllMocks();
  });

  test('refuses 400 on invalid disposition or malformed call id', async () => {
    const tables = setup({ call: CALL });
    await withServer(async (base) => {
      const badDisp = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'bogus' }),
      });
      expect(badDisp.status).toBe(400);

      const badId = await fetch(`${base}/admin/call-recordings/calls/not-a-uuid-or-sid/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'spam' }),
      });
      expect(badId.status).toBe(400);
    });
    expect(tables.blocked_numbers).toBeUndefined();
  });

  test('looks up CallSid via twilio_call_sid without triggering UUID lookup', async () => {
    const tables = setup({ call: CALL });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_SID}/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'spam' }),
      });
      expect(res.status).toBe(200);
    });
    expect(tables.call_log.some((q) => q.where.mock.calls.some((c) => c[0]?.twilio_call_sid === CALL_SID))).toBe(true);
  });

  test('refuses 409 when the call is linked to a live customer; nothing blocked or deleted', async () => {
    const tables = setup({ call: { ...CALL, customer_id: 'cust-1' }, linkedCustomer: { id: 'cust-1', first_name: 'Pat', last_name: 'Lee' } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'spam' }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('CUSTOMER_NUMBER');
      expect(body.customer_name).toBe('Pat Lee');
    });
    expect(tables.blocked_numbers).toBeUndefined();
    expect(tables.sms_log).toBeUndefined();
    for (const q of tables.call_log) expect(q.del).not.toHaveBeenCalled();
  });

  test('refuses 409 when an unlinked call matches a live customer phone', async () => {
    const tables = setup({ call: CALL, phoneCustomer: { id: 'cust-2', first_name: 'Sam', last_name: null } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'spam' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).customer_name).toBe('Sam');
    });
    expect(tables.blocked_numbers).toBeUndefined();
  });

  test('refuses 409 on an unlinked OUTBOUND row (from_phone is our own number)', async () => {
    const tables = setup({ call: { ...CALL, direction: 'outbound', from_phone: '+19415550000', to_phone: '+19415551234' } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'spam' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('NOT_INBOUND_CALL');
    });
    expect(tables.blocked_numbers).toBeUndefined();
    expect(tables.customers).toBeUndefined();
    for (const q of tables.call_log) expect(q.del).not.toHaveBeenCalled();
  });

  test('refuses 409 when direction is missing/unknown (fail closed)', async () => {
    for (const direction of [null, '', 'legacy']) {
      const tables = setup({ call: { ...CALL, direction } });
      await withServer(async (base) => {
        const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/disposition`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'spam' }),
        });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('NOT_INBOUND_CALL');
      });
      expect(tables.blocked_numbers).toBeUndefined();
    }
  });

  test('phone lookup covers every pipeline identity column (service-contact slots + secondary)', async () => {
    const tables = setup({ call: CALL, phoneCustomer: { id: 'cust-3', first_name: 'Tenant', last_name: 'Two' } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'spam' }),
      });
      expect(res.status).toBe(409);
    });
    const sql = tables.customers.flatMap((q) => q.whereRaw.mock.calls.map((c) => c[0])).join(' ');
    for (const col of ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone', 'secondary_phone']) {
      expect(sql).toContain(`COALESCE(${col}, '')`);
    }
  });

  test('true spam: blocks + soft-marks the call row (never hard-deletes or logs raw phone PII)', async () => {
    const logger = require('../services/logger');
    const tables = setup({ call: CALL });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'spam' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, disposition: 'spam', blocked: true });
    });
    expect(tables.blocked_numbers).toHaveLength(1);
    expect(tables.blocked_numbers[0].insert).toHaveBeenCalledWith(expect.objectContaining({ number: '+19415551234', block_type: 'hard_block' }));
    expect(tables.call_log.some((q) => q.del.mock.calls.length > 0)).toBe(false);
    expect(tables.call_log.some((q) => q.update.mock.calls.some((c) => (
      c[0]?.disposition === 'spam'
      && c[0]?.processing_status === 'spam'
      && c[0]?.invalid_reason === 'spam'
      && c[0]?.processing_token === null
      && c[0]?.processing_generation?.__raw === 'COALESCE(processing_generation, 0) + 1'
    )))).toBe(true);
    expect(tables.call_live_utterances).toBeUndefined();
    expect(tables.sms_log).toBeUndefined();
    const logLines = logger.info.mock.calls.map((c) => c[0]).join(' ');
    expect(logLines).toContain('***1234');
    expect(logLines).not.toContain('+19415551234');
  });

  test('non-spam outbound disposition preserves outbound_call direction and uses transcription column', async () => {
    const tables = setup({
      call: {
        ...CALL,
        direction: 'outbound',
        customer_id: 'cust-9',
        transcription: 'Agent: Confirming Thursday visit.',
      },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/disposition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'existing_service_q' }),
      });
      expect(res.status).toBe(200);
    });
    expect(tables.customer_interactions).toHaveLength(1);
    expect(tables.customer_interactions[0].insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'cust-9',
      interaction_type: 'outbound_call',
      body: 'Agent: Confirming Thursday visit.',
    }));
  });
});
