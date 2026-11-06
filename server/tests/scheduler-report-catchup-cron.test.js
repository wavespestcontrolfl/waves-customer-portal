/**
 * Missed-tick catch-up for four admin/report jobs in server/services/scheduler.js:
 * the SiteOne deals digest, the LLM dispatch digest, the booking-link weekly check and
 * the KPI daily snapshot. Each catch-up tick does nothing when its period already ran,
 * runs the same job under the same runExclusive lock when it did not, and the original
 * tick is unchanged. The service modules are faked here; their own catch-up decisions
 * are tested beside each service.
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
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []), recordMissedTick: jest.fn(async () => {}) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/recurring-series-topup', () => ({ runRecurringSeriesTopUpSweep: jest.fn() }));

jest.mock('../services/procurement/siteone-deals-digest', () => ({
  weekIsMissing: jest.fn(),
  runSiteOneDealsCatchUp: jest.fn().mockResolvedValue({ scanned: 3, deals: 1, notified: true }),
  runSiteOneDealsDigest: jest.fn().mockResolvedValue({ scanned: 3, deals: 1, notified: true }),
}));
jest.mock('../services/llm-dispatch-metrics', () => ({
  digestCatchUpNeeded: jest.fn(),
  runLlmDispatchDigestWithCatchUp: jest.fn().mockResolvedValue({ exceptions: [], emailed: false }),
  runLlmDispatchDigest: jest.fn(),
  alertRecorderUnreachable: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/call-booking-link-weekly-check', () => ({
  weekIsMissing: jest.fn(),
  runCallBookingLinkWeeklyCheck: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../services/kpi-snapshot', () => ({
  snapshotMissing: jest.fn(),
  recordKpiSnapshotIfMissing: jest.fn().mockResolvedValue({ snapshot_date: '2026-11-05', metrics: 16 }),
  recordKpiSnapshot: jest.fn().mockResolvedValue({ snapshot_date: '2026-11-05', metrics: 16 }),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive, recordMissedTick } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const logger = require('../services/logger');
const siteone = require('../services/procurement/siteone-deals-digest');
const llm = require('../services/llm-dispatch-metrics');
const booking = require('../services/call-booking-link-weekly-check');
const kpi = require('../services/kpi-snapshot');
const { initScheduledJobs } = require('../services/scheduler');
const { etDateString } = require('../utils/datetime-et');

// initScheduledJobs registers once; beforeEach's clearAllMocks would wipe the record of
// it, so the registrations are copied out right after the first call.
let registrations = null;
function tick(expression, handlerSource) {
  if (!registrations) {
    isEnabled.mockImplementation((name) => name === 'cronJobs' || name === 'siteOneDealsDigest');
    initScheduledJobs();
    registrations = cron.schedule.mock.calls.map(([expr, fn, opts]) => ({ expr, fn, opts }));
  }
  const matches = registrations.filter((r) => r.expr === expression
    && (!handlerSource || String(r.fn).includes(handlerSource)));
  expect(matches).toHaveLength(1);
  expect(matches[0].opts).toEqual({ timezone: 'America/New_York' });
  return matches[0].fn;
}

beforeEach(() => {
  jest.clearAllMocks();
  runExclusive.mockImplementation(async (_key, task) => task());
  isEnabled.mockImplementation((name) => name === 'cronJobs' || name === 'siteOneDealsDigest');
});

describe('SiteOne deals digest catch-up (Mon + Tue 10:52)', () => {
  const catchUp = () => tick('52 10 * * 1,2')();

  test('this week already ran: no lock, no run', async () => {
    siteone.weekIsMissing.mockResolvedValue(false);
    await catchUp();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(siteone.runSiteOneDealsCatchUp).not.toHaveBeenCalled();
  });

  test('this week missed: runs under the digest job lock', async () => {
    siteone.weekIsMissing.mockResolvedValue(true);
    await catchUp();
    expect(runExclusive).toHaveBeenCalledWith('siteone-deals-digest', expect.any(Function));
    expect(siteone.runSiteOneDealsCatchUp).toHaveBeenCalledTimes(1);
  });

  test('gate off: the tick returns before any check', async () => {
    isEnabled.mockImplementation((name) => name === 'cronJobs');
    await catchUp();
    expect(siteone.weekIsMissing).not.toHaveBeenCalled();
    expect(runExclusive).not.toHaveBeenCalled();
  });

  test('a failed catch-up is logged, never thrown out of the tick', async () => {
    siteone.weekIsMissing.mockResolvedValue(true);
    siteone.runSiteOneDealsCatchUp.mockRejectedValueOnce(new Error('boom'));
    await expect(catchUp()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Weekly SiteOne deals digest catch-up failed: boom');
  });

  test('the Monday 8:00 tick is unchanged: plain run, no pre-check', async () => {
    await tick('0 8 * * 1')();
    expect(siteone.weekIsMissing).not.toHaveBeenCalled();
    expect(runExclusive).toHaveBeenCalledWith('siteone-deals-digest', expect.any(Function));
    expect(siteone.runSiteOneDealsDigest).toHaveBeenCalledWith();
  });
});

describe('booking-link weekly check catch-up (Mon + Tue 10:44)', () => {
  const catchUp = () => tick('44 10 * * 1,2')();

  test('this week already reported: no lock, no run', async () => {
    booking.weekIsMissing.mockResolvedValue(false);
    await catchUp();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(booking.runCallBookingLinkWeeklyCheck).not.toHaveBeenCalled();
  });

  test('this week missed: runs the same check under the same lock', async () => {
    booking.weekIsMissing.mockResolvedValue(true);
    await catchUp();
    expect(runExclusive).toHaveBeenCalledWith('call-booking-link-weekly', expect.any(Function));
    expect(booking.runCallBookingLinkWeeklyCheck).toHaveBeenCalledTimes(1);
  });

  test('a lock skipped for a lost connection is recorded like the Monday tick', async () => {
    booking.weekIsMissing.mockResolvedValue(true);
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'no_connection' });
    await catchUp();
    expect(recordMissedTick).toHaveBeenCalledWith('call-booking-link-weekly', expect.any(Number), 'tick skipped: no_connection');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('tick skipped: no_connection'));
  });

  test('the Monday 8:13 tick is unchanged: plain run, no pre-check', async () => {
    await tick('13 8 * * 1')();
    expect(booking.weekIsMissing).not.toHaveBeenCalled();
    expect(runExclusive).toHaveBeenCalledWith('call-booking-link-weekly', expect.any(Function));
    expect(booking.runCallBookingLinkWeeklyCheck).toHaveBeenCalledTimes(1);
  });
});

describe('KPI daily snapshot catch-up (23:55)', () => {
  const catchUp = () => tick('55 23 * * *')();

  test('today already recorded: no lock, no write', async () => {
    kpi.snapshotMissing.mockResolvedValue(false);
    await catchUp();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(kpi.recordKpiSnapshotIfMissing).not.toHaveBeenCalled();
  });

  test("today's rows missing: writes today's date under the snapshot lock", async () => {
    kpi.snapshotMissing.mockResolvedValue(true);
    await catchUp();
    const today = etDateString();
    expect(kpi.snapshotMissing).toHaveBeenCalledWith(today);
    expect(runExclusive).toHaveBeenCalledWith('kpi-daily-snapshot', expect.any(Function));
    expect(kpi.recordKpiSnapshotIfMissing).toHaveBeenCalledWith(today);
  });

  test('the 23:45 tick is unchanged: plain snapshot, no pre-check', async () => {
    await tick('45 23 * * *')();
    expect(kpi.snapshotMissing).not.toHaveBeenCalled();
    expect(runExclusive).toHaveBeenCalledWith('kpi-daily-snapshot', expect.any(Function));
    expect(kpi.recordKpiSnapshot).toHaveBeenCalledWith();
  });

  test('a failed catch-up is logged, never thrown out of the tick', async () => {
    kpi.snapshotMissing.mockResolvedValue(true);
    kpi.recordKpiSnapshotIfMissing.mockRejectedValueOnce(new Error('boom'));
    await expect(catchUp()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('[kpi-snapshot] catch-up failed: boom');
  });
});

describe('LLM dispatch digest catch-up (12:28)', () => {
  const catchUp = () => tick('28 12 * * *')();

  test('no day owed: no lock, no digest', async () => {
    llm.digestCatchUpNeeded.mockResolvedValue(false);
    await catchUp();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(llm.runLlmDispatchDigestWithCatchUp).not.toHaveBeenCalled();
  });

  test('a day is owed: runs the digest under the same lock', async () => {
    llm.digestCatchUpNeeded.mockResolvedValue(true);
    await catchUp();
    expect(runExclusive).toHaveBeenCalledWith('llm-dispatch-digest', expect.any(Function));
    expect(llm.runLlmDispatchDigestWithCatchUp).toHaveBeenCalledTimes(1);
  });

  test('the 6:25 tick runs the same entry point with no pre-check', async () => {
    await tick('25 6 * * *', 'runLlmDispatchDigestTick')();
    expect(llm.digestCatchUpNeeded).not.toHaveBeenCalled();
    expect(runExclusive).toHaveBeenCalledWith('llm-dispatch-digest', expect.any(Function));
    expect(llm.runLlmDispatchDigestWithCatchUp).toHaveBeenCalledTimes(1);
  });

  test('the no_connection SMTP alert still fires from the 6:25 tick', async () => {
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'no_connection' });
    await tick('25 6 * * *', 'runLlmDispatchDigestTick')();
    expect(llm.alertRecorderUnreachable).toHaveBeenCalledWith('no_connection');
  });

  test('a lease held by another instance is a normal overlap, not an outage', async () => {
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    await tick('25 6 * * *', 'runLlmDispatchDigestTick')();
    expect(llm.alertRecorderUnreachable).not.toHaveBeenCalled();
  });
});
