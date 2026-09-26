process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockRouteScorecardEnabled = jest.fn();
const mockGetDayScorecard = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin', email: 'owner@example.com', name: 'Owner' },
      tech: { id: 'tech-1', role: 'technician', email: 'tech@example.com', name: 'Tech' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
jest.mock('../services/scheduling/day-scorecard', () => {
  const actual = jest.requireActual('../services/scheduling/day-scorecard');
  return {
    ...actual,
    routeScorecardEnabled: (...args) => mockRouteScorecardEnabled(...args),
    getDayScorecard: (...args) => mockGetDayScorecard(...args),
  };
});

const express = require('express');
const scorecardRouter = require('../routes/admin-route-scorecard');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/route-scorecard', scorecardRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('admin route scorecard route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('requires admin authentication', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/route-scorecard`);
      const body = await res.json();
      expect(res.status).toBe(401);
      expect(body.error).toBe('Admin authentication required');
      expect(mockGetDayScorecard).not.toHaveBeenCalled();
    });
  });

  test('rejects technician access on both endpoints', async () => {
    await withServer(async (baseUrl) => {
      const status = await fetch(`${baseUrl}/admin/route-scorecard/status`, { headers: { Authorization: 'Bearer tech' } });
      expect(status.status).toBe(403);
      const list = await fetch(`${baseUrl}/admin/route-scorecard`, { headers: { Authorization: 'Bearer tech' } });
      expect(list.status).toBe(403);
      expect(mockGetDayScorecard).not.toHaveBeenCalled();
    });
  });

  test('status reports the gate state for an admin', async () => {
    mockRouteScorecardEnabled.mockReturnValue(false);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/route-scorecard/status`, { headers: { Authorization: 'Bearer admin' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false });
    });
  });

  test('gate off answers 404 on the list endpoint without calling the reader', async () => {
    mockRouteScorecardEnabled.mockReturnValue(false);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/route-scorecard?from=2026-09-01&to=2026-09-08`, { headers: { Authorization: 'Bearer admin' } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ enabled: false });
      expect(mockGetDayScorecard).not.toHaveBeenCalled();
    });
  });

  test('gate on rejects an invalid range with 400 before calling the reader', async () => {
    mockRouteScorecardEnabled.mockReturnValue(true);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/route-scorecard?from=2026-09-08&to=2026-09-01`, { headers: { Authorization: 'Bearer admin' } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/valid date range/);
      expect(mockGetDayScorecard).not.toHaveBeenCalled();
    });
  });

  test('gate on with a valid range returns the scorecard payload', async () => {
    mockRouteScorecardEnabled.mockReturnValue(true);
    mockGetDayScorecard.mockResolvedValue({ range: { from: '2026-09-01', to: '2026-09-08' }, driveModel: 'legacy', days: [] });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/route-scorecard?from=2026-09-01&to=2026-09-08`, { headers: { Authorization: 'Bearer admin' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ driveModel: 'legacy', days: [] });
      expect(mockGetDayScorecard).toHaveBeenCalledWith({ date_from: '2026-09-01', date_to: '2026-09-08' });
    });
  });

  test('a reader-reported range error still answers 400', async () => {
    mockRouteScorecardEnabled.mockReturnValue(true);
    mockGetDayScorecard.mockResolvedValue({ error: 'Use a valid date range of at most 31 days.' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/route-scorecard?from=2026-09-01&to=2026-09-08`, { headers: { Authorization: 'Bearer admin' } });
      expect(res.status).toBe(400);
    });
  });
});
