// Ads follow the route, step 1 (record only): the pure record builder and the save. Nothing here touches a budget,
// a campaign or Google Ads; the save writes two system_settings rows (ads.route_areas.last / .history) in one
// transaction.

jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('the module must use the conn it is given'); }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({ applyAssignable: jest.fn((q) => q), absentTechDays: jest.fn() }));
jest.mock('../services/scheduling/policy', () => ({ SHIFT: { startMinutes: 480, endMinutes: 1080 } }));
jest.mock('../services/day-replan/close-gaps', () => ({ SLOT_MIN: 80 }));

const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
const { absentTechDays } = require('../services/technician-eligibility');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../services/stops-ahead');
const {
  buildRouteAreas, recordRouteAreas, LAST_KEY, HISTORY_KEY, HISTORY_MAX,
} = require('../services/ads/route-areas');

const T1 = 'tech-1';
const T2 = 'tech-2';
// Mon + Tue
const WEEKDAYS = ['2026-11-23', '2026-11-24'];
const LIMITS = { weekday_limit: 6, saturday_limit: 4, sunday_limit: 2 };
const TERRITORY = [
  { zip: '34201', area: 'a-north', technicianId: null },
  { zip: '34202', area: 'a-north', technicianId: null },
  { zip: '34203', area: 'b-mid', technicianId: null },
  { zip: '34204', area: 'c-south', technicianId: null },
];

const stop = (over = {}) => ({
  technicianId: T1, date: WEEKDAYS[1], zip: '34201', minutes: 60, done: false, ...over,
});
const input = (over = {}) => ({
  at: '2026-11-23T14:00:00.000Z',
  dates: WEEKDAYS,
  nowMin: 9 * 60,
  techIds: [T1],
  absent: new Set(),
  blackout: new Set(),
  stops: [],
  territory: TERRITORY,
  lineCard: { general: null, lawn: null },
  limits: LIMITS,
  shift: { startMinutes: 480, endMinutes: 1080 },
  slotMin: 80,
  ...over,
});
const dayOf = (rec, techId, date) => rec.technicians.find((t) => t.id === techId).days.find((d) => d.date === date);

