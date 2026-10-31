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
jest.mock('../services/scheduling/line-technician', () => {
  const actual = jest.requireActual('../services/scheduling/line-technician');
  return { ...actual, recordLinePickShadow: jest.fn(actual.recordLinePickShadow) };
});
jest.mock('../services/scheduling/office-auto-technician', () => ({ resolveOfficeAutoTechnician: jest.fn() }));
jest.mock('../services/scheduling/arrival-route', () => ({
  ...jest.requireActual('../services/scheduling/arrival-route'),
  placeMovedVisit: jest.fn().mockResolvedValue(null),
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
const { recordLinePickShadow } = require('../services/scheduling/line-technician');
const { resolveOfficeAutoTechnician } = require('../services/scheduling/office-auto-technician');
const logger = require('../services/logger');
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
// work_days (GATE_TECH_WORK_DAYS) is whatever the test sets; null = every day.
let techWorkDays = null;
// technician_capabilities rows that are Off (GATE_TECH_JOB_TYPE_CHECKS); [] = qualified or needs review.
let capabilityOffCategories = [];
function chainTechnician(techId) {
  return chain({ id: techId, name: 'Test Tech', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true, work_days: techWorkDays });
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
  techWorkDays = null;
  capabilityOffCategories = [];
  delete process.env.GATE_TECH_WORK_DAYS;
  delete process.env.GATE_TECH_JOB_TYPE_CHECKS;
  findConflictingVisits.mockResolvedValue([]);
  acquireOccupancyLock.mockImplementation(async () => {});
  lockCustomerComms.mockImplementation(async () => {});
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null } : undefined)));
  trx = jest.fn((table) => {
    if (table === 'technicians') return chainTechnician(TECH_ID);
    if (table === 'technician_absences') return chainTechAbsences(TECH_ID, ABSENCE_DATE);
    if (table === 'technician_capabilities') {
      const caps = chain(undefined);
      caps.pluck = jest.fn().mockResolvedValue(capabilityOffCategories);
      return caps;
    }
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

// GATE_TECH_WORK_DAYS (owner 2026-10-25): the office may put a technician on a
// day they do not work. The create saves every visit and says so in `warnings`.
describe('POST / — admin create — technician work-days warning (office paths warn, never block)', () => {
  afterEach(() => { delete process.env.GATE_TECH_WORK_DAYS; });
  // Same plan as above: the parent and two children fall on Fridays, the booster on a Tuesday.
  const recurringBody = {
    customerId: 'cust-1',
    scheduledDate: '2099-07-03',
    windowStart: '10:00',
    serviceType: 'General Pest Control',
    sendConfirmationSms: false,
    technicianId: 'tech-no-absence',
    isRecurring: true,
    recurringPattern: 'monthly',
    recurringCount: 3,
    boosterMonths: [11],
    estimatedPrice: 89,
    createInvoice: true,
  };

  test('gate on, a Monday-to-Thursday tech: every visit is saved and one "does not work on Fridays" warning comes back', async () => {
    process.env.GATE_TECH_WORK_DAYS = 'true';
    techWorkDays = [1, 2, 3, 4];
    const { status, body } = await post(recurringBody);
    expect(status).toBe(201);
    expect(inserts.map((d) => d.scheduled_date)).toEqual(['2099-07-03', '2099-08-07', '2099-09-04', '2099-11-03']);
    expect(inserts.every((d) => d.technician_id === 'tech-no-absence')).toBe(true);
    expect(body.warnings).toContain('Test Tech does not work on Fridays.');
    expect(body.warnings.filter((w) => /does not work/.test(w))).toHaveLength(1);
  });

  test('gate on, a tech who works Fridays: no work-days warning', async () => {
    process.env.GATE_TECH_WORK_DAYS = 'true';
    techWorkDays = [1, 2, 3, 4, 5];
    const { status, body } = await post(recurringBody);
    expect(status).toBe(201);
    expect((body.warnings || []).some((w) => /does not work/.test(w))).toBe(false);
  });

  test('gate off: work_days is ignored, no warning', async () => {
    techWorkDays = [1, 2, 3, 4];
    const { status, body } = await post(recurringBody);
    expect(status).toBe(201);
    expect((body.warnings || []).some((w) => /does not work/.test(w))).toBe(false);
  });
});


// GATE_SERVICE_LINE_MAP=shadow (owner 2026-10-25): an office create left on Auto /
// unassigned logs the technician the service-line map would pick, after the commit.
describe('POST / — admin create — service-line map shadow (office_auto)', () => {
  const body = {
    customerId: 'cust-1',
    scheduledDate: '2099-07-03',
    windowStart: '10:00',
    serviceType: 'General Pest Control',
    sendConfirmationSms: false,
    estimatedPrice: 89,
  };
  const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
  afterEach(() => { delete process.env.GATE_SERVICE_LINE_MAP; });

  test('Auto: one office_auto row is recorded after the response, with the saved visit and technician', async () => {
    const { status } = await post({ ...body, assignmentMode: 'auto' });
    expect(status).toBe(201);
    await settle();
    expect(recordLinePickShadow).toHaveBeenCalledTimes(1);
    expect(recordLinePickShadow).toHaveBeenCalledWith(expect.objectContaining({
      source: 'office_auto', scheduledServiceId: 'new-1', customerId: 'cust-1', date: '2099-07-03',
      windowStart: '10:00', actualTechnicianId: null,
    }));
  });

  test('the recorder runs only after every transaction of the create has committed', async () => {
    let open = 0;
    const openAtCall = [];
    const run = db.transaction.getMockImplementation();
    db.transaction = jest.fn(async (cb) => { open += 1; try { return await run(cb); } finally { open -= 1; } });
    recordLinePickShadow.mockImplementationOnce(() => { openAtCall.push(open); return Promise.resolve(null); });
    const { status } = await post({ ...body, assignmentMode: 'auto' });
    expect(status).toBe(201);
    await settle();
    expect(openAtCall).toEqual([0]);
  });

  test('a technician picked by hand: no row', async () => {
    const { status } = await post({ ...body, technicianId: 'tech-no-absence', assignmentMode: 'manual' });
    expect(status).toBe(201);
    await settle();
    expect(recordLinePickShadow).not.toHaveBeenCalled();
  });

  test('a recurring create records the parent visit only (children copy the technician)', async () => {
    const { status, body: out } = await post({
      ...body, isRecurring: true, recurringPattern: 'monthly', recurringCount: 3, boosterMonths: [11], assignmentMode: 'unassigned', createInvoice: true,
    });
    expect(out.error).toBeUndefined();
    expect(status).toBe(201);
    await settle();
    expect(recordLinePickShadow).toHaveBeenCalledTimes(1);
  });

  test('gate shadow with a broken log table: the create still succeeds and the failure is only logged', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'shadow';
    const original = db.getMockImplementation();
    db.mockImplementation((table) => (table === 'service_line_pick_shadow'
      ? { insert: () => Promise.reject(new Error('log table down')) }
      : original(table)));
    const { status, body: out } = await post({ ...body, assignmentMode: 'auto' });
    expect(status).toBe(201);
    expect(out.id).toBe('new-1');
    await settle();
    expect(recordLinePickShadow).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('shadow row not written'));
  });

  test('gate off (default): the real recorder runs no query', async () => {
    const original = db.getMockImplementation();
    const tables = [];
    db.mockImplementation((table) => { tables.push(table); return original(table); });
    await post({ ...body, assignmentMode: 'auto' });
    await settle();
    expect(tables.filter((t) => /^service_line_/.test(t))).toEqual([]);
  });
});

