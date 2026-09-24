/**
 * ADMIN-BUG-R35 (audit repro r1-sched-routes-1): PUT
 * /api/admin/dispatch/:serviceId/status with a TECHNICIAN token used to
 * cancel a visit assigned to ANOTHER technician (this_only and series
 * scope) and invoke the cancellation notice with sendNotification:true when
 * notifyCustomer was omitted.
 *
 * Fixed behaviour: completionOwnershipError, inserted right after the bare
 * id load, refuses with 403 service_not_assigned before any write. Pre-fix
 * this was 200 + a status transition + a customer cancellation text.
 *
 * Harness copied from series-cancel-prepaid-guard.test.js with the auth
 * stub switched to role='technician' id='tech-1'.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-1', role: 'technician' };
      req.technicianId = 'tech-1';
      req.techRole = 'technician';
      return next();
    },
  };
});
const mockTransitionJobStatus = jest.fn().mockResolvedValue({ ok: true, adminPayload: null });
jest.mock('../services/job-status', () => {
  const actual = jest.requireActual('../services/job-status');
  return { ...actual, transitionJobStatus: (...a) => mockTransitionJobStatus(...a) };
});
const mockHandleSeriesCancellation = jest.fn().mockResolvedValue(undefined);
const mockHandleCancellation = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/appointment-reminders', () => ({
  handleSeriesCancellation: (...a) => mockHandleSeriesCancellation(...a),
  handleCancellation: (...a) => mockHandleCancellation(...a),
}));
const mockRunFollowThrough = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/visit-cancellation-followthrough', () => ({
  runVisitCancellationFollowThrough: (...a) => mockRunFollowThrough(...a),
}));

jest.mock('../models/db', () => {
  const state = { rows: [], invoices: [], terms: [], pendingTerms: [], writes: [], reads: [] };
  const makeBuilder = (table) => {
    const b = {
      _where: {},
      where(w, op, val) {
        if (typeof w === 'function') { w.call(b); return b; }
        if (w && typeof w === 'object') Object.assign(b._where, w);
        else if (val === undefined) b._where[String(w).replace(/^scheduled_services\./, '')] = op;
        else (b._cmp ||= []).push([String(w).replace(/^scheduled_services\./, ''), op, val]);
        return b;
      },
      andWhere(...a) { return b.where(...a); },
      orWhere() { return b; },
      whereIn() { return b; },
      whereNotIn(col, vals) { if (String(col).replace(/^scheduled_services\./, '') === 'status') b._statusNotIn = vals; return b; },
      orWhereNotIn(col, vals) { if (col === 'status') b._statusNotIn = vals; return b; },
      whereNot() { return b; },
      whereNull(col) { (b._nullCols ||= []).push(String(col).replace(/^scheduled_services\./, '')); return b; },
      whereNotNull() { return b; },
      leftJoin() { return b; },
      whereRaw() { return b; },
      whereNotExists() { return b; },
      orderBy() { return b; },
      forUpdate() { return b; },
      modify(cb) { cb(b); return b; },
      select() { return b; },
      async first() {
        const rows = table === 'scheduled_services' ? state.rows : table === 'invoices' ? state.invoices : [];
        const cmp = (a, op, v) => (op === '>=' ? a >= v : op === '>' ? a > v : op === '<=' ? a <= v : op === '<' ? a < v : a === v);
        const found = rows.find((r) => Object.entries(b._where).every(([k, v]) => r[k] === v)
          && (b._cmp || []).every(([c, op, v]) => cmp(r[c], op, v))
          && !(b._statusNotIn && b._statusNotIn.includes(r.status)));
        state.reads.push({ table, where: { ...b._where }, cmp: b._cmp || [], notIn: b._statusNotIn || null });
        return found ? { ...found } : undefined;
      },
      async columnInfo() { return { recurring_ongoing: {} }; },
      update(u) {
        state.writes.push({ table, op: 'update', u });
        return { returning: async () => [], then: (res, rej) => Promise.resolve(1).then(res, rej) };
      },
      insert(r) {
        state.writes.push({ table, op: 'insert', r });
        return { returning: async () => [{ id: 'x' }], then: (res, rej) => Promise.resolve([1]).then(res, rej) };
      },
      then(resolve, reject) {
        const rows = table === 'scheduled_services' ? state.rows.map((r) => ({ ...r }))
          : table === 'invoices' ? state.invoices.map((r) => ({ ...r }))
          : table === 'annual_prepay_terms as t' ? []
          : table === 'annual_prepay_terms' ? [] : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return b;
  };
  const dbFn = (table) => makeBuilder(table);
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = async () => ({});
  dbFn.schema = { hasTable: async () => true };
  dbFn.transaction = async (cb) => {
    state.writes.push({ table: '<trx>', op: 'begin' });
    const trx = (table) => makeBuilder(table);
    trx.fn = dbFn.fn; trx.raw = async () => ({}); trx.schema = dbFn.schema;
    try { const out = await cb(trx); state.writes.push({ table: '<trx>', op: 'commit' }); return out; }
    catch (e) { state.writes.push({ table: '<trx>', op: 'rollback' }); throw e; }
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
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

const future = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

function seed() {
  db.__state.rows = [
    // Assigned to tech-2 — NOT the requesting tech-1. Recurring parent so scope:'series' is accepted.
    { id: 'svc-other', technician_id: 'tech-2', customer_id: 'cust-other', status: 'confirmed', scheduled_date: future(3), service_type: 'Pest Control', is_recurring: true, recurring_pattern: 'quarterly', recurring_parent_id: null, recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null, source_action: null, customer_confirmed: true },
    { id: 'svc-other-child', technician_id: 'tech-2', customer_id: 'cust-other', status: 'pending', scheduled_date: future(93), service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 'svc-other', recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null, source_action: null, customer_confirmed: true },
  ];
  db.__state.writes = []; db.__state.reads = [];
  mockTransitionJobStatus.mockClear(); mockHandleCancellation.mockClear(); mockHandleSeriesCancellation.mockClear(); mockRunFollowThrough.mockClear();
}

async function put(id, body) {
  const res = await fetch(`${baseUrl}/api/admin/dispatch/${id}/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('technician token cancelling ANOTHER technician\'s visit via dispatch status route', () => {
  test('this_only cancel with notifyCustomer omitted — refused 403, no writes', async () => {
    seed();
    const { status, body } = await put('svc-other', { status: 'cancelled' });
    // Surface what actually happened for the report
     
    console.log('this_only →', status, JSON.stringify(body), 'transition calls:', mockTransitionJobStatus.mock.calls.length,
      'handleCancellation:', JSON.stringify(mockHandleCancellation.mock.calls.map((c) => [c[0], { sendNotification: c[1]?.sendNotification }])),
      'followThrough:', mockRunFollowThrough.mock.calls.length,
      'lookup read:', JSON.stringify(db.__state.reads[0]));
    expect(status).toBe(403);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
  });

  test('series cancel with notifyCustomer omitted — refused 403, no writes', async () => {
    seed();
    const { status, body } = await put('svc-other', { status: 'cancelled', scope: 'series' });
     
    console.log('series →', status, JSON.stringify(body), 'transition calls:', mockTransitionJobStatus.mock.calls.length,
      'handleSeriesCancellation:', JSON.stringify(mockHandleSeriesCancellation.mock.calls.map((c) => [c[0], c[1], { sendNotification: c[2]?.sendNotification }])),
      'recurring_ongoing writes:', JSON.stringify(db.__state.writes.filter((w) => w.u && 'recurring_ongoing' in w.u)),
      'followThrough targets:', JSON.stringify(mockRunFollowThrough.mock.calls.map((c) => c[0]?.targetIds)));
    expect(status).toBe(403);
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockHandleSeriesCancellation).not.toHaveBeenCalled();
  });
});
