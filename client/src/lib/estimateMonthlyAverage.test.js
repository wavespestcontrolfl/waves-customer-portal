import { describe, expect, it } from 'vitest';
import { pageMonthlyAverage } from './estimateMonthlyAverage';

// Real-shaped sections: net per-application price + application count + the
// selected cadence's monthly, exactly what a ServiceSection card reads.
const pest = (overrides = {}) => ({
  key: 'pest_control', label: 'Pest Control', isRecurring: true, defaultFrequencyKey: 'quarterly',
  frequencies: [{
    key: 'quarterly', monthly: 30, annual: 360, perVisit: 100, perTreatment: 90, visitsPerYear: 4,
    perServiceTreatments: [{ service: 'pest_control', displayPrice: 90, visitsPerYear: 4, monthly: 30 }],
  }],
  ...overrides,
});
const lawn = (overrides = {}) => ({
  key: 'lawn_care', label: 'Lawn Care', isRecurring: true, defaultFrequencyKey: 'standard',
  frequencies: [{
    key: 'standard', monthly: 42.3, annual: 507.6, visitsPerYear: 9, perTreatment: 56.4, billedPerApplication: true, billingFrequencyKey: 'monthly',
    perServiceTreatments: [{ service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 9, monthly: 42.3 }],
  }],
  ...overrides,
});
const cents = (n) => Math.round(n * 100);

describe('pageMonthlyAverage', () => {
  it('is off unless the page says the gate is on', () => {
    expect(pageMonthlyAverage({ enabled: false, services: [pest()], selected: {}, planFrequency: { monthly: 30 } })).toBeNull();
  });

  it('single service: the average is the stored monthly, no plan line', () => {
    const single = pest({
      frequencies: [{
        key: 'quarterly', monthly: 31.33, annual: 376, perVisit: 94, perTreatment: 94, visitsPerYear: 4,
        perServiceTreatments: [{ service: 'pest_control', displayPrice: 94, visitsPerYear: 4, monthly: 31.33 }],
      }],
    });
    const result = pageMonthlyAverage({ enabled: true, services: [single], selected: {}, planFrequency: single.frequencies[0] });
    expect(result.model.multi).toBe(false);
    expect(result.byKey).toEqual({ pest_control: 31.33 });
  });

  it('multi service: per-service lines sum to the plan line, which is the stored monthly_total', () => {
    const storedMonthlyTotal = 72.3;
    const result = pageMonthlyAverage({
      enabled: true,
      services: [pest(), lawn()],
      selected: {},
      planFrequency: { key: 'quarterly', monthly: storedMonthlyTotal, annual: 867.6 },
      bundleDiscountPct: 0.1,
    });
    expect(result.byKey).toEqual({ pest_control: 30, lawn_care: 42.3 });
    expect(cents(result.byKey.pest_control) + cents(result.byKey.lawn_care)).toBe(cents(result.model.planMonthly));
    expect(result.model.planMonthly).toBe(storedMonthlyTotal);
    expect(result.model.bundlePct).toBe(10);
  });

  it('rounding remainder: three services that do not divide evenly still add up to the plan to the cent', () => {
    const svc = (key, perTreatment, visitsPerYear) => ({
      key, label: key, isRecurring: true,
      frequencies: [{ key: 'k', monthly: 1, visitsPerYear, perTreatment, billedPerApplication: true, perServiceTreatments: [{ displayPrice: perTreatment, visitsPerYear }] }],
    });
    const result = pageMonthlyAverage({
      enabled: true,
      services: [svc('lawn_care', 47.33, 9), svc('pest_control', 33.17, 4), svc('tree_shrub', 58.37, 9)],
      selected: {},
      planFrequency: { monthly: 90.33 },
    });
    const total = Object.values(result.byKey).reduce((sum, v) => sum + cents(v), 0);
    expect(total).toBe(9033);
    expect(result.model.planMonthly).toBe(90.33);
    expect(result.byKey).toEqual({ lawn_care: 35.5, pest_control: 11.06, tree_shrub: 43.77 });
  });

  it('a plan credit the cards do not carry prints as its own line and the sum still reconciles', () => {
    const result = pageMonthlyAverage({
      enabled: true,
      services: [pest(), lawn()],
      selected: {},
      planFrequency: { monthly: 62.3 },
      credit: { label: 'Referral Credit', monthly: 10 },
    });
    expect(result.model.credit).toEqual({ label: 'Referral Credit', monthly: 10 });
    expect(cents(result.byKey.pest_control) + cents(result.byKey.lawn_care) - cents(result.model.credit.monthly)).toBe(6230);
  });

  it('follows the SELECTED cadence', () => {
    const ladder = pest({
      frequencies: [
        { key: 'quarterly', monthly: 31.33, perTreatment: 94, visitsPerYear: 4, perServiceTreatments: [{ displayPrice: 94, visitsPerYear: 4, monthly: 31.33 }] },
        { key: 'bi_monthly', monthly: 47, perTreatment: 94, visitsPerYear: 6, perServiceTreatments: [{ displayPrice: 94, visitsPerYear: 6, monthly: 47 }] },
      ],
    });
    const result = pageMonthlyAverage({ enabled: true, services: [ladder], selected: { pest_control: 'bi_monthly' }, planFrequency: ladder.frequencies[1] });
    expect(result.byKey.pest_control).toBe(47);
  });

  it('shows nothing when the figures cannot describe one plan', () => {
    // plan monthly does not match the cards
    expect(pageMonthlyAverage({ enabled: true, services: [pest(), lawn()], selected: {}, planFrequency: { monthly: 99 } })).toBeNull();
    // an unsplit bundle card carries no per-service price
    expect(pageMonthlyAverage({ enabled: true, services: [{ key: 'bundle', isRecurring: true, frequencies: [{ key: 'q', monthly: 72.3 }] }], selected: {}, planFrequency: { monthly: 72.3 } })).toBeNull();
    // quote-required plan
    expect(pageMonthlyAverage({ enabled: true, services: [pest()], selected: {}, planFrequency: { monthly: 30, quoteRequired: true } })).toBeNull();
    // ranged (low-confidence) price
    expect(pageMonthlyAverage({ enabled: true, services: [pest()], selected: {}, planFrequency: { monthly: 30, lowConfidenceRangePct: 0.2 } })).toBeNull();
    // a row that still bills a flat monthly ("Billed $X/mo") is not paid after each application
    const legacy = lawn({ frequencies: [{ ...lawn().frequencies[0], billedPerApplication: false }] });
    expect(pageMonthlyAverage({ enabled: true, services: [legacy], selected: {}, planFrequency: { monthly: 42.3 } })).toBeNull();
    // one-time only: no recurring sections
    expect(pageMonthlyAverage({ enabled: true, services: [{ key: 'wdo', isRecurring: false }], selected: {}, planFrequency: { monthly: 0 } })).toBeNull();
  });
});