// GATE_TECH_JOB_TYPE_CHECKS (owner 2026-10-25): the office may give a technician work
// they are set to Off for; the create saves the visit and says so in `warnings`.
describe('POST / — admin create — technician job-type warning (office paths warn, never block)', () => {
  afterEach(() => { delete process.env.GATE_TECH_JOB_TYPE_CHECKS; });
  const body = {
    customerId: 'cust-1',
    scheduledDate: '2099-07-03',
    windowStart: '10:00',
    serviceType: 'General Pest Control',
    sendConfirmationSms: false,
    technicianId: 'tech-no-absence',
    estimatedPrice: 89,
    createInvoice: true,
  };
  const OFF_LINE = 'Test Tech is set to Off for General pest work.';

  test('gate on, the technician is Off for the visit\'s category: the visit is saved and one warning comes back', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    capabilityOffCategories = ['general'];
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(inserts.map((d) => d.technician_id)).toEqual(['tech-no-absence']);
    expect(res.body.warnings).toContain(OFF_LINE);
    expect(res.body.warnings.filter((w) => /set to Off/.test(w))).toHaveLength(1);
  });

  test('gate on, qualified or needs review (no Off row): no warning', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    const res = await post(body);
    expect(res.status).toBe(201);
    expect((res.body.warnings || []).some((w) => /set to Off/.test(w))).toBe(false);
  });

  test('gate off: an Off category is ignored, no warning', async () => {
    capabilityOffCategories = ['general'];
    const res = await post(body);
    expect(res.status).toBe(201);
    expect((res.body.warnings || []).some((w) => /set to Off/.test(w))).toBe(false);
  });

  test('gate on, no technician chosen (Auto): nothing to warn about', async () => {
    process.env.GATE_TECH_JOB_TYPE_CHECKS = 'true';
    capabilityOffCategories = ['general'];
    const res = await post({ ...body, technicianId: undefined });
    expect(res.status).toBe(201);
    expect((res.body.warnings || []).some((w) => /set to Off/.test(w))).toBe(false);
  });
});

