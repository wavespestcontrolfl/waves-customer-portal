/** Read-only reconciliation of saved planning baselines with recorded work.
 * Status events corroborate lifecycle timestamps; a stored timestamp alone
 * may have been inferred by closeout and is not evidence of a real arrival.
 * This reader never trains a model or changes an appointment. */
const { etDateString, etParts, parseETDateTime, validCalendarDate } = require('../../utils/datetime-et');
const { finiteDate, firstFiniteDate, positiveMinutesBetween, positiveNumber } = require('../../utils/service-duration-capture');
const { minutesFromElapsed } = require('../../utils/duration-minutes');
const { isOperatorTimeOnSite } = require('../completion-attempts');
const { effectiveWindowRange } = require('../route-reorder-window-fit');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');

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

/** Choose the latest snapshot captured BEFORE the service day. The applied
 * order wins its same-run before-image. Never manufacture a historical plan
 * from the schedule as it looks after completion. */
function selectPlanningSnapshots(runs, { from, to, now = new Date() }) {
  const selected = new Map();
  const today = etDateString(now);
  for (const run of runs) {
    const snapshots = objectValue(run.result).route_quality;
    if (!Array.isArray(snapshots)) continue;
    for (const plan of snapshots) {
      if (!plan || !validCalendarDate(plan.date) || !Array.isArray(plan.plannedStops)) continue;
      const validStops = plan.plannedStops.every(stop => stop && typeof stop.id === 'string'
        && Number.isFinite(stop.serviceMinutes) && stop.serviceMinutes > 0
        && (stop.arrivalWindow == null || (Number.isFinite(stop.arrivalWindow.startMin)
          && Number.isFinite(stop.arrivalWindow.endMin) && stop.arrivalWindow.endMin >= stop.arrivalWindow.startMin)));
      if (!validStops || new Set(plan.plannedStops.map(stop => stop.id)).size !== plan.plannedStops.length) continue;
      const captured = finiteDate(plan.as_of);
      const created = finiteDate(run.created_at);
      const midnight = parseETDateTime(`${plan.date}T00:00`);
      if (!captured || !created || !Number.isFinite(midnight.getTime()) || captured >= midnight || created >= midnight
        || plan.date < from || plan.date > to || plan.date >= today
        || typeof plan.technician_id !== 'string') continue;
      const key = `${plan.date}|${plan.technician_id}`;
      const previous = selected.get(key);
      const rank = [captured.getTime(), created.getTime(), plan.snapshot_phase === 'applied_reorder' ? 1 : 0];
      if (!previous || rank[0] > previous.rank[0] || (rank[0] === previous.rank[0] && (rank[1] > previous.rank[1]
        || (rank[1] === previous.rank[1] && rank[2] > previous.rank[2])))) {
        selected.set(key, { ...plan, planningRunId: run.id, rank });
      }
    }
  }
  return [...selected.values()].map(({ rank: _rank, ...plan }) => plan)
    .sort((a, b) => a.date.localeCompare(b.date) || a.technician_id.localeCompare(b.technician_id));
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
    const comparable = sameRoute && row.status === 'completed' && !row.visit_id && !stop.visitId;
    let arrivalOutcome = 'unknown';
    if (!row) arrivalOutcome = 'missing_visit';
    else if (!sameRoute) arrivalOutcome = 'day_or_technician_changed';
    else if (row.status !== 'completed') arrivalOutcome = 'not_completed';
    else if (row.visit_id || stop.visitId) arrivalOutcome = 'grouped_work_requires_review';
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
      recordedArrivalMinute: comparable && timing.arrival ? minuteInET(timing.arrival) : null,
      arrivalEvidence: timing.arrival ? 'lifecycle_corroborated_by_status_event' : 'unknown',
      lateMinutes: scoredArrival ? Math.max(0, minuteInET(timing.arrival) - range.endMin) : null,
      predictedArrivalMinute: stop.predictedArrivalMinute ?? null,
      arrivalPredictionErrorMinutes: scoredArrival && Number.isFinite(stop.predictedArrivalMinute)
        ? minuteInET(timing.arrival) - stop.predictedArrivalMinute : null,
      plannedServiceMinutes: stop.serviceMinutes,
      recordedServiceMinutes: duration,
      durationEvidence: comparable ? timing.durationEvidence : 'unmatched_or_uncompleted_work',
      servicePredictionErrorMinutes: duration != null ? duration - stop.serviceMinutes : null,
      recordedCompletionMinute: comparable && timing.completion ? minuteInET(timing.completion) : null,
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
    actualDriveMinutes: null, actualWaitingMinutes: null, actualReturnMinute: null,
    stops,
  };
}

