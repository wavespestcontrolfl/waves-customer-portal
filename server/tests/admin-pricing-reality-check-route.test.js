process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockGetPricingRealityCheck = jest.fn();

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
jest.mock('../services/pricing-reality-check', () => {
  const actual = jest.requireActual('../services/pricing-reality-check');
  return {
    ...actual,
    getPricingRealityCheck: (...args) => mockGetPricingRealityCheck(...args),
  };
});

const express = require('express');
const pricingRealityRouter = require('../routes/admin-pricing-reality-check');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/pricing-reality-check', pricingRealityRouter);
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

describe('admin pricing reality check route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('requires admin authentication', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pricing-reality-check`);
      const body = await res.json();
      expect(res.status).toBe(401);
      expect(body.error).toBe('Admin authentication required');
      expect(mockGetPricingRealityCheck).not.toHaveBeenCalled();
    });
  });

  test('rejects technician access', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pricing-reality-check`, {
        headers: { Authorization: 'Bearer tech' },
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required');
      expect(mockGetPricingRealityCheck).not.toHaveBeenCalled();
    });
  });

  test('returns dashboard payload for an admin user', async () => {
    mockGetPricingRealityCheck.mockResolvedValue({
      lookbackDays: 30,
      laborRateDollarsPerHour: 35,
      generatedAt: '2026-05-16T12:00:00.000Z',
      coverage: { completedServiceCount: 1, includedServiceCount: 1 },
      summary: { serviceCount: 1 },
      segments: [],
      outliers: [],
      availableFilters: {},
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/admin/pricing-reality-check?lookbackDays=30&groupBy=month&outlierLimit=500`,
        { headers: { Authorization: 'Bearer admin' } },
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.lookbackDays).toBe(30);
      expect(mockGetPricingRealityCheck).toHaveBeenCalledWith(expect.objectContaining({
        lookbackDays: 30,
        groupBy: 'month',
        outlierLimit: 200,
      }));
    });
  });

  test('validates lookbackDays and groupBy', async () => {
    await withServer(async (baseUrl) => {
      const lookbackRes = await fetch(`${baseUrl}/admin/pricing-reality-check?lookbackDays=45`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(lookbackRes.status).toBe(400);
      expect((await lookbackRes.json()).error).toMatch(/lookbackDays/);

      const groupRes = await fetch(`${baseUrl}/admin/pricing-reality-check?groupBy=raw_sql`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(groupRes.status).toBe(400);
      expect((await groupRes.json()).error).toMatch(/groupBy/);
      expect(mockGetPricingRealityCheck).not.toHaveBeenCalled();
    });
  });
});
