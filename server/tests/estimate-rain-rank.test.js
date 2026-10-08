/**
 * Estimate slots rank by rain fit (owner 2026-10-08, GATE_CUSTOMER_RAIN_RANK,
 * dark). The estimate page's list keeps its promises at every gate setting:
 *  - the first card is still the soonest opening, wet or not;
 *  - a scarce first day's cards stay pinned (the "N openings today" badge);
 *  - behind them, an outdoor estimate's wet hours move after its dry ones,
 *    in a stable order, before the display slice.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { selectCustomerFacingSlots } = require('../services/estimate-slot-availability')._internals;
const { slotRainTierOf, demoteByRainTier, _test: rankTest } = require('../services/scheduling/customer-rain-rank');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const D1 = dayOffset(1);
const D2 = dayOffset(2);
const slot = (date, windowStart, extra = {}) => ({
  date, windowStart, windowEnd: `${String(Number(windowStart.slice(0, 2)) + 1).padStart(2, '0')}:00`, slotId: `${date}-${windowStart}`, ...extra,
});
const label = (s) => `${s.date === D1 ? 'D1' : 'D2'} ${s.windowStart}`;
// Wet = any D1 afternoon start.
const wetTier = (s) => (s.date === D1 && s.windowStart >= '13:00' ? 2 : 0);

describe('selectCustomerFacingSlots with a rain tier', () => {
  const pool = [slot(D1, '13:00'), slot(D1, '14:00'), slot(D1, '15:00'), slot(D2, '09:00'), slot(D2, '10:00'), slot(D2, '11:00')];

  test('no tier function: today\'s order', () => {
    const base = selectCustomerFacingSlots(pool, 6).map(label);
    expect(selectCustomerFacingSlots(pool, 6, { rainTierOf: null }).map(label)).toEqual(base);
    expect(base[0]).toBe('D1 13:00');
  });

  test('the soonest opening stays first even when it is wet; other wet hours move behind the dry ones', () => {
    const out = selectCustomerFacingSlots(pool, 6, { rainTierOf: wetTier }).map(label);
    expect(out[0]).toBe('D1 13:00');
    const rest = out.slice(1);
    const firstWet = rest.findIndex((l) => l.startsWith('D1'));
    const lastDry = rest.map((l) => l.startsWith('D2')).lastIndexOf(true);
    expect(firstWet).toBeGreaterThan(lastDry);
    expect(out).toHaveLength(6);
  });

  test('the display slice keeps dry hours ahead of wet ones', () => {
    const out = selectCustomerFacingSlots(pool, 4, { rainTierOf: wetTier }).map(label);
    expect(out).toEqual(['D1 13:00', expect.stringMatching(/^D2/), expect.stringMatching(/^D2/), expect.stringMatching(/^D2/)]);
  });

  test('a scarce first day stays pinned, wet or not', () => {
    const scarce = [slot(D1, '13:00'), slot(D1, '14:00'), slot(D2, '09:00'), slot(D2, '10:00')];
    const out = selectCustomerFacingSlots(scarce, 4, { rainTierOf: wetTier }).map(label);
    expect(out.slice(0, 2)).toEqual(['D1 13:00', 'D1 14:00']);
  });
});

describe('demoteByRainTier', () => {
  test('stable, and the pinned head never moves', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    const tier = (x) => ({ a: 2, b: 2, c: 0, d: 2, e: 0 }[x]);
    expect(demoteByRainTier(list, tier, 1)).toEqual(['a', 'c', 'e', 'b', 'd']);
    expect(demoteByRainTier(list, tier, 2)).toEqual(['a', 'b', 'c', 'e', 'd']);
    expect(demoteByRainTier(list, null, 1)).toBe(list);
  });
});

describe('slotRainTierOf', () => {
  const IN_AREA = { point: { lat: 27.4, lng: -82.4 } };
  const HOURLY = Array.from({ length: 13 }, (_, i) => {
    const h = 7 + i;
    return { startTime: `${D1}T${String(h).padStart(2, '0')}:00:00-04:00`, rainChance: h >= 13 ? 85 : 10 };
  });
  beforeEach(() => { rankTest._forecastStarts.length = 0; });
  afterEach(() => { delete process.env.GATE_CUSTOMER_RAIN_RANK; });

  test('gate off: null, nothing read', async () => {
    const hourlyRain = jest.fn(async () => HOURLY);
    expect(await slotRainTierOf([slot(D1, '14:00')], { services: ['Pest Control'], ...IN_AREA, deps: { hourlyRain } })).toBeNull();
    expect(hourlyRain).not.toHaveBeenCalled();
  });

  test('gate on, an outdoor estimate: the wet window is tier 2, the dry one 0', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const tierOf = await slotRainTierOf([slot(D1, '14:00'), slot(D1, '08:00')], { services: [{ label: 'Pest Control', service: 'pest_control' }], ...IN_AREA, deps: { hourlyRain: async () => HOURLY } });
    expect(tierOf(slot(D1, '14:00'))).toBe(2);
    expect(tierOf(slot(D1, '08:00'))).toBe(0);
  });

  test('a row\'s verified catalog key decides, whatever its label says', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const profiles = require('../services/service-completion-profiles');
    const spy = jest.spyOn(profiles, 'resolveCompletionProfileForScheduledService')
      .mockImplementation(async ({ service_key_snapshot: key }) => ({ serviceKey: key || null, findingsType: null }));
    const opts = { ...IN_AREA, deps: { hourlyRain: async () => HOURLY } };
    // An inspection sold under a label that reads like spray work: rain-OK, so the wet window is tier 0.
    const inspection = await slotRainTierOf([slot(D1, '14:00')], { services: [{ label: 'Exterior Spray Package', catalogServiceKey: 'wdo_inspection' }], ...opts });
    expect(inspection(slot(D1, '14:00'))).toBe(0);
    expect(spy).toHaveBeenCalledWith({ service_type: 'Exterior Spray Package', service_key_snapshot: 'wdo_inspection' }, undefined);
    // Spray work sold under a label that reads like an inspection: outdoor, tier 2.
    const spray = await slotRainTierOf([slot(D1, '14:00')], { services: [{ label: 'Home Inspection Visit', catalogServiceKey: 'pest_general_quarterly' }], ...opts });
    expect(spray(slot(D1, '14:00'))).toBe(2);
    spy.mockRestore();
  });

  test('gate on, no slot inside the 3 dates: null, nothing read', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const hourlyRain = jest.fn(async () => HOURLY);
    expect(await slotRainTierOf([slot(dayOffset(9), '09:00')], { services: ['Pest Control'], ...IN_AREA, deps: { hourlyRain } })).toBeNull();
    expect(hourlyRain).not.toHaveBeenCalled();
  });

  test('gate on, no coordinates: null (no forecast point)', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    const hourlyRain = jest.fn(async () => HOURLY);
    expect(await slotRainTierOf([slot(D1, '14:00')], { services: ['Pest Control'], deps: { hourlyRain } })).toBeNull();
    expect(hourlyRain).not.toHaveBeenCalled();
  });
});
