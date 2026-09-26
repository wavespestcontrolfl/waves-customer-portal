jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ error: jest.fn() }));
jest.mock('../services/scheduling/day-quality', () => ({ getScheduleQualityMeasurements: jest.fn() }));
jest.mock('../services/route-reorder', () => ({ runRouteRepairAfterChange: jest.fn() }));
jest.mock('../services/scheduling/quality-alerts', () => ({ refreshScheduleQualityAlerts: jest.fn(async () => ({ status: 'gate_off' })) }));
jest.mock('../services/scheduling/quality-refresh-queue', () => ({
  registerQualityRefresh: jest.fn(async payload => ({ id: 'refresh-job', payload, attempt_token: 'attempt-1', attempts: 1 })),
  captureResolvedDates: jest.fn(async (job, dates) => { job.payload = { ...job.payload, resolvedDates: dates }; }),
  claimQualityRefresh: jest.fn(),
  completeQualityRefresh: jest.fn(async () => 1),
  retryQualityRefresh: jest.fn(async () => 1),
}));
const { refreshScheduleQualityAfterChange, retryScheduleQualityRefreshes } = require('../services/scheduling/quality-after-change');
const { getScheduleQualityMeasurements } = require('../services/scheduling/day-quality');
const { runRouteRepairAfterChange } = require('../services/route-reorder');
const { refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');
const queue = require('../services/scheduling/quality-refresh-queue');

const now = new Date('2040-09-09T08:00:00Z');
let conn;
let insert;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS = 'true';
  insert = jest.fn(() => ({ returning: async () => [{ id: 'ledger' }] }));
  const snapshot = jest.fn(table => {
    if (table === 'scheduled_services') return { where: () => ({ first: async () => ({ scheduled_date: '2040-09-11' }) }) };
    if (table === 'route_optimization_planner_runs') return { insert };
    throw new Error('Unexpected query');
  });
  conn = { transaction: jest.fn(async callback => callback(snapshot)) };
  getScheduleQualityMeasurements.mockImplementation(async ({ date }) => ({ driveModel: 'calibrated', days: [{ date,
    byTech: [{ technicianId: 'tech', technician: 'Synthetic technician', scheduledVisits: 0, plannedStops: [], uncertaintyReasons: ['workday_or_break_allowance_unset'] }],
  }] }));
});
afterEach(() => {
  ['GATE_SCHEDULE_QUALITY_MEASUREMENTS', 'GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION']
    .forEach(gate => { delete process.env[gate]; });
});

test('the dark gate performs no database work', async () => {
  delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn)).toEqual({ status: 'gate_off' });
  expect(conn.transaction).not.toHaveBeenCalled();
  expect(queue.registerQualityRefresh).not.toHaveBeenCalled();
});

test('both changed dates get fresh snapshots, including an emptied route, without names', async () => {
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', dates: ['2040-09-10', '2040-09-10'], now }, conn))
    .toEqual({ status: 'recorded', ledgerId: 'ledger', dates: ['2040-09-10', '2040-09-11'] });
  const ledger = insert.mock.calls[0][0];
  expect(ledger).toMatchObject({ run_type: 'schedule_quality_change', start_date: '2040-09-10', end_date: '2040-09-11', applied_count: 0 });
  const snapshots = JSON.parse(ledger.result).route_quality;
  expect(snapshots).toHaveLength(2);
  expect(snapshots[0]).toMatchObject({ date: '2040-09-10', technician_id: 'tech', snapshot_phase: 'schedule_change',
    plannedStops: [], uncertaintyReasons: ['workday_or_break_allowance_unset'] });
  expect(ledger.result).not.toContain('Synthetic technician');
  expect(queue.captureResolvedDates).toHaveBeenCalledWith(expect.objectContaining({ id: 'refresh-job' }),
    ['2040-09-10', '2040-09-11'], conn);
});

