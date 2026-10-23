/**
 * PLAN TAKEN-HOUR HAND-OFF (owner 2026-10-22, auto-dispatch audit decision
 * D4: "If the automatic visit plan lands on a taken time, leave the visit
 * without a time so the tool picks a free one"). Dark behind
 * GATE_PLAN_TAKEN_HOUR_HANDOFF, read at call time (unset = live kill).
 *
 * Two plan writers copy the plan's hour onto a new visit without asking
 * whether it is free, and the 10-22 audit traced double bookings to them:
 *   - the follow-up seeder (recurring-appointment-seeder.js
 *     seedFollowUpsForParent: booking, estimate conversion, admin create),
 *     which has no clash check at all;
 *   - the nightly top-up (routes/admin-schedule.js walkExtensionCandidates,
 *     overlapAdvisoryOnly), which inserts on a clash and logs it.
 * Gate on, a new plan visit whose hour another customer's live visit already
 * holds is written WINDOWLESS and handed to auto-dispatch with its cadence
 * date as recurring_dispatch_due_date: the shape a series move gives a
 * deferred occurrence (rebooker.js rescheduleSeries; the due-date lifecycle
 * is scheduling/recurring-dispatch-due.js). The night tool places it within
 * three days of that date (gap-candidates.js) and its due-date notice tells a
 * person if it cannot (auto-dispatch/audit.js flagUnplacedVisits).
 *
 * "Taken" is the night tool's own double-booking rule
 * (auto-dispatch/current-conflict.js), read through the shared plan-writer
 * probe (window-rules.js seriesCandidateDateClashRows): a live stop in the
 * hour — tech-blind until the schedule is technician-scoped (then only the
 * new visit's own technician's stops and unassigned ones; isOtherStop), with the
 * writer's own statuses (rebooker.js probeMoveConflicts: no cancelled,
 * skipped, no-show or rescheduled row, nor a completed one) and the owner's
 * booked interviews (occupancy.js includeInterviews: a failed interview read
 * throws, as on every writer that reads them). The same
 * customer at the same place is one stop with the new visit, not a conflict
 * (current-conflict.js samePlaceIdsAt, measured from the new visit's own
 * place, which can differ from any stored row of its plan); the same
 * customer at another property, or at a place that cannot be read, is a
 * conflict (Codex #6476 r1, r2). Probe-only, no lock, like every plan-writer
 * probe; a same-instant booking can still overlap, and the night tool's
 * conflict read catches that one.
 *
 * Only from HANDOFF_MIN_DAYS_OUT days ahead: the night tool never moves a
 * visit inside its 73-hour freeze, so a nearer visit keeps its hour and the
 * double booking reaches a person through the needs-a-person notice, as
 * before. The completion-time extend is unchanged (it skips a clashing date).
 *
 * CALL FOLLOW-UP FREE HOUR (owner 2026-10-22, "fix", after the Oct 30 call
 * follow-up landed on another customer's 10 AM): the call pipeline's visit 2
 * (call-recording-processor.js) copies visit 1's hour when the call set no
 * time. Dark behind GATE_CALL_FOLLOWUP_FREE_HOUR (call time). On, when the
 * same "taken" rule holds any of visit 2's span on its date (its hour, or
 * its whole job when longer), visit 2 takes the nearest whole hour that day
 * where that span fits the shift and is free (callFollowUpWindow): the
 * night tool never places a one-off visit (it loads recurring series only),
 * so the hour is chosen here. Unlike the plan writers' probe, it is read
 * under the call booking's own fence (occupancy.js fenceBookingDay, taken
 * just before), so two fenced call bookings cannot pick the same free hour.
 * A time set on the call, and a two-treatment package's visit 2 (visit 1's
 * time, owner 2026-10-04 "same time"), keep theirs; a day with no free hour
 * keeps the copied one, as before.
 */
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { toDateStr } = require('../auto-dispatch/dates');
const { seriesCandidateDateClashRows, parseHHMM, minutesToHHMM } = require('./window-rules');
const { formatSmsTime } = require('../../utils/sms-time-format');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');

