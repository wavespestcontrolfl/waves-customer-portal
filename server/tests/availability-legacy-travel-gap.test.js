/**
 * AvailabilityEngine.getAvailableSlots — travel-gap mirror (GATE_SLOT_TRAVEL_GAP).
 *
 * confirmBooking's commit probe runs the tech-blind, coordinate-aware
 * findConflictingVisits `travel` predicate over every stop that day, while
 * this legacy builder's occupied set is zone-scoped and buffer-only. GH codex
 * #3803 r1 P1: an out-of-zone stop adjacent to a quoted slot made the commit
 * reject the exact option check_availability had just returned. Gate on, the
 * builder now reads every occupying row (guarded coords) once for the range
 * and drops what the commit would 409; gate off issues no extra statement.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  listOccupiedWindows: jest.fn(),
}));

const db = require('../models/db');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const engine = require('../services/availability');
const { etDateString, addETDays } = require('../utils/datetime-et');

const ZONE = { id: 'zone-a', zone_name: 'Palmetto', cities: ['Palmetto'] };
const CONFIG = {
  advance_days_min: 1,
  advance_days_max: 1,
  day_start: '08:00',
  day_end: '17:00',
  lunch_start: '12:00',
  lunch_end: '13:00',
  slot_duration_minutes: 60,
  buffer_minutes: 15,
  max_self_books_per_day: 3,
};
const DATE = etDateString(addETDays(new Date(), 1));
const PALMETTO = { latitude: 27.545, longitude: -82.545 };
const BRADENTON = { lat: 27.425, lng: -82.41 };

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function arrayChain(rowsArr) {
  let counting = false;
  const b = {
    where: () => b,
    whereNot: () => b,
    whereNotExists: () => { rowsArr = rowsArr.filter(row => !row.linkedVisit); return b; },
    whereIn: () => b,
    whereNotIn: () => b,
    whereNotNull: () => b,
    whereRaw: () => b,
    count: () => { counting = true; return b; },
    first: () => Promise.resolve(counting ? { count: 0 } : (rowsArr[0] || null)),
    modify(fn) { fn(b); return b; },
    leftJoin: () => b,
    select: () => b,
    then: (resolve, reject) => Promise.resolve(rowsArr).then(resolve, reject),
  };
  return b;
}

const tables = () => ({
  service_zones: () => Promise.resolve([ZONE]),
  booking_config: () => ({ first: () => Promise.resolve(CONFIG) }),
  tech_schedule_blocks: () => arrayChain([{ id: 'blk-1' }]),
  scheduled_services: () => arrayChain([]), // nothing in-zone
  self_booked_appointments: () => arrayChain([]),
  estimates: () => arrayChain([{ customer_id: 'cust-1' }]),
  customers: () => arrayChain([{ ...PALMETTO }]),
});

let seen;
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  seen = [];
  db.mockReset();
  const t = tables();
  db.mockImplementation((table) => {
    seen.push(table);
    if (!t[table]) throw new Error(`unexpected table ${table}`);
    return t[table]();
  });
});

const startsOf = (result) => (result.days[0]?.slots || []).map((s) => s.startTime24);

test('gate off: no occupancy range read, no estimate/customer pin read — legacy statements only', async () => {
  const result = await engine.getAvailableSlots('Palmetto', 'est-1');
  expect(listOccupiedWindows).not.toHaveBeenCalled();
  expect(seen).not.toContain('estimates');
  expect(seen).not.toContain('customers');
  // Empty zone timeline → the builder's own gaps, 09:00 onward.
  expect(startsOf(result)).toContain('09:00');
});

test('gate on: an OUT-OF-ZONE stop across a real drive drops the touching window the commit would reject', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  // Bradenton 10:00–11:00 — not in the Palmetto zone's city list, so the
  // legacy occupied set never saw it; the commit probe (tech-blind) does.
  listOccupiedWindows.mockResolvedValue([
    { id: 'far', date: DATE, startMin: 600, endMin: 660, ...BRADENTON },
  ]);
  const result = await engine.getAvailableSlots('Palmetto', 'est-1');
  expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ dateFrom: DATE, dateTo: DATE, withCoords: true }));
  expect(seen).toContain('estimates');
  expect(seen).toContain('customers');
  const starts = startsOf(result);
  // 09:00–10:00 touches the 10:00 stop with 0 free minutes against ~33 + 15.
  expect(starts).not.toContain('09:00');
  // 10:00–11:00 overlaps it outright.
  expect(starts).not.toContain('10:00');
  // Afternoon windows are clear of it.
  expect(starts).toContain('14:00');
});

test('gate on with a customerId and no estimate (AI assistant session): the customer pin, no estimates read', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  listOccupiedWindows.mockResolvedValue([
    { id: 'far', date: DATE, startMin: 600, endMin: 660, ...BRADENTON },
  ]);
  const result = await engine.getAvailableSlots('Palmetto', null, { customerId: 'cust-1' });
  expect(seen).not.toContain('estimates');
  expect(seen).toContain('customers');
  expect(startsOf(result)).not.toContain('09:00');
  expect(startsOf(result)).toContain('14:00');
});

test('gate on without an estimate: buffer-only pin, still mirrored; a failed range read serves unfiltered', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  listOccupiedWindows.mockResolvedValue([
    { id: 'near', date: DATE, startMin: 605, endMin: 665, lat: null, lng: null }, // 10:05 — 5 free min < 15 buffer
  ]);
  let result = await engine.getAvailableSlots('Palmetto');
  expect(seen).not.toContain('estimates');
  expect(startsOf(result)).not.toContain('09:00');

  listOccupiedWindows.mockRejectedValue(new Error('boom'));
  result = await engine.getAvailableSlots('Palmetto', 'est-1');
  expect(startsOf(result)).toContain('09:00');
});

test('findGaps applies the accept predicate BEFORE its four-slot cap (r4 P2)', () => {
  // Six one-hour holes on the day (blocks every other hour); rejecting the
  // first four must still surface the fifth and sixth.
  const occupied = [9, 11, 13, 15].map((h) => ({ start: h * 60, end: h * 60 + 60 }));
  const all = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0);
  expect(all).toHaveLength(4); // capped
  const rejectEarly = (g) => g.start >= 14 * 60;
  const late = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0, rejectEarly);
  expect(late.map((g) => g.start / 60)).toEqual([14, 16]);
});

test('findGaps advances an hour at a time inside a rejected gap (r5 P2)', () => {
  // One long zone-local hole 09:00–15:00 (blocks 08–09 and 15–16). An
  // out-of-zone rejection of 09:00 must yield the first accepted hour.
  const occupied = [{ start: 8 * 60, end: 9 * 60 }, { start: 15 * 60, end: 16 * 60 }];
  const noEarly = (g) => g.start >= 12 * 60;
  const slots = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0, noEarly);
  expect(slots.map((g) => g.start / 60)).toEqual([12, 16]);
  // Without a predicate the legacy shape is unchanged: one slot per gap.
  expect(engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0).map((g) => g.start / 60)).toEqual([9, 16]);
});

test('a linked booking copy cannot retain the old window after its visit stops occupying it', async () => {
  const t = tables();
  const copy = { id: 'old-copy', start_time: '08:00', end_time: '17:00' };
  let linkedVisit = false;
  t.self_booked_appointments = () => arrayChain([{ ...copy, linkedVisit }]);
  db.mockImplementation(table => t[table]());
  expect((await engine.getAvailableSlots('Palmetto')).days).toHaveLength(0);
  linkedVisit = true;
  expect(startsOf(await engine.getAvailableSlots('Palmetto'))).toContain('09:00');
});
