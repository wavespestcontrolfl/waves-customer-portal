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
