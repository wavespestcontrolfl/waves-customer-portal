/**
 * PUT /:id/update-details — the re-price block (owner ruling 2026-09-28):
 * a visit's price cannot change while money is already committed on it at
 * the old price. Staff void/release it first; the one exemption is the
 * FREE re-service conversion, which voids its own invoices as part of the
 * same save. See server/routes/admin-schedule.js (priceChangeNeedsGuard,
 * the mint-lock acquisition right above it, and findBillingCoveredVisits'
 * `openBalance` option).
 *
 * Reuses the mock-knex harness pattern from
 * update-details-discount-preserved-no-addons-mock.test.js: `db` is a
 * jest.fn() dispatching per-table fake query builders, and `db.transaction`
 * hands the route a `trx` that reads through the SAME per-table fixtures.
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
const mockReleaseCombined = jest.fn(async () => ({ inFlight: 0 }));
jest.mock('../services/pay-combined', () => ({
  lockCombinedCustomers: jest.fn(async () => {}),
  releaseUnconfirmedCombinedSessionsForScheduledServices: (...a) => mockReleaseCombined(...a),
}));
jest.mock('../services/scheduled-invoice-mint', () => {
  const actual = jest.requireActual('../services/scheduled-invoice-mint');
  return {
    ...actual,
    acquireScheduledInvoiceMintLock: jest.fn((...a) => actual.acquireScheduledInvoiceMintLock(...a)),
  };
});

const express = require('express');
const db = require('../models/db');
const adminScheduleRouter = require('../routes/admin-schedule');
const { acquireScheduledInvoiceMintLock } = require('../services/scheduled-invoice-mint');

const COLS = {
  id: {}, customer_id: {}, scheduled_date: {}, status: {}, estimated_price: {},
  primary_line_price: {}, discount_type: {}, discount_amount: {}, discount_dollars: {},
  discount_id: {}, discount_name: {}, line_discount_id: {}, line_discount_name: {},
  line_discount_type: {}, line_discount_amount: {}, line_discount_dollars: {},
  service_id: {}, service_key_snapshot: {}, service_category_snapshot: {}, notes: {}, is_recurring: {},
  recurring_parent_id: {}, technician_id: {}, payer_id: {}, po_number: {}, self_pay_override: {},
  annual_prepay_term_id: {}, prepaid_amount: {}, is_callback: {},
};

// A $100, undiscounted, self-pay visit — no annual term, no hand prepayment.
const STORED = {
  id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2099-01-15', status: 'confirmed',
  estimated_price: 100, primary_line_price: 100, discount_type: null, discount_amount: null,
  discount_dollars: null, is_recurring: false, recurring_parent_id: null, technician_id: null,
  service_id: 'svc-old', service_key_snapshot: 'pest_control', service_category_snapshot: 'pest',
  window_start: null, window_end: null, payer_id: null, po_number: null, self_pay_override: false,
  annual_prepay_term_id: null, prepaid_amount: null, is_callback: false,
};

let invoiceFixture = [];
// Every jest.fn() created for the scheduled_services table's `forUpdate` —
// used to prove the mint lock is acquired before the FIRST row lock this
// transaction takes on the edited visit (jest's invocationCallOrder is a
// single counter shared across every mock function in the environment, so
// comparing across distinct jest.fn instances is meaningful).
const forUpdateSpy = jest.fn();

function chain(table) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere', 'orWhere', 'select', 'orderBy', 'limit', 'forNoKeyUpdate', 'forShare', 'leftJoin', 'join', 'groupBy', 'distinct', 'clone', 'transacting', 'skipLocked']) {
    c[m] = jest.fn().mockReturnThis();
  }
  c.forUpdate = jest.fn((...args) => {
    if (table === 'scheduled_services') forUpdateSpy(...args);
    return c;
  });
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
  const rows = table === 'invoices' ? invoiceFixture : [];
  const thenable = Object.assign(c, {
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    catch: (fn) => Promise.resolve(rows).catch(fn),
  });
  return thenable;
}

const captured = [];
class Sentinel extends Error {}

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
  invoiceFixture = [];
  forUpdateSpy.mockClear();
  acquireScheduledInvoiceMintLock.mockClear();
  mockReleaseCombined.mockClear();
  db.mockImplementation((table) => chain(table));
  db.raw = jest.fn(() => 'raw');
  db.fn = { now: jest.fn(() => 'now()') };
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => db(table));
    trx.raw = jest.fn(() => 'raw');
    trx.fn = { now: jest.fn(() => 'now()') };
    trx.schema = db.schema;
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

test('unchanged price passes even with an open invoice on the visit', async () => {
  invoiceFixture = [{ scheduled_service_id: 'svc-1', status: 'sent', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 100 }];
  const { status, body } = await put({ estimatedPrice: 100, notes: 'no price change' });
  console.log('unchanged price:', status, JSON.stringify(body));
  // Same price -> no guard, no mint lock, save proceeds to the write.
  expect(acquireScheduledInvoiceMintLock).not.toHaveBeenCalled();
  const write = captured.find((c) => c.table === 'scheduled_services');
  expect(write).toBeDefined();
});

test('changed price is refused (409) with a DRAFT invoice that still has a balance', async () => {
  invoiceFixture = [{ scheduled_service_id: 'svc-1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 100 }];
  const { status, body } = await put({ estimatedPrice: 150, notes: 'price bump' });
  console.log('draft-blocked:', status, JSON.stringify(body));
  expect(status).toBe(409);
  expect(body.code).toBe('REPRICE_BLOCKED_COMMITTED_MONEY');
  expect(captured.find((c) => c.table === 'scheduled_services')).toBeUndefined();
});

test('changed price is refused (409) with a SENT invoice that still has a balance', async () => {
  invoiceFixture = [{ scheduled_service_id: 'svc-1', status: 'sent', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 250 }];
  const { status, body } = await put({ estimatedPrice: 175, notes: 'price change' });
  console.log('sent-blocked:', status, JSON.stringify(body));
  expect(status).toBe(409);
  expect(body.code).toBe('REPRICE_BLOCKED_COMMITTED_MONEY');
});

test('changed price is refused (409) with an invoice paid entirely by account credit (prepaid + credit_applied)', async () => {
  invoiceFixture = [{ scheduled_service_id: 'svc-1', status: 'prepaid', credit_applied: 100, line_items: '[]', stripe_payment_intent_id: null, total: 100 }];
  const { status, body } = await put({ estimatedPrice: 150, notes: 'price change' });
  console.log('credit-paid-blocked:', status, JSON.stringify(body));
  expect(status).toBe(409);
  expect(body.code).toBe('REPRICE_BLOCKED_COMMITTED_MONEY');
});

test('changed price is allowed when there is no covered invoice — mint lock is acquired BEFORE the first visit-row FOR UPDATE', async () => {
  invoiceFixture = [];
  const { status, body } = await put({ estimatedPrice: 150, notes: 'price change, nothing committed' });
  console.log('allowed:', status, JSON.stringify(body));
  expect(acquireScheduledInvoiceMintLock).toHaveBeenCalledWith(expect.anything(), 'svc-1');
  expect(forUpdateSpy).toHaveBeenCalled();
  const mintOrder = acquireScheduledInvoiceMintLock.mock.invocationCallOrder[0];
  const rowLockOrder = forUpdateSpy.mock.invocationCallOrder[0];
  expect(mintOrder).toBeLessThan(rowLockOrder);
  const write = captured.find((c) => c.table === 'scheduled_services');
  expect(write).toBeDefined();
  expect(Number(write.payload.estimated_price)).toBeCloseTo(150, 2);
});

test('the free re-service conversion is exempt from the repricing guard by construction', () => {
  // reServiceConversionZeroPrice zeros the visit (and voids its own open
  // invoices in the same save — see the trx block right after this guard),
  // so it must never itself be blocked by the guard it would otherwise
  // trip. Driving resolveReServiceConversion's full eligibility chain
  // (membership lookup, re-service catalog resolution, prior-price
  // comparison) end-to-end through this mock harness would exercise a
  // large, separately-tested surface just to re-prove a one-line gate —
  // asserted directly against the route source instead, the same technique
  // this file's neighbor (edit-appt-price-service-scope.test.js) uses for
  // an equally deep conditional.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../routes/admin-schedule.js'), 'utf8');
  expect(src).toMatch(/if \(!reServiceConversionZeroPrice && updates\.estimated_price !== undefined\) \{/);
  // The conversion still takes the mint lock (it voids invoices under it),
  // it just never runs the coverage refusal.
  expect(src).toMatch(/if \(reServiceConversionZeroPrice \|\| priceChangeNeedsGuard\) \{/);
});

test('the refusal happens BEFORE the Bill-To session release (the first Stripe cancel this route can reach)', async () => {
  invoiceFixture = [{ scheduled_service_id: 'svc-1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 100 }];
  const { status, body } = await put({ estimatedPrice: 150, payerId: 'payer-9', notes: 'price + payer change' });
  console.log('blocked-before-stripe:', status, JSON.stringify(body));
  expect(status).toBe(409);
  expect(body.code).toBe('REPRICE_BLOCKED_COMMITTED_MONEY');
  expect(mockReleaseCombined).not.toHaveBeenCalled();
});
