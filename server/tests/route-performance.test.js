jest.mock('../models/db', () => ({}));
const { recordedTiming, selectPlanningSnapshots, measureRoutePerformance } = require('../services/scheduling/route-performance');

const day = '2026-09-08';
const snapshot = { date: day, technician_id: 'tech', as_of: '2026-09-07T08:20:00Z', snapshot_phase: 'loaded_schedule',
  plannedStops: [{ id: 'visit', arrivalWindow: { startMin: 480, endMin: 600 }, serviceMinutes: 60, predictedArrivalMinute: 480 }] };
const recorded = (extra = {}) => ({ id: 'visit', technician_id: 'tech', scheduled_date: day, status: 'completed', window_start: '08:00',
  actual_start_time: '2026-09-08T12:10:00Z', actual_end_time: '2026-09-08T12:55:00Z',
  service_time_minutes: 60, completionNotes: { timeOnSite: '45:00' },
  statusHistory: [
    { from_status: 'confirmed', to_status: 'on_site', transitioned_at: '2026-09-08T12:10:01Z' },
    { from_status: 'on_site', to_status: 'completed', transitioned_at: '2026-09-08T12:55:02Z' },
  ], ...extra });

test('a corroborated interval compares with the saved estimate and prediction, not a later estimate', () => {
  const result = measureRoutePerformance(snapshot, [recorded({ estimated_duration_minutes: 5 })]);
  expect(result).toMatchObject({ knownArrivals: 1, unscoredArrivals: 0, onTimeRate: 1,
    comparableDurations: 1, lastRecordedCompletionMinute: 535,
    serviceErrorByEvidence: { recorded_lifecycle_interval: { visits: 1, meanAbsoluteErrorMinutes: 15 } },
    actualDriveMinutes: null, actualWaitingMinutes: null, actualReturnMinute: null });
  expect(result.stops[0]).toMatchObject({ arrivalOutcome: 'on_time', recordedArrivalMinute: 490,
    arrivalPredictionErrorMinutes: 10, plannedServiceMinutes: 60, recordedServiceMinutes: 45,
    durationEvidence: 'recorded_lifecycle_interval', servicePredictionErrorMinutes: -15 });
});

test('unknown and uncompleted arrivals cannot inflate the on-time denominator', () => {
  const rows = [recorded(), recorded({ id: 'unknown', statusHistory: [] }), recorded({ id: 'pending', status: 'pending' })];
  const plan = { ...snapshot, plannedStops: rows.map(row => ({ ...snapshot.plannedStops[0], id: row.id })) };
  const result = measureRoutePerformance(plan, rows);
  expect(result).toMatchObject({ knownArrivals: 1, unscoredArrivals: 2, onTimeRate: 1,
    arrivalCounts: { on_time: 1, unknown: 1, not_completed: 1 }, lastRecordedCompletionMinute: null });
  expect(result.stops[1]).toMatchObject({ recordedServiceMinutes: null, durationEvidence: 'unverified_timing' });
});

test('corrected, operator-reported and backfilled durations retain separate evidence', () => {
  expect(recordedTiming(recorded({ time_on_site_adjusted_minutes: 30 }))).toMatchObject({ durationMinutes: 30,
    durationEvidence: 'operator_corrected', completion: null });
  expect(recordedTiming(recorded({ completionNotes: { timeOnSite: 35 }, statusHistory: [] }))).toMatchObject({ durationMinutes: 35,
    durationEvidence: 'operator_reported', arrival: null, completion: null });
  expect(recordedTiming(recorded({ completionNotes: JSON.stringify({ backfill: true, timeOnSite: 40 }) }))).toMatchObject({ durationMinutes: 40,
    durationEvidence: 'backfill_reported', arrival: null, completion: null });
  expect(recordedTiming(recorded({ completionNotes: { backfill: true }, actual_end_time: '2026-10-08T12:55:00Z' })))
    .toMatchObject({ durationMinutes: null, durationEvidence: 'backfill_unknown', arrival: null });
});

