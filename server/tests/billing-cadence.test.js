const {
  inferFrequencyKeyFromEstimateData,
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
});
