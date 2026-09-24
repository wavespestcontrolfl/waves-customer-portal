/**
 * Audit repro r2-tech-reachable-leftovers-dispatch-protocols-3
 *
 * GET /api/admin/schedule/:id/estimate-source is technician-reachable
 * (router.use(adminAuthenticate, requireTechOrAdmin) + ownership check only)
 * and serialises `estimateToken: est.token` — the permanent public bearer
 * token for /api/estimates/:token/* (accept, select-tier, bond, preferences,
 * change-request, extension-request). admin-customers.js strips `estimates`
 * from the tech 360 payload for exactly this reason (TECH_360_STRIPPED_KEYS).
 *
 * Expected: a technician response omits estimateToken. An admin response may
 * keep it. Asserting the expected contract — FAILS on current code if the bug
 * is real.
 *
 * Pattern copied from server/tests/admin-tech-role-scoping.test.js (real
 * requireTechOrAdmin, stubbed adminAuthenticate, where-aware db fake).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockCurrentRole = 'technician';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/estimate-deposits', () => ({
  summarizeEstimateDeposit: jest.fn(async () => ({ required: false, amount: 0 })),
}));
jest.mock('../services/estimate-payment-context', () => ({
  buildEstimatePaymentContext: jest.fn(async () => ({ posture: 'none' })),
}));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-1', role: mockCurrentRole };
      req.technicianId = 'tech-1';
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});

jest.mock('../models/db', () => {
  const state = { scheduledServices: [], estimates: [], writes: [] };
  const normCol = (c) => String(c).replace(/^scheduled_services\./, '');
  const cmp = (a, op, v) => {
    if (op === '>') return a > v;
    if (op === '>=') return a >= v;
    if (op === '<') return a < v;
    if (op === '<=') return a <= v;
    return a === v;
  };
  const dbFn = (table) => {
    const builder = {
      _where: {},
      _cmp: [],
      _notIn: [],
      _count: false,
      where(w, op, val) {
        if (w && typeof w === 'object') Object.assign(builder._where, w);
        else if (val !== undefined) builder._cmp.push([w, op, val]);
        else builder._where[w] = op;
        return builder;
      },
      andWhere(...args) { return builder.where(...args); },
      whereNot(col, val) { builder._notIn.push([col, [val]]); return builder; },
      whereNotIn(col, vals) { builder._notIn.push([col, vals]); return builder; },
      whereIn() { return builder; },
      modify(cb) { cb(builder); return builder; },
      leftJoin() { return builder; },
      forUpdate() { return builder; },
      orderBy() { return builder; },
      select() { return builder; },
      countDistinct() { builder._count = true; return builder; },
      whereNull(col) { builder._cmp.push([col, 'null', null]); return builder; },
      _rows() {
        const rows = table === 'scheduled_services' ? state.scheduledServices
          : table === 'estimates' ? state.estimates : [];
        return rows.filter((r) =>
          Object.entries(builder._where).every(([k, v]) => r[normCol(k)] === v)
          && builder._cmp.every(([c, op, v]) => (op === 'null' ? r[normCol(c)] == null : cmp(r[normCol(c)], op, v)))
          && builder._notIn.every(([c, vals]) => !vals.includes(r[normCol(c)])));
      },
      async first() {
        if (builder._count) return { n: builder._rows().length };
        const found = builder._rows()[0];
        return found ? { ...found } : undefined;
      },
      then(resolve, reject) { return Promise.resolve(builder._rows()).then(resolve, reject); },
      catch(fn) { return Promise.resolve(builder._rows()).catch(fn); },
      async update(u) { state.writes.push({ table, op: 'update', u }); return 0; },
      async insert(r) { state.writes.push({ table, op: 'insert', r }); return [1]; },
      async del() { state.writes.push({ table, op: 'del' }); return 0; },
    };
    return builder;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => {
    const trx = (table) => dbFn(table);
    trx.raw = async () => ({});
    return cb(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');
const scheduleRouter = require('../routes/admin-schedule');

const daysFromNow = (n) => etDateString(addETDays(new Date(), n));

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

beforeEach(() => {
  mockCurrentRole = 'technician';
  db.__state.scheduledServices = [
    { id: 'svc-own', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed',
      scheduled_date: daysFromNow(0), source_estimate_id: 'est-1', recurring_parent_id: null, service_type: 'pest_control' },
  ];
  db.__state.estimates = [
    { id: 'est-1', customer_id: 'cust-1', token: 'tok_public_bearer', estimate_data: '{}', estimate_slug: 'EST-2026-0001',
      monthly_total: 89, annual_total: 0, onetime_total: 0, bill_by_invoice: false,
      created_at: new Date('2026-09-01T12:00:00Z'), status: 'accepted', service_interest: null, waveguard_tier: null },
  ];
  db.__state.writes = [];
});

describe('GET /:id/estimate-source — technician projection', () => {
  test('a technician on their own visit gets the provenance card but NOT the public bearer token', async () => {
    const { status, body } = await get('/api/admin/schedule/svc-own/estimate-source');
    expect(status).toBe(200);
    expect(body.linked).toBe(true);
    expect(body.estimateId).toBe('est-1');
    // The public bearer token authorizes /api/estimates/:token/* customer
    // actions with no auth of its own — office-only, same rule as
    // TECH_360_STRIPPED_KEYS 'estimates' in admin-customers.js.
    expect(body.estimateToken).toBeUndefined();
  });

  test('control: an admin still receives estimateToken (sanity that the field is real)', async () => {
    mockCurrentRole = 'admin';
    const { status, body } = await get('/api/admin/schedule/svc-own/estimate-source');
    expect(status).toBe(200);
    expect(body.estimateToken).toBe('tok_public_bearer');
  });
});
