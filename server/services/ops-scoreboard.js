/**
 * Weekly ops scoreboard — four owner-approved metrics computed from existing
 * production data (owner ruling 2026-09-26). Read-only: no writes, no
 * customer communication, no side effects.
 *
 * Each metric is computed independently and wrapped in its own try/catch —
 * one bad query degrades that metric to `{ error: 'unavailable' }` rather
 * than failing the whole scoreboard. Every metric reports numerator,
 * denominator and share; share is `null` (never 0) when the denominator is
 * zero, per the owner's rule that "no data yet" must not read as "0%".
 *
 * Window: ET calendar dates [from, to] inclusive. Default is the last
 * completed 7-day week ending yesterday (today is a partial day).
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, validCalendarDate } = require('../utils/datetime-et');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const {
  VOICE_AGENT_BOOKING_SOURCE_ACTION,
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  isPendingOutboundReviewBooking,
} = require('./call-booking-source-actions');
const { selectPlanningSnapshots } = require('./scheduling/route-performance');

// 'ai_call_pipeline' is a literal in call-recording-processor.js (the
// inbound-call booking writer) — it is never exported as a named constant
// there (that module exports only the CallRecordingProcessor class), so it
// is reproduced here verbatim rather than imported. The other two AI
// source_actions (voice_agent, ai_call_outbound_review) ARE exported from
// call-booking-source-actions.js and are imported above.
const CALL_PIPELINE_SOURCE_ACTION = 'ai_call_pipeline';
const AI_BOOKING_SOURCE_ACTIONS = new Set([
  CALL_PIPELINE_SOURCE_ACTION,
  VOICE_AGENT_BOOKING_SOURCE_ACTION,
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
]);

const MAX_WINDOW_DAYS = 92;

// Mirrors admin-dashboard.js's own `applyETTimestampWindow` (not exported
// there — see CLAUDE.md rule 15 for the list of canonical shared helpers;
// this ET-midnight raw-SQL window is reimplemented per-file today, not one
// of them). Railway runs TZ=UTC, so a timestamptz column must be bounded by
// ET-midnight instants, never compared against a bare 'YYYY-MM-DD' string.
function applyETTimestampWindow(qb, column, from, to) {
  return qb
    .whereRaw(`${column} >= ?::timestamp AT TIME ZONE 'America/New_York'`, [`${from}T00:00:00`])
    .whereRaw(`${column} <  (?::timestamp + INTERVAL '1 day') AT TIME ZONE 'America/New_York'`, [`${to}T00:00:00`]);
}

function resolveWindow({ from, to } = {}) {
  const today = etDateString();
  const defaultTo = etDateString(addETDays(new Date(), -1));
  const defaultFrom = etDateString(addETDays(new Date(), -7));
  let resolvedFrom = validCalendarDate(from) || defaultFrom;
  let resolvedTo = validCalendarDate(to) || defaultTo;
  if (resolvedFrom > resolvedTo) [resolvedFrom, resolvedTo] = [resolvedTo, resolvedFrom];
  if (resolvedTo > today) resolvedTo = today;
  const spanDays = Math.round(
    (Date.parse(`${resolvedTo}T00:00:00Z`) - Date.parse(`${resolvedFrom}T00:00:00Z`)) / 86400000,
  ) + 1;
  if (spanDays > MAX_WINDOW_DAYS) {
    resolvedFrom = etDateString(addETDays(new Date(`${resolvedTo}T12:00:00`), -(MAX_WINDOW_DAYS - 1)));
  }
  return { from: resolvedFrom, to: resolvedTo };
}

function shareOf(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

// A DATE column arrives as a Date at UTC midnight (Railway runs TZ=UTC) or
// as a 'YYYY-MM-DD' string; either way the calendar date is its first 10 chars.
function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

// ─── 1. drive_minutes_per_stop ──────────────────────────────────────────
// Drive time to each stop, from the technician's own status taps: en route
// (en_route_at) to arrived (arrived_at) on completed stops in the window.
// `share` here is the average minutes per timed stop. Verified in prod
// 2026-09-26: ~95% of completed stops carry both taps and the values are
// plausible (7–15 min typical, 11 min average over 94 stops). A gap over
// MAX_TAP_DRIVE_MINUTES is a forgotten tap, not a drive, and is left out.
//
// The van's GPS trips (mileage_log, Bouncie) cannot be tied to stops: none
// carry a job_id, none are classified business (every row is still
// 'needs_review'), and a trip has no start time to bound it to the route.
// So GPS appears only as the secondary "all van driving" total.
// scheduled_services.drive_time_minutes / distance_from_previous_miles are
// empty in prod and are not used.
const MAX_TAP_DRIVE_MINUTES = 180;

function tapDriveMinutes(stop) {
  const start = new Date(stop.en_route_at || NaN).getTime();
  const end = new Date(stop.arrived_at || NaN).getTime();
  const minutes = (end - start) / 60000;
  return minutes > 0 && minutes <= MAX_TAP_DRIVE_MINUTES ? minutes : null;
}

async function computeDriveMinutesPerStop({ from, to }, conn) {
  const [stops, trips] = await Promise.all([
    conn('scheduled_services')
      .where('status', 'completed')
      .where('scheduled_date', '>=', from)
      .where('scheduled_date', '<=', to)
      .select('en_route_at', 'arrived_at'),
    conn('mileage_log')
      .where('trip_date', '>=', from)
      .where('trip_date', '<=', to)
      .select('duration_minutes', 'distance_miles'),
  ]);
  const timed = stops.map(tapDriveMinutes).filter((minutes) => minutes != null);
  const driveMinutes = timed.reduce((sum, minutes) => sum + minutes, 0);
  return {
    numerator: driveMinutes,
    denominator: timed.length,
    share: shareOf(driveMinutes, timed.length),
    completedStops: stops.length,
    timedStops: timed.length,
    vanDrivingMinutes: trips.reduce((sum, trip) => sum + (Number(trip.duration_minutes) || 0), 0),
    vanDrivingMiles: trips.reduce((sum, trip) => sum + (Number(trip.distance_miles) || 0), 0),
  };
}

// ─── 2. ai_call_share ────────────────────────────────────────────────────
// Inbound calls the AI voice agent handled with no human transfer, divided
// by all ANSWERED inbound calls. Sandbox bake-off calls (source =
// 'voice_relay_sandbox') are excluded everywhere else in the codebase via
// whereNotSandboxCall (relay-protocol.js) and are excluded here the same
// way. answered_by / call_outcome vocabulary verified against the writers in
// server/routes/twilio-voice-webhook.js: answered_by IN
// ('human','ai_agent','voicemail'); a transferred AI call keeps
// answered_by='ai_agent' and gets call_outcome='ai_transferred' (the
// transfer does not change answered_by), so "AI-handled, no transfer" is
// answered_by='ai_agent' AND call_outcome IS DISTINCT FROM 'ai_transferred'.
function classifyCall(row) {
  if (row.answered_by === 'voicemail') return 'voicemail';
  if (row.answered_by === 'ai_agent') {
    return row.call_outcome === 'ai_transferred' ? 'transferred' : 'ai_handled';
  }
  if (row.answered_by === 'human') return 'human';
  return 'other';
}

async function computeAiCallShare({ from, to }, conn) {
  const rows = await applyETTimestampWindow(
    conn('call_log')
      .where('direction', 'inbound')
      .modify((qb) => whereNotSandboxCall(qb)),
    'created_at',
    from,
    to,
  ).select('answered_by', 'call_outcome');
  const counts = { ai_handled: 0, transferred: 0, human: 0, voicemail: 0, other: 0 };
  for (const row of rows) counts[classifyCall(row)] += 1;
  const answered = counts.human + counts.ai_handled + counts.transferred;
  return {
    numerator: counts.ai_handled,
    denominator: answered,
    share: shareOf(counts.ai_handled, answered),
    aiHandled: counts.ai_handled,
    transferred: counts.transferred,
    voicemail: counts.voicemail,
    humanAnswered: counts.human,
  };
}

// ─── 3. bookings_without_staff ──────────────────────────────────────────
// New bookings created in the window (scheduled_services.created_at, ET
// date), split ai / customer_self_serve / staff. Excludes recurring series
// children (recurring_parent_id), auto-created follow-ups
// (parent_service_id), import rows (source ILIKE '%import%'), and
// uncommitted estimate slot holds (customer_id IS NULL AND
// reservation_expires_at IS NOT NULL — the hold shape reserveSlot() writes
// in slot-reservation.js; commitReservation() clears reservation_expires_at
// and sets customer_id when a hold graduates into a real booking).
//
// ai = source_action IN ('ai_call_pipeline', 'voice_agent',
// 'ai_call_outbound_review') (see the constants imported/reproduced above).
// An AI-created booking still awaiting office review
// (isPendingOutboundReviewBooking — pending, not customer-confirmed) is not
// a booking yet: it is left out of every bucket and reported as
// aiPendingReview. Once the office confirms it, it counts as ai — the AI did
// the booking; staff approved it.
//
// customer_self_serve = self_booking_id IS NOT NULL (the public /book wizard
// stamps this — server/routes/booking.js sets `source: source || 'self_booked'`
// and `self_booking_id: bookingRow.id` on the same insert) OR source =
// 'reservice_link'.
//
// GAP (reported, not guessed): a customer accepting an estimate online goes
// through slot-reservation.js's reserveSlot() -> commitReservation(). Neither
// function stamps scheduled_services.source or booking_source — reserveSlot's
// insert (slot-reservation.js, the hold write) and commitReservation's update
// only set customer_id/reservation_service_mix, never `source` — so that row
// keeps the column's own DB default, 'admin' (migration
// 20260401000048_self_scheduling.js). Staff has no code path found that
// inserts a NEW scheduled_services row with source_estimate_id set (staff
// tooling in admin-schedule.js/admin-estimates.js only UPDATEs
// source_estimate_id on an existing row, e.g. re-linking); the only writers
// of a fresh row with source_estimate_id set are the customer-facing accept
// flow (slot-reservation.js, estimate-converter.js standalone companion
// rows) and the self-serve wizard (self_booking_id path, bucketed above).
// So the prod combo "source='admin' AND source_estimate_id set" (37 rows /
// 30d) is most likely customer self-serve, mislabeled by omission — but per
// the brief's instruction, since it is NOT distinguishable from a staff
// conversion by the data alone (source literally reads 'admin', the same
// value a staff-created row defaults to), these are counted as STAFF here,
// not guessed into customer_self_serve. Flagged in `notes`.
function classifyBooking(row) {
  if (AI_BOOKING_SOURCE_ACTIONS.has(row.source_action)) return 'ai';
  if (row.self_booking_id != null || row.source === 'reservice_link') return 'customer_self_serve';
  return 'staff';
}

async function computeBookingsWithoutStaff({ from, to }, conn) {
  const rows = await applyETTimestampWindow(
    conn('scheduled_services')
      .whereNull('recurring_parent_id')
      .whereNull('parent_service_id')
      .whereRaw("COALESCE(source, '') NOT ILIKE '%import%'")
      .whereNot((qb) => qb.whereNull('customer_id').whereNotNull('reservation_expires_at')),
    'created_at',
    from,
    to,
  ).select('source_action', 'self_booking_id', 'source', 'status', 'customer_confirmed');
  const counts = { ai: 0, customer_self_serve: 0, staff: 0 };
  let aiPendingReview = 0;
  for (const row of rows) {
    if (isPendingOutboundReviewBooking(row)) aiPendingReview += 1;
    else counts[classifyBooking(row)] += 1;
  }
  const total = counts.ai + counts.customer_self_serve + counts.staff;
  const withoutStaff = counts.ai + counts.customer_self_serve;
  return {
    numerator: withoutStaff,
    denominator: total,
    share: shareOf(withoutStaff, total),
    ai: counts.ai,
    customerSelfServe: counts.customer_self_serve,
    staff: counts.staff,
    aiPendingReview,
  };
}

// ─── 4. ai_route_days ────────────────────────────────────────────────────
// Completed tech-days driven in the order the nightly optimizer planned.
// Reuses route-performance.js's selectPlanningSnapshots (the canonical
// pre-day-plan selection: latest valid snapshot captured strictly before
// midnight of its date, "applied_reorder" outranking "loaded_schedule" for
// the same run) — never reimplemented here. plannedStops order is verified
// (server/services/scheduling/day-quality.js measureDayQuality ->
// currentOrder(), route-reorder-window-fit.js) to be the actual planned
// visiting order: currentOrder() mirrors the dispatch board's own sort
// (route_order, then window_start, then created_at) for a 'loaded_schedule'
// snapshot, and route-reorder.js's applied-reorder snapshot re-derives
// plannedStops from the NEWLY COMMITTED route_order right after a reorder
// applies (`finalIds.indexOf(stop.id) + 1`) — so in both phases plannedStops
// is the order the tech was meant to drive that day in.
//
// A tech-day is "followed" when its completed stops' actual arrival order
// (arrived_at, falling back to check_in_time) matches the plannedStops order
// restricted to those completed stops. Only stops still on the plan's own
// date and technician count, as in route-performance.js — a stop moved to
// another day or reassigned says nothing about this route. A tech-day with
// no such completed stop is not scored (null). Fewer than 2 completed-and-
// timed stops can't violate an order, so those days score as followed
// (nothing contradicts the plan) — documented rather than silently assumed.
function planFollowed(plan, rowsById) {
  const onThisRoute = (row) => row?.status === 'completed'
    && dateOnly(row.scheduled_date) === plan.date
    && row.technician_id === plan.technician_id;
  const completedIds = plan.plannedStops
    .map((stop) => stop.id)
    .filter((id) => onThisRoute(rowsById.get(id)));
  if (completedIds.length === 0) return null;
  const timed = completedIds
    .map((id) => {
      const row = rowsById.get(id);
      const at = row.arrived_at || row.check_in_time;
      return at ? { id, at: new Date(at).getTime() } : null;
    })
    .filter(Boolean);
  if (timed.length < 2) return true;
  const timedIds = new Set(timed.map((entry) => entry.id));
  const plannedOrder = completedIds.filter((id) => timedIds.has(id));
  const actualOrder = [...timed].sort((a, b) => a.at - b.at).map((entry) => entry.id);
  return plannedOrder.join('|') === actualOrder.join('|');
}

async function computeAiRouteDays({ from, to }, conn) {
  const now = new Date();
  const today = etDateString(now);
  const runs = await conn('route_optimization_planner_runs')
    .whereIn('run_type', ['route_tiers_nightly', 'route_repair_change', 'schedule_quality_change'])
    .where('start_date', '<=', to)
    .where('end_date', '>=', from)
    .whereRaw("jsonb_typeof(result->'route_quality') = 'array'")
    .orderBy('created_at', 'desc')
    .limit(501)
    .select('id', 'created_at', 'result');
  const plans = selectPlanningSnapshots(runs.slice(0, 500), { from, to, now });

  const plannedIds = [...new Set(plans.flatMap((plan) => plan.plannedStops.map((stop) => stop.id)))];
  const rows = plannedIds.length
    ? await conn('scheduled_services')
      .whereIn('id', plannedIds)
      .select('id', 'technician_id', 'scheduled_date', 'status', 'arrived_at', 'check_in_time')
    : [];
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  let followed = 0;
  let scored = 0;
  let reordered = 0;
  const coveredTechDays = new Set();
  for (const plan of plans) {
    coveredTechDays.add(`${plan.date}|${plan.technician_id}`);
    if (plan.snapshot_phase === 'applied_reorder') reordered += 1;
    const verdict = planFollowed(plan, rowsById);
    if (verdict === null) continue;
    scored += 1;
    if (verdict) followed += 1;
  }

  // Completed tech-days with no matching plan snapshot at all — reported
  // separately, never folded into the followed/total share.
  const completedWork = await conn('scheduled_services')
    .where('status', 'completed')
    .where('scheduled_date', '>=', from)
    .where('scheduled_date', '<=', to)
    .select('technician_id', 'scheduled_date');
  const seenTechDays = new Set();
  let completedTechDaysWithNoSnapshot = 0;
  for (const row of completedWork) {
    const date = dateOnly(row.scheduled_date);
    if (date >= today || !row.technician_id) continue;
    const key = `${date}|${row.technician_id}`;
    if (seenTechDays.has(key)) continue;
    seenTechDays.add(key);
    if (!coveredTechDays.has(key)) completedTechDaysWithNoSnapshot += 1;
  }

  return {
    numerator: followed,
    denominator: scored,
    share: shareOf(followed, scored),
    daysFollowed: followed,
    totalTechDaysWithSnapshot: plans.length,
    techDaysWithNoCompletedPlannedStop: plans.length - scored,
    daysWithAppliedReorder: reordered,
    completedTechDaysWithNoSnapshot,
  };
}

async function computeOpsScoreboard(range = {}, conn = db) {
  const window = resolveWindow(range);
  const notes = [
    'bookings_without_staff: rows with source=\'admin\' (including those with '
      + 'source_estimate_id set — the customer-facing estimate-accept flow never '
      + 'stamps a distinct source) are counted as staff, not customer '
      + 'self-serve, because the data does not distinguish a staff conversion '
      + 'from a customer accept in that case. See ops-scoreboard.js comments.',
    'drive_minutes_per_stop: average en-route → arrived minutes from the '
      + 'technician\'s status taps; van GPS trips are reported only as total '
      + 'driving because they are not linked to stops. See ops-scoreboard.js.',
  ];

  const results = await Promise.all([
    computeDriveMinutesPerStop(window, conn).catch((err) => {
      logger.error(`[ops-scoreboard] drive_minutes_per_stop failed: ${err.message}`);
      return { error: 'unavailable' };
    }),
    computeAiCallShare(window, conn).catch((err) => {
      logger.error(`[ops-scoreboard] ai_call_share failed: ${err.message}`);
      return { error: 'unavailable' };
    }),
    computeBookingsWithoutStaff(window, conn).catch((err) => {
      logger.error(`[ops-scoreboard] bookings_without_staff failed: ${err.message}`);
      return { error: 'unavailable' };
    }),
    computeAiRouteDays(window, conn).catch((err) => {
      logger.error(`[ops-scoreboard] ai_route_days failed: ${err.message}`);
      return { error: 'unavailable' };
    }),
  ]);
  const [driveMinutesPerStop, aiCallShare, bookingsWithoutStaff, aiRouteDays] = results;

  return {
    window,
    driveMinutesPerStop,
    aiCallShare,
    bookingsWithoutStaff,
    aiRouteDays,
    notes,
  };
}

module.exports = {
  computeOpsScoreboard,
  classifyCall,
  classifyBooking,
  planFollowed,
  resolveWindow,
};
