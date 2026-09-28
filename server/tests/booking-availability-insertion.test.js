/**
 * Codex round 1 on PR #5231 (owner 2026-09-28): buildBookingAvailability
 * (the shared /book availability builder) now takes a `capacityPlacement`
 * param and passes it straight through to findAvailableSlots, replacing the
 * earlier unconditional `insertProspective: true` — insertion offers must
 * only reach callers whose own commit persists the certified route order,
 * so buildBookingAvailability itself takes no default and leaves the
 * decision to each caller. Per-caller wiring (which callers pass
 * capacityPlacement: bookInsertionOffersLive() vs omit it — renamed from
 * bookCapacityCommitLive() in round 2, see booking-capacity-placement-wiring
 * .test.js) is covered in each route's own test file (booking-find-slots*,
 * reservice-public*, inspection-public*, reschedule-public*,
 * voice-relay-booking/tools). This file mirrors
 * booking-availability-gap-fanout.test.js's mocking style (find-time itself
 * mocked) and is purely about buildBookingAvailability's own pass-through,
 * plus (round 2, Codex P1) the signed policy tag its mint attaches when
 * capacityPlacement is true.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { buildBookingAvailability } = require('../routes/booking')._internals;
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const D = dayOffset(10);

const CONFIG = {
  advance_days_min: 1, advance_days_max: 14,
  slot_duration_minutes: 60,
  day_start: '08:00', day_end: '18:00',
  max_self_books_per_day: 3,
};

// db('self_booked_appointments') day-cap count query — thenable, no full days.
function wireDayCapCounts(rows = []) {
  const builder = {
    whereNot: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
  return builder;
}

async function build(serviceKey = '', extra = {}) {
  return buildBookingAvailability({
    lat: 27.4, lng: -82.4, duration: 60,
    rangeFrom: D, rangeTo: D,
    config: CONFIG, today: new Date(), serviceKey, ...extra,
  });
}

describe('buildBookingAvailability — capacityPlacement pass-through', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    listOccupiedWindows.mockResolvedValue([]);
    findAvailableSlots.mockResolvedValue({ slots: [], total_feasible: 0 });
  });

  test('capacityPlacement: true is passed straight through to findAvailableSlots, alongside packEnds: true', async () => {
    await build('', { capacityPlacement: true });
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ capacityPlacement: true, packEnds: true }));
  });

  test('capacityPlacement omitted by the caller reaches findAvailableSlots as undefined, never true — the append-only default', async () => {
    await build();
    const opts = findAvailableSlots.mock.calls[0][0];
    expect(opts.capacityPlacement).toBeUndefined();
    expect(opts.capacityPlacement).not.toBe(true);
  });

  test('capacityPlacement: false is passed through as false, not coerced to undefined or true', async () => {
    await build('', { capacityPlacement: false });
    const opts = findAvailableSlots.mock.calls[0][0];
    expect(opts.capacityPlacement).toBe(false);
  });
});

// Codex round 2 P1 on PR #5231: an offer minted while capacityPlacement is
// true must carry BOOK_INSERTION_OFFER_POLICY in its slot_sig HMAC, so a
// GATE_BOOK_CAPACITY_COMMIT/GATE_SCHEDULING_CAPACITY flip during the offer's
// 45-minute lifetime can't confirm it under the wrong policy. Real
// slot-offer-token (not mocked in this file) verifies the actual minted
// field end to end.
describe('buildBookingAvailability — mid-route insertion policy tag on the minted slot_sig', () => {
  const { verifySlotOfferField, BOOK_INSERTION_OFFER_POLICY } = require('../utils/slot-offer-token');
  const { bookingOfferLocationKey } = require('../routes/booking')._internals;
  const LAT = 27.4;
  const LNG = -82.4;
  const LOCATION_KEY = bookingOfferLocationKey(LAT, LNG);
  const OFFER_FIELDS = {
    surface: 'booking', scopeId: '', serviceKey: '', locationKey: LOCATION_KEY,
    date: D, startMinutes: 10 * 60, technicianId: 'tech-1', durationMinutes: 60,
  };

  function gapSlot(startTime, extra = {}) {
    return {
      date: D, start_time: startTime, end_time: null,
      technician: { id: 'tech-1' }, detour_minutes: 3, stops_that_day: 2,
      rank: 1, score: 10, insertion: { after_stop_id: 'stop-1' },
      ...extra,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    listOccupiedWindows.mockResolvedValue([]);
  });

  async function mintedSig(extra) {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('10:00', { latest_start_min: 12 * 60 })], total_feasible: 1,
    });
    const availability = await build('', { ...extra });
    return availability.days[0].slots[0].slot_sig;
  }

  test('capacityPlacement: true mints a slot_sig that verifies WITH the policy, and fails WITHOUT it', async () => {
    const sig = await mintedSig({ capacityPlacement: true });
    expect(verifySlotOfferField({ ...OFFER_FIELDS, policy: BOOK_INSERTION_OFFER_POLICY }, sig)).toBe(true);
    expect(verifySlotOfferField(OFFER_FIELDS, sig)).toBe(false);
  });

  test('capacityPlacement omitted mints a slot_sig that verifies WITHOUT the policy, and fails WITH it', async () => {
    const sig = await mintedSig({});
    expect(verifySlotOfferField(OFFER_FIELDS, sig)).toBe(true);
    expect(verifySlotOfferField({ ...OFFER_FIELDS, policy: BOOK_INSERTION_OFFER_POLICY }, sig)).toBe(false);
  });

  test('capacityPlacement: false mints the same as omitted — no policy', async () => {
    const sig = await mintedSig({ capacityPlacement: false });
    expect(verifySlotOfferField(OFFER_FIELDS, sig)).toBe(true);
  });
});
