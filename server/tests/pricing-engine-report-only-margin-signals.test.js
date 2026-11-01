/**
 * Report-only post-discount margin signals for rodent bait, mosquito and
 * termite bait (owner approval 2026-11-01, audit item D5). Pest, tree & shrub
 * and lawn already carried them. The signal is a "looks low" flag
 * (finalMargin / belowMarginFloor) plus a waveguard_discount_below_margin_floor
 * entry in marginWarnings; it never moves a price, a discount or a billed
 * amount. The floor is GLOBAL.MARGIN_FLOOR (0.35), the same one pest uses.
 *
 * Costs are steered with GLOBAL.LABOR_RATE: all three prices come from fixed
 * brackets, not from cost, so the rate moves margin and nothing else.
 */
const { generateEstimate, constants } = require('../services/pricing-engine');

const ORIGINAL_LABOR_RATE = constants.GLOBAL.LABOR_RATE;
afterEach(() => {
  constants.GLOBAL.LABOR_RATE = ORIGINAL_LABOR_RATE;
});

const HOME = { homeSqFt: 2000, lotSqFt: 8000, propertyType: 'single_family' };
const SERVICES = {
  rodent_bait: { rodentBait: true },
  mosquito: { mosquito: true },
  termite_bait: { termite: { system: 'trelona', monitoringTier: 'basic' } },
};
// Pest + the service under test = Silver (10% WaveGuard).
const silver = (service, extra = {}) => generateEstimate({
  ...HOME,
  services: { pest: { frequency: 'quarterly' }, ...SERVICES[service] },
  ...extra,
});
const alone = (service) => generateEstimate({ ...HOME, services: { ...SERVICES[service] } });
const line = (estimate, service) => estimate.lineItems.find((i) => i.service === service);
const waveGuardWarning = (estimate, service) => estimate.marginWarnings.find((w) => (
  w.service === service && w.type === 'waveguard_discount_below_margin_floor'
));

// Cost steering per service: [rate that lands below the floor, rate that is healthy].
const RATES = {
  rodent_bait: { low: ORIGINAL_LABOR_RATE, healthy: 5 }, // list margin already ~30% after Silver
  mosquito: { low: 120, healthy: ORIGINAL_LABOR_RATE },
  termite_bait: { low: ORIGINAL_LABOR_RATE, healthy: 5 }, // monitoring cost already above list
};

