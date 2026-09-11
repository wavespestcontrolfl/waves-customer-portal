// POST /api/ops/digest — the external ops-cron → bell seam. Contract:
// 404 while the token is unset, 401 on mismatch, 409 while the in-app
// digest lane is off, 400 on a bad payload (FYI/FIRST are refused: only
// exceptions ring — owner 2026-09-11), 503 when no row landed, 201 with
// the row id (and deduped flag) otherwise. Every non-2xx is the caller's
// cue to email instead.

const mockNotifyAdmin = jest.fn();
const mockResolve = jest.fn();
const mockLockCalls = [];
const mockStanding = { row: null };
jest.mock('../models/db', () => {
  const builder = () => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'orderBy', 'select']) b[m] = jest.fn(() => b);
    b.first = jest.fn(async () => mockStanding.row);
    b.update = jest.fn(async () => 1);
    return b;
  };
  const trx = jest.fn(() => builder());
  trx.raw = jest.fn((sql, bindings) => {
    if (/pg_advisory/.test(String(sql))) mockLockCalls.push(bindings);
    return { sql, bindings };
  });
  const db = jest.fn(() => builder());
  db.raw = (sql, bindings) => ({ sql, bindings });
  db.transaction = jest.fn(async (fn) => fn(trx));
  return db;
});
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
  mockLockCalls.length = 0;
  mockStanding.row = null;
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
    // Same body an unknown route gets — nothing to distinguish it while dark.
    expect(json).toEqual({ error: 'Route not found: POST /api/ops/digest' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('every outcome carries the token-route privacy headers (no-store, noindex, no-referrer)', async () => {
    const headersOf = async (token) => {
      const res = await fetch(`${baseUrl}/api/ops/digest`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(good()) });
      return { status: res.status, cc: res.headers.get('cache-control'), robots: res.headers.get('x-robots-tag'), ref: res.headers.get('referrer-policy') };
    };
    mockNotifyAdmin.mockResolvedValue({ id: 'n-h', deduped: false });
    for (const [token, expected] of [[TOKEN, 201], ['nope', 401]]) {
      const h = await headersOf(token);
      expect(h.status).toBe(expected);
      expect(h.cc).toContain('no-store');
      expect(h.robots).toContain('noindex');
      expect(h.ref).toBe('no-referrer');
    }
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const dark = await headersOf('anything');
    expect(dark.status).toBe(404);
    expect(dark.cc).toContain('no-store');
    expect(dark.robots).toContain('noindex');
    expect(dark.ref).toBe('no-referrer');
  });

  test('the dark 404 sits ahead of the rate limiter, so a prober never sees a 429 while unset', () => {
    // Route-level order is the guarantee: darkUnlessConfigured is the first
    // handler on both POSTs (a production limiter would otherwise answer
    // 429 after 120 probes and reveal the route).
    const { darkUnlessConfigured, ingestAuth, ingestBodyErrorHandler } = router._private;
    for (const layer of router.stack.filter((l) => l.route)) {
      expect(layer.route.stack[0].handle).toBe(darkUnlessConfigured);
      // the limiter lives only in the pre-chain, so a request is counted once
      expect(layer.route.stack.map((l) => l.handle)).not.toContain(router.ingestPreParsers[2]);
    }
    // pre-chain order: privacy headers → dark → limiter → auth → parse → body errors
    const { noStore } = require('../middleware/no-store');
    expect(router.ingestPreParsers[0]).toBe(noStore);
    expect(router.ingestPreParsers[1]).toBe(darkUnlessConfigured);
    expect(router.ingestPreParsers[3]).toBe(ingestAuth);
    expect(router.ingestPreParsers[5]).toBe(ingestBodyErrorHandler);
    expect(router.ingestPreParsers).toHaveLength(6);
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const next = jest.fn();
    darkUnlessConfigured({}, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
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
      // a later run's recurrence refreshes the standing row (observedAt above all)
      refreshOnDedupe: true,
      dedupeVersion: expect.any(String),
      // probe + write share one advisory-locked transaction
      trx: expect.anything(),
      metadata: {
        check: { id: 'e22-schedule-integrity', title: 'Schedule integrity', cadence: 'daily' },
        opsKey: 'e22-schedule-integrity:overlaps-2026-09-11',
        subject: 'FIX: schedule integrity — 3 overlapping visits',
        kind: 'FIX',
        source: 'ops-crons',
        observedAt: expect.any(String),
      },
    });
  });

  test('the write takes the dedupe advisory lock first — the same one /resolve takes', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-lock', deduped: false });
    await post(good());
    expect(mockLockCalls).toEqual([['admin:ops-crons:e22-schedule-integrity:overlaps-2026-09-11']]);
  });

  test('a DELAYED re-post from an earlier run cannot lower the stored observation', async () => {
    // A recurrence already raised the standing row to 14:00.
    mockStanding.row = { created_at: new Date('2026-09-11T10:00:00Z'), observed_at: '2026-09-11T14:00:00.000Z' };
    mockNotifyAdmin.mockResolvedValue({ id: 'n-old', deduped: true });
    await post({ ...good(), observedAt: '2026-09-11T12:00:00Z' });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    // The stored 14:00 wins, so nothing regresses and the version is
    // unchanged — a plain dedupe, no rewrite, no re-bell.
    expect(opts.metadata.observedAt).toBe('2026-09-11T14:00:00.000Z');
    expect(opts.dedupeVersion).toBe('2026-09-11T14:00:00.000Z');
  });

  test('a LATER run raises the observation and so rewrites the standing row', async () => {
    mockStanding.row = { created_at: new Date('2026-09-11T10:00:00Z'), observed_at: '2026-09-11T11:00:00.000Z' };
    mockNotifyAdmin.mockResolvedValue({ id: 'n-new', deduped: true, refreshed: true });
    await post({ ...good(), observedAt: '2026-09-11T13:00:00Z' });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata.observedAt).toBe('2026-09-11T13:00:00.000Z');
    expect(opts.dedupeVersion).toBe('2026-09-11T13:00:00.000Z');
  });

  test('laterOf and the standing probe: no standing row, unparsable or missing observation all fall back to the incoming value', async () => {
    const { laterOf } = router._private;
    expect(laterOf(null, '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T12:00:00.000Z');
    expect(laterOf(undefined, '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T12:00:00.000Z');
    expect(laterOf('nonsense', '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T12:00:00.000Z');
    expect(laterOf('2026-09-11T09:00:00.000Z', '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T12:00:00.000Z');
    expect(laterOf(new Date('2026-09-11T15:00:00Z'), '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T15:00:00.000Z');
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

  test('observedAt: caller ISO timestamp is honoured, future or garbage falls back to now, and it is seam-owned', () => {
    const { observedAtFrom } = router._private;
    const now = Date.parse('2026-09-11T12:00:00.000Z');
    expect(observedAtFrom('2026-09-11T11:10:00Z', now)).toBe('2026-09-11T11:10:00.000Z');
    expect(observedAtFrom('2027-01-01T00:00:00Z', now)).toBe('2026-09-11T12:00:00.000Z');
    expect(observedAtFrom('nope', now)).toBe('2026-09-11T12:00:00.000Z');
    expect(observedAtFrom(undefined, now)).toBe('2026-09-11T12:00:00.000Z');
    expect(validateDigest({ ...good(), observedAt: '2026-09-11T11:10:00Z', metadata: { observedAt: 'spoof' } }).value.metadata).toEqual({});
  });

  test('resolve passes the clean run observation as notAfter', async () => {
    mockResolve.mockResolvedValue(1);
    const res = await fetch(`${baseUrl}/api/ops/digest/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ key: 'k1', observedAt: '2026-09-11T11:10:00Z' }) });
    expect(res.status).toBe(200);
    expect(mockResolve.mock.calls[0][0].notAfter).toBe('2026-09-11T11:10:00.000Z');
  });

  test('metadata cannot override the seam fields or pre-resolve the finding', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n2', deduped: false });
    await post({ ...good(), metadata: { source: 'spoof', opsKey: 'spoof', kind: 'FYI', resolved: true, resolvedAt: 'x', resolvedBy: 'y', dedupeKey: 'z', keep: 1 } });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata).toEqual({
      keep: 1,
      opsKey: 'e22-schedule-integrity:overlaps-2026-09-11',
      subject: 'FIX: schedule integrity — 3 overlapping visits',
      kind: 'FIX',
      source: 'ops-crons',
      observedAt: expect.any(String),
    });
    expect(opts.metadata.resolved).toBeUndefined();
    expect(validateDigest({ ...good(), metadata: { resolved: true } }).value.metadata).toEqual({});
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

  test('same auth as ingest: 404 unset (generic body), 401 mismatch', async () => {
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const dark = await resolve({ key: 'k' });
    expect(dark.status).toBe(404);
    expect(dark.json).toEqual({ error: 'Route not found: POST /api/ops/digest/resolve' });
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
    expect(mockResolve).toHaveBeenCalledWith({ key: 'e22-schedule-integrity:overlaps', source: 'ops-crons', lockKey: 'ops-crons:e22-schedule-integrity:overlaps', notAfter: expect.any(String), resolvedBy: 'ops-crons:3-clean-runs' });
  });

  test('nothing standing is still a 200 with resolved 0; bad key is 400', async () => {
    mockResolve.mockResolvedValue(0);
    expect((await resolve({ key: 'never-rang' })).json).toEqual({ ok: true, resolved: 0 });
    expect(mockResolve).toHaveBeenCalledWith({ key: 'never-rang', source: 'ops-crons', lockKey: 'ops-crons:never-rang', notAfter: expect.any(String), resolvedBy: 'ops-crons' });
    expect((await resolve({ key: 'has spaces' })).status).toBe(400);
    expect((await resolve({})).status).toBe(400);
  });
});

describe('dark 404 body equals the app-level unknown-route body', () => {
  test('genericNotFound, the router and the pre-router gate all emit exactly what middleware/errors.js notFound emits', async () => {
    const { notFound } = require('../middleware/errors');
    const { genericNotFound } = router._private;
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const capture = () => { const r = { status: jest.fn(() => r), json: jest.fn(() => r) }; return r; };
    const req = { method: 'POST', originalUrl: '/api/ops/digest?x=1', path: '/api/ops/digest' };
    const a = capture(); notFound(req, a);
    const b = capture(); genericNotFound({ ...req, path: '/' }, b); // inside the mounted router req.path is the remainder
    expect(b.json.mock.calls[0][0]).toEqual(a.json.mock.calls[0][0]);
    // and over HTTP: an unknown sibling path through the real notFound vs the dark route
    const app = express();
    app.use('/api/ops/digest', ...router.ingestPreParsers);
    app.use('/api/ops/digest', router);
    app.use(notFound);
    const s2 = app.listen(0); const base = `http://127.0.0.1:${s2.address().port}`;
    try {
      const dark = await (await fetch(`${base}/api/ops/digest`, { method: 'POST' })).json();
      const unknown = await (await fetch(`${base}/api/ops/nothing`, { method: 'POST' })).json();
      expect(Object.keys(dark)).toEqual(Object.keys(unknown));
      expect(dark.error.replace('/api/ops/digest', '/api/ops/nothing')).toBe(unknown.error);
    } finally { await new Promise((r) => s2.close(r)); }
  });
});

describe('pre-parser chain (mounted ahead of the global JSON parser, like server/index.js)', () => {
  function chainServer() {
    const app = express();
    app.use('/api/ops/digest', ...router.ingestPreParsers);
    app.use(express.json({ limit: '1mb' })); // the "global" parser comes AFTER
    app.use('/api/ops/digest', router);
    const server = app.listen(0);
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
  }
  async function raw(baseUrl, body, token) {
    const res = await fetch(`${baseUrl}/api/ops/digest`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
    let json = null; try { json = await res.json(); } catch { /* html */ }
    return { status: res.status, json };
  }

  test('token unset + malformed body → generic 404, never 400', async () => {
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const { server: s2, baseUrl } = chainServer();
    try {
      const out = await raw(baseUrl, '{not json', 'anything');
      expect(out.status).toBe(404);
      expect(out.json).toEqual({ error: 'Route not found: POST /api/ops/digest' });
    } finally { await new Promise((r) => s2.close(r)); }
  });

  test('token set + wrong bearer + malformed body → 401 (auth before parse)', async () => {
    const { server: s2, baseUrl } = chainServer();
    try {
      expect((await raw(baseUrl, '{not json', 'nope')).status).toBe(401);
      expect((await raw(baseUrl, '{not json', null)).status).toBe(401);
    } finally { await new Promise((r) => s2.close(r)); }
  });

  test('token set + right bearer + malformed body → 400 JSON from the chain handler', async () => {
    const { server: s2, baseUrl } = chainServer();
    try {
      const out = await raw(baseUrl, '{not json', TOKEN);
      expect(out.status).toBe(400);
      expect(out.json).toEqual({ ok: false, reason: 'invalid_json' });
      const big = await raw(baseUrl, JSON.stringify({ ...good(), body: 'x'.repeat(1100 * 1024) }), TOKEN);
      expect(big.status).toBe(413);
      expect(big.json).toEqual({ ok: false, reason: 'payload_too_large' });
    } finally { await new Promise((r) => s2.close(r)); }
  });
});

describe('server/index.js mount order (unobservable-when-dark)', () => {
  // The route contract promises a plain 404 while the token is unset, at any
  // request volume and for any body. That holds only if the pre-router gate
  // is mounted BEFORE the global /api/ limiter and BEFORE the global JSON
  // parser. The real app boots a server + DB, so this pins the ORDER
  // statically from the entrypoint source instead (pre-push P1 on #4397).
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (needle) => { const i = src.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };

  test('the /api/ops/digest dark gate precedes the global cors(), the global /api/ limiter, the global JSON parser, and the router mount', () => {
    const gate = at("app.use('/api/ops/digest', require('./middleware/no-store').noStore, (req, res, next) => {");
    expect(src.slice(gate, gate + 600)).toContain('OPS_DIGEST_INGEST_TOKEN');
    // an OPTIONS preflight must hit the dark 404 before cors() can answer 204
    expect(gate).toBeLessThan(at("app.use(cors({"));
    expect(gate).toBeLessThan(at("app.use('/api/', limiter);"));
    expect(gate).toBeLessThan(at("app.use(express.json({ limit: '1mb'"));
    expect(gate).toBeLessThan(at("app.use('/api/ops/digest', require('./routes/ops-digest-ingest'));"));
  });

  test('the ingest pre-parser chain is mounted before the global JSON parser and before the router', () => {
    const pre = at("app.use('/api/ops/digest', ...require('./routes/ops-digest-ingest').ingestPreParsers);");
    expect(pre).toBeLessThan(at("app.use(express.json({ limit: '1mb'"));
    expect(pre).toBeLessThan(at("app.use('/api/ops/digest', require('./routes/ops-digest-ingest'));"));
    expect(pre).toBeGreaterThan(at("app.use('/api/', limiter);"));
  });
});

