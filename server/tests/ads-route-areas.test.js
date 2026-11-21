// Ads follow the route, step 1 (record only): the pure record builder and the save. Nothing here touches a budget,
// a campaign or Google Ads; the save writes two system_settings rows (ads.route_areas.last / .history).

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
    expect(dayOf(rec, T1, WEEKDAYS[1])).toMatchObject({ booked_min: 150, drive_min: 40, open_min: 410 });
    // T2 has no stops of his own and still carries the unassigned work
    expect(dayOf(rec, T2, WEEKDAYS[1])).toMatchObject({ stops: 0, booked_min: 90, drive_min: 20, open_min: 490 });
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
    expect(rec).toMatchObject({ at: '2026-11-23T14:00:00.000Z', dates: WEEKDAYS, hour_et: 6, in_ad_hours: false });
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
function fakeConn({ stopRows = [], history, targets = null, territory = TERRITORY, lineRows = [], techs = [{ id: T1 }] } = {}) {
  const store = {};
  if (history !== undefined) store[HISTORY_KEY] = history;
  const upserts = [];
  const conn = jest.fn((table) => {
    if (table === 'system_settings') {
      return {
        where: jest.fn(({ key }) => ({ first: () => Promise.resolve(key in store ? { key, value: store[key] } : null) })),
        insert: jest.fn((row) => ({
          onConflict: jest.fn(() => ({
            merge: jest.fn((patch) => { store[row.key] = row.value; upserts.push({ row, patch }); return Promise.resolve(); }),
          })),
        })),
      };
    }
    if (table === 'technicians') return { select: () => Promise.resolve(techs) };
    if (table === 'territory_zips') return { select: () => Promise.resolve(territory.map((t) => ({ zip: t.zip, area: t.area, technician_id: t.technicianId }))) };
    if (table === 'ad_targets') return { first: () => Promise.resolve(targets) };
    if (table === 'service_line_techs') return { whereIn: () => ({ select: () => Promise.resolve(lineRows) }) };
    throw new Error(`Unexpected table in test: ${table}`);
  });
  conn.raw = jest.fn(() => Promise.resolve({ rows: stopRows }));
  return { conn, store, upserts };
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
    const { conn, store, upserts } = fakeConn({
      stopRows: [
        { technician_id: T1, day: '2026-11-23', zip: '34201', minutes: 60, done: true },
        { technician_id: T1, day: '2026-11-24', zip: '34203', minutes: '90', done: false },
        { technician_id: null, day: '2026-11-24', zip: null, minutes: 60, done: false },
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

    expect(record.dates).toEqual(['2026-11-23', '2026-11-24']);
    expect(record.hour_et).toBe(10);
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
    expect(history[0]).toMatchObject({ at: record.at, hour_et: 10 });
  });

  test('history keeps the last 120 compact entries, newest last, with no ZIP lists', async () => {
    const old = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => ({ at: `old-${i}` }));
    const { conn, store } = fakeConn({
      history: JSON.stringify(old),
      stopRows: [{ technician_id: T1, day: '2026-11-24', zip: '34201', minutes: 60, done: false }],
    });
    await recordRouteAreas({ now: NOW, conn });
    const history = JSON.parse(store[HISTORY_KEY]);
    expect(history).toHaveLength(HISTORY_MAX);
    expect(history[0].at).toBe('old-6');
    const entry = history.at(-1);
    expect(entry.at).toBe(NOW.toISOString());
    const weekdayLimit = JSON.parse(store[LAST_KEY]).rule.limits.weekday_limit;
    expect(entry.techs[0].days[1]).toEqual({
      date: '2026-11-24', staffed: true, room: true, stops: 1, stops_left: 1, open_stops: weekdayLimit - 1, open_min: 520, areas: { 'a-north': 1 },
    });
    expect(Object.keys(entry.lines)).toEqual(['pest', 'lawn']);
    expect(entry.lines.pest).toEqual({ areas: ['a-north'], open_min: expect.any(Number) });
    expect(JSON.stringify(entry)).not.toMatch(/zips/);
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
