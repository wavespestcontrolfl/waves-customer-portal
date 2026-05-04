const {
  parseETDateTime, etDateString,
  addETMonthsByWeekday, etNthWeekdayOfMonth,
} = require('../utils/datetime-et');

describe('ET calendar-month recurrence helpers', () => {
  test('quarterly cadence preserves ordinal weekday instead of fixed day gaps', () => {
    const base = parseETDateTime('2026-05-04T12:00');

    expect(etDateString(addETMonthsByWeekday(base, 3))).toBe('2026-08-03');
    expect(etDateString(addETMonthsByWeekday(base, 6))).toBe('2026-11-02');
    expect(etDateString(addETMonthsByWeekday(base, 9))).toBe('2027-02-01');
  });

  test('monthly and bimonthly cadences preserve ordinal weekday', () => {
    const base = parseETDateTime('2026-05-04T12:00');

    expect(etDateString(addETMonthsByWeekday(base, 1))).toBe('2026-06-01');
    expect(etDateString(addETMonthsByWeekday(base, 2))).toBe('2026-07-06');
    expect(etDateString(addETMonthsByWeekday(base, 4))).toBe('2026-09-07');
  });

  test('fifth weekday falls back to the last matching weekday', () => {
    const base = parseETDateTime('2026-01-31T12:00');

    expect(etDateString(addETMonthsByWeekday(base, 1))).toBe('2026-02-28');
    expect(etDateString(addETMonthsByWeekday(base, 2))).toBe('2026-03-28');
    expect(etDateString(etNthWeekdayOfMonth(2026, 2, 5, 1))).toBe('2026-02-23');
  });

  test('explicit fifth weekday anchor does not drift after fallback months', () => {
    const fallbackMonth = parseETDateTime('2026-04-24T12:00');

    expect(etDateString(addETMonthsByWeekday(fallbackMonth, 1, { nth: 5, weekday: 5 }))).toBe('2026-05-29');
  });
});
