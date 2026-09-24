/**
 * ADMIN-BUG (audit repro r1-sched-routes-2): PUT /api/admin/schedule/:id/status
 * used to have no target-status allow-list. A TECHNICIAN token on its OWN
 * current visit could send { status: 'rescheduled' } (or 'pending' to
 * un-confirm), or any arbitrary string, and the route handed the value
 * straight to transitionJobStatus, which wrote it.
 *
 * Fixed: STATUS_ROUTE_ALLOWED_TARGETS rejects any status outside the
 * scheduled_services enum this route actually commits (confirmed, en_route,
 * on_site, skipped, no_show, cancelled, completed) with 400 before the
 * ownership-scoped row lookup even runs — 'pending' and 'rescheduled' are
 * not among them (un-confirming or hand-stamping a reschedule outside the
 * reschedule engine's side effects is not a supported transition here).
 *
 * transitionJobStatus is spied (real module otherwise) so the assertion is
 * on what the route COMMITS to the shared writer; the db fake only serves
 * the ownership lookups (same shape as admin-tech-role-scoping.test.js).
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
const mockTransitionJobStatus = jest.fn().mockResolvedValue({ ok: true, adminPayload: null });
jest.mock('../services/job-status', () => {
  const actual = jest.requireActual('../services/job-status');
  return { ...actual, transitionJobStatus: (...a) => mockTransitionJobStatus(...a) };
});

jest.mock('../models/db', () => {
  const state = { scheduledServices: [], writes: [] };
  const normCol = (c) => String(c).replace(/^scheduled_services\./, '');
  const cmp = (a, op, v) => (op === '>=' ? a >= v : op === '>' ? a > v : op === '<=' ? a <= v : op === '<' ? a < v : a === v);
  const dbFn = (table) => {
    const b = {
      _where: {}, _cmp: [], _notIn: [],
      where(w, op, val) {
        if (typeof w === 'function') { w.call(b); return b; }
        if (w && typeof w === 'object') Object.assign(b._where, w);
        else if (val !== undefined) b._cmp.push([w, op, val]);
        else b._where[w] = op;
        return b;
      },
      andWhere(...a) { return b.where(...a); },
      whereNot(col, val) { b._notIn.push([col, [val]]); return b; },
      whereNotIn(col, vals) { b._notIn.push([col, vals]); return b; },
      whereIn() { return b; }, whereNull() { return b; }, whereNotNull() { return b; },
      whereRaw() { return b; }, orWhere() { return b; },
      modify(cb) { cb(b); return b; },
      leftJoin() { return b; }, forUpdate() { return b; }, orderBy() { return b; }, select() { return b; },
      async first() {
        const rows = table === 'scheduled_services' ? state.scheduledServices : [];
        const found = rows.find((r) =>
          Object.entries(b._where).every(([k, v]) => r[normCol(k)] === v)
          && b._cmp.every(([c, op, v]) => cmp(r[normCol(c)], op, v))
          && b._notIn.every(([c, vals]) => !vals.includes(r[normCol(c)])));
        return found ? { ...found } : undefined;
      },
      async update(u) { state.writes.push({ table, op: 'update', u }); return 1; },
      async insert(r) { state.writes.push({ table, op: 'insert', r }); return [1]; },
      async del() { state.writes.push({ table, op: 'del' }); return 0; },
      then(res, rej) { return Promise.resolve([]).then(res, rej); },
    };
    return b;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => {
    const trx = (table) => dbFn(table);
    trx.raw = async () => ({});
    trx.fn = dbFn.fn;
    return cb(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');
const scheduleRouter = require('../routes/admin-schedule');

const daysFromNow = (n) => etDateString(addETDays(new Date(), n));

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

async function put(path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}

beforeEach(() => {
  mockTransitionJobStatus.mockClear();
  db.__state.writes = [];
  db.__state.scheduledServices = [
    { id: 'svc-own-confirmed', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: daysFromNow(3), source_action: null, customer_confirmed: true },
    { id: 'svc-own-pending', technician_id: 'tech-1', customer_id: 'cust-2', status: 'pending', scheduled_date: daysFromNow(3), source_action: null },
  ];
});

test("technician's OWN confirmed visit — 'rescheduled' is rejected before it ever reaches the writer", async () => {
  const { status, body } = await put('/api/admin/schedule/svc-own-confirmed/status', { status: 'rescheduled' });
  expect(status).toBe(400);
  expect(body).toEqual({ error: "Invalid status 'rescheduled'", code: 'invalid_status' });
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

test("technician's OWN confirmed visit — 'pending' (un-confirm) is rejected", async () => {
  const { status, body } = await put('/api/admin/schedule/svc-own-confirmed/status', { status: 'pending' });
  expect(status).toBe(400);
  expect(body).toEqual({ error: "Invalid status 'pending'", code: 'invalid_status' });
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

test("an arbitrary string ('foo') is rejected — the allow-list is a closed set, not a passthrough", async () => {
  const { status, body } = await put('/api/admin/schedule/svc-own-pending/status', { status: 'foo' });
  expect(status).toBe(400);
  expect(body).toEqual({ error: "Invalid status 'foo'", code: 'invalid_status' });
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

test("a legitimate target ('confirmed') on the technician's OWN visit still works", async () => {
  const { status } = await put('/api/admin/schedule/svc-own-pending/status', { status: 'confirmed' });
  expect(status).toBe(200);
  expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
  expect(mockTransitionJobStatus.mock.calls[0][0]).toMatchObject({
    jobId: 'svc-own-pending', fromStatus: 'pending', toStatus: 'confirmed', transitionedBy: 'tech-1',
  });
});
