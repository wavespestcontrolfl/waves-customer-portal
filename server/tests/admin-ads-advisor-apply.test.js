/**
 * POST /api/admin/ads/advisor/apply — honest apply contract.
 *
 * The advisor "Apply" button previously always reported success even when the
 * server took no action. These pin that:
 *  - budget/mode recs resolve the campaign by name and apply via setBudget/
 *    setMode, returning applied:true and counting the action;
 *  - an unresolvable campaign or a missing/invalid value returns 422 applied:false
 *    and does NOT increment the day's applied_count;
 *  - advisory-only actions (add_negative, SEO/GBP/bid) return applied:false with
 *    manual:true and are never counted.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; return next(); },
  };
});

const mockSetBudget = jest.fn();
const mockSetMode = jest.fn();
jest.mock('../services/ads/budget-manager', () => ({
  setBudget: mockSetBudget,
  setMode: mockSetMode,
}));

let mockCampaign = null;
const mockIncrement = jest.fn().mockResolvedValue(1);
jest.mock('../models/db', () => jest.fn((table) => {
  if (table === 'ad_campaigns') {
    const b = { where: () => b, whereRaw: () => b, first: () => Promise.resolve(mockCampaign) };
    return b;
  }
  if (table === 'ad_advisor_reports') {
    return { where: () => ({ increment: mockIncrement }) };
  }
  const b = { where: () => b, orderBy: () => b, first: () => Promise.resolve(null), then: (r, j) => Promise.resolve([]).then(r, j) };
  return b;
}));

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

async function apply(body) {
  const res = await fetch(`${baseUrl}/api/admin/ads/advisor/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCampaign = null;
});

test('increase_budget resolves the campaign by name and applies', async () => {
  mockCampaign = { id: 'c-1', campaign_name: 'Pest Bradenton' };
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: true });

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetBudget).toHaveBeenCalledWith('c-1', 30, expect.any(String));
  expect(mockIncrement).toHaveBeenCalledTimes(1);
});

test('change_mode applies via setMode', async () => {
  mockCampaign = { id: 'c-9', campaign_name: 'Lawn Sarasota' };
  mockSetMode.mockResolvedValue({ campaign: 'Lawn Sarasota', newMode: 'stop' });

  const res = await apply({ action: 'change_mode', campaignName: 'Lawn Sarasota', value: 'stop' });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetMode).toHaveBeenCalledWith('c-9', 'stop', expect.any(String));
});

test('unresolvable campaign → 422 applied:false, not counted', async () => {
  mockCampaign = null;
  const res = await apply({ action: 'increase_budget', campaignName: 'Ghost Campaign', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(mockSetBudget).not.toHaveBeenCalled();
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('budget rec with no concrete value → 422 applied:false', async () => {
  mockCampaign = { id: 'c-1', campaign_name: 'Pest Bradenton' };
  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton' });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('change_mode with an invalid mode → 422 applied:false', async () => {
  mockCampaign = { id: 'c-1', campaign_name: 'Pest Bradenton' };
  const res = await apply({ action: 'change_mode', campaignName: 'Pest Bradenton', value: 'turbo' });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(mockSetMode).not.toHaveBeenCalled();
});

test('advisory-only action (add_negative) → applied:false manual, not counted', async () => {
  const res = await apply({ action: 'add_negative', value: ['cheap'] });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(false);
  expect(res.body.manual).toBe(true);
  expect(mockIncrement).not.toHaveBeenCalled();
});
