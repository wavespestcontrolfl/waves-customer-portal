/**
 * AUDIT REPRO r1-agents-ai-1 — admin-assessment-analytics mounts only
 * adminAuthenticate (routes/admin-assessment-analytics.js:16), which accepts
 * role='technician' (middleware/admin-auth.js:42). GET /roi (revenue-per-
 * customer aggregates from payments) and POST /compute (analytics.runAll,
 * the weekly cron's job, rewriting five analytics tables) therefore answer a
 * technician token. Only PATCH /contradictions/:id (line 212) is requireAdmin.
 *
 * Uses the REAL admin-auth middleware with a REAL signed staff JWT; only the
 * DB and the analytics service are mocked. Tests assert the expected
 * (owner-only) contract, so failures demonstrate the bug; the control tests
 * (admin 200, technician 403 on the guarded PATCH) prove the harness works.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/agronomic-wiki', () => ({ recomputeEntryReviewGate: jest.fn(async () => {}) }));
jest.mock('../services/assessment-analytics', () => ({
  runAll: jest.fn(async () => ({ efficacy: 'ran', protocol: 'ran', completion: 'ran', benchmarks: 'ran', contradictions: 'ran' })),
  computeROI: jest.fn(async () => ({
    assessedCustomers: 10, nonAssessedCustomers: 40,
    assessedRetention: 80, nonAssessedRetention: 60,
    assessedAvgRevenue: 1234, nonAssessedAvgRevenue: 456,
    improvementBuckets: { bigImprovers: 1, smallImprovers: 2, decliners: 0 }, retentionDelta: null,
  })),
  computeProductEfficacy: jest.fn(async () => ({})),
  computeProtocolPerformance: jest.fn(async () => ({})),
  computeCompletionRates: jest.fn(async () => ({})),
  detectContradictions: jest.fn(async () => ({})),
  getTechCalibrationSummary: jest.fn(async () => ({})),
  getTechFieldContext: jest.fn(async () => ({ notes: [] })),
}));
jest.mock('../models/db', () => {
  const state = { techs: {} };
  const dbFn = (table) => {
    const b = { _where: {} };
    for (const m of ['whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orderBy', 'limit', 'select', 'returning']) b[m] = () => b;
    b.where = (w) => { if (w && typeof w === 'object') Object.assign(b._where, w); return b; };
    b.first = async () => (table === 'technicians' ? state.techs[b._where.id] || null : null);
    b.update = () => b;
    b.then = (res, rej) => Promise.resolve([]).then(res, rej);
    return b;
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const analytics = require('../services/assessment-analytics');
const router = require('../routes/admin-assessment-analytics');

db.__state.techs = {
  'tech-1': { id: 'tech-1', name: 'Field Tech', role: 'technician', employment_status: 'active', auth_token_version: 1, must_change_password: false },
  'admin-1': { id: 'admin-1', name: 'Owner', role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false },
};
const token = (id) => jwt.sign({ technicianId: id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/assessment-analytics', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { analytics.runAll.mockClear(); analytics.computeROI.mockClear(); });

async function call(method, path, who, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(who)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: json };
}

test('control: admin token reads GET /roi (200 with revenue fields)', async () => {
  const r = await call('GET', '/api/admin/assessment-analytics/roi', 'admin-1');
  expect(r.status).toBe(200);
  expect(r.body.assessedAvgRevenue).toBe(1234);
});

test('control: technician token is refused on the one guarded route PATCH /contradictions/:id (403)', async () => {
  const r = await call('PATCH', '/api/admin/assessment-analytics/contradictions/c1', 'tech-1', { status: 'resolved' });
  expect(r.status).toBe(403);
});

test('technician token on GET /roi: expected 403, no revenue aggregates returned', async () => {
  const r = await call('GET', '/api/admin/assessment-analytics/roi', 'tech-1');
   
  console.log('[repro] technician GET /roi →', r.status, JSON.stringify(r.body));
  expect(r.status).toBe(403);
  expect(analytics.computeROI).not.toHaveBeenCalled();
});

test('technician token on POST /compute: expected 403, runAll never invoked', async () => {
  const r = await call('POST', '/api/admin/assessment-analytics/compute', 'tech-1', {});
   
  console.log('[repro] technician POST /compute →', r.status, JSON.stringify(r.body));
  expect(r.status).toBe(403);
  expect(analytics.runAll).not.toHaveBeenCalled();
});

test('control: GET /tech-context/:customerId stays technician-reachable (the one tech-portal-facing route in this file)', async () => {
  const r = await call('GET', '/api/admin/assessment-analytics/tech-context/cust-1', 'tech-1');
  expect(r.status).toBe(200);
  expect(analytics.getTechFieldContext).toHaveBeenCalledWith('cust-1');
});
