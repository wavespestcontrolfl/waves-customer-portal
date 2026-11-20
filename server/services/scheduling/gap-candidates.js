/** Candidate-specific read analysis for the existing schedule gap tool.
 * Reuses staff arrival-placement checks and the optimizer's hard preference
 * filters (the mowing-day rule included, GATE_AUTO_DISPATCH_MOWING_DAYS).
 * No holds, geocoding, reassignment, or customer promises are made. */
const { guardedCoordSelects } = require('./day-stops');
const { enumerateArrivalPlacements } = require('./arrival-route');
const { ADMIN_DAY_END_MINUTES, parseHHMM } = require('./window-rules');
const { workDuration } = require('../route-reorder-window-fit');
const { getCustomerSchedulingPreferences } = require('../auto-dispatch/preferences');
const { inBlackout, violatesPreferredDay, violatesPreferredTime, _internals: { weekdayOf } } = require('../auto-dispatch/candidate-slots');
const { toDateStr, shiftDateStr } = require('../auto-dispatch/dates');
const mowingDays = require('../auto-dispatch/mowing-days');
const { categoriesForServices } = require('../technician-capabilities');

async function loadGapCandidate(serviceId, conn) {
  const service = await conn('scheduled_services').leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.id', serviceId)
    .first('scheduled_services.*', 'customers.active as customer_active', 'customers.deleted_at as customer_deleted_at', ...guardedCoordSelects(conn));
  if (!service) return { unavailable: 'candidate_not_found' };
  if (!['pending', 'confirmed'].includes(service.status) || service.reservation_expires_at
    || service.customer_active !== true || service.customer_deleted_at) return { unavailable: 'candidate_not_active' };
  if (service.auto_dispatch_locked || service.auto_dispatch_excluded) return { unavailable: 'candidate_locked_or_excluded' };
  const preferences = await getCustomerSchedulingPreferences(service.customer_id, service.service_type, conn, { serviceId: service.service_id, serviceKey: service.service_key_snapshot });
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

/**
 * An open estimate's first visit as a gap candidate (the 07:05 notice's fill list, day-replan/fill-list.js). It is a
 * new stop, under the office's new-stop id ('__candidate__', arrival-route.js), at the customer's stored location:
 * never geocoded (resolveEstimateCoords paidCalls false). Its service and length are the ones the estimate's booking
 * page offers (resolveCatalogSlotProfile). The customer's day and time rules apply as for loadGapCandidate, and a
 * technician needs the capability for every service the visit performs (a combined visit's too). It is checked as a new
 * visit (`prospective`, analyzeGapCandidate): at every place in the route, as the staff finder checks a new customer.
 * `firstVisitOpen(date)` is the booking page's first-visit date rule: a seasonal mosquito program starts in season, and
 * a new-home estimate not before the move-in date. `{ unavailable: 'no_stored_location' }` when no stored location can
 * stand in. A failed read throws.
 */
async function estimateGapCandidate(estimate, conn) {
  const slots = require('../estimate-slot-availability');
  let coords;
  try {
    coords = await slots.resolveEstimateCoords(estimate, { paidCalls: false, strictReads: true });
  } catch (err) {
    if (err.code === 'COORDS_NEED_GEOCODE') return { unavailable: 'no_stored_location' };
    throw err;
  }
  const profile = await slots.resolveCatalogSlotProfile(estimate, {}, conn);
  const performs = slots.appointmentServicesFor(profile).map((row) => ({
    service_type: row.label || profile.serviceLabel, service_key_snapshot: row.resolvedServiceKey || row.service || null,
  }));
  const [primary = { service_type: profile.serviceLabel, service_key_snapshot: null }] = performs;
  const service = {
    id: '__candidate__', customer_id: estimate.customer_id, status: 'pending', lat: coords.lat, lng: coords.lng,
    estimated_duration_minutes: profile.durationMinutes, ...primary,
  };
  const preferences = await getCustomerSchedulingPreferences(estimate.customer_id, service.service_type, conn,
    { serviceKey: service.service_key_snapshot });
  // The office list's capability rule, by each service's catalog category or name (technician-capabilities.js).
  const categories = [...new Set(await categoriesForServices(conn, performs.length ? performs : [primary]))];
  const deactivated = await conn('technician_capabilities').whereIn('service_category', categories).where('active', false).pluck('technician_id');
  const seasonal = slots.seasonalSelectionProfile(profile);
  const moveInDate = await slots.estimateMoveInDate(estimate);
  const firstVisitOpen = (date) => (!seasonal || slots.inMosquitoSeason(date)) && (!moveInDate || date >= moveInDate);
  return { service, preferences, holds: [], siblingDates: [], deactivated, label: profile.serviceLabel, prospective: true, firstVisitOpen };
}

function analyzeGapCandidate(candidate, rows, {
  date, technicianId, now, today, departureMinutes, targetReturnMinutes, breakMinutes, closed,
  // The tech's start point (GATE_TECH_START_POINTS); absent = the office.
  home,
  // The van's departure when the caller gave none (day-quality.js); 08:00 by default.
  modeledDepartureMinutes = 480,
  // The day's schedule blocks for this technician (tech_schedule_blocks rows: start_time, end_time), when the caller
  // read them (the 07:05 fill list); absent = none, as before.
  blocks,
}) {
  const response = { candidateId: candidate.service?.id || null, routeFits: [], feasibleInsertionWindows: null,
    automaticMoveAuthorized: false, reviewRequirements: ['customer_commitments_and_access', 'locked_save_recheck'] };
  if (candidate.unavailable) return { ...response, reason: candidate.unavailable };
  const { service, preferences, holds, siblingDates, deactivated, prospective } = candidate;
  if (date <= today) return { ...response, reason: 'actual_progress_required' };
  if (closed) return { ...response, reason: 'scheduled_day_off' };
  if (deactivated.includes(technicianId)) return { ...response, reason: 'technician_category_deactivated' };
  if (siblingDates.includes(date)) return { ...response, reason: 'another_series_visit_on_date' };
  if (holds.some(hold => toDateStr(hold.starts_on) <= date && toDateStr(hold.resume_on) > date)) {
    return { ...response, reason: 'plan_paused_on_date' };
  }
  // The customer's date rules, all cheap and pure, so a list rather than a
  // chain. GATE_AUTO_DISPATCH_MOWING_DAYS='true': a Lawn Care Service visit is
  // not offered on or next to the customer's mowing day (mowing-days.js).
  const dateRefused = [
    inBlackout(date, preferences.blackout),
    violatesPreferredDay(date, preferences),
    mowingDays.blocksLive(date, mowingDays.unitRule(preferences, [service])),
    service.skip_weekends && [0, 6].includes(weekdayOf(date)),
  ].some(Boolean);
  if (dateRefused) return { ...response, reason: 'customer_date_preference' };
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
  const departure = departureMinutes ?? modeledDepartureMinutes;
  // A caller's own departure also opens the first window (as before). The
  // Settings departure only moves the van: no window opens before 08:00.
  const earliestStart = departureMinutes ?? Math.max(480, departure);
  // Respect any known return limit even when another workday input is
  // missing. Such results stay provisional; an omitted break is not zero.
  const returnBy = Number.isFinite(targetReturnMinutes)
    ? targetReturnMinutes - (Number.isFinite(breakMinutes) ? breakMinutes : 0) : null;
  // The candidate is the visit BEING analyzed for a different gap, the same
  // role arrival-route.js's own `target` plays — its duration keeps the
  // legacy window/estimate rule, never the owner planning minutes that rule
  // applies to the OTHER stops already on the route it might join (Codex r1
  // P2: an unmarked candidate matching the table was offered shorter windows
  // than its own stored estimate).
  const duration = workDuration({ ...service, planning_exempt: true });
  const sameRoute = toDateStr(service.scheduled_date) === date && service.technician_id === technicianId;
  const target = { ...service, technician_id: technicianId, scheduled_date: date, route_order: sameRoute ? service.route_order : null };
  // vanDepartureMin: with GATE_SCHEDULING_CAPACITY on the route opens at the
  // van's departure (the Settings time; 08:00 with the day rules off), not at
  // the 08:00 shift open, the way the night tool's arrival search plans it.
  // A new visit (`prospective`: an estimate's first visit, estimateGapCandidate) is tried at every place in the route:
  // the staff finder's check of a new customer (arrival-route.js staffPlacement, with its margin for later stops). A
  // saved visit keeps the order its save would produce.
  const context = { target, rows: others, date, now, grouped: false, activeTarget: false, home, vanDepartureMin: modeledDepartureMinutes,
    prospective, blocks };
  const result = enumerateArrivalPlacements(context, { durationMinutes: duration, earliestStartMin: earliestStart,
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
    note: prospective ? 'Fits place the new visit where the staff finder would. They do not book it or create a booking hold.'
      : 'Fits preserve the dispatch order produced by the existing save. They do not authorize a date/time change or create a booking hold.' };
}

module.exports = { loadGapCandidate, estimateGapCandidate, analyzeGapCandidate };
