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
const { releaseCollectionHold } = require('../services/collections/collection-hold-admin');
const router = require('../routes/admin-customers');

const HOLD_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

async function post(body = { holdId: HOLD_ID }) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/admin/customers/cust-1/collection-holds/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  } finally { await new Promise((res) => server.close(res)); }
}

beforeEach(() => { jest.clearAllMocks(); mockTx.committed = 0; mockTx.rolledBack = 0; });

test('release + critical audit share one transaction and commit together', async () => {
  const res = await post();
  expect(res).toEqual({ status: 200, body: { released: 1 } });
  expect(releaseCollectionHold).toHaveBeenCalledWith('cust-1', { holdId: HOLD_ID, trx: mockTx.trx });
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    action: 'customer.collection_hold_released', critical: true, trx: mockTx.trx,
    metadata: expect.objectContaining({ hold_id: HOLD_ID }),
  }));
  expect(mockTx.committed).toBe(1);
});

test('a released dispute that leaves the fallback hold in place says so, and the audit row records it', async () => {
  releaseCollectionHold.mockResolvedValueOnce({ ok: true, released: 1, fallbackRestored: true });
  const res = await post();
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    released: 1,
    fallbackRestored: true,
    message: 'Dispute released; the earlier wrong-number/wrong-party hold stays.',
  });
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    metadata: expect.objectContaining({ hold_id: HOLD_ID, fallback_restored: true }),
  }));
});

test('a failed audit write rolls the release back and the route errors', async () => {
  recordAuditEvent.mockRejectedValueOnce(new Error('audit down'));
  const res = await post();
  expect(res.status).toBe(500);
  expect(mockTx.rolledBack).toBe(1);
  expect(mockTx.committed).toBe(0);
});

test('a failed release errors without writing an audit row', async () => {
  releaseCollectionHold.mockResolvedValueOnce({ ok: false, reason: 'release_failed' });
  const res = await post();
  expect(res.status).toBe(500);
  expect(recordAuditEvent).not.toHaveBeenCalled();
  expect(mockTx.committed).toBe(0);
});

test('no holdId is a 400 and never touches the writer', async () => {
  const res = await post({});
  expect(res.status).toBe(400);
  expect(releaseCollectionHold).not.toHaveBeenCalled();
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('a stale or mismatched hold id (nothing released) is a 409 "This hold changed — reload", no audit, rolled back', async () => {
  releaseCollectionHold.mockResolvedValueOnce({ ok: true, released: 0 });
  const res = await post();
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('This hold changed — reload');
  expect(recordAuditEvent).not.toHaveBeenCalled();
  expect(mockTx.rolledBack).toBe(1);
  expect(mockTx.committed).toBe(0);
});

test('a malformed hold id is a 409 without reaching the writer (it can never match a row)', async () => {
  const res = await post({ holdId: 'not-a-uuid' });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('This hold changed — reload');
  expect(releaseCollectionHold).not.toHaveBeenCalled();
});
