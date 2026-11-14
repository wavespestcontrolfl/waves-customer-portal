/**
 * A month cadence counts the next visit from the MONTH of the latest one. A
 * weekend shift or a holiday nudge can carry a visit over a month end
 * (Sat Feb 27 2027 -> Mon Mar 1). Counted from the month it landed in, the next
 * monthly visit went to April and March got none: a 56-day gap in a monthly
 * plan (first seen 2026-11-13 in pest-frequency-change-postgres.test.js).
 * seriesExtendAnchor now gives such a visit the cadence day it was moved from.
 *
 * Pure: every path below is date arithmetic. The extension walks are run the
 * way production runs them, one visit at a time from the latest visit.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => next() };
});

const adminSchedule = require('../routes/admin-schedule');

const {
  planSeriesExtendDates, seriesExtendAnchor, seasonalSafeShift, seriesRecurrenceOptions,
} = adminSchedule._test;

// Only Date is faked (the walks floor candidates at today); timers stay real.
beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-13T17:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
      'cancelIdleCallback', 'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});
afterAll(() => { jest.useRealTimers(); });

const utcNoon = (ymd) => new Date(`${ymd}T12:00:00Z`);
const plusDays = (ymd, n) => new Date(utcNoon(ymd).getTime() + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((utcNoon(b) - utcNoon(a)) / 86400000);

// A series whose day is the day of `cadenceDay` (a parent with no stored nth or
// weekday), extended `hops` times the way the nightly top-up and the
// completion path do it: anchor on the latest visit, book the next date.
function hopSeries({ cadenceDay, pattern, dir = 'forward', hops, blackoutDates = null }) {
  const rOpts = seriesRecurrenceOptions({ scheduled_date: cadenceDay });
  const visits = [seasonalSafeShift(cadenceDay, pattern, true, dir, blackoutDates)];
  for (let i = 0; i < hops; i += 1) {
    const anchor = seriesExtendAnchor({ scheduled_date: visits[visits.length - 1] }, pattern, rOpts);
    const [next] = planSeriesExtendDates({
      baseDateStr: anchor, pattern, rOpts, skip: true, dir, seen: new Set([...visits, anchor]), need: 1, blackoutDates,
    });
    visits.push(next);
  }
  return visits;
}
const gapsOf = (visits) => visits.slice(1).map((d, i) => daysBetween(visits[i], d));

describe('a visit moved over a month end keeps the month it was moved from', () => {
  test('monthly on the 4th Saturday, visits moved to Monday: March 2027 gets its visit', () => {
    // 4th Saturdays: Nov 28, Dec 26, Jan 23, Feb 27, Mar 27, Apr 24, May 22.
    const visits = hopSeries({ cadenceDay: '2026-11-28', pattern: 'monthly', hops: 6 });
    expect(visits).toEqual(['2026-11-30', '2026-12-28', '2027-01-25', '2027-03-01', '2027-03-29', '2027-04-26', '2027-05-24']);
  });

  test('the anchor of a visit moved from Sat Feb 27 to Mon Mar 1 is Feb 27', () => {
    const rOpts = seriesRecurrenceOptions({ scheduled_date: '2026-11-28' });
    expect(seriesExtendAnchor({ scheduled_date: '2027-03-01' }, 'monthly', rOpts)).toBe('2027-02-27');
    expect(seriesExtendAnchor({ scheduled_date: '2027-03-01' }, 'quarterly', rOpts)).toBe('2027-02-27');
    expect(seriesExtendAnchor({ scheduled_date: '2027-03-01' }, 'monthly_nth_weekday', rOpts)).toBe('2027-02-27');
  });

  test('quarterly on the 1st Saturday, visits moved back to Friday: the gap after Fri Apr 30 is a full quarter', () => {
    // Sat May 1 2027 is moved back to Fri Apr 30. Counted from April the next visit was Fri Jul 2 (63 days).
    const rOpts = seriesRecurrenceOptions({ scheduled_date: '2027-05-01' });
    const anchor = seriesExtendAnchor({ scheduled_date: '2027-04-30' }, 'quarterly', rOpts);
    expect(anchor).toBe('2027-05-01');
    expect(planSeriesExtendDates({
      baseDateStr: anchor, pattern: 'quarterly', rOpts, skip: true, dir: 'back', seen: new Set(['2027-04-30']), need: 1, blackoutDates: null,
    })).toEqual(['2027-08-06']);
  });

  test('a holiday nudge over the year end keeps December', () => {
    // Last Thursday, Dec 31 2026, closed with Jan 1: the visit goes to Mon Jan 4.
    const blackoutDates = new Set(['2026-12-31', '2027-01-01']);
    const rOpts = seriesRecurrenceOptions({ scheduled_date: '2026-12-31' });
    expect(seasonalSafeShift('2026-12-31', 'monthly', true, 'forward', blackoutDates)).toBe('2027-01-04');
    expect(seriesExtendAnchor({ scheduled_date: '2027-01-04' }, 'monthly', rOpts)).toBe('2026-12-31');
  });

  test.each([
    ['monthly', 26, 37],
    ['bimonthly', 54, 65],
    ['quarterly', 82, 100],
  ])('%s: from every Saturday and Sunday of a year and either weekend direction, no gap is a month long or short', (pattern, min, max) => {
    // 2026-11-14 is a Saturday: offsets 0 and 1 of each week are the weekend.
    for (let offset = 0; offset < 371; offset += 1) {
      if (offset % 7 > 1) continue;
      const cadenceDay = plusDays('2026-11-14', offset);
      for (const dir of ['forward', 'back']) {
        const gaps = gapsOf(hopSeries({ cadenceDay, pattern, dir, hops: 10 }));
        const bad = gaps.filter((gap) => !(gap >= min && gap <= max));
        if (bad.length) throw new Error(`${pattern} from ${cadenceDay} (${dir}): gaps ${gaps.join(', ')}`);
      }
    }
  });
});

describe('every other visit keeps its own date as the anchor', () => {
  const fourthSaturday = seriesRecurrenceOptions({ scheduled_date: '2026-11-28' });

  test('a visit moved inside its month', () => {
    expect(seriesExtendAnchor({ scheduled_date: '2026-12-28' }, 'monthly', fourthSaturday)).toBe('2026-12-28');
  });

  test('a visit on its own cadence day', () => {
    const firstMonday = seriesRecurrenceOptions({ scheduled_date: '2027-03-01' });
    expect(seriesExtendAnchor({ scheduled_date: '2027-03-01' }, 'monthly', firstMonday)).toBe('2027-03-01');
  });

  test('a visit more than seven days from the cadence day of the month before or after', () => {
    expect(seriesExtendAnchor({ scheduled_date: '2027-03-08' }, 'monthly', fourthSaturday)).toBe('2027-03-08');
  });

  test('a day-gap cadence', () => {
    expect(seriesExtendAnchor({ scheduled_date: '2027-03-01' }, 'biweekly', fourthSaturday)).toBe('2027-03-01');
  });

  test('a one-visit move still counts from its recorded cadence date', () => {
    const moved = { scheduled_date: '2027-03-10', date_exception: true, date_exception_cadence_date: '2027-03-27' };
    expect(seriesExtendAnchor(moved, 'monthly', fourthSaturday)).toBe('2027-03-27');
  });
});
