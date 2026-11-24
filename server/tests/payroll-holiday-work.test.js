// The paid minutes worked ON a holiday (payroll-holiday-work.js), with no database: the part of each shift that falls inside
// the holiday's Eastern calendar day, less the unpaid meal inside it, whichever day the shift started on.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { holidayWorkMinutes, capHolidayDays, dayBounds } = require('../services/payroll-holiday-work');
const { parseETDateTime, etDateString } = require('../utils/datetime-et');

const HOLIDAY = '2026-09-07'; // Labor Day, a Monday
const at = (wall) => parseETDateTime(wall);
const entry = (from, to, extra = {}) => {
  const clockIn = at(from);
  const clockOut = to ? at(to) : null;
  return {
    clock_in: clockIn, clock_out: clockOut,
    duration_minutes: clockOut ? ((clockOut - clockIn) / 60000).toFixed(2) : null,
    work_date: etDateString(clockIn), ...extra,
  };
};
const daily = (...rows) => new Map(rows.map(([date, shift, meal = 0]) => [date, { total_shift_minutes: shift, unpaid_meal_minutes: meal }]));

describe('holidayWorkMinutes: the part of a shift inside the holiday', () => {
  test('a 10 PM to 2 AM shift that starts the night before the holiday earns the 2 hours inside it', () => {
    const shift = entry('2026-09-06T22:00', '2026-09-07T02:00');
    expect(shift.work_date).toBe('2026-09-06');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], daily: daily(['2026-09-06', 240]) })).toBe(120);
  });

  test('the same shift starting on the holiday earns the same 2 hours, not 4', () => {
    const shift = entry('2026-09-07T22:00', '2026-09-08T02:00');
    expect(shift.work_date).toBe(HOLIDAY);
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], daily: daily([HOLIDAY, 240]) })).toBe(120);
  });

  test('a shift wholly inside the day counts its stored duration', () => {
    const shift = entry('2026-09-07T08:00', '2026-09-07T18:00');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], daily: daily([HOLIDAY, 600]) })).toBe(600);
    // the stored figure is what the pay run pays: a 9.5 minute difference from the clock is kept
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [{ ...shift, duration_minutes: '590.50' }], daily: daily([HOLIDAY, 590.5]) })).toBe(590.5);
  });

  test('shifts of other days, and a day with no shift, earn nothing', () => {
    const before = entry('2026-09-05T08:00', '2026-09-05T18:00');
    const after = entry('2026-09-08T08:00', '2026-09-08T18:00');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [before, after], daily: daily() })).toBe(0);
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [], daily: daily() })).toBe(0);
  });

  test('two shifts on the day add up', () => {
    const a = entry('2026-09-07T06:00', '2026-09-07T10:00');
    const b = entry('2026-09-07T13:00', '2026-09-07T15:30');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [a, b], daily: daily([HOLIDAY, 390]) })).toBe(390);
  });
});

describe('holidayWorkMinutes: the unpaid meal inside the day', () => {
  test('a recorded meal break comes off at its own clock time', () => {
    const shift = entry('2026-09-07T08:00', '2026-09-07T18:00');
    const meal = entry('2026-09-07T12:00', '2026-09-07T12:30');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], breaks: [meal], daily: daily([HOLIDAY, 600, 30]) })).toBe(570);
  });

  test('a meal taken on the other side of midnight does not come off the holiday', () => {
    // 8 PM to 4 AM, work date the day before; meal at 11 PM (before the holiday) or 11:45 PM to 12:15 AM (15 minutes inside it).
    const shift = entry('2026-09-06T20:00', '2026-09-07T04:00');
    const rows = daily(['2026-09-06', 480, 30]);
    const early = entry('2026-09-06T23:00', '2026-09-06T23:30');
    const late = entry('2026-09-06T23:45', '2026-09-07T00:15');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], breaks: [early], daily: rows })).toBe(240);
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], breaks: [late], daily: rows })).toBe(225);
  });

  test('an automatic deduction has no clock time: the share of the shift inside the day bears the same share of it', () => {
    // 8 PM to 4 AM, 30 minutes deducted by the day's summary: half the shift is inside, so 15 minutes come off.
    const shift = entry('2026-09-07T20:00', '2026-09-08T04:00');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], daily: daily([HOLIDAY, 480, 30]) })).toBe(225);
    const whole = entry('2026-09-07T08:00', '2026-09-07T17:00');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [whole], daily: daily([HOLIDAY, 540, 30]) })).toBe(510);
  });

  test('no deduction in the summary (the gate is off) means a recorded break is not taken off', () => {
    const shift = entry('2026-09-07T08:00', '2026-09-07T18:00');
    const meal = entry('2026-09-07T12:00', '2026-09-07T12:45');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], breaks: [meal], daily: daily([HOLIDAY, 600, 0]) })).toBe(600);
  });

  test('a short rest break is not a meal even when the summary deducts the automatic 30 minutes', () => {
    const shift = entry('2026-09-07T08:00', '2026-09-07T17:00');
    const rest = entry('2026-09-07T10:00', '2026-09-07T10:15');
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [shift], breaks: [rest], daily: daily([HOLIDAY, 540, 30]) })).toBe(510);
  });
});

