const {
  arrivalWindowRange,
  formatSmsTime,
  formatSmsTimeRange,
  formatSmsTemplateVars,
} = require('../utils/sms-time-format');

describe('sms time formatting', () => {
  test('formats 24-hour times for customer-facing SMS', () => {
    expect(formatSmsTime('00:00')).toBe('12:00 AM');
    expect(formatSmsTime('08:30')).toBe('8:30 AM');
    expect(formatSmsTime('13:00')).toBe('1:00 PM');
    expect(formatSmsTime('23:59')).toBe('11:59 PM');
  });

  test('formats time ranges with 12-hour labels', () => {
    expect(formatSmsTimeRange('13:00-14:00')).toBe('1:00 PM - 2:00 PM');
    expect(formatSmsTimeRange('09:00–12:00')).toBe('9:00 AM - 12:00 PM');
  });

  test('arrivalWindowRange is always start + 2 hours, never the stored window_end', () => {
    expect(arrivalWindowRange('09:00')).toBe('09:00-11:00');
    expect(arrivalWindowRange('09:00:00')).toBe('09:00-11:00');
    expect(arrivalWindowRange('13:30')).toBe('13:30-15:30');
    expect(arrivalWindowRange('23:00')).toBe('23:00-01:00');
    expect(formatSmsTimeRange(arrivalWindowRange('09:00'))).toBe('9:00 AM - 11:00 AM');
  });

  test('arrivalWindowRange returns null on missing or malformed starts', () => {
    expect(arrivalWindowRange(null)).toBeNull();
    expect(arrivalWindowRange('')).toBeNull();
    expect(arrivalWindowRange('soon')).toBeNull();
  });

  test('normalizes template vars without touching non-time text', () => {
    expect(formatSmsTemplateVars({
      first_name: 'David',
      date: '2026-05-08',
      time: '13:00-14:00',
      note: 'Gate code 1300',
    })).toEqual({
      first_name: 'David',
      date: '2026-05-08',
      time: '1:00 PM - 2:00 PM',
      note: 'Gate code 1300',
    });
  });
});
