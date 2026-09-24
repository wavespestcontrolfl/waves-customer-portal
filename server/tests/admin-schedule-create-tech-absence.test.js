/**
 * POST /api/admin/schedule (creation route) — recurring child/booster dates
 * are save-time eligibility checked too (tech-out P1).
 *
 * The parent insert already refuses when resolvedTechId is marked out on
 * the PARENT date (assertAssignableTechnician, services/technician-eligibility.js).
 * The recurring-child and booster loops that follow insert that SAME
 * technician_id on other dates with no check of their own — a tech who is
 * only out on a generated child/booster date, not the parent date, sailed
 * through. This mirrors the harness in admin-schedule-occupancy-gate.test.js
 * (same recurring plan: monthly from 2099-07-03, count 3, booster month 11
 * → children 2099-08-07 / 2099-09-04, booster 2099-11-03) and adds a
 * technician_absences table to the strict mock.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  assignDispatchJob: jest.fn(),
  emitDispatchJobUpdate: jest.fn(),
}));
jest.mock('../services/scheduling/occupancy', () => {
  const actual = jest.requireActual('../services/scheduling/occupancy');
  const mocked = {
    ...actual,
    acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
    findConflictingVisits: jest.fn().mockResolvedValue([]),
  };
  mocked.acquireOccupancyLocks = jest.fn(async (trx, dates) => {
    const sorted = [...new Set((dates || []).filter(Boolean).map((d) => String(d).split('T')[0]))].sort();
    for (const d of sorted) await mocked.acquireOccupancyLock(trx, d);
  });
  return mocked;
});
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
  withCustomerCommsLock: jest.fn(async (db, customerId, fn) => db.transaction(async (trx) => fn(trx))),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

const db = require('../models/db');
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
}));
const { acquireOccupancyLock, findConflictingVisits } = require('../services/scheduling/occupancy');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');
const { NOT_ASSIGNABLE } = require('../services/technician-eligibility');

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  scheduled_date: '2099-07-01',
  day: '2099-07-01',
  window_start: '09:00:00',
  window_end: '10:00:00',
  status: 'confirmed',
  technician_id: null,
  service_type: 'General Pest Control',
  estimated_duration_minutes: 60,
};

const TECH_ID = 'tech-1';
const ABSENCE_DATE = '2099-09-04'; // second generated child date, not the parent date

function chain(row) {
  const builder = {};
  const self = () => builder;
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit', 'select', 'forUpdate', 'forShare', 'returning', 'leftJoin', 'join', 'groupBy', 'distinct', 'andWhere', 'orWhere', 'modify', 'clone']) {
    builder[m] = jest.fn(self);
  }
  builder.first = jest.fn().mockResolvedValue(row);
  builder.pluck = jest.fn().mockResolvedValue([]);
  builder.count = jest.fn().mockResolvedValue([{ count: '0' }]);
  builder.update = jest.fn().mockResolvedValue(1);
  builder.insert = jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ ...SVC, id: 'new-1' }]), onConflict: jest.fn(() => ({ ignore: jest.fn().mockResolvedValue([]) })) }));
  builder.del = jest.fn().mockResolvedValue(0);
  builder.delete = jest.fn().mockResolvedValue(0);
  builder.columnInfo = jest.fn().mockResolvedValue({ source_action: {} });
  builder.then = (resolve, reject) => Promise.resolve(row === undefined ? [] : [row]).then(resolve, reject);
  return builder;
}

// technicians: a single active + field-dispatchable row, whatever the where().
function chainTechnician(techId) {
  return chain({ id: techId, name: 'Test Tech', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true });
}

// technician_absences: only a hit when where() named THIS tech + THIS date
// (mirrors the cadence-test pattern already in admin-schedule-occupancy-gate.test.js).
function chainTechAbsences(techId, absenceDate) {
  const c = chain(undefined);
  c.first = jest.fn(async () => {
    const wheres = c.where.mock.calls.map((args) => args[0]);
    const hit = wheres.some((w) => w && typeof w === 'object'
      && String(w.technician_id) === String(techId) && w.absence_date === absenceDate);
    return hit ? { id: 'absence-1' } : undefined;
  });
  return c;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

let trx;
let inserts;
beforeEach(() => {
  jest.clearAllMocks();
  inserts = [];
  findConflictingVisits.mockResolvedValue([]);
  acquireOccupancyLock.mockImplementation(async () => {});
  lockCustomerComms.mockImplementation(async () => {});
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null } : undefined)));
  trx = jest.fn((table) => {
    if (table === 'technicians') return chainTechnician(TECH_ID);
    if (table === 'technician_absences') return chainTechAbsences(TECH_ID, ABSENCE_DATE);
    const c = chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1' } : undefined));
    if (table === 'scheduled_services') {
      c.insert = jest.fn((data) => {
        inserts.push(data);
        return { returning: jest.fn().mockResolvedValue([{ ...SVC, ...data, id: `new-${inserts.length}` }]) };
      });
    }
    return c;
  });
  trx.raw = jest.fn(async (sql, bindings) => ({ sql, bindings, rows: [] }));
  trx.fn = { now: jest.fn(() => 'now()') };
  trx.transaction = jest.fn(async (cb) => cb(trx));
  trx.commit = jest.fn();
  trx.rollback = jest.fn();
  db.transaction = jest.fn(async (cb) => cb(trx));
});

async function post(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST / — admin create — recurring child/booster technician-absence check', () => {
  // Same recurring plan as admin-schedule-occupancy-gate.test.js's
  // "recurring create locks..." test: monthly from 2099-07-03, count 3,
  // booster month 11 → children 2099-08-07 / 2099-09-04, booster 2099-11-03.
  const recurringBody = {
    customerId: 'cust-1',
    scheduledDate: '2099-07-03',
    windowStart: '10:00',
    serviceType: 'General Pest Control',
    sendConfirmationSms: false,
    technicianId: TECH_ID,
    isRecurring: true,
    recurringPattern: 'monthly',
    recurringCount: 3,
    boosterMonths: [11],
    estimatedPrice: 89,
    createInvoice: true,
  };

  test('a child occurrence landing on the technician\'s absence date refuses the WHOLE create (422 NOT_ASSIGNABLE) and inserts nothing', async () => {
    const { status, body } = await post(recurringBody);

    expect(status).toBe(422);
    expect(body.code).toBe(NOT_ASSIGNABLE);
    expect(body.code).toBe('TECH_NOT_ASSIGNABLE');
    // Nothing partially inserted — the parent write never happens either.
    expect(inserts).toEqual([]);
  });

  test('the same plan with no absence on any generated date books clean (sanity — proves the check above is not a false positive)', async () => {
    const { status, body } = await post({ ...recurringBody, technicianId: 'tech-no-absence' });

    expect(status).toBe(201);
    expect(inserts.map((d) => d.scheduled_date)).toEqual(['2099-07-03', '2099-08-07', '2099-09-04', '2099-11-03']);
    expect(body.code).not.toBe('TECH_NOT_ASSIGNABLE');
  });
});
