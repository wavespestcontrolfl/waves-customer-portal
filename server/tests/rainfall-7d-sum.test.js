const { sumPrecipInches, et0SumToInches, rainWindowEndingOn } = require('../services/service-report/application-conditions');

describe('et0SumToInches (unit safety)', () => {
  test('inch unit (our request) passes through', () => {
    expect(et0SumToInches(1.57, 'inch')).toBe(1.57);
    expect(et0SumToInches(1.57, 'in')).toBe(1.57);
  });
  test('mm unit converts so a ~40mm week is not read as 40 inches', () => {
    expect(et0SumToInches(40, 'mm')).toBe(1.57); // 40 / 25.4
  });
  test('missing unit defaults to inches (matches the request)', () => {
    expect(et0SumToInches(1.5, null)).toBe(1.5);
    expect(et0SumToInches(1.5, undefined)).toBe(1.5);
  });
  test('null/invalid sum → null', () => {
    expect(et0SumToInches(null, 'inch')).toBeNull();
    expect(et0SumToInches('x', 'mm')).toBeNull();
  });
});

describe('sumPrecipInches', () => {
  test('sums all numeric days', () => {
    expect(sumPrecipInches([0.1, 0.2, 0, 0.5, 0, 0.3, 0.1])).toBe(1.2);
  });

  test('a real zero-rain window stays 0 (not unknown)', () => {
    expect(sumPrecipInches([0, 0, 0])).toBe(0);
  });

  test('a PARTIAL window (any missing/non-numeric day) → null, not an undercount', () => {
    expect(sumPrecipInches([null, 0.2, null, 0.3])).toBeNull();
    expect(sumPrecipInches([0.2, '', 0.3])).toBeNull();
    expect(sumPrecipInches([0.2, 'x', 0.3])).toBeNull();
  });

  test('all-missing / empty → null (caller degrades to rain_unknown)', () => {
    expect(sumPrecipInches([null, '', undefined])).toBeNull();
    expect(sumPrecipInches([])).toBeNull();
    expect(sumPrecipInches(null)).toBeNull();
  });
});

describe('rainWindowEndingOn', () => {
  test('7-day window ending on the service date (inclusive)', () => {
    expect(rainWindowEndingOn('2026-06-12', 7)).toEqual({ start: '2026-06-06', end: '2026-06-12' });
  });

  test('accepts a Date object', () => {
    expect(rainWindowEndingOn(new Date('2026-06-12T00:00:00Z'), 7)).toEqual({ start: '2026-06-06', end: '2026-06-12' });
  });

  test('malformed date → null', () => {
    expect(rainWindowEndingOn('not-a-date')).toBeNull();
    expect(rainWindowEndingOn(null)).toBeNull();
  });
});

describe('fetchServiceWeekWeather — dailyRain mirrors rainInches (no partial chart)', () => {
  const { fetchServiceWeekWeather } = require('../services/service-report/application-conditions');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  // Mock Open-Meteo to return the exact inclusive window the function expects, with
  // a caller-supplied precipitation array (one entry per day).
  function mockOpenMeteo(window, precip) {
    const days = [];
    let d = new Date(`${window.start}T00:00:00Z`);
    const end = new Date(`${window.end}T00:00:00Z`);
    while (d <= end) { days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        daily: { time: days, precipitation_sum: precip, et0_fao_evapotranspiration: days.map(() => 0.2) },
        daily_units: { et0_fao_evapotranspiration: 'inch' },
      }),
    });
  }

  test('a clean full window → weekly total AND a complete per-day array', async () => {
    const serviceDate = '2026-05-10';
    mockOpenMeteo(rainWindowEndingOn(serviceDate, 7), [0.1, 0, 0.2, 0, 0.3, 0, 0.1]);
    const res = await fetchServiceWeekWeather({ latitude: 27.1, longitude: -82.4, serviceDate });
    expect(res.rainInches).toBe(0.7);
    expect(Array.isArray(res.dailyRain)).toBe(true);
    expect(res.dailyRain).toHaveLength(7);
    expect(res.dailyRain.every((p) => typeof p.inches === 'number')).toBe(true);
  });

  test('full-length window but ONE missing day → rainInches null AND dailyRain null', async () => {
    // Different end-date + coords so this never hits the prior test's rain cache.
    const serviceDate = '2026-05-11';
    mockOpenMeteo(rainWindowEndingOn(serviceDate, 7), [0.1, null, 0.2, 0, 0.3, 0, 0.1]);
    const res = await fetchServiceWeekWeather({ latitude: 28.2, longitude: -81.9, serviceDate });
    // sumPrecipInches rejects the partial window → both must be null together, so the
    // chart can never render a 6-bar partial series while the weekly total is unknown.
    expect(res.rainInches).toBeNull();
    expect(res.dailyRain).toBeNull();
  });

  test('a SHORT et0 array (full precip window) → et0Inches null, rain still computed', async () => {
    // Open-Meteo can return a full precipitation_sum but a truncated et0 series.
    // sumPrecipInches only rejects gaps, not a short array, so et0 must be length-guarded
    // against the window or it would understate ET₀ and drag the water target down.
    const serviceDate = '2026-05-12';
    const window = rainWindowEndingOn(serviceDate, 7);
    const days = [];
    let d = new Date(`${window.start}T00:00:00Z`);
    const end = new Date(`${window.end}T00:00:00Z`);
    while (d <= end) { days.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        daily: {
          time: days,
          precipitation_sum: days.map(() => 0.1), // full, valid → rain trusted
          et0_fao_evapotranspiration: [0.2, 0.2, 0.2], // SHORT: 3 of 7 → et0 must NOT be trusted
        },
        daily_units: { et0_fao_evapotranspiration: 'inch' },
      }),
    });
    const res = await fetchServiceWeekWeather({ latitude: 27.33, longitude: -82.55, serviceDate });
    expect(res.rainInches).toBe(0.7);
    expect(res.et0Inches).toBeNull();
  });
});
