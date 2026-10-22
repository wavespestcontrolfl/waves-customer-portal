/**
 * Holidays the office can close (owner 2026-10-22: "add 14 for now, and make
 * them all open as default in the admin portal"). The list is the 14 days
 * Google Business Profile shows Florida businesses ("About holidays on
 * Google", support.google.com/business/answer/6333474, US section). Google
 * does not list Juneteenth or Columbus Day for Florida, so neither is here.
 *
 * Every date comes from a yearly rule, so nobody re-types next year's dates.
 * The rules reproduce Google's published 2026 Florida dates exactly
 * (tests/schedule-holidays.test.js).
 *
 * A closed holiday is stored by key in system_settings
 * `schedule_holiday_closures` (a JSON array of keys). A missing or empty list
 * means every holiday is open: nothing closes until the owner closes it in
 * Settings → Scheduling → Blackouts. Closed holidays reach every booking
 * surface through scheduling/blackout-dates.js, like weekly days off.
 *
 * A fixed-date federal holiday that falls on a weekend also closes its
 * observed weekday (Saturday → the Friday before, Sunday → the Monday after),
 * the way Google lists "4th of July (observed)" on Friday 2026-07-03.
 *
 * Pure: no DB and no clock. Dates are YYYY-MM-DD calendar days.
 */

const HOLIDAY_CLOSURES_KEY = 'schedule_holiday_closures';

const DAY_MS = 86400000;
const utcDay = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (date, n) => new Date(date.getTime() + n * DAY_MS);
const dateStr = (date) => date.toISOString().slice(0, 10);
const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// The nth (1-based) weekday (0 = Sun … 6 = Sat) of a month.
function nthWeekday(y, m, weekday, n) {
  const first = utcDay(y, m, 1);
  return addDays(first, ((weekday - first.getUTCDay() + 7) % 7) + 7 * (n - 1));
}

// The last weekday (0 = Sun … 6 = Sat) of a month.
function lastWeekday(y, m, weekday) {
  const last = utcDay(y, m + 1, 0); // day 0 of the next month
  return addDays(last, -((last.getUTCDay() - weekday + 7) % 7));
}

