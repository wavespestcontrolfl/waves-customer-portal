/**
 * Admin-only per-technician-day drive-vs-stops scorecard (GATE_ROUTE_SCORECARD).
 *
 * Pure composition over the two existing read-only reporters — no writes, no
 * geocoding, no traffic calls, and never a call into
 * refreshScheduleQualityAfterChange or any other writer:
 *   - day-quality.js's getScheduleQualityMeasurements for future/today rows
 *     (PLANNED ONLY — there is nothing recorded yet to compare against).
 *     Called with includeStopExtras:true so day-quality does the physical-
 *     stop and co-visit-aware on-site-minutes math on the SAME raw-stops
 *     read its own quality numbers use, instead of a second query here.
 *   - route-performance.js's getRoutePerformance for past rows: the saved
 *     pre-service snapshot (PLANNED-as-of-the-day-before) paired with
 *     recorded work (ACTUAL), plus a Bouncie mileage_log rollup for actual
 *     drive minutes (route-performance's own actualDriveMinutes/etc. are
 *     hard-coded null — this is the first real caller of that snapshot data,
 *     read straight from the plan object rather than duplicating it).
 *
 * A past technician-day with no saved snapshot (see getRoutePerformance's
 * own missingBaselineRoutes) reports planned:null rather than inventing one,
 * with plannedUnavailableReason distinguishing a definite "no_saved_plan"
 * from "may_be_truncated" (the newest-500-planner-runs cap can evict a real
 * baseline; truncatedPlanningRuns says which is true for this response).
 * Every null shows as "unknown" in the UI, never 0 (day-quality's own rule).
 */
const { validate: isUuid } = require('uuid');
const { etDateString, addETDays, validCalendarDate } = require('../../utils/datetime-et');
const { etDateDiffDays } = require('../recurring-appointment-seeder');
const { gateEnvValue } = require('../../config/feature-gates');
const { getScheduleQualityMeasurements, physicalStopCount } = require('./day-quality');
const { getRoutePerformance, getSavedDayPlans, physicalVisitCount } = require('./route-performance');
const { applyAssignable } = require('../technician-eligibility');

const MAX_RANGE_DAYS = 30; // Same 31-day inclusive cap as day-quality.
// Only these evidence grades are corroborated recorded work (route-performance's
// own distinction) — 'unverified_timing'/'unmatched_or_uncompleted_work' never
// contribute a minute to the actual side.
const RECORDED_EVIDENCE = new Set(['operator_corrected', 'operator_reported', 'recorded_lifecycle_interval']);
// measureRoutePerformance's arrivalOutcome values that mean the row was NOT
// completed on this route (missing/moved/still open) — every other value,
// including 'grouped_work_requires_review', only exists because row.status
// WAS 'completed' (see measureRoutePerformance's own branch order). Codex
// P1: durationEvidence is the wrong signal for "was this stop completed" —
// it's forced to 'unmatched_or_uncompleted_work' for ANY grouped stop
// regardless of real completion, so filtering on it dropped every completed
// grouped stop from the count.
const NOT_COMPLETED_OUTCOMES = new Set(['missing_visit', 'day_or_technician_changed', 'not_completed']);
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

function stopsPerHour(stops, departureMinutes, returnMinute) {
  if (!Number.isFinite(stops) || !Number.isFinite(departureMinutes) || !Number.isFinite(returnMinute) || returnMinute <= departureMinutes) return null;
  return stops / ((returnMinute - departureMinutes) / 60);
}

function driveShare(driveMinutes, onSiteMinutes) {
  if (!Number.isFinite(driveMinutes) || !Number.isFinite(onSiteMinutes) || driveMinutes + onSiteMinutes <= 0) return null;
  return driveMinutes / (driveMinutes + onSiteMinutes);
}

