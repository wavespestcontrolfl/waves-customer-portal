/**
 * Pre-push fallback audit on PR #4673 (P1): admin-schedule's PUT /:id/status
 * gained a closed target allow-list (r1-sched-routes-2) but the sibling
 * PUT /api/admin/dispatch/:serviceId/status did not — it handed 'pending' /
 * 'rescheduled' / any string to transitionJobStatus, subject only to the
 * terminal/day-of guards, so a technician refused on the schedule route
 * could un-confirm or hand-stamp a reschedule on their own visit here.
 *
 * Fixed: both routes read STATUS_ROUTE_ALLOWED_TARGETS from
 * services/job-status.js and refuse anything else with 400 invalid_status
 * before the row lookup, for every caller. 'completed' still passes the
 * list and reaches the route's own USE_COMPLETION_FLOW refusal.
 *
 * Mock shape copied from admin-schedule-status-target-whitelist.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const actor = { role: 'technician' };
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-1', role: actor.role };
      req.technicianId = 'tech-1';
      req.techRole = actor.role;
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
const dispatchRouter = require('../routes/admin-dispatch');

const daysFromNow = (n) => etDateString(addETDays(new Date(), n));

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
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
  actor.role = 'technician';
  mockTransitionJobStatus.mockClear();
  db.__state.writes = [];
  db.__state.scheduledServices = [
    { id: 'svc-own-confirmed', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: daysFromNow(0), source_action: null, customer_confirmed: true },
  ];
});

test.each(['rescheduled', 'pending', 'foo'])("technician's OWN visit — '%s' is refused with 400 before any lookup or write", async (target) => {
  const { status, body } = await put('/api/admin/dispatch/svc-own-confirmed/status', { status: target });
  expect(status).toBe(400);
  expect(body).toEqual({ error: `Invalid status '${target}'`, code: 'invalid_status' });
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  expect(db.__state.writes).toHaveLength(0);
});

test("an ADMIN gets the same refusal — the allow-list is a route contract, not a role gate", async () => {
  actor.role = 'admin';
  const { status, body } = await put('/api/admin/dispatch/svc-own-confirmed/status', { status: 'rescheduled' });
  expect(status).toBe(400);
  expect(body).toEqual({ error: "Invalid status 'rescheduled'", code: 'invalid_status' });
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
});

test("'completed' passes the allow-list and still lands on the route's own USE_COMPLETION_FLOW refusal", async () => {
  const { status, body } = await put('/api/admin/dispatch/svc-own-confirmed/status', { status: 'completed' });
  expect(status).toBe(409);
  expect(body.code).toBe('USE_COMPLETION_FLOW');
});

test('both status routes enforce the identical set', () => {
  const { STATUS_ROUTE_ALLOWED_TARGETS } = jest.requireActual('../services/job-status');
  expect([...STATUS_ROUTE_ALLOWED_TARGETS].sort()).toEqual(['cancelled', 'completed', 'confirmed', 'en_route', 'no_show', 'on_site', 'skipped']);
});
