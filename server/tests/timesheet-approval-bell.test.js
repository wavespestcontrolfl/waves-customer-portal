// The "timesheets wait" admin bell (owner "fix all", 2026-11-01) without a database: the Monday 5 AM cron raises ONE bell
// through raiseAdminAlert and sends no text, a week with nothing pending raises none and closes an open one, and an
// approval closes the bell only when it was the last pending week. Synthetic ids only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({ computeWeeklySummary: jest.fn(), computeDailySummary: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(), isKnownOwnerPhone: jest.fn() }));
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(),
}));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn() }));
jest.mock('../services/timesheet-approval', () => ({ getPendingWeeks: jest.fn() }));

const db = require('../models/db');
const cron = require('../utils/scheduled-cron');
const TwilioService = require('../services/twilio');
const timeTracking = require('../services/time-tracking');
const { composeAdminAlert, raiseAdminAlert } = require('../services/admin-alert-compose');
const episodes = require('../services/admin-alert-episodes');
const { getPendingWeeks } = require('../services/timesheet-approval');
const bells = require('../services/timesheet-approval-bells');
const { initTimeTrackingCrons } = require('../services/time-tracking-crons');

// A chainable query: every builder method returns itself, the awaited and .first() result is `rows` / its head.
function chain(rows) {
  const q = {};
  for (const m of ['where', 'whereRaw', 'select', 'leftJoin']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => rows[0]);
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

// Fake the tables the Monday body reads: two active techs that both worked the week.
function fakeTables() {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech One' }, { id: 't2', name: 'Tech Two' }]);
    if (table === 'time_entry_daily_summary') return chain([{ id: 'd1' }]);
    throw new Error(`unexpected table ${table}`);
  });
}

async function runMonday() {
  initTimeTrackingCrons();
  const monday = cron.schedule.mock.calls.find(([expr]) => expr === '0 5 * * 1');
  expect(monday).toBeTruthy();
  await monday[1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  raiseAdminAlert.mockResolvedValue({ id: 'n1' });
  episodes.closeAdminAlertKeys.mockResolvedValue(1);
  fakeTables();
  getPendingWeeks.mockResolvedValue([]);
});

describe('Monday 5 AM cron', () => {
  test('weeks wait for approval: one bell the composer accepts counted from the Approvals list, and no text', async () => {
    // The cron loop sees one active tech with a pending week; the page also lists a deactivated tech's pending week
    // and an approved one. Only the unapproved weeks count, the deactivated tech's included.
    timeTracking.computeWeeklySummary
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'approved' });
    getPendingWeeks.mockResolvedValue([
      { technician_id: 't1', status: 'pending' },
      { technician_id: 't2', status: 'approved' },
      { technician_id: 'gone', status: 'pending', tech_name: 'Inactive technician' },
    ]);
    await runMonday();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('payroll');
    const composed = composeAdminAlert(spec); // throws on a rule violation
    expect(composed.headline.length).toBeLessThanOrEqual(60);
    expect(spec.why).toMatch(/^2 timesheets for the week of [A-Z][a-z]{2} \d{1,2} wait, and pay needs them approved first\.$/);
    expect(spec.link).toMatch(/^\/admin\/timetracking\?tab=approvals&weekStart=\d{4}-\d{2}-\d{2}$/);
    const weekStart = spec.link.split('weekStart=')[1];
    expect(getPendingWeeks).toHaveBeenCalledWith(weekStart);
    expect(opts).toEqual({
      dedupeKey: `timesheets-approve:${weekStart}`,
      bellDefault: true,
      metadata: { weekStart, pendingCount: 2, reminder: 'timesheet_approval' },
    });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('the cron sees no pending tech but the page lists a waiting week: the bell still rings', async () => {
    timeTracking.computeWeeklySummary.mockResolvedValue({ status: 'approved' });
    getPendingWeeks.mockResolvedValue([{ technician_id: 'gone', status: 'pending' }]);
    await runMonday();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][2].metadata.pendingCount).toBe(1);
  });

  test('nothing waits: no bell, and the open bell of that week is closed', async () => {
    timeTracking.computeWeeklySummary.mockResolvedValue({ status: 'approved' });
    getPendingWeeks.mockResolvedValue([{ technician_id: 't1', status: 'approved' }]);
    await runMonday();

    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    const [, keys, reason] = episodes.closeAdminAlertKeys.mock.calls[0];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^timesheets-approve:\d{4}-\d{2}-\d{2}$/);
    expect(reason).toBe('timesheets_approved');
  });

  test('the Approvals list cannot be read: nothing closes, and the cron own count still raises the bell', async () => {
    getPendingWeeks.mockRejectedValue(new Error('db down'));
    timeTracking.computeWeeklySummary.mockResolvedValue({ status: 'approved' });
    await runMonday();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();

    jest.clearAllMocks();
    fakeTables();
    getPendingWeeks.mockRejectedValue(new Error('db down'));
    raiseAdminAlert.mockResolvedValue({ id: 'n1' });
    timeTracking.computeWeeklySummary.mockResolvedValue({ status: 'pending' });
    await runMonday();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a bell that cannot be written never breaks the cron', async () => {
    timeTracking.computeWeeklySummary.mockResolvedValue({ status: 'pending' });
    getPendingWeeks.mockResolvedValue([{ technician_id: 't1', status: 'pending' }]);
    raiseAdminAlert.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONN' }));
    await expect(runMonday()).resolves.toBeUndefined();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});

describe('bell copy', () => {
  test('plural copy passes the composer and stays inside the length rules', () => {
    const spec = bells.specFor('2027-01-04', 3);
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Billing — approve the timesheets for the week of Jan 4');
    expect(spec.why).toBe('3 timesheets for the week of Jan 4 wait, and pay needs them approved first.');
    expect(spec.why.length).toBeLessThanOrEqual(110);
  });
});

describe('closing after an approval', () => {
  test('the Approvals page lists only approved weeks: the week bell closes', async () => {
    getPendingWeeks.mockResolvedValue([{ status: 'approved' }, { status: 'approved' }]);
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn' })).resolves.toBe(1);
    expect(getPendingWeeks).toHaveBeenCalledWith('2027-01-04');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(
      'conn', ['timesheets-approve:2027-01-04'], 'timesheets_approved', { resolution: expect.any(String) },
    );
  });

  test('the page lists no week at all: the week bell closes', async () => {
    getPendingWeeks.mockResolvedValue([]);
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn' })).resolves.toBe(1);
  });

  test('one of two weeks approved: the bell stays open', async () => {
    getPendingWeeks.mockResolvedValue([{ status: 'approved' }, { status: 'pending' }]);
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn' })).resolves.toBe(0);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('another tech whose weekly summary was missing is listed as pending by the page: the bell stays open', async () => {
    // getPendingWeeks builds the missing rollup and lists it as pending, so approving the first tech cannot close the bell.
    getPendingWeeks.mockResolvedValue([
      { technician_id: 't1', status: 'approved' },
      { technician_id: 't2', status: 'pending', id: 'rebuilt-summary' },
    ]);
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn' })).resolves.toBe(0);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a list that cannot be read, or a close that fails, never throws and never closes by guess', async () => {
    getPendingWeeks.mockRejectedValue(new Error('db down'));
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn' })).resolves.toBe(0);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();

    getPendingWeeks.mockResolvedValue([]);
    episodes.closeAdminAlertKeys.mockRejectedValue(new Error('db down'));
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn' })).resolves.toBe(0);
  });
});
