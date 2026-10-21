import { describe, expect, it } from 'vitest';
import { oneTimeBesidePlan, pageAverageEligible, pageMonthlyAverage, planCreditSource, resolvePageMonthlyAverage, sectionAverageLine, singleServiceAverageContext } from './estimateMonthlyAverage';

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

describe('page decision helpers', () => {
  const monthlyAmountOf = (d) => Math.round((Number(d.recurringAmount ?? d.amount) / 12) * 100) / 100;
  const base = () => ({
    data: { monthlyAverageEnabled: true },
    serviceMode: 'recurring',
    estimate: {},
    billsMonthly: false,
    isCommercialEstimate: false,
    cta: { terminalState: null },
    paymentPreference: null,
    services: [pest(), lawn()],
    selected: {},
    selectedCombo: null,
    combinedFrequency: { monthly: 72.3 },
    pricing: { combinedRecurring: { waveGuardDiscountPct: 0.1 } },
    renderFlags: {},
  });

  it('resolves the whole decision in one call', () => {
    const result = resolvePageMonthlyAverage(base(), monthlyAmountOf);
    expect(result.model.planMonthly).toBe(72.3);
    expect(result.byKey).toEqual({ pest_control: 30, lawn_care: 42.3 });
  });

  it('eligibility: gate switch, mode, billing, terminal state, quote, prepay', () => {
    expect(pageAverageEligible(base())).toBe(true);
    for (const change of [
      { data: {} }, { serviceMode: 'one_time' }, { estimate: { isOneTimeOnly: true } }, { billsMonthly: true },
      { isCommercialEstimate: true }, { cta: { terminalState: 'accepted' } }, { cta: { quoteRequired: true } },
      { paymentPreference: 'prepay_annual' },
    ]) {
      expect(pageAverageEligible({ ...base(), ...change })).toBe(false);
      expect(resolvePageMonthlyAverage({ ...base(), ...change }, monthlyAmountOf)).toBeNull();
    }
  });

  it('credit: the selected combo\'s own state wins; the base frequency only when no combo is selected', () => {
    const credit = { label: 'Referral Credit', amount: 120, recurringAmount: 120 };
    expect(planCreditSource({ ...base(), selectedCombo: { manualDiscount: credit } })).toBe(credit);
    expect(planCreditSource({ ...base(), selectedCombo: { manualDiscount: credit, manualDiscountSuppressed: true } })).toBeNull();
    expect(planCreditSource({ ...base(), selectedCombo: {}, combinedFrequency: { manualDiscount: credit } })).toBeNull();
    expect(planCreditSource({ ...base(), combinedFrequency: { manualDiscount: credit } })).toBe(credit);
    expect(planCreditSource({ ...base(), combinedFrequency: { manualDiscount: credit, manualDiscountSuppressed: true } })).toBeNull();
    expect(planCreditSource({ ...base(), renderFlags: { manualDiscountItemizedInSections: true }, combinedFrequency: { manualDiscount: credit } })).toBeNull();
    const result = resolvePageMonthlyAverage({ ...base(), combinedFrequency: { monthly: 62.3 }, selectedCombo: { manualDiscount: credit } }, monthlyAmountOf);
    expect(result.model.credit).toEqual({ label: 'Referral Credit', monthly: 10 });
  });

  it('one-time notice and card text helpers', () => {
    const flea = { kind: 'charge', amount: 150 };
    expect(oneTimeBesidePlan({ feeList: [{ amount: 99 }], estimate: {}, pricing: {} })).toBe(true);
    expect(oneTimeBesidePlan({ feeList: [], estimate: {}, pricing: { oneTimeBreakdown: { items: [flea] } } })).toBe(true);
    expect(oneTimeBesidePlan({ feeList: [], estimate: { showOneTimeOption: true }, pricing: { oneTimeBreakdown: { items: [flea] } } })).toBe(false);
    expect(oneTimeBesidePlan({ feeList: [], estimate: {}, pricing: {} })).toBe(false);
    const average = resolvePageMonthlyAverage(base(), monthlyAmountOf);
    expect(sectionAverageLine(average, 'pest_control')).toBe('$30.00 a month');
    expect(sectionAverageLine(null, 'pest_control')).toBeNull();
    expect(singleServiceAverageContext(average, true)).toBeNull(); // multi: the summary carries it
    const single = resolvePageMonthlyAverage({ ...base(), services: [pest()], combinedFrequency: null }, monthlyAmountOf);
    expect(singleServiceAverageContext(single, false)).toBe('Averaged over the year. You pay after each application.');
    expect(singleServiceAverageContext(single, true)).toBe('Averaged over the year. You pay after each application. One-time charges are not in the average.');
  });
});
