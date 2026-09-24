/**
 * codex round-1 P1 on PR #4673 — PUT /:serviceId/status decided ownership
 * from the pre-transaction `svc` snapshot only. If the visit is reassigned
 * to another technician between that read and the write transaction (e.g.
 * a dispatcher's assignDispatchJob landing mid-flight), the status CAS
 * itself doesn't care who owns the row — it keys on fromStatus — so the
 * FORMER technician's transition still committed against the newly
 * reassigned visit.
 *
 * Fixed: every ordinary technician transition now re-verifies assignment
 * under the SAME row lock (FOR UPDATE) the field-confirm special case
 * already used only for itself, before transitionJobStatus ever runs.
 *
 * Race is modeled deterministically: db.transaction() mutates the
 * underlying row (simulating a concurrent reassignment) immediately before
 * invoking its callback, so the transaction's locked re-read observes the
 * NEW assignment while the route's initial (pre-transaction) read saw the
 * OLD one.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-A', role: 'technician' };
      req.technicianId = 'tech-A';
      req.techRole = 'technician';
      return next();
    },
  };
});
const mockTransitionJobStatus = jest.fn().mockResolvedValue({ ok: true, adminPayload: null });
jest.mock('../services/job-status', () => {
  const actual = jest.requireActual('../services/job-status');
  return { ...actual, transitionJobStatus: (...a) => mockTransitionJobStatus(...a) };
});

jest.mock('../models/db', () => {
  const state = { scheduledServices: [], writes: [], reassignOnTransaction: false, reassignedTo: null };
  const dbFn = (table) => {
    const builder = {
      _where: {},
      where(w, op, val) {
        if (w && typeof w === 'object') Object.assign(builder._where, w);
        else if (val === undefined) builder._where[String(w).replace(/^scheduled_services\./, '')] = op;
        return builder;
      },
      andWhere(...a) { return builder.where(...a); },
      whereNot() { return builder; },
      whereNotIn() { return builder; },
      whereIn() { return builder; },
      whereNull() { return builder; },
      whereRaw() { return builder; },
      modify(cb) { cb(builder); return builder; },
      leftJoin() { return builder; },
      forUpdate() { return builder; },
      orderBy() { return builder; },
      select() { return builder; },
      returning() { return builder; },
      async first() {
        const rows = table === 'scheduled_services' ? state.scheduledServices : [];
        const found = rows.find((r) => Object.entries(builder._where).every(([k, v]) => r[k] === v));
        return found ? { ...found } : undefined;
      },
      then(resolve, reject) {
        return Promise.resolve(builder._lastResult ?? []).then(resolve, reject);
      },
      update(u) {
        const rows = table === 'scheduled_services' ? state.scheduledServices : [];
        const hits = rows.filter((r) => Object.entries(builder._where).every(([k, v]) => r[k] === v));
        state.writes.push({ table, op: 'update', where: { ...builder._where }, u, hit: hits.map((r) => r.id) });
        hits.forEach((r) => Object.assign(r, u));
        builder._lastResult = hits.map((r) => ({ ...r, ...u }));
        return builder;
      },
      async insert(r) { state.writes.push({ table, op: 'insert', r }); return [1]; },
      async del() { state.writes.push({ table, op: 'del' }); return 0; },
    };
    return builder;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => {
    state.writes.push({ table: '<trx>', op: 'transaction' });
    // Simulate the concurrent reassignment landing between the route's
    // pre-transaction read and this transaction's own locked read.
    if (state.reassignOnTransaction) {
      const row = state.scheduledServices.find((r) => r.id === 'svc-1');
      if (row) row.technician_id = state.reassignedTo;
    }
    const trx = (table) => dbFn(table);
    trx.raw = async () => ({});
    return cb(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const dispatchRouter = require('../routes/admin-dispatch');
const { etDateString } = require('../utils/datetime-et');

let server;
let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  mockTransitionJobStatus.mockClear();
  const today = etDateString(new Date());
  db.__state.scheduledServices = [
    // Owned by tech-A at the time of the route's initial read.
    { id: 'svc-1', technician_id: 'tech-A', customer_id: 'cust-1', status: 'confirmed', scheduled_date: today, service_type: 'Pest Control', source_action: null, customer_confirmed: true },
  ];
  db.__state.writes = [];
  db.__state.reassignOnTransaction = false;
  db.__state.reassignedTo = null;
});

async function put(id, body) {
  const res = await fetch(`${baseUrl}/api/admin/dispatch/${id}/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('a visit reassigned to another tech between the read and the write transaction refuses the FORMER tech with 403, no transition committed', async () => {
  db.__state.reassignOnTransaction = true;
  db.__state.reassignedTo = 'tech-B';
  const { status, body } = await put('svc-1', { status: 'en_route' });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  // The row really was reassigned (the lock's own read, not a stale cache).
  expect(db.__state.scheduledServices[0].technician_id).toBe('tech-B');
});

test('control: no reassignment in flight — the same technician transitions their own visit normally', async () => {
  const { status } = await put('svc-1', { status: 'en_route' });
  expect(status).toBe(200);
  expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
  expect(mockTransitionJobStatus.mock.calls[0][0]).toMatchObject({ jobId: 'svc-1', toStatus: 'en_route', transitionedBy: 'tech-A' });
});
