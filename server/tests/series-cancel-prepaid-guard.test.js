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
  const state = { rows: [], invoices: [], terms: [], pendingTerms: [], writes: [], hasTableCalls: [], reads: [] };
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
      whereNotIn(col, vals) { if (col === 'status') b._statusNotIn = vals; return b; },
      whereNot() { return b; },
      whereNull() { return b; },
      whereNotNull() { return b; },
      leftJoin() { return b; },
      whereRaw() { return b; },
      orderBy() { return b; },
      forUpdate() { b._locked = true; return b; },
      modify(cb) { cb(b); return b; },
      select() { b._selectCalled = true; return b; },
      async first() {
        const rows = table === 'scheduled_services' ? state.rows : table === 'invoices' ? state.invoices : [];
        const found = rows.find((r) => Object.entries(b._where).every(([k, v]) => r[k] === v));
        return found ? { ...found } : undefined;
      },
      async columnInfo() { return { recurring_ongoing: {} }; },
      update(u) {
        // Honour the id + status predicates so a terminal row matches 0 rows
        // (the single-visit prepaid guard) — other updates match everything.
        const match = (r) => Object.entries(b._where).every(([k, v]) => r[k] === v)
          && !(b._statusNotIn && b._statusNotIn.includes(r.status));
        const rows = table === 'scheduled_services' && b._where.id
          ? state.rows.filter(match) : [{ id: null }];
        if (rows.length) state.writes.push({ table, op: 'update', u });
        return {
          returning: async () => rows.map((r) => ({ ...r, ...u })),
          then: (res, rej) => Promise.resolve(rows.length).then(res, rej),
        };
      },
      async insert(r) { state.writes.push({ table, op: 'insert', r }); return [1]; },
      // Awaiting the builder (the target select) resolves every scheduled
      // service — the harness owns the scope filtering by what it seeds.
      then(resolve, reject) {
        state.reads.push(String(table) + (b._locked ? ' FOR UPDATE' : '') + (b._statusNotIn ? ' live-only' : ''));
        const rows = table === 'scheduled_services' ? state.rows.map((r) => ({ ...r }))
          : table === 'invoices' ? state.invoices.map((r) => ({ ...r }))
          // coveredTermsAsOf reads 'annual_prepay_terms as t' — the harness
          // seeds what its paid-coverage predicate would return (`covered`).
          : table === 'annual_prepay_terms as t' ? state.terms.filter((t) => t.covered).map((t) => ({ id: t.id }))
          // The bare table is the pending-prepay-invoice pre-check (payment_pending terms).
          : table === 'annual_prepay_terms' ? state.pendingTerms.map((t) => ({ ...t })) : [];
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
    trx.fn = dbFn.fn;
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
const scheduleRouter = require('../routes/admin-schedule');

let server;
let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use('/api/admin/schedule', scheduleRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

const future = (days) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
};

function seed({ prepaidChild, invoices = [], terms = [{ id: 'term-1', covered: true }], pendingTerms = [] } = {}) {
  db.__state.invoices = invoices;
  db.__state.pendingTerms = pendingTerms;
  db.__state.terms = terms;
  db.__state.rows = [
    { id: 'parent', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: future(3), service_type: 'Pest Control', is_recurring: true, recurring_parent_id: null, recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null },
    { id: 'child-1', technician_id: 'tech-1', customer_id: 'cust-1', status: 'pending', scheduled_date: future(33), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'parent', recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null },
    { id: 'child-2', technician_id: 'tech-1', customer_id: 'cust-1', status: 'pending', scheduled_date: future(63), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'parent', recurring_ongoing: true, ...(prepaidChild || { annual_prepay_term_id: null, prepaid_amount: null }) },
  ];
  db.__state.writes = [];
  db.__state.hasTableCalls = [];
  db.__state.reads = [];
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
  seed({ prepaidChild: { annual_prepay_term_id: 'term-1', prepaid_amount: null }, terms: [{ id: 'term-1', covered: false }] });
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
  const stopIndex = db.__state.writes.findIndex(w => w.table === 'recurring_plan_alerts' && w.op === 'insert');
  const commitIndex = db.__state.writes.findIndex(w => w.op === 'commit');
  expect(stopIndex).toBeGreaterThan(-1);
  expect(stopIndex).toBeLessThan(commitIndex);
  expect(db.__state.writes[stopIndex].r).toMatchObject({ recurring_parent_id: 'parent', resolved_action: 'cancel_series' });
});