// Future/today: straight from the existing quality measurement. onSiteMinutes
// prefers day-quality's co-visit-aware coVisitOnSiteMinutes (a co-visit
// chain of fallback-duration rows counts once, matching what
// simulateArrivalRoute itself charges) over the plain serviceMinutes flat
// sum, which double-counts that case; physicalStops is day-quality's own
// count from the SAME raw stops, not a second dayStopsQuery here.
//
// allocationModelMismatch (Codex P2, round 9): a version-2 allocation's
// summed on-site minutes disagree with what the arrival simulation charged
// it, so the simulation's return/waiting/lateness — and stops/hour, which
// divides by that return — rest on a different duration model than the
// on-site total. They're reported unknown rather than mixed; drive minutes
// (travel legs, not durations) and the on-site total stand.
function plannedFutureRow(techQuality) {
  const onSiteMinutes = Number.isFinite(techQuality.coVisitOnSiteMinutes) ? techQuality.coVisitOnSiteMinutes
    : (Number.isFinite(techQuality.serviceMinutes) ? techQuality.serviceMinutes : null);
  const driveMinutes = techQuality.modeledDriveMinutes ?? null;
  const physicalStops = Number.isFinite(techQuality.physicalStops) ? techQuality.physicalStops : null;
  const simulated = techQuality.allocationModelMismatch ? {} : techQuality;
  const returnMinute = simulated.modeledReturnMinuteBeforeBreaks ?? null;
  return {
    stops: techQuality.scheduledVisits, physicalStops,
    onSiteMinutes, driveMinutes, waitMinutes: simulated.modeledWaitingMinutes ?? null,
    driveShare: driveShare(driveMinutes, onSiteMinutes),
    stopsPerHour: stopsPerHour(physicalStops, DEPARTURE_MINUTES, returnMinute),
    returnMinute, lateVisits: simulated.modeledLateVisits ? simulated.modeledLateVisits.length : null,
  };
}

// Past, PLANNED-as-of-the-day-before: the saved snapshot's own numbers
// (route-performance's passthrough fields), never recomputed here.
// onSiteMinutes is the snapshot's flat per-stop sum, NOT co-visit-aware: plan.stops keeps only ids/durations/windows, not
// the customer/premise/coordinate columns isCoVisitPair needs to detect a
// co-visit at all, so a co-visited pair sharing a fallback duration MAY be
// double-counted here (see getDayScorecard's assumptions.plannedOnSiteMinutes
// — noted rather than silently wrong or falsely "fixed").
//
// physicalStops is route-performance's plannedPhysicalStops — member rows
// sharing a visitId collapse to one, and null when the snapshot can't prove
// the count (see physicalVisitCount). stops/hour divides by it and is null
// with it (Codex P2, round 9): the raw row count would overstate throughput
// whenever an unrecognized co-visit or allocation is in the plan.
function plannedPastRow(plan) {
  if (!plan) return null;
  const physicalStops = Number.isFinite(plan.plannedPhysicalStops) ? plan.plannedPhysicalStops : null;
  return {
    stops: plan.plannedVisits, physicalStops,
    onSiteMinutes: plan.plannedServiceMinutes, driveMinutes: plan.plannedDriveMinutes,
    waitMinutes: plan.plannedWaitingMinutes,
    driveShare: driveShare(plan.plannedDriveMinutes, plan.plannedServiceMinutes),
    stopsPerHour: stopsPerHour(physicalStops, DEPARTURE_MINUTES, plan.plannedReturnMinuteBeforeBreaks),
    returnMinute: plan.plannedReturnMinuteBeforeBreaks, lateVisits: null,
  };
}

