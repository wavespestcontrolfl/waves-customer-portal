/**
 * Dispatch reschedule — past-date guard.
 *
 * POST /:serviceId/reschedule previously accepted any newDate verbatim and
 * the reschedule notice announced it to the customer (2026-08-13: a
 * week-off calendar click texted "now set for Friday, August 7" six days
 * after Aug 7). pastRescheduleDateError fails closed on malformed and
 * already-passed dates; same-day and future dates pass.
 */
const fs = require('fs');
const path = require('path');
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

describe('update-details suppressed past-date notice — reminder close (source pin)', () => {
  // reminderFlagsCoveredByNotice only covers windows with hoursUntil > 0, so
  // coverDueWindows / markRescheduleNoticeSent write the flags FALSE for a
  // past appointment and the 15-min cron rescans the row forever (codex
  // #3401 r2 P2). Pin that the suppression branch does an EXPLICIT close of
  // both windows, guarded on the rewrite-stamped appointment_time + the
  // marker carve-outs.
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

  test('the suppression branch explicitly closes both windows, guarded on the stamped time', () => {
    const branch = src.split('is in the past, so no reschedule text was sent')[0].slice(-3000);
    expect(branch).toMatch(/appointment_time: pastApptTime,/);
    expect(branch).toMatch(/reminder_72h_sent: true,/);
    expect(branch).toMatch(/reminder_24h_sent: true,/);
    expect(branch).toMatch(/suppressed_by_sibling: false,\s*\n\s*windows_preclosed: false,/);
    // …as a direct UPDATE — not through handleReschedule, whose
    // hoursUntil>0 coverage can't close a past time.
    expect(branch).not.toMatch(/handleReschedule\(/);
  });
});
