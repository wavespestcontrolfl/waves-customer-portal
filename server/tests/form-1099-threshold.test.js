/**
 * Form 1099 reporting threshold by tax year: $600 through 2025, $2,000 from 2026
 * (OBBBA section 70433, IRC 6041(a)).
 */
const { form1099ThresholdCents, form1099ThresholdDollars } = require('../services/form-1099-threshold');

describe('form1099ThresholdCents', () => {
  test('payments made through 2025 use $600', () => {
    expect(form1099ThresholdCents(2024)).toBe(60000);
    expect(form1099ThresholdCents(2025)).toBe(60000);
    expect(form1099ThresholdDollars(2025)).toBe(600);
  });

  test('payments made in 2026 use $2,000', () => {
    expect(form1099ThresholdCents(2026)).toBe(200000);
    expect(form1099ThresholdDollars(2026)).toBe(2000);
  });

  test('later years keep the 2026 amount until a new range is added', () => {
    expect(form1099ThresholdCents(2027)).toBe(200000);
  });

  test('a numeric string year works; a missing year throws instead of guessing', () => {
    expect(form1099ThresholdCents('2025')).toBe(60000);
    expect(() => form1099ThresholdCents(undefined)).toThrow(/tax year/);
    expect(() => form1099ThresholdCents(null)).toThrow(/tax year/);
  });
});