// Past, ACTUAL: on-site minutes summed from evidence-graded recorded
// durations (coverage reported alongside so a partial sum never reads as a
// complete one — see onSiteCoverage on the client) and drive minutes summed
// from mileage_log (null, not 0, when no trip rows exist).
//
// `stops` (Codex P2, round 3) is the COMPLETED stop count for the tech-day —
// planned-and-completed (plan.stops entries whose arrivalOutcome proves the
// row was completed on this route — NOT the durationEvidence-based check an
// earlier round used, which forces 'unmatched_or_uncompleted_work' onto
// every grouped stop regardless of real completion and silently dropped a
// completed group from the count, Codex P1) plus any same-day job completed
// outside the snapshot (unbaselined, below). physicalStops collapses
// visitId groups only (actualPhysicalStops): route-performance's own select
// carries no premise/coordinate columns, so a same-property co-visit
// collapse is not derivable here the way it is from day-quality's own
// raw-stops read (plannedFutureRow).
//
// fallbackStops (Codex P1/P2, round 3): a MISSING-baseline tech-day (no
// saved plan at all) still has route-performance's own raw completed rows,
// shaped exactly like plan.stops (missingBaselineActualStops) — reusing the
// SAME aggregation below instead of a second formula. Every completed row
// in fallbackStops already counts toward `stops`; there is no separate
// "unbaselined" concept when there was never a baseline to compare against.
//
// onSiteCoverage.unbaselined (Codex P1): plan.stops is the SAVED snapshot —
// a job added to the route after the snapshot was captured and then
// completed the same day exists in `enriched` (route-performance's own
// scheduled_services read) but never in plan.stops, so covered/total alone
// would silently omit it and read as full coverage. route-performance.js's
// getRoutePerformance already tallies this per route
// (plan.unbaselinedCompletedVisits, the per-key breakdown behind its
// top-level unbaselinedCompletedVisits count) — carried straight through so
// the UI can mark the day partial and say so.
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
function actualPastRow(plan, mileage, fallbackStops) {
  const drive = actualDrive(mileage);
  const stops = plan ? plan.stops : fallbackStops;
  if (!stops) return { stops: null, physicalStops: null, onSiteMinutes: null, onSiteCoverage: null, ...drive, spanMinutes: null, spanCoverage: null };
  // Coverage is over the stops actually completed on this route (Codex P2,
  // round 9) — the same predicate as `stops` below; a moved/cancelled/never-
  // completed planned stop has no on-site time to record and never makes
  // the performed work read partial. Unbaselined work stays its own marker.
  const completedOnRoute = stops.filter(stop => !NOT_COMPLETED_OUTCOMES.has(stop.arrivalOutcome));
  const recorded = completedOnRoute.filter(stop => RECORDED_EVIDENCE.has(stop.durationEvidence) && Number.isFinite(stop.recordedServiceMinutes));
  const onSiteMinutes = recorded.length ? recorded.reduce((sum, stop) => sum + stop.recordedServiceMinutes, 0) : null;
  // A same-day added (unbaselined) completed job's own recorded arrival/
  // completion counts toward the SPAN too (Codex P2, round 5) — route-
  // performance.js already loads it (the same pastWork pass that counts
  // unbaselinedCompletedVisits) and exposes it per route as
  // plan.unbaselinedStops, so this is the actual first-arrival-to-last-
  // completion span for the tech-day, not just the snapshot's own stops. It
  // never contributes to onSiteMinutes/onSiteCoverage — its duration still
  // isn't independently trusted the way a planned, matched stop's is.
  //
  // A saved-plan stop reads its lifecycle* minutes (Codex P2, round 6):
  // measureRoutePerformance nulls recorded* on grouped (visit_id) work
  // because its DURATION isn't comparable, but its corroborated arrival/
  // completion still bound the day. Fallback and unbaselined stops already
  // carry grouped work's times in recorded* (their durations are what gets
  // forced null there), so they fall through to it.
  const spanStops = plan && Array.isArray(plan.unbaselinedStops) ? [...stops, ...plan.unbaselinedStops] : stops;
  const unbaselined = plan && Number.isFinite(plan.unbaselinedCompletedVisits) ? plan.unbaselinedCompletedVisits : 0;
  const completedStops = completedOnRoute.length + unbaselined;
  return { stops: completedStops, physicalStops: actualPhysicalStops(plan, fallbackStops), onSiteMinutes,
    onSiteCoverage: { covered: recorded.length, total: completedOnRoute.length, unbaselined },
    ...drive, ...actualSpan(spanStops) };
}

