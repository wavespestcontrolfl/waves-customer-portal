/**
 * GET /api/admin/ads/health — the read-only Ad health card (GATE_ADS_HEALTH_CARD, owner 2026-11-04 option A).
 * Gate off (anything but the exact string 'true'): 404 and the health service never runs. Same owner-only guard as
 * the rest of the ads router.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockCurrentRole = 'admin';
const mockBuildAdsHealth = jest.fn();

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
jest.mock('../models/db', () => jest.fn(() => { throw new Error('the health route reads no table itself'); }));
jest.mock('../services/ads/ads-health', () => ({ buildAdsHealth: (...args) => mockBuildAdsHealth(...args) }));
// The router must not load the Google Ads SDK module on its own.
jest.mock('../services/ads/google-ads', () => { throw new Error('google-ads SDK module must not load for the health route'); });

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

const ORIGINAL = process.env.GATE_ADS_HEALTH_CARD;
beforeEach(() => {
  mockCurrentRole = 'admin';
  mockBuildAdsHealth.mockReset();
  delete process.env.GATE_ADS_HEALTH_CARD;
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.GATE_ADS_HEALTH_CARD;
  else process.env.GATE_ADS_HEALTH_CARD = ORIGINAL;
});

describe('GET /api/admin/ads/health', () => {
  test.each([undefined, 'false', 'TRUE', '1', 'shadow'])('gate %p: 404 and the service never runs', async (value) => {
    if (value !== undefined) process.env.GATE_ADS_HEALTH_CARD = value;

    const res = await get('/api/admin/ads/health');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'ads_health_off' });
    expect(mockBuildAdsHealth).not.toHaveBeenCalled();
  });

  test('gate on: answers the service payload', async () => {
    process.env.GATE_ADS_HEALTH_CARD = 'true';
    const payload = { generatedAt: '2026-11-05T05:40:00.000Z', google: { configured: false }, uploads: {}, timeline: [], notes: [] };
    mockBuildAdsHealth.mockResolvedValue(payload);

    const res = await get('/api/admin/ads/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(mockBuildAdsHealth).toHaveBeenCalledTimes(1);
  });

  test('is owner-only like the rest of the ads router', async () => {
    process.env.GATE_ADS_HEALTH_CARD = 'true';
    mockCurrentRole = 'technician';

    expect((await get('/api/admin/ads/health')).status).toBe(403);
    expect(mockBuildAdsHealth).not.toHaveBeenCalled();
  });
});
