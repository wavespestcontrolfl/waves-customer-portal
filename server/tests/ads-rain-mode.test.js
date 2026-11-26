/**
 * Rain-day ads record (services/ads/rain-mode.js). Record only: these tests prove the day it decides for, the rain-day
 * rule (4+ work hours at 70%+ in half the areas read), what each campaign class would get, that unknown is never
 * dry, and the next-day score against measured radar rain.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  getNwsHourlyRain: jest.fn(),
  getNwsHourlyRainPatient: (...args) => jest.requireActual('../services/weather-forecast').getNwsHourlyRainPatient(...args),
}));
jest.mock('../services/mrms-qpe', () => ({ fetchMrmsDailyRain: jest.fn() }));

const rainMode = require('../services/ads/rain-mode');
const { soldDay } = require('../services/ads/budget-manager');
const { ZONE_COORDS } = require('../services/scheduling/forecast-zones');

const ZONES = Object.keys(ZONE_COORDS);

// NWS-shaped hours for `day`, 8 AM to 4 PM ET, with `wetHours` of them at `pct`.
function hours(day, wetHours, pct = 80) {
  return Array.from({ length: 9 }, (_, i) => ({
    startTime: `${day}T${String(8 + i).padStart(2, '0')}:00:00-05:00`,
    rainChance: i < wetHours ? pct : 10,
  }));
}

// A reader that answers each area by its order in ZONES.
function readerFor(day, plan) {
  return jest.fn(async (lat, lng) => {
    const i = ZONES.findIndex((z) => ZONE_COORDS[z].lat === lat && ZONE_COORDS[z].lng === lng);
    const p = plan[i];
    if (p === null) return null;
    return hours(day, p);
  });
}

// Hourly gauge readings, ET hour -> inches. SRQ stands for the five areas around Sarasota, VNC for Venice/N. Port.
// `wet` = work hours (8 AM on) with 0.05 in; the rest read dry; `gone` = work hours with no report.
const hourRow = (wet, gone = []) => Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, h >= 8 && h < 17 && h - 8 < wet ? 0.05 : 0])
  .filter(([h]) => !gone.includes(Number(h))));
const obsOf = ({ SRQ, VNC }, gone = {}) => ({ SRQ: hourRow(SRQ, gone.SRQ), VNC: hourRow(VNC, gone.VNC), PGD: {}, SPG: {} });
const obsFetch = (plan, gone) => jest.fn(async () => obsOf(plan, gone));

function fakeConn({ campaigns = [], settings = {} } = {}) {
  const store = { ...settings };
  const conn = jest.fn((table) => ({
    where(cond) {
      if (table === 'ad_campaigns') return Promise.resolve(campaigns);
      return { first: async () => (store[cond.key] != null ? { key: cond.key, value: store[cond.key] } : undefined) };
    },
  }));
  conn.transaction = async (cb) => cb((table) => ({
    where: (cond) => ({ first: async () => (store[cond.key] != null ? { key: cond.key, value: store[cond.key] } : undefined) }),
    insert: (row) => ({ onConflict: () => ({ merge: async () => { store[row.key] = row.value; } }) }),
  }));
  conn.store = store;
  return conn;
}

// Tuesday 2026-11-24, 3 PM ET (EST): the ads sell Wednesday.
const AFTER_TWO = new Date('2026-11-24T20:00:00Z');

describe('soldDay', () => {
  test('before 2 PM ET the ads sell today, from 2 PM tomorrow, on Sunday Monday', () => {
    expect(soldDay(new Date('2026-11-24T18:59:00Z'))).toBe('2026-11-24');
    expect(soldDay(new Date('2026-11-24T19:00:00Z'))).toBe('2026-11-25');
    expect(soldDay(new Date('2026-11-22T14:00:00Z'))).toBe('2026-11-23');
  });
});

describe('rainClassOf and decideCampaign', () => {
  test('marked classes and route lines; the brand campaign is left alone', () => {
    expect(rainMode.rainClassOf({ metadata: { rain_class: 'indoor' } })).toBe('indoor');
    expect(rainMode.rainClassOf({ metadata: JSON.stringify({ route_line: 'pest' }) })).toBe('outdoor');
    expect(rainMode.rainClassOf({ metadata: {} })).toBeNull();
    // A hand-set rain_class wins over a route line.
    expect(rainMode.rainClassOf({ metadata: { route_line: 'pest', rain_class: 'indoor' } })).toBe('indoor');
    expect(rainMode.decideCampaign('outdoor', 'rain')).toBe('stop');
    expect(rainMode.decideCampaign('outdoor', 'dry')).toBe('base');
    expect(rainMode.decideCampaign('indoor', 'rain')).toBe('base');
    expect(rainMode.decideCampaign('indoor', 'dry')).toBe('stop');
    expect(rainMode.decideCampaign(null, 'rain')).toBeNull();
    expect(rainMode.decideCampaign('outdoor', 'unknown')).toBeNull();
  });
});

describe('forecastDay', () => {
  test('an area NWS does not answer is asked once more, with the long wait; a second miss stays unread', async () => {
    const calls = [];
    const flaky = jest.fn(async (lat, lng, opts) => {
      calls.push(opts);
      return calls.length <= 2 ? null : hours('2026-11-25', 0); // the first two reads fail, then NWS answers
    });
    const out = await rainMode.forecastDay('2026-11-25', { read: flaky });
    expect(calls.every((o) => o && o.fetchTimeoutMs === 10000)).toBe(true);
    expect(flaky.mock.calls.length).toBe(8); // 6 areas, 2 of them asked twice
    expect(out.unread).toEqual([]);

    const never = jest.fn(async () => null);
    const none = await rainMode.forecastDay('2026-11-25', { read: never });
    expect(never.mock.calls.length).toBe(12);
    expect(none.unread.length).toBe(6);
  });

  test('an area is wet at 4 work hours at 70%+, not at 3 or at 69%', async () => {
    expect(rainMode.countWetHours(hours('2026-11-25', 4), '2026-11-25').wet).toBe(4);
    expect(rainMode.countWetHours(hours('2026-11-25', 9, 69), '2026-11-25').wet).toBe(0);
    const out = await rainMode.forecastDay('2026-11-25', { read: readerFor('2026-11-25', [4, 4, 4, 3, 0, 0]) });
    expect(out.areas.map((a) => a.rain)).toEqual([true, true, true, false, false, false]);
    expect(out.call).toBe('rain'); // half the areas read
  });

  test('fewer than half wet is a dry day', async () => {
    const out = await rainMode.forecastDay('2026-11-25', { read: readerFor('2026-11-25', [9, 9, 0, 0, 0, 0]) });
    expect(out.call).toBe('dry');
  });

  test('unread areas are never counted dry; too few read = unknown', async () => {
    const out = await rainMode.forecastDay('2026-11-25', { read: readerFor('2026-11-25', [0, 0, null, null, null, null]) });
    expect(out.unread).toHaveLength(4);
    expect(out.call).toBe('unknown');
  });
});

describe('recordRun', () => {
  const campaigns = [
    { id: 1, campaign_name: 'Brand', status: 'active', metadata: {} },
    { id: 2, campaign_name: 'Pest route', status: 'paused', metadata: { route_line: 'pest' } },
    { id: 3, campaign_name: 'Indoor', status: 'active', metadata: { rain_class: 'indoor' } },
    { id: 4, campaign_name: 'Old', status: 'removed', metadata: { rain_class: 'outdoor' } },
  ];

  test('records what each campaign would get on a rain day and writes nothing else', async () => {
    const conn = fakeConn({ campaigns });
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [6, 6, 6, 6, 0, 0]), fetchRain: jest.fn() });
    expect(run.day).toBe('2026-11-25');
    expect(run.call).toBe('rain');
    expect(run.campaigns.map((c) => [c.campaign_id, c.would])).toEqual([[1, null], [2, 'stop'], [3, 'base']]);
    expect(run.problems).toEqual([]);
    const days = JSON.parse(conn.store[rainMode.DAYS_KEY]);
    expect(days['2026-11-25']).toMatchObject({ call: 'rain', areas: ZONES.slice(0, 4) });
    expect(JSON.parse(conn.store[rainMode.LAST_KEY]).mode).toBe('shadow');
  });

  test('an unknown forecast is a problem and the record throws for job_health', async () => {
    const conn = fakeConn({ campaigns });
    await expect(rainMode.recordRainMode({ now: AFTER_TWO, conn, read: jest.fn(async () => null), fetchRain: jest.fn() }))
      .rejects.toThrow(/forecast unsettled for 2026-11-25/);
  });

  test('scores a past day on measured work-hour rain once, never rewrites it, and regrades a day the daily grader scored', async () => {
    const settings = {
      [rainMode.DAYS_KEY]: JSON.stringify({
        '2026-11-23': { day: '2026-11-23', call: 'rain', areas: [] },
        '2026-11-22': { day: '2026-11-22', call: 'dry', areas: [], score: { basis: 'work_hours', hit: true } },
        '2026-11-21': { day: '2026-11-21', call: 'rain', areas: [], score: { hit: false, wet_day: false } },
      }),
    };
    const conn = fakeConn({ campaigns, settings });
    // Five areas read wet at SRQ (6 work hours), Venice dry: a wet day.
    const fetchObs = obsFetch({ SRQ: 6, VNC: 0 });
    const fetchRain = jest.fn(async ({ start }) => ({ days: [{ date: start, inches: 0.1 }] }));
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain, fetchObs });
    expect(run.scored.sort()).toEqual(['2026-11-21', '2026-11-23']);
    const days = JSON.parse(conn.store[rainMode.DAYS_KEY]);
    expect(days['2026-11-23'].score).toMatchObject({ basis: 'work_hours', wet_areas: ZONES.slice(0, 5), wet_day: true, hit: true });
    expect(days['2026-11-23'].score.measured[ZONES[0]]).toMatchObject({ wet_hours: 6, missing: 0, wet: true });
    // A day first graded here also gets the daily radar score, for comparison (0.1 in is a dry day by radar).
    expect(days['2026-11-23'].score_daily).toMatchObject({ wet_day: false, hit: false });
    // The old score moves to score_daily; the new one is primary.
    expect(days['2026-11-21'].score_daily).toEqual({ hit: false, wet_day: false });
    expect(days['2026-11-21'].score).toMatchObject({ basis: 'work_hours', hit: true });
    expect(days['2026-11-22'].score).toEqual({ basis: 'work_hours', hit: true });
    expect(fetchObs).toHaveBeenCalledTimes(2);
  });

  test('the 2026-11-25 shape: rain mostly before work and a wet Venice is not a wet day', async () => {
    // Daily radar would read all six areas wet. Work hours: SRQ areas 2 wet hours (dry), Venice 7 (wet): 1 of 6.
    const score = await rainMode.scoreDay({ day: '2026-11-25', call: 'rain', cutoff_call: 'rain' }, { fetchObs: obsFetch({ SRQ: 2, VNC: 7 }), now: new Date('2026-11-26T20:00:00Z') });
    expect(score).toMatchObject({ wet_areas: ['venice_north_port'], wet_day: false, hit: false, cutoff_hit: false });
  });
  test('a day the gauges did not answer for stays unscored for the next run', async () => {
    const settings = { [rainMode.DAYS_KEY]: JSON.stringify({ '2026-11-23': { day: '2026-11-23', call: 'dry', areas: [] } }) };
    const conn = fakeConn({ campaigns, settings });
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn(async () => null), fetchObs: jest.fn(async () => null) });
    expect(run.scored).toEqual([]);
    const row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-23'];
    expect(row.score).toBeUndefined();
    expect(row.score_tried_at).toBe(AFTER_TWO.toISOString());
  });
  test('an open area (missing hours could still make it wet) is not counted, and unknown keeps the settled call', async () => {
    // Morning of the sold day: hours already over are gone from the feed.
    const partHours = (day) => hours(day, 2).slice(4); // 8-11 AM gone: 5 dry hours left, 4 missing = open
    const open = rainMode.countWetHours(partHours('2026-11-25'), '2026-11-25');
    expect(open).toEqual({ wet: 0, missing: 4 });
    const forecast = await rainMode.forecastDay('2026-11-25', { read: jest.fn(async () => partHours('2026-11-25')) });
    expect(forecast.areas.every((a) => a.rain === null)).toBe(true);
    expect(forecast.call).toBe('unknown');

    const settings = { [rainMode.DAYS_KEY]: JSON.stringify({ '2026-11-25': { day: '2026-11-25', call: 'rain', areas: ZONES } }) };
    const conn = fakeConn({ campaigns, settings });
    const morning = new Date('2026-11-25T17:00:00Z'); // noon ET on the sold day
    const run = await rainMode.recordRun({ now: morning, conn, read: jest.fn(async () => partHours('2026-11-25')), fetchRain: jest.fn(async () => null) });
    expect(run.problems).toEqual([]);
    expect(run.forecast_call).toBe('unknown');
    expect(run.call).toBe('rain');
    expect(run.campaigns.find((c) => c.campaign_id === 2).would).toBe('stop');
    expect(JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'].call).toBe('rain');
  });

  test('a gauge gap that could flip the score waits; after the give-up days the areas read decide', async () => {
    // SRQ: 2 wet work hours, 5 reports gone: Lakewood and Sarasota read the Venice gauge for those hours (dry), but
    // Parrish, Palmetto and Bradenton N have no second gauge with reports: 3 open areas could still flip a dry day.
    const gone = { SRQ: [10, 11, 12, 13, 14] };
    const fetchObs = obsFetch({ SRQ: 2, VNC: 2 }, gone);
    const row = { day: '2026-11-23', call: 'rain', areas: [] };
    expect(await rainMode.scoreDay(row, { fetchObs, now: new Date('2026-11-24T20:00:00Z') })).toBeNull();
    const late = await rainMode.scoreDay(row, { fetchObs, now: new Date('2026-12-01T20:00:00Z') });
    expect(late).toMatchObject({ partial: true, wet_day: false, hit: false });
  });

  test('a short gap that cannot flip the area does not hold the score', async () => {
    // 7 wet hours and 2 gone at SRQ: wet either way.
    const score = await rainMode.scoreDay({ day: '2026-11-23', call: 'rain' }, { fetchObs: obsFetch({ SRQ: 7, VNC: 0 }, { SRQ: [15, 16] }), now: new Date('2026-11-24T20:00:00Z') });
    expect(score).toMatchObject({ partial: false, wet_day: true });
  });
  test('a day waiting on the gauges does not block the days after it', async () => {
    const settings = {
      [rainMode.DAYS_KEY]: JSON.stringify({
        '2026-11-18': { day: '2026-11-18', call: 'dry', areas: [], score_tried_at: '2026-11-24T18:00:00Z' },
        '2026-11-19': { day: '2026-11-19', call: 'dry', areas: [], score_tried_at: '2026-11-24T18:00:00Z' },
        '2026-11-20': { day: '2026-11-20', call: 'dry', areas: [], score_tried_at: '2026-11-24T18:00:00Z' },
        '2026-11-21': { day: '2026-11-21', call: 'dry', areas: [] },
      }),
    };
    const conn = fakeConn({ campaigns, settings });
    const fetchObs = jest.fn(async (day) => (day === '2026-11-21' ? obsOf({ SRQ: 0, VNC: 0 }) : null));
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn(async () => null), fetchObs });
    expect(run.scored).toEqual(['2026-11-21']);
    const days = JSON.parse(conn.store[rainMode.DAYS_KEY]);
    expect(days['2026-11-18'].score_tried_at).toBe(AFTER_TWO.toISOString());
  });

  test('a future day with only open areas fails the tick and freezes no cutoff', async () => {
    const conn = fakeConn({ campaigns });
    const oneHour = jest.fn(async () => hours('2026-11-25', 0).slice(0, 1)); // one dry hour per area: all open
    await expect(rainMode.recordRainMode({ now: AFTER_TWO, conn, read: oneHour, fetchRain: jest.fn() }))
      .rejects.toThrow(/forecast unsettled for 2026-11-25: 0 settled, 6 of 6 areas read/);
    const row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row.call).toBeUndefined();
    expect(row.cutoff_call).toBeUndefined();
    expect(row.cutoff_at).toBeUndefined();
  });
  test('the 2 PM call is kept beside later calls, and the score grades both', async () => {
    const conn = fakeConn({ campaigns });
    await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn() });
    const morning = new Date('2026-11-25T13:00:00Z'); // 8 AM ET on the day: now rain
    await rainMode.recordRun({ now: morning, conn, read: readerFor('2026-11-25', [9, 9, 9, 9, 9, 9]), fetchRain: jest.fn() });
    const row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row).toMatchObject({ call: 'rain', cutoff_call: 'dry', cutoff_at: AFTER_TWO.toISOString() });
    const score = await rainMode.scoreDay(row, { fetchObs: obsFetch({ SRQ: 6, VNC: 6 }), now: new Date('2026-11-26T20:00:00Z') });
    expect(score).toMatchObject({ wet_day: true, hit: true, cutoff_hit: false });
  });

  test('a Sunday morning call for Monday is not the cutoff; the Sunday 2 PM call is', async () => {
    const conn = fakeConn({ campaigns });
    const sundayMorning = new Date('2026-11-29T15:00:00Z'); // Sunday 10 AM ET, sells Monday 11-30
    await rainMode.recordRun({ now: sundayMorning, conn, read: readerFor('2026-11-30', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn() });
    expect(JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-30']).toMatchObject({ call: 'dry' });
    expect(JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-30'].cutoff_call).toBeUndefined();
    const sundayTwo = new Date('2026-11-29T19:00:00Z'); // Sunday 2 PM ET
    await rainMode.recordRun({ now: sundayTwo, conn, read: readerFor('2026-11-30', [9, 9, 9, 9, 0, 0]), fetchRain: jest.fn() });
    expect(JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-30']).toMatchObject({ call: 'rain', cutoff_call: 'rain', cutoff_at: sundayTwo.toISOString() });
  });

  test('rain at 10 AM, unknown at 2 PM, dry at 4 PM: the cutoff is the rain call in force at 2 PM', async () => {
    const conn = fakeConn({ campaigns });
    const at = (h) => new Date(`2026-11-29T${String(h + 5).padStart(2, '0')}:00:00Z`); // Sunday, ET hour h
    await rainMode.recordRun({ now: at(10), conn, read: readerFor('2026-11-30', [9, 9, 9, 9, 0, 0]), fetchRain: jest.fn() });
    const open = jest.fn(async () => hours('2026-11-30', 0).slice(0, 1));
    await rainMode.recordRainMode({ now: at(14), conn, read: open, fetchRain: jest.fn() }).catch(() => {});
    await rainMode.recordRun({ now: at(16), conn, read: readerFor('2026-11-30', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn() });
    expect(JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-30']).toMatchObject({ call: 'dry', cutoff_call: 'rain', cutoff_at: at(14).toISOString() });
  });

  test('an unsettled 2 PM run freezes no cutoff; the next settled run before the day takes it (2026-11-26 bug)', async () => {
    const conn = fakeConn({ campaigns });
    const at = (h) => new Date(`2026-11-24T${String(h + 5).padStart(2, '0')}:00:00Z`); // Tuesday, sells Wed from 2 PM
    const open = jest.fn(async () => hours('2026-11-25', 0).slice(0, 1));
    await rainMode.recordRainMode({ now: at(14), conn, read: open, fetchRain: jest.fn() }).catch(() => {});
    expect(JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'].cutoff_call).toBeUndefined();
    await rainMode.recordRun({ now: at(16), conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn() });
    const row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row).toMatchObject({ call: 'dry', cutoff_call: 'dry', cutoff_at: at(16).toISOString() });
    // Once the day has started a settled call is no cutoff: a day with none stays with no cutoff grade.
    const conn2 = fakeConn({ campaigns });
    await rainMode.recordRun({ now: new Date('2026-11-25T13:00:00Z'), conn: conn2, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn() });
    const row2 = JSON.parse(conn2.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row2.cutoff_call).toBeUndefined();
    expect(await rainMode.scoreDay(row2, { fetchObs: obsFetch({ SRQ: 0, VNC: 0 }), now: new Date('2026-11-26T20:00:00Z') })).toMatchObject({ hit: true, cutoff_hit: null });
  });
  test('a sold-day morning with no call in force fails; a second run of one tick replaces its history entry', async () => {
    const conn = fakeConn({ campaigns });
    const sixAm = new Date('2026-11-25T11:00:00Z');
    const open = jest.fn(async () => hours('2026-11-25', 0).slice(0, 1));
    await expect(rainMode.recordRainMode({ now: sixAm, conn, read: open, fetchRain: jest.fn() })).rejects.toThrow(/forecast unsettled/);
    const dry = readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]);
    await rainMode.recordRun({ now: sixAm, conn, read: dry, fetchRain: jest.fn() });
    await rainMode.recordRun({ now: new Date('2026-11-25T11:20:00Z'), conn, read: dry, fetchRain: jest.fn() });
    const history = JSON.parse(conn.store[rainMode.HISTORY_KEY]);
    expect(history.map((e) => e.tick)).toEqual(['2026-11-25T06']);
    expect(history[0].call).toBe('dry');
  });

  test('NWS down fails the tick even while an earlier call is kept for the campaigns', async () => {
    const settings = { [rainMode.DAYS_KEY]: JSON.stringify({ '2026-11-25': { day: '2026-11-25', call: 'rain', areas: [] } }) };
    const conn = fakeConn({ campaigns, settings });
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: jest.fn(async () => null), fetchRain: jest.fn() });
    expect(run.call).toBe('rain');
    expect(run.campaigns.find((c) => c.campaign_id === 3).would).toBe('base');
    expect(run.problems).toEqual([expect.stringMatching(/forecast unsettled for 2026-11-25: 0 settled, 0 of 6 areas read/)]);
  });

  test('the forecast numbers are kept per area for the work hours: at the cutoff, and latest (a dropped hour keeps its reading)', async () => {
    const conn = fakeConn({ campaigns });
    await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [6, 6, 6, 6, 0, 0]), fetchRain: jest.fn() });
    let row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row.cutoff_chances[ZONES[0]]).toEqual([80, 80, 80, 80, 80, 80, 10, 10, 10]);
    expect(row.cutoff_chances[ZONES[5]]).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(Object.keys(row.latest_chances)).toEqual(ZONES);
    // Noon on the day: hours 8-11 are gone from the feed; the latest keeps them, 12 on is new, the cutoff is untouched.
    const noon = new Date('2026-11-25T17:00:00Z');
    const later = (lat, lng) => hours('2026-11-25', 0).slice(4).map((h) => ({ ...h, rainChance: 55 }));
    await rainMode.recordRun({ now: noon, conn, read: jest.fn(async (lat, lng) => later(lat, lng)), fetchRain: jest.fn() });
    row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row.latest_chances[ZONES[0]]).toEqual([80, 80, 80, 80, 55, 55, 55, 55, 55]);
    expect(row.cutoff_chances[ZONES[0]]).toEqual([80, 80, 80, 80, 80, 80, 10, 10, 10]);
  });

  test('cutoff_chances are the unmerged readings of the run that supplied the call, also when the cutoff carries an earlier call forward', async () => {
    const conn = fakeConn({ campaigns });
    const at = (h) => new Date(`2026-11-29T${String(h + 5).padStart(2, '0')}:00:00Z`); // Sunday, ET hour h; sells Monday
    // 10 AM: a settled rain call. 2 PM: the feed answers with fewer hours and no settled call (open areas): the call is
    // carried forward and becomes the cutoff, with the 10 AM readings, not a merge with the 2 PM ones.
    await rainMode.recordRun({ now: at(10), conn, read: readerFor('2026-11-30', [6, 6, 6, 6, 0, 0]), fetchRain: jest.fn() });
    const partial = jest.fn(async () => hours('2026-11-30', 0).slice(6).map((h) => ({ ...h, rainChance: 33 })));
    await rainMode.recordRainMode({ now: at(14), conn, read: partial, fetchRain: jest.fn() }).catch(() => {});
    const row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-30'];
    expect(row).toMatchObject({ cutoff_call: 'rain', cutoff_at: at(14).toISOString() });
    expect(row.cutoff_chances[ZONES[0]]).toEqual([80, 80, 80, 80, 80, 80, 10, 10, 10]);
    // latest_chances may merge: the 2 PM readings land on the hours they cover.
    expect(row.latest_chances[ZONES[0]]).toEqual([80, 80, 80, 80, 80, 80, 33, 33, 33]);
    // A settled 2 PM run supplies its own readings (nothing merged in from before).
    const conn2 = fakeConn({ campaigns });
    await rainMode.recordRun({ now: at(10), conn: conn2, read: readerFor('2026-11-30', [6, 6, 6, 6, 0, 0]), fetchRain: jest.fn() });
    await rainMode.recordRun({ now: at(14), conn: conn2, read: readerFor('2026-11-30', [2, 2, 2, 2, 0, 0]), fetchRain: jest.fn() });
    const row2 = JSON.parse(conn2.store[rainMode.DAYS_KEY])['2026-11-30'];
    expect(row2.cutoff_call).toBe('dry');
    expect(row2.cutoff_chances[ZONES[0]]).toEqual([80, 80, 10, 10, 10, 10, 10, 10, 10]);
  });

  test('LSA and Facebook campaigns are classified and recorded too: rain_class by hand only, never a route line', async () => {
    const more = [
      { id: 10, platform: 'google_lsa', campaign_name: 'LSA', status: 'active', metadata: { rain_class: 'indoor' } },
      { id: 11, platform: 'facebook', campaign_name: 'FB route', status: 'active', metadata: { route_line: 'pest' } },
      { id: 12, platform: 'facebook', campaign_name: 'FB out', status: 'paused', metadata: { rain_class: 'outdoor' } },
    ];
    const conn = fakeConn({ campaigns: [...campaigns, ...more] });
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [6, 6, 6, 6, 0, 0]), fetchRain: jest.fn() });
    expect(run.campaigns.filter((c) => c.campaign_id >= 10).map((c) => [c.campaign_id, c.platform, c.rain_class, c.would]))
      .toEqual([[10, 'google_lsa', 'indoor', 'base'], [11, 'facebook', null, null], [12, 'facebook', 'outdoor', 'stop']]);
    expect(rainMode.RAIN_PLATFORMS).toEqual(['google_ads', 'google_lsa', 'facebook']);
  });
  test('a day with no gauge reading by the give-up day gets a final ungraded score', async () => {
    const none = jest.fn(async () => null);
    const row = { day: '2026-11-15', call: 'rain', cutoff_call: 'rain' };
    expect(await rainMode.scoreDay(row, { fetchObs: none, now: new Date('2026-11-18T20:00:00Z') })).toBeNull();
    expect(await rainMode.scoreDay(row, { fetchObs: none, now: new Date('2026-11-24T20:00:00Z') }))
      .toMatchObject({ partial: true, wet_day: null, hit: null, cutoff_hit: null });
  });
});

