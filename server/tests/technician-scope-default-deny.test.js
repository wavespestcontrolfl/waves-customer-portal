// Technician reach is an allow-list behind GATE_STAFF_DEFAULT_DENY (owner
// 2026-10-02). Enforced inside adminAuthenticate, the chokepoint every staff
// route shares, so a router that forgot requireAdmin is still closed.
//
// Gate ON: a technician gets 403 TECHNICIAN_SCOPE on any route off the list,
// before the handler runs; admins are untouched. Gate OFF: nothing is denied
// and a would-deny line is logged once per route shape.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
let mockGateOn = false;
jest.mock('../config/feature-gates', () => ({ isEnabled: (g) => (g === 'staffDefaultDeny' ? mockGateOn : false) }));

const jwt = require('jsonwebtoken');
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const scope = require('../middleware/technician-scope');

const tokenFor = (id) => `Bearer ${jwt.sign({ technicianId: id, type: 'access', tokenVersion: 1 }, 'test-secret')}`;
const TECH = { id: 'tech-1', employment_status: 'active', role: 'technician', auth_token_version: 1 };
const ADMIN = { id: 'admin-1', employment_status: 'active', role: 'admin', auth_token_version: 1 };

function mockStaff(rows) {
  db.mockImplementation(() => ({ where: jest.fn(({ id }) => ({ first: jest.fn(async () => rows.find((r) => r.id === id) || null) })) }));
}

