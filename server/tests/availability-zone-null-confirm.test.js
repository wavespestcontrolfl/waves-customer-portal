/**
 * confirmBooking shared occupancy probe (schedule-conflict lane): the
 * whole occupied-set re-check was wrapped in `if (zone)` — when the
 * customer's city resolved to NO service zone (AI-assistant book tool,
 * onboarding reschedule), NOTHING validated the window and the booking
 * landed blind. The zone-null branch runs the shared tech-blind occupancy
 * check as its ONLY gate; round 3 extended the SAME probe to the
 * zone-RESOLVED branch as a backstop behind its zone-scoped fast path —
 * that fast path never selects an overlapping visit whose customer city is
 * outside the zone list (or a tech-assigned estimate-lane row), and the
 * date lock alone only serializes writers, it cannot widen what the check
 * sees. Zone fast-path behavior and error shapes are unchanged.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  isBlackoutDate: jest.fn().mockResolvedValue(false),
  getBlackoutDates: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  // Real lock helper (it only issues a trx.raw advisory-lock statement the
  // suite asserts on); only the probe itself is stubbed.
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
}));

const db = require('../models/db');
const Availability = require('../services/availability');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { parseETDateTime, addETDays, etDateString, etParts } = require('../utils/datetime-et');

// Future non-Sunday target (confirmBooking rejects Sundays outright).
const futureWeekday = () => {
  for (let n = 10; n < 20; n += 1) {
    const d = etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
    if (etParts(parseETDateTime(`${d}T12:00`)).dayOfWeek !== 0) return d;
  }
  throw new Error('unreachable');
};
const DATE = futureWeekday();

// Every advisory lock a transaction took, as [namespace, key], in acquisition
// order — the ORDERING CONTRACT is about order, so the assertions below read
// this list positionally.
const advisoryLocks = (trx) => trx.raw.mock.calls
  .filter((c) => String(c[0]).includes('pg_advisory_xact_lock') && Array.isArray(c[1]))
  .map((c) => c[1]);
const lockKeys = (trx) => advisoryLocks(trx).map(([, key]) => key);

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    }),
    whereNot: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    modify: jest.fn(function modify(fn) { fn(builder); return builder; }),
    select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'row-1' }]),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  });
  return Object.assign(builder, overrides);
}

function wireConfirm({ zones = [], replacedRow = undefined } = {}) {
  const customerLookup = chain({
    first: jest.fn().mockResolvedValue({
      id: 'cust-1', first_name: 'Pat', last_name: 'Lee', city: 'Offgridville',
    }),
  });
  const zonesQuery = chain({
    then: (resolve, reject) => Promise.resolve(zones).then(resolve, reject),
  });
  const configLookup = chain({ first: jest.fn().mockResolvedValue(undefined) });

  db.mockImplementation((table) => {
    if (table === 'customers') return customerLookup;
    if (table === 'service_zones') return zonesQuery;
    if (table === 'booking_config') return configLookup;
    throw new Error(`Unexpected db table ${table}`);
  });

  const dayCapCount = chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
  const selfBookInsert = chain({
    returning: jest.fn().mockResolvedValue([{ id: 'booking-1' }]),
  });
  const scheduledQueries = [];
  const trx = jest.fn((table) => {
    if (table === 'self_booked_appointments') {
      // First call = day-cap count, later call = insert. Both chains
      // support either usage; return count first.
      return trx.selfBookCalls++ === 0 ? dayCapCount : selfBookInsert;
    }
    if (table === 'scheduled_services') {
      const q = chain({
        first: jest.fn().mockResolvedValue(replacedRow),
        returning: jest.fn().mockResolvedValue([{ id: 'sched-1' }]),
      });
      scheduledQueries.push(q);
      return q;
    }
    if (table === 'customers') return customerLookup;
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.selfBookCalls = 0;
  trx.raw = jest.fn().mockResolvedValue(undefined);
  db.transaction = jest.fn(async (callback) => callback(trx));

  return { trx, scheduledQueries };
}

describe('confirmBooking — zone-null occupancy fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findConflictingVisits.mockResolvedValue([]);
  });

  test('no zone + overlapping row → SLOT_TAKEN, nothing inserted', async () => {
    const { scheduledQueries } = wireConfirm({ zones: [] });
    findConflictingVisits.mockResolvedValue([{ id: 'svc-9' }]);

    await expect(
      Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null),
    ).rejects.toMatchObject({ code: 'SLOT_TAKEN', statusCode: 409 });
    // No scheduled_services insert happened.
    expect(scheduledQueries.every((q) => !q.insert.mock.calls.length)).toBe(true);
  });

  test('no zone + clean occupancy → books, with the shared-module call shape', async () => {
    const { trx } = wireConfirm({ zones: [] });

    const result = await Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null);
    expect(result.confirmationCode).toBeTruthy();
    expect(findConflictingVisits).toHaveBeenCalledWith({
      db: trx,
      date: DATE,
      windowStart: '09:00',
      windowEnd: '10:00',
      excludeServiceIds: [],
    });

    // The zone-null confirm WRITES behind the tech-blind gate, so it takes
    // the same date-wide occupancy lock the rebooker writers use — without
    // it, this confirm and a rebooker move on the same date both pass their
    // checks under READ COMMITTED and double-book.
    expect(trx.raw).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['slot-reserve', `occupancy:${DATE}`],
    );
    // ...and holds it BEFORE the probe runs.
    const occupancyLockIdx = trx.raw.mock.calls.findIndex(
      (c) => Array.isArray(c[1]) && c[1][1] === `occupancy:${DATE}`,
    );
    expect(trx.raw.mock.invocationCallOrder[occupancyLockIdx])
      .toBeLessThan(findConflictingVisits.mock.invocationCallOrder[0]);
  });

  test('onboarding-reschedule exclusions thread through (service row + replaced self-booking row)', async () => {
    const { trx } = wireConfirm({ zones: [], replacedRow: { id: 'sched-old' } });

    await Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null, {
      excludeServiceId: 'svc-moving',
      excludeSelfBookingId: 'booking-old',
    });
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      db: trx,
      excludeServiceIds: ['svc-moving', 'sched-old'],
    }));
  });

  test('zone resolved → zone fast path still runs, AND the shared probe backstops it under the date lock', async () => {
    const { trx, scheduledQueries } = wireConfirm({
      zones: [{ id: 'zone-1', zone_name: 'Sarasota / South', cities: ['Offgridville'] }],
    });

    const result = await Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null);
    expect(result.confirmationCode).toBeTruthy();
    // The zone-scoped occupied-set fast path still owns this branch's error
    // shapes — its scheduled_services zone query ran (city-scoped join)...
    expect(scheduledQueries.some((q) => q.whereIn.mock.calls
      .some((c) => c[0] === 'customers.city'))).toBe(true);
    // ...but the branch no longer commits on it ALONE: the shared tech-blind
    // probe runs as the backstop. The zone set never selects an overlapping
    // visit whose customer city is outside the zone list, and rung 1 only
    // serializes writers — it cannot widen what the check sees.
    expect(findConflictingVisits).toHaveBeenCalledWith({
      db: trx,
      date: DATE,
      windowStart: '09:00',
      windowEnd: '10:00',
      excludeServiceIds: [],
    });
    // The date-wide lock is unconditional (ORDERING CONTRACT rung 1) and is
    // granted BEFORE the probe reads.
    expect(lockKeys(trx)).toContain(`occupancy:${DATE}`);
    const occupancyLockIdx = trx.raw.mock.calls.findIndex(
      (c) => Array.isArray(c[1]) && c[1][1] === `occupancy:${DATE}`,
    );
    expect(trx.raw.mock.invocationCallOrder[occupancyLockIdx])
      .toBeLessThan(findConflictingVisits.mock.invocationCallOrder[0]);
  });

  test('zone resolved + clean zone set + GLOBAL overlap → SLOT_TAKEN, nothing inserted (the round-3 P1)', async () => {
    // A committed visit for a different tech / outside the zone's city list:
    // invisible to the zone fast path, real for the one field tech.
    const { scheduledQueries } = wireConfirm({
      zones: [{ id: 'zone-1', zone_name: 'Sarasota / South', cities: ['Offgridville'] }],
    });
    findConflictingVisits.mockResolvedValue([{ id: 'svc-other-zone' }]);

    await expect(
      Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null),
    ).rejects.toMatchObject({ code: 'SLOT_TAKEN', statusCode: 409 });
    expect(scheduledQueries.every((q) => !q.insert.mock.calls.length)).toBe(true);
  });

  test('zone resolved → the probe threads the onboarding-reschedule exclusions too', async () => {
    const { trx } = wireConfirm({
      zones: [{ id: 'zone-1', zone_name: 'Sarasota / South', cities: ['Offgridville'] }],
      replacedRow: { id: 'sched-old' },
    });

    await Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null, {
      excludeServiceId: 'svc-moving',
      excludeSelfBookingId: 'booking-old',
    });
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      db: trx,
      excludeServiceIds: ['svc-moving', 'sched-old'],
    }));
  });

  // ---- ORDERING CONTRACT (services/scheduling/occupancy.js) ---------------
  // Global order: date-occupancy -> self-booking-confirm -> tech -> zone ->
  // day-cap. confirmBooking uses rungs 1, 4 and 5. A writer that took them in
  // any other order could deadlock against createSelfBooking, which shares
  // all three.
  describe('lock ordering', () => {
    test.each([
      ['zone-null', []],
      ['zone-resolved', [{ id: 'zone-1', zone_name: 'Sarasota / South', cities: ['Offgridville'] }]],
    ])('%s confirm takes date-occupancy -> zone -> day-cap', async (_label, zones) => {
      const { trx } = wireConfirm({ zones });

      await Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null);

      const keys = lockKeys(trx);
      const occupancyIdx = keys.indexOf(`occupancy:${DATE}`);
      const zoneIdx = keys.indexOf(`zone:${zones[0]?.id || 'unknown'}:${DATE}`);
      const dayCapIdx = keys.indexOf(DATE);
      expect(occupancyIdx).toBeGreaterThanOrEqual(0);
      expect(zoneIdx).toBeGreaterThanOrEqual(0);
      expect(dayCapIdx).toBeGreaterThanOrEqual(0);
      // Rung 1 is FIRST — of every advisory lock this transaction takes, not
      // merely before the zone one.
      expect(occupancyIdx).toBe(0);
      expect(occupancyIdx).toBeLessThan(zoneIdx);
      expect(zoneIdx).toBeLessThan(dayCapIdx);
    });

    test('the day-cap lock rides the self-booking-day-cap namespace, the other two ride slot-reserve', async () => {
      const { trx } = wireConfirm({ zones: [] });
      await Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null);

      const locks = advisoryLocks(trx);
      expect(locks[0]).toEqual(['slot-reserve', `occupancy:${DATE}`]);
      expect(locks[1]).toEqual(['slot-reserve', `zone:unknown:${DATE}`]);
      expect(locks[2]).toEqual(['self-booking-day-cap', DATE]);
    });
  });
});
