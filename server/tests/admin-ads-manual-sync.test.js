/**
 * Manual Ads syncs and the generic campaign PUT (Ads UI audit #5, #6, #7).
 * - POST /sync runs the 6 AM cron's job (ads/google-ads-daily-sync.js) under the
 *   cron's 'google-ads-sync' lock and job_health row: every step runs with
 *   throwOnError, each failed step is named in a 502, and a held lock answers
 *   409 with nothing synced.
 * - POST /sync/meta runs both steps with throwOnError + throwOnSkip: a failed
 *   step answers 502, a lock another sync holds answers 409.
 * - PUT /campaigns/:id refuses a status change on a synced Meta campaign, as it
 *   already does on a Google one; manual / google_lsa campaigns keep it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; req.technicianId = 'admin-1'; return next(); },
  };
});

const mockGoogle = {
  isConfigured: jest.fn(),
  syncCampaigns: jest.fn(),
  syncDailyPerformance: jest.fn(),
  syncSearchTerms: jest.fn(),
};
jest.mock('../services/ads/google-ads', () => mockGoogle);
const mockMeta = {
  isConfigured: jest.fn(),
  syncCampaigns: jest.fn(),
  syncDailyPerformance: jest.fn(),
  SYNC_RUNNING: 'sync_running',
};
jest.mock('../services/ads/meta-ads', () => mockMeta);
const mockNegativesLive = jest.fn();
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  adsNegativesLive: (...a) => mockNegativesLive(...a),
}));
const mockSyncOwnerWords = jest.fn();
jest.mock('../services/ads/negative-keyword-actions', () => ({
  ...jest.requireActual('../services/ads/negative-keyword-actions'),
  syncOwnerWords: (...a) => mockSyncOwnerWords(...a),
}));
// Pass-through lock that (like the real runExclusive) records the body's
// outcome under the job name and rethrows a failure.
const mockOutcomes = {};
const passThroughLock = async (name, fn) => {
  try {
    const out = await fn();
    mockOutcomes[name] = 'success';
    return out;
  } catch (err) {
    mockOutcomes[name] = `failed: ${err.message}`;
    throw err;
  }
};
const mockRunExclusive = jest.fn();
jest.mock('../utils/cron-lock', () => ({ runExclusive: (...a) => mockRunExclusive(...a) }));

let campaignRow;
let updates;
const mockDb = jest.fn((table) => {
  if (table !== 'ad_campaigns') throw new Error(`Unexpected table in test: ${table}`);
  const b = {
    where: () => b,
    first: () => Promise.resolve(campaignRow),
    update: (patch) => {
      updates.push(patch);
      return { returning: () => Promise.resolve([{ ...campaignRow, ...patch }]) };
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

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}/api/admin/ads${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const busy = () => Object.assign(new Error('meta-ads-campaigns did not run: another sync holds the lock (lease_held)'), { code: 'sync_running' });

beforeEach(() => {
  jest.clearAllMocks();
  updates = [];
  for (const k of Object.keys(mockOutcomes)) delete mockOutcomes[k];
  mockRunExclusive.mockImplementation(passThroughLock);
  mockNegativesLive.mockReturnValue(false);
  mockSyncOwnerWords.mockResolvedValue({ pushed: 0, failed: 0, removed: 0, googleFailed: 0 });
  mockGoogle.isConfigured.mockReturnValue(true);
  mockGoogle.syncCampaigns.mockResolvedValue([{}]);
  mockGoogle.syncDailyPerformance.mockResolvedValue([{}, {}]);
  mockGoogle.syncSearchTerms.mockResolvedValue([{}, {}, {}]);
  mockMeta.isConfigured.mockReturnValue(true);
  mockMeta.syncCampaigns.mockResolvedValue([{}, {}]);
  mockMeta.syncDailyPerformance.mockResolvedValue([{}, {}, {}, {}, {}]);
});

describe('POST /sync (Google)', () => {
  test("runs the cron's job under its lock and job_health row; every step throws on error", async () => {
    const res = await call('POST', '/sync');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, synced: { campaigns: 1, performanceRows: 2, searchTerms: 3 } });
    expect(mockRunExclusive).toHaveBeenCalledWith('google-ads-sync', expect.any(Function));
    expect(mockOutcomes['google-ads-sync']).toBe('success');
    expect(mockGoogle.syncCampaigns).toHaveBeenCalledWith({ throwOnError: true });
    expect(mockGoogle.syncDailyPerformance).toHaveBeenCalledWith(7, { throwOnError: true });
    expect(mockGoogle.syncSearchTerms).toHaveBeenCalledWith(30, { throwOnError: true });
    expect(mockSyncOwnerWords).not.toHaveBeenCalled(); // GATE_ADS_NEGATIVES off
  });

  test('failed campaign and performance steps answer 502 and name them; the run records the first failure', async () => {
    mockGoogle.syncCampaigns.mockRejectedValue(new Error('PERMISSION_DENIED'));
    mockGoogle.syncDailyPerformance.mockRejectedValue(new Error('quota exceeded'));
    const res = await call('POST', '/sync');
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.failed).toEqual(['campaigns', 'performanceRows']);
    expect(res.body.error).toMatch(/Campaigns not synced: PERMISSION_DENIED/);
    expect(res.body.error).toMatch(/Performance not synced: quota exceeded/);
    expect(res.body.synced).toEqual({ campaigns: 0, performanceRows: 0, searchTerms: 3 });
    expect(mockGoogle.syncSearchTerms).toHaveBeenCalled();
    expect(mockOutcomes['google-ads-sync']).toBe('failed: PERMISSION_DENIED');
  });

  test("the owner's negative word list runs as the fourth step while GATE_ADS_NEGATIVES is on", async () => {
    mockNegativesLive.mockReturnValue(true);
    mockSyncOwnerWords.mockResolvedValue({ pushed: 2, failed: 0, removed: 1, googleFailed: 0 });
    const res = await call('POST', '/sync');
    expect(res.status).toBe(200);
    expect(res.body.synced).toEqual({
      campaigns: 1, performanceRows: 2, searchTerms: 3,
      negativeWords: { pushed: 2, failed: 0, removed: 1, googleFailed: 0 },
    });
    expect(mockSyncOwnerWords).toHaveBeenCalledTimes(1);
  });

  test('Google refusing a word fails that step (502), as in the cron', async () => {
    mockNegativesLive.mockReturnValue(true);
    mockSyncOwnerWords.mockResolvedValue({ pushed: 0, failed: 1, removed: 0, googleFailed: 1 });
    const res = await call('POST', '/sync');
    expect(res.status).toBe(502);
    expect(res.body.failed).toEqual(['negativeWords']);
    expect(res.body.error).toMatch(/Negative words not synced: negative keywords: Google did not take 1 change/);
    expect(mockOutcomes['google-ads-sync']).toMatch(/^failed: negative keywords/);
  });

  test('a held lock (cron running, or no free slot) answers 409 and syncs nothing', async () => {
    for (const reason of ['lease_held', 'no_connection']) {
      mockRunExclusive.mockResolvedValueOnce({ skipped: true, reason });
      const res = await call('POST', '/sync');
      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Google Ads sync is already running/);
    }
    expect(mockGoogle.syncCampaigns).not.toHaveBeenCalled();
    expect(mockGoogle.syncDailyPerformance).not.toHaveBeenCalled();
    expect(mockGoogle.syncSearchTerms).not.toHaveBeenCalled();
  });

  test('Google not configured: 400 and no lock taken', async () => {
    mockGoogle.isConfigured.mockReturnValue(false);
    const res = await call('POST', '/sync');
    expect(res.status).toBe(400);
    expect(mockRunExclusive).not.toHaveBeenCalled();
  });
});

describe('POST /sync/meta', () => {
  test('both steps run with throwOnError + throwOnSkip; success keeps the old body', async () => {
    const res = await call('POST', '/sync/meta');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, synced: { campaigns: 2, performanceRows: 5 } });
    expect(mockMeta.syncCampaigns).toHaveBeenCalledWith({ throwOnError: true, throwOnSkip: true });
    expect(mockMeta.syncDailyPerformance).toHaveBeenCalledWith(7, { throwOnError: true, throwOnSkip: true });
  });

  test('a failed step answers 502 and names it; the other step still runs', async () => {
    mockMeta.syncCampaigns.mockRejectedValue(new Error('Invalid token'));
    const res = await call('POST', '/sync/meta');
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.failed).toEqual(['campaigns']);
    expect(res.body.error).toMatch(/Campaigns not synced: Invalid token/);
    expect(res.body.synced).toEqual({ campaigns: 0, performanceRows: 5 });
    expect(mockMeta.syncDailyPerformance).toHaveBeenCalled();
  });

  test('a lock another sync holds answers 409, on either step', async () => {
    mockMeta.syncCampaigns.mockRejectedValueOnce(busy());
    let res = await call('POST', '/sync/meta');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Meta Ads sync is already running/);
    expect(mockMeta.syncDailyPerformance).not.toHaveBeenCalled();

    mockMeta.syncDailyPerformance.mockRejectedValueOnce(busy());
    res = await call('POST', '/sync/meta');
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test('an error without the busy code is a failed step, not a busy lock', async () => {
    mockMeta.syncDailyPerformance.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const res = await call('POST', '/sync/meta');
    expect(res.status).toBe(502);
    expect(res.body.failed).toEqual(['performanceRows']);
  });

  test('Meta not configured: 400 and no sync', async () => {
    mockMeta.isConfigured.mockReturnValue(false);
    const res = await call('POST', '/sync/meta');
    expect(res.status).toBe(400);
    expect(mockMeta.syncCampaigns).not.toHaveBeenCalled();
  });
});

describe('PUT /campaigns/:id status on synced platforms', () => {
  test('a synced Meta campaign refuses a status change and writes nothing', async () => {
    campaignRow = { id: 'c-1', platform: 'facebook', status: 'active', campaign_name: 'Meta' };
    const res = await call('PUT', '/campaigns/c-1', { status: 'paused' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Meta Ads Manager/);
    expect(updates).toEqual([]);
  });

  test('a Meta campaign still takes non-status edits, and its unchanged status', async () => {
    campaignRow = { id: 'c-1', platform: 'facebook', status: 'active', campaign_name: 'Meta' };
    let res = await call('PUT', '/campaigns/c-1', { campaign_name: 'Meta - Renamed' });
    expect(res.status).toBe(200);
    res = await call('PUT', '/campaigns/c-1', { status: 'active', target_area: 'Parrish' });
    expect(res.status).toBe(200);
    expect(updates.map(({ updated_at: _ignored, ...rest }) => rest)).toEqual([
      { campaign_name: 'Meta - Renamed' },
      { status: 'active', target_area: 'Parrish' },
    ]);
  });

  test('a google_lsa campaign can still be retired through PUT', async () => {
    campaignRow = { id: 'c-2', platform: 'google_lsa', status: 'active', campaign_name: 'LSA' };
    const res = await call('PUT', '/campaigns/c-2', { status: 'removed' });
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe('removed');
  });

  test('a Google campaign still points to /pause and /enable', async () => {
    campaignRow = { id: 'c-3', platform: 'google_ads', status: 'active', campaign_name: 'Google' };
    const res = await call('PUT', '/campaigns/c-3', { status: 'paused' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Use \/pause or \/enable/);
    expect(updates).toEqual([]);
  });
});
