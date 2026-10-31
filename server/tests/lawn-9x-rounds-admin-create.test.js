/**
 * GATE_LAWN_9X_ROUNDS on the office writers (owner 2026-10-28): POST
 * /api/admin/schedule stores a NEW residential lawn 9x series as
 * lawn_rounds_9 with no interval on the parent AND every child; the
 * make-recurring spawn of PUT /:id/update-details does the same; prepay on
 * book and the prepay preview cover it on the lawn_rounds_9 coverage cadence
 * (9 visits, no downgrade). Off, every value is stored as posted. Harness mirrors admin-schedule-create-tech-absence.test.js.
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
jest.mock('../services/package-followup-booking', () => ({
  ...jest.requireActual('../services/package-followup-booking'),
  hasLivePackageChild: jest.fn(async () => false),
}));
jest.mock('../services/estimate-manual-acceptance', () => ({
  ...jest.requireActual('../services/estimate-manual-acceptance'),
  persistedAddOnRefusal: jest.fn(() => null),
  prepayBookingEligibility: jest.fn(async () => ({ eligible: true })),
  markEstimateManuallyAccepted: jest.fn((...args) => jest.requireActual('../services/estimate-manual-acceptance').markEstimateManuallyAccepted(...args)),
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

// Lawn neighborhood day (lawn-area-days.js) on the office New Appointment: a NEW rounds series is placed
// from its area's anchor and the parent stores it.
describe('POST / — admin create — lawn neighborhood day', () => {
  const { lawnRoundDateFrom } = require('../services/lawn-rounds');
  const PARRISH = '2027-01-26';
  const withCustomer = (extra) => {
    // The same row on db and trx: the booking compares the two reads of the customer.
    const row = { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null, ...extra };
    for (const conn of [db, trx]) {
      const base = conn.getMockImplementation();
      conn.mockImplementation((table) => (table === 'customers' ? chain({ ...row }) : base(table)));
    }
  };
  const dates = () => inserts.map((d) => d.scheduled_date);
  const areaDates = (base) => [0, 1, 2, 3].map((i) => lawnRoundDateFrom(PARRISH, base, i));

  test('an area customer: the parent stores the area anchor and the children follow it', async () => {
    gateOn();
    withCustomer({ zip: '34219', city: 'Parrish' });
    const { status } = await post(lawnBody);
    expect(status).toBe(201);
    expect(dates()).toEqual(areaDates('2099-07-03'));
    expect(inserts[0].recurring_round_anchor_date).toBe(PARRISH);
    expect(inserts.slice(1).every((d) => !('recurring_round_anchor_date' in d))).toBe(true);
    // Every follow-up is on the Parrish Tuesday and 28+ days after the visit.
    expect(dates().slice(1).every((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 2)).toBe(true);
    expect(Math.round((new Date(`${dates()[1]}T12:00:00Z`) - new Date('2099-07-03T12:00:00Z')) / 86400000)).toBeGreaterThanOrEqual(28);
  });

  test('planner equals write: the dates locked up front are exactly the dates inserted', async () => {
    gateOn();
    withCustomer({ zip: '34219', city: 'Parrish' });
    const { status } = await post(lawnBody);
    expect(status).toBe(201);
    const locked = [...new Set(acquireOccupancyLock.mock.calls.map((c) => c[1]))].sort();
    expect(locked).toEqual([...dates()].sort());
  });

  test('a customer outside every area is unchanged: own anchor, no stamp', async () => {
    gateOn();
    withCustomer({ zip: '34251', city: 'Myakka City' });
    const { status } = await post(lawnBody);
    expect(status).toBe(201);
    expect(dates()).toEqual([0, 1, 2, 3].map((i) => lawnRoundDateFrom('2099-07-03', '2099-07-03', i)));
    expect(inserts.every((d) => !('recurring_round_anchor_date' in d))).toBe(true);
  });

  test('gate off: custom/42 is stored as posted and never takes an area anchor', async () => {
    withCustomer({ zip: '34219', city: 'Parrish' });
    const off = await post(lawnBody);
    expect(off.status).toBe(201);
    expect(inserts.every((d) => !('recurring_round_anchor_date' in d))).toBe(true);
    expect(dates()).toEqual(['2099-07-03', '2099-08-14', '2099-09-25', '2099-11-06']);
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

  test('gate on: a lawn 9x draft is covered on the lawn_rounds_9 cadence with 9 visits (no cadence refusal)', async () => {
    gateOn();
    const { status, body } = await preview();
    expect(status).toBe(200);
    expect(String(body.blockReason || '')).not.toMatch(/visit cadence/);
    expect(body.eligible).toBe(true);
    expect(body.coverageCadence).toBe('lawn_rounds_9');
    expect(body.visitsPerYear).toBe(9);
    expect(body.mintPayload.coverageCadence).toBe('lawn_rounds_9');
    expect(body.mintPayload.visitCount).toBe(9);
  });

  test('gate off: the same draft stays every_6_weeks', async () => {
    const { body } = await preview();
    expect(body.eligible).toBe(true);
    expect(body.coverageCadence).toBe('every_6_weeks');
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

  test('gate on: the series is written as rounds and prepay on book mints a lawn_rounds_9 term (no downgrade)', async () => {
    gateOn();
    const accept = require('../services/estimate-manual-acceptance').markEstimateManuallyAccepted;
    accept.mockClear();
    accept.mockResolvedValueOnce({ conversion: { draftInvoiceId: 'inv-1' } });
    const { status, body } = await post(prepayBody);
    expect(status).toBe(201);
    expect(seriesRows().map((d) => d.recurring_pattern)).toEqual(Array(4).fill('lawn_rounds_9'));
    expect((body.warnings || []).some((w) => /booked as standard|annual prepay/i.test(w))).toBe(false);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0][0]).toMatchObject({
      billingTerm: 'prepay_annual',
      annualPrepayCoverage: { coverageServiceType: 'Lawn Care', coverageVisitCount: 9, coverageCadence: 'lawn_rounds_9' },
    });
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

  const CATALOG = [
    { id: 'svc-lawn', service_key: 'lawn_care_6week', name: 'Lawn Care', category: 'lawn_care' },
    { id: 'svc-ts', service_key: 'tree_shrub_6week', name: 'Tree & Shrub Care', category: 'tree_shrub' },
  ];

  function mockVisit(row, customerExtra = {}) {
    spawned = [];
    parentUpdates = [];
    const make = (table) => {
      if (table === 'services') {
        const c = chain(undefined);
        c.first = jest.fn(async () => {
          const wheres = c.where.mock.calls.map((args) => args[0]).filter((w) => w && typeof w === 'object');
          return CATALOG.find((r) => wheres.some((w) => (w.id && w.id === r.id) || (w.service_key && w.service_key === r.service_key))) || undefined;
        });
        return c;
      }
      const c = chain(table === 'scheduled_services'
        ? { ...row }
        : (table === 'customers' ? { id: 'cust-1', waveguard_tier: 'Bronze', monthly_rate: 46.33, ...customerExtra } : undefined));
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

  describe('gate on: the identity is the EFFECTIVE posted service, not the stored one', () => {
    const asCustom = () => {
      expect(parentWrites()[0]).toMatchObject({ recurring_pattern: 'custom', recurring_interval_days: 42 });
      expect(spawned.map((d) => d.recurring_pattern)).toEqual(['custom', 'custom']);
    };
    const asRounds = () => {
      expect(parentWrites()[0].recurring_pattern).toBe('lawn_rounds_9');
      expect(spawned.map((d) => d.recurring_pattern)).toEqual(['lawn_rounds_9', 'lawn_rounds_9']);
    };
    const lawnStored = { ...lawnVisit, service_id: 'svc-lawn' };
    const tsStored = { ...lawnVisit, service_type: 'Tree & Shrub Care', service_id: 'svc-ts' };

    test('a lawn visit changed to tree & shrub (T&S serviceId) and made recurring stays custom/42', async () => {
      gateOn(); mockVisit(lawnStored);
      const r = await put({ ...makeRecurring, serviceId: 'svc-ts', serviceType: 'Tree & Shrub Care' })
      expect(r.status).toBe(200);
      asCustom();
    });

    test('a tree & shrub visit changed to lawn (lawn serviceId) and made recurring becomes lawn_rounds_9', async () => {
      gateOn(); mockVisit(tsStored);
      expect((await put({ ...makeRecurring, serviceId: 'svc-lawn', serviceType: 'Lawn Care' })).status).toBe(200);
      asRounds();
    });

    test('serviceId null with a "Lawn Care" label becomes lawn_rounds_9, even from a tree & shrub row', async () => {
      gateOn(); mockVisit(tsStored);
      expect((await put({ ...makeRecurring, serviceId: null, serviceType: 'Lawn Care' })).status).toBe(200);
      asRounds();
    });

    test('serviceId null with postedServiceKey lawn_care_6week becomes lawn_rounds_9 (label does not say lawn)', async () => {
      gateOn(); mockVisit(tsStored);
      expect((await put({ ...makeRecurring, serviceId: null, serviceType: 'Enhanced Program', serviceKey: 'lawn_care_6week' })).status).toBe(200);
      asRounds();
    });

    test('serviceId null with a tree & shrub label stays custom/42 even from a lawn row', async () => {
      gateOn(); mockVisit(lawnStored);
      expect((await put({ ...makeRecurring, serviceId: null, serviceType: 'Tree & Shrub Care' })).status).toBe(200);
      asCustom();
    });

    test('a label-only change to tree & shrub (no serviceId) stays custom/42 — the stale lawn id is not used', async () => {
      gateOn(); mockVisit(lawnStored);
      expect((await put({ ...makeRecurring, serviceType: 'Tree & Shrub Care' })).status).toBe(200);
      asCustom();
    });

    test('no service fields posted keeps the stored identity (lawn row → rounds, tree & shrub row → custom)', async () => {
      gateOn(); mockVisit(lawnStored);
      expect((await put(makeRecurring)).status).toBe(200);
      asRounds();
      mockVisit(tsStored);
      expect((await put(makeRecurring)).status).toBe(200);
      asCustom();
    });
  });

  test('gate on: a lawn visit that is already in a series is never re-written (a series never mixes the two patterns)', async () => {
    gateOn();
    mockVisit({ ...lawnVisit, is_recurring: true, recurring_pattern: 'custom', recurring_interval_days: 42 });
    const { status } = await put({ ...makeRecurring, spawnRecurringChildren: false });
    expect(status).toBe(200);
    expect(parentWrites().every((u) => u.recurring_pattern === 'custom')).toBe(true);
  });

  // Lawn neighborhood day (lawn-area-days.js): a make-recurring spawn of a rounds visit with no stored
  // anchor is placed from its area's anchor. The save's drift check aborts when the pre-lock plan
  // (planUpdateDetailsRecurrenceDates) and the write disagree, so a 200 here means plan == write.
  describe('gate on: a lawn neighborhood day', () => {
    const roundsVisit = { ...lawnVisit, recurring_pattern: 'lawn_rounds_9', scheduled_date: '2099-07-01', day: '2099-07-01' };
    const { lawnRoundDateFrom } = require('../services/lawn-rounds');
    const PARRISH = '2027-01-26';
    const stamps = () => parentUpdates.filter((u) => u.recurring_round_anchor_date !== undefined);

    test('an area customer: the parent stores the area anchor and the children follow it', async () => {
      gateOn();
      mockVisit(roundsVisit, { zip: '34219', city: 'Parrish' });
      const { status } = await put({ ...makeRecurring, recurringCount: 4 });
      expect(status).toBe(200);
      expect(stamps()).toEqual([{ recurring_round_anchor_date: PARRISH }]);
      const expected = [1, 2, 3].map((i) => lawnRoundDateFrom(PARRISH, '2099-07-01', i));
      expect(spawned.map((d) => d.scheduled_date)).toEqual(expected);
      expect(spawned.every((d) => d.recurring_pattern === 'lawn_rounds_9')).toBe(true);
    });

    test('a visit late in its round: the first follow-up is still 28+ days out, on the area day', async () => {
      gateOn();
      mockVisit({ ...roundsVisit, scheduled_date: '2099-07-07', day: '2099-07-07' }, { zip: '34219', city: 'Parrish' });
      const { status } = await put({ ...makeRecurring, recurringCount: 3 });
      expect(status).toBe(200);
      expect(spawned.map((d) => d.scheduled_date)).toEqual([1, 2].map((i) => lawnRoundDateFrom(PARRISH, '2099-07-07', i)));
      expect(Math.round((new Date(`${spawned[0].scheduled_date}T12:00:00Z`) - new Date('2099-07-07T12:00:00Z')) / 86400000)).toBeGreaterThanOrEqual(28);
    });

    test('a customer outside every area keeps the visit date as the anchor', async () => {
      gateOn();
      mockVisit(roundsVisit, { zip: '34251', city: 'Myakka City' });
      const { status } = await put({ ...makeRecurring, recurringCount: 3 });
      expect(status).toBe(200);
      expect(stamps()).toEqual([{ recurring_round_anchor_date: '2099-07-01' }]);
      expect(spawned.map((d) => d.scheduled_date)).toEqual([1, 2].map((i) => lawnRoundDateFrom('2099-07-01', '2099-07-01', i)));
    });

    test('a parent that already stores an anchor is re-placed from its own date, as before', async () => {
      gateOn();
      mockVisit({ ...roundsVisit, recurring_round_anchor_date: '2099-01-05' }, { zip: '34219', city: 'Parrish' });
      const { status } = await put({ ...makeRecurring, recurringCount: 3 });
      expect(status).toBe(200);
      expect(stamps()).toEqual([{ recurring_round_anchor_date: '2099-07-01' }]);
    });
  });
});
