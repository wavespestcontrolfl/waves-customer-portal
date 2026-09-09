jest.mock('../models/db', () => ({}));
const { analyzeGapCandidate } = require('../services/scheduling/gap-candidates');
const { normalizePreferences } = require('../services/auto-dispatch/preferences');
const { HQ } = require('../services/route-optimizer');
const service = { id: 'candidate', technician_id: null, scheduled_date: '2040-09-11', status: 'pending',
  service_type: 'Pest Control', estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng };
const candidate = { service, preferences: normalizePreferences(null, service.service_type), holds: [], siblingDates: [], deactivated: [] };
const options = { date: '2040-09-10', today: '2040-09-09', now: new Date('2040-09-09T12:00:00Z'), technicianId: 'tech',
  departureMinutes: 480, targetReturnMinutes: 1020, breakMinutes: 30, closed: false };
const stop = (id, start, extra = {}) => ({ id, technician_id: 'tech', status: 'confirmed', window_start: start,
  estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng, ...extra });

test('specific on-the-hour fits account for stored work, the return trip, and an explicit allowance', () => {
  const result = analyzeGapCandidate(candidate, [stop('first', '08:00'), stop('later', '13:00')], options);
  expect(result).toMatchObject({ workdayVerified: true, reason: 'route_fit_requires_staff_review', automaticMoveAuthorized: false });
  expect(result.feasibleInsertionWindows.length).toBeGreaterThan(0);
  expect(result.routeFits.every(fit => fit.windowStart.endsWith(':00') && fit.modeledReturnMinuteWithAllowance <= 1020)).toBe(true);
  expect(analyzeGapCandidate(candidate, [stop('long', '08:00', { window_end: '17:00' })], options).routeFits).toEqual([]);
});

test('without workday settings route fits remain provisional, and a day underway requires progress', () => {
  const result = analyzeGapCandidate(candidate, [], { ...options, targetReturnMinutes: null });
  expect(result).toMatchObject({ workdayVerified: false, feasibleInsertionWindows: null, reason: 'workday_or_break_allowance_unset' });
  expect(result.routeFits.length).toBeGreaterThan(0);
  expect(analyzeGapCandidate(candidate, [], { ...options, today: options.date }).reason).toBe('actual_progress_required');
});

test('the return leg is part of a fit, including when a different workday input is still unknown', () => {
  const distant = { ...candidate, service: { ...service, lat: HQ.lat + 0.3 } };
  expect(analyzeGapCandidate(distant, [], { ...options, targetReturnMinutes: 600, breakMinutes: 0 }).routeFits).toEqual([]);
  expect(analyzeGapCandidate(distant, [], { ...options, targetReturnMinutes: 600, breakMinutes: null }).routeFits).toEqual([]);
  expect(analyzeGapCandidate(distant, [], { ...options, targetReturnMinutes: 660, breakMinutes: 0 }).routeFits.length).toBeGreaterThan(0);
});

test('missing pins, unknown work duration, grouped work, and untimed unallocated work cannot yield certified fits', () => {
  for (const [rows, reason] of [
    [[stop('no-pin', '08:00', { lat: null })], 'missing_coordinates'],
    [[stop('unknown', '08:00', { estimated_duration_minutes: null })], 'default_service_durations'],
    [[stop('group', '08:00', { visit_id: 'group' })], 'grouped_work_requires_review'],
    [[stop('unplaced', null, { technician_id: null })], 'untimed_unallocated_work'],
    [[stop('legacy-band', null, { technician_id: null, time_window: 'morning' })], 'untimed_unallocated_work'],
  ]) expect(analyzeGapCandidate(candidate, rows, options)).toMatchObject({ reason, feasibleInsertionWindows: null, routeFits: [] });
});

test('customer time preferences, blackouts, family holds, sibling dates, and capability deactivation constrain candidates', () => {
  const afternoon = { ...candidate, preferences: normalizePreferences({ preferred_time: 'afternoon' }, service.service_type) };
  expect(analyzeGapCandidate(afternoon, [], options).routeFits.every(fit => Number(fit.windowStart.slice(0, 2)) >= 12)).toBe(true);
  for (const [change, reason] of [
    [{ holds: [{ starts_on: '2040-09-01', resume_on: '2040-10-01' }] }, 'plan_paused_on_date'],
    [{ siblingDates: [options.date] }, 'another_series_visit_on_date'],
    [{ deactivated: ['tech'] }, 'technician_category_deactivated'],
    [{ preferences: normalizePreferences({ blackout_start: options.date, blackout_end: options.date }, service.service_type) }, 'customer_date_preference'],
  ]) expect(analyzeGapCandidate({ ...candidate, ...change }, [], options).reason).toBe(reason);
  expect(analyzeGapCandidate(candidate, [], { ...options, closed: true }).reason).toBe('scheduled_day_off');
});

test('analysis preserves the route order that the save would produce instead of assuming a future reorder', () => {
  const positioned = [stop('one', '13:00', { route_order: 1 }), stop('later', '15:00', { route_order: 2, window_end: '17:00' })];
  const extended = { ...options, targetReturnMinutes: 1200, breakMinutes: 0 };
  const result = analyzeGapCandidate(candidate, positioned, extended);
  expect(result.rejections.arrival_window).toBeGreaterThan(0);
  expect(result.routeFits.some(fit => fit.windowStart === '14:00')).toBe(false);
  expect(result.routeFits.some(fit => fit.windowStart === '17:00')).toBe(true);
  expect(analyzeGapCandidate(candidate, positioned.map(row => ({ ...row, route_order: null })), extended).routeFits.some(fit => fit.windowStart === '14:00')).toBe(true);
});

test('active holds and unassigned timed visits remain occupancy; the candidate excludes only itself', () => {
  const fixed = stop('hold', '08:00', { technician_id: null, window_end: '17:00', reservation_expires_at: '2040-09-10T20:00:00Z' });
  expect(analyzeGapCandidate(candidate, [fixed], options).routeFits).toEqual([]);
  const existing = { ...candidate, service: { ...service, scheduled_date: options.date, technician_id: 'tech', window_start: '08:00' } };
  expect(analyzeGapCandidate(existing, [existing.service], options).routeFits.some(fit => fit.windowStart === '08:00')).toBe(true);
});

test('first-occurrence anchors and due-date bounds are retained', () => {
  expect(analyzeGapCandidate({ ...candidate, service: { ...service, is_recurring: true } }, [], options).reason).toBe('first_occurrence_cadence_anchor');
  const due = { ...candidate, service: { ...service, is_recurring: true, recurring_parent_id: 'root', recurring_dispatch_due_date: '2040-10-01' } };
  expect(analyzeGapCandidate(due, [], options).reason).toBe('outside_recurring_due_range');
});
