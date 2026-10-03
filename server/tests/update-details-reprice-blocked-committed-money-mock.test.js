/**
 * PUT /:id/update-details — the re-price block (owner ruling 2026-09-28):
 * a visit's price cannot change while money is already committed on it at
 * the old price. Staff void/release it first; the one exemption is the
 * FREE re-service conversion, which voids its own invoices as part of the
 * same save. See server/routes/admin-schedule.js (priceChangeNeedsGuard,
 * the mint-lock acquisition right above it, and findBillingCoveredVisits'
 * `liveInvoice` option).
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
const { lockTechDays } = require('../services/scheduling/tech-day-lock');

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

// Two shapes share `.raw()` here: plain embedded column expressions (e.g.
// `to_char(...)`, used synchronously as a query-builder argument — 'raw' is
// enough) and the secure-prepay coverage rail's per-customer advisory
// try-lock (securePendingPrepayCoverageReasons, admin-schedule.js), which is
// AWAITED and needs the real `{ rows: [{ locked: … }] }` shape
// advisoryTryLockAcquired reads. None of these tests are about that rail, so
// it always answers "acquired".
function rawImpl(sql) {
  if (/AS locked/.test(String(sql))) return Promise.resolve({ rows: [{ locked: true }] });
  return 'raw';
}

let invoiceFixture = [];
// Every jest.fn() created for the scheduled_services table's `forUpdate` —
// used to prove the mint lock is acquired before the FIRST row lock this
// transaction takes on the edited visit (jest's invocationCallOrder is a
// single counter shared across every mock function in the environment, so
// comparing across distinct jest.fn instances is meaningful).
const forUpdateSpy = jest.fn();
// TOCTOU regression coverage (pre-push audit P1): true only while the
// route's own db.transaction callback is running. A test can set
// `concurrentEstimatedPrice` to make a `scheduled_services` read made
// INSIDE the transaction answer a DIFFERENT stored price than one made
// before it — simulating a concurrent save that already committed a price
// change between whatever the operator's screen last showed and this
// transaction's own mint-lock-held read.
let insideTxn = false;
let concurrentEstimatedPrice = null;

function chain(table) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere', 'orWhere', 'select', 'orderBy', 'limit', 'forNoKeyUpdate', 'forShare', 'leftJoin', 'join', 'groupBy', 'distinct', 'clone', 'transacting', 'skipLocked']) {
    c[m] = jest.fn().mockReturnThis();
  }
  c.forUpdate = jest.fn((...args) => {
    if (table === 'scheduled_services') forUpdateSpy(...args);
    return c;
  });
  c.first = jest.fn(async () => {
    if (table === 'technicians') {
      // Assignable by construction — this fixture only proves lock ORDER
      // (tech-day fence vs. mint lock), not eligibility refusal.
      return { id: 'tech-2', name: 'Tech Two', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true };
    }
    if (table !== 'scheduled_services') return null;
    if (insideTxn && concurrentEstimatedPrice != null) {
      return { ...STORED, estimated_price: concurrentEstimatedPrice };
    }
    return { ...STORED };
  });
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
  insideTxn = false;
  concurrentEstimatedPrice = null;
  forUpdateSpy.mockClear();
  acquireScheduledInvoiceMintLock.mockClear();
  lockTechDays.mockClear();
  mockReleaseCombined.mockClear();
  db.mockImplementation((table) => chain(table));
  db.raw = jest.fn(rawImpl);
  db.fn = { now: jest.fn(() => 'now()') };
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => db(table));
    trx.raw = jest.fn(rawImpl);
    trx.fn = { now: jest.fn(() => 'now()') };
    trx.schema = db.schema;
    trx.commit = jest.fn();
    trx.rollback = jest.fn();
    insideTxn = true;
    try {
      return await fn(trx);
    } finally {
      insideTxn = false;
    }
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
  // A price field WAS posted, so the mint lock is still taken (it's gated on
  // the request shape, not a pre-transaction DB comparison — see
  // priceEditPosted's own comment: that comparison can only be trusted
  // in-transaction, under the lock). But the in-transaction comparison
  // finds no actual change, so the coverage check never runs and the save
  // proceeds to the write.
  expect(acquireScheduledInvoiceMintLock).toHaveBeenCalledWith(expect.anything(), 'svc-1');
  const write = captured.find((c) => c.table === 'scheduled_services');
  expect(write).toBeDefined();
});

test('TOCTOU regression: a save that LOOKS unchanged still refuses when the in-transaction row already differs (a concurrent save landed first)', async () => {
  // The operator's screen (and any pre-transaction read) shows the OLD
  // stored price (100) and posts it back unchanged. But by the time this
  // save reaches its mint-lock-held read INSIDE the transaction, a
  // concurrent save has already moved the row to 250 — so this save's
  // posted 100 is actually a real (and, given the open invoice below,
  // blocked) price change relative to the row's CURRENT state. The guard
  // must decide from the in-transaction read, never a value that could have
  // gone stale before the transaction opened.
  concurrentEstimatedPrice = 250;
  invoiceFixture = [{ scheduled_service_id: 'svc-1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 250 }];
  const { status, body } = await put({ estimatedPrice: 100, notes: 'looks unchanged from a stale read' });
  console.log('toctou-blocked:', status, JSON.stringify(body));
  expect(status).toBe(409);
  expect(body.code).toBe('REPRICE_BLOCKED_COMMITTED_MONEY');
  expect(captured.find((c) => c.table === 'scheduled_services')).toBeUndefined();
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

test('a combined price + technician-assignment save takes the tech-day fence BEFORE the mint lock (Codex P2 on #5253: avoids the ABBA deadlock against estimate-public.js\'s accept, which takes the same two locks occupancy -> tech-day fence -> mint)', async () => {
  invoiceFixture = [];
  await put({
    estimatedPrice: 150, technicianId: 'tech-2', notes: 'price change + tech assignment',
  });
  expect(lockTechDays).toHaveBeenCalled();
  expect(acquireScheduledInvoiceMintLock).toHaveBeenCalledWith(expect.anything(), 'svc-1');
  const fenceCalls = lockTechDays.mock.invocationCallOrder;
  const mintCalls = acquireScheduledInvoiceMintLock.mock.invocationCallOrder;
  const fenceOrder = fenceCalls[fenceCalls.length - 1];
  const mintOrder = mintCalls[mintCalls.length - 1];
  expect(fenceOrder).toBeLessThan(mintOrder);
});

test('the free re-service conversion runs the same any-live-invoice check, guards its series siblings, and service edits take the mint lock', () => {
  // Owner ruling 2026-09-28 (#5253 r3): a conversion is a re-price like any
  // other — no exemption for the invoices its own cleanup would void. Driving
  // resolveReServiceConversion's full eligibility chain through this mock
  // harness would exercise a large, separately tested surface to re-prove a
  // one-line argument — asserted against the route source instead, the same
  // technique edit-appt-price-service-scope.test.js uses.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../routes/admin-schedule.js'), 'utf8');
  expect(src).toMatch(/const priceEditPosted = postedPriceKeys\.length > 0;/);
  expect(src).toMatch(/findBillingCoveredVisits\(trx, \[priceGuardRow \|\| \{ id: req\.params\.id \}\], \{ liveInvoice: true \}\)/);
  // Series-wide conversion: every sibling the conversion block zeroes is
  // locked, mint-try-locked and guarded BEFORE the first write (Codex r3 P1).
  const sibGuardAt = src.indexOf('const sibCovered = await findBillingCoveredVisits(trx, convSiblings.map((row) => (');
  expect(sibGuardAt).toBeGreaterThan(-1);
  expect(sibGuardAt).toBeLessThan(src.indexOf('if (addressPlan) addressUpdatedIds = await applyAppointmentAddress(trx, addressPlan, req.technicianId);'));
  expect(src).not.toMatch(/liveIndirectInvoice/);
  expect(src).toMatch(/if \(reServiceConversionZeroPrice \|\| priceEditPosted \|\| serviceEditPosted\) \{/);
  // The check reads the row under its own FOR UPDATE, before the first
  // route-owned write (applyAppointmentAddress).
  const guardAt = src.indexOf("const priceGuardRow = await trx('scheduled_services').where({ id: req.params.id }).forUpdate().first(...priceGuardSelect);");
  const firstWriteAt = src.indexOf('if (addressPlan) addressUpdatedIds = await applyAppointmentAddress(trx, addressPlan, req.technicianId);');
  expect(guardAt).toBeGreaterThan(-1);
  expect(guardAt).toBeLessThan(firstWriteAt);
});

test('changed price is refused (409) with a live $0 invoice (completion would reuse it at the old price)', async () => {
  invoiceFixture = [{ scheduled_service_id: 'svc-1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 0 }];
  const { status, body } = await put({ estimatedPrice: 150, notes: 'price change over a $0 draft' });
  expect(status).toBe(409);
  expect(body.code).toBe('REPRICE_BLOCKED_COMMITTED_MONEY');
  // Decided under the visit's row lock.
  expect(forUpdateSpy).toHaveBeenCalled();
  expect(captured.find((c) => c.table === 'scheduled_services')).toBeUndefined();
});

test('the refusal happens BEFORE the Bill-To session release (the first Stripe cancel this route can reach)', async () => {
  invoiceFixture = [{ scheduled_service_id: 'svc-1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 100 }];
  const { status, body } = await put({ estimatedPrice: 150, payerId: 'payer-9', notes: 'price + payer change' });
  console.log('blocked-before-stripe:', status, JSON.stringify(body));
  expect(status).toBe(409);
  expect(body.code).toBe('REPRICE_BLOCKED_COMMITTED_MONEY');
  expect(mockReleaseCombined).not.toHaveBeenCalled();
});

test("the 'following' sibling locks and refusals run before the Bill-To Stripe session release", () => {
  // Codex r4 P1 on #5253: a sibling refusal after the combined-session
  // cancel rolls back the DB but not Stripe. Source-order contract, same
  // technique as the conversion guard test above.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../routes/admin-schedule.js'), 'utf8');
  const earlyAt = src.indexOf('await lockAndGuardFollowingSiblings(trx, {');
  const releaseAt = src.indexOf('.releaseUnconfirmedCombinedSessionsForScheduledServices(trx, movedVisitIds, {');
  const firstWriteAt = src.indexOf('if (addressPlan) addressUpdatedIds = await applyAppointmentAddress(trx, addressPlan, req.technicianId);');
  expect(earlyAt).toBeGreaterThan(-1);
  expect(earlyAt).toBeLessThan(firstWriteAt);
  expect(earlyAt).toBeLessThan(releaseAt);
  // The propagation itself still re-runs the same phase (re-entrant locks).
  expect(src).toMatch(/const targets = await lockAndGuardFollowingSiblings\(conn, \{/);
});

test('estimate accept onto ANY existing appointment takes the mint lock before its first row lock', () => {
  // Codex r5 P1 on #5253: re-price holds mint → customer row; the accept
  // updated the customer before its adopt-block mint acquisition (ABBA).
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../routes/estimate-public.js'), 'utf8');
  const earlyAt = src.indexOf("if (existingAppointmentRow?.id && existingAppointmentRow.id !== acceptHoldRow?.id) {");
  const firstCommsAt = src.indexOf('let acceptPreLockedCommsId = estimate.customer_id || null;');
  expect(earlyAt).toBeGreaterThan(-1);
  expect(earlyAt).toBeLessThan(firstCommsAt);
});

test('re-price refuses with a retry while a /secure card confirmation is mid-finish, and checks estimate-scoped money', () => {
  // Codex r8 P1s on #5253 — source contract, same technique as above.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../routes/admin-schedule.js'), 'utf8');
  const guardAt = src.indexOf("const priceGuardRow = await trx('scheduled_services').where({ id: req.params.id }).forUpdate().first(...priceGuardSelect);");
  const completingAt = src.indexOf('await findCompletingCardRequestVisitId(trx, [req.params.id])');
  const estimateAt = src.indexOf('await findEstimateScopedCommitment(trx, priceGuardRow?.source_estimate_id)');
  const firstWriteAt = src.indexOf('if (addressPlan) addressUpdatedIds = await applyAppointmentAddress(trx, addressPlan, req.technicianId);');
  for (const at of [completingAt, estimateAt]) {
    expect(at).toBeGreaterThan(guardAt);
    expect(at).toBeLessThan(firstWriteAt);
  }
});
