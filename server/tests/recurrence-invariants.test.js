/**
 * Recurrence invariants — a 12-month sweep of EVERY cadence the three
 * nextRecurringDate copies support (seeder / rebooker / admin-schedule),
 * from base dates that straddle both 2026 DST transitions (03-08 spring
 * forward, 11-01 fall back — the 12-month runs also cross 2027-03-14 and
 * 2027-11-07) and the month-end edges (Jan 31, Feb 28, Oct 31, Dec 31,
 * 5th-weekday months).
 *
 * recurring-date-parity.test.js proves the three copies agree with each
 * other for i=0..4 from three bases. This file proves what they agree ON
 * holds up for a full year: every (implementation × pattern × base) series
 * is
 *   (1) MONOTONIC        — each occurrence is strictly after the previous;
 *   (2) GAP-TOLERANT     — consecutive gaps obey the rule the code's own
 *                          arithmetic defines (see GAP RULES below, derived
 *                          from datetime-et.js — nothing looser);
 *   (3) REMINDER-SAFE    — the reminder time the visit-creation path derives
 *                          for the occurrence (resolveCommittedVisitTime →
 *                          parseETDateTime, the #3649 path) keeps the ET
 *                          wall clock of the window across DST (a 10:00 ET
 *                          visit is still 10:00 ET after the change) and both
 *                          reminder bands (72h / 24h) open strictly before
 *                          the window start, per the cron's own exported
 *                          boundary helpers.
 *
 * GAP RULES (derived from server/utils/datetime-et.js):
 *   - Day cadences (daily 1 / weekly 7 / biweekly 14 / every_6_weeks 42 /
 *     custom N) go through addETDays, which is ET CALENDAR-day arithmetic
 *     anchored at noon UTC: the gap is EXACTLY k calendar days, DST or not.
 *   - Month cadences (monthly 1 / bimonthly 2 / quarterly 3 / triannual 4 /
 *     semiannual|biannual 6 / annual|yearly 12, monthly_nth_weekday, and
 *     seasonal_feb_oct) go through addETMonthsByWeekday →
 *     etNthWeekdayOfMonth: occurrence i is the SAME ORDINAL WEEKDAY (nth,
 *     weekday) of month base+k·i, falling back to the LAST such weekday when
 *     the target month has no nth one (`if (day > lastDay) day -= 7`). So:
 *       · the weekday never changes, hence every gap is a multiple of 7;
 *       · the ordinal is nth, or nth−1 exactly when the month lacks an nth
 *         weekday (the occurrence is then in the month's last 7 days);
 *       · the gap differs from the 1st-of-month-to-1st-of-month distance D
 *         by at most 6 days (the ordinal weekday's offset inside its month
 *         is 0..6), widened by exactly 7 when the fallback fired on one
 *         endpoint but not the other. That is |gap − D| ≤ 6 + 7·|fbA − fbB|.
 *   - seasonal_feb_oct additionally never lands in Nov–Jan and steps one
 *     in-season month at a time, Oct → next Feb being a 4-month step.
 *
 * Deterministic: no DB, no network, no clock. Mocks are the parity test's
 * (db / logger / admin-auth) plus appointment-reminders' own established set
 * (appointment-reminders-committed-time.test.js) so the REAL committed-row
 * reminder-time resolver runs against a stub row reader.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => next() };
});
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ renderTemplate: jest.fn(), getTemplate: jest.fn() }));
jest.mock('../services/estimate-card-holds', () => ({}));

jest.setTimeout(120000); // the sweep is Intl-bound (~10k date projections); CI runners are slow

const { parseETDateTime, etParts, etDateString } = require('../utils/datetime-et');
const AppointmentReminders = require('../services/appointment-reminders');

const IMPLS = {
  seeder: require('../services/recurring-appointment-seeder')._internals.nextRecurringDate,
  rebooker: require('../services/rebooker').nextRecurringDate,
  adminSchedule: require('../routes/admin-schedule').nextRecurringDate,
};

// Fixed calendar-day gap per addETDays (see GAP RULES). `custom` carries its
// interval through opts.intervalDays; the 9x lawn cadence normalizes to
// every_6_weeks and 12x to monthly (recurring-appointment-seeder
// normalizeRecurrencePattern), so both are covered by name below.
const DAY_CADENCES = {
  daily: { days: 1 },
  weekly: { days: 7 },
  biweekly: { days: 14 },
  every_6_weeks: { days: 42 },
  custom: { days: 10, opts: { intervalDays: 10 } },
};

// Month step per MONTH_RECURRENCE_INTERVALS (identical in all three copies).
const MONTH_CADENCES = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  triannual: 4,
  semiannual: 6,
  biannual: 6,
  annual: 12,
  yearly: 12,
};

const SEASON_FIRST_MONTH = 2;
const SEASON_LAST_MONTH = 10;

// Bases straddling both DST seams and the month-end edges. Twelve months
// from each also crosses the 2027 transitions (03-14 / 11-07).
const BASES = [
  '2025-11-01', '2025-12-31',
  '2026-01-29', // 5th Thursday — exercises the nth-weekday fallback
  '2026-01-31', '2026-02-28',
  '2026-03-07', '2026-03-08', '2026-03-09',
  '2026-03-31', // 5th Tuesday — fallback again, straddling spring forward
  '2026-04-30', '2026-05-31', '2026-07-04', '2026-08-31',
  '2026-10-31', '2026-11-01', '2026-11-02',
  '2026-12-31',
];

// A daily series from one base visits every date of its year, so extra
// bases add cost (Intl formatting per call) without new dates; three bases
// still put both 2026 seams and the 2027 spring seam inside every run.
const DAILY_BASES = ['2025-12-31', '2026-03-08', '2026-10-31'];

const WINDOW_STARTS = ['08:00', '10:00', '16:00'];
const HOUR_MS = 3600000;

// ── pure calendar helpers (UTC-anchored, no timezone involved) ──
function ymd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { y, m, d };
}
function dayNumber(dateStr) {
  const { y, m, d } = ymd(dateStr);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
function calendarDaysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}
function monthIndex(dateStr) {
  const { y, m } = ymd(dateStr);
  return y * 12 + (m - 1);
}
// Days from the 1st of a's month to the 1st of b's month.
function monthStartDistance(a, b) {
  const A = ymd(a); const B = ymd(b);
  return Math.round((Date.UTC(B.y, B.m - 1, 1) - Date.UTC(A.y, A.m - 1, 1)) / 86400000);
}
function lastDayOfMonth(dateStr) {
  const { y, m } = ymd(dateStr);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function weekdayOf(dateStr) {
  return etParts(parseETDateTime(`${dateStr}T12:00`)).dayOfWeek;
}
function ordinalOf(dateStr) {
  return Math.ceil(ymd(dateStr).d / 7);
}

// Occurrence 0 is the anchor visit itself — every production caller asks
// nextRecurringDate for i >= 1 only (seeder attempt=1, admin-schedule loops
// from 1, rebooker cadenceSlotDate pins occurrenceIndex 0 to anchorDate).
// (For seasonal_feb_oct an off-season base's i=0 is the slot BEFORE the
// coming February — the previous October — by seasonOrdinalForBase's
// design; it is never requested.)
function series(impl, base, pattern, count, opts = {}) {
  const out = [base];
  for (let i = 1; i < count; i++) out.push(impl(base, pattern, i, opts));
  return out;
}

// Invariant 1 — strictly increasing.
function assertMonotonic(label, dates) {
  for (let i = 1; i < dates.length; i++) {
    expect({ label, i, prev: dates[i - 1], next: dates[i], ok: dates[i] > dates[i - 1] })
      .toEqual({ label, i, prev: dates[i - 1], next: dates[i], ok: true });
  }
}

// Invariant 2 (day cadences) — exactly k calendar days apart.
function assertExactDayGaps(label, dates, k) {
  for (let i = 1; i < dates.length; i++) {
    const gap = calendarDaysBetween(dates[i - 1], dates[i]);
    expect({ label, i, prev: dates[i - 1], next: dates[i], gap }).toEqual({ label, i, prev: dates[i - 1], next: dates[i], gap: k });
  }
}

// Invariant 2 (month cadences) — same ordinal weekday of the expected month,
// with the documented last-weekday fallback, and the gap bound that follows.
function assertOrdinalWeekdayGaps(label, dates, { nth, weekday, expectedMonthIndex }) {
  const fallbacks = dates.map((d, i) => {
    const info = { label, i, date: d };
    expect({ ...info, monthIndex: monthIndex(d) }).toEqual({ ...info, monthIndex: expectedMonthIndex(i) });
    expect({ ...info, weekday: weekdayOf(d) }).toEqual({ ...info, weekday });
    const ordinal = ordinalOf(d);
    const fellBack = ordinal < nth;
    if (fellBack) {
      // Only the "month has no nth weekday" fallback may lower the ordinal,
      // and then the occurrence is the LAST such weekday of its month.
      expect({ ...info, ordinal, nth }).toEqual({ ...info, ordinal: nth - 1, nth });
      expect({ ...info, lastOfKind: ymd(d).d + 7 > lastDayOfMonth(d) }).toEqual({ ...info, lastOfKind: true });
    } else {
      expect({ ...info, ordinal }).toEqual({ ...info, ordinal: nth });
    }
    return fellBack ? 1 : 0;
  });
  for (let i = 1; i < dates.length; i++) {
    const gap = calendarDaysBetween(dates[i - 1], dates[i]);
    const D = monthStartDistance(dates[i - 1], dates[i]);
    const allowed = 6 + 7 * Math.abs(fallbacks[i] - fallbacks[i - 1]);
    const info = { label, i, prev: dates[i - 1], next: dates[i], gap, D };
    expect({ ...info, multipleOf7: gap % 7 === 0 }).toEqual({ ...info, multipleOf7: true });
    expect({ ...info, withinBound: Math.abs(gap - D) <= allowed, allowed }).toEqual({ ...info, withinBound: true, allowed });
  }
}

// Stub row reader shaped like the committed-time test's: the visit row as
// the DB would hand it back (TIME columns arrive as HH:MM:SS strings).
function committedRow(date, hhmm) {
  const builder = {
    where: () => builder,
    forShare: () => builder,
    first: async () => ({ scheduled_date: date, window_start: `${hhmm}:00` }),
  };
  return () => builder;
}

// Invariant 3 — for one occurrence date: the reminder time the creation
// path resolves keeps the ET wall clock, and both reminder bands open
// strictly before the window start (the cron's own boundary helpers).
async function assertReminderBeforeWindow(date, hhmm) {
  const info = { date, hhmm };
  const resolved = await AppointmentReminders.resolveCommittedVisitTime(
    'visit-under-test', { date, windowStart: null }, committedRow(date, hhmm), { lock: true },
  );
  expect({ ...info, resolved }).toEqual({ ...info, resolved: { appointmentTime: `${date}T${hhmm}`, windowless: false } });

  // registerAppointment: `parseETDateTime(appointmentTime)` — the absolute
  // instant stored as appointment_reminders.appointment_time.
  const apptTime = parseETDateTime(resolved.appointmentTime);
  const et = etParts(apptTime);
  const wall = `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`;
  expect({ ...info, etDate: etDateString(apptTime), wall }).toEqual({ ...info, etDate: date, wall: hhmm });

  const t72 = new Date(apptTime.getTime() - 72 * HOUR_MS);
  const t24 = new Date(apptTime.getTime() - 24 * HOUR_MS);
  expect({ ...info, order: t72 < t24 && t24 < apptTime }).toEqual({ ...info, order: true });
  // 72h band is open when it fires and has handed off by the 24h mark;
  // the 24h band is open when it fires and closed at the window start.
  expect({
    ...info,
    open72AtFire: AppointmentReminders.reminder72hStillReachable(apptTime, t72),
    closed72At24: AppointmentReminders.reminder72hStillReachable(apptTime, t24),
    open24AtFire: AppointmentReminders.reminder24hStillReachable(apptTime, t24),
    closed24AtStart: AppointmentReminders.reminder24hStillReachable(apptTime, apptTime),
  }).toEqual({ ...info, open72AtFire: true, closed72At24: false, open24AtFire: true, closed24AtStart: false });
}

// Every distinct occurrence date any series produced — invariant 3 is a
// property of the date, so it runs once per (date × window), not per series.
const allOccurrenceDates = new Set();

describe('recurrence invariants — 12-month sweep, every cadence, both DST seams', () => {
  const implNames = Object.keys(IMPLS);

  describe('day cadences: exact calendar-day gaps (addETDays)', () => {
    for (const [pattern, { days, opts = {} }] of Object.entries(DAY_CADENCES)) {
      test(`${pattern}: +${days}d exactly, monotonic, from every base, all three copies`, () => {
        const count = Math.floor(366 / days) + 1; // 12 months of occurrences
        for (const base of (pattern === 'daily' ? DAILY_BASES : BASES)) {
          const perImpl = implNames.map((name) => series(IMPLS[name], base, pattern, count, opts));
          for (let k = 1; k < perImpl.length; k++) {
            expect({ pattern, base, impl: implNames[k], dates: perImpl[k] })
              .toEqual({ pattern, base, impl: implNames[k], dates: perImpl[0] });
          }
          implNames.forEach((name, k) => {
            const label = `${name}/${pattern}/${base}`;
            expect({ label, i0: IMPLS[name](base, pattern, 0, opts) }).toEqual({ label, i0: base });
            assertMonotonic(label, perImpl[k]);
            assertExactDayGaps(label, perImpl[k], days);
          });
          perImpl[0].forEach((d) => allOccurrenceDates.add(d));
        }
      });
    }
  });

  describe('month cadences: same ordinal weekday of month base+k·i (addETMonthsByWeekday)', () => {
    for (const [pattern, step] of Object.entries(MONTH_CADENCES)) {
      test(`${pattern}: every ${step} month(s), weekday-preserving, monotonic, all three copies`, () => {
        const count = Math.floor(12 / step) + 1; // spans exactly 12 months
        for (const base of BASES) {
          const perImpl = implNames.map((name) => series(IMPLS[name], base, pattern, count, {}));
          for (let k = 1; k < perImpl.length; k++) {
            expect({ pattern, base, impl: implNames[k], dates: perImpl[k] })
              .toEqual({ pattern, base, impl: implNames[k], dates: perImpl[0] });
          }
          const nth = ordinalOf(base);
          const weekday = weekdayOf(base);
          const baseMonth = monthIndex(base);
          implNames.forEach((name, k) => {
            const label = `${name}/${pattern}/${base}`;
            expect({ label, i0: IMPLS[name](base, pattern, 0, {}) }).toEqual({ label, i0: base });
            assertMonotonic(label, perImpl[k]);
            assertOrdinalWeekdayGaps(label, perImpl[k], {
              nth, weekday, expectedMonthIndex: (i) => baseMonth + step * i,
            });
          });
          perImpl[0].forEach((d) => allOccurrenceDates.add(d));
        }
      });
    }

    test('monthly_nth_weekday: explicit nth/weekday, monthly, monotonic, all three copies', () => {
      for (const base of BASES) {
        // Explicit nth/weekday equal to the base's own so i=0 is the base
        // (the parity test uses a fixed nth=3/weekday=4; here the base is
        // the anchor, which is how a series is booked).
        const opts = { nth: ordinalOf(base), weekday: weekdayOf(base) };
        const perImpl = implNames.map((name) => series(IMPLS[name], base, 'monthly_nth_weekday', 13, opts));
        for (let k = 1; k < perImpl.length; k++) {
          expect({ base, impl: implNames[k], dates: perImpl[k] }).toEqual({ base, impl: implNames[k], dates: perImpl[0] });
        }
        const baseMonth = monthIndex(base);
        implNames.forEach((name, k) => {
          const label = `${name}/monthly_nth_weekday/${base}`;
          expect({ label, i0: IMPLS[name](base, 'monthly_nth_weekday', 0, opts) }).toEqual({ label, i0: base });
          assertMonotonic(label, perImpl[k]);
          assertOrdinalWeekdayGaps(label, perImpl[k], {
            nth: opts.nth, weekday: opts.weekday, expectedMonthIndex: (i) => baseMonth + i,
          });
        });
        perImpl[0].forEach((d) => allOccurrenceDates.add(d));
      }
    });

    test('seasonal_feb_oct: one in-season month per step, Oct → next Feb, never Nov–Jan, all three copies', () => {
      for (const base of BASES) {
        // 10 occurrences = a full 9-slot season cycle plus one, i.e. 12 months.
        const perImpl = implNames.map((name) => series(IMPLS[name], base, 'seasonal_feb_oct', 10, {}));
        for (let k = 1; k < perImpl.length; k++) {
          expect({ base, impl: implNames[k], dates: perImpl[k] }).toEqual({ base, impl: implNames[k], dates: perImpl[0] });
        }
        const { y: baseY, m: baseM } = ymd(base);
        const inSeason = baseM >= SEASON_FIRST_MONTH && baseM <= SEASON_LAST_MONTH;
        // seasonOrdinalForBase: slots run Feb=0 … Oct=8 within a season
        // year; an off-season base sits at slot −1 of the COMING season
        // (Nov/Dec → next year's, Jan → its own), so i=1 is that February.
        const seasonYear = inSeason ? baseY : (baseM > SEASON_LAST_MONTH ? baseY + 1 : baseY);
        const baseSlot = inSeason ? baseM - SEASON_FIRST_MONTH : -1;
        const expectedMonthIndex = (i) => {
          if (i === 0 && !inSeason) return monthIndex(base); // the base itself, untouched
          const slot = baseSlot + i;
          const year = seasonYear + Math.floor(slot / 9);
          const month = ((slot % 9) + 9) % 9 + SEASON_FIRST_MONTH;
          return year * 12 + (month - 1);
        };
        implNames.forEach((name, k) => {
          const label = `${name}/seasonal_feb_oct/${base}`;
          const dates = perImpl[k];
          if (inSeason) {
            expect({ label, i0: IMPLS[name](base, 'seasonal_feb_oct', 0, {}) }).toEqual({ label, i0: base });
          }
          assertMonotonic(label, dates);
          dates.forEach((d, i) => {
            if (i === 0 && !inSeason) return;
            const month = ymd(d).m;
            expect({ label, i, date: d, inSeason: month >= SEASON_FIRST_MONTH && month <= SEASON_LAST_MONTH })
              .toEqual({ label, i, date: d, inSeason: true });
          });
          for (let i = 1; i < dates.length; i++) {
            const prevM = ymd(dates[i - 1]).m;
            const stepMonths = monthIndex(dates[i]) - monthIndex(dates[i - 1]);
            const expectedStep = (i === 1 && !inSeason)
              ? monthIndex(dates[1]) - monthIndex(base)
              : (prevM === SEASON_LAST_MONTH ? 4 : 1);
            expect({ label, i, prev: dates[i - 1], next: dates[i], stepMonths })
              .toEqual({ label, i, prev: dates[i - 1], next: dates[i], stepMonths: expectedStep });
          }
          assertOrdinalWeekdayGaps(label, dates, {
            nth: ordinalOf(base), weekday: weekdayOf(base), expectedMonthIndex,
          });
        });
        perImpl[0].forEach((d) => allOccurrenceDates.add(d));
      }
    });
  });

  describe('reminder before window, ET wall clock stable across DST', () => {
    test('every occurrence date the sweep produced × 08:00 / 10:00 / 16:00 windows', async () => {
      const dates = [...allOccurrenceDates].sort();
      // Guard against an accidentally empty sweep (a describe reorder would
      // otherwise make this test vacuously green).
      expect(dates.length).toBeGreaterThan(400);
      // Both 2026 seams and both 2027 seams are inside the swept range.
      for (const seam of ['2026-03-08', '2026-11-01', '2027-03-14']) {
        expect({ seam, swept: dates.includes(seam) }).toEqual({ seam, swept: true });
      }
      for (const date of dates) {
        for (const hhmm of WINDOW_STARTS) {
          await assertReminderBeforeWindow(date, hhmm);
        }
      }
    });

    test('the DST seam days themselves: spring-forward and fall-back visits keep their ET wall clock', async () => {
      // Bookable windows only (07:00–19:00 ET); the 01:00–03:00 seam hour
      // itself is not a schedulable window and is deliberately not asserted.
      for (const date of ['2026-03-08', '2026-11-01', '2027-03-14', '2027-11-07']) {
        for (const hhmm of ['07:00', '10:00', '13:30', '19:00']) {
          await assertReminderBeforeWindow(date, hhmm);
        }
      }
    });
  });
});
