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
// The real rain rank, watched: which builds skip it (the paidLookups test below).
jest.mock('../services/scheduling/customer-rain-rank', () => {
  const actual = jest.requireActual('../services/scheduling/customer-rain-rank');
  return { ...actual, startCustomerRainRank: jest.fn(actual.startCustomerRainRank) };
});

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

// The hourly route check's slot-rule decision (day-replan/route-check.js) reads /book's offer at a
// zone center through availabilityForPin with three options no other caller sends:
// paidLookups: false buys nothing (no road lookup, find-time travelAllowance; no forecast, whose
// backup is the paid Open-Meteo key); crew offers each date only from the technicians who work it;
// through searches to the last date it decides on. Every other caller sends none: as before.
describe("availabilityForPin — the hourly route check's read-only ask", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]).first = jest.fn(async () => CONFIG); // loadBookingConfig's row
    listOccupiedWindows.mockResolvedValue([]);
    findAvailableSlots.mockResolvedValue({ slots: [], total_feasible: 0 });
  });

  test('paidLookups: false: no road lookup and no forecast read; an omitted value keeps both', async () => {
    const { availabilityForPin } = require('../routes/booking')._internals;
    const { startCustomerRainRank } = require('../services/scheduling/customer-rain-rank');
    const gates = require('../config/feature-gates');
    const realIsEnabled = gates.isEnabled;
    const chips = jest.spyOn(gates, 'isEnabled').mockImplementation((gate) => gate === 'bookingRainChips' || realIsEnabled(gate));
    const outlook = jest.spyOn(require('../services/weather-forecast'), 'getDailyRainOutlookBounded').mockResolvedValue(null);
    try {
      const pin = { lat: 27.4, lng: -82.4, serviceKey: 'pest_control' };
      await expect(availabilityForPin({ ...pin, paidLookups: false })).resolves.toMatchObject({ days: [] });
      expect(findAvailableSlots).toHaveBeenCalledTimes(1);
      expect(findAvailableSlots.mock.calls[0][0]).toMatchObject({ providerTravel: false, customerFacing: true });
      expect(outlook).not.toHaveBeenCalled();
      expect(startCustomerRainRank.mock.calls[0][0].skip).toBe(true);
      jest.clearAllMocks();
      await availabilityForPin(pin);
      expect(findAvailableSlots.mock.calls[0][0].providerTravel).toBeUndefined();
      expect(outlook).toHaveBeenCalledTimes(1);
      expect(startCustomerRainRank.mock.calls[0][0].skip).toBe(false);
    } finally {
      chips.mockRestore();
      outlook.mockRestore();
    }
  });

  // Two technicians share a start; /book keeps one claim per date and start (the better rank).
  const sharedStart = (techId, rank) => ({
    date: D, start_time: '09:00', end_time: null, technician: { id: techId }, detour_minutes: 3,
    stops_that_day: 2, rank, score: 100 - rank, insertion: { after_stop_id: 'stop-1' },
  });
  const offeredAt9 = (result) => result.days.flatMap((d) => d.slots).filter((s) => s.start_time === '09:00').map((s) => s.technician_id);

  test('crew: a technician outside the date\'s crew is dropped before the one-per-start pick', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [sharedStart('tech-1', 1), sharedStart('tech-2', 2)], total_feasible: 2 });
    // No crew: the better-ranked technician keeps the start, as before.
    expect(offeredAt9(await build())).toEqual(['tech-1']);
    // tech-1 does not work D: the start is tech-2's, not lost.
    expect(offeredAt9(await build('', { crew: new Map([[D, new Set(['tech-2'])]]) }))).toEqual(['tech-2']);
    // Nobody works D: nothing is offered there.
    expect(offeredAt9(await build('', { crew: new Map([[D, new Set()]]) }))).toEqual([]);
    // An unknown crew (null) or a date the map leaves out keeps every technician.
    expect(offeredAt9(await build('', { crew: new Map([[D, null]]) }))).toEqual(['tech-1']);
    expect(offeredAt9(await build('', { crew: new Map([[dayOffset(11), new Set(['tech-2'])]]) }))).toEqual(['tech-1']);
    // The pin finder (the route check's ask) hands its crew to the same pick.
    const { availabilityForPin } = require('../routes/booking')._internals;
    const pin = { lat: 27.4, lng: -82.4, serviceKey: 'pest_control', paidLookups: false };
    expect(offeredAt9(await availabilityForPin(pin))).toEqual(['tech-1']);
    expect(offeredAt9(await availabilityForPin({ ...pin, crew: new Map([[D, new Set(['tech-2'])]]) }))).toEqual(['tech-2']);
  });

  test('through: the search reaches that date when it is past the default window, never past the 90-day horizon', async () => {
    const { availabilityForPin } = require('../routes/booking')._internals;
    const pin = { lat: 27.4, lng: -82.4, serviceKey: 'pest_control', paidLookups: false };
    const searchedTo = async (extra) => {
      findAvailableSlots.mockClear();
      await availabilityForPin({ ...pin, ...extra });
      return findAvailableSlots.mock.calls[0][0].dateTo;
    };
    expect(await searchedTo({})).toBe(dayOffset(14)); // advance_days_max
    expect(await searchedTo({ through: dayOffset(3) })).toBe(dayOffset(14)); // never narrower than /book's own
    expect(await searchedTo({ through: dayOffset(20) })).toBe(dayOffset(20));
    expect(await searchedTo({ through: dayOffset(120) })).toBe(dayOffset(90));
  });

  test("now: the offer is built for the caller's clock (its window and its notice); unset = the wall clock", async () => {
    const { availabilityForPin } = require('../routes/booking')._internals;
    const pin = { lat: 27.4, lng: -82.4, serviceKey: 'pest_control', paidLookups: false };
    const saved = process.env.SELF_SERVE_NOTICE_HOURS;
    process.env.SELF_SERVE_NOTICE_HOURS = '24';
    findAvailableSlots.mockResolvedValue({ slots: [sharedStart('tech-1', 1)], total_feasible: 1 });
    try {
      // The wall clock: D is 10 days out, inside the window and past the 24-hour notice, so its 9:00 AM is offered.
      expect(offeredAt9(await availabilityForPin(pin))).toEqual(['tech-1']);
      expect(findAvailableSlots.mock.calls[0][0]).toMatchObject({ dateFrom: dayOffset(1), dateTo: dayOffset(14) });
      // A clock at noon the day before D: the window opens on D, and D's 9:00 AM is inside the notice.
      findAvailableSlots.mockClear();
      const noonBeforeD = parseETDateTime(`${dayOffset(9)}T12:00`);
      expect(offeredAt9(await availabilityForPin({ ...pin, now: noonBeforeD }))).toEqual([]);
      expect(findAvailableSlots.mock.calls[0][0]).toMatchObject({ dateFrom: D, dateTo: dayOffset(23) });
    } finally {
      if (saved === undefined) delete process.env.SELF_SERVE_NOTICE_HOURS;
      else process.env.SELF_SERVE_NOTICE_HOURS = saved;
    }
  });

  test("surface: the customer route check labels the ask with the caller's surface; 'book' by default, none for a staff pick", async () => {
    const { availabilityForPin } = require('../routes/booking')._internals;
    const routeCheck = require('../services/scheduling/customer-route-check');
    const mode = jest.spyOn(routeCheck, 'customerRouteCheckMode').mockReturnValue('shadow');
    const filter = jest.spyOn(routeCheck, 'filterOfferedSlots').mockImplementation(async ({ slots }) => ({ slots, report: {} }));
    const labels = () => filter.mock.calls.map(([args]) => args.surface);
    try {
      const pin = { lat: 27.4, lng: -82.4, serviceKey: 'pest_control', paidLookups: false };
      await availabilityForPin({ ...pin, surface: 'route_check' });
      expect(labels()).toEqual(['route_check']);
      filter.mockClear();
      await availabilityForPin(pin);
      expect(labels()).toEqual(['book']);
      filter.mockClear();
      await availabilityForPin({ ...pin, internal: true, surface: 'route_check' });
      expect(filter).not.toHaveBeenCalled();
    } finally {
      mode.mockRestore();
      filter.mockRestore();
    }
  });

  test('verifiedOnly: a failed occupancy read is no answer; every other caller still serves the unfiltered list', async () => {
    const { availabilityForPin } = require('../routes/booking')._internals;
    const pin = { lat: 27.4, lng: -82.4, serviceKey: 'pest_control', paidLookups: false };
    findAvailableSlots.mockResolvedValue({ slots: [sharedStart('tech-1', 1)], total_feasible: 1 });
    listOccupiedWindows.mockRejectedValue(new Error('pool exhausted'));
    await expect(availabilityForPin({ ...pin, verifiedOnly: true })).rejects.toThrow('occupancy mirror unread: pool exhausted');
    // The customer's fallback is unchanged: the commit gate still owns correctness.
    expect(offeredAt9(await availabilityForPin(pin))).toEqual(['tech-1']);
  });

  test('verifiedOnly: a route check that kept a slot unchecked is no answer; a customer keeps its list as before', async () => {
    const { availabilityForPin } = require('../routes/booking')._internals;
    const routeCheck = require('../services/scheduling/customer-route-check');
    const mode = jest.spyOn(routeCheck, 'customerRouteCheckMode').mockReturnValue('on');
    let report = {};
    const filter = jest.spyOn(routeCheck, 'filterOfferedSlots').mockImplementation(async ({ slots }) => ({ slots, report: { mode: 'on', ...report } }));
    findAvailableSlots.mockResolvedValue({ slots: [sharedStart('tech-1', 1)], total_feasible: 1 });
    const pin = { lat: 27.4, lng: -82.4, serviceKey: 'pest_control', paidLookups: false, surface: 'route_check' };
    try {
      // A finished check stands. The verified ask waits up to 15 seconds; a customer's keeps the 1.5-second default.
      expect(offeredAt9(await availabilityForPin({ ...pin, verifiedOnly: true }))).toEqual(['tech-1']);
      expect(filter.mock.calls[0][0]).toMatchObject({ budgetMs: 15000, floor: true, verifiedOnly: true });
      filter.mockClear();
      expect(offeredAt9(await availabilityForPin(pin))).toEqual(['tech-1']);
      expect(filter.mock.calls[0][0]).not.toHaveProperty('budgetMs');
      for (const [kept, reason] of [[{ timedOut: true }, 'timed_out'], [{ errors: 2 }, 'errors=2'], [{ floorKept: true }, 'floor_kept']]) {
        report = kept;
        await expect(availabilityForPin({ ...pin, verifiedOnly: true })).rejects.toThrow(`route check: ${reason}`);
        expect(offeredAt9(await availabilityForPin(pin))).toEqual(['tech-1']);
      }
      report = {};
      // A check that throws, or a check that cannot start: no answer for the verified ask; a customer gets the list.
      filter.mockRejectedValueOnce(new Error('router down'));
      await expect(availabilityForPin({ ...pin, verifiedOnly: true })).rejects.toThrow('route check failed: router down');
      filter.mockRejectedValueOnce(new Error('router down'));
      expect(offeredAt9(await availabilityForPin(pin))).toEqual(['tech-1']);
      mode.mockImplementation(() => { throw new Error('gates unreadable'); });
      await expect(availabilityForPin({ ...pin, verifiedOnly: true })).rejects.toThrow('route check unavailable: gates unreadable');
      expect(offeredAt9(await availabilityForPin(pin))).toEqual(['tech-1']);
    } finally {
      mode.mockRestore();
      filter.mockRestore();
    }
  });

  test("crew: the route check keeps no floor over the crew's slots, so a start /book removes stays removed", async () => {
    // Pre-push audit r5 / Codex r1 on #8068. Friday's only start would make a customer late. An idle technician's
    // Sunday start (no stop that day, so not in Sunday's crew) is fine. /book removes Friday and shows Sunday.
    const { availabilityForPin } = require('../routes/booking')._internals;
    const routeCheck = require('../services/scheduling/customer-route-check');
    const arrivalRoute = require('../services/scheduling/arrival-route');
    const FRI = dayOffset(2);
    const SUN = dayOffset(3);
    const startOn = (date, techId) => ({ ...sharedStart(techId, 1), date });
    const spies = [
      jest.spyOn(routeCheck, 'customerRouteCheckMode').mockReturnValue('on'),
      jest.spyOn(arrivalRoute, 'arrivalWindowRoutingEnabled').mockReturnValue(true),
      jest.spyOn(arrivalRoute, 'loadArrivalRouteContext').mockImplementation(async ({ date }) => ({ date, rows: [] })),
      jest.spyOn(arrivalRoute, 'evaluateArrivalPlacement').mockImplementation((context) => (context.date === FRI
        ? { feasible: false, reason: 'arrival_window', lateness: { newlyLateStopIds: ['visit-9'], baselineLateStopIds: [] } }
        : { feasible: true })),
    ];
    const offered = (result) => result.days.flatMap((d) => d.slots.map((s) => `${d.date} ${s.start_time} ${s.technician_id}`));
    const pin = { lat: 27.4, lng: -82.4, serviceKey: 'pest_control', paidLookups: false, surface: 'route_check' };
    const crew = new Map([[FRI, new Set(['tech-1'])], [SUN, new Set()]]);
    findAvailableSlots.mockResolvedValue({ slots: [startOn(FRI, 'tech-1'), startOn(SUN, 'tech-2')], total_feasible: 2 });
    try {
      expect(offered(await availabilityForPin(pin))).toEqual([`${SUN} 09:00 tech-2`]);
      // The crew's ask: Sunday is nobody's, and Friday stays removed (a floor over Friday alone would bring it back).
      expect(offered(await availabilityForPin({ ...pin, crew, verifiedOnly: true }))).toEqual([]);
      // /book's own pool, verified: Sunday survives, so its check keeps no whole week, and the answer stands.
      expect(offered(await availabilityForPin({ ...pin, verifiedOnly: true }))).toEqual([`${SUN} 09:00 tech-2`]);
      // With no Sunday at all, /book's floor keeps Friday for the customer, and the verified ask has no answer.
      findAvailableSlots.mockResolvedValue({ slots: [startOn(FRI, 'tech-1')], total_feasible: 1 });
      expect(offered(await availabilityForPin(pin))).toEqual([`${FRI} 09:00 tech-1`]);
      await expect(availabilityForPin({ ...pin, verifiedOnly: true })).rejects.toThrow('route check: floor_kept');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
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
