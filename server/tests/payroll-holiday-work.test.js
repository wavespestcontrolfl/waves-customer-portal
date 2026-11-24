// The paid minutes worked on holidays (payroll-holiday-work.js), with no database. The premium belongs to the shift that
// earned it and is paid in the pay week that pays that shift: for a pay week, the shifts whose work date is in it, each
// clipped to every holiday it overlaps (the holiday may fall in the next week), less the unpaid meal inside the holiday.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { allocate, holidayWorkForWeek, capHolidayDays, dayBounds } = require('../services/payroll-holiday-work');
const { computePaycheck } = require('../services/payroll-calc');
const { parseETDateTime, etDateString } = require('../utils/datetime-et');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

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
const weekDates = (weekStart) => Array.from({ length: 7 }, (_, n) => addStaffWorkDays(weekStart, n));
// One pay week's holiday minutes, as the pay run reads it: a Map of holiday date -> minutes.
const week = (weekStart, input) => new Map(holidayWorkForWeek({ breaks: [], holidays: [HOLIDAY], daily: daily(), ...input, dates: weekDates(weekStart) })
  .map((d) => [d.workDate, d.minutes]));
// Every pay week the shifts fall in, added up (the whole pay history of those shifts).
const allWeeks = (input) => {
  const total = new Map();
  for (const start of new Set(input.shifts.map((s) => staffWeekStartForWorkDate(s.work_date)))) {
    const mine = { ...input, shifts: input.shifts.filter((s) => staffWeekStartForWorkDate(s.work_date) === start) };
    for (const [date, minutes] of week(start, mine)) total.set(date, (total.get(date) || 0) + minutes);
  }
  return total;
};
const PRIOR = '2026-08-31'; // the Monday of the week before Labor Day's week
const HOLIDAY_WEEK = '2026-09-07';

describe('holidayWorkForWeek: the part of a shift inside the holiday', () => {
  test('a 10 PM to 2 AM shift that starts the night before the holiday earns the 2 hours inside it', () => {
    const shift = entry('2026-09-06T22:00', '2026-09-07T02:00');
    expect(shift.work_date).toBe('2026-09-06');
    expect(allWeeks({ shifts: [shift], daily: daily(['2026-09-06', 240]) }).get(HOLIDAY)).toBe(120);
  });

  test('the same shift starting on the holiday earns the same 2 hours, not 4', () => {
    const shift = entry('2026-09-07T22:00', '2026-09-08T02:00');
    expect(shift.work_date).toBe(HOLIDAY);
    expect(allWeeks({ shifts: [shift], daily: daily([HOLIDAY, 240]) }).get(HOLIDAY)).toBe(120);
  });

  test('a shift wholly inside the day counts its stored duration', () => {
    const shift = entry('2026-09-07T08:00', '2026-09-07T18:00');
    expect(allWeeks({ shifts: [shift], daily: daily([HOLIDAY, 600]) }).get(HOLIDAY)).toBe(600);
    expect(allWeeks({ shifts: [{ ...shift, duration_minutes: '590.50' }], daily: daily([HOLIDAY, 590.5]) }).get(HOLIDAY)).toBe(590.5);
  });

  test('shifts of other days, and a day with no shift, earn nothing', () => {
    const before = entry('2026-09-05T08:00', '2026-09-05T18:00');
    const after = entry('2026-09-08T08:00', '2026-09-08T18:00');
    expect(allWeeks({ shifts: [before, after], daily: daily() }).size).toBe(0);
    expect(week(HOLIDAY_WEEK, { shifts: [], daily: daily() }).size).toBe(0);
  });

  test('two shifts on the day add up', () => {
    const a = entry('2026-09-07T06:00', '2026-09-07T10:00');
    const b = entry('2026-09-07T13:00', '2026-09-07T15:30');
    expect(allWeeks({ shifts: [a, b], daily: daily([HOLIDAY, 390]) }).get(HOLIDAY)).toBe(390);
  });
});