// Completed service rows collapsed by visitId — planned-and-completed plan
// stops, same-day added (unbaselined) rows, or a missing-baseline day's
// fallback rows — with physicalVisitCount, the SAME rule the saved plan's
// plannedPhysicalStops uses, so a two-service visit reads Planned 1 /
// Actual 1, not 1 / 2 (Codex pre-push P1). null when any completed row's
// group identity is unknown: a row with no visitId key at all, or
// unbaselined work that was counted but not itemized.
function actualPhysicalStops(plan, fallbackStops) {
  const unitemized = plan && !Array.isArray(plan.unbaselinedStops) && plan.unbaselinedCompletedVisits > 0;
  const completed = plan
    ? [...plan.stops.filter(stop => !NOT_COMPLETED_OUTCOMES.has(stop.arrivalOutcome)), ...(plan.unbaselinedStops || [])]
    : fallbackStops;
  if (unitemized || !completed.every(stop => 'visitId' in stop)) return null;
  return physicalVisitCount(completed);
}

// First recorded arrival to last recorded completion over the COMPLETED
// stops (plan stops whose arrivalOutcome proves completion; unbaselined and
// fallback stops are completed by construction). spanCoverage (Codex P2,
// round 7): a completed stop missing either boundary — e.g. an operator-
// corrected duration, whose completion recordedTiming deliberately leaves
// null — could have opened or closed the day, so the span over the rest is
// only a lower bound. It's still shown, but with covered < total so the UI
// marks it partial instead of passing it off as the whole day.
function actualSpan(spanStops) {
  const completed = spanStops.filter(stop => !NOT_COMPLETED_OUTCOMES.has(stop.arrivalOutcome));
  const arrivalOf = stop => stop.lifecycleArrivalMinute ?? stop.recordedArrivalMinute;
  const completionOf = stop => stop.lifecycleCompletionMinute ?? stop.recordedCompletionMinute;
  const arrivals = completed.map(arrivalOf).filter(Number.isFinite);
  const completions = completed.map(completionOf).filter(Number.isFinite);
  const covered = completed.filter(stop => Number.isFinite(arrivalOf(stop)) && Number.isFinite(completionOf(stop))).length;
  return {
    spanMinutes: arrivals.length && completions.length ? Math.max(...completions) - Math.min(...arrivals) : null,
    spanCoverage: { covered, total: completed.length },
  };
}

// driveMinutes sums only trips with a known duration (duration_minutes is
// nullable); driveCoverage (Codex P2, round 7) says how many of the day's
// counted trips that is, and driveMinutes is null — never a definitive 0 —
// when none of them has one.
function actualDrive(mileage) {
  if (!mileage) return { driveMinutes: null, driveTrips: null, driveCoverage: null };
  return { driveMinutes: mileage.timedTrips ? mileage.minutes : null, driveTrips: mileage.trips,
    driveCoverage: { timed: mileage.timedTrips, total: mileage.trips } };
}

// bouncie-mileage.js's own canonical predicates (getIrsReport, the daily/
// monthly summaries): purpose === 'personal' is the ONE definitive,
// non-suggested classification (a matched personal-address geofence) —
// proven NOT work driving. 'commute' is the schema's third documented
// purpose (server/models/migrations/20260401000070_mileage_bouncie.js), never
// actually written by the sync code today, excluded on the same basis if it
// ever is. Everything else — 'business', or 'unclassified' (no job/fence
// match; getIrsReport deliberately treats that as neither business nor
// personal for the TAX deduction question, $0 until an operator confirms
// it) — counts as day driving HERE, because this is an OPERATIONAL
// drive-time metric, not a deduction: an unclassified trip is still time the
// vehicle was moving that workday. Reported so this choice is visible, not
// silent (see getDayScorecard's assumptions and the UI's drive-model note).
const EXCLUDED_MILEAGE_PURPOSES = ['personal', 'commute'];
const MILEAGE_NOTE = 'Actual drive minutes sum mileage_log trips for the day, excluding personal and commute trips; '
  + 'unclassified trips (no confirmed business/personal match) are counted as day driving.';
const PLANNED_ONSITE_NOTE = "Board on-site minutes count a co-visited pair once. Past and today's saved-plan on-site "
  + 'minutes come from the saved snapshot, which cannot detect a co-visit (no customer/premise/coordinate columns) and may '
  + 'double-count one; past ACTUAL minutes are unaffected (summed from recorded evidence per row).';

