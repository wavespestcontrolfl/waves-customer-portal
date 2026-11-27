/**
 * 4:20 AM schedule quality alert cron (server/services/scheduler.js, '20 4 * * *'):
 * The retired nightly route-reorder pass no longer runs or contends for the
 * 'auto-dispatch-recurring' writer lock; the tick runs schedule quality alert
 * reconciliation only (runScheduleQualityAlertsOnly).
 */
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
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  recurringSeriesTopUpLive: jest.fn(() => false), dayReplanMode: jest.fn(() => 'off'),
}));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/recurring-series-topup', () => ({ runRecurringSeriesTopUpSweep: jest.fn() }));

jest.mock('../services/route-reorder', () => ({
  runRouteReorderIfEnabled: jest.fn(),
  recordSkippedTick: jest.fn(),
  runScheduleQualityAlertsOnly: jest.fn(),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, gateEnvValue } = require('../config/feature-gates');
const { runRouteReorderIfEnabled, runScheduleQualityAlertsOnly } = require('../services/route-reorder');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function registration() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const found = cron.schedule.mock.calls.filter(([expression, task]) => expression === '20 4 * * *' && String(task).includes('runScheduleQualityAlertsOnly'));
  expect(found).toHaveLength(1);
  return found[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  gateEnvValue.mockReturnValue(true);
  runExclusive.mockImplementation(async (_key, task) => task());
  runScheduleQualityAlertsOnly.mockResolvedValue({ status: 'reconciled', created: 1, resolved: 2 });
});

test('4:20 AM cron runs quality alerts only and never invokes the retired nightly reorder pass', async () => {
  await registration()[1]();
  expect(runScheduleQualityAlertsOnly).toHaveBeenCalledTimes(1);
  expect(runRouteReorderIfEnabled).not.toHaveBeenCalled();
  expect(runExclusive).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('created=1 resolved=2'));
});

test('4:20 AM cron logs when quality alert reconciliation reports failure', async () => {
  runScheduleQualityAlertsOnly.mockResolvedValueOnce({ status: 'failed' });
  await registration()[1]();
  expect(logger.error).toHaveBeenCalledWith('[route-reorder] quality-alerts-only cron run failed');
});
