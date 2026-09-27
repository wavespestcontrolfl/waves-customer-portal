/**
 * getWeatherSignals()'s recent-rainfall enrichment for the public pest
 * forecast.
 *
 * SWFL ('sw') cities read YESTERDAY's measured rainfall at the city's own
 * coordinate from NOAA MRMS gauge-corrected radar (mrms-qpe.js — the same
 * observed source the irrigation emails quote), replacing the FAWN station
 * reading this suite was first written for: a FAWN station can sit 30+ mi
 * from the city, reports a partial day as a full one during a station
 * outage, and has no station in range of Fort Myers/Cape Coral at all.
 * mrms-qpe's own fetch/parse contract is covered by rain-engine-mrms.test.js;
 * this suite mocks it and pins the enrichment: a measured reading (0"
 * included) → 'nws+mrms'; a gap or an outage degrades to NWS-only, never a
 * phantom 0"; "yesterday" is the ET calendar day, not UTC's.
 */

jest.mock('../services/mrms-qpe');

const { fetchMrmsDailyRain } = require('../services/mrms-qpe');
const logger = require('../services/logger');
const { getWeatherSignals, _clearCache } = require('../services/pest-forecast/weather');

const BRADENTON = { lat: 27.4989, lng: -82.5748, region: 'sw' };

// Only Date is faked: promise plumbing and the NWS fetch timeouts run real.
const ONLY_DATE = { doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] };
// Midday ET on 2026-07-15 — "yesterday" is unambiguously 2026-07-14.
const MIDDAY_ET = new Date('2026-07-15T16:00:00Z');

function nwsForecastBody(precipChance) {
  return {
    properties: {
      periods: [
        { isDaytime: true, temperature: 90, probabilityOfPrecipitation: { value: precipChance } },
        { isDaytime: false, temperature: 78, probabilityOfPrecipitation: { value: precipChance } },
        { isDaytime: true, temperature: 88, probabilityOfPrecipitation: { value: precipChance } },
      ],
    },
  };
}

function mockNws({ precipChance = 40, down = false } = {}) {
  global.fetch = jest.fn((url) => {
    if (down) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    const body = String(url).includes('/points/')
      ? { properties: { forecast: 'https://api.weather.gov/gridpoints/TBW/1,1/forecast' } }
      : nwsForecastBody(precipChance);
    return Promise.resolve({ ok: true, json: async () => body });
  });
}

const mrmsDay = (date, inches) => ({ days: [{ date, inches }], complete: inches != null });

describe('getWeatherSignals MRMS rainfall enrichment (public pest forecast)', () => {
  let warnSpy;
  let infoSpy;

  beforeEach(() => {
    jest.useFakeTimers({ ...ONLY_DATE, now: MIDDAY_ET });
    _clearCache();
    jest.clearAllMocks();
    mockNws();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    delete global.fetch;
  });

  test('sw + a measured reading -> nws+mrms, requested for yesterday at the city coordinate', async () => {
    fetchMrmsDailyRain.mockResolvedValue(mrmsDay('2026-07-14', 0.42));

    const out = await getWeatherSignals(BRADENTON);

    expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(1);
    expect(fetchMrmsDailyRain).toHaveBeenCalledWith({
      latitude: BRADENTON.lat, longitude: BRADENTON.lng, start: '2026-07-14', end: '2026-07-14',
    });
    expect(out.source).toBe('nws+mrms');
    expect(out.recentRainIn).toBeCloseTo(0.42, 5);
    expect(out.hasWeather).toBe(true);
  });

  test('"yesterday" is the ET calendar day: at 11:30 PM ET it is not UTC\'s yesterday', async () => {
    // 03:30Z on 07-16 is 23:30 EDT on 07-15 — ET yesterday is 07-14; a UTC
    // calendar would ask for 07-15, a day still accumulating in ET.
    jest.setSystemTime(new Date('2026-07-16T03:30:00Z'));
    fetchMrmsDailyRain.mockResolvedValue(mrmsDay('2026-07-14', 0.2));

    await getWeatherSignals(BRADENTON);

    expect(fetchMrmsDailyRain).toHaveBeenCalledWith(expect.objectContaining({ start: '2026-07-14', end: '2026-07-14' }));
  });

  test('a measured 0" is a real dry day, not a gap — with a low rain chance the week reads dry', async () => {
    mockNws({ precipChance: 10 });
    fetchMrmsDailyRain.mockResolvedValue(mrmsDay('2026-07-14', 0));

    const out = await getWeatherSignals(BRADENTON);

    expect(out.recentRainIn).toBe(0);
    expect(out.source).toBe('nws+mrms');
    expect(out.dry).toBe(true);
  });

  test('a heavy measured day flags the week wet even when the forecast rain chance is low', async () => {
    mockNws({ precipChance: 10 });
    fetchMrmsDailyRain.mockResolvedValue(mrmsDay('2026-07-14', 0.9));

    const out = await getWeatherSignals(BRADENTON);

    expect(out.wet).toBe(true);
    expect(out.dry).toBe(false);
  });

  test('a gap (IEM has not backfilled yesterday) stays NWS-only — never a phantom 0"', async () => {
    fetchMrmsDailyRain.mockResolvedValue(mrmsDay('2026-07-14', null));

    const out = await getWeatherSignals(BRADENTON);

    expect(out.source).toBe('nws');
    expect(out.recentRainIn).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('MRMS unavailable (mrms-qpe failed soft) degrades to NWS-only and is logged', async () => {
    fetchMrmsDailyRain.mockResolvedValue(null);

    const out = await getWeatherSignals(BRADENTON);

    expect(out.source).toBe('nws');
    expect(out.recentRainIn).toBeNull();
    expect(out.hasWeather).toBe(true); // the NWS signal alone still stands
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MRMS rainfall unavailable'));
  });

  test('an MRMS rejection degrades to NWS-only, is logged, and never throws', async () => {
    fetchMrmsDailyRain.mockRejectedValue(new Error('socket hang up'));

    const out = await getWeatherSignals(BRADENTON);

    expect(out.source).toBe('nws');
    expect(out.recentRainIn).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MRMS lookup failed'));
  });

  test('NWS down + a measured reading -> mrms alone still yields weather', async () => {
    mockNws({ down: true });
    fetchMrmsDailyRain.mockResolvedValue(mrmsDay('2026-07-14', 0.3));

    const out = await getWeatherSignals(BRADENTON);

    expect(out.source).toBe('mrms');
    expect(out.hasWeather).toBe(true);
    expect(out.tempHighF).toBeNull();
    expect(out.recentRainIn).toBeCloseTo(0.3, 5);
  });

  test('non-sw regions never call MRMS and stay nws-only', async () => {
    const out = await getWeatherSignals({ lat: 28.5383, lng: -81.3792, region: 'central' });

    expect(fetchMrmsDailyRain).not.toHaveBeenCalled();
    expect(out.source).toBe('nws');
    expect(out.recentRainIn).toBeNull();
  });

  test('a cached city is served without a second MRMS request', async () => {
    fetchMrmsDailyRain.mockResolvedValue(mrmsDay('2026-07-14', 0.42));

    await getWeatherSignals(BRADENTON);
    await getWeatherSignals(BRADENTON);

    expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(1);
  });
});
