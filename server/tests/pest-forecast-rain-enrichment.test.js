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
 * phantom 0"; "yesterday" is the ET calendar day, not UTC's. Freshness: every
 * result carries one freshUntil — 3h, 15 min while a SWFL rain reading is
 * missing (so a late IEM backfill shows up soon), never past ET midnight
 * (when "yesterday" moves) — and a day's measured reading survives a later
 * same-day outage instead of being dropped; a missing reading can read as
 * "dry".
 */

jest.mock('../services/mrms-qpe');

const { fetchMrmsDailyRain } = require('../services/mrms-qpe');
const logger = require('../services/logger');
const { getWeatherSignals, _clearCache } = require('../services/pest-forecast/weather');
const forecast = require('../services/pest-forecast/forecast');

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
    forecast._clearCache();
    jest.clearAllMocks();
    fetchMrmsDailyRain.mockReset();
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

  test('concurrent fills of one city share a single lookup — a slower failure can\'t overwrite a good reading', async () => {
    fetchMrmsDailyRain
      .mockResolvedValueOnce(mrmsDay('2026-07-14', 0.7)) // fast and good
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(null), 20))); // a slow outage

    const [a, b] = await Promise.all([getWeatherSignals(BRADENTON), getWeatherSignals(BRADENTON)]);
    await new Promise((resolve) => setTimeout(resolve, 40)); // let any straggling fill land
    const cached = await getWeatherSignals(BRADENTON);

    expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(1);
    expect(a.recentRainIn).toBeCloseTo(0.7, 5);
    expect(b.recentRainIn).toBeCloseTo(0.7, 5);
    expect(cached.recentRainIn).toBeCloseTo(0.7, 5);
  });

  describe('freshness', () => {
    // 11:30 PM ET on 07-15, then 12:30 AM ET on 07-16 — one hour apart, well
    // inside the 3h cache lifetime, but "yesterday" moved from 07-14 to 07-15.
    const BEFORE_MIDNIGHT = new Date('2026-07-16T03:30:00Z');
    const AFTER_MIDNIGHT = new Date('2026-07-16T04:30:00Z');
    // Past the 3h cache lifetime but still the same ET day (3:01 PM ET).
    const SAME_DAY_AFTER_TTL = new Date(MIDDAY_ET.getTime() + (3 * 60 + 1) * 60 * 1000);

    test('the weather cache never carries yesterday\'s rain past ET midnight', async () => {
      jest.setSystemTime(BEFORE_MIDNIGHT);
      fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-14', 0.9));
      const before = await getWeatherSignals(BRADENTON);

      jest.setSystemTime(AFTER_MIDNIGHT);
      fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-15', 0.05));
      const after = await getWeatherSignals(BRADENTON);

      expect(fetchMrmsDailyRain.mock.calls.map(([args]) => args.start)).toEqual(['2026-07-14', '2026-07-15']);
      expect(before.recentRainIn).toBeCloseTo(0.9, 5);
      expect(after.recentRainIn).toBeCloseTo(0.05, 5);
    });

    test('the forecast response cache is recomputed after ET midnight too', async () => {
      jest.setSystemTime(BEFORE_MIDNIGHT);
      fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-14', 0.9));
      const before = await forecast.getForecast({ location: 'bradenton-fl' });

      jest.setSystemTime(AFTER_MIDNIGHT);
      fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-15', 0.05));
      const after = await forecast.getForecast({ location: 'bradenton-fl' });

      expect(before.weather.recent_rain_in).toBeCloseTo(0.9, 5);
      expect(after.weather.recent_rain_in).toBeCloseTo(0.05, 5);
    });

    test.each([
      ['an outage', () => fetchMrmsDailyRain.mockResolvedValueOnce(null)],
      ['a rejection', () => fetchMrmsDailyRain.mockRejectedValueOnce(new Error('socket hang up'))],
      ['a late gap', () => fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-14', null))],
    ])('%s later the same day reuses the day\'s measured reading — it never flips a wet week dry', async (_label, failNextLookup) => {
      mockNws({ precipChance: 10 });
      fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-14', 0.9));
      const first = await getWeatherSignals(BRADENTON);

      jest.setSystemTime(SAME_DAY_AFTER_TTL);
      failNextLookup();
      const later = await getWeatherSignals(BRADENTON);

      expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(2);
      expect(first.wet).toBe(true);
      expect(later.recentRainIn).toBeCloseTo(0.9, 5);
      expect(later.source).toBe('nws+mrms');
      expect(later.wet).toBe(true);
      expect(later.dry).toBe(false);
    });

    test('a measured reading is never reused for a different day', async () => {
      jest.setSystemTime(BEFORE_MIDNIGHT);
      fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-14', 0.9));
      await getWeatherSignals(BRADENTON);

      jest.setSystemTime(AFTER_MIDNIGHT);
      fetchMrmsDailyRain.mockResolvedValueOnce(null);
      const after = await getWeatherSignals(BRADENTON);

      expect(after.recentRainIn).toBeNull();
      expect(after.source).toBe('nws');
    });

    test('a SWFL fill still missing its rain retries in 15 minutes, not 3 hours', async () => {
      fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-14', null)); // not backfilled yet
      const first = await forecast.getForecast({ location: 'bradenton-fl' });

      jest.setSystemTime(new Date(MIDDAY_ET.getTime() + 14 * 60 * 1000));
      await forecast.getForecast({ location: 'bradenton-fl' });
      expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(1); // still inside the retry window

      jest.setSystemTime(new Date(MIDDAY_ET.getTime() + 16 * 60 * 1000));
      fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-14', 0.6)); // IEM caught up
      const later = await forecast.getForecast({ location: 'bradenton-fl' });

      expect(fetchMrmsDailyRain).toHaveBeenCalledTimes(2);
      expect(first.weather.recent_rain_in).toBeNull();
      expect(later.weather.recent_rain_in).toBeCloseTo(0.6, 5);
    });

    const at = (ms) => new Date(ms).toISOString();
    test.each([
      ['a SWFL reading lasts 3 hours', MIDDAY_ET, 'bradenton-fl', 0.4, MIDDAY_ET.getTime() + 3 * 60 * 60 * 1000],
      ['a SWFL fill missing its rain lasts 15 minutes', MIDDAY_ET, 'bradenton-fl', null, MIDDAY_ET.getTime() + 15 * 60 * 1000],
      ['a 10 PM ET fill stops at ET midnight, not 3 hours later', new Date('2026-07-16T02:00:00Z'), 'bradenton-fl', 0.4, Date.parse('2026-07-16T04:00:00Z')],
      ['a non-SWFL city (no rain expected) keeps the 3-hour lifetime', MIDDAY_ET, 'tampa-fl', undefined, MIDDAY_ET.getTime() + 3 * 60 * 60 * 1000],
    ])('freshUntil: %s', async (_label, fillAt, location, inches, expected) => {
      jest.setSystemTime(fillAt); // both fill times are ET 07-15, so "yesterday" is 07-14
      if (inches !== undefined) fetchMrmsDailyRain.mockResolvedValueOnce(mrmsDay('2026-07-14', inches));

      const { freshUntil } = await forecast.getForecastWithFreshness({ location });

      expect(at(freshUntil)).toBe(at(expected));
    });
  });
});
