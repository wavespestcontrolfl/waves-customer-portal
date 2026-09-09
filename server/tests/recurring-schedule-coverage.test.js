jest.mock('../models/db', () => ({}));
const { measureRecurringSeries } = require('../services/recurring-schedule-audit');

const root = { id: 'root', customer_id: 'customer', property_id: 'property', service_type: 'Quarterly Pest Control Service',
  is_recurring: true, recurring_ongoing: true, recurring_pattern: 'quarterly', scheduled_date: '2026-06-01', status: 'completed' };
const visit = (id, date, extra = {}) => ({ ...root, id, recurring_parent_id: root.id, scheduled_date: date, status: 'pending', ...extra });
const measure = (rows, template = root, options = {}) => measureRecurringSeries(template, rows, { todayET: '2026-09-09', ...options });

describe('recurring series coverage measurements', () => {
  test('shows a 75-day quarterly gap and its calendar cadence drift without inventing a warning threshold', () => {
    const result = measure([root, visit('early', '2026-08-15', { status: 'completed' }), visit('next', '2026-11-02')]);
    expect(result.intervals[0]).toMatchObject({ intervalDays: 75, expectedDate: '2026-09-07', driftDays: -23,
      dateException: false, basis: 'completed_visit_dates' });
    expect(result.issues).toEqual([]);
    expect(result.lastCompletedScheduledDate).toBe('2026-08-15');
  });

  test('measures a missed application as a long interval, including completed-to-upcoming spacing', () => {
    const result = measure([root, visit('late', '2026-12-07', { window_start: '09:00' })]);
    expect(result.intervals[0]).toMatchObject({ intervalDays: 189, expectedDate: '2026-09-07', driftDays: 91 });
    expect(result).toMatchObject({ nextExpectedDate: '2026-09-07', nextRecordedDate: '2026-12-07', nextTimedVisitDate: '2026-12-07' });
  });

  test('an ongoing plan with only overdue work has no future continuation', () => {
    const result = measure([root, visit('overdue', '2026-09-07')]);
    expect(result).toMatchObject({ upcomingVisits: 0, overdueVisits: 1, nextRecordedDate: null,
      issues: ['ongoing_plan_has_no_future_visit', 'overdue_uncompleted_visits'] });
  });

  test('a generated untimed due visit counts as continuation but not a timed appointment', () => {
    const result = measure([root, visit('due', '2026-09-14', { recurring_dispatch_due_date: '2026-09-07' })]);
    expect(result).toMatchObject({ upcomingVisits: 1, untimedUpcomingVisits: 1, nextRecordedDate: '2026-09-14', nextTimedVisitDate: null, issues: [] });
    expect(result.intervals[0]).toMatchObject({ scheduledDate: '2026-09-14', cadenceDate: '2026-09-07', driftDays: 0 });
  });

  test.each(['cancel_series', 'let_lapse'])('an explicit %s decision suppresses missing-continuation alerts', decision => {
    expect(measure([root], root, { decision })).toMatchObject({ stopped: true, issues: [] });
  });

  test('finite plans finish without being reported as a broken ongoing plan', () => {
    expect(measure([root], { ...root, recurring_ongoing: false })).toMatchObject({ ongoing: false, continuationDueDate: null, issues: [] });
  });

  test.each(['2026-09-01', '2026-10-01'])('a finite plan retains parked work with abandoned date %s', date => {
    const result = measure([root, visit('parked', date, { status: 'rescheduled' })], { ...root, recurring_ongoing: false });
    expect(result).toMatchObject({ awaitingPlacementVisits: 1, upcomingVisits: 0, overdueVisits: 0,
      nextRecordedDate: null, nextTimedVisitDate: null, intervals: [], issues: ['rescheduled_visits_awaiting_placement'] });
  });

  test('letting a plan lapse does not conceal its last parked application', () => {
    expect(measure([root, visit('parked', '2026-09-01', { status: 'rescheduled' })], root, { decision: 'let_lapse' }))
      .toMatchObject({ stopped: false, awaitingPlacementVisits: 1, issues: expect.arrayContaining(['rescheduled_visits_awaiting_placement']) });
  });

  test('active pauses suppress alerts while retaining interval evidence; resumed pauses do not', () => {
    const hold = { starts_on: '2026-08-01', resume_on: '2026-10-01', status: 'active' };
    const rows = [root, visit('overdue', '2026-09-07')];
    expect(measure(rows, root, { holds: [hold] })).toMatchObject({ paused: true, issues: [], intervals: [expect.objectContaining({ overlapsHold: true })] });
    expect(measure(rows, root, { holds: [{ ...hold, status: 'resumed' }] }).issues).toContain('ongoing_plan_has_no_future_visit');
  });

  test('date exceptions keep their actual spacing and original cadence position; unknown positions stay unknown', () => {
    const known = visit('moved', '2026-10-12', { date_exception: true, date_exception_cadence_date: '2026-09-07' });
    expect(measure([root, known]).intervals[0]).toMatchObject({ intervalDays: 133, driftDays: 0, dateException: true });
    const unknown = { ...known, date_exception_cadence_date: null };
    expect(measure([root, unknown]).intervals[0]).toMatchObject({ driftDays: null, cadenceDate: null });
    expect(measure([root, unknown]).continuationDueDate).toBeNull();
  });

  test('a legacy unknown exception does not erase later known cadence evidence', () => {
    const unknown = visit('legacy', '2026-08-01', { status: 'completed', date_exception: true });
    const result = measure([root, unknown, visit('september', '2026-09-07'), visit('december', '2026-12-07')]);
    expect(result.intervals[0]).toMatchObject({ appointmentId: 'legacy', expectedDate: null, cadenceDate: null, driftDays: null });
    expect(result.intervals[1]).toMatchObject({ appointmentId: 'september', expectedDate: '2026-09-07', driftDays: 0 });
    expect(result.intervals[2]).toMatchObject({ appointmentId: 'december', expectedDate: '2026-12-07', driftDays: 0 });
    expect(result.continuationDueDate).toBe('2027-03-01');
    // The last completed application itself has no known cadence position.
    expect(result.nextExpectedDate).toBeNull();
  });

  test('an unknown final exception keeps continuation unknown without erasing earlier drift', () => {
    const result = measure([root, visit('september', '2026-09-07'), visit('legacy', '2026-12-14', { date_exception: true })]);
    expect(result.intervals[0]).toMatchObject({ expectedDate: '2026-09-07', driftDays: 0 });
    expect(result.intervals[1]).toMatchObject({ expectedDate: null, cadenceDate: null, driftDays: null });
    expect(result.continuationDueDate).toBeNull();
  });

  test('seasonal mosquito respects its winter gap and custom plans use their own day interval', () => {
    const seasonal = { ...root, recurring_pattern: 'seasonal_feb_oct', scheduled_date: '2026-10-05' };
    expect(measure([seasonal, visit('spring', '2027-02-01')], seasonal).intervals[0]).toMatchObject({ expectedDate: '2027-02-01', driftDays: 0 });
    const custom = { ...root, recurring_pattern: 'custom', recurring_interval_days: 42 };
    expect(measure([custom, visit('six-week', '2026-07-13')], custom).intervals[0]).toMatchObject({ intervalDays: 42, expectedDate: '2026-07-13', driftDays: 0 });
    expect(measure([custom], { ...custom, recurring_interval_days: null }).nextExpectedDate).toBeNull();
  });

  test.each(['forward', 'back'])('weekend shifts %s do not re-anchor a day-based series', weekendShift => {
    const template = { ...root, scheduled_date: '2040-03-01', recurring_pattern: 'custom',
      recurring_interval_days: 31, skip_weekends: true, weekend_shift: weekendShift };
    const generated = require('../services/recurring-appointment-seeder').buildRecurringFollowUpRows(template, { plannedCount: 4 });
    const rows = [template, ...generated.slice(0, 2).map((row, index) => ({ ...row, id: `shifted-${index}` }))];
    const result = measure(rows, template);
    expect(result.intervals.map(row => row.driftDays)).toEqual([0, 0]);
    expect(result.continuationDueDate).toBe(generated[2].scheduled_date);
  });

  test('blackout nudges share the anchored generator and do not accumulate into later dates', () => {
    const template = { ...root, scheduled_date: '2040-03-01', recurring_pattern: 'custom', recurring_interval_days: 31 };
    const blackoutDates = new Set(['2040-04-01', '2040-04-02', '2040-05-02']);
    const result = measure([template, visit('april', '2040-04-03'), visit('may', '2040-05-03')], template, { blackoutDates });
    expect(result.intervals.map(row => row.driftDays)).toEqual([0, 0]);
    expect(result.continuationDueDate).toBe('2040-06-02');
  });

  test('coverage can continue a historical series beyond the seeder insertion batch limit', () => {
    const template = { ...root, scheduled_date: '2040-01-01', recurring_pattern: 'weekly' };
    const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');
    const rows = Array.from({ length: 30 }, (_, index) => ({ ...template, id: `week-${index}`,
      scheduled_date: etDateString(addETDays(parseETDateTime('2040-01-01T12:00'), index * 7)) }));
    const result = measure(rows, template);
    expect(result.intervals.every(row => row.driftDays === 0)).toBe(true);
    expect(result.continuationDueDate).toBe(etDateString(addETDays(parseETDateTime('2040-01-01T12:00'), 30 * 7)));
  });

  test('an exception moved past the following visit keeps both original cadence positions', () => {
    const moved = visit('moved', '2026-12-14', { date_exception: true, date_exception_cadence_date: '2026-09-07' });
    const result = measure([root, moved, visit('following', '2026-12-07')]);
    expect(result.intervals.map(interval => interval.driftDays)).toEqual([0, 0]);
    expect(result.continuationDueDate).toBe('2027-03-01');
  });

  test('cancelled visits and callbacks do not conceal a coverage gap or double-count the first occurrence', () => {
    const result = measure([root, visit('cancelled', '2026-09-07', { status: 'cancelled' }),
      visit('callback', '2026-08-01', { is_callback: true }), visit('next', '2026-12-07')]);
    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].intervalDays).toBe(189);
  });
});
