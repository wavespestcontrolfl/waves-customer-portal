/**
 * Monday permit cron body: report sync, detail collection, and one late
 * second try of a failed report sync (job_health 2026-10-12: the county's
 * report service failed for three minutes at 4:05 AM and the week had no
 * second chance).
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../services/property-lookup/manatee-permit-sync', () => ({ syncPermits: jest.fn() }));
jest.mock('../services/property-lookup/manatee-permit-detail', () => ({ syncPermitDetails: jest.fn() }));

const { syncPermits } = require('../services/property-lookup/manatee-permit-sync');
const { syncPermitDetails } = require('../services/property-lookup/manatee-permit-detail');
const { runPermitSyncSteps, LATE_RETRY_MIN_WAIT_MS } = require('../services/property-lookup/permit-sync-tick');

const OK = { errors: [], pool: { written: 3, fetched: 3 }, construction: { written: 5, fetched: 5 } };
const NOT_CSV = 'permit sync failed: pool: report output is not CSV (text/html; charset=utf-8)';

// A clock the test moves by hand; `wait` records the request and advances it.
function clock(start = 1000) {
  const c = { t: start, waits: [] };
  c.now = () => c.t;
  c.wait = jest.fn(async (ms) => { c.waits.push(ms); c.t += ms; });
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  syncPermitDetails.mockResolvedValue({});
});

describe('runPermitSyncSteps', () => {
  test('a clean report sync runs once, then the detail step; no wait', async () => {
    syncPermits.mockResolvedValue(OK);
    const c = clock();
    await expect(runPermitSyncSteps(c)).resolves.toBeUndefined();
    expect(syncPermits).toHaveBeenCalledTimes(1);
    expect(syncPermitDetails).toHaveBeenCalledTimes(1);
    expect(c.wait).not.toHaveBeenCalled();
  });

  test('a gated-off report sync is not a failure and is not tried again', async () => {
    syncPermits.mockResolvedValue({ skipped: 'gated' });
    const c = clock();
    await expect(runPermitSyncSteps(c)).resolves.toBeUndefined();
    expect(syncPermits).toHaveBeenCalledTimes(1);
    expect(c.wait).not.toHaveBeenCalled();
  });

  test('a failed report sync is tried once more after the detail step, and a late success clears the failure', async () => {
    const order = [];
    syncPermits
      .mockImplementationOnce(async () => { order.push('report'); throw new Error(NOT_CSV); })
      .mockImplementationOnce(async () => { order.push('report-late'); return OK; });
    const c = clock();
    // The detail step used its hour: the late try needs no extra wait.
    syncPermitDetails.mockImplementation(async () => { order.push('detail'); c.t += 60 * 60 * 1000; });
    await expect(runPermitSyncSteps(c)).resolves.toBeUndefined();
    expect(order).toEqual(['report', 'detail', 'report-late']);
    expect(c.wait).not.toHaveBeenCalled();
  });

  test('a quick detail step: the late try waits out the rest of the minimum wait', async () => {
    syncPermits.mockRejectedValueOnce(new Error(NOT_CSV)).mockResolvedValueOnce(OK);
    const c = clock();
    syncPermitDetails.mockImplementation(async () => { c.t += 5000; });
    await runPermitSyncSteps(c);
    expect(c.waits).toEqual([LATE_RETRY_MIN_WAIT_MS - 5000]);
    expect(syncPermits).toHaveBeenCalledTimes(2);
  });

  test('a report sync that fails twice rejects with the late error, after exactly two tries', async () => {
    syncPermits
      .mockRejectedValueOnce(new Error(NOT_CSV))
      .mockRejectedValueOnce(new Error('permit sync failed: pool: report 22615: report form request timed out after 60000ms (3 attempts)'));
    const c = clock();
    await expect(runPermitSyncSteps(c)).rejects.toThrow(/^report sync: permit sync failed: pool: report 22615: report form request timed out/);
    expect(syncPermits).toHaveBeenCalledTimes(2);
  });

  test('a detail failure still reaches the lease, and does not stop the late report try', async () => {
    syncPermits.mockRejectedValueOnce(new Error(NOT_CSV)).mockResolvedValueOnce(OK);
    syncPermitDetails.mockRejectedValue(new Error('record page HTTP 403'));
    const c = clock();
    await expect(runPermitSyncSteps(c)).rejects.toThrow('detail sync: record page HTTP 403');
    expect(syncPermits).toHaveBeenCalledTimes(2);
  });

  test('both steps failed: one error names both', async () => {
    syncPermits.mockRejectedValue(new Error(NOT_CSV));
    syncPermitDetails.mockRejectedValue(new Error('record page HTTP 403'));
    await expect(runPermitSyncSteps(clock())).rejects.toThrow(/^report sync: .*not CSV.* \| detail sync: record page HTTP 403$/);
  });
});