// GATE_UNASSIGNED_VISIT_GUARD (census H5, owner 2026-10-25): the office modal's Auto choice used
// to require a tech-matcher that does not exist, so every Auto visit saved with no technician.
// The resolver itself is covered against Postgres in unassigned-visit-guard.pg.test.js.
describe('POST / — admin create — Auto technician choice (GATE_UNASSIGNED_VISIT_GUARD)', () => {
  const body = {
    customerId: 'cust-1',
    scheduledDate: '2099-07-03',
    windowStart: '10:00',
    serviceType: 'General Pest Control',
    sendConfirmationSms: false,
    estimatedPrice: 89,
    assignmentMode: 'auto',
  };
  const recurring = { ...body, isRecurring: true, recurringPattern: 'monthly', recurringCount: 3, boosterMonths: [11], createInvoice: true };
  afterEach(() => { delete process.env.GATE_UNASSIGNED_VISIT_GUARD; });

  test('gate off: the resolver is never asked, the visit saves unassigned as before, and the response has no autoAssign', async () => {
    const { status, body: res } = await post(body);
    expect(status).toBe(201);
    expect(resolveOfficeAutoTechnician).not.toHaveBeenCalled();
    expect(inserts[0].technician_id).toBeNull();
    expect(res).not.toHaveProperty('autoAssign');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Auto-assign failed, leaving unassigned'));
  });

  test('gate on, Auto resolves a technician: the visit is saved on that technician and the response says so', async () => {
    process.env.GATE_UNASSIGNED_VISIT_GUARD = 'true';
    resolveOfficeAutoTechnician.mockResolvedValue({ technicianId: 'tech-no-absence', result: 'assigned', reason: 'only_assignable' });
    const { status, body: res } = await post(body);
    expect(status).toBe(201);
    expect(resolveOfficeAutoTechnician).toHaveBeenCalledWith(expect.objectContaining({
      date: '2099-07-03', windowStart: '10:00', windowEnd: '11:00', durationMinutes: 60, serviceType: 'General Pest Control', customerId: 'cust-1',
    }));
    expect(inserts[0].technician_id).toBe('tech-no-absence');
    expect(res.autoAssign).toEqual({ result: 'assigned', reason: 'only_assignable', technicianId: 'tech-no-absence' });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Auto-assign failed'));
  });

  test('gate on, Auto finds nobody: the visit still saves, unassigned, and the response says why', async () => {
    process.env.GATE_UNASSIGNED_VISIT_GUARD = 'true';
    resolveOfficeAutoTechnician.mockResolvedValue({ technicianId: null, result: 'unassigned', reason: 'several_assignable' });
    const { status, body: res } = await post(body);
    expect(status).toBe(201);
    expect(inserts[0].technician_id).toBeNull();
    expect(res.autoAssign).toEqual({ result: 'unassigned', reason: 'several_assignable' });
  });

  test('gate on, a technician the office chose is never overridden, and "unassigned" on purpose is never resolved', async () => {
    process.env.GATE_UNASSIGNED_VISIT_GUARD = 'true';
    for (const mode of ['choose', 'unassigned']) {
      inserts = [];
      const { status, body: res } = await post({ ...body, assignmentMode: mode, technicianId: mode === 'choose' ? 'tech-no-absence' : undefined });
      expect(status).toBe(201);
      expect(res).not.toHaveProperty('autoAssign');
      expect(inserts[0].technician_id).toBe(mode === 'choose' ? 'tech-no-absence' : null);
    }
    expect(resolveOfficeAutoTechnician).not.toHaveBeenCalled();
  });

  test('gate on, a recurring series resolves once for the parent and every child copies it', async () => {
    process.env.GATE_UNASSIGNED_VISIT_GUARD = 'true';
    resolveOfficeAutoTechnician.mockResolvedValue({ technicianId: 'tech-no-absence', result: 'assigned', reason: 'only_assignable' });
    const { status, body: res } = await post(recurring);
    expect(status).toBe(201);
    expect(resolveOfficeAutoTechnician).toHaveBeenCalledTimes(1);
    expect(inserts.map((d) => d.scheduled_date)).toEqual(['2099-07-03', '2099-08-07', '2099-09-04', '2099-11-03']);
    expect(inserts.every((d) => d.technician_id === 'tech-no-absence')).toBe(true);
    expect(res.autoAssign.result).toBe('assigned');
  });

  test('gate on, the Auto technician is marked out on a later series date: the series saves unassigned instead of refusing', async () => {
    process.env.GATE_UNASSIGNED_VISIT_GUARD = 'true';
    resolveOfficeAutoTechnician.mockResolvedValue({ technicianId: TECH_ID, result: 'assigned', reason: 'only_assignable' });
    const { status, body: res } = await post(recurring);
    expect(status).toBe(201);
    expect(inserts).toHaveLength(4);
    expect(inserts.every((d) => d.technician_id === null)).toBe(true);
    expect(res.autoAssign).toEqual({ result: 'unassigned', reason: 'absent_on_series_date' });
  });
});