describe('buildRouteAreas: one technician', () => {
  test('the day at its stop limit has no room, even with minutes left; the minutes alone can be counted again', () => {
    // Sunday limit 2, two short stops, run at 9:00 on that day: 540 - 60 - 40 = 440 open minutes, but no stop is left
    // under the limit.
    const sunday = '2026-11-22';
    const rec = buildRouteAreas(input({
      dates: [sunday, '2026-11-23'],
      stops: [stop({ date: sunday, minutes: 30 }), stop({ date: sunday, minutes: 30, zip: '34203' })],
    }));
    expect(dayOf(rec, T1, sunday)).toMatchObject({
      staffed: true, stops: 2, limit: 2, open_stops: 0, open_min: 440, room: false, zips: [], zip_source: null, zip_reason: 'full',
    });
  });

  test('room with stops in two areas: every ZIP of both areas, from the stops', () => {
    const rec = buildRouteAreas(input({ stops: [stop(), stop({ zip: '34203' }), stop({ zip: '34203' })] }));
    const d = dayOf(rec, T1, WEEKDAYS[1]);
    expect(d).toMatchObject({
      staffed: true, reason: null, stops: 3, stops_left: 3, limit: 6, open_stops: 3,
      shift_min: 600, booked_min: 180, drive_min: 60, open_min: 360, room: true,
      unmapped_stops: 0, zip_source: 'stops', zip_reason: null,
    });
    expect(d.areas).toEqual([{ area: 'a-north', stops: 1, stops_left: 1 }, { area: 'b-mid', stops: 2, stops_left: 2 }]);
    expect(d.zips).toEqual(['34201', '34202', '34203']);
    expect(rec.zips).toEqual(['34201', '34202', '34203']);
    expect(rec.areas).toEqual(['a-north', 'b-mid']);
  });

  test('a full day (open_min below the slot) lists no ZIPs', () => {
    const stops = Array.from({ length: 7 }, () => stop());
    const d = dayOf(buildRouteAreas(input({ stops })), T1, WEEKDAYS[1]);
    expect(d.open_min).toBe(40);
    expect(d).toMatchObject({ room: false, zips: [], zip_reason: 'full', zip_source: null });
    expect(d.areas).toEqual([{ area: 'a-north', stops: 7, stops_left: 7 }]);
  });

  test('a date the route check measured takes its real openings: free time in pieces is not room', () => {
    // Tomorrow: 3 stops, 360 open minutes in total, but the route check found no opening that holds a job.
    const stops = [stop(), stop({ zip: '34203' }), stop({ zip: '34203' })];
    const check = (slots, extra = {}) => ({ at: '2026-11-23T13:30:00.000Z', days: [{ date: WEEKDAYS[1], technicianId: T1, slots, skip: null, ...extra }] });
    const none = buildRouteAreas(input({ stops, routeCheck: check(0) }));
    expect(dayOf(none, T1, WEEKDAYS[1])).toMatchObject({
      open_stops: 3, open_min: 360, room_basis: 'route_check', route_slots: 0, room: false, zips: [], zip_reason: 'full',
    });
    expect(none.rule.route_check_at).toBe('2026-11-23T13:30:00.000Z');

    // One real opening is room, even where the minute total alone is under a slot.
    const tight = Array.from({ length: 7 }, () => stop());
    const one = buildRouteAreas(input({ stops: tight, limits: { ...LIMITS, weekday_limit: 9 }, routeCheck: check(1) }));
    expect(dayOf(one, T1, WEEKDAYS[1])).toMatchObject({ open_min: 40, open_stops: 2, room_basis: 'route_check', route_slots: 1, room: true });

    // The stop limit still applies to a measured date.
    const atLimit = buildRouteAreas(input({ stops: tight, limits: { ...LIMITS, weekday_limit: 7 }, routeCheck: check(3) }));
    expect(dayOf(atLimit, T1, WEEKDAYS[1])).toMatchObject({ open_stops: 0, route_slots: 3, room: false });
  });

  test('today, a skipped day and a day with no route check use the minute total', () => {
    const stops = [stop({ date: WEEKDAYS[0] }), stop()];
    const routeCheck = {
      at: '2026-11-23T13:30:00.000Z',
      days: [
        // The route check does not measure today; an entry for it is never used.
        { date: WEEKDAYS[0], technicianId: T1, slots: 0, skip: null },
        { date: WEEKDAYS[1], technicianId: T1, slots: null, skip: 'UNASSIGNED_WORK' },
      ],
    };
    const rec = buildRouteAreas(input({ stops, routeCheck }));
    expect(dayOf(rec, T1, WEEKDAYS[0])).toMatchObject({ room_basis: 'minutes', route_slots: null, room: true });
    expect(dayOf(rec, T1, WEEKDAYS[1])).toMatchObject({ room_basis: 'minutes', route_slots: null, room: true });
    const noCheck = buildRouteAreas(input({ stops }));
    expect(dayOf(noCheck, T1, WEEKDAYS[1])).toMatchObject({ room_basis: 'minutes', route_slots: null, room: true });
    expect(noCheck.rule.route_check_at).toBeNull();
  });

  test('a blackout date is closed, an absent technician is absent', () => {
    const rec = buildRouteAreas(input({ blackout: new Set([WEEKDAYS[0]]), absent: new Set([`${T1}:${WEEKDAYS[1]}`]) }));
    expect(dayOf(rec, T1, WEEKDAYS[0])).toMatchObject({ staffed: false, reason: 'closed', room: false, zips: [], zip_reason: 'not_staffed' });
    expect(dayOf(rec, T1, WEEKDAYS[1])).toMatchObject({ staffed: false, reason: 'absent', room: false, zips: [], zip_reason: 'not_staffed' });
  });

  test('a Sunday counts only with a stop that day', () => {
    const sunday = ['2026-11-22', '2026-11-23'];
    const without = buildRouteAreas(input({ dates: sunday }));
    expect(dayOf(without, T1, sunday[0])).toMatchObject({ staffed: false, reason: 'sunday_no_stops' });
    const withStop = buildRouteAreas(input({ dates: sunday, stops: [stop({ date: sunday[0] })] }));
    expect(dayOf(withStop, T1, sunday[0])).toMatchObject({ staffed: true, reason: null, stops: 1 });
  });

  test('an unclaimed hold or a windowless placeholder does not staff a Sunday, and still holds its time', () => {
    const sunday = ['2026-11-22', '2026-11-23'];
    const holdOnly = buildRouteAreas(input({ dates: sunday, stops: [stop({ date: sunday[0], booked: false })] }));
    expect(dayOf(holdOnly, T1, sunday[0])).toMatchObject({
      staffed: false, reason: 'sunday_no_stops', stops: 1, booked_min: 60, room: false, zip_reason: 'not_staffed',
    });
    const withBooked = buildRouteAreas(input({
      dates: sunday, limits: { ...LIMITS, sunday_limit: 4 }, stops: [stop({ date: sunday[0], booked: false }), stop({ date: sunday[0], booked: true })],
    }));
    expect(dayOf(withBooked, T1, sunday[0])).toMatchObject({ staffed: true, reason: null, stops: 2, open_stops: 2, booked_min: 120 });
    // A weekday does not need a booked stop.
    expect(dayOf(buildRouteAreas(input({ stops: [stop({ booked: false })] })), T1, WEEKDAYS[1]).staffed).toBe(true);
  });

  test('today after the shift ends: no shift left, no room', () => {
    const rec = buildRouteAreas(input({ nowMin: 19 * 60, stops: [stop({ date: WEEKDAYS[0] })] }));
    expect(dayOf(rec, T1, WEEKDAYS[0])).toMatchObject({ shift_min: 0, open_min: 0, room: false, zip_reason: 'full' });
    expect(dayOf(rec, T1, WEEKDAYS[1]).shift_min).toBe(600);
  });

  test('today before the shift starts keeps the whole shift; mid-shift counts the rest', () => {
    expect(dayOf(buildRouteAreas(input({ nowMin: 6 * 60 })), T1, WEEKDAYS[0]).shift_min).toBe(600);
    expect(dayOf(buildRouteAreas(input({ nowMin: 14 * 60 })), T1, WEEKDAYS[0]).shift_min).toBe(240);
  });

  test('done stops stay in stops and areas but not in booked or drive minutes', () => {
    const rec = buildRouteAreas(input({ stops: [stop({ done: true }), stop({ zip: '34203' })] }));
    const d = dayOf(rec, T1, WEEKDAYS[1]);
    expect(d).toMatchObject({ stops: 2, stops_left: 1, booked_min: 60, drive_min: 20, open_min: 520 });
    expect(d.areas).toEqual([{ area: 'a-north', stops: 1, stops_left: 0 }, { area: 'b-mid', stops: 1, stops_left: 1 }]);
  });

  test('a visit with one service done keeps only the minutes of the rest, with one drive', () => {
    const rec = buildRouteAreas(input({ stops: [stop({ minutes: 120, minutesLeft: 45 })] }));
    expect(dayOf(rec, T1, WEEKDAYS[1])).toMatchObject({ stops: 1, stops_left: 1, booked_min: 45, drive_min: 20, open_min: 535 });
    const unassigned = buildRouteAreas(input({ stops: [stop({ technicianId: null, minutes: 120, minutesLeft: 45 })] }));
    expect(unassigned.unassigned[1]).toMatchObject({ stops: 1, minutes: 120, stops_left: 1, minutes_left: 45 });
    expect(dayOf(unassigned, T1, WEEKDAYS[1])).toMatchObject({ booked_min: 45, drive_min: 20 });
  });

  test('unassigned work still to do takes a place under every technician\'s stop limit', () => {
    // Limit 6: five own stops and one unassigned stop still to do leave no stop, whatever the minutes say.
    const five = Array.from({ length: 5 }, () => stop({ minutes: 30 }));
    const rec = buildRouteAreas(input({ stops: [...five, stop({ technicianId: null, minutes: 30 })] }));
    const d = dayOf(rec, T1, WEEKDAYS[1]);
    expect(d).toMatchObject({ stops: 5, limit: 6, open_stops: 0, room: false, zips: [], zip_reason: 'full' });
    expect(d.open_min).toBeGreaterThanOrEqual(80);
    // Done unassigned work takes no place.
    const done = buildRouteAreas(input({ stops: [...five, stop({ technicianId: null, minutes: 30, done: true })] }));
    expect(dayOf(done, T1, WEEKDAYS[1])).toMatchObject({ open_stops: 1, room: true });
  });

  test('unassigned not-done work reduces the open minutes; done unassigned work does not', () => {
    const rec = buildRouteAreas(input({
      techIds: [T1, T2],
      stops: [
        stop({ technicianId: null, minutes: 90 }),
        stop({ technicianId: null, minutes: 60, done: true }),
        stop(),
      ],
    }));
    expect(rec.unassigned).toEqual([
      { date: WEEKDAYS[0], stops: 0, minutes: 0, stops_left: 0, minutes_left: 0 },
      { date: WEEKDAYS[1], stops: 2, minutes: 150, stops_left: 1, minutes_left: 90 },
    ]);
    // T1: own 60 + unassigned 90 = 150 booked; drive 20 * (1 + 1) = 40; 600 - 190 = 410
    expect(dayOf(rec, T1, WEEKDAYS[1])).toMatchObject({ booked_min: 150, drive_min: 40, open_min: 410, open_stops: 4 });
    // T2 has no stops of his own and still carries the unassigned work
    expect(dayOf(rec, T2, WEEKDAYS[1])).toMatchObject({ stops: 0, booked_min: 90, drive_min: 20, open_min: 490, open_stops: 5 });
  });

  test('a stop whose ZIP is missing or outside the territory counts as unmapped', () => {
    const rec = buildRouteAreas(input({ stops: [stop(), stop({ zip: null }), stop({ zip: '99999' })] }));
    const d = dayOf(rec, T1, WEEKDAYS[1]);
    expect(d.unmapped_stops).toBe(2);
    expect(d.stops).toBe(3);
    expect(d.areas).toEqual([{ area: 'a-north', stops: 1, stops_left: 1 }]);
  });

  test('an empty day takes the ZIPs the technician owns in the territory', () => {
    const territory = [...TERRITORY, { zip: '34205', area: 'c-south', technicianId: T1 }, { zip: '34199', area: 'd-far', technicianId: 99 }];
    const d = dayOf(buildRouteAreas(input({ territory })), T1, WEEKDAYS[1]);
    expect(d).toMatchObject({ stops: 0, room: true, zip_source: 'territory', zip_reason: null, zips: ['34205'] });
  });

  test('an empty day with no owned ZIPs lists none', () => {
    expect(dayOf(buildRouteAreas(input()), T1, WEEKDAYS[1])).toMatchObject({
      room: true, zips: [], zip_source: null, zip_reason: 'empty_day_no_territory',
    });
  });

  test('stops that map to no area list no ZIPs', () => {
    const d = dayOf(buildRouteAreas(input({ stops: [stop({ zip: null }), stop({ zip: '99999' })] })), T1, WEEKDAYS[1]);
    expect(d).toMatchObject({ room: true, zips: [], zip_source: null, zip_reason: 'no_mapped_stops', areas: [] });
  });

  test('a technician id is compared as a string', () => {
    const rec = buildRouteAreas(input({ techIds: [7], stops: [stop({ technicianId: '7' })], absent: new Set([`7:${WEEKDAYS[0]}`]) }));
    expect(rec.technicians[0].id).toBe('7');
    expect(dayOf(rec, '7', WEEKDAYS[1]).stops).toBe(1);
    expect(dayOf(rec, '7', WEEKDAYS[0]).reason).toBe('absent');
  });

  test('the record carries the run time, the ad-hours flag and the rule inputs', () => {
    const rec = buildRouteAreas(input({ nowMin: 6 * 60 + 59 }));
    expect(rec).toMatchObject({ at: '2026-11-23T14:00:00.000Z', tick: '2026-11-23T06', dates: WEEKDAYS, hour_et: 6, in_ad_hours: false });
    expect(rec.rule).toMatchObject({ now_min: 419, slot_min: 80, limits: LIMITS });
    expect(buildRouteAreas(input({ nowMin: 7 * 60 })).in_ad_hours).toBe(true);
    expect(buildRouteAreas(input({ nowMin: 18 * 60 + 59 })).in_ad_hours).toBe(true);
    expect(buildRouteAreas(input({ nowMin: 19 * 60 })).in_ad_hours).toBe(false);
  });
});