describe('holidayWorkForWeek: the premium is paid in the week that pays the shift, once', () => {
  // A Sunday 10 PM to Monday 2 AM shift: all 4 base hours are on the prior week's timesheet.
  const sunday = entry('2026-09-06T22:00', '2026-09-07T02:00');

  test('the prior week carries the 2 Monday holiday hours, dated Monday; the holiday week carries none of them', () => {
    const input = { shifts: [sunday], daily: daily(['2026-09-06', 240]) };
    expect(holidayWorkForWeek({ ...input, breaks: [], holidays: [HOLIDAY], dates: weekDates(PRIOR) })).toEqual([{ workDate: HOLIDAY, minutes: 120 }]);
    // the holiday week reads only shifts whose work date is in it: the Sunday shift is not one of them
    expect(holidayWorkForWeek({ shifts: [], daily: daily(), breaks: [], holidays: [HOLIDAY], dates: weekDates(HOLIDAY_WEEK) })).toEqual([]);
  });

  test('a technician with no other shift in the holiday week is paid it in the prior week', () => {
    expect(week(PRIOR, { shifts: [sunday], daily: daily(['2026-09-06', 240]) }).get(HOLIDAY)).toBe(120);
  });

  test('a holiday in the week after the shift is read (up to a week after the week ends)', () => {
    // Friday 10 PM to Saturday... a Sunday 11 PM shift to Tuesday 1 AM (a corrected long shift) with holidays on Monday and Tuesday.
    const long = entry('2026-09-06T23:00', '2026-09-08T01:00');
    const result = week(PRIOR, { shifts: [long], daily: daily(['2026-09-06', 1560]), holidays: [HOLIDAY, '2026-09-08'] });
    expect(result.get(HOLIDAY)).toBe(1440);
    expect(result.get('2026-09-08')).toBe(60);
  });

  test('a corrected shift from Monday 11 PM to Wednesday 1 AM earns the whole of Tuesday and the hour of Wednesday', () => {
    const corrected = entry('2026-09-07T23:00', '2026-09-09T01:00');
    const result = week(HOLIDAY_WEEK, { shifts: [corrected], daily: daily([HOLIDAY, 1560]), holidays: [HOLIDAY, '2026-09-08', '2026-09-09'] });
    expect(result.get(HOLIDAY)).toBe(60);
    expect(result.get('2026-09-08')).toBe(1440);
    expect(result.get('2026-09-09')).toBe(60);
  });
});