// GATE_NEW_APPT_STOP_ORDER (owner 2026-10-26, "OK GO"): the save numbers the
// booked visit's technician day through the staff writer, on the booking's own
// transaction, so the board and the tech app list it in its place, not last.
describe('POST / — admin create — New Appointment stop order', () => {
  const { placeMovedVisit } = require('../services/scheduling/arrival-route');
  const body = {
    customerId: 'cust-1',
    scheduledDate: '2099-07-03',
    windowStart: '10:00',
    serviceType: 'General Pest Control',
    sendConfirmationSms: false,
    technicianId: 'tech-no-absence',
    estimatedPrice: 89,
  };
  afterEach(() => { delete process.env.GATE_NEW_APPT_STOP_ORDER; });

  test('gate on: the booked visit goes to the staff writer, on the booking transaction', async () => {
    process.env.GATE_NEW_APPT_STOP_ORDER = 'true';
    const { status } = await post(body);
    expect(status).toBe(201);
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
    expect(placeMovedVisit).toHaveBeenCalledWith(trx, { serviceId: 'new-1', source: 'new_appointment', staffSave: true, lateDays: true });
  });

  test('gate on, a recurring create: the parent visit only (the night pass orders the children)', async () => {
    process.env.GATE_NEW_APPT_STOP_ORDER = 'true';
    const { status } = await post({ ...body, isRecurring: true, recurringPattern: 'monthly', recurringCount: 3, createInvoice: true });
    expect(status).toBe(201);
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
    expect(placeMovedVisit.mock.calls[0][1]).toEqual({ serviceId: 'new-1', source: 'new_appointment', staffSave: true, lateDays: true });
  });

  test('gate off (default): the save writes no stop order', async () => {
    const { status } = await post(body);
    expect(status).toBe(201);
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });
});

