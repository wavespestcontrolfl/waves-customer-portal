jest.mock('../services/scheduling/day-stops', () => ({ dayStopsQuery: jest.fn(), guardedCoordSelects: () => ['lat', 'lng'] }));
jest.mock('../services/scheduling/day-quality', () => {
  const actual = jest.requireActual('../services/scheduling/day-quality');
  return { ...actual, getScheduleQualityMeasurements: jest.fn() };
});
jest.mock('../services/scheduling/route-performance', () => ({ getRoutePerformance: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({ applyAssignable: jest.fn() }));

const { dayStopsQuery } = require('../services/scheduling/day-stops');
const { getScheduleQualityMeasurements } = require('../services/scheduling/day-quality');
const { getRoutePerformance } = require('../services/scheduling/route-performance');
const { applyAssignable } = require('../services/technician-eligibility');
const {
  routeScorecardEnabled, validDateRange, physicalStopCount, getDayScorecard,
} = require('../services/scheduling/day-scorecard');

const TECHS = [{ id: 'tech1', name: 'Tech One' }];

// A minimal thenable query-builder for the mileage_log rollup chain: every
// chain method returns itself, and awaiting it resolves to `rows`.
function mileageBuilder(rows) {
  const builder = {
    whereIn: () => builder, whereBetween: () => builder, groupBy: () => builder,
    select: () => builder, sum: () => builder, count: () => builder,
    then: (resolve) => resolve(rows),
  };
  return builder;
}

function conn(mileageRows = []) {
  return jest.fn((table) => {
    if (table === 'mileage_log') return mileageBuilder(mileageRows);
    if (table === 'technicians') return {};
    throw new Error(`day-scorecard test: unexpected table ${table}`);
  });
}

const stop = (id, extra = {}) => ({
  id, technician_id: 'tech1', customer_id: `cust-${id}`, visit_id: null,
  window_start: '09:00', window_end: null, time_window: null, route_order: null,
  created_at: `2026-09-08T0${id.length}:00:00Z`, lat: 27.4, lng: -82.4,
  service_address_line1: '1 Main St', service_address_line2: null,
  service_address_city: 'Bradenton', service_address_zip: '34205',
  customer_address_line1: '1 Main St', customer_address_line2: null,
  customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205',
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  applyAssignable.mockImplementation(() => ({ select: async () => TECHS }));
  delete process.env.GATE_ROUTE_SCORECARD;
});

describe('routeScorecardEnabled', () => {
  test('reads GATE_ROUTE_SCORECARD at call time', () => {
    expect(routeScorecardEnabled()).toBe(false);
    process.env.GATE_ROUTE_SCORECARD = 'true';
    expect(routeScorecardEnabled()).toBe(true);
  });
});

describe('validDateRange', () => {
  test('accepts a same-day or ordered range within 31 days', () => {
    expect(validDateRange('2026-09-08', '2026-09-08')).toBe(true);
    expect(validDateRange('2026-09-01', '2026-09-30')).toBe(true);
  });
  test('rejects an inverted range, a too-long range, and invalid dates', () => {
    expect(validDateRange('2026-09-08', '2026-09-01')).toBe(false);
    expect(validDateRange('2026-09-01', '2026-10-05')).toBe(false);
    expect(validDateRange('not-a-date', '2026-09-08')).toBe(false);
    expect(validDateRange('2026-09-08', 'not-a-date')).toBe(false);
  });
});

describe('physicalStopCount', () => {
  test('a same-property co-visit pair is one physical stop', () => {
    const a = stop('a');
    const b = stop('bb', { customer_id: a.customer_id }); // same customer, same window, same premise/coords
    expect(physicalStopCount([a, b])).toBe(1);
  });
  test('a 3-member co-visit chain still collapses to one', () => {
    const a = stop('a');
    const b = stop('bb', { customer_id: a.customer_id });
    const c = stop('ccc', { customer_id: a.customer_id });
    expect(physicalStopCount([a, b, c])).toBe(1);
  });
  test('a visit_id group is one physical stop regardless of member count', () => {
    const a = stop('a', { visit_id: 'visit-1' });
    const b = stop('bb', { visit_id: 'visit-1', customer_id: 'other-cust' });
    expect(physicalStopCount([a, b])).toBe(1);
  });
  test('a second customer, or a second property for the same customer, is a separate physical stop', () => {
    const a = stop('a');
    const otherCustomer = stop('bb', { customer_id: 'someone-else' });
    expect(physicalStopCount([a, otherCustomer])).toBe(2);
    const secondProperty = stop('bb', { customer_id: a.customer_id, lat: 5, lng: 5, service_address_line1: '9 Other Rd' });
    expect(physicalStopCount([a, secondProperty])).toBe(2);
  });
});

describe('getDayScorecard', () => {
  test('rejects an invalid range before calling any reader', async () => {
    const result = await getDayScorecard({ date_from: '2026-09-08', date_to: '2026-09-01' }, conn());
    expect(result).toEqual({ error: 'Use a valid date range of at most 31 days.' });
    expect(getScheduleQualityMeasurements).not.toHaveBeenCalled();
  });

  test('a future/today row is planned only, with a physical-stop count the quality measurement does not compute', async () => {
    const date = '2026-09-08';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'calibrated',
      days: [{ date, closed: false, byTech: [{
        technicianId: 'tech1', technician: 'Tech One', scheduledVisits: 2, serviceMinutes: 90,
        modeledDriveMinutes: 30, modeledWaitingMinutes: 5, modeledReturnMinuteBeforeBreaks: 600,
        modeledLateVisits: [], uncertaintyReasons: [],
      }] }],
    });
    getRoutePerformance.mockResolvedValue({ plans: [] });
    const a = stop('a');
    const b = stop('bb', { customer_id: a.customer_id }); // co-visit — one physical stop
    dayStopsQuery.mockImplementation(() => ({ whereRaw: () => Promise.resolve([a, b]) }));

    const result = await getDayScorecard({ date_from: date, date_to: date }, conn(), new Date(`${date}T12:00:00Z`));
    expect(result.driveModel).toBe('calibrated');
    expect(result.days).toHaveLength(1);
    const row = result.days[0].byTech[0];
    expect(row.actual).toBeNull();
    expect(row.planned).toMatchObject({ stops: 2, physicalStops: 1, onSiteMinutes: 90, driveMinutes: 30, waitMinutes: 5, returnMinute: 600 });
    expect(row.planned.driveShare).toBeCloseTo(30 / 120);
    expect(row.planned.stopsPerHour).toBeCloseTo(1 / 2); // 1 physical stop over a 2-hour (480->600) span
  });

  test('a past row pairs the saved snapshot with recorded work and a mileage rollup', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [{
        date, technicianId: 'tech1', plannedVisits: 2, plannedServiceMinutes: 90, plannedDriveMinutes: 25,
        plannedWaitingMinutes: 5, plannedReturnMinuteBeforeBreaks: 600, driveModel: 'legacy',
        stops: [
          { durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 480, recordedCompletionMinute: 600 },
          { durationEvidence: 'unmatched_or_uncompleted_work', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null },
        ],
      }],
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([{ technician_id: 'tech1', trip_date: date, minutes: '30', trips: '2' }]),
      new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech[0];
    expect(row.planned).toMatchObject({ stops: 2, onSiteMinutes: 90, driveMinutes: 25, returnMinute: 600 });
    expect(row.actual).toMatchObject({ onSiteMinutes: 45, onSiteCoverage: { covered: 1, total: 2 }, driveMinutes: 30, driveTrips: 2, spanMinutes: 120 });
    // No idle metric: mileage_log has no per-trip timestamps, so a day's
    // drive total can include outbound/return legs outside the recorded
    // arrival-to-completion span — span - onSite - drive is not a real
    // number on that mixed basis (Codex P1) and must never be computed.
    expect(row.actual).not.toHaveProperty('idleMinutes');
    // Drive share / stops-per-hour on the actual side are never derived from
    // a (possibly partial) actual on-site sum — planned-only fields.
    expect(row.actual).not.toHaveProperty('driveShare');
    expect(row.actual).not.toHaveProperty('stopsPerHour');
    expect(dayStopsQuery).not.toHaveBeenCalled(); // past rows never re-query raw stops
  });

  test('a partial on-site sum never inflates coverage or a no-idle claim', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [{
        date, technicianId: 'tech1', plannedVisits: 4, plannedServiceMinutes: 180, plannedDriveMinutes: 40,
        plannedWaitingMinutes: 5, plannedReturnMinuteBeforeBreaks: 700, driveModel: 'legacy',
        stops: [
          { durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 480, recordedCompletionMinute: 540 },
          { durationEvidence: 'unmatched_or_uncompleted_work', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null },
          { durationEvidence: 'unverified_timing', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null },
          { durationEvidence: 'unmatched_or_uncompleted_work', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null },
        ],
      }],
    });
    // A full-day mileage total (60m) that legitimately exceeds the recorded
    // 45m on-site + the arrival-to-completion span (60m): span(60) -
    // onSite(45) - drive(60) would be -45 if computed — proof the field
    // really is gone, not just usually positive in the other fixtures.
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([{ technician_id: 'tech1', trip_date: date, minutes: '60', trips: '3' }]),
      new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech[0];
    expect(row.actual).toMatchObject({ onSiteMinutes: 45, onSiteCoverage: { covered: 1, total: 4 }, driveMinutes: 60, spanMinutes: 60 });
    expect(row.actual).not.toHaveProperty('idleMinutes');
    expect(row.actual).not.toHaveProperty('driveShare');
    expect(row.actual).not.toHaveProperty('stopsPerHour');
  });

  test('a past tech-day with no saved snapshot reports planned:null instead of inventing one', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({ plans: [] });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech[0];
    expect(row.planned).toBeNull();
    expect(row.actual).toMatchObject({ onSiteMinutes: null, driveMinutes: null });
  });
});