async function getRoutePerformance({ from, to, now = new Date() }, conn) {
  // Range validation is shared with the caller, getScheduleQualityMeasurements.
  const runs = await conn('route_optimization_planner_runs').whereIn('run_type', ['route_tiers_nightly', 'route_repair_change', 'schedule_quality_change'])
    .where('start_date', '<=', to).where('end_date', '>=', from)
    .whereRaw("jsonb_typeof(result->'route_quality') = 'array'").orderBy('created_at', 'desc').limit(501)
    .select('id', 'created_at', 'result');
  const plans = selectPlanningSnapshots(runs.slice(0, 500), { from, to, now });
  const plannedIds = [...new Set(plans.flatMap(plan => plan.plannedStops.map(stop => stop.id)))];
  const rows = await conn('scheduled_services').where(query => query.whereIn('id', plannedIds).orWhereBetween('scheduled_date', [from, to]))
    .select('id', 'customer_id', 'technician_id', 'scheduled_date', 'status', 'visit_id', 'window_start', 'time_window',
      'actual_start_time', 'check_in_time', 'arrived_at', 'actual_end_time', 'check_out_time', 'completed_at',
      'service_time_minutes', 'actual_duration_minutes', 'time_on_site_adjusted_minutes');
  const ids = rows.map(row => row.id);
  const records = ids.length ? await conn('service_records').whereIn('scheduled_service_id', ids)
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .select('scheduled_service_id', 'customer_id', 'structured_notes') : [];
  const events = ids.length ? await conn('job_status_history').whereIn('job_id', ids)
    .whereIn('to_status', ['on_site', 'completed'])
    .select('job_id', 'from_status', 'to_status', 'transitioned_at') : [];
  const enriched = rows.map(row => ({ ...row,
    completionNotes: records.find(record => record.scheduled_service_id === row.id && record.customer_id === row.customer_id)?.structured_notes,
    statusHistory: events.filter(event => event.job_id === row.id),
  }));
  const routeKey = (date, technicianId) => `${date}|${technicianId || ''}`;
  const coveredRoutes = new Map(plans.map(plan => [routeKey(plan.date, plan.technician_id), new Set(plan.plannedStops.map(stop => stop.id))]));
  const today = etDateString(now);
  const pastWork = rows.filter(row => !NOT_A_ROUTE_STOP_STATUSES.includes(row.status)
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
  return {
    basis: 'saved_pre_service_plan_vs_recorded_work', asOf: now.toISOString(),
    plans: plans.map(plan => measureRoutePerformance(plan, enriched)), missingBaselineDates, missingBaselineRoutes,
    unbaselinedCompletedVisits: pastWork.filter(row => row.status === 'completed'
      && !coveredRoutes.get(routeKey(dateOnly(row.scheduled_date), row.technician_id))?.has(row.id)).length,
    truncatedPlanningRuns: runs.length > 500,
    note: 'Unknown arrivals are excluded from the on-time denominator. Duration sources stay separate; no GPS gap is classified as idle and no model is updated.',
  };
}

module.exports = { recordedTiming, selectPlanningSnapshots, measureRoutePerformance, getRoutePerformance };