// GATE_ROUTE_CHECK_STAFF_SAVES (owner 2026-10-29, Route Check Everywhere 2a): the
// booked visit also gets the arrival-window route check Edit's save runs (a
// SECOND, advisory probe after the insert; the overlap probe is unchanged), and
// its warning joins `warnings`. The booking never fails on a route result.
describe('POST / — admin create — GATE_ROUTE_CHECK_STAFF_SAVES route check', () => {
  const ROUTE_WARNING = 'Could not verify the route\'s arrival windows on 2099-07-03. Review the route before driving it.';
  const body = {
    customerId: 'cust-1',
    scheduledDate: '2099-07-03',
    windowStart: '10:00',
    serviceType: 'General Pest Control',
    sendConfirmationSms: false,
    technicianId: 'tech-no-absence',
    estimatedPrice: 89,
  };
  const arrivalCalls = () => findConflictingVisits.mock.calls.map(([a]) => a).filter((a) => a.arrivalWindow);
  const overlapCalls = () => findConflictingVisits.mock.calls.map(([a]) => a).filter((a) => !a.arrivalWindow);
  beforeEach(() => {
    findConflictingVisits.mockImplementation(async (args) => (args.arrivalWindow
      ? [{ id: args.arrivalWindow.serviceId, conflict_reason: 'arrival_window', warning: ROUTE_WARNING }] : []));
  });
  afterEach(() => {
    delete process.env.GATE_ROUTE_CHECK_STAFF_SAVES;
    delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
    delete process.env.GATE_NEW_APPT_STOP_ORDER;
  });
  const gateOn = () => {
    process.env.GATE_ROUTE_CHECK_STAFF_SAVES = 'true';
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  };

  test('gate off: no route probe, no extra warning; the overlap probe carries no arrivalWindow', async () => {
    const { status, body: res } = await post(body);
    expect(status).toBe(201);
    expect(res.warnings || []).not.toContain(ROUTE_WARNING);
    expect(arrivalCalls()).toHaveLength(0);
    expect(overlapCalls()).toHaveLength(1);
    expect(overlapCalls()[0]).not.toHaveProperty('arrivalWindow');
  });

  test('gate on: the booked visit is checked on cached road times, the warning is returned, and the booking still commits', async () => {
    gateOn();
    const { status, body: res } = await post(body);
    expect(status).toBe(201);
    expect(res.warnings).toContain(ROUTE_WARNING);
    expect(inserts).toHaveLength(1);
    expect(arrivalCalls()).toHaveLength(1);
    expect(arrivalCalls()[0]).toMatchObject({
      db: trx, date: '2099-07-03', windowStart: '10:00', windowEnd: '11:00', excludeServiceIds: ['new-1'],
      arrivalWindow: { serviceId: 'new-1', roads: 'cache' },
    });
    // The overlap probe is the same call it was.
    expect(overlapCalls()).toHaveLength(1);
    expect(overlapCalls()[0]).not.toHaveProperty('arrivalWindow');
  });

  test('gate on, a recurring create: the parent visit only', async () => {
    gateOn();
    const { status } = await post({ ...body, isRecurring: true, recurringPattern: 'monthly', recurringCount: 3, createInvoice: true });
    expect(status).toBe(201);
    expect(arrivalCalls().map((a) => a.arrivalWindow.serviceId)).toEqual(['new-1']);
  });

  test('gate on: an unassigned booking is not route-checked', async () => {
    gateOn();
    const { status, body: res } = await post({ ...body, technicianId: undefined });
    expect(status).toBe(201);
    expect(res.warnings || []).not.toContain(ROUTE_WARNING);
    expect(arrivalCalls()).toHaveLength(0);
  });

  test('gate on, GATE_NEW_APPT_STOP_ORDER on: the stop-order placement runs before the route check (Codex P1 on 9837f0c3d4)', async () => {
    const { placeMovedVisit } = require('../services/scheduling/arrival-route');
    gateOn();
    process.env.GATE_NEW_APPT_STOP_ORDER = 'true';
    const { status, body: res } = await post(body);
    expect(status).toBe(201);
    expect(res.warnings).toContain(ROUTE_WARNING);
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
    const arrivalIdx = findConflictingVisits.mock.calls.findIndex(([a]) => a.arrivalWindow);
    expect(placeMovedVisit.mock.invocationCallOrder[0]).toBeLessThan(findConflictingVisits.mock.invocationCallOrder[arrivalIdx]);
  });

  test('gate on, GATE_NEW_APPT_STOP_ORDER off: the stop-order writer is untouched (this gate numbers nothing here)', async () => {
    const { placeMovedVisit } = require('../services/scheduling/arrival-route');
    gateOn();
    await post(body);
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });
});

