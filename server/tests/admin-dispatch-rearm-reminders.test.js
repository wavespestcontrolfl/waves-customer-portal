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
 *
 * The 72h window additionally only re-arms while the cron can still deliver
 * it (the REAL AppointmentReminders.reminder72hStillReachable — appointment
 * more than 24.25h out, the cron's own send boundary): clearing it for a
 * same/next-day appointment leaves a dead armed flag the 15-minute scan
 * re-selects forever, so those guards re-arm ONLY the 24h window (which
 * carries the fallback notice). This pins both helpers' contract.
 *
 * The snapshot read itself is BEST-EFFORT with a DISTINCT failure result:
 * captureReminderGuards returned [] both for "no reminder rows" and for a
 * failed read, so a blocked send after a failed read silently skipped the
 * re-arm — the willNotify:true sync had already covered both windows, and the
 * customer heard nothing. It now returns { failed: true, guards: [] } on
 * failure, and rearmRescheduleReminderWindows degrades to the unguarded
 * re-arm scoped by the caller-supplied service ids + the static
 * suppressed_by_sibling/cancelled carve-outs, judging the 72h band from each
 * entry's caller-known NEW appointment time (mirrors reschedule-sms.js's
 * reminderGuardReadFailed fallback — "silence is worse"). Genuine-empty []
 * stays a no-op, and a nullish guards input can never trigger the fallback.
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

// Guard times relative to the REAL clock — the 72h band predicate is the real
// AppointmentReminders.reminder72hStillReachable (unmocked), so these pin the
// actual 24.25h boundary, not a stub of it.
const FUTURE_APPT = new Date(Date.now() + 72 * 3600 * 1000); // inside the 72h send band
const NEAR_APPT = new Date(Date.now() + 20 * 3600 * 1000);   // < 24.25h — 72h can never fire
const FAR_APPT = new Date(Date.now() + 200 * 3600 * 1000);   // beyond the band — 72h fires later
const APPT = new Date('2026-07-10T14:00:00Z');
const UPD = new Date('2026-07-04T17:00:00Z');
const guard = (id, appointmentTime = FUTURE_APPT, updatedAt = UPD) => ({
  scheduledServiceId: id, appointmentTime, updatedAt,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.fn = { now: jest.fn(() => 'now()') };
});

test('re-arms both windows for a still-reachable guard, scoped by service id + appointment_time + updated_at', async () => {
  const q = chain();
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') return q;
    throw new Error(`Unexpected db('${table}') call`);
  });

  await rearmRescheduleReminderWindows(guard('svc-1'));

  expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1' });
  // The move-on-underneath guard: the exact row state this invocation synced.
  expect(q.where).toHaveBeenCalledWith('appointment_time', FUTURE_APPT);
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

test('a same/next-day guard (< 24.25h out) re-arms ONLY the 24h window — the dead 72h flag stays covered', async () => {
  // The cron's 72h branch never fires inside 24.25h: clearing the flag there
  // can never produce a text, it just re-enters the row in every 15-minute
  // scan forever. The covered flag the sync stamped is the correct terminal
  // state; the re-armed 24h window carries the fallback notice.
  const q = chain();
  db.mockImplementation(() => q);

  await rearmRescheduleReminderWindows(guard('svc-1', NEAR_APPT));

  const payload = q.update.mock.calls[0][0];
  expect(payload).toMatchObject({ reminder_24h_sent: false, reminder_24h_sent_at: null });
  expect(payload).not.toHaveProperty('reminder_72h_sent');
  expect(payload).not.toHaveProperty('reminder_72h_sent_at');
});

test('a guard beyond the 72h send band (no upper bound) still re-arms the 72h window for the later pass', async () => {
  // reminder72hStillReachable has no upper bound on purpose: a visit 200h out
  // re-arms now and the cron delivers when it drops into (24.25h, 72.25h].
  const q = chain();
  db.mockImplementation(() => q);

  await rearmRescheduleReminderWindows(guard('svc-1', FAR_APPT));

  expect(q.update).toHaveBeenCalledWith(expect.objectContaining({
    reminder_72h_sent: false,
    reminder_72h_sent_at: null,
    reminder_24h_sent: false,
    reminder_24h_sent_at: null,
  }));
});

test('re-arms every occurrence of a series move (one guarded update per guard), each judged on its OWN time', async () => {
  const q = chain();
  db.mockImplementation(() => q);

  await rearmRescheduleReminderWindows([
    guard('svc-1', FUTURE_APPT), guard('svc-2', NEAR_APPT), guard('svc-3', FUTURE_APPT),
  ]);

  expect(q.update).toHaveBeenCalledTimes(3);
  expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1' });
  expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-2' });
  expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-3' });
  // Per-guard band decisions: occurrences 1 and 3 re-arm both windows, the
  // same/next-day occurrence 2 re-arms only the 24h window.
  expect(q.update.mock.calls[0][0]).toHaveProperty('reminder_72h_sent', false);
  expect(q.update.mock.calls[1][0]).not.toHaveProperty('reminder_72h_sent');
  expect(q.update.mock.calls[2][0]).toHaveProperty('reminder_72h_sent', false);
});