const GATE = 'GATE_PLAN_TAKEN_HOUR_HANDOFF';
const CALL_FOLLOWUP_GATE = 'GATE_CALL_FOLLOWUP_FREE_HOUR';
const HANDOFF_MIN_DAYS_OUT = 4;
// The rows that are no stop in the hour: the night tool's own
// (rebooker.js probeMoveConflicts).
const TAKEN_EXCLUDE_STATUSES = [...NOT_A_ROUTE_STOP_STATUSES, 'completed'];

function handoffEnabled() {
  return !!gateEnvValue(GATE);
}

// The first date the hand-off applies to (ET).
function firstHandoffDate(now = new Date()) {
  return etDateString(addETDays(now, HANDOFF_MIN_DAYS_OUT));
}

// The columns a hand-off writes (with `cols`, those the table has). The
// legacy presentation fields go too: customer-facing context and route
// reorder fall back to window_display, then time_window, when window_start is
// null (rebooker.js, deferred occurrence), so a copied one would keep
// promising the taken hour.
function handoffFields(date, cols = null) {
  const fields = {
    window_start: null,
    window_end: null,
    time_window: null,
    window_display: null,
    route_order: null,
    recurring_dispatch_due_date: toDateStr(date),
  };
  return cols ? Object.fromEntries(Object.entries(fields).filter(([key]) => cols[key])) : fields;
}

// Whether `row` (a new plan visit: customer, technician, date, window, and
// its own place fields) would land on an hour another stop holds, and is far
// enough out for the night tool to place it. False with the gate off,
// without a window, or inside HANDOFF_MIN_DAYS_OUT — nothing is read then.
async function takenHourHandoff(conn, row, { date = row?.scheduled_date, now = new Date() } = {}) {
  if (!handoffEnabled() || !row || !row.window_start) return false;
  const day = toDateStr(date);
  if (!day || day < firstHandoffDate(now)) return false;
  return hourTaken(conn, row, day);
}

// Whether another stop holds `row`'s hour on `day`: the rule in the header.
async function hourTaken(conn, row, day) {
  const rows = await seriesCandidateDateClashRows(conn, row, day, {
    excludeStatuses: TAKEN_EXCLUDE_STATUSES,
    includeInterviews: true,
  });
  const { isOtherStop, samePlaceIdsAt } = require('../auto-dispatch/current-conflict');
  const clash = rows.filter((r) => isOtherStop(r, row));
  if (!clash.length) return false;
  // The new visit's own place: its fields with the plan's template address
  // override applied, exactly as both writers stamp it on the insert
  // (booking/visit-financial-stamps.js recurringServiceAddress).
  const { recurringServiceAddress } = require('../booking/visit-financial-stamps');
  const samePlace = row.customer_id
    ? await samePlaceIdsAt(conn, { ...row, ...recurringServiceAddress(row) }, clash)
    : new Set();
  return clash.some((r) => !samePlace.has(String(r.id)));
}

// The whole-hour starts (minutes) at which a visit `spanMin` long fits the
// shift (scheduling/policy.js placementFitsShift), nearest to `plannedMin`
// first and the later of two equally near; `plannedMin` itself is not one.
function freeHourCandidates(plannedMin, spanMin) {
  const { SHIFT, placementFitsShift } = require('./policy');
  const starts = [];
  for (let start = SHIFT.startMinutes; start < SHIFT.endMinutes; start += 60) {
    if (start !== plannedMin && placementFitsShift(start, start + spanMin)) starts.push(start);
  }
  return starts.sort((a, b) => Math.abs(a - plannedMin) - Math.abs(b - plannedMin) || b - a);
}

