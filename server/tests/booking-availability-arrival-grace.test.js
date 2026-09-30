/**
 * GATE_BOOK_ARRIVAL_GRACE (owner-approved 2026-09-29), OFFER side of
 * buildBookingAvailability (the shared /book availability builder):
 *   - a build opts in with `bookArrivalGrace: true` (only the redeemable /book
 *     surfaces do) and it only takes effect with mid-route insertion
 *     (capacityPlacement) and the gate live;
 *   - the travel-gap mirror then waives ONLY the previous assigned committed
 *     stop's buffer, within grace (book-arrival-grace.js — the rule the commit
 *     probe applies, see booking-confirm-signed-offer.test.js);
 *   - a slot delayed past the grace is not offered;
 *   - every slot_sig carries the grace policy tag, plus the exact grace
 *     (`<exp>.<grace>.<sig>`) when the slot was offered under one.
 * find-time itself is mocked here (its both-neighbour pick is covered by
 * book-arrival-grace-parity.test.js); listOccupiedWindows feeds the mirror.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { buildBookingAvailability, bookingOfferLocationKey } = require('../routes/booking')._internals;
const {
  verifySlotOfferField, slotOfferFieldGrace, BOOK_INSERTION_OFFER_POLICY, BOOK_ARRIVAL_GRACE_OFFER_POLICY,
} = require('../utils/slot-offer-token');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const D = dayOffset(10);
const LAT = 27.4;
const LNG = -82.4;
const TECH = 'tech-1';

const CONFIG = {
  advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60,
  day_start: '08:00', day_end: '18:00', max_self_books_per_day: 3,
};

function wireDayCapCounts(rows = []) {
  const builder = {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
  return builder;
}

// listOccupiedWindows row shape (loadPackingAnchors reads it): co-located
// with the customer so the modeled drive is 0 and the 15-minute buffer alone
// decides.
const occupied = (id, startMin, endMin, extra = {}) => ({
  id, technician_id: TECH, customer_id: `cust-${id}`, date: D, startMin, endMin,
  windowMinutes: endMin - startMin, expectedMinutes: endMin - startMin, lat: LAT, lng: LNG, hold: false, ...extra,
});
const PREV = () => occupied('prev', 9 * 60, 10 * 60); // 09:00-10:00 — a 10:00 candidate touches it

const slot = (startTime, extra = {}) => ({
  date: D, start_time: startTime, end_time: null, technician: { id: TECH }, detour_minutes: 3,
  stops_that_day: 2, rank: 1, score: 10, insertion: { after_stop_id: 'prev' },
  route_mode: 'arrival_windows', arrival_delay_minutes: 12, latest_start_min: 10 * 60, ...extra,
});

const ENV = ['GATE_SCHEDULING_CAPACITY', 'GATE_BOOK_CAPACITY_COMMIT', 'GATE_BOOK_ARRIVAL_GRACE', 'GATE_SLOT_TRAVEL_GAP', 'SELF_SERVE_ARRIVAL_GRACE_MINUTES'];
const saved = {};
beforeAll(() => { for (const k of ENV) saved[k] = process.env[k]; });
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV) delete process.env[k];
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
  process.env.GATE_BOOK_ARRIVAL_GRACE = 'true';
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '120';
  wireDayCapCounts([]);
  listOccupiedWindows.mockResolvedValue([PREV()]);
  findAvailableSlots.mockResolvedValue({ slots: [slot('10:00')], total_feasible: 1 });
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const build = (extra = {}) => buildBookingAvailability({
  lat: LAT, lng: LNG, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date(),
  serviceKey: '', capacityPlacement: true, bookArrivalGrace: true, ...extra,
});
const offered = (availability) => (availability.days[0]?.slots || []).map((s) => s.start_time);
const sigOf = (availability) => availability.days[0].slots[0].slot_sig;
const OFFER = {
  surface: 'booking', scopeId: '', serviceKey: '', locationKey: bookingOfferLocationKey(LAT, LNG),
  date: D, startMinutes: 10 * 60, technicianId: TECH, durationMinutes: 60,
};

describe('buildBookingAvailability — the travel-gap mirror under grace', () => {
  test('GATE ON: a slot touching the previous assigned committed stop is offered (the strict mirror dropped it), signed under the grace policy with the exact grace', async () => {
    const availability = await build();
    expect(offered(availability)).toEqual(['10:00']);
    const sig = sigOf(availability);
    expect(slotOfferFieldGrace(sig)).toBe(120);
    expect(sig.split('.')).toHaveLength(3);
    expect(verifySlotOfferField({ ...OFFER, policy: BOOK_ARRIVAL_GRACE_OFFER_POLICY }, sig)).toBe(true);
    expect(verifySlotOfferField({ ...OFFER, policy: BOOK_INSERTION_OFFER_POLICY }, sig)).toBe(false);
    expect(verifySlotOfferField(OFFER, sig)).toBe(false);
  });

  test('find-time is told to pack under the /book rule only for a graced build', async () => {
    await build();
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bookArrivalGrace: true, packEnds: true, capacityPlacement: true }));
    await build({ bookArrivalGrace: undefined });
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bookArrivalGrace: false }));
  });

  test('GATE OFF: the same slot is dropped by the strict mirror and signed under the insertion policy with NO grace segment — byte-identical to before', async () => {
    delete process.env.GATE_BOOK_ARRIVAL_GRACE;
    const availability = await build();
    expect(offered(availability)).toEqual([]);
    // an unbuffered slot (prev far earlier) shows the policy + wire shape
    listOccupiedWindows.mockResolvedValue([occupied('prev', 7 * 60, 8 * 60)]);
    const clear = await build();
    const sig = sigOf(clear);
    expect(sig.split('.')).toHaveLength(2);
    expect(verifySlotOfferField({ ...OFFER, policy: BOOK_INSERTION_OFFER_POLICY }, sig)).toBe(true);
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bookArrivalGrace: false }));
  });

  test('a caller that never opts in (voice, public reschedule) is strict and insertion-tagged even with the gate live', async () => {
    const availability = await build({ bookArrivalGrace: undefined });
    expect(offered(availability)).toEqual([]);
  });

  test('capacityPlacement off (append-only build) never grants grace, gate or not', async () => {
    const availability = await build({ capacityPlacement: false });
    expect(offered(availability)).toEqual([]);
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bookArrivalGrace: false }));
  });

  test('grace env 0: strict (dropped) — but the offer carries the grace POLICY tag with no grace segment', async () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '0';
    expect(offered(await build())).toEqual([]);
    listOccupiedWindows.mockResolvedValue([occupied('prev', 7 * 60, 8 * 60)]);
    const sig = sigOf(await build());
    expect(sig.split('.')).toHaveLength(2);
    expect(slotOfferFieldGrace(sig)).toBe(0);
    expect(verifySlotOfferField({ ...OFFER, policy: BOOK_ARRIVAL_GRACE_OFFER_POLICY }, sig)).toBe(true);
  });

  test('a delay past the grace is never offered — even where nothing crowds a neighbour (the commit enforces the same bound)', async () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '30';
    listOccupiedWindows.mockResolvedValue([occupied('prev', 7 * 60, 8 * 60)]);
    findAvailableSlots.mockResolvedValue({ slots: [slot('10:00', { arrival_delay_minutes: 45 })], total_feasible: 1 });
    expect(offered(await build())).toEqual([]);
    findAvailableSlots.mockResolvedValue({ slots: [slot('10:00', { arrival_delay_minutes: 25 })], total_feasible: 1 });
    const availability = await build();
    expect(offered(availability)).toEqual(['10:00']);
    expect(slotOfferFieldGrace(sigOf(availability))).toBe(30);
  });

  test.each([
    ['a stop that STARTS as this one ends (next side)', [PREV(), occupied('next', 11 * 60, 12 * 60)]],
    ['an unassigned previous stop', [occupied('prev', 9 * 60, 10 * 60, { technician_id: null })]],
    ['a live hold as the previous stop', [occupied('prev', 9 * 60, 10 * 60, { hold: true, customer_id: null })]],
    ['a raw window overlap', [occupied('prev', 9 * 60 + 30, 10 * 60 + 30)]],
  ])('never waived: %s', async (_label, rows) => {
    listOccupiedWindows.mockResolvedValue(rows);
    expect(offered(await build())).toEqual([]);
  });

  test('another technician\'s stop is not on this route: it neither blocks nor waives (existing tech-scoped mirror)', async () => {
    listOccupiedWindows.mockResolvedValue([occupied('prev', 9 * 60, 10 * 60, { technician_id: 'other-tech' })]);
    expect(offered(await build())).toEqual(['10:00']);
  });
});
