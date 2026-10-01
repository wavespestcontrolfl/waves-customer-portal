/**
 * /api/admin/rate-review — admin-only, dark behind GATE_RATE_REVIEW.
 * Gate off = 404 on every route before any service call; a technician is
 * 403; an unauthenticated caller 401; a batch with sent rows refuses the
 * recompute with 409. The admin-screen routes (row edit, approve, config)
 * map the service's refusal reasons to 400/404/409 and pass the acting
 * admin's id through; the owner digest is the parent's POST …/digest.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockListBatches = jest.fn();
const mockGetBatch = jest.fn();
const mockBuildBatch = jest.fn();
const mockReadConfig = jest.fn();
const mockLoadConfig = jest.fn(); // the parent's numeric-knobs read; GET /batches answers the screen's readConfig
const mockUpdateRow = jest.fn();
const mockApproveBatch = jest.fn();
const mockSendBatchEmail = jest.fn();
const mockUpdateConfig = jest.fn();

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
const mockBatchEmailed = jest.fn(async () => false);
const mockRunExclusive = jest.fn(async (_name, fn) => fn());
jest.mock('../utils/cron-lock', () => ({
  runExclusive: (...args) => mockRunExclusive(...args),
  wasLockSkipped: (result) => !!(result && result.skipped === true),
}));
jest.mock('../services/rate-review', () => ({
  listBatches: (...args) => mockListBatches(...args),
  getBatch: (...args) => mockGetBatch(...args),
  buildBatch: (...args) => mockBuildBatch(...args),
  loadConfig: (...args) => mockLoadConfig(...args),
  sendBatchEmail: (...args) => mockSendBatchEmail(...args),
  batchEmailed: (...args) => mockBatchEmailed(...args),
  readConfig: (...args) => mockReadConfig(...args),
  updateRow: (...args) => mockUpdateRow(...args),
  approveBatch: (...args) => mockApproveBatch(...args),
  updateConfig: (...args) => mockUpdateConfig(...args),
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
  mockReadConfig.mockResolvedValue({ pass_through_pct: 3.5, cost_block: '' });
  mockGetBatch.mockResolvedValue({ batchKey: '2026-12', rows: [], summary: { rows: 0 }, batch: null, approvalDigest: 'abc' });
  mockBuildBatch.mockResolvedValue({ ok: true, batchKey: '2026-12', window: { from: '2026-12-01', to: '2026-12-31' }, rows: 6, summary: { rows: 6 }, allowances: {} });
  mockUpdateRow.mockResolvedValue({ ok: true, row: { id: ROW, status: 'green' }, summary: { green: 1 }, approvalDigest: 'd1' });
  mockApproveBatch.mockResolvedValue({ ok: true, approved: 3, annual_delta_cents: 26200, approved_at: '2026-12-01T12:00:00.000Z', approvalDigest: 'd2', summary: { approved: 3 } });
  mockSendBatchEmail.mockResolvedValue({ sent: true, channel: 'email', subject: 'ACT: Rate review', rows: 6 });
  mockUpdateConfig.mockResolvedValue({ ok: true, config: { pass_through_pct: 4 }, changed: { pass_through_pct: { from: 3.5, to: 4 } } });
});

const ROW = '3f1d2a6e-9b7c-4d21-8e5a-0c4b9a1f2d33';

afterAll(() => { delete process.env.GATE_RATE_REVIEW; });

describe('gate off', () => {
  test.each([
    ['GET', '/batches'], ['GET', '/batches/2026-12'], ['POST', '/batches/2026-12/build'], ['POST', '/batches/2026-12/digest'],
    ['PUT', `/batches/2026-12/rows/${ROW}`], ['POST', '/batches/2026-12/approve'], ['PUT', '/config'],
  ])('%s %s answers 404 and calls nothing', async (method, path) => {
    process.env.GATE_RATE_REVIEW = 'false';
    await withServer(async (base) => {
      const out = await call(base, method, `/api/admin/rate-review${path}`);
      expect(out.status).toBe(404);
      expect(out.body).toEqual({ error: 'Rate review is not enabled' });
    });
    expect(mockListBatches).not.toHaveBeenCalled();
    expect(mockGetBatch).not.toHaveBeenCalled();
    expect(mockBuildBatch).not.toHaveBeenCalled();
    expect(mockUpdateRow).not.toHaveBeenCalled();
    expect(mockApproveBatch).not.toHaveBeenCalled();
    expect(mockSendBatchEmail).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  test('unauthenticated → 401, technician → 403, both before the gate read', async () => {
    process.env.GATE_RATE_REVIEW = 'false';
    await withServer(async (base) => {
      expect((await call(base, 'GET', '/api/admin/rate-review/batches', { token: null })).status).toBe(401);
      expect((await call(base, 'GET', '/api/admin/rate-review/batches', { token: 'tech' })).status).toBe(403);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build', { token: 'tech' })).status).toBe(403);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/digest', { token: 'tech' })).status).toBe(403);
      expect((await call(base, 'PUT', `/api/admin/rate-review/batches/2026-12/rows/${ROW}`, { token: 'tech', body: { status: 'skipped' } })).status).toBe(403);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/approve', { token: 'tech', body: { expectedDigest: 'x' } })).status).toBe(403);
      expect((await call(base, 'PUT', '/api/admin/rate-review/config', { token: 'tech', body: { cap_pct: 1 } })).status).toBe(403);
    });
    expect(mockUpdateRow).not.toHaveBeenCalled();
    expect(mockApproveBatch).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  test('GET /batches lists batches with the config', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'GET', '/api/admin/rate-review/batches');
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ enabled: true, batches: [{ batch_key: '2026-12', rows: 6, statuses: { green: 3 } }], config: { pass_through_pct: 3.5, cost_block: '' } });
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
      // a delivery failure is answered as one: the rebuild landed (the batch comes back), the digest did not (502)
      mockBuildBatch.mockResolvedValue({ ok: true, batchKey: '2026-12', window: { from: '2026-12-06', to: '2027-01-05' }, rows: 6, summary: { rows: 6 }, allowances: {}, digestReset: true });
      mockSendBatchEmail.mockRejectedValue(Object.assign(new Error('sendgrid 503: {"errors":[{"message":"bounced: someone@example.com"}]}'), { status: 503 }));
      const failed = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(failed.status).toBe(502);
      expect(failed.body).toMatchObject({ ok: false, built: true, reason: 'digest_delivery_failed', digest: 'failed', digestStatus: 503, batchKey: '2026-12', rows: 6 });
      expect(JSON.stringify(failed.body)).not.toMatch(/@|bounced/);
    });
  });
  test('POST /batches/:key/digest delivers the owner digest on demand under the same lock', async () => {
    mockSendBatchEmail.mockResolvedValue({ sent: true, stamped: true, channel: 'email', subject: 'ACT: Rate review — …', rows: 6 });
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/dec-2026/digest')).status).toBe(400);
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/digest');
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ ok: true, batchKey: '2026-12', sent: true, stamped: true, channel: 'email', skipped: null, subject: 'ACT: Rate review — …' });
      // the in-app ops-digest posture (GATE_OPS_DIGESTS_IN_APP) is reported as such — the bell, not contact@
      mockSendBatchEmail.mockResolvedValueOnce({ sent: true, stamped: true, channel: 'in_app', subject: 'ACT: Rate review — …', rows: 6 });
      const bell = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/digest');
      expect(bell.body).toMatchObject({ sent: true, channel: 'in_app' });
      expect(mockSendBatchEmail).toHaveBeenCalledWith({ batchKey: '2026-12' });
      expect(mockRunExclusive).toHaveBeenLastCalledWith('rate-review-monthly', expect.any(Function), { recordHealth: false, waitForSlot: false });
      // no such batch → 404; a fail-closed skip (recipient / unconfigured) is reported, not an error
      mockSendBatchEmail.mockResolvedValueOnce({ sent: false, skipped: 'no_batch' });
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-11/digest')).status).toBe(404);
      mockSendBatchEmail.mockResolvedValueOnce({ sent: false, skipped: 'recipient', subject: 'ACT: …' });
      const skipped = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/digest');
      expect(skipped.status).toBe(200);
      expect(skipped.body).toMatchObject({ sent: false, channel: null, skipped: 'recipient' });
      // already delivered (the one-email marker, read under the lock) → nothing more is sent; a rebuild clears the marker
      mockBatchEmailed.mockResolvedValueOnce(true);
      const again = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/digest');
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ ok: true, sent: false, skipped: 'already_sent' });
      expect(mockBatchEmailed).toHaveBeenLastCalledWith('2026-12');
      expect(mockSendBatchEmail).toHaveBeenCalledTimes(4); // the four sends above, none for the retry
      // a held lock → 409; a provider failure → 502 with the status only (the provider body can carry addresses)
      mockRunExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/digest')).status).toBe(409);
      mockSendBatchEmail.mockRejectedValueOnce(Object.assign(new Error('sendgrid 503: bounced: someone@example.com'), { status: 503 }));
      const failed = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/digest');
      expect(failed.status).toBe(502);
      expect(failed.body).toEqual({ error: 'The rate review digest could not be delivered — try again.', reason: 'digest_delivery_failed', digestStatus: 503 });
    });
  });
  test('a build (and its resend) runs under the monthly tick\'s own lock; a held lock answers 409, no connection 503', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(out.status).toBe(200);
      expect(mockRunExclusive).toHaveBeenCalledWith('rate-review-monthly', expect.any(Function), { recordHealth: false, waitForSlot: false });
      mockRunExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
      const held = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(held.status).toBe(409);
      expect(held.body.reason).toBe('build_in_progress');
      mockRunExclusive.mockResolvedValueOnce({ skipped: true, reason: 'no_connection' });
      const noConn = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(noConn.status).toBe(503);
      expect(noConn.body.reason).toBe('lock_unavailable');
    });
  });
  test('refuses once any row in the batch was sent, or approved by the owner', async () => {
    mockBuildBatch.mockResolvedValueOnce({ ok: false, reason: 'batch_has_sent_rows', batchKey: '2026-12' })
      .mockResolvedValueOnce({ ok: false, reason: 'batch_has_approved_rows', batchKey: '2026-12' })
      .mockResolvedValueOnce({ ok: false, reason: 'batch_changed', batchKey: '2026-12' });
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(out.status).toBe(409);
      expect(out.body.reason).toBe('batch_has_sent_rows');
      const approved = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(approved.status).toBe(409);
      expect(approved.body).toEqual({ error: 'This batch has rows you approved — it cannot be recomputed over your decision.', reason: 'batch_has_approved_rows' });
      // an edit landed while the ranking ran → the write refused instead of discarding it
      const changed = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/build');
      expect(changed.status).toBe(409);
      expect(changed.body).toEqual({ error: 'This batch was edited while it was being recomputed — build it again.', reason: 'batch_changed' });
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

describe('PUT /batches/:key/rows/:id', () => {
  test('passes the amount, status, include flag and the acting admin through; returns row + summary + digest', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'PUT', `/api/admin/rate-review/batches/2026-12/rows/${ROW}`, { body: { proposed_rate_cents: 11700, status: 'green', includeException: true } });
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ ok: true, row: { id: ROW, status: 'green' }, summary: { green: 1 }, approvalDigest: 'd1' });
      expect(mockUpdateRow).toHaveBeenCalledWith({ batchKey: '2026-12', rowId: ROW, proposedRateCents: 11700, status: 'green', includeException: true, actorId: 'admin-1' });
    });
  });
  test('an absent status/amount is null and includeException is strictly boolean true', async () => {
    await withServer(async (base) => {
      await call(base, 'PUT', `/api/admin/rate-review/batches/2026-12/rows/${ROW}`, { body: { status: 'skipped', includeException: 'yes' } });
      expect(mockUpdateRow).toHaveBeenCalledWith(expect.objectContaining({ proposedRateCents: null, status: 'skipped', includeException: false }));
    });
  });
  test.each([
    ['batch_has_sent_rows', 409], ['row_locked', 409], ['row_is_exception', 409], ['no_visits_per_year', 409], ['row_not_found', 404],
    ['proposed_below_current', 400], ['proposed_not_whole_dollars', 400], ['status_required', 400],
  ])('refusal %s → %s with the reason', async (reason, status) => {
    mockUpdateRow.mockResolvedValue({ ok: false, reason, error: `refused: ${reason}` });
    await withServer(async (base) => {
      const out = await call(base, 'PUT', `/api/admin/rate-review/batches/2026-12/rows/${ROW}`, { body: { status: 'green' } });
      expect(out.status).toBe(status);
      expect(out.body).toEqual({ error: `refused: ${reason}`, reason });
    });
  });
  test('a bad batch key is 400 before the service is called', async () => {
    await withServer(async (base) => {
      expect((await call(base, 'PUT', `/api/admin/rate-review/batches/dec/rows/${ROW}`, { body: { status: 'green' } })).status).toBe(400);
    });
    expect(mockUpdateRow).not.toHaveBeenCalled();
  });
});

describe('POST /batches/:key/approve', () => {
  test('approves against the digest the screen sent, as the acting admin', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/approve', { body: { expectedDigest: 'abc123' } });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, approved: 3, annual_delta_cents: 26200, approvalDigest: 'd2' });
      expect(mockApproveBatch).toHaveBeenCalledWith({ batchKey: '2026-12', expectedDigest: 'abc123', actorId: 'admin-1' });
    });
  });
  test('a digest mismatch is 409 and hands back the fresh digest', async () => {
    mockApproveBatch.mockResolvedValue({ ok: false, reason: 'digest_mismatch', error: 'moved', approvalDigest: 'fresh' });
    await withServer(async (base) => {
      const out = await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/approve', { body: { expectedDigest: 'stale' } });
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ error: 'moved', reason: 'digest_mismatch', approvalDigest: 'fresh' });
    });
  });
  test('nothing to approve / missing digest are 400, an unknown batch 404', async () => {
    mockApproveBatch.mockResolvedValueOnce({ ok: false, reason: 'nothing_to_approve', error: 'none' })
      .mockResolvedValueOnce({ ok: false, reason: 'digest_required', error: 'need digest' })
      .mockResolvedValueOnce({ ok: false, reason: 'batch_not_found', error: 'gone' });
    await withServer(async (base) => {
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/approve', { body: { expectedDigest: 'x' } })).status).toBe(400);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/approve', { body: {} })).status).toBe(400);
      expect((await call(base, 'POST', '/api/admin/rate-review/batches/2026-12/approve', { body: { expectedDigest: 'x' } })).status).toBe(404);
    });
    expect(mockApproveBatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedDigest: '' }));
  });
});

describe('PUT /config', () => {
  test('saves the patch as the acting admin and returns the config', async () => {
    await withServer(async (base) => {
      const out = await call(base, 'PUT', '/api/admin/rate-review/config', { body: { pass_through_pct: 4, cost_block: 'Technician pay is up 6%.' } });
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ ok: true, config: { pass_through_pct: 4 }, changed: { pass_through_pct: { from: 3.5, to: 4 } } });
      expect(mockUpdateConfig).toHaveBeenCalledWith({ patch: { pass_through_pct: 4, cost_block: 'Technician pay is up 6%.' }, actorId: 'admin-1' });
    });
  });
  test('validation refusals are 400 with every message', async () => {
    mockUpdateConfig.mockResolvedValue({ ok: false, reason: 'invalid', errors: ['cap_pct must be at most 100', 'lock_months must be a whole number'] });
    await withServer(async (base) => {
      const out = await call(base, 'PUT', '/api/admin/rate-review/config', { body: { cap_pct: 500, lock_months: 1.5 } });
      expect(out.status).toBe(400);
      expect(out.body).toEqual({ error: 'cap_pct must be at most 100', reason: 'invalid', errors: ['cap_pct must be at most 100', 'lock_months must be a whole number'] });
    });
  });
});
