/**
 * Dispatch reschedule — no-send reminder re-arm helper (guarded).
 *
 * The dispatch reschedule routes cover due 24h/72h reminder windows
 * (syncRescheduleReminder willNotify:true) BEFORE attempting their own SMS.
 * On a failed/blocked send they re-arm both windows so the customer still
 * gets a day-before reminder ("silence is worse").
 *
 * The re-arm was scoped by service id ALONE, so a NEWER reschedule that
 * committed while this request's send was in flight (re-stamping
 * appointment_time, or marking its own notice sent) got its fresh flags
 * clobbered → duplicate messages. It is now guarded per-row on the
 * appointment_time + updated_at captured (captureReminderGuards) BEFORE the
 * send — a row that moved on underneath matches zero rows and is skipped, the
 * newer reschedule owns it. Mirrors handleReschedule's own re-arm guard.
 * This pins both helpers' contract.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { rearmRescheduleReminderWindows, captureReminderGuards } = require('../routes/admin-dispatch')._test;

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  });
  return builder;
}

const APPT = new Date('2026-07-10T14:00:00Z');
const UPD = new Date('2026-07-04T17:00:00Z');
const guard = (id, appointmentTime = APPT, updatedAt = UPD) => ({
  scheduledServiceId: id, appointmentTime, updatedAt,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.fn = { now: jest.fn(() => 'now()') };
});

test('re-arms both windows for a single guard, scoped by service id + appointment_time + updated_at', async () => {
  const q = chain();
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') return q;
    throw new Error(`Unexpected db('${table}') call`);
  });

  await rearmRescheduleReminderWindows(guard('svc-1'));

  expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1' });
  // The move-on-underneath guard: the exact row state this invocation synced.
  expect(q.where).toHaveBeenCalledWith('appointment_time', APPT);
  expect(q.where).toHaveBeenCalledWith('updated_at', UPD);
  // …and the sibling/cancelled carve-out is preserved.
  expect(q.where).toHaveBeenCalledWith('suppressed_by_sibling', false);
  expect(q.where).toHaveBeenCalledWith('cancelled', false);
  expect(q.update).toHaveBeenCalledWith(expect.objectContaining({
    reminder_72h_sent: false,
    reminder_72h_sent_at: null,
    reminder_24h_sent: false,
    reminder_24h_sent_at: null,
  }));
});

test('re-arms every occurrence of a series move (one guarded update per guard)', async () => {
  const q = chain();
  db.mockImplementation(() => q);

  await rearmRescheduleReminderWindows([guard('svc-1'), guard('svc-2'), guard('svc-3')]);

  expect(q.update).toHaveBeenCalledTimes(3);
  expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1' });
  expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-2' });
  expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-3' });
});

test('a newer reschedule that moved the row on underneath is not stomped (zero-row skip, no throw)', async () => {
  // The guarded UPDATE matches zero rows because appointment_time/updated_at
  // no longer equal the captured snapshot — the newer reschedule owns the
  // flags now. The helper simply moves on.
  const q = chain({ update: jest.fn().mockResolvedValue(0) });
  db.mockImplementation(() => q);

  await expect(rearmRescheduleReminderWindows(guard('svc-1'))).resolves.toBeUndefined();
  expect(q.where).toHaveBeenCalledWith('appointment_time', APPT);
  expect(q.where).toHaveBeenCalledWith('updated_at', UPD);
  expect(logger.error).not.toHaveBeenCalled();
});

test('empty/falsy input is a no-op (nothing without a guard is queried)', async () => {
  db.mockImplementation(() => { throw new Error('should not query'); });
  await rearmRescheduleReminderWindows([]);
  await rearmRescheduleReminderWindows(null);
  await rearmRescheduleReminderWindows(undefined);
  // A malformed guard with no id is filtered out too.
  await rearmRescheduleReminderWindows({ appointmentTime: APPT });
  expect(db).not.toHaveBeenCalled();
});

test('a re-arm failure is logged per guard, never thrown (best-effort compensation)', async () => {
  db.mockImplementation(() => chain({ update: jest.fn().mockRejectedValue(new Error('db down')) }));
  await expect(rearmRescheduleReminderWindows(guard('svc-1'))).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('re-arm after failed notice failed'));
});

describe('captureReminderGuards', () => {
  test('snapshots appointment_time + updated_at per service id (the pre-send guard)', async () => {
    const q = chain({
      select: jest.fn().mockResolvedValue([
        { scheduled_service_id: 'svc-1', appointment_time: APPT, updated_at: UPD },
        { scheduled_service_id: 'svc-2', appointment_time: APPT, updated_at: UPD },
      ]),
    });
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return q;
      throw new Error(`Unexpected db('${table}') call`);
    });

    const guards = await captureReminderGuards(['svc-1', 'svc-2']);

    expect(q.whereIn).toHaveBeenCalledWith('scheduled_service_id', ['svc-1', 'svc-2']);
    expect(q.select).toHaveBeenCalledWith('scheduled_service_id', 'appointment_time', 'updated_at');
    expect(guards).toEqual([
      { scheduledServiceId: 'svc-1', appointmentTime: APPT, updatedAt: UPD },
      { scheduledServiceId: 'svc-2', appointmentTime: APPT, updatedAt: UPD },
    ]);
  });

  test('empty/falsy input returns [] without a query', async () => {
    db.mockImplementation(() => { throw new Error('should not query'); });
    await expect(captureReminderGuards([])).resolves.toEqual([]);
    await expect(captureReminderGuards(null)).resolves.toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });

  test('a snapshot read failure degrades to [] (best-effort), logged', async () => {
    db.mockImplementation(() => chain({ select: jest.fn().mockRejectedValue(new Error('db down')) }));
    await expect(captureReminderGuards('svc-1')).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('reminder guard snapshot failed'));
  });
});
