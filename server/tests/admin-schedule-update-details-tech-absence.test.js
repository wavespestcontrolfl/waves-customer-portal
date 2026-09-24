/**
 * PUT /api/admin/schedule/:id/update-details — save-time technician
 * eligibility now checks the FINAL technician against the FINAL date this
 * save actually lands on (tech-out P1 pre-push audit on 1d199feac3):
 *
 *   (a) tech + date changed together — the receiving tech's absence on the
 *       NEW date is checked, not the row's stale OLD date (assignScheduleJobs
 *       used to run before updates.scheduled_date was written, so its
 *       eligibility check validated the wrong day).
 *   (b) a date-only edit that KEEPS the current technician still checks
 *       that tech's absence on the destination date — assignScheduleJobs
 *       never runs for a same-tech save, so this used to skip eligibility
 *       entirely.
 *   (c) an absence recorded on the OLD date no longer wrongly blocks an
 *       otherwise-valid move to a new date.
 *
 * Harness mirrors admin-schedule-occupancy-gate.test.js (full trx execution
 * through a permissive knex-ish chain), with a technician_absences table
 * added, mirroring admin-schedule-create-tech-absence.test.js's absence-mock
 * pattern.
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
const { assignDispatchJob } = require('../services/dispatch-assignment');

const STORED_DATE = '2099-07-01';
const NEW_DATE = '2099-08-01';
const TECH_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TECH_B = 'bbbbbbbb-0000-4000-8000-000000000002';

function baseSvc(overrides) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    scheduled_date: STORED_DATE,
    day: STORED_DATE, // to_char projection used by the shared tech-day fence
    window_start: '09:00:00',
    window_end: '10:00:00',
    status: 'confirmed',
    technician_id: TECH_A,
    service_type: 'General Pest Control',
    estimated_duration_minutes: 60,
    ...overrides,
  };
}

// Permissive knex-ish chain — every query resolves to the given row/rows.
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
  builder.insert = jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ ...row, id: 'new-1' }]), onConflict: jest.fn(() => ({ ignore: jest.fn().mockResolvedValue([]) })) }));
  builder.del = jest.fn().mockResolvedValue(0);
  builder.delete = jest.fn().mockResolvedValue(0);
  builder.columnInfo = jest.fn().mockResolvedValue({ source_action: {} });
  builder.then = (resolve, reject) => Promise.resolve(row === undefined ? [] : [row]).then(resolve, reject);
  return builder;
}

// technicians: a single active + field-dispatchable row, whatever the where().
function chainTechnician() {
  return chain({ id: 'any-tech', name: 'Test Tech', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true });
}

// technician_absences: a hit only when where() named THIS tech + THIS date
// (mirrors admin-schedule-create-tech-absence.test.js).
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
let updateCalls;

// Wires the strict mock for one scenario: the row as it stands, and which
// (technician_id, absence_date) pair the technician_absences table answers.
function setup({ svc, absenceTechId, absenceDate }) {
  updateCalls = [];
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...svc } : (table === 'customers' ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null } : undefined)));
  trx = jest.fn((table) => {
    if (table === 'technicians') return chainTechnician();
    if (table === 'technician_absences') return chainTechAbsences(absenceTechId, absenceDate);
    const c = chain(table === 'scheduled_services' ? { ...svc } : (table === 'customers' ? { id: 'cust-1' } : undefined));
    if (table === 'scheduled_services') {
      c.update = jest.fn(async (data) => { updateCalls.push(data); return 1; });
    }
    return c;
  });
  trx.raw = jest.fn(async (sql, bindings) => ({ sql, bindings, rows: [] }));
  trx.fn = { now: jest.fn(() => 'now()') };
  trx.transaction = jest.fn(async (cb) => cb(trx));
  trx.commit = jest.fn();
  trx.rollback = jest.fn();
  db.transaction = jest.fn(async (cb) => cb(trx));
}

beforeEach(() => {
  jest.clearAllMocks();
  findConflictingVisits.mockResolvedValue([]);
  acquireOccupancyLock.mockImplementation(async () => {});
  lockCustomerComms.mockImplementation(async () => {});
});

async function put(id, body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/${id}/update-details`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('PUT /:id/update-details — save-time technician eligibility on the FINAL tech + FINAL date', () => {
  test('date-only edit onto the RETAINED technician\'s absence date on the NEW date → 422 TECH_NOT_ASSIGNABLE, nothing written', async () => {
    setup({
      svc: baseSvc({ technician_id: TECH_A }),
      absenceTechId: TECH_A,
      absenceDate: NEW_DATE,
    });

    const { status, body } = await put('svc-1', { scheduledDate: NEW_DATE });

    expect(status).toBe(422);
    expect(body.code).toBe(NOT_ASSIGNABLE);
    expect(body.code).toBe('TECH_NOT_ASSIGNABLE');
    expect(updateCalls).toEqual([]);
    // assignScheduleJobs never runs for a same-tech save — this refusal has
    // to come from the route's own pre-write check, not dispatch-assignment.
    expect(assignDispatchJob).not.toHaveBeenCalled();
  });

  test('a same-date resubmit (scheduledDate unchanged) for a technician marked out on THAT date is not re-validated: the edit is written (auditor P1)', async () => {
    setup({
      svc: baseSvc({ technician_id: TECH_A }),
      absenceTechId: TECH_A,
      absenceDate: STORED_DATE,
    });

    const { status } = await put('svc-1', { scheduledDate: STORED_DATE, notes: 'gate code 1234' });

    expect(status).toBe(200);
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(assignDispatchJob).not.toHaveBeenCalled();
  });

  test('tech + date edit onto the NEW technician\'s absence date → 422 TECH_NOT_ASSIGNABLE, nothing written', async () => {
    setup({
      svc: baseSvc({ technician_id: TECH_A }),
      absenceTechId: TECH_B,
      absenceDate: NEW_DATE,
    });

    const { status, body } = await put('svc-1', { technicianId: TECH_B, scheduledDate: NEW_DATE });

    expect(status).toBe(422);
    expect(body.code).toBe('TECH_NOT_ASSIGNABLE');
    expect(updateCalls).toEqual([]);
    // The route's own pre-write check refuses before assignScheduleJobs ever
    // reaches assignDispatchJob.
    expect(assignDispatchJob).not.toHaveBeenCalled();
  });

  test('tech + date edit AWAY FROM a day the technician is out on (absence only on the OLD date) succeeds', async () => {
    setup({
      svc: baseSvc({ technician_id: TECH_A }),
      absenceTechId: TECH_B,
      absenceDate: STORED_DATE, // the row's OLD date — must not block a move off of it
    });
    assignDispatchJob.mockResolvedValue({ changed: true, technicianName: 'Test Tech B' });

    const { status, body } = await put('svc-1', { technicianId: TECH_B, scheduledDate: NEW_DATE });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.code).not.toBe('TECH_NOT_ASSIGNABLE');
  });
});
