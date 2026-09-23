/**
 * AUDIT REPRO r1-sched-routes-3 — POST /api/admin/schedule/find-time is
 * technician-reachable (router.use(adminAuthenticate, requireTechOrAdmin),
 * admin-schedule-find-time.js:37) and the handler never reads
 * req.techRole / req.technicianId. A technician token therefore receives
 * (a) the whole organisation's route: every slot carries
 *     insertion.after / insertion.before / after_name = '<other customer>'
 *     plus the other tech's id/name and stop ids
 *     (services/scheduling/find-time.js:373, 458-465), and
 * (b) any customer's full street address by id via resolveFindTimeTarget
 *     (routes/admin-schedule-find-time.js:136-140, 178, 321).
 *
 * Expected contract asserted here (so this FAILS on current code if the bug
 * is real): per the scoping rule at routes/admin-schedule.js:335-345, a
 * technician token must never see another technician's customers' names or
 * a non-served customer's address — either the route refuses (403) or the
 * payload is scoped to the requesting tech and stripped of the address echo.
 *
 * Harness: admin-auth stubbed to inject a technician identity
 * (requireTechOrAdmin stays REAL); geocoder stubbed (as in
 * tests/find-time-best-time-hints.test.js); the find-time ENGINE stays
 * REAL and runs over a chainable knex fake that returns two assignable
 * techs, one stop for the OTHER tech's customer, and that customer's row.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockCurrentRole = 'technician';

// A weekday well in the future (never Sunday — the legacy engine skips
// Sundays outright) relative to the REAL clock, so this fixture never goes
// stale the way a fixed calendar date eventually does. Named with the
// `mock` prefix so babel-plugin-jest-hoist allows referencing it from
// inside the jest.mock('../models/db', ...) factory below.
function mockFutureWeekday(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
const mockFutureDate = mockFutureWeekday(14);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-self', role: mockCurrentRole };
      req.technicianId = 'tech-self';
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});
jest.mock('../services/geocoder', () => ({
  geocodeAddress: jest.fn(),
  ensureCustomerGeocoded: jest.fn(),
  buildAddress: jest.requireActual('../services/geocoder').buildAddress,
}));

// Chainable knex fake: every builder method returns the builder; awaiting
// it resolves the table's rows (filtered by an id where-clause when one was
// given); .first() resolves the first such row.
jest.mock('../models/db', () => {
  const tables = {
    technicians: [
      { id: 'tech-self', name: 'Self Tech', employment_status: 'active', field_dispatchable: true },
      { id: 'tech-other', name: 'Other Tech', employment_status: 'active', field_dispatchable: true },
    ],
    scheduled_services: [
      {
        id: 'svc-other-1', scheduled_date: mockFutureDate, technician_id: 'tech-other',
        window_start: '09:00', window_end: '10:00', service_type: 'Pest Control',
        estimated_duration_minutes: 60, svc_lat: 27.45, svc_lng: -82.45,
        first_name: 'Olivia', last_name: 'Otherton', city: 'Bradenton',
        cust_lat: 27.45, cust_lng: -82.45,
      },
    ],
    customers: [
      {
        id: 'cust-other', latitude: 27.45, longitude: -82.45,
        address_line1: '99 Secret Ln', city: 'Bradenton', state: 'FL', zip: '34205',
        profile_label: 'Otherton residence',
      },
    ],
  };
  const dbFn = (table) => {
    const state = { table, idFilter: undefined };
    const rows = () => {
      const all = tables[table] || [];
      return state.idFilter === undefined ? all : all.filter((r) => r.id === state.idFilter);
    };
    const builder = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
        if (prop === 'catch') return (fn) => Promise.resolve(rows()).catch(fn);
        if (prop === 'first') return () => Promise.resolve(rows()[0] || null);
        if (prop === 'where') {
          return (a, b, c) => {
            if (typeof a === 'function') { a(builder); return builder; }
            if (a && typeof a === 'object' && 'id' in a) state.idFilter = a.id;
            else if (typeof a === 'string' && /(^|\.)id$/.test(a)) state.idFilter = c === undefined ? b : c;
            return builder;
          };
        }
        return () => builder;
      },
    });
    return builder;
  };
  dbFn.raw = (sql) => ({ toString: () => sql, sql });
  dbFn.fn = { now: () => 'now()' };
  return dbFn;
});

const express = require('express');
const findTimeRouter = require('../routes/admin-schedule-find-time');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule/find-time', findTimeRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

function post(body) {
  return fetch(`${baseUrl}/api/admin/schedule/find-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A weekday well in the future so the same-day floor never applies.
const RANGE = { dateFrom: mockFutureDate, dateTo: mockFutureDate, durationMinutes: 15, topN: 100 };

describe('r1-sched-routes-3: find-time leaks other techs\' customers and any customer address to a technician token', () => {
  beforeEach(() => { mockCurrentRole = 'technician'; });

  test('CONTROL (passes today): an admin token gets the whole-org route with customer names', async () => {
    mockCurrentRole = 'admin';
    const res = await post({ ...RANGE, lat: 27.4, lng: -82.4 });
    expect(res.status).toBe(200);
    const body = await res.json();
    const techIds = new Set(body.slots.map((s) => s.technician.id));
    expect(techIds.has('tech-other')).toBe(true);
    expect(JSON.stringify(body.slots)).toContain('Olivia Otherton');
  });

  test('(a) a technician-role coords search must not expose other techs\' customers or routes', async () => {
    const res = await post({ ...RANGE, lat: 27.4, lng: -82.4 });
    const body = await res.json();
    // Expected: 403 (requireAdmin) OR a payload scoped to the caller.
    if (res.status === 200) {
      const otherTechSlots = body.slots.filter((s) => s.technician && s.technician.id !== 'tech-self');
      expect(otherTechSlots).toEqual([]);
      expect(JSON.stringify(body.slots)).not.toContain('Otherton');
      expect(JSON.stringify(body.slots)).not.toContain('svc-other-1');
    } else {
      expect(res.status).toBe(403);
    }
  });

  test('(b) a technician-role customerId lookup must not echo a non-served customer\'s street address', async () => {
    const res = await post({ ...RANGE, customerId: 'cust-other', technicianId: 'tech-self' });
    const body = await res.json();
    if (res.status === 200) {
      expect(body.target && body.target.address ? body.target.address : '').not.toContain('99 Secret Ln');
      expect(body.target && body.target.profileLabel).toBeFalsy();
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });
});
