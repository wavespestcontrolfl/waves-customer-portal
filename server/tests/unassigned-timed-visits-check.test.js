// The daily unassigned-timed-visits row (census M13, GATE_UNASSIGNED_VISIT_GUARD): the copy passes
// the admin notification rule; a refresh rings only when a visit joins; the 6:10 PM ET cron runs the
// check under runExclusive. The query and the row's lifecycle run against Postgres in
// unassigned-visit-guard.pg.test.js.
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
  recurringSeriesTopUpLive: jest.fn(() => false),
  unassignedVisitGuardLive: jest.fn(() => false),
  alertEpisodesLive: jest.fn(() => true),
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
jest.mock('../services/unassigned-timed-visits-check', () => ({
  ...jest.requireActual('../services/unassigned-timed-visits-check'),
  runUnassignedTimedVisitsCheck: jest.fn(),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const logger = require('../services/logger');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const Check = require('../services/unassigned-timed-visits-check');
const { initScheduledJobs } = require('../services/scheduler');

const { composeUnassignedVisits, ringOnNewVisit } = Check._private;
const visit = (over = {}) => ({
  id: 'v1', customer_id: 'c1', scheduled_date: '2026-10-27', window_start: '09:00:00', service_type: 'General Pest Control',
  first_name: 'Pat', last_name: 'Synthetic', ...over,
});

describe('composeUnassignedVisits', () => {
  test('one visit: a verb-led headline, a one-sentence why with the day and time, the board on that day', () => {
    const { spec, detail, itemKeys, count } = composeUnassignedVisits([visit()]);
    const alert = composeAdminAlert(spec); // throws under NODE_ENV=test when a rule is broken
    expect(alert.headline).toBe('Schedule — assign a technician to 1 visit');
    expect(alert.why).toBe('It is Tue Oct 27 at 9:00 AM for Pat Synthetic, with no technician.');
    expect(alert.link).toBe('/admin/schedule?date=2026-10-27');
    expect(alert.metadata).toMatchObject({ area: 'Schedule', severity: 'needs-you', doneWhen: 'count_zero', who: 'person', subject: { type: 'check', id: 'unassigned-timed-visits' } });
    expect(itemKeys).toEqual(['v1']);
    expect(count).toBe(1);
    expect(detail).toContain('- Tue Oct 27 at 9:00 AM: Pat Synthetic, General Pest Control');
  });

  test('several visits: the earliest leads, every visit is listed, and a long name still fits the 110-character why', () => {
    const rows = [
      visit({ id: 'b', first_name: 'Alexandria-Marguerite', last_name: 'Synthetic-Longname-Hyphenated-Surname-Example' }),
      visit({ id: 'a', scheduled_date: '2026-10-28', window_start: '13:30:00', first_name: 'Kim', last_name: 'Sample' }),
    ];
    const { spec, detail, itemKeys } = composeUnassignedVisits(rows);
    const alert = composeAdminAlert(spec);
    expect(alert.headline).toBe('Schedule — assign a technician to 2 visits');
    expect(alert.why.length).toBeLessThanOrEqual(110);
    expect(alert.link).toBe('/admin/schedule?date=2026-10-27');
    expect(itemKeys).toEqual(['a', 'b']);
    expect(detail).toContain('Wed Oct 28 at 1:30 PM: Kim Sample');
  });
});

describe('ringOnNewVisit', () => {
  test('rings only when a visit the row did not carry joins', () => {
    const ring = ringOnNewVisit(['a', 'b']);
    expect(ring(null, { itemKeys: ['a', 'b', 'c'] })).toBe(false);
    expect(ring(null, { itemKeys: ['a'] })).toBe(true);
    expect(ring(null, undefined)).toBe(true);
  });
});

describe('the 6:10 PM ET cron', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  function tick() {
    isEnabled.mockImplementation((name) => name === 'cronJobs');
    initScheduledJobs();
    const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === '10 18 * * *' && String(task).includes('runUnassignedTimedVisitsCheck'));
    expect(registrations).toHaveLength(1);
    expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
    return registrations[0][1]();
  }

  test('runs the check inside runExclusive', async () => {
    Check.runUnassignedTimedVisitsCheck.mockResolvedValue({ count: 2, outcome: 'raised' });
    await tick();
    expect(runExclusive).toHaveBeenCalledWith('unassigned-timed-visits', expect.any(Function));
    expect(Check.runUnassignedTimedVisitsCheck).toHaveBeenCalledTimes(1);
  });

  test('a failed check is logged, never thrown out of the tick', async () => {
    Check.runUnassignedTimedVisitsCheck.mockRejectedValue(new Error('read failed'));
    await expect(tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Unassigned timed visits check failed: read failed');
  });
});
