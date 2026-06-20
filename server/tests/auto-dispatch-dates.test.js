const { toDateStr, shiftDateStr } = require('../services/auto-dispatch/dates');

describe('toDateStr', () => {
  test('passes through a YYYY-MM-DD string', () => {
    expect(toDateStr('2026-08-04')).toBe('2026-08-04');
    expect(toDateStr('2026-08-04T00:00:00.000Z')).toBe('2026-08-04');
  });
  test('normalizes a pg Date object (the real-DB case that broke eligibility)', () => {
    expect(toDateStr(new Date('2026-08-04T00:00:00Z'))).toBe('2026-08-04');
  });
  test('null/invalid → null', () => {
    expect(toDateStr(null)).toBeNull();
    expect(toDateStr(new Date('not-a-date'))).toBeNull();
  });
});

describe('shiftDateStr', () => {
  test('shifts whole days and handles month rollover', () => {
    expect(shiftDateStr('2026-08-04', -7)).toBe('2026-07-28');
    expect(shiftDateStr('2026-08-28', 7)).toBe('2026-09-04');
    expect(shiftDateStr('2026-08-04', 0)).toBe('2026-08-04');
  });
});
