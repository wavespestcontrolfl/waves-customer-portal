/** Candidate-specific read analysis for the existing schedule gap tool.
 * Reuses staff arrival-placement checks and the optimizer's hard preference
 * filters. No holds, geocoding, reassignment, or customer promises are made. */
const { guardedCoordSelects } = require('./day-stops');
const { enumerateArrivalPlacements } = require('./arrival-route');
const { ADMIN_DAY_END_MINUTES, parseHHMM } = require('./window-rules');
const { workDuration } = require('../route-reorder-window-fit');
const { getCustomerSchedulingPreferences } = require('../auto-dispatch/preferences');
const { inBlackout, violatesPreferredDay, violatesPreferredTime, _internals: { weekdayOf } } = require('../auto-dispatch/candidate-slots');
const { toDateStr, shiftDateStr } = require('../auto-dispatch/dates');

async function loadGapCandidate(serviceId, conn) {
  const service = await conn('scheduled_services').leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.id', serviceId)
    .first('scheduled_services.*', 'customers.active as customer_active', 'customers.deleted_at as customer_deleted_at', ...guardedCoordSelects(conn));
  if (!service) return { unavailable: 'candidate_not_found' };
  if (!['pending', 'confirmed'].includes(service.status) || service.reservation_expires_at
    || service.customer_active !== true || service.customer_deleted_at) return { unavailable: 'candidate_not_active' };
  if (service.auto_dispatch_locked || service.auto_dispatch_excluded) return { unavailable: 'candidate_locked_or_excluded' };
  const preferences = await getCustomerSchedulingPreferences(service.customer_id, service.service_type, conn);
  const deactivated = await conn('technician_capabilities').where({ service_category: preferences.service_category, active: false }).pluck('technician_id');
  const { seedingFamilyKey, comboRouteFamiliesFromCatalogKey } = require('../estimate-converter');
  const catalog = service.service_id ? await conn('services').where('id', service.service_id).first('service_key') : null;
  const identity = catalog?.service_key || service.service_key_snapshot;
  const combo = comboRouteFamiliesFromCatalogKey(identity);
  const families = combo.length ? combo : [seedingFamilyKey({ service: identity, name: service.service_type })];
  const holds = await conn('plan_holds').where({ customer_id: service.customer_id, status: 'active' })
    .whereIn('family_key', families).select('starts_on', 'resume_on');
  let siblingDates = [];
  if (service.is_recurring) {
    const parentId = service.recurring_parent_id || service.id;
    const decision = await conn('recurring_plan_alerts').where({ recurring_parent_id: parentId, customer_id: service.customer_id })
      .whereNotNull('resolved_at').orderBy('resolved_at', 'desc').orderBy('id', 'desc').first('resolved_action');
    const lapsed = await conn('recurring_plan_alerts').where({ recurring_parent_id: parentId, customer_id: service.customer_id, alert_type: 'plan_lapsed' })
      .whereNull('resolved_at').first('id');
    if (decision?.resolved_action === 'cancel_series' || lapsed) return { unavailable: 'recurring_plan_stopped_or_lapsed' };
    siblingDates = (await conn('scheduled_services').where('customer_id', service.customer_id)
      .where(query => query.where('id', parentId).orWhere('recurring_parent_id', parentId))
      .whereNot('id', service.id)
      // Match ordinary optimizer moves versus customer due-date placement:
      // only the latter retains the re-anchor's rescheduled sibling holds.
      .whereNotIn('status', service.recurring_dispatch_due_date ? ['cancelled'] : ['cancelled', 'rescheduled'])
      .pluck('scheduled_date')).map(toDateStr);
  }
  return { service, preferences, holds, siblingDates, deactivated };
}