// Date range + technician_id IS NOT NULL only — NOT the assignable-tech
// list (a deactivated/no-longer-eligible technician's own history must not
// vanish; see getDayScorecard). Aggregated in JS, not SQL: mileage_log has
// no index-friendly way to express "purpose is NULL or not personal/commute"
// without a NULL-handling trap in a raw NOT IN, and the row volume for an
// admin-only, <=31-day report is trivial either way.
async function mileageByTechDay(conn, from, to) {
  const rows = await conn('mileage_log')
    .whereNotNull('technician_id')
    .whereBetween('trip_date', [from, to])
    .select('technician_id', 'trip_date', 'duration_minutes', 'purpose');
  const byKey = new Map();
  for (const row of rows) {
    if (EXCLUDED_MILEAGE_PURPOSES.includes(row.purpose)) continue;
    const key = `${dateOnly(row.trip_date)}|${row.technician_id}`;
    const entry = byKey.get(key) || { minutes: 0, trips: 0, timedTrips: 0 };
    // Number(null) and Number('') are 0 — an unknown duration must stay
    // unknown, not become a zero-minute trip.
    const minutes = row.duration_minutes == null || row.duration_minutes === '' ? NaN : Number(row.duration_minutes);
    if (Number.isFinite(minutes)) { entry.minutes += minutes; entry.timedTrips += 1; }
    entry.trips += 1;
    byKey.set(key, entry);
  }
  return byKey;
}

function pastTechRow({ technicianId, technician }, planByKey, mileageByKey, missingBaselineStopsByKey, date, truncatedPlanningRuns) {
  const key = `${date}|${technicianId}`;
  const plan = planByKey.get(key) || null;
  const mileage = mileageByKey.get(key) || null;
  const fallbackStops = plan ? null : (missingBaselineStopsByKey.get(key) || null);
  return { technicianId, technician,
    driveModel: plan ? plan.driveModel : null,
    // Distinct from a definite "never had a baseline": the newest-500
    // planner-runs cap can evict a real one (see getDayScorecard), and this
    // response can't tell the two apart for any one row.
    plannedUnavailableReason: plan ? null : (truncatedPlanningRuns ? 'may_be_truncated' : 'no_saved_plan'),
    planned: plannedPastRow(plan), actual: actualPastRow(plan, mileage, fallbackStops) };
}

// plannedBasis says what the planned column measures. A future day is the
// live board ('board'). TODAY (Codex P2, round 7) prefers the saved
// pre-service snapshot ('saved_plan', same numbers a past row's Planned
// column reads): the live board excludes completed visits
// (QUALITY_EXCLUDED_STATUSES), so its totals shrink as the day's work gets
// done. Without a saved plan, today falls back to the board, labeled
// 'remaining_route' so it never reads as the whole day's plan.
//
// Today's roster also takes every technician with a saved plan for today
// (Codex P2, round 10), as past days already take their history: one who
// became inactive/non-assignable after the snapshot is gone from day.byTech,
// and their completed planned work is gone from the unallocated footer too
// (day-quality excludes completed rows), so the saved plan is the only
// place it shows. Named via nameById (no assignable filter).
function futureTechRows(day, driveModel, savedPlans, nameById) {
  const rows = day.byTech.map(techQuality => {
    const saved = savedPlans ? savedPlans.get(techQuality.technicianId) : null;
    if (saved) {
      return { technicianId: techQuality.technicianId, technician: techQuality.technician,
        driveModel: saved.driveModel, plannedBasis: 'saved_plan', planned: plannedPastRow(saved), actual: null };
    }
    return { technicianId: techQuality.technicianId, technician: techQuality.technician, driveModel,
      plannedBasis: savedPlans ? 'remaining_route' : 'board',
      planned: plannedFutureRow(techQuality), actual: null };
  });
  const onBoard = new Set(day.byTech.map(techQuality => techQuality.technicianId));
  for (const [technicianId, saved] of savedPlans || []) {
    if (onBoard.has(technicianId)) continue;
    rows.push({ technicianId, technician: nameById.get(technicianId) || null,
      driveModel: saved.driveModel, plannedBasis: 'saved_plan', planned: plannedPastRow(saved), actual: null });
  }
  return rows;
}

