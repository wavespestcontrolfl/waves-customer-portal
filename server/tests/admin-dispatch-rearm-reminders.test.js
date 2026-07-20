/**
 * Dispatch reschedule — no-send reminder re-arm helper.
 *
 * The dispatch reschedule routes cover due 24h/72h reminder windows
 * (syncRescheduleReminder willNotify:true) BEFORE attempting their own SMS.
 * On a failed/blocked send they recorded notificationError but never
 * re-armed — the customer could be moved with NO message of any kind.
 * The routes now call rearmRescheduleReminderWindows on every no-send path
 * (single visit + series variant), mirroring reschedule-public.js.
 * This pins the helper's contract.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { rearmRescheduleReminderWindows } = require('../routes/admin-dispatch')._test;

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  });
  return builder;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.fn = { now: jest.fn(() => 'now()') };
});

test('re-arms both windows for a single service id', async () => {
  const q = chain();
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') return q;
    throw new Error(`Unexpected db('${table}') call`);
  });

  await rearmRescheduleReminderWindows('svc-1');

  expect(q.whereIn).toHaveBeenCalledWith('scheduled_service_id', ['svc-1']);
  expect(q.update).toHaveBeenCalledWith(expect.objectContaining({
    reminder_72h_sent: false,
    reminder_72h_sent_at: null,
    reminder_24h_sent: false,
    reminder_24h_sent_at: null,
  }));
});

test('re-arms every occurrence of a series move', async () => {
  const q = chain();
  db.mockImplementation(() => q);

  await rearmRescheduleReminderWindows(['svc-1', 'svc-2', 'svc-3']);

  expect(q.whereIn).toHaveBeenCalledWith('scheduled_service_id', ['svc-1', 'svc-2', 'svc-3']);
});

test('empty/falsy input is a no-op', async () => {
  db.mockImplementation(() => { throw new Error('should not query'); });
  await rearmRescheduleReminderWindows([]);
  await rearmRescheduleReminderWindows(null);
  expect(db).not.toHaveBeenCalled();
});

test('a re-arm failure is logged, never thrown (best-effort compensation)', async () => {
  db.mockImplementation(() => chain({ update: jest.fn().mockRejectedValue(new Error('db down')) }));
  await expect(rearmRescheduleReminderWindows('svc-1')).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('re-arm after failed notice failed'));
});
