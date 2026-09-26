jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_key, task) => task()),
  settleDeadRunningJobs: jest.fn(async () => []),
}));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/geocoder', () => ({ sweepUngeocodedCustomers: jest.fn() }));
jest.mock('../services/geocoder-service-locations', () => ({ sweepUngeocodedServices: jest.fn() }));
jest.mock('../services/scheduling/quality-after-change', () => ({ retryScheduleQualityRefreshes: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { runExclusive } = require('../utils/cron-lock');
const { sweepUngeocodedCustomers } = require('../services/geocoder');
const { sweepUngeocodedServices } = require('../services/geocoder-service-locations');
const { retryScheduleQualityRefreshes } = require('../services/scheduling/quality-after-change');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(name => name === 'cronJobs');
  sweepUngeocodedCustomers.mockResolvedValue({ status: 'completed' });
  sweepUngeocodedServices.mockResolvedValue({ status: 'completed' });
  retryScheduleQualityRefreshes.mockResolvedValue({ status: 'completed', processed: 2, succeeded: 2, failed: 0 });
});

function registeredTick() {
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, callback]) =>
    expression === '20 * * * *' && callback.toString().includes('sweepUngeocodedCustomers'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1];
}

test('a rejected service-pin sweep is logged with its code and the customer sweep still runs', async () => {
  sweepUngeocodedServices.mockRejectedValueOnce(Object.assign(new Error('synthetic service query failure'), { code: 'SERVICE_QUERY_FAILED' }));

  await registeredTick()();

  expect(runExclusive).toHaveBeenCalledWith('geocoder-backstop', expect.any(Function));
  expect(sweepUngeocodedServices).toHaveBeenCalledWith({ dryRun: false });
  expect(sweepUngeocodedCustomers).toHaveBeenCalledTimes(1);
  expect(sweepUngeocodedServices.mock.invocationCallOrder[0])
    .toBeLessThan(sweepUngeocodedCustomers.mock.invocationCallOrder[0]);
  expect(logger.error).toHaveBeenCalledWith(
    '[geocoder] service-location backstop failed (SERVICE_QUERY_FAILED): synthetic service query failure',
  );
  expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('backstop sweep failed:'));
});

test('successful service and customer sweeps run in order under the same existing lease', async () => {
  await registeredTick()();

  expect(runExclusive).toHaveBeenCalledTimes(1);
  expect(runExclusive).toHaveBeenCalledWith('geocoder-backstop', expect.any(Function));
  expect(sweepUngeocodedServices.mock.invocationCallOrder[0])
    .toBeLessThan(sweepUngeocodedCustomers.mock.invocationCallOrder[0]);
  expect(logger.error).not.toHaveBeenCalled();
});

test('a customer sweep rejection still reaches the existing outer failure handler', async () => {
  sweepUngeocodedCustomers.mockRejectedValueOnce(new Error('synthetic customer query failure'));

  await registeredTick()();

  expect(sweepUngeocodedServices).toHaveBeenCalledTimes(1);
  expect(sweepUngeocodedCustomers).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith('[geocoder] backstop sweep failed: synthetic customer query failure');
});

function registeredRetryTick() {
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, callback]) =>
    expression === '*/5 * * * *' && callback.toString().includes('retryScheduleQualityRefreshes'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1];
}

test('the retry tick drains durable refreshes independently of the geocoder sweep', async () => {
  await registeredRetryTick()();
  expect(retryScheduleQualityRefreshes).toHaveBeenCalledTimes(1);
  expect(sweepUngeocodedCustomers).not.toHaveBeenCalled();
  expect(runExclusive).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('[schedule-quality] retry sweep: processed=2 succeeded=2 failed=0');
});

test('a failed retry is observable without escaping the scheduled callback', async () => {
  const tick = registeredRetryTick();
  retryScheduleQualityRefreshes.mockResolvedValueOnce({ status: 'completed', processed: 1, succeeded: 0, failed: 1 });
  await tick();
  expect(logger.error).toHaveBeenCalledWith('[schedule-quality] retry sweep has pending failures');
  retryScheduleQualityRefreshes.mockRejectedValueOnce(Object.assign(new Error('synthetic private detail'), { code: '57P01' }));
  await tick();
  expect(logger.error).toHaveBeenCalledWith('[schedule-quality] retry sweep failed (57P01)');
});
