// Audit repro r1-inventory-time-2: GET /api/admin/timesheets/week-detail returns
// the raw technicians row (password_hash, password_reset_token_hash, ...).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({
  computeDailySummaryInTransaction: jest.fn(),
  computeWeeklySummary: jest.fn(),
  computeWeeklySummaryInTransaction: jest.fn(),
  isCompletedEntryIntervalValid: jest.fn(),
  lockStaffWeek: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.role = 'admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const http = require('http');
const db = require('../models/db');
const router = require('../routes/admin-timesheet-approval');

const TECH_ROW = {
  id: 'tech-1',
  name: 'Tech One',
  password_hash: '$2b$10$LEAKEDHASH',
  password_reset_token_hash: 'LEAKEDRESETHASH',
  password_reset_expires_at: '2030-01-01T00:00:00.000Z',
  auth_token_version: 7,
  must_change_password: true,
  pay_rate: 22.5,
  ssn_last4: '1234',
  dob: '1990-01-01',
};

// project() mimics real knex column selection — a fixed test double for a
// real SQL SELECT list, not a JS return-and-strip. This is the load-bearing
// bit of the harness: the fix under test (timesheet-approval.js) is
// `.first('id', 'name')`, a column-list SELECT, and the whole point of this
// regression is that unlisted columns never leave the database — a mock
// that ignored the column list back to the raw fixture would pass whether
// or not the fix was real.
function project(row, cols) {
  if (!row) return row;
  if (!cols || !cols.length) return { ...row };
  const out = {};
  for (const c of cols) if (c in row) out[c] = row[c];
  return out;
}
function chain(rows, first) {
  const c = { _cols: null };
  for (const m of ['where', 'whereIn', 'whereNot', 'whereRaw', 'orderBy', 'orderByRaw', 'leftJoin', 'forUpdate']) {
    c[m] = jest.fn(() => c);
  }
  c.select = jest.fn((...cols) => { c._cols = cols; return c; });
  c.first = jest.fn((...cols) => {
    if (cols.length) c._cols = cols;
    return Promise.resolve(project(first, c._cols));
  });
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

const WEEKLY = {
  id: 'w1', technician_id: 'tech-1', week_start: '2020-01-06', week_end: '2020-01-12',
  status: 'approved', total_shift_minutes: 600, total_job_minutes: 500, total_drive_minutes: 50,
  regular_minutes: 600, overtime_minutes: 0, days_worked: 2,
};

beforeEach(() => {
  db.mockImplementation((table) => {
    if (table === 'time_weekly_summary') return chain([WEEKLY], WEEKLY);
    if (table === 'time_entry_daily_summary') return chain([], undefined);
    if (table === 'time_entries') return chain([], undefined);
    if (table === 'technicians') return chain([TECH_ROW], TECH_ROW);
    throw new Error(`unexpected table ${table}`);
  });
});

test('week-detail must not ship technician credential columns', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/timesheets', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();
  const res = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/admin/timesheets/week-detail?technicianId=tech-1&weekStart=2020-01-06`, (r) => {
      let data = '';
      r.on('data', (c) => { data += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
    }).on('error', reject);
  });
  await new Promise((resolve) => server.close(resolve));
  expect(res.status).toBe(200);
   
  console.log('RESPONSE tech keys:', Object.keys(res.body.tech || {}));
  expect(res.body.tech).toBeDefined();
  expect(res.body.tech.password_hash).toBeUndefined();
  expect(res.body.tech.password_reset_token_hash).toBeUndefined();
  expect(res.body.tech.ssn_last4).toBeUndefined();
});
