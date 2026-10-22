/**
 * The 14 holidays the office can close (services/scheduling/holidays.js,
 * owner 2026-10-22). The yearly rules must reproduce the days Google Business
 * Profile lists for Florida ("About holidays on Google", US section, read
 * 2026-10-22): every row with no state list or with FL in it.
 */

const {
  HOLIDAYS,
  HOLIDAY_KEYS,
  holidaysBetween,
  holidayKeysOn,
  upcomingHolidays,
  parseHolidayClosures,
} = require('../services/scheduling/holidays');

const pairs = (days) => days.map((day) => `${day.date} ${day.key}${day.observed ? ' (observed)' : ''}`);

describe('holiday rules', () => {
  test('there are exactly the 14 Google Florida holidays, in calendar order', () => {
    expect(HOLIDAYS.map((h) => h.key)).toEqual([
      'new_years_day', 'mlk_day', 'presidents_day', 'good_friday', 'easter', 'memorial_day',
      'independence_day', 'labor_day', 'veterans_day', 'thanksgiving', 'black_friday',
      'christmas_eve', 'christmas', 'new_years_eve',
    ]);
    expect(HOLIDAY_KEYS.size).toBe(14);
  });

  test("2026 matches Google's published Florida list exactly", () => {
    expect(pairs(holidaysBetween('2026-01-01', '2026-12-31'))).toEqual([
      '2026-01-01 new_years_day',
      '2026-01-19 mlk_day',
      '2026-02-16 presidents_day',
      '2026-04-03 good_friday',
      '2026-04-05 easter',
      '2026-05-25 memorial_day',
      '2026-07-03 independence_day (observed)', // Google: "4th of July (observed)"
      '2026-07-04 independence_day',
      '2026-09-07 labor_day',
      '2026-11-11 veterans_day',
      '2026-11-26 thanksgiving',
      '2026-11-27 black_friday',
      '2026-12-24 christmas_eve',
      '2026-12-25 christmas',
      '2026-12-31 new_years_eve',
    ]);
  });

  test("the end of 2025 matches Google's list too", () => {
    expect(pairs(holidaysBetween('2025-12-24', '2025-12-31'))).toEqual([
      '2025-12-24 christmas_eve',
      '2025-12-25 christmas',
      '2025-12-31 new_years_eve',
    ]);
  });

  test('2027: the moving holidays and the weekend observed days', () => {
    const days = pairs(holidaysBetween('2027-01-01', '2027-12-31'));
    expect(days).toEqual(expect.arrayContaining([
      '2027-01-18 mlk_day',
      '2027-02-15 presidents_day',
      '2027-03-26 good_friday',
      '2027-03-28 easter',
      '2027-05-31 memorial_day',
      '2027-07-04 independence_day',
      '2027-07-05 independence_day (observed)', // July 4 is a Sunday
      '2027-09-06 labor_day',
      '2027-11-25 thanksgiving',
      '2027-11-26 black_friday',
      '2027-12-24 christmas (observed)', // Christmas is a Saturday
      '2027-12-24 christmas_eve',
      '2027-12-31 new_years_day (observed)', // Jan 1 2028 is a Saturday
    ]));
    expect(days).toHaveLength(17);
  });

  test('a Sunday Veterans Day is observed on the Monday', () => {
    expect(pairs(holidaysBetween('2029-11-10', '2029-11-13'))).toEqual([
      '2029-11-11 veterans_day',
      '2029-11-12 veterans_day (observed)',
    ]);
  });

  test('keys limit the holidays; a bad range returns nothing', () => {
    expect(pairs(holidaysBetween('2026-11-01', '2026-12-31', ['thanksgiving']))).toEqual(['2026-11-26 thanksgiving']);
    expect(holidaysBetween('2026-12-31', '2026-01-01')).toEqual([]);
    expect(holidaysBetween('2026-1-1', '2026-12-31')).toEqual([]);
    expect(holidaysBetween(null, '2026-12-31')).toEqual([]);
  });

  test('holidayKeysOn names the holidays that close one date', () => {
    expect(holidayKeysOn('2026-11-26')).toEqual(['thanksgiving']);
    expect(holidayKeysOn('2027-12-24')).toEqual(['christmas', 'christmas_eve']);
    expect(holidayKeysOn('2027-12-31')).toEqual(['new_years_day', 'new_years_eve']);
    expect(holidayKeysOn('2026-11-25')).toEqual([]);
    expect(holidayKeysOn(new Date('2026-11-26T12:00:00Z'))).toEqual([]); // strings only
  });
});

describe('upcomingHolidays (the settings list)', () => {
  test('lists all 14 by their next date, from today', () => {
    const list = upcomingHolidays('2026-10-22');
    expect(list).toHaveLength(14);
    expect(list[0]).toEqual({ key: 'veterans_day', name: 'Veterans Day', date: '2026-11-11', observedDate: null });
    expect(list.find((h) => h.key === 'independence_day'))
      .toEqual({ key: 'independence_day', name: '4th of July', date: '2027-07-04', observedDate: '2027-07-05' });
    expect(list.find((h) => h.key === 'new_years_eve').date).toBe('2026-12-31');
    expect(list.at(-1)).toMatchObject({ key: 'labor_day', date: '2027-09-06' });
    expect(list.map((h) => h.date)).toEqual([...list.map((h) => h.date)].sort());
  });

  test('a holiday is still listed on its own day', () => {
    expect(upcomingHolidays('2026-11-26').find((h) => h.key === 'thanksgiving').date).toBe('2026-11-26');
    expect(upcomingHolidays('2026-11-27').find((h) => h.key === 'thanksgiving').date).toBe('2027-11-25');
  });

  test('a Saturday New Year’s Day shows its observed Friday in the old year', () => {
    expect(upcomingHolidays('2027-12-31').find((h) => h.key === 'new_years_day'))
      .toEqual({ key: 'new_years_day', name: "New Year's Day", date: '2028-01-01', observedDate: '2027-12-31' });
  });

  test('a bad date returns nothing', () => {
    expect(upcomingHolidays('Oct 22')).toEqual([]);
  });
});

describe('parseHolidayClosures', () => {
  test('keeps known keys only and fails open on a bad value', () => {
    expect([...parseHolidayClosures('["thanksgiving","black_friday"]')]).toEqual(['thanksgiving', 'black_friday']);
    expect([...parseHolidayClosures(['christmas', 'juneteenth', 6, null])]).toEqual(['christmas']);
    expect(parseHolidayClosures('[0,6]').size).toBe(0);
    expect(parseHolidayClosures('{"thanksgiving":true}').size).toBe(0);
    expect(parseHolidayClosures('not json').size).toBe(0);
    expect(parseHolidayClosures(null).size).toBe(0);
    expect(parseHolidayClosures('').size).toBe(0);
  });
});
