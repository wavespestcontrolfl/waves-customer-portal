/**
 * Custom dashboard range (?period=custom&from=YYYY-MM-DD) — the start date
 * must be a real calendar date. parseCustomRange used to accept anything
 * shaped like a date, so from=2026-09-31 went on to the routes' date binds.
 * Every custom-range route parses through it; this pins the core KPIs and
 * one attribution route.
 *
 * Same harness as admin-dashboard-ops-scoreboard-route.test.js: the REAL
 * admin-auth chain with a mocked technicians row, and a db mock that throws
 * on any other table — so "the handler reached its queries" shows up as a
 * recorded table, and a refused date records none.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: () => {} }));

const mockTables = [];
jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    if (table === 'technicians') {
      return {
        where: () => ({
          first: async () => ({ id: 'admin-1', role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false }),
        }),
      };
    }
    mockTables.push(table);
    throw new Error(`unexpected table ${table}`);
  });
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../routes/admin-dashboard');
const { errorHandler } = require('../middleware/errors');

const adminToken = jwt.sign({ type: 'access', tokenVersion: 1, technicianId: 'admin-1', scope: 'staff' }, process.env.JWT_SECRET);

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dashboard', router);
  app.use(errorHandler);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { mockTables.length = 0; });

async function get(path) {
  const res = await fetch(`${base}/api/admin/dashboard${path}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.each([
  ['/core-kpis', '2026-09-31'],
  ['/core-kpis', '2026-02-30'],
  ['/lead-funnel', '2026-09-31'],
])('%s refuses from=%s with a 400 before any query', async (route, from) => {
  const res = await get(`${route}?period=custom&from=${from}`);
  expect(res).toEqual({ status: 400, body: { error: 'from must be a valid YYYY-MM-DD calendar date' } });
  expect(mockTables).toEqual([]);
});

test('a malformed from is refused too, not silently swapped for the named period', async () => {
  const res = await get('/core-kpis?period=custom&from=2026-9-1');
  expect(res.status).toBe(400);
  expect(mockTables).toEqual([]);
});

test.each(['/core-kpis', '/lead-funnel'])('%s with a real calendar date reaches its queries', async (route) => {
  await get(`${route}?period=custom&from=2026-09-30`);
  expect(mockTables.length).toBeGreaterThan(0);
});

test('no from at all keeps the named period path', async () => {
  await get('/core-kpis?period=mtd');
  expect(mockTables.length).toBeGreaterThan(0);
});
