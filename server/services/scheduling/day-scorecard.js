/**
 * Admin-only per-technician-day drive-vs-stops scorecard (GATE_ROUTE_SCORECARD).
 *
 * Pure composition over the two existing read-only reporters — no writes, no
 * geocoding, no traffic calls, and never a call into
 * refreshScheduleQualityAfterChange or any other writer:
 *   - day-quality.js's getScheduleQualityMeasurements for future/today rows
 *     (PLANNED ONLY — there is nothing recorded yet to compare against).
 *   - route-performance.js's getRoutePerformance for past rows: the saved
 *     pre-service snapshot (PLANNED-as-of-the-day-before) paired with
 *     recorded work (ACTUAL), plus a Bouncie mileage_log rollup for actual
 *     drive minutes (route-performance's own actualDriveMinutes/etc. are
 *     hard-coded null — this is the first real caller of that snapshot data,
 *     read straight from the plan object rather than duplicating it).
 *
 * A past technician-day with no saved snapshot (see getRoutePerformance's
 * own missingBaselineRoutes) reports planned:null rather than inventing one.
 * Every null shows as "unknown" in the UI, never 0 (day-quality's own rule).
 */
const { etDateString, validCalendarDate } = require('../../utils/datetime-et');
const { etDateDiffDays } = require('../recurring-appointment-seeder');
const { gateEnvValue } = require('../../config/feature-gates');
const { currentOrder, effectiveWindowRange, isCoVisitPair } = require('../route-reorder-window-fit');
const { dayStopsQuery } = require('./day-stops');
const { QUALITY_EXCLUDED_STATUSES, getScheduleQualityMeasurements, dayStopSelect } = require('./day-quality');
const { getRoutePerformance } = require('./route-performance');
const { applyAssignable } = require('../technician-eligibility');

const MAX_RANGE_DAYS = 30; // Same 31-day inclusive cap as day-quality.
// Only these evidence grades are corroborated recorded work (route-performance's
// own distinction) — 'unverified_timing'/'unmatched_or_uncompleted_work' never
// contribute a minute to the actual side.
const RECORDED_EVIDENCE = new Set(['operator_corrected', 'operator_reported', 'recorded_lifecycle_interval']);
const DEPARTURE_MINUTES = 8 * 60; // 08:00 — the same default measureDayQuality falls back to.

function routeScorecardEnabled() {
  return gateEnvValue('GATE_ROUTE_SCORECARD');
}

function validDateRange(from, to) {
  return Boolean(validCalendarDate(from) && validCalendarDate(to) && to >= from && etDateDiffDays(from, to) <= MAX_RANGE_DAYS);
}

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

/**
 * Same-property co-visit rows collapse into one physical stop; a service-
 * visit group (visit_id) is also one physical stop no matter how many member
 * rows it has (arrival-route's SUM-of-durations contract — day-quality's own
 * doubleBookedPairs collapses co-visits the same way for its own purpose).
 * Walks the board order so a 3+ member co-visit chain (not just a pair)
 * still collapses to one.
 */
function physicalStopCount(stops) {
  const ordered = currentOrder(stops);
  const seenVisitIds = new Set();
  let count = 0;
  let chainTail = null;
  for (const stop of ordered) {
    if (stop.visit_id) {
      if (!seenVisitIds.has(stop.visit_id)) { seenVisitIds.add(stop.visit_id); count += 1; }
      chainTail = null;
      continue;
    }
    if (chainTail && isCoVisitPair(effectiveWindowRange, chainTail, stop)) { chainTail = stop; continue; }
    count += 1;
    chainTail = stop;
  }
  return count;
}

function stopsPerHour(stops, departureMinutes, returnMinute) {
  if (!Number.isFinite(stops) || !Number.isFinite(departureMinutes) || !Number.isFinite(returnMinute) || returnMinute <= departureMinutes) return null;
  return stops / ((returnMinute - departureMinutes) / 60);
}

function driveShare(driveMinutes, onSiteMinutes) {
  if (!Number.isFinite(driveMinutes) || !Number.isFinite(onSiteMinutes) || driveMinutes + onSiteMinutes <= 0) return null;
  return driveMinutes / (driveMinutes + onSiteMinutes);
}

// Future/today: straight from the existing quality measurement, plus the
// physical-stop count that measurement does not compute for itself.
function plannedFutureRow(techQuality, physicalStops) {
  const onSiteMinutes = Number.isFinite(techQuality.serviceMinutes) ? techQuality.serviceMinutes : null;
  const driveMinutes = techQuality.modeledDriveMinutes ?? null;
  const returnMinute = techQuality.modeledReturnMinuteBeforeBreaks ?? null;
  return {
    stops: techQuality.scheduledVisits, physicalStops,
    onSiteMinutes, driveMinutes, waitMinutes: techQuality.modeledWaitingMinutes ?? null,
    driveShare: driveShare(driveMinutes, onSiteMinutes),
    stopsPerHour: stopsPerHour(physicalStops, DEPARTURE_MINUTES, returnMinute),
    returnMinute, lateVisits: techQuality.modeledLateVisits ? techQuality.modeledLateVisits.length : null,
  };
}

// Past, PLANNED-as-of-the-day-before: the saved snapshot's own numbers
// (route-performance's passthrough fields), never recomputed here. No
// physical-stop count — the snapshot keeps ids/durations/windows, not the
// premise/coordinate columns isCoVisitPair needs (see design_choices).
function plannedPastRow(plan) {
  if (!plan) return null;
  return {
    stops: plan.plannedVisits, physicalStops: null,
    onSiteMinutes: plan.plannedServiceMinutes, driveMinutes: plan.plannedDriveMinutes,
    waitMinutes: plan.plannedWaitingMinutes,
    driveShare: driveShare(plan.plannedDriveMinutes, plan.plannedServiceMinutes),
    stopsPerHour: stopsPerHour(plan.plannedVisits, DEPARTURE_MINUTES, plan.plannedReturnMinuteBeforeBreaks),
    returnMinute: plan.plannedReturnMinuteBeforeBreaks, lateVisits: null,
  };
}

