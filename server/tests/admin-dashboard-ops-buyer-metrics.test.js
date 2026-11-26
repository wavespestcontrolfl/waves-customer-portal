/**
 * GET /api/admin/dashboard/ops-buyer-metrics: admin only (a technician gets 403 and nothing is read), calls the
 * service with the app db, and returns its payload as is. The formulas and the SQL are covered by
 * ops-buyer-metrics.test.js and ops-buyer-metrics-postgres.test.js. Synthetic numbers only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: () => {} }));
jest.mock('../models/db', () => jest.fn());
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
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const PAYLOAD = {
  generatedFor: '2026-11-26',
  errors: {},
  ownerReliance: null,
  revenuePerRouteDay: null,
  routeFill: { scheduledStops: 24, routeDaysAvailable: 4, fillRatio: 0.5, label: 'planning only, not a pay target' },
  returnVisitRate: null,
};
const mockBuild = jest.fn(async () => PAYLOAD);
jest.mock('../services/ops-buyer-metrics', () => ({
  buildOpsBuyerMetrics: (...a) => mockBuild(...a),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-dashboard');

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dashboard', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

// A distinct query string per call: the route caches 60 s per URL and user.
let seq = 0;
const get = async (token) => {
  seq += 1;
  const res = await fetch(`${base}/api/admin/dashboard/ops-buyer-metrics?n=${seq}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { mockBuild.mockClear(); });

describe('GET /api/admin/dashboard/ops-buyer-metrics', () => {
  test('a technician gets 403 and nothing is read', async () => {
    const { status, body } = await get('tech');
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'Admin access required' });
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('no login gets 401', async () => {
    expect((await get(null)).status).toBe(401);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('an admin gets the service payload as is, built from the app db', async () => {
    const { status, body } = await get('admin');
    expect(status).toBe(200);
    expect(body).toEqual(PAYLOAD);
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(mockBuild.mock.calls[0][0].db).toBe(db);
  });

  test('a service failure passes to the error handler, not a crash', async () => {
    mockBuild.mockRejectedValueOnce(new Error('boom'));
    const { status, body } = await get('admin');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'boom' });
  });
});
