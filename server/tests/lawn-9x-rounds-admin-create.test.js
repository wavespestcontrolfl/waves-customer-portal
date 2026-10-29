/**
 * GATE_LAWN_9X_ROUNDS on the office writers (owner 2026-10-28): POST
 * /api/admin/schedule stores a NEW residential lawn 9x series as
 * lawn_rounds_9 with no interval on the parent AND every child; the
 * make-recurring spawn of PUT /:id/update-details does the same; prepay on
 * book and the prepay preview refuse it (fail closed, like seasonal_feb_oct)
 * until the prepay coverage change ships. Off, every value is stored as
 * posted. Harness mirrors admin-schedule-create-tech-absence.test.js.
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
jest.mock('../services/estimate-manual-acceptance', () => ({
  ...jest.requireActual('../services/estimate-manual-acceptance'),
  persistedAddOnRefusal: jest.fn(() => null),
  prepayBookingEligibility: jest.fn(async () => ({ eligible: true })),
}));
jest.mock('../services/area-addon-limits', () => ({
  ...jest.requireActual('../services/area-addon-limits'),
  areaAddOnLimitRefusal: jest.fn(async () => null),
}));
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
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');
const { roundOf } = require('../services/lawn-rounds');

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

const SCHEDULE_COLUMNS = Object.fromEntries([
  'source_action', 'recurring_ongoing', 'recurring_nth', 'recurring_weekday', 'recurring_interval_days',
  'skip_weekends', 'weekend_shift', 'service_id', 'is_recurring', 'recurring_pattern', 'recurring_parent_id',
  'recurring_round_anchor_date',
].map((c) => [c, {}]));

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
  builder.columnInfo = jest.fn().mockResolvedValue(SCHEDULE_COLUMNS);
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

afterEach(() => { delete process.env.GATE_LAWN_9X_ROUNDS; });
const gateOn = () => { process.env.GATE_LAWN_9X_ROUNDS = 'true'; };

const lawnBody = {
  customerId: 'cust-1',
  scheduledDate: '2099-07-03',
  windowStart: '10:00',
  serviceType: 'Lawn Care',
  sendConfirmationSms: false,
  technicianId: 'tech-no-absence',
  isRecurring: true,
  recurringPattern: 'custom',
  recurringIntervalDays: 42,
  recurringCount: 4,
  estimatedPrice: 89,
  createInvoice: true,
};

const seriesRows = () => inserts.filter((d) => d.is_recurring);

describe('POST / — admin create — lawn 9x series pattern', () => {
  test('gate off: parent and children are stored custom with 42 days, exactly as posted', async () => {
    const { status } = await post(lawnBody);
    expect(status).toBe(201);
    expect(inserts).toHaveLength(4);
    expect(seriesRows().map((d) => d.recurring_pattern)).toEqual(['custom', 'custom', 'custom', 'custom']);
    expect(seriesRows().map((d) => d.recurring_interval_days)).toEqual([42, 42, 42, 42]);
    expect(inserts.map((d) => d.scheduled_date)).toEqual(['2099-07-03', '2099-08-14', '2099-09-25', '2099-11-06']);
  });

  test('gate on: parent and every child are stored lawn_rounds_9 with no interval, one visit a round', async () => {
    gateOn();
    const { status } = await post(lawnBody);
    expect(status).toBe(201);
    expect(inserts).toHaveLength(4);
    expect(seriesRows().map((d) => d.recurring_pattern)).toEqual(Array(4).fill('lawn_rounds_9'));
    expect(inserts.every((d) => d.recurring_interval_days === undefined)).toBe(true);
    // One visit in each of four consecutive rounds, from the parent's round 5.
    expect(inserts.map((d) => roundOf(d.scheduled_date).round)).toEqual([5, 6, 7, 8]);
  });

  test('gate on: a posted every_6_weeks lawn series is stored lawn_rounds_9 too', async () => {
    gateOn();
    const { status } = await post({ ...lawnBody, recurringPattern: 'every_6_weeks', recurringIntervalDays: undefined });
    expect(status).toBe(201);
    expect(seriesRows().map((d) => d.recurring_pattern)).toEqual(Array(4).fill('lawn_rounds_9'));
  });

  test.each([
    ['tree and shrub', 'Tree & Shrub Care'],
    ['mosquito', 'Mosquito Control'],
    ['pest', 'General Pest Control'],
    ['commercial lawn', 'Commercial Lawn Care'],
  ])('gate on: %s custom/42 is stored as posted', async (_name, serviceType) => {
    gateOn();
    const { status } = await post({ ...lawnBody, serviceType, allowDuplicateSeries: true });
    expect(status).toBe(201);
    expect(seriesRows().map((d) => d.recurring_pattern)).toEqual(Array(4).fill('custom'));
    expect(seriesRows().map((d) => d.recurring_interval_days)).toEqual(Array(4).fill(42));
  });

  test.each(['monthly', 'bimonthly'])('gate on: lawn %s is stored as posted', async (recurringPattern) => {
    gateOn();
    const { status } = await post({ ...lawnBody, recurringPattern, recurringIntervalDays: undefined });
    expect(status).toBe(201);
    expect(seriesRows().map((d) => d.recurring_pattern)).toEqual(Array(4).fill(recurringPattern));
  });

  test('gate on: a one-time lawn visit is untouched', async () => {
    gateOn();
    const { status } = await post({ ...lawnBody, isRecurring: false, recurringPattern: undefined, recurringIntervalDays: undefined });
    expect(status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].is_recurring).toBe(false);
  });
});

describe('GET /annual-prepay-preview — lawn 9x draft', () => {
  const gates = require('../config/feature-gates').gates;
  let prepayOnBookWas;
  beforeEach(() => { prepayOnBookWas = gates.prepayOnBook; gates.prepayOnBook = true; });
  afterEach(() => { gates.prepayOnBook = prepayOnBookWas; });

  async function preview(extra = {}) {
    const qs = new URLSearchParams({
      customerId: 'cust-1', serviceType: 'Lawn Care', price: '89', cadence: 'custom', intervalDays: '42', ...extra,
    });
    const res = await fetch(`${baseUrl}/api/admin/schedule/annual-prepay-preview?${qs}`);
    return { status: res.status, body: await res.json() };
  }

  test('gate off: custom/42 reads as every_6_weeks, a supported coverage cadence (no cadence refusal)', async () => {
    const { body } = await preview();
    expect(String(body.blockReason || '')).not.toMatch(/visit cadence/);
  });

  test('gate on: a lawn 9x draft is refused as an unsupported cadence, like seasonal_feb_oct', async () => {
    gateOn();
    const { status, body } = await preview();
    expect(status).toBe(200);
    expect(body.eligible).toBe(false);
    expect(body.blockReason).toMatch(/visit cadence/);
  });

  test('gate on: a tree and shrub custom/42 draft is not refused for its cadence', async () => {
    gateOn();
    const { body } = await preview({ serviceType: 'Tree & Shrub Care' });
    expect(String(body.blockReason || '')).not.toMatch(/visit cadence/);
  });

  test('gate on: a lawn bimonthly draft is not refused for its cadence', async () => {
    gateOn();
    const { body } = await preview({ cadence: 'bimonthly', intervalDays: '' });
    expect(String(body.blockReason || '')).not.toMatch(/visit cadence/);
  });
});

describe('POST / — admin create — prepay on book for a lawn 9x series', () => {
  const lawnQuote = {
    id: 'est-lawn', status: 'sent', customer_id: 'cust-1', expires_at: null,
    estimate_data: {
      engineResult: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', monthly: 75, annual: 900, perApp: 100, visitsPerYear: 9, frequency: 'every_6_weeks' }] },
    },
  };
  const prepayBody = { ...lawnBody, sourceEstimateId: 'est-lawn', billingTerm: 'prepay_annual', createInvoice: true };
  const cadenceRefusal = /isn.t supported for this visit cadence/;

  beforeEach(() => {
    const base = db.getMockImplementation();
    db.mockImplementation((table) => (table === 'estimates' ? chain({ ...lawnQuote }) : base(table)));
    const baseTrx = trx.getMockImplementation();
    trx.mockImplementation((table) => (table === 'estimates' ? chain({ ...lawnQuote }) : baseTrx(table)));
  });

  test('gate on: the series is written as rounds and the prepay downgrades to a standard accept, like seasonal_feb_oct', async () => {
    gateOn();
    const { status, body } = await post(prepayBody);
    expect(status).toBe(201);
    expect(seriesRows().map((d) => d.recurring_pattern)).toEqual(Array(4).fill('lawn_rounds_9'));
    expect(body.warnings.some((w) => /booked as standard — annual prepay isn.t available yet for the nine-round lawn program/.test(w))).toBe(true);
    expect(body.warnings.some((w) => /seasonal|every-6-weeks/i.test(w))).toBe(false);
  });

  test('gate off: custom/42 keeps its supported every_6_weeks coverage cadence (no cadence downgrade)', async () => {
    const { status, body } = await post(prepayBody);
    expect(status).toBe(201);
    expect(seriesRows().map((d) => d.recurring_pattern)).toEqual(Array(4).fill('custom'));
    expect((body.warnings || []).some((w) => cadenceRefusal.test(w))).toBe(false);
  });
});

describe('PUT /:id/update-details — make this lawn visit recurring', () => {
  const lawnVisit = { ...SVC, service_type: 'Lawn Care', is_recurring: false, recurring_pattern: null, recurring_parent_id: null };
  let spawned;
  let parentUpdates;

  function mockVisit(row) {
    spawned = [];
    parentUpdates = [];
    const make = (table) => {
      const c = chain(table === 'scheduled_services'
        ? { ...row }
        : (table === 'customers' ? { id: 'cust-1', waveguard_tier: 'Bronze', monthly_rate: 46.33 } : undefined));
      if (table === 'scheduled_services') {
        c.insert = jest.fn((data) => {
          spawned.push(data);
          return { returning: jest.fn().mockResolvedValue([{ ...row, ...data, id: `new-${spawned.length}` }]) };
        });
        c.update = jest.fn(async (data) => {
          const wheres = c.where.mock.calls.map((args) => args[0]);
          if (wheres.some((w) => w && typeof w === 'object' && w.id === 'svc-1')) parentUpdates.push(data);
          return 1;
        });
      }
      return c;
    };
    db.mockImplementation(make);
    trx.mockImplementation(make);
  }

  async function put(body) {
    const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  const makeRecurring = { isRecurring: true, recurringPattern: 'custom', recurringIntervalDays: 42, recurringCount: 3 };
  const parentWrites = () => parentUpdates.filter((u) => u.recurring_pattern !== undefined);

  test('gate off: the parent and the spawned children keep custom with 42 days', async () => {
    mockVisit(lawnVisit);
    const { status } = await put(makeRecurring);
    expect(status).toBe(200);
    expect(parentWrites()[0]).toMatchObject({ recurring_pattern: 'custom', recurring_interval_days: 42 });
    expect(spawned).toHaveLength(2);
    expect(spawned.map((d) => d.recurring_pattern)).toEqual(['custom', 'custom']);
    expect(spawned.map((d) => d.recurring_interval_days)).toEqual([42, 42]);
  });

  test('gate on: the parent and every spawned child are written lawn_rounds_9 with no interval', async () => {
    gateOn();
    mockVisit(lawnVisit);
    const { status } = await put(makeRecurring);
    expect(status).toBe(200);
    expect(parentWrites()[0].recurring_pattern).toBe('lawn_rounds_9');
    expect(parentWrites()[0].recurring_interval_days).toBeNull();
    expect(spawned).toHaveLength(2);
    expect(spawned.map((d) => d.recurring_pattern)).toEqual(['lawn_rounds_9', 'lawn_rounds_9']);
    expect(spawned.every((d) => (d.recurring_interval_days ?? null) === null)).toBe(true);
  });

  test('gate on: a tree and shrub visit made recurring keeps custom with 42 days', async () => {
    gateOn();
    mockVisit({ ...lawnVisit, service_type: 'Tree & Shrub Care' });
    const { status } = await put(makeRecurring);
    expect(status).toBe(200);
    expect(parentWrites()[0]).toMatchObject({ recurring_pattern: 'custom', recurring_interval_days: 42 });
    expect(spawned.map((d) => d.recurring_pattern)).toEqual(['custom', 'custom']);
  });

  test('gate on: a lawn visit that is already in a series is never re-written (a series never mixes the two patterns)', async () => {
    gateOn();
    mockVisit({ ...lawnVisit, is_recurring: true, recurring_pattern: 'custom', recurring_interval_days: 42 });
    const { status } = await put({ ...makeRecurring, spawnRecurringChildren: false });
    expect(status).toBe(200);
    expect(parentWrites().every((u) => u.recurring_pattern === 'custom')).toBe(true);
  });
});
