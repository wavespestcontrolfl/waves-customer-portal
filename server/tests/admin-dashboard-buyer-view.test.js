/**
 * GET /api/admin/dashboard/buyer-view: admin only (a technician gets 403 and nothing is read), returns the service's
 * payload as is, and a failure is a 500 (the service itself turns one tile's failure into { error } for that tile).
 * The math and the queries are covered by buyer-view.test.js and buyer-view-postgres.test.js. Synthetic numbers only.
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
  asOf: '2026-11-26',
  months: { count: 12, from: '2025-10-01', to: '2026-09-01' },
  revenue: { value: 120000, growthPct: 12.5, monthsCounted: 12 },
  recurring: { share: 61.2 },
  planRevenueKept: { pct: 94.1 },
  grossMargin: { bookPct: 48.3, perJobAtStandardPct: 55.1 },
  ownerProfit: { marginPct: 14.2, sde: 31000 },
  officeCost: { perStop: 11.5, pctOfRevenue: 8.1 },
};
const mockBuyerView = jest.fn(async () => PAYLOAD);
jest.mock('../services/buyer-view', () => ({ getBuyerView: (...a) => mockBuyerView(...a) }));

const express = require('express');
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
  const res = await fetch(`${base}/api/admin/dashboard/buyer-view?n=${seq}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { mockBuyerView.mockClear(); });

describe('GET /api/admin/dashboard/buyer-view', () => {
  test('a technician gets 403 and nothing is read', async () => {
    const { status, body } = await get('tech');
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'Admin access required' });
    expect(mockBuyerView).not.toHaveBeenCalled();
  });

  test('no login gets 401', async () => {
    expect((await get(null)).status).toBe(401);
    expect(mockBuyerView).not.toHaveBeenCalled();
  });

  test('an admin gets the payload', async () => {
    const { status, body } = await get('admin');
    expect(status).toBe(200);
    expect(body).toEqual(PAYLOAD);
    expect(mockBuyerView).toHaveBeenCalledTimes(1);
  });

  test('a failure is a 500, not an empty row of tiles', async () => {
    mockBuyerView.mockRejectedValueOnce(new Error('boom'));
    const { status, body } = await get('admin');
    expect(status).toBe(500);
    expect(body.error).toBe('boom');
  });
});
