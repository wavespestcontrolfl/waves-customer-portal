/**
 * POST /admin/customers/:id/collection-holds/release — the release and its
 * CRITICAL audit row commit in ONE transaction (B10): a failed audit write
 * rolls the release back and the request errors.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/collections/collection-hold-admin', () => ({
  listCollectionHolds: jest.fn(async () => []),
  releaseCollectionHold: jest.fn(async () => ({ ok: true, released: 1 })),
  sendWithheldInvoicesAfterRelease: jest.fn(async () => ({ ok: true, queued: [] })),
}));

const mockTx = { committed: 0, rolledBack: 0, trx: { isTrx: true } };
jest.mock('../models/db', () => {
  const db = () => { throw new Error('unexpected non-transactional query'); };
  db.transaction = jest.fn(async (fn) => {
    try { const out = await fn(mockTx.trx); mockTx.committed += 1; return out; } catch (e) { mockTx.rolledBack += 1; throw e; }
  });
  return db;
});

const express = require('express');
const { recordAuditEvent } = require('../services/audit-log');
const { releaseCollectionHold, sendWithheldInvoicesAfterRelease } = require('../services/collections/collection-hold-admin');
const db = require('../models/db');
const router = require('../routes/admin-customers');

async function post() {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/admin/customers/cust-1/collection-holds/release`, { method: 'POST' });
    return { status: r.status, body: await r.json() };
  } finally { await new Promise((res) => server.close(res)); }
}

beforeEach(() => { jest.clearAllMocks(); mockTx.committed = 0; mockTx.rolledBack = 0; });

test('release + critical audit share one transaction and commit together', async () => {
  const res = await post();
  expect(res).toEqual({ status: 200, body: { released: 1 } });
  expect(releaseCollectionHold).toHaveBeenCalledWith('cust-1', { trx: mockTx.trx });
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    action: 'customer.collection_hold_released', critical: true, trx: mockTx.trx,
  }));
  expect(mockTx.committed).toBe(1);
});

test('the withheld invoices are sent only AFTER the release + audit transaction commits (owner ruling 2026-09-30)', async () => {
  const order = [];
  db.transaction.mockImplementationOnce(async (fn) => { const out = await fn(mockTx.trx); order.push('commit'); return out; });
  sendWithheldInvoicesAfterRelease.mockImplementationOnce(async () => { order.push('send'); return { ok: true, queued: [] }; });
  const res = await post();
  expect(res).toEqual({ status: 200, body: { released: 1 } });
  expect(sendWithheldInvoicesAfterRelease).toHaveBeenCalledWith('cust-1');
  expect(order).toEqual(['commit', 'send']);
});

test('a failed post-release send (it never throws; it alerts) leaves the release response intact', async () => {
  sendWithheldInvoicesAfterRelease.mockResolvedValueOnce({ ok: false, error: 'queue down', queued: [] });
  expect(await post()).toEqual({ status: 200, body: { released: 1 } });
});

test('a failed audit write rolls the release back and the route errors', async () => {
  recordAuditEvent.mockRejectedValueOnce(new Error('audit down'));
  const res = await post();
  expect(res.status).toBe(500);
  expect(mockTx.rolledBack).toBe(1);
  expect(mockTx.committed).toBe(0);
  expect(sendWithheldInvoicesAfterRelease).not.toHaveBeenCalled();
});

test('a failed release errors without writing an audit row', async () => {
  releaseCollectionHold.mockResolvedValueOnce({ ok: false, reason: 'release_failed' });
  const res = await post();
  expect(res.status).toBe(500);
  expect(recordAuditEvent).not.toHaveBeenCalled();
  expect(mockTx.committed).toBe(0);
  expect(sendWithheldInvoicesAfterRelease).not.toHaveBeenCalled();
});
