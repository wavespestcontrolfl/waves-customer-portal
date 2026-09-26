/** Planned route measurements. No writes, geocoding, traffic calls or invented
 * stop capacity. Gross calendar gaps are not automatically bookable time. */
const { currentOrder, effectiveWindowRange, simulateArrivalRoute, workDuration, isCoVisitPair,
  startCoVisitChain, advanceCoVisit } = require('../route-reorder-window-fit');
const { allocationKey, occupiedRows } = require('./visit-capacity');
const { isHoldStop } = require('./travel-gap');

// Route-quality measures work still to be performed. stops-ahead keeps
// completed visits as route stops (position/total on the day of service),
// but the admin details editor can move a terminal row onto a future date
// (route-reorder.js handles the same case), and such a row must not create
// location, duration, grouping or lateness cards (codex #4295 r3 P2).
const QUALITY_EXCLUDED_STATUSES = [...require('../stops-ahead').NOT_A_ROUTE_STOP_STATUSES, 'completed'];
const { parseHHMM } = require('./window-rules');
const { plannedWorkMinutes } = require('./planning-minutes');

// Two customers promised the same technician at the same time. Staff and
// phone-reschedule saves commit through such a clash by owner ruling
// (2026-08-25, advisory only), so the planned board is where it must show.
//
// SCOPE (owner decision 2026-09-20, PR #4620): the plain case only — two
// ungrouped rows with a known duration, neither a live hold, occupying the
// rebooker's own probe span (visit-capacity occupiedRows: COALESCE(
// window_end, start + estimate)), so the card agrees with what let the
// save through. Rows that are part of a service-visit group (visit_id) or
// a version-2 combined booking (allocationKey) are NOT measured here: their
// occupancy is the SUM of members plus co-visit chaining (arrival-route
// groupRouteStops, route-reorder-window-fit), and this measurement does not
// re-compose those models — such days stay under the existing grouped-work
// review line. One customer's ungrouped pest + lawn rows that isCoVisitPair
// proves are one stop never pair; a second property or unit still does. An
// unknown customer on either side is never waved on.
function doubleBookedPairs(stops) {
  const plain = stops.filter(stop => parseHHMM(stop.window_start) != null
    && !stop.visit_id && !allocationKey(stop) && !isHoldStop(stop)
    && (Number(stop.estimated_duration_minutes) > 0 || parseHHMM(stop.window_end) > parseHHMM(stop.window_start)));
  const rows = occupiedRows(plain)
    .map((row, index) => ({ stop: plain[index], start: row.startMin, end: row.endMin }))
    .filter(row => row.start != null && row.end > row.start)
    .sort((a, b) => a.start - b.start || String(a.stop.id).localeCompare(String(b.stop.id)));
  // A proven co-visit is ONE physical appointment: collapse it so a clash
  // with a third customer is one collision, not one per member. Its span is
  // the union of the members' probe spans (the summed tail is out of scope).
  const blocks = [];
  for (const row of rows) {
    const host = blocks.find(block => isCoVisitPair(effectiveWindowRange, block.stops[block.stops.length - 1], row.stop));
    if (host) {
      host.ids.push(row.stop.id);
      host.stops.push(row.stop);
      host.end = Math.max(host.end, row.end);
    } else blocks.push({ ids: [row.stop.id], stops: [row.stop], start: row.start, end: row.end });
  }
  const pairs = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length && blocks[j].start < blocks[i].end; j++) {
      const [a, b] = [blocks[i], blocks[j]];
      pairs.push({ ids: [...a.ids, ...b.ids], minutes: Math.min(a.end, b.end) - b.start });
    }
  }
  return pairs;
}

// workDuration reads owner planning minutes for recognized stops under the
// capacity gate; report that provenance instead of the legacy basis.
function durationBasis(stops) {
  return stops.some(stop => plannedWorkMinutes(stop) != null)
    ? 'owner_planning_minutes_or_stored_window_or_estimate' : 'stored_window_or_estimate';
}

/**
 * Opt-in extras for a callers that need physical-stop counting or a
 * co-visit-aware on-site-minutes total (today: day-scorecard.js's
 * per-day scorecard) without a second raw-stops read of their own.
 *
 * Same-property co-visit rows collapse into one physical stop; a
 * service-visit group (visit_id) is also one physical stop no matter how
 * many member rows it has (arrival-route's SUM-of-durations contract —
 * doubleBookedPairs above collapses co-visits the same way for its own
 * purpose), and so is a version-2 combined booking's allocation
 * (allocationKey: one shared arrival anchor even with no visit_id — Codex
 * P2), keyed on its own id rather than the coordinate-dependent co-visit
 * rule, which fails closed when a member lacks usable coordinates. Walks the
 * board order so a 3+ member co-visit chain (not just a pair) still
 * collapses to one.
 */