test('today, invalid dates and dates beyond the 30-day horizon do not enter the future planning ledger', async () => {
  expect(await refreshScheduleQualityAfterChange({ dates: ['2040-09-08', '2040-09-09', '2040-02-30', '2040-10-10'], now }, conn))
    .toEqual({ status: 'outside_planning_horizon' });
  expect(getScheduleQualityMeasurements).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
});

test('a nested writer waits for the outermost commit and checks the gate again', async () => {
  let commit;
  const root = { executionPromise: new Promise(resolve => { commit = resolve; }) };
  const savepoint = { parentTransaction: root, executionPromise: Promise.resolve() };
  const pending = refreshScheduleQualityAfterChange({ jobId: 'job', trx: savepoint, now }, conn);
  await Promise.resolve();
  expect(conn.transaction).not.toHaveBeenCalled();
  delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
  commit();
  expect(await pending).toEqual({ status: 'gate_off' });
  expect(conn.transaction).not.toHaveBeenCalled();
});

test('a rejected outer transaction cannot create a planning snapshot', async () => {
  let rollback;
  const trx = { executionPromise: new Promise((resolve, reject) => { rollback = reject; }) };
  const pending = refreshScheduleQualityAfterChange({ jobId: 'job', trx, now }, conn);
  rollback(new Error('Synthetic rollback'));
  expect(await pending).toEqual({ status: 'rolled_back' });
  expect(conn.transaction).not.toHaveBeenCalled();
  expect(queue.registerQualityRefresh).not.toHaveBeenCalled();
});

test('a successful commit captures the schedule only after the transaction settles', async () => {
  let commit;
  const trx = { executionPromise: new Promise(resolve => { commit = resolve; }) };
  const pending = refreshScheduleQualityAfterChange({ jobId: 'job', trx, now }, conn);
  expect(getScheduleQualityMeasurements).not.toHaveBeenCalled();
  expect(queue.registerQualityRefresh).not.toHaveBeenCalled();
  commit();
  expect(await pending).toMatchObject({ status: 'recorded' });
  expect(queue.registerQualityRefresh).toHaveBeenCalledTimes(1);
  expect(getScheduleQualityMeasurements).toHaveBeenCalledTimes(1);
});

test('registration failure is reported without rejecting the committed operation', async () => {
  queue.registerQualityRefresh.mockRejectedValueOnce(Object.assign(new Error('Synthetic queue outage'), { code: '08006' }));
  await expect(refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn)).resolves.toEqual({ status: 'failed' });
  expect(conn.transaction).not.toHaveBeenCalled();
});

test('read and ledger failures are reported without rejecting the committed operation', async () => {
  getScheduleQualityMeasurements.mockRejectedValueOnce(new Error('Synthetic closure read failure'));
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn)).toEqual({ status: 'failed' });
  expect(insert).not.toHaveBeenCalled();
  insert.mockImplementationOnce(() => { throw new Error('Synthetic ledger failure'); });
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn)).toEqual({ status: 'failed' });
});

test('turning the gate off during measurement prevents the ledger write', async () => {
  getScheduleQualityMeasurements.mockImplementationOnce(async ({ date }) => {
    delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
    return { driveModel: 'legacy', days: [{ date, byTech: [] }] };
  });
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn)).toEqual({ status: 'gate_off' });
  expect(insert).not.toHaveBeenCalled();
  expect(queue.completeQualityRefresh).not.toHaveBeenCalled();
  expect(queue.retryQualityRefresh).not.toHaveBeenCalled();
});

test('turning every applicable gate off after date capture leaves the request pending', async () => {
  queue.captureResolvedDates.mockImplementationOnce(async (job, dates) => {
    job.payload = { ...job.payload, resolvedDates: dates };
    delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
  });
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn)).toEqual({ status: 'gate_off' });
  expect(queue.completeQualityRefresh).not.toHaveBeenCalled();
  expect(queue.retryQualityRefresh).not.toHaveBeenCalled();
});

