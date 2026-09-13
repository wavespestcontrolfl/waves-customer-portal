jest.mock('../models/db', () => ({}));
const { measureDayQuality, getScheduleQualityMeasurements, QUALITY_EXCLUDED_STATUSES } = require('../services/scheduling/day-quality');
const { simulateArrivalRoute, effectiveWindowRange } = require('../services/route-reorder-window-fit');
const Model = { HQ: { lat: 1, lng: 1 }, haversine: (a, b, c, d) => a === c && b === d ? 0 : 1,
  fallbackLegMetrics: distance => ({ minutes: distance * 10, meters: distance * 1000 }) };
const stop = (hour, index, duration = 60) => ({ id: `visit-${index}`, lat: index + 2, lng: 2,
  window_start: `${String(hour).padStart(2, '0')}:00`, estimated_duration_minutes: duration, route_order: index + 1 });
const workday = { departureMinutes: 480, targetReturnMinutes: 1020, breakMinutes: 30 };

test('Wednesday has 180 gross gap minutes; modeled waiting and bookable capacity are separate', () => {
  const result = measureDayQuality(Model, [8, 11, 13, 14, 15].map((hour, index) => stop(hour, index)));
  expect(result).toMatchObject({ serviceMinutes: 300, grossGapMinutes: 180, modeledDriveMinutes: 60,
    modeledWaitingMinutes: 150, remainingServiceBudgetMinutes: null, feasibleInsertionWindows: null,
    uncertaintyReasons: ['workday_or_break_allowance_unset'] });
  expect(result.grossGaps.map(gap => gap.minutes)).toEqual([120, 60]);
});

test('seven Thursday visits can exhaust the workday; no stop-count capacity is invented', () => {
  const stops = [8, 10, 11, 12, 13, 14, 15].map((hour, index) => stop(hour, index, index ? 60 : 120));
  const result = measureDayQuality(Model, stops, workday);
  expect(result).toMatchObject({ serviceMinutes: 480, grossGapMinutes: 0, overlapMinutes: 0,
    modeledDriveMinutes: 80, remainingServiceBudgetMinutes: -50, modeledReturnMinuteBeforeBreaks: 1040 });
  expect(result.feasibleInsertionWindows).toBeNull();
  expect(result).not.toHaveProperty('available');
});

test('partial workday inputs and missing coordinates cannot produce capacity', () => {
  expect(measureDayQuality(Model, [stop(8, 0)], { targetReturnMinutes: 1020, breakMinutes: 30 }).remainingServiceBudgetMinutes).toBeNull();
  const result = measureDayQuality(Model, [{ ...stop(8, 0), lat: null }], workday);
  expect(result).toMatchObject({ modeledDriveMinutes: null, remainingServiceBudgetMinutes: null, missingCoordinates: ['visit-0'] });
});

test('stored work spans outrank shorter estimates and overlaps are measured without truncating longer jobs', () => {
  const result = measureDayQuality(Model, [{ ...stop(8, 0), window_end: '10:00' }, { ...stop(9, 1), window_start: '09:30' }]);
  expect(result).toMatchObject({ serviceMinutes: 180, overlapMinutes: 30, grossGapMinutes: 0 });
});

test('unknown duration, grouped work, and a day already underway remain uncertified', () => {
  const result = measureDayQuality(Model, [{ ...stop(8, 0), estimated_duration_minutes: null, visit_id: 'group' }], { ...workday, future: false });
  expect(result.uncertaintyReasons).toEqual(expect.arrayContaining(['default_service_durations', 'grouped_work_requires_review', 'actual_progress_required']));
  expect(result.remainingServiceBudgetMinutes).toBeNull();
});

test('diagnostics report a late arrival while the writer simulation still rejects the same route', () => {
  const stops = [stop(13, 0), stop(15, 1, 120), stop(14, 2)];
  expect(simulateArrivalRoute(Model, effectiveWindowRange, stops)).toBeNull();
  const result = measureDayQuality(Model, stops, workday);
  expect(result.modeledLateVisits).toEqual([expect.objectContaining({ id: 'visit-2', lateMinutes: 70 })]);
  expect(result.insertionStatus).toBe('current_route_infeasible');
});

test('malformed and excessive date ranges reject before database access', async () => {
  for (const input of [{ date_from: 'bad' }, { date_from: '2026-02-30' }, { date_from: '2026-09-01', date_to: '2026-12-01' }]) {
    expect(await getScheduleQualityMeasurements(input, {})).toEqual({ error: 'Use a valid date range of at most 31 days.' });
  }
});

test('quality measurement excludes completed rows as well as every non-route-stop status (codex #4295 r3 P2)', () => {
  const { NOT_A_ROUTE_STOP_STATUSES } = require('../services/stops-ahead');
  expect(QUALITY_EXCLUDED_STATUSES).toEqual(expect.arrayContaining([...NOT_A_ROUTE_STOP_STATUSES, 'completed']));
  expect(NOT_A_ROUTE_STOP_STATUSES).not.toContain('completed');
});
