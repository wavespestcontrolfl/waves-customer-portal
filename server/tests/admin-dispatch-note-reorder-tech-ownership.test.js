/**
 * ADMIN-BUG-R35 (audit repro r1-authz-3) — technician token wrote notes /
 * route_order on ANOTHER technician's visit through admin-dispatch, with no
 * ownership predicate on PATCH /:serviceId/note, PUT /:serviceId/reorder or
 * PUT /reorder/bulk.
 *
 * Contract (services/technician-visit-scope.js header): every per-visit
 * mutation from a technician token is scoped to the tech's OWN assigned
 * jobs. admin-dispatch's assertRecapOwnership (403) and admin-schedule's
 * technicianLiveVisitFilter (404) already implement it for their routes.
 *
 * Asserts the FIXED behaviour (completionOwnershipError inserted after each
 * bare-id load): 403/skip, zero writes to tech-B's row. Originally filed as
 * a same-file "documents the bug" test (200 + a write hitting tech-B's
 * row); flipped here to the expected contract post-fix. Mock db is
 * self-contained (pattern of tests/status-route-completed-refusal.test.js);
 * the real requireTechOrAdmin runs, only adminAuthenticate is stubbed.
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
const mockRefresh = jest.fn(async () => {});
jest.mock('../services/scheduling/quality-after-change', () => ({
  refreshScheduleQualityAfterChange: (...a) => mockRefresh(...a),
}));
jest.mock('../models/db', () => {
  const state = { scheduledServices: [], writes: [], locks: [] };
  const matches = (row, w) => Object.entries(w).every(([k, v]) => row[k] === v);
  const dbFn = (table) => {
    const b = {
      _where: {}, _in: null, _returning: null,
      where(w, op, val) {
        if (w && typeof w === 'object') Object.assign(b._where, w);
        else if (val === undefined) b._where[String(w).replace(/^scheduled_services\./, '')] = op;
        return b;
      },
      andWhere(...a) { return b.where(...a); },
      whereIn(col, vals) { b._in = { col, vals: vals.map(String) }; return b; },
      whereRaw() { return b; },
      whereNull() { return b; },
      whereNot() { return b; },
      whereNotIn() { return b; },
      modify(cb) { cb(b); return b; },
      select() { return b; },
      first(...cols) {
        const rows = b._rows();
        const r = rows[0];
        if (!r) return Promise.resolve(undefined);
        const out = { ...r, day: r.scheduled_date };
        return Promise.resolve(out);
      },
      _rows() {
        const rows = table === 'scheduled_services' ? state.scheduledServices : [];
        return rows.filter((r) => matches(r, b._where) && (!b._in || b._in.vals.includes(String(r[b._in.col]))));
      },
      update(u) {
        const hits = b._rows();
        state.writes.push({ table, op: 'update', where: { ...b._where }, u, hit: hits.map((r) => r.id) });
        hits.forEach((r) => Object.assign(r, u));
        b._updated = hits;
        return b;
      },
      returning(cols) { b._returning = cols; return b; },
      then(resolve, reject) {
        let out;
        if (b._updated) out = b._returning ? b._updated.map((r) => ({ ...r })) : b._updated.length;
        else out = b._rows().map((r) => ({ ...r, day: r.scheduled_date }));
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => {
    const trx = (table) => dbFn(table);
    trx.raw = async (sql, bindings) => { state.locks.push(bindings); return { rows: [] }; };
    return cb(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const dispatchRouter = require('../routes/admin-dispatch');

let server; let baseUrl;
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
    { id: 'svc-B1', technician_id: 'tech-B', customer_id: 'c1', status: 'confirmed', scheduled_date: today, route_order: 1, notes: 'Gate code 4471 — dog in yard, office: collect check' },
    { id: 'svc-B2', technician_id: 'tech-B', customer_id: 'c2', status: 'confirmed', scheduled_date: today, route_order: 2, notes: '' },
  ];
  db.__state.writes = [];
  db.__state.locks = [];
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
}

test("PATCH /:serviceId/note — tech-A is refused on tech-B's visit (403, no write)", async () => {
  const { status, body } = await call('PATCH', '/api/admin/dispatch/svc-B1/note', { notes: '' });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  const w = db.__state.writes.filter((x) => x.table === 'scheduled_services' && x.op === 'update');
  expect(w).toHaveLength(0);
  expect(db.__state.scheduledServices[0].notes).toBe('Gate code 4471 — dog in yard, office: collect check');
});

test("PUT /reorder/bulk — tech-A's items on tech-B's day are silently skipped (200, zero writes)", async () => {
  const { status, body } = await call('PUT', '/api/admin/dispatch/reorder/bulk', {
    order: [{ serviceId: 'svc-B1', routeOrder: 2 }, { serviceId: 'svc-B2', routeOrder: 1 }],
  });
  expect(status).toBe(200);
  expect(body).toEqual({ success: true });
  const w = db.__state.writes.filter((x) => x.table === 'scheduled_services' && x.op === 'update');
  expect(w).toHaveLength(0);
  // the tech-day lock is still taken up front (it fences the whole batch
  // before the per-row ownership check runs), but no route_order write lands
  expect(mockRefresh).not.toHaveBeenCalled();
});

test("PUT /:serviceId/reorder — tech-A is refused reordering a stop on tech-B's day (403, no write)", async () => {
  const { status, body } = await call('PUT', '/api/admin/dispatch/svc-B2/reorder', { routeOrder: 9 });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  const w = db.__state.writes.filter((x) => x.table === 'scheduled_services' && x.op === 'update');
  expect(w).toHaveLength(0);
});

test('control: recap route DOES enforce ownership for the same token (403)', async () => {
  const { status, body } = await call('POST', '/api/admin/dispatch/svc-B1/pest-recap/draft', { technicianNotes: 'x' });
  expect(status).toBe(403);
  expect(body.error).toMatch(/not assigned/i);
});