// Past, ACTUAL: on-site minutes summed from evidence-graded recorded
// durations (coverage reported alongside so a partial sum never reads as a
// complete one — see onSiteCoverage on the client) and drive minutes summed
// from mileage_log (null, not 0, when no trip rows exist).
//
// No idle metric: mileage_log has no per-trip timestamps, only a day total,
// so a day's drive minutes include the outbound/return legs OUTSIDE the
// first-arrival-to-last-completion span, not just the driving that happened
// between recorded stops. span - onSite - drive on that mixed basis can run
// negative on an ordinary day (1 stop, 60m on-site + 30m of drive that
// includes the drive home => -30), so it is not computed at all rather than
// shown as a wrong number. driveShare/stopsPerHour are PLANNED-only for the
// same reason drive has no dependable actual denominator here — never
// derived from a possibly-partial actual on-site sum.
function actualPastRow(plan, mileage) {
  const driveMinutes = mileage ? mileage.minutes : null;
  const driveTrips = mileage ? mileage.trips : null;
  if (!plan) return { onSiteMinutes: null, onSiteCoverage: null, driveMinutes, driveTrips, spanMinutes: null };
  const recorded = plan.stops.filter(stop => RECORDED_EVIDENCE.has(stop.durationEvidence) && Number.isFinite(stop.recordedServiceMinutes));
  const onSiteMinutes = recorded.length ? recorded.reduce((sum, stop) => sum + stop.recordedServiceMinutes, 0) : null;
  const arrivals = plan.stops.map(stop => stop.recordedArrivalMinute).filter(Number.isFinite);
  const completions = plan.stops.map(stop => stop.recordedCompletionMinute).filter(Number.isFinite);
  const spanMinutes = arrivals.length && completions.length ? Math.max(...completions) - Math.min(...arrivals) : null;
  return { onSiteMinutes, onSiteCoverage: { covered: recorded.length, total: plan.stops.length },
    driveMinutes, driveTrips, spanMinutes };
}

async function mileageByTechDay(conn, techs, from, to) {
  if (!techs.length) return new Map();
  const rows = await conn('mileage_log')
    .whereIn('technician_id', techs.map(tech => tech.id))
    .whereBetween('trip_date', [from, to])
    .groupBy('technician_id', 'trip_date')
    .select('technician_id', 'trip_date')
    .sum({ minutes: 'duration_minutes' })
    .count({ trips: 'id' });
  return new Map(rows.map(row => [`${dateOnly(row.trip_date)}|${row.technician_id}`,
    { minutes: Number(row.minutes) || 0, trips: Number(row.trips) || 0 }]));
}

function pastTechRow(techQuality, planByKey, mileageByKey, date) {
  const key = `${date}|${techQuality.technicianId}`;
  const plan = planByKey.get(key) || null;
  const mileage = mileageByKey.get(key) || null;
  return { technicianId: techQuality.technicianId, technician: techQuality.technician,
    driveModel: plan ? plan.driveModel : null,
    planned: plannedPastRow(plan), actual: actualPastRow(plan, mileage) };
}

async function futureTechRows(conn, day, driveModel) {
  const stops = await dayStopsQuery(conn, { dateStr: day.date, excludeStatuses: QUALITY_EXCLUDED_STATUSES,
    select: dayStopSelect(conn) }).whereRaw('(scheduled_services.reservation_expires_at IS NULL OR scheduled_services.reservation_expires_at > NOW())');
  return day.byTech.map(techQuality => ({
    technicianId: techQuality.technicianId, technician: techQuality.technician, driveModel,
    planned: plannedFutureRow(techQuality, physicalStopCount(stops.filter(stop => stop.technician_id === techQuality.technicianId))),
    actual: null,
  }));
}

async function getDayScorecard(input = {}, conn = require('../../models/db'), now = new Date()) {
  const from = input.date_from;
  const to = input.date_to;
  if (!validDateRange(from, to)) return { error: 'Use a valid date range of at most 31 days.' };
  const today = etDateString(now);

  const quality = await getScheduleQualityMeasurements({ date_from: from, date_to: to }, conn, now);
  if (quality.error) return quality; // Defensive only: the same rule already passed above.

  const techs = await applyAssignable(conn('technicians')).select('technicians.id', 'technicians.name');
  const performance = await getRoutePerformance({ from, to, now }, conn);
  const planByKey = new Map(performance.plans.map(plan => [`${plan.date}|${plan.technicianId}`, plan]));
  const mileageByKey = await mileageByTechDay(conn, techs, from, to);

  const days = [];
  for (const day of quality.days) {
    const byTech = day.date < today
      ? day.byTech.map(techQuality => pastTechRow(techQuality, planByKey, mileageByKey, day.date))
      : await futureTechRows(conn, day, quality.driveModel);
    days.push({ date: day.date, closed: day.closed, byTech });
  }
  return {
    range: { from, to }, driveModel: quality.driveModel, days,
    note: 'Future/today rows are planned only — nothing recorded yet to compare against. '
      + 'Past rows compare the saved pre-service plan with recorded work. Unknown values are null, never 0.',
  };
}

module.exports = { routeScorecardEnabled, validDateRange, physicalStopCount, getDayScorecard };
