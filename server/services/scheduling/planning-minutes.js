/**
 * Owner planning minutes (2026-09-25; recurring pest and lawn 35 minutes
 * from 2026-10-30): how long a stop is expected to keep
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
 * It plans the stops ALREADY on a route, and (placedVisitMinutes, owner
 * 2026-10-30) the visit being placed when the table names its service and its
 * caller's allowance is the legacy hour or less, so an offer and the stops
 * behind it read one set of minutes. A placed visit the table does not name,
 * or one whose allowance is above the hour (add-on minutes, dead-rodent
 * attic, pest + termite), keeps the allowance its caller resolved (booking
 * funnel, estimate profile, re-service catalog) — arrival-route.js marks it
 * `planning_exempt`, and does so for every visit when planningMinutes is
 * false (the night arrival search). These are PLAN minutes only: every row
 * written keeps its one-hour window and estimate (owner 2026-09-25: "a
 * one-hour arrival window is a promise about when the truck arrives, not how
 * long the work takes").
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
  // Owner 2026-10-30: truck GPS parked median 32.6 min (2026-08-27..10-25),
  // app taps 50.6, drive 21.9 per stop. Was 25 and 20 (2026-09-25).
  recurringPest: 35,
  recurringLawn: 35,
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

/** Planned minutes for the visit BEING PLACED, or null to keep its caller's
 *  allowance. The table applies when it names the visit's service and the
 *  allowance is the legacy hour or less — the same line deliberateEstimate
 *  draws for the stops on the route, so a visit never plans differently
 *  placed than it does once placed. A longer allowance is real work (add-on
 *  minutes, dead-rodent attic 90, pest + termite 120) and never shrinks.
 *  `combined_services` (find-time.js) marks a prospective visit that holds
 *  several services under one joined label, which names no single table row.
 *  Live only in capacity mode, or on the persisted `preserveCapacity` path. */
function placedVisitMinutes(target, allowanceMinutes, { preserveCapacity = false } = {}) {
  if (!target || target.combined_services === true) return null;
  if (!capacityEnabled() && !preserveCapacity) return null;
  const allowance = Number(allowanceMinutes);
  if (!(allowance > 0) || allowance > LEGACY_DEFAULT_MINUTES) return null;
  return tableMinutes(target);
}

module.exports = { PLANNING_MINUTES, plannedWorkMinutes, placedVisitMinutes };
