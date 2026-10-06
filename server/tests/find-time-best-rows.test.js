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
const { pickBestRows, buildBestRows, rainForWindow, buildHintSummary } = require('../services/scheduling/find-time-hints');
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

  test('a same-day leg whose stop already ended leaves from now, not the past', () => {
    // 15:30 ET on the chip's own day; the previous stop ended at 12:00.
    const nowEt = { date: '2026-10-08', minute: 15 * 60 + 30 };
    const legs = _test.chipLegs(hour('2026-10-08', '16:00', 34, 19), nowEt);
    expect(legs.in.departureMin).toBe(15 * 60 + 31);
    expect(legs.base.departureMin).toBe(15 * 60 + 31);
    expect(legs.out.departureMin).toBe(16 * 60 + 30);
    expect(_test.chipLegs(hour('2026-10-09', '16:00', 34, 19), nowEt).in.departureMin).toBe(12 * 60);
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

  test('the picked verdict is priced over the window the form will save', async () => {
    const seen = [];
    const picked = { start: '12:00', fits: true, detour_minutes: 34, drive_in_minutes: 19, [GAP_LEGS]: hour('2026-10-08', '12:00', 34, 19)[GAP_LEGS] };
    const out = await buildBestRows([day('2026-10-08', [])], {
      pickedDate: '2026-10-08', today: '2026-10-06', lat: 1, lng: 2, picked, spanMin: 30, pickedEnd: '14:00',
      deps: {
        priceChipsOnRoads: async (chips) => { seen.push(...chips); return chips; },
        hourlyRain: async () => hourly,
      },
    });
    expect(seen[0]).toMatchObject({ end_time: '14:00' });
    expect(seen[0][GAP_LEGS].durationMinutes).toBe(120);
    expect(out.picked.rain_chance).toBe(60);
  });

  test('no chips: no forecast lookup', async () => {
    const hourlyRain = jest.fn(async () => hourly);
    await buildBestRows([day('2026-10-08', [])], {
      pickedDate: '2026-10-08', today: '2026-10-06', lat: 1, lng: 2,
      deps: { priceChipsOnRoads: async (chips) => chips, hourlyRain },
    });
    expect(hourlyRain).not.toHaveBeenCalled();
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

describe('opt-in', () => {
  test('a summary without bestRows has no rows and asks no one for rain or roads (Codex #6045 r2)', async () => {
    const plan = { summary: true, from: '2026-10-08', to: '2026-10-08', verdictDate: '2026-10-08' };
    const out = await buildHintSummary(plan, [hour('2026-10-08', '12:00', 34, 19)], {
      startedAt: Date.now(), today: '2026-10-06', target: { lat: 1, lng: 2 }, picked: null, spanMin: 60,
    });
    expect(out.summary.best).toBeUndefined();
    expect(out.summary.days[0].hours).toHaveLength(1);
  });
});

describe('capacity-mode chips (Codex #6045 r3-r7)', () => {
  const { _internals: { capacityLegs } } = require('../services/scheduling/find-time');
  const target = { id: 't', ...NEW };

  test('a middle stop shows the drive its own simulation drove', () => {
    const fit = { arrivals: [
      { id: 'a', arrival: '11:00', departure: '12:00', drive: 10 }, { id: 't', arrival: '12:19', departure: '12:49', drive: 19 },
    ] };
    expect(capacityLegs({ fit, target })).toEqual({ driveIn: 19, fromHome: false });
  });

  test('waiting for the window is not driving', () => {
    const fit = { origin: { isHome: true }, arrivals: [{ id: 't', arrival: '12:00', departure: '12:30', drive: 20 }] };
    expect(capacityLegs({ fit, target })).toEqual({ driveIn: 20, fromHome: true });
  });

  test("a first stop after today's completed visit does not claim home base", () => {
    const fit = { origin: { isHome: false }, arrivals: [{ id: 't', arrival: '13:20', departure: '14:00', drive: 20 }] };
    expect(capacityLegs({ fit, target })).toEqual({ driveIn: 20, fromHome: false });
  });

  test('no known origin: no drive in', () => {
    const fit = { arrivals: [{ id: 't', arrival: '08:30', departure: '09:00', drive: 30 }] };
    expect(capacityLegs({ fit, target })).toEqual({ driveIn: null, fromHome: null });
  });

  test('a capacity chip keeps the source its simulation priced it with; it is never re-priced', async () => {
    process.env.GATE_BEST_TIMES_ROAD_TIMES = 'true';
    try {
      const chip = { date: '2026-10-08', start_time: '12:00', end_time: '13:00', detour_minutes: 30, drive_in_minutes: 18, drive_source: 'google' };
      const factory = jest.fn();
      const [out] = await priceChipsOnRoads([chip], { travelFactory: factory });
      expect(out).toMatchObject({ drive_in_minutes: 18, drive_source: 'google' });
      expect(factory).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_BEST_TIMES_ROAD_TIMES;
    }
  });
});

describe('the day list matches the chips (Codex #6045 r7)', () => {
  test('an hour that is also a chip carries the chip numbers and rain', async () => {
    const plan = { summary: true, from: '2026-10-08', to: '2026-10-08', verdictDate: '2026-10-08' };
    jest.resetModules();
    jest.doMock('../services/scheduling/hint-road-times', () => ({
      priceChipsOnRoads: async (chips) => chips.map((c) => ({ ...c, drive_in_minutes: 21, drive_source: 'google' })),
    }));
    jest.doMock('../services/weather-forecast', () => ({ getHourlyRainOutlook: async () => [{ startTime: '2026-10-08T12:00:00-04:00', rainChance: 30 }] }));
    const hints = require('../services/scheduling/find-time-hints');
    const { GAP_LEGS: LEGS } = require('../services/scheduling/find-time');
    const slot = { ...hour('2026-10-08', '12:00', 34, 19), [LEGS]: hour('2026-10-08', '12:00', 34, 19)[GAP_LEGS] };
    const out = await hints.buildHintSummary(plan, [slot], {
      startedAt: Date.now(), today: '2026-10-06', target: { lat: 1, lng: 2 }, picked: null, spanMin: 60, bestRows: true,
    });
    expect(out.summary.days[0].hours[0]).toMatchObject({ drive_in_minutes: 21, drive_source: 'google', rain_chance: 30 });
    jest.dontMock('../services/scheduling/hint-road-times');
    jest.dontMock('../services/weather-forecast');
  });
});
