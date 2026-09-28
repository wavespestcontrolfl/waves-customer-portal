/**
 * Audit repro r2-sched-update-details-financials-1 (ADMIN-BUG-R01)
 *
 * A discounted NO-add-on visit (estimated_price 90 net, primary_line_price 100
 * gross, discount_type 'percentage' 10) receives an unrelated Edit-appointment
 * save. The V1 EditServiceModal seeds its Price field from primaryLinePrice
 * (gross 100) and posts { estimatedPrice: 100, notes } with no discount
 * fields. The no-add-on branch of PUT /:id/update-details compared 100
 * against the stored NET 90, treated it as a price change, and rewrote the
 * row at gross with the discount stamp nulled.
 *
 * Fix: the desktop modal now also sends its own `primaryLinePrice` on every
 * no-add-on save (not only when add-ons are present), declaring outright
 * that its `estimatedPrice` is the row's GROSS. The server reads that
 * field's presence as the caller's convention instead of guessing from the
 * posted number — MobileServiceEditModal never sends it, so its
 * `estimatedPrice` is read as the stored NET exactly as before this fix.
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
  service_id: {}, service_key_snapshot: {}, service_category_snapshot: {}, notes: {}, is_recurring: {},
  recurring_parent_id: {}, technician_id: {},
};

// The stored row: a $100 primary with a 10% appointment discount => $90 net.
const STORED = {
  id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2099-01-15', status: 'pending',
  estimated_price: 90, primary_line_price: 100, discount_type: 'percentage', discount_amount: 10,
  discount_dollars: 10, is_recurring: false, recurring_parent_id: null, technician_id: null,
  service_id: 'svc-old', service_key_snapshot: 'pest_control', service_category_snapshot: 'pest',
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

// A variant of STORED with an existing $50 add-on line and no discount:
// primary_line_price=100, one add-on base_price=50, estimated_price=150.
function mockDbWithAddonRow(storedRowOverrides) {
  const storedRow = { ...STORED, discount_type: null, discount_amount: null, discount_dollars: null, ...storedRowOverrides };
  db.mockImplementation((table) => {
    if (table === 'scheduled_service_addons') {
      const c = chain(table);
      const rows = [{ base_price: 50, estimated_price: 50 }];
      c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      c.catch = (fn) => Promise.resolve(rows).catch(fn);
      return c;
    }
    const c = chain(table);
    if (table === 'scheduled_services') c.first = jest.fn(async () => ({ ...storedRow }));
    return c;
  });
}

// Resolves `db('services').where({ id }).first(...)` to a fixed catalog row —
// used to simulate the operator picking a service from the dropdown (the
// route's own service-resolution block, upstream of the price branches,
// stamps updates.service_id/service_key_snapshot/service_category_snapshot
// from whatever this resolves to).
function mockDbWithServiceLookup(serviceRow) {
  db.mockImplementation((table) => {
    if (table === 'services') {
      const c = chain(table);
      c.first = jest.fn(async () => ({ ...serviceRow }));
      return c;
    }
    return chain(table);
  });
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
    // GitHub Codex round 22 P1 (#4657, :11627): the route's under-lock
    // financial recheck now reads through `trx` for the no-add-on path
    // too (previously only the addons-replaced path ever reached a
    // trx-side re-read here), so `trx` must see the SAME per-test row
    // shape `db` was configured with (mockDbWithAddonRow et al. override
    // `db.mockImplementation`, not some separate trx-only fixture) — a
    // stale `chain(table)` default would hand the locked recheck the
    // module-level STORED fixture instead of a test's overridden row,
    // manufacturing a false financial-drift 409 that never reaches the
    // write this suite asserts on.
    const trx = jest.fn((table) => db(table));
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

test('desktop: an unrelated save echoing the gross primaryLinePrice must NOT strip the appointment discount', async () => {
  // What the FIXED EditServiceModal posts for a no-add-on row: form.price
  // was seeded from primaryLinePrice (100, gross); primaryLinePrice is now
  // sent unconditionally, declaring the gross convention; discountType
  // state is "" so it is omitted.
  const { status, body } = await put({ estimatedPrice: 100, primaryLinePrice: 100, notes: 'gate code 1234' });
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

test('desktop: a genuine price change (primaryLinePrice posted, different from stored) is honored, discount recomputed', async () => {
  // Operator actually types a new Price of 120 on the same $100/$90 row.
  const { status, body } = await put({ estimatedPrice: 120, primaryLinePrice: 120, notes: 'price bump' });
  const write = captured.find((c) => c.table === 'scheduled_services');
  console.log('status', status, JSON.stringify(body), 'captured scheduled_services update:', JSON.stringify(write?.payload));
  expect(write).toBeDefined();
  expect(Number(write.payload.estimated_price)).toBeCloseTo(120, 2);
});

test('mobile: an unrelated save echoing the stored NET as estimatedPrice must also NOT strip the discount', async () => {
  // MobileServiceEditModal seeds its price state from the stored NET
  // `estimatedPrice` (90) and posts it back verbatim, WITHOUT
  // primaryLinePrice — the opposite convention from the desktop modal's
  // gross echo above. Both callers post the same `estimatedPrice` key to
  // this same branch, so the no-op check must recognize BOTH as unchanged.
  const { status, body } = await put({ estimatedPrice: 90, notes: 'gate code 1234' });
  const write = captured.find((c) => c.table === 'scheduled_services');
  console.log('status', status, JSON.stringify(body), 'captured scheduled_services update:', JSON.stringify(write?.payload));
  expect(write).toBeDefined();
  if (write.payload.estimated_price !== undefined) {
    expect(Number(write.payload.estimated_price)).toBeCloseTo(90, 2);
  }
  expect(write.payload.discount_type).not.toBeNull();
  expect(write.payload.discount_amount).not.toBeNull();
});

test('Codex round-2 P0: a genuine mobile price change that happens to equal the stored GROSS must still be honored', async () => {
  // Same $100/$90/10%-discount row. Mobile operator genuinely wants to set
  // the price to 100 (drop the discount) — no primaryLinePrice is posted,
  // so this must be read as a real NET change (90 -> 100), never guessed as
  // an echo of the stored gross.
  const { status, body } = await put({ estimatedPrice: 100, notes: 'drop the discount' });
  const write = captured.find((c) => c.table === 'scheduled_services');
  console.log('status', status, JSON.stringify(body), 'captured scheduled_services update:', JSON.stringify(write?.payload));
  expect(write).toBeDefined();
  expect(Number(write.payload.estimated_price)).toBeCloseTo(100, 2);
});

test('Codex round-1 P0: a genuine mobile price change on a row WITH existing add-ons must NOT be silently ignored just because it matches the primary line\'s own gross', async () => {
  // Stored row: a $100 primary line + a $50 add-on = $150 total, no
  // discount. `deriveLegacyPrimarySubmission` returns only the PRIMARY
  // line's own gross (100) here — NOT the row's true $150 total — so
  // reading it as a stand-in for "the whole-visit price" would let a
  // genuine new total that happens to equal 100 be discarded as unchanged.
  // No primaryLinePrice is posted (mobile), so the fix must never even
  // consider the gross reading here.
  mockDbWithAddonRow({ estimated_price: 150 });
  const { status, body } = await put({ estimatedPrice: 100, notes: 'gate code 1234' });
  const write = captured.find((c) => c.table === 'scheduled_services');
  console.log('status', status, JSON.stringify(body), 'captured scheduled_services update:', JSON.stringify(write?.payload));
  expect(write).toBeDefined();
  // The genuine price change must actually land — never silently discarded.
  expect(Number(write.payload.estimated_price)).toBeCloseTo(100, 2);
});

test('Codex round 1 P1: a same-priced SERVICE SWITCH must rebase the discount, not silently keep it stamped for the old service', async () => {
  // Stored row is $100 gross / $90 net / 10% off, stamped for
  // service_id='svc-old' (service_key 'pest_control'). The operator switches
  // the primary service to a DIFFERENT catalog service while leaving the
  // Price field exactly as it was (100, gross) — the desktop modal never
  // reseeds discount fields either way, so this save posts no discountType/
  // discountAmount. Because neither the price NOR any discount field
  // changed, the no-op check alone would (before this fix) preserve the OLD
  // service's discount stamp on a visit that may no longer be in that
  // discount's scope.
  mockDbWithServiceLookup({ id: 'svc-new', service_key: 'termite_bond', category: 'termite', name: 'Termite Bond' });
  const { status, body } = await put({
    estimatedPrice: 100, primaryLinePrice: 100, serviceId: 'svc-new', notes: 'switch to termite bond',
  });
  const write = captured.find((c) => c.table === 'scheduled_services');
  console.log('status', status, JSON.stringify(body), 'captured scheduled_services update:', JSON.stringify(write?.payload));
  expect(write).toBeDefined();
  // The new service identity must land.
  expect(write.payload.service_id).toBe('svc-new');
  expect(write.payload.service_key_snapshot).toBe('termite_bond');
  // The discount stamp must be ACTIVELY rebased (explicitly nulled, since no
  // discount was reposted for the new service) — never left as the stale
  // 'percentage'/10 stamp scoped to the OLD service. An explicit null here
  // (as opposed to the key being absent) proves this went through the
  // rebase path, not the no-op path.
  expect(write.payload.discount_type).toBeNull();
  expect(write.payload.discount_amount).toBeNull();
});

test('Codex round 1 P1 control: same gross AND same service is still a true no-op', async () => {
  // The operator "picks" the SAME service the visit already has (e.g. the
  // dropdown re-submits the current selection) with an unchanged price.
  // Posting a serviceId at all must not by itself force a rebase — only an
  // ACTUAL identity change should.
  mockDbWithServiceLookup({ id: 'svc-old', service_key: 'pest_control', category: 'pest', name: 'General Pest Control' });
  const { status, body } = await put({
    estimatedPrice: 100, primaryLinePrice: 100, serviceId: 'svc-old', notes: 'gate code 1234',
  });
  const write = captured.find((c) => c.table === 'scheduled_services');
  console.log('status', status, JSON.stringify(body), 'captured scheduled_services update:', JSON.stringify(write?.payload));
  expect(write).toBeDefined();
  if (write.payload.estimated_price !== undefined) {
    expect(Number(write.payload.estimated_price)).toBeCloseTo(90, 2);
  }
  expect(write.payload.discount_type).not.toBeNull();
  expect(write.payload.discount_amount).not.toBeNull();
});