describe('holidayWorkForWeek: the unpaid meal inside the day', () => {
  test('a recorded meal break comes off at its own clock time', () => {
    const shift = entry('2026-09-07T08:00', '2026-09-07T18:00');
    const meal = entry('2026-09-07T12:00', '2026-09-07T12:30');
    expect(allWeeks({ shifts: [shift], breaks: [meal], daily: daily([HOLIDAY, 600, 30]) }).get(HOLIDAY)).toBe(570);
  });

  test('a meal taken on the other side of midnight does not come off the holiday', () => {
    const shift = entry('2026-09-06T20:00', '2026-09-07T04:00');
    const rows = daily(['2026-09-06', 480, 30]);
    const early = entry('2026-09-06T23:00', '2026-09-06T23:30');
    const late = entry('2026-09-06T23:45', '2026-09-07T00:15');
    expect(allWeeks({ shifts: [shift], breaks: [early], daily: rows }).get(HOLIDAY)).toBe(240);
    expect(allWeeks({ shifts: [shift], breaks: [late], daily: rows }).get(HOLIDAY)).toBe(225);
  });

  test('a break of another work date is not in this date\'s deduction: a 1 AM meal does not move the Tuesday shift\'s premium', () => {
    // Tuesday 8 PM to Wednesday 4 AM, a 30 minute meal at 1 AM Wednesday and the 30 minute deduction on Tuesday's summary.
    // The 1 AM break has Wednesday as its work date, so the daily summary counts it in WEDNESDAY's deduction (it has no shift
    // there); Tuesday's 30 minutes are the automatic ones, with no clock time, shared by the half of the shift inside
    // Wednesday: 240 - 15 = 225, and whatever happens to that break later cannot change this figure.
    const shift = entry('2026-09-08T20:00', '2026-09-09T04:00');
    const meal = entry('2026-09-09T01:00', '2026-09-09T01:30');
    expect(meal.work_date).toBe('2026-09-09');
    const input = { shifts: [shift], daily: daily(['2026-09-08', 480, 30]), holidays: ['2026-09-09'] };
    expect(week(HOLIDAY_WEEK, { ...input, breaks: [meal] }).get('2026-09-09')).toBe(225);
    expect(week(HOLIDAY_WEEK, { ...input, breaks: [] }).get('2026-09-09')).toBe(225);
    expect(week(HOLIDAY_WEEK, { ...input, breaks: [{ ...meal, clock_in: at('2026-09-09T02:00'), clock_out: at('2026-09-09T02:45'), duration_minutes: '45.00' }] }).get('2026-09-09')).toBe(225);
  });

  test('a meal taken on the shift\'s own work date is placed by its clock time', () => {
    // Tuesday 8 PM to Wednesday 4 AM with the meal at 11 PM Tuesday (the shift's own work date): it is before Wednesday, so
    // none of the 30 minutes comes off the holiday hours.
    const shift = entry('2026-09-08T20:00', '2026-09-09T04:00');
    const meal = entry('2026-09-08T23:00', '2026-09-08T23:30');
    expect(week(HOLIDAY_WEEK, { shifts: [shift], breaks: [meal], daily: daily(['2026-09-08', 480, 30]), holidays: ['2026-09-09'] }).get('2026-09-09')).toBe(240);
  });

  test('a break is clipped to the shift before the deduction is placed: only the part inside the shift is placed', () => {
    // The shift ends 11:50 PM; its 40 minute meal runs 11:30 PM to 12:10 AM (work date the same). Only 20 minutes of it are
    // inside the shift, so 20 are placed and the other 20 of the 40 deducted are shared by the whole shift: all inside the
    // holiday, so all 40 minutes come off: 350 - 40 = 310 (not 320, which counts the break as 30 placed minutes).
    const shift = entry('2026-09-07T18:00', '2026-09-07T23:50');
    const meal = entry('2026-09-07T23:30', '2026-09-08T00:10');
    expect(meal.work_date).toBe(HOLIDAY);
    expect(week(HOLIDAY_WEEK, { shifts: [shift], breaks: [meal], daily: daily([HOLIDAY, 350, 40]) }).get(HOLIDAY)).toBe(310);
  });

  test('only the deduction without a recorded time is shared by the share of the shift inside the day', () => {
    // 8 PM to 4 AM, 45 minutes deducted, a recorded 30 minute meal at 11 PM (before the holiday): the recorded 30 is placed
    // before midnight, and only the other 15 is shared (half the shift is inside): 240 - 7.5 = 232.5.
    const shift = entry('2026-09-06T20:00', '2026-09-07T04:00');
    const meal = entry('2026-09-06T23:00', '2026-09-06T23:30');
    expect(week(PRIOR, { shifts: [shift], breaks: [meal], daily: daily(['2026-09-06', 480, 45]) }).get(HOLIDAY)).toBe(232.5);
  });

  test('an automatic deduction has no clock time: the share of the shift inside the day bears the same share of it', () => {
    const shift = entry('2026-09-07T20:00', '2026-09-08T04:00');
    expect(allWeeks({ shifts: [shift], daily: daily([HOLIDAY, 480, 30]) }).get(HOLIDAY)).toBe(225);
    const whole = entry('2026-09-07T08:00', '2026-09-07T17:00');
    expect(allWeeks({ shifts: [whole], daily: daily([HOLIDAY, 540, 30]) }).get(HOLIDAY)).toBe(510);
  });

  test('no deduction in the summary (the gate is off) means a recorded break is not taken off', () => {
    const shift = entry('2026-09-07T08:00', '2026-09-07T18:00');
    const meal = entry('2026-09-07T12:00', '2026-09-07T12:45');
    expect(allWeeks({ shifts: [shift], breaks: [meal], daily: daily([HOLIDAY, 600, 0]) }).get(HOLIDAY)).toBe(600);
  });

  test('a short rest break is not a meal even when the summary deducts the automatic 30 minutes', () => {
    const shift = entry('2026-09-07T08:00', '2026-09-07T17:00');
    const rest = entry('2026-09-07T10:00', '2026-09-07T10:15');
    expect(allWeeks({ shifts: [shift], breaks: [rest], daily: daily([HOLIDAY, 540, 30]) }).get(HOLIDAY)).toBe(510);
  });
});

