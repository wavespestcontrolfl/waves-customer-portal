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
 * same "taken" rule holds that hour on visit 2's date, visit 2 takes the
 * nearest free whole hour inside the shift that day (callFollowUpStart): the
 * night tool never places a one-off visit (it loads recurring series only),
 * so the hour is chosen here. A time set on the call, and a two-treatment
 * package's visit 2 (visit 1's time, owner 2026-10-04 "same time"), keep
 * theirs; a day with no free hour keeps the copied one, as before.
 */
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { toDateStr } = require('../auto-dispatch/dates');
const { seriesCandidateDateClashRows } = require('./window-rules');
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

// The whole-hour starts (HH:MM) of a one-hour visit inside the shift
// (scheduling/policy.js placementFitsShift), nearest to `planned` first and
// the later of two equally near; `planned` itself is not one of them.
function freeHourCandidates(planned) {
  const { SHIFT, placementFitsShift } = require('./policy');
  const [h, m] = String(planned).split(':').map(Number);
  const plannedMin = h * 60 + m;
  const starts = [];
  for (let start = SHIFT.startMinutes; start < SHIFT.endMinutes; start += 60) {
    if (start !== plannedMin && placementFitsShift(start, start + 60)) starts.push(start);
  }
  return starts
    .sort((a, b) => Math.abs(a - plannedMin) - Math.abs(b - plannedMin) || b - a)
    .map((start) => `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`);
}

// visit 2 as the probe reads it at `start`: a one-hour window, visit 1's
// place, and visit 1's technician else the default one (the writer's own
// order; call-recording-processor.js copies both).
function callFollowUpRow({ visit1 = {}, customerId, defaultTechnicianId = null, date }, start) {
  const [h, m] = start.split(':').map(Number);
  const endMin = Math.min(h * 60 + m + 60, 23 * 60 + 59);
  return {
    customer_id: customerId,
    technician_id: visit1.technician_id || defaultTechnicianId || null,
    scheduled_date: date,
    window_start: start,
    window_end: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`,
    property_id: visit1.property_id,
    service_address_line1: visit1.service_address_line1,
    service_address_line2: visit1.service_address_line2,
    service_address_city: visit1.service_address_city,
    service_address_zip: visit1.service_address_zip,
  };
}

// The start visit 2 of a call takes (CALL FOLLOW-UP FREE HOUR, header):
// `start` (the planned HH:MM) unless the gate is on, the call set no time,
// it is no package visit, and another stop holds that hour on `date` — then
// the nearest free whole hour that day, or `start` when none is free. The
// reads run in their own savepoint of the caller's transaction, so a failed
// read keeps `start` and never aborts the booking. Never throws.
async function callFollowUpStart(conn, { visit1, customerId, defaultTechnicianId = null, date, start }, { hourStated = false, packageVisit = false } = {}) {
  const day = toDateStr(date);
  if (!gateEnvValue(CALL_FOLLOWUP_GATE) || hourStated || packageVisit || !day || !/^\d{2}:\d{2}$/.test(String(start))) return start;
  const logger = require('../logger');
  const at = (hhmm) => callFollowUpRow({ visit1, customerId, defaultTechnicianId, date: day }, hhmm);
  try {
    return await conn.transaction(async (sp) => {
      if (!await hourTaken(sp, at(start), day)) return start;
      for (const free of freeHourCandidates(start)) {
        if (!await hourTaken(sp, at(free), day)) {
          logger.info(`[plan-taken-hour] call follow-up on ${day}: ${start} is taken — ${free} instead`);
          return free;
        }
      }
      logger.warn(`[plan-taken-hour] call follow-up on ${day}: ${start} is taken and no whole hour that day is free — keeping ${start}`);
      return start;
    });
  } catch (err) {
    logger.warn(`[plan-taken-hour] call follow-up free-hour check failed (${err.message}); keeping ${start}`);
    return start;
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
  takenHourHandoff, handOffTakenHours, callFollowUpStart,
};