describe('buildRouteAreas: limits by weekday', () => {
  test('weekday, Saturday and Sunday limits give the open stops', () => {
    // Fri 11-20 is not used; Sat 11-21 and Sun 11-22, then Mon 11-23
    const sat = buildRouteAreas(input({ dates: ['2026-11-21', '2026-11-22'], stops: [stop({ date: '2026-11-21' }), stop({ date: '2026-11-22' }), stop({ date: '2026-11-22' }), stop({ date: '2026-11-22' })] }));
    expect(dayOf(sat, T1, '2026-11-21')).toMatchObject({ limit: 4, stops: 1, open_stops: 3 });
    expect(dayOf(sat, T1, '2026-11-22')).toMatchObject({ limit: 2, stops: 3, open_stops: 0 });
    expect(dayOf(buildRouteAreas(input({ stops: [stop()] })), T1, WEEKDAYS[1])).toMatchObject({ limit: 6, open_stops: 5 });
  });
});

describe('buildRouteAreas: service lines', () => {
  // T1 stops in a-north, T2 stops in b-mid, both with room on both dates.
  const twoTechs = (over = {}) => input({
    techIds: [T1, T2],
    stops: [stop({ date: WEEKDAYS[0] }), stop(), stop({ technicianId: T2, date: WEEKDAYS[0], zip: '34203' }), stop({ technicianId: T2, zip: '34203' })],
    ...over,
  });

  test('no card: both lines follow every staffed technician, with the unions', () => {
    const rec = buildRouteAreas(twoTechs({ lineCard: { general: null, lawn: { homeId: null, gapId: null } }, absent: new Set([`${T2}:${WEEKDAYS[0]}`]) }));
    for (const name of ['pest', 'lawn']) {
      expect(rec.lines[name].days[0]).toMatchObject({ date: WEEKDAYS[0], technician_ids: [T1], zips: ['34201', '34202'] });
      expect(rec.lines[name].days[1]).toMatchObject({ technician_ids: [T1, T2], zips: ['34201', '34202', '34203'] });
      expect(rec.lines[name].zips).toEqual(['34201', '34202', '34203']);
      expect(rec.lines[name].areas).toEqual(['a-north', 'b-mid']);
    }
    expect(rec.lines.pest.card_line).toBe('general');
    expect(rec.lines.lawn.card_line).toBe('lawn');
    expect(rec.lines.pest.days[1].open_min).toBe(dayOf(rec, T1, WEEKDAYS[1]).open_min + dayOf(rec, T2, WEEKDAYS[1]).open_min);
  });

  test('pest follows its home technician; the gap technician when home is absent; nobody when both are out', () => {
    const card = { general: { homeId: T1, gapId: T2 }, lawn: null };
    const home = buildRouteAreas(twoTechs({ lineCard: card }));
    expect(home.lines.pest.days.map((d) => d.technician_ids)).toEqual([[T1], [T1]]);
    expect(home.lines.pest.zips).toEqual(['34201', '34202']);
    expect(home.lines.pest.areas).toEqual(['a-north']);

    const gap = buildRouteAreas(twoTechs({ lineCard: card, absent: new Set([`${T1}:${WEEKDAYS[1]}`]) }));
    expect(gap.lines.pest.days.map((d) => d.technician_ids)).toEqual([[T1], [T2]]);
    expect(gap.lines.pest.days[1].zips).toEqual(['34203']);
    expect(gap.lines.pest.zips).toEqual(['34201', '34202', '34203']);

    const none = buildRouteAreas(twoTechs({ lineCard: card, absent: new Set([`${T1}:${WEEKDAYS[1]}`, `${T2}:${WEEKDAYS[1]}`]) }));
    expect(none.lines.pest.days[1]).toMatchObject({ technician_ids: [], open_min: 0, zips: [] });
  });

  test('a full home technician: the line follows the gap technician who has room', () => {
    const card = { general: { homeId: T1, gapId: T2 }, lawn: null };
    // T1 is at his limit on the second date; T2 has one stop there.
    const full = Array.from({ length: 6 }, () => stop({ minutes: 30 }));
    const rec = buildRouteAreas(input({ techIds: [T1, T2], lineCard: card, stops: [...full, stop({ technicianId: T2, zip: '34203' })] }));
    expect(dayOf(rec, T1, WEEKDAYS[1]).room).toBe(false);
    expect(rec.lines.pest.days[1]).toMatchObject({ technician_ids: [T2], zips: ['34203'] });
    expect(rec.lines.pest.days[1].open_min).toBe(dayOf(rec, T2, WEEKDAYS[1]).open_min);
    // The first date: T1 has room, so the line stays with the home technician.
    expect(rec.lines.pest.days[0].technician_ids).toEqual([T1]);

    // Both full: the line stays with the home technician and lists no ZIPs.
    const both = buildRouteAreas(input({
      techIds: [T1, T2], lineCard: card, stops: [...full, ...Array.from({ length: 6 }, () => stop({ technicianId: T2, minutes: 30, zip: '34203' }))],
    }));
    expect(both.lines.pest.days[1]).toMatchObject({ technician_ids: [T1], open_min: 0, zips: [] });
  });

  test('a technician who is off for a line is not followed by it', () => {
    // With a card: the home technician is off for general pest, so pest follows the gap technician.
    const carded = buildRouteAreas(twoTechs({ lineCard: { general: { homeId: T1, gapId: T2 }, lawn: null }, lineOff: [`${T1}:general`] }));
    expect(carded.lines.pest.days.map((d) => d.technician_ids)).toEqual([[T2], [T2]]);
    expect(carded.lines.pest.areas).toEqual(['b-mid']);
    // With no card: lawn follows only the technician who can take lawn; pest still follows both.
    const open = buildRouteAreas(twoTechs({ lineOff: [`${T2}:lawn`] }));
    expect(open.lines.lawn.days.map((d) => d.technician_ids)).toEqual([[T1], [T1]]);
    expect(open.lines.lawn.areas).toEqual(['a-north']);
    expect(open.lines.pest.days[1].technician_ids).toEqual([T1, T2]);
    expect(open.rule.line_off).toEqual([`${T2}:lawn`]);
  });

  test('lawn follows its own card entry, apart from pest', () => {
    const rec = buildRouteAreas(twoTechs({ lineCard: { general: { homeId: T1, gapId: null }, lawn: { homeId: T2, gapId: T1 } } }));
    expect(rec.lines.pest.days[0].technician_ids).toEqual([T1]);
    expect(rec.lines.lawn.days[0].technician_ids).toEqual([T2]);
    expect(rec.lines.lawn.areas).toEqual(['b-mid']);
    expect(rec.areas).toEqual(['a-north', 'b-mid']);
    expect(rec.zips).toEqual(['34201', '34202', '34203']);
  });

  test('a home technician who is not assignable (not in techIds) falls to the gap technician', () => {
    const rec = buildRouteAreas(twoTechs({ lineCard: { general: { homeId: 'ghost', gapId: T2 }, lawn: null } }));
    expect(rec.lines.pest.days[0].technician_ids).toEqual([T2]);
  });

  test('a line day sums open minutes only over technicians with room', () => {
    const full = Array.from({ length: 7 }, () => stop());
    const rec = buildRouteAreas(input({ techIds: [T1, T2], stops: full }));
    expect(dayOf(rec, T1, WEEKDAYS[1]).room).toBe(false);
    expect(rec.lines.pest.days[1].technician_ids).toEqual([T1, T2]);
    expect(rec.lines.pest.days[1].open_min).toBe(dayOf(rec, T2, WEEKDAYS[1]).open_min);
    expect(rec.lines.pest.days[1].zips).toEqual([]);
  });
});

