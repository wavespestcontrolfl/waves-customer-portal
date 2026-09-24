// AUDIT REPRO r1-sched-routes-3 (unit variant, merged with the sibling
// integration-style repro in admin-schedule-find-time-tech-authz.test.js) —
// a technician-role token could call POST /api/admin/schedule/find-time and
// receive (a) other technicians' route stops with customer names + times in
// insertion.after/before, (b) any customer's street address via customerId,
// and (c) any visit's street address via serviceId (the id leaked by (a)).
// Real router + real engine; only the DB, auth and geometry are mocked.
//
// Fixed behaviour asserted here: the router stays technician-reachable only
// for hint-mode requests tied to a visit/customer the technician currently
// services (technicianId forced to the caller) — every other technician
// request (no hint, no ownership anchor, or a non-owned anchor) is refused.
// This variant's `chain()` fake applies REAL equality filtering (not the
// original's fixed per-table row regardless of the query), which is
// load-bearing for exercising the ownership check for real.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-08-31T16:00:00Z');
  return {
    ...actual,
    etParts: (date) => actual.etParts(date || PINNED_NOW),
    etDateString: (date) => actual.etDateString(date || PINNED_NOW),
  };
});
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 0.5,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));
// Technician-role token (what admin-auth.js:56-57 sets for role='technician').
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => { req.techRole = 'technician'; req.technicianId = 't1'; next(); },
  };
});
jest.mock('../services/geocoder', () => ({
  geocodeAddress: jest.fn(),
  ensureCustomerGeocoded: jest.fn(),
  buildAddress: jest.requireActual('../services/geocoder').buildAddress,
}));

const express = require('express');
const db = require('../models/db');
const findTimeRouter = require('../routes/admin-schedule-find-time');

const ORIGINAL_DRIVE_GATE = process.env.GATE_DRIVE_TIME_CALIBRATION;
beforeAll(() => { delete process.env.GATE_DRIVE_TIME_CALIBRATION; });
afterAll(() => {
  if (ORIGINAL_DRIVE_GATE === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  else process.env.GATE_DRIVE_TIME_CALIBRATION = ORIGINAL_DRIVE_GATE;
});

// A real filterable table: `.where({col: val})` / `.where('t.col', val)`
// narrows the row set, `.whereNotIn` excludes, a 3-arg operator form (the
// technician-scope date cutoff) passes through unfiltered. `.first()` /
// `.select()` / awaiting the builder all read the current (possibly
// narrowed) row set — this is what makes the ownership check below a real
// test rather than always finding whatever row the table started with.
function table(rows) {
  let cur = rows.slice();
  const col = (name) => String(name).split('.').pop();
  const c = {};
  ['whereNotNull', 'whereNull', 'whereBetween', 'leftJoin', 'orderBy', 'orWhereRaw', 'andWhere']
    .forEach((m) => { c[m] = () => c; });
  c.where = (a, b, cVal) => {
    if (typeof a === 'function') { a(c); return c; }
    if (a && typeof a === 'object') {
      for (const [k, v] of Object.entries(a)) cur = cur.filter((r) => r[col(k)] === v);
    } else if (typeof a === 'string' && cVal === undefined) {
      cur = cur.filter((r) => r[col(a)] === b);
    } // 3-arg operator forms pass through unfiltered.
    return c;
  };
  c.whereIn = (colName, list) => { cur = cur.filter((r) => list.includes(r[col(colName)])); return c; };
  c.whereNotIn = (colName, list) => { cur = cur.filter((r) => !list.includes(r[col(colName)])); return c; };
  c.select = async () => cur;
  c.first = async () => cur[0] || null;
  c.then = (resolve, reject) => Promise.resolve(cur).then(resolve, reject);
  return c;
}

const FUTURE_DATE = '2026-09-01'; // Tuesday after the pinned ET now
const OTHER_TECH_STOP = {
  id: 'svc-other', scheduled_date: FUTURE_DATE, technician_id: 't2', customer_id: 'cust-othertech',
  window_start: '10:00', window_end: '11:00', service_type: 'pest',
  estimated_duration_minutes: 60, lat: 27.41, lng: -82.41,
  address_line1: '221B Baker Street', city: 'Sarasota', state: 'FL', zip: '34236',
  svc_lat: 27.41, svc_lng: -82.41, cust_lat: 27.41, cust_lng: -82.41,
  first_name: 'Othertech', last_name: 'Customer', city_: 'Venice',
};
const SELF_STOP = {
  id: 'svc-mine', scheduled_date: FUTURE_DATE, technician_id: 't1', customer_id: 'cust-mine',
  window_start: '08:00', window_end: '09:00', service_type: 'pest',
  estimated_duration_minutes: 60, lat: 27.40, lng: -82.40,
  address_line1: '1 Mine St', city: 'Sarasota', state: 'FL', zip: '34231',
  svc_lat: 27.40, svc_lng: -82.40, cust_lat: 27.40, cust_lng: -82.40,
  first_name: 'My', last_name: 'Customer',
};
const UNRELATED_CUSTOMER = {
  id: 'cust-unrelated', latitude: 27.42, longitude: -82.42,
  address_line1: '742 Evergreen Terrace', city: 'Bradenton', state: 'FL', zip: '34205', profile_label: null,
};
const MINE_CUSTOMER = {
  id: 'cust-mine', latitude: 27.40, longitude: -82.40,
  address_line1: '1 Mine St', city: 'Sarasota', state: 'FL', zip: '34231', profile_label: null,
};

beforeEach(() => {
  db.mockImplementation((tbl) => {
    if (tbl === 'technicians') return table([
      { id: 't1', name: 'Me', employment_status: 'active', field_dispatchable: true },
      { id: 't2', name: 'Other Tech', employment_status: 'active', field_dispatchable: true },
    ]);
    if (tbl === 'customers') return table([UNRELATED_CUSTOMER, MINE_CUSTOMER]);
    return table([OTHER_TECH_STOP, SELF_STOP]);
  });
});

let server; let baseUrl;
const ORIGINAL_HINTS_GATE = process.env.GATE_BEST_TIME_HINTS;
beforeAll((done) => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule/find-time', findTimeRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (ORIGINAL_HINTS_GATE === undefined) delete process.env.GATE_BEST_TIME_HINTS;
  else process.env.GATE_BEST_TIME_HINTS = ORIGINAL_HINTS_GATE;
  server.close(done);
});

