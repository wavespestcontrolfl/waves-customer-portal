/**
 * Rain-day ads record (services/ads/rain-mode.js). Record only: these tests prove the day it decides for, the rain-day
 * rule (4+ work hours at 70%+ in half the areas read), what each campaign class would get, that unknown is never
 * dry, and the next-day score against measured radar rain.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({ getNwsHourlyRain: jest.fn() }));
jest.mock('../services/mrms-qpe', () => ({ fetchMrmsDailyRain: jest.fn() }));

const rainMode = require('../services/ads/rain-mode');
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
    expect(rainMode.soldDay(new Date('2026-11-24T18:59:00Z'))).toBe('2026-11-24');
    expect(rainMode.soldDay(new Date('2026-11-24T19:00:00Z'))).toBe('2026-11-25');
    expect(rainMode.soldDay(new Date('2026-11-22T14:00:00Z'))).toBe('2026-11-23');
  });
});

describe('rainClassOf and decideCampaign', () => {
  test('marked classes and route lines; the brand campaign is left alone', () => {
    expect(rainMode.rainClassOf({ metadata: { rain_class: 'indoor' } })).toBe('indoor');
    expect(rainMode.rainClassOf({ metadata: JSON.stringify({ route_line: 'pest' }) })).toBe('outdoor');
    expect(rainMode.rainClassOf({ metadata: {} })).toBeNull();
    expect(rainMode.decideCampaign('outdoor', 'rain')).toBe('stop');
    expect(rainMode.decideCampaign('outdoor', 'dry')).toBe('base');
    expect(rainMode.decideCampaign('indoor', 'rain')).toBe('base');
    expect(rainMode.decideCampaign('indoor', 'dry')).toBe('stop');
    expect(rainMode.decideCampaign(null, 'rain')).toBeNull();
    expect(rainMode.decideCampaign('outdoor', 'unknown')).toBeNull();
  });
});

describe('forecastDay', () => {
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

  test('scores a past day against measured rain once, and never rewrites a scored day', async () => {
    const settings = {
      [rainMode.DAYS_KEY]: JSON.stringify({
        '2026-11-23': { day: '2026-11-23', call: 'rain', areas: [] },
        '2026-11-22': { day: '2026-11-22', call: 'dry', areas: [], score: { hit: true } },
      }),
    };
    const conn = fakeConn({ campaigns, settings });
    const inches = [0.6, 0.4, 0.3, 0.1, 0, null];
    const fetchRain = jest.fn(async ({ latitude }) => {
      const i = ZONES.findIndex((z) => ZONE_COORDS[z].lat === latitude);
      return { days: [{ date: '2026-11-23', inches: inches[i] }] };
    });
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain });
    expect(run.scored).toEqual(['2026-11-23']);
    const days = JSON.parse(conn.store[rainMode.DAYS_KEY]);
    expect(days['2026-11-23'].score).toMatchObject({ wet_areas: ZONES.slice(0, 3), wet_day: true, hit: true });
    expect(days['2026-11-22'].score).toEqual({ hit: true });
    expect(fetchRain).toHaveBeenCalledTimes(ZONES.length);
  });

  test('a day with too little measured rain read stays unscored for the next run', async () => {
    const settings = { [rainMode.DAYS_KEY]: JSON.stringify({ '2026-11-23': { day: '2026-11-23', call: 'dry', areas: [] } }) };
    const conn = fakeConn({ campaigns, settings });
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn(async () => null) });
    expect(run.scored).toEqual([]);
    expect(JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-23'].score).toBeUndefined();
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

  test('a radar gap that could flip the score waits; after the give-up days the areas read decide', async () => {
    const inches = [0.6, 0.4, 0, 0, null, null]; // 2 wet, 2 dry, 2 missing: could be 4 of 6 wet or 2 of 6
    const fetchRain = jest.fn(async ({ latitude }) => {
      const i = ZONES.findIndex((z) => ZONE_COORDS[z].lat === latitude);
      return { days: [{ date: '2026-11-23', inches: inches[i] }] };
    });
    const row = { day: '2026-11-23', call: 'rain', areas: [] };
    expect(await rainMode.scoreDay(row, { fetchRain, now: new Date('2026-11-24T20:00:00Z') })).toBeNull();
    const late = await rainMode.scoreDay(row, { fetchRain, now: new Date('2026-12-01T20:00:00Z') });
    expect(late).toMatchObject({ partial: true, wet_day: true, hit: true });
  });

  test('a day waiting on radar does not block the days after it', async () => {
    const settings = {
      [rainMode.DAYS_KEY]: JSON.stringify({
        '2026-11-18': { day: '2026-11-18', call: 'dry', areas: [], score_tried_at: '2026-11-24T18:00:00Z' },
        '2026-11-19': { day: '2026-11-19', call: 'dry', areas: [], score_tried_at: '2026-11-24T18:00:00Z' },
        '2026-11-20': { day: '2026-11-20', call: 'dry', areas: [], score_tried_at: '2026-11-24T18:00:00Z' },
        '2026-11-21': { day: '2026-11-21', call: 'dry', areas: [] },
      }),
    };
    const conn = fakeConn({ campaigns, settings });
    const fetchRain = jest.fn(async ({ start }) => ({ days: [{ date: start, inches: start === '2026-11-21' ? 0 : null }] }));
    const run = await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain });
    expect(run.scored).toEqual(['2026-11-21']);
    const days = JSON.parse(conn.store[rainMode.DAYS_KEY]);
    expect(days['2026-11-18'].score_tried_at).toBe(AFTER_TWO.toISOString());
  });

  test('a future day with only open areas fails the tick and keeps only the unknown cutoff', async () => {
    const conn = fakeConn({ campaigns });
    const oneHour = jest.fn(async () => hours('2026-11-25', 0).slice(0, 1)); // one dry hour per area: all open
    await expect(rainMode.recordRainMode({ now: AFTER_TWO, conn, read: oneHour, fetchRain: jest.fn() }))
      .rejects.toThrow(/forecast unsettled for 2026-11-25: 0 settled, 6 of 6 areas read/);
    const row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row.call).toBeUndefined();
    expect(row.cutoff_call).toBe('unknown');
  });

  test('the 2 PM call is kept beside later calls, and the score grades both', async () => {
    const conn = fakeConn({ campaigns });
    await rainMode.recordRun({ now: AFTER_TWO, conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn() });
    const morning = new Date('2026-11-25T13:00:00Z'); // 8 AM ET on the day: now rain
    await rainMode.recordRun({ now: morning, conn, read: readerFor('2026-11-25', [9, 9, 9, 9, 9, 9]), fetchRain: jest.fn() });
    const row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row).toMatchObject({ call: 'rain', cutoff_call: 'dry', cutoff_at: AFTER_TWO.toISOString() });
    const wet = jest.fn(async ({ start }) => ({ days: [{ date: start, inches: 1 }] }));
    const score = await rainMode.scoreDay(row, { fetchRain: wet, now: new Date('2026-11-26T20:00:00Z') });
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

  test('an unknown 2 PM call with nothing before it is kept as the cutoff, and graded as no call', async () => {
    const conn = fakeConn({ campaigns });
    const at = (h) => new Date(`2026-11-24T${String(h + 5).padStart(2, '0')}:00:00Z`); // Tuesday, sells Wed from 2 PM
    const open = jest.fn(async () => hours('2026-11-25', 0).slice(0, 1));
    await rainMode.recordRainMode({ now: at(14), conn, read: open, fetchRain: jest.fn() }).catch(() => {});
    await rainMode.recordRun({ now: at(16), conn, read: readerFor('2026-11-25', [0, 0, 0, 0, 0, 0]), fetchRain: jest.fn() });
    const row = JSON.parse(conn.store[rainMode.DAYS_KEY])['2026-11-25'];
    expect(row).toMatchObject({ call: 'dry', cutoff_call: 'unknown', cutoff_at: at(14).toISOString() });
    const dry = jest.fn(async ({ start }) => ({ days: [{ date: start, inches: 0 }] }));
    expect(await rainMode.scoreDay(row, { fetchRain: dry, now: new Date('2026-11-26T20:00:00Z') })).toMatchObject({ hit: true, cutoff_hit: null });
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
});