// A fake knex for the save: the reads the loader makes, plus system_settings.
// conn.transaction runs its body on the same fake and undoes the body's writes when it throws, as Postgres does.
// failKey makes the write of that key fail. Every system_settings call outside a transaction is counted in `loose`.
function fakeConn({
  stopRows = [], history, last, targets = null, territory = TERRITORY, lineRows = [], techs = [{ id: T1 }], failKey = null,
  capRows = [], routeCheckRow = null,
} = {}) {
  const store = {};
  if (history !== undefined) store[HISTORY_KEY] = history;
  if (last !== undefined) store[LAST_KEY] = last;
  const upserts = [];
  const state = { inTransaction: false, loose: 0, routeCheckWhere: null, routeCheckStatuses: null, capIds: null };
  const conn = jest.fn((table) => {
    if (table === 'system_settings') {
      if (!state.inTransaction) state.loose += 1;
      return {
        where: jest.fn(({ key }) => ({ first: () => Promise.resolve(key in store ? { key, value: store[key] } : null) })),
        insert: jest.fn((row) => ({
          onConflict: jest.fn(() => ({
            merge: jest.fn((patch) => {
              if (row.key === failKey) return Promise.reject(new Error(`write of ${row.key} failed`));
              store[row.key] = row.value;
              upserts.push({ row, patch });
              return Promise.resolve();
            }),
          })),
        })),
      };
    }
    if (table === 'technicians') return { select: () => Promise.resolve(techs) };
    if (table === 'territory_zips') return { select: () => Promise.resolve(territory.map((t) => ({ zip: t.zip, area: t.area, technician_id: t.technicianId }))) };
    if (table === 'ad_targets') return { first: () => Promise.resolve(targets) };
    if (table === 'service_line_techs') return { whereIn: () => ({ select: () => Promise.resolve(lineRows) }) };
    if (table === 'technician_capabilities') {
      return { whereIn: (_col, ids) => { state.capIds = ids; return { whereIn: () => ({ select: () => Promise.resolve(capRows) }) }; } };
    }
    if (table === 'route_check_runs') {
      return {
        where: (filter) => {
          state.routeCheckWhere = filter;
          return { whereIn: (_col, statuses) => { state.routeCheckStatuses = statuses; return { orderBy: () => ({ first: () => Promise.resolve(routeCheckRow) }) }; } };
        },
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });
  conn.raw = jest.fn(() => Promise.resolve({ rows: stopRows }));
  conn.transaction = jest.fn(async (body) => {
    const before = { ...store };
    const mark = upserts.length;
    state.inTransaction = true;
    try {
      return await body(conn);
    } catch (err) {
      for (const key of Object.keys(store)) delete store[key];
      Object.assign(store, before);
      upserts.length = mark;
      throw err;
    } finally {
      state.inTransaction = false;
    }
  });
  return { conn, store, upserts, state };
}

describe('recordRouteAreas', () => {
  // Mon 2026-11-23 10:15 ET (15:15Z, EST)
  const NOW = new Date('2026-11-23T15:15:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
    getBlackoutDates.mockResolvedValue(new Set());
    absentTechDays.mockResolvedValue(new Set());
  });

  test('reads the two dates and the gap rule row filter, writes both keys', async () => {
    const { conn, store, upserts, state } = fakeConn({
      stopRows: [
        { technician_id: T1, day: '2026-11-23', zip: '34201', minutes: 60, minutes_left: 0, done: true, booked: true },
        { technician_id: T1, day: '2026-11-24', zip: '34203', minutes: '120', minutes_left: '90', done: false, booked: true },
        { technician_id: null, day: '2026-11-24', zip: null, minutes: 60, minutes_left: 60, done: false, booked: false },
      ],
      lineRows: [{ service_category: 'general', home_technician_id: T1, gap_technician_id: T1 }],
    });
    const record = await recordRouteAreas({ now: NOW, conn });

    expect(getBlackoutDates).toHaveBeenCalledWith('2026-11-23', '2026-11-24', conn, { strict: true });
    const [sql, bindings] = conn.raw.mock.calls[0];
    expect(bindings).toEqual(['2026-11-23', '2026-11-24', ...NOT_A_ROUTE_STOP_STATUSES]);
    expect(sql).toMatch(/ss\.status NOT IN \(\?, \?, \?, \?\)/);
    expect(sql).toMatch(/ss\.reservation_expires_at IS NULL OR ss\.reservation_expires_at > now\(\)/);
    expect(sql).toMatch(/ss\.visit_id IS NOT NULL/);
    // A live hold with no customer yet is its own stop: without the row id its key would be NULL.
    expect(sql).toMatch(/COALESCE\(ss\.customer_id::text, 'hold:' \|\| ss\.id::text\)/);
    // The minutes left skip a completed service of a part-done visit.
    expect(sql).toMatch(/FILTER \(WHERE ss\.status <> 'completed'\), 0\)::int AS minutes_left/);
    // A stored 0 is a missing estimate: the catalog's minutes, else 60.
    expect(sql.match(/COALESCE\(NULLIF\(ss\.estimated_duration_minutes, 0\), NULLIF\(sv\.default_duration_minutes, 0\), 60\)/g)).toHaveLength(2);
    // A booked stop is the route check's: a claimed row that dispatch keeps.
    expect(sql).toMatch(/bool_or\(\(ss\.customer_id IS NOT NULL OR ss\.reservation_expires_at IS NULL\)\s+AND \(ss\.window_start IS NOT NULL OR COALESCE\(ss\.time_window, ''\) <> '' OR ss\.status IN \('completed', 'en_route', 'on_site'\)\)\) AS booked/);

    expect(record.dates).toEqual(['2026-11-23', '2026-11-24']);
    expect(record.hour_et).toBe(10);
    expect(record.tick).toBe('2026-11-23T10');
    expect(record.rule.now_min).toBe(615);
    expect(record.rule.line_card.general).toEqual({ homeId: T1, gapId: null });
    expect(record.rule.line_card.lawn).toBeNull();
    expect(record.rule.limits).toMatchObject({ weekday_limit: expect.any(Number) });
    const tue = dayOf(record, T1, '2026-11-24');
    expect(tue).toMatchObject({ stops: 1, booked_min: 90 + 60, zips: ['34203'] });
    expect(dayOf(record, T1, '2026-11-23')).toMatchObject({ stops: 1, stops_left: 0, shift_min: 1080 - 615 });

    expect(Object.keys(store).sort()).toEqual([HISTORY_KEY, LAST_KEY].sort());
    expect(JSON.parse(store[LAST_KEY])).toEqual(JSON.parse(JSON.stringify(record)));
    const last = upserts.find((u) => u.row.key === LAST_KEY);
    expect(last.row).toMatchObject({ category: 'ads', description: 'Latest ads route-areas record (shadow)' });
    expect(last.patch).toEqual({ value: store[LAST_KEY], updated_at: NOW });
    const history = JSON.parse(store[HISTORY_KEY]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ at: record.at, tick: '2026-11-23T10', hour_et: 10 });
    // Both rows go in one transaction; nothing touches system_settings outside it.
    expect(conn.transaction).toHaveBeenCalledTimes(1);
    expect(state.loose).toBe(0);
    expect(upserts.map((u) => u.row.key)).toEqual([LAST_KEY, HISTORY_KEY]);
  });

  test('reads today\'s newest route check and uses it for tomorrow; a stale run is not used', async () => {
    const stopRows = [{ technician_id: T1, day: '2026-11-24', zip: '34201', minutes: 60, minutes_left: 60, done: false, booked: true }];
    const days = [{ date: '2026-11-24', technician_id: T1, staffed: true, stops: 1, slots: 0, openings: [] }];
    // 45 minutes before the run; jsonb arrives parsed.
    const fresh = fakeConn({ stopRows, routeCheckRow: { run_at: new Date('2026-11-23T14:30:00Z'), days } });
    const record = await recordRouteAreas({ now: NOW, conn: fresh.conn });
    expect(fresh.state.routeCheckWhere).toEqual({ service_date: '2026-11-23' });
    expect(fresh.state.routeCheckStatuses).toEqual(['completed', 'completed_with_errors']);
    expect(record.rule.route_check_at).toBe('2026-11-23T14:30:00.000Z');
    expect(dayOf(record, T1, '2026-11-24')).toMatchObject({ open_min: 520, room_basis: 'route_check', route_slots: 0, room: false });

    // A text value parses too; a day the route check skipped falls to the minute total.
    const skipped = fakeConn({
      stopRows,
      routeCheckRow: { run_at: '2026-11-23T14:30:00Z', days: JSON.stringify([{ date: '2026-11-24', technician_id: T1, staffed: true, skip: 'NO_SIMULATION' }]) },
    });
    expect(dayOf(await recordRouteAreas({ now: NOW, conn: skipped.conn }), T1, '2026-11-24')).toMatchObject({ room_basis: 'minutes', route_slots: null, room: true });

    // 195 minutes old: over the 150-minute limit.
    const stale = fakeConn({ stopRows, routeCheckRow: { run_at: new Date('2026-11-23T12:00:00Z'), days } });
    const old = await recordRouteAreas({ now: NOW, conn: stale.conn });
    expect(old.rule.route_check_at).toBeNull();
    expect(dayOf(old, T1, '2026-11-24')).toMatchObject({ room_basis: 'minutes', room: true });

    // A run stamped after `now` is not used either.
    const ahead = fakeConn({ stopRows, routeCheckRow: { run_at: new Date('2026-11-23T15:30:00Z'), days } });
    expect((await recordRouteAreas({ now: NOW, conn: ahead.conn })).rule.route_check_at).toBeNull();
  });

  test('reads which technicians are off for a line', async () => {
    const { conn, state } = fakeConn({
      techs: [{ id: T2 }, { id: T1 }],
      capRows: [
        { technician_id: T2, service_category: 'lawn', capability_level: 'qualified', active: false },
        { technician_id: T1, service_category: 'lawn', capability_level: 'review_required', active: true },
      ],
    });
    const record = await recordRouteAreas({ now: NOW, conn });
    // Technician ids are sorted, so the record has one order on every run.
    expect(record.technicians.map((t) => t.id)).toEqual([T1, T2]);
    expect(state.capIds).toEqual([T1, T2]);
    expect(record.rule.line_off).toEqual([`${T2}:lawn`]);
    expect(record.lines.lawn.days[1].technician_ids).toEqual([T1]);
    expect(record.lines.pest.days[1].technician_ids).toEqual([T1, T2]);
  });

  test('a history write that fails leaves the latest record as it was, and throws', async () => {
    const { conn, store, upserts } = fakeConn({ last: '{"at":"before"}', history: '[{"at":"before"}]', failKey: HISTORY_KEY });
    await expect(recordRouteAreas({ now: NOW, conn })).rejects.toThrow(`write of ${HISTORY_KEY} failed`);
    expect(store[LAST_KEY]).toBe('{"at":"before"}');
    expect(store[HISTORY_KEY]).toBe('[{"at":"before"}]');
    expect(upserts).toHaveLength(0);
  });

  test('a second run of the same cron occurrence replaces its entry; another hour adds one', async () => {
    const { conn, store } = fakeConn();
    await recordRouteAreas({ now: NOW, conn });
    // The other app instance of a deploy, 40 seconds later in the same hour.
    const later = new Date(NOW.getTime() + 40e3);
    await recordRouteAreas({ now: later, conn });
    let history = JSON.parse(store[HISTORY_KEY]);
    expect(history.map((h) => h.tick)).toEqual(['2026-11-23T10']);
    expect(history[0].at).toBe(later.toISOString());
    expect(JSON.parse(store[LAST_KEY]).at).toBe(later.toISOString());

    await recordRouteAreas({ now: new Date(NOW.getTime() + 2 * 3600e3), conn });
    history = JSON.parse(store[HISTORY_KEY]);
    expect(history.map((h) => h.tick)).toEqual(['2026-11-23T10', '2026-11-23T12']);
  });

  test('a day whose ZIPs come from the technician\'s own territory keeps its ZIP list in the history', async () => {
    // T1 owns one of the two ZIPs of c-south: the area key alone cannot say which.
    const territory = [...TERRITORY, { zip: '34205', area: 'c-south', technicianId: T1 }];
    const { conn, store } = fakeConn({ territory });
    await recordRouteAreas({ now: NOW, conn });
    const entry = JSON.parse(store[HISTORY_KEY])[0];
    expect(entry.techs[0].days[1]).toMatchObject({ date: '2026-11-24', stops: 0, room: true, areas: {}, zip_source: 'territory', zips: ['34205'] });
    expect(entry.lines.pest.areas).toEqual(['c-south']);
    expect(entry.lines.pest.days[1]).toEqual({ date: '2026-11-24', technician_ids: [T1], open_min: 600 });
  });

  test('history keeps the last 120 compact entries, newest last: every number of the room test, no ZIP lists', async () => {
    const old = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => ({ at: `old-${i}` }));
    const { conn, store } = fakeConn({
      history: JSON.stringify(old),
      stopRows: [{ technician_id: T1, day: '2026-11-24', zip: '34201', minutes: 60, minutes_left: 60, done: false, booked: true }],
    });
    await recordRouteAreas({ now: NOW, conn });
    const history = JSON.parse(store[HISTORY_KEY]);
    expect(history).toHaveLength(HISTORY_MAX);
    expect(history[0].at).toBe('old-6');
    const entry = history.at(-1);
    expect(entry.at).toBe(NOW.toISOString());
    const weekdayLimit = JSON.parse(store[LAST_KEY]).rule.limits.weekday_limit;
    expect(entry.techs[0].days[1]).toEqual({
      date: '2026-11-24', staffed: true, reason: null, room: true, room_basis: 'minutes', route_slots: null,
      stops: 1, stops_left: 1, limit: weekdayLimit, open_stops: weekdayLimit - 1,
      shift_min: 600, booked_min: 60, drive_min: 20, open_min: 520, areas: { 'a-north': 1 }, zip_source: 'stops',
    });
    // The rule's numbers and the unassigned work stay with the entry: a past result can be counted again.
    expect(entry.rule).toEqual({
      now_min: 615, slot_min: 80, shift: { startMinutes: 480, endMinutes: 1080 },
      limits: { weekday_limit: weekdayLimit, saturday_limit: expect.any(Number), sunday_limit: expect.any(Number) },
      line_off: [], route_check_at: null,
    });
    expect(entry.unassigned).toEqual([
      { date: '2026-11-23', stops_left: 0, minutes_left: 0 },
      { date: '2026-11-24', stops_left: 0, minutes_left: 0 },
    ]);
    const d = entry.techs[0].days[1];
    expect(d.open_stops).toBe(d.limit - d.stops - entry.unassigned[1].stops_left);
    expect(d.open_min).toBe(d.shift_min - d.booked_min - d.drive_min);
    expect(Object.keys(entry.lines)).toEqual(['pest', 'lawn']);
    expect(entry.lines.pest).toEqual({
      areas: ['a-north'],
      open_min: expect.any(Number),
      days: [
        { date: '2026-11-23', technician_ids: [T1], open_min: expect.any(Number) },
        { date: '2026-11-24', technician_ids: [T1], open_min: 520 },
      ],
    });
    // A list that follows from the areas is not stored.
    expect(JSON.stringify(entry)).not.toMatch(/"zips"/);
  });

  test.each([
    ['corrupt JSON', '{not json'],
    ['a non-array value', '{"at":"x"}'],
  ])('%s in the stored history starts a new array', async (_name, stored) => {
    const { conn, store } = fakeConn({ history: stored });
    await recordRouteAreas({ now: NOW, conn });
    expect(JSON.parse(store[HISTORY_KEY])).toHaveLength(1);
  });

  test('a read that fails writes nothing and throws', async () => {
    const { conn, upserts } = fakeConn();
    getBlackoutDates.mockRejectedValue(new Error('blackout read failed'));
    await expect(recordRouteAreas({ now: NOW, conn })).rejects.toThrow('blackout read failed');
    expect(upserts).toHaveLength(0);
  });
});
