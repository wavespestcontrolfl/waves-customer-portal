// Audit repro r2-tech-reachable-leftovers-dispatch-protocols-4:
// GET /api/admin/timetracking/ (requireTechOrAdmin) returns every coworker's
// time_entry_daily_summary.* (revenue_generated, rpmh_actual, overtime_minutes,
// status/approved_by/notes) and raw active time_entries.* (clock_in_lat/lng,
// clock_in_address, pay_type, edit_reason, approval_notes) to a technician
// token, while the sibling /daily, /entries, /weekly, /analytics reads of the
// same rows are requireAdmin. Only technicians.pay_rate is stripped.
//
// Assertions state the EXPECTED (projected) behaviour, so this test FAILS on
// current code; the failure output shows the leaked values.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const OTHER_TECH = 'tech-OTHER';
const CALLER_TECH = 'tech-CALLER';

const SHIFT_ROW = {
  id: 'entry-shift-1',
  technician_id: OTHER_TECH,
  entry_type: 'shift',
  status: 'active',
  clock_in: '2026-09-23T12:01:00Z',
  clock_in_lat: 27.3364,
  clock_in_lng: -82.5307,
  clock_in_address: '742 Evergreen Terrace, Sarasota, FL',
  pay_type: 'hourly',
  notes: 'late — car trouble',
  edit_reason: 'admin fixed clock-in',
  edited_by: 'admin-1',
  approval_status: 'pending',
  approval_notes: 'verify with GPS before approving',
  tech_name: 'Other Tech',
};

const SUMMARY_ROW = {
  id: 'daily-1',
  technician_id: OTHER_TECH,
  work_date: '2026-09-23',
  total_shift_minutes: 480,
  overtime_minutes: 90,
  utilization_pct: 71.5,
  revenue_generated: 1250,
  rpmh_actual: 156.25,
  status: 'rejected',
  approved_by: 'admin-1',
  notes: 'rejected: missing job entries',
  tech_name: 'Other Tech',
};

jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const chain = { _table: table, _where: [] };
    for (const m of ['leftJoin', 'select', 'orderBy', 'whereIn', 'whereNotNull', 'whereRaw']) {
      chain[m] = jest.fn(() => chain);
    }
    chain.where = jest.fn((...args) => { chain._where.push(args); return chain; });
    const rows = () => {
      const w0 = chain._where[0] && chain._where[0][0];
      if (table === 'time_entries' && w0 && w0.entry_type === 'shift') return [SHIFT_ROW];
      if (table === 'time_entry_daily_summary') return [SUMMARY_ROW];
      if (table === 'technicians') {
        return [
          { id: OTHER_TECH, name: 'Other Tech', role: 'technician' },
          { id: CALLER_TECH, name: 'Caller Tech', role: 'technician' },
        ];
      }
      return [];
    };
    // job / break lookups use .first(); shift + summaries + technicians are awaited.
    chain.first = jest.fn(async () => undefined);
    chain.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
    chain.catch = (reject) => Promise.resolve(rows()).catch(reject);
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

// Real admin-auth semantics for a technician-role staff token: passes
// adminAuthenticate + requireTechOrAdmin, fails requireAdmin with 403.
// req.technician mirrors what adminAuthenticate attaches (isAdminCaller reads it).
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-CALLER';
    req.techRole = 'technician';
    req.technician = { id: 'tech-CALLER', role: 'technician', employment_status: 'active' };
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole !== 'admin' ? res.status(403).json({ error: 'Admin access required' }) : next()),
  requireTechOrAdmin: (req, res, next) => (['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })),
}));

const express = require('express');
const router = require('../routes/admin-timetracking');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/timetracking', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

describe('r2-tech-reachable-leftovers-dispatch-protocols-4: GET /api/admin/timetracking with a technician token', () => {
  test('control: the sibling reads of the same rows are owner-only (403 for a technician)', async () => {
    await withServer(async (baseUrl) => {
      for (const p of ['/daily', '/entries', '/weekly', '/analytics']) {
        const r = await fetch(`${baseUrl}/admin/timetracking${p}`);
        expect([p, r.status]).toEqual([p, 403]);
      }
    });
  });

  test('dashboard projects out coworker payroll/performance/approval and raw entry columns for a technician caller', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/timetracking`);
      expect(res.status).toBe(200);
      const body = await res.json();

      // The row belongs to a DIFFERENT technician than the caller.
      expect(body.todaySummaries[0].technician_id).toBe(OTHER_TECH);
      expect(body.activeShifts[0].technician_id).toBe(OTHER_TECH);

      // pay_rate IS stripped (the one projection the handler does).
      for (const t of body.allTechs) expect(t).not.toHaveProperty('pay_rate');

      // EXPECTED: daily-summary money / performance / approval columns absent
      // for a non-admin caller (these are the rows /daily keeps requireAdmin).
      const leakedSummary = {};
      for (const k of ['revenue_generated', 'rpmh_actual', 'overtime_minutes', 'utilization_pct', 'status', 'approved_by', 'notes']) {
        if (body.todaySummaries[0][k] !== undefined) leakedSummary[k] = body.todaySummaries[0][k];
        if (body.weekDailies[0][k] !== undefined) leakedSummary[`week.${k}`] = body.weekDailies[0][k];
      }
      // EXPECTED: raw time_entries columns absent from the live roster.
      const leakedShift = {};
      for (const k of ['clock_in_lat', 'clock_in_lng', 'clock_in_address', 'pay_type', 'notes', 'edit_reason', 'edited_by', 'approval_status', 'approval_notes']) {
        if (body.activeShifts[0][k] !== undefined) leakedShift[k] = body.activeShifts[0][k];
      }

      expect({ leakedSummary, leakedShift }).toEqual({ leakedSummary: {}, leakedShift: {} });
    });
  });
});
