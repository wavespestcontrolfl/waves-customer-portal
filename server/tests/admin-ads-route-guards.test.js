/**
 * admin-ads route guards — the ads router mutates real Google Ads spend and the
 * state the autonomous budget cron acts on, so these pin the two protections the
 * routes previously lacked entirely (no route-layer test existed):
 *
 *  - requireAdmin on every spend/state-mutating endpoint (a technician-role
 *    token must NOT be able to change budgets, pause campaigns, sync, or apply
 *    advisor actions); reads stay tech-or-admin.
 *  - write-body whitelisting/validation on POST/PUT /campaigns, /campaigns/:id/
 *    budget, and PUT /targets — no raw mass-assignment of budget_mode /
 *    daily_budget_base / platform, no out-of-range capacity thresholds, no NaN/
 *    negative budgets.
 *
 * The real requireAdmin/requireTechOrAdmin/sanitizers run; only adminAuthenticate
 * is stubbed to inject a controllable role, and db is stubbed so a rejected write
 * never reaches Postgres.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockCurrentRole = 'admin';

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

// db stub: chainable builder that resolves to [] for reads; write paths under
// test are rejected by validation BEFORE any db call, so they never resolve.
const mockDb = jest.fn(() => {
  const builder = {
    where: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    first: jest.fn(() => Promise.resolve(null)),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  return builder;
});
jest.mock('../models/db', () => mockDb);

const express = require('express');
const adsRouter = require('../routes/admin-ads');

// Real listen + fetch round-trips (repo has no supertest at the root).
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

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

beforeEach(() => {
  mockCurrentRole = 'admin';
  jest.clearAllMocks();
});

describe('requireAdmin on spend/state-mutating endpoints', () => {
  const mutating = [
    ['post', '/api/admin/ads/campaigns'],
    ['put', '/api/admin/ads/campaigns/c-1'],
    ['post', '/api/admin/ads/campaigns/c-1/mode'],
    ['post', '/api/admin/ads/campaigns/c-1/budget'],
    ['post', '/api/admin/ads/campaigns/c-1/pause'],
    ['post', '/api/admin/ads/campaigns/c-1/enable'],
    ['post', '/api/admin/ads/sync'],
    ['post', '/api/admin/ads/sync/meta'],
    ['post', '/api/admin/ads/call-bridge/apply'],
    ['post', '/api/admin/ads/advisor/generate'],
    ['post', '/api/admin/ads/advisor/apply'],
    ['post', '/api/admin/ads/fixed-costs'],
    ['put', '/api/admin/ads/targets'],
  ];

  test.each(mutating)('technician role gets 403 on %s %s', async (method, path) => {
    mockCurrentRole = 'technician';
    const res = await call(method, path, {});
    expect(res.status).toBe(403);
  });

  test('reads stay open to technicians (GET /campaigns)', async () => {
    mockCurrentRole = 'technician';
    const res = await call('get', '/api/admin/ads/campaigns');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('campaigns');
  });
});

describe('write-body validation (admin role)', () => {
  test('POST /campaigns rejects a managed spend field (budget_mode)', async () => {
    const res = await call('post', '/api/admin/ads/campaigns', { campaign_name: 'X', platform: 'google_ads', budget_mode: 'garbage' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/budget_mode/);
  });

  test('POST /campaigns rejects an unknown platform', async () => {
    const res = await call('post', '/api/admin/ads/campaigns', { campaign_name: 'X', platform: 'evil' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/platform/);
  });

  test('POST /campaigns rejects a non-digit platform_campaign_id', async () => {
    const res = await call('post', '/api/admin/ads/campaigns', { campaign_name: 'X', platform: 'google_ads', platform_campaign_id: '1 OR 1=1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/platform_campaign_id/);
  });

  test('PUT /campaigns/:id rejects repointing identity (platform)', async () => {
    const res = await call('put', '/api/admin/ads/campaigns/c-1', { platform: 'google_ads' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/platform/);
  });

  test('PUT /campaigns/:id rejects a managed budget field (daily_budget_base)', async () => {
    const res = await call('put', '/api/admin/ads/campaigns/c-1', { daily_budget_base: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/daily_budget_base/);
  });

  test('POST /campaigns/:id/budget rejects a negative amount', async () => {
    const res = await call('post', '/api/admin/ads/campaigns/c-1/budget', { budget: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/budget/);
  });

  test('POST /campaigns/:id/budget rejects zero', async () => {
    const res = await call('post', '/api/admin/ads/campaigns/c-1/budget', { budget: 0 });
    expect(res.status).toBe(400);
  });

  test('POST /campaigns/:id/budget rejects a non-numeric / trailing-garbage amount', async () => {
    expect((await call('post', '/api/admin/ads/campaigns/c-1/budget', { budget: 'abc' })).status).toBe(400);
    expect((await call('post', '/api/admin/ads/campaigns/c-1/budget', { budget: '50junk' })).status).toBe(400);
  });

  test('POST /campaigns/:id/budget rejects an amount above the storable maximum', async () => {
    const res = await call('post', '/api/admin/ads/campaigns/c-1/budget', { budget: 100000000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/≤|maximum/);
  });

  test('PUT /targets rejects an out-of-range capacity threshold', async () => {
    const res = await call('put', '/api/admin/ads/targets', { capacity_green_max: 200 });
    expect(res.status).toBe(400);
  });

  test('PUT /targets rejects mis-ordered thresholds (green ≥ yellow)', async () => {
    const res = await call('put', '/api/admin/ads/targets', { capacity_green_max: 90, capacity_yellow_max: 80, capacity_orange_max: 95 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/green < yellow < orange/);
  });

  test('PUT /targets rejects a non-integer max_services_per_tech', async () => {
    const res = await call('put', '/api/admin/ads/targets', { max_services_per_tech: 2.5 });
    expect(res.status).toBe(400);
  });

  test('PUT /targets rejects a null threshold that breaks the effective ordering', async () => {
    // Clearing green to null persists null → cron reads its default (70); with
    // yellow=60 that violates green<yellow, so it must be rejected up front.
    const res = await call('put', '/api/admin/ads/targets', {
      capacity_green_max: null, capacity_yellow_max: 60, capacity_orange_max: 90,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/green < yellow < orange/);
  });

  test('POST /campaigns rejects an invalid initial status', async () => {
    const res = await call('post', '/api/admin/ads/campaigns', { campaign_name: 'X', platform: 'google_ads', status: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/);
  });
});
