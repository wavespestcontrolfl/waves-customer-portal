/**
 * GET /api/admin/ads/sync-status — per-job last-sync health from job_health so
 * the PPC dashboard can show a dead ad sync instead of rendering "no data".
 * Same owner-only guard as the rest of the ads router.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockCurrentRole = 'admin';
let mockHealthRows = [];
let mockWhereInArgs = null;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: mockCurrentRole };
      req.technicianId = 'staff-1';
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn((table) => {
  const builder = {
    whereIn: jest.fn((col, vals) => { mockWhereInArgs = { table, col, vals }; return Promise.resolve(mockHealthRows); }),
  };
  return builder;
}));
jest.mock('../services/ads/google-ads', () => ({ isConfigured: jest.fn(() => true) }));
jest.mock('../services/ads/meta-ads', () => ({ isConfigured: jest.fn(() => false) }));

const express = require('express');
const adsRouter = require('../routes/admin-ads');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ads', adsRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

beforeEach(() => {
  mockCurrentRole = 'admin';
  mockHealthRows = [];
  mockWhereInArgs = null;
});

describe('GET /api/admin/ads/sync-status', () => {
  test('is owner-only like the rest of the ads router', async () => {
    mockCurrentRole = 'technician';
    expect((await get('/api/admin/ads/sync-status')).status).toBe(403);
  });

  test('returns one row per sync job with the job_health fields and configured flag', async () => {
    mockHealthRows = [
      {
        job_name: 'google-ads-sync', last_status: 'success',
        last_success_at: new Date('2026-09-30T10:00:00Z'), last_error: null, consecutive_failures: 0,
      },
      {
        job_name: 'meta-ads-campaigns', last_status: 'failed',
        last_success_at: new Date('2026-09-28T10:00:00Z'), last_error: 'x'.repeat(500), consecutive_failures: 3,
      },
    ];

    const res = await get('/api/admin/ads/sync-status');

    expect(res.status).toBe(200);
    expect(mockWhereInArgs).toEqual({
      table: 'job_health',
      col: 'job_name',
      vals: ['google-ads-sync', 'meta-ads-campaigns', 'meta-ads-performance'],
    });
    expect(res.body.syncs).toHaveLength(3);
    expect(res.body.syncs[0]).toEqual({
      platform: 'google_ads',
      job: 'google-ads-sync',
      configured: true,
      last_success_at: '2026-09-30T10:00:00.000Z',
      last_status: 'success',
      last_error: null,
      consecutive_failures: 0,
    });
    expect(res.body.syncs[1]).toMatchObject({
      platform: 'facebook',
      job: 'meta-ads-campaigns',
      configured: false,
      last_status: 'failed',
      consecutive_failures: 3,
    });
    expect(res.body.syncs[1].last_error).toHaveLength(200); // short, not the raw 500
    // A job that never ran has no row: nulls, not a crash.
    expect(res.body.syncs[2]).toMatchObject({
      job: 'meta-ads-performance', last_status: null, last_success_at: null, consecutive_failures: 0,
    });
  });
});
