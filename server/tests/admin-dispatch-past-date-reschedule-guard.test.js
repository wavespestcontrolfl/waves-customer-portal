/**
 * Dispatch reschedule — past-date guard.
 *
 * POST /:serviceId/reschedule previously accepted any newDate verbatim and
 * the reschedule notice announced it to the customer (2026-08-13: a
 * week-off calendar click texted "now set for Friday, August 7" six days
 * after Aug 7). pastRescheduleDateError fails closed on malformed and
 * already-passed dates; same-day and future dates pass.
 */
const { pastRescheduleDateError } = require('../routes/admin-dispatch')._test;
const { etDateString, addETDays } = require('../utils/datetime-et');

describe('pastRescheduleDateError (validScheduleDate-backed)', () => {
  test('a past date is refused with an operator-facing message naming the date', () => {
    const yesterday = etDateString(addETDays(new Date(), -1));
    expect(pastRescheduleDateError(yesterday)).toMatch(new RegExp(`${yesterday}.*valid upcoming date`));
    expect(pastRescheduleDateError('2020-01-01')).toMatch(/valid upcoming date/);
  });

  test('today (ET) and future dates pass', () => {
    expect(pastRescheduleDateError(etDateString())).toBeNull();
    expect(pastRescheduleDateError(etDateString(addETDays(new Date(), 1)))).toBeNull();
    expect(pastRescheduleDateError(etDateString(addETDays(new Date(), 30)))).toBeNull();
  });

  test('an ISO datetime is judged by its date part', () => {
    expect(pastRescheduleDateError(`${etDateString(addETDays(new Date(), 1))}T10:00:00`)).toBeNull();
    expect(pastRescheduleDateError('2020-01-01T10:00:00')).toMatch(/valid upcoming date/);
  });

  test('malformed, missing, and impossible-calendar dates fail closed — no raw PG cast 500', () => {
    for (const bad of [undefined, null, '', 'not-a-date', '08/07/2026', '2026-8-7', 42,
      '2099-99-99', '2099-02-31', '2027-13-01', '2027-00-10']) {
      expect(pastRescheduleDateError(bad)).toMatch(/valid upcoming date/);
    }
  });
});
