/**
 * The re-service fold on POST /api/admin/schedule (GATE_RESERVICE_FOLD, owner 2026-11-17): the handler's wiring only.
 * findFoldTarget (reservice-fold-postgres.test.js) and moveFoldTarget (reservice-fold-move.test.js) have their own suites.
 * Pinned: gate off = no lookup and the usual 201; gate on + plan visit = the 200 fold answer and no insert; a refused move
 * books the re-service with the reason in `warnings`; only a free re-service with no add-on line looks; a bad request keeps its 400; a recurring booking and a service that
 * is not a re-service never look. Harness mirrors admin-schedule-reservice-office-request.test.js.
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
  mocked.acquireOccupancyLocks = jest.fn(async () => {});
  return mocked;
});
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
  withCustomerCommsLock: jest.fn(async (db, customerId, fn) => db.transaction(async (trx) => fn(trx))),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
}));

const gateState = { fold: true };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, reserviceFoldLive: jest.fn(() => gateState.fold) };
});
// The lookup and the move are proven in their own suites; here only the handler's wiring is.
jest.mock('../services/reservice-fold', () => ({
  ...jest.requireActual('../services/reservice-fold'),
  findFoldTarget: jest.fn(),
  moveFoldTarget: jest.fn(),
}));

const db = require('../models/db');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');
const fold = require('../services/reservice-fold');

const CUST = '11111111-1111-4111-8111-111111111111';
const TARGET = { id: 'plan-1', scheduled_date: '2099-07-09', service_type: 'Quarterly Pest Control Service', customer_request: null, notes: null };
const FOLD_ANSWER = { id: 'plan-1', recurringCreated: 0, appointments: [], warnings: ['No re-service booked: moved up.'], reserviceFold: { movedServiceId: 'plan-1' } };

const SVC = {
  id: 'svc-1', customer_id: CUST, scheduled_date: '2099-07-01', day: '2099-07-01',
  window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', technician_id: null,
  service_type: 'Pest Re-Service', estimated_duration_minutes: 60,
};

let tables;
function chain(table, rows) {
  const list = rows === undefined ? [] : (Array.isArray(rows) ? rows : [rows]);
  const builder = {};
  const self = () => builder;
  for (const m of ['whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit', 'offset', 'select', 'forUpdate', 'forShare', 'returning', 'leftJoin', 'join', 'groupBy', 'distinct', 'andWhere', 'orWhere', 'modify', 'clone']) {
    builder[m] = jest.fn(self);
  }
  let filtered = list;
  builder.where = jest.fn((a, b, c) => {
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      filtered = filtered.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
    } else if (typeof a === 'string' && b === '>=') {
      filtered = filtered.filter((r) => r[a] >= c);
    }
    return builder;
  });
  builder.first = jest.fn(async () => filtered[0]);
  builder.pluck = jest.fn().mockResolvedValue([]);
  builder.count = jest.fn().mockResolvedValue([{ count: '0' }]);
  builder.update = jest.fn().mockResolvedValue(1);
  builder.del = jest.fn().mockResolvedValue(0);
  builder.delete = jest.fn().mockResolvedValue(0);
  builder.columnInfo = jest.fn().mockResolvedValue(tables.columns[table] || { source_action: {} });
  builder.then = (resolve, reject) => Promise.resolve(filtered).then(resolve, reject);
  return builder;
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

let inserts;
beforeEach(() => {
  jest.clearAllMocks();
  gateState.fold = true;
  inserts = [];
  fold.findFoldTarget.mockResolvedValue(TARGET);
  fold.moveFoldTarget.mockResolvedValue({ moved: true, answer: FOLD_ANSWER });
  tables = {
    columns: { scheduled_services: { source_action: {}, customer_request: {}, customer_request_source: {}, is_callback: {} } },
    services: [
      { id: 'svc-pest-re', service_key: 'pest_re_service', name: 'Pest Re-Service' },
      { id: 'svc-pest-q', service_key: 'pest_control_quarterly', name: 'Quarterly Pest Control' },
    ],
    customers: [{ id: CUST, first_name: 'Test', last_name: 'Customer', phone: null, email: null, waveguard_tier: 'Silver' }],
  };
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table, tables[table] ?? (table === 'scheduled_services' ? { ...SVC } : undefined)));
  const trx = jest.fn((table) => {
    const c = chain(table, tables[table] ?? (table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: CUST } : undefined)));
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
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}


describe('POST / - re-service fold (GATE_RESERVICE_FOLD)', () => {
  const base = {
    customerId: CUST, scheduledDate: '2099-07-01', windowStart: '10:00', serviceType: 'Pest Re-Service',
    serviceId: 'svc-pest-re', sendConfirmationSms: false, estimatedPrice: 0, createInvoice: false,
  };

  test('gate off: no lookup, the re-service books exactly as before', async () => {
    gateState.fold = false;
    const r = await post(base);
    expect(r.status).toBe(201);
    expect(fold.findFoldTarget).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
  });

  test('gate on and a plan visit in range: the 200 fold answer, nothing inserted, the move carries the office choices', async () => {
    const r = await post({ ...base, sendConfirmationSms: true, technicianId: 'tech-9', notes: 'Ants in the lanai', customerNotes: 'Gate open' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(FOLD_ANSWER);
    expect(inserts).toHaveLength(0);
    expect(fold.findFoldTarget).toHaveBeenCalledWith(expect.anything(), { customerId: CUST, lane: 'pest', date: '2099-07-01', propertyId: null });
    expect(fold.moveFoldTarget).toHaveBeenCalledWith(expect.objectContaining({
      target: TARGET, date: '2099-07-01', windowStart: '10:00', technicianId: 'tech-9', notifyCustomer: true,
      notes: 'Ants in the lanai\nGate open', actor: { techRole: 'admin', technicianId: 'staff-1' },
    }));
  });

  test("the office's customerAskedTime reaches the move, whatever it is, for the move to judge", async () => {
    await post({ ...base, customerAskedTime: true });
    expect(fold.moveFoldTarget).toHaveBeenCalledWith(expect.objectContaining({ customerAskedTime: true }));
    await post(base);
    expect(fold.moveFoldTarget.mock.calls[1][0].customerAskedTime).toBeUndefined();
  });

  test('the technician choice: Unassigned reaches the move as null; no choice leaves the plan visit its own technician', async () => {
    await post({ ...base, assignmentMode: 'unassigned', technicianId: 'tech-9' });
    expect(fold.moveFoldTarget.mock.calls[0][0].technicianId).toBeNull();
    await post(base);
    expect(fold.moveFoldTarget.mock.calls[1][0].technicianId).toBeUndefined();
  });

  test('the move says no text with the confirmation box off', async () => {
    await post(base);
    expect(fold.moveFoldTarget).toHaveBeenCalledWith(expect.objectContaining({ notifyCustomer: false }));
  });

  test('gate on, no plan visit in range: the re-service books and nothing moves', async () => {
    fold.findFoldTarget.mockResolvedValue(null);
    const r = await post(base);
    expect(r.status).toBe(201);
    expect(fold.moveFoldTarget).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
  });

  test('the planner refuses the move: the re-service books as before and the answer names why', async () => {
    fold.moveFoldTarget.mockResolvedValue({ moved: false, warning: 'The re-service was booked as its own visit: the plan visit could not move up (taken).' });
    const r = await post(base);
    expect(r.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(r.body.warnings).toContain('The re-service was booked as its own visit: the plan visit could not move up (taken).');
  });

  test('a re-service that is not free books as before with no lookup: a price, an add-on line, or a customer with no free callback', async () => {
    const booked = async (extra, customer) => {
      if (customer) tables.customers = [{ id: CUST, first_name: 'Test', last_name: 'Customer', phone: null, email: null, ...customer }];
      inserts = [];
      const r = await post({ ...base, ...extra });
      // The mock database cannot finish every shape (an add-on line fails after the insert): the proof is that the write
      // was reached and the answer is not the fold's 200.
      expect(r.status).not.toBe(200);
      expect(inserts.length).toBeGreaterThan(0);
    };
    await booked({ estimatedPrice: 45 });
    await booked({ primaryLinePrice: 45 });
    await booked({ serviceAddons: [{ name: 'Extra', price: 20 }] });
    await booked({ serviceAddons: [{ name: 'No-charge line', price: 0 }] });
    await booked({}, { waveguard_tier: null });
    expect(fold.findFoldTarget).not.toHaveBeenCalled();
    expect(fold.moveFoldTarget).not.toHaveBeenCalled();
  });

  test('a free re-service with an empty add-on list still folds', async () => {
    expect((await post({ ...base, serviceAddons: [] })).status).toBe(200);
  });

  test('a bad request still gets its normal 400 and never reaches the lookup', async () => {
    const r = await post({ ...base, scheduledDate: undefined });
    expect(r.status).toBe(400);
    expect(fold.findFoldTarget).not.toHaveBeenCalled();
  });

  test('a recurring booking never folds', async () => {
    // The mock database cannot finish a series (it fails after the insert), so the proof is that the write was reached.
    await post({ ...base, isRecurring: true, recurringPattern: 'quarterly', recurringCount: 2 });
    expect(inserts.length).toBeGreaterThan(0);
    expect(fold.findFoldTarget).not.toHaveBeenCalled();
    expect(fold.moveFoldTarget).not.toHaveBeenCalled();
  });

  test('a service that is not a re-service never looks up a plan visit', async () => {
    const r = await post({ ...base, serviceId: 'svc-pest-q', serviceType: 'Quarterly Pest Control' });
    expect(r.status).toBe(201);
    expect(fold.findFoldTarget).not.toHaveBeenCalled();
  });
});