test('an alert reconciliation failure records the measurement and retains the request', async () => {
  refreshScheduleQualityAlerts.mockResolvedValueOnce({ status: 'failed' });
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn))
    .toMatchObject({ status: 'recorded_with_alert_error', ledgerId: 'ledger' });
  expect(queue.retryQualityRefresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'refresh-job' }),
    'recorded_with_alert_error', now, conn);
  expect(queue.completeQualityRefresh).not.toHaveBeenCalled();
});

test('a full gate shutdown during alert reconciliation leaves the measured request pending', async () => {
  refreshScheduleQualityAlerts.mockImplementationOnce(async () => {
    delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
    return { status: 'gate_off' };
  });
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn))
    .toMatchObject({ status: 'recorded', ledgerId: 'ledger' });
  expect(queue.completeQualityRefresh).not.toHaveBeenCalled();
  expect(queue.retryQualityRefresh).not.toHaveBeenCalled();
});

test('a committed change repairs first and measures the resulting route', async () => {
  ['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'].forEach(gate => { process.env[gate] = 'true'; });
  let commit;
  const trx = { executionPromise: new Promise(resolve => { commit = resolve; }) };
  runRouteRepairAfterChange.mockImplementationOnce(async () => {
    expect(getScheduleQualityMeasurements).not.toHaveBeenCalled();
    return { status: 'completed', applied: 1 };
  });
  const pending = refreshScheduleQualityAfterChange({ jobId: 'job', dates: ['2040-09-10'], trx, now }, conn);
  expect(runRouteRepairAfterChange).not.toHaveBeenCalled();
  commit();
  expect(await pending).toMatchObject({ status: 'recorded', repair: { applied: 1 } });
  expect(runRouteRepairAfterChange).toHaveBeenCalledWith({ dates: ['2040-09-10', '2040-09-11'], now }, conn);
  expect(getScheduleQualityMeasurements).toHaveBeenCalledTimes(2);
});

test('the repair gate can run independently of observational snapshots', async () => {
  delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
  ['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'].forEach(gate => { process.env[gate] = 'true'; });
  runRouteRepairAfterChange.mockResolvedValueOnce({ status: 'completed', applied: 1 });
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', now }, conn)).toMatchObject({ status: 'repair_checked', repair: { applied: 1 } });
  expect(getScheduleQualityMeasurements).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
});

test.each([
  { status: 'completed_with_errors', failed: 1 },
  { status: 'failed', failed: 0 },
])('returned repair failure %# retains the durable request', async repair => {
  ['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'].forEach(gate => { process.env[gate] = 'true'; });
  runRouteRepairAfterChange.mockResolvedValueOnce(repair);
  expect(await refreshScheduleQualityAfterChange({ dates: ['2040-09-10'], now }, conn)).toMatchObject({ status: 'recorded', repair });
  expect(queue.retryQualityRefresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'refresh-job' }),
    expect.stringMatching(/^route_repair_/), now, conn);
  expect(queue.completeQualityRefresh).not.toHaveBeenCalled();
});

test('retry worker uses captured sparse dates and removes successful intent', async () => {
  queue.claimQualityRefresh
    .mockResolvedValueOnce({ id: 'persisted', attempt_token: 'attempt-2', attempts: 2,
      payload: { jobId: 'old-job', customerIds: ['customer'], dates: ['2040-09-12'], resolvedDates: ['2040-09-10', '2040-09-16'] } })
    .mockResolvedValueOnce(null);
  expect(await retryScheduleQualityRefreshes({ now, limit: 3 }, conn))
    .toEqual({ status: 'completed', processed: 1, succeeded: 1, failed: 0 });
  expect(getScheduleQualityMeasurements.mock.calls.map(([arg]) => arg.date)).toEqual(['2040-09-10', '2040-09-16']);
  expect(conn.transaction.mock.calls).toHaveLength(1);
  expect(queue.completeQualityRefresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'persisted' }), conn);
});

