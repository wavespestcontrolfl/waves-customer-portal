/**
 * DELETE /admin/customers/:id (archive) and PATCH /:id/restore both re-run the
 * newsletter twin picker for the customer's email INSIDE their transaction —
 * symmetric, so archiving a primary moves links to the secondary and restoring
 * it moves them back.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/newsletter-subscribers', () => ({
  relinkSubscribersForEmail: jest.fn(async () => ({ winnerId: 'winner-1', relinked: 1 })),
}));

const mockState = { customer: null, updates: [] };
let mockTrx;
jest.mock('../models/db', () => {
  const builder = (table, viaTrx) => {
    const q = { _where: {} };
    q.where = (c) => { Object.assign(q._where, c); return q; };
    q.whereNull = () => q;
    q.whereNotNull = () => q;
    q.first = async () => (table === 'customers' ? mockState.customer : null);
    q.update = async (patch) => { mockState.updates.push({ table, viaTrx, where: { ...q._where }, patch }); return 1; };
    return q;
  };
  const db = (table) => builder(table, false);
  db.transaction = jest.fn(async (fn) => {
    mockTrx = Object.assign((table) => builder(table, true), { fn: { now: () => 'NOW()' }, isTrx: true });
    return fn(mockTrx);
  });
  return db;
});

const express = require('express');
const db = require('../models/db');
const { recordAuditEvent } = require('../services/audit-log');
const { relinkSubscribersForEmail } = require('../services/newsletter-subscribers');
const router = require('../routes/admin-customers');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

beforeEach(() => { jest.clearAllMocks(); mockState.updates = []; });

describe('DELETE /admin/customers/:id (archive)', () => {
  beforeEach(() => { mockState.customer = { id: 'cust-1', email: 'Household@Example.com', deleted_at: null }; });

  test('sets deleted_at, relinks by the customer email on the trx, audits on the same trx', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockState.updates).toEqual([
      expect.objectContaining({ table: 'customers', viaTrx: true, where: { id: 'cust-1' }, patch: expect.objectContaining({ deleted_at: expect.any(Date) }) }),
    ]);
    expect(relinkSubscribersForEmail).toHaveBeenCalledTimes(1);
    expect(relinkSubscribersForEmail.mock.calls[0][0]).toBe(mockTrx);
    expect(relinkSubscribersForEmail.mock.calls[0][1]).toBe('Household@Example.com');
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'customer.archive', resource_id: 'cust-1', critical: true, trx: mockTrx,
      metadata: expect.objectContaining({ newsletterRelinkedTo: 'winner-1', newsletterRelinked: 1 }),
    }));
  });

  test('relink failure rolls the archive back (no audit, 500)', async () => {
    relinkSubscribersForEmail.mockRejectedValueOnce(new Error('relink exploded'));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1`, { method: 'DELETE' });
      expect(res.status).toBe(500);
    });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe('PATCH /admin/customers/:id/restore', () => {
  beforeEach(() => { mockState.customer = { id: 'cust-1', email: 'Household@Example.com', deleted_at: new Date('2026-08-01') }; });

  test('clears deleted_at, re-runs the SAME relink for the email on the trx, audits on the same trx', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/restore`, { method: 'PATCH' });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockState.updates).toEqual([
      expect.objectContaining({ table: 'customers', viaTrx: true, where: { id: 'cust-1' }, patch: { deleted_at: null } }),
    ]);
    expect(relinkSubscribersForEmail).toHaveBeenCalledWith(mockTrx, 'Household@Example.com');
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'customer.restore', resource_id: 'cust-1', critical: true, trx: mockTrx,
      metadata: expect.objectContaining({ newsletterRelinkedTo: 'winner-1', newsletterRelinked: 1 }),
    }));
  });
});
