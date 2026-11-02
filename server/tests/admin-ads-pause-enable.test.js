/**
 * POST /campaigns/:id/pause and /enable. A campaign linked to Google (and Google
 * configured) changes locally ONLY when Google confirms. A failed Google call
 * (null) answers 502 and writes nothing. An unlinked campaign, or Google not
 * configured, keeps the local-only change with googleAdsUpdated: false.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), adsGapRuleMode: () => 'off' }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; req.technicianId = 'admin-1'; return next(); },
  };
});
const mockIsConfigured = jest.fn();
const mockPause = jest.fn();
const mockEnable = jest.fn();
jest.mock('../services/ads/google-ads', () => ({
  isConfigured: mockIsConfigured,
  pauseCampaign: mockPause,
  enableCampaign: mockEnable,
}));

let campaignRow;
let updates;
const mockDb = jest.fn((table) => {
  if (table !== 'ad_campaigns') throw new Error(`Unexpected table in test: ${table}`);
  const b = {
    where: () => b,
    first: () => Promise.resolve(campaignRow),
    update: (patch) => {
      updates.push(patch);
      campaignRow = { ...campaignRow, ...patch };
      return { returning: () => Promise.resolve([campaignRow]) };
    },
  };
  return b;
});
jest.mock('../models/db', () => mockDb);

const express = require('express');
const adsRouter = require('../routes/admin-ads');

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ads', adsRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

async function post(path) {
  const res = await fetch(`${baseUrl}/api/admin/ads${path}`, { method: 'POST' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeEach(() => {
  jest.clearAllMocks();
  updates = [];
  mockIsConfigured.mockReturnValue(true);
  campaignRow = { id: 'c-1', campaign_name: 'Waves', platform: 'google_ads', platform_campaign_id: '123', status: 'active' };
});

describe.each([
  ['pause', mockPause, 'paused', 'active', /did not confirm the pause\. Nothing changed\./],
  ['enable', mockEnable, 'active', 'paused', /did not confirm the restart\. Nothing changed\./],
])('POST /campaigns/:id/%s', (action, googleCall, newStatus, startStatus, errorText) => {
  beforeEach(() => { campaignRow.status = startStatus; });

  test('Google returns null -> 502 and nothing is written', async () => {
    googleCall.mockResolvedValue(null);
    const res = await post(`/campaigns/c-1/${action}`);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(errorText);
    expect(updates).toEqual([]);
    expect(campaignRow.status).toBe(startStatus);
  });

  test('Google confirms -> 200 and the status changes', async () => {
    googleCall.mockResolvedValue({ success: true });
    const res = await post(`/campaigns/c-1/${action}`);
    expect(res.status).toBe(200);
    expect(googleCall).toHaveBeenCalledWith('123');
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe(newStatus);
    expect(res.body).toMatchObject({ campaign: { status: newStatus }, googleAdsUpdated: true });
  });

  test('an unlinked campaign changes locally and never calls Google', async () => {
    campaignRow.platform_campaign_id = null;
    const res = await post(`/campaigns/c-1/${action}`);
    expect(res.status).toBe(200);
    expect(googleCall).not.toHaveBeenCalled();
    expect(updates[0].status).toBe(newStatus);
    expect(res.body.googleAdsUpdated).toBe(false);
  });

  test('Google not configured changes locally and never calls Google', async () => {
    mockIsConfigured.mockReturnValue(false);
    const res = await post(`/campaigns/c-1/${action}`);
    expect(res.status).toBe(200);
    expect(googleCall).not.toHaveBeenCalled();
    expect(updates[0].status).toBe(newStatus);
    expect(res.body.googleAdsUpdated).toBe(false);
  });
});
