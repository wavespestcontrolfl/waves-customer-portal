/**
 * confirmBooking zone-null occupancy fallback (schedule-conflict lane): the
 * whole occupied-set re-check was wrapped in `if (zone)` — when the
 * customer's city resolved to NO service zone (AI-assistant book tool,
 * onboarding reschedule), NOTHING validated the window and the booking
 * landed blind. The zone-null branch now runs the shared tech-blind
 * occupancy check; zone-resolved behavior is unchanged.
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

  test('zone resolved → zone path unchanged, fallback never runs', async () => {
    wireConfirm({
      zones: [{ id: 'zone-1', zone_name: 'Sarasota / South', cities: ['Offgridville'] }],
    });

    const result = await Availability.confirmBooking(null, 'cust-1', DATE, '09:00', null);
    expect(result.confirmationCode).toBeTruthy();
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });
});
