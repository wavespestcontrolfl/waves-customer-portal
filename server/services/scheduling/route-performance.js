/** Read-only reconciliation of saved planning baselines with recorded work.
 * Status events corroborate lifecycle timestamps; a stored timestamp alone
 * may have been inferred by closeout and is not evidence of a real arrival.
 * This reader never trains a model or changes an appointment. */
const { validate: isUuid } = require('uuid');
const { etDateString, etParts, parseETDateTime, validCalendarDate } = require('../../utils/datetime-et');
const { finiteDate, firstFiniteDate, positiveMinutesBetween, positiveNumber } = require('../../utils/service-duration-capture');
const { minutesFromElapsed } = require('../../utils/duration-minutes');
const { isOperatorTimeOnSite } = require('../completion-attempts');
const { effectiveWindowRange } = require('../route-reorder-window-fit');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { summarizeDurationReferences } = require('./duration-priors');

const MAX_RECORDED_MINUTES = 720; // Same single-visit ceiling as completion corrections.
const EVENT_TOLERANCE_MS = 5 * 60000;

function objectValue(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

function boundedMinutes(value) {
  const minutes = positiveNumber(value);
  return minutes != null && minutes <= MAX_RECORDED_MINUTES ? minutes : null;
}

function minuteInET(value) {
  const parts = etParts(value);
  return parts.hour * 60 + parts.minute + parts.second / 60;
}

// ET wall-clock minutes measured from the service day's midnight: a stamp on
// a LATER ET date carries +1440 per day (Codex P2, round 8), so a caller
// taking last completion minus first arrival never sees a visit that
// crossed midnight as a negative ~23h span. recordedTiming currently only
// corroborates stamps dated on the service day itself, so today this is
// always the plain minute of day — the offset keeps the arithmetic right
// without depending on that rule.
function minuteOfServiceDay(stamp, serviceDate) {
  const days = Math.round((Date.parse(`${etDateString(stamp)}T00:00:00Z`) - Date.parse(`${serviceDate}T00:00:00Z`)) / 86400000);
  return minuteInET(stamp) + (Number.isFinite(days) ? days * 1440 : 0);
}

// One row's recorded lifecycle arrival/completion as minutes of its service day.
function lifecycleMinutes(timing, row) {
  const serviceDate = dateOnly(row.scheduled_date);
  return { arrival: timing.arrival ? minuteOfServiceDay(timing.arrival, serviceDate) : null,
    completion: timing.completion ? minuteOfServiceDay(timing.completion, serviceDate) : null };
}

function recordedTiming(row) {
  const notes = objectValue(row.completionNotes);
  const typed = boundedMinutes(minutesFromElapsed(notes.timeOnSite));
  const corrected = boundedMinutes(row.time_on_site_adjusted_minutes)
    ?? (notes.timeOnSiteAdjusted === true ? typed : null);
  const events = (row.statusHistory || []).filter(event => event.from_status != null
    && event.from_status !== event.to_status && finiteDate(event.transitioned_at));
  const starts = events.filter(event => event.to_status === 'on_site');
  const ends = events.filter(event => event.to_status === 'completed');
  const start = firstFiniteDate(row.actual_start_time, row.check_in_time, row.arrived_at);
  const end = firstFiniteDate(row.actual_end_time, row.check_out_time, row.completed_at);
  const matches = (stamp, event) => stamp && event
    && Math.abs(stamp.getTime() - new Date(event.transitioned_at).getTime()) <= EVENT_TOLERANCE_MS
    && etDateString(stamp) === dateOnly(row.scheduled_date);
  const arrival = notes.backfill !== true && starts.length === 1 && matches(start, starts[0]) ? start : null;
  const interval = arrival && ends.length === 1 && matches(end, ends[0])
    ? boundedMinutes(positiveMinutesBetween(arrival, end)) : null;

  let durationMinutes = null;
  let durationEvidence = 'missing';
  if (notes.backfill === true) {
    durationMinutes = corrected ?? typed;
    durationEvidence = durationMinutes == null ? 'backfill_unknown' : 'backfill_reported';
  } else if (corrected != null) {
    durationMinutes = corrected;
    durationEvidence = 'operator_corrected';
  } else if (isOperatorTimeOnSite(notes.timeOnSite) && typed != null) {
    durationMinutes = typed;
    durationEvidence = 'operator_reported';
  } else if (interval != null) {
    durationMinutes = interval;
    durationEvidence = 'recorded_lifecycle_interval';
  } else if ([row.service_time_minutes, row.actual_duration_minutes, typed].some(value => boundedMinutes(value) != null) || start || end) {
    durationEvidence = 'unverified_timing';
  }
  return { arrival, durationMinutes, durationEvidence,
    // A corrected duration can imply an end instant; it is not a measured
    // finish. Keep that distinction even when an old status event remains.
    completion: durationEvidence === 'recorded_lifecycle_interval' ? end : null };
}

const anyStringId = id => typeof id === 'string';

// Every planned stop well-formed and unique. `validId` defaults to the plain
// string check; getRoutePerformance passes a UUID check (Codex P2) because
// its plannedIds feed whereIn('id', ...) against the uuid-typed
// scheduled_services.id — an empty or corrupted id in retained JSONB would
// otherwise raise 22P02 and fail the whole read. Such a snapshot is refused
// like any other malformed one, so the route reads as missing a baseline
// instead of half-measured.
function validPlannedStops(plannedStops, validId) {
  const validStops = plannedStops.every(stop => stop && validId(stop.id)
    && Number.isFinite(stop.serviceMinutes) && stop.serviceMinutes > 0
    && (stop.arrivalWindow == null || (Number.isFinite(stop.arrivalWindow.startMin)
      && Number.isFinite(stop.arrivalWindow.endMin) && stop.arrivalWindow.endMin >= stop.arrivalWindow.startMin)));
  return validStops && new Set(plannedStops.map(stop => stop.id)).size === plannedStops.length;
}

// Lexicographic rank comparison: the first differing position decides.
function outranks(rank, previous) {
  const index = rank.findIndex((value, position) => value !== previous[position]);
  return index >= 0 && rank[index] > previous[index];
}

/** Choose the latest snapshot captured BEFORE the service day. The applied
 * order wins its same-run before-image. Never manufacture a historical plan
 * from the schedule as it looks after completion. `includeToday` admits the
 * current day's pre-service snapshot for a planned-only reader
 * (getSavedDayPlans); the capture-before-midnight guard still applies. */
function selectPlanningSnapshots(runs, { from, to, now = new Date(), validStopId = anyStringId, includeToday = false }) {
  const selected = new Map();
  const today = etDateString(now);
  for (const run of runs) {
    const snapshots = objectValue(run.result).route_quality;
    if (!Array.isArray(snapshots)) continue;
    for (const plan of snapshots) {
      if (!plan || !validCalendarDate(plan.date) || !Array.isArray(plan.plannedStops)) continue;
      if (!validPlannedStops(plan.plannedStops, validStopId)) continue;
      const captured = finiteDate(plan.as_of);
      const created = finiteDate(run.created_at);
      const midnight = parseETDateTime(`${plan.date}T00:00`);
      if (!captured || !created || !Number.isFinite(midnight.getTime()) || captured >= midnight || created >= midnight
        || plan.date < from || plan.date > to || plan.date > today || (plan.date === today && !includeToday)
        || typeof plan.technician_id !== 'string') continue;
      const key = `${plan.date}|${plan.technician_id}`;
      const previous = selected.get(key);
      const rank = [captured.getTime(), created.getTime(), plan.snapshot_phase === 'applied_reorder' ? 1 : 0];
      if (!previous || outranks(rank, previous.rank)) {
        selected.set(key, { ...plan, planningRunId: run.id, rank });
      }
    }
  }
  return [...selected.values()].map(({ rank: _rank, ...plan }) => plan)
    .sort((a, b) => a.date.localeCompare(b.date) || a.technician_id.localeCompare(b.technician_id));
}

// Straight passthrough of the SAVED snapshot's own planned numbers (the
// day-quality byTech object route-reorder.js/quality-after-change.js spread
// into the ledger row) — day-scorecard.js's PLANNED-as-of-the-day-before
// column reads these instead of recomputing them, so the scorecard can never
// disagree with what was actually saved.
//
// plannedPhysicalStops (Codex P2, round 8): planned stops sharing a visitId
// are one physical visit (physicalVisitCount), the same collapse the live
// board's physicalStopCount applies. The snapshot keeps only ids/visitIds/windows/
// durations, so a same-property co-visit or a version-2 allocation without
// a visit_id can't be recognized here and still counts per row.
// Rows sharing a visitId are one physical visit; every other row is its
// own. The one rule for both the saved plan's planned stops and the
// scorecard's completed (actual) stops, so the two columns compare alike.
function physicalVisitCount(stops) {
  const grouped = new Set(stops.filter(stop => stop.visitId).map(stop => stop.visitId));
  return stops.filter(stop => !stop.visitId).length + grouped.size;
}

function plannedPassthrough(plan) {
  const finiteOrNull = value => (Number.isFinite(value) ? value : null);
  return {
    plannedPhysicalStops: physicalVisitCount(plan.plannedStops),
    plannedServiceMinutes: finiteOrNull(plan.serviceMinutes),
    plannedDriveMinutes: finiteOrNull(plan.modeledDriveMinutes),
    plannedWaitingMinutes: finiteOrNull(plan.modeledWaitingMinutes),
    plannedReturnMinuteBeforeBreaks: finiteOrNull(plan.modeledReturnMinuteBeforeBreaks),
    driveModel: plan.drive_model || null,
  };
}

function measureRoutePerformance(plan, rows) {
  const actual = new Map(rows.map(row => [row.id, row]));
  const stops = plan.plannedStops.map(stop => {
    const row = actual.get(stop.id);
    const timing = row ? recordedTiming(row) : {};
    const currentWindow = row ? effectiveWindowRange(row) : null;
    const range = stop.arrivalWindow;
    const changedPromise = (range?.startMin ?? null) !== (currentWindow?.startMin ?? null)
      || (range?.endMin ?? null) !== (currentWindow?.endMin ?? null);
    const sameRoute = row && dateOnly(row.scheduled_date) === plan.date && row.technician_id === plan.technician_id;
    const completedOnRoute = sameRoute && row.status === 'completed';
    // The recorded row's own group when it exists (it may have been
    // regrouped since the snapshot), else the snapshot's.
    const visitId = row?.visit_id || stop.visitId || null;
    const comparable = completedOnRoute && !visitId;
    // Grouped (visit_id) work is never comparable — its duration is a
    // SUM-of-members model — but a completed grouped row's own corroborated
    // arrival/completion still happened on this route. Carried separately
    // (Codex P2) so a caller measuring the day's first-arrival-to-last-
    // completion span keeps grouped work that opened or closed the day,
    // without that row ever reading as a comparable duration.
    const lifecycle = completedOnRoute ? lifecycleMinutes(timing, row) : { arrival: null, completion: null };
    let arrivalOutcome = 'unknown';
    if (!row) arrivalOutcome = 'missing_visit';
    else if (!sameRoute) arrivalOutcome = 'day_or_technician_changed';
    else if (row.status !== 'completed') arrivalOutcome = 'not_completed';
    else if (visitId) arrivalOutcome = 'grouped_work_requires_review';
    else if (changedPromise) arrivalOutcome = 'promise_changed';
    else if (!range) arrivalOutcome = 'unpromised';
    else if (timing.arrival) {
      const minute = minuteInET(timing.arrival);
      arrivalOutcome = minute < range.startMin ? 'early' : (minute > range.endMin ? 'late' : 'on_time');
    }
    const scoredArrival = ['early', 'late', 'on_time'].includes(arrivalOutcome);
    const duration = comparable ? timing.durationMinutes ?? null : null;
    return {
      appointmentId: stop.id, arrivalOutcome,
      visitId,
      recordedArrivalMinute: comparable ? lifecycle.arrival : null,
      arrivalEvidence: timing.arrival ? 'lifecycle_corroborated_by_status_event' : 'unknown',
      lateMinutes: scoredArrival ? Math.max(0, minuteInET(timing.arrival) - range.endMin) : null,
      predictedArrivalMinute: stop.predictedArrivalMinute ?? null,
      arrivalPredictionErrorMinutes: scoredArrival && Number.isFinite(stop.predictedArrivalMinute)
        ? minuteInET(timing.arrival) - stop.predictedArrivalMinute : null,
      plannedServiceMinutes: stop.serviceMinutes,
      recordedServiceMinutes: duration,
      durationEvidence: comparable ? timing.durationEvidence : 'unmatched_or_uncompleted_work',
      servicePredictionErrorMinutes: duration != null ? duration - stop.serviceMinutes : null,
      recordedCompletionMinute: comparable ? lifecycle.completion : null,
      lifecycleArrivalMinute: lifecycle.arrival, lifecycleCompletionMinute: lifecycle.completion,
    };
  });
  const arrivalCounts = {};
  const durationEvidenceCounts = {};
  for (const stop of stops) {
    arrivalCounts[stop.arrivalOutcome] = (arrivalCounts[stop.arrivalOutcome] || 0) + 1;
    durationEvidenceCounts[stop.durationEvidence] = (durationEvidenceCounts[stop.durationEvidence] || 0) + 1;
  }
  const knownArrivals = ['on_time', 'early', 'late'].reduce((sum, key) => sum + (arrivalCounts[key] || 0), 0);
  const comparableDurations = stops.filter(stop => stop.servicePredictionErrorMinutes != null);
  const serviceErrorByEvidence = {};
  for (const evidence of Object.keys(durationEvidenceCounts)) {
    const comparable = comparableDurations.filter(stop => stop.durationEvidence === evidence);
    if (comparable.length) serviceErrorByEvidence[evidence] = { visits: comparable.length,
      meanAbsoluteErrorMinutes: comparable.reduce((sum, stop) => sum + Math.abs(stop.servicePredictionErrorMinutes), 0) / comparable.length };
  }
  return {
    date: plan.date, technicianId: plan.technician_id, planningRunId: plan.planningRunId, capturedAt: plan.as_of,
    snapshotPhase: plan.snapshot_phase || 'loaded_schedule',
    plannedVisits: stops.length, arrivalCounts, knownArrivals,
    unscoredArrivals: stops.length - knownArrivals,
    onTimeRate: knownArrivals ? (arrivalCounts.on_time || 0) / knownArrivals : null,
    comparableDurations: comparableDurations.length, durationEvidenceCounts,
    serviceErrorByEvidence,
    lastRecordedCompletionMinute: stops.length && stops.every(stop => stop.recordedCompletionMinute != null)
      ? Math.max(...stops.map(stop => stop.recordedCompletionMinute)) : null,
    ...plannedPassthrough(plan),
    actualDriveMinutes: null, actualWaitingMinutes: null, actualReturnMinute: null,
    stops,
  };
}

function planningRuns(conn, from, to) {
  return conn('route_optimization_planner_runs').whereIn('run_type', ['route_tiers_nightly', 'route_repair_change', 'schedule_quality_change'])
    .where('start_date', '<=', to).where('end_date', '>=', from)
    .whereRaw("jsonb_typeof(result->'route_quality') = 'array'").orderBy('created_at', 'desc').limit(501)
    .select('id', 'created_at', 'result');
}

/** The saved pre-service plan for a day that has already started (today),
 * keyed by technician id — planned numbers only (plannedPassthrough plus the
 * planned stop count). No recorded-work comparison: the day isn't over, so
 * getRoutePerformance deliberately never measures it. Used by the scorecard
 * so today's planned column doesn't shrink as visits complete (the live
 * board excludes completed work). Same newest-500-runs cap and snapshot
 * validation as getRoutePerformance; a technician with no saved plan (or
 * one the cap evicted) is simply absent, and the caller falls back to the
 * live board, labeled as the remaining route. */
async function getSavedDayPlans({ date, now = new Date() }, conn) {
  const runs = await planningRuns(conn, date, date);
  const plans = selectPlanningSnapshots(runs.slice(0, 500), { from: date, to: date, now, validStopId: isUuid, includeToday: true });
  return new Map(plans.map(plan => [plan.technician_id,
    { plannedVisits: plan.plannedStops.length, ...plannedPassthrough(plan) }]));
}

async function getRoutePerformance({ from, to, now = new Date() }, conn) {
  // Range validation is shared with the caller, getScheduleQualityMeasurements.
  const runs = await planningRuns(conn, from, to);
  const plans = selectPlanningSnapshots(runs.slice(0, 500), { from, to, now, validStopId: isUuid });
  const plannedIds = [...new Set(plans.flatMap(plan => plan.plannedStops.map(stop => stop.id)))];
  const rows = await conn('scheduled_services').where(query => query.whereIn('id', plannedIds).orWhereBetween('scheduled_date', [from, to]))
    .select('id', 'customer_id', 'technician_id', 'scheduled_date', 'status', 'visit_id', 'is_callback', 'followup_included', 'window_start', 'time_window',
      'actual_start_time', 'check_in_time', 'arrived_at', 'actual_end_time', 'check_out_time', 'completed_at',
      'service_time_minutes', 'actual_duration_minutes', 'time_on_site_adjusted_minutes');
  const ids = rows.map(row => row.id);
  const records = ids.length ? await conn('service_records').whereIn('scheduled_service_id', ids)
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .select('id', 'scheduled_service_id', 'customer_id', 'structured_notes') : [];
  const attempts = ids.length ? await conn('service_completion_attempts').whereIn('service_id', ids)
    .where('status', 'succeeded').orderBy('updated_at', 'desc').orderBy('id', 'desc')
    .select('service_id', 'service_record_id') : [];
  const events = ids.length ? await conn('job_status_history').whereIn('job_id', ids)
    .whereIn('to_status', ['on_site', 'completed'])
    .select('job_id', 'from_status', 'to_status', 'transitioned_at') : [];
  const enriched = rows.map(row => {
    // Match closeout-status: the succeeded attempt's committed sibling wins
    // over later recap/project records; otherwise use the newest sibling.
    const siblings = records.filter(record => record.scheduled_service_id === row.id && record.customer_id === row.customer_id);
    const pinnedId = attempts.find(attempt => attempt.service_id === row.id)?.service_record_id;
    const record = siblings.find(sibling => sibling.id === pinnedId) || siblings[0];
    return { ...row, completionNotes: record?.structured_notes,
      statusHistory: events.filter(event => event.job_id === row.id) };
  });
  const routeKey = (date, technicianId) => `${date}|${technicianId || ''}`;
  const coveredRoutes = new Map(plans.map(plan => [routeKey(plan.date, plan.technician_id), new Set(plan.plannedStops.map(stop => stop.id))]));
  const today = etDateString(now);
  const pastWork = enriched.filter(row => !NOT_A_ROUTE_STOP_STATUSES.includes(row.status)
    && dateOnly(row.scheduled_date) >= from && dateOnly(row.scheduled_date) <= to && dateOnly(row.scheduled_date) < today);
  // Empty days do not require a route baseline. Report uncovered work, not
  // every weekend or other date on which no visit was scheduled.
  const missingRoutes = new Map();
  for (const row of pastWork) {
    const date = dateOnly(row.scheduled_date);
    const key = routeKey(date, row.technician_id);
    if (!coveredRoutes.has(key)) missingRoutes.set(key, { date, technicianId: row.technician_id || null });
  }
  const missingBaselineRoutes = [...missingRoutes.values()].sort((a, b) => a.date.localeCompare(b.date)
    || String(a.technicianId || '').localeCompare(String(b.technicianId || '')));
  const missingBaselineDates = [...new Set(missingBaselineRoutes.map(route => route.date))];
  // Same tally the top-level unbaselinedCompletedVisits sums, kept per route
  // key too: a route WITH a baseline can still miss a job added (and
  // completed) after the snapshot was captured — a caller measuring "actual"
  // work against `plan.plannedStops` alone would silently omit it (Codex
  // P1 on day-scorecard.js's onSiteCoverage). Stores each unbaselined row's
  // own recorded arrival/completion too (Codex P2, round 5) — the count
  // alone couldn't extend a caller's actual SPAN to include a same-day
  // added job's real arrival/completion; recordedTiming is cheap (already
  // computed for durationReferences below over the same pastWork) so
  // there's no reason to leave it out.
  const unbaselinedByRoute = new Map();
  for (const row of pastWork) {
    if (row.status !== 'completed') continue;
    const key = routeKey(dateOnly(row.scheduled_date), row.technician_id);
    if (coveredRoutes.get(key)?.has(row.id)) continue;
    const lifecycle = lifecycleMinutes(recordedTiming(row), row);
    const entry = unbaselinedByRoute.get(key) || [];
    entry.push({ appointmentId: row.id, visitId: row.visit_id || null,
      recordedArrivalMinute: lifecycle.arrival, recordedCompletionMinute: lifecycle.completion });
    unbaselinedByRoute.set(key, entry);
  }
  return {
    basis: 'saved_pre_service_plan_vs_recorded_work', asOf: now.toISOString(),
    plans: plans.map(plan => {
      const unbaselinedStops = unbaselinedByRoute.get(routeKey(plan.date, plan.technician_id)) || [];
      return { ...measureRoutePerformance(plan, enriched),
        unbaselinedStops, unbaselinedCompletedVisits: unbaselinedStops.length };
    }),
    missingBaselineDates, missingBaselineRoutes,
    // A missing-baseline tech-day (no plan at all) still has raw completed
    // work in `enriched` — shaped exactly like a plan's own `stops`
    // (durationEvidence/recordedServiceMinutes/recordedArrivalMinute/
    // recordedCompletionMinute) so a caller with no saved snapshot can
    // aggregate actual on-site minutes/span the SAME way it does for a route
    // that has one, instead of a second formula (Codex P2). Additive only —
    // every existing field above is unchanged.
    missingBaselineStops: missingBaselineActualStops(missingBaselineRoutes, pastWork, routeKey),
    unbaselinedCompletedVisits: [...unbaselinedByRoute.values()].reduce((sum, entries) => sum + entries.length, 0),
    truncatedPlanningRuns: runs.length > 500,
    durationReferences: summarizeDurationReferences(pastWork, recordedTiming),
    note: 'Unknown arrivals are excluded from the on-time denominator. Duration sources stay separate; no GPS gap is classified as idle and no model is updated.',
  };
}

// Every completed row for the tech-day, GROUPED ones included (Codex P1: an
// all-grouped no-baseline day was dropping every one of its stops, reading
// as zero actual stops with coverage that could still look complete). A
// visit_id group's occupancy/duration is a SUM-of-members model this reader
// does not re-compose, so a grouped row's own recordedTiming is never
// trusted as ITS on-site duration — durationEvidence/recordedServiceMinutes
// are forced the same way measureRoutePerformance's own "comparable" check
// forces them for a grouped plan stop ('unmatched_or_uncompleted_work',
// null) — but the row still counts as a completed stop, and its recorded
// arrival/completion (if any) still counts toward the day's span. Keyed the
// same way coveredRoutes/unbaselinedByRoute are.
function missingBaselineActualStops(routes, pastWork, routeKey) {
  const byKey = new Map();
  for (const route of routes) {
    const completed = pastWork.filter(row => dateOnly(row.scheduled_date) === route.date
      && (row.technician_id || null) === route.technicianId && row.status === 'completed');
    byKey.set(routeKey(route.date, route.technicianId), completed.map(row => {
      const timing = recordedTiming(row);
      const lifecycle = lifecycleMinutes(timing, row);
      return { appointmentId: row.id, visitId: row.visit_id || null,
        durationEvidence: row.visit_id ? 'unmatched_or_uncompleted_work' : timing.durationEvidence,
        recordedServiceMinutes: row.visit_id ? null : timing.durationMinutes,
        recordedArrivalMinute: lifecycle.arrival, recordedCompletionMinute: lifecycle.completion };
    }));
  }
  return byKey;
}

module.exports = { lifecycleMinutes, physicalVisitCount, recordedTiming, selectPlanningSnapshots, measureRoutePerformance, getRoutePerformance, getSavedDayPlans, missingBaselineActualStops };