// Western Easter Sunday (the anonymous Gregorian algorithm).
function easterSunday(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return utcDay(y, Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
}

const thanksgiving = (y) => nthWeekday(y, 11, 4, 4);

// In calendar order. `observed`: a fixed-date federal holiday whose weekend
// date moves to the nearest weekday.
const HOLIDAYS = Object.freeze([
  { key: 'new_years_day', name: "New Year's Day", dateIn: (y) => utcDay(y, 1, 1), observed: true },
  { key: 'mlk_day', name: 'Martin Luther King Jr. Day', dateIn: (y) => nthWeekday(y, 1, 1, 3) },
  { key: 'presidents_day', name: "Presidents' Day", dateIn: (y) => nthWeekday(y, 2, 1, 3) },
  { key: 'good_friday', name: 'Good Friday', dateIn: (y) => addDays(easterSunday(y), -2) },
  { key: 'easter', name: 'Easter', dateIn: (y) => easterSunday(y) },
  { key: 'memorial_day', name: 'Memorial Day', dateIn: (y) => lastWeekday(y, 5, 1) },
  { key: 'independence_day', name: '4th of July', dateIn: (y) => utcDay(y, 7, 4), observed: true },
  { key: 'labor_day', name: 'Labor Day', dateIn: (y) => nthWeekday(y, 9, 1, 1) },
  { key: 'veterans_day', name: 'Veterans Day', dateIn: (y) => utcDay(y, 11, 11), observed: true },
  { key: 'thanksgiving', name: 'Thanksgiving', dateIn: thanksgiving },
  { key: 'black_friday', name: 'Black Friday', dateIn: (y) => addDays(thanksgiving(y), 1) },
  { key: 'christmas_eve', name: 'Christmas Eve', dateIn: (y) => utcDay(y, 12, 24) },
  { key: 'christmas', name: 'Christmas', dateIn: (y) => utcDay(y, 12, 25), observed: true },
  { key: 'new_years_eve', name: "New Year's Eve", dateIn: (y) => utcDay(y, 12, 31) },
].map((holiday) => Object.freeze(holiday)));

const HOLIDAY_KEYS = new Set(HOLIDAYS.map((holiday) => holiday.key));

// The days one holiday closes in one year: its own date, plus the observed
// weekday when an observed holiday falls on a weekend. [{ date, observed }].
function holidayDays(holiday, year) {
  const day = holiday.dateIn(year);
  const days = [{ date: dateStr(day), observed: false }];
  if (holiday.observed) {
    const dow = day.getUTCDay();
    if (dow === 6) days.push({ date: dateStr(addDays(day, -1)), observed: true });
    if (dow === 0) days.push({ date: dateStr(addDays(day, 1)), observed: true });
  }
  return days;
}

// Every day the given holidays close within [fromStr, toStr], inclusive, in
// date order: [{ key, name, date, observed }]. `keys` (iterable) limits the
// holidays; omitted = all 14.
function holidaysBetween(fromStr, toStr, keys = null) {
  if (!isDateStr(fromStr) || !isDateStr(toStr) || fromStr > toStr) return [];
  const wanted = keys ? new Set(keys) : null;
  const days = [];
  // One year either side: a Saturday New Year's Day is observed on Dec 31.
  for (let year = Number(fromStr.slice(0, 4)) - 1; year <= Number(toStr.slice(0, 4)) + 1; year++) {
    for (const holiday of HOLIDAYS) {
      if (wanted && !wanted.has(holiday.key)) continue;
      for (const day of holidayDays(holiday, year)) {
        if (day.date >= fromStr && day.date <= toStr) days.push({ key: holiday.key, name: holiday.name, ...day });
      }
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

// The holiday keys that close one date: usually none. Two when Christmas is a
// Saturday and its observed Friday is also Christmas Eve.
function holidayKeysOn(dateValue) {
  return isDateStr(dateValue) ? holidaysBetween(dateValue, dateValue).map((day) => day.key) : [];
}

// True when one of the closed holiday keys falls on dateValue (YYYY-MM-DD).
// The one check behind blackout-dates.isBlackoutDate and blackout-nudge.
function isClosedHoliday(dateValue, closedKeys) {
  if (!closedKeys || !closedKeys.size) return false;
  return holidayKeysOn(dateValue).some((key) => closedKeys.has(key));
}

// The next time each holiday comes around, for the settings list:
// [{ key, name, date, observed, observedDate }] in date order, never a day
// before todayStr. `date` is the holiday's own day; `observedDate` is the
// weekday that also closes for it while that day is still ahead, else null.
// When the own day is past but its observed weekday is not (a Sunday holiday,
// seen on its Monday), the observed weekday becomes `date` and `observed`
// is true.
function upcomingHolidays(todayStr) {
  if (!isDateStr(todayStr)) return [];
  const thisYear = Number(todayStr.slice(0, 4));
  const upcoming = [];
  for (const holiday of HOLIDAYS) {
    for (let year = thisYear - 1; year <= thisYear + 1; year++) {
      const [own, observed] = holidayDays(holiday, year);
      const observedAhead = !!observed && observed.date >= todayStr;
      if (own.date >= todayStr) {
        upcoming.push({ key: holiday.key, name: holiday.name, date: own.date, observed: false,
          observedDate: observedAhead ? observed.date : null });
      } else if (observedAhead) {
        upcoming.push({ key: holiday.key, name: holiday.name, date: observed.date, observed: true, observedDate: null });
      } else {
        continue;
      }
      break;
    }
  }
  // A Saturday holiday closes its Friday first: order by the earliest day.
  const firstDay = (h) => (h.observedDate && h.observedDate < h.date ? h.observedDate : h.date);
  return upcoming.sort((a, b) => firstDay(a).localeCompare(firstDay(b)) || a.key.localeCompare(b.key));
}

// The stored closure list as a Set of known holiday keys. Malformed values
// and unknown keys are dropped, so a bad row closes nothing (fail open).
function parseHolidayClosures(value) {
  if (!value) return new Set();
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key) => typeof key === 'string' && HOLIDAY_KEYS.has(key)));
  } catch {
    return new Set();
  }
}

module.exports = {
  HOLIDAY_CLOSURES_KEY,
  HOLIDAYS,
  HOLIDAY_KEYS,
  holidayDays,
  holidaysBetween,
  holidayKeysOn,
  isClosedHoliday,
  upcomingHolidays,
  parseHolidayClosures,
};
