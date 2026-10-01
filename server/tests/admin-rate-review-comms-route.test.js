/**
 * /api/admin/rate-review — the COMMS lane's routes (send preview, letter
 * preview, send). Admin-only, dark behind GATE_RATE_REVIEW: gate off = 404
 * before any service call; a technician is 403; send needs the preview's
 * digest and turns a service refusal into a 409. Approval and send live
 * only behind admin auth — never an email reply.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockSendPreview = jest.fn();
const mockLetterPreview = jest.fn();
const mockSendBatch = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/rate-review', () => ({ listBatches: jest.fn(), getBatch: jest.fn(), buildBatch: jest.fn(), loadConfig: jest.fn() }));
jest.mock('../services/rate-review-apply', () => ({ scheduleNoticeRows: jest.fn(), listApplyHolds: jest.fn(), retireDraftNotices: jest.fn() }));
jest.mock('../services/rate-review-comms', () => ({
  sendPreview: (...args) => mockSendPreview(...args),
  letterPreview: (...args) => mockLetterPreview(...args),
  sendBatch: (...args) => mockSendBatch(...args),
}));

const express = require('express');
const router = require('../routes/admin-rate-review');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/rate-review', router);
  const server = app.listen(0, '127.0.0.1');
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return new Promise((resolve, reject) => {
    server.on('listening', async () => {
      try { resolve(await fn(base())); } catch (err) { reject(err); } finally { server.close(); }
    });
  });
}

async function call(base, method, path, { token = 'admin', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

const DIGEST = 'a'.repeat(64);
const ROW_ID = '40000000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_RATE_REVIEW = 'true';
});

describe('rate review comms routes', () => {
  test('gate off: 404 before any service call', async () => {
    process.env.GATE_RATE_REVIEW = 'false';
    await withServer(async (base) => {
      expect((await call(base, 'GET', '/api/admin/rate-review/batches/2026-12/send-preview')).status).toBe(404);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/send', { body: { expectedDigest: DIGEST } })).status).toBe(404);
    });
    expect(mockSendPreview).not.toHaveBeenCalled();
    expect(mockSendBatch).not.toHaveBeenCalled();
  });

  test('a technician is 403 — sending is admin-only', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/send', { token: 'tech', body: { expectedDigest: DIGEST } })).status).toBe(403);
    });
    expect(mockSendBatch).not.toHaveBeenCalled();
  });

  test('send preview passes through', async () => {
    mockSendPreview.mockResolvedValue({ ok: true, digest: DIGEST, counts: { letters: 1 }, customers: [] });
    await withServer(async (base) => {
      const res = await call(base, 'GET', '/api/admin/rate-review/batches/2026-12/send-preview');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ digest: DIGEST, counts: { letters: 1 } });
    });
    expect(mockSendPreview).toHaveBeenCalledWith('2026-12');
  });

  test('send requires the preview digest; a refusal is a 409 with its reason', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/send', { body: {} })).status).toBe(400);
      mockSendBatch.mockResolvedValueOnce({ ok: false, reason: 'list_changed' });
      const changed = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/send', { body: { expectedDigest: DIGEST } });
      expect(changed).toMatchObject({ status: 409, body: { reason: 'list_changed' } });
      mockSendBatch.mockResolvedValueOnce({ ok: false, reason: 'cost_block_missing' });
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/send', { body: { expectedDigest: DIGEST } })).status).toBe(409);
      mockSendBatch.mockResolvedValueOnce({ ok: true, sent: 2, emailed: 2, texted: 1 });
      const sent = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/send', { body: { expectedDigest: DIGEST } });
      expect(sent).toMatchObject({ status: 200, body: { sent: 2 } });
    });
    expect(mockSendBatch).toHaveBeenLastCalledWith('2026-12', { expectedDigest: DIGEST, actorId: 'admin-1' });
  });

  test('letter preview: the UI contract { subject, html }; 404 until scheduled; a bad row id is 400', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'GET', '/api/admin/rate-review/batches/2026-12/rows/not-a-uuid/letter-preview')).status).toBe(400);
      mockLetterPreview.mockResolvedValueOnce({ ok: true, subject: 'Your Waves rate from December 10, 2026', html: '<p>x</p>', costBlockReady: true, suppressed: null });
      const ok = await call(base, 'GET', `/api/admin/rate-review/batches/2026-12/rows/${ROW_ID}/letter-preview`);
      expect(ok).toMatchObject({ status: 200, body: { subject: 'Your Waves rate from December 10, 2026', html: '<p>x</p>' } });
      mockLetterPreview.mockRejectedValueOnce(Object.assign(new Error('This row has no scheduled notice yet'), { status: 404 }));
      expect((await call(base, 'GET', `/api/admin/rate-review/batches/2026-12/rows/${ROW_ID}/letter-preview`)).status).toBe(404);
    });
  });
});
