/**
 * Measured rain by work hour (services/scheduling/work-hour-rain.js): the free IEM airport hourly read both rain records
 * grade against. Parsing is checked on the real 2026-11-25 shape (rain mostly before 8 AM at Sarasota, 7 wet work hours at Venice).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const w = require('../services/scheduling/work-hour-rain');
const { ZONE_COORDS } = require('../services/scheduling/forecast-zones');

const CSV = [
  'station,valid,p01i',
  'SRQ,2026-11-25 00:53,0.01',
  'SRQ,2026-11-25 07:53,0.49',
  'SRQ,2026-11-25 08:53,0.03',
  'SRQ,2026-11-25 09:53,T',
  'SRQ,2026-11-25 10:53,M',
  'SRQ,2026-11-25 11:53,0.03',
  'SRQ,2026-11-26 00:15,0.20',
  'VNC,2026-11-25 08:55,0.01',
  'VNC,2026-11-25 09:55,0.01',
  'VNC,2026-11-25 10:55,0.01',
  'VNC,2026-11-25 11:55,0.01',
  'VNC,2026-11-25 12:55,0.01',
  'VNC,2026-11-25 13:55,0.01',
  'VNC,2026-11-25 14:55,0.03',
  'ZZZ,2026-11-25 08:53,5.00',
].join('\n');

beforeEach(() => w._clearCache());

describe('parseObs', () => {
  test('a report belongs to the hour 30 minutes before it; trace reads 0; M and no report read nothing', () => {
    const obs = w.parseObs(CSV, '2026-11-25');
    expect(obs.SRQ[7]).toBe(0.49); // the 7:53 report is hour 7, before work
    expect(obs.SRQ[8]).toBe(0.03);
    expect(obs.SRQ[9]).toBe(0);
    expect(obs.SRQ[10]).toBeUndefined();
    expect(obs.SRQ[23]).toBe(0.2); // a 00:15 report is the previous day's hour 23
  });

  test('the response that is not the CSV (the rate limit text) is null, never dry', () => {
    expect(w.parseObs('Too many requests from your IP address, slow down.', '2026-11-25')).toBeNull();
  });
});

describe('areas and the day', () => {
  const obs = w.parseObs(CSV, '2026-11-25');
  const zones = Object.keys(ZONE_COORDS);

  test('Sarasota-side areas count only work hours; Venice with 7 wet hours is wet; missing hours stay open', () => {
    const areas = w.measureAreas(obs, zones, 4);
    // SRQ: 8 AM 0.03, 11 AM 0.03 = 2 wet hours, 9 AM trace, 10 AM and 12-16 unread (6 missing): 2 + 6 >= 4, open.
    expect(areas.parrish).toMatchObject({ wet_hours: 2, missing: 6, wet: null });
    // Sarasota reads the Venice gauge for the hours SRQ did not report.
    expect(areas.sarasota).toMatchObject({ wet_hours: 6, missing: 2, wet: true });
    expect(areas.venice_north_port).toMatchObject({ wet_hours: 7, wet: true });
    expect(w.wetDayFrom(areas)).toMatchObject({ wet_areas: ['lakewood_ranch', 'sarasota', 'venice_north_port'], unknown: 3, wet_day: true });
  });

  test('an area is dry when its unread hours could not reach the rule, wet at 4 wet hours', () => {
    const full = { SRQ: Object.fromEntries(w.WORK_HOURS.map((h) => [h, h < 12 ? 0.02 : 0])), VNC: Object.fromEntries(w.WORK_HOURS.map((h) => [h, 0])) };
    const areas = w.measureAreas(full, zones, 4);
    expect(areas.parrish).toMatchObject({ wet_hours: 4, wet: true });
    expect(areas.venice_north_port).toMatchObject({ wet_hours: 0, wet: false });
    expect(w.wetDayFrom(areas)).toMatchObject({ wet_day: true });
    const dry = w.measureAreas({ SRQ: {}, VNC: {} }, zones, 4);
    expect(w.wetDayFrom(dry).wet_day).toBeNull(); // nothing read: not dry
  });

  test('an hour with no report at the first station reads the next', () => {
    const o = { SRQ: { 8: 0.05 }, SPG: { 8: 0.5, 9: 0.05 }, VNC: {}, PGD: {} };
    expect(w.tallyHours(o, ['SRQ', 'SPG'], [8, 9])).toEqual({ wet_hours: 2, inches: 0.1, missing: 0 });
  });
});

describe('spanWet', () => {
  const obs = w.parseObs(CSV, '2026-11-25');
  const venice = ZONE_COORDS.venice_north_port;

  test('wet when any hour from the visit start through the drying hours is measurable, from the nearest gauges', () => {
    expect(w.stationsNear(venice)[0]).toBe('VNC');
    expect(w.spanWet(obs, venice, 9 * 60, 10 * 60, 2)).toMatchObject({ wet: true, missing: 0 });
  });

  test('false only when every hour was read; an unread hour with no rain found is unknown, not dry', () => {
    const o = { SRQ: { 15: 0, 16: 0, 17: 0 }, VNC: { 15: 0, 16: 0, 17: 0 }, SPG: {}, PGD: {} };
    expect(w.spanWet(o, ZONE_COORDS.sarasota, 15 * 60, 16 * 60, 2)).toMatchObject({ wet: false, missing: 0 });
    expect(w.spanWet(o, ZONE_COORDS.sarasota, 15 * 60, 17 * 60, 2)).toMatchObject({ wet: null, missing: 1 });
  });
});

describe('fetchHourlyObs', () => {
  const ok = (body) => jest.fn(async () => ({ ok: true, text: async () => body }));

  test('one request names every station, is asked for the ET day, is kept for 10 minutes', async () => {
    const fetchFn = ok(CSV);
    const first = await w.fetchHourlyObs('2026-11-25', { fetchFn });
    await w.fetchHourlyObs('2026-11-25', { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = fetchFn.mock.calls[0][0];
    expect(url).toMatch(/station=SRQ&station=VNC&station=PGD&station=SPG&data=p01i/);
    expect(url).toMatch(/year1=2026&month1=11&day1=25&year2=2026&month2=11&day2=26&tz=America%2FNew_York/);
    expect(first.VNC[14]).toBe(0.03);
  });

  test('a failure or a rate-limit reply is null and is asked again next time', async () => {
    const down = jest.fn(async () => { throw new Error('timeout'); });
    expect(await w.fetchHourlyObs('2026-11-25', { fetchFn: down })).toBeNull();
    expect(await w.fetchHourlyObs('2026-11-25', { fetchFn: ok('Too many requests') })).toBeNull();
    const fetchFn = ok(CSV);
    expect(await w.fetchHourlyObs('2026-11-25', { fetchFn })).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('workHourChances', () => {
  test('nine work hours, null where the feed has no hour', () => {
    const hours = [{ startTime: '2026-11-25T09:00:00-05:00', rainChance: 80 }, { startTime: '2026-11-25T16:00:00-05:00', rainChance: 30.4 }];
    expect(w.workHourChances(hours, '2026-11-25')).toEqual([null, 80, null, null, null, null, null, null, 30]);
  });
});
