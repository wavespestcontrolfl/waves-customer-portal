/**
 * Scheduled jobs that caught their own failure inside runExclusive, so
 * job_health recorded success (runExclusive records a failure only when the
 * body throws). The cron bodies in scheduler.js now throw inside runExclusive
 * and catch outside it:
 *   - appointment-reminders: throws on a failed main scan AFTER the stale
 *     cancellation-claim sweep ran; a per-customer error count never throws.
 *   - call-self-audit and typed-decisions-daily-review: rethrow.
 *
 * Mock baseline copied from scheduler-alert-retention-cron.test.js.
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
  recurringSeriesTopUpLive: jest.fn(() => false), alertRetentionMode: jest.fn(() => 'off'),
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

jest.mock('../services/appointment-reminders', () => ({
  checkAndSendReminders: jest.fn(),
  sweepStaleCancellationClaims: jest.fn(),
}));
jest.mock('../services/call-self-audit', () => ({ runSelfAudit: jest.fn() }));
jest.mock('../services/typed-decisions/daily-review-item', () => ({ runDailyReviewItem: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const reminders = require('../services/appointment-reminders');
const { runSelfAudit } = require('../services/call-self-audit');
const { runDailyReviewItem } = require('../services/typed-decisions/daily-review-item');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

// The cron callback registered on `expression` whose body names `job`
// (several crons share an expression).
function tickFor(expression, job) {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const matches = cron.schedule.mock.calls.filter(([expr, fn]) => expr === expression && String(fn).includes(`'${job}'`));
  expect(matches).toHaveLength(1);
  return matches[0][1];
}

// The promise runExclusive returned for the job: what job_health sees.
const healthOutcome = (job) => runExclusive.mock.results[
  runExclusive.mock.calls.findIndex(([name]) => name === job)
].value;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('appointment-reminders cron', () => {
  test('a failed main scan runs the cancellation-claim sweep, then fails the job', async () => {
    reminders.checkAndSendReminders.mockResolvedValue({ sent72h: 0, sent24h: 0, skipped: 0, errors: 1, scanFailed: true });
    const tick = tickFor('*/15 * * * *', 'appointment-reminders');
    await expect(tick()).resolves.toBeUndefined();
    expect(reminders.sweepStaleCancellationClaims).toHaveBeenCalledTimes(1);
    await expect(healthOutcome('appointment-reminders')).rejects.toThrow('appointment-reminders: reminder scan failed');
    expect(logger.error).toHaveBeenCalledWith('Reminder check failed: appointment-reminders: reminder scan failed');
  });

  test("one customer's send error is counted, never a job failure", async () => {
    reminders.checkAndSendReminders.mockResolvedValue({ sent72h: 3, sent24h: 1, skipped: 0, errors: 2 });
    const tick = tickFor('*/15 * * * *', 'appointment-reminders');
    await tick();
    await expect(healthOutcome('appointment-reminders')).resolves.toBeUndefined();
    expect(reminders.sweepStaleCancellationClaims).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe.each([
  ['call-self-audit', '40 3 * * *', runSelfAudit, 'Call self-audit failed: boom'],
  ['typed-decisions-daily-review', '5 8 * * *', runDailyReviewItem, 'Typed-decisions daily review failed: boom'],
])('%s cron', (job, expression, run, logLine) => {
  test('a failed run fails the job and is still logged, never thrown out of the tick', async () => {
    run.mockRejectedValue(new Error('boom'));
    const tick = tickFor(expression, job);
    await expect(tick()).resolves.toBeUndefined();
    await expect(healthOutcome(job)).rejects.toThrow('boom');
    expect(logger.error).toHaveBeenCalledWith(logLine);
  });

  test('a clean run records success', async () => {
    run.mockResolvedValue({ skipped: true });
    const tick = tickFor(expression, job);
    await tick();
    await expect(healthOutcome(job)).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