// Past completed work with NO technician at all (Codex P2, round 10):
// route-performance reports it as a missing-baseline route keyed
// "date|" and builds its recorded rows, and day-quality's unallocated
// footer excludes completed work, so without this row it vanished. Shown
// as one "Unassigned" row — no plan or mileage can belong to it.
function unassignedPastRow(date, missingBaselineStopsByKey) {
  const fallbackStops = missingBaselineStopsByKey.get(`${date}|`);
  if (!fallbackStops || !fallbackStops.length) return null;
  return { technicianId: null, technician: 'Unassigned', driveModel: null, plannedUnavailableReason: 'unassigned',
    planned: null, actual: actualPastRow(null, null, fallbackStops) };
}

// keyed "date|technicianId" -> Map(date -> Set(technicianId)), shared by the
// plan and mileage lookups so a past day's roster can include a technician
// history alone still evidences.
function idsByDate(keyedMap) {
  const byDate = new Map();
  for (const key of keyedMap.keys()) {
    const [date, technicianId] = key.split('|');
    if (!byDate.has(date)) byDate.set(date, new Set());
    byDate.get(date).add(technicianId);
  }
  return byDate;
}

// route-performance's own record of "past work exists, no covering plan" —
// the SAME condition that would otherwise silently drop this technician's
// day from the roster if their only evidence is a missing baseline (no
// plan, and no mileage that day either). Non-null technicianIds only: a
// route with no technician at all gets its own Unassigned row instead
// (unassignedPastRow).
function missingBaselineIdsByDate(routes = []) {
  const byDate = new Map();
  for (const route of routes) {
    if (!route.technicianId) continue;
    if (!byDate.has(route.date)) byDate.set(route.date, new Set());
    byDate.get(route.date).add(route.technicianId);
  }
  return byDate;
}

// A saved planner-run snapshot's technician_id is untrusted JSONB, not a
// DB-validated column (mileage_log/missingBaselineRoutes technicianIds come
// straight from a real FK column and are always well-formed already) — a
// malformed/corrupted value passed straight into whereIn('id', ...) against
// a uuid column would 500 the whole request (Codex P2). Dropped from the
// lookup query entirely; its row still renders (the roster keeps the id),
// labeled 'unknown technician' rather than leaking the raw garbage value.
async function resolveHistoricalNames(conn, techs, idsByDateMaps) {
  const known = new Set(techs.map(tech => tech.id));
  const historicalIds = new Set();
  for (const map of idsByDateMaps) for (const set of map.values()) for (const id of set) historicalIds.add(id);
  const unresolved = [...historicalIds].filter(id => !known.has(id));
  const missingIds = unresolved.filter(id => isUuid(id));
  const malformedIds = unresolved.filter(id => !isUuid(id));
  const extra = missingIds.length ? await conn('technicians').whereIn('id', missingIds).select('id', 'name') : [];
  return new Map([
    ...techs.map(tech => [tech.id, tech.name]),
    ...extra.map(tech => [tech.id, tech.name]),
    ...malformedIds.map(id => [id, 'unknown technician']),
  ]);
}

// PAST rosters are NOT day.byTech (getScheduleQualityMeasurements' own
// applyAssignable-filtered list) — a deactivated/no-longer-eligible
// technician's saved snapshot, mileage history, or known-missing baseline
// would silently vanish from their own PAST day. Instead: the union of
// technicianIds evidenced in the plans/mileage/missing-baseline records for
// THIS date, plus every currently-assignable technician (so a day with no
// history for an active technician still shows their empty row, matching
// the future/today board's own "every technician gets a row" behavior).
function pastDayRoster(date, techs, idsByDateMaps) {
  const ids = new Set(techs.map(tech => tech.id));
  for (const map of idsByDateMaps) for (const id of (map.get(date) || [])) ids.add(id);
  return ids;
}

