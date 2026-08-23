/**
 * DELETE /admin/customers/:id — archive sets deleted_at AND relinks newsletter
 * subscribers to the live same-email twin inside the SAME transaction.
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
  relinkSubscribersFromArchivedCustomer: jest.fn(async () => ({ twinId: 'twin-1', relinked: 1 })),
}));

const mockState = { customer: { id: 'cust-1', deleted_at: null }, updates: [] };
let mockTrx;
jest.mock('../models/db', () => {
  const builder = (table, viaTrx) => {
    const q = { _where: {} };
    q.where = (c) => { Object.assign(q._where, c); return q; };
    q.whereNull = () => q;
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
const { relinkSubscribersFromArchivedCustomer } = require('../services/newsletter-subscribers');
const router = require('../routes/admin-customers');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

describe('DELETE /admin/customers/:id relinks newsletter subscribers inside the archive transaction', () => {
  beforeEach(() => { jest.clearAllMocks(); mockState.updates = []; });

  test('sets deleted_at, calls the relink helper with the trx, audits on the same trx', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockState.updates).toEqual([
      expect.objectContaining({ table: 'customers', viaTrx: true, where: { id: 'cust-1' }, patch: expect.objectContaining({ deleted_at: expect.any(Date) }) }),
    ]);
    expect(relinkSubscribersFromArchivedCustomer).toHaveBeenCalledTimes(1);
    const [trxArg, idArg] = relinkSubscribersFromArchivedCustomer.mock.calls[0];
    expect(trxArg).toBe(mockTrx);
    expect(idArg).toBe('cust-1');
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'customer.archive', resource_id: 'cust-1', critical: true, trx: mockTrx,
      metadata: expect.objectContaining({ newsletterRelinkedTo: 'twin-1', newsletterRelinked: 1 }),
    }));
  });

  test('relink failure rolls the archive back (no deleted_at commit without the relink)', async () => {
    relinkSubscribersFromArchivedCustomer.mockRejectedValueOnce(new Error('relink exploded'));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1`, { method: 'DELETE' });
      expect(res.status).toBe(500);
    });
    // The transaction callback rejected → knex would roll back; the audit never ran.
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
