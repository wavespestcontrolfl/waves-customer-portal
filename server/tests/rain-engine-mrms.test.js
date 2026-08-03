/**
 * Rain engine — MRMS-primary ladder (GATE_RAIN_MRMS).
 *
 * Pins: (1) gate off = pre-engine behavior, ZERO extra external calls;
 * (2) merge semantics — closed days take the MRMS observation, gaps fall to
 * Open-Meteo, the unclosed visit day takes max(observation, model), a day
 * with neither fails the merge; (3) shadow mode logs but returns Open-Meteo;
 * (4) live mode returns the merged week with per-day provider stamps.
 */

const { mergeMrmsIntoWeek, rainMrmsMode } = require('../services/service-report/application-conditions');
const { fetchMrmsDailyRain } = require('../services/mrms-qpe');

const OM_WEEK = {
  rainInches: 1.18,
  et0Inches: 1.4,
  dailyRain: [
    { date: '2026-07-24', inches: 0.03 },
    { date: '2026-07-25', inches: 0 },
    { date: '2026-07-26', inches: 0.45 },
    { date: '2026-07-27', inches: 0.65 },
    { date: '2026-07-28', inches: 0 },
    { date: '2026-07-29', inches: 0 },
    { date: '2026-07-30', inches: 0.05 },
  ],
  rainConfidence: null,
  rainSource: 'property_point',
};

const mrmsDays = (values) => ({
  days: OM_WEEK.dailyRain.map((d, i) => ({ date: d.date, inches: values[i] })),
  complete: values.every((v) => v != null),
});

describe('rainMrmsMode', () => {
  const OLD = process.env.GATE_RAIN_MRMS;
  afterEach(() => { if (OLD === undefined) delete process.env.GATE_RAIN_MRMS; else process.env.GATE_RAIN_MRMS = OLD; });
  test('unset → off; shadow → shadow; true → live', () => {
    delete process.env.GATE_RAIN_MRMS;
    expect(rainMrmsMode()).toBe('off');
    process.env.GATE_RAIN_MRMS = 'shadow';
    expect(rainMrmsMode()).toBe('shadow');
    process.env.GATE_RAIN_MRMS = 'true';
    expect(rainMrmsMode()).toBe('live');
    process.env.GATE_RAIN_MRMS = 'false';
    expect(rainMrmsMode()).toBe('off');
  });
});

