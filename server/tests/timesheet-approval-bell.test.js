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

const db = require('../models/db');
const cron = require('../utils/scheduled-cron');
const TwilioService = require('../services/twilio');
const timeTracking = require('../services/time-tracking');
const { composeAdminAlert, raiseAdminAlert } = require('../services/admin-alert-compose');
const episodes = require('../services/admin-alert-episodes');
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
});

describe('Monday 5 AM cron', () => {
  test('weeks wait for approval: one bell the composer accepts, and no text', async () => {
    timeTracking.computeWeeklySummary
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'approved' });
    await runMonday();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('payroll');
    const composed = composeAdminAlert(spec); // throws on a rule violation
    expect(composed.headline.length).toBeLessThanOrEqual(60);
    expect(spec.why).toMatch(/^1 timesheet for the week of [A-Z][a-z]{2} \d{1,2} waits, and pay needs it approved first\.$/);
    expect(spec.link).toMatch(/^\/admin\/timetracking\?tab=approvals&weekStart=\d{4}-\d{2}-\d{2}$/);
    const weekStart = spec.link.split('weekStart=')[1];
    expect(opts).toEqual({
      dedupeKey: `timesheets-approve:${weekStart}`,
      bellDefault: true,
      metadata: { weekStart, pendingCount: 1, reminder: 'timesheet_approval' },
    });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('nothing waits: no bell, and the open bell of that week is closed', async () => {
    timeTracking.computeWeeklySummary.mockResolvedValue({ status: 'approved' });
    await runMonday();

    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    const [, keys, reason] = episodes.closeAdminAlertKeys.mock.calls[0];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^timesheets-approve:\d{4}-\d{2}-\d{2}$/);
    expect(reason).toBe('timesheets_approved');
  });

  test('a bell that cannot be written never breaks the cron', async () => {
    timeTracking.computeWeeklySummary.mockResolvedValue({ status: 'pending' });
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
  test('the last pending week approved: the week bell closes', async () => {
    const countPending = jest.fn().mockResolvedValue(0);
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn', countPending })).resolves.toBe(1);
    expect(countPending).toHaveBeenCalledWith('conn', '2027-01-04');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(
      'conn', ['timesheets-approve:2027-01-04'], 'timesheets_approved', { resolution: expect.any(String) },
    );
  });

  test('one of two weeks approved: the bell stays open', async () => {
    const countPending = jest.fn().mockResolvedValue(1);
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn', countPending })).resolves.toBe(0);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a count or close that fails never throws and never closes by guess', async () => {
    const countPending = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn', countPending })).resolves.toBe(0);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();

    episodes.closeAdminAlertKeys.mockRejectedValue(new Error('db down'));
    await expect(bells.settleWeekBell('2027-01-04', { conn: 'conn', countPending: async () => 0 })).resolves.toBe(0);
  });
});
