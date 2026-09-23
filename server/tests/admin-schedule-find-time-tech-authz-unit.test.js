// AUDIT REPRO r1-sched-routes-3 (unit variant, merged with the sibling
// integration-style repro in admin-schedule-find-time-tech-authz.test.js) —
// a technician-role token could call POST /api/admin/schedule/find-time and
// receive (a) other technicians' route stops with customer names + times in
// insertion.after/before, (b) any customer's street address via customerId,
// and (c) any visit's street address via serviceId (the id leaked by (a)).
// Real router + real engine; only the DB, auth and geometry are mocked.
//
// Fixed behaviour asserted here: the router now locks the whole surface to
// requireAdmin (no technician caller exists anywhere in the repo), so every
// technician request gets 403 with no body. Assertions accept either that
// lockdown OR a scoped 200 payload, in case scoping is chosen later.
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

function chain(result, firstRow) {
  const c = {};
  ['whereNotNull', 'whereNull', 'where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'orWhereRaw', 'andWhere']
    .forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  c.first = async () => firstRow;
  c.then = (resolve) => resolve(result);
  return c;
}

const FUTURE_DATE = '2026-09-01'; // Tuesday after the pinned ET now
const OTHER_TECH_STOP = {
  id: 'svc-other', scheduled_date: FUTURE_DATE, technician_id: 't2',
  window_start: '10:00', window_end: '11:00', service_type: 'pest',
  estimated_duration_minutes: 60,
  svc_lat: 27.41, svc_lng: -82.41, cust_lat: 27.41, cust_lng: -82.41,
  first_name: 'Othertech', last_name: 'Customer', city: 'Venice',
};
const UNRELATED_CUSTOMER = {
  id: 'cust-unrelated', latitude: 27.42, longitude: -82.42,
  address_line1: '742 Evergreen Terrace', city: 'Bradenton', state: 'FL', zip: '34205', profile_label: null,
};

// What resolveFindTimeTarget's serviceId branch reads (serviceLocationSelects):
// the visit joined to its customer, address columns coalesced.
const OTHER_TECH_VISIT_ROW = {
  lat: 27.41, lng: -82.41, address_line1: '221B Baker Street', city: 'Sarasota', state: 'FL', zip: '34236',
  visit_customer_id: 'cust-othertech', visit_profile_label: 'Othertech home',
};

beforeEach(() => {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Me' }, { id: 't2', name: 'Other Tech' }]);
    if (table === 'customers') return chain([UNRELATED_CUSTOMER], UNRELATED_CUSTOMER);
    return chain([OTHER_TECH_STOP], OTHER_TECH_VISIT_ROW);
  });
});

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule/find-time', findTimeRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

function post(body) {
  return fetch(`${baseUrl}/api/admin/schedule/find-time`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('(a) technician token, no hint/serviceId: must not name another tech\'s customer stops', async () => {
  const res = await post({ lat: 27.4, lng: -82.4, dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 100, durationMinutes: 15 });
  if (res.status !== 200) {
    expect(res.status).toBe(403);
    return;
  }
  const body = await res.json();
  const leaks = body.slots.filter((s) => s.technician?.id === 't2'
    && (String(s.insertion?.after).includes('Othertech Customer') || String(s.insertion?.before).includes('Othertech Customer')));
  // Bug: a technician-role request should not be able to see t2's stops or names.
  expect(leaks.length).toBe(0);
});

test('(b) technician token, customerId of an unrelated customer: must not echo the street address', async () => {
  const res = await post({ customerId: 'cust-unrelated', dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 1 });
  if (res.status !== 200) {
    expect([403, 404]).toContain(res.status);
    return;
  }
  const body = await res.json();
  // Bug: target.address for a customer the tech does not serve should not be returned.
  expect(body.target?.address || '').not.toContain('742 Evergreen Terrace');
});

test('(c) technician token, serviceId of another tech\'s visit (leaked as before_stop_id in (a)): must not echo that visit\'s address', async () => {
  const res = await post({ serviceId: 'svc-other', dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 1 });
  if (res.status !== 200) {
    expect([403, 404]).toContain(res.status);
    return;
  }
  const body = await res.json();
  // Bug: no ownership predicate on the visit lookup (router:93-100), so any
  // stop id from (a) resolves to a street address + customer id.
  expect(body.target?.address || '').not.toContain('221B Baker Street');
  expect(body.target?.customerId).not.toBe('cust-othertech');
});
