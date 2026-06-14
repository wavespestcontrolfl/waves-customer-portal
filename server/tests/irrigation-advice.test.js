const {
  recommendedInchesPerWeek,
  recommendedFromEt0,
  buildIrrigationAdvice,
  _private,
} = require('../services/service-report/irrigation-advice');

const ALL_GRASSES = ['st_augustine', 'bermuda', 'zoysia', 'seashore_paspalum', 'bahia', 'centipede'];

describe('seasonal Kc factor (ET₀ path)', () => {
  test('classifies SWFL months into peak / shoulder / cool', () => {
    expect([6, 7, 8, 9].map(_private.classifySeason)).toEqual(['peak', 'peak', 'peak', 'peak']);
    expect([4, 5, 10, 11].map(_private.classifySeason)).toEqual(['shoulder', 'shoulder', 'shoulder', 'shoulder']);
    expect([12, 1, 2, 3].map(_private.classifySeason)).toEqual(['cool', 'cool', 'cool', 'cool']);
    expect(_private.classifySeason(null)).toBe('peak'); // unknown → no reduction
  });

  test('factor curve is 1.0 peak / 0.9 shoulder / 0.75 cool', () => {
    expect(_private.seasonalKcFactor(7)).toBe(1.0);
    expect(_private.seasonalKcFactor(5)).toBe(0.9);
    expect(_private.seasonalKcFactor(1)).toBe(0.75);
  });

  test('no month → peak (unreduced) Kc, preserving prior behavior', () => {
    expect(recommendedFromEt0(1.6, 'st_augustine')).toBe(1.25);       // 1.6 × 0.8 × 1.0
    expect(recommendedFromEt0(1.6, 'st_augustine', 7)).toBe(1.25);    // explicit peak, same
  });

  test('steps the target down through the seasons for the same ET₀', () => {
    // St. Augustine at a constant ET₀ of 2.5": 2.5 × 0.8 × {1.0, 0.9, 0.75}
    // = {2.0, 1.8→1.75, 1.5}, rounded to the nearest 0.25".
    expect(recommendedFromEt0(2.5, 'st_augustine', 7)).toBe(2.0);   // peak
    expect(recommendedFromEt0(2.5, 'st_augustine', 5)).toBe(1.75);  // shoulder
    expect(recommendedFromEt0(2.5, 'st_augustine', 1)).toBe(1.5);   // cool
  });

  test('applies to EVERY grass type (cool target < peak target)', () => {
    for (const grass of ALL_GRASSES) {
      const peak = recommendedFromEt0(2.5, grass, 7);
      const cool = recommendedFromEt0(2.5, grass, 1);
      expect(cool).toBeLessThan(peak);
    }
  });
});

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
  test('seasonal Kc lowers the winter ET₀ target vs summer for the same ET₀', () => {
    const summer = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 7, irrigationInchesPerWeek: 1, rainfallInches7d: 0.3, referenceEt0InchesWeek: 2.0 });
    const winter = buildIrrigationAdvice({ grassType: 'St. Augustine', month: 1, irrigationInchesPerWeek: 1, rainfallInches7d: 0.3, referenceEt0InchesWeek: 2.0 });
    expect(summer.targetBasis).toBe('evapotranspiration');
    expect(winter.targetBasis).toBe('evapotranspiration');
    expect(winter.recommendedInchesPerWeek).toBeLessThan(summer.recommendedInchesPerWeek);
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