describe('holidayWorkMinutes: daylight saving time', () => {
  test('on the fall-back Sunday (25 hours) the day starts at midnight EDT, not an hour either side', () => {
    // 10 PM Saturday EDT to 3 AM Sunday EST = 6 hours on the clock; midnight EDT (04:00Z) to 3 AM EST (08:00Z) = 4 hours inside.
    const shift = entry('2026-10-31T22:00', '2026-11-01T03:00');
    expect(shift.clock_in.toISOString()).toBe('2026-11-01T02:00:00.000Z');
    expect(shift.clock_out.toISOString()).toBe('2026-11-01T08:00:00.000Z');
    expect(holidayWorkMinutes({ day: '2026-11-01', shifts: [shift], daily: daily(['2026-10-31', 360]) })).toBe(240);
    expect(dayBounds('2026-11-01').end - dayBounds('2026-11-01').start).toBe(25 * 3600000);
  });

  test('on the spring-forward Sunday (23 hours) the same shift is cut at the real midnight', () => {
    // 10 PM Saturday EST to 3 AM Sunday EDT = 4 hours elapsed; midnight EST (05:00Z) to 07:00Z = 2 hours inside.
    const shift = entry('2027-03-13T22:00', '2027-03-14T03:00');
    expect(holidayWorkMinutes({ day: '2027-03-14', shifts: [shift], daily: daily(['2027-03-13', 240]) })).toBe(120);
    expect(dayBounds('2027-03-14').end - dayBounds('2027-03-14').start).toBe(23 * 3600000);
  });
});

describe('holidayWorkMinutes: when the time entries cannot give clock times', () => {
  test('a shift with no clock-out reads the day summary as a whole (shift less meal)', () => {
    const open = entry('2026-09-07T08:00', null);
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [open], daily: daily([HOLIDAY, 540, 30]) })).toBe(510);
  });

  test('no shift entries but a summary with shift minutes reads the summary; a summary with none earns nothing', () => {
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [], daily: daily([HOLIDAY, 240, 0]) })).toBe(240);
    expect(holidayWorkMinutes({ day: HOLIDAY, shifts: [], daily: daily([HOLIDAY, 0, 0]) })).toBe(0);
  });
});

describe('capHolidayDays', () => {
  const days = [{ workDate: '2026-09-07', minutes: 240 }, { workDate: '2026-09-08', minutes: 120 }];
  test('keeps every day while the week pays that many worked minutes', () => {
    expect(capHolidayDays(days, 2400)).toEqual({ minutes: 360, days });
  });
  test('cuts the last days first when the week pays fewer minutes, and the days still add up to the total', () => {
    expect(capHolidayDays(days, 300)).toEqual({ minutes: 300, days: [{ workDate: '2026-09-07', minutes: 240 }, { workDate: '2026-09-08', minutes: 60 }] });
    expect(capHolidayDays(days, 100)).toEqual({ minutes: 100, days: [{ workDate: '2026-09-07', minutes: 100 }] });
    expect(capHolidayDays(days, 0)).toEqual({ minutes: 0, days: [] });
    expect(capHolidayDays(undefined, 600)).toEqual({ minutes: 0, days: [] });
  });
});