function physicalStopCount(stops) {
  const ordered = currentOrder(stops);
  const seenGroups = new Set();
  let count = 0;
  let chainTail = null;
  for (const stop of ordered) {
    const group = stop.visit_id ? `visit:${stop.visit_id}` : allocationKey(stop);
    if (group) {
      if (!seenGroups.has(group)) { seenGroups.add(group); count += 1; }
      chainTail = null;
      continue;
    }
    if (chainTail && isCoVisitPair(effectiveWindowRange, chainTail, stop)) { chainTail = stop; continue; }
    count += 1;
    chainTail = stop;
  }
  return count;
}

/**
 * On-site minutes, but a co-visit chain counts once instead of once per
 * member — plain serviceMinutes (a flat sum of workDuration) double-counts
 * a co-visited pair sharing a single fallback-duration promise (the same
 * "phantom hour" isCoVisitPair's own comment describes), which
 * simulateArrivalRoute never does. Reuses the SAME chain arithmetic the
 * simulation itself calls (startCoVisitChain/advanceCoVisit in
 * route-reorder-window-fit.js) rather than a second, driftable formula —
 * only the duration bookkeeping, no clock/travel state, so it needs no
 * RouteOptimizer or blocked-interval input.
 *
 * A version-2 allocation (allocationKey, no visit_id) is settled FIRST
 * (Codex P2, round 8): it occupies the SUM of its members — visit-capacity's
 * own occupiedRows contract, read from that helper rather than re-derived —
 * so it counts once at that total and never enters a co-visit chain, which
 * would keep only one member's fallback span (two 60-minute fallback
 * members are 120, not 60).
 */
function allocationTotals(stops) {
  const members = stops.filter(stop => !stop.visit_id && allocationKey(stop));
  const totals = new Map();
  occupiedRows(members).forEach((row, index) => {
    const key = allocationKey(members[index]);
    if (!totals.has(key)) totals.set(key, row.endMin - (row.startMin ?? 0));
  });
  return totals;
}

//
// `sumAllocations: false` is the simulation's OWN duration model (it chains
// allocation members like any co-visit) — used only to detect when the two
// disagree (allocationModelMismatch below).
function coVisitOnSiteMinutes(stops, { sumAllocations = true } = {}) {
  const ordered = currentOrder(stops);
  const allocations = sumAllocations ? allocationTotals(ordered) : new Map();
  let total = [...allocations.values()].reduce((sum, minutes) => sum + minutes, 0);
  let chain = null;
  let chainTail = null;
  for (const stop of ordered) {
    if (sumAllocations && !stop.visit_id && allocationKey(stop)) {
      if (chain) total += chain.coMerged;
      chain = null;
      chainTail = null;
      continue;
    }
    if (chainTail && isCoVisitPair(effectiveWindowRange, chainTail, stop)) {
      chain = advanceCoVisit(chain, stop);
    } else {
      if (chain) total += chain.coMerged;
      chain = startCoVisitChain(stop);
    }
    chainTail = stop;
  }
  if (chain) total += chain.coMerged;
  return total;
}

/**
 * True when a version-2 allocation's summed-member duration contract
 * (coVisitOnSiteMinutes) disagrees with the duration simulateArrivalRoute
 * charged it (the plain co-visit chain) — Codex P2, round 9. The modeled
 * return/lateness/waiting then rest on a different duration model than the
 * on-site total, so a caller should report them as unknown rather than mix
 * the two.
 */
function allocationModelMismatch(stops) {
  return coVisitOnSiteMinutes(stops) !== coVisitOnSiteMinutes(stops, { sumAllocations: false });
}

/**
 * Unallocated work (Codex P2, round 3): a flat per-stop sum double-counts a
 * co-visited pair the SAME way plain serviceMinutes does — except unallocated
 * stops can span several DIFFERENT technician_ids (an offboarding tech's
 * stops, an unrelated unassigned stop, …), and a co-visit is only ever
 * within one technician's own route. Group first — a null technician_id
 * (genuinely unassigned) is its own group, never merged with a named one —
 * then collapse each group before totaling, so two different technicians'
 * stops can never chain into one "co-visit" just for sharing a clock slot.
 */
