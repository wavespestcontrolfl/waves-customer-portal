/**
 * Audit repro r1-sched-visits-2: a technician-role token can rain-out
 * (move + text) a stop assigned to ANOTHER technician via the admin-dispatch
 * twin, while the tech-portal twin refuses the same request with 403.
 *
 * Real requireTechOrAdmin runs; only adminAuthenticate is stubbed to inject
 * a technician-role identity (tech-1). rain-out.commit is spied so no move /
 * SMS side effect runs — reaching commit() at all is the defect.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-1', role: 'technician' };
      req.technicianId = 'tech-1';
      req.techRole = 'technician';
      return next();
    },
  };
});
const mockCommit = jest.fn(async () => ({ ok: true, results: [], qualityDates: [] }));
jest.mock('../services/rain-out', () => ({
  commit: (...a) => mockCommit(...a),
  getOptions: jest.fn(async () => ({ ok: true })),
  previewMovedSms: jest.fn(async () => ({ ok: true })),
  checkTarget: jest.fn(async () => ({ ok: true })),
}));
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
      whereNot() { return builder; }, whereNotIn() { return builder; }, whereIn() { return builder; },
      whereNull() { return builder; }, modify(cb) { cb(builder); return builder; },
      leftJoin() { return builder; }, forUpdate() { return builder; }, orderBy() { return builder; },
      select() { return builder; },
      async first() {
        const rows = table === 'scheduled_services' ? state.scheduledServices : [];
        const found = rows.find((r) => Object.entries(builder._where).every(([k, v]) => r[k] === v));
        return found ? { ...found } : undefined;
      },
      async update(u) { state.writes.push({ table, op: 'update', u }); return 0; },
      async insert(r) { state.writes.push({ table, op: 'insert', r }); return [1]; },
      async del() { state.writes.push({ table, op: 'del' }); return 0; },
    };
    return builder;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => { const trx = (t) => dbFn(t); trx.raw = async () => ({}); return cb(trx); };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const dispatchRouter = require('../routes/admin-dispatch');
const techTrackRouter = require('../routes/tech-track');

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use('/api/tech/services', techTrackRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

const etToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tomorrow = (() => { const d = new Date(`${etToday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

beforeEach(() => {
  db.__state.scheduledServices = [
    // Assigned to tech-2 — NOT the requesting technician (tech-1).
    { id: 'svc-other', technician_id: 'tech-2', customer_id: 'cust-9', status: 'scheduled', scheduled_date: etToday, service_type: 'Pest Control' },
  ];
  mockCommit.mockClear();
});

const body = { reasonCode: 'weather_rain', scope: 'route', target: { date: tomorrow, window: { start: '09:00', end: '10:00' } } };
async function post(path) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('tech-portal twin refuses a technician acting on another tech\'s stop (control)', async () => {
  const r = await post('/api/tech/services/svc-other/rain-out');
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/not assigned/i);
  expect(mockCommit).not.toHaveBeenCalled();
});

test('admin-dispatch twin lets the same technician token reach RainOut.commit for another tech\'s route (BUG)', async () => {
  const r = await post('/api/admin/dispatch/svc-other/rain-out');
  // Expected (per tech-track / completionOwnershipError contract): 403 or 404, commit never reached.
  expect(mockCommit).not.toHaveBeenCalled();
  expect([403, 404]).toContain(r.status);
});

test('detail: what admin-dispatch actually passes to commit for a technician caller', async () => {
  const r = await post('/api/admin/dispatch/svc-other/rain-out');
  // Documentation of the observed behaviour (not the desired one).
   
  console.log('OBSERVED status', r.status, 'commit calls', mockCommit.mock.calls.length, JSON.stringify(mockCommit.mock.calls[0]?.[0] || null));
});
