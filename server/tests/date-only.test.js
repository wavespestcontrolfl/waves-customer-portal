const { formatDateOnly, formatDisplayDate } = require('../utils/date-only');

describe('date-only formatting', () => {
  it('preserves UTC-midnight date-only values as their calendar date', () => {
    expect(formatDateOnly(new Date('2026-05-18T00:00:00.000Z'))).toBe('May 18, 2026');
    expect(formatDateOnly('2026-05-18T00:00:00.000Z')).toBe('May 18, 2026');
    expect(formatDateOnly('2026-05-18')).toBe('May 18, 2026');
  });

  it('formats timestamp values as Eastern Time dates', () => {
    expect(formatDisplayDate('2026-05-18T02:00:00.000Z')).toBe('May 17, 2026');
    expect(formatDisplayDate('2026-05-18T04:30:00.000Z')).toBe('May 18, 2026');
  });
});

describe('addMonthsSameDay', () => {
  const { addMonthsSameDay } = require('../utils/date-only');

  test('clamps to the target month\'s last day', () => {
    expect(addMonthsSameDay('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsSameDay('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonthsSameDay('2028-02-29', 12)).toBe('2029-02-28');
  });

  test('walks across year boundaries in both directions and accepts Date inputs', () => {
    expect(addMonthsSameDay('2026-05-14', 12)).toBe('2027-05-14');
    expect(addMonthsSameDay('2026-11-10', 3)).toBe('2027-02-10');
    expect(addMonthsSameDay('2026-01-10', -2)).toBe('2025-11-10');
    expect(addMonthsSameDay(new Date('2026-09-24T00:00:00Z'), 12)).toBe('2027-09-24');
  });

  test('returns null for unparseable input', () => {
    expect(addMonthsSameDay(null, 12)).toBeNull();
    expect(addMonthsSameDay('not a date', 12)).toBeNull();
  });
});