test("POST /admin/schedule/:id/prepaid refuses a cancelled visit with 409 visit_terminal (the writer side of the race — Codex #3878 r1 P1)", async () => {
  seed();
  db.__state.rows.find((r) => r.id === 'child-2').status = 'cancelled';
  const res = await fetch(`${baseUrl}/api/admin/schedule/child-2/prepaid`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 95, method: 'cash' }),
  });
  const body = await res.json();
  expect(res.status).toBe(409);
  expect(body.code).toBe('visit_terminal');
  expect(db.__state.writes.filter((w) => w.op === 'update')).toHaveLength(0);
});

test("POST /admin/schedule/:id/prepaid still stamps a 'rescheduled' visit (a pending reschedule REQUEST parks the same row; hook P1)", async () => {
  seed();
  db.__state.rows.find((r) => r.id === 'child-2').status = 'rescheduled';
  const res = await fetch(`${baseUrl}/api/admin/schedule/child-2/prepaid`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 95, method: 'cash' }),
  });
  expect(res.status).toBe(200);
});

test('POST /admin/schedule/:id/prepaid still stamps a live visit', async () => {
  seed();
  const res = await fetch(`${baseUrl}/api/admin/schedule/child-2/prepaid`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 95, method: 'cash' }),
  });
  expect(res.status).toBe(200);
  expect(db.__state.writes.some((w) => w.op === 'update' && Number(w.u.prepaid_amount) === 95)).toBe(true);
});

describe('term coverage is decided by the canonical reader, not a status list (pre-push P0 on #3878)', () => {
  test('the guard reads the linked terms through coveredTermsAsOf (aliased "annual_prepay_terms as t")', async () => {
    seed({ prepaidChild: { annual_prepay_term_id: 'term-1', prepaid_amount: null } });
    await cancel('series');
    expect(db.__state.reads).toContain('annual_prepay_terms as t');
  });

  test('the cancel locks the LIVE family (same set + order as the series prepaid stamp) before selecting its targets (Codex #3878 r4 P2)', async () => {
    seed();
    await cancel('series');
    const visitReads = db.__state.reads.filter((r) => r.startsWith('scheduled_services FOR UPDATE'));
    expect(visitReads[0]).toBe('scheduled_services FOR UPDATE live-only');
    expect(visitReads.length).toBeGreaterThanOrEqual(2);
  });

  test('coveredTermsAsOf keeps a cancelled term with renewal_decision=cancel (paid non-renewal) covered and drops refunded money', () => {
    // Real query builder, no connection: pin the SQL the guard now inherits.
    const knex = require('knex')({ client: 'pg' });
    const { coveredTermsAsOf } = require('../services/annual-prepay-renewals');
    const sql = coveredTermsAsOf(knex).whereIn('t.id', ['term-1']).select('t.id').toString();
    expect(sql).toMatch(/"t"\."status" = 'cancelled' and "t"\."renewal_decision" = 'cancel'/);
    expect(sql).toMatch(/not exists \(\s*select 1 from payments p/);
    expect(sql).toMatch(/"t"\."id" in \('term-1'\)/);
  });
});

describe('unpaid payment_pending annual term (Codex #3878 r3 P1)', () => {
  const pendingTerm = { id: 'term-p', prepay_invoice_id: 'inv-p', plan_label: 'Annual Pest', coverage_service_type: 'Pest Control' };
  const payable = { id: 'inv-p', status: 'sent', invoice_number: 'INV-9001' };

  test.each(['following', 'series'])('scope %s → 409 pending_prepay_invoice before any transaction (its invoice would re-activate coverage if paid later)', async (scope) => {
    seed({ pendingTerms: [pendingTerm], invoices: [payable] });
    const { status, body } = await cancel(scope);
    expect(status).toBe(409);
    expect(body.code).toBe('pending_prepay_invoice');
    expect(body.error).toContain('INV-9001');
    expect(body.error).toMatch(/Void it from the invoice tools first/);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(db.__state.writes).toEqual([]);
  });

  test('a VOIDED pending-prepay invoice no longer blocks', async () => {
    seed({ pendingTerms: [pendingTerm], invoices: [{ ...payable, status: 'void' }] });
    const { status } = await cancel('series');
    expect(status).toBe(200);
  });

  test("a pending term for ANOTHER service family does not block this family's series", async () => {
    seed({ pendingTerms: [{ ...pendingTerm, coverage_service_type: 'Lawn Care' }], invoices: [payable] });
    const { status } = await cancel('series');
    expect(status).toBe(200);
  });
});
