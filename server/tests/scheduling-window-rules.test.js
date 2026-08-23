/**
 * scheduling/window-rules — the shared admin appointment-window validator
 * every admin write path (schedule create / edit / bulk move / dispatch
 * reschedule) runs a window through before persisting it.
 */
jest.mock('../models/db', () => jest.fn());

const {
  assertAdminAppointmentWindow,
  assertNoSlotOverlap,
  adminSlotOverlapGuardEnabled,
  ADMIN_DAY_START_MINUTES,
  ADMIN_DAY_END_MINUTES,
} = require('../services/scheduling/window-rules');
const findTime = require('../services/scheduling/find-time');

describe('assertAdminAppointmentWindow', () => {
  test('day START is the customer slot finder\'s (08:00); day END is the admin grid\'s 20:00', () => {
    expect(ADMIN_DAY_START_MINUTES).toBe(findTime.DAY_START_HOUR * 60);
    expect(ADMIN_DAY_START_MINUTES).toBe(8 * 60);
    // Admins book evening visits the self-booking path never offers; the
    // bound is TimeGridDay's DAY_END_HOUR, not find-time's 17:00.
    expect(ADMIN_DAY_END_MINUTES).toBe(20 * 60);
  });

  test('good case normalizes and derives the end from the duration', () => {
    expect(assertAdminAppointmentWindow({ windowStart: '8:00', windowEnd: '9:00' }))
      .toEqual({ window_start: '08:00', window_end: '09:00' });
    expect(assertAdminAppointmentWindow({ windowStart: '09:00:00', durationMinutes: 120 }))
      .toEqual({ window_start: '09:00', window_end: '11:00' });
    expect(assertAdminAppointmentWindow({ windowStart: '16:00' }))
      .toEqual({ window_start: '16:00', window_end: '17:00' });
  });

  function expect422(args, pattern) {
    let caught;
    try { assertAdminAppointmentWindow(args); } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(422);
    expect(caught.statusCode).toBe(422);
    expect(caught.code).toBe('INVALID_APPOINTMENT_WINDOW');
    expect(caught.message).toMatch(pattern);
  }

  test('pre-8am start is refused', () => {
    expect422({ windowStart: '07:00', windowEnd: '08:00' }, /before 08:00/);
    expect422({ windowStart: '06:00' }, /before 08:00/);
  });

  test(':30 start is refused (slots start on the hour)', () => {
    expect422({ windowStart: '06:30', windowEnd: '07:30' }, /on the hour/);
    expect422({ windowStart: '09:30' }, /on the hour.*09:00/);
  });

  test('"8am" and other non-HH:MM strings are refused instead of producing a NaN end', () => {
    expect422({ windowStart: '8am' }, /HH:MM/);
    expect422({ windowStart: '' }, /HH:MM/);
    expect422({ windowStart: null }, /HH:MM/);
    expect422({ windowStart: '25:00' }, /HH:MM/);
    expect422({ windowStart: '09:00', windowEnd: 'noon' }, /HH:MM/);
  });

  test('end must be after start', () => {
    expect422({ windowStart: '10:00', windowEnd: '10:00' }, /after its start/);
    expect422({ windowStart: '10:00', windowEnd: '09:00' }, /after its start/);
  });

  test('end must not run past the day end', () => {
    expect422({ windowStart: '19:00', windowEnd: '21:00' }, /end by 20:00/);
    expect422({ windowStart: '20:00' }, /end by 20:00/);
  });
});

describe('assertNoSlotOverlap gate', () => {
  const saved = process.env.GATE_ADMIN_SLOT_OVERLAP_GUARD;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_ADMIN_SLOT_OVERLAP_GUARD;
    else process.env.GATE_ADMIN_SLOT_OVERLAP_GUARD = saved;
  });

  test('only the exact string "true" enables the guard (fail-closed parse)', () => {
    for (const v of [undefined, '', '1', 'TRUE', 'yes', 'on', ' true']) {
      if (v === undefined) delete process.env.GATE_ADMIN_SLOT_OVERLAP_GUARD;
      else process.env.GATE_ADMIN_SLOT_OVERLAP_GUARD = v;
      expect(adminSlotOverlapGuardEnabled()).toBe(false);
    }
    process.env.GATE_ADMIN_SLOT_OVERLAP_GUARD = 'true';
    expect(adminSlotOverlapGuardEnabled()).toBe(true);
  });

  test('gate off: no lock, no probe, no throw', async () => {
    delete process.env.GATE_ADMIN_SLOT_OVERLAP_GUARD;
    const trx = jest.fn();
    trx.raw = jest.fn();
    await expect(assertNoSlotOverlap({ trx, date: '2099-01-15', windowStart: '09:00', windowEnd: '10:00' }))
      .resolves.toEqual([]);
    expect(trx).not.toHaveBeenCalled();
    expect(trx.raw).not.toHaveBeenCalled();
  });
});