describe('the unpaid meal is shared to the exact hundredth', () => {
  test('an 11:30 PM to 7:30 AM shift across two holidays pays all 450 minutes, so $24.02 an hour pays $90.08, not $90.07', () => {
    // 480 minutes, a 30 minute automatic meal; 30 minutes fall in the first holiday and 450 in the second. Each share alone is
    // 1.875 and 28.125 minutes, which rounds to 1.88 + 28.13 = 30.01 (one hundredth too much). Largest remainder: 1.88 + 28.12.
    const shift = entry('2026-09-07T23:30', '2026-09-08T07:30');
    const result = week(HOLIDAY_WEEK, { shifts: [shift], daily: daily([HOLIDAY, 480, 30]), holidays: [HOLIDAY, '2026-09-08'] });
    expect(result.get(HOLIDAY)).toBe(28.12);
    expect(result.get('2026-09-08')).toBe(421.88);
    const minutes = Math.round([...result.values()].reduce((sum, m) => sum + m * 100, 0)) / 100;
    expect(minutes).toBe(450);
    const pay = computePaycheck({
      payDate: '2026-09-18', hourlyRate: '24.02', holidayMinutes: 0, ptoMinutes: 0, holidayWorkMinutes: String(minutes),
      w4: { formYear: 2026, filingStatus: 'single', step2Checkbox: false },
    });
    expect(pay.holidayWorkPremiumCents).toBe(9008);
  });

  test('the shares of the holidays and of the rest of the shift add up to exactly the deduction, for any split', () => {
    // 10 PM to 6 AM across one holiday (2 hours inside) with a 45 minute meal: the holiday and the rest share 4500 hundredths
    const shift = entry('2026-09-06T22:00', '2026-09-07T06:00');
    const result = week(PRIOR, { shifts: [shift], daily: daily(['2026-09-06', 480, 45]) });
    // 360 minutes inside, 120 outside: the meal is 3/4 inside = 33.75
    expect(result.get(HOLIDAY)).toBe(360 - 33.75);
  });

  test('allocate: whole hundredths that add up to the total, the leftover to the largest remainder, ties to the earliest', () => {
    expect(allocate(3000, [3000, 45000, 0])).toEqual([188, 2812, 0]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(allocate(7, [1, 2, 4])).toEqual([1, 2, 4]);
    expect(allocate(5, [0, 0])).toEqual([5, 0]);
    expect(allocate(0, [3, 4])).toEqual([0, 0]);
    for (let total = 1; total < 60; total += 7) {
      for (const weights of [[3, 5, 11], [1, 0, 6], [999, 1], [2, 2, 2, 2]]) {
        expect(allocate(total, weights).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
});

describe('holidayWorkForWeek: daylight saving time', () => {
  test('on the fall-back Sunday (25 hours) the day starts at midnight EDT, not an hour either side', () => {
    const shift = entry('2026-10-31T22:00', '2026-11-01T03:00');
    expect(shift.clock_in.toISOString()).toBe('2026-11-01T02:00:00.000Z');
    expect(shift.clock_out.toISOString()).toBe('2026-11-01T08:00:00.000Z');
    const result = week('2026-10-26', { shifts: [shift], daily: daily(['2026-10-31', 360]), holidays: ['2026-11-01'] });
    expect(result.get('2026-11-01')).toBe(240);
    expect(dayBounds('2026-11-01').end - dayBounds('2026-11-01').start).toBe(25 * 3600000);
  });

  test('on the spring-forward Sunday (23 hours) the same shift is cut at the real midnight', () => {
    const shift = entry('2027-03-13T22:00', '2027-03-14T03:00');
    const result = week('2027-03-08', { shifts: [shift], daily: daily(['2027-03-13', 240]), holidays: ['2027-03-14'] });
    expect(result.get('2027-03-14')).toBe(120);
    expect(dayBounds('2027-03-14').end - dayBounds('2027-03-14').start).toBe(23 * 3600000);
  });
});

describe('holidayWorkForWeek: when the time entries cannot give clock times, per work date', () => {
  test('a shift with no clock-out reads that date\'s summary as a whole (shift less meal)', () => {
    const open = entry('2026-09-07T08:00', null);
    expect(week(HOLIDAY_WEEK, { shifts: [open], daily: daily([HOLIDAY, 540, 30]) }).get(HOLIDAY)).toBe(510);
  });

  test('no shift entries but a summary with shift minutes reads the summary; a summary with none earns nothing', () => {
    expect(week(HOLIDAY_WEEK, { shifts: [], daily: daily([HOLIDAY, 240, 0]) }).get(HOLIDAY)).toBe(240);
    expect(week(HOLIDAY_WEEK, { shifts: [], daily: daily([HOLIDAY, 0, 0]) }).size).toBe(0);
  });

  test('the fallback is per date: a holiday summary with no shifts still pays when another date has a completed shift', () => {
    // Wednesday's summary holds 4 hours with no Wednesday shift entries; Tuesday has a completed daytime shift. Wednesday is
    // the holiday: its 4 hours are read from the summary, and Tuesday's shift (no overlap) adds nothing.
    const tuesday = entry('2026-09-08T08:00', '2026-09-08T16:00');
    const result = week(HOLIDAY_WEEK, { shifts: [tuesday], daily: daily(['2026-09-08', 480], ['2026-09-09', 240]), holidays: ['2026-09-09'] });
    expect(result.get('2026-09-09')).toBe(240);
  });

  test('a measured overnight overlap is added to a fallback date of the same holiday', () => {
    // Tuesday 10 PM to Wednesday 2 AM measured (2 h on Wednesday) + Wednesday's own 4 hours read from the summary.
    const overnight = entry('2026-09-08T22:00', '2026-09-09T02:00');
    const result = week(HOLIDAY_WEEK, { shifts: [overnight], daily: daily(['2026-09-08', 240], ['2026-09-09', 240]), holidays: ['2026-09-09'] });
    expect(result.get('2026-09-09')).toBe(120 + 240);
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
