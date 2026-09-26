jest.mock('../models/db', () => ({}));
jest.mock('../services/scheduling/day-stops', () => ({ dayStopsQuery: jest.fn(), guardedCoordSelects: () => [] }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })) }));
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
    // A live hold on a combined estimate is not grouped work yet (codex #4620 r11 P2).
    const expiry = new Date(Date.now() + 600000).toISOString();
    const heldMix = { version: 2, allocatedServiceIds: ['h1', 'h2'] };
    const held = measureDayQuality(Model, [row('h1', null, 10, { reservation_service_mix: heldMix, reservation_expires_at: expiry }), row('h2', null, 10, { reservation_service_mix: heldMix, reservation_expires_at: expiry })]);
    expect(held.uncertaintyReasons).not.toContain('grouped_work_requires_review');
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

describe('getScheduleQualityMeasurements selects the planning-minute inputs (Codex r1 P2)', () => {
  const { dayStopsQuery } = require('../services/scheduling/day-stops');
  const DATE = '2027-05-10';
  const techQuery = () => {
    const c = {};
    c.where = () => c;
    c.select = async () => [{ id: 'tech1', name: 'Tech One' }];
    return c;
  };
  const conn = jest.fn((table) => {
    if (table === 'technicians') return techQuery();
    throw new Error(`schedule-day-quality test: unexpected table ${table}`);
  });

  afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; dayStopsQuery.mockReset(); });

  test('the day-stops select list carries service_type/is_recurring/is_callback so quality totals plan the same minutes as the picker', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    let capturedSelect;
    dayStopsQuery.mockImplementation((_c, opts) => {
      capturedSelect = opts.select;
      return { whereRaw: () => Promise.resolve([{
        id: 'v1', technician_id: 'tech1', route_order: 1, customer_id: 'cust', scheduled_date: DATE,
        window_start: '09:00', window_end: '10:00', time_window: null, status: 'confirmed',
        reservation_expires_at: null, created_at: '2020-01-01T00:00:00Z', visit_id: null,
        estimated_duration_minutes: 60, service_type: 'Quarterly Pest Control Service', is_recurring: true,
        is_callback: false, lat: 27.4, lng: -82.4,
      }]) };
    });
    const result = await getScheduleQualityMeasurements({ date: DATE }, conn, new Date(`${DATE}T12:00:00Z`));
    // The fix: without these three columns selected, workDuration's
    // plannedWorkMinutes always reads an unnamed service and falls back to
    // the legacy window/estimate rule, silently disagreeing with the picker.
    expect(capturedSelect).toEqual(expect.arrayContaining([
      'scheduled_services.service_type', 'scheduled_services.is_recurring', 'scheduled_services.is_callback',
    ]));
    // A recognized recurring-pest row plans at owner minutes (25), not the
    // legacy 60 its stored estimate/window would otherwise charge.
    expect(result.days[0].byTech[0].serviceMinutes).toBe(25);
    // Codex r2 P2: the reported provenance names the planning basis.
    expect(result.days[0].byTech[0].assumptions.durationBasis).toBe('owner_planning_minutes_or_stored_window_or_estimate');
  });

  test('gate off keeps the stored window/estimate minutes and says so', async () => {
    dayStopsQuery.mockImplementation(() => ({ whereRaw: () => Promise.resolve([{
      id: 'v1', technician_id: 'tech1', route_order: 1, customer_id: 'cust', scheduled_date: DATE,
      window_start: '09:00', window_end: '10:00', time_window: null, status: 'confirmed',
      reservation_expires_at: null, created_at: '2020-01-01T00:00:00Z', visit_id: null,
      estimated_duration_minutes: 60, service_type: 'Quarterly Pest Control Service', is_recurring: true,
      is_callback: false, lat: 27.4, lng: -82.4,
    }]) }));
    const result = await getScheduleQualityMeasurements({ date: DATE }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(result.days[0].byTech[0].serviceMinutes).toBe(60);
    expect(result.days[0].byTech[0].assumptions.durationBasis).toBe('stored_window_or_estimate');
  });

  // Codex P2: day-scorecard.js's physical-stop count and co-visit-aware
  // on-site minutes must come from the SAME raw-stops read this measurement
  // already does, opt-in only so every other caller's byTech shape is
  // unchanged by default.
  test('includeStopExtras opts a caller into physicalStops/coVisitOnSiteMinutes; default output is unchanged', async () => {
    const coVisitStop = (id, extra = {}) => ({
      id, technician_id: 'tech1', customer_id: 'cust-a', visit_id: null,
      scheduled_date: DATE, window_start: '09:00', window_end: '10:00', time_window: null, route_order: null,
      status: 'confirmed', reservation_expires_at: null, created_at: `2020-01-01T0${id.length}:00:00Z`,
      // No REAL stored estimate — workDuration falls back to the 60-minute
      // WINDOW SPAN for each row, the exact "phantom hour" coVisitOnSiteMinutes
      // exists to not double-charge (two real, additive estimates instead
      // WOULD sum, by the same rule route-reorder-window-fit.js documents).
      estimated_duration_minutes: null, service_type: null, is_recurring: false, is_callback: false,
      lat: 27.4, lng: -82.4, service_address_line1: '1 Main St', service_address_line2: null,
      service_address_city: 'Bradenton', service_address_zip: '34205',
      customer_address_line1: '1 Main St', customer_address_line2: null,
      customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205',
      ...extra,
    });
    // Two ungrouped rows sharing one promised window at one premise — a
    // co-visit pair. Flat serviceMinutes double-counts it (120); the
    // co-visit-aware total must not (60).
    const stops = [coVisitStop('a'), coVisitStop('bb')];
    dayStopsQuery.mockImplementation(() => ({ whereRaw: () => Promise.resolve(stops) }));

    const withoutFlag = await getScheduleQualityMeasurements({ date: DATE }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(withoutFlag.days[0].byTech[0].serviceMinutes).toBe(120);
    expect(withoutFlag.days[0].byTech[0]).not.toHaveProperty('physicalStops');
    expect(withoutFlag.days[0].byTech[0]).not.toHaveProperty('coVisitOnSiteMinutes');

    const withFlag = await getScheduleQualityMeasurements({ date: DATE, includeStopExtras: true }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(withFlag.days[0].byTech[0]).toMatchObject({ serviceMinutes: 120, physicalStops: 1, coVisitOnSiteMinutes: 60 });
  });

  // Codex P2 (round 3): the unallocated summary flat-summed EVERY unallocated
  // stop together regardless of technician, so a co-visited pair assigned to
  // an ineligible/offboarding technician double-counted its on-site minutes
  // the same way plain serviceMinutes always did. Under the flag, each
  // technician_id (null — genuinely unassigned — is its own group) is
  // collapsed on its own before the day totals it; the two groups here must
  // never merge into one "co-visit" just for sharing a clock slot.
  test('unallocated totals collapse co-visits PER technician group under includeStopExtras; flag off is unchanged', async () => {
    const ghostCoVisitStop = (id, extra = {}) => ({
      id, technician_id: 'ghost', customer_id: 'cust-ghost', visit_id: null,
      scheduled_date: DATE, window_start: '09:00', window_end: '10:00', time_window: null, route_order: null,
      status: 'confirmed', reservation_expires_at: null, created_at: `2020-01-01T0${id.length}:00:00Z`,
      estimated_duration_minutes: null, service_type: null, is_recurring: false, is_callback: false,
      lat: 27.4, lng: -82.4, service_address_line1: '1 Main St', service_address_line2: null,
      service_address_city: 'Bradenton', service_address_zip: '34205',
      customer_address_line1: '1 Main St', customer_address_line2: null,
      customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205',
      ...extra,
    });
    const unassignedStop = {
      id: 'u1', technician_id: null, customer_id: 'cust-none', visit_id: null,
      scheduled_date: DATE, window_start: '13:00', window_end: null, time_window: null, route_order: null,
      status: 'confirmed', reservation_expires_at: null, created_at: '2020-01-01T02:00:00Z',
      estimated_duration_minutes: 30, service_type: null, is_recurring: false, is_callback: false,
      lat: 27.5, lng: -82.5, service_address_line1: '2 Second St', service_address_line2: null,
      service_address_city: 'Bradenton', service_address_zip: '34205',
      customer_address_line1: '2 Second St', customer_address_line2: null,
      customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205',
    };
    const stops = [ghostCoVisitStop('g1'), ghostCoVisitStop('g2'), unassignedStop];
    dayStopsQuery.mockImplementation(() => ({ whereRaw: () => Promise.resolve(stops) }));

    const withoutFlag = await getScheduleQualityMeasurements({ date: DATE }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(withoutFlag.days[0]).toMatchObject({ unallocatedVisits: 3, unallocatedServiceMinutes: 150 }); // 60+60+30, flat

    const withFlag = await getScheduleQualityMeasurements({ date: DATE, includeStopExtras: true }, conn, new Date(`${DATE}T12:00:00Z`));
    // ghost's co-visit pair collapses to 1 stop/60m; the unassigned stop
    // stays its own group at 1 stop/30m — 2 stops, 90m total, never 1/60.
    expect(withFlag.days[0]).toMatchObject({ unallocatedVisits: 2, unallocatedServiceMinutes: 90 });
  });

  // Codex P2 (round 8): a version-2 allocation occupies the SUM of its
  // members (visit-capacity occupiedRows). Treated as a co-visit chain it
  // kept only one member's fallback span — 60 instead of 120 — on a named
  // technician's row and in the unallocated summary alike.
  test('a V2 allocation counts its summed member minutes (not one co-visit span) under includeStopExtras', async () => {
    const allocationStop = (id, technicianId) => ({
      id, technician_id: technicianId, customer_id: 'cust-a', visit_id: null,
      scheduled_date: DATE, window_start: '09:00', window_end: '10:00', time_window: null, route_order: null,
      status: 'confirmed', reservation_expires_at: null, created_at: `2020-01-01T0${id.length}:00:00Z`,
      estimated_duration_minutes: null, service_type: null, is_recurring: false, is_callback: false,
      reservation_service_mix: { version: 2, allocatedServiceIds: technicianId === 'tech1' ? ['a', 'bb'] : ['g1', 'g2'] },
      lat: 27.4, lng: -82.4, service_address_line1: '1 Main St', service_address_line2: null,
      service_address_city: 'Bradenton', service_address_zip: '34205',
      customer_address_line1: '1 Main St', customer_address_line2: null,
      customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205',
    });
    const stops = [allocationStop('a', 'tech1'), allocationStop('bb', 'tech1'), allocationStop('g1', 'ghost'), allocationStop('g2', 'ghost')];
    dayStopsQuery.mockImplementation(() => ({ whereRaw: () => Promise.resolve(stops) }));

    const withFlag = await getScheduleQualityMeasurements({ date: DATE, includeStopExtras: true }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(withFlag.days[0].byTech[0]).toMatchObject({ physicalStops: 1, coVisitOnSiteMinutes: 120 });
    expect(withFlag.days[0]).toMatchObject({ unallocatedVisits: 1, unallocatedServiceMinutes: 120 });

    const withoutFlag = await getScheduleQualityMeasurements({ date: DATE }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(withoutFlag.days[0].byTech[0]).not.toHaveProperty('coVisitOnSiteMinutes');
    expect(withoutFlag.days[0]).toMatchObject({ unallocatedVisits: 2, unallocatedServiceMinutes: 120 }); // flat, unchanged
  });

  // Codex P2 (round 9): the arrival simulation chains the same allocation as
  // a co-visit (one 60-minute span), so its return/lateness rest on a
  // different duration model than the summed on-site total — flagged so a
  // caller can report them unknown. Plain rows never trip it.
  test('allocationModelMismatch flags a V2 allocation the simulation under-charges; plain rows do not', async () => {
    const row = (id, extra = {}) => ({
      id, technician_id: 'tech1', customer_id: 'cust-a', visit_id: null,
      scheduled_date: DATE, window_start: '09:00', window_end: '10:00', time_window: null, route_order: null,
      status: 'confirmed', reservation_expires_at: null, created_at: `2020-01-01T0${id.length}:00:00Z`,
      estimated_duration_minutes: null, service_type: null, is_recurring: false, is_callback: false,
      lat: 27.4, lng: -82.4, service_address_line1: '1 Main St', service_address_line2: null,
      service_address_city: 'Bradenton', service_address_zip: '34205',
      customer_address_line1: '1 Main St', customer_address_line2: null,
      customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205', ...extra,
    });
    const mix = { version: 2, allocatedServiceIds: ['a', 'bb'] };
    dayStopsQuery.mockImplementation(() => ({ whereRaw: () => Promise.resolve([row('a', { reservation_service_mix: mix }), row('bb', { reservation_service_mix: mix })]) }));
    const allocated = await getScheduleQualityMeasurements({ date: DATE, includeStopExtras: true }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(allocated.days[0].byTech[0]).toMatchObject({ coVisitOnSiteMinutes: 120, allocationModelMismatch: true });

    dayStopsQuery.mockImplementation(() => ({ whereRaw: () => Promise.resolve([row('a'), row('bb', { window_start: '11:00', window_end: '12:00' })]) }));
    const plain = await getScheduleQualityMeasurements({ date: DATE, includeStopExtras: true }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(plain.days[0].byTech[0]).toMatchObject({ allocationModelMismatch: false });
    const flagOff = await getScheduleQualityMeasurements({ date: DATE }, conn, new Date(`${DATE}T12:00:00Z`));
    expect(flagOff.days[0].byTech[0]).not.toHaveProperty('allocationModelMismatch');
  });

  test('coVisitOnSiteMinutes only collapses a fallback-duration pair — two REAL, distinct estimates still sum', async () => {
    const realEstimateStop = (id, extra = {}) => ({
      id, technician_id: 'tech1', customer_id: 'cust-a', visit_id: null,
      scheduled_date: DATE, window_start: '09:00', window_end: null, time_window: null, route_order: null,
      status: 'confirmed', reservation_expires_at: null, created_at: `2020-01-01T0${id.length}:00:00Z`,
      estimated_duration_minutes: 45, service_type: null, is_recurring: false, is_callback: false,
      lat: 27.4, lng: -82.4, service_address_line1: '1 Main St', service_address_line2: null,
      service_address_city: 'Bradenton', service_address_zip: '34205',
      customer_address_line1: '1 Main St', customer_address_line2: null,
      customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205',
      ...extra,
    });
    const stops = [realEstimateStop('a'), realEstimateStop('bb')];
    dayStopsQuery.mockImplementation(() => ({ whereRaw: () => Promise.resolve(stops) }));
    const result = await getScheduleQualityMeasurements({ date: DATE, includeStopExtras: true }, conn, new Date(`${DATE}T12:00:00Z`));
    // 45+45 minutes of genuinely separate work at one co-visited premise is
    // additive (arrival-route's SUM contract) — never floored down to 45.
    expect(result.days[0].byTech[0]).toMatchObject({ serviceMinutes: 90, physicalStops: 1, coVisitOnSiteMinutes: 90 });
  });
});

test('an owner-planned stop with no stored estimate is not a default duration (Codex #4829 r5 P2)', () => {
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  try {
    const planned = { ...stop(9, 1), window_end: null, estimated_duration_minutes: null,
      service_type: 'Quarterly Pest Control Service', is_recurring: true, is_callback: false };
    const result = measureDayQuality(Model, [planned], workday);
    expect(result.defaultDurations).toEqual([]);
    expect(result.serviceMinutes).toBe(25);
    const unnamed = { ...stop(9, 1), window_end: null, estimated_duration_minutes: null, service_type: 'Mosquito' };
    expect(measureDayQuality(Model, [unnamed], workday).defaultDurations).toEqual(['visit-1']);
  } finally {
    delete process.env.GATE_SCHEDULING_CAPACITY;
  }
});
