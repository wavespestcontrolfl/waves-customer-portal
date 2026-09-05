/**
 * PUT /:id/status { status: 'completed' } must be refused on BOTH generic
 * status routes (admin-dispatch + admin-schedule): only POST /complete mints
 * the service_records row + invoice, and Billing Recovery's leak query keys
 * on service_records — a bare status flip finished the visit as silent
 * unbilled work. Refusal happens before any write.
 *
 * admin-schedule additionally refuses { status: 'cancelled' }: the dispatch
 * status route is the one staff cancel writer (scope + follow-through), and
 * the schedule route's cancel branch was retired with no live caller.
 * admin-dispatch keeps accepting it (asserted here so the retirement can't
 * silently spread to the live writer).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'admin-1', role: 'admin' };
      req.technicianId = 'admin-1';
      req.techRole = 'admin';
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
      modify(cb) { cb(builder); return builder; },
      leftJoin() { return builder; },
      forUpdate() { return builder; },
      orderBy() { return builder; },
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
const scheduleRouter = require('../routes/admin-schedule');

let server;
let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use('/api/admin/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  const today = new Date().toISOString().slice(0, 10);
  db.__state.scheduledServices = [
    { id: 'svc-1', technician_id: 'tech-1', customer_id: 'cust-1', status: 'on_site', scheduled_date: today, service_type: 'Pest Control' },
  ];
  db.__state.writes = [];
});

async function put(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe.each([
  ['admin-dispatch', '/api/admin/dispatch/svc-1/status'],
  ['admin-schedule', '/api/admin/schedule/svc-1/status'],
])('%s PUT /:id/status', (_name, path) => {
  test("status 'completed' is refused with USE_COMPLETION_FLOW and zero writes", async () => {
    const { status, body } = await put(path, { status: 'completed' });
    expect(status).toBe(409);
    expect(body.code).toBe('USE_COMPLETION_FLOW');
    expect(body.error).toMatch(/completion flow/i);
    expect(db.__state.writes).toHaveLength(0);
  });

  test('a missing visit still 404s ahead of the refusal (no existence oracle change)', async () => {
    const { status } = await put(path.replace('svc-1', 'svc-nope'), { status: 'completed' });
    expect(status).toBe(404);
    expect(db.__state.writes).toHaveLength(0);
  });
});

test("admin-schedule PUT /:id/status refuses 'cancelled' with USE_DISPATCH_CANCEL and zero writes", async () => {
  const { status, body } = await put('/api/admin/schedule/svc-1/status', { status: 'cancelled' });
  expect(status).toBe(409);
  expect(body.code).toBe('USE_DISPATCH_CANCEL');
  expect(body.error).toMatch(/dispatch status route/i);
  expect(db.__state.writes).toHaveLength(0);
});

test("admin-dispatch PUT /:id/status still accepts 'cancelled' (the live cancel writer)", async () => {
  // This file's db mock is refusal-shaped (no persisted rows, no trx.fn), so
  // the dispatch cancel cannot complete here and the response status proves
  // nothing on its own (pre-push hook P1). What the retirement must not
  // change is observable regardless: the dispatch route is NOT refused
  // up front and reaches its write transaction — the exact thing the
  // schedule route above no longer does.
  const { status, body } = await put('/api/admin/dispatch/svc-1/status', { status: 'cancelled' });
  expect([404, 409]).not.toContain(status);
  expect(body.code).toBeUndefined();
  expect(db.__state.writes.some((w) => w.op === 'transaction')).toBe(true);
});
