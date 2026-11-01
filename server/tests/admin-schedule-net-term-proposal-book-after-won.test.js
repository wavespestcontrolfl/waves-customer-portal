/**
 * Staff booking from a not-yet-won Bill-by-invoice proposal (owner 2026-11-01, "fix all", audit fix 2).
 *
 * POST /api/admin/schedule with a linkedEstimateId may link a SENT or VIEWED estimate (the phone-acceptance case). A
 * Bill-by-invoice proposal's Net 30 / Net 60 due date reaches a bill only once the proposal is accepted
 * (bill-by-invoice.js billByInvoiceProposal, proposal-win.js proposalTermsDueDate), so a visit booked early and completed
 * first was due on the visit day, chargeable by Auto Pay, with reminders from day 3. The route now answers 409
 * proposal_not_won before any scheduled_services row is written. Accepted proposals, Auto Pay-term proposals and ordinary
 * open quotes book as before.
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
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');

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


const AUTHORED_PROPOSAL = {
  enabled: true,
  title: 'Bayview Office Proposal',
  buildings: [{
    name: 'Main building',
    lineItems: [{ description: 'Quarterly pest', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true, amount: 300 }],
  }],
  commercialTerms: { paymentTerms: 'net30' },
};
const estimateRow = (extra = {}) => ({
  id: 'est-1', customer_id: 'cust-1', status: 'sent', expires_at: null, property_id: null, bill_by_invoice: true,
  estimate_data: { proposal: AUTHORED_PROPOSAL }, monthly_total: 0, annual_total: 0, onetime_total: 300, ...extra,
});

let linkedEstimate;
beforeEach(() => {
  linkedEstimate = estimateRow();
  const base = db.getMockImplementation();
  db.mockImplementation((table) => (table === 'estimates' ? chain(linkedEstimate) : base(table)));
  const baseTrx = trx.getMockImplementation();
  trx.mockImplementation((table) => (table === 'estimates' ? chain(linkedEstimate) : baseTrx(table)));
});

const body = (extra = {}) => ({
  customerId: 'cust-1',
  scheduledDate: '2099-07-03',
  windowStart: '10:00',
  serviceType: 'General Pest Control',
  sendConfirmationSms: false,
  estimatedPrice: 300,
  sourceEstimateId: 'est-1',
  ...extra,
});

describe('POST / — staff booking from a Bill-by-invoice proposal that is not won yet', () => {
  test.each(['sent', 'viewed'])('a %s Bill-by-invoice proposal is refused with 409 proposal_not_won and writes no visit', async (status) => {
    linkedEstimate = estimateRow({ status });
    const res = await post(body());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('proposal_not_won');
    expect(res.body.error).toMatch(/Mark this proposal won before booking from it/);
    expect(inserts).toEqual([]);
  });

  test('the same proposal, accepted, books', async () => {
    linkedEstimate = estimateRow({ status: 'accepted' });
    const res = await post(body());
    expect(res.body.code).not.toBe('proposal_not_won');
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
  });

  test('an Auto Pay-term proposal (not Bill by invoice) that is still sent is not refused by this guard', async () => {
    linkedEstimate = estimateRow({ bill_by_invoice: false });
    const res = await post(body());
    expect(res.body.code).not.toBe('proposal_not_won');
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
  });

  test('an ordinary sent quote with no authored proposal is not refused by this guard', async () => {
    linkedEstimate = estimateRow({ bill_by_invoice: false, estimate_data: { result: { oneTime: { items: [] } } } });
    const res = await post(body());
    expect(res.body.code).not.toBe('proposal_not_won');
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
  });
});
