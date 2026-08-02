/**
 * Rain provenance — archive-first Open-Meteo, honest Source labels, and the
 * conditional NOAA attribution line.
 *
 * Context (measured 2026-08-01 for one SWFL service week): Open-Meteo's
 * /v1/forecast endpoint reported 0.00" on two days the archive scored at
 * 0.055" and 0.382" — weekly 1.12" vs 2.67" — and a volunteer rain gauge a few
 * miles away caught 1.28" in the same window. The service week is always a
 * COMPLETED window, so the archive is the correct endpoint and the forecast
 * API is the fallback.
 *
 * Pins: (1) the archive is tried first and the forecast endpoint only backs it
 * up; (2) an unusable archive window degrades to the forecast rather than to
 * nothing; (3) the customer-facing Source row credits the provider that
 * actually supplied the number — the pre-fix code hardcoded 'open_meteo' and
 * mislabeled every MRMS week the moment the gate flipped; (4) the NOAA
 * attribution appears ONLY on a measured week.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _private: irrigationPrivate } = require('../services/irrigation-weekly-email');

describe('Open-Meteo service week — archive first, forecast as fallback', () => {
  const OK = (dailyPrecip) => ({
    ok: true,
    json: async () => ({
      daily: {
        time: ['2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30'],
        precipitation_sum: dailyPrecip,
        et0_fao_evapotranspiration: new Array(7).fill(0.2),
      },
      daily_units: { et0_fao_evapotranspiration: 'mm' },
    }),
  });

  let conditions;
  beforeEach(() => {
    jest.resetModules();
     
    conditions = require('../services/service-report/application-conditions');
  });
  afterEach(() => { delete global.fetch; jest.restoreAllMocks(); });

  test('the ARCHIVE endpoint is called first for a completed service week', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => { urls.push(String(url)); return OK([0.1, 0, 0.2, 1.0, 0.05, 0.38, 0.66]); });

    await conditions.fetchServiceWeekWeather({ latitude: 27.5, longitude: -82.5, serviceDate: '2026-07-30' });

    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('archive-api.open-meteo.com');
    // The forecast endpoint must NOT be hit when the archive answered.
    expect(urls.some((u) => u.includes('api.open-meteo.com/v1/forecast'))).toBe(false);
  });

  test('an unusable archive window falls back to the forecast endpoint, not to nothing', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(String(url));
      // Archive 500s; forecast answers with a full, trustworthy window.
      if (String(url).includes('archive-api')) return { ok: false, status: 500, json: async () => ({}) };
      return OK([0.03, 0, 0.45, 0.65, 0, 0, 0.05]);
    });

    const week = await conditions.fetchServiceWeekWeather({ latitude: 27.5, longitude: -82.5, serviceDate: '2026-07-30' });

    expect(urls[0]).toContain('archive-api.open-meteo.com');
    expect(urls.some((u) => u.includes('api.open-meteo.com/v1/forecast'))).toBe(true);
    // Degrades to the PREVIOUS behaviour — a real week, not an empty one.
    expect(week.rainInches).toBeCloseTo(1.18, 2);
  });

  test('a window ending TODAY keeps the forecast endpoint — the archive would understate an unclosed day', async () => {
    // Reanalysis only carries the hours already assimilated, so on a day that
    // is still raining it reads low. Same reasoning mergeMrmsIntoWeek uses to
    // stop a partial MRMS total from capping the model (codex #3153 P1).
    const urls = [];
    global.fetch = jest.fn(async (url) => { urls.push(String(url)); return OK([0.1, 0, 0.2, 1.0, 0.05, 0.38, 0.66]); });

    const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    await conditions.fetchServiceWeekWeather({ latitude: 27.5, longitude: -82.5, serviceDate: todayEt });

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('archive-api.open-meteo.com'))).toBe(true);
    expect(urls[0]).toContain('api.open-meteo.com/v1/forecast');
  });

  test('a partial archive window (a missing day) is rejected and retried on the forecast endpoint', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(String(url));
      // A null day must never be read as a zero — the whole window is untrusted.
      if (String(url).includes('archive-api')) return OK([0.1, null, 0.2, 1.0, 0.05, 0.38, 0.66]);
      return OK([0.03, 0, 0.45, 0.65, 0, 0, 0.05]);
    });

    const week = await conditions.fetchServiceWeekWeather({ latitude: 27.5, longitude: -82.5, serviceDate: '2026-07-30' });

    expect(urls.some((u) => u.includes('api.open-meteo.com/v1/forecast'))).toBe(true);
    expect(week.rainInches).toBeCloseTo(1.18, 2);
  });
});

describe('Source row credits the real provider', () => {
  // The REAL buildLawnWaterContext — an earlier draft of this suite asserted an
  // inline copy of the mapping, which would have passed while the shipped code
  // regressed. Always exercise the implementation.
   
  const { buildLawnWaterContext } = require('../services/service-report/report-data');

  const ctx = (completionRainSource) => buildLawnWaterContext({
    assessment: {},
    serviceDate: '2026-07-30',
    completionRainfall7dInches: 2.6,
    completionEt0Inches: 1.4,
    completionRainSource,
  });

  test.each([
    ['mrms'],
    ['mrms+open_meteo'],
    ['property_point'],
    ['city_collective'],
  ])('a %s week is credited to that provider, not a hardcoded open_meteo', (source) => {
    expect(ctx(source).rainfall7dProvider).toBe(source);
  });

  test('a completion figure with NO source still falls back to open_meteo', () => {
    expect(ctx(null).rainfall7dProvider).toBe('open_meteo');
  });

  test('no completion figure at all → not credited to Open-Meteo', () => {
    const water = buildLawnWaterContext({
      assessment: {}, serviceDate: '2026-07-30', completionRainfall7dInches: null, completionRainSource: null,
    });
    expect(water.rainfall7dProvider).not.toBe('open_meteo');
  });
});

describe('NOAA attribution appears only on a measured week', () => {
  const note = irrigationPrivate.rainSourceNote;

  test.each([
    ['mrms', true],
    ['mrms+open_meteo', true],
  ])('%s → the note is present', (source, present) => {
    expect(Boolean(note(source))).toBe(present);
    expect(note(source)).toBe('Based on NOAA radar and rain-gauge data — local totals may vary.');
  });

  test.each([
    ['property_point'],
    ['city_collective'],
    ['open_meteo'],
    [null],
    [undefined],
    [''],
  ])('%s → empty string, never a radar claim over a model number', (source) => {
    expect(note(source)).toBe('');
  });
});
