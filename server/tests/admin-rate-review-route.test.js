/**
 * /api/admin/rate-review — admin-only, dark behind GATE_RATE_REVIEW.
 * Gate off = 404 on every route before any service call; a technician is
 * 403; an unauthenticated caller 401; a batch with sent rows refuses the
 * recompute with 409.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockListBatches = jest.fn();
const mockGetBatch = jest.fn();
const mockBuildBatch = jest.fn();
const mockLoadConfig = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
const mockSendBatchEmail = jest.fn();
jest.mock('../services/rate-review', () => ({
  listBatches: (...args) => mockListBatches(...args),
  getBatch: (...args) => mockGetBatch(...args),
  buildBatch: (...args) => mockBuildBatch(...args),
  loadConfig: (...args) => mockLoadConfig(...args),
  sendBatchEmail: (...args) => mockSendBatchEmail(...args),
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

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_RATE_REVIEW = 'true';
  mockListBatches.mockResolvedValue([{ batch_key: '2026-12', rows: 6, statuses: { green: 3 } }]);
  mockLoadConfig.mockResolvedValue({ pass_through_pct: 3.5 });
  mockGetBatch.mockResolvedValue({ batchKey: '2026-12', rows: [], summary: { rows: 0 }, batch: null });
  mockBuildBatch.mockResolvedValue({ ok: true, batchKey: '2026-12', window: { from: '2026-12-01', to: '2026-12-31' }, rows: 6, summary: { rows: 6 }, allowances: {} });
});

afterAll(() => { delete process.env.GATE_RATE_REVIEW; });

describe('gate off', () => {
  test.each([['GET', '/batches'], ['GET', '/batches/2026-12'], ['POST', '/batches/2026-12/build']])('%s %s answers 404 and calls nothing', async (method, path) => {
    process.env.GATE_RATE_REVIEW = 'false';
    await withServer(async (base) => {
      const out = await call(base, method, `/api/admin/rate-review${path}`);
      expect(out.status).toBe(404);
      expect(out.body).toEqual({ error: 'Rate review is not enabled' });
    });
    expect(mockListBatches).not.toHaveBeenCalled();
    expect(mockGetBatch).not.toHaveBeenCalled();
    expect(mockBuildBatch).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  test('unauthenticated → 401, technician → 403, both before the gate read', async () => {
    process.env.GATE_RATE_REVIEW = 'false';
    await withServer(async (base) => {
      expect((await call(base, 'GET', '/api/admin/rate-review/batches', { token: null })).status).toBe(401);
      expect((await call(base, 'GET', '/api/admin/rate-review/batches', { token: 'tech' })).status).toBe(403);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build', { token: 'tech' })).status).toBe(403);
    });
  });
});

describe('reads', () => {
  test('GET /batches lists batches with the config', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'GET', '/api/admin/rate-review/batches');
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ enabled: true, batches: [{ batch_key: '2026-12', rows: 6, statuses: { green: 3 } }], config: { pass_through_pct: 3.5 } });
    });
  });
  test('GET /batches/:key validates the key and returns rows + summary', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'GET', '/api/admin/rate-review/batches/dec-2026')).status).toBe(400);
      const out = await call(base, 'GET', '/api/admin/rate-review/batches/2026-12');
      expect(out.status).toBe(200);
      expect(mockGetBatch).toHaveBeenCalledWith('2026-12');
      expect(out.body.batchKey).toBe('2026-12');
    });
  });
});

describe('POST /batches/:key/build', () => {
  test('recomputes with an optional window', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build', { body: { anniversaryFrom: '2026-01-01', anniversaryTo: '2026-12-31' } });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, batchKey: '2026-12', rows: 6 });
      expect(mockBuildBatch).toHaveBeenCalledWith({ batchKey: '2026-12', anniversaryFrom: '2026-01-01', anniversaryTo: '2026-12-31' });
    });
  });
  test('with no explicit window it hands null/null to the service, whose default is the standing 35–65 day window', async () => {
    await withServer(async (base) => {
      await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(mockBuildBatch).toHaveBeenCalledWith({ batchKey: '2026-12', anniversaryFrom: null, anniversaryTo: null });
    });
  });
  test('a rebuild that reset an already-delivered digest re-sends the updated ops email; an unchanged one sends nothing', async () => {
    mockBuildBatch.mockResolvedValue({ ok: true, batchKey: '2026-12', window: { from: '2026-12-06', to: '2027-01-05' }, rows: 6, summary: { rows: 6 }, allowances: {}, digestReset: true });
    mockSendBatchEmail.mockResolvedValue({ sent: true, subject: 'ACT: Rate review — …' });
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(out.status).toBe(200);
      expect(out.body.digest).toBe('resent');
      expect(mockSendBatchEmail).toHaveBeenCalledWith({ batchKey: '2026-12' });
      mockSendBatchEmail.mockClear();
      mockBuildBatch.mockResolvedValue({ ok: true, batchKey: '2026-12', window: { from: '2026-12-06', to: '2027-01-05' }, rows: 6, summary: { rows: 6 }, allowances: {}, digestReset: false });
      const quiet = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(quiet.body.digest).toBe('unchanged');
      expect(mockSendBatchEmail).not.toHaveBeenCalled();
      // a delivery failure never fails the rebuild
      mockBuildBatch.mockResolvedValue({ ok: true, batchKey: '2026-12', window: { from: '2026-12-06', to: '2027-01-05' }, rows: 6, summary: { rows: 6 }, allowances: {}, digestReset: true });
      mockSendBatchEmail.mockRejectedValue(Object.assign(new Error('sendgrid 503'), { status: 503 }));
      const failed = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(failed.status).toBe(200);
      expect(failed.body.digest).toBe('reset');
    });
  });
  test('refuses once any row in the batch was sent', async () => {
    mockBuildBatch.mockResolvedValue({ ok: false, reason: 'batch_has_sent_rows', batchKey: '2026-12' });
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(out.status).toBe(409);
      expect(out.body.reason).toBe('batch_has_sent_rows');
    });
  });
  test('bad dates and service 400s are 400', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build', { body: { anniversaryFrom: '12/01/2026' } })).status).toBe(400);
      // shape is not enough: an impossible calendar date and an impossible month are refused before the service
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build', { body: { anniversaryFrom: '2026-02-31', anniversaryTo: '2026-12-31' } })).status).toBe(400);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-13/build')).status).toBe(400);
      expect((await call(base, 'GET', '/api/admin/rate-review/batches/2026-00')).status).toBe(400);
      expect(mockBuildBatch).not.toHaveBeenCalled();
      const err = new Error('anniversaryFrom must not be after anniversaryTo');
      err.status = 400;
      mockBuildBatch.mockRejectedValue(err);
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build', { body: { anniversaryFrom: '2026-12-31', anniversaryTo: '2026-12-01' } });
      expect(out.status).toBe(400);
      expect(out.body.error).toMatch(/not be after/);
    });
  });
});
