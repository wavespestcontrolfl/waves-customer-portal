// POST /api/ops/digest — the external ops-cron → bell seam. Contract:
// 404 while the token is unset, 401 on mismatch, 409 while the in-app
// digest lane is off, 400 on a bad payload (FYI/FIRST are refused: only
// exceptions ring — owner 2026-09-11), 503 when no row landed, 201 with
// the row id (and deduped flag) otherwise. Every non-2xx is the caller's
// cue to email instead.

const mockNotifyAdmin = jest.fn();
const mockResolve = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
jest.mock('../services/ops-digest', () => {
  const actual = jest.requireActual('../services/ops-digest');
  return { ...actual, resolveOpsDigest: (...args) => mockResolve(...args) };
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const router = require('../routes/ops-digest-ingest');
const { validateDigest, KINDS } = router._private;

const TOKEN = 'ops-test-token-0123456789';

function lane(on) {
  process.env.GATE_OPS_DIGESTS_IN_APP = on ? 'true' : '';
  process.env.GATE_AGENT_ACTIVITY = on ? 'true' : '';
}

function appServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/ops/digest', router);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

const good = () => ({
  key: 'e22-schedule-integrity:overlaps-2026-09-11',
  kind: 'FIX',
  subject: 'schedule integrity — 3 overlapping visits',
  body: 'visit 0b9fce27 overlaps 11425c5f\nvisit 1a7f3f9a overlaps 1b0544b8',
  link: '/admin/agents?tab=activity',
  metadata: { check: { id: 'e22-schedule-integrity', title: 'Schedule integrity', cadence: 'daily' } },
});

let server; let baseUrl;
beforeEach(() => {
  mockNotifyAdmin.mockReset();
  mockResolve.mockReset();
  process.env.NODE_ENV = 'test';
  process.env.OPS_DIGEST_INGEST_TOKEN = TOKEN;
  lane(true);
  ({ server, baseUrl } = appServer());
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.OPS_DIGEST_INGEST_TOKEN;
});

async function post(body, { token = TOKEN } = {}) {
  const res = await fetch(`${baseUrl}/api/ops/digest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('auth and gates', () => {
  test('404 while the token is unset — the endpoint does not exist', async () => {
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const { status, json } = await post(good());
    expect(status).toBe(404);
    expect(json).toEqual({ ok: false, reason: 'not_configured' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('401 on a wrong or missing bearer', async () => {
    expect((await post(good(), { token: 'nope' })).status).toBe(401);
    expect((await post(good(), { token: null })).status).toBe(401);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('409 while the in-app digest lane is off (either gate)', async () => {
    lane(false);
    expect((await post(good())).status).toBe(409);
    process.env.GATE_OPS_DIGESTS_IN_APP = 'true';
    process.env.GATE_AGENT_ACTIVITY = '';
    const { status, json } = await post(good());
    expect(status).toBe(409);
    expect(json.reason).toBe('in_app_disabled');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('payload', () => {
  test('exceptions only: FYI and FIRST are refused, FIX and ACT accepted (case-insensitive)', () => {
    expect([...KINDS].sort()).toEqual(['ACT', 'FIX']);
    expect(validateDigest({ ...good(), kind: 'FYI' }).error).toMatch(/FIX or ACT/);
    expect(validateDigest({ ...good(), kind: 'FIRST' }).error).toMatch(/FIX or ACT/);
    expect(validateDigest({ ...good(), kind: 'act' }).value.kind).toBe('ACT');
  });

  test('rejects a bad key, an empty subject/body, an off-portal link and oversized fields', () => {
    expect(validateDigest({ ...good(), key: 'has spaces' }).error).toMatch(/key/);
    expect(validateDigest({ ...good(), key: 'x'.repeat(121) }).error).toMatch(/key/);
    expect(validateDigest({ ...good(), subject: '   ' }).error).toMatch(/subject is required/);
    expect(validateDigest({ ...good(), subject: 's'.repeat(181) }).error).toMatch(/subject exceeds/);
    expect(validateDigest({ ...good(), body: '' }).error).toMatch(/body is required/);
    expect(validateDigest({ ...good(), body: 'b'.repeat(60001) }).error).toMatch(/body exceeds/);
    expect(validateDigest({ ...good(), link: 'https://evil.example/admin' }).error).toMatch(/\/admin path/);
    expect(validateDigest({ ...good(), link: '/customer/x' }).error).toMatch(/\/admin path/);
    expect(validateDigest({ ...good(), link: '/adminx' }).error).toMatch(/\/admin path/);
    expect(validateDigest({ ...good(), metadata: [1] }).error).toMatch(/metadata/);
    expect(validateDigest({ ...good(), metadata: { blob: 'm'.repeat(5000) } }).error).toMatch(/metadata exceeds/);
    expect(validateDigest('nope').error).toMatch(/JSON object/);
  });

  test('accepts /admin, /admin/, /admin?x and /admin#x links and a null link', () => {
    for (const link of ['/admin', '/admin/', '/admin?tab=x', '/admin#y', null]) {
      expect(validateDigest({ ...good(), link }).value.link).toBe(link);
    }
    expect(validateDigest({ ...good(), link: undefined }).value.link).toBe(null);
  });

  test('400 over HTTP with the reason and no bell write', async () => {
    const { status, json } = await post({ ...good(), kind: 'FYI' });
    expect(status).toBe(400);
    expect(json.reason).toBe('invalid_payload');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('bell write', () => {
  test('201: one ops_digest row, bell:true, opsKey/subject/kind/source metadata, rolling-day dedupe', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n1', deduped: false });
    const { status, json } = await post(good());
    expect(status).toBe(201);
    expect(json).toEqual({ ok: true, id: 'n1', deduped: false });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('ops_digest');
    expect(title).toBe('FIX: schedule integrity — 3 overlapping visits');
    expect(body).toBe('visit 0b9fce27 overlaps 11425c5f\nvisit 1a7f3f9a overlaps 1b0544b8');
    expect(opts).toEqual({
      link: '/admin/agents?tab=activity',
      bell: true,
      dedupeKey: 'ops-crons:e22-schedule-integrity:overlaps-2026-09-11',
      dedupeWindowMs: 24 * 60 * 60 * 1000,
      metadata: {
        check: { id: 'e22-schedule-integrity', title: 'Schedule integrity', cadence: 'daily' },
        opsKey: 'e22-schedule-integrity:overlaps-2026-09-11',
        subject: 'FIX: schedule integrity — 3 overlapping visits',
        kind: 'FIX',
        source: 'ops-crons',
      },
    });
  });

  test('201 with deduped:true when the keyed row already stands', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-old', deduped: true });
    const { status, json } = await post(good());
    expect(status).toBe(201);
    expect(json).toEqual({ ok: true, id: 'n-old', deduped: true });
  });

  test('503 when the write returns null, a suppression sentinel, or throws', async () => {
    mockNotifyAdmin.mockResolvedValueOnce(null);
    expect((await post(good())).status).toBe(503);
    mockNotifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true });
    expect((await post(good())).status).toBe(503);
    mockNotifyAdmin.mockRejectedValueOnce(new Error('db down'));
    const { status, json } = await post(good());
    expect(status).toBe(503);
    expect(json).toEqual({ ok: false, reason: 'bell_write_failed' });
  });

  test('metadata cannot override the seam fields', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n2', deduped: false });
    await post({ ...good(), metadata: { source: 'spoof', opsKey: 'spoof', kind: 'FYI' } });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata.source).toBe('ops-crons');
    expect(opts.metadata.opsKey).toBe('e22-schedule-integrity:overlaps-2026-09-11');
    expect(opts.metadata.kind).toBe('FIX');
  });
});

describe('POST /resolve (fall-off rule)', () => {
  async function resolve(body, { token = TOKEN } = {}) {
    const res = await fetch(`${baseUrl}/api/ops/digest/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  test('same auth as ingest: 404 unset, 401 mismatch', async () => {
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    expect((await resolve({ key: 'k' })).status).toBe(404);
    process.env.OPS_DIGEST_INGEST_TOKEN = TOKEN;
    expect((await resolve({ key: 'k' }, { token: 'nope' })).status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('retires the key scoped to source ops-crons and reports the count; works with the lane off', async () => {
    lane(false); // retiring history must not depend on the ingest lane
    mockResolve.mockResolvedValue(2);
    const { status, json } = await resolve({ key: 'e22-schedule-integrity:overlaps', successes: 3 });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, resolved: 2 });
    expect(mockResolve).toHaveBeenCalledWith({ key: 'e22-schedule-integrity:overlaps', source: 'ops-crons', resolvedBy: 'ops-crons:3-clean-runs' });
  });

  test('nothing standing is still a 200 with resolved 0; bad key is 400', async () => {
    mockResolve.mockResolvedValue(0);
    expect((await resolve({ key: 'never-rang' })).json).toEqual({ ok: true, resolved: 0 });
    expect(mockResolve).toHaveBeenCalledWith({ key: 'never-rang', source: 'ops-crons', resolvedBy: 'ops-crons' });
    expect((await resolve({ key: 'has spaces' })).status).toBe(400);
    expect((await resolve({})).status).toBe(400);
  });
});
