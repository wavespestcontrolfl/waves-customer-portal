/**
 * AUDIT REPRO r1-dispatch-2 — admin-dispatch per-visit mutation routes are
 * not technician-ownership-scoped.
 *
 * A role='technician' token (tech-A) acts on a visit assigned to tech-B via
 * PATCH /:serviceId/note and PUT /:serviceId/status. The expected contract
 * (services/technician-visit-scope.js header; admin-schedule PUT /:id/status
 * uses technicianCurrentVisitFilter) is 403/404 with zero writes. Current
 * behaviour: the note route writes tech-B's row and the status route passes
 * the lookup and enters its write transaction.
 *
 * db mock copied from tests/status-route-completed-refusal.test.js.
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
jest.mock('../models/db', () => {
  const state = { scheduledServices: [], writes: [] };
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
        // awaited without .first(): the note route awaits update().returning()
        return Promise.resolve(builder._lastResult ?? []).then(resolve, reject);
      },
      update(u) {
        const rows = table === 'scheduled_services' ? state.scheduledServices : [];
        const hits = rows.filter((r) => Object.entries(builder._where).every(([k, v]) => r[k] === v));
        state.writes.push({ table, op: 'update', where: { ...builder._where }, u, hit: hits.map((r) => r.id) });
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
  const today = new Date().toISOString().slice(0, 10);
  db.__state.scheduledServices = [
    // Assigned to ANOTHER technician than the caller (tech-A).
    { id: 'svc-B', technician_id: 'tech-B', customer_id: 'cust-1', status: 'confirmed', scheduled_date: today, service_type: 'Pest Control', notes: 'original' },
  ];
  db.__state.writes = [];
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: json };
}

test("technician token overwrites ANOTHER tech's visit notes via PATCH /:serviceId/note (expected 403/404, zero writes)", async () => {
  const { status, body } = await call('PATCH', '/api/admin/dispatch/svc-B/note', { notes: 'overwritten by tech-A' });
  const noteWrites = db.__state.writes.filter((w) => w.table === 'scheduled_services' && w.op === 'update');
  // Document current behaviour so the failure is legible:
   
  console.log('[repro] note route →', status, JSON.stringify(body), 'writes:', JSON.stringify(noteWrites));
  expect([403, 404]).toContain(status);
  expect(noteWrites).toHaveLength(0);
});

test("technician token's PUT /:serviceId/status on ANOTHER tech's visit is not rejected by ownership (expected 403/404 before any transaction)", async () => {
  const { status, body } = await call('PUT', '/api/admin/dispatch/svc-B/status', { status: 'no_show' });
  const enteredTrx = db.__state.writes.some((w) => w.table === '<trx>');
   
  console.log('[repro] status route →', status, JSON.stringify(body), 'enteredTransaction:', enteredTrx);
  expect([403, 404]).toContain(status);
  expect(enteredTrx).toBe(false);
});