// GATE_SAVE_ROAD_BUY (owner 2026-10-29): the New Appointment save buys the
// placement's Google road times BEFORE its transaction opens, as the staff
// user. The helper reads its own gate and is spied: only the wiring is under
// test here (the purchase itself is proven in save-road-buy.test.js).
describe('POST / — admin create — GATE_SAVE_ROAD_BUY wiring', () => {
  const roadBuy = require('../services/scheduling/save-road-buy');
  let buySpy;
  const located = (table) => chain(table === 'customers'
    ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null, latitude: '27.5', longitude: '-82.4' }
    : (table === 'scheduled_services' ? { ...SVC } : undefined));
  const body = {
    customerId: 'cust-1', scheduledDate: '2099-07-03', windowStart: '10:00', serviceType: 'General Pest Control',
    sendConfirmationSms: false, technicianId: TECH_ID, estimatedPrice: 89, createInvoice: true,
  };
  beforeEach(() => {
    buySpy = jest.spyOn(roadBuy, 'buyRoadsBeforeSave').mockResolvedValue({ lookups: 0 });
    db.mockImplementation(located);
  });
  afterEach(() => buySpy.mockRestore());

  test('a timed booking with a technician and a located customer buys first, as the staff user, outside any transaction', async () => {
    const { status } = await post({ ...body, technicianId: 'tech-no-absence' });
    expect(status).toBe(201);
    expect(buySpy).toHaveBeenCalledTimes(1);
    expect(buySpy.mock.calls[0][0]).toMatchObject({
      spender: 'staff-1', date: '2099-07-03', technicianId: 'tech-no-absence', windowStart: '10:00',
      prospective: { lat: '27.5', lng: '-82.4', service_type: 'General Pest Control' },
    });
    expect(buySpy.mock.invocationCallOrder[0]).toBeLessThan(db.transaction.mock.invocationCallOrder[0]);
  });

  // A chosen property is stamped on the visit with its own pin (nulls too), and
  // the route read excludes the primary address's pin for it: price that pin only.
  describe('a chosen property', () => {
    const customerProps = require('../services/customer-properties');
    const converter = require('../services/estimate-converter');
    const stamp = (pin) => ({ property_id: 'prop-2', service_address_line1: '2 Side St', service_address_city: 'Bradenton',
      service_address_state: 'FL', service_address_zip: '34202', lat: pin.lat, lng: pin.lng });
    const gates = require('../config/feature-gates').gates;
    const savedAddressGate = gates.editApptAddress;
    beforeEach(() => {
      gates.editApptAddress = true;
      jest.spyOn(converter, 'buildSeriesAddressScope').mockResolvedValue(null);
    });
    afterEach(() => { gates.editApptAddress = savedAddressGate; jest.restoreAllMocks(); });
    const book = (pin) => {
      jest.spyOn(customerProps, 'bookingPropertyStamp').mockResolvedValue(stamp(pin));
      return post({ ...body, technicianId: 'tech-no-absence', propertyId: 'prop-2' });
    };

    test('with its own pin: that pin is priced, not the customer\'s', async () => {
      await book({ lat: 27.9, lng: -82.1 });
      expect(buySpy).toHaveBeenCalledTimes(1);
      expect(buySpy.mock.calls[0][0].prospective).toMatchObject({ lat: 27.9, lng: -82.1 });
    });

    test('with no pin: nothing is bought, never the customer\'s primary pin', async () => {
      await book({ lat: null, lng: null });
      expect(buySpy).not.toHaveBeenCalled();
    });
  });

  test('an unassigned, untimed or unlocated booking buys nothing', async () => {
    await post({ ...body, technicianId: undefined });
    await post({ ...body, technicianId: 'tech-no-absence', windowStart: undefined });
    db.mockImplementation((table) => chain(table === 'customers' ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null } : undefined));
    await post({ ...body, technicianId: 'tech-no-absence' });
    expect(buySpy).not.toHaveBeenCalled();
  });
});