function post(body) {
  return fetch(`${baseUrl}/api/admin/schedule/find-time`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('(a) technician token, non-hint mode: refused (403) regardless of anchor', async () => {
  const res = await post({ lat: 27.4, lng: -82.4, dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 100, durationMinutes: 15 });
  expect(res.status).toBe(403);
});

test('(a2) technician token, hint mode with no serviceId/customerId anchor: refused (403)', async () => {
  const res = await post({ hint: true, lat: 27.4, lng: -82.4, dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 100, durationMinutes: 15 });
  expect(res.status).toBe(403);
});

test('(b) technician token, hint mode, customerId of an unrelated customer: refused (404)', async () => {
  const res = await post({ hint: true, customerId: 'cust-unrelated', dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 1 });
  expect(res.status).toBe(404);
});

test('(c) technician token, hint mode, serviceId of another tech\'s visit (leaked as before_stop_id in (a)): refused (404), never the address', async () => {
  const res = await post({ hint: true, serviceId: 'svc-other', customerId: 'cust-othertech', dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 1 });
  expect(res.status).toBe(404);
  const body = await res.json().catch(() => ({}));
  expect(JSON.stringify(body)).not.toContain('221B Baker Street');
  expect(JSON.stringify(body)).not.toContain('cust-othertech');
});

test('(d) technician token, hint mode, serviceId of THEIR OWN visit: succeeds (200), scoped to their own route', async () => {
  const res = await post({
    hint: true, serviceId: 'svc-mine', customerId: 'cust-mine',
    // Even if the client asks for another tech's route, technicianId is
    // forced back to the caller server-side.
    technicianId: 't2',
    dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 100, durationMinutes: 15,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.target.address).toContain('1 Mine St');
  const otherTechSlots = (body.slots || []).filter((s) => s.technician && s.technician.id !== 't1');
  expect(otherTechSlots).toEqual([]);
  expect(JSON.stringify(body)).not.toContain('Other Tech');
  expect(JSON.stringify(body)).not.toContain('221B Baker Street');
});
