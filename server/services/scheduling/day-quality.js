/** Planned route measurements. No writes, geocoding, traffic calls or invented
 * stop capacity. Gross calendar gaps are not automatically bookable time. */
const { currentOrder, effectiveWindowRange, simulateArrivalRoute, workDuration, isCoVisitPair } = require('../route-reorder-window-fit');
const { allocationKey, occupiedRows } = require('./visit-capacity');

// Route-quality measures work still to be performed. stops-ahead keeps
// completed visits as route stops (position/total on the day of service),
// but the admin details editor can move a terminal row onto a future date
// (route-reorder.js handles the same case), and such a row must not create
// location, duration, grouping or lateness cards (codex #4295 r3 P2).
const QUALITY_EXCLUDED_STATUSES = [...require('../stops-ahead').NOT_A_ROUTE_STOP_STATUSES, 'completed'];
const { parseHHMM } = require('./window-rules');

// Two customers promised the same technician at the same time. Staff and
// phone-reschedule saves commit through such a clash by owner ruling
// (2026-08-25, advisory only), so the planned board is where it must show.
// One physical stop is one block: the members of a service-visit group
// (visit_id — arrival-route groupRouteStops: one stop, the SUM of its
// members' work) or of a version-2 combined booking (visit-capacity
// allocationKey, which occupiedRows already sums) are merged before any
// comparison, and one customer's ungrouped pest + lawn rows that
// isCoVisitPair proves are one stop (same window, pin and premise) never
// pair. A customer's second property or unit in the same slot still does.
// Everything else occupies COALESCE(window_end, start + estimate) — the
// rebooker's own probe, so the card agrees with what let the save through.
// An unknown customer on either side is never waved on.
function occupiedBlocks(stops) {
  const timed = stops.filter(stop => parseHHMM(stop.window_start) != null);
  const occupied = occupiedRows(timed);
  const blocks = new Map();
  timed.forEach((stop, index) => {
    const key = stop.visit_id || allocationKey(stop) || `row:${stop.id}`;
    const block = blocks.get(key) || { key, ids: [], stops: [], start: Infinity, end: -Infinity, work: 0 };
    block.ids.push(stop.id);
    block.stops.push(stop);
    block.start = Math.min(block.start, occupied[index].startMin);
    block.end = Math.max(block.end, occupied[index].endMin);
    block.work += workDuration(stop);
    blocks.set(key, block);
  });
  return [...blocks.values()]
    .map(block => ({ ...block, end: block.stops.length > 1 && block.stops[0].visit_id ? Math.max(block.end, block.start + block.work) : block.end }))
    .filter(block => Number.isFinite(block.start) && block.end > block.start)
    .sort((a, b) => a.start - b.start || String(a.ids[0]).localeCompare(String(b.ids[0])));
}

function doubleBookedPairs(stops) {
  const blocks = occupiedBlocks(stops);
  const pairs = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length && blocks[j].start < blocks[i].end; j++) {
      const [a, b] = [blocks[i], blocks[j]];
      if (a.stops.length === 1 && b.stops.length === 1 && isCoVisitPair(effectiveWindowRange, a.stops[0], b.stops[0])) continue;
      pairs.push({ ids: [...a.ids, ...b.ids], minutes: Math.min(a.end, b.end) - b.start });
    }
  }
  return pairs;
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
  const defaultDurations = stops.filter(stop => !(Number(stop.estimated_duration_minutes) > 0)
    && !(parseHHMM(stop.window_end) > parseHHMM(stop.window_start) && parseHHMM(stop.window_start) != null)).map(stop => stop.id);
  const grouped = stops.some(stop => stop.visit_id);
  const configured = [departureMinutes, targetReturnMinutes, breakMinutes].every(Number.isFinite)
    && targetReturnMinutes > departureMinutes && breakMinutes >= 0;
  const unknown = Object.entries({
    missing_coordinates: missingCoordinates.length > 0,
    default_service_durations: defaultDurations.length > 0,
    grouped_work_requires_review: grouped,
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
    assumptions: { departureMinutes: modeledDeparture, departureProvided: departureMinutes != null, targetReturnMinutes, breakMinutes, durationBasis: 'stored_window_or_estimate',
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

async function getScheduleQualityMeasurements(input = {}, conn = require('../../models/db'), now = new Date()) {
  const { etDateString, parseETDateTime, addETDays, validCalendarDate } = require('../../utils/datetime-et');
  const { etDateDiffDays } = require('../recurring-appointment-seeder');
  const { dayStopsQuery, guardedCoordSelects } = require('./day-stops');
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
      select: ['scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.route_order',
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
        ...guardedCoordSelects(conn)],
    }).whereRaw('(scheduled_services.reservation_expires_at IS NULL OR scheduled_services.reservation_expires_at > NOW())');
    const unallocated = stops.filter(stop => !techs.some(tech => tech.id === stop.technician_id));
    const closed = blackouts.dates.has(date);
    const byTech = techs.map(tech => {
      const quality = measureDayQuality(RouteOptimizer, stops.filter(stop => stop.technician_id === tech.id), {
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
        ...(candidateAnalysis ? { candidateAnalysis } : {}) };
    });
    days.push({ date, closed, unallocatedVisits: unallocated.length,
      unallocatedServiceMinutes: unallocated.reduce((sum, stop) => sum + workDuration(stop), 0), byTech });
  }
  const result = { range: { from, to }, units: 'minutes', days,
    basis: 'planned_schedule_not_actual_field_time',
    driveModel: require('../../config/feature-gates').gateEnvValue('GATE_DRIVE_TIME_CALIBRATION') ? 'calibrated' : 'legacy',
    note: 'Gross gaps and remaining minute budgets are not bookable slots. Insertion needs the candidate location, duration and scheduling constraints.' };
  return result;
}

module.exports = {
  QUALITY_EXCLUDED_STATUSES, measureDayQuality, getScheduleQualityMeasurements };
