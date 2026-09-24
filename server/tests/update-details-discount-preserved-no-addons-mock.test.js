/**
 * Audit repro r2-sched-update-details-financials-1
 *
 * A discounted NO-add-on visit (estimated_price 90 net, primary_line_price 100
 * gross, discount_type 'percentage' 10) receives an unrelated Edit-appointment
 * save. The V1 EditServiceModal seeds its Price field from primaryLinePrice
 * (gross 100) and posts { estimatedPrice: 100, notes } with no discount
 * fields. The no-add-on branch of PUT /:id/update-details compares 100 against
 * the stored NET 90, treats it as a price change, and rewrites the row at
 * gross with the discount stamp nulled.
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
    requireAdmin: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn());
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
  tryLockCustomerComms: jest.fn(async () => true),
  withCustomerCommsLock: jest.fn(async (_db, _id, fn) => fn()),
  lockSmsPhone: jest.fn(async () => {}),
  withSmsConsentLock: jest.fn(async (_db, _p, fn) => fn()),
  lockCustomerEmail: jest.fn(async () => {}),
}));
jest.mock('../services/scheduling/occupancy', () => {
  const actual = jest.requireActual('../services/scheduling/occupancy');
  return {
    ...actual,
    acquireOccupancyLock: jest.fn(async () => {}),
    acquireOccupancyLocks: jest.fn(async () => {}),
    findConflictingVisits: jest.fn(async () => []),
  };
});
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn(async () => []) }));
jest.mock('../services/scheduling/arrival-route', () => {
  const actual = jest.requireActual('../services/scheduling/arrival-route');
  return { ...actual, arrivalWindowRoutingEnabled: () => false };
});
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: () => false, discountStackingLive: () => false };
});

const express = require('express');
const db = require('../models/db');
const adminScheduleRouter = require('../routes/admin-schedule');

const COLS = {
  id: {}, customer_id: {}, scheduled_date: {}, status: {}, estimated_price: {},
  primary_line_price: {}, discount_type: {}, discount_amount: {}, discount_dollars: {},
  discount_id: {}, discount_name: {}, line_discount_id: {}, line_discount_name: {},
  line_discount_type: {}, line_discount_amount: {}, line_discount_dollars: {},
  service_key_snapshot: {}, service_category_snapshot: {}, notes: {}, is_recurring: {},
  recurring_parent_id: {}, technician_id: {},
};

// The stored row: a $100 primary with a 10% appointment discount => $90 net.
const STORED = {
  id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2099-01-15', status: 'pending',
  estimated_price: 90, primary_line_price: 100, discount_type: 'percentage', discount_amount: 10,
  discount_dollars: 10, is_recurring: false, recurring_parent_id: null, technician_id: null,
  service_key_snapshot: 'pest_control', service_category_snapshot: 'pest',
  window_start: null, window_end: null,
};

const captured = [];
class Sentinel extends Error {}

function chain(table) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere', 'orWhere', 'select', 'orderBy', 'limit', 'forUpdate', 'forNoKeyUpdate', 'forShare', 'leftJoin', 'join', 'groupBy', 'distinct', 'clone', 'transacting', 'skipLocked']) {
    c[m] = jest.fn().mockReturnThis();
  }
  c.first = jest.fn(async () => (table === 'scheduled_services' ? { ...STORED } : null));
  c.columnInfo = jest.fn(async () => (table === 'scheduled_services' ? COLS : {}));
  c.pluck = jest.fn(async () => []);
  c.count = jest.fn(async () => [{ count: '0' }]);
  c.update = jest.fn(async (payload) => {
    captured.push({ table, payload });
    if (table === 'scheduled_services') throw new Sentinel('captured');
    return 1;
  });
  c.insert = jest.fn(async () => []);
  c.del = jest.fn(async () => 0);
  c.delete = jest.fn(async () => 0);
  c.then = undefined;
  // Awaiting the chain itself (a select without .first) resolves to [].
  const thenable = Object.assign(c, {
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    catch: (fn) => Promise.resolve([]).catch(fn),
  });
  return thenable;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  captured.length = 0;
  db.mockImplementation((table) => chain(table));
  db.raw = jest.fn(() => 'raw');
  db.fn = { now: jest.fn(() => 'now()') };
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => chain(table));
    trx.raw = jest.fn(() => 'raw');
    trx.fn = { now: jest.fn(() => 'now()') };
    trx.commit = jest.fn();
    trx.rollback = jest.fn();
    return fn(trx);
  });
});

async function put(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('an unrelated save echoing the gross primaryLinePrice as estimatedPrice must NOT strip the appointment discount', async () => {
  // What the V1 EditServiceModal posts for a no-add-on row: form.price was
  // seeded from primaryLinePrice (100, gross) because the list DTO always ships
  // serviceAddons as an array; discountType state is "" so it is omitted.
  const { status, body } = await put({ estimatedPrice: 100, notes: 'gate code 1234' });
  const write = captured.find((c) => c.table === 'scheduled_services');
   
  console.log('status', status, JSON.stringify(body), 'captured scheduled_services update:', JSON.stringify(write?.payload));
  expect(write).toBeDefined();
  // Expected: economics untouched. Either no estimated_price write at all, or
  // the stored net (90) and the discount stamp preserved.
  if (write.payload.estimated_price !== undefined) {
    expect(Number(write.payload.estimated_price)).toBeCloseTo(90, 2);
  }
  expect(write.payload.discount_type).not.toBeNull();
  expect(write.payload.discount_amount).not.toBeNull();
});