function groupedUnallocatedTotals(stops) {
  const groups = new Map();
  for (const stop of stops) {
    const key = stop.technician_id || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(stop);
  }
  // Per-technician breakdown too (null = genuinely unassigned) so a caller
  // that renders one of these technicians elsewhere can leave that group
  // out of its footer instead of counting it twice (day-scorecard's today
  // saved-plan rows — Codex P2, round 11). The raw stops ride along too
  // (Codex P2, round 12) so that caller can partition a group against
  // another stop-id set (a saved plan's own plannedStopIds) instead of
  // excluding it wholesale — never itself part of the public response.
  const byTechnician = [...groups].map(([key, groupStops]) => ({ technicianId: key || null,
    visits: physicalStopCount(groupStops), serviceMinutes: coVisitOnSiteMinutes(groupStops), stops: groupStops }));
  return { visits: byTechnician.reduce((sum, group) => sum + group.visits, 0),
    minutes: byTechnician.reduce((sum, group) => sum + group.serviceMinutes, 0), byTechnician };
}

// One branch point, not three, at the getScheduleQualityMeasurements call
// site: flag off is the original flat sum, byte for byte; flag on is the
// per-technician-group collapse above.
function unallocatedSummary(unallocated, includeStopExtras) {
  if (!includeStopExtras) {
    return { unallocatedVisits: unallocated.length,
      unallocatedServiceMinutes: unallocated.reduce((sum, stop) => sum + workDuration(stop), 0) };
  }
  const totals = groupedUnallocatedTotals(unallocated);
  return { unallocatedVisits: totals.visits, unallocatedServiceMinutes: totals.minutes,
    unallocatedByTechnician: totals.byTechnician };
}

function measureDayQuality(RouteOptimizer, stops, {
  departureMinutes = null, targetReturnMinutes = null, breakMinutes = null, future = true,
} = {}) {
  const modeledDeparture = departureMinutes ?? 480;
  const ordered = currentOrder(stops);
  const timed = stops.filter(stop => parseHHMM(stop.window_start) != null)
    .map(stop => ({ start: parseHHMM(stop.window_start), end: parseHHMM(stop.window_start) + workDuration(stop) }))
    .sort((a, b) => a.start - b.start);
  const gaps = [];
  let end = -Infinity;
  let overlapMinutes = 0;
  for (const block of timed) {
    if (Number.isFinite(end) && block.start > end) gaps.push({ startMinute: end, endMinute: block.start, minutes: block.start - end });
    // Extra service minutes booked on top of the union of earlier blocks.
    overlapMinutes += Math.max(0, Math.min(end, block.end) - block.start);
    end = Math.max(end, block.end);
  }
  const doubleBookedVisits = doubleBookedPairs(stops);
  const missingCoordinates = stops.filter(stop => !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))
    || !Number(stop.lat) || !Number(stop.lng)).map(stop => stop.id);
  // An owner-planned stop has a known duration even with no stored estimate.
  const defaultDurations = stops.filter(stop => plannedWorkMinutes(stop) == null
    && !(Number(stop.estimated_duration_minutes) > 0)
    && !(parseHHMM(stop.window_end) > parseHHMM(stop.window_start) && parseHHMM(stop.window_start) != null)).map(stop => stop.id);
  const grouped = stops.some(stop => stop.visit_id);
  // A version-2 combined booking is excluded from double-booking pairs (see
  // doubleBookedPairs), so its day carries the grouped-work review line too.
  // A live hold on a combined estimate is not yet a customer stop.
  const combined = stops.some(stop => allocationKey(stop) && !isHoldStop(stop));
  const configured = [departureMinutes, targetReturnMinutes, breakMinutes].every(Number.isFinite)
    && targetReturnMinutes > departureMinutes && breakMinutes >= 0;
  const unknown = Object.entries({
    missing_coordinates: missingCoordinates.length > 0,
    default_service_durations: defaultDurations.length > 0,
    grouped_work_requires_review: grouped || combined,
    actual_progress_required: !future,
    workday_or_break_allowance_unset: !configured,
  }).filter(([, present]) => present).map(([reason]) => reason);
  const serviceMinutes = stops.reduce((sum, stop) => sum + workDuration(stop), 0);
  // reportLate is diagnostic only. Writers use the default fail-on-lateness
  // simulation; an overloaded route still needs measurable lateness here.
  const simulation = !missingCoordinates.length && !grouped
    ? simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, ordered, { startMin: modeledDeparture, reportLate: true }) : null;
  const budget = !unknown.length && simulation
    ? targetReturnMinutes - departureMinutes - serviceMinutes - simulation.travelMin - breakMinutes : null;
  return {
    scheduledVisits: stops.length, serviceMinutes,
    grossGapMinutes: gaps.reduce((sum, gap) => sum + gap.minutes, 0), grossGaps: gaps, overlapMinutes, doubleBookedVisits,
    untimedVisits: stops.length - timed.length, missingCoordinates, defaultDurations,
    modeledDriveMinutes: null, modeledWaitingMinutes: null, modeledReturnMinuteBeforeBreaks: null, modeledLateVisits: null,
    ...(simulation ? { modeledDriveMinutes: simulation.travelMin, modeledWaitingMinutes: simulation.waitingMin,
      modeledReturnMinuteBeforeBreaks: simulation.returnAtMin, modeledLateVisits: simulation.arrivals.filter(row => row.lateMinutes > 0) } : {}),
    remainingServiceBudgetMinutes: budget,
    // A minute balance does not prove a candidate fits between promises.
    feasibleInsertionWindows: null,
    insertionStatus: simulation?.arrivals.some(row => row.lateMinutes > 0) ? 'current_route_infeasible' : 'candidate_location_and_duration_required',
    uncertaintyReasons: unknown,
    assumptions: { departureMinutes: modeledDeparture, departureProvided: departureMinutes != null, targetReturnMinutes, breakMinutes, durationBasis: durationBasis(stops),
      modelBasis: 'shared_fallback_leg_model', currentTraffic: false, gapsDeductTravelAndBreaks: false },
    // IDs, promises and durations allow later comparisons without persisting
    // customer identity, addresses or GPS coordinates in the planner ledger.
    plannedStops: ordered.map(stop => {
      const arrival = simulation?.arrivals.find(row => row.id === stop.id);
      return { id: stop.id, visitId: stop.visit_id || null, routeOrder: stop.route_order ?? null,
        arrivalWindow: effectiveWindowRange(stop), serviceMinutes: workDuration(stop),
        predictedArrivalMinute: arrival?.arrivalMin ?? null, predictedDepartureMinute: arrival?.departureMin ?? null };
    }),
  };
}

