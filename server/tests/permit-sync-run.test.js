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
 * is on and a report section has not committed since the start of this week's
 * Monday in ET (a catch-up late in one week never hides the next failed Monday);
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
  REPORT_FRESH_MS, RETRY_DETAIL_BUDGET_MS, thisWeeksMondayStart,
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
    // NOW is Monday Oct 26 8:02 AM EDT; that Monday starts at 04:00Z.
    expect(sync.reportSyncedSince).toHaveBeenCalledWith(new Date('2026-10-26T04:00:00Z'));
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

  test('the freshness line is the start of this week\'s Monday in ET, on each catch-up day', () => {
    const since = (tick) => thisWeeksMondayStart(Date.parse(tick)).toISOString();
    // Tue Nov 10 and Sat Nov 14, 7:41 AM EST -> Mon Nov 9 00:00 EST.
    expect(since('2026-11-10T12:41:00Z')).toBe('2026-11-09T05:00:00.000Z');
    expect(since('2026-11-14T12:41:00Z')).toBe('2026-11-09T05:00:00.000Z');
    // Sun Nov 8 7:41 AM EST belongs to the week of Mon Nov 2.
    expect(since('2026-11-08T12:41:00Z')).toBe('2026-11-02T05:00:00.000Z');
  });

  test('the Monday line holds across both clock changes', () => {
    const since = (tick) => thisWeeksMondayStart(Date.parse(tick)).toISOString();
    // Sun Nov 1 2026 (clocks go back that day) 7:41 AM EST -> Mon Oct 26 00:00 EDT.
    expect(since('2026-11-01T12:41:00Z')).toBe('2026-10-26T04:00:00.000Z');
    // Sun Mar 14 2027 (clocks go forward that day) 7:41 AM EDT -> Mon Mar 8 00:00 EST.
    expect(since('2027-03-14T11:41:00Z')).toBe('2027-03-08T05:00:00.000Z');
    // Tue Mar 16 2027 7:41 AM EDT -> Mon Mar 15 00:00 EDT.
    expect(since('2027-03-16T11:41:00Z')).toBe('2027-03-15T04:00:00.000Z');
  });

  test('a catch-up that committed last Sunday does not hide a failed Monday (pre-push audit P1)', () => {
    // Sunday Nov 8 catch-up commits 7:44 AM; Monday Nov 9 fails; Tuesday Nov 10 must be due.
    const sundayCommit = Date.parse('2026-11-08T12:44:00Z');
    expect(sundayCommit).toBeLessThan(thisWeeksMondayStart(Date.parse('2026-11-10T12:41:00Z')).getTime());
    // A good Monday Nov 9 7:44 AM commit reads fresh through Sunday Nov 15.
    const mondayCommit = Date.parse('2026-11-09T12:44:00Z');
    expect(mondayCommit).toBeGreaterThanOrEqual(thisWeeksMondayStart(Date.parse('2026-11-15T12:41:00Z')).getTime());
  });
});
