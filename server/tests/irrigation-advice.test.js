const {
  recommendedInchesPerWeek,
  recommendedFromEt0,
  buildIrrigationAdvice,
} = require('../services/service-report/irrigation-advice');

describe('recommendedFromEt0 (ET₀ × turf Kc)', () => {
  test('calibrates to the approved seasonal targets in a typical summer week', () => {
    expect(recommendedFromEt0(1.6, 'St. Augustine')).toBe(1.25); // 1.6 × 0.8
    expect(recommendedFromEt0(1.6, 'bahia')).toBe(0.75);         // 1.6 × 0.45
  });
  test('null/zero/invalid ET₀ → null (caller falls back to seasonal lookup)', () => {
    expect(recommendedFromEt0(null, 'St. Augustine')).toBeNull();
    expect(recommendedFromEt0(0, 'St. Augustine')).toBeNull();
    expect(recommendedFromEt0('x', 'St. Augustine')).toBeNull();
  });
});

describe('buildIrrigationAdvice target basis', () => {
  test('uses the ET₀ target when reference ET₀ is supplied', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: 1, rainfallInches7d: 0.3, referenceEt0InchesWeek: 1.6 });
    expect(a.targetBasis).toBe('evapotranspiration');
    expect(a.recommendedInchesPerWeek).toBe(1.25);
  });
  test('falls back to the seasonal lookup when ET₀ is absent', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: 1, rainfallInches7d: 0.3 });
    expect(a.targetBasis).toBe('seasonal');
    expect(a.recommendedInchesPerWeek).toBe(1.25);
  });
});

describe('recommendedInchesPerWeek (grass × season, v1 lookup)', () => {
  test('St. Augustine steps down from peak to cool season', () => {
    expect(recommendedInchesPerWeek('St. Augustine', 6)).toBe(1.25); // peak
    expect(recommendedInchesPerWeek('St. Augustine', 4)).toBe(1);    // shoulder
    expect(recommendedInchesPerWeek('St. Augustine', 12)).toBe(0.75); // cool
  });

  test('drought-tolerant grasses recommend less; unknown defaults to St. Augustine', () => {
    expect(recommendedInchesPerWeek('bahia', 6)).toBe(0.75);
    expect(recommendedInchesPerWeek('zoysia', 6)).toBe(1);
    expect(recommendedInchesPerWeek(null, 6)).toBe(1.25);   // St. Augustine default
    expect(recommendedFromEt0(1.6, null)).toBe(1.25);        // 1.6 × 0.8 (St. Aug Kc)
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

  test('irrigation system turned off → missing profile despite stale inches', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: 1.5, rainfallInches7d: 0.2, irrigationEnabled: false });
    expect(a.profileMissing).toBe(true);
    expect(a.status).toBe('unknown');
  });

  test('unknown rainfall + below-target irrigation → rain_unknown, not a false deficit', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: 0.75, rainfallInches7d: null });
    expect(a.status).toBe('rain_unknown');
    expect(a.differentialInchesPerWeek).toBeNull();
    expect(a.profileMissing).toBe(false);
  });

  test('unknown rainfall but irrigation alone exceeds target → still surplus', () => {
    const a = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 6, irrigationInchesPerWeek: 2, rainfallInches7d: null });
    expect(a.status).toBe('surplus');
    expect(a.differentialInchesPerWeek).toBe(0.75); // 2 - 1.25, a valid lower bound
  });
});
