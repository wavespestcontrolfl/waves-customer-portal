/**
 * scheduling/window-rules — the shared admin appointment-window validator
 * every admin write path (schedule create / edit / bulk move / dispatch
 * reschedule) runs a window through before persisting it.
 */
jest.mock('../models/db', () => jest.fn());
// Spy over the REAL occupancy probe: existing cases keep the real SQL builder;
// the technician cases read what probeSlotOverlap hands it.
jest.mock('../services/scheduling/occupancy', () => {
  const actual = jest.requireActual('../services/scheduling/occupancy');
  return { ...actual, findConflictingVisits: jest.fn((...args) => actual.findConflictingVisits(...args)) };
});

const {
  assertAdminAppointmentWindow,
  probeSlotOverlap,
  slotOverlapWarning,
  ADMIN_DAY_END_MINUTES,
} = require('../services/scheduling/window-rules');
const findTime = require('../services/scheduling/find-time');

describe('assertAdminAppointmentWindow', () => {
  test('day END is the admin grid\'s 20:00; there is no day-start floor', () => {
    // Admins book evening visits the self-booking path never offers; the
    // bound is TimeGridDay's DAY_END_HOUR, not find-time's 17:00.
    expect(ADMIN_DAY_END_MINUTES).toBe(20 * 60);
    expect(findTime.DAY_START_HOUR).toBe(8); // customer slot finder only — not an admin rule
  });

  test('good case normalizes and derives the end from the duration', () => {
    expect(assertAdminAppointmentWindow({ windowStart: '8:00', windowEnd: '9:00' }))
      .toEqual({ window_start: '08:00', window_end: '09:00' });
    expect(assertAdminAppointmentWindow({ windowStart: '09:00:00', durationMinutes: 120 }))
      .toEqual({ window_start: '09:00', window_end: '11:00' });
    expect(assertAdminAppointmentWindow({ windowStart: '16:00' }))
      .toEqual({ window_start: '16:00', window_end: '17:00' });
  });

  test('the office default end is the one-hour promise in capacity mode too (owner 2026-10-30)', () => {
    // Capacity mode used to write 30 here (the 2026-10-05 failure); only the PLAN uses minutes.
    const open = { windowStart: '10:00' };
    try {
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      expect(assertAdminAppointmentWindow(open)).toEqual({ window_start: '10:00', window_end: '11:00' });
      // A typed duration is unchanged in capacity mode.
      expect(assertAdminAppointmentWindow({ ...open, durationMinutes: 45 })).toEqual({ window_start: '10:00', window_end: '10:45' });
      delete process.env.GATE_SCHEDULING_CAPACITY;
      expect(assertAdminAppointmentWindow(open)).toEqual({ window_start: '10:00', window_end: '11:00' });
    } finally { delete process.env.GATE_SCHEDULING_CAPACITY; }
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

  test('early on-the-hour starts are accepted — the former "no client appointments before 08:00" floor is gone', () => {
    expect(assertAdminAppointmentWindow({ windowStart: '07:00', windowEnd: '08:00' }))
      .toEqual({ window_start: '07:00', window_end: '08:00' });
    expect(assertAdminAppointmentWindow({ windowStart: '06:00' }))
      .toEqual({ window_start: '06:00', window_end: '07:00' });
    expect(assertAdminAppointmentWindow({ windowStart: '00:00' }))
      .toEqual({ window_start: '00:00', window_end: '01:00' });
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

describe('probeSlotOverlap (unconditional advisory probe)', () => {
  test('a missing window or trx resolves empty without locking', async () => {
    const trx = jest.fn();
    trx.raw = jest.fn();
    await expect(probeSlotOverlap({ trx, date: '2099-01-15', windowStart: '09:00' }))
      .resolves.toEqual([]);
    await expect(probeSlotOverlap({ date: '2099-01-15', windowStart: '09:00', windowEnd: '10:00' }))
      .resolves.toEqual([]);
    expect(trx).not.toHaveBeenCalled();
    expect(trx.raw).not.toHaveBeenCalled();
  });

  test('a clash is RETURNED (advisory — never thrown), mapped without customer data', async () => {
    const row = {
      id: 'svc-other', customer_id: 'cust-9', scheduled_date: '2099-01-15',
      window_start: '09:30:00', window_end: '10:30:00', status: 'confirmed',
      technician_id: null, service_type: 'Pest Control',
    };
    const chain = {
      where: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([row]),
    };
    const trx = jest.fn(() => chain);
    trx.raw = jest.fn().mockResolvedValue({});
    const conflicts = await probeSlotOverlap({ trx, date: '2099-01-15', windowStart: '09:00', windowEnd: '10:00' });
    expect(conflicts).toEqual([{
      id: 'svc-other', scheduled_date: '2099-01-15', window_start: '09:30:00',
      window_end: '10:30:00', status: 'confirmed', technician_id: null, service_type: 'Pest Control',
    }]);
    // customer_id never crosses the advisory boundary.
    expect(conflicts[0]).not.toHaveProperty('customer_id');
    // Rung 1 was still taken before the probe.
    expect(trx.raw.mock.calls.some(([sql, b]) => /pg_advisory_xact_lock/.test(sql) && b?.includes('occupancy:2099-01-15'))).toBe(true);
  });

  describe('technicianId (the technician the saved row carries)', () => {
    const { findConflictingVisits } = require('../services/scheduling/occupancy');
    const cleanTrx = () => {
      const chain = {
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        whereRaw: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([]),
      };
      const trx = jest.fn(() => chain);
      trx.raw = jest.fn().mockResolvedValue({});
      return trx;
    };
    beforeEach(() => findConflictingVisits.mockClear());

    test('reaches findConflictingVisits', async () => {
      await probeSlotOverlap({ trx: cleanTrx(), date: '2099-01-15', windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech-1' });
      expect(findConflictingVisits).toHaveBeenCalledTimes(1);
      expect(findConflictingVisits.mock.calls[0][0]).toMatchObject({ technicianId: 'tech-1', date: '2099-01-15' });
    });

    test('omitted, null or empty is NOT passed (the probe is called exactly as before)', async () => {
      for (const extra of [{}, { technicianId: null }, { technicianId: '' }]) {
        findConflictingVisits.mockClear();
        await probeSlotOverlap({ trx: cleanTrx(), date: '2099-01-15', windowStart: '09:00', windowEnd: '10:00', ...extra });
        expect(findConflictingVisits.mock.calls[0][0]).not.toHaveProperty('technicianId');
      }
    });

    test('the lock, statuses and return shape do not change with a technician', async () => {
      const trx = cleanTrx();
      await expect(probeSlotOverlap({ trx, date: '2099-01-15T08:00', windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech-1', excludeServiceIds: ['x'] }))
        .resolves.toEqual([]);
      expect(trx.raw.mock.calls.some(([sql, b]) => /pg_advisory_xact_lock/.test(sql) && b?.includes('occupancy:2099-01-15'))).toBe(true);
      expect(findConflictingVisits.mock.calls[0][0]).toMatchObject({
        excludeServiceIds: ['x'], excludeStatuses: ['cancelled', 'completed', 'skipped', 'no_show'],
      });
    });
  });

  test('slotOverlapWarning names the date (date-only, no customer data)', () => {
    expect(slotOverlapWarning('2099-01-15T10:00')).toMatch(/on 2099-01-15/);
    expect(slotOverlapWarning(null)).toMatch(/overlaps another appointment/);
  });
});

describe('acquireAdminSlotLocks (rung 1 for multi-date writers)', () => {
  const { acquireAdminSlotLocks } = require('../services/scheduling/window-rules');

  test('every date locked once, in ascending order (occupancy.js acquireOccupancyLocks), set returned', async () => {
    const trx = jest.fn();
    trx.raw = jest.fn().mockResolvedValue({});
    const locked = await acquireAdminSlotLocks({
      trx, dates: ['2099-03-01', '2099-01-15T10:00', '2099-02-01', '2099-01-15', null],
    });
    expect([...locked]).toEqual(['2099-03-01', '2099-01-15', '2099-02-01']);
    expect(trx.raw.mock.calls.map(([, b]) => b[1])).toEqual([
      'occupancy:2099-01-15', 'occupancy:2099-02-01', 'occupancy:2099-03-01',
    ]);
  });

  test('no trx: nothing locked, empty set', async () => {
    expect((await acquireAdminSlotLocks({ dates: ['2099-01-15'] })).size).toBe(0);
  });
});
