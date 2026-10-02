jest.mock('../services/pest-forecast/weather', () => ({ getWeatherSignals: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { computeForecast, getForecastWithFreshness, _clearCache } = require('../services/pest-forecast/forecast');
const { compareForecasts, weekBefore, saveSnapshot, collectDailyForecasts } = require('../services/pest-forecast/history');
const { getWeatherSignals } = require('../services/pest-forecast/weather');
const db = require('../models/db');
const { BY_SLUG, LOCATIONS } = require('../services/pest-forecast/locations');
const location = BY_SLUG.get('bradenton-fl');
const signals = { hasWeather: true, source: 'nws', warm: true, wet: true, tempHighF: 88, precipChance: 70, recentRainIn: null };
const make = (date, overrides = {}) => computeForecast(location, { ...signals, ...overrides }, new Date(`${date}T16:00:00Z`));
const pest = f => f.pests.find(p => p.key === 'ants');

afterEach(() => { delete process.env.GATE_PEST_FORECAST_HISTORY; _clearCache(); jest.clearAllMocks(); });

test('above-seasonal pressure can be lower than last week; neither comparison overwrites the other', () => {
  const previous = make('2026-09-25');
  const current = make('2026-10-02');
  const result = compareForecasts(current, previous);
  expect(pest(result)).toMatchObject({ baseline_comparison: 'above', trend: 'up',
    week_over_week: { direction: 'down', delta: -1, previous_date: '2026-09-25', current_date: '2026-10-02' } });
  expect(pest(current).week_over_week).toBeNull();
});

test.each([
  ['no history', () => null],
  ['six days old', () => make('2026-09-26')],
  ['another city', () => ({ ...make('2026-09-25'), location: { slug: 'sarasota-fl' } })],
  ['another model', () => ({ ...make('2026-09-25'), model_version: 'future-model' })],
  ['weather outage', () => make('2026-09-25', { hasWeather: false })],
  ['different weather coverage', () => make('2026-09-25', { source: 'nws+mrms', recentRainIn: 1 })],
  ['future generated timestamp', () => ({ ...make('2026-09-25'), generated_at: '2026-10-03T16:00:00Z' })],
])('%s never becomes a flat trend', (_label, previous) => {
  expect(pest(compareForecasts(make('2026-10-02'), previous())).week_over_week).toBeNull();
});

test('missing and nonnumeric pest scores are not zero', () => {
  const previous = make('2026-09-25');
  pest(previous).score = null;
  expect(pest(compareForecasts(make('2026-10-02'), previous)).week_over_week).toBeNull();
  previous.pests = [];
  expect(pest(compareForecasts(make('2026-10-02'), previous)).week_over_week).toBeNull();
});

test('unchanged comparable history is explicitly similar, including DST and year boundaries', () => {
  expect(weekBefore('2026-11-03')).toBe('2026-10-27');
  expect(weekBefore('2027-01-03')).toBe('2026-12-27');
  const previous = make('2026-10-02');
  const current = make('2026-10-09');
  expect(pest(compareForecasts(current, previous)).week_over_week).toMatchObject({ direction: 'flat', delta: 0 });
});

test('weather outage cannot be captured as successful history', async () => {
  const knex = jest.fn();
  expect(await saveSnapshot(make('2026-10-02', { hasWeather: false }), knex)).toBe(false);
  expect(knex).not.toHaveBeenCalled();
});

test('disabled collector does no database or weather work', async () => {
  const knex = jest.fn();
  expect(await collectDailyForecasts({ knex })).toEqual({ skipped: 'gated' });
  expect(knex).not.toHaveBeenCalled();
  expect(getWeatherSignals).not.toHaveBeenCalled();
});

test('collector saves only missing cities, preserves the ET date, and retries unavailable weather', async () => {
  process.env.GATE_PEST_FORECAST_HISTORY = 'true';
  const missing = LOCATIONS.slice(0, 2);
  const inserted = [];
  const knex = jest.fn(() => ({
    where: () => ({ pluck: async () => LOCATIONS.slice(2).map(l => l.slug) }),
    insert: row => {
      inserted.push(row);
      return { onConflict: () => ({ ignore: () => ({ returning: async () => [row.location_slug] }) }) };
    },
  }));
  getWeatherSignals.mockResolvedValueOnce(signals).mockResolvedValueOnce({ hasWeather: false });
  await expect(collectDailyForecasts({ knex, now: new Date('2026-10-03T02:00:00Z') }))
    .rejects.toThrow('1 saved, 1 weather unavailable, 0 failed');
  expect(getWeatherSignals.mock.calls.map(([l]) => l.slug)).toEqual(missing.map(l => l.slug));
  expect(inserted).toHaveLength(1);
  expect(inserted[0]).toMatchObject({ location_slug: missing[0].slug, forecast_date: '2026-10-02' });
  expect(JSON.parse(inserted[0].forecast).as_of_date).toBe('2026-10-02');
});

test('collector continues to other cities after a failed weather request and reports the gap', async () => {
  process.env.GATE_PEST_FORECAST_HISTORY = 'true';
  const knex = jest.fn(() => ({
    where: () => ({ pluck: async () => LOCATIONS.slice(2).map(l => l.slug) }),
    insert: () => ({ onConflict: () => ({ ignore: () => ({ returning: async () => ['saved'] }) }) }),
  }));
  getWeatherSignals.mockRejectedValueOnce(new Error('upstream')).mockResolvedValueOnce(signals);
  await expect(collectDailyForecasts({ knex })).rejects.toThrow('1 saved, 0 weather unavailable, 1 failed');
  expect(getWeatherSignals).toHaveBeenCalledTimes(2);
});

test('history read failure leaves the public forecast usable and unknown; public path never writes', async () => {
  process.env.GATE_PEST_FORECAST_HISTORY = 'true';
  const first = jest.fn(() => ({ timeout: jest.fn().mockRejectedValue(new Error('table not migrated')) }));
  const where = jest.fn(() => ({ first }));
  db.mockReturnValue({ where });
  getWeatherSignals.mockResolvedValue({ ...signals, freshUntil: Date.now() + 60000 });
  const out = await getForecastWithFreshness({ location: location.slug });
  expect(out.forecast.weather.available).toBe(true);
  expect(out.forecast.pests.every(p => p.week_over_week === null)).toBe(true);
  expect(db).toHaveBeenCalledTimes(1);
  expect(where).toHaveBeenCalledWith(expect.objectContaining({ location_slug: location.slug }));
});

test('turning history off cannot replay a history-enriched cache entry', async () => {
  process.env.GATE_PEST_FORECAST_HISTORY = 'true';
  const now = new Date('2026-10-02T16:00:00Z');
  db.mockReturnValue({ where: () => ({ first: () => ({ timeout: async () => ({ forecast: make('2026-09-25') }) }) }) });
  getWeatherSignals.mockResolvedValue({ ...signals, freshUntil: Date.now() + 60000 });
  expect(pest((await getForecastWithFreshness({ location: location.slug }, { now })).forecast).week_over_week).not.toBeNull();
  delete process.env.GATE_PEST_FORECAST_HISTORY;
  expect(pest((await getForecastWithFreshness({ location: location.slug }, { now })).forecast).week_over_week).toBeNull();
  expect(db).toHaveBeenCalledTimes(1);
});
