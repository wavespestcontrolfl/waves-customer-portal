jest.mock('../models/db', () => ({}));
const { lifecycleMinutes, physicalVisitCount, recordedTiming, selectPlanningSnapshots, measureRoutePerformance, missingBaselineActualStops, getRoutePerformance, getSavedDayPlans } = require('../services/scheduling/route-performance');

const routeKey = (date, technicianId) => `${date}|${technicianId || ''}`;

const day = '2026-09-08';
// A snapshot's technician_id must be a real UUID (Codex P2, round 11) — this
// fixture stands in for a real technicians.id everywhere a plan/snapshot
// object flows through selectPlanningSnapshots; `recorded()`'s row default
// below is kept equal to it so the sameRoute match in measureRoutePerformance
// tests still holds.
const techId = '22222222-2222-4222-8222-222222222222';
const snapshot = { date: day, technician_id: techId, as_of: '2026-09-07T08:20:00Z', snapshot_phase: 'loaded_schedule',
  plannedStops: [{ id: 'visit', arrivalWindow: { startMin: 480, endMin: 600 }, serviceMinutes: 60, predictedArrivalMinute: 480 }] };
const recorded = (extra = {}) => ({ id: 'visit', technician_id: techId, scheduled_date: day, status: 'completed', window_start: '08:00',
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

// Codex P2 (round 11): technician_id must be null or a real UUID. A bare
// typeof-string check let '' through, and this function's own dedupe key
// (`${plan.date}|${plan.technician_id}`) plus routeKey's `technicianId || ''`
// both collapse '' the same way a genuinely null technician_id does — a
// corrupted snapshot could otherwise be read as the real Unassigned route's
// own saved plan. Any other non-UUID, non-null value is refused the same way.
test('a snapshot with an empty-string, non-UUID, or otherwise malformed technician_id is refused', () => {
  const from = { from: day, to: day, now: new Date('2026-09-09T12:00:00Z') };
  const runFor = (technicianId) => ({ id: 'run', created_at: snapshot.as_of,
    result: { route_quality: [{ ...snapshot, technician_id: technicianId }] } });
  expect(selectPlanningSnapshots([runFor('')], from)).toEqual([]);
  expect(selectPlanningSnapshots([runFor('not-a-uuid')], from)).toEqual([]);
  expect(selectPlanningSnapshots([runFor(42)], from)).toEqual([]);
  expect(selectPlanningSnapshots([runFor(undefined)], from)).toEqual([]);
  // A genuinely null technician_id is accepted (no production writer emits
  // one today, but the validator treats it as a real value, not malformed).
  expect(selectPlanningSnapshots([runFor(null)], from)).toHaveLength(1);
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

// Codex pre-push P1: every stop shape carries its group identity (null when
// ungrouped) so the scorecard can collapse a completed multi-service visit
// the same way the saved plan's plannedPhysicalStops does. The recorded
// row's own visit_id wins over the snapshot's.
test('plan stops carry visitId (recorded row first, else the snapshot\'s; null when ungrouped)', () => {
  const plan = { ...snapshot, plannedStops: [
    { ...snapshot.plannedStops[0], id: 'a', visitId: 'group-1' },
    { ...snapshot.plannedStops[0], id: 'b', visitId: null },
    { ...snapshot.plannedStops[0], id: 'c', visitId: null },
  ] };
  const stops = measureRoutePerformance(plan, [recorded({ id: 'a', visit_id: 'group-1' }), recorded({ id: 'b', visit_id: 'regrouped' }), recorded({ id: 'c' })]).stops;
  expect(stops.map(stop => stop.visitId)).toEqual(['group-1', 'regrouped', null]);
  expect(measureRoutePerformance(plan, []).stops[0].visitId).toBe('group-1');
});

// Codex P2 (round 9): a group dissolved after the snapshot leaves the
// current row with visit_id null — that explicit null wins; the snapshot's
// membership is used only when no current row exists.
test('a current row\'s null visit_id wins over the snapshot\'s stale group', () => {
  const plan = { ...snapshot, plannedStops: [{ ...snapshot.plannedStops[0], visitId: 'group-1' }] };
  const [dissolved] = measureRoutePerformance(plan, [recorded({ visit_id: null })]).stops;
  expect(dissolved).toMatchObject({ visitId: null, arrivalOutcome: 'on_time',
    durationEvidence: 'recorded_lifecycle_interval', recordedServiceMinutes: 45 });
  expect(measureRoutePerformance(plan, []).stops[0].visitId).toBe('group-1');
});

// Codex P2 (round 9): the snapshot and the recorded rows can't recognize a
// same-property co-visit or a V2 allocation (no customer/premise/allocation
// evidence); both need a shared window start, so two ungrouped rows sharing
// one — or both lacking one — make the physical count unknown, not a
// per-row overstatement.
test('physicalVisitCount is null unless every ungrouped row has a distinct window start', () => {
  expect(physicalVisitCount([{ visitId: 'v' }, { visitId: 'v' }, { visitId: null, windowStartMin: 480 },
    { visitId: null, windowStartMin: 600 }])).toBe(3);
  expect(physicalVisitCount([{ visitId: null, windowStartMin: 480 }, { visitId: null, windowStartMin: 480 }])).toBeNull();
  expect(physicalVisitCount([{ visitId: null, windowStartMin: null }, { visitId: null }])).toBeNull();
  // Grouped rows sharing a window never make it ambiguous.
  expect(physicalVisitCount([{ visitId: 'v', windowStartMin: 480 }, { visitId: 'v', windowStartMin: 480 },
    { visitId: null, windowStartMin: 480 }])).toBe(2);
  const sameWindow = { ...snapshot, plannedStops: [{ ...snapshot.plannedStops[0], id: 'a' }, { ...snapshot.plannedStops[0], id: 'b' }] };
  expect(measureRoutePerformance(sameWindow, []).plannedPhysicalStops).toBeNull();
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
  // Distinct real UUIDs (Codex P2, round 11 — a snapshot's own technician_id
  // is validated too) standing in for the old 'tech-ok'/'tech-empty'/
  // 'tech-garbage' labels, so this test still isolates the STOP-id check.
  const techOk = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const techEmpty = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const techGarbage = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const plan = (technicianId, id) => ({ ...snapshot, technician_id: technicianId, plannedStops: [{ ...snapshot.plannedStops[0], id }] });
  const run = { id: 'run', created_at: snapshot.as_of,
    result: { route_quality: [plan(techOk, goodId), plan(techEmpty, ''), plan(techGarbage, 'not-a-uuid')] } };
  const { conn, calls } = recordingConn({ route_optimization_planner_runs: [run] });
  const result = await getRoutePerformance({ from: day, to: day, now: new Date('2026-09-09T12:00:00Z') }, conn);
  const idQuery = calls.find(([table, method, column]) => table === 'scheduled_services' && method === 'whereIn' && column === 'id');
  expect(idQuery[3]).toEqual([goodId]);
  expect(result.plans.map(measured => measured.technicianId)).toEqual([techOk]);
});

// Codex P2 (round 7): the scorecard's TODAY row reads the saved pre-service
// plan (the live board drops completed visits). Only a snapshot captured
// before the day's midnight counts; getRoutePerformance still never measures
// a day that isn't over.
// Updated (Codex P2, round 10): plannedPassthrough now also carries
// plannedLateVisits and plannedStopIds, so this exact shape gained the two
// new keys (null here — `plan` never sets modeledLateVisits).
// Updated (Codex P2, round 11): technician_id must be a real UUID now, so
// the old 'tech'/'late' labels became two distinct UUIDs.
test('getSavedDayPlans returns today\'s pre-service plan per technician, planned numbers only', async () => {
  const goodId = '11111111-1111-4111-8111-111111111111';
  const lateTechId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const plan = (technicianId, asOf) => ({ ...snapshot, technician_id: technicianId, as_of: asOf, serviceMinutes: 60,
    modeledDriveMinutes: 20, modeledWaitingMinutes: 5, modeledReturnMinuteBeforeBreaks: 600, drive_model: 'calibrated',
    plannedStops: [{ ...snapshot.plannedStops[0], id: goodId }] });
  const before = { id: 'before', created_at: snapshot.as_of, result: { route_quality: [plan(techId, snapshot.as_of)] } };
  const during = { id: 'during', created_at: '2026-09-08T15:00:00Z', result: { route_quality: [plan(lateTechId, '2026-09-08T14:00:00Z')] } };
  const now = new Date('2026-09-08T16:00:00Z'); // `day` is today
  const { conn } = recordingConn({ route_optimization_planner_runs: [during, before] });
  const plans = await getSavedDayPlans({ date: day, now }, conn);
  expect([...plans.keys()]).toEqual([techId]);
  expect(plans.get(techId)).toEqual({ plannedVisits: 1, plannedPhysicalStops: 1, plannedServiceMinutes: 60, plannedDriveMinutes: 20,
    plannedWaitingMinutes: 5, plannedReturnMinuteBeforeBreaks: 600, driveModel: 'calibrated',
    plannedLateVisits: null, plannedStopIds: [goodId] });
  expect(selectPlanningSnapshots([before], { from: day, to: day, now })).toEqual([]);
});

// Codex P2 (round 10): the snapshot's own modeled lateness count and stop
// ids pass through (plannedPassthrough, shared by measureRoutePerformance
// and getSavedDayPlans), rather than day-scorecard.js hard-coding lateVisits
// to null for every saved-plan row.
test('measureRoutePerformance carries modeledLateVisits and plannedStops through as plannedLateVisits/plannedStopIds', () => {
  const late = { ...snapshot, modeledLateVisits: [{ id: 'visit', lateMinutes: 10 }] };
  expect(measureRoutePerformance(late, [])).toMatchObject({ plannedLateVisits: 1, plannedStopIds: ['visit'] });
  // A snapshot that never simulated lateness (missing coordinates/grouped
  // work at capture time) leaves modeledLateVisits null — passed through as
  // null, never invented as 0.
  expect(measureRoutePerformance(snapshot, [])).toMatchObject({ plannedLateVisits: null });
});

// Codex P2 (round 3): a missing-baseline tech-day (no saved plan) still has
// raw completed work — shaped like a plan's own `stops` so day-scorecard.js
// can reuse the SAME actual-minutes aggregation instead of a second formula.
describe('missingBaselineActualStops', () => {
  const routes = [{ date: day, technicianId: techId }];

  test('only completed rows for the matching date+technician are included (grouped ones too)', () => {
    const rows = [
      recorded({ id: 'a' }),
      recorded({ id: 'wrong-date', scheduled_date: '2026-09-09' }),
      recorded({ id: 'wrong-tech', technician_id: 'other' }),
      recorded({ id: 'not-completed', status: 'confirmed' }),
      recorded({ id: 'grouped', visit_id: 'group-1' }),
    ];
    const byKey = missingBaselineActualStops(routes, rows, routeKey);
    const stops = byKey.get(routeKey(day, techId));
    // Codex P1: a completed grouped row must still count as a completed
    // stop for the tech-day — dropping it entirely (the old behavior) made
    // an all-grouped no-baseline day read as zero actual stops.
    expect(stops.map(stop => stop.appointmentId).sort()).toEqual(['a', 'grouped']);
  });

  test('a grouped completed row counts as a stop but never contributes an accepted duration', () => {
    const stops = missingBaselineActualStops(routes, [recorded({ id: 'a', visit_id: 'group-1' })], routeKey).get(routeKey(day, techId));
    // A visit_id group's real duration is a SUM across members this reader
    // does not re-compose, so the row's OWN recordedTiming is never trusted
    // as its on-site minutes — same forcing measureRoutePerformance applies
    // to a grouped plan stop ('unmatched_or_uncompleted_work', null).
    expect(stops).toEqual([{ appointmentId: 'a', visitId: 'group-1', windowStartMin: 480, durationEvidence: 'unmatched_or_uncompleted_work',
      recordedServiceMinutes: null, recordedArrivalMinute: 490, recordedCompletionMinute: 535 }]);
  });

  test('each completed row is shaped like a plan stop, with recordedTiming\'s own evidence', () => {
    const stops = missingBaselineActualStops(routes, [recorded({ id: 'a' })], routeKey).get(routeKey(day, techId));
    expect(stops).toEqual([{ appointmentId: 'a', visitId: null, windowStartMin: 480, durationEvidence: 'recorded_lifecycle_interval',
      recordedServiceMinutes: 45, recordedArrivalMinute: 490, recordedCompletionMinute: 535 }]);
  });

  test('a route with no matching completed work gets an empty array, not undefined', () => {
    const stops = missingBaselineActualStops(routes, [], routeKey).get(routeKey(day, techId));
    expect(stops).toEqual([]);
  });

  test('a null-technician route (unassigned work) matches rows with no technician_id', () => {
    const nullTechRoutes = [{ date: day, technicianId: null }];
    const rows = [recorded({ id: 'a', technician_id: null }), recorded({ id: 'b', technician_id: techId })];
    const stops = missingBaselineActualStops(nullTechRoutes, rows, routeKey).get(routeKey(day, null));
    expect(stops.map(stop => stop.appointmentId)).toEqual(['a']);
  });

  test('independent routes get independently keyed arrays', () => {
    const twoRoutes = [{ date: day, technicianId: techId }, { date: '2026-09-09', technicianId: techId }];
    const rows = [recorded({ id: 'a' }), recorded({ id: 'b', scheduled_date: '2026-09-09' })];
    const byKey = missingBaselineActualStops(twoRoutes, rows, routeKey);
    expect(byKey.get(routeKey(day, techId)).map(stop => stop.appointmentId)).toEqual(['a']);
    expect(byKey.get(routeKey('2026-09-09', techId)).map(stop => stop.appointmentId)).toEqual(['b']);
  });
});