function pastDayRows(date, { techs, idsByDateMaps, nameById, planByKey, mileageByKey, missingBaselineStopsByKey, truncatedPlanningRuns }) {
  const rows = [...pastDayRoster(date, techs, idsByDateMaps)].map(technicianId => pastTechRow(
    { technicianId, technician: nameById.get(technicianId) || null }, planByKey, mileageByKey,
    missingBaselineStopsByKey, date, truncatedPlanningRuns));
  const unassigned = unassignedPastRow(date, missingBaselineStopsByKey);
  return unassigned ? [...rows, unassigned] : rows;
}

async function getDayScorecard(input = {}, conn = require('../../models/db'), now = new Date()) {
  const from = input.date_from;
  const to = input.date_to;
  if (!validDateRange(from, to)) return { error: 'Use a valid date range of at most 31 days.' };
  const today = etDateString(now);

  const quality = await getScheduleQualityMeasurements({ date_from: from, date_to: to, includeStopExtras: true }, conn, now);
  if (quality.error) return quality; // Defensive only: the same rule already passed above.

  const techs = await applyAssignable(conn('technicians')).select('technicians.id', 'technicians.name');
  // Past rows never need a route-performance snapshot dated today or later.
  // Asking for one anyway lets the nightly reorder's future-dated planner
  // runs (D+1..D+6) compete for getRoutePerformance's newest-500-runs cap
  // and evict a genuinely past baseline this exact range needed (Codex P1)
  // — cheap to avoid since the future side never reads `performance` at all.
  const yesterday = etDateString(addETDays(now, -1));
  const pastTo = to < yesterday ? to : yesterday;
  const performance = pastTo >= from
    ? await getRoutePerformance({ from, to: pastTo, now }, conn)
    : { plans: [], missingBaselineRoutes: [], missingBaselineStops: new Map(), truncatedPlanningRuns: false };
  const planByKey = new Map(performance.plans.map(plan => [`${plan.date}|${plan.technicianId}`, plan]));
  const mileageByKey = await mileageByTechDay(conn, from, to);
  const planIdsByDate = idsByDate(planByKey);
  const mileageIdsByDate = idsByDate(mileageByKey);
  const missingIdsByDate = missingBaselineIdsByDate(performance.missingBaselineRoutes);
  const missingBaselineStopsByKey = performance.missingBaselineStops || new Map();
  const idsByDateMaps = [planIdsByDate, mileageIdsByDate, missingIdsByDate];
  const truncatedPlanningRuns = Boolean(performance.truncatedPlanningRuns);
  const todayPlans = from <= today && to >= today
    ? await getSavedDayPlans({ date: today, now }, conn) : null;
  const todayIdsByDate = new Map([[today, new Set(todayPlans ? todayPlans.keys() : [])]]);
  const nameById = await resolveHistoricalNames(conn, techs, [...idsByDateMaps, todayIdsByDate]);

  const days = [];
  for (const day of quality.days) {
    const byTech = day.date < today
      ? pastDayRows(day.date, { techs, idsByDateMaps, nameById, planByKey, mileageByKey, missingBaselineStopsByKey, truncatedPlanningRuns })
      : futureTechRows(day, quality.driveModel, day.date === today ? todayPlans : null, nameById);
    days.push({ date: day.date, closed: day.closed, byTech,
      // Stops assigned to no assignable technician at all (unassigned, or an
      // offboarding/ineligible tech that still carries assigned work — Codex
      // P1) never get a named row; day-quality already tallies this at the
      // day level, so it's surfaced instead of a silently missing tech row.
      unallocated: { visits: day.unallocatedVisits, serviceMinutes: day.unallocatedServiceMinutes } });
  }
  return {
    range: { from, to }, driveModel: quality.driveModel, days, truncatedPlanningRuns,
    assumptions: { actualDriveMinutes: MILEAGE_NOTE, plannedOnSiteMinutes: PLANNED_ONSITE_NOTE },
    note: 'Future/today rows are planned only — nothing recorded yet to compare against. Today uses the saved '
      + 'pre-service plan when one exists, else the remaining route (completed visits drop out of it). '
      + 'Past rows compare the saved pre-service plan with recorded work. Unknown values are null, never 0. '
      + MILEAGE_NOTE,
  };
}

module.exports = { routeScorecardEnabled, validDateRange, physicalStopCount, getDayScorecard };
