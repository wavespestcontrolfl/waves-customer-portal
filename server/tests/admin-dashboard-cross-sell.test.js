/**
 * GET /api/admin/dashboard/cross-sell: admin only (a technician gets 403 and nothing is read), passes the months window to the
 * reader, and returns its payload as is. The counting and the SQL are covered by cross-sell-rate.test.js and
 * cross-sell-rate-postgres.test.js. Synthetic numbers only.
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
  series: [{ month: '2026-10-01', recurringCustomers: 260, multiServiceCustomers: 31, share: 0.1192 }],
  now: { asOf: '2026-11-26', recurringCustomers: 275, multiServiceCustomers: 33, share: 0.12 },
  sources: { app: 1, office: 32 },
  pestOnly: [{ id: 'c1', firstName: 'Sample', lastName: 'Alpha', city: 'Parrish', pestServiceKey: 'pest_general_quarterly' }],
};
const mockSummary = jest.fn(async () => PAYLOAD);
jest.mock('../services/cross-sell-rate', () => ({
  getCrossSellSummary: (...a) => mockSummary(...a),
}));

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
const get = async (token, query = '') => {
  seq += 1;
  const res = await fetch(`${base}/api/admin/dashboard/cross-sell?n=${seq}${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { mockSummary.mockClear(); });

describe('GET /api/admin/dashboard/cross-sell', () => {
  test('a technician gets 403 and nothing is read', async () => {
    const { status, body } = await get('tech');
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'Admin access required' });
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test('no login gets 401', async () => {
    expect((await get(null)).status).toBe(401);
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test('an admin gets the summary and the months window reaches the reader', async () => {
    const { status, body } = await get('admin', '&months=6');
    expect(status).toBe(200);
    expect(body).toEqual(PAYLOAD);
    expect(mockSummary).toHaveBeenCalledTimes(1);
    expect(mockSummary.mock.calls[0][0]).toMatchObject({ months: '6' });
  });

  test('a reader failure is a 500, not an empty card', async () => {
    mockSummary.mockRejectedValueOnce(new Error('boom'));
    const { status, body } = await get('admin');
    expect(status).toBe(500);
    expect(body.error).toBe('boom');
  });
});
