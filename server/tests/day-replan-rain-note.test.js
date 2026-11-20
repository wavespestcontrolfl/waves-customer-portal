// The 07:05 notice's rain note (owner 2026-11-19 D3): rain hours by area, from NWS only, never the paid backup.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60 }));
jest.mock('../services/weather-forecast', () => ({ getNwsHourlyRain: jest.fn(async () => []), getHourlyRainOutlook: jest.fn() }));

const { getNwsHourlyRain, getHourlyRainOutlook } = require('../services/weather-forecast');
const { ZONE_COORDS } = require('../services/scheduling/forecast-zones');
const { rainNote, _internals: { wetSpans } } = require('../services/day-replan/rain-note');

// An NWS hour as the hourly forecast gives it: its local start, with the Eastern offset.
const hour = (day, h, rainChance) => ({ startTime: `${day}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance });
const DAY = '2026-11-21';

beforeEach(() => jest.clearAllMocks());

describe('wetSpans', () => {
  test('hours of 60% or more inside 8:00 AM to 5:00 PM, joined; an hour with no reading or under 60% ends a span', () => {
    const hours = [hour(DAY, 7, 90), hour(DAY, 8, 60), hour(DAY, 9, 59), hour(DAY, 10, 85), hour(DAY, 11, 80),
      hour(DAY, 12, null), hour(DAY, 13, 70), hour(DAY, 16, 95), hour(DAY, 17, 99), hour('2026-11-22', 14, 90)];
    expect(wetSpans(hours, DAY)).toEqual([
      { start: 480, end: 540, max: 60 },
      { start: 600, end: 720, max: 85 },
      { start: 780, end: 840, max: 70 },
      { start: 960, end: 1020, max: 95 },
    ]);
    expect(wetSpans(hours, '2026-11-23')).toEqual([]);
  });
});

describe('rainNote', () => {
  // 11:30 PM ET on Nov 20: the note's first day is the ET date, not the UTC one.
  const NOW = new Date('2026-11-21T04:30:00Z');

  test('the horizon\'s days from the ET date, each area\'s wet spans in board order; an area that fails is unread', async () => {
    const byPoint = new Map(Object.entries(ZONE_COORDS).map(([zone, p]) => [`${p.lat},${p.lng}`, zone]));
    const read = jest.fn((lat, lng) => {
      const zone = byPoint.get(`${lat},${lng}`);
      if (zone === 'parrish') return Promise.resolve(null);
      if (zone === 'palmetto') return Promise.reject(new Error('timeout'));
      if (zone === 'venice_north_port') throw new Error('bad point');
      if (zone === 'sarasota') return Promise.resolve([hour(DAY, 13, 70), hour(DAY, 14, 80), hour('2026-11-22', 9, 65)]);
      if (zone === 'lakewood_ranch') return Promise.resolve([hour(DAY, 15, 61)]);
      return Promise.resolve([]);
    });
    const note = await rainNote(NOW, { read });
    expect(read).toHaveBeenCalledTimes(Object.keys(ZONE_COORDS).length);
    for (const p of Object.values(ZONE_COORDS)) expect(read).toHaveBeenCalledWith(p.lat, p.lng);
    expect(note.days).toEqual([
      { day: '2026-11-20', areas: [] },
      { day: '2026-11-21', areas: [{ zone: 'lakewood_ranch', spans: [{ start: 900, end: 960, max: 61 }] }, { zone: 'sarasota', spans: [{ start: 780, end: 900, max: 80 }] }] },
      { day: '2026-11-22', areas: [{ zone: 'sarasota', spans: [{ start: 540, end: 600, max: 65 }] }] },
    ]);
    expect(note.unread).toEqual(['parrish', 'palmetto', 'venice_north_port']);
    expect(Object.keys(note.outlooks)).toEqual(Object.keys(ZONE_COORDS));
  });

  test('reads NWS only, at each area\'s board point: never the reader with the paid backup', async () => {
    await rainNote(NOW);
    expect(getNwsHourlyRain).toHaveBeenCalledTimes(Object.keys(ZONE_COORDS).length);
    for (const p of Object.values(ZONE_COORDS)) expect(getNwsHourlyRain).toHaveBeenCalledWith(p.lat, p.lng);
    expect(getHourlyRainOutlook).not.toHaveBeenCalled();
  });
});
