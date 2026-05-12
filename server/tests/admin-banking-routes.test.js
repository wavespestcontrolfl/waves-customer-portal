process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/stripe-banking', () => ({
  getBalance: jest.fn(),
  createInstantPayout: jest.fn(),
  syncPayouts: jest.fn(),
  getCashFlow: jest.fn(),
  reconcilePayout: jest.fn(),
}));
jest.mock('../services/banking-export', () => ({
  generateCSV: jest.fn(() => ({ content: 'csv', filename: 'test.csv', content_type: 'text/csv' })),
  generateOFX: jest.fn(() => ({ content: 'ofx', filename: 'test.ofx', content_type: 'application/x-ofx' })),
}));
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

const express = require('express');
const db = require('../models/db');
const StripeBanking = require('../services/stripe-banking');
const bankingRouter = require('../routes/admin-banking');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/banking', bankingRouter);
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

describe('admin banking routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('technician role cannot access banking balance', async () => {
    StripeBanking.getBalance.mockResolvedValue({ total_available: 123 });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/balance`, {
        headers: { Authorization: 'Bearer tech' },
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required');
      expect(StripeBanking.getBalance).not.toHaveBeenCalled();
    });
  });

  test('reconciliation list returns the client envelope', async () => {
    const latestSubquery = {
      select: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      as: jest.fn().mockReturnValue('latest-reconciliation'),
    };
    const payoutQuery = {
      where: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([{ id: 'payout-1', amount: '100.00' }]),
    };
    db.mockImplementation((table) => {
      if (table === 'bank_reconciliation as br') return latestSubquery;
      if (table === 'stripe_payouts') return payoutQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/reconciliation`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ payouts: [{ id: 'payout-1', amount: '100.00' }] });
    });
  });

  test('reconciliation records the authenticated admin as actor', async () => {
    StripeBanking.reconcilePayout.mockResolvedValue({ payout_id: 'payout-1', status: 'confirmed' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/reconciliation/payout-1`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ actual_amount: 100, notes: 'matched' }),
      });
      expect(res.status).toBe(200);
      expect(StripeBanking.reconcilePayout).toHaveBeenCalledWith(
        'payout-1',
        100,
        'matched',
        'admin-1',
        'confirmed',
      );
    });
  });

  test('instant payout uses stable non-PII admin actor with client idempotency key', async () => {
    StripeBanking.createInstantPayout.mockResolvedValue({ payout_id: 'po_123', status: 'pending' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/banking/payouts/instant`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50, idempotency_key: 'ipo_attempt_123' }),
      });
      expect(res.status).toBe(200);
      expect(StripeBanking.createInstantPayout).toHaveBeenCalledWith(50, {
        requestedBy: 'admin-1',
        idempotencyKey: 'ipo_attempt_123',
      });
    });
  });
});
