// Auto-dispatch's reminder sync after a committed move: a still-pending
// creation confirmation stays pending inside handleReschedule's own write
// (keepPendingConfirmation), never re-armed afterwards. A re-arm read the
// snapshot handleReschedule took BEFORE its update, so a deferred send that
// finished in between was marked unsent again and could go out twice.
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn(async (id, date, win, reason, by, opts) => ({ success: true, landedStatus: opts.expect.status })),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn(),
  REMINDER_BLOCKING_STATUSES: new Set(['cancelled', 'canceled', 'completed', 'skipped', 'no_show', 'rescheduled']),
  reminderRowCanSend: (row) => !!row && row.cancelled !== true && row.suppressed_by_sibling !== true && row.windows_preclosed !== true,
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'n1' }),
  _private: { doneColumns: jest.fn(({ by, resolution, at }) => ({ done_at: at, done_by: by, resolution })) },
}));
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn().mockResolvedValue({ failed: false, frozen: new Set() }),
  loadAnchorMap: jest.fn().mockResolvedValue(new Map()),
}));

const db = require('../models/db');
const AppointmentReminders = require('../services/appointment-reminders');
const notifications = require('../services/notification-service');
const { applyAutoDispatchMove } = require('../services/auto-dispatch/apply');

const SERVICE = {
  id: 's-race', status: 'confirmed', scheduled_date: '2026-08-04',
  window_start: '09:00', window_end: '11:00', technician_id: 't1',
  auto_dispatch_change_count: 0,
};
const BEST = { date: '2026-08-11', start_time: '08:00', end_time: '10:00', technician_id: 't1' };
const FRESH = {
  scheduled_date: SERVICE.scheduled_date, window_start: SERVICE.window_start, window_end: SERVICE.window_end,
  technician_id: SERVICE.technician_id, status: SERVICE.status,
  auto_dispatch_locked: false, auto_dispatch_excluded: false, customer_confirmed: false,
};

function query(first, update) {
  return {
    where() { return this; },
    whereNot() { return this; },
    whereRaw() { return this; },
    first: first || (async () => undefined),
    update: update || (async () => 1),
  };
}

// Every table by name; appointment_reminders writes land on `reminder`.
function wireTables(reminder, tables = []) {
  db.mockImplementation((table) => {
    tables.push(table);
    if (table === 'scheduled_services') return query(async () => FRESH);
    if (table === 'appointment_reminders') {
      return query(undefined, async (patch) => { Object.assign(reminder, patch); return 1; });
    }
    if (table === 'notifications') return query(undefined, async () => 1);
    throw new Error(`unexpected table ${table}`);
  });
  return tables;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((s) => ({ raw: s }));
  db.fn = { now: jest.fn(() => 'now()') };
});

test('a confirmation the deferred worker sends during the reminder sync stays sent', async () => {
  const reminder = { id: 'r-race', confirmation_sent: false, confirmation_sent_at: null };
  const providerSend = jest.fn(async () => {
    reminder.confirmation_sent = true;
    reminder.confirmation_sent_at = 'provider-mark';
  });
  // The worker finishes inside the sync, but handleReschedule returns the
  // snapshot it read before that send.
  AppointmentReminders.handleReschedule.mockImplementationOnce(async () => {
    await providerSend();
    return { id: reminder.id, confirmation_sent: false };
  });
  const tables = wireTables(reminder);

  await applyAutoDispatchMove(SERVICE, BEST, 'run-race', {});

  expect(providerSend).toHaveBeenCalledTimes(1);
  expect(reminder).toMatchObject({ confirmation_sent: true, confirmation_sent_at: 'provider-mark' });
  expect(tables).not.toContain('appointment_reminders');
});

test('the sync keeps the pending confirmation and is fenced on the slot the move committed', async () => {
  AppointmentReminders.handleReschedule.mockResolvedValueOnce({ id: 'r1', confirmation_sent: false });
  wireTables({});
  await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('s-race', '2026-08-11T08:00', {
    sendNotification: false,
    keepPendingConfirmation: true,
    expectSchedule: { date: '2026-08-11', windowStart: '08:00' },
    preserveMoveHold: false,
  });
});

test('a candidate with no start time fences on the date only (no windowStart key)', async () => {
  AppointmentReminders.handleReschedule.mockResolvedValueOnce({ id: 'r1', confirmation_sent: true });
  wireTables({});
  await applyAutoDispatchMove(SERVICE, { ...BEST, start_time: null }, 'run1', {});
  expect(AppointmentReminders.handleReschedule.mock.calls[0][2].expectSchedule).toEqual({ date: '2026-08-11' });
});

test('a sync skipped as stale rings nobody, even with the reminder off the slot this run committed', async () => {
  // A newer move holds another slot: that writer syncs its own reminder.
  AppointmentReminders.handleReschedule.mockResolvedValueOnce({ skippedStale: true });
  AppointmentReminders.composeScheduledApptTime = jest.fn(() => new Date('2026-08-11T12:00:00Z'));
  const tables = wireTables({ appointment_time: '2026-08-04T13:00:00Z' });
  await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  expect(tables).not.toContain('notifications');
});
