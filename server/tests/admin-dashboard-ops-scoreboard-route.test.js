/**
 * GET /api/admin/dashboard/ops-scoreboard — auth + date validation.
 *
 * Uses the REAL middleware/admin-auth (real JWT signed with JWT_SECRET, db
 * mocked to return an active technician/admin row) so the router's actual
 * guard chain (router.use(adminAuthenticate, requireAdmin), admin-dashboard.js
 * top of file) is exercised — same pattern as
 * admin-dashboard-ops-bi-tech-authz.test.js. computeOpsScoreboard itself is
 * mocked: its own logic is covered by ops-scoreboard.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: () => {} }));

const mockCompute = jest.fn(async () => ({
  window: { from: '2026-09-19', to: '2026-09-25' },
  driveMinutesPerStop: { numerator: 0, denominator: 0, share: null },
  aiCallShare: { numerator: 0, denominator: 0, share: null },
  bookingsWithoutStaff: { numerator: 0, denominator: 0, share: null },
  aiRouteDays: { numerator: 0, denominator: 0, share: null },
  notes: [],
}));
jest.mock('../services/ops-scoreboard', () => ({ computeOpsScoreboard: (...a) => mockCompute(...a) }));

let mockTechRow = { id: 'admin-1', role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false };
jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    if (table === 'technicians') {
      return { where: () => ({ first: async () => mockTechRow }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return dbFn;
});

const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../routes/admin-dashboard');

const adminToken = jwt.sign({ type: 'access', tokenVersion: 1, technicianId: 'admin-1', scope: 'staff' }, process.env.JWT_SECRET);
const techToken = jwt.sign({ type: 'access', tokenVersion: 1, technicianId: 'tech-1', scope: 'staff' }, process.env.JWT_SECRET);

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dashboard', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  mockCompute.mockClear();
  mockTechRow = { id: 'admin-1', role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false };
});

test('no bearer token -> 401, computeOpsScoreboard never called', async () => {
  const res = await fetch(`${base}/api/admin/dashboard/ops-scoreboard`);
  expect(res.status).toBe(401);
  expect(mockCompute).not.toHaveBeenCalled();
});

test('a technician (non-admin) role is refused 403 — owner-only like /core-kpis', async () => {
  mockTechRow = { id: 'tech-1', role: 'technician', employment_status: 'active', auth_token_version: 1, must_change_password: false };
  const res = await fetch(`${base}/api/admin/dashboard/ops-scoreboard`, { headers: { Authorization: `Bearer ${techToken}` } });
  const body = await res.json();
  expect({ status: res.status, body, calls: mockCompute.mock.calls.length }).toEqual({
    status: 403, body: { error: 'Admin access required' }, calls: 0,
  });
});

test('an admin with no from/to gets the default-window scoreboard', async () => {
  const res = await fetch(`${base}/api/admin/dashboard/ops-scoreboard`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.window).toEqual({ from: '2026-09-19', to: '2026-09-25' });
  expect(mockCompute).toHaveBeenCalledWith({ from: undefined, to: undefined });
});

test('a valid from/to range is passed through', async () => {
  const res = await fetch(`${base}/api/admin/dashboard/ops-scoreboard?from=2026-08-01&to=2026-08-31`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status).toBe(200);
  expect(mockCompute).toHaveBeenCalledWith({ from: '2026-08-01', to: '2026-08-31' });
});

test.each([
  ['from', 'not-a-date'],
  ['to', '2026-13-40'],
  ['from', '2026-02-30'],
])('an invalid %s= value is rejected with 400 before computeOpsScoreboard runs', async (param, value) => {
  const res = await fetch(`${base}/api/admin/dashboard/ops-scoreboard?${param}=${value}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(res.status).toBe(400);
  expect(body.error).toMatch(/valid YYYY-MM-DD/);
  expect(mockCompute).not.toHaveBeenCalled();
});
