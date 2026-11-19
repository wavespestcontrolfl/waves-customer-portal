/**
 * Weekly near-stops check (owner 2026-11-19, "check"): one read-only owner
 * notification each Monday. These tests pin what the owner reads:
 *   1. which next-door stops count as booked apart (and which do not),
 *   2. the booking replay: a booking is costly only against an hour that was
 *      really open when it was made, on the booking engine's own gap math,
 *   3. the notification's size limits, wording and weekly dedupe,
 *   4. the run's marker: one run a week, a catch-up only while it is missing.
 * Names here are synthetic. Drive minutes are the plain model (no calibration).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n-1' })) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 0) }));
const mockFirst = jest.fn();
jest.mock('../models/db', () => {
  const chain = { where: jest.fn(() => chain), first: (...args) => mockFirst(...args) };
  const db = jest.fn(() => chain);
  db.raw = jest.fn();
  db.fn = { now: jest.fn() };
  return db;
});

delete process.env.GATE_DRIVE_TIME_CALIBRATION;
delete process.env.GATE_TECH_START_POINTS;

const { deliverOpsDigest } = require('../services/ops-digest');
const { retireIfClean } = require('../services/ops-digest-fall-off');
const { HQ } = require('../services/auto-dispatch/geo');
const { parseETDateTime } = require('../utils/datetime-et');
const {
  runNearStopsWeeklyCheck,
  weekIsMissing,
  _private: {
    findApartPairs, holdFor, stateAt, groupBookings, replayBooking, replayAll, seriesSiblingMoves, shortDriveSummary, composeWeeklyCheck, sentRecently, noEmail, OPS_KEY,
  },
} = require('../services/near-stops-weekly-check');

const MILES_PER_DEGREE = (3959 * Math.PI) / 180; // route-optimizer haversine's radius
const north = (miles, from = HQ) => ({ lat: from.lat + miles / MILES_PER_DEGREE, lng: from.lng });

const TECH = { id: 'tech-1', name: 'Tech One' };

// ------------------------------------------------------------------ part 1

let seq = 0;
function stop({ customer, first = 'Avery', last = 'Sample', city = 'Lakewood Ranch', at, date, start = '09:00', plan = false }) {
  seq += 1;
  return {
    id: `svc-${seq}`,
    customer_id: customer,
    scheduled_date: date,
    window_start: start ? `${start}:00` : null,
    technician_id: TECH.id,
    is_recurring: plan,
    recurring_parent_id: plan ? `plan-${customer}` : null,
    lat: at.lat,
    lng: at.lng,
    service_address_line1: null,
    service_address_zip: null,
    service_address_city: city,
    first_name: first,
    last_name: last,
    customer_address_line1: null,
    customer_zip: null,
    customer_city: city,
    customer_latitude: at.lat,
    customer_longitude: at.lng,
  };
}

const HOME_A = north(5);
const NEXT_DOOR = north(0.05, HOME_A); // about 260 feet from HOME_A

describe('part 1: next-door stops booked apart', () => {
  test('two customers 0.05 mile apart, booked 3 days apart: one split, with the distance in feet', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }),
      stop({ customer: 'c-b', first: 'Blake', last: 'Example', at: NEXT_DOOR, date: '2027-03-04', plan: true }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ gap: 3, sameCustomer: false });
    expect(pairs[0].first.date).toBe('2027-03-01');
    const { detail } = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), weekStart: '2027-03-01' });
    expect(detail).toMatch(/- Avery S\. and Blake E\. \(Lakewood Ranch\), about 260 ft apart: Mon, Mar 1 9:00\sAM \(not in the night run\) and Thu, Mar 4 9:00\sAM \(not in the night run\), 3 days apart\./);
    expect(detail).not.toContain('Sample');
  });

  test('back to back on one day is together, not a split', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '10:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test("two customers on one day with a stop between are the 4:40 re-plan's to order, not reported", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test("one customer's two homes on one day with a stop between are reported: the re-plan keeps their hours", () => {
    const rental = north(0.3, HOME_A);
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-a', at: rental, date: '2027-03-01', start: '11:00' }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ sameCustomer: true, between: 1 });
    const { detail } = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), weekStart: '2027-03-01' });
    expect(detail).toMatch(/- Avery S\.'s two homes \(Lakewood Ranch\), 0\.3 mi apart: Mon, Mar 1 9:00\sAM and 11:00\sAM, same day, 1 stop between; the 4:40 AM re-plan keeps one customer's own hours\./);
  });

  test("a stop with no map pin between one customer's two homes still splits them", () => {
    const pinless = { ...stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }), lat: null, lng: null, customer_latitude: null, customer_longitude: null };
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      pinless,
      stop({ customer: 'c-a', at: north(0.3, HOME_A), date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([expect.objectContaining({ sameCustomer: true, between: 1 })]);
  });

  test('a combined visit between two homes is one stop, not two', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-a', at: north(0.3, HOME_A), date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([expect.objectContaining({ between: 1 })]);
  });

  test("a third home of the same customer between the two near homes splits them", () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-a', at: north(9), date: '2027-03-01', start: '10:00' }),
      stop({ customer: 'c-a', at: north(0.3, HOME_A), date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([expect.objectContaining({ sameCustomer: true, between: 1 })]);
  });

  test("an unassigned home's stops are judged on its partner's route: another route's stop does not split them", () => {
    const rows = [
      { ...stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }), technician_id: null },
      { ...stop({ customer: 'c-x', at: north(8), date: '2027-03-01', start: '10:00' }), technician_id: 'tech-2' },
      stop({ customer: 'c-a', at: north(0.3, HOME_A), date: '2027-03-01', start: '11:00' }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test('outside the radius: two customers 0.2 mile apart, or one customer\'s homes 0.6 mile apart', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01' }),
      stop({ customer: 'c-b', at: north(0.2, HOME_A), date: '2027-03-05' }),
      stop({ customer: 'c-d', at: north(20), date: '2027-03-01' }),
      stop({ customer: 'c-d', at: north(20.6), date: '2027-03-05' }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });

  test('each visit meets the nearest-dated visit next door: the April round with no partner is not a split', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-04-01', start: '09:00', plan: true }),
      stop({ customer: 'c-a', at: HOME_A, date: '2027-05-03', start: '09:00', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: '10:00', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-05-10', start: '10:00', plan: true }),
    ];
    const pairs = findApartPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ gap: 7 });
    expect([pairs[0].first.date, pairs[0].second.date]).toEqual(['2027-05-03', '2027-05-10']);
    const { detail } = composeWeeklyCheck({ apart: pairs, nightLog: new Map(), weekStart: '2027-03-01' });
    expect(detail).toContain("7 days apart, past the night run's 5-day reach.");
  });

  test('a visit with no time yet on the same day is not judged', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', start: '09:00' }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-01', start: null }),
    ];
    expect(findApartPairs(rows)).toEqual([]);
  });
});

describe('what holds each visit, in plain words', () => {
  const planVisit = { id: 'svc-9', planChild: true };

  test('a first or one-time visit never enters the night run', () => {
    expect(holdFor({ id: 'svc-8', planChild: false }, new Map())).toBe('first or one-time visit');
  });

  test("the night run's own reason for the visit", () => {
    const log = new Map([['svc-9', { reason_code: 'REMINDER_SENT_FROZEN', action: 'no_change' }]]);
    expect(holdFor(planVisit, log)).toBe('customer already told the time');
  });

  test('an unknown reason reads as its own words', () => {
    const log = new Map([['svc-9', { reason_code: 'NEW_REASON_CODE' }]]);
    expect(holdFor(planVisit, log)).toBe('new reason code');
  });

  test('a plan visit the run did not log, and a week with no run to read', () => {
    expect(holdFor(planVisit, new Map())).toBe('not in the night run');
    expect(holdFor(planVisit, null)).toBe('no night run to read');
  });
});

// ------------------------------------------------------------------ part 2

const DAY = '2027-03-03'; // Wednesday
const BOOKED_AT = parseETDateTime('2027-03-02T10:00'); // Tuesday 10:00 AM ET
const X = north(10); // the new customer, 28 model minutes from the office
const BESIDE_X = north(0.05, X);
const Y = north(-10); // the other side of the office, 56 minutes from X
const before = (minutes) => new Date(BOOKED_AT.getTime() - minutes * 60000);
const after = (minutes) => new Date(BOOKED_AT.getTime() + minutes * 60000);

function svc({ id, customer, date = DAY, start, end, at, createdAt = before(60 * 24 * 3), status = 'pending', extra = {} }) {
  return {
    id,
    customer_id: customer,
    scheduled_date: date,
    technician_id: TECH.id,
    window_start: `${start}:00`,
    window_end: `${end}:00`,
    service_type: 'Pest Control',
    estimated_duration_minutes: 60,
    reservation_service_mix: null,
    is_recurring: false,
    recurring_parent_id: null,
    status,
    created_at: createdAt,
    updated_at: createdAt,
    cancelled_at: null,
    reservation_expires_at: null,
    source: 'admin',
    booking_source: null,
    svc_lat: at.lat,
    svc_lng: at.lng,
    first_name: 'Casey',
    last_name: 'Fixture',
    city: 'Parrish',
    cust_lat: at.lat,
    cust_lng: at.lng,
    ...extra,
  };
}

// The day as booked: a stop beside the new customer at 9, one across town at 1.
const besideStop = () => svc({ id: 's-beside', customer: 'c-1', start: '09:00', end: '10:00', at: BESIDE_X });
const acrossStop = () => svc({ id: 's-across', customer: 'c-2', start: '13:00', end: '14:00', at: Y });
const bookingRow = (extra = {}) => svc({
  id: 'b-1', customer: 'c-new', start: '15:00', end: '16:00', at: X, createdAt: BOOKED_AT, extra,
});

function replay({ rows, moves = [], created = [bookingRow()], closed = new Set(), absent = new Set(), absences = [] }) {
  const movesById = new Map();
  for (const m of moves) movesById.set(m.scheduled_service_id, [...(movesById.get(m.scheduled_service_id) || []), m]);
  const [booking] = groupBookings(created, movesById);
  const ctx = { rows: [...rows, ...created], movesById, tech: TECH, closed, offDays: absent, absences, techStartPoints: false };
  return replayBooking(booking, ctx);
}

describe('part 2: the booking replay', () => {
  test('the 3 PM hour across town cost 56 minutes when 10 AM beside a stop cost 0', () => {
    const r = replay({ rows: [besideStop(), acrossStop()] });
    expect(r.booked).toBe(56);
    expect(r.best).toMatchObject({ date: DAY, start_time: '10:00', detour_minutes: 0 });
    expect(r.saving).toBe(56);
    const { detail } = composeWeeklyCheck({ costly: [r], replayed: 1, weekStart: '2027-03-01' });
    expect(detail).toContain('- Office, booked Tue, Mar 2: Casey F. (Parrish) on Wed, Mar 3 3:00');
    expect(detail).toMatch(/adds 56 min; Wed, Mar 3 10:00\s?AM was open and adds 0 min \(56 less\)\./);
  });

  test('a stop booked after the booking was not there to choose', () => {
    const later = { ...besideStop(), created_at: after(30), updated_at: after(30) };
    const r = replay({ rows: [later, acrossStop()] });
    expect(r.saving).toBe(0);
  });

  test('a stop moved away later still counts on the day it held at booking', () => {
    const moved = { ...besideStop(), scheduled_date: '2027-03-20' };
    const moves = [{ scheduled_service_id: 's-beside', original_date: DAY, original_window: '09:00:00-10:00:00', created_at: after(120) }];
    const r = replay({ rows: [moved, acrossStop()], moves });
    expect(r.saving).toBe(56);
  });

  test('a stop cancelled after the booking was still on the calendar then; one cancelled before was not', () => {
    const cancelledLater = { ...besideStop(), status: 'cancelled', cancelled_at: after(60) };
    expect(replay({ rows: [cancelledLater, acrossStop()] }).saving).toBe(56);
    const cancelledBefore = { ...besideStop(), status: 'cancelled', cancelled_at: before(60) };
    expect(replay({ rows: [cancelledBefore, acrossStop()] }).saving).toBe(0);
  });

  test('a move logged with a start alone still holds the stop at that hour', () => {
    const moved = { ...besideStop(), scheduled_date: '2027-03-20' };
    const moves = [{ scheduled_service_id: 's-beside', original_date: DAY, original_window: '09:00:00', created_at: after(120) }];
    expect(replay({ rows: [moved, acrossStop()], moves }).saving).toBe(56);
  });

  test('a visit with no technician is a stop on the one route, and so is a booking with none', () => {
    const unassigned = { ...besideStop(), technician_id: null };
    expect(replay({ rows: [unassigned, acrossStop()] }).saving).toBe(56);
    const created = [bookingRow({ technician_id: null })];
    expect(replay({ rows: [besideStop(), acrossStop()], created }).saving).toBe(56);
  });

  test('a stop skipped before the booking was off the route; one skipped after was still on it', () => {
    const skippedBefore = { ...besideStop(), status: 'skipped', updated_at: before(30) };
    expect(replay({ rows: [skippedBefore, acrossStop()] }).saving).toBe(0);
    const skippedAfter = { ...besideStop(), status: 'skipped', updated_at: after(30) };
    expect(replay({ rows: [skippedAfter, acrossStop()] }).saving).toBe(56);
  });

  test('a booking moved after it was made is judged at the hour it took', () => {
    const created = [bookingRow({ scheduled_date: '2027-03-09', window_start: '08:00:00', window_end: '09:00:00' })];
    const moves = [{ scheduled_service_id: 'b-1', original_date: DAY, original_window: '15:00:00-16:00:00', created_at: after(5) }];
    const r = replay({ rows: [besideStop(), acrossStop()], moves, created });
    expect(r.booking.day).toBe(DAY);
    expect(r.booked).toBe(56);
  });

  test('on the booking day, an hour less than 30 minutes ahead was not open', () => {
    const lateMorning = parseETDateTime(`${DAY}T11:15`);
    const created = [bookingRow({ created_at: lateMorning, updated_at: lateMorning })];
    const r = replay({ rows: [besideStop(), acrossStop()], created });
    expect(r.saving).toBe(0);
  });

  test('office and phone bookings are replayed; a link booking is counted, not replayed', () => {
    const rows = [besideStop(), acrossStop()];
    const link = bookingRow({ id: 'b-link', customer_id: 'c-link', source: 'inspection_link', scheduled_date: '2027-03-10' });
    const created = [bookingRow(), link];
    const ctx = { rows: [...rows, ...created], movesById: new Map(), tech: TECH, closed: new Set(), offDays: new Set(), absences: [], techStartPoints: false };
    const out = replayAll(groupBookings(created, new Map()), ctx);
    expect(out).toMatchObject({ replayed: 1, customerPicked: 1 });
    expect(out.costly.map((r) => r.saving)).toEqual([56]);
    const { detail } = composeWeeklyCheck({ ...out, weekStart: '2027-03-01' });
    expect(detail).toContain('Office and phone bookings last week that took a costlier hour: 1 of 1 replayed (1 customer-picked booking not replayed: links and self-booking have their own offer rules)');
  });

  test('a self-booking is customer-picked even when its source reads admin', () => {
    const [booking] = groupBookings([bookingRow({ self_booking_id: 'sb-1' })], new Map());
    expect(booking.staffPicked).toBe(false);
    expect(groupBookings([bookingRow()], new Map())[0].staffPicked).toBe(true);
  });

  test("a sibling moved by a series move held its old hour at booking (series_moves.rows)", () => {
    const moved = { ...besideStop(), scheduled_date: '2027-03-24' };
    const series = [{ created_at: after(60), rows: [{ id: 's-beside', before: { scheduled_date: DAY, window_start: '09:00:00', window_end: '10:00:00' }, after: { scheduled_date: '2027-03-24' } }] }];
    const moves = seriesSiblingMoves(series);
    expect(moves).toEqual([{ scheduled_service_id: 's-beside', original_date: DAY, original_window: '09:00:00-10:00:00', created_at: after(60) }]);
    expect(replay({ rows: [moved, acrossStop()], moves }).saving).toBe(56);
  });

  test('an absence counts as it stood at booking: one entered later does not close the day', () => {
    const later = [{ absence_date: DAY, created_at: after(60), cleared_at: null }];
    expect(replay({ rows: [besideStop(), acrossStop()], absences: later }).saving).toBe(56);
    const thenCleared = [{ absence_date: DAY, created_at: before(60), cleared_at: after(60) }];
    expect(replay({ rows: [besideStop(), acrossStop()], absences: thenCleared }).saving).toBe(0);
  });

  test('a booking cancelled after it was made still counts: it took the hour when booked', () => {
    const cancelledLater = bookingRow({ status: 'cancelled', cancelled_at: after(90) });
    expect(groupBookings([cancelledLater], new Map())).toHaveLength(1);
  });

  test("a stop on another technician's route those days makes the replay ambiguous: skipped", () => {
    const otherRoute = { ...acrossStop(), technician_id: 'tech-2' };
    expect(replay({ rows: [besideStop(), otherRoute] })).toBeNull();
    expect(replay({ rows: [besideStop(), acrossStop()], created: [bookingRow({ technician_id: 'tech-2' })] })).toBeNull();
  });

  test("a closed day, or the technician's day off, offers no hour", () => {
    expect(replay({ rows: [besideStop(), acrossStop()], closed: new Set([DAY]) }).saving).toBe(0);
    expect(replay({ rows: [besideStop(), acrossStop()], absent: new Set([`${TECH.id}:${DAY}`]) }).saving).toBe(0);
  });

  test('the screen each booking came from', () => {
    const screen = (extra) => groupBookings([bookingRow(extra)], new Map())[0].screen;
    expect(screen({})).toBe('office');
    expect(screen({ booking_source: 'phone_call' })).toBe('phone call');
    expect(screen({ source: 'reservice_link' })).toBe('re-service link');
    expect(screen({ source: 'inspection_link' })).toBe('inspection link');
  });

  test('one booking per customer, home, day and start, however many service rows it holds', () => {
    const second = bookingRow({ id: 'b-2' });
    const bookings = groupBookings([bookingRow(), second], new Map());
    expect(bookings).toHaveLength(1);
    expect([...bookings[0].ids].sort()).toEqual(['b-1', 'b-2']);
  });

  test('a later booking that reuses the same slot is its own booking', () => {
    const rebooked = bookingRow({ id: 'b-2', created_at: after(120), updated_at: after(120) });
    const bookings = groupBookings([bookingRow(), rebooked], new Map());
    expect(bookings.map((b) => [...b.ids])).toEqual([['b-1'], ['b-2']]);
  });

  test('a second appointment at the same home that day stays its own booking', () => {
    const morning = bookingRow({ id: 'b-2', window_start: '09:00:00', window_end: '10:00:00' });
    const bookings = groupBookings([bookingRow(), morning], new Map());
    expect(bookings.map((b) => [b.startMin, b.durationMinutes])).toEqual([[900, 60], [540, 60]]);
  });
});

describe('stateAt', () => {
  const row = bookingRow();
  test('a row made after the instant was not on the calendar', () => {
    expect(stateAt(row, before(1).getTime())).toBeNull();
  });
  test('an expired hold was off the calendar', () => {
    const hold = { ...row, reservation_expires_at: after(10) };
    expect(stateAt(hold, after(5).getTime())).not.toBeNull();
    expect(stateAt(hold, after(15).getTime())).toBeNull();
  });
});

// ------------------------------------------------------------- the message

function manyPairs(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const at = north(30 + i);
    rows.push(stop({ customer: `p-${i}`, first: 'Maximiliana-Josephine', last: 'Worthington', city: 'Lakewood Ranch Main Street District', at, date: '2027-03-01', plan: true }));
    rows.push(stop({ customer: `q-${i}`, first: 'Bartholomew-Alexander', last: 'Fairweather', city: 'Lakewood Ranch Main Street District', at: north(0.05, at), date: `2027-03-${String(10 + i).padStart(2, '0')}`, plan: true }));
  }
  return findApartPairs(rows);
}

describe('the notification', () => {
  test('nothing in parts 1 and 2: nothing to post', () => {
    expect(composeWeeklyCheck({ apart: [], costly: [], replayed: 4, weekStart: '2027-03-01' })).toEqual({ items: 0 });
  });

  test('headline, summary and detail stay inside the admin-notification limits', () => {
    const base = replay({ rows: [besideStop(), acrossStop()] });
    const costly = Array.from({ length: 12 }, () => ({ ...base, booking: { ...base.booking, customerName: 'Maximiliana-Josephine W.', city: 'Lakewood Ranch Main Street District' } }));
    const out = composeWeeklyCheck({
      apart: manyPairs(12), costly, replayed: 30, nightLog: new Map(), weekStart: '2027-03-01',
      drives: { week: [{ drive_miles: 0.4, drive_minutes: 1.9 }], total: 1, median: 1.9, since: '2026-08-27' },
    });
    expect(out.items).toBe(24);
    expect(out.headline).toBe('Schedule — review 12 next-door splits and 12 costly bookings');
    expect(out.headline.length).toBeLessThanOrEqual(60);
    expect(out.summary.length).toBeLessThanOrEqual(110);
    expect(out.detail.length).toBeLessThanOrEqual(2000);
    expect(out.detail).not.toContain('…');
    for (const text of [out.headline, out.summary]) expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(out.detail.match(/- and 9 more/g)).toHaveLength(2);
    expect(out.detail).toContain('Not checked: arrival windows, customer wishes, short holds, office edits the move log missed.');
    expect(out.detail).toContain('Truck GPS, drives under half a mile from one visit to the next: last week 0.4 mi in 1.9 min. All since Thu, Aug 27: 1, median 1.9 min.');
    expect(out.metadata).toMatchObject({ weekOf: '2027-03-01', pairsApart: 12, bookingsReplayed: 30, bookingsCostly: 12, costlyMinutes: 672 });
  });

  test('with two technicians the booking part says it is paused, and why', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', plan: true }),
    ];
    const out = composeWeeklyCheck({ apart: findApartPairs(rows), nightLog: new Map(), techCount: 2, weekStart: '2027-03-01' });
    expect(out.detail).toContain('Bookings last week: not replayed. The replay needs one technician to know whose route each stop was on; the schedule has 2.');
    expect(out.detail).not.toContain('An estimate:');
  });

  test('the GPS median of an even count is the mean of the middle two', () => {
    const legs = [{ service_date: '2027-03-02', drive_minutes: 1 }, { service_date: '2027-02-01', drive_minutes: 5 }];
    expect(shortDriveSummary(legs, '2027-03-01', '2027-03-08')).toMatchObject({ total: 2, median: 3 });
    expect(shortDriveSummary(legs, '2027-03-01', '2027-03-08').week).toHaveLength(1);
  });

  test('the summary leads with the easiest pair to join', () => {
    const rows = [
      stop({ customer: 'c-a', at: HOME_A, date: '2027-03-01', plan: true }),
      stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-04', plan: true }),
    ];
    const out = composeWeeklyCheck({ apart: findApartPairs(rows), nightLog: new Map(), weekStart: '2027-03-01' });
    expect(out.headline).toBe('Schedule — review 1 next-door split');
    expect(out.summary).toBe('Easiest to join: two stops about 260 ft apart, Mon, Mar 1 and Thu, Mar 4.');
  });
});

// ------------------------------------------------------------------ the run

const MONDAY = new Date('2027-03-08T11:17:00.000Z'); // Monday 6:17 AM EST

function deps(data) {
  return {
    now: MONDAY,
    sentRecently: jest.fn(async () => false),
    loadWeek: jest.fn(async () => data),
    stampSendMarker: jest.fn(async () => {}),
  };
}

const oneSplit = () => {
  const rows = [
    stop({ customer: 'c-a', at: HOME_A, date: '2027-03-10', plan: true }),
    stop({ customer: 'c-b', at: NEXT_DOOR, date: '2027-03-12', plan: true }),
  ];
  return { weekStart: '2027-03-08', apart: findApartPairs(rows), nightLog: new Map(), costly: [], replayed: 2, drives: null };
};

describe('runNearStopsWeeklyCheck', () => {
  beforeEach(() => jest.clearAllMocks());

  test("this week's check already ran: nothing is read or posted", async () => {
    const opts = { ...deps(oneSplit()), sentRecently: jest.fn(async () => true) };
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ skipped: 'recent_send' });
    expect(opts.loadWeek).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('a finding posts one owner row a week, rung once, closing last week\'s row, never by email', async () => {
    const opts = deps(oneSplit());
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ sent: true, pairs: 1, bookings: 0 });
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const call = deliverOpsDigest.mock.calls[0][0];
    expect(call).toMatchObject({
      key: OPS_KEY,
      subject: 'ACT: Schedule — review 1 next-door split',
      link: '/admin/schedule',
      audience: 'owner',
      dedupeKey: 'near-stops-weekly:2027-03-08',
      itemKeys: ['2027-03-08'],
      ringOnFirstIdentity: true,
      supersedePrior: true,
      count: 1,
    });
    await expect(call.sendEmail()).resolves.toEqual({ ok: false, error: 'bell_only' });
    expect(opts.stampSendMarker).toHaveBeenCalledTimes(1);
    expect(retireIfClean).not.toHaveBeenCalled();
  });

  test('a clean week posts nothing, closes the open row and stamps the week', async () => {
    const opts = deps({ weekStart: '2027-03-08', apart: [], nightLog: new Map(), costly: [], replayed: 3, drives: null });
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ sent: false, empty: true, pairs: 0, bookings: 0 });
    expect(deliverOpsDigest).not.toHaveBeenCalled();
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
    expect(opts.stampSendMarker).toHaveBeenCalledTimes(1);
  });

  test('unreadable data: no post, no stamp, so the catch-up tries again', async () => {
    const opts = { ...deps(null), loadWeek: jest.fn(async () => { throw new Error('read timeout'); }) };
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toEqual({ skipped: 'query_failed' });
    expect(opts.stampSendMarker).not.toHaveBeenCalled();
  });

  test('a bell row that could not be written leaves the week unstamped', async () => {
    deliverOpsDigest.mockResolvedValueOnce({ ok: false, error: 'bell_only', fallback: true });
    const opts = deps(oneSplit());
    await expect(runNearStopsWeeklyCheck(opts)).resolves.toMatchObject({ sent: false, error: true });
    expect(opts.stampSendMarker).not.toHaveBeenCalled();
    deliverOpsDigest.mockRejectedValueOnce(new Error('pool closed'));
    await expect(runNearStopsWeeklyCheck(deps(oneSplit()))).resolves.toMatchObject({ sent: false, error: true });
  });

  test('the email stand-in sends nothing', async () => {
    await expect(noEmail()).resolves.toEqual({ ok: false, error: 'bell_only' });
  });
});

describe('the weekly marker', () => {
  const TUESDAY = new Date('2027-03-09T16:17:00.000Z'); // Tuesday 11:17 AM EST
  beforeEach(() => jest.clearAllMocks());

  test("no marker, or last week's: this week is missing", async () => {
    mockFirst.mockResolvedValueOnce(undefined);
    await expect(weekIsMissing(TUESDAY)).resolves.toBe(true);
    mockFirst.mockResolvedValueOnce({ last_sent_at: new Date('2027-03-01T11:17:30.000Z') });
    await expect(weekIsMissing(TUESDAY)).resolves.toBe(true);
  });

  test("this week's marker, stamped Monday: not missing, and the Monday run is done", async () => {
    mockFirst.mockResolvedValue({ last_sent_at: new Date('2027-03-08T11:18:00.000Z') });
    await expect(weekIsMissing(TUESDAY)).resolves.toBe(false);
    await expect(sentRecently(TUESDAY)).resolves.toBe(true);
  });

  test('an unreadable marker: the catch-up skips, the Monday run goes ahead', async () => {
    mockFirst.mockRejectedValue(new Error('connection reset'));
    await expect(weekIsMissing(TUESDAY)).resolves.toBe(false);
    await expect(sentRecently(MONDAY)).resolves.toBe(false);
  });
});