describe('mergeMrmsIntoWeek', () => {
  test('full MRMS week wins every closed day and stamps providers', () => {
    const merged = mergeMrmsIntoWeek({
      om: OM_WEEK,
      mrms: mrmsDays([0.29, 0, 1.14, 1.1, 0, 0, 0.39]),
      todayYmd: '2026-07-30',
    });
    expect(merged.rainSource).toBe('mrms');
    expect(merged.rainInches).toBeCloseTo(2.92, 2);
    expect(merged.dailyRain.every((d) => d.provider === 'mrms')).toBe(true);
    expect(merged.et0Inches).toBe(1.4);
  });

  test('a gap day falls back to Open-Meteo → mixed source', () => {
    const merged = mergeMrmsIntoWeek({
      om: OM_WEEK,
      mrms: mrmsDays([0.29, 0, null, 1.1, 0, 0, 0.39]),
      todayYmd: '2026-07-30',
    });
    expect(merged.rainSource).toBe('mrms+open_meteo');
    const gapDay = merged.dailyRain.find((d) => d.date === '2026-07-26');
    expect(gapDay).toEqual({ date: '2026-07-26', inches: 0.45, provider: 'open_meteo' });
  });

  test('unclosed visit day takes max(observation, model)', () => {
    const merged = mergeMrmsIntoWeek({
      om: { ...OM_WEEK, dailyRain: OM_WEEK.dailyRain.map((d) => (d.date === '2026-07-30' ? { ...d, inches: 0.8 } : d)) },
      mrms: mrmsDays([0.29, 0, 1.14, 1.1, 0, 0, 0.39]),
      todayYmd: '2026-07-30',
    });
    const today = merged.dailyRain.find((d) => d.date === '2026-07-30');
    expect(today.inches).toBe(0.8);
    expect(today.provider).toBe('open_meteo');
  });

  test('a day with neither source fails the whole merge', () => {
    const merged = mergeMrmsIntoWeek({
      om: { ...OM_WEEK, dailyRain: OM_WEEK.dailyRain.slice(0, 6) },
      mrms: mrmsDays([0.29, 0, 1.14, 1.1, 0, 0, null]),
      todayYmd: '2026-07-29',
    });
    expect(merged).toBeNull();
  });

  test('MRMS-complete CLOSED week survives an Open-Meteo outage', () => {
    const merged = mergeMrmsIntoWeek({
      om: { rainInches: null, et0Inches: null, dailyRain: null, rainConfidence: null, rainSource: null },
      mrms: mrmsDays([0.29, 0, 1.14, 1.1, 0, 0, 0.39]),
      todayYmd: '2026-07-31',
    });
    expect(merged.rainSource).toBe('mrms');
    expect(merged.rainInches).toBeCloseTo(2.92, 2);
    expect(merged.et0Inches).toBeNull();
  });

  test('missing MRMS row for today uses the model and keeps closed-day measurements (r3)', () => {
    const merged = mergeMrmsIntoWeek({
      om: OM_WEEK,
      mrms: mrmsDays([0.29, 0, 1.14, 1.1, 0, 0, null]),
      todayYmd: '2026-07-30',
    });
    expect(merged.rainSource).toBe('mrms+open_meteo');
    const today = merged.dailyRain.find((d) => d.date === '2026-07-30');
    expect(today).toEqual({ date: '2026-07-30', inches: 0.05, provider: 'open_meteo' });
    expect(merged.dailyRain.filter((d) => d.provider === 'mrms')).toHaveLength(6);
  });

  test('unclosed day with MRMS-so-far but no model value fails the merge (r2)', () => {
    const merged = mergeMrmsIntoWeek({
      om: { rainInches: null, et0Inches: null, dailyRain: null, rainConfidence: null, rainSource: null },
      mrms: mrmsDays([0.29, 0, 1.14, 1.1, 0, 0, 0.39]),
      todayYmd: '2026-07-30',
    });
    expect(merged).toBeNull();
  });

  test('all-gaps MRMS adds nothing → null (caller keeps Open-Meteo)', () => {
    expect(mergeMrmsIntoWeek({
      om: OM_WEEK,
      mrms: mrmsDays([null, null, null, null, null, null, null]),
      todayYmd: '2026-07-30',
    })).toBeNull();
    expect(mergeMrmsIntoWeek({ om: OM_WEEK, mrms: null, todayYmd: '2026-07-30' })).toBeNull();
  });

  test("city-collective 'low' badge survives only when OM days remain", () => {
    const lowOm = { ...OM_WEEK, rainConfidence: 'low', rainSource: 'city_collective' };
    const mixed = mergeMrmsIntoWeek({ om: lowOm, mrms: mrmsDays([0.29, 0, null, 1.1, 0, 0, 0.39]), todayYmd: '2026-07-30' });
    expect(mixed.rainConfidence).toBe('low');
    const allMrms = mergeMrmsIntoWeek({ om: lowOm, mrms: mrmsDays([0.29, 0, 1.14, 1.1, 0, 0, 0.39]), todayYmd: '2026-07-31' });
    expect(allMrms.rainConfidence).toBeNull();
  });
});

describe('fetchMrmsDailyRain payload handling', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('parses IEM rows, materializes gaps for missing dates', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { date: '2026-07-24', mrms_precip_in: 0.29 },
          { date: '2026-07-26', mrms_precip_in: 1.14 },
        ],
      }),
    });
    const out = await fetchMrmsDailyRain({ latitude: 27.54, longitude: -82.47, start: '2026-07-24', end: '2026-07-26' });
    expect(out.days).toEqual([
      { date: '2026-07-24', inches: 0.29 },
      { date: '2026-07-25', inches: null },
      { date: '2026-07-26', inches: 1.14 },
    ]);
    expect(out.complete).toBe(false);
  });

  test('null and empty-string rows stay gaps, never zeros (codex P2)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { date: '2026-07-24', mrms_precip_in: null },
          { date: '2026-07-25', mrms_precip_in: '' },
          { date: '2026-07-26', mrms_precip_in: 0 },
        ],
      }),
    });
    const out = await fetchMrmsDailyRain({ latitude: 27.54, longitude: -82.47, start: '2026-07-24', end: '2026-07-26' });
    expect(out.days).toEqual([
      { date: '2026-07-24', inches: null },
      { date: '2026-07-25', inches: null },
      { date: '2026-07-26', inches: 0 },
    ]);
    expect(out.complete).toBe(false);
  });

  test('non-OK, malformed, and thrown fetches all return null', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false });
    expect(await fetchMrmsDailyRain({ latitude: 27, longitude: -82, start: '2026-07-24', end: '2026-07-26' })).toBeNull();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: true }) });
    expect(await fetchMrmsDailyRain({ latitude: 27, longitude: -82, start: '2026-07-24', end: '2026-07-26' })).toBeNull();
    global.fetch = jest.fn().mockRejectedValue(new Error('boom'));
    expect(await fetchMrmsDailyRain({ latitude: 27, longitude: -82, start: '2026-07-24', end: '2026-07-26' })).toBeNull();
  });
});
