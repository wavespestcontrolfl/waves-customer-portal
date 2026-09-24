/**
 * AUDIT REPRO r1-platform-2 — technician can read the owner's weekly BI
 * financial briefings and launch the paid BI agent run via
 * /api/admin/dashboard-ops/bi/*.
 *
 * Uses the REAL middleware/admin-auth (real JWT signed with JWT_SECRET, db
 * mocked to return an active role='technician' row) so the router's actual
 * guard chain (router.use(adminAuthenticate, requireTechOrAdmin), line 10)
 * is exercised. BIAgent is mocked so no Anthropic session / SMS fires.
 *
 * Expected (owner-only, like admin-dashboard.js:54 / admin-kpi-targets.js:27):
 * both routes answer 403 for a technician and never touch weekly_bi_reports
 * or BIAgent.run. Fails on current code if the bug is real.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: () => {} }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../utils/recruiting-thread-scope', () => ({ hideRecruitingThreadsFromNonAdmin: (q) => q, isRecruitingMessageType: () => false }));

const mockBiRun = jest.fn(async () => ({ success: true, report: 'MRR $12,345 ...' }));
jest.mock('../services/bi-agent', () => ({ run: (...a) => mockBiRun(...a) }));

const REPORT_ROW = {
  id: 'wbr-1', week_of: '2026-09-21', summary: 'MRR up 4%',
  revenue_section: { mrr: 12345, arr: 148140, revenueMTD: 5000 },
  customer_section: {}, ads_section: {}, anomalies_section: {}, action_items: [],
  created_at: '2026-09-21T09:00:00Z',
};
const weeklyReportReads = [];
jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    if (table === 'technicians') {
      return { where: () => ({ first: async () => ({ id: 'tech-1', role: 'technician', employment_status: 'active', auth_token_version: 1, must_change_password: false }) }) };
    }
    if (table === 'weekly_bi_reports') {
      weeklyReportReads.push(table);
      const q = { orderBy: () => q, limit: async () => [REPORT_ROW] };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  return dbFn;
});

const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../routes/admin-dashboard-ops');

const techToken = jwt.sign({ type: 'access', tokenVersion: 1, technicianId: 'tech-1', scope: 'staff' }, process.env.JWT_SECRET);

let server; let base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/admin/dashboard-ops', router);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { mockBiRun.mockClear(); weeklyReportReads.length = 0; });

test('technician GET /bi/reports is refused (403) and weekly_bi_reports is never read', async () => {
  const res = await fetch(`${base}/api/admin/dashboard-ops/bi/reports?limit=10`, { headers: { Authorization: `Bearer ${techToken}` } });
  const body = await res.json();
  expect({ status: res.status, reports: body.reports, reads: weeklyReportReads.length }).toEqual({ status: 403, reports: undefined, reads: 0 });
});

test('technician POST /bi/run is refused (403) and BIAgent.run is never invoked', async () => {
  const res = await fetch(`${base}/api/admin/dashboard-ops/bi/run`, { method: 'POST', headers: { Authorization: `Bearer ${techToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const body = await res.json();
  expect({ status: res.status, body, runCalls: mockBiRun.mock.calls.length }).toEqual({ status: 403, body: { error: 'Admin access required' }, runCalls: 0 });
});
