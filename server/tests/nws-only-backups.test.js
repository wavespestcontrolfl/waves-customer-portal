/**
 * Open-Meteo backup for the three readers that keep their own NWS path
 * (owner 2026-10-08): the public pest forecast, the dispatch forecast
 * analyzer and the portal "Local Conditions" tile.
 *  - NWS up: Open-Meteo is never asked.
 *  - NWS down: each answers from Open-Meteo; both down: the old fail-soft.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const isOpenMeteo = (url) => String(url).includes('open-meteo.com');

describe('weather-forecast getOpenMeteoDaytime', () => {
  test('complete daytime dates only, with the daytime high and max chance', () => {
    const { _test } = require('../services/weather-forecast');
    const hours = [];
    for (let h = 6; h < 18; h += 1) hours.push({ startTime: `2026-10-09T${String(h).padStart(2, '0')}:00:00-04:00`, rainChance: h === 14 ? 70 : 20, temperatureF: 70 + h });
    hours.push({ startTime: '2026-10-10T06:00:00-04:00', rainChance: 95, temperatureF: 99 }); // partial date
    expect(_test.daytimeFromHours(hours)).toEqual([{ date: '2026-10-09', rainChance: 70, tempHighF: 87 }]);
  });
});

describe('pest forecast weather', () => {
  beforeEach(() => { jest.resetModules(); });
  afterEach(() => { delete global.fetch; });

  function load(daytime) {
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/mrms-qpe', () => ({ fetchMrmsDailyRain: jest.fn(async () => null) }));
    const getOpenMeteoDaytime = jest.fn(async () => daytime);
    jest.doMock('../services/weather-forecast', () => ({ getOpenMeteoDaytime }));
    return { ...require('../services/pest-forecast/weather'), getOpenMeteoDaytime };
  }

  test('NWS down: the two signals come from Open-Meteo, averaged over six days', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const days = [88, 90, 86, 84, 92, 90, 60].map((t, i) => ({ date: `2026-10-${10 + i}`, tempHighF: t, rainChance: i < 6 ? 40 : 100 }));
    const { getWeatherSignals } = load(days);
    const out = await getWeatherSignals({ lat: 28.5, lng: -81.4, region: 'central' });
    expect(out).toMatchObject({ hasWeather: true, tempHighF: 88, precipChance: 40, source: 'open_meteo' });
  });

  test('NWS up: Open-Meteo is never asked', async () => {
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () => (String(url).includes('/points/')
        ? { properties: { forecast: 'https://api.weather.gov/gridpoints/X/1,1/forecast' } }
        : { properties: { periods: [{ isDaytime: true, temperature: 91, probabilityOfPrecipitation: { value: 30 } }] } }),
    }));
    const { getWeatherSignals, getOpenMeteoDaytime } = load([{ date: '2026-10-10', tempHighF: 50, rainChance: 99 }]);
    const out = await getWeatherSignals({ lat: 28.6, lng: -81.5, region: 'central' });
    expect(out).toMatchObject({ tempHighF: 91, precipChance: 30, source: 'nws' });
    expect(getOpenMeteoDaytime).not.toHaveBeenCalled();
  });

  test('both down: no weather, as before', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const { getWeatherSignals } = load(null);
    const out = await getWeatherSignals({ lat: 28.7, lng: -81.6, region: 'central' });
    expect(out.hasWeather).toBe(false);
  });
});

describe('dispatch forecast analyzer', () => {
  beforeEach(() => { jest.resetModules(); });

  test('reads the shared hourly reader (NWS, Open-Meteo when NWS fails)', async () => {
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const row = { id: 's1', customer_id: 'c1', service_type: 'Assessment', first_name: 'Test', last_name: 'Person' };
    const query = { where: () => query, whereIn: () => query, leftJoin: () => query, select: async () => [row] };
    jest.doMock('../models/db', () => jest.fn(() => query));
    const getHourlyRainOutlook = jest.fn(async () => [
      { startTime: '2026-10-09T14:00:00-04:00', rainChance: 80, temperatureF: 84.4, windMph: 12.2, shortForecast: null, source: 'open-meteo' },
    ]);
    jest.doMock('../services/weather-forecast', () => ({ getHourlyRainOutlook }));
    const analyzer = require('../services/forecast-analyzer');
    const seen = [];
    analyzer.analyzeServiceWeather = (service, forecast) => { seen.push(forecast); return { recommendation: 'GO' }; };
    analyzer.buildSummary = () => 'summary';
    const out = await analyzer.analyzeTomorrow();
    expect(getHourlyRainOutlook).toHaveBeenCalledWith(27.4217, -82.4065);
    expect(seen[0][0]).toMatchObject({ temp_f: 84.4, wind_speed_mph: 12.2, rain_probability_pct: 80, rain_mm: 0 });
    expect(seen[0][0].datetime.toISOString()).toBe('2026-10-09T18:00:00.000Z');
    expect(out.canProceed).toHaveLength(1);
  });
});

describe('portal Local Conditions tile', () => {
  let handler;
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../middleware/auth', () => ({ authenticate: (req, res, next) => next() }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/newsletter-feed', () => ({ getPublishedPosts: jest.fn(async () => []) }));
    jest.doMock('../services/local-news-store', () => ({}));
    jest.doMock('../services/pest-forecast/forecast', () => ({ getForecast: jest.fn(async () => ({ pests: [] })) }));
    const router = require('../routes/feed');
    handler = router.stack.find((l) => l.route && l.route.path === '/weather').route.stack[0].handle;
  });
  afterEach(() => { delete global.fetch; });

  const get = async (customer) => {
    let body;
    const res = { json: (b) => { body = b; return res; } };
    await handler({ customer }, res, (e) => { throw e; });
    return body;
  };

  // Noon ET and 10 PM ET: the low must be the night minimum at both.
  test.each([['2026-10-08T16:00:00Z', true], ['2026-10-09T02:00:00Z', false]])('NWS down at %s: real current conditions from Open-Meteo, not the seasonal defaults', async (at, isDay) => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(at));
    const hour0 = Math.floor(Date.now() / 3600000) * 3600;
    const times = Array.from({ length: 30 }, (_, i) => hour0 + i * 3600);
    global.fetch = jest.fn(async (url) => {
      if (!isOpenMeteo(url)) return { ok: false };
      return {
        ok: true,
        json: async () => ({
          current: { time: Math.floor(Date.now() / 1000), temperature_2m: 81.6, relative_humidity_2m: 77, wind_speed_10m: 11.4, weather_code: 95 },
          // Tonight's hours read 73.2; the day after and the NEXT night read
          // colder, and must not set tonight's low.
          hourly: {
            time: times,
            temperature_2m: times.map((t) => {
              const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(t * 1000));
              const night = etHour >= 18 || etHour < 6;
              const firstNight = t * 1000 < Date.parse(at) + 19 * 3600000;
              return night && firstNight ? 73.2 : night ? 60 : 88;
            }),
            precipitation: times.map(() => 0),
          },
        }),
      };
    });
    const out = await get({ city: 'Sarasota', zip: '34236' });
    expect(out).toMatchObject({ location: 'Sarasota, FL', temp: 82, humidity: 77, wind: '11 mph', forecast: 'Thunderstorms' });
    // Tonight's low is the night hours' minimum, by day and after dark alike:
    // never the current reading.
    expect(out.nightTemp).toBe(73);
    expect(out.isDaytime).toBe(isDay);
    Date.now.mockRestore();
  });

  test('5 AM ET: the low counts the night hours already past', async () => {
    const at = Date.parse('2026-10-09T09:00:00Z'); // 5 AM ET
    jest.spyOn(Date, 'now').mockReturnValue(at);
    const first = Math.floor(at / 3600000) * 3600 - 14 * 3600;
    const times = Array.from({ length: 48 }, (_, i) => first + i * 3600);
    global.fetch = jest.fn(async (url) => {
      if (!isOpenMeteo(url)) return { ok: false };
      return {
        ok: true,
        json: async () => ({
          current: { time: at / 1000, temperature_2m: 75.2, relative_humidity_2m: 90, wind_speed_10m: 3, weather_code: 0 },
          // 70 at 2 AM ET (06:00Z), 75 through the rest of the night, 55 the NEXT night.
          hourly: {
            time: times,
            temperature_2m: times.map((t) => (t * 1000 === Date.parse('2026-10-09T06:00:00Z') ? 70 : t * 1000 > at + 12 * 3600000 ? 55 : 75)),
            precipitation: times.map(() => 0),
          },
        }),
      };
    });
    const out = await get({ city: 'Sarasota', zip: '34236' });
    expect(out.isDaytime).toBe(false);
    expect(out.temp).toBe(75);
    expect(out.nightTemp).toBe(70);
    Date.now.mockRestore();
  });

  test('the NWS read carries a deadline, and a stalled NWS that aborts falls to the backup', async () => {
    const hour0 = Math.floor(Date.now() / 3600000) * 3600;
    const times = Array.from({ length: 30 }, (_, i) => hour0 + i * 3600);
    global.fetch = jest.fn(async (url) => {
      if (!isOpenMeteo(url)) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return {
        ok: true,
        json: async () => ({
          current: { time: Math.floor(Date.now() / 1000), temperature_2m: 80, relative_humidity_2m: 70, wind_speed_10m: 5, weather_code: 3 },
          hourly: { time: times, temperature_2m: times.map(() => 72), precipitation: times.map(() => 0) },
        }),
      };
    });
    const out = await get({ city: 'Venice', zip: '34285' });
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(out).toMatchObject({ temp: 80, forecast: 'Cloudy' });
  });

  test('both down: the seasonal fallback, as before', async () => {
    global.fetch = jest.fn(async () => ({ ok: false }));
    const out = await get({ city: 'Naples', zip: '34102' });
    expect(out.location).toBe('Naples, FL');
    expect(out.detailedForecast).toBe('');
    expect([89, 78]).toContain(out.temp);
  });
});
