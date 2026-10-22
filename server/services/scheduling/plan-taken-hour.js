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
 * hour — tech-blind until the schedule is technician-scoped, with the
 * writer's own statuses (rebooker.js probeMoveConflicts: no cancelled,
 * skipped, no-show or rescheduled row, nor a completed one) and the owner's
 * booked interviews (occupancy.js includeInterviews: a failed interview read
 * throws, as on every writer that reads them). The same
 * customer at the same place is one stop with the new visit, not a conflict
 * (samePlaceIds, measured from the plan's stored parent row); the same
 * customer at another property, or at a place that cannot be read, is a
 * conflict (Codex #6476 r1). Probe-only, no lock, like every plan-writer
 * probe; a same-instant booking can still overlap, and the night tool's
 * conflict read catches that one.
 *
 * Only from HANDOFF_MIN_DAYS_OUT days ahead: the night tool never moves a
 * visit inside its 73-hour freeze, so a nearer visit keeps its hour and the
 * double booking reaches a person through the needs-a-person notice, as
 * before. The completion-time extend is unchanged (it skips a clashing date).
 */
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { toDateStr } = require('../auto-dispatch/dates');
const { seriesCandidateDateClashRows } = require('./window-rules');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');

const GATE = 'GATE_PLAN_TAKEN_HOUR_HANDOFF';
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

// The columns a hand-off writes. The legacy presentation fields go too:
// customer-facing context and route reorder fall back to window_display, then
// time_window, when window_start is null (rebooker.js, deferred occurrence),
// so a copied one would keep promising the taken hour.
function handoffFields(date) {
  return {
    window_start: null,
    window_end: null,
    time_window: null,
    window_display: null,
    route_order: null,
    recurring_dispatch_due_date: toDateStr(date),
  };
}

// Whether `row` (a new plan visit: customer, technician, date, window) would
// land on an hour another stop holds, and is far enough out for the night
// tool to place it. `placeId` is the stored row whose place the new visit
// shares (its plan's parent; a follow-up row names it as
// recurring_parent_id). False with the gate off, without a window, or inside
// HANDOFF_MIN_DAYS_OUT — nothing is read then.
async function takenHourHandoff(conn, row, { date = row?.scheduled_date, now = new Date(), placeId = row?.recurring_parent_id || null } = {}) {
  if (!handoffEnabled() || !row || !row.window_start) return false;
  const day = toDateStr(date);
  if (!day || day < firstHandoffDate(now)) return false;
  const clash = await seriesCandidateDateClashRows(conn, row, day, {
    technicianId: row.technician_id || null,
    excludeStatuses: TAKEN_EXCLUDE_STATUSES,
    includeInterviews: true,
  });
  if (!clash.length) return false;
  const samePlace = placeId && row.customer_id
    ? await require('../auto-dispatch/current-conflict').samePlaceIds(conn, { id: placeId, customer_id: row.customer_id }, clash)
    : new Set();
  return clash.some((r) => !samePlace.has(String(r.id)));
}

// The seeder's batch: each row whose hour is taken comes back handed off.
// Returns { rows, handedOff }; the input array is not changed.
async function handOffTakenHours(conn, rows, { now = new Date() } = {}) {
  if (!handoffEnabled() || !Array.isArray(rows) || !rows.length) return { rows, handedOff: 0 };
  const out = [];
  let handedOff = 0;
  for (const row of rows) {
    if (await takenHourHandoff(conn, row, { now })) {
      out.push({ ...row, ...handoffFields(row.scheduled_date) });
      handedOff += 1;
    } else {
      out.push(row);
    }
  }
  return { rows: out, handedOff };
}

module.exports = {
  GATE, HANDOFF_MIN_DAYS_OUT, TAKEN_EXCLUDE_STATUSES, handoffEnabled, firstHandoffDate, handoffFields, takenHourHandoff, handOffTakenHours,
};
