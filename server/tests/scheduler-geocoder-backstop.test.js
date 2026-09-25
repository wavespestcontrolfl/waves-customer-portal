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

const cron = require('../utils/scheduled-cron');
const { isEnabled } = require('../config/feature-gates');
const { runExclusive } = require('../utils/cron-lock');
const { sweepUngeocodedCustomers } = require('../services/geocoder');
const { sweepUngeocodedServices } = require('../services/geocoder-service-locations');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(name => name === 'cronJobs');
  sweepUngeocodedCustomers.mockResolvedValue({ status: 'completed' });
  sweepUngeocodedServices.mockResolvedValue({ status: 'completed' });
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
