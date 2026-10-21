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
const db = require('../models/db');
const gates = require('../config/feature-gates');

const TOKEN = '0123456789abcdef0123456789abcdef';

async function withFreshServer(fn) {
  let router;
  jest.isolateModules(() => { router = require('../routes/reports-public'); });
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
      const statuses = [];
      for (let i = 0; i < 30; i += 1) statuses.push((await post(base)).status);
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
      const statuses = [];
      for (let i = 0; i < 30; i += 1) statuses.push((await post(base, '/')).status);
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
      const statuses = [];
      for (let i = 0; i < 22; i += 1) statuses.push((await post(base)).status);
      expect(statuses.slice(0, 20).every((status) => status === 400)).toBe(true); // reached the handler: no photo
      expect(statuses.slice(20)).toEqual([429, 429]);
    });
  });
});
