/**
 * Customer rain rank (owner 2026-10-08, GATE_CUSTOMER_RAIN_RANK, dark):
 * buildBookingAvailability ranks its recommendations and each day's best fit
 * by rain fit before route score.
 *  - Gate off: today's order, no forecast read, no rain_tier in the payload.
 *  - Gate on, outdoor booking: the wet hour loses the day's best fit and the
 *    first recommendation to a dry one.
 *  - Gate on, rain-OK booking (the assessment's own catalog identity): the
 *    wet hour keeps both.
 *  - The re-service profile and a failed forecast keep today's order.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({ getHourlyRainOutlook: jest.fn(), getDailyRainOutlookBounded: jest.fn(async () => null) }));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async ({ service_key_snapshot: key }) => ({ serviceKey: key || null, findingsType: null })),
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { getHourlyRainOutlook } = require('../services/weather-forecast');
const { buildBookingAvailability } = require('../routes/booking')._internals;
const { customerRainTierOf, startCustomerRainRank, stampRainTiers, rainTierDiff } = require('../services/scheduling/customer-rain-rank');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const D1 = dayOffset(1); // inside the 3-day horizon
const CONFIG = { advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '18:00', max_self_books_per_day: 3 };

// D1: 14:00-16:00 reads 85%; every other hour 10%.
const HOURLY = Array.from({ length: 13 }, (_, i) => {
  const h = 7 + i;
  return { startTime: `${D1}T${String(h).padStart(2, '0')}:00:00-04:00`, rainChance: h >= 14 && h <= 16 ? 85 : 10 };
});

function gapSlot(startTime, extra = {}) {
  return {
    date: D1, start_time: startTime, end_time: null, technician: { id: 'tech-1' },
    detour_minutes: 3, stops_that_day: 2, rank: 1, score: 10, insertion: { after_stop_id: 'stop-1' }, ...extra,
  };
}

function wireDb() {
  const builder = {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
}

const build = (extra = {}) => buildBookingAvailability({
  lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D1, rangeTo: D1, config: CONFIG, today: new Date(), serviceKey: 'pest_control', ...extra,
});
const bestFit = (availability) => availability.days[0].slots.find((s) => s.is_best_fit)?.start_time;

describe('buildBookingAvailability rain rank', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDb();
    listOccupiedWindows.mockResolvedValue([]);
    getHourlyRainOutlook.mockResolvedValue(HOURLY);
    // The wet 14:00 start has the better route score; the dry 10:00 the worse.
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('14:00', { rank: 1, score: 5, insertion: { after_stop_id: 'a' } }), gapSlot('10:00', { rank: 2, score: 40, insertion: { after_stop_id: 'b' } })],
      total_feasible: 2,
    });
  });
  afterEach(() => { delete process.env.GATE_CUSTOMER_RAIN_RANK; });

  test('gate off: route score decides, the forecast is not read, nothing leaks', async () => {
    const out = await build();
    expect(bestFit(out)).toBe('14:00');
    expect(out.slots[0].start_time).toBe('14:00');
    expect(getHourlyRainOutlook).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain('rain_tier');
  });

  test('gate on, outdoor booking: the dry hour takes the best fit and the recommendation', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const out = await build();
    expect(bestFit(out)).toBe('10:00');
    expect(out.slots[0].start_time).toBe('10:00');
    // Order only: the wet hour is still offered in the day list.
    expect(out.days[0].slots.map((s) => s.start_time)).toEqual(expect.arrayContaining(['10:00', '14:00']));
    expect(JSON.stringify(out)).not.toContain('rain_tier');
  });

  test('gate on: a wet recommendation carries display_tier for the picker; a dry one does not', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const D2 = dayOffset(2);
    // D1 has only the wet 14:00; D2 (no reading above 60%) a dry 10:00.
    getHourlyRainOutlook.mockResolvedValue([...HOURLY, ...HOURLY.map((h) => ({ startTime: h.startTime.replace(D1, D2), rainChance: 5 }))]);
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('14:00', { rank: 1, score: 5, insertion: { after_stop_id: 'a' } }), gapSlot('10:00', { date: D2, rank: 2, score: 40, insertion: { after_stop_id: 'b' } })],
      total_feasible: 2,
    });
    const out = await build({ rangeTo: D2 });
    const byDate = Object.fromEntries(out.slots.map((s) => [s.date, s]));
    expect(byDate[D1].display_tier).toBe(2);
    expect(byDate[D2]).not.toHaveProperty('display_tier');
    expect(JSON.stringify(out)).not.toContain('rain_tier');
  });

  test('gate on, a range wholly past the 3 dates: the forecast is not read', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const far = dayOffset(10);
    findAvailableSlots.mockResolvedValue({ slots: [gapSlot('10:00', { date: far })], total_feasible: 1 });
    const out = await build({ rangeFrom: far, rangeTo: far });
    expect(getHourlyRainOutlook).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain('display_tier');
  });

  test('gate on, rain-OK booking (assessment identity): the wet hour stays first', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const out = await build({ serviceKey: '', serviceIdentity: { catalogServiceKey: 'waves_assessment', serviceType: 'Waves Assessment' } });
    expect(bestFit(out)).toBe('14:00');
    expect(out.slots[0].start_time).toBe('14:00');
  });

  test('gate on, forecast unavailable: today\'s order (fail open)', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    getHourlyRainOutlook.mockResolvedValue(null);
    const out = await build();
    expect(bestFit(out)).toBe('14:00');
  });

  test('gate on, forecast throws: today\'s order (fail open)', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    getHourlyRainOutlook.mockRejectedValue(new Error('down'));
    const out = await build();
    expect(bestFit(out)).toBe('14:00');
  });
});

describe('customer-rain-rank helpers', () => {
  afterEach(() => { delete process.env.GATE_CUSTOMER_RAIN_RANK; });

  test('skip (another ranking profile owns the order) reads nothing', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const hourlyRain = jest.fn(async () => HOURLY);
    expect(await customerRainTierOf({ serviceLabels: ['Pest Control'], lat: 1, lng: 2, skip: true, deps: { hourlyRain } })).toBeNull();
    expect(hourlyRain).not.toHaveBeenCalled();
  });

  test('a booking with no service is neutral: no forecast read', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const hourlyRain = jest.fn(async () => HOURLY);
    expect(await customerRainTierOf({ serviceLabels: [], lat: 1, lng: 2, deps: { hourlyRain } })).toBeNull();
    expect(hourlyRain).not.toHaveBeenCalled();
  });

  test('no candidate inside the 3 dates: stamp does not wait for the forecast', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    // A forecast that never answers: stamp must still resolve.
    const rank = startCustomerRainRank({ serviceLabels: ['Pest Control'], lat: 1, lng: 2, today: new Date(), deps: { hourlyRain: () => new Promise(() => {}) } });
    const far = [{ date: dayOffset(10), start_time: '10:00', end_time: '11:00' }];
    expect((await rank.stamp(far))[0].rain_tier).toBe(0);
    expect(await rank.stamp([])).toEqual([]);
  });

  test('stampRainTiers: 0 without a tier function; rainTierDiff orders by tier', () => {
    const rows = stampRainTiers([{ date: D1, start_time: '14:00', end_time: '15:00' }], null);
    expect(rows[0].rain_tier).toBe(0);
    expect(rainTierDiff({ rain_tier: 2 }, { rain_tier: 0 })).toBeGreaterThan(0);
    expect(rainTierDiff({}, {})).toBe(0);
  });
});