// A miniature staff surface shaped like the real one: a router that forgot
// requireAdmin, mounted under /api/admin.
function withServer(fn) {
  const app = express();
  const forgotten = express.Router();
  forgotten.use(adminAuthenticate, requireTechOrAdmin);
  forgotten.get('/', (_req, res) => res.json({ ok: 'listed' }));
  forgotten.post('/:id/verify', (_req, res) => res.json({ ok: 'verified' }));
  app.use('/api/admin/kb', forgotten);
  const sched = express.Router();
  sched.use(adminAuthenticate, requireTechOrAdmin);
  sched.get('/week', (_req, res) => res.json({ ok: 'week' }));
  app.use('/api/admin/schedule', sched);
  const rec = express.Router();
  rec.use(adminAuthenticate, requireTechOrAdmin);
  rec.get('/recordings', (_req, res) => res.json({ ok: 'recordings' }));
  rec.get('/commitments/open', (_req, res) => res.json({ ok: 'promises' }));
  app.use('/api/admin/call-recordings', rec);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

const call = (base, auth, method, path) => fetch(`${base}${path}`, { method, headers: { Authorization: auth } });

beforeEach(() => {
  jest.clearAllMocks();
  scope._shadowLoggedForTests.clear();
  mockStaff([TECH, ADMIN]);
});

describe('matcher', () => {
  test.each([
    ['GET', '/api/admin/schedule/week', true],
    ['POST', '/api/admin/schedule/11111111-2222-4333-8444-555555555555/update-details', true],
    ['GET', '/api/admin/kb', true],
    // /knowledge/queries matches the read pattern but the route itself is requireAdmin.
    ['GET', '/api/admin/kb/11111111-2222-4333-8444-555555555555', true],
    ['POST', '/api/admin/kb', false],
    ['POST', '/api/admin/kb/11111111-2222-4333-8444-555555555555/verify', false],
    ['GET', '/api/admin/call-recordings/recordings', false],
    ['GET', '/api/admin/call-recordings/commitments/open', true],
    ['GET', '/api/admin/communications/log', true],
    ['GET', '/api/admin/communications/compliance-export', false],
    ['POST', '/api/admin/communications/call', false],
    ['POST', '/api/admin/communications/sms', true],
    ['GET', '/api/admin/communications/agent-draft', true],
    ['GET', '/api/admin/communications/stats', false],
    ['GET', '/api/dispatch/jobs', true],
    ['POST', '/api/admin/review-requests/trigger', true],
    ['GET', '/api/admin/estimates/11111111-2222-4333-8444-555555555555/schedule-source', false],
    ['POST', '/api/admin/estimator/property-lookup/verify', false],
    ['GET', '/api/admin/review-requests', false],
    ['GET', '/api/dispatch/routes', false],
    ['GET', '/api/dispatch/insights', false],
    ['GET', '/api/admin/equipment-systems/calibrations', true],
    ['PUT', '/api/admin/equipment-systems/calibrations/1/verify', false],
    ['GET', '/api/admin/inventory', true],
    ['POST', '/api/admin/inventory/1/adjust', false],
    ['GET', '/api/admin/dashboard', false],
    ['GET', '/api/ai/admin/calls', false],
    ['GET', '/api/tech/timetracking/entries', true],
    ['POST', '/api/admin/timesheets/approve', false],
    ['POST', '/api/admin/timesheets/dispute', true],
    ['GET', '/api/admin/auth/me', true],
    ['GET', '/api/admin/feature-flags', true],
    ['GET', '/api/admin/drafts', false],
    ['GET', '/api/admin/drafts/stats', true], // matches the single-draft shape; the router's requireAdmin still wins
    ['GET', '/api/admin/drafts/11111111-2222-4333-8444-555555555555', true],
    ['POST', '/api/stripe/terminal/handoff', true],
    ['POST', '/api/admin/consultations/11111111-2222-4333-8444-555555555555/outcome', true],
    ['GET', '/api/admin/consultations/stats', false],
    ['POST', '/api/stripe/terminal/capture', false],
    ['GET', '/api/admin/lawn-assessment/customers', true],
    ['POST', '/api/admin/lawn-assessment/assess', true],
    ['GET', '/api/admin/lawn-assessment/history/11111111-2222-4333-8444-555555555555', true],
    ['POST', '/api/admin/lawn-assessment/reset-baseline/11111111-2222-4333-8444-555555555555', false],
    ['GET', '/api/admin/wiki', true],
    ['GET', '/api/admin/wiki/termite/baiting', true],
    ['POST', '/api/admin/wiki/update/termite/baiting', false],
    ['POST', '/api/admin/wiki/generate', false],
    ['GET', '/api/jobs/11111111-2222-4333-8444-555555555555/visual-moments', true],
    ['PATCH', '/api/visual-moments/11111111-2222-4333-8444-555555555555/visibility', false],
    ['GET', '/api/admin/feature-flags/all', false],
    ['POST', '/api/admin/feature-flags/toggle', false],
  ])('%s %s → %s', (method, path, expected) => {
    expect(scope.technicianMayReach(method, path)).toBe(expected);
  });

  test('the shadow-log key carries no record identifiers (ids, SIDs, phone numbers, tokens)', () => {
    expect(scope.shadowKey('DELETE', '/api/admin/call-recordings/blocked/+15555550123')).toBe('DELETE /api/admin/call-recordings/blocked/:x');
    expect(scope.shadowKey('DELETE', '/api/admin/communications/blocked-numbers/%2B15555550123')).toBe('DELETE /api/admin/communications/blocked-numbers/:x');
    expect(scope.shadowKey('POST', '/api/admin/call-recordings/process/CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('POST /api/admin/call-recordings/process/:x');
    expect(scope.shadowKey('GET', '/api/admin/kb/11111111-2222-4333-8444-555555555555')).toBe('GET /api/admin/kb/:x');
    expect(scope.shadowKey('GET', '/api/admin/email/thread/someone@example.com')).toBe('GET /api/admin/email/thread/:x');
    expect(scope.shadowKey('GET', '/api/admin/kb/stats')).toBe('GET /api/admin/kb/stats');
  });

  test('a trailing slash does not widen or narrow the match', () => {
    const req = { baseUrl: '/api/admin/kb', path: '/' };
    expect(scope.normalizePath(req)).toBe('/api/admin/kb');
  });
});

describe('shadow log cap', () => {
  test('the set stops growing at the cap and says so once', () => {
    scope._shadowLoggedForTests.clear();
    const { info, warn } = logger;
    // Distinct lowercase route words (digits would collapse to :x).
    const word = (n) => n.toString(26).split('').map((c) => String.fromCharCode(97 + parseInt(c, 26))).join('');
    for (let i = 0; i < scope.SHADOW_LOG_CAP + 25; i += 1) {
      scope.enforceTechnicianScope({ techRole: 'technician', method: 'GET', baseUrl: `/api/admin/zz-${word(i)}`, path: '/' }, {});
    }
    expect(info.mock.calls.filter(([m]) => m.includes('would-deny technician')).length).toBe(scope.SHADOW_LOG_CAP);
    expect(warn.mock.calls.filter(([m]) => m.includes('reached')).length).toBe(1);
    scope._shadowLoggedForTests.clear();
  });
});

describe('gate ON', () => {
  beforeEach(() => { mockGateOn = true; });

  test('a technician is refused off-list routes before the handler, with the scope code', async () => {
    await withServer(async (base) => {
      const res = await call(base, tokenFor('tech-1'), 'POST', '/api/admin/kb/11111111-2222-4333-8444-555555555555/verify');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Admin access required', code: 'TECHNICIAN_SCOPE' });
      const rec = await call(base, tokenFor('tech-1'), 'GET', '/api/admin/call-recordings/recordings');
      expect(rec.status).toBe(403);
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('a technician still reaches listed routes, including router root paths', async () => {
    await withServer(async (base) => {
      expect(await (await call(base, tokenFor('tech-1'), 'GET', '/api/admin/kb')).json()).toEqual({ ok: 'listed' });
      expect(await (await call(base, tokenFor('tech-1'), 'GET', '/api/admin/schedule/week')).json()).toEqual({ ok: 'week' });
      expect(await (await call(base, tokenFor('tech-1'), 'GET', '/api/admin/call-recordings/commitments/open')).json()).toEqual({ ok: 'promises' });
    });
  });

  test('a non-admin role other than technician is also denied (default-deny, not keyed on one role)', async () => {
    const res = { status: jest.fn(function (c) { this.code = c; return this; }), json: jest.fn(function (b) { this.body = b; return this; }) };
    expect(scope.enforceTechnicianScope({ techRole: 'csr', method: 'GET', baseUrl: '/api/admin/kb', path: '/x/verify' }, res)).toBe(true);
    expect(res.code).toBe(403);
  });

  test('an admin is never affected', async () => {
    await withServer(async (base) => {
      expect(await (await call(base, tokenFor('admin-1'), 'POST', '/api/admin/kb/11111111-2222-4333-8444-555555555555/verify')).json()).toEqual({ ok: 'verified' });
      expect(await (await call(base, tokenFor('admin-1'), 'GET', '/api/admin/call-recordings/recordings')).json()).toEqual({ ok: 'recordings' });
    });
  });
});

describe('gate OFF (today)', () => {
  beforeEach(() => { mockGateOn = false; });

  test('nothing is denied; a would-deny line is logged once per route shape', async () => {
    await withServer(async (base) => {
      expect(await (await call(base, tokenFor('tech-1'), 'POST', '/api/admin/kb/11111111-2222-4333-8444-555555555555/verify')).json()).toEqual({ ok: 'verified' });
      expect(await (await call(base, tokenFor('tech-1'), 'POST', '/api/admin/kb/22222222-2222-4333-8444-555555555555/verify')).json()).toEqual({ ok: 'verified' });
      expect(await (await call(base, tokenFor('tech-1'), 'GET', '/api/admin/kb')).json()).toEqual({ ok: 'listed' });
    });
    const lines = logger.info.mock.calls.map(([m]) => m).filter((m) => m.includes('[staff-scope] would-deny'));
    expect(lines).toEqual([expect.stringContaining('POST /api/admin/kb/:x/verify')]);
    expect(lines[0]).not.toMatch(/1111|2222/);
  });
});
