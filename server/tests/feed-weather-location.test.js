/**
 * GET /api/feed/weather — the portal "Local Conditions" card.
 *  - reads the weather for the logged-in customer's own forecast city, and
 *    names that city in `location` (Lakewood Ranch only as a labeled fallback)
 *  - after dark, "tonight" is the night period, never tomorrow's daytime high
 *  - mosquito pressure comes from the pest-forecast service (the same one the
 *    website widget reads), not a separate calculation
 *  - the 30 minute cache is keyed per location
 */
const DAY = {
  isDaytime: true, temperature: 91, windSpeed: '8 mph', shortForecast: 'Mostly Sunny',
  detailedForecast: 'Sunny.', relativeHumidity: { value: 65 },
};
const NIGHT = {
  isDaytime: false, temperature: 74, windSpeed: '5 mph', shortForecast: 'Mostly Clear',
  detailedForecast: 'Clear.', relativeHumidity: { value: 80 },
};
const TOMORROW_DAY = { ...DAY, temperature: 89 };

function mockNws(periods) {
  global.fetch = jest.fn(async (url) => {
    if (String(url).startsWith('https://api.weather.gov/points/')) {
      return { ok: true, json: async () => ({ properties: { forecast: 'https://api.weather.gov/gridpoints/TBW/1,1/forecast' } }) };
    }
    return { ok: true, json: async () => ({ properties: { periods } }) };
  });
}

function pestForecast(mosquito) {
  return { pests: [{ key: 'ants', level: 'low', score10: 3, note: 'ants' }, { key: 'mosquitoes', ...mosquito }] };
}

// The cache is module-level; every test uses a fresh module instance so one
// test's cached response never answers another's request.
let freshHandler;
let getForecastMock;
beforeEach(() => {
  jest.resetModules();
  jest.doMock('../middleware/auth', () => ({ authenticate: (req, res, next) => next() }));
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/newsletter-feed', () => ({ getPublishedPosts: jest.fn(async () => []) }));
  jest.doMock('../services/local-news-store', () => ({}));
  jest.doMock('../services/pest-forecast/forecast', () => ({ getForecast: jest.fn() }));
  const freshRouter = require('../routes/feed');
  freshHandler = freshRouter.stack.find((l) => l.route && l.route.path === '/weather').route.stack[0].handle;
  getForecastMock = require('../services/pest-forecast/forecast').getForecast;
  getForecastMock.mockResolvedValue(pestForecast({ level: 'high', score10: 10, note: 'Warm, humid Florida weather keeps biting pressure up.' }));
  mockNws([DAY, NIGHT, TOMORROW_DAY]);
});

async function get({ customer, property } = {}) {
  let body;
  let error;
  const res = { json: (b) => { body = b; return res; } };
  await freshHandler({ customer, property }, res, (e) => { error = e; });
  if (error) throw error;
  return body;
}

describe('location resolution', () => {
  test('uses the customer city, reads NWS for that point, and names it', async () => {
    const out = await get({ customer: { city: 'Sarasota', zip: '34236' } });
    expect(out.location).toBe('Sarasota, FL');
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.weather.gov/points/27.3364,-82.5307');
    expect(getForecastMock).toHaveBeenCalledWith({ location: 'sarasota-fl' });
  });

  test('city match ignores case, periods, and extra spaces', async () => {
    const out = await get({ customer: { city: '  st.  petersburg ', zip: '' } });
    expect(out.location).toBe('St. Petersburg, FL');
  });

  test('an uncurated city resolves through the zip and names the forecast city, not the customer city', async () => {
    const out = await get({ customer: { city: 'Myakka City', zip: '34251' } });
    expect(out.location).toBe('Bradenton, FL');
  });

  test('the selected property wins over the customer row', async () => {
    const out = await get({
      customer: { city: 'Sarasota', zip: '34236' },
      property: { city: 'Venice', zip: '34285' },
    });
    expect(out.location).toBe('Venice, FL');
  });

  test('nothing resolves: falls back to Lakewood Ranch and says so', async () => {
    const out = await get({ customer: { city: '', zip: null } });
    expect(out.location).toBe('Lakewood Ranch, FL');
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.weather.gov/points/27.4225,-82.4082');
    expect(getForecastMock).toHaveBeenCalledWith({ location: 'lakewood-ranch-fl' });
  });

  test('NWS down: the fallback payload still carries the resolved location and forecast mosquito', async () => {
    global.fetch = jest.fn(async () => ({ ok: false }));
    const out = await get({ customer: { city: 'Naples', zip: '34102' } });
    expect(out.location).toBe('Naples, FL');
    expect(out.pestPressure.mosquito.level).toBe('HIGH');
  });
});

describe('day and night periods', () => {
  test('daytime: today is periods[0], tonight is the first night period', async () => {
    mockNws([DAY, NIGHT, TOMORROW_DAY]);
    const out = await get({ customer: { city: 'Bradenton' } });
    expect(out.isDaytime).toBe(true);
    expect(out.temp).toBe(91);
    expect(out.nightTemp).toBe(74);
  });

  test('after dark: periods[0] is tonight, tomorrow\'s high is not shown as tonight', async () => {
    mockNws([{ ...NIGHT, temperature: 71 }, TOMORROW_DAY, { ...NIGHT, temperature: 73 }]);
    const out = await get({ customer: { city: 'Bradenton' } });
    expect(out.isDaytime).toBe(false);
    expect(out.temp).toBe(71);
    expect(out.nightTemp).toBe(71);
    expect(out.forecast).toBe('Mostly Clear');
  });
});

describe('mosquito pressure', () => {
  test('comes from the pest-forecast service for the same location (10/10 reads HIGH)', async () => {
    const out = await get({ customer: { city: 'Parrish' } });
    expect(getForecastMock).toHaveBeenCalledWith({ location: 'parrish-fl' });
    expect(out.pestPressure.mosquito).toEqual({
      level: 'HIGH',
      color: '#E53935',
      advice: 'Warm, humid Florida weather keeps biting pressure up.',
      score10: 10,
      forecastLevel: 'high',
    });
  });

  test.each([
    ['high', 'HIGH'], ['elevated', 'MODERATE'], ['moderate', 'MODERATE'], ['low', 'LOW'], ['minimal', 'LOW'],
  ])('forecast level %s maps to %s', async (forecastLevel, expected) => {
    getForecastMock.mockResolvedValue(pestForecast({ level: forecastLevel, score10: 5, note: 'n' }));
    const out = await get({ customer: { city: 'Tampa' } });
    expect(out.pestPressure.mosquito.level).toBe(expected);
  });

  test('forecast service failure degrades to a seasonal read instead of failing the card', async () => {
    getForecastMock.mockRejectedValue(new Error('boom'));
    const out = await get({ customer: { city: 'Tampa' } });
    expect(['HIGH', 'MODERATE']).toContain(out.pestPressure.mosquito.level);
    expect(out.pestPressure.fungus).toBeDefined();
  });
});

describe('cache', () => {
  test('is keyed per location: a second city does not get the first city\'s weather', async () => {
    const a = await get({ customer: { city: 'Sarasota' } });
    const b = await get({ customer: { city: 'Tampa' } });
    expect(a.location).toBe('Sarasota, FL');
    expect(b.location).toBe('Tampa, FL');
    // 2 NWS calls per uncached location
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  test('the same location is served from cache', async () => {
    await get({ customer: { city: 'Sarasota' } });
    const again = await get({ customer: { city: 'Sarasota', zip: '34236' } });
    expect(again.location).toBe('Sarasota, FL');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(getForecastMock).toHaveBeenCalledTimes(1);
  });
});
