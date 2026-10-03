/**
 * /api/admin/rate-review — the APPLY lane's two routes (schedule + apply
 * holds). Admin-only, dark behind GATE_RATE_REVIEW: gate off = 404 before
 * any service call; a technician is 403; nothing approved is 409; a bad
 * planned send date is 400. The ranking routes keep their own suite
 * (admin-rate-review-route.test.js).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockScheduleNoticeRows = jest.fn();
const mockListApplyHolds = jest.fn();
const mockRetireDraftNotices = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/rate-review', () => ({ listBatches: jest.fn(), getBatch: jest.fn(), buildBatch: jest.fn(), loadConfig: jest.fn() }));
jest.mock('../services/rate-review-apply', () => ({
  scheduleNoticeRows: (...args) => mockScheduleNoticeRows(...args),
  listApplyHolds: (...args) => mockListApplyHolds(...args),
  retireDraftNotices: (...args) => mockRetireDraftNotices(...args),
}));

const express = require('express');
const router = require('../routes/admin-rate-review');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/rate-review', router);
  const server = app.listen(0, '127.0.0.1');
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return new Promise((resolve, reject) => {
    server.on('listening', async () => {
      try { resolve(await fn(base())); } catch (err) { reject(err); } finally { server.close(); }
    });
  });
}

async function call(base, method, path, { token = 'admin', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_RATE_REVIEW = 'true';
  mockScheduleNoticeRows.mockResolvedValue({
    ok: true, batchKey: '2026-12', batchId: 'b-1', plannedSendDate: '2026-11-02', approved: 3, created: 2, alreadyScheduled: 0,
    held: [{ rowId: 'r-3', customerId: 'c-3', familyKey: 'lawn_care', reason: 'no_future_visit', detail: null }],
    firstEffectiveDate: '2026-12-10', lastEffectiveDate: '2027-01-04', notices: [],
  });
  mockListApplyHolds.mockResolvedValue([{ noticeId: 'n-1', holdReason: 'rate_moved_since_notice' }]);
  mockRetireDraftNotices.mockResolvedValue({ ok: true, batchKey: '2026-12', retired: 2, keptDelivered: 1, revoked: 2 });
});

afterAll(() => { delete process.env.GATE_RATE_REVIEW; });

describe('gate off', () => {
  test.each([['POST', '/batches/2026-12/schedule'], ['DELETE', '/batches/2026-12/schedule'], ['GET', '/apply-holds']])('%s %s answers 404 and calls nothing', async (method, path) => {
    process.env.GATE_RATE_REVIEW = 'false';
    await withServer(async (base) => {
      const out = await call(base, method, `/api/admin/rate-review${path}`);
      expect(out.status).toBe(404);
      expect(out.body).toEqual({ error: 'Rate review is not enabled' });
    });
    expect(mockScheduleNoticeRows).not.toHaveBeenCalled();
    expect(mockListApplyHolds).not.toHaveBeenCalled();
    expect(mockRetireDraftNotices).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  test('unauthenticated → 401, technician → 403', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule', { token: null })).status).toBe(401);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule', { token: 'tech' })).status).toBe(403);
      expect((await call(base, 'GET', '/api/admin/rate-review/apply-holds', { token: 'tech' })).status).toBe(403);
    });
    expect(mockScheduleNoticeRows).not.toHaveBeenCalled();
  });
});

describe('POST /batches/:key/schedule', () => {
  test('creates draft notice rows for the approved rows and returns the counts and effective-date range', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule', { body: { plannedSendDate: '2026-11-02' } });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, batchKey: '2026-12', created: 2, alreadyScheduled: 0, firstEffectiveDate: '2026-12-10', lastEffectiveDate: '2027-01-04' });
      expect(out.body.held).toEqual([expect.objectContaining({ reason: 'no_future_visit' })]);
      expect(mockScheduleNoticeRows).toHaveBeenCalledWith('2026-12', { plannedSendDate: '2026-11-02', actorId: 'admin-1' });
    });
  });
  test('defaults the planned send date to today (service default) when none is posted', async () => {
    await withServer(async (base) => {
      await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule');
      expect(mockScheduleNoticeRows).toHaveBeenCalledWith('2026-12', { plannedSendDate: null, actorId: 'admin-1' });
    });
  });
  test('nothing approved → 409 with the reason', async () => {
    mockScheduleNoticeRows.mockResolvedValue({ ok: false, reason: 'nothing_approved', approved: 0 });
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule');
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ reason: 'nothing_approved', approved: 0 });
    });
  });
  test('bad key / bad date / service 400s and 404s pass through', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/dec-2026/schedule')).status).toBe(400);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule', { body: { plannedSendDate: '11/02/2026' } })).status).toBe(400);
      expect(mockScheduleNoticeRows).not.toHaveBeenCalled();
      const past = new Error('plannedSendDate must not be in the past');
      past.status = 400;
      mockScheduleNoticeRows.mockRejectedValueOnce(past);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule', { body: { plannedSendDate: '2026-01-01' } })).status).toBe(400);
      const missing = new Error('rate review batch not found');
      missing.status = 404;
      mockScheduleNoticeRows.mockRejectedValueOnce(missing);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule')).status).toBe(404);
    });
  });
  test('an unexpected service failure is a 500 with no detail leaked', async () => {
    mockScheduleNoticeRows.mockRejectedValueOnce(new Error('connection reset for customer 00000000-0000-4000-8000-000000000001'));
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/schedule');
      expect(out.status).toBe(500);
      expect(out.body).toEqual({ error: 'Could not schedule the rate review notices' });
    });
  });
});

describe('DELETE /batches/:key/schedule', () => {
  test('retires the draft rows and reports what was kept', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'DELETE', '/api/admin/rate-review/batches/2026-12/schedule');
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ ok: true, batchKey: '2026-12', retired: 2, keptDelivered: 1, revoked: 2 });
      expect(mockRetireDraftNotices).toHaveBeenCalledWith('2026-12');
      expect((await call(base, 'DELETE', '/api/admin/rate-review/batches/dec-2026/schedule')).status).toBe(400);
    });
  });
});

describe('GET /apply-holds', () => {
  test('lists the held notices', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'GET', '/api/admin/rate-review/apply-holds');
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ enabled: true, holds: [{ noticeId: 'n-1', holdReason: 'rate_moved_since_notice' }] });
    });
  });
});
