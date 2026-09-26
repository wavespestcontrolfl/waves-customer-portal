jest.mock('../models/db', () => ({}));
const { lifecycleMinutes, recordedTiming, selectPlanningSnapshots, measureRoutePerformance, missingBaselineActualStops, getRoutePerformance, getSavedDayPlans } = require('../services/scheduling/route-performance');

const routeKey = (date, technicianId) => `${date}|${technicianId || ''}`;

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

// Codex P2 (round 6): grouped work's DURATION is never comparable, so its
// recorded* minutes stay null — but a completed grouped row's corroborated
// arrival/completion still happened on this route and is carried as
// lifecycle* for a caller's day span. Work not completed on this route
// carries none.
test('a completed grouped stop carries its lifecycle arrival/completion separately from the comparable fields', () => {
  const [grouped] = measureRoutePerformance(snapshot, [recorded({ visit_id: 'group' })]).stops;
  expect(grouped).toMatchObject({ arrivalOutcome: 'grouped_work_requires_review', recordedArrivalMinute: null,
    recordedCompletionMinute: null, recordedServiceMinutes: null, lifecycleArrivalMinute: 490, lifecycleCompletionMinute: 535 });
  expect(measureRoutePerformance(snapshot, [recorded()]).stops[0])
    .toMatchObject({ recordedArrivalMinute: 490, lifecycleArrivalMinute: 490, lifecycleCompletionMinute: 535 });
  for (const row of [recorded({ status: 'pending' }), recorded({ technician_id: 'other' })]) {
    expect(measureRoutePerformance(snapshot, [row]).stops[0]).toMatchObject({ lifecycleArrivalMinute: null, lifecycleCompletionMinute: null });
  }
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

// Codex P2 (round 8): planned stops sharing a visitId are one physical
// visit on the saved plan too, matching the live board's physicalStopCount.
test('a saved plan reports planned physical stops with visitId groups collapsed', () => {
  const plan = { ...snapshot, plannedStops: [
    { ...snapshot.plannedStops[0], id: 'a', visitId: 'group-1' },
    { ...snapshot.plannedStops[0], id: 'b', visitId: 'group-1' },
    { ...snapshot.plannedStops[0], id: 'c', visitId: null },
  ] };
  expect(measureRoutePerformance(plan, [])).toMatchObject({ plannedVisits: 3, plannedPhysicalStops: 2 });
});

// Codex P2 (round 8): minutes are measured from the SERVICE day's midnight,
// so a boundary stamped on the next ET day reads 1440+ and a span taken
// from them stays positive (23:30 -> 00:30 is 60 minutes, never -1380).
// recordedTiming itself refuses a completion dated after the service day,
// so a real cross-midnight visit reads as an unknown completion, never a
// negative span.
test('lifecycle minutes carry a day offset past ET midnight; a real cross-midnight visit never goes negative', () => {
  const row = { scheduled_date: day };
  const crossing = lifecycleMinutes({ arrival: new Date('2026-09-09T03:30:00Z'), completion: new Date('2026-09-09T04:30:00Z') }, row);
  expect(crossing).toEqual({ arrival: 1410, completion: 1470 });
  expect(crossing.completion - crossing.arrival).toBe(60);

  const late = recorded({ actual_start_time: '2026-09-09T03:30:00Z', actual_end_time: '2026-09-09T04:30:00Z', completionNotes: {},
    statusHistory: [
      { from_status: 'confirmed', to_status: 'on_site', transitioned_at: '2026-09-09T03:30:00Z' },
      { from_status: 'on_site', to_status: 'completed', transitioned_at: '2026-09-09T04:30:00Z' },
    ] });
  const [stop] = measureRoutePerformance(snapshot, [late]).stops;
  expect(stop.lifecycleArrivalMinute).toBe(1410);
  expect(stop.lifecycleCompletionMinute).toBeNull();
});

// Minimal chainable knex stand-in for getRoutePerformance: records every
// builder call (a where(fn) callback runs against the same builder) and
// resolves select() with the fixture rows for its table.
function recordingConn(tables) {
  const calls = [];
  const conn = table => {
    const builder = { select: async () => tables[table] || [] };
    for (const method of ['whereIn', 'where', 'whereRaw', 'orderBy', 'limit', 'orWhereBetween']) {
      builder[method] = (...args) => {
        calls.push([table, method, ...args]);
        if (typeof args[0] === 'function') args[0](builder);
        return builder;
      };
    }
    return builder;
  };
  return { conn, calls };
}

// Codex P2 (round 6): plannedStops ids are untrusted retained JSONB; an empty
// or corrupted one reached whereIn('id', ...) against the uuid-typed
// scheduled_services.id and raised 22P02, failing the whole read. The
// snapshot is refused like any other malformed one instead.
test('getRoutePerformance refuses a snapshot whose planned stop ids are not UUIDs and never queries them', async () => {
  const goodId = '11111111-1111-4111-8111-111111111111';
  const plan = (technicianId, id) => ({ ...snapshot, technician_id: technicianId, plannedStops: [{ ...snapshot.plannedStops[0], id }] });
  const run = { id: 'run', created_at: snapshot.as_of,
    result: { route_quality: [plan('tech-ok', goodId), plan('tech-empty', ''), plan('tech-garbage', 'not-a-uuid')] } };
  const { conn, calls } = recordingConn({ route_optimization_planner_runs: [run] });
  const result = await getRoutePerformance({ from: day, to: day, now: new Date('2026-09-09T12:00:00Z') }, conn);
  const idQuery = calls.find(([table, method, column]) => table === 'scheduled_services' && method === 'whereIn' && column === 'id');
  expect(idQuery[3]).toEqual([goodId]);
  expect(result.plans.map(measured => measured.technicianId)).toEqual(['tech-ok']);
});

// Codex P2 (round 7): the scorecard's TODAY row reads the saved pre-service
// plan (the live board drops completed visits). Only a snapshot captured
// before the day's midnight counts; getRoutePerformance still never measures
// a day that isn't over.
test('getSavedDayPlans returns today\'s pre-service plan per technician, planned numbers only', async () => {
  const goodId = '11111111-1111-4111-8111-111111111111';
  const plan = (technicianId, asOf) => ({ ...snapshot, technician_id: technicianId, as_of: asOf, serviceMinutes: 60,
    modeledDriveMinutes: 20, modeledWaitingMinutes: 5, modeledReturnMinuteBeforeBreaks: 600, drive_model: 'calibrated',
    plannedStops: [{ ...snapshot.plannedStops[0], id: goodId }] });
  const before = { id: 'before', created_at: snapshot.as_of, result: { route_quality: [plan('tech', snapshot.as_of)] } };
  const during = { id: 'during', created_at: '2026-09-08T15:00:00Z', result: { route_quality: [plan('late', '2026-09-08T14:00:00Z')] } };
  const now = new Date('2026-09-08T16:00:00Z'); // `day` is today
  const { conn } = recordingConn({ route_optimization_planner_runs: [during, before] });
  const plans = await getSavedDayPlans({ date: day, now }, conn);
  expect([...plans.keys()]).toEqual(['tech']);
  expect(plans.get('tech')).toEqual({ plannedVisits: 1, plannedPhysicalStops: 1, plannedServiceMinutes: 60, plannedDriveMinutes: 20,
    plannedWaitingMinutes: 5, plannedReturnMinuteBeforeBreaks: 600, driveModel: 'calibrated' });
  expect(selectPlanningSnapshots([before], { from: day, to: day, now })).toEqual([]);
});

// Codex P2 (round 3): a missing-baseline tech-day (no saved plan) still has
// raw completed work — shaped like a plan's own `stops` so day-scorecard.js
// can reuse the SAME actual-minutes aggregation instead of a second formula.
describe('missingBaselineActualStops', () => {
  const routes = [{ date: day, technicianId: 'tech' }];

  test('only completed rows for the matching date+technician are included (grouped ones too)', () => {
    const rows = [
      recorded({ id: 'a' }),
      recorded({ id: 'wrong-date', scheduled_date: '2026-09-09' }),
      recorded({ id: 'wrong-tech', technician_id: 'other' }),
      recorded({ id: 'not-completed', status: 'confirmed' }),
      recorded({ id: 'grouped', visit_id: 'group-1' }),
    ];
    const byKey = missingBaselineActualStops(routes, rows, routeKey);
    const stops = byKey.get(routeKey(day, 'tech'));
    // Codex P1: a completed grouped row must still count as a completed
    // stop for the tech-day — dropping it entirely (the old behavior) made
    // an all-grouped no-baseline day read as zero actual stops.
    expect(stops.map(stop => stop.appointmentId).sort()).toEqual(['a', 'grouped']);
  });

  test('a grouped completed row counts as a stop but never contributes an accepted duration', () => {
    const stops = missingBaselineActualStops(routes, [recorded({ id: 'a', visit_id: 'group-1' })], routeKey).get(routeKey(day, 'tech'));
    // A visit_id group's real duration is a SUM across members this reader
    // does not re-compose, so the row's OWN recordedTiming is never trusted
    // as its on-site minutes — same forcing measureRoutePerformance applies
    // to a grouped plan stop ('unmatched_or_uncompleted_work', null).
    expect(stops).toEqual([{ appointmentId: 'a', durationEvidence: 'unmatched_or_uncompleted_work',
      recordedServiceMinutes: null, recordedArrivalMinute: 490, recordedCompletionMinute: 535 }]);
  });

  test('each completed row is shaped like a plan stop, with recordedTiming\'s own evidence', () => {
    const stops = missingBaselineActualStops(routes, [recorded({ id: 'a' })], routeKey).get(routeKey(day, 'tech'));
    expect(stops).toEqual([{ appointmentId: 'a', durationEvidence: 'recorded_lifecycle_interval',
      recordedServiceMinutes: 45, recordedArrivalMinute: 490, recordedCompletionMinute: 535 }]);
  });

  test('a route with no matching completed work gets an empty array, not undefined', () => {
    const stops = missingBaselineActualStops(routes, [], routeKey).get(routeKey(day, 'tech'));
    expect(stops).toEqual([]);
  });

  test('a null-technician route (unassigned work) matches rows with no technician_id', () => {
    const nullTechRoutes = [{ date: day, technicianId: null }];
    const rows = [recorded({ id: 'a', technician_id: null }), recorded({ id: 'b', technician_id: 'tech' })];
    const stops = missingBaselineActualStops(nullTechRoutes, rows, routeKey).get(routeKey(day, null));
    expect(stops.map(stop => stop.appointmentId)).toEqual(['a']);
  });

  test('independent routes get independently keyed arrays', () => {
    const twoRoutes = [{ date: day, technicianId: 'tech' }, { date: '2026-09-09', technicianId: 'tech' }];
    const rows = [recorded({ id: 'a' }), recorded({ id: 'b', scheduled_date: '2026-09-09' })];
    const byKey = missingBaselineActualStops(twoRoutes, rows, routeKey);
    expect(byKey.get(routeKey(day, 'tech')).map(stop => stop.appointmentId)).toEqual(['a']);
    expect(byKey.get(routeKey('2026-09-09', 'tech')).map(stop => stop.appointmentId)).toEqual(['b']);
  });
});
