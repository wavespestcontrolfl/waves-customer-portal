const {
  inferFrequencyKeyFromEstimateData,
  intervalPriceFromAnnual,
  intervalPriceFromMonthly,
  normalizeFrequencyKey,
  resolveBillingCadence,
} = require('../services/billing-cadence');

describe('billing cadence helpers', () => {
  test('normalizes customer-facing frequency labels', () => {
    expect(normalizeFrequencyKey('Quarterly')).toBe('quarterly');
    expect(normalizeFrequencyKey('Bi-Monthly')).toBe('bi_monthly');
    expect(normalizeFrequencyKey('bimonthly')).toBe('bi_monthly');
    expect(normalizeFrequencyKey('Every 2 months')).toBe('bi_monthly');
    expect(normalizeFrequencyKey('Monthly')).toBe('monthly');
  });

  test('converts monthly-equivalent rates to cadence charge amounts', () => {
    expect(intervalPriceFromMonthly(35.33, 'quarterly')).toBe(105.99);
    expect(intervalPriceFromMonthly(35.33, 'bi_monthly')).toBe(70.66);
    expect(intervalPriceFromMonthly(35.33, 'monthly')).toBe(35.33);
  });

  test('prefers accepted estimate customer selection for billing display', () => {
    const cadence = resolveBillingCadence({
      monthlyRate: 35.33,
      estimateData: {
        customerSelection: {
          frequency: 'quarterly',
          monthlyTotal: 35.33,
        },
      },
    });

    expect(cadence).toMatchObject({
      frequencyKey: 'quarterly',
      amount: 105.99,
      planLabel: 'Quarterly plan',
      displaySuffix: '/ quarter',
    });
  });

  test('infers pest cadence from stored recurring services when no selection is present', () => {
    const estimateData = {
      result: {
        recurring: {
          services: [
            { name: 'Lawn Care', frequency: 'monthly' },
            { name: 'Pest Control', frequency: 'Bi-Monthly' },
          ],
        },
      },
    };

    expect(inferFrequencyKeyFromEstimateData(estimateData)).toBe('bi_monthly');
    expect(resolveBillingCadence({ monthlyRate: 44.5, estimateData }).amount).toBe(89);
  });

  test('converts exact annuals to cadence charge amounts', () => {
    // Quarterly $392/yr = 4 x $98.00 exactly — never 32.67 * 3 = 98.01.
    expect(intervalPriceFromAnnual(392, 'quarterly')).toBe(98);
    expect(intervalPriceFromAnnual(392, 'bi_monthly')).toBe(65.33);
    expect(intervalPriceFromAnnual(392, 'monthly')).toBe(32.67);
  });

  test('interval charge derives from the exact annual when it corresponds to the monthly', () => {
    const cadence = resolveBillingCadence({
      monthlyRate: 32.67,
      annualRate: 392,
      frequencyKey: 'quarterly',
    });
    // Rounded-monthly path gave 32.67 * 3 = 98.01; the quoted per-visit is 98.00.
    expect(cadence.amount).toBe(98);
    expect(cadence.monthlyRate).toBe(32.67);
  });

  test('monthly cadence is unchanged by a corresponding annual', () => {
    expect(resolveBillingCadence({ monthlyRate: 32.67, annualRate: 392, frequencyKey: 'monthly' }).amount).toBe(32.67);
  });

  test('a non-corresponding annual is ignored — the monthly stays the billing authority', () => {
    // e.g. a stale/foreign annual (real price change never synced): drift > $0.50.
    expect(resolveBillingCadence({ monthlyRate: 32.67, annualRate: 432, frequencyKey: 'quarterly' }).amount).toBe(98.01);
  });

  test('callers that do not pass annualRate keep the legacy monthly derivation', () => {
    expect(resolveBillingCadence({ monthlyRate: 32.67, frequencyKey: 'quarterly' }).amount).toBe(98.01);
  });
});
