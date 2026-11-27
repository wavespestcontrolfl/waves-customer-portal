/**
 * Schedule rain record (services/scheduling/rain-schedule-record.js). Test mode: it records what the rain rule would do
 * to the next work day (a same-day re-time, or a one-off move when the whole day is wet, at most 10 a day), freezes the
 * 2 PM decision, rechecks beside it, and scores past days against the measured rain in each visit's hours. It changes nothing: it writes
 * only its own system_settings rows. rain-pass's own verdicts are covered by auto-dispatch-rain-pass.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => {
  const actual = jest.requireActual('../services/weather-forecast');
  return {
    getNwsHourlyRain: jest.fn(),
    getHourlyRainOutlook: jest.fn(),
    getNwsActiveAlerts: jest.fn(async () => []),
    getNwsHourlyRainPatient: (...args) => actual.getNwsHourlyRainPatient(...args),
    parseHasThunder: (...args) => actual.parseHasThunder(...args),
    alertOverlapsWindow: (...args) => actual.alertOverlapsWindow(...args),
    classifyNwsAlertEvent: (...args) => actual.classifyNwsAlertEvent(...args),
  };
});
jest.mock('../services/mrms-qpe', () => ({ fetchMrmsDailyRain: jest.fn() }));

const fs = require('fs');
const path = require('path');
const weather = require('../services/weather-forecast');
const record = require('../services/scheduling/rain-schedule-record');
const rainMode = require('../services/ads/rain-mode');
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
// Wednesday rain from 8:00 to 11:00 only: a dry afternoon exists (a reorder goes LATER the same day, never earlier).
// Wednesday all day: no dry hour and a wholly wet day.
const MORNING = { [WED]: [8, 9, 10, 11] };
// Rain at 13:00 to 17:00 only: a dry morning exists, but a visit at 14:00 has no later dry hour.
const AFTERNOON = { [WED]: [13, 14, 15, 16, 17] };
const ALL_DAY = { [WED]: 'all' };

let n = 0;
const stop = (extra = {}) => {
  n += 1;
  return {
    id: `v${String(n).padStart(2, '0')}`, customer_id: `c${n}`, service_type: 'Quarterly Pest Control Service',
    service_key_snapshot: 'pest_general_quarterly', technician_id: `t${n}`, status: 'confirmed', scheduled_date: WED,
    window_start: '09:00:00', window_end: '10:00:00', point: { lat: 27.4 + n / 1000, lng: -82.4 },
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
    // The recurrence read: a service is recurring (a plain quarterly plan) when its stop row says so, else one-time.
    loadSeries: jest.fn(async (_conn, ids) => new Map(ids.map((id) => {
      const recurring = rows.some((r) => String(r.id) === String(id) && r.is_recurring === true);
      return [String(id), { id, is_recurring: recurring, scheduled_date: WED, recurring_pattern: recurring ? 'quarterly' : null }];
    }))),
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
const run = (opts) => record.recordScheduleRain({ fetchObs: jest.fn(async () => null), ...opts });

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
    const out = await run({ now: TUE_CUTOFF, conn, read: jest.fn(async () => hoursFor(MORNING)), deps: deps([stop()]) });
    expect(out.problems).toEqual([]);
    // Rain 8 to 11 and the visit at 9: the nearest dry hours after it are 12:00 (its own hours and the 2 drying hours read dry).
    expect(out.proposals).toEqual([{ id: 'v01', start: '09:00', span: expect.any(Array), gauges: expect.any(Array), span_chances: expect.any(Array), day_chances: expect.any(Array), peak: 80, decision: 'reorder', to_start: '12:00' }]);
    // The reorder's own hours (12:00 on) are inside day_chances, read from the same snapshot: the decision replays.
    expect(out.proposals[0].day_chances).toHaveLength(11);
    expect(out.proposals[0].day_chances.slice(4).every((c) => c != null && c < 40)).toBe(true);
    expect(daysOf(conn)[WED].cutoff.proposals).toEqual(out.proposals);
  });

  test('a reorder is LATER the same day only: a visit with only an earlier dry hour goes on to the next work day, never earlier', async () => {
    // Rain 13 to 17, the visit at 14:00: rain-pass finds dry hours before it (10:00) and none after.
    const late = () => stop({ window_start: '14:00:00', window_end: '15:00:00' });
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([late()]), read: jest.fn(async () => hoursFor(AFTERNOON)) });
    expect(out.proposals[0]).toMatchObject({ id: 'v01', start: '14:00', decision: 'day_move', to_date: THU });
    expect(out.proposals[0].to_start).toBe('08:00');
    // The same visit when the next work day is wet too: the call list.
    n = 0;
    const wet = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([late()]), read: jest.fn(async () => hoursFor({ ...AFTERNOON, [THU]: 'all' })) });
    expect(wet.proposals[0]).toMatchObject({ decision: 'call_list' });
  });

  test('when an earlier proposal holds the nearest later hour the next later hour is taken, never an earlier one', async () => {
    const rows = [stop({ technician_id: 'tx' }), stop({ technician_id: 'tx' })];
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read: jest.fn(async () => hoursFor(MORNING)) });
    expect(out.proposals.map((p) => p.to_start)).toEqual(['12:00', '13:00']);
    expect(out.proposals.every((p) => p.to_start > '09:00')).toBe(true);
  });

  test('a visit whose whole day is wet, with no dry hour, is a move to the next work day at a free dry start', async () => {
    const conn = fakeConn();
    const d = deps([stop()]);
    const out = await run({ now: TUE_CUTOFF, conn, read: jest.fn(async () => hoursFor(ALL_DAY)), deps: d });
    // Thursday is the next work day; 08:00 is the day's first start. Not a recurring visit: it moves alone.
    expect(out.proposals).toEqual([{
      id: 'v01', start: '09:00', span: expect.any(Array), gauges: expect.any(Array), span_chances: expect.any(Array), day_chances: expect.any(Array), next_day: THU, next_day_chances: expect.any(Array), peak: 80, decision: 'day_move', to_date: THU, to_start: '08:00', plan_moves: 'one_visit',
    }]);
    expect(d.blackoutDates).toHaveBeenCalledWith(THU, '2026-12-03');
  });

  test('no dry slot today and none on the next work day: the visit goes to the office call list, with no text and no move', async () => {
    const out = await run({
      now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]),
      read: jest.fn(async () => hoursFor({ ...ALL_DAY, [THU]: 'all' })),
    });
    expect(out.proposals).toEqual([{ id: 'v01', start: '09:00', span: expect.any(Array), gauges: expect.any(Array), span_chances: expect.any(Array), day_chances: expect.any(Array), next_day: THU, next_day_chances: expect.any(Array), peak: 80, decision: 'call_list', reason: 'no_dry_slot' }]);
    expect(out.proposals[0].to_date).toBeUndefined();
  });

  test('only the next work day is tried: the day after it, though dry, is never offered', async () => {
    // Thursday wet all day, Friday dry: the old rule moved to Friday; the 2026-11-26 ruling sends it to the call list.
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]), read: jest.fn(async () => hoursFor({ ...ALL_DAY, [THU]: 'all' })) });
    expect(out.proposals[0].decision).toBe('call_list');
  });

  describe('the next work day', () => {
    const SAT = '2026-11-28';
    const MON = '2026-11-30';
    const dayHours = (dates, wet) => dates.flatMap((date) => Array.from({ length: 24 }, (_, h) => ({
      startTime: `${date}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance: wet.includes(date) ? 80 : 10,
    })));

    test('a Friday stop moves to Saturday; a Saturday stop to Monday (Sunday skipped), and the occupancy snapshot reaches it', async () => {
      const fri = deps([stop({ scheduled_date: '2026-11-27' })]);
      const out = await run({ now: parseETDateTime('2026-11-26T14:06'), conn: fakeConn(), deps: fri, read: jest.fn(async () => dayHours(['2026-11-27', SAT, '2026-11-29', MON], ['2026-11-27'])) });
      expect(out.proposals[0]).toMatchObject({ decision: 'day_move', to_date: SAT });
      // rain-pass asks for today to today + 2; the record asks for the next work day's reach too.
      const asked = fri.rainOut.loadOccupancy.mock.calls[0][0];
      expect(asked.dateTo >= '2026-12-04').toBe(true);
      n = 0;
      const sat = deps([stop({ scheduled_date: SAT })]);
      const out2 = await run({ now: parseETDateTime('2026-11-27T14:06'), conn: fakeConn(), deps: sat, read: jest.fn(async () => dayHours([SAT, '2026-11-29', MON, '2026-12-01'], [SAT])) });
      expect(out2.proposals[0]).toMatchObject({ decision: 'day_move', to_date: MON });
      expect(sat.blackoutDates).toHaveBeenCalledWith('2026-11-29', '2026-12-06');
    });

    test('a closed next work day is skipped to the one after it, and a Sunday is never the day', async () => {
      const sat = deps([stop({ scheduled_date: SAT })], { blackoutDates: jest.fn(async () => new Set([MON])) });
      const out = await run({ now: parseETDateTime('2026-11-27T14:06'), conn: fakeConn(), deps: sat, read: jest.fn(async () => dayHours([SAT, '2026-11-29', MON, '2026-12-01'], [SAT])) });
      expect(out.proposals[0]).toMatchObject({ decision: 'day_move', to_date: '2026-12-01' });
    });
  });

  describe('plan_moves', () => {
    const recurring = (extra = {}) => stop({ is_recurring: true, ...extra });
    const go = (rows, extra = {}) => run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows, extra), read: jest.fn(async () => hoursFor(ALL_DAY)) });

    test('a recurring visit shifts the whole plan; a one-time visit moves alone', async () => {
      const out = await go([recurring(), stop()]);
      expect(out.proposals.map((p) => [p.decision, p.plan_moves])).toEqual([['day_move', 'whole_plan'], ['day_move', 'one_visit']]);
    });

    test('a lawn round moved 7 days or less inside its round stays one visit; a pest plan does not', async () => {
      const lawn = { id: 'v01', is_recurring: true, scheduled_date: WED, recurring_pattern: 'lawn_rounds_9', date_exception: false, date_exception_cadence_date: null };
      const pest = { id: 'v02', is_recurring: true, scheduled_date: WED, recurring_pattern: 'quarterly', date_exception: false, date_exception_cadence_date: null };
      const out = await go([recurring(), recurring()], { loadSeries: jest.fn(async () => new Map([['v01', lawn], ['v02', pest]])) });
      expect(out.proposals.map((p) => p.plan_moves)).toEqual(['one_visit', 'whole_plan']);
    });

    test('a grouped stop: every member service is read, the move is whole_plan if any member is recurring, and each member is recorded', async () => {
      // Two services at one stop (a shared visit_id): the anchor is one-time, the second is a recurring pest plan.
      const rows = [stop({ visit_id: 'g1', service_type: 'Quarterly Pest Control Service' }), stop({ visit_id: 'g1', service_type: 'Quarterly Pest Control Service' })];
      const loadSeries = jest.fn(async () => new Map([
        ['v01', { id: 'v01', is_recurring: false, scheduled_date: WED }],
        ['v02', { id: 'v02', is_recurring: true, scheduled_date: WED, recurring_pattern: 'quarterly' }],
      ]));
      const out = await go(rows.map((r) => ({ ...r, technician_id: 't1' })), { loadSeries });
      expect(loadSeries.mock.calls[0][1].sort()).toEqual(['v01', 'v02']);
      expect(out.proposals[0]).toMatchObject({ decision: 'day_move', plan_moves: 'whole_plan', plan_moves_by_service: { v01: 'one_visit', v02: 'whole_plan' } });
    });

    test('a grouped stop whose recurring member is a lawn round moved within 7 days stays one_visit', async () => {
      const rows = [stop({ visit_id: 'g1', technician_id: 't1' }), stop({ visit_id: 'g1', technician_id: 't1' })];
      const loadSeries = jest.fn(async () => new Map([
        ['v01', { id: 'v01', is_recurring: false, scheduled_date: WED }],
        ['v02', { id: 'v02', is_recurring: true, scheduled_date: WED, recurring_pattern: 'lawn_rounds_9', date_exception: false, date_exception_cadence_date: null }],
      ]));
      const out = await go(rows, { loadSeries });
      expect(out.proposals[0]).toMatchObject({ plan_moves: 'one_visit', plan_moves_by_service: { v01: 'one_visit', v02: 'one_visit' } });
    });

    test('a failed recurrence read never freezes a plan scope: the run stops, nothing is frozen, the retry decides again', async () => {
      const conn = fakeConn();
      const bad = jest.fn(async () => { throw new Error('series down'); });
      const out = await run({ now: TUE_CUTOFF, conn, deps: deps([recurring()], { loadSeries: bad }), read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(out.problems).toEqual(['the run failed: series down']);
      expect(daysOf(conn)[WED]).toBeUndefined();
      n = 0;
      const retry = await run({ now: TUE_RETRY, conn, deps: deps([recurring()]), read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(retry.problems).toEqual([]);
      expect(daysOf(conn)[WED].cutoff.proposals[0]).toMatchObject({ decision: 'day_move', plan_moves: 'whole_plan' });
    });

    test('the recurrence is read only when a day move needs it, and once', async () => {
      const d = deps([recurring(), recurring()]);
      await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor(MORNING)) });
      expect(d.loadSeries).not.toHaveBeenCalled(); // both reorder
      n = 0;
      const d2 = deps([recurring(), recurring()]);
      await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d2, read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(d2.loadSeries).toHaveBeenCalledTimes(1);
    });

    test('a service with no recurrence row is unknown, never one_visit', async () => {
      const out = await go([recurring()], { loadSeries: jest.fn(async () => new Map()) });
      expect(out.proposals[0]).toMatchObject({ decision: 'day_move', plan_moves: 'unknown' });
    });
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
      await fresh.recordScheduleRain({ now: TUE_CUTOFF, conn, deps: d, read: jest.fn(async () => hoursFor(ALL_DAY)), fetchObs: jest.fn(async () => null) });
      jest.dontMock('../services/scheduling/blackout-dates');
      expect(getBlackoutDates).toHaveBeenCalledWith(THU, '2026-12-03', conn, { strict: true });
    });

    test('a next work day whose hours are unread is unread_forecast, not call_list', async () => {
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

    test('a technician busy all day on the next work day sends the visit to the call list', async () => {
      const d = deps([stop()]);
      d.rainOut.conflictsForTarget = jest.fn((_s, _id, date) => (date === THU ? [{ id: 'other' }] : []));
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor(ALL_DAY)) });
      expect(out.proposals[0]).toMatchObject({ decision: 'call_list', reason: 'no_dry_slot' });
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

  test('a visit whose span is wet with no later dry slot goes to the next work day even when the day is not wholly wet (owner 2026-11-26, per visit)', async () => {
    // Only 3 wet work hours (8 to 10), so the day is not wholly wet; every hour after 09:00 today is taken by other stops.
    const taken = () => jest.fn((_s, _id, date) => (date === WED ? [{ id: 'other' }] : []));
    const d = deps([stop()]);
    d.rainOut.conflictsForTarget = taken();
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor({ [WED]: [8, 9, 10] })) });
    expect(out.proposals).toEqual([{
      id: 'v01', start: '09:00', span: expect.any(Array), gauges: expect.any(Array), span_chances: expect.any(Array), day_chances: expect.any(Array), next_day: THU, next_day_chances: expect.any(Array), peak: 80, decision: 'day_move', to_date: THU, to_start: '08:00', plan_moves: 'one_visit',
    }]);
    // The next work day wet as well: the office call list.
    n = 0;
    const wet = deps([stop()]);
    wet.rainOut.conflictsForTarget = taken();
    const call = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: wet, read: jest.fn(async () => hoursFor({ [WED]: [8, 9, 10], [THU]: 'all' })) });
    expect(call.proposals[0]).toMatchObject({ decision: 'call_list', reason: 'no_dry_slot' });
  });

  test('a visit with no point is none with its reason; a dry visit is stored as forecast_dry so a miss can score', async () => {
    const rows = [stop({ point: null }), stop({ window_start: '14:00:00', window_end: '15:00:00' })];
    const conn = fakeConn();
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps(rows), read: jest.fn(async () => hoursFor(MORNING)) });
    // A dry visit keeps its peak too (10%), so the forecast can be replayed against what fell.
    expect(out.proposals).toEqual([
      { id: 'v01', start: '09:00', span: expect.any(Array), decision: 'none', reason: 'no_point' },
      { id: 'v02', start: '14:00', span: expect.any(Array), gauges: expect.any(Array), span_chances: expect.any(Array), peak: 10, decision: 'none', reason: 'forecast_dry' },
    ]);
    expect(daysOf(conn)[WED].cutoff).toMatchObject({ checked: 2, dry: 1 });
  });

  test('the 11th proposal is cap: 10 a day, in order of start then id, one per visit', async () => {
    process.env.GATE_MULTI_TECH_CONFIRM = 'true'; // each visit has its own technician: hours are not shared
    const rows = Array.from({ length: 11 }, () => stop());
    const conn = fakeConn();
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps(rows), read: jest.fn(async () => hoursFor(MORNING)) });
    const decisions = out.proposals.map((p) => [p.id, p.decision]);
    expect(decisions.filter(([, d]) => d === 'reorder')).toHaveLength(10);
    expect(decisions[10]).toEqual(['v11', 'cap']);
    expect(out.proposals[10]).toMatchObject({ would: 'reorder' });
    expect(new Set(out.proposals.map((p) => p.id)).size).toBe(11);
  });

  test('an earlier start takes a slot before a later one, whatever the id', async () => {
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const rows = [...Array.from({ length: 10 }, () => stop()), stop({ window_start: '08:00:00', window_end: '09:00:00' })];
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read: jest.fn(async () => hoursFor(MORNING)) });
    const byId = Object.fromEntries(out.proposals.map((p) => [p.id, p.decision]));
    expect(byId.v11).toBe('reorder'); // 08:00 sorts first
    expect(byId.v10).toBe('cap'); // the last of the 09:00 visits by id
  });
});

describe('the NWS forecast', () => {
  test('is read from NWS only: never the paid-backup reader, and asked with the long wait', async () => {
    const read = jest.fn(async () => hoursFor(MORNING));
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
    await expect(record.runScheduleRainRecord({ now: TUE_RETRY, conn, deps: deps([stop()]), read, fetchObs: jest.fn(async () => null) }))
      .rejects.toThrow(/schedule rain record: forecast unread/);
    // The 15:06 retry takes the cutoff once the forecast answers.
    const retry = await run({ now: TUE_RETRY, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(MORNING)) });
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
    await run({ now: TUE_CUTOFF, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(MORNING)) });
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
    expect(row.recheck.proposals).toEqual([{ id: 'v01', start: '09:00', span: expect.any(Array), gauges: expect.any(Array), span_chances: expect.any(Array), peak: 10, decision: 'none', reason: 'forecast_dry' }]);
    expect(row.recheck.dry).toBe(1);
  });

  test('a recheck with no cutoff before it (a missed 2 PM) is kept as a recheck, not as a cutoff', async () => {
    const conn = fakeConn();
    await run({ now: WED_RECHECK, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(MORNING)) });
    const row = daysOf(conn)[WED];
    expect(row.cutoff).toBeUndefined();
    expect(row.recheck.proposals[0].decision).toBe('reorder');
  });
});

describe('scoring against the measured rain in each visit\'s hours', () => {
  const FRI = parseETDateTime('2026-11-27T06:06');
  const seeded = (extra = {}, proposals = null) => fakeConn({
    [record.DAYS_KEY]: JSON.stringify({
      [WED]: {
        day: WED,
        cutoff: {
          at: '2026-11-24T19:06:00.000Z', checked: 5, dry: 0,
          proposals: proposals || [
            { id: 'a', gauges: G.a, start: '14:00', span: [840, 900], decision: 'reorder', to_start: '16:00' },
            { id: 'b', gauges: G.b, start: '14:00', span: [840, 900], decision: 'reorder', to_start: '16:00' },
            { id: 'c', gauges: G.c, start: '14:00', span: [840, 900], decision: 'none', reason: 'no_dry_hour' },
            { id: 'd', gauges: G.d, start: '14:00', span: [840, 900], decision: 'none', reason: 'no_dry_hour' },
            { id: 'e', start: '14:00', span: [840, 900], decision: 'none', reason: 'no_point' },
          ],
        },
        ...extra,
      },
    }),
  });
  // The gauges stored on each proposal at decision time: a, b on the Venice side, c, d on the Sarasota side; e has no point.
  const G = { a: ['VNC', 'SRQ'], b: ['VNC', 'SRQ'], c: ['SRQ', 'VNC'], d: ['SRQ', 'VNC'] };
  // Hourly gauge readings: `rain` = ET hours with 0.02 in; every other hour of the day reads 0.
  const obsWith = ({ VNC = [], SRQ = [] }, gone = {}) => {
    const row = (wet, skip = []) => Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, wet.includes(h) ? 0.02 : 0]).filter(([h]) => !skip.includes(Number(h))));
    return { VNC: row(VNC, gone.VNC), SRQ: row(SRQ, gone.SRQ), PGD: {}, SPG: {} };
  };
  // The visit is 14:00 to 15:00 and dries until 17:00 (RAIN_AFTER_HOURS 2): hours 14, 15, 16 count.
  const fetchObs = (plan, gone) => jest.fn(async () => obsWith(plan, gone));

  test('rain in the visit\'s hours or its drying hours: a move is a hit, a miss without one is a false alarm; none on a wet visit is a miss', async () => {
    const conn = seeded();
    const obs = fetchObs({ VNC: [16], SRQ: [] }); // Venice rains in the last drying hour; Sarasota stays dry
    const out = await run({ now: FRI, conn, fetchObs: obs, deps: deps([]) });
    expect(out.scored).toEqual([WED]);
    const { score } = daysOf(conn)[WED];
    expect(score.basis).toBe('work_hours');
    expect(score.visits.a).toMatchObject({ inches: 0.02, wet: true, cutoff: 'hit', recheck: null });
    expect(score.visits.c).toMatchObject({ inches: 0, wet: false, cutoff: 'ok' });
    // A visit with no point is never read and never makes the day wait.
    expect(score.visits.e).toBeUndefined();
    expect(score.cutoff).toEqual({ hit: 2, false_alarm: 0, miss: 0, ok: 2, unread: 1 });
    expect(score.partial).toBe(false);
    expect(obs).toHaveBeenCalledTimes(1);
    expect(obs).toHaveBeenCalledWith(WED);
    expect(score.day).toMatchObject({ wet_day: false });
  });

  test('a rain before the visit started is not its rain, and a rain after its drying hours is not either', async () => {
    const conn = seeded();
    await run({ now: FRI, conn, fetchObs: fetchObs({ VNC: [8, 9, 10, 11, 12, 13, 17, 18], SRQ: [8, 9, 10, 11, 12, 13, 17] }), deps: deps([]) });
    const { score } = daysOf(conn)[WED];
    expect(score.visits.a.wet).toBe(false);
    expect(score.visits.a.cutoff).toBe('false_alarm');
    expect(score.visits.c).toMatchObject({ wet: false, cutoff: 'ok' });
  });

  test('a call_list on a wet visit is a hit, on a dry visit a false alarm', async () => {
    const conn = seeded({}, [
      { id: 'a', gauges: G.a, start: '14:00', span: [840, 900], decision: 'call_list', reason: 'no_dry_slot' },
      { id: 'c', gauges: G.c, start: '14:00', span: [840, 900], decision: 'call_list', reason: 'no_dry_slot' },
    ]);
    await run({ now: FRI, conn, fetchObs: fetchObs({ VNC: [14], SRQ: [] }), deps: deps([]) });
    const { score } = daysOf(conn)[WED];
    expect([score.visits.a.cutoff, score.visits.c.cutoff]).toEqual(['hit', 'false_alarm']);
  });

  test('a proposal with no stored span (a record from before spans were kept) is ungraded: null verdicts, final, never waits, never rebuilt', async () => {
    const conn = seeded({}, [
      { id: 'a', gauges: G.a, start: '14:00', decision: 'reorder', to_start: '16:00' },
      { id: 'c', gauges: G.c, start: '14:00', span: [840, 900], decision: 'none', reason: 'no_dry_hour' },
    ]);
    // Rain at 14:00 on both visits' points: the legacy one is not graded on an assumed hour; the stored-span one is.
    const out = await run({ now: FRI, conn, fetchObs: fetchObs({ VNC: [14], SRQ: [14] }), deps: deps([]) });
    expect(out.scored).toEqual([WED]);
    const { score } = daysOf(conn)[WED];
    expect(score.partial).toBe(false);
    expect(score.visits.a).toEqual({ inches: null, wet: null, missing: null, cutoff: null, recheck: null });
    expect(score.visits.c).toMatchObject({ wet: true, cutoff: 'miss' });
    expect(score.cutoff).toEqual({ hit: 0, false_alarm: 0, miss: 1, ok: 0, unread: 1 });
  });

  test('an hour no gauge reported is unread, never dry: the day waits, and after 7 days the visits read decide, marked partial', async () => {
    const conn = seeded();
    // Hour 15 has no report at SRQ or VNC and nothing was wet: the visits cannot be called dry.
    const gapped = jest.fn(async () => { const o = obsWith({ VNC: [], SRQ: [] }, {}); delete o.SRQ[15]; delete o.VNC[15]; return o; });
    const first = await run({ now: FRI, conn, fetchObs: gapped, deps: deps([]) });
    expect(first.scored).toEqual([]);
    expect(daysOf(conn)[WED].score).toBeUndefined();
    expect(daysOf(conn)[WED].score_tried_at).toBeDefined();

    const late = parseETDateTime('2026-12-02T06:06'); // 7 days after the day
    const later = await run({ now: late, conn, fetchObs: gapped, deps: deps([]) });
    expect(later.scored).toContain(WED);
    const { score } = daysOf(conn)[WED];
    expect(score.partial).toBe(true);
    expect(score.visits.a).toMatchObject({ wet: null, cutoff: null });
  });

  test('gauges that did not answer wait the same way', async () => {
    const conn = seeded();
    const out = await run({ now: FRI, conn, fetchObs: jest.fn(async () => null), deps: deps([]) });
    expect(out.scored).toEqual([]);
  });

  test('the recheck is scored beside the cutoff', async () => {
    const conn = seeded({ recheck: { at: '2026-11-25T11:06:00.000Z', checked: 5, dry: 0, proposals: [{ id: 'a', gauges: G.a, start: '14:00', span: [840, 900], decision: 'none', reason: 'no_dry_hour' }] } });
    await run({ now: FRI, conn, fetchObs: fetchObs({ VNC: [14], SRQ: [] }), deps: deps([]) });
    expect(daysOf(conn)[WED].score.visits.a).toMatchObject({ cutoff: 'hit', recheck: 'miss' });
    expect(daysOf(conn)[WED].score.recheck).toMatchObject({ miss: 1 });
  });

  test('the cutoff and the recheck are each graded against their own span: a stop re-timed between them', async () => {
    // The cutoff judged the visit at 14:00 (rain at 14 hits); the recheck re-judged it at 08:00 (hours 8 to 10 read dry).
    const conn = seeded({ recheck: { at: '2026-11-25T11:06:00.000Z', checked: 1, dry: 0, proposals: [{ id: 'a', gauges: G.a, start: '08:00', span: [480, 540], decision: 'none', reason: 'no_dry_hour' }] } });
    await run({ now: FRI, conn, fetchObs: fetchObs({ VNC: [14], SRQ: [] }), deps: deps([]) });
    const v = daysOf(conn)[WED].score.visits.a;
    expect(v).toMatchObject({ wet: true, cutoff: 'hit', recheck: 'ok', recheck_wet: false });
    expect(daysOf(conn)[WED].score.recheck).toMatchObject({ ok: 1, miss: 0 });
  });

  test('a recheck whose own span has an unread hour waits, even when the cutoff span read fully', async () => {
    const conn = seeded({ recheck: { at: '2026-11-25T11:06:00.000Z', checked: 1, dry: 0, proposals: [{ id: 'a', gauges: G.a, start: '08:00', span: [480, 540], decision: 'none', reason: 'no_dry_hour' }] } });
    const gapped = jest.fn(async () => { const o = obsWith({ VNC: [14], SRQ: [] }); delete o.VNC[9]; delete o.SRQ[9]; return o; });
    const out = await run({ now: FRI, conn, fetchObs: gapped, deps: deps([]) });
    expect(out.scored).toEqual([]);
  });

  describe('a day with no outdoor visit', () => {
    const emptyDay = () => fakeConn({ [record.DAYS_KEY]: JSON.stringify({ [WED]: { day: WED, recheck: { at: 'x', checked: 0, dry: 0, proposals: [] } } }) });

    test('an IEM outage never freezes a score, not even past the give-up days; a successful read with no reports does', async () => {
      const conn = emptyDay();
      const down = jest.fn(async () => null); // a 429, a timeout, a bad reply: not read this run
      const late = parseETDateTime('2026-12-02T06:06');
      expect((await run({ now: FRI, conn, fetchObs: down, deps: deps([]) })).scored).toEqual([]);
      expect((await run({ now: late, conn, fetchObs: down, deps: deps([]) })).scored).toEqual([]);
      expect(daysOf(conn)[WED].score).toBeUndefined();
      const empty = jest.fn(async () => ({ SRQ: {}, VNC: {}, PGD: {}, SPG: {} })); // IEM answered, no gauge reported
      expect((await run({ now: FRI, conn, fetchObs: empty, deps: deps([]) })).scored).toEqual([]);
      const done = await run({ now: late, conn, fetchObs: empty, deps: deps([]) });
      expect(done.scored).toEqual([WED]);
      expect(daysOf(conn)[WED].score).toMatchObject({ partial: true, day: { wet_day: null } });
    });

    test('at the give-up deadline both graders reach the same partial day verdict from the same readings', async () => {
      // Gaps at SRQ leave Parrish, Palmetto and Bradenton N open (no second gauge reports); Lakewood, Sarasota (they read the
      // Venice gauge for those hours) and Venice settle dry: the three settled areas decide, marked partial.
      const o = obsWith({ VNC: [], SRQ: [8, 9] }, { SRQ: [10, 11, 12, 13, 14, 15, 16], VNC: [] });
      const obs = jest.fn(async () => o);
      const conn = emptyDay();
      await run({ now: parseETDateTime('2026-12-02T06:06'), conn, fetchObs: obs, deps: deps([]) });
      const mine = daysOf(conn)[WED].score.day;
      const theirs = rainMode.scoreDay;
      const ads = await theirs({ day: WED, call: 'rain' }, { fetchObs: obs, now: parseETDateTime('2026-12-02T06:06') });
      expect(ads).toMatchObject({ partial: true, wet_areas: mine.wet_areas, wet_day: mine.wet_day });
      expect(mine).toMatchObject({ partial: true, wet_day: false, unknown: 3 });
    });

    test('a day read in full is scored final with its wet day', async () => {
      const conn = emptyDay();
      await run({ now: FRI, conn, fetchObs: jest.fn(async () => allHours(0.5)), deps: deps([]) });
      expect(daysOf(conn)[WED].score).toMatchObject({ partial: false, day: { wet_day: true } });
    });
  });

  test('a span nobody measured stores inches null, never 0; a partly read span stores its total and how many hours were missing', async () => {
    const conn = seeded({}, [
      { id: 'a', gauges: G.a, start: '14:00', span: [840, 900], decision: 'none', reason: 'no_dry_hour' },
      { id: 'c', gauges: G.c, start: '14:00', span: [840, 900], decision: 'none', reason: 'no_dry_hour' },
    ]);
    // Venice gauges report nothing for the span (hours 14 to 16); Sarasota's gauges miss only hour 15 and read rain at 14.
    const o = obsWith({ VNC: [], SRQ: [14] });
    for (const h of [14, 15, 16]) delete o.VNC[h];
    delete o.SRQ[15];
    const out = await run({ now: parseETDateTime('2026-12-02T06:06'), conn, fetchObs: jest.fn(async () => o), deps: deps([]) });
    expect(out.scored).toEqual([WED]);
    const { score } = daysOf(conn)[WED];
    // 'a' sits at 27.1 (Venice side): its nearest gauges are VNC then SRQ; SRQ fills 14 and 16 so it is not wholly unread.
    expect(score.visits.c).toMatchObject({ wet: true, inches: 0.02, missing: 1 });
    expect(score.partial).toBe(false);
  });

  test('a visit whose every hour is unread has inches null', async () => {
    const conn = seeded({}, [{ id: 'a', gauges: G.a, start: '14:00', span: [840, 900], decision: 'none', reason: 'no_dry_hour' }]);
    const o = obsWith({ VNC: [], SRQ: [] });
    for (const h of [14, 15, 16]) { delete o.VNC[h]; delete o.SRQ[h]; }
    await run({ now: parseETDateTime('2026-12-02T06:06'), conn, fetchObs: jest.fn(async () => o), deps: deps([]) });
    expect(daysOf(conn)[WED].score.visits.a).toMatchObject({ wet: null, inches: null, missing: 3 });
  });

  test('the day is also graded per forecast area: rain before work does not make a wet day (2026-11-25)', async () => {
    const conn = seeded();
    // 7 wet work hours at Venice, 2 at Sarasota: one wet area of six.
    await run({ now: FRI, conn, fetchObs: fetchObs({ VNC: [8, 9, 10, 11, 12, 13, 14], SRQ: [8, 9] }), deps: deps([]) });
    const { day } = daysOf(conn)[WED].score;
    expect(day).toMatchObject({ wet_areas: ['venice_north_port'], wet_day: false });
    expect(day.wet_hours.sarasota).toBe(2);
  });

  test('a day the daily radar grader scored is graded again, and that score stays as score_daily', async () => {
    const conn = seeded({ score: { partial: false, visits: { a: { wet: true } }, cutoff: { hit: 9 } } });
    const out = await run({ now: FRI, conn, fetchObs: fetchObs({ VNC: [], SRQ: [] }), deps: deps([]) });
    expect(out.scored).toEqual([WED]);
    const row = daysOf(conn)[WED];
    expect(row.score.basis).toBe('work_hours');
    expect(row.score_daily).toEqual({ partial: false, visits: { a: { wet: true } }, cutoff: { hit: 9 } });
  });

  test('a day is scored once, and the day itself is not scored while it is still today', async () => {
    const conn = seeded();
    const obs = fetchObs({ VNC: [], SRQ: [] });
    await run({ now: WED_RECHECK, conn, fetchObs: obs, deps: deps([stop({ scheduled_date: '2026-11-26' })]) });
    expect(obs).not.toHaveBeenCalled();
    await run({ now: FRI, conn, fetchObs: obs, deps: deps([]) });
    const calls = obs.mock.calls.length;
    await run({ now: parseETDateTime('2026-11-27T14:06'), conn, fetchObs: obs, deps: deps([]) });
    expect(obs.mock.calls.length).toBe(calls);
  });
});

describe('one forecast snapshot per visit point per run', () => {
  const atPoint = (read, point) => read.mock.calls.filter(([lat, lng]) => lat === point.lat && lng === point.lng).length;

  test('the visit\'s point is read once for the run, whatever path the decision takes: verdict and alternatives share it', async () => {
    for (const [wet, decision] of [[MORNING, 'reorder'], [ALL_DAY, 'day_move'], [{ ...ALL_DAY, [THU]: 'all' }, 'call_list']]) {
      n = 0;
      const rows = [stop()];
      const read = jest.fn(async () => hoursFor(wet));
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read });
      expect(out.proposals[0].decision).toBe(decision);
      expect(atPoint(read, rows[0].point)).toBe(1);
    }
  });

  test('a forecast that goes from wet to dry between would-be reads cannot split a visit: the verdict and the alternatives use the first read', async () => {
    n = 0;
    const rows = [stop()];
    let calls = 0;
    const read = jest.fn(async (lat, lng) => {
      if (lat === rows[0].point.lat && lng === rows[0].point.lng) calls += 1;
      return hoursFor(calls <= 1 ? ALL_DAY : {});
    });
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read });
    expect(calls).toBe(1);
    // Wet on the one snapshot (peak 80), and its alternatives judged on that same all-day rain: the next work day.
    expect(out.proposals[0]).toMatchObject({ peak: 80, decision: 'day_move', to_date: THU });
  });

  test('two visits at one point share one read; a point that failed stays unread for the run', async () => {
    n = 0;
    const rows = [stop({ point: { lat: 27.41, lng: -82.4 } }), stop({ point: { lat: 27.41, lng: -82.4 } })];
    const read = jest.fn(async () => hoursFor(MORNING));
    await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read });
    expect(atPoint(read, rows[0].point)).toBe(1);
  });
});

describe('proposals that failed to plan', () => {
  test('an error proposal keeps the visit\'s own span (and stop ids), so it can still be graded', async () => {
    const rows = [stop(), stop()];
    const d = deps(rows);
    d.rainOut.conflictsForTarget = jest.fn(() => { throw new Error('occupancy rows unreadable'); });
    const { decideDay } = record;
    const planned = rainPass._test.groupStops(rows);
    const out = await decideDay(planned.map((visit) => ({ visit, start: '09:00', date: WED, wet: true, peak: 80, reason: 'wet', proposal: '12:00' })), {
      day: WED, today: '2026-11-24', read: async () => { throw new Error('boom'); }, occupied: () => false,
      blackouts: async () => new Set(), seriesRows: async () => new Map(), dayHours: { startMin: 480, endMin: 1020 }, earliestMin: 0,
    });
    expect(out.proposals).toHaveLength(2);
    for (const p of out.proposals) {
      expect(p).toMatchObject({ decision: 'none', reason: 'error', start: '09:00' });
      expect(p.span).toEqual([540, expect.any(Number)]);
    }
  });
});

describe('what a proposal stores for the replay and the grade', () => {
  test('every decision stores the hours it used (raw, from the visit\'s snapshot) and the gauge IDs, never coordinates', async () => {
    // A visit at 09:00 with the forecast hours at fractional values the rules compare against 70 and 40.
    const hours = hoursFor(MORNING).map((h) => (h.startTime.startsWith(`${WED}T09`) ? { ...h, rainChance: 69.6 } : h));
    const conn = fakeConn();
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps([stop()]), read: jest.fn(async () => hours) });
    const p = out.proposals[0];
    // Hours 9, 10, 11 (the visit, 1 hour) through its 2 drying hours: the 9 AM reading is stored as read.
    expect(p.span_chances).toEqual([69.6, 80, 80]);
    expect(p.gauges).toEqual(['SRQ', 'VNC']);
    expect(JSON.stringify(daysOf(conn)[WED].cutoff.proposals)).not.toMatch(/27\.4|-82\.4|"lat"|"lng"/);
  });

  test('a forecast_dry visit stores its hours too', async () => {
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]), read: jest.fn(async () => hoursFor({})) });
    expect(out.proposals[0]).toMatchObject({ reason: 'forecast_dry', span_chances: [10, 10, 10], gauges: expect.any(Array) });
  });

  test('a day move and a call list store the next work day\'s work hours it judged', async () => {
    const move = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]), read: jest.fn(async () => hoursFor({ ...ALL_DAY, [THU]: [8, 9] })) });
    expect(move.proposals[0]).toMatchObject({ decision: 'day_move', next_day: THU, next_day_chances: [80, 80, 10, 10, 10, 10, 10, 10, 10, 10, 10] });
    n = 0;
    const call = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()]), read: jest.fn(async () => hoursFor({ ...ALL_DAY, [THU]: 'all' })) });
    expect(call.proposals[0]).toMatchObject({ decision: 'call_list', next_day: THU, next_day_chances: Array(11).fill(80) });
  });

  test('an error proposal keeps its gauges as well as its span', async () => {
    const rows = [stop()];
    const planned = rainPass._test.groupStops(rows);
    const out = await record.decideDay(planned.map((visit) => ({ visit, start: '09:00', date: WED, wet: true, peak: 80, reason: 'wet', proposal: '12:00' })), {
      day: WED, today: '2026-11-24', read: async () => { throw new Error('boom'); }, occupied: () => false,
      blackouts: async () => new Set(), seriesRows: async () => new Map(), dayHours: { startMin: 480, endMin: 1020 }, earliestMin: 0,
    });
    expect(out.proposals[0]).toMatchObject({ reason: 'error', gauges: ['SRQ', 'VNC'], span: [540, expect.any(Number)] });
  });
});

describe('grading from stored gauges only', () => {
  const FRI2 = parseETDateTime('2026-11-27T06:06');
  const seed = (proposals) => fakeConn({ [record.DAYS_KEY]: JSON.stringify({ [WED]: { day: WED, cutoff: { at: 'x', checked: 1, dry: 0, proposals } } }) });
  // Every hour of the day read at both gauges; `rainy` has measurable rain at 14, 15 and 16 (the visit and its drying hours).
  const day = (wet) => Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, wet && h >= 14 && h <= 16 ? 0.05 : 0]));
  const obsAt = (rainy) => jest.fn(async () => ({ SRQ: day(rainy === 'SRQ'), VNC: day(rainy === 'VNC'), PGD: day(false), SPG: day(false) }));

  test('the grade reads the gauges stored on the proposal, in their order, and never asks for the visit\'s point', async () => {
    const loadPoints = jest.fn(async () => { throw new Error('points must not be read'); });
    const conn = seed([{ id: 'a', gauges: ['VNC', 'SRQ'], start: '14:00', span: [840, 900], decision: 'reorder', to_start: '16:00' }]);
    const out = await run({ now: FRI2, conn, fetchObs: obsAt('VNC'), deps: deps([], { loadPoints }) });
    expect(out.problems).toEqual([]);
    expect(loadPoints).not.toHaveBeenCalled();
    expect(daysOf(conn)[WED].score.visits.a).toMatchObject({ wet: true, cutoff: 'hit' });
    // The same visit graded on SRQ first reads SRQ's hours, which are dry.
    const conn2 = seed([{ id: 'a', gauges: ['SRQ', 'VNC'], start: '14:00', span: [840, 900], decision: 'reorder', to_start: '16:00' }]);
    await run({ now: FRI2, conn: conn2, fetchObs: obsAt('VNC'), deps: deps([]) });
    expect(daysOf(conn2)[WED].score.visits.a).toMatchObject({ wet: false, cutoff: 'false_alarm' });
  });

  test('a proposal with no gauge IDs (a legacy record) stays ungraded, like a legacy span', async () => {
    const conn = seed([{ id: 'a', start: '14:00', span: [840, 900], decision: 'reorder', to_start: '16:00' }]);
    await run({ now: FRI2, conn, fetchObs: obsAt('VNC'), deps: deps([]) });
    expect(daysOf(conn)[WED].score.visits.a).toEqual({ inches: null, wet: null, missing: null, cutoff: null, recheck: null });
    expect(daysOf(conn)[WED].score.partial).toBe(false);
  });
});

describe('a scan with no work day in it', () => {
  const allClosed = () => jest.fn(async (from, to) => {
    // Every date of the range is a closure day.
    const out = new Set();
    for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d = new Date(d.getTime() + 24 * 3600 * 1000)) out.add(d.toISOString().slice(0, 10));
    return out;
  });

  test('is unresolved: none/no_work_day_in_scan, never call_list, and the day is not frozen', async () => {
    const conn = fakeConn();
    const d = deps([stop()], { blackoutDates: allClosed() });
    const out = await run({ now: TUE_CUTOFF, conn, deps: d, read: jest.fn(async () => hoursFor(ALL_DAY)) });
    expect(out.proposals[0]).toMatchObject({ decision: 'none', reason: 'no_work_day_in_scan' });
    expect(out.proposals.some((p) => p.decision === 'call_list')).toBe(false);
    expect(out.problems[0]).toMatch(/no work day within 8 days of 2026-11-25 for 1 visit/);
    expect(daysOf(conn)[WED]).toBeUndefined(); // nothing frozen: the retry decides again
    // The retry, once a day is open, takes the cutoff.
    n = 0;
    const retry = await run({ now: TUE_RETRY, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(ALL_DAY)) });
    expect(retry.problems).toEqual([]);
    expect(daysOf(conn)[WED].cutoff.proposals[0].decision).toBe('day_move');
  });

  test('a visit that reorders the same day is not touched by a closed next week', async () => {
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()], { blackoutDates: allClosed() }), read: jest.fn(async () => hoursFor(MORNING)) });
    expect(out.proposals[0].decision).toBe('reorder');
    expect(out.problems).toEqual([]);
  });
});

describe('rain-pass candidateStarts is the one walk', () => {
  const dayStartMin = 480;
  const dayEndMin = 1020;

  test('grouped offsets, duration limits and the earliest start; the current start is never a candidate', () => {
    // A grouped stop whose first member works 30 minutes before the anchor and which lasts 150 minutes in all.
    const reach = { startMin: 570, endMin: 720, ownStartMin: 600 };
    const c = rainPass.candidateStarts({ reach, earliestMin: 0, dayStartMin, dayEndMin });
    expect(c.every((x) => x.start === x.own - 30 && x.end - x.start === 150)).toBe(true);
    expect(c.some((x) => x.own === 600)).toBe(false);
    expect(c[0].own).toBe(480 + 60); // own 480 would start the whole span at 450, before the day
    expect(Math.max(...c.map((x) => x.end))).toBeLessThanOrEqual(dayEndMin);
    const lead = rainPass.candidateStarts({ reach, earliestMin: 780, dayStartMin, dayEndMin });
    expect(Math.min(...lead.map((x) => x.own))).toBe(780);
  });

  test('dryStart takes its starts from it: the nearest dry open one', () => {
    const reach = { startMin: 540, endMin: 600, ownStartMin: 540 };
    const dry = Array.from({ length: 24 }, (_, h) => ({ startTime: `${WED}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance: 0 }));
    const asked = [];
    const own = rainPass.dryStart({ hourly: dry, date: WED, reach, earliestMin: 0, dayStartMin, dayEndMin, isFree: (st, en) => { asked.push([st, en]); return st >= 660; } });
    expect(own).toBe(660);
    expect(asked).toEqual(rainPass.candidateStarts({ reach, earliestMin: 0, dayStartMin, dayEndMin }).map((x) => [x.start, x.end]));
  });
});

describe('one candidate list for the later-hour search and the unread check', () => {
  test('laterStarts is exactly what rain-pass dryStart walks, filtered to starts after the visit\'s own start', () => {
    const dayHours = { startMin: 480, endMin: 1020 };
    for (const reach of [{ startMin: 540, endMin: 600, ownStartMin: 540 }, { startMin: 480, endMin: 720, ownStartMin: 600 }, { startMin: 900, endMin: 1020, ownStartMin: 960 }]) {
      const walked = [];
      // dryStart only asks isFree for a dry start; an all-dry day makes it ask for every candidate it considers.
      const dry = Array.from({ length: 24 }, (_, h) => ({ startTime: `${WED}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance: 0 }));
      rainPass._test.dryStart({
        hourly: dry, date: WED, reach, earliestMin: 0, dayStartMin: dayHours.startMin, dayEndMin: dayHours.endMin,
        isFree: (start, end) => { walked.push({ start, end }); return false; },
      });
      const mine = record._test.laterStarts({ visit: { reach } }, { dayHours, earliestMin: 0 });
      const before = reach.ownStartMin - reach.startMin;
      expect(mine.map(({ start, end }) => ({ start, end }))).toEqual(walked.filter((w) => w.start + before > reach.ownStartMin));
    }
  });

  test('a later start whose own hours do not fit the day is never offered and never makes the day unread', async () => {
    // A 3-hour stop at 13:00 (13:00 to 16:00): a later own start would end after 17:00, so there is no candidate at all.
    const late = stop({ window_start: '13:00:00', window_end: '16:00:00', estimated_duration_minutes: 180 });
    const hours = hoursFor({ [WED]: [12, 13, 14, 15, 16] }).filter((h) => !(h.startTime.startsWith(WED) && Number(h.startTime.slice(11, 13)) >= 17));
    const d = deps([late]);
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hours) });
    expect(out.proposals[0]).toMatchObject({ decision: 'day_move' });
  });
});

describe('the forecast numbers are kept', () => {
  test('each entry holds the per-area NWS chance of every work hour of the target day, for a replay', async () => {
    const conn = fakeConn();
    await run({ now: TUE_CUTOFF, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(MORNING)) });
    const { chances } = daysOf(conn)[WED].cutoff;
    expect(Object.keys(chances)).toHaveLength(6);
    // 8 AM to 4 PM: the morning rain is 8 to 11, so the first four work hours read 80.
    expect(chances.parrish).toEqual([80, 80, 80, 80, 10, 10, 10, 10, 10]);
    n = 0;
    await run({ now: WED_RECHECK, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor({})) });
    expect(daysOf(conn)[WED].recheck.chances.parrish).toEqual(Array(9).fill(10));
    expect(daysOf(conn)[WED].cutoff.chances.parrish).toEqual([80, 80, 80, 80, 10, 10, 10, 10, 10]);
  });
});

// A full set of work-hour readings at every gauge: the day by area settles.
const allHours = (inches) => Object.fromEntries(['SRQ', 'VNC', 'PGD', 'SPG'].map((st) => [st, Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, inches]))]));

describe('it changes nothing', () => {
  test('a cutoff with a day move, a recheck and a score write only system_settings, and touch no visit table', async () => {
    const conn = fakeConn();
    // The recurrence read (a plain select of the stop's services) is stubbed: this test is about what is written and asked for.
    const d = () => deps([stop()], { loadSeries: jest.fn(async () => new Map()) });
    const read = jest.fn(async () => hoursFor(ALL_DAY));
    await run({ now: TUE_CUTOFF, conn, deps: d(), read });
    n = 0;
    await run({ now: WED_RECHECK, conn, deps: d(), read });
    await run({
      now: parseETDateTime('2026-11-27T06:06'), conn, deps: d(),
      read, fetchObs: jest.fn(async () => allHours(0.5)),
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
    await run({ now: TUE_CUTOFF, conn, deps: deps([stop({ service_address_line1: '1 Main St', point: { lat: 27.4, lng: -82.4 } })]), read: jest.fn(async () => hoursFor(MORNING)) });
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
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(same), read: jest.fn(async () => hoursFor(MORNING)) });
    expect(out.proposals.map((p) => [p.id, p.decision, p.to_start])).toEqual([['v01', 'reorder', '12:00'], ['v02', 'reorder', '13:00']]);
    n = 0;
    // With GATE_MULTI_TECH_CONFIRM on the probe is scoped to the technician's own route (see the gate tests below).
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const two = [stop({ technician_id: 'tx' }), stop({ technician_id: 'ty' })];
    const apart = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(two), read: jest.fn(async () => hoursFor(MORNING)) });
    expect(apart.proposals.map((p) => p.to_start)).toEqual(['12:00', '12:00']);
  });

  test('a span with an hour the forecast did not read is unread, not dry', async () => {
    const conn = fakeConn();
    // 09:00 reads 10%; 10:00 and 11:00 (the rest of the visit and its drying time) have no reading.
    const hours = hoursFor({}).filter((h) => !(h.startTime.startsWith(`${WED}T10`) || h.startTime.startsWith(`${WED}T11`)));
    const out = await run({ now: TUE_CUTOFF, conn, deps: deps([stop()]), read: jest.fn(async () => hours) });
    expect(out.proposals).toEqual([{ id: 'v01', start: '09:00', span: expect.any(Array), gauges: expect.any(Array), span_chances: expect.any(Array), peak: 10, decision: 'none', reason: 'unread_forecast' }]);
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
    expect(out.proposals).toEqual([{ id: 'v01', start: '08:00', span: expect.any(Array), gauges: expect.any(Array), span_chances: expect.any(Array), day_chances: expect.any(Array), peak: 80, decision: 'reorder', to_start: '11:00' }]);
  });

  test('the Saturday 2 PM run does not freeze Monday; the Sunday 2 PM run does', async () => {
    const MON = '2026-11-30';
    const monday = () => deps([stop({ scheduled_date: MON })]);
    const read = jest.fn(async () => hoursOn(MON, [8, 9, 10, 11]));
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
    await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hoursFor(MORNING)) });
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
    const retry = await run({ now: TUE_RETRY, conn, deps: deps([stop()]), read: jest.fn(async () => hoursFor(MORNING)) });
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
    // Saturday is wholly wet; Sunday is no work day, so the next work day is Monday, which the forecast does not cover: unread.
    expect(out.proposals[0]).toMatchObject({ decision: 'none', reason: 'unread_forecast' });
  });

  describe('over the cap', () => {
    // Visits 1 to 10 sit in afternoon rain (a dry morning); visit 11 sits in an all-day rain.
    const readBy = jest.fn(async (lat) => hoursFor(lat > 27.4105 ? ALL_DAY : MORNING));
    const ten = () => Array.from({ length: 11 }, () => stop());
    beforeEach(() => { process.env.GATE_MULTI_TECH_CONFIRM = 'true'; });

    test('a wholly wet stop over the cap is cap only when a valid move exists', async () => {
      const withMove = deps(ten());
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: withMove, read: readBy });
      expect(out.proposals.filter((p) => p.decision === 'reorder')).toHaveLength(10);
      expect(out.proposals[10]).toMatchObject({ id: 'v11', decision: 'cap', would: 'day_move', to_date: THU });
      n = 0;
      const noMove = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(ten(), { rainOut: { loadOccupancy: jest.fn(async () => ({ rows: [] })), conflictsForTarget: jest.fn((_s, _id, date) => (date === THU ? [{ id: 'other' }] : [])) } }), read: readBy });
      expect(noMove.proposals[10]).toMatchObject({ id: 'v11', decision: 'call_list', reason: 'no_dry_slot' });
    });

    test('a reorder over the cap never names an hour an accepted proposal of the same technician holds', async () => {
      process.env.GATE_MULTI_TECH_CONFIRM = 'true';
      const rows = [stop({ technician_id: 'tx' }), ...Array.from({ length: 9 }, () => stop()), stop({ technician_id: 'tx' })];
      const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: deps(rows), read: jest.fn(async () => hoursFor(MORNING)) });
      expect(out.proposals[0]).toMatchObject({ id: 'v01', decision: 'reorder', to_start: '12:00' });
      expect(out.proposals[10]).toMatchObject({ id: 'v11', decision: 'cap', would: 'reorder', to_start: '13:00' });
    });
  });

  test('a scoring failure never drops the day decision: the cutoff is saved and the error recorded', async () => {
    const SAT = '2026-11-28';
    const old = { day: WED, cutoff: { at: 'x', checked: 1, dry: 0, proposals: [{ id: 'a', gauges: ['VNC', 'SRQ'], start: '14:00', span: [840, 900], decision: 'reorder', to_start: '16:00' }] } };
    const conn = fakeConn({ [record.DAYS_KEY]: JSON.stringify({ [WED]: old }) });
    const d = deps([stop({ scheduled_date: SAT })]);
    // A reading object that throws when the grader looks at it: a scoring failure that has nothing to do with the day's decision.
    const broken = { get SRQ() { throw new Error('obs boom'); }, VNC: {}, PGD: {}, SPG: {} };
    const hours = Array.from({ length: 24 }, (_, h) => ({ startTime: `${SAT}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance: h >= 8 && h <= 11 ? 80 : 10 }));
    const out = await run({ now: parseETDateTime('2026-11-27T14:06'), conn, deps: d, read: jest.fn(async () => hours), fetchObs: jest.fn(async () => broken) });
    expect(out.problems).toEqual(['scoring failed: obs boom']);
    expect(daysOf(conn)[SAT].cutoff.proposals[0]).toMatchObject({ decision: 'reorder' });
    expect(daysOf(conn)[WED].score).toBeUndefined();
    expect(JSON.parse(conn.store[record.LAST_KEY]).error).toBe('scoring failed: obs boom');
  });

  test('a later hour with no reading and none read wet is unread_forecast, never a move or a call', async () => {
    const d = deps([stop()]);
    // Rain 8 to 11, and no reading from 12:00 on: no later start can be called dry or wet.
    const hours = hoursFor({ [WED]: [8, 9, 10, 11] }).filter((h) => !(h.startTime.startsWith(WED) && Number(h.startTime.slice(11, 13)) >= 12));
    const out = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: d, read: jest.fn(async () => hours) });
    expect(out.proposals[0]).toMatchObject({ decision: 'none', reason: 'unread_forecast' });
    expect(d.blackoutDates).not.toHaveBeenCalled();
  });

  test('a catalog read that fails stops the run: nothing is frozen and no name rule is used instead', async () => {
    const conn = fakeConn();
    const broken = deps([stop(), stop()], { withCatalogKeys: jest.fn(async () => { throw new Error('catalog down'); }) });
    const out = await run({ now: TUE_CUTOFF, conn, deps: broken, read: jest.fn(async () => hoursFor(MORNING)) });
    expect(out.problems).toEqual(['the run failed: catalog down']);
    expect(daysOf(conn)[WED]).toBeUndefined();
  });

  test('a day where every visit failed to plan is a problem and freezes nothing', async () => {
    const conn = fakeConn();
    const broken = deps([stop(), stop()]);
    broken.rainOut.conflictsForTarget = jest.fn(() => { throw new Error('occupancy rows unreadable'); });
    const out = await run({ now: TUE_CUTOFF, conn, deps: broken, read: jest.fn(async () => hoursFor(MORNING)) });
    expect(out.problems[0]).toMatch(/forecast unread for all 2 outdoor visit/);
    expect(daysOf(conn)[WED]).toBeUndefined();
    // A visit with no point stays out of the count: one error and one no-point visit is still every readable visit.
    n = 0;
    const mixed = deps([stop({ point: null }), stop()]);
    mixed.rainOut.conflictsForTarget = jest.fn(() => { throw new Error('occupancy rows unreadable'); });
    const two = await run({ now: TUE_CUTOFF, conn: fakeConn(), deps: mixed, read: jest.fn(async () => hoursFor(MORNING)) });
    expect(two.problems[0]).toMatch(/forecast unread for all 1 outdoor visit/);
  });

  test('thunderstorms at 50% PoP and Tropical Storm Warnings trigger reorder/day_move while Heat Advisory stays dry', async () => {
    // Thunder during 09:00 on Wednesday (55% PoP, below 70% rain threshold) -> reorders to dry afternoon slot.
    const thunderHours = hoursFor({}).map((h) => (
      h.startTime.startsWith(`${WED}T09`) ? { ...h, rainChance: 55, hasThunder: true, shortForecast: 'Chance Thunderstorms' } : h
    ));
    const thunderOut = await run({
      now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()], { activeAlerts: jest.fn(async () => []) }),
      read: jest.fn(async () => thunderHours),
    });
    expect(thunderOut.proposals[0]).toMatchObject({ decision: 'reorder', storm_hazard: 'thunderstorms' });

    // Tropical Storm Warning covering all of Wednesday (10% rain) -> day_move to Thursday.
    n = 0;
    const tsAlert = {
      event: 'Tropical Storm Warning', category: 'tropical_storm', moveTrigger: true,
      onset: `${WED}T06:00:00-05:00`, expires: `${WED}T22:00:00-05:00`,
    };
    const tsOut = await run({
      now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()], { activeAlerts: jest.fn(async () => [tsAlert]) }),
      read: jest.fn(async () => hoursFor({})),
    });
    expect(tsOut.proposals[0]).toMatchObject({ decision: 'day_move', to_date: THU, storm_hazard: 'Tropical Storm Warning' });

    // Heat Advisory on dry Wednesday -> remains forecast_dry with informational advisories.
    n = 0;
    const heatAlert = {
      event: 'Heat Advisory', category: 'heat_advisory', moveTrigger: false,
      onset: `${WED}T10:00:00-05:00`, expires: `${WED}T18:00:00-05:00`,
    };
    const heatOut = await run({
      now: TUE_CUTOFF, conn: fakeConn(), deps: deps([stop()], { activeAlerts: jest.fn(async () => [heatAlert]) }),
      read: jest.fn(async () => hoursFor({})),
    });
    expect(heatOut.proposals[0]).toMatchObject({ decision: 'none', reason: 'forecast_dry' });
    expect(heatOut.proposals[0].advisories).toEqual([{ event: 'Heat Advisory', category: 'heat_advisory' }]);
  });
});
