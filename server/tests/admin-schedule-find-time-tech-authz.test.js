/**
 * AUDIT REPRO r1-sched-routes-3 — POST /api/admin/schedule/find-time was
 * technician-reachable with no scoping at all (router.use(adminAuthenticate,
 * requireTechOrAdmin) and the handler never read req.techRole /
 * req.technicianId). A technician token could receive (a) the whole
 * organisation's route: every slot carries insertion.after / .before /
 * after_name = '<other customer>' plus the other tech's id/name and stop
 * ids, and (b) any customer's or visit's full street address by id via
 * resolveFindTimeTarget.
 *
 * Fixed contract asserted here: the router stays technician-reachable ONLY
 * for hint-mode requests (the edit/reschedule pickers' advisory search) tied
 * to a visit or customer the technician currently services — technicianId
 * is then forced to the caller regardless of what was requested, so the
 * ranked search never walks another technician's route. Non-hint requests,
 * requests with no serviceId/customerId anchor, and requests for a visit or
 * customer the technician does NOT service are all refused (403/404).
 *
 * Harness: admin-auth stubbed to inject a technician identity
 * (requireTechOrAdmin stays REAL); geocoder stubbed (as in
 * tests/find-time-best-time-hints.test.js); the find-time ENGINE stays
 * REAL and runs over a chainable knex fake with real equality filtering
 * (technician_id / customer_id), two assignable techs, one visit+customer
 * owned by each.
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

// Chainable knex fake with REAL equality filtering (not just an id
// shortcut): every `.where({col: val})` / `.where('table.col', val)` call
// narrows the row set, `.whereNotIn` excludes, and a 3-arg operator form
// (e.g. the technician-scope date cutoff) is left unfiltered — the fixture
// dates are chosen to already satisfy it. This is load-bearing for the
// technician-ownership checks below, which run real `where` predicates
// against `scheduled_services` (technician_id / customer_id) that a
// looser "just match on id" fake would silently let through.
jest.mock('../models/db', () => {
  const tables = {
    technicians: [
      { id: 'tech-self', name: 'Self Tech', employment_status: 'active', field_dispatchable: true },
      { id: 'tech-other', name: 'Other Tech', employment_status: 'active', field_dispatchable: true },
    ],
    scheduled_services: [
      {
        id: 'svc-other-1', scheduled_date: mockFutureDate, technician_id: 'tech-other', customer_id: 'cust-other',
        window_start: '09:00', window_end: '10:00', service_type: 'Pest Control',
        estimated_duration_minutes: 60, lat: 27.45, lng: -82.45,
        address_line1: '99 Secret Ln', city: 'Bradenton', state: 'FL', zip: '34205',
        svc_lat: 27.45, svc_lng: -82.45, first_name: 'Olivia', last_name: 'Otherton',
        cust_lat: 27.45, cust_lng: -82.45,
      },
      {
        id: 'svc-self-1', scheduled_date: mockFutureDate, technician_id: 'tech-self', customer_id: 'cust-self',
        window_start: '11:00', window_end: '12:00', service_type: 'Pest Control',
        estimated_duration_minutes: 60, lat: 27.40, lng: -82.40,
        address_line1: '5 Self Ave', city: 'Sarasota', state: 'FL', zip: '34231',
        svc_lat: 27.40, svc_lng: -82.40, first_name: 'Sam', last_name: 'Selfington',
        cust_lat: 27.40, cust_lng: -82.40,
      },
    ],
    customers: [
      {
        id: 'cust-other', latitude: 27.45, longitude: -82.45,
        address_line1: '99 Secret Ln', city: 'Bradenton', state: 'FL', zip: '34205',
        profile_label: 'Otherton residence',
      },
      {
        id: 'cust-self', latitude: 27.40, longitude: -82.40,
        address_line1: '5 Self Ave', city: 'Sarasota', state: 'FL', zip: '34231',
        profile_label: 'Selfington residence',
      },
    ],
  };
  const col = (name) => String(name).split('.').pop();
  const dbFn = (table) => {
    let rows = (tables[table] || []).slice();
    const builder = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
        if (prop === 'catch') return (fn) => Promise.resolve(rows).catch(fn);
        if (prop === 'first') return () => Promise.resolve(rows[0] || null);
        if (prop === 'select') return () => Promise.resolve(rows);
        if (prop === 'where') {
          return (a, b, c) => {
            if (typeof a === 'function') { a(builder); return builder; }
            if (a && typeof a === 'object') {
              for (const [k, v] of Object.entries(a)) rows = rows.filter((r) => r[col(k)] === v);
            } else if (typeof a === 'string' && c === undefined) {
              rows = rows.filter((r) => r[col(a)] === b);
            } // 3-arg operator forms (e.g. scheduled_date >= cutoff) pass through unfiltered.
            return builder;
          };
        }
        if (prop === 'whereNotIn') {
          return (c2, list) => { rows = rows.filter((r) => !list.includes(r[col(c2)])); return builder; };
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
const ORIGINAL_HINTS_GATE = process.env.GATE_BEST_TIME_HINTS;
beforeAll((done) => {
  // Hint mode (what every test here exercises) is gated off by default;
  // the authz behaviour under test must hold with it on.
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule/find-time', findTimeRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => {
  if (ORIGINAL_HINTS_GATE === undefined) delete process.env.GATE_BEST_TIME_HINTS;
  else process.env.GATE_BEST_TIME_HINTS = ORIGINAL_HINTS_GATE;
  server.close(done);
});

function post(body) {
  return fetch(`${baseUrl}/api/admin/schedule/find-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A weekday well in the future so the same-day floor never applies.
const RANGE = { dateFrom: mockFutureDate, dateTo: mockFutureDate, durationMinutes: 15, topN: 100 };

describe('r1-sched-routes-3: find-time technician hint scoping (ADMIN-BUG-R07)', () => {
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

  test('(a) a technician-role coords search with no serviceId/customerId anchor is refused (403)', async () => {
    // No hint anchor to prove ownership against — hint mode still needs a
    // visit or customer the technician currently services.
    const res = await post({ ...RANGE, hint: true, lat: 27.4, lng: -82.4 });
    expect(res.status).toBe(403);
  });

  test('(b) a technician-role customerId lookup for a non-served customer is refused (404)', async () => {
    const res = await post({ ...RANGE, hint: true, customerId: 'cust-other', technicianId: 'tech-self' });
    expect(res.status).toBe(404);
  });

  test('(c) a technician-role serviceId lookup for ANOTHER tech\'s visit is refused (404), never the address', async () => {
    const res = await post({ ...RANGE, hint: true, serviceId: 'svc-other-1', customerId: 'cust-other', technicianId: 'tech-other' });
    expect(res.status).toBe(404);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toContain('99 Secret Ln');
    expect(JSON.stringify(body)).not.toContain('Otherton');
  });

  test('(d) a technician-role serviceId lookup for THEIR OWN visit succeeds (200), scoped to their own route', async () => {
    const res = await post({
      ...RANGE, hint: true, serviceId: 'svc-self-1', customerId: 'cust-self',
      // Even if the client (or an attacker) asks for another tech's route,
      // the server forces technicianId back to the caller.
      technicianId: 'tech-other',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target.address).toContain('5 Self Ave');
    // Forced to the caller's own id — the response never carries tech-other.
    const otherTechSlots = body.slots.filter((s) => s.technician && s.technician.id !== 'tech-self');
    expect(otherTechSlots).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('tech-other');
    expect(JSON.stringify(body)).not.toContain('Otherton');
    expect(JSON.stringify(body)).not.toContain('99 Secret Ln');
  });
});
