jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ error: jest.fn() }));
jest.mock('../services/scheduling/day-quality', () => ({ getScheduleQualityMeasurements: jest.fn() }));
jest.mock('../services/route-reorder', () => ({ runRouteRepairAfterChange: jest.fn() }));
const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');
const { getScheduleQualityMeasurements } = require('../services/scheduling/day-quality');
const { runRouteRepairAfterChange } = require('../services/route-reorder');

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
});

test('a successful commit captures the schedule only after the transaction settles', async () => {
  let commit;
  const trx = { executionPromise: new Promise(resolve => { commit = resolve; }) };
  const pending = refreshScheduleQualityAfterChange({ jobId: 'job', trx, now }, conn);
  expect(getScheduleQualityMeasurements).not.toHaveBeenCalled();
  commit();
  expect(await pending).toMatchObject({ status: 'recorded' });
  expect(getScheduleQualityMeasurements).toHaveBeenCalledTimes(1);
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