// The one stop-select list this measurement reads. Exported so a read-only
// consumer that needs the SAME columns for its own raw query (day-scorecard's
// physical-stop collapsing, which needs premise + coords + visit_id +
// customer_id for isCoVisitPair) can share it instead of drifting from it.
function dayStopSelect(conn) {
  const { guardedCoordSelects } = require('./day-stops');
  return ['scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.route_order',
    'scheduled_services.customer_id', 'scheduled_services.scheduled_date', 'scheduled_services.reservation_service_mix',
    'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
    'scheduled_services.service_address_city', 'scheduled_services.service_address_zip',
    {
      customer_address_line1: 'customers.address_line1',
      customer_address_line2: 'customers.address_line2',
      customer_city: 'customers.city',
      customer_state: 'customers.state',
      customer_zip: 'customers.zip',
    },
    'scheduled_services.window_start', 'scheduled_services.window_end', 'scheduled_services.time_window',
    'scheduled_services.status', 'scheduled_services.reservation_expires_at',
    'scheduled_services.created_at', 'scheduled_services.visit_id', 'scheduled_services.estimated_duration_minutes',
    // Planning-minute inputs (scheduling/planning-minutes.js) — without
    // them workDuration's plannedWorkMinutes always reads an unnamed
    // service and falls back to the legacy window/estimate rule, so
    // these quality totals silently disagreed with the picker's real
    // planned minutes under GATE_SCHEDULING_CAPACITY (Codex r1 P2).
    'scheduled_services.service_type', 'scheduled_services.is_recurring', 'scheduled_services.is_callback',
    ...guardedCoordSelects(conn)];
}