// The window visit 2 of a call is written with (CALL FOLLOW-UP FREE HOUR,
// header): `planned` (its window_start, window_end and window_display) unless
// the gate is on, the call set no time, it is no package visit, and another
// stop holds part of its span on `date` — then the span at the nearest whole
// hour that day where it fits the shift and is free, or `planned` when there
// is none. The span is the planned window, or the job's `durationMinutes`
// when longer (the estimated_duration_minutes the insert stores; Codex #6495
// r1 P1: a three-hour job moved into a one-hour window would run past close
// over hours that read as free). The probe reads visit 2 as the writer
// inserts it: the technician it resolved and visit 1's place. The caller
// reads it after its booking fence; the reads run in their own savepoint of
// its transaction, so a failed read keeps `planned` and never aborts the
// booking. Never throws.
async function callFollowUpWindow(conn, { visit1 = {}, customerId, technicianId = null, date, durationMinutes = null }, planned, { hourStated = false, packageVisit = false } = {}) {
  const day = toDateStr(date);
  const plannedMin = parseHHMM(planned?.window_start);
  if (!gateEnvValue(CALL_FOLLOWUP_GATE) || hourStated || packageVisit || !day || plannedMin == null) return planned;
  const plannedEndMin = parseHHMM(planned.window_end);
  const spanMin = Math.max(plannedEndMin > plannedMin ? plannedEndMin - plannedMin : 60, Number(durationMinutes) || 0);
  const span = (startMin) => ({ window_start: minutesToHHMM(startMin), window_end: minutesToHHMM(Math.min(startMin + spanMin, 23 * 60 + 59)) });
  const visit2 = {
    customer_id: customerId,
    technician_id: technicianId,
    property_id: visit1.property_id,
    service_address_line1: visit1.service_address_line1,
    service_address_line2: visit1.service_address_line2,
    service_address_city: visit1.service_address_city,
    service_address_zip: visit1.service_address_zip,
  };
  const logger = require('../logger');
  try {
    return await conn.transaction(async (sp) => {
      if (!await hourTaken(sp, { ...visit2, ...span(plannedMin) }, day)) return planned;
      for (const startMin of freeHourCandidates(plannedMin, spanMin)) {
        const moved = { ...span(startMin), window_display: formatSmsTime(minutesToHHMM(startMin)) };
        if (!await hourTaken(sp, { ...visit2, ...moved }, day)) {
          logger.info(`[plan-taken-hour] call follow-up on ${day}: ${planned.window_start} is taken — ${moved.window_start} instead`);
          return moved;
        }
      }
      logger.warn(`[plan-taken-hour] call follow-up on ${day}: ${planned.window_start} is taken and no whole hour that day is free — keeping it`);
      return planned;
    });
  } catch (err) {
    logger.warn(`[plan-taken-hour] call follow-up free-hour check failed (${err.message}); keeping ${planned.window_start}`);
    return planned;
  }
}

// The seeder's batch: each row whose hour is taken comes back handed off
// (the fields `cols` has). Returns the rows; the input array is not changed.
async function handOffTakenHours(conn, rows, { now = new Date(), cols = null } = {}) {
  if (!handoffEnabled() || !Array.isArray(rows) || !rows.length) return rows;
  const out = [];
  for (const row of rows) {
    out.push(await takenHourHandoff(conn, row, { now }) ? { ...row, ...handoffFields(row.scheduled_date, cols) } : row);
  }
  const handedOff = out.filter((row, i) => row !== rows[i]).length;
  if (handedOff) {
    require('../logger').info(`[plan-taken-hour] parent ${rows[0].recurring_parent_id}: ${handedOff} follow-up(s) seeded without a time (hour taken); auto-dispatch places them`);
  }
  return out;
}

module.exports = {
  GATE, CALL_FOLLOWUP_GATE, HANDOFF_MIN_DAYS_OUT, TAKEN_EXCLUDE_STATUSES, handoffEnabled, firstHandoffDate, handoffFields,
  takenHourHandoff, handOffTakenHours, callFollowUpWindow,
};