test('retry gate off leaves pending rows unclaimed', async () => {
  delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
  expect(await retryScheduleQualityRefreshes({ now }, conn))
    .toEqual({ status: 'gate_off', processed: 0, succeeded: 0, failed: 0 });
  expect(queue.claimQualityRefresh).not.toHaveBeenCalled();
});

test('retry settlement failure is counted as failed', async () => {
  queue.claimQualityRefresh
    .mockResolvedValueOnce({ id: 'persisted', attempt_token: 'attempt-2', attempts: 2,
      payload: { resolvedDates: ['2040-09-10'] } })
    .mockResolvedValueOnce(null);
  queue.completeQualityRefresh.mockRejectedValueOnce(new Error('Synthetic completion failure'));
  expect(await retryScheduleQualityRefreshes({ now }, conn))
    .toEqual({ status: 'failed', processed: 1, succeeded: 0, failed: 1 });
});

test('a stale completion token is not counted as retry success', async () => {
  queue.claimQualityRefresh
    .mockResolvedValueOnce({ id: 'persisted', attempt_token: 'stale-attempt', attempts: 2,
      payload: { resolvedDates: ['2040-09-10'] } })
    .mockResolvedValueOnce(null);
  queue.completeQualityRefresh.mockResolvedValueOnce(0);
  expect(await retryScheduleQualityRefreshes({ now }, conn))
    .toEqual({ status: 'failed', processed: 1, succeeded: 0, failed: 1 });
});

test('retry leases and settlement use fresh clocks when no clock is supplied', async () => {
  jest.useFakeTimers().setSystemTime(now);
  const later = new Date(now.getTime() + 20 * 60 * 1000);
  queue.claimQualityRefresh.mockImplementationOnce(async () => {
    jest.setSystemTime(later);
    return { id: 'persisted', attempt_token: 'attempt-2', attempts: 2, payload: { resolvedDates: ['2040-09-10'] } };
  }).mockResolvedValueOnce(null);
  getScheduleQualityMeasurements.mockRejectedValueOnce(new Error('Synthetic delayed failure'));
  await retryScheduleQualityRefreshes({}, conn);
  expect(queue.claimQualityRefresh.mock.calls[0][0]).toEqual(now);
  expect(queue.retryQualityRefresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'persisted' }), 'failed', later, conn);
  expect(queue.claimQualityRefresh.mock.calls[1][0]).toEqual(later);
  jest.useRealTimers();
});

test('a delayed repair timestamps the measured plan after repair, not when the request started', async () => {
  jest.useFakeTimers().setSystemTime(now);
  const measuredAt = new Date(now.getTime() + 20 * 60 * 1000);
  ['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'].forEach(gate => { process.env[gate] = 'true'; });
  runRouteRepairAfterChange.mockImplementationOnce(async () => {
    jest.setSystemTime(measuredAt);
    return { status: 'completed', applied: 1 };
  });
  try {
    expect(await refreshScheduleQualityAfterChange({ dates: ['2040-09-10'] }, conn)).toMatchObject({ status: 'recorded' });
    const snapshots = JSON.parse(insert.mock.calls[0][0].result).route_quality;
    expect(snapshots[0].as_of).toBe(measuredAt.toISOString());
    expect(getScheduleQualityMeasurements.mock.calls[0][2]).toEqual(measuredAt);
  } finally {
    jest.useRealTimers();
  }
});

test('failed discovery retains original identifiers for a later retry', async () => {
  conn.transaction.mockRejectedValueOnce(new Error('Synthetic discovery failure'));
  expect(await refreshScheduleQualityAfterChange({ jobId: 'job', customerIds: ['customer'], dates: ['2040-09-10'], now }, conn))
    .toEqual({ status: 'failed' });
  expect(queue.captureResolvedDates).not.toHaveBeenCalled();
  expect(queue.retryQualityRefresh).toHaveBeenCalledWith(expect.objectContaining({ payload: {
    jobId: 'job', customerIds: ['customer'], dates: ['2040-09-10'],
  } }), 'failed', now, conn);
});
