// Owner 2026-11-04 (technician visibility, "Own hours only"): the Staff
// dashboard read gives a technician its own clock state and hours, never a
// coworker's. An admin still reads every row.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockCalls = [];
jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const chain = { _table: table };
    for (const m of ['leftJoin', 'select', 'orderBy', 'whereIn', 'whereNotNull', 'whereRaw']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.where = jest.fn((...args) => { mockCalls.push([table, ...args]); return chain; });
    chain.first = jest.fn(async () => undefined);
    chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    chain.catch = (reject) => Promise.resolve([]).catch(reject);
    return chain;
  };
  const fn = jest.fn((table) => makeChain(table));
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW') };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (k, f) => f) }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    const role = global.__dashRole || 'technician';
    req.technicianId = role === 'admin' ? 'admin-1' : 'tech-CALLER';
    req.techRole = role;
    req.technician = { id: req.technicianId, role, employment_status: 'active' };
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole !== 'admin' ? res.status(403).json({ error: 'Admin access required' }) : next()),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const express = require('express');
const router = require('../routes/admin-timetracking');

async function readDashboard(role) {
  global.__dashRole = role;
  mockCalls.length = 0;
  const app = express();
  app.use('/admin/timetracking', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/timetracking`);
    expect(res.status).toBe(200);
    return mockCalls.map((c) => c.slice());
  } finally {
    await new Promise((r) => server.close(r));
    delete global.__dashRole;
  }
}

const ownFilters = (calls, table, column) => calls.filter((c) => c[0] === table && c[1] === column);

describe('GET /api/admin/timetracking: own rows only for a technician', () => {
  test('a technician reads its own shift, today, week and technician row only', async () => {
    const calls = await readDashboard('technician');
    expect(ownFilters(calls, 'time_entries', 'time_entries.technician_id')).toEqual([['time_entries', 'time_entries.technician_id', 'tech-CALLER']]);
    expect(ownFilters(calls, 'time_entry_daily_summary', 'time_entry_daily_summary.technician_id')).toEqual([
      ['time_entry_daily_summary', 'time_entry_daily_summary.technician_id', 'tech-CALLER'],
      ['time_entry_daily_summary', 'time_entry_daily_summary.technician_id', 'tech-CALLER'],
    ]);
    expect(ownFilters(calls, 'technicians', 'id')).toEqual([['technicians', 'id', 'tech-CALLER']]);
  });

  test('an admin still reads every technician', async () => {
    const calls = await readDashboard('admin');
    expect(ownFilters(calls, 'time_entries', 'time_entries.technician_id')).toEqual([]);
    expect(ownFilters(calls, 'time_entry_daily_summary', 'time_entry_daily_summary.technician_id')).toEqual([]);
    expect(ownFilters(calls, 'technicians', 'id')).toEqual([]);
  });
});
