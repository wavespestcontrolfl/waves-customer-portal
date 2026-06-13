const {
  recommendedInchesPerWeek,
  buildIrrigationAdvice,
} = require('../services/service-report/irrigation-advice');

describe('recommendedInchesPerWeek (grass × season, v1 lookup)', () => {
  test('St. Augustine steps down from peak to cool season', () => {
    expect(recommendedInchesPerWeek('St. Augustine', 6)).toBe(1.25); // peak
    expect(recommendedInchesPerWeek('St. Augustine', 4)).toBe(1);    // shoulder
    expect(recommendedInchesPerWeek('St. Augustine', 12)).toBe(0.75); // cool
  });

  test('drought-tolerant grasses recommend less; unknown falls back to default', () => {
    expect(recommendedInchesPerWeek('bahia', 6)).toBe(0.75);
    expect(recommendedInchesPerWeek('zoysia', 6)).toBe(1);
    expect(recommendedInchesPerWeek(null, 6)).toBe(1);
  });
});

describe('buildIrrigationAdvice (water-balance differential)', () => {
  test('no schedule on file → unknown + profileMissing', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: null, rainfallInches7d: 0.5 });
    expect(a.profileMissing).toBe(true);
    expect(a.status).toBe('unknown');
    expect(a.differentialInchesPerWeek).toBeNull();
    expect(a.recommendedInchesPerWeek).toBe(1.25); // still recommend a target to prompt with
  });

  test('over-watering reads as surplus (cross-checks fungus/mushroom signal)', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: 2, rainfallInches7d: 0.5 });
    expect(a.appliedInchesPerWeek).toBe(2.5);
    expect(a.differentialInchesPerWeek).toBe(1.25);
    expect(a.status).toBe('surplus');
  });

  test('under-watering reads as deficit', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: 0.5, rainfallInches7d: 0 });
    expect(a.status).toBe('deficit');
    expect(a.differentialInchesPerWeek).toBe(-0.75);
  });

  test('within a quarter-inch of target → balanced', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: 1, rainfallInches7d: 0.25 });
    expect(a.status).toBe('balanced');
    expect(a.differentialInchesPerWeek).toBe(0);
  });
});
