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

// ─── 1. drive_minutes_per_stop ──────────────────────────────────────────
// Business driving minutes (mileage_log, Bouncie) on days in the window,
// divided by completed stops on those same days. mileage_log.trip_date is
// already an ET calendar date (bouncie-mileage.js tripDateForBouncieStart ->
// etDateString), so it is compared directly against the ET window bounds —
// no timestamp-window conversion needed, unlike call_log/scheduled_services
// created_at below. is_business is read strictly (`= true`), matching the
// codebase's one canonical business-flag rule (bouncie-mileage.js: "ONLY an
// explicit is_business=true deducts" — unclassified/null and personal trips
// are excluded). scheduled_services.drive_time_minutes /
// distance_from_previous_miles and mileage_daily_summary are NOT used —
// verified empty/non-running in prod per the brief.
async function computeDriveMinutesPerStop({ from, to }, conn) {
  const [mileage, stopCount] = await Promise.all([
    conn('mileage_log')
      .where('trip_date', '>=', from)
      .where('trip_date', '<=', to)
      .where('is_business', true)
      .select(
        conn.raw('COALESCE(SUM(duration_minutes), 0) as total_minutes'),
        conn.raw('COALESCE(SUM(distance_miles), 0) as total_miles'),
      )
      .first(),
    conn('scheduled_services')
      .where('status', 'completed')
      .where('scheduled_date', '>=', from)
      .where('scheduled_date', '<=', to)
      .count('id as cnt')
      .first(),
  ]);
  const totalMinutes = parseFloat(mileage?.total_minutes || 0);
  const totalMiles = parseFloat(mileage?.total_miles || 0);
  const completedStops = parseInt(stopCount?.cnt, 10) || 0;
  return {
    numerator: totalMinutes,
    denominator: completedStops,
    share: shareOf(totalMinutes, completedStops),
    totalDriveMinutes: totalMinutes,
    totalMiles,
    completedStops,
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
  ).select('source_action', 'self_booking_id', 'source');
  const counts = { ai: 0, customer_self_serve: 0, staff: 0 };
  for (const row of rows) counts[classifyBooking(row)] += 1;
  const total = counts.ai + counts.customer_self_serve + counts.staff;
  const withoutStaff = counts.ai + counts.customer_self_serve;
  return {
    numerator: withoutStaff,
    denominator: total,
    share: shareOf(withoutStaff, total),
    ai: counts.ai,
    customerSelfServe: counts.customer_self_serve,
    staff: counts.staff,
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
// restricted to those completed stops. Fewer than 2 completed-and-timed
// stops can't violate an order, so those days score as followed (nothing to
// contradict the plan) — documented rather than silently assumed.
function planFollowed(plan, rowsById) {
  const completedIds = plan.plannedStops
    .map((stop) => stop.id)
    .filter((id) => rowsById.get(id)?.status === 'completed');
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
  let reordered = 0;
  const coveredTechDays = new Set();
  for (const plan of plans) {
    coveredTechDays.add(`${plan.date}|${plan.technician_id}`);
    if (planFollowed(plan, rowsById)) followed += 1;
    if (plan.snapshot_phase === 'applied_reorder') reordered += 1;
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
    const date = row.scheduled_date instanceof Date
      ? row.scheduled_date.toISOString().slice(0, 10)
      : String(row.scheduled_date).slice(0, 10);
    if (date >= today || !row.technician_id) continue;
    const key = `${date}|${row.technician_id}`;
    if (seenTechDays.has(key)) continue;
    seenTechDays.add(key);
    if (!coveredTechDays.has(key)) completedTechDaysWithNoSnapshot += 1;
  }

  return {
    numerator: followed,
    denominator: plans.length,
    share: shareOf(followed, plans.length),
    daysFollowed: followed,
    totalTechDaysWithSnapshot: plans.length,
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
    // Verified in prod 2026-09-26: EVERY mileage_log row in the last 30 days
    // is is_business=false (0 true, 0 null) — not a bug in this query. Per
    // bouncie-mileage.js, is_business is only ever set true by an operator-
    // configured business geo-fence; a proximity job match is a review
    // SUGGESTION and never auto-sets it, and the Tax Center manual-review
    // step that would flip a trip to business apparently has not been used.
    // drive_minutes_per_stop will read 0 until trips are classified there
    // (or the owner decides this metric should count all van driving
    // regardless of the tax-deduction business flag).
    'drive_minutes_per_stop: currently 0 in prod because no mileage_log trip '
      + 'has ever been marked is_business=true — a real reading of today\'s '
      + 'data, not a query bug. See ops-scoreboard.js comments.',
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
