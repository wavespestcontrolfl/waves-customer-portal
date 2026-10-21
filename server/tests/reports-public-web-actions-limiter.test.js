/**
 * GATE_REPORT_WEB_ACTIONS: POST /api/reports/:token/photo-check against the REAL router-wide
 * report limiter (20 a minute per IP), not a mocked one. A dark route answers 404 on every
 * request (AGENTS.md: dark routes 404 before any limiter); a live route is still limited.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
  jwt: { secret: 'test-jwt-secret' },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  reportSimpleWebLive: jest.fn(() => false),
  reportWebActionsLive: jest.fn(() => false),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn().mockImplementation(() => ({})), GetObjectCommand: jest.fn() }));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../routes/photo-id', () => ({
  photoIdLimiters: {
    sharedDailyLimiter: (req, res, next) => next(),
  },
  runCustomerPhotoId: jest.fn(),
}));
// express-rate-limit is deliberately NOT mocked.

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('../models/db');
const gates = require('../config/feature-gates');

const TOKEN = '0123456789abcdef0123456789abcdef';

// The first require of the router pulls its whole module graph (slow on a cold CI runner), so it is loaded ONCE,
// outside any timed test, and every test gets an explicit timeout. The report limiter is reset between tests.
jest.setTimeout(30000);
let router;
beforeAll(() => { router = require('../routes/reports-public'); }, 120000);
const resetReportLimiter = () => ['127.0.0.1', '::ffff:127.0.0.1', '::1'].forEach((key) => router.reportLimiter.resetKey(key));
beforeEach(() => resetReportLimiter());

async function withFreshServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/reports', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, suffix = '') => fetch(`${base}/reports/${TOKEN}/photo-check${suffix}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});

describe('photo-check against the real report limiter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => { throw new Error('the dark route must not read the database'); });
  });

  test('dark: 30 requests in a row all answer 404, never 429, with no database read', async () => {
    await withFreshServer(async (base) => {
      const statuses = (await Promise.all(Array.from({ length: 30 }, () => post(base)))).map((res) => res.status);
      expect(new Set(statuses)).toEqual(new Set([404]));
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('dark: every photo-check answer carries no-store and noindex', async () => {
    await withFreshServer(async (base) => {
      for (const suffix of ['', '/']) {
        const res = await post(base, suffix);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      }
    });
  });

  test('dark: the trailing-slash path is guarded too (Express matches it)', async () => {
    await withFreshServer(async (base) => {
      const statuses = (await Promise.all(Array.from({ length: 30 }, () => post(base, '/')))).map((res) => res.status);
      expect(new Set(statuses)).toEqual(new Set([404]));
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('live: the router limiter still applies after 20 requests', async () => {
    gates.reportSimpleWebLive.mockReturnValue(true);
    gates.reportWebActionsLive.mockReturnValue(true);
    gates.isEnabled.mockImplementation((name) => name === 'customerPhotoId');
    const record = { id: 's1', customer_id: 'c1', report_template_version: 'service_report_v1', structured_notes: null, service_type: 'Pest Control' };
    const chain = () => ({
      where: jest.fn().mockReturnThis(), leftJoin: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(record),
    });
    db.mockImplementation(() => chain());
    await withFreshServer(async (base) => {
      const statuses = (await Promise.all(Array.from({ length: 22 }, () => post(base)))).map((res) => res.status);
      expect(statuses.filter((status) => status === 400)).toHaveLength(20); // reached the handler: no photo
      expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    });
  });
});

// Production mounts the global /api limiter in server/index.js BEFORE the reports router, so the
// pre-guard is mounted app-level ahead of it (and first in the router). Real 1-request limiter here.
describe('photo-check pre-guard ahead of a real global /api limiter', () => {
  const rateLimit = jest.requireActual('express-rate-limit');
  const fs = require('fs');
  const path = require('path');

  async function withApp(fn) {
    const app = express();
    // Same order as server/index.js: privacy headers, helmet, the pre-guard, THEN cors(), the global limiter, the JSON parser.
    app.use('/api/reports', router.reportsAskPrivacyHeaders);
    app.use(helmet());
    app.use('/api/reports', router.reportPhotoCheckPreGuard);
    app.use(cors({ origin: 'https://portal.example', credentials: true }));
    app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 1, standardHeaders: true, legacyHeaders: false, message: { error: 'global limit' } }));
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/reports', router);
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    const server = app.listen(0);
    try {
      return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  const call = (base, urlPath, method = 'POST') => fetch(`${base}/api/reports/${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });

  beforeEach(() => {
    jest.clearAllMocks();
    gates.reportSimpleWebLive.mockReturnValue(false);
    gates.reportWebActionsLive.mockReturnValue(false);
    gates.isEnabled.mockReturnValue(false);
    db.mockImplementation(() => { throw new Error('a guarded request must not read the database'); });
  });

  test('dark: every POST answers 404 (slash or not, any token shape), never the global 429, with privacy headers', async () => {
    await withApp(async (base) => {
      for (const p of [`${TOKEN}/photo-check`, `${TOKEN}/photo-check/`, 'short/photo-check', `${TOKEN.toUpperCase()}/photo-check`, `${TOKEN}/PHOTO-CHECK`]) {
        for (let i = 0; i < 3; i += 1) {
          const res = await call(base, p);
          expect(res.status).toBe(404);
          expect(res.headers.get('cache-control')).toBe('no-store');
        }
      }
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('dark: OPTIONS preflight, an oversized body and an exhausted limiter all answer 404 (before cors, the limiter and the 1 MB parser)', async () => {
    await withApp(async (base) => {
      // spend the global limiter on another route first
      await call(base, `${TOKEN}/recap`, 'GET');
      expect((await call(base, `${TOKEN}/recap`, 'GET')).status).toBe(429);
      const preflight = await fetch(`${base}/api/reports/${TOKEN}/photo-check`, {
        method: 'OPTIONS', headers: { Origin: 'https://portal.example', 'Access-Control-Request-Method': 'POST' },
      });
      expect(preflight.status).toBe(404);
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
      const big = await fetch(`${base}/api/reports/${TOKEN}/photo-check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: ['x'.repeat(2 * 1024 * 1024)] }),
      });
      expect(big.status).toBe(404);
      const chunked = await fetch(`${base}/api/reports/${TOKEN}/photo-check/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
      expect(chunked.status).toBe(404);
    });
  });

  test('a dark 404 carries the helmet headers and the privacy headers (POST and OPTIONS)', async () => {
    await withApp(async (base) => {
      const post404 = await call(base, `${TOKEN}/photo-check`);
      const options404 = await fetch(`${base}/api/reports/${TOKEN}/photo-check`, { method: 'OPTIONS' });
      for (const res of [post404, options404]) {
        expect(res.status).toBe(404);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('strict-transport-security')).toBeTruthy();
        expect(res.headers.get('content-security-policy')).toBeTruthy();
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      }
    });
  });

  test('live: a malformed token is the same generic 404 before the limiter and the database', async () => {
    gates.reportSimpleWebLive.mockReturnValue(true);
    gates.reportWebActionsLive.mockReturnValue(true);
    gates.isEnabled.mockImplementation((name) => name === 'customerPhotoId');
    await withApp(async (base) => {
      for (const p of ['short/photo-check', 'nothex-nothex-nothex-nothex-nothex/photo-check/', `${TOKEN.toUpperCase()}/photo-check`]) {
        const res = await call(base, p);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Report not found' });
      }
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('other report routes still meet the global limiter (the guard touches photo-check only)', async () => {
    await withApp(async (base) => {
      const first = await call(base, `${TOKEN}/recap`, 'GET');
      const second = await call(base, `${TOKEN}/recap`, 'GET');
      expect(first.status).not.toBe(429);
      expect(second.status).toBe(429);
      expect((await call(base, `${TOKEN}/photo-check`)).status).toBe(404); // guard is ahead of the already-spent limiter
    });
  });

  test('server/index.js mounts the guard ahead of the global /api limiter', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const guard = index.indexOf("app.use('/api/reports', reportsPublicRoutes.reportPhotoCheckPreGuard)");
    // after helmet, so a dark 404 carries the helmet headers
    expect(guard).toBeGreaterThan(index.indexOf('return strictHelmet(req, res, next);'));
    expect(guard).toBeGreaterThan(index.indexOf("app.use('/api/reports', reportsPublicRoutes.reportsAskPrivacyHeaders)"));
    const limiterMount = index.indexOf("app.use('/api/', limiter)");
    expect(guard).toBeGreaterThan(-1);
    expect(limiterMount).toBeGreaterThan(guard);
    // ...and ahead of the global cors() and every JSON body parser (a dark OPTIONS or oversized POST must 404 first)
    expect(index.indexOf('app.use(cors({')).toBeGreaterThan(guard);
    const parsers = [...index.matchAll(/express\.json\(/g)].map((m) => m.index);
    expect(parsers.length).toBeGreaterThan(0);
    expect(parsers.every((at) => at > guard)).toBe(true);
  });
});