function analyzeGapCandidate(candidate, rows, {
  date, technicianId, now, today, departureMinutes, targetReturnMinutes, breakMinutes, closed,
}) {
  const response = { candidateId: candidate.service?.id || null, routeFits: [], feasibleInsertionWindows: null,
    automaticMoveAuthorized: false, reviewRequirements: ['customer_commitments_and_access', 'locked_save_recheck'] };
  if (candidate.unavailable) return { ...response, reason: candidate.unavailable };
  const { service, preferences, holds, siblingDates, deactivated } = candidate;
  if (date <= today) return { ...response, reason: 'actual_progress_required' };
  if (closed) return { ...response, reason: 'scheduled_day_off' };
  if (deactivated.includes(technicianId)) return { ...response, reason: 'technician_category_deactivated' };
  if (siblingDates.includes(date)) return { ...response, reason: 'another_series_visit_on_date' };
  if (holds.some(hold => toDateStr(hold.starts_on) <= date && toDateStr(hold.resume_on) > date)) {
    return { ...response, reason: 'plan_paused_on_date' };
  }
  if (inBlackout(date, preferences.blackout) || violatesPreferredDay(date, preferences)
    || (service.skip_weekends && [0, 6].includes(weekdayOf(date)))) return { ...response, reason: 'customer_date_preference' };
  if (service.is_recurring && !service.recurring_parent_id && toDateStr(service.scheduled_date) !== date) {
    return { ...response, reason: 'first_occurrence_cadence_anchor' };
  }
  if (service.recurring_dispatch_due_date && (date < shiftDateStr(toDateStr(service.recurring_dispatch_due_date), -3)
    || date > shiftDateStr(toDateStr(service.recurring_dispatch_due_date), 3))) return { ...response, reason: 'outside_recurring_due_range' };
  const others = rows.filter(row => row.id !== service.id);
  const all = [service, ...others];
  if (all.some(row => row.visit_id)) return { ...response, reason: 'grouped_work_requires_review' };
  if (all.some(row => !Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lng)) || !Number(row.lat) || !Number(row.lng))) {
    return { ...response, reason: 'missing_coordinates' };
  }
  if (all.some(row => !(Number(row.estimated_duration_minutes) > 0)
    && !(parseHHMM(row.window_start) != null && parseHHMM(row.window_end) > parseHHMM(row.window_start)))) {
    return { ...response, reason: 'default_service_durations' };
  }
  // Fixed occupancy in the staff checker needs a concrete work-block start;
  // a legacy "morning" band alone cannot certify where that work sits.
  if (others.some(row => (row.technician_id !== technicianId || row.reservation_expires_at != null)
    && parseHHMM(row.window_start) == null)) {
    return { ...response, reason: 'untimed_unallocated_work' };
  }
  const configured = [departureMinutes, targetReturnMinutes, breakMinutes].every(Number.isFinite)
    && targetReturnMinutes > departureMinutes && breakMinutes >= 0;
  const departure = departureMinutes ?? 480;
  // Respect any known return limit even when another workday input is
  // missing. Such results stay provisional; an omitted break is not zero.
  const returnBy = Number.isFinite(targetReturnMinutes)
    ? targetReturnMinutes - (Number.isFinite(breakMinutes) ? breakMinutes : 0) : null;
  const duration = workDuration(service);
  const sameRoute = toDateStr(service.scheduled_date) === date && service.technician_id === technicianId;
  const target = { ...service, technician_id: technicianId, scheduled_date: date, route_order: sameRoute ? service.route_order : null };
  const context = { target, rows: others, date, now, grouped: false, activeTarget: false };
  const result = enumerateArrivalPlacements(context, { durationMinutes: duration, earliestStartMin: departure,
    latestServiceEndMin: Math.min(ADMIN_DAY_END_MINUTES, returnBy ?? ADMIN_DAY_END_MINUTES),
    dayEndMin: Math.min(ADMIN_DAY_END_MINUTES, returnBy ?? ADMIN_DAY_END_MINUTES), departureMin: departure, returnByMin: returnBy });
  const routeFits = result.placements.filter(item => !violatesPreferredTime(item.windowStart, preferences)).map(({ windowStart, windowEnd, fit }) => ({
    windowStart, windowEnd, estimatedArrival: fit.estimatedArrival,
    addedDriveMinutes: fit.detourMinutes, modeledDriveMinutes: fit.driveMinutes, modeledWaitingMinutes: fit.waitingMinutes,
    modeledReturnMinuteBeforeBreaks: fit.returnMinuteBeforeBreaks,
    modeledReturnMinuteWithAllowance: configured ? fit.returnMinuteBeforeBreaks + breakMinutes : null,
  })).sort((a, b) => a.addedDriveMinutes - b.addedDriveMinutes || a.modeledWaitingMinutes - b.modeledWaitingMinutes
    || a.windowStart.localeCompare(b.windowStart));
  return { ...response, routeFits, feasibleInsertionWindows: configured ? routeFits : null,
    reason: !configured ? 'workday_or_break_allowance_unset' : (routeFits.length ? 'route_fit_requires_staff_review' : 'no_fit_in_saved_order'),
    evaluatedWindows: result.evaluated, rejections: { ...result.rejections, customer_time_preference: result.placements.length - routeFits.length },
    workdayVerified: configured, departureMinutes: departure, breakPlacement: 'daily_allowance_not_a_timed_break',
    note: 'Fits preserve the dispatch order produced by the existing save. They do not authorize a date/time change or create a booking hold.' };
}

module.exports = { loadGapCandidate, analyzeGapCandidate };
