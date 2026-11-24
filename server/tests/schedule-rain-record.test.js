/**
 * Schedule rain record (services/scheduling/rain-schedule-record.js). Test mode: it records what the rain rule would do
 * to the next work day (a same-day re-time, or a one-off move when the whole day is wet, at most 10 a day), freezes the
 * 2 PM decision, rechecks beside it, and scores past days against measured radar rain. It changes nothing: it writes
 * only its own system_settings rows. rain-pass's own verdicts are covered by auto-dispatch-rain-pass.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({ getNwsHourlyRain: jest.fn(), getHourlyRainOutlook: jest.fn() }));
jest.mock('../services/mrms-qpe', () => ({ fetchMrmsDailyRain: jest.fn() }));

const fs = require('fs');
const path = require('path');
const weather = require('../services/weather-forecast');
const record = require('../services/scheduling/rain-schedule-record');
const rainPass = require('../services/auto-dispatch/rain-pass');
const { parseETDateTime } = require('../utils/datetime-et');

const WED = '2026-11-25';
const THU = '2026-11-26';
// Tuesday 2:06 PM ET: the cutoff run for Wednesday. Wednesday 6:06 AM ET: its recheck.
const TUE_CUTOFF = parseETDateTime('2026-11-24T14:06');
const TUE_RETRY = parseETDateTime('2026-11-24T15:06');
const WED_RECHECK = parseETDateTime('2026-11-25T06:06');

// NWS-shaped hours for 4 dates; `wet` maps a date to its wet hours (or 'all'): those read 80%, every other hour 10%.
const hoursFor = (wet = {}) => ['2026-11-24', WED, THU, '2026-11-27'].flatMap((date) => Array.from({ length: 24 }, (_, h) => ({
  startTime: `${date}T${String(h).padStart(2, '0')}:00:00-05:00`,
  rainChance: wet[date] === 'all' || (wet[date] || []).includes(h) ? 80 : 10,
})));
// Wednesday rain from 13:00 to 17:00 only: a dry morning exists. Wednesday all day: no dry hour and a wholly wet day.
const AFTERNOON = { [WED]: [13, 14, 15, 16, 17] };
const ALL_DAY = { [WED]: 'all' };

let n = 0;
const stop = (extra = {}) => {
  n += 1;
  return {
    id: `v${String(n).padStart(2, '0')}`, customer_id: `c${n}`, service_type: 'Quarterly Pest Control Service',
    service_key_snapshot: 'pest_general_quarterly', technician_id: `t${n}`, status: 'confirmed', scheduled_date: WED,
    window_start: '14:00:00', window_end: '15:00:00', point: { lat: 27.4 + n / 1000, lng: -82.4 },
    ...extra,
  };
};

function deps(rows, extra = {}) {
  return {
    loadStops: jest.fn(async () => rainPass._test.groupStops(rows)),
    withCatalogKeys: jest.fn(async (items) => items.map((i) => ({ name: i.name, serviceKey: i.serviceKey, findingsType: null }))),
    rainOut: { loadOccupancy: jest.fn(async () => ({ rows: [] })), conflictsForTarget: jest.fn(() => []) },
    dayHours: { DAY_START_HOUR: 8, DAY_END_HOUR: 17 },
    blackoutDates: jest.fn(async () => new Set()),
    loadPoints: jest.fn(async (_conn, ids) => new Map(ids.map((id, i) => [String(id), { lat: 27.4 + i / 100, lng: -82.4 }]))),
    ...extra,
  };
}

// A fake db that keeps system_settings in memory and notes every table it is asked for and every write.
function fakeConn(settings = {}) {
  const store = { ...settings };
  const writes = [];
  const tables = [];
  const builder = (table) => ({
    where: (cond) => ({ first: async () => (store[cond.key] != null ? { key: cond.key, value: store[cond.key] } : undefined) }),
    insert: (row) => { writes.push(table); return { onConflict: () => ({ merge: async () => { store[row.key] = row.value; } }) }; },
    update: () => { writes.push(table); return Promise.resolve(0); },
    del: () => { writes.push(table); return Promise.resolve(0); },
  });
  const conn = jest.fn((table) => { tables.push(table); return builder(table); });
  conn.transaction = async (cb) => cb((table) => { tables.push(table); return builder(table); });
  Object.assign(conn, { store, writes, tables });
  return conn;
}

const daysOf = (conn) => JSON.parse(conn.store[record.DAYS_KEY]);
const run = (opts) => record.recordScheduleRain({ fetchRain: jest.fn(), ...opts });

beforeEach(() => { n = 0; jest.clearAllMocks(); });
afterEach(() => { delete process.env.GATE_MULTI_TECH_CONFIRM; });

describe('targetDay', () => {
  test('from 2 PM the next work day (the cutoff), before 2 PM today (a recheck), never a Sunday', () => {
    expect(record.targetDay(TUE_CUTOFF)).toMatchObject({ day: WED, kind: 'cutoff' });
    expect(record.targetDay(WED_RECHECK)).toMatchObject({ day: WED, kind: 'recheck' });
    // Sunday is no work day; a Sunday morning decides nothing yet.
    // The cutoff is the calendar day before the target: Saturday 2 PM is not Monday's cutoff, Sunday 2 PM is.
    expect(record.targetDay(parseETDateTime('2026-11-28T14:06'))).toMatchObject({ day: '2026-11-30', kind: 'none' });
    expect(record.targetDay(parseETDateTime('2026-11-29T14:06'))).toMatchObject({ day: '2026-11-30', kind: 'cutoff' });
    expect(record.targetDay(parseETDateTime('2026-11-29T06:06'))).toMatchObject({ day: '2026-11-30', kind: 'none' });
  });
});

describe('proposals', () => {
  test('a wet visit with a dry open hour is a same-day reorder', async () => {
    const conn = fakeConn();
    const out = await run({ now: TUE_CUTOFF, conn, read: jest.fn(async () => hoursFor(AFTERNOON)), deps: deps([stop()]) });
    expect(out.problems).toEqual([]);
    expect(out.proposals).toEqual([{ id: 'v01', start: '14:00', peak: 80, decision: 'reorder', to_start: '10:00' }]);
    expect(daysOf(conn)[WED].cutoff.proposals).toEqual(out.proposals);
  });

  test('a visit whose whole day is wet, with no dry hour, is a one-off move to the first later day with a free dry start', async () => {
    const conn = fakeConn();
    const d = deps([stop()]);
    const out = await run({ now: TUE_CUTOFF, conn, read: jest.fn(async () => hoursFor(ALL_DAY)), deps: d });
    // Thursday is the only later day inside the 3-day forecast; 08:00 is the day's first start.
    expect(out.proposals).toEqual([{
      id: 'v01', start: '14:00', peak: 80, decision: 'day_move', to_date: THU, to_start: '08:00', series: false,
    }]);
    expect(d.blackoutDates).toHaveBeenCalledWith(THU, THU);
  });

  test('a day move needs a dry day in the forecast: none with the reason when every later day is wet', async () => {
    const out = await run({
      now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]),
      read: jest.fn(async () => hoursFor({ ...ALL_DAY, [THU]: 'all' })),
    });
    expect(out.proposals).toEqual([{ id: 'v01', start: '14:00', peak: 80, decision: 'none', reason: 'no_dry_day' }]);
  });

  describe('day moves from the occupancy snapshot and the closure list', () => {
    const FRI = '2026-11-27';

    test('a closure day is skipped, and the next later day is used', async () => {
      const d = deps([stop()], { blackoutDates: jest.fn(async () => new Set([THU])) });
      const out = await run({ now: WED_RECHECK, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(out.proposals[0]).toMatchObject({ decision: 'day_move', to_date: FRI, to_start: '08:00' });
    });

    test('an unreadable closure list stops the run: nothing is frozen and the retry decides again', async () => {
      const conn = fakeConn();
      const bad = deps([stop()], { blackoutDates: jest.fn(async () => { throw new Error('blackout down'); }) });
      const out = await run({ now: TUE_CUTOFF, conn, deps: bad, read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(out.problems).toEqual(['the run failed: blackout down']);
      expect(daysOf(conn)[WED]).toBeUndefined();
      n = 0;
      const retry = await run({ now: TUE_RETRY, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(retry.problems).toEqual([]);
      expect(daysOf(conn)[WED].cutoff.proposals[0].decision).toBe('day_move');
    });

    test('the closure list is read strictly from the real reader', async () => {
      const getBlackoutDates = jest.fn(async () => new Set());
      jest.resetModules();
      jest.doMock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates }));
      const fresh = require('../services/scheduling/rain-schedule-record');
      const conn = fakeConn();
      const d = deps([stop()]);
      delete d.blackoutDates;
      await fresh.recordScheduleRain({ now: TUE_CUTOFF, conn, deps: d, read: jest.fn(async () => hoursFor(ALL_DAY)), fetchRain: jest.fn() });
      jest.dontMock('../services/scheduling/blackout-dates');
      expect(getBlackoutDates).toHaveBeenCalledWith(THU, THU, conn, { strict: true });
    });

    test('a later day whose hours are unread is unread_forecast, not no_dry_day', async () => {
      const hours = hoursFor(ALL_DAY).filter((h) => !h.startTime.startsWith(THU));
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]), read: jest.fn(async () => hours) });
      expect(out.proposals[0]).toMatchObject({ decision: 'none', reason: 'unread_forecast' });
    });

    test('a busy technician moves the start to the next free one; a start that reads wet does not count', async () => {
      const d = deps([stop()]);
      d.rainOut.conflictsForTarget = jest.fn((_s, _id, date, window) => (date === THU && window.start === '08:00' ? [{ id: 'other' }] : []));
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor({ ...ALL_DAY, [THU]: [9, 10] })) });
      // 08:00 is busy; 09:00 and 10:00 read wet; 11:00 is the first free start whose span and drying hours are dry.
      expect(out.proposals[0]).toMatchObject({ decision: 'day_move', to_date: THU, to_start: '11:00' });
    });

    test('a technician busy all day on every later day leaves none', async () => {
      const d = deps([stop()]);
      d.rainOut.conflictsForTarget = jest.fn((_s, _id, date) => (date === THU ? [{ id: 'other' }] : []));
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(out.proposals[0]).toMatchObject({ decision: 'none', reason: 'no_dry_day' });
    });

    test('the span probed is the stop\'s own length, not an hour', async () => {
      const mk = () => stop({ window_end: '16:30:00', estimated_duration_minutes: 150 });
      const length = (({ reach }) => reach.endMin - reach.startMin)(rainPass._test.groupStops([mk()])[0]);
      expect(length).toBeGreaterThan(60);
      n = 0;
      const d = deps([mk()]);
      await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor(ALL_DAY)) });
      const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
      const thu = d.rainOut.conflictsForTarget.mock.calls.filter(([, , date]) => date === THU).map(([, , , w]) => w);
      expect(thu.length).toBeGreaterThan(0);
      expect(thu.every((w) => minutes(w.end) - minutes(w.start) === length)).toBe(true);
    });

    test('a day move goes to a later date only: never the planned date or an earlier one', async () => {
      // Tuesday is dry in this forecast; only the order of dates keeps it from being picked.
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]), read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(out.proposals[0]).toMatchObject({ decision: 'day_move', to_date: THU });
    });

    test('two day moves of one technician never take the same start on the target day', async () => {
      const rows = [stop({ technician_id: 'tx' }), stop({ technician_id: 'tx' })];
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(out.proposals.map((p) => [p.decision, p.to_date, p.to_start])).toEqual([['day_move', THU, '08:00'], ['day_move', THU, '09:00']]);
    });
  });

  test('a wet visit with no dry open hour on a day that is not wholly wet is none', async () => {
    const d = deps([stop()]);
    d.rainOut.conflictsForTarget = jest.fn(() => [{ id: 'other' }]); // every other hour is taken
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor({ [WED]: [13, 14, 15] })) });
    expect(out.proposals).toEqual([{ id: 'v01', start: '14:00', peak: 80, decision: 'none', reason: 'no_dry_hour' }]);
    expect(d.blackoutDates).not.toHaveBeenCalled();
  });

  test('a visit with no point is none with its reason; a dry visit is stored as forecast_dry so a miss can score', async () => {
    const rows = [stop({ point: null }), stop({ window_start: '09:00:00', window_end: '10:00:00' })];
    const conn = fakeConn();
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps(rows), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(out.proposals).toEqual([
      { id: 'v02', start: '09:00', decision: 'none', reason: 'forecast_dry' },
      { id: 'v01', start: '14:00', decision: 'none', reason: 'no_point' },
    ]);
    expect(daysOf(conn)[WED].cutoff).toMatchObject({ checked: 2, dry: 1 });
  });

  test('the 11th proposal is cap: 10 a day, in order of start then id, one per visit', async () => {
    process.env.GATE_MULTI_TECH_CONFIRM = 'true'; // each visit has its own technician: hours are not shared
    const rows = Array.from({ length: 11 }, () => stop());
    const conn = fakeConn();
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps(rows), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    const decisions = out.proposals.map((p) => [p.id, p.decision]);
    expect(decisions.filter(([, d]) => d === 'reorder')).toHaveLength(10);
    expect(decisions[10]).toEqual(['v11', 'cap']);
    expect(out.proposals[10]).toMatchObject({ would: 'reorder' });
    expect(new Set(out.proposals.map((p) => p.id)).size).toBe(11);
  });

  test('an earlier start takes a slot before a later one, whatever the id', async () => {
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const rows = [...Array.from({ length: 10 }, () => stop()), stop({ window_start: '13:00:00', window_end: '14:00:00' })];
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    const byId = Object.fromEntries(out.proposals.map((p) => [p.id, p.decision]));
    expect(byId.v11).toBe('reorder'); // 13:00 sorts first
    expect(byId.v10).toBe('cap'); // the last of the 14:00 visits by id
  });
});

describe('the NWS forecast', () => {
  test('is read from NWS only: never the paid-backup reader, and asked with the long wait', async () => {
    const read = jest.fn(async () => hoursFor(AFTERNOON));
    await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]), read });
    expect(read).toHaveBeenCalled();
    expect(read.mock.calls.every(([, , opts]) => opts && opts.fetchTimeoutMs === 10000)).toBe(true);
    expect(weather.getHourlyRainOutlook).not.toHaveBeenCalled();
  });

  test('a forecast that answers for no visit is a problem, freezes nothing, and fails the job_health step', async () => {
    const conn = fakeConn();
    const read = jest.fn(async () => null);
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps([stop()]), read });
    expect(out.problems[0]).toMatch(/forecast unread for all 1 outdoor visit/);
    expect(daysOf(conn)[WED]).toBeUndefined();
    await expect(record.runScheduleRainRecord({ now: TUE_RETRY, conn, deps: deps([stop()]), read, fetchRain: jest.fn() }))
      .rejects.toThrow(/schedule rain record: forecast unread/);
    // The 15:06 retry takes the cutoff once the forecast answers.
    const retry = await run({ now: TUE_RETRY, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(retry.problems).toEqual([]);
    expect(daysOf(conn)[WED].cutoff.proposals[0].decision).toBe('reorder');
  });

  test('never throws: a failed read is logged, kept on the last record, and reported as a problem', async () => {
    const conn = fakeConn();
    const bad = deps([stop()], { loadStops: jest.fn(async () => { throw new Error('db down'); }) });
    const out = await run({ now: TUE_CUTOFF, conn, deps: bad, read: jest.fn() });
    expect(out.problems).toEqual(['the run failed: db down']);
    expect(JSON.parse(conn.store[record.LAST_KEY]).error).toBe('db down');
  });
});

describe('the cutoff is frozen', () => {
  test('a later run on the same day before never replaces it; the 6 AM recheck sits beside it', async () => {
    const conn = fakeConn();
    await run({ now: TUE_CUTOFF, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    const frozen = daysOf(conn)[WED].cutoff;
    expect(frozen.proposals[0]).toMatchObject({ decision: 'reorder' });

    // The 15:06 run finds the forecast changed and takes no new cutoff (it does not even plan).
    const again = deps([stop()]);
    await run({ now: TUE_RETRY, conn, deps: again, read: jest.fn(async () => hoursFor(ALL_DAY)) });
    expect(again.loadStops).not.toHaveBeenCalled();
    expect(daysOf(conn)[WED].cutoff).toEqual(frozen);

    // Wednesday 6 AM: the rain has gone. The recheck records no proposal and the cutoff stands.
    n = 0;
    await run({ now: WED_RECHECK, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor({})) });
    const row = daysOf(conn)[WED];
    expect(row.cutoff).toEqual(frozen);
    expect(row.recheck.proposals).toEqual([{ id: 'v01', start: '14:00', decision: 'none', reason: 'forecast_dry' }]);
    expect(row.recheck.dry).toBe(1);
  });

  test('a recheck with no cutoff before it (a missed 2 PM) is kept as a recheck, not as a cutoff', async () => {
    const conn = fakeConn();
    await run({ now: WED_RECHECK, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    const row = daysOf(conn)[WED];
    expect(row.cutoff).toBeUndefined();
    expect(row.recheck.proposals[0].decision).toBe('reorder');
  });
});

describe('scoring against measured radar rain', () => {
  const FRI = parseETDateTime('2026-11-27T06:06');
  const seeded = (extra = {}) => fakeConn({
    [record.DAYS_KEY]: JSON.stringify({
      [WED]: {
        day: WED,
        cutoff: {
          at: '2026-11-24T19:06:00.000Z', checked: 5, dry: 0,
          proposals: [
            { id: 'a', start: '14:00', decision: 'reorder', to_start: '10:00' },
            { id: 'b', start: '14:00', decision: 'reorder', to_start: '10:00' },
            { id: 'c', start: '14:00', decision: 'none', reason: 'no_dry_hour' },
            { id: 'd', start: '14:00', decision: 'none', reason: 'no_dry_hour' },
            { id: 'e', start: '14:00', decision: 'none', reason: 'no_point' },
          ],
        },
        ...extra,
      },
    }),
  });
  // Visits a to d have a point (the fake loadPoints); e has none.
  const rainAt = { 27.4: 0.5, 27.41: 0.0, 27.42: 0.3, 27.43: 0.05 };
  const mrms = () => jest.fn(async ({ latitude }) => ({ days: [{ date: WED, inches: rainAt[Number(latitude.toFixed(2))] ?? null }], complete: true }));
  const LATS = { a: 27.4, b: 27.41, c: 27.42, d: 27.43 };
  const pointsWithoutE = jest.fn(async (_c, ids) => new Map(ids.filter((id) => LATS[id]).map((id) => [id, { lat: LATS[id], lng: -82.4 }])));

  test('a move on a wet visit is a hit, on a dry one a false alarm; a none on a wet visit is a miss, on a dry one ok', async () => {
    const conn = seeded();
    const fetchRain = mrms();
    const out = await run({ now: FRI, conn, fetchRain, deps: deps([], { loadPoints: pointsWithoutE }) });
    expect(out.scored).toEqual([WED]);
    const { score } = daysOf(conn)[WED];
    expect(score.visits.a).toMatchObject({ inches: 0.5, wet: true, cutoff: 'hit', recheck: null });
    expect(score.visits.b).toMatchObject({ wet: false, cutoff: 'false_alarm' });
    expect(score.visits.c).toMatchObject({ wet: true, cutoff: 'miss' });
    expect(score.visits.d).toMatchObject({ wet: false, cutoff: 'ok' });
    // A visit with no point is never read and never makes the day wait.
    expect(score.visits.e).toBeUndefined();
    expect(score.cutoff).toEqual({ hit: 1, false_alarm: 1, miss: 1, ok: 1, unread: 1 });
    expect(score.partial).toBe(false);
    // The radar is read for the day's own date, once per visit.
    expect(fetchRain.mock.calls.map(([a]) => [a.start, a.end])).toEqual(Array(4).fill([WED, WED]));
  });

  test('0.25 inches is wet, the radar rain rule of the ads record', async () => {
    const conn = seeded();
    await run({ now: FRI, conn, fetchRain: jest.fn(async () => ({ days: [{ date: WED, inches: 0.25 }] })), deps: deps([], { loadPoints: pointsWithoutE }) });
    expect(daysOf(conn)[WED].score.visits.a.wet).toBe(true);
  });

  test('a radar gap waits and keeps the readings; after 7 days the visits read decide, marked partial', async () => {
    const conn = seeded();
    const gap = jest.fn(async ({ latitude }) => (Number(latitude.toFixed(2)) === 27.42 ? null : { days: [{ date: WED, inches: 0.5 }] }));
    const first = await run({ now: FRI, conn, fetchRain: gap, deps: deps([], { loadPoints: pointsWithoutE }) });
    expect(first.scored).toEqual([]);
    expect(daysOf(conn)[WED].score).toBeUndefined();
    expect(daysOf(conn)[WED].measured_so_far).toMatchObject({ a: 0.5, b: 0.5, d: 0.5, c: null });

    const late = parseETDateTime('2026-12-02T06:06'); // 7 days after the day
    const later = await run({ now: late, conn, fetchRain: gap, deps: deps([], { loadPoints: pointsWithoutE }) });
    expect(later.scored).toContain(WED);
    const { score } = daysOf(conn)[WED];
    expect(score.partial).toBe(true);
    expect(score.visits.c).toMatchObject({ inches: null, wet: null, cutoff: null });
    expect(daysOf(conn)[WED].measured_so_far).toBeUndefined();
  });

  test('the recheck is scored beside the cutoff', async () => {
    const conn = seeded({ recheck: { at: '2026-11-25T11:06:00.000Z', checked: 5, dry: 0, proposals: [{ id: 'a', start: '14:00', decision: 'none', reason: 'no_dry_hour' }] } });
    await run({ now: FRI, conn, fetchRain: mrms(), deps: deps([], { loadPoints: pointsWithoutE }) });
    expect(daysOf(conn)[WED].score.visits.a).toMatchObject({ cutoff: 'hit', recheck: 'miss' });
    expect(daysOf(conn)[WED].score.recheck).toMatchObject({ miss: 1 });
  });

  test('a day is scored once, and the day itself is not scored while it is still today', async () => {
    const conn = seeded();
    const fetchRain = mrms();
    await run({ now: WED_RECHECK, conn, fetchRain, deps: deps([stop({ scheduled_date: '2026-11-26' })]) });
    expect(fetchRain).not.toHaveBeenCalled();
    await run({ now: FRI, conn, fetchRain, deps: deps([], { loadPoints: pointsWithoutE }) });
    const calls = fetchRain.mock.calls.length;
    await run({ now: parseETDateTime('2026-11-27T14:06'), conn, fetchRain, deps: deps([], { loadPoints: pointsWithoutE }) });
    expect(fetchRain.mock.calls.length).toBe(calls);
  });
});

describe('it changes nothing', () => {
  test('a cutoff with a day move, a recheck and a score write only system_settings, and touch no visit table', async () => {
    const conn = fakeConn();
    const d = () => deps([stop()]);
    const read = jest.fn(async () => hoursFor(ALL_DAY));
    await run({ now: TUE_CUTOFF, conn, deps: d(), read });
    n = 0;
    await run({ now: WED_RECHECK, conn, deps: d(), read });
    await run({
      now: parseETDateTime('2026-11-27T06:06'), conn, deps: d(),
      read, fetchRain: jest.fn(async () => ({ days: [{ date: WED, inches: 1 }] })),
    });
    expect(daysOf(conn)[WED].score).toBeDefined();
    expect(conn.writes.length).toBeGreaterThan(0);
    expect(new Set(conn.writes)).toEqual(new Set(['system_settings']));
    // The connection it was given is asked for nothing else (the visit reads go through rain-pass's own readers).
    expect(new Set(conn.tables)).toEqual(new Set(['system_settings']));
    const keys = Object.keys(conn.store);
    expect(keys.sort()).toEqual([record.DAYS_KEY, record.HISTORY_KEY, record.LAST_KEY].sort());
  });

  test('what it stores holds visit ids and decisions only: no name, address or coordinates', async () => {
    const conn = fakeConn();
    await run({ now: TUE_CUTOFF, conn, deps: deps([stop({ service_address_line1: '1 Main St', point: { lat: 27.4, lng: -82.4 } })]), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    const text = Object.values(conn.store).join(' ');
    expect(text).not.toMatch(/Main St|27\.4|-82\.4|c1"|customer/i);
  });

  test('the module has no way to text, email, notify or write a visit', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/scheduling/rain-schedule-record.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/notifyAdmin|raiseAdminAlert|sendSMS|sendSms|twilio|sendgrid|resend|\.commit\(|handOffToCustomer|rebooker|geocod|googleapis|maps\.|road-?time|distance-?matrix|scheduled_services|\.update\(|\.del\(|\.delete\(/i);
  });
});

// Fixes from the pre-push audit.
describe('audit fixes', () => {
  const hoursOn = (date, wet = []) => Array.from({ length: 24 }, (_, h) => ({
    startTime: `${date}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance: wet.includes(h) ? 80 : 10,
  }));

  test('two wet stops of one technician never take the same dry hour; two technicians may', async () => {
    const same = [stop({ technician_id: 'tx' }), stop({ technician_id: 'tx' })];
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(same), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(out.proposals.map((p) => [p.id, p.decision, p.to_start])).toEqual([['v01', 'reorder', '10:00'], ['v02', 'reorder', '09:00']]);
    n = 0;
    // With GATE_MULTI_TECH_CONFIRM on the probe is scoped to the technician's own route (see the gate tests below).
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const two = [stop({ technician_id: 'tx' }), stop({ technician_id: 'ty' })];
    const apart = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(two), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(apart.proposals.map((p) => p.to_start)).toEqual(['10:00', '10:00']);
  });

  test('a span with an hour the forecast did not read is unread, not dry', async () => {
    const conn = fakeConn();
    // 14:00 reads 10%; 15:00 and 16:00 (the rest of the visit and its drying time) have no reading.
    const hours = hoursFor({}).filter((h) => !(h.startTime.startsWith(`${WED}T15`) || h.startTime.startsWith(`${WED}T16`)));
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps([stop()]), read: jest.fn(async () => hours) });
    expect(out.proposals).toEqual([{ id: 'v01', start: '14:00', decision: 'none', reason: 'unread_forecast' }]);
    expect(daysOf(conn)[WED]).toBeUndefined(); // the only visit is unread: no forecast, nothing frozen
    const read = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]), read: jest.fn(async () => hoursFor({})) });
    expect(read.proposals[0]).toMatchObject({ decision: 'none', reason: 'forecast_dry' });
  });

  test('one visit with no point and one whose forecast failed is an unread day: nothing is frozen', async () => {
    const conn = fakeConn();
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps([stop({ point: null }), stop()]), read: jest.fn(async () => null) });
    expect(out.problems[0]).toMatch(/forecast unread for all 1 outdoor visit/);
    expect(daysOf(conn)[WED]).toBeUndefined();
    // Only no-point visits: nothing could be read, and that is not a forecast failure.
    n = 0;
    const alone = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop({ point: null })]), read: jest.fn(async () => null) });
    expect(alone.problems).toEqual([]);
  });

  test('at 6 AM a stop that starts within two hours still has its rain judged', async () => {
    const row = stop({ window_start: '08:00:00', window_end: '09:00:00' });
    const out = await run({ now: WED_RECHECK, conn: fakeConn(), deps: deps([row]), read: jest.fn(async () => hoursOn(WED, [8, 9, 10])) });
    expect(out.proposals).toEqual([{ id: 'v01', start: '08:00', peak: 80, decision: 'reorder', to_start: '11:00' }]);
  });

  test('the Saturday 2 PM run does not freeze Monday; the Sunday 2 PM run does', async () => {
    const MON = '2026-11-30';
    const monday = () => deps([stop({ scheduled_date: MON })]);
    const read = jest.fn(async () => hoursOn(MON, [13, 14, 15, 16, 17]));
    const conn = fakeConn();
    const sat = monday();
    await run({ now: parseETDateTime('2026-11-28T14:06'), conn, deps: sat, read });
    expect(sat.loadStops).not.toHaveBeenCalled();
    expect(daysOf(conn)[MON]).toBeUndefined();
    n = 0;
    await run({ now: parseETDateTime('2026-11-29T14:06'), conn, deps: monday(), read });
    expect(daysOf(conn)[MON].cutoff.proposals[0]).toMatchObject({ decision: 'reorder' });
  });

  test('the catalog resolver is used for every service, whatever the rain-pass gate says', async () => {
    const d = deps([stop()]);
    delete process.env.GATE_AUTO_DISPATCH_RAIN_PASS;
    await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(d.withCatalogKeys.mock.calls[0][2]).toEqual({ gate: null, strict: true });
  });

  test('a failed occupancy read is a planning problem: nothing is decided or frozen, the retry can take the cutoff', async () => {
    const conn = fakeConn();
    const bad = deps([stop()]);
    bad.rainOut.loadOccupancy = jest.fn(async () => { throw new Error('occupancy down'); });
    const out = await run({ now: TUE_CUTOFF, conn, deps: bad, read: jest.fn(async () => hoursFor(ALL_DAY)) });
    expect(out.problems[0]).toMatch(/occupancy unread for 2026-11-25/);
    expect(out.proposals).toEqual([]);
    expect(daysOf(conn)[WED]).toBeUndefined();
    n = 0;
    const retry = await run({ now: TUE_RETRY, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(retry.problems).toEqual([]);
    expect(daysOf(conn)[WED].cutoff.proposals[0].decision).toBe('reorder');
  });

  test('a day move never lands on a Sunday', async () => {
    const SAT = '2026-11-28';
    const SUN = '2026-11-29';
    const hours = [SAT, SUN, '2026-11-27'].flatMap((date) => Array.from({ length: 24 }, (_, h) => ({
      startTime: `${date}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance: date === SAT ? 80 : 10,
    })));
    const d = deps([stop({ scheduled_date: SAT })]);
    const out = await run({ now: parseETDateTime('2026-11-27T14:06'), conn: fakeConn(), deps: d, read: jest.fn(async () => hours) });
    expect(out.proposals[0]).toMatchObject({ decision: 'none', reason: 'no_dry_day' });
  });

  describe('over the cap', () => {
    // Visits 1 to 10 sit in afternoon rain (a dry morning); visit 11 sits in an all-day rain.
    const readBy = jest.fn(async (lat) => hoursFor(lat > 27.4105 ? ALL_DAY : AFTERNOON));
    const ten = () => Array.from({ length: 11 }, () => stop());
    beforeEach(() => { process.env.GATE_MULTI_TECH_CONFIRM = 'true'; });

    test('a wholly wet stop over the cap is cap only when a valid move exists', async () => {
      const withMove = deps(ten());
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: withMove, read: readBy });
      expect(out.proposals.filter((p) => p.decision === 'reorder')).toHaveLength(10);
      expect(out.proposals[10]).toMatchObject({ id: 'v11', decision: 'cap', would: 'day_move', to_date: THU });
      n = 0;
      const noMove = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(ten(), { rainOut: { loadOccupancy: jest.fn(async () => ({ rows: [] })), conflictsForTarget: jest.fn((_s, _id, date) => (date === THU ? [{ id: 'other' }] : [])) } }), read: readBy });
      expect(noMove.proposals[10]).toMatchObject({ id: 'v11', decision: 'none', reason: 'no_dry_day' });
    });

    test('a reorder over the cap never names an hour an accepted proposal of the same technician holds', async () => {
      process.env.GATE_MULTI_TECH_CONFIRM = 'true';
      const rows = [stop({ technician_id: 'tx' }), ...Array.from({ length: 9 }, () => stop()), stop({ technician_id: 'tx' })];
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read: jest.fn(async () => hoursFor(AFTERNOON)) });
      expect(out.proposals[0]).toMatchObject({ id: 'v01', decision: 'reorder', to_start: '10:00' });
      expect(out.proposals[10]).toMatchObject({ id: 'v11', decision: 'cap', would: 'reorder', to_start: '09:00' });
    });
  });

  test('a scoring failure never drops the day decision: the cutoff is saved and the error recorded', async () => {
    const SAT = '2026-11-28';
    const old = { day: WED, cutoff: { at: 'x', checked: 1, dry: 0, proposals: [{ id: 'a', start: '14:00', decision: 'reorder', to_start: '10:00' }] } };
    const conn = fakeConn({ [record.DAYS_KEY]: JSON.stringify({ [WED]: old }) });
    const d = deps([stop({ scheduled_date: SAT })], { loadPoints: jest.fn(async () => { throw new Error('points down'); }) });
    const hours = Array.from({ length: 24 }, (_, h) => ({ startTime: `${SAT}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance: h >= 13 && h <= 17 ? 80 : 10 }));
    const out = await run({ now: parseETDateTime('2026-11-27T14:06'), conn, deps: d, read: jest.fn(async () => hours) });
    expect(out.problems).toEqual(['scoring failed: points down']);
    expect(daysOf(conn)[SAT].cutoff.proposals[0]).toMatchObject({ decision: 'reorder' });
    expect(daysOf(conn)[WED].score).toBeUndefined();
    expect(JSON.parse(conn.store[record.LAST_KEY]).error).toBe('scoring failed: points down');
  });

  test('a day whose unread hours could still make it wholly wet is unread, not no_dry_hour', async () => {
    const d = deps([stop()]);
    d.rainOut.conflictsForTarget = jest.fn(() => [{ id: 'other' }]); // no open hour
    // 3 wet work hours and the 16:00 hour unread: 3 + 1 reaches 4.
    const hours = hoursFor({ [WED]: [13, 14, 15] }).filter((h) => !h.startTime.startsWith(`${WED}T16`));
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hours) });
    expect(out.proposals[0]).toMatchObject({ decision: 'none', reason: 'unread_forecast' });
    expect(d.blackoutDates).not.toHaveBeenCalled();
  });

  test('a catalog read that fails stops the run: nothing is frozen and no name rule is used instead', async () => {
    const conn = fakeConn();
    const broken = deps([stop(), stop()], { withCatalogKeys: jest.fn(async () => { throw new Error('catalog down'); }) });
    const out = await run({ now: TUE_CUTOFF, conn, deps: broken, read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(out.problems).toEqual(['the run failed: catalog down']);
    expect(daysOf(conn)[WED]).toBeUndefined();
  });

  test('a day where every visit failed to plan is a problem and freezes nothing', async () => {
    const conn = fakeConn();
    const broken = deps([stop(), stop()]);
    broken.rainOut.conflictsForTarget = jest.fn(() => { throw new Error('occupancy rows unreadable'); });
    const out = await run({ now: TUE_CUTOFF, conn, deps: broken, read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(out.problems[0]).toMatch(/forecast unread for all 2 outdoor visit/);
    expect(daysOf(conn)[WED]).toBeUndefined();
    // A visit with no point stays out of the count: one error and one no-point visit is still every readable visit.
    n = 0;
    const mixed = deps([stop({ point: null }), stop()]);
    mixed.rainOut.conflictsForTarget = jest.fn(() => { throw new Error('occupancy rows unreadable'); });
    const two = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: mixed, read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(two.problems[0]).toMatch(/forecast unread for all 1 outdoor visit/);
  });
});
