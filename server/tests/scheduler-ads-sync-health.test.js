/**
 * The daily Google (6:00) and Meta (6:15) ad-sync crons must report failures
 * to job_health. Google was not under runExclusive at all (no job_health row)
 * and every sync swallowed API errors into [] — so a dead sync read as success.
 * Same mocking shape as email-division-area-intel-cron.test.js.
 */
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'cronJobs'), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
}));
// Pass-through lock that (like the real runExclusive) records a failed body
// by name and rethrows it.
const mockJobOutcomes = {};
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (name, task) => {
    try {
      const out = await task();
      mockJobOutcomes[name] = 'success';
      return out;
    } catch (err) {
      mockJobOutcomes[name] = `failed: ${err.message}`;
      throw err;
    }
  }),
  settleDeadRunningJobs: jest.fn(async () => []),
  recordMissedTick: jest.fn(),
}));
jest.mock('../services/ads/google-ads', () => ({
  isConfigured: jest.fn(() => true),
  syncCampaigns: jest.fn(),
  syncDailyPerformance: jest.fn(),
  syncSearchTerms: jest.fn(),
}));
jest.mock('../services/ads/meta-ads', () => ({
  isConfigured: jest.fn(() => true),
  syncCampaigns: jest.fn(),
  syncDailyPerformance: jest.fn(),
}));

const cron = require('../utils/scheduled-cron');
const logger = require('../services/logger');
const { runExclusive } = require('../utils/cron-lock');
const googleAds = require('../services/ads/google-ads');
const metaAds = require('../services/ads/meta-ads');
const { initScheduledJobs } = require('../services/scheduler');

function tick(expr, marker) {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([e, cb]) => e === expr && cb.toString().includes(marker));
  expect(regs).toHaveLength(1);
  return regs[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockJobOutcomes)) delete mockJobOutcomes[k];
  googleAds.isConfigured.mockReturnValue(true);
  metaAds.isConfigured.mockReturnValue(true);
  for (const fn of [googleAds.syncCampaigns, googleAds.syncDailyPerformance, googleAds.syncSearchTerms,
    metaAds.syncCampaigns, metaAds.syncDailyPerformance]) fn.mockResolvedValue([]);
});

describe('Google Ads 6:00 cron', () => {
  const googleTick = () => tick('0 6 * * *', 'google-ads');

  test('runs under runExclusive("google-ads-sync") with throwOnError on every step', async () => {
    await googleTick()();
    expect(runExclusive).toHaveBeenCalledWith('google-ads-sync', expect.any(Function));
    expect(mockJobOutcomes['google-ads-sync']).toBe('success');
    expect(googleAds.syncCampaigns).toHaveBeenCalledWith({ throwOnError: true });
    expect(googleAds.syncDailyPerformance).toHaveBeenCalledWith(7, { throwOnError: true });
    expect(googleAds.syncSearchTerms).toHaveBeenCalledWith(30, { throwOnError: true });
  });

  test('a failed sync fails the job (job_health failed) but the remaining steps still run', async () => {
    googleAds.syncCampaigns.mockRejectedValue(new Error('invalid_grant'));
    await googleTick()(); // the tick itself logs and does not throw
    expect(mockJobOutcomes['google-ads-sync']).toBe('failed: invalid_grant');
    expect(googleAds.syncDailyPerformance).toHaveBeenCalled();
    expect(googleAds.syncSearchTerms).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Google Ads sync failed: invalid_grant'));
  });

  test('not configured is a silent no-op: no lock, no job_health row', async () => {
    googleAds.isConfigured.mockReturnValue(false);
    await googleTick()();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(googleAds.syncCampaigns).not.toHaveBeenCalled();
  });
});

describe('Meta Ads 6:15 cron', () => {
  const metaTick = () => tick('15 6 * * *', 'metaAds');

  test('passes throwOnError to both steps (each owns its own runExclusive row)', async () => {
    await metaTick()();
    expect(metaAds.syncCampaigns).toHaveBeenCalledWith({ throwOnError: true });
    expect(metaAds.syncDailyPerformance).toHaveBeenCalledWith(7, { throwOnError: true });
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('a failed campaign sync is surfaced (not swallowed) and performance still runs', async () => {
    metaAds.syncCampaigns.mockRejectedValue(new Error('Meta API campaigns: Invalid token'));
    await metaTick()();
    expect(metaAds.syncDailyPerformance).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Meta Ads sync failed: Meta API campaigns: Invalid token'));
  });

  test('not configured is a silent no-op', async () => {
    metaAds.isConfigured.mockReturnValue(false);
    await metaTick()();
    expect(metaAds.syncCampaigns).not.toHaveBeenCalled();
  });
});
