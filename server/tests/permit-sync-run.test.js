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
 *
 * The daily catch-up (2026-11-09: the county refused both report downloads
 * with HTTP 403 and nothing asked again for a week): due only when the gate
 * is on and a report section has not committed since this week's Monday run;
 * it runs the report step alone, reads freshness again under the lease, and
 * throws on a failure so job health keeps the job failed.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn() }));
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
const { gateEnvValue } = require('../config/feature-gates');
const {
  runPermitSyncSteps, reportCatchUpDue, runPermitReportCatchUp,
  REPORT_FRESH_MS, RETRY_DETAIL_BUDGET_MS, CATCH_UP_STALE_MS,
} = require('../services/property-lookup/permit-sync-run');

const NOW = Date.parse('2026-10-26T12:02:52Z');
const now = () => NOW;
const REPORT_OK = {
  pool: { written: 3, fetched: 3 }, construction: { written: 5, fetched: 5 }, errors: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  gateEnvValue.mockImplementation((name) => name === 'GATE_PERMIT_SYNC');
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

describe('the daily catch-up after a failed Monday report', () => {
  test('gate off: not due, and nothing reads the database', async () => {
    gateEnvValue.mockReturnValue(false);
    await expect(reportCatchUpDue({ now })).resolves.toBe(false);
    expect(sync.reportSyncedSince).not.toHaveBeenCalled();
  });

  test('not due while both report sections committed this week', async () => {
    sync.reportSyncedSince.mockResolvedValue(true);
    await expect(reportCatchUpDue({ now })).resolves.toBe(false);
    expect(sync.reportSyncedSince).toHaveBeenCalledWith(new Date(NOW - CATCH_UP_STALE_MS));
  });

  test('due when a section has not committed since the Monday run', async () => {
    sync.reportSyncedSince.mockResolvedValue(false);
    await expect(reportCatchUpDue({ now })).resolves.toBe(true);
  });

  test('an unreadable freshness check is due (a second report run is harmless)', async () => {
    sync.reportSyncedSince.mockRejectedValue(new Error('connection reset'));
    await expect(reportCatchUpDue({ now })).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/catch-up: report freshness unreadable.*connection reset/));
  });

  test('runs the report step alone: the detail step belongs to the Monday run', async () => {
    sync.reportSyncedSince.mockResolvedValue(false);
    await expect(runPermitReportCatchUp({ now })).resolves.toBe(REPORT_OK);
    expect(sync.syncPermits).toHaveBeenCalledTimes(1);
    expect(detail.syncPermitDetails).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Permit sync catch-up: pool 3/3 rows; construction 5/5 rows');
  });

  test('a tick that got the lease after another catch-up committed asks the county for nothing', async () => {
    sync.reportSyncedSince.mockResolvedValue(true);
    await expect(runPermitReportCatchUp({ now })).resolves.toEqual({ skipped: 'fresh' });
    expect(sync.syncPermits).not.toHaveBeenCalled();
  });

  test('a refused report throws for job health, so the next day tries again', async () => {
    sync.reportSyncedSince.mockResolvedValue(false);
    sync.syncPermits.mockRejectedValue(new Error('permit sync failed: pool: report download request HTTP 403 | construction: report download request HTTP 403'));
    await expect(runPermitReportCatchUp({ now })).rejects.toThrow(/^report sync \(catch-up\): permit sync failed: pool: report download request HTTP 403/);
    expect(detail.syncPermitDetails).not.toHaveBeenCalled();
  });

  test('a good Monday run reads fresh on all six catch-up days, also across the clock change', () => {
    const age = (commit, tick) => Date.parse(tick) - Date.parse(commit);
    // Mon Nov 2 7:44 AM EST commit -> Sun Nov 8 7:41 AM EST tick.
    expect(age('2026-11-02T12:44:00Z', '2026-11-08T12:41:00Z')).toBeLessThan(CATCH_UP_STALE_MS);
    // Mon Oct 26 7:44 AM EDT commit -> Sun Nov 1 7:41 AM EST tick (25-hour day in between).
    expect(age('2026-10-26T11:44:00Z', '2026-11-01T12:41:00Z')).toBeLessThan(CATCH_UP_STALE_MS);
  });

  test('a failed Monday reads stale on Tuesday, also across the spring clock change', () => {
    const age = (commit, tick) => Date.parse(tick) - Date.parse(commit);
    // Last commit Mon Nov 2 7:44 AM EST; Mon Nov 9 failed -> Tue Nov 10 7:41 AM EST tick.
    expect(age('2026-11-02T12:44:00Z', '2026-11-10T12:41:00Z')).toBeGreaterThan(CATCH_UP_STALE_MS);
    // Last commit Mon Mar 1 2027 7:44 AM EST; Mon Mar 8 failed -> Tue Mar 9 7:41 AM EST tick.
    expect(age('2027-03-01T12:44:00Z', '2027-03-09T12:41:00Z')).toBeGreaterThan(CATCH_UP_STALE_MS);
  });
});
