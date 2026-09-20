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

describe('double-booking measurement (same technician, occupied time per the rebooker\'s own model)', () => {
  // A real day-stops row: premise columns present, ungrouped, geocoded.
  const row = (id, customer, hour, over = {}) => ({ ...stop(hour, 0), id, customer_id: customer, technician_id: 'tech', scheduled_date: '2040-09-10',
    visit_id: null, service_address_line1: null, customer_address_line1: `${customer} St`, customer_address_line2: null,
    customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205', window_end: `${String(hour + 1).padStart(2, '0')}:00`, ...over });

  test('two customers in one slot are a pair; back-to-back, untimed and a third customer later are not', () => {
    const clash = measureDayQuality(Model, [row('a', 'cust-a', 10), row('b', 'cust-b', 10), row('c', 'cust-c', 12)]);
    expect(clash.doubleBookedVisits).toEqual([{ ids: ['a', 'b'], minutes: 60 }]);
    const clean = measureDayQuality(Model, [row('a', 'cust-a', 10), row('b', 'cust-b', 11), { ...row('u', 'cust-u', 8), window_start: null, window_end: null }]);
    expect(clean.doubleBookedVisits).toEqual([]);
  });

  test('a partial overlap counts the shared minutes, and an unknown customer is never waved on', () => {
    const partial = measureDayQuality(Model, [row('a', 'cust-a', 10, { window_end: '12:00' }), row('b', null, 11)]);
    expect(partial.doubleBookedVisits).toEqual([{ ids: ['a', 'b'], minutes: 60 }]);
  });

  test('one customer\'s pest + lawn at one premise is one stop; the same customer at a second pin or unit is not', () => {
    const pest = row('pest', 'cust-a', 10, { lat: 5, lng: 5 });
    const coVisit = measureDayQuality(Model, [pest, row('lawn', 'cust-a', 10, { lat: 5, lng: 5 })]);
    expect(coVisit.doubleBookedVisits).toEqual([]);
    expect(coVisit.overlapMinutes).toBe(60);
    // Real estimates add up (codex #4620 r4 P1): 45 + 40 in one 10:00–11:00 promise occupies until 11:25.
    const additive = [row('pest', 'cust-a', 10, { lat: 5, lng: 5, estimated_duration_minutes: 45 }), row('lawn', 'cust-a', 10, { lat: 5, lng: 5, estimated_duration_minutes: 40 })];
    expect(measureDayQuality(Model, [...additive, row('n', 'cust-n', 11)]).doubleBookedVisits).toEqual([{ ids: ['lawn', 'pest', 'n'], minutes: 25 }]);
    expect(measureDayQuality(Model, [...additive, row('n', 'cust-n', 11, { window_start: '11:30', window_end: '12:30' })]).doubleBookedVisits).toEqual([]);
    // Second property: different pin (codex #4620 r1 P1 — a customer-id-only rule hid this).
    const rental = measureDayQuality(Model, [pest, row('lawn', 'cust-a', 10, { lat: 6, lng: 6, service_address_line1: '9 Other Rd' })]);
    expect(rental.doubleBookedVisits).toEqual([{ ids: ['lawn', 'pest'], minutes: 60 }]);
    // Same parcel pin, different unit.
    const unit = measureDayQuality(Model, [{ ...pest, service_address_line1: '1 Main St Apt 1' }, row('lawn', 'cust-a', 10, { lat: 5, lng: 5, service_address_line1: '1 Main St Apt 2' })]);
    expect(unit.doubleBookedVisits).toEqual([{ ids: ['lawn', 'pest'], minutes: 60 }]);
  });

  test('a service-visit group is one stop occupying the sum of its members (codex #4620 r2 P1)', () => {
    const group = [row('pest', 'cust-a', 10, { visit_id: 'g', window_end: null }), row('lawn', 'cust-a', 10, { visit_id: 'g', window_end: null })];
    // Members never pair with each other; the group runs 10:00–12:00, so an 11:00 neighbour collides with its summed tail.
    expect(measureDayQuality(Model, group).doubleBookedVisits).toEqual([]);
    expect(measureDayQuality(Model, [...group, row('n', 'cust-n', 11, { window_end: null })]).doubleBookedVisits)
      .toEqual([{ ids: ['pest', 'lawn', 'n'], minutes: 60 }]);
    expect(measureDayQuality(Model, [...group, row('n', 'cust-n', 12, { window_end: null })]).doubleBookedVisits).toEqual([]);
    // A different group in the same slot is still a clash.
    expect(measureDayQuality(Model, [...group, row('o', 'cust-o', 10, { visit_id: 'h', window_end: null })]).doubleBookedVisits)
      .toEqual([{ ids: ['o', 'pest', 'lawn'], minutes: 60 }]);
  });

  test('a version-2 combined booking occupies the sum of its members (codex #4620 r1 P1)', () => {
    const mix = { version: 2, allocatedServiceIds: ['m1', 'm2'] };
    const members = [row('m1', 'cust-a', 10, { window_end: null, estimated_duration_minutes: 45, reservation_service_mix: mix }),
      row('m2', 'cust-a', 10, { window_end: null, estimated_duration_minutes: 40, reservation_service_mix: mix })];
    // Members never pair with each other; the 11:00 neighbour collides with the 11:25 allocation end.
    const result = measureDayQuality(Model, [...members, row('n', 'cust-n', 11, { window_end: null })]);
    expect(result.doubleBookedVisits).toEqual([{ ids: ['m1', 'm2', 'n'], minutes: 25 }]);
    expect(measureDayQuality(Model, [...members, row('n', 'cust-n', 12, { window_end: null })]).doubleBookedVisits).toEqual([]);
  });
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
