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

describe('double-booking measurement (plain rows only — owner scope 2026-09-20, PR #4620)', () => {
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

  test('occupancy is the rebooker\'s own span: stored end first, else start + estimate; partial overlaps count shared minutes', () => {
    expect(measureDayQuality(Model, [row('a', 'cust-a', 10, { window_end: '12:00' }), row('b', 'cust-b', 11)]).doubleBookedVisits).toEqual([{ ids: ['a', 'b'], minutes: 60 }]);
    expect(measureDayQuality(Model, [row('a', 'cust-a', 10, { window_end: null, estimated_duration_minutes: 90 }), row('b', 'cust-b', 11)]).doubleBookedVisits).toEqual([{ ids: ['a', 'b'], minutes: 30 }]);
  });

  test('an unknown customer is never waved on; a live hold (no customer + expiry) never cards; a stray expiry on a committed row still does', () => {
    expect(measureDayQuality(Model, [row('a', 'cust-a', 10), row('b', null, 10)]).doubleBookedVisits).toEqual([{ ids: ['a', 'b'], minutes: 60 }]);
    const expiry = new Date(Date.now() + 600000).toISOString();
    expect(measureDayQuality(Model, [row('h1', null, 10, { reservation_expires_at: expiry }), row('h2', null, 10, { reservation_expires_at: expiry }), row('n', 'cust-n', 10)]).doubleBookedVisits).toEqual([]);
    expect(measureDayQuality(Model, [row('c', 'cust-c', 10, { reservation_expires_at: expiry }), row('n', 'cust-n', 10)]).doubleBookedVisits).toEqual([{ ids: ['c', 'n'], minutes: 60 }]);
  });

  test('one customer\'s pest + lawn at one premise is one stop; the same customer at a second pin or unit is not', () => {
    const pest = row('pest', 'cust-a', 10, { lat: 5, lng: 5 });
    const coVisit = measureDayQuality(Model, [pest, row('lawn', 'cust-a', 10, { lat: 5, lng: 5 })]);
    expect(coVisit.doubleBookedVisits).toEqual([]);
    expect(coVisit.overlapMinutes).toBe(60);
    // Against a third customer the pair is ONE collision (codex #4620 r10 P2).
    expect(measureDayQuality(Model, [pest, row('lawn', 'cust-a', 10, { lat: 5, lng: 5 }), row('n', 'cust-n', 10)]).doubleBookedVisits)
      .toEqual([{ ids: ['lawn', 'pest', 'n'], minutes: 60 }]);
    expect(measureDayQuality(Model, [pest, row('lawn', 'cust-a', 10, { lat: 6, lng: 6, service_address_line1: '9 Other Rd' })]).doubleBookedVisits).toEqual([{ ids: ['lawn', 'pest'], minutes: 60 }]);
    expect(measureDayQuality(Model, [{ ...pest, service_address_line1: '1 Main St Apt 1' }, row('lawn', 'cust-a', 10, { lat: 5, lng: 5, service_address_line1: '1 Main St Apt 2' })]).doubleBookedVisits).toEqual([{ ids: ['lawn', 'pest'], minutes: 60 }]);
  });

  test('grouped rows and unknown durations are out of scope by design: never paired, never a false card', () => {
    const mix = { version: 2, allocatedServiceIds: ['m1', 'm2'] };
    const allocation = [row('m1', 'cust-a', 10, { reservation_service_mix: mix }), row('m2', 'cust-a', 10, { reservation_service_mix: mix })];
    const group = [row('g1', 'cust-g', 10, { visit_id: 'g' }), row('g2', 'cust-g', 10, { visit_id: 'g' })];
    const unknown = row('u', 'cust-u', 10, { window_end: null, estimated_duration_minutes: null });
    const result = measureDayQuality(Model, [...allocation, ...group, unknown, row('n', 'cust-n', 10)]);
    expect(result.doubleBookedVisits).toEqual([]);
    // The existing lines still cover those rows.
    expect(result.uncertaintyReasons).toEqual(expect.arrayContaining(['grouped_work_requires_review', 'default_service_durations']));
    expect(result.defaultDurations).toEqual(['u']);
    // An allocation-only day carries the grouped-work line on its own (codex #4620 r10 P1), and is still simulated.
    const allocationOnly = measureDayQuality(Model, [...allocation, row('n', 'cust-n', 10)]);
    expect(allocationOnly.doubleBookedVisits).toEqual([]);
    expect(allocationOnly.uncertaintyReasons).toContain('grouped_work_requires_review');
    expect(allocationOnly.modeledDriveMinutes).not.toBeNull();
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
