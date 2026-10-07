/**
 * Booking rain rank (owner 2026-10-06, GATE_BOOKING_RAIN_RANK, dark).
 *
 *  1. rainFitFor: a booking is rain-OK only when every service is
 *     (assessment, estimate, inspection, WDO, rodent, trapping, interior).
 *  2. isWetWindow: 60%+ in any hour from the start through 2 h after the end,
 *     next 3 dates only; no reading = unknown, not dry.
 *  3. The New Appointment rows rank by rain fit before drive with the gate
 *     on; off, the order is drive-only and the forecast is read once.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { rainFitFor, isWetWindow, rainTier } = require('../services/scheduling/rain-fit');
const { buildBestRows } = require('../services/scheduling/find-time-hints');

const TODAY = '2026-10-07';
const hourly = [];
for (let h = 6; h <= 20; h += 1) {
  const hh = String(h).padStart(2, '0');
  // 7 Oct: storm 14:00-16:00. 8 Oct: dry. 10 Oct: storm all day (past the 3-day horizon).
  hourly.push({ startTime: `2026-10-07T${hh}:00:00-04:00`, rainChance: h >= 14 && h <= 16 ? 80 : 10 });
  hourly.push({ startTime: `2026-10-08T${hh}:00:00-04:00`, rainChance: 10 });
  hourly.push({ startTime: `2026-10-10T${hh}:00:00-04:00`, rainChance: 90 });
}

describe('rainFitFor', () => {
  test.each([
    [['General Pest Control'], 'avoid'],
    [['Lawn Care'], 'avoid'],
    [['Tree & Shrub'], 'avoid'],
    [['Mosquito'], 'avoid'],
    [['Termite Liquid Treatment'], 'avoid'],
    [['WaveGuard Assessment'], 'prefer'],
    [['Free Estimate'], 'prefer'],
    [['WDO Inspection'], 'prefer'],
    [['Rodent Trapping Check'], 'prefer'],
    [['Rodent Monitoring'], 'prefer'],
    [['Rodent Trapping + Exclusion'], 'avoid'],
    [['Rodent Wire Mesh Exclusion'], 'avoid'],
    [['Rodent Trapping'], 'avoid'],
    [['Interior + Exterior Pest'], 'avoid'],
    [['Interior Pest Only'], 'prefer'],
    [['WDO Inspection', 'General Pest Control'], 'avoid'],
    [[], 'neutral'],
    [[''], 'neutral'],
  ])('%j → %s', (types, fit) => {
    expect(rainFitFor(types)).toBe(fit);
  });
});

describe('isWetWindow', () => {
  const chip = (date, start, end) => ({ date, start_time: start, end_time: end });
  test('rain in the visit window is wet', () => {
    expect(isWetWindow(hourly, chip('2026-10-07', '14:00', '15:00'), TODAY)).toBe(true);
  });
  test('rain within 2 h after the visit is wet (drying time)', () => {
    expect(isWetWindow(hourly, chip('2026-10-07', '12:00', '13:00'), TODAY)).toBe(true);
  });
  test('rain 3 h after the visit is dry', () => {
    expect(isWetWindow(hourly, chip('2026-10-07', '09:00', '10:00'), TODAY)).toBe(false);
  });
  test('a date past the 3-day horizon is unknown', () => {
    expect(isWetWindow(hourly, chip('2026-10-10', '09:00', '10:00'), TODAY)).toBeNull();
  });
  test('no reading for the window is unknown', () => {
    expect(isWetWindow(hourly, chip('2026-10-09', '09:00', '10:00'), TODAY)).toBeNull();
    expect(isWetWindow(null, chip('2026-10-07', '09:00', '10:00'), TODAY)).toBeNull();
  });
  test('one dry reading does not cover a window with a missing hour', () => {
    const gappy = [
      { startTime: '2026-10-08T09:00:00-04:00', rainChance: 10 },
      { startTime: '2026-10-08T10:00:00-04:00', rainChance: null },
      { startTime: '2026-10-08T11:00:00-04:00', rainChance: 10 },
    ];
    expect(isWetWindow(gappy, chip('2026-10-08', '09:00', '10:00'), TODAY)).toBeNull();
    // A wet reading is known even when another hour is missing.
    gappy[2].rainChance = 70;
    expect(isWetWindow(gappy, chip('2026-10-08', '09:00', '10:00'), TODAY)).toBe(true);
  });
  test('tiers', () => {
    expect([rainTier('avoid', false), rainTier('avoid', null), rainTier('avoid', true)]).toEqual([0, 1, 2]);
    expect([rainTier('prefer', true), rainTier('prefer', null), rainTier('prefer', false)]).toEqual([0, 1, 2]);
    expect(rainTier('neutral', true)).toBe(0);
  });
});

describe('best rows rank by rain fit (GATE_BOOKING_RAIN_RANK)', () => {
  const h = (date, start, detour) => ({
    date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
    detour_minutes: detour, drive_in_minutes: detour, technician: { id: 't1', name: 'Tech One' },
  });
  // The wet 14:00 hour has the least drive; the dry ones cost more.
  const days = [{ date: TODAY, status: 'open', hours: [h(TODAY, '14:00', 5), h(TODAY, '08:00', 20), h(TODAY, '09:00', 25)] }];
  const run = (serviceTypes, hourlyRain = jest.fn(async () => hourly)) => buildBestRows(days, {
    pickedDate: TODAY, today: TODAY, lat: 1, lng: 2, serviceTypes,
    deps: { priceChipsOnRoads: async (chips) => chips, hourlyRain },
  });
  afterEach(() => { delete process.env.GATE_BOOKING_RAIN_RANK; });

  test('gate off: drive-only order, forecast read once', async () => {
    const hourlyRain = jest.fn(async () => hourly);
    const out = await run(['General Pest Control'], hourlyRain);
    expect(out.rows.day.map((c) => c.start_time)).toEqual(['14:00', '08:00', '09:00']);
    expect(hourlyRain).toHaveBeenCalledTimes(1);
  });

  test('gate on, outdoor booking: the wet hour sorts last', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const hourlyRain = jest.fn(async () => hourly);
    const out = await run(['General Pest Control'], hourlyRain);
    expect(out.rows.day.map((c) => c.start_time)).toEqual(['08:00', '09:00', '14:00']);
    expect(out.rows.day[2].rain_chance).toBe(80);
    // One forecast read serves both the ranking and the rain labels.
    expect(hourlyRain).toHaveBeenCalledTimes(1);
  });

  test('gate on, rain-OK booking: the wet hour sorts first', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const out = await run(['WaveGuard Assessment']);
    expect(out.rows.day[0].start_time).toBe('14:00');
  });

  test('gate on, every candidate past the 3-day horizon: rows do not wait for the forecast', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const far = '2026-10-14';
    const farDays = [{ date: far, status: 'open', hours: [h(far, '14:00', 5), h(far, '08:00', 20)] }];
    let priced = false;
    let release;
    const hourlyRain = jest.fn(() => new Promise((resolve) => { release = () => resolve(hourly); }));
    const pending = buildBestRows(farDays, {
      pickedDate: far, today: TODAY, lat: 1, lng: 2, serviceTypes: ['General Pest Control'],
      deps: { priceChipsOnRoads: async (chips) => { priced = true; return chips; }, hourlyRain },
    });
    await new Promise((r) => setImmediate(r));
    // Pricing started while the forecast is still out.
    expect(priced).toBe(true);
    release();
    const out = await pending;
    expect(out.rows.day.map((c) => c.start_time)).toEqual(['14:00', '08:00']);
  });

  test('gate on, no forecast: drive-only order (fail open)', async () => {
    process.env.GATE_BOOKING_RAIN_RANK = 'true';
    const out = await run(['General Pest Control'], jest.fn(async () => null));
    expect(out.rows.day.map((c) => c.start_time)).toEqual(['14:00', '08:00', '09:00']);
  });
});
