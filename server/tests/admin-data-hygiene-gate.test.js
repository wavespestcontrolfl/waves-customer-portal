/**
 * GATE_DATA_HYGIENE_UI (dataHygieneReviewUi) controls the whole Hygiene review
 * API: gate off, every route answers 404 behind admin auth (so a dark gate
 * looks like an unshipped route); gate on, the admin reviews as before. The
 * knex stub resolves empty rows; no real DB.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockGates = { dataHygieneReviewUi: false };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: (gate) => (gate in mockGates ? mockGates[gate] : actual.isEnabled(gate)),
  };
});
jest.mock('../models/db', () => {
  const chain = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve) => resolve([]);
      return () => chain;
    },
  });
  const db = jest.fn(() => chain);
  db.raw = jest.fn((sql) => ({ sql }));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'auth' });
    req.technician = user; req.technicianId = user.id; req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'admin' })),
}));

async function withServer(fn) {
  const express = require('express');
  const router = require('../routes/admin-data-hygiene');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/data-hygiene', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}/api/admin/data-hygiene`); } finally { await new Promise((r) => server.close(r)); }
}

const admin = { Authorization: 'Bearer admin' };
const call = (base, method, path, headers = admin) => fetch(`${base}${path}`, {
  method,
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: method === 'GET' ? undefined : JSON.stringify({}),
});

const ROUTES = [
  ['GET', '/proposals'],
  ['GET', '/metrics'],
  ['POST', '/scan'],
  ['POST', '/proposals/p1/approve'],
  ['POST', '/proposals/p1/reject'],
  ['POST', '/proposals/p1/reveal'],
  ['POST', '/proposals/p1/revert'],
];

describe('admin-data-hygiene review gate', () => {
  test('gate off: every route is 404 for an admin, auth still answers first', async () => {
    mockGates.dataHygieneReviewUi = false;
    await withServer(async (base) => {
      for (const [method, path] of ROUTES) {
        const res = await call(base, method, path);
        expect([method, path, res.status]).toEqual([method, path, 404]);
        expect(await res.json()).toEqual({ error: 'Not found' });
      }
      expect((await call(base, 'GET', '/metrics', {})).status).toBe(401);
      expect((await call(base, 'GET', '/metrics', { Authorization: 'Bearer tech' })).status).toBe(403);
    });
  });

  test('gate on: the admin reads metrics as before; a technician is still 403', async () => {
    mockGates.dataHygieneReviewUi = true;
    await withServer(async (base) => {
      const res = await call(base, 'GET', '/metrics');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expect.objectContaining({ days: 30 }));
      expect((await call(base, 'GET', '/metrics', { Authorization: 'Bearer tech' })).status).toBe(403);
    });
  });

  test('gate on: the scan route reaches its own scanner gate instead of the review gate', async () => {
    mockGates.dataHygieneReviewUi = true;
    mockGates.dataHygieneScanner = false;
    await withServer(async (base) => {
      const res = await call(base, 'POST', '/scan');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Data Hygiene scanner is disabled' });
    });
    delete mockGates.dataHygieneScanner;
  });
});
