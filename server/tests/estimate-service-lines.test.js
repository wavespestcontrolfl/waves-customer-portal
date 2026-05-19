const {
  inferEstimateServiceInterest,
  inferEstimateServiceLines,
  serviceKeysFromText,
} = require('../services/estimate-service-lines');

describe('estimate service line inference', () => {
  test('classifies explicit service-interest text without defaulting blanks to pest', () => {
    expect(serviceKeysFromText('General Pest Control')).toEqual(['pest']);
    expect(serviceKeysFromText('General Pest Control + Lawn Care')).toEqual(['lawn', 'pest']);
    expect(serviceKeysFromText('')).toEqual([]);
  });

  test('extracts actual recurring services and prorates bundle discounts', () => {
    const lines = inferEstimateServiceLines({
      estimateData: {
        result: {
          recurring: {
            grandTotal: 119.1,
            services: [
              { service: 'lawn_care', name: 'Lawn Care', mo: 84 },
              { service: 'pest_control', name: 'Pest Control', mo: 48.33 },
            ],
          },
        },
      },
      monthlyTotal: 119.1,
    });

    expect(lines).toEqual([
      { key: 'lawn', amount: 75.6, amountBasis: 'monthly' },
      { key: 'pest', amount: 43.5, amountBasis: 'monthly' },
    ]);
    expect(inferEstimateServiceInterest({ estimateData: { result: { recurring: { services: [{ service: 'pest_control', mo: 30 }] } } } }))
      .toBe('Pest Control');
  });

  test('surfaces unknown service data instead of assigning pest', () => {
    expect(inferEstimateServiceLines({ monthlyTotal: 99 })).toEqual([
      { key: 'unknown', amount: null, amountBasis: 'unknown' },
    ]);
    expect(inferEstimateServiceInterest({ monthlyTotal: 99 })).toBeNull();
  });
});
