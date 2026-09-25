/**
 * Owner planning minutes (2026-09-25): how long a stop is expected to keep
 * the technician on site, for every route simulation — the booking picker,
 * the nightly reorder pass and the route-quality measurements all read it
 * through route-reorder-window-fit.js's workDuration, so the two sides of
 * scheduling plan the same day. Live only with GATE_SCHEDULING_CAPACITY.
 *
 * "The full hour is wrong": a one-hour arrival window is a promise about when
 * the truck arrives, not how long the work takes. Rows this table does not
 * name (tree & shrub, mosquito, bed bug, fumigation, general and combined
 * pest+lawn rows) return null and keep the legacy window/estimate rule.
 *
 * It plans the stops ALREADY on a route. The visit being placed keeps the
 * allowance its caller resolved (booking funnel, estimate profile, re-service
 * catalog) — arrival-route.js marks it `planning_exempt`.
 *
 * Live on the persisted `preserveCapacity` path too, not just the live gate:
 * a reservation_policy_version===2 hold accepted while GATE_SCHEDULING_CAPACITY
 * is rolled back still commits through prepareReservationCommit's
 * preserveCapacity option (slot-reservation.js), and must keep the SAME
 * planning minutes it was offered under — arrival-route.js stamps
 * `preserveCapacity` onto every row it hands to workDuration for exactly
 * this (Codex r1 P0).
 */
const { capacityEnabled } = require('./policy');

const PLANNING_MINUTES = Object.freeze({
  oneTimePest: 45,
  recurringPest: 25,
  recurringLawn: 20,
  reService: 15,
  assessment: 30,
  rodentTermite: 30,
});

// The legacy default charge. A stored estimate above it is a real long job
// (e.g. pest + termite bait at 120) and is never planned shorter.
const LEGACY_DEFAULT_MINUTES = 60;

const CADENCE = /quarterly|monthly|weekly|annual|every \d+ (weeks?|months?)/;
const ONE_TIME = /one[- ]?time/;

function isRecurring(stop, name) {
  if (ONE_TIME.test(name)) return false;
  return stop.is_recurring === true || CADENCE.test(name);
}

function tableMinutes(stop) {
  const name = String(stop.service_type || '').toLowerCase();
  if (stop.is_callback === true || /re-?service|callback/.test(name)) return PLANNING_MINUTES.reService;
  if (/assessment|inspection/.test(name)) return PLANNING_MINUTES.assessment;
  if (/rodent|termite/.test(name)) return PLANNING_MINUTES.rodentTermite;
  const pest = /pest/.test(name);
  const lawn = /lawn|turf/.test(name);
  if (pest && lawn) return null;
  if (pest) return isRecurring(stop, name) ? PLANNING_MINUTES.recurringPest : PLANNING_MINUTES.oneTimePest;
  if (lawn && isRecurring(stop, name)) return PLANNING_MINUTES.recurringLawn;
  return null;
}

function deliberateEstimate(stop) {
  // window_end is duration-driven (AGENTS.md), so a stored estimate above the
  // legacy default is real work whether or not it matches the window span.
  // A wide window carrying the default estimate still plans at the table:
  // the span alone is never charged as work.
  const estimate = Number(stop.estimated_duration_minutes) || 0;
  return estimate > LEGACY_DEFAULT_MINUTES ? estimate : 0;
}

/** Planned on-site minutes for one scheduled_services row, or null when the
 *  gate is off, the row is the visit being placed, or the table does not name
 *  its service. A capacity route group (arrival-route.js groupRouteStops —
 *  every stop, grouped or alone) already carries the sum of its members'
 *  planned minutes; its window span must not inflate that back to an hour. */
function plannedWorkMinutes(stop) {
  if (!stop || stop.planning_exempt) return null;
  if (!capacityEnabled() && !stop.preserveCapacity) return null;
  if (stop.memberIds) return Number(stop.estimated_duration_minutes) || null;
  const planned = tableMinutes(stop);
  return planned == null ? null : Math.max(planned, deliberateEstimate(stop));
}

module.exports = { PLANNING_MINUTES, plannedWorkMinutes };
