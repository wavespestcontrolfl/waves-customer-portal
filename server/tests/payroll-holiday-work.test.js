// The paid minutes worked on holidays (payroll-holiday-work.js), with no database. The premium belongs to the shift that
// earned it and is paid in the pay week that pays that shift: for a pay week, the shifts whose work date is in it, each
// clipped to every holiday it overlaps (the holiday may fall in the next week), less the unpaid meal inside the holiday.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { allocate, splitWorkDate, holidayWorkDetailForWeek, holidayWorkForWeek, capHolidayDays, dayBounds } = require('../services/payroll-holiday-work');
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

  test('a stored duration of null counts as 0, as time tracking counts it: no fallback to the clock', () => {
    const shift = { ...entry('2026-09-07T08:00', '2026-09-07T18:00'), duration_minutes: null };
    expect(week(HOLIDAY_WEEK, { shifts: [shift], daily: daily([HOLIDAY, 0]) }).size).toBe(0);
    const split = splitWorkDate({ shifts: [shift], held: [HOLIDAY], meal: 0 });
    expect(split.parts).toEqual([]);
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

  test('a recorded meal of the next work date in the same pay week counts for the shift it lies in: Tuesday to Wednesday, 1 AM meal', () => {
    // Tuesday 8 PM to Wednesday 4 AM, a 30 minute meal at 1 AM Wednesday (work date Wednesday, the same pay week) and the 30
    // minute deduction on Tuesday's summary. The meal overlaps the shift and is in the same week, so it is placed by its clock
    // time, inside Wednesday: 240 - 30 = 210. (Earlier a break was read only on the shift's own work date: 225.)
    const shift = entry('2026-09-08T20:00', '2026-09-09T04:00');
    const meal = entry('2026-09-09T01:00', '2026-09-09T01:30');
    expect(meal.work_date).toBe('2026-09-09');
    const input = { shifts: [shift], daily: daily(['2026-09-08', 480, 30]), holidays: ['2026-09-09'] };
    expect(week(HOLIDAY_WEEK, { ...input, breaks: [meal] }).get('2026-09-09')).toBe(210);
    // without the meal on file the 30 minutes are shared: half the shift is inside Wednesday
    expect(week(HOLIDAY_WEEK, { ...input, breaks: [] }).get('2026-09-09')).toBe(225);
  });

  test('a shift from 8 PM on the holiday to 4 AM: a 1 AM meal is outside the holiday, so all 240 minutes inside are paid', () => {
    const shift = entry('2026-09-07T20:00', '2026-09-08T04:00');
    const meal = entry('2026-09-08T01:00', '2026-09-08T01:30');
    expect(meal.work_date).toBe('2026-09-08');
    expect(week(HOLIDAY_WEEK, { shifts: [shift], breaks: [meal], daily: daily([HOLIDAY, 480, 30]) }).get(HOLIDAY)).toBe(240);
  });

  test('a Sunday to Monday shift: a 1 AM Monday meal (next pay week) still counts, and is listed for the frozen check', () => {
    // Sunday 8 PM to Monday 4 AM (holiday Monday), a 1 AM Monday meal of 30 minutes and the 30 minute deduction on Sunday: the
    // meal overlaps the shift whatever week its own date is in, so it is placed inside Monday: 240 - 30 = 210 (not 225).
    const shift = entry('2026-09-06T20:00', '2026-09-07T04:00');
    const meal = { ...entry('2026-09-07T01:00', '2026-09-07T01:30'), id: 'break-1' };
    expect(meal.work_date).toBe(HOLIDAY);
    const input = { dates: weekDates(PRIOR), shifts: [shift], daily: daily(['2026-09-06', 480, 30]), holidays: [HOLIDAY] };
    const detail = holidayWorkDetailForWeek({ ...input, breaks: [meal] });
    expect(detail.days).toEqual([{ workDate: HOLIDAY, minutes: 210 }]);
    // what the frozen check shows it used: the break id, its clipped interval and minutes, and the work date it was read for
    expect(detail.meals).toEqual([{ workDate: '2026-09-06', id: 'break-1', from: '2026-09-07T05:00:00.000Z', to: '2026-09-07T05:30:00.000Z', minutes: 30 }]);
    // with no meal on file the 30 minutes are shared by the minutes left: 225
    expect(holidayWorkDetailForWeek({ ...input, breaks: [] })).toEqual({ days: [{ workDate: HOLIDAY, minutes: 225 }], meals: [] });
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

  test('only the deduction left after the recorded meal is shared, by each part\'s minutes left', () => {
    // 8 PM to 4 AM (240 inside the holiday, 240 outside), 45 minutes deducted, a recorded 30 minute meal at 11 PM (before the
    // holiday): the recorded 30 is placed in the outside part, so 240 and 210 minutes are left; the other 15 is shared by
    // those, 240/450 to the holiday = 8.00: 240 - 8 = 232. (Earlier this was 232.5, the share of the whole shift inside the
    // holiday: it took 7.5 from the holiday although the placed meal had already used 30 of the outside part.)
    const shift = entry('2026-09-06T20:00', '2026-09-07T04:00');
    const meal = entry('2026-09-06T23:00', '2026-09-06T23:30');
    expect(week(PRIOR, { shifts: [shift], breaks: [meal], daily: daily(['2026-09-06', 480, 45]) }).get(HOLIDAY)).toBe(232);
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

describe('splitWorkDate: one exact split in whole hundredths', () => {
  const split = (input) => splitWorkDate({ held: [HOLIDAY, '2026-09-08'], breaks: [], meal: 0, ...input });
  const premiumOf = (result, day) => (result.parts.find((p) => p.holiday === day) || { premium: 0 }).premium;

  test('a recorded meal from 11 PM to midnight in a 11:30 PM to 7:30 AM shift: 420 paid minutes, none deducted twice', () => {
    // The first 30 shift minutes are the meal itself (placed in the first holiday, which has only those 30 paid minutes);
    // the other 30 deducted minutes can only come from the second holiday's minutes: 0 and 420, not 0.00 and 421.87.
    const shift = entry('2026-09-07T23:30', '2026-09-08T07:30');
    const meal = entry('2026-09-07T23:00', '2026-09-08T00:00');
    const result = split({ shifts: [shift], breaks: [meal], meal: 6000 });
    expect(result.deduction).toBe(6000);
    expect(premiumOf(result, HOLIDAY)).toBe(0);
    expect(premiumOf(result, '2026-09-08')).toBe(42000);
    const summed = result.parts.reduce((sum, p) => sum + p.premium, 0);
    expect(summed).toBe(42000);
  });

  test('a shift with millisecond clock times keeps its stored 60.00 minutes across two holidays: $22.33 an hour pays $11.17', () => {
    // 23:30:00.360 to 00:30:00.240: 29.99 and 30.00 when each side is rounded alone (59.99 in all), 60.00 stored.
    const shift = { ...entry('2026-09-07T23:30', '2026-09-08T00:30'), clock_in: new Date(at('2026-09-07T23:30').getTime() + 360), clock_out: new Date(at('2026-09-08T00:30').getTime() + 240), duration_minutes: '60.00' };
    const result = split({ shifts: [shift] });
    const minutes = result.parts.reduce((sum, p) => sum + p.premium, 0);
    expect(minutes).toBe(6000);
    // each holiday is within a hundredth of its 30.00 minutes (the clock gives 29.9940 and 30.0040), and they add up to 60.00
    for (const part of result.parts) expect(Math.abs(part.premium - 3000)).toBeLessThanOrEqual(1);
    const pay = computePaycheck({
      payDate: '2026-09-18', hourlyRate: '22.33', holidayMinutes: 0, ptoMinutes: 0, holidayWorkMinutes: String(minutes / 100),
      w4: { formYear: 2026, filingStatus: 'single', step2Checkbox: false },
    });
    expect(pay.holidayWorkPremiumCents).toBe(1117);
  });

  test('a deduction larger than the paid minutes is capped at them', () => {
    const shift = entry('2026-09-07T10:00', '2026-09-07T10:20');
    const result = split({ shifts: [shift], meal: 6000 });
    expect(result.deduction).toBe(2000);
    expect(result.parts).toEqual([expect.objectContaining({ holiday: HOLIDAY, paid: 2000, premium: 0 })]);
  });

  describe('seeded property test', () => {
    // mulberry32: a small seeded generator, so a failure repeats
    const seeded = (seed) => () => {
      let t = (seed += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const DAYS = ['2026-09-07', '2026-11-01', '2026-10-31', '2027-03-14', '2027-03-13', '2026-12-25'];

    test('500 random weeks: every break that overlaps a shift is read, whatever week its date is in, and every holiday figure is the exact split of its date', () => {
      const rand = seeded(7);
      const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
      for (let n = 0; n < 500; n += 1) {
        const weekStart = ['2026-10-26', '2027-03-08', '2026-09-07', '2026-12-21'][int(0, 3)];
        const dates = weekDates(weekStart);
        const shifts = [];
        const rows = [];
        for (const date of dates) {
          if (rand() < 0.4) continue;
          const from = dayBounds(date).start + int(0, 22 * 3600000);
          const to = from + int(30 * 60000, 12 * 3600000);
          shifts.push({ clock_in: new Date(from), clock_out: new Date(to), duration_minutes: String(Math.round((to - from) / 600) / 100), work_date: date });
          rows.push([date, Math.round((to - from) / 60000), int(0, 60)]);
        }
        const breaks = Array.from({ length: int(0, 4) }, (_, k) => {
          const base = shifts.length ? shifts[int(0, shifts.length - 1)] : null;
          const from = (base ? base.clock_in.getTime() : dayBounds(weekStart).start) + int(0, 14 * 3600000);
          const to = from + int(0, 90 * 60000);
          return { id: `b${k}`, clock_in: new Date(from), clock_out: new Date(to), duration_minutes: String(Math.round((to - from) / 600) / 100), work_date: etDateString(new Date(from)) };
        });
        const holidays = dates.concat([addStaffWorkDays(weekStart, 7)]).filter(() => rand() < 0.4);
        const dailyRows = daily(...rows);
        const detail = holidayWorkDetailForWeek({ dates, shifts, breaks, daily: dailyRows, holidays });
        // each date is the exact split of its own shifts with EVERY break (clipped to them), a Sunday shift's Monday meal included
        const expected = new Map();
        for (const date of dates) {
          const group = shifts.filter((sh) => sh.work_date === date);
          if (!group.length) continue;
          const split = splitWorkDate({ shifts: group, breaks, held: [...new Set(holidays)].sort(), meal: Math.round(dailyRows.get(date).unpaid_meal_minutes * 100) });
          for (const part of split.parts) if (part.holiday && part.premium > 0) expected.set(part.holiday, (expected.get(part.holiday) || 0) + part.premium);
        }
        const label = `week ${n} ${weekStart}`;
        expect([label, detail.days]).toEqual([label, [...expected.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([workDate, units]) => ({ workDate, minutes: units / 100 }))]);
        // the meals listed are breaks that exist, each clipped inside its own interval
        for (const meal of detail.meals) {
          const own = breaks.find((b) => b.id === meal.id);
          expect([label, Boolean(own), Date.parse(meal.from) >= own.clock_in.getTime(), Date.parse(meal.to) <= own.clock_out.getTime()]).toEqual([label, true, true, true]);
        }
      }
    });

    test('2000 random dates: every part is whole and non-negative, the parts add up to the stored total less the deduction, no part is paid more than its clock minutes', () => {
      const rand = seeded(20261124);
      const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
      for (let n = 0; n < 2000; n += 1) {
        const day = DAYS[int(0, DAYS.length - 1)];
        const dayStart = dayBounds(day).start;
        // 1-3 shifts that do not overlap, with millisecond clock times, anywhere from the start of the work date
        const shifts = [];
        let cursor = dayStart + int(0, 20 * 3600000);
        const jitter = rand() < 0.3 ? int(-5, 5) : 0; // sometimes the stored duration is a few hundredths off the clock
        for (let k = int(1, 3); k > 0; k -= 1) {
          const length = int(10 * 60000, 14 * 3600000);
          const from = cursor;
          const to = from + length;
          shifts.push({ clock_in: new Date(from), clock_out: new Date(to), duration_minutes: String((Math.round((to - from) / 600) + jitter) / 100) });
          cursor = to + int(0, 4 * 3600000);
        }
        const first = shifts[0].clock_in.getTime();
        const last = shifts[shifts.length - 1].clock_out.getTime();
        // 0-3 breaks of 0-90 minutes anywhere in or around the shifts
        const breaks = Array.from({ length: int(0, 3) }, () => {
          const from = first - 3600000 + int(0, last - first + 7200000);
          const to = from + int(0, 90 * 60000);
          return { clock_in: new Date(from), clock_out: new Date(to), duration_minutes: String(Math.round((to - from) / 600) / 100) };
        });
        // 0-3 holidays among the day before and the three after
        const held = [-1, 0, 1, 2].filter(() => rand() < 0.5).slice(0, 3).map((d) => addStaffWorkDays(day, d));
        const meal = int(0, 6000) + (rand() < 0.1 ? int(0, 50000) : 0);
        const result = splitWorkDate({ shifts, breaks, held, meal });
        const label = `case ${n} ${day} meal ${meal}`;
        const stored = shifts.reduce((sum, sh) => sum + Math.round(Number(sh.duration_minutes) * 100), 0);
        const paid = result.parts.reduce((sum, p) => sum + p.paid, 0);
        // the parts add up to the stored total, and the deduction never exceeds it
        expect([label, paid]).toEqual([label, stored]);
        expect(result.deduction).toBe(Math.min(meal, stored));
        let deducted = 0;
        let premiums = 0;
        for (const p of result.parts) {
          for (const key of ['paid', 'placed', 'shared', 'premium']) {
            expect([label, p.holiday, key, Number.isInteger(p[key]) && p[key] >= 0]).toEqual([label, p.holiday, key, true]);
          }
          expect([label, p.paid - p.placed - p.shared >= 0]).toEqual([label, true]);
          expect([label, p.premium]).toEqual([label, p.paid - p.placed - p.shared]);
          deducted += p.placed + p.shared;
          premiums += p.premium;
          if (p.holiday) {
            const bounds = dayBounds(p.holiday);
            const clockInside = shifts.reduce((sum, sh) => sum + Math.max(0, Math.min(sh.clock_out.getTime(), bounds.end) - Math.max(sh.clock_in.getTime(), bounds.start)), 0);
            // a part is paid its share of the stored duration: the clock minutes inside, within the stored jitter and the
            // one hundredth each shift's largest remainder can add
            expect([label, p.holiday, p.paid <= Math.ceil(clockInside / 600) + Math.abs(jitter) * shifts.length + shifts.length]).toEqual([label, p.holiday, true]);
          }
        }
        // the deduction is placed in full, and the premium and the rest of the shift are the stored total less it, exactly
        expect([label, deducted]).toEqual([label, result.deduction]);
        expect([label, premiums]).toEqual([label, stored - result.deduction]);
      }
    });
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