async function getScheduleQualityMeasurements(input = {}, conn = require('../../models/db'), now = new Date()) {
  const { etDateString, parseETDateTime, addETDays, validCalendarDate } = require('../../utils/datetime-et');
  const { etDateDiffDays } = require('../recurring-appointment-seeder');
  const { dayStopsQuery } = require('./day-stops');
  const { applyAssignable } = require('../technician-eligibility');
  const { getBlackoutLayers } = require('./blackout-dates');
  const RouteOptimizer = require('../route-optimizer');
  const today = etDateString(now);
  const from = input.date || input.date_from || today;
  if (!validCalendarDate(from)) return { error: 'Use a valid date range of at most 31 days.' };
  const to = input.date || input.date_to || etDateString(addETDays(parseETDateTime(`${from}T12:00`), 6));
  if (!validCalendarDate(to) || to < from || etDateDiffDays(from, to) > 30) {
    return { error: 'Use a valid date range of at most 31 days.' };
  }
  const departureMinutes = parseHHMM(input.departure_time);
  const targetReturnMinutes = parseHHMM(input.target_return_time);
  const breakMinutes = input.break_minutes;
  const invalidTimes = [input.departure_time, input.target_return_time].some(value => value != null && parseHHMM(value) == null);
  if (invalidTimes || ([departureMinutes, targetReturnMinutes].every(Number.isFinite) && targetReturnMinutes <= departureMinutes)
    || (breakMinutes != null && (!Number.isFinite(breakMinutes) || breakMinutes < 0))) {
    return { error: 'Use valid departure/return times and a nonnegative break allowance.' };
  }
  if (input.candidate_service_id != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.candidate_service_id)) {
    return { error: 'candidate_service_id must be an appointment UUID.' };
  }
  const candidate = input.candidate_service_id
    ? await require('./gap-candidates').loadGapCandidate(input.candidate_service_id, conn) : null;
  const techs = await applyAssignable(conn('technicians')).select('technicians.id', 'technicians.name');
  // Strict lookup: a failed closure read must not certify open capacity.
  const blackouts = await getBlackoutLayers(from, to, conn);
  const days = [];
  for (let index = 0; index <= etDateDiffDays(from, to); index++) {
    const date = etDateString(addETDays(parseETDateTime(`${from}T12:00`), index));
    const stops = await dayStopsQuery(conn, { dateStr: date, excludeStatuses: QUALITY_EXCLUDED_STATUSES,
      select: dayStopSelect(conn),
    }).whereRaw('(scheduled_services.reservation_expires_at IS NULL OR scheduled_services.reservation_expires_at > NOW())');
    const unallocated = stops.filter(stop => !techs.some(tech => tech.id === stop.technician_id));
    const closed = blackouts.dates.has(date);
    const byTech = techs.map(tech => {
      const techStops = stops.filter(stop => stop.technician_id === tech.id);
      const quality = measureDayQuality(RouteOptimizer, techStops, {
        departureMinutes, targetReturnMinutes, breakMinutes, future: date > today,
      });
      if (unallocated.length || closed) {
        quality.remainingServiceBudgetMinutes = null;
        quality.uncertaintyReasons.push(...[
          closed ? 'scheduled_day_off' : null,
          unallocated.length ? 'unallocated_work_requires_placement' : null,
        ].filter(Boolean));
      }
      const candidateAnalysis = candidate ? require('./gap-candidates').analyzeGapCandidate(candidate, stops, {
        date, technicianId: tech.id, now, today, departureMinutes, targetReturnMinutes, breakMinutes, closed,
      }) : null;
      if (candidateAnalysis) {
        quality.feasibleInsertionWindows = candidateAnalysis.feasibleInsertionWindows;
        quality.insertionStatus = candidateAnalysis.reason;
      }
      return { technicianId: tech.id, technician: tech.name, ...quality,
        ...(candidateAnalysis ? { candidateAnalysis } : {}),
        // Opt-in only (day-scorecard.js) — every other caller's byTech shape
        // is unchanged. Reuses techStops instead of re-filtering `stops`.
        ...(input.includeStopExtras ? { physicalStops: physicalStopCount(techStops),
          coVisitOnSiteMinutes: coVisitOnSiteMinutes(techStops),
          allocationModelMismatch: allocationModelMismatch(techStops) } : {}) };
    });
    days.push({ date, closed, ...unallocatedSummary(unallocated, input.includeStopExtras), byTech });
  }
  const result = { range: { from, to }, units: 'minutes', days,
    basis: 'planned_schedule_not_actual_field_time',
    driveModel: require('../../config/feature-gates').gateEnvValue('GATE_DRIVE_TIME_CALIBRATION') ? 'calibrated' : 'legacy',
    note: 'Gross gaps and remaining minute budgets are not bookable slots. Insertion needs the candidate location, duration and scheduling constraints.' };
  return result;
}

module.exports = {
  QUALITY_EXCLUDED_STATUSES, measureDayQuality, getScheduleQualityMeasurements, dayStopSelect,
  physicalStopCount, coVisitOnSiteMinutes };
