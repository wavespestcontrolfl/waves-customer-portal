jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    if (req.headers['x-customer'] !== 'yes') return res.status(401).json({ error: 'customer auth required' });
    req.customerId = 'customer-1';
    return next();
  },
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const role = req.headers['x-staff-role'];
    if (!role) return res.status(401).json({ error: 'staff auth required' });
    req.techRole = role;
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const router = require('../routes/badges');

async function withServer(callback) {
  const app = express();
  app.use('/badges', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('badge route authorization boundaries', () => {
  test('a customer credential cannot access badge admin definitions', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/badges/admin/definitions`, {
        headers: { 'x-customer': 'yes' },
      });
      expect(response.status).toBe(401);
    });
  });

  test('a technician credential is refused on badge admin routes (403)', async () => {
    await withServer(async (baseUrl) => {
      for (const path of ['/badges/admin/definitions', '/badges/admin/stats', '/badges/admin/customer/cust-1']) {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { 'x-staff-role': 'technician' },
        });
        expect(response.status).toBe(403);
      }
    });
  });

  test('an admin credential can access badge admin definitions', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/badges/admin/definitions`, {
        headers: { 'x-staff-role': 'admin' },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.badges.length).toBeGreaterThan(0);
    });
  });
});