test('an inferred start or ambiguous/reconstructed status history is not a measured arrival', () => {
  const row = recorded();
  for (const statusHistory of [[], row.statusHistory.map(event => ({ ...event, from_status: null })), [...row.statusHistory, row.statusHistory[0]]]) {
    expect(recordedTiming({ ...row, statusHistory })).toMatchObject({ arrival: null, durationMinutes: null, durationEvidence: 'unverified_timing' });
  }
  expect(recordedTiming(recorded({ actual_start_time: '2026-09-08T11:00:00Z' })).arrival).toBeNull();
});

test('changed promises and route membership are visible instead of scored as missed or kept promises', () => {
  expect(measureRoutePerformance(snapshot, [recorded({ window_start: '09:00' })])).toMatchObject({ knownArrivals: 0, onTimeRate: null,
    arrivalCounts: { promise_changed: 1 }, comparableDurations: 1 });
  expect(measureRoutePerformance(snapshot, [recorded({ scheduled_date: '2026-09-09' })]).arrivalCounts).toEqual({ day_or_technician_changed: 1 });
  expect(measureRoutePerformance(snapshot, [recorded({ technician_id: 'other' })]).comparableDurations).toBe(0);
  expect(measureRoutePerformance(snapshot, [recorded({ visit_id: 'group' })]).arrivalCounts).toEqual({ grouped_work_requires_review: 1 });
  expect(measureRoutePerformance(snapshot, []).arrivalCounts).toEqual({ missing_visit: 1 });
});

test('late arrival minutes use the immutable two-hour deadline in Eastern time', () => {
  const row = recorded({ actual_start_time: '2026-09-08T14:10:00Z', actual_end_time: '2026-09-08T14:55:00Z',
    statusHistory: [
      { from_status: 'confirmed', to_status: 'on_site', transitioned_at: '2026-09-08T14:10:00Z' },
      { from_status: 'on_site', to_status: 'completed', transitioned_at: '2026-09-08T14:55:00Z' },
    ] });
  expect(measureRoutePerformance(snapshot, [row]).stops[0]).toMatchObject({ arrivalOutcome: 'late', lateMinutes: 10, recordedArrivalMinute: 610 });
});

test('an arrival just after the deadline is not rounded into the on-time numerator', () => {
  const row = recorded({ actual_start_time: '2026-09-08T14:00:30Z', actual_end_time: '2026-09-08T14:45:30Z',
    statusHistory: [
      { from_status: 'confirmed', to_status: 'on_site', transitioned_at: '2026-09-08T14:00:30Z' },
      { from_status: 'on_site', to_status: 'completed', transitioned_at: '2026-09-08T14:45:30Z' },
    ] });
  expect(measureRoutePerformance(snapshot, [row])).toMatchObject({ onTimeRate: 0,
    stops: [expect.objectContaining({ arrivalOutcome: 'late', lateMinutes: 0.5 })] });
});

test('snapshot selection prefers the applied order and refuses plans recorded during/after service', () => {
  const run = { id: 'run', created_at: snapshot.as_of, result: { route_quality: [snapshot, { ...snapshot, snapshot_phase: 'applied_reorder' }] } };
  const after = { id: 'hindsight', created_at: '2026-09-08T13:00:00Z', result: { route_quality: [{ ...snapshot, as_of: '2026-09-08T12:00:00Z' }] } };
  const forgedEarlierAsOf = { ...after, id: 'late-ledger', result: { route_quality: [snapshot] } };
  const result = selectPlanningSnapshots([after, forgedEarlierAsOf, run], { from: day, to: day, now: new Date('2026-09-09T12:00:00Z') });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ planningRunId: 'run', snapshot_phase: 'applied_reorder' });
  expect(selectPlanningSnapshots([run], { from: day, to: day, now: new Date('2026-09-08T12:00:00Z') })).toEqual([]);
});

test('malformed or duplicated baseline stops remain missing evidence instead of double-counting performance', () => {
  const run = { id: 'bad', created_at: snapshot.as_of, result: { route_quality: [null, { ...snapshot, plannedStops: [null] },
    { ...snapshot, plannedStops: [snapshot.plannedStops[0], snapshot.plannedStops[0]] }] } };
  expect(selectPlanningSnapshots([run], { from: day, to: day, now: new Date('2026-09-09T12:00:00Z') })).toEqual([]);
});
