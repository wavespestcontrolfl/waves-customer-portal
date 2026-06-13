const { sumPrecipInches, rainWindowEndingOn } = require('../services/service-report/application-conditions');

describe('sumPrecipInches', () => {
  test('sums all numeric days', () => {
    expect(sumPrecipInches([0.1, 0.2, 0, 0.5, 0, 0.3, 0.1])).toBe(1.2);
  });

  test('a real zero-rain window stays 0 (not unknown)', () => {
    expect(sumPrecipInches([0, 0, 0])).toBe(0);
  });

  test('skips missing days rather than reading them as zero', () => {
    expect(sumPrecipInches([null, 0.2, null, 0.3])).toBeCloseTo(0.5, 5);
  });

  test('all-missing / empty → null (caller degrades to rain_unknown)', () => {
    expect(sumPrecipInches([null, '', undefined])).toBeNull();
    expect(sumPrecipInches([])).toBeNull();
    expect(sumPrecipInches(null)).toBeNull();
  });
});

describe('rainWindowEndingOn', () => {
  test('7-day window ending on the service date (inclusive)', () => {
    expect(rainWindowEndingOn('2026-06-12', 7)).toEqual({ start: '2026-06-06', end: '2026-06-12' });
  });

  test('accepts a Date object', () => {
    expect(rainWindowEndingOn(new Date('2026-06-12T00:00:00Z'), 7)).toEqual({ start: '2026-06-06', end: '2026-06-12' });
  });

  test('malformed date → null', () => {
    expect(rainWindowEndingOn('not-a-date')).toBeNull();
    expect(rainWindowEndingOn(null)).toBeNull();
  });
});
