// The 07:05 notice's rain note (owner 2026-11-19 D3): rain hours by area, from NWS only, never the paid backup.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60 }));
jest.mock('../services/weather-forecast', () => ({
  getNwsHourlyRain: jest.fn(async () => []),
  getOpenMeteoHourlyBackup: jest.fn(async () => null),
  getHourlyRainOutlook: jest.fn(),
}));

const { getNwsHourlyRain, getOpenMeteoHourlyBackup, getHourlyRainOutlook } = require('../services/weather-forecast');
const { ZONE_COORDS } = require('../services/scheduling/forecast-zones');
const { rainNote, _internals: { readDay } } = require('../services/day-replan/rain-note');

// An NWS hour as the hourly forecast gives it: its local start, with the Eastern offset.
const hour = (day, h, rainChance) => ({ startTime: `${day}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance });
// Every hour of each day at 10%, except the hours `wet` names ({ 'YYYY-MM-DD': { hour: chance } }).
const fullDays = (days, wet = {}) => days.flatMap((day) => Array.from({ length: 24 }, (_, h) => hour(day, h, wet[day]?.[h] === undefined ? 10 : wet[day][h])));
const DAY = '2026-11-21';

beforeEach(() => jest.clearAllMocks());

describe('readDay', () => {
  test('hours of 60% or more inside 8:00 AM to 5:00 PM, joined; a span keeps its highest chance', () => {
    const hours = fullDays([DAY, '2026-11-22'], { [DAY]: { 7: 90, 8: 60, 9: 59, 10: 85, 11: 80, 13: 70, 16: 95, 17: 99 }, '2026-11-22': { 14: 90 } });
    expect(readDay(hours, DAY)).toEqual({
      spans: [
        { start: 480, end: 540, max: 60 },
        { start: 600, end: 720, max: 85 },
        { start: 780, end: 840, max: 70 },
        { start: 960, end: 1020, max: 95 },
      ],
      missing: 0,
    });
  });

  test('an hour with no reading is missing, never dry or wet, and ends a span; `from` skips the hours before it', () => {
    const hours = fullDays([DAY], { [DAY]: { 8: 70, 9: null, 10: 75, 11: 80 } }).filter((h) => !h.startTime.includes('T14:'));
    expect(readDay(hours, DAY)).toEqual({ spans: [{ start: 480, end: 540, max: 70 }, { start: 600, end: 720, max: 80 }], missing: 2 });
    expect(readDay(hours, DAY, 660)).toEqual({ spans: [{ start: 660, end: 720, max: 80 }], missing: 1 });
    expect(readDay(hours, '2026-11-23')).toEqual({ spans: [], missing: 9 });
  });
});

describe('rainNote', () => {
  const byPoint = new Map(Object.entries(ZONE_COORDS).map(([zone, p]) => [`${p.lat},${p.lng}`, zone]));
  const reader = (answers) => jest.fn((lat, lng) => answers(byPoint.get(`${lat},${lng}`)));
  // 6:30 AM ET on Nov 21 (11:30 UTC): the first day is today, counted from 8 AM.
  const MORNING = new Date('2026-11-21T11:30:00Z');
  const THREE = [DAY, '2026-11-22', '2026-11-23'];

  test('the horizon\'s days from the ET date, each area\'s wet spans in board order; an area that fails is unread', async () => {
    const read = reader((zone) => {
      if (zone === 'parrish') return Promise.resolve(null);
      if (zone === 'palmetto') return Promise.reject(new Error('timeout'));
      if (zone === 'venice_north_port') throw new Error('bad point');
      // 7 AM is before the day on every date: never a span.
      if (zone === 'sarasota') return Promise.resolve(fullDays(THREE, { [DAY]: { 7: 90, 13: 70, 14: 80 }, '2026-11-22': { 7: 95, 9: 65 } }));
      if (zone === 'lakewood_ranch') return Promise.resolve(fullDays(THREE, { [DAY]: { 15: 61 } }));
      return Promise.resolve(fullDays(THREE));
    });
    const note = await rainNote(MORNING, { read });
    expect(read).toHaveBeenCalledTimes(Object.keys(ZONE_COORDS).length);
    for (const p of Object.values(ZONE_COORDS)) expect(read).toHaveBeenCalledWith(p.lat, p.lng);
    expect(note.days).toEqual([
      { day: DAY, areas: [{ zone: 'lakewood_ranch', spans: [{ start: 900, end: 960, max: 61 }] }, { zone: 'sarasota', spans: [{ start: 780, end: 900, max: 80 }] }], gaps: [] },
      { day: '2026-11-22', areas: [{ zone: 'sarasota', spans: [{ start: 540, end: 600, max: 65 }] }], gaps: [] },
      { day: '2026-11-23', areas: [], gaps: [] },
    ]);
    expect(note.unread).toEqual(['parrish', 'palmetto', 'venice_north_port']);
    expect(Object.keys(note.outlooks)).toEqual(Object.keys(ZONE_COORDS));
  });

  test('an answer that stops early or leaves an hour blank names its area under that day; it is never read as dry', async () => {
    const read = reader((zone) => {
      // Two days only: the third day has no reading.
      if (zone === 'sarasota') return Promise.resolve(fullDays([DAY, '2026-11-22']));
      // 10 AM on Nov 22 has no chance of rain on it.
      if (zone === 'parrish') return Promise.resolve(fullDays(THREE, { '2026-11-22': { 10: null } }));
      return Promise.resolve(fullDays(THREE));
    });
    const note = await rainNote(MORNING, { read });
    expect(note.days.map(({ day, gaps }) => [day, gaps])).toEqual([[DAY, []], ['2026-11-22', ['parrish']], ['2026-11-23', ['sarasota']]]);
    expect(note.unread).toEqual([]);
  });

  test('today counts from the current hour; a day already over is left out', async () => {
    // 11:30 AM ET on Nov 21: the answer starts at 11 AM, so 8 to 10 AM are over, neither wet nor missing.
    const late = fullDays(THREE, { [DAY]: { 8: 90, 12: 70 } }).filter((h) => h.startTime >= `${DAY}T11`);
    let note = await rainNote(new Date('2026-11-21T16:30:00Z'), { read: reader(() => Promise.resolve(late)) });
    expect(note.days[0]).toEqual({ day: DAY, areas: Object.keys(ZONE_COORDS).map((zone) => ({ zone, spans: [{ start: 720, end: 780, max: 70 }] })), gaps: [] });
    // 11:30 PM ET on Nov 20 (04:30 UTC on Nov 21): Nov 20 is over, so the note starts on Nov 21, the ET date's next day.
    note = await rainNote(new Date('2026-11-21T04:30:00Z'), { read: reader(() => Promise.resolve(fullDays(['2026-11-20', DAY, '2026-11-22']))) });
    expect(note.days.map((d) => d.day)).toEqual([DAY, '2026-11-22']);
    expect(note.days.every((d) => !d.gaps.length && !d.areas.length)).toBe(true);
  });

  test('reads NWS first at each area\'s board point and falls back to Open-Meteo backup when NWS fails', async () => {
    await rainNote(MORNING);
    expect(getNwsHourlyRain).toHaveBeenCalledTimes(Object.keys(ZONE_COORDS).length);
    for (const p of Object.values(ZONE_COORDS)) expect(getNwsHourlyRain).toHaveBeenCalledWith(p.lat, p.lng);
    expect(getOpenMeteoHourlyBackup).not.toHaveBeenCalled();
    expect(getHourlyRainOutlook).not.toHaveBeenCalled();

    jest.clearAllMocks();
    getNwsHourlyRain.mockResolvedValue(null);
    getOpenMeteoHourlyBackup.mockResolvedValue(fullDays(THREE, { [DAY]: { 14: 75 } }));
    const fallbackNote = await rainNote(MORNING);
    expect(getOpenMeteoHourlyBackup).toHaveBeenCalledTimes(Object.keys(ZONE_COORDS).length);
    expect(fallbackNote.unread).toEqual([]);
    expect(fallbackNote.days[0].areas).toHaveLength(Object.keys(ZONE_COORDS).length);
  });
});
