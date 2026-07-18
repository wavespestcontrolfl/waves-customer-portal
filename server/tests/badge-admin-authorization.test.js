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
    if (req.headers['x-staff'] !== 'yes') return res.status(401).json({ error: 'staff auth required' });
    req.techRole = 'technician';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    req.techRole === 'technician' ? next() : res.status(403).json({ error: 'staff required' })
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

  test('a staff credential can access badge admin definitions', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/badges/admin/definitions`, {
        headers: { 'x-staff': 'yes' },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.badges.length).toBeGreaterThan(0);
    });
  });
});