describe.each(Object.keys(SERVICES))('%s report-only post-discount margin signal', (service) => {
  test('a discounted line below the floor gets the flag and a warning; its price is unchanged', () => {
    constants.GLOBAL.LABOR_RATE = RATES[service].low;
    const estimate = silver(service);
    const item = line(estimate, service);

    expect(item.discount.effectiveDiscount).toBeCloseTo(0.1, 5);
    expect(item.belowMarginFloor).toBe(true);
    expect(item.finalMargin).toBeLessThan(0.35);
    const cost = item.costs.annualCost ?? item.costs.annualTotal;
    expect(item.finalMargin)
      .toBeCloseTo((item.annualAfterDiscount - cost) / item.annualAfterDiscount, 3);

    const warning = waveGuardWarning(estimate, service);
    expect(warning).toEqual(expect.objectContaining({
      margin: item.finalMargin,
      marginFloor: 0.35,
      finalAnnual: item.annualAfterDiscount,
    }));
    expect(warning.message).toContain('price stands as discounted');

    // Report-only: the price is exactly list less the tier percent; no cap,
    // lift or alternate final fields appear.
    expect(item.annualAfterDiscount)
      .toBeCloseTo(item.annualBeforeDiscount * (1 - item.discount.effectiveDiscount), 2);
    expect(item.monthlyAfterDiscount)
      .toBeCloseTo(item.annualAfterDiscount / 12, 2);
    expect(item.discountCapped).toBeUndefined();
    expect(item.marginGuardApplied).toBeUndefined();
    expect(item.finalAnnual).toBeUndefined();
  });

  test('flagging never changes the billed price (same price at a healthy cost)', () => {
    constants.GLOBAL.LABOR_RATE = RATES[service].low;
    const flagged = line(silver(service), service);
    constants.GLOBAL.LABOR_RATE = RATES[service].healthy;
    const healthy = line(silver(service), service);

    expect(flagged.belowMarginFloor).toBe(true);
    expect(healthy.belowMarginFloor).toBe(false);
    expect(flagged.annualBeforeDiscount).toBe(healthy.annualBeforeDiscount);
    expect(flagged.annualAfterDiscount).toBe(healthy.annualAfterDiscount);
    expect(flagged.monthlyAfterDiscount).toBe(healthy.monthlyAfterDiscount);
  });

  test('an undiscounted line gets no warning entry', () => {
    const estimate = alone(service);
    const item = line(estimate, service);

    expect(item.discount.effectiveDiscount).toBe(0);
    expect(item.annualAfterDiscount).toBe(item.annualBeforeDiscount);
    expect(typeof item.finalMargin).toBe('number');
    expect(waveGuardWarning(estimate, service)).toBeUndefined();
  });

  test('a healthy discounted line gets no flag and no warning', () => {
    constants.GLOBAL.LABOR_RATE = RATES[service].healthy;
    const estimate = silver(service);
    const item = line(estimate, service);

    expect(item.discount.effectiveDiscount).toBeCloseTo(0.1, 5);
    expect(item.belowMarginFloor).toBe(false);
    expect(item.finalMargin).toBeGreaterThanOrEqual(0.35);
    expect(waveGuardWarning(estimate, service)).toBeUndefined();
  });
});

// Rodent bait and termite bait are not manual-discount eligible
// (MANUAL_RECURRING_DISCOUNT_SERVICES), so only mosquito reaches the shared
// manual audit, which reads the same cost basis and floor.
describe('mosquito manual-discount audit', () => {
  test('a manual discount below the floor warns and leaves the price alone', () => {
    const estimate = silver('mosquito', {
      manualDiscount: { type: 'PERCENT', value: 60, source: 'test', eligibilityConfirmed: true },
    });
    const item = line(estimate, 'mosquito');

    expect(item.manualFinalAnnual).toBeLessThan(item.annualAfterDiscount);
    expect(item.manualMarginWarning).toBe(true);
    expect(item.manualFinalMargin).toBeLessThan(0.35);
    const warning = estimate.marginWarnings.find((w) => (
      w.service === 'mosquito' && w.type === 'manual_discount_below_margin_floor'
    ));
    expect(warning).toEqual(expect.objectContaining({ marginFloor: 0.35 }));
    expect(item.annualAfterDiscount)
      .toBeCloseTo(item.annualBeforeDiscount * (1 - item.discount.effectiveDiscount), 2);
  });

  test('a manual discount that stays above the floor raises no warning', () => {
    const estimate = silver('mosquito', {
      manualDiscount: { type: 'PERCENT', value: 5, source: 'test', eligibilityConfirmed: true },
    });
    expect(line(estimate, 'mosquito').manualMarginWarning).toBeUndefined();
    expect(estimate.marginWarnings.find((w) => w.type === 'manual_discount_below_margin_floor')).toBeUndefined();
  });
});

describe('legacy pinned rodent replay', () => {
  test('a line with no cost basis gets no margin signal', () => {
    const estimate = generateEstimate({
      ...HOME,
      services: { pest: { frequency: 'quarterly' }, rodentBait: true },
      rodentBaitLegacyReplay: { monthly: 30 },
    });
    const rodent = line(estimate, 'rodent_bait');
    expect(rodent.legacyPinnedReplay).toBe(true);
    expect(rodent.finalMargin).toBeUndefined();
    expect(rodent.belowMarginFloor).toBeUndefined();
    expect(waveGuardWarning(estimate, 'rodent_bait')).toBeUndefined();
  });
});
