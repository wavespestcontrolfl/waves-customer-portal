process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// GET /api/admin/revenue/settings is owner-only like every revenue route
// (settings audit SET-01). It used to admit technicians and hand them the
// company overhead figures (office payroll, rent, insurance) after Settings
// had already hidden the Operating Costs tab from them.
const LATEST_ROW = {
  id: 'row-1',
  effective_date: '2026-10-01',
  loaded_labor_rate: '35.00',
  target_gross_margin_pct: '55.00',
  vehicle_deduction_method: 'standard_mileage',
  ovh_office_payroll: '2000.00',
  ovh_rent: '900.00',
  ovh_insurance: '400.00',
  overhead_entered_at: '2026-10-01T14:00:00.000Z',
};
const mockReads = [];
jest.mock('../models/db', () => {
  const mockDb = jest.fn((table) => {
    mockReads.push(table);
    const q = {
      orderBy: () => q,
      first: () => Promise.resolve(table === 'company_financials' ? LATEST_ROW : undefined),
    };
    return q;
  });
  return mockDb;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    req.techRole === 'admin' || req.techRole === 'technician'
      ? next()
      : res.status(403).json({ error: 'Staff access required' })
  ),
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const revenueRouter = require('../routes/admin-revenue');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/revenue', revenueRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

beforeEach(() => {
  mockReads.length = 0;
});

describe('GET /api/admin/revenue/settings role boundary', () => {
  test('a technician gets 403 and no company figures; nothing is read', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/revenue/settings`, { headers: auth('tech') });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: 'Admin access required' });
      expect(JSON.stringify(body)).not.toMatch(/ovh_|overhead|2000/);
      expect(mockReads).toEqual([]);
    });
  });

  test('a technician cannot save the figures either', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/revenue/settings`, {
        method: 'PUT',
        headers: auth('tech'),
        body: JSON.stringify({ ovhRent: 1 }),
      });
      expect(res.status).toBe(403);
      expect(mockReads).toEqual([]);
    });
  });

  test('the owner gets the whole latest row', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/revenue/settings`, { headers: auth('admin') });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ settings: LATEST_ROW });
      expect(mockReads).toEqual(['company_financials']);
    });
  });

  test('no session is a 401', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/revenue/settings`);
      expect(res.status).toBe(401);
      expect(mockReads).toEqual([]);
    });
  });
});
