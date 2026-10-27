/**
 * The weekly permit-sync job body (permit-sync-run.js).
 *
 * Pins: the cron run does both steps with the full detail budget; a failure
 * in one step never skips the other but still throws for job health; a
 * deploy-kill retry skips a report step both sections already finished
 * (2026-10-26: four retries each re-ran the report, two got HTTP 403, and
 * every 60-minute detail run died to the next deploy), re-runs the report
 * when either section is stale or freshness is unreadable, and caps the
 * detail step to a short slice.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/property-lookup/manatee-permit-sync', () => ({
  syncPermits: jest.fn(),
  reportSyncedSince: jest.fn(),
}));
jest.mock('../services/property-lookup/manatee-permit-detail', () => ({
  syncPermitDetails: jest.fn(),
}));

const logger = require('../services/logger');
const sync = require('../services/property-lookup/manatee-permit-sync');
const detail = require('../services/property-lookup/manatee-permit-detail');
const {
  runPermitSyncSteps, REPORT_FRESH_MS, RETRY_DETAIL_BUDGET_MS,
} = require('../services/property-lookup/permit-sync-run');

const NOW = Date.parse('2026-10-26T12:02:52Z');
const now = () => NOW;
const REPORT_OK = {
  pool: { written: 3, fetched: 3 }, construction: { written: 5, fetched: 5 }, errors: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  sync.syncPermits.mockResolvedValue(REPORT_OK);
  sync.reportSyncedSince.mockResolvedValue(false);
  detail.syncPermitDetails.mockResolvedValue({ attempted: 2, ok: 2, stopped: 'budget' });
});

describe('the weekly cron run', () => {
  test('runs the report step, then the detail step with its own full budget', async () => {
    await runPermitSyncSteps({ now });
    expect(sync.reportSyncedSince).not.toHaveBeenCalled();
    expect(sync.syncPermits).toHaveBeenCalledTimes(1);
    expect(detail.syncPermitDetails).toHaveBeenCalledWith({});
    expect(sync.syncPermits.mock.invocationCallOrder[0])
      .toBeLessThan(detail.syncPermitDetails.mock.invocationCallOrder[0]);
  });

  test('a report failure still runs the detail step, and the run throws for job health', async () => {
    sync.syncPermits.mockRejectedValue(new Error('permit sync failed: pool: report download request HTTP 403'));
    await expect(runPermitSyncSteps({ now })).rejects.toThrow(/^report sync: permit sync failed: pool: report download request HTTP 403$/);
    expect(detail.syncPermitDetails).toHaveBeenCalledTimes(1);
  });

  test('both failures reach the lease in one message', async () => {
    sync.syncPermits.mockRejectedValue(new Error('report boom'));
    detail.syncPermitDetails.mockRejectedValue(new Error('detail boom'));
    await expect(runPermitSyncSteps({ now })).rejects.toThrow('report sync: report boom | detail sync: detail boom');
  });
});

describe('the retry after a deploy kill', () => {
  test('skips a report step both sections already finished and runs a short detail slice', async () => {
    sync.reportSyncedSince.mockResolvedValue(true);
    await runPermitSyncSteps({ afterKill: true, now });
    expect(sync.reportSyncedSince).toHaveBeenCalledWith(new Date(NOW - REPORT_FRESH_MS));
    expect(sync.syncPermits).not.toHaveBeenCalled();
    expect(detail.syncPermitDetails).toHaveBeenCalledWith({ maxBudgetMs: RETRY_DETAIL_BUDGET_MS });
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/report step already finished/));
  });

  test('re-runs the report step when a section is stale (the kill came before it committed)', async () => {
    sync.reportSyncedSince.mockResolvedValue(false);
    await runPermitSyncSteps({ afterKill: true, now });
    expect(sync.syncPermits).toHaveBeenCalledTimes(1);
    expect(detail.syncPermitDetails).toHaveBeenCalledWith({ maxBudgetMs: RETRY_DETAIL_BUDGET_MS });
  });

  test('an unreadable freshness check runs the report step (fail toward the full run)', async () => {
    sync.reportSyncedSince.mockRejectedValue(new Error('connection reset'));
    await runPermitSyncSteps({ afterKill: true, now });
    expect(sync.syncPermits).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/freshness unreadable.*connection reset/));
  });

  test('a detail failure in the slice still throws for job health', async () => {
    sync.reportSyncedSince.mockResolvedValue(true);
    detail.syncPermitDetails.mockRejectedValue(new Error('permit detail sync stopped: outage (5 attempted, 0 ok)'));
    await expect(runPermitSyncSteps({ afterKill: true, now })).rejects.toThrow(/^detail sync: permit detail sync stopped: outage/);
  });

  test('the slice fits the gaps between the 2026-10-26 deploys (5 to 18 minutes)', () => {
    expect(RETRY_DETAIL_BUDGET_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(REPORT_FRESH_MS).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });
});
