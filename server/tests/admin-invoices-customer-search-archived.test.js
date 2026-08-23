process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = 'technician';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/stripe', () => ({}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-invoices');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GET /customers/search excludes archived customers', () => {
  test('builder receives both active=true and whereNull(deleted_at)', async () => {
    const q = {};
    ['where', 'whereNull', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.limit = jest.fn(async () => [{ id: 1, first_name: 'Live' }]);
    db.mockImplementation((table) => {
      if (table !== 'customers') throw new Error(`Unexpected table ${table}`);
      return q;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/customers/search?q=liv`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ customers: [{ id: 1, first_name: 'Live' }] });
    });

    expect(q.where).toHaveBeenCalledWith({ active: true });
    expect(q.whereNull).toHaveBeenCalledWith('deleted_at');
  });
});