test('a newer reschedule that moved the row on underneath is not stomped (zero-row skip, no throw)', async () => {
  // The guarded UPDATE matches zero rows because appointment_time/updated_at
  // no longer equal the captured snapshot — the newer reschedule owns the
  // flags now. The helper simply moves on.
  const q = chain({ update: jest.fn().mockResolvedValue(0) });
  db.mockImplementation(() => q);

  await expect(rearmRescheduleReminderWindows(guard('svc-1'))).resolves.toBeUndefined();
  expect(q.where).toHaveBeenCalledWith('appointment_time', FUTURE_APPT);
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

  test('a snapshot read failure returns the DISTINCT failure marker (never the genuine-empty []), logged', async () => {
    // [] must keep meaning "read succeeded, no reminder rows" — a failed read
    // masquerading as that no-ops the blocked-send re-arm while the
    // willNotify:true sync has already covered both windows: total silence.
    db.mockImplementation(() => chain({ select: jest.fn().mockRejectedValue(new Error('db down')) }));
    await expect(captureReminderGuards('svc-1')).resolves.toEqual({ failed: true, guards: [] });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('reminder guard snapshot failed'));
  });
});

describe('snapshot-read-failure fallback (unguarded re-arm)', () => {
  const FAILED = { failed: true, guards: [] };
  const entry = (id, appointmentTime = FUTURE_APPT) => ({ scheduledServiceId: id, appointmentTime });

  test('failure marker + fallback scope → unguarded re-arm: service id + carve-outs only, NO snapshot predicates, logged loudly', async () => {
    const q = chain();
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return q;
      throw new Error(`Unexpected db('${table}') call`);
    });

    await rearmRescheduleReminderWindows(FAILED, [entry('svc-1')]);

    expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1' });
    // The static carve-outs survive the lost snapshot…
    expect(q.where).toHaveBeenCalledWith('suppressed_by_sibling', false);
    expect(q.where).toHaveBeenCalledWith('cancelled', false);
    // …but the snapshot predicates are exactly what failed to capture — they
    // must NOT appear, or the update could never match a row.
    expect(q.where).not.toHaveBeenCalledWith('appointment_time', expect.anything());
    expect(q.where).not.toHaveBeenCalledWith('updated_at', expect.anything());
    expect(q.update).toHaveBeenCalledWith(expect.objectContaining({
      reminder_72h_sent: false,
      reminder_72h_sent_at: null,
      reminder_24h_sent: false,
      reminder_24h_sent_at: null,
    }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('WITHOUT the pre-send snapshot guard'));
  });

  test('fallback respects the 72h band per entry, judged on the caller-supplied NEW appointment time', async () => {
    const q = chain();
    db.mockImplementation(() => q);

    await rearmRescheduleReminderWindows(FAILED, [
      entry('svc-1', FUTURE_APPT), entry('svc-2', NEAR_APPT),
    ]);

    expect(q.update).toHaveBeenCalledTimes(2);
    expect(q.update.mock.calls[0][0]).toHaveProperty('reminder_72h_sent', false);
    expect(q.update.mock.calls[1][0]).not.toHaveProperty('reminder_72h_sent');
    expect(q.update.mock.calls[1][0]).toMatchObject({ reminder_24h_sent: false, reminder_24h_sent_at: null });
  });

  test('capture failure piped straight into the re-arm (the call-site shape) fires the fallback', async () => {
    // The read fails…
    db.mockImplementation(() => chain({ select: jest.fn().mockRejectedValue(new Error('db down')) }));
    const guards = await captureReminderGuards(['svc-1']);

    // …and the re-arm still reaches the row via the caller-known scope.
    const q = chain();
    db.mockImplementation(() => q);
    await rearmRescheduleReminderWindows(guards, [entry('svc-1')]);

    expect(q.update).toHaveBeenCalledTimes(1);
    expect(q.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1' });
  });

  test('failure marker WITHOUT a usable fallback scope re-arms nothing (logged) — never an unscoped update', async () => {
    db.mockImplementation(() => { throw new Error('should not query'); });
    await rearmRescheduleReminderWindows(FAILED);
    await rearmRescheduleReminderWindows(FAILED, []);
    // A malformed entry with no id is filtered out too.
    await rearmRescheduleReminderWindows(FAILED, [{ appointmentTime: APPT }]);
    expect(db).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no fallback scope supplied'));
  });

  test('genuine-empty snapshot ([] — read succeeded, no rows) still no-ops even with a fallback scope supplied', async () => {
    db.mockImplementation(() => { throw new Error('should not query'); });
    await rearmRescheduleReminderWindows([], [entry('svc-1')]);
    expect(db).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a fallback re-arm failure is logged per entry, never thrown (best-effort compensation)', async () => {
    db.mockImplementation(() => chain({ update: jest.fn().mockRejectedValue(new Error('db down')) }));
    await expect(rearmRescheduleReminderWindows(FAILED, [entry('svc-1')])).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('re-arm after failed notice failed'));
  });
});
