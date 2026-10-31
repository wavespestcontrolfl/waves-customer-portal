/**
 * The 8:23 AM ET tax deadline job (server/services/scheduler.js), owner 2026-10-30. Gate off
 * (GATE_TAX_DEADLINE_BELLS unset): the owner-phone text and the reminder_sent marks are as before.
 * Gate on: the bell service runs and no text goes out.
 *
 * Mock baseline copied from scheduler-alert-retention-cron.test.js.
 */
const mockFilings = [{ id: 'f1', title: 'FL Sales Tax Return (DR-15)', amount_due: null, due_date: '2099-01-20' }];
const mockUpdates = [];
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const b = {};
    for (const m of ['where', 'whereNot', 'orderBy', 'whereIn']) b[m] = jest.fn(() => b);
    b.del = jest.fn(async () => 0);
    b.update = jest.fn(async (patch) => { mockUpdates.push(patch); return 1; });
    b.then = (resolve, reject) => Promise.resolve(mockFilings).then(resolve, reject);
    return b;
  });
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  recurringSeriesTopUpLive: jest.fn(() => false), alertRetentionMode: jest.fn(() => 'off'),
  taxDeadlineBellsLive: jest.fn(() => false),
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
jest.mock('../services/payroll-tax-calendar', () => ({ syncPayrollFilingsSafe: jest.fn(async () => ({})) }));
jest.mock('../services/tax-deadline-reminders', () => ({ runTaxDeadlineReminders: jest.fn(async () => ({})) }));

const cron = require('../utils/scheduled-cron');
const { isEnabled, taxDeadlineBellsLive } = require('../config/feature-gates');
const TwilioService = require('../services/twilio');
const { runTaxDeadlineReminders } = require('../services/tax-deadline-reminders');
const { syncPayrollFilingsSafe } = require('../services/payroll-tax-calendar');
const { initScheduledJobs } = require('../services/scheduler');

function taxTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  mockUpdates.length = 0; // marks written while the other jobs were registered
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '23 8 * * *');
  expect(registrations).toHaveLength(1);
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdates.length = 0;
  taxDeadlineBellsLive.mockReturnValue(false);
  process.env.ADAM_PHONE = '+15550001111';
});
afterAll(() => { delete process.env.ADAM_PHONE; });

test('gate off: the same text to the owner phone and the same reminder_sent marks', async () => {
  await taxTick();
  expect(syncPayrollFilingsSafe).toHaveBeenCalledTimes(1);
  expect(runTaxDeadlineReminders).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  const [to, message, opts] = TwilioService.sendSMS.mock.calls[0];
  expect(to).toBe('+15550001111');
  expect(message).toBe('Tax Deadline Alert:\n\n- FL Sales Tax Return (DR-15) — due Jan 20 (' + message.match(/\((\d+) days?\)/)[1] + ' days)\n\nReview in the admin portal.');
  expect(opts).toEqual({ messageType: 'internal_alert' });
  expect(mockUpdates).toEqual([{ reminder_sent: true, reminder_sent_at: expect.any(Date) }]);
});

test('gate on: the payroll sync runs first, the bells run, and no text or mark goes out', async () => {
  taxDeadlineBellsLive.mockReturnValue(true);
  await taxTick();
  expect(syncPayrollFilingsSafe).toHaveBeenCalledTimes(1);
  expect(runTaxDeadlineReminders).toHaveBeenCalledTimes(1);
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  expect(mockUpdates).toHaveLength(0);
});
