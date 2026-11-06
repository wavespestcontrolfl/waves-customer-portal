/**
 * Admin-only scheduled jobs that re-alerted or double-ran (scheduler.js):
 *   - dashboard-alerts-cron: throws AFTER the state write when an alert read
 *     failed (or the check itself failed), so job_health records it.
 *   - morning email digest: runs under runExclusive('email-digest-daily') and
 *     raises its bell under a per-ET-day dedupeKey.
 *   - Tax Advisor and SEO Advisor weekly reports: run under runExclusive, so a
 *     deploy overlap makes one report and one paid model call, not two.
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

jest.mock('../services/dashboard-alerts-cron', () => ({
  runDashboardAlertsCheck: jest.fn(),
  COUNT_ESCALATION_COOLDOWN_MS: {},
}));
jest.mock('../services/tax-advisor', () => {
  const generateWeeklyReport = jest.fn();
  const TaxAdvisor = jest.fn(() => ({ generateWeeklyReport }));
  TaxAdvisor.generateWeeklyReport = generateWeeklyReport;
  return TaxAdvisor;
});
jest.mock('../services/seo/seo-advisor', () => ({ generateWeeklyReport: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const db = require('../models/db');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runDashboardAlertsCheck } = require('../services/dashboard-alerts-cron');
const TaxAdvisor = require('../services/tax-advisor');
const SEOAdvisor = require('../services/seo/seo-advisor');
const NotificationService = require('../services/notification-service');
const { etDateString } = require('../utils/datetime-et');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

const baseDb = db.getMockImplementation();

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
  runExclusive.mockImplementation(async (_key, task) => task());
});

describe('dashboard-alerts-cron', () => {
  test('an alert read that failed fails the job after the check ran', async () => {
    runDashboardAlertsCheck.mockResolvedValue({ fired: 0, cleared: 0, current: 1, failedIds: ['payments_failed_today', 'ar_overdue_60'] });
    const tick = tickFor('*/5 * * * *', 'dashboard-alerts-cron');
    await expect(tick()).resolves.toBeUndefined();
    expect(runDashboardAlertsCheck).toHaveBeenCalledTimes(1);
    await expect(healthOutcome('dashboard-alerts-cron')).rejects.toThrow('dashboard-alerts-cron: 2 alert read(s) failed (payments_failed_today, ar_overdue_60)');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Dashboard alerts cron failed: dashboard-alerts-cron: 2 alert read(s) failed'));
  });

  test('a failed check or state write fails the job too', async () => {
    runDashboardAlertsCheck.mockResolvedValue({ fired: 0, cleared: 0, error: 'connection lost' });
    const tick = tickFor('*/5 * * * *', 'dashboard-alerts-cron');
    await tick();
    await expect(healthOutcome('dashboard-alerts-cron')).rejects.toThrow('dashboard-alerts-cron: the alert check or its state write failed');
  });

  test('a clean tick records success', async () => {
    runDashboardAlertsCheck.mockResolvedValue({ fired: 1, cleared: 0, current: 2 });
    const tick = tickFor('*/5 * * * *', 'dashboard-alerts-cron');
    await tick();
    await expect(healthOutcome('dashboard-alerts-cron')).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('morning email digest', () => {
  let notifyAdmin;
  // The mailbox reads, installed after initScheduledJobs ran on the baseline db mock.
  const useMailboxDb = () => db.mockImplementation(() => {
    const q = {
      where: () => q,
      count: () => q,
      first: async () => ({ c: '3' }),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return q;
  });
  beforeEach(() => {
    notifyAdmin = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'n1' });
  });
  afterEach(() => {
    notifyAdmin.mockRestore();
    db.mockImplementation(baseDb);
  });

  test('runs under its own lock and raises the bell under a per-ET-day dedupeKey', async () => {
    const tick = tickFor('30 7 * * *', 'email-digest-daily');
    useMailboxDb();
    await tick();
    expect(runExclusive).toHaveBeenCalledWith('email-digest-daily', expect.any(Function));
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, , opts] = notifyAdmin.mock.calls[0];
    expect([category, title]).toEqual(['email_digest', 'Morning Email Digest']);
    expect(opts.dedupeKey).toBe(`email-digest:${etDateString()}`);
    expect(opts).toMatchObject({ link: '/admin/email' });
  });

  test('a tick another instance already holds posts nothing', async () => {
    runExclusive.mockResolvedValue({ skipped: true, reason: 'lease_held' });
    const tick = tickFor('30 7 * * *', 'email-digest-daily');
    useMailboxDb();
    await tick();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

describe('weekly advisor reports run under a lock', () => {
  test('Tax Advisor: one report per lease; a held lease runs nothing', async () => {
    const tick = tickFor('0 7 * * 0', 'tax-advisor-weekly');
    await tick();
    expect(runExclusive).toHaveBeenCalledWith('tax-advisor-weekly', expect.any(Function));
    expect(TaxAdvisor.generateWeeklyReport).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    runExclusive.mockResolvedValue({ skipped: true, reason: 'lease_held' });
    await tick();
    expect(TaxAdvisor.generateWeeklyReport).not.toHaveBeenCalled();
  });

  test('Tax Advisor: a failed run fails the job and is logged, never thrown out of the tick', async () => {
    TaxAdvisor.generateWeeklyReport.mockRejectedValue(new Error('boom'));
    const tick = tickFor('0 7 * * 0', 'tax-advisor-weekly');
    await expect(tick()).resolves.toBeUndefined();
    await expect(healthOutcome('tax-advisor-weekly')).rejects.toThrow('boom');
    expect(logger.error).toHaveBeenCalledWith('Tax Advisor failed: boom');
  });

  test('SEO Advisor: one report per lease; a held lease runs nothing', async () => {
    const tick = tickFor('0 7 * * 1', 'seo-advisor-weekly');
    await tick();
    expect(runExclusive).toHaveBeenCalledWith('seo-advisor-weekly', expect.any(Function));
    expect(SEOAdvisor.generateWeeklyReport).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    runExclusive.mockResolvedValue({ skipped: true, reason: 'lease_held' });
    await tick();
    expect(SEOAdvisor.generateWeeklyReport).not.toHaveBeenCalled();
  });
});
