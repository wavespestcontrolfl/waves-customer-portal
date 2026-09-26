jest.mock('../services/scheduling/day-quality', () => {
  const actual = jest.requireActual('../services/scheduling/day-quality');
  return { ...actual, getScheduleQualityMeasurements: jest.fn() };
});
jest.mock('../services/scheduling/route-performance', () => ({ getRoutePerformance: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({ applyAssignable: jest.fn() }));

const { getScheduleQualityMeasurements } = require('../services/scheduling/day-quality');
const { getRoutePerformance } = require('../services/scheduling/route-performance');
const { applyAssignable } = require('../services/technician-eligibility');
const {
  routeScorecardEnabled, validDateRange, physicalStopCount, getDayScorecard,
} = require('../services/scheduling/day-scorecard');

const TECHS = [{ id: 'tech1', name: 'Tech One' }];

// A minimal thenable query-builder for the mileage_log raw-rows read: every
// chain method returns itself, and the terminal select() resolves `rows`.
function mileageBuilder(rows) {
  const builder = { whereNotNull: () => builder, whereBetween: () => builder, select: () => Promise.resolve(rows) };
  return builder;
}

// resolveHistoricalNames' direct (non-applyAssignable) technicians lookup —
// conn('technicians') is also called as applyAssignable's own argument, but
// that mock ignores it entirely, so one shape here covers both call sites.
function techniciansBuilder(extraTechs) {
  return { whereIn: () => ({ select: async () => extraTechs }) };
}

function conn(mileageRows = [], extraTechs = []) {
  return jest.fn((table) => {
    if (table === 'mileage_log') return mileageBuilder(mileageRows);
    if (table === 'technicians') return techniciansBuilder(extraTechs);
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

  test('a future/today row reads day-quality\'s own physicalStops/coVisitOnSiteMinutes, never a second raw-stops query', async () => {
    const date = '2026-09-08';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'calibrated',
      days: [{ date, closed: false, byTech: [{
        // serviceMinutes (120) is the flat, double-counting sum; the co-visit-
        // aware field (90) is what plannedFutureRow must actually use.
        technicianId: 'tech1', technician: 'Tech One', scheduledVisits: 2, serviceMinutes: 120,
        coVisitOnSiteMinutes: 90, physicalStops: 1,
        modeledDriveMinutes: 30, modeledWaitingMinutes: 5, modeledReturnMinuteBeforeBreaks: 600,
        modeledLateVisits: [], uncertaintyReasons: [],
      }] }],
    });

    const dbConn = conn();
    const result = await getDayScorecard({ date_from: date, date_to: date }, dbConn, new Date(`${date}T12:00:00Z`));
    // includeStopExtras must be requested, and a pure-future range never
    // needs route-performance at all (Codex P1 — nothing to consume its
    // newest-500-planner-runs cap for a date range with no past side).
    expect(getScheduleQualityMeasurements).toHaveBeenCalledWith(
      expect.objectContaining({ includeStopExtras: true }), dbConn, expect.any(Date));
    expect(getRoutePerformance).not.toHaveBeenCalled();
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
          { durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 480, recordedCompletionMinute: 600, arrivalOutcome: 'on_time' },
          { durationEvidence: 'unmatched_or_uncompleted_work', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null, arrivalOutcome: 'not_completed' },
        ],
      }],
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([
      { technician_id: 'tech1', trip_date: date, duration_minutes: 15, purpose: 'business' },
      { technician_id: 'tech1', trip_date: date, duration_minutes: 15, purpose: 'business' },
    ]), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech[0];
    expect(row.planned).toMatchObject({ stops: 2, onSiteMinutes: 90, driveMinutes: 25, returnMinute: 600 });
    expect(row.actual).toMatchObject({ onSiteMinutes: 45, onSiteCoverage: { covered: 1, total: 2 }, driveMinutes: 30, driveTrips: 2, spanMinutes: 120,
      stops: 1, physicalStops: null }); // 1 of the 2 planned stops actually completed on this route; no unbaselined job
    // No idle metric: mileage_log has no per-trip timestamps, so a day's
    // drive total can include outbound/return legs outside the recorded
    // arrival-to-completion span — span - onSite - drive is not a real
    // number on that mixed basis (Codex P1) and must never be computed.
    expect(row.actual).not.toHaveProperty('idleMinutes');
    // Drive share / stops-per-hour on the actual side are never derived from
    // a (possibly partial) actual on-site sum — planned-only fields.
    expect(row.actual).not.toHaveProperty('driveShare');
    expect(row.actual).not.toHaveProperty('stopsPerHour');
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
          { durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 480, recordedCompletionMinute: 540, arrivalOutcome: 'on_time' },
          { durationEvidence: 'unmatched_or_uncompleted_work', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null, arrivalOutcome: 'not_completed' },
          { durationEvidence: 'unverified_timing', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null, arrivalOutcome: 'unknown' },
          { durationEvidence: 'unmatched_or_uncompleted_work', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null, arrivalOutcome: 'not_completed' },
        ],
      }],
    });
    // A full-day mileage total (60m) that legitimately exceeds the recorded
    // 45m on-site + the arrival-to-completion span (60m): span(60) -
    // onSite(45) - drive(60) would be -45 if computed — proof the field
    // really is gone, not just usually positive in the other fixtures.
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([
      { technician_id: 'tech1', trip_date: date, duration_minutes: 20, purpose: 'business' },
      { technician_id: 'tech1', trip_date: date, duration_minutes: 20, purpose: 'business' },
      { technician_id: 'tech1', trip_date: date, duration_minutes: 20, purpose: 'unclassified' },
    ]), new Date('2026-09-08T12:00:00Z'));
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

  // Codex P1: quality.days[].byTech (and the old mileage query) were both
  // filtered through applyAssignable, so a deactivated/no-longer-eligible
  // technician's own PAST history silently vanished from their own day.
  test('a deactivated technician with a saved snapshot still shows their PAST history', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [{
        date, technicianId: 'ghost', plannedVisits: 1, plannedServiceMinutes: 60, plannedDriveMinutes: 10,
        plannedWaitingMinutes: 0, plannedReturnMinuteBeforeBreaks: 540, driveModel: 'legacy',
        stops: [{ durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 55, recordedArrivalMinute: 480, recordedCompletionMinute: 540, arrivalOutcome: 'on_time' }],
      }],
    });
    const result = await getDayScorecard({ date_from: date, date_to: date },
      conn([], [{ id: 'ghost', name: 'Former Tech' }]), new Date('2026-09-08T12:00:00Z'));
    const ids = result.days[0].byTech.map(row => row.technicianId);
    expect(ids).toEqual(expect.arrayContaining(['tech1', 'ghost']));
    const ghostRow = result.days[0].byTech.find(row => row.technicianId === 'ghost');
    // Name resolved via the direct, non-applyAssignable technicians lookup —
    // never dropped just because the roster query excludes this technician.
    expect(ghostRow.technician).toBe('Former Tech');
    expect(ghostRow.planned).toMatchObject({ stops: 1, onSiteMinutes: 60 });
    expect(ghostRow.actual).toMatchObject({ onSiteMinutes: 55 });
  });

  test('a deactivated technician with ONLY mileage history (no saved snapshot) still shows a past row', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({ plans: [] });
    // The mileage query itself must not filter by the assignable roster.
    const result = await getDayScorecard({ date_from: date, date_to: date },
      conn([{ technician_id: 'ghost', trip_date: date, duration_minutes: 40, purpose: 'business' }], [{ id: 'ghost', name: 'Former Tech' }]),
      new Date('2026-09-08T12:00:00Z'));
    const ghostRow = result.days[0].byTech.find(row => row.technicianId === 'ghost');
    expect(ghostRow).toBeTruthy();
    expect(ghostRow.technician).toBe('Former Tech');
    expect(ghostRow.planned).toBeNull();
    expect(ghostRow.actual).toMatchObject({ driveMinutes: 40, driveTrips: 1 });
  });

  // Codex P1: onSiteCoverage was built only from plan.stops (the saved
  // snapshot), so a job added to the route after the snapshot and completed
  // the same day was invisible — covered/total read as full when real,
  // uncounted work happened. route-performance.js's getRoutePerformance
  // reports this per route as plan.unbaselinedCompletedVisits; day-scorecard
  // must carry it through as onSiteCoverage.unbaselined rather than drop it.
  test('a same-day added job completed outside the saved snapshot is carried as onSiteCoverage.unbaselined', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [{
        date, technicianId: 'tech1', plannedVisits: 2, plannedServiceMinutes: 90, plannedDriveMinutes: 25,
        plannedWaitingMinutes: 5, plannedReturnMinuteBeforeBreaks: 600, driveModel: 'legacy',
        unbaselinedCompletedVisits: 1,
        stops: [
          { durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 480, recordedCompletionMinute: 540, arrivalOutcome: 'on_time' },
          { durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 540, recordedCompletionMinute: 600, arrivalOutcome: 'on_time' },
        ],
      }],
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech[0];
    // Full coverage on the SNAPSHOT's own two stops, but a third, unbaselined
    // completed job existed that day and is not folded into onSiteMinutes.
    expect(row.actual.onSiteCoverage).toEqual({ covered: 2, total: 2, unbaselined: 1 });
    // 2 planned-and-completed stops + the 1 same-day unbaselined completion.
    expect(row.actual.stops).toBe(3);
  });

  // Codex P1 (round 4): measureRoutePerformance forces durationEvidence to
  // 'unmatched_or_uncompleted_work' for ANY grouped stop, completed or not
  // (a visit_id group's real duration is a SUM this reader does not
  // re-compose) — filtering the completed count on durationEvidence
  // silently dropped every completed grouped stop, so an all-grouped day
  // read as zero actual stops even with full coverage. The fix keys off
  // arrivalOutcome instead, which is only 'grouped_work_requires_review'
  // (not one of the NOT-completed outcomes) when the row really was
  // completed on this route.
  test('a completed grouped stop still counts toward actual.stops, and coverage never accepts its duration', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [{
        date, technicianId: 'tech1', plannedVisits: 2, plannedServiceMinutes: 90, plannedDriveMinutes: 20,
        plannedWaitingMinutes: 0, plannedReturnMinuteBeforeBreaks: 560, driveModel: 'legacy',
        stops: [
          // A completed member of a visit_id group: real completion, but
          // measureRoutePerformance never trusts ITS OWN duration/coverage.
          { durationEvidence: 'unmatched_or_uncompleted_work', recordedServiceMinutes: null, recordedArrivalMinute: null, recordedCompletionMinute: null, arrivalOutcome: 'grouped_work_requires_review' },
          { durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 480, recordedCompletionMinute: 540, arrivalOutcome: 'on_time' },
        ],
      }],
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech[0];
    // Both stops completed (2), not just the ungrouped one (the pre-fix bug
    // would have reported 1). Coverage still only accepts the ungrouped
    // stop's evidence — the grouped one never inflates onSiteMinutes.
    expect(row.actual).toMatchObject({ stops: 2, onSiteMinutes: 45, onSiteCoverage: { covered: 1, total: 2, unbaselined: 0 } });
  });

  test('a plan with no unbaselined completed visits reports unbaselined: 0, not undefined', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [{
        date, technicianId: 'tech1', plannedVisits: 1, plannedServiceMinutes: 60, plannedDriveMinutes: 10,
        plannedWaitingMinutes: 0, plannedReturnMinuteBeforeBreaks: 540, driveModel: 'legacy',
        stops: [{ durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 55, recordedArrivalMinute: 480, recordedCompletionMinute: 540, arrivalOutcome: 'on_time' }],
      }],
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    expect(result.days[0].byTech[0].actual.onSiteCoverage.unbaselined).toBe(0);
  });

  // Codex P1: getRoutePerformance keeps only the newest 500 planner runs;
  // future-dated runs (the nightly D+1..D+6 reorder) can evict a genuinely
  // past baseline and a truncated caller has no way to tell "never had a
  // plan" from "had one, evicted" apart — the response must say so.
  test('a truncated planner-runs read marks a null-planned row distinctly from a definite no-saved-plan', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({ plans: [], missingBaselineRoutes: [], truncatedPlanningRuns: true });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    expect(result.truncatedPlanningRuns).toBe(true);
    const row = result.days[0].byTech.find(r => r.technicianId === 'tech1');
    expect(row.planned).toBeNull();
    expect(row.plannedUnavailableReason).toBe('may_be_truncated');
  });

  test('an untruncated planner-runs read marks a null-planned row as a definite no-saved-plan', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({ plans: [], missingBaselineRoutes: [], truncatedPlanningRuns: false });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    expect(result.truncatedPlanningRuns).toBe(false);
    const row = result.days[0].byTech.find(r => r.technicianId === 'tech1');
    expect(row.plannedUnavailableReason).toBe('no_saved_plan');
  });

  test('a plan already carries a baseline, so plannedUnavailableReason is null regardless of truncation', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [{ date, technicianId: 'tech1', plannedVisits: 1, plannedServiceMinutes: 60, plannedDriveMinutes: 10,
        plannedWaitingMinutes: 0, plannedReturnMinuteBeforeBreaks: 540, driveModel: 'legacy',
        stops: [{ durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 55, recordedArrivalMinute: 480, recordedCompletionMinute: 540, arrivalOutcome: 'on_time' }] }],
      missingBaselineRoutes: [], truncatedPlanningRuns: true,
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    expect(result.days[0].byTech[0].plannedUnavailableReason).toBeNull();
  });

  // Codex P1: a range that includes today/future dates was still sent to
  // getRoutePerformance unclamped, letting future-dated planner runs compete
  // for its cap even though the future side of the scorecard never reads
  // `performance` at all.
  test('getRoutePerformance is called with to clamped to yesterday when the requested range reaches into today/future', async () => {
    const from = '2026-09-01';
    const to = '2026-09-10'; // "today" below is 2026-09-08
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [
        { date: '2026-09-01', closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] },
        { date: '2026-09-10', closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One', scheduledVisits: 0, serviceMinutes: 0, modeledLateVisits: [] }] },
      ],
    });
    getRoutePerformance.mockResolvedValue({ plans: [], missingBaselineRoutes: [], truncatedPlanningRuns: false });
    await getDayScorecard({ date_from: from, date_to: to }, conn([]), new Date('2026-09-08T12:00:00Z'));
    expect(getRoutePerformance).toHaveBeenCalledWith(
      expect.objectContaining({ from, to: '2026-09-07' }), expect.any(Function));
  });

  // Codex P1: performance.missingBaselineRoutes is route-performance's own
  // record of "past completed work exists, no covering plan" — a technician
  // who appears ONLY there (no plan, no mileage, e.g. a vehicle-less tech)
  // must still get a row instead of vanishing entirely.
  test('a technicianId known only through missingBaselineRoutes still gets a past row and a resolved name', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [], missingBaselineRoutes: [{ date, technicianId: 'ghost' }], truncatedPlanningRuns: false,
    });
    const result = await getDayScorecard({ date_from: date, date_to: date },
      conn([], [{ id: 'ghost', name: 'Former Tech' }]), new Date('2026-09-08T12:00:00Z'));
    const ghostRow = result.days[0].byTech.find(row => row.technicianId === 'ghost');
    expect(ghostRow).toBeTruthy();
    expect(ghostRow.technician).toBe('Former Tech');
    expect(ghostRow.planned).toBeNull();
  });

  test('a missingBaselineRoutes entry with no technicianId is never turned into a row', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [], missingBaselineRoutes: [{ date, technicianId: null }], truncatedPlanningRuns: false,
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    expect(result.days[0].byTech).toHaveLength(1); // only tech1 (the assignable roster)
  });

  // Codex P1: an offboarding technician can still carry an assigned FUTURE
  // visit; day-quality already tallies work with no assignable technician
  // (unassigned OR assigned to a non-assignable tech) at the day level as
  // unallocatedVisits/unallocatedServiceMinutes — surfaced instead of a
  // fabricated per-tech row this data can't support honestly.
  test('day-level unallocated workload (offboarding/unassigned techs) is passed through for every day', async () => {
    const date = '2026-09-08';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, unallocatedVisits: 2, unallocatedServiceMinutes: 90,
        byTech: [{ technicianId: 'tech1', technician: 'Tech One', scheduledVisits: 1, serviceMinutes: 60, modeledLateVisits: [] }] }],
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn(), new Date(`${date}T12:00:00Z`));
    expect(result.days[0].unallocated).toEqual({ visits: 2, serviceMinutes: 90 });
  });

  // Codex P1: the mileage rollup summed every trip including ones Bouncie
  // classified as personal, inflating "actual drive" with non-work driving.
  test('personal and commute trips are excluded from actual drive minutes; unclassified and business count', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [{
        date, technicianId: 'tech1', plannedVisits: 1, plannedServiceMinutes: 60, plannedDriveMinutes: 10,
        plannedWaitingMinutes: 0, plannedReturnMinuteBeforeBreaks: 540, driveModel: 'legacy',
        stops: [{ durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 55, recordedArrivalMinute: 480, recordedCompletionMinute: 540, arrivalOutcome: 'on_time' }],
      }],
    });
    const rows = [
      { technician_id: 'tech1', trip_date: date, duration_minutes: 20, purpose: 'business' },
      { technician_id: 'tech1', trip_date: date, duration_minutes: 15, purpose: 'unclassified' },
      { technician_id: 'tech1', trip_date: date, duration_minutes: 5, purpose: null },
      { technician_id: 'tech1', trip_date: date, duration_minutes: 100, purpose: 'personal' },
      { technician_id: 'tech1', trip_date: date, duration_minutes: 50, purpose: 'commute' },
    ];
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn(rows), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech.find(r => r.technicianId === 'tech1');
    // 20 (business) + 15 (unclassified) + 5 (no purpose recorded) = 40;
    // personal (100) and commute (50) are never counted as day driving.
    expect(row.actual).toMatchObject({ driveMinutes: 40, driveTrips: 3 });
    // The policy is documented, not silent.
    expect(result.assumptions.actualDriveMinutes).toMatch(/personal/i);
    expect(result.note).toMatch(/personal/i);
  });

  // Codex P2 (round 3): a missing-baseline tech-day (no saved plan at all)
  // still has route-performance's own raw completed-work evidence
  // (missingBaselineStops) — reused for actual on-site minutes/span/stops
  // the SAME way a route WITH a plan is, instead of leaving it at all-null.
  test('a missing-baseline tech-day aggregates actual on-site/span/stops from route-performance\'s own recorded evidence', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    const missingBaselineStops = new Map([[`${date}|tech1`, [
      { appointmentId: 'a', durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 480, recordedCompletionMinute: 540 },
      { appointmentId: 'b', durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 30, recordedArrivalMinute: 540, recordedCompletionMinute: 580 },
    ]]]);
    getRoutePerformance.mockResolvedValue({
      plans: [], missingBaselineRoutes: [{ date, technicianId: 'tech1' }], missingBaselineStops, truncatedPlanningRuns: false,
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech.find(r => r.technicianId === 'tech1');
    expect(row.planned).toBeNull(); // still no saved plan — this is additive, not a fabricated plan
    expect(row.actual).toMatchObject({
      stops: 2, physicalStops: null, onSiteMinutes: 75, // 45 + 30
      onSiteCoverage: { covered: 2, total: 2, unbaselined: 0 },
      spanMinutes: 100, // 580 - 480
    });
  });

  // Codex P1 (round 4): the no-baseline reader (missingBaselineActualStops)
  // used to drop every grouped completed row outright — an all-grouped
  // no-baseline day read as zero actual stops. It now includes them (with a
  // forced non-accepted durationEvidence, matching the has-a-plan path), so
  // actual.stops counts the grouped row too, while onSiteMinutes/coverage
  // still never trust its individual duration.
  test('a missing-baseline tech-day counts a grouped completed row toward stops, never toward on-site minutes', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    const missingBaselineStops = new Map([[`${date}|tech1`, [
      { appointmentId: 'grouped', durationEvidence: 'unmatched_or_uncompleted_work', recordedServiceMinutes: null, recordedArrivalMinute: 480, recordedCompletionMinute: null },
      { appointmentId: 'ungrouped', durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45, recordedArrivalMinute: 540, recordedCompletionMinute: 585 },
    ]]]);
    getRoutePerformance.mockResolvedValue({
      plans: [], missingBaselineRoutes: [{ date, technicianId: 'tech1' }], missingBaselineStops, truncatedPlanningRuns: false,
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech.find(r => r.technicianId === 'tech1');
    expect(row.actual).toMatchObject({ stops: 2, onSiteMinutes: 45, onSiteCoverage: { covered: 1, total: 2 } });
  });

  test('a missing-baseline tech-day with no completed evidence at all still reports null, not zero', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({
      plans: [], missingBaselineRoutes: [{ date, technicianId: 'tech1' }],
      missingBaselineStops: new Map([[`${date}|tech1`, []]]), truncatedPlanningRuns: false,
    });
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech.find(r => r.technicianId === 'tech1');
    expect(row.actual).toMatchObject({ stops: 0, onSiteMinutes: null, spanMinutes: null, onSiteCoverage: { covered: 0, total: 0 } });
  });

  test('a missing-baseline entry with no completed rows at all (getRoutePerformance mock omits the map) does not crash', async () => {
    const date = '2026-09-01';
    getScheduleQualityMeasurements.mockResolvedValue({
      driveModel: 'legacy',
      days: [{ date, closed: false, byTech: [{ technicianId: 'tech1', technician: 'Tech One' }] }],
    });
    getRoutePerformance.mockResolvedValue({ plans: [] }); // no missingBaselineRoutes/missingBaselineStops at all
    const result = await getDayScorecard({ date_from: date, date_to: date }, conn([]), new Date('2026-09-08T12:00:00Z'));
    const row = result.days[0].byTech.find(r => r.technicianId === 'tech1');
    expect(row.planned).toBeNull();
    expect(row.actual).toMatchObject({ stops: null, onSiteMinutes: null });
  });
});
