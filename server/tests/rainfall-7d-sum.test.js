const { sumPrecipInches, et0SumToInches, rainWindowEndingOn } = require('../services/service-report/application-conditions');

describe('et0SumToInches (unit safety)', () => {
  test('inch unit (our request) passes through', () => {
    expect(et0SumToInches(1.57, 'inch')).toBe(1.57);
    expect(et0SumToInches(1.57, 'in')).toBe(1.57);
  });
  test('mm unit converts so a ~40mm week is not read as 40 inches', () => {
    expect(et0SumToInches(40, 'mm')).toBe(1.57); // 40 / 25.4
  });
  test('missing unit defaults to inches (matches the request)', () => {
    expect(et0SumToInches(1.5, null)).toBe(1.5);
    expect(et0SumToInches(1.5, undefined)).toBe(1.5);
  });
  test('null/invalid sum → null', () => {
    expect(et0SumToInches(null, 'inch')).toBeNull();
    expect(et0SumToInches('x', 'mm')).toBeNull();
  });
});

describe('sumPrecipInches', () => {
  test('sums all numeric days', () => {
    expect(sumPrecipInches([0.1, 0.2, 0, 0.5, 0, 0.3, 0.1])).toBe(1.2);
  });

  test('a real zero-rain window stays 0 (not unknown)', () => {
    expect(sumPrecipInches([0, 0, 0])).toBe(0);
  });

  test('a PARTIAL window (any missing/non-numeric day) → null, not an undercount', () => {
    expect(sumPrecipInches([null, 0.2, null, 0.3])).toBeNull();
    expect(sumPrecipInches([0.2, '', 0.3])).toBeNull();
    expect(sumPrecipInches([0.2, 'x', 0.3])).toBeNull();
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
