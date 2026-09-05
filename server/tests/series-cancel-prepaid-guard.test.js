/**
 * PUT /admin/dispatch/:id/status { status: 'cancelled', scope: 'following' |
 * 'series' } refuses when any target is already paid for (annual prepay term
 * or hand-collected prepayment) — the plan-length trim's refusal contract
 * (findBillingCoveredVisits), read INSIDE the cancel transaction before any
 * row is written. Fee holds are NOT a refusal reason on this route (it runs
 * the fee rails with a waiver), so the guard is called with feeRails: false.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'admin-1', role: 'admin' };
      req.technicianId = 'admin-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
const mockTransitionJobStatus = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../services/job-status', () => {
  const actual = jest.requireActual('../services/job-status');
  return { ...actual, transitionJobStatus: (...a) => mockTransitionJobStatus(...a) };
});
const mockHandleSeriesCancellation = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/appointment-reminders', () => ({
  handleSeriesCancellation: (...a) => mockHandleSeriesCancellation(...a),
  handleCancellation: jest.fn().mockResolvedValue(undefined),
}));
const mockRunFollowThrough = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/visit-cancellation-followthrough', () => ({
  runVisitCancellationFollowThrough: (...a) => mockRunFollowThrough(...a),
}));

jest.mock('../models/db', () => {
  const state = { rows: [], invoices: [], terms: [], writes: [], hasTableCalls: [] };
  const makeBuilder = (table) => {
    const b = {
      _where: {},
      _selectCalled: false,
      where(w, op, val) {
        if (typeof w === 'function') { w.call(b); return b; }
        if (w && typeof w === 'object') Object.assign(b._where, w);
        else if (val === undefined) b._where[String(w).replace(/^scheduled_services\./, '')] = op;
        return b;
      },
      andWhere(...a) { return b.where(...a); },
      orWhere() { return b; },
      whereIn() { return b; },
      whereNotIn() { return b; },
      whereNot() { return b; },
      whereNull() { return b; },
      whereNotNull() { return b; },
      leftJoin() { return b; },
      orderBy() { return b; },
      forUpdate() { return b; },
      modify(cb) { cb(b); return b; },
      select() { b._selectCalled = true; return b; },
      async first() {
        const rows = table === 'scheduled_services' ? state.rows : [];
        const found = rows.find((r) => Object.entries(b._where).every(([k, v]) => r[k] === v));
        return found ? { ...found } : undefined;
      },
      async columnInfo() { return { recurring_ongoing: {} }; },
      async update(u) { state.writes.push({ table, op: 'update', u }); return 1; },
      async insert(r) { state.writes.push({ table, op: 'insert', r }); return [1]; },
      // Awaiting the builder (the target select) resolves every scheduled
      // service — the harness owns the scope filtering by what it seeds.
      then(resolve, reject) {
        const rows = table === 'scheduled_services' ? state.rows.map((r) => ({ ...r }))
          : table === 'invoices' ? state.invoices.map((r) => ({ ...r }))
          // Live terms only — the harness models the whereNotIn(dead statuses)
          // by seeding what a live read would return.
          : table === 'annual_prepay_terms' ? state.terms.filter((t) => !['cancelled', 'canceled', 'refunded'].includes(t.status)).map((t) => ({ id: t.id })) : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return b;
  };
  const dbFn = (table) => makeBuilder(table);
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = async () => ({});
  dbFn.schema = { hasTable: async (t) => { state.hasTableCalls.push(t); return true; } };
  dbFn.transaction = async (cb) => {
    state.writes.push({ table: '<trx>', op: 'begin' });
    const trx = (table) => makeBuilder(table);
    trx.raw = async () => ({});
    trx.schema = dbFn.schema;
    try {
      const out = await cb(trx);
      state.writes.push({ table: '<trx>', op: 'commit' });
      return out;
    } catch (e) {
      state.writes.push({ table: '<trx>', op: 'rollback' });
      throw e;
    }
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const dispatchRouter = require('../routes/admin-dispatch');

let server;
let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

const future = (days) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
};

function seed({ prepaidChild, invoices = [], terms = [{ id: 'term-1', status: 'active' }] } = {}) {
  db.__state.invoices = invoices;
  db.__state.terms = terms;
  db.__state.rows = [
    { id: 'parent', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: future(3), service_type: 'Pest Control', is_recurring: true, recurring_parent_id: null, recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null },
    { id: 'child-1', technician_id: 'tech-1', customer_id: 'cust-1', status: 'pending', scheduled_date: future(33), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'parent', recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null },
    { id: 'child-2', technician_id: 'tech-1', customer_id: 'cust-1', status: 'pending', scheduled_date: future(63), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'parent', recurring_ongoing: true, ...(prepaidChild || { annual_prepay_term_id: null, prepaid_amount: null }) },
  ];
  db.__state.writes = [];
  db.__state.hasTableCalls = [];
  mockTransitionJobStatus.mockClear();
  mockHandleSeriesCancellation.mockClear();
  mockRunFollowThrough.mockClear();
}

async function cancel(scope) {
  const res = await fetch(`${baseUrl}/api/admin/dispatch/parent/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled', scope, notifyCustomer: false }),
  });
  return { status: res.status, body: await res.json() };
}

describe.each([
  ['annual prepay term', { annual_prepay_term_id: 'term-1', prepaid_amount: null }],
  ['hand-collected prepayment', { annual_prepay_term_id: null, prepaid_amount: '95.00' }],
])('series cancel with a target %s', (_label, prepaidChild) => {
  test.each(['following', 'series'])('scope %s → 409 BILLING_COVERED_VISIT, transaction rolled back, nothing transitioned', async (scope) => {
    seed({ prepaidChild });
    const { status, body } = await cancel(scope);
    expect(status).toBe(409);
    expect(body.code).toBe('BILLING_COVERED_VISIT');
    expect(body.coveredCount).toBe(1);
    expect(body.error).toMatch(/Cancel plan on the customer profile/);
    expect(body.error).toContain(future(63));
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockHandleSeriesCancellation).not.toHaveBeenCalled();
    expect(mockRunFollowThrough).not.toHaveBeenCalled();
    const ops = db.__state.writes.map((w) => `${w.table}:${w.op}`);
    expect(ops).toEqual(['<trx>:begin', '<trx>:rollback']);
    // Fee holds are the dispatch route's own business (fee rails + waiver):
    // the guard must not consult the hold / card-request tables here — but
    // it still reads invoices (money held there is money taken too).
    expect(db.__state.hasTableCalls).toEqual(['invoices']);
  });
});

test('a target whose invoice already holds money (paid, neither visit field stamped) refuses too (pre-push hook P0)', async () => {
  seed({ invoices: [{ scheduled_service_id: 'child-2', status: 'paid', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: 'pi_1' }] });
  const { status, body } = await cancel('series');
  expect(status).toBe(409);
  expect(body.code).toBe('BILLING_COVERED_VISIT');
  expect(body.error).toMatch(/invoice that has money on it/);
  expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  expect(db.__state.writes.map((w) => `${w.table}:${w.op}`)).toEqual(['<trx>:begin', '<trx>:rollback']);
});

test('a visit linked to a REFUNDED term (link kept for audit, stamp cleared) is not covered — cancel proceeds (Codex #3878 r1 P2)', async () => {
  seed({ prepaidChild: { annual_prepay_term_id: 'term-1', prepaid_amount: null }, terms: [{ id: 'term-1', status: 'refunded' }] });
  const { status, body } = await cancel('series');
  expect(status).toBe(200);
  expect(body.cancelledCount).toBe(3);
});

test('an unpaid series still cancels through the same branch (guard is not a blanket refusal)', async () => {
  seed();
  const { status, body } = await cancel('series');
  expect(status).toBe(200);
  expect(body.cancelledCount).toBe(3);
  expect(mockTransitionJobStatus).toHaveBeenCalledTimes(3);
  const ops = db.__state.writes.map((w) => `${w.table}:${w.op}`);
  expect(ops).toContain('<trx>:commit');
  expect(db.__state.writes.some((w) => w.table === 'scheduled_services' && w.op === 'update' && w.u.recurring_ongoing === false)).toBe(true);
});
