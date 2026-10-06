/**
 * Best-times rows (owner 2026-10-06): the availability strip's two rows of
 * four chips, their real-road drive numbers and their chance of rain.
 *
 * What this locks down:
 *  1. Row 1 is the picked date's four best hours; row 2 the four best date +
 *     hours in the 7 days from today, without the picked date, closed days
 *     or days off. Best = least added drive, then shortest drive in.
 *  2. With GATE_BEST_TIMES_ROAD_TIMES on, a chip's drive-in and added drive
 *     come from Google (in + out − base) and are cached; a chip with any
 *     leg missing keeps the model's numbers and says "estimate". Off, Google
 *     is never asked.
 *  3. A chip's rain is the highest NWS hourly chance across its window.
 *  4. No stop coordinates reach the serialized answer.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { GAP_LEGS } = require('../services/scheduling/find-time');
const { pickBestRows, buildBestRows, rainForWindow } = require('../services/scheduling/find-time-hints');
const { priceChipsOnRoads, _test } = require('../services/scheduling/hint-road-times');

const PREV = { lat: 27.4208, lng: -82.4929 };
const NEXT = { lat: 27.4111, lng: -82.4045 };
const NEW = { lat: 27.4606, lng: -82.5878 };

function hour(date, start, detour, driveIn, extra = {}) {
  const h = Number(start.slice(0, 2));
  return {
    date, start_time: start, end_time: `${String(h + 1).padStart(2, '0')}:00`,
    detour_minutes: detour, drive_in_minutes: driveIn, from_home_base: false, from_name: 'Stop A',
    technician: { id: 't1', name: 'Tech One' },
    [GAP_LEGS]: { prev: PREV, next: NEXT, newStop: NEW, prevEndMin: 12 * 60, prevIsHome: false, durationMinutes: 30 },
    ...extra,
  };
}

function day(date, hours, extra = {}) {
  return { date, status: hours.length ? 'open' : 'full', hours, ...extra };
}

describe('pickBestRows', () => {
  const days = [
    day('2026-10-06', [hour('2026-10-06', '15:00', 50, 20)]),
    day('2026-10-07', [hour('2026-10-07', '12:00', 30, 22), hour('2026-10-07', '13:00', 30, 18)]),
    day('2026-10-08', [
      hour('2026-10-08', '08:00', 43, 31), hour('2026-10-08', '10:00', 34, 25), hour('2026-10-08', '12:00', 34, 19),
      hour('2026-10-08', '13:00', 34, 19), hour('2026-10-08', '15:00', 55, 32),
    ]),
    day('2026-10-09', [hour('2026-10-09', '09:00', 5, 5)], { status: 'off' }),
    day('2026-10-11', [hour('2026-10-11', '09:00', 1, 1)], { closed: true }),
    day('2026-10-12', [hour('2026-10-12', '11:00', 46, 18)]),
    day('2026-10-13', [hour('2026-10-13', '09:00', 0, 3)]),
  ];

  test('row 1 is the picked date, least added drive then shortest drive in', () => {
    const { day: row } = pickBestRows(days, { pickedDate: '2026-10-08', today: '2026-10-06' });
    expect(row.map((h) => h.start_time)).toEqual(['12:00', '13:00', '10:00', '08:00']);
  });

  test('row 2 covers 7 days from today and skips the picked date, closed days and days off', () => {
    const rows = pickBestRows(days, { pickedDate: '2026-10-08', today: '2026-10-06' });
    expect(rows.week_to).toBe('2026-10-12');
    expect(rows.week.map((h) => `${h.date} ${h.start_time}`)).toEqual([
      '2026-10-07 13:00', '2026-10-07 12:00', '2026-10-12 11:00', '2026-10-06 15:00',
    ]);
  });
});

describe('priceChipsOnRoads', () => {
  const ENV = process.env.GATE_BEST_TIMES_ROAD_TIMES;
  afterEach(() => {
    if (ENV === undefined) delete process.env.GATE_BEST_TIMES_ROAD_TIMES;
    else process.env.GATE_BEST_TIMES_ROAD_TIMES = ENV;
    _test.roadCache.clear();
  });

  function fakeTravel(minutesByLeg) {
    const calls = [];
    return {
      calls,
      factory: () => ({
        preload: async (legs) => { calls.push(legs.length); },
        lookup: (leg) => {
          const key = `${leg.from === NEW ? 'new' : 'prev'}>${leg.to === NEW ? 'new' : (leg.to === NEXT ? 'next' : 'x')}`;
          const minutes = minutesByLeg[key];
          return minutes == null ? { minutes: 99, source: 'conservative_model' } : { minutes, source: 'google_traffic' };
        },
      }),
    };
  }

  test('gate off: model numbers, Google never asked', async () => {
    delete process.env.GATE_BEST_TIMES_ROAD_TIMES;
    const travel = fakeTravel({});
    const [chip] = await priceChipsOnRoads([hour('2026-10-08', '12:00', 34, 19)], { travelFactory: travel.factory });
    expect(chip).toMatchObject({ drive_in_minutes: 19, detour_minutes: 34, drive_source: 'estimate' });
    expect(travel.calls).toEqual([]);
  });

  test('gate on: in + out − base from Google, then served from the cache', async () => {
    process.env.GATE_BEST_TIMES_ROAD_TIMES = 'true';
    const travel = fakeTravel({ 'prev>new': 21, 'new>next': 28, 'prev>next': 15 });
    const [chip] = await priceChipsOnRoads([hour('2026-10-08', '12:00', 34, 19)], { travelFactory: travel.factory });
    expect(chip).toMatchObject({ drive_in_minutes: 21, detour_minutes: 34, drive_source: 'google' });
    expect(travel.calls).toEqual([3]);

    const again = fakeTravel({});
    const [cached] = await priceChipsOnRoads([hour('2026-10-08', '12:00', 34, 19)], { travelFactory: again.factory });
    expect(cached).toMatchObject({ drive_in_minutes: 21, drive_source: 'google' });
    expect(again.calls).toEqual([]);
  });

  test('a leg Google did not answer keeps the whole chip on the model', async () => {
    process.env.GATE_BEST_TIMES_ROAD_TIMES = 'true';
    const travel = fakeTravel({ 'prev>new': 21, 'prev>next': 15 });
    const [chip] = await priceChipsOnRoads([hour('2026-10-08', '12:00', 34, 19)], { travelFactory: travel.factory });
    expect(chip).toMatchObject({ drive_in_minutes: 19, detour_minutes: 34, drive_source: 'estimate' });
  });

  test('an unpinned neighbour is never priced', async () => {
    process.env.GATE_BEST_TIMES_ROAD_TIMES = 'true';
    const travel = fakeTravel({ 'prev>new': 21, 'new>next': 28, 'prev>next': 15 });
    const chip = hour('2026-10-08', '12:00', null, null);
    chip[GAP_LEGS] = { ...chip[GAP_LEGS], prev: null };
    const [out] = await priceChipsOnRoads([chip], { travelFactory: travel.factory });
    expect(out).toMatchObject({ drive_in_minutes: null, detour_minutes: null, drive_source: 'estimate' });
    expect(travel.calls).toEqual([]);
  });
});

describe('rain and the serialized rows', () => {
  const hourly = [
    { startTime: '2026-10-08T12:00:00-04:00', rainChance: 20 },
    { startTime: '2026-10-08T13:00:00-04:00', rainChance: 60 },
  ];

  test('a chip takes the highest hourly chance across its window', () => {
    expect(rainForWindow(hourly, '2026-10-08', '12:00', '13:00')).toBe(20);
    expect(rainForWindow(hourly, '2026-10-08', '12:00', '14:00')).toBe(60);
    expect(rainForWindow(hourly, '2026-10-09', '12:00', '13:00')).toBeNull();
    expect(rainForWindow(null, '2026-10-08', '12:00', '13:00')).toBeNull();
  });

  test('buildBestRows decorates rain, prices the picked verdict and never serializes pins', async () => {
    const days = [day('2026-10-08', [hour('2026-10-08', '12:00', 34, 19), hour('2026-10-08', '13:00', 34, 19)])];
    const picked = { start: '12:00', fits: true, detour_minutes: 34, drive_in_minutes: 19, [GAP_LEGS]: hour('2026-10-08', '12:00', 34, 19)[GAP_LEGS] };
    const out = await buildBestRows(days, {
      pickedDate: '2026-10-08', today: '2026-10-06', lat: 1, lng: 2, picked, spanMin: 60,
      deps: {
        priceChipsOnRoads: async (chips) => chips.map((c) => ({ ...c, drive_in_minutes: c.drive_in_minutes + 2, drive_source: 'google' })),
        hourlyRain: async () => hourly,
      },
    });
    expect(out.rows.day.map((c) => [c.start_time, c.drive_in_minutes, c.rain_chance])).toEqual([['12:00', 21, 20], ['13:00', 21, 60]]);
    expect(out.picked).toMatchObject({ fits: true, drive_in_minutes: 21, drive_source: 'google', rain_chance: 20 });
    const json = JSON.stringify({ rows: out.rows, picked: out.picked });
    expect(json).not.toContain('27.4');
  });
});
