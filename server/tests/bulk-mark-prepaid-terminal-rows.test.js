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
      // The series lock read groups whereNull('status').orWhereNotIn(...) (live = NULL or non-terminal).
      orWhereNotIn(col, vals) { if (col === 'status') b._statusNotIn = vals; return b; },
      whereNot() { return b; },
      whereNull(col) { (b._nullCols ||= []).push(String(col).replace(/^scheduled_services\./, '')); return b; },
      whereNotNull() { return b; },
      leftJoin() { return b; },
      whereRaw(sql, bindings) {
        // The manual prepaid writers' null-safe annual-method predicate
        // (prepaid-series.js withoutAnnualCoverage); other raw SQL is opaque.
        const distinct = /^(\w+) IS DISTINCT FROM \?$/.exec(String(sql));
        if (distinct) (b._distinctFrom ||= []).push([distinct[1], bindings?.[0]]);
        return b;
      },
      whereNotExists() { return b; },
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
        // (the single-visit prepaid guard) and the annual-coverage predicates
        // (whereNull + IS DISTINCT FROM) — other updates match everything.
        const nullCols = b._nullCols || [];
        // whereNull('status').orWhereNotIn('status', X) is an OR-composed
        // group (live = NULL or non-terminal), not two independent AND
        // predicates — a bare AND would require status to be BOTH null
        // and non-terminal, matching nothing. Every other whereNull column
        // (e.g. annual_prepay_term_id in the annual-coverage guard) stays
        // a plain "must be null" AND predicate.
        const statusIsOrGrouped = nullCols.includes('status') && b._statusNotIn;
        const plainNullCols = nullCols.filter((col) => col !== 'status' || !statusIsOrGrouped);
        const match = (r) => Object.entries(b._where).every(([k, v]) => r[k] === v)
          && (statusIsOrGrouped ? (r.status == null || !b._statusNotIn.includes(r.status)) : !(b._statusNotIn && b._statusNotIn.includes(r.status)))
          && plainNullCols.every((col) => r[col] == null)
          && (b._distinctFrom || []).every(([col, val]) => r[col] !== val);
        const rows = table === 'scheduled_services' && b._where.id
          ? state.rows.filter(match) : [{ id: null }];
        if (rows.length) state.writes.push({ table, op: 'update', u });
        return {
          returning: async () => rows.map((r) => ({ ...r, ...u })),
          then: (res, rej) => Promise.resolve(rows.length).then(res, rej),
        };
      },
      insert(r) {
        state.writes.push({ table, op: 'insert', r });
        return { returning: async () => [{ id: 'allocation-audit' }],
          then: (resolve, reject) => Promise.resolve([1]).then(resolve, reject) };
      },
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

// ---- audit repro r1-sched-series-3: bulk mark_prepaid has no terminal-status guard ----
const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/admin-schedule');

let server;
let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', scheduleRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

const future = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

function seed() {
  db.__state.invoices = []; db.__state.pendingTerms = []; db.__state.terms = [];
  db.__state.rows = [
    { id: 'parent', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: future(3), service_type: 'Pest Control', is_recurring: true, recurring_parent_id: null, recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null, prepaid_method: null },
    { id: 'child-completed', technician_id: 'tech-1', customer_id: 'cust-1', status: 'completed', scheduled_date: future(-30), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'parent', recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null, prepaid_method: null },
    { id: 'child-cancelled', technician_id: 'tech-1', customer_id: 'cust-1', status: 'cancelled', scheduled_date: future(33), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'parent', recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null, prepaid_method: null },
    { id: 'child-noshow', technician_id: 'tech-1', customer_id: 'cust-1', status: 'no_show', scheduled_date: future(-2), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'parent', recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null, prepaid_method: null },
    // Legacy null-status row: the service-cadence convention treats a NULL
    // status as live (fetchSeriesRows' own lock predicate), so this row
    // must be stamped like any other live visit, not refused as if it
    // carried annual coverage.
    { id: 'child-null-status', technician_id: 'tech-1', customer_id: 'cust-1', status: null, scheduled_date: future(45), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'parent', recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null, prepaid_method: null },
  ];
  db.__state.writes = []; db.__state.hasTableCalls = []; db.__state.reads = [];
}

test('CONTRAST: POST /:id/prepaid refuses the cancelled row with 409 visit_terminal', async () => {
  seed();
  const res = await fetch(`${baseUrl}/api/admin/schedule/child-cancelled/prepaid`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 90, method: 'cash' }),
  });
  const body = await res.json();
  expect(res.status).toBe(409);
  expect(body.code).toBe('visit_terminal');
  expect(db.__state.writes.filter((w) => w.op === 'update')).toHaveLength(0);
});

test('EXPECTED: bulk mark_prepaid refuses completed, cancelled and no_show rows — only live rows (incl. a legacy null-status row) are stamped', async () => {
  seed();
  const res = await fetch(`${baseUrl}/api/admin/schedule/bulk-action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'mark_prepaid', serviceIds: ['parent', 'child-completed', 'child-cancelled', 'child-noshow', 'child-null-status'], payload: { totalAmount: 360, method: 'cash' } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  console.log('bulk result:', JSON.stringify(body));
  const stamps = db.__state.writes.filter((w) => w.op === 'update' && w.u.prepaid_amount != null);
  console.log('stamp writes:', stamps.length, 'each amount:', stamps.map((w) => w.u.prepaid_amount));
  // EXPECTED (symmetry with the single-visit writer, admin-schedule.js:13384):
  // the live parent AND the legacy null-status row are stamped; the three
  // terminal rows land in failed[] instead of silently taking a PAID stamp
  // for a visit that never runs (or already ran). A bare whereNotIn would
  // evaluate unknown against a NULL status and wrongly refuse this row too.
  expect(body.updated.sort()).toEqual(['child-null-status', 'parent']);
  expect(body.failed).toHaveLength(3);
  expect(body.failed.map((f) => f.id).sort()).toEqual(['child-cancelled', 'child-completed', 'child-noshow']);
  for (const f of body.failed) expect(f.reason).toMatch(/already \w+/);
  expect(stamps).toHaveLength(2);
  for (const s of stamps) expect(s.u.prepaid_amount).toBe(360);
});
