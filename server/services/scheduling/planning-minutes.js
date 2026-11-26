/**
 * Owner planning minutes (2026-09-25; recurring pest and lawn 35 minutes
 * from 2026-10-30): how long a stop is expected to keep
 * the technician on site, for every route simulation — the booking picker,
 * the nightly reorder pass and the route-quality measurements all read it
 * through route-reorder-window-fit.js's workDuration, so the two sides of
 * scheduling plan the same day. Live with GATE_SCHEDULING_CAPACITY=true
 * (capacity mode) and with GATE_SCHEDULING_CAPACITY=plan (plan-only mode,
 * owner 2026-11-01: these minutes alone, with the one-hour slots, the 8 PM
 * day end and every other hour-mode rule kept; planningTableLive below).
 *
 * "The full hour is wrong": a one-hour arrival window is a promise about when
 * the truck arrives, not how long the work takes. Since 2026-11-26 the table
 * names every routine service (owner per-service table). Rows it does not
 * name (sized jobs such as exclusion, sanitation, bed bug, liquid termite and
 * lawn renovation; combined pest+lawn rows; unnamed services) return null and
 * keep the legacy window/estimate rule.
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
const { schedulingPlanMinutesOnly } = require('../../config/feature-gates');

const PLANNING_MINUTES = Object.freeze({
  oneTimePest: 45,
  // Owner 2026-10-30: truck GPS parked median 32.6 min (2026-08-27..10-25),
  // app taps 50.6, drive 21.9 per stop. Was 25 and 20 (2026-09-25).
  recurringPest: 35,
  // Owner 2026-11-26 per-service table (decision page Euv3tg228Jh7zMitXN1gSx,
  // "do this"): Massey SPP 402 plans monthly 20 / bi-monthly 30 /
  // quarterly 36; truck GPS Aug 27-Nov 24 monthly pest 24 (n13).
  biMonthlyPest: 30,
  monthlyPest: 25,
  // Owner 2026-11-26: "these should be the same" (6-week and monthly lawn), 25.
  recurringLawn: 25,
  lawnRound: 25,
  // Owner 2026-11-26: lawn re-service, fire ant, insect spot, weed control and
  // soil test are 15 ("usually its for weeds, so spot treatment").
  lawnSpot: 15,
  // Owner 2026-11-26: pest re-service stays 15.
  reService: 15,
  assessment: 30,
  wdoInspection: 45,
  rodentTermite: 30,
  rodentTrapping: 45,
  rodentCheck: 20,
  termiteTreatment: 45,
  // Owner 2026-11-26: roach treatment 45 at most; plan 40 (German roach 45).
  cockroach: 40,
  germanRoach: 45,
  smallPestJob: 30,
  stingingInsect: 30,
  fleaTick: 45,
  mosquito: 30,
  treeShrub: 30,
});

// Capacity mode plans the table, and so does plan-only mode
// (GATE_SCHEDULING_CAPACITY=plan): the 2026-11-01 back-test of Adam's
// 30 days against truck GPS arrivals put the table's arrival error at p50
// 26.5 / p90 63.8 min against 41.0 / 127.6 for the whole hour, which called
// 48 on-time stops late. Plan-only mode changes the minutes and nothing
// else: capacityEnabled() stays false for it.
function planningTableLive() {
  return capacityEnabled() || schedulingPlanMinutesOnly();
}

// The legacy default charge. A stored estimate above it is a real long job
// (e.g. pest + termite bait at 120) and is never planned shorter.
const LEGACY_DEFAULT_MINUTES = 60;

const CADENCE = /quarterly|monthly|weekly|annual|every \d+ (weeks?|months?)|every other month/;
const ONE_TIME = /one[- ]?time/;

function isRecurring(stop, name) {
  if (ONE_TIME.test(name)) return false;
  return stop.is_recurring === true || CADENCE.test(name);
}

// Sized jobs (owner 2026-11-26: "big jobs use the minutes written on the
// job"): the table names none of them, so they keep the legacy
// window/estimate rule, and a stored estimate above the hour is always kept.
const SIZED_JOB = /exclusion|sanitation|wire mesh|roof[- ]entry|bird box|wildlife|bed ?bug|fumigat|trench|liquid|bora[- ]?care|pre[- ]?treat|installation|install\b|setup|set-up|dethatch|aerat|renovat|overseed|plugging|top dressing|sod\b|misting|guarantee|membership/;
const LAWN_SPOT = /fire ant|insect spot|spot treatment|weed|soil test|pre-?emergent/;

function pestMinutes(stop, name) {
  if (/vehicle|web sweep/.test(name)) return PLANNING_MINUTES.smallPestJob;
  if (/german (cock)?roach/.test(name)) return PLANNING_MINUTES.germanRoach;
  if (/roach/.test(name)) return PLANNING_MINUTES.cockroach;
  if (!isRecurring(stop, name)) return PLANNING_MINUTES.oneTimePest;
  if (/bi-?monthly|every other month|every 2 months/.test(name)) return PLANNING_MINUTES.biMonthlyPest;
  if (/monthly/.test(name)) return PLANNING_MINUTES.monthlyPest;
  return PLANNING_MINUTES.recurringPest;
}

function rodentTermiteMinutes(name) {
  if (/wdo/.test(name)) return PLANNING_MINUTES.wdoInspection;
  if (/inspection|assessment/.test(name)) return PLANNING_MINUTES.assessment;
  if (/rodent/.test(name)) {
    if (/follow[- ]?up|trap check|trap[- ]only|retainer|bait station/.test(name)) return PLANNING_MINUTES.rodentCheck;
    if (/trapping/.test(name)) return PLANNING_MINUTES.rodentTrapping;
    return PLANNING_MINUTES.rodentTermite;
  }
  if (/spot|foam/.test(name)) return PLANNING_MINUTES.termiteTreatment;
  return PLANNING_MINUTES.rodentTermite;
}

function specialtyMinutes(stop, name) {
  if (/mosquito/.test(name)) return PLANNING_MINUTES.mosquito;
  if (/tree|shrub|\bpalms?\b/.test(name)) return PLANNING_MINUTES.treeShrub;
  if (/\bbees?\b|wasp|hornet|yellow ?jacket|mud dauber|stinging insect/.test(name)) return PLANNING_MINUTES.stingingInsect;
  if (/flea|tick/.test(name)) return PLANNING_MINUTES.fleaTick;
  if (/roach|web sweep/.test(name)) return pestMinutes(stop, name);
  if (/trap[- ]only|trap check/.test(name)) return PLANNING_MINUTES.rodentCheck;
  return null;
}

function tableMinutes(stop) {
  const name = String(stop.service_type || '').toLowerCase();
  // A joined label ("Quarterly Lawn Care Service + Flea Control Service")
  // holds several services: no single row fits it.
  if (/\s\+\s/.test(name)) return null;
  // A rodent trap check is flagged is_callback by the scheduler; it still
  // plans the trap-check row, not the 15-minute re-service.
  if (/rodent/.test(name) && /follow[- ]?up|trap check/.test(name)) return PLANNING_MINUTES.rodentCheck;
  if (stop.is_callback === true || /re-?service|callback/.test(name)) {
    return /lawn|turf/.test(name) ? PLANNING_MINUTES.lawnSpot : PLANNING_MINUTES.reService;
  }
  if (SIZED_JOB.test(name)) return null;
  if (/wdo|rodent|termite|foam/.test(name)) return rodentTermiteMinutes(name);
  if (/assessment|inspection/.test(name)) return PLANNING_MINUTES.assessment;
  const pest = /pest/.test(name);
  const lawn = /lawn|turf/.test(name);
  // A label that names two programs (pest + lawn, lawn + tree & shrub,
  // pest + mosquito) is a combined visit: no single row fits it.
  const programs = [pest, lawn, /tree|shrub|\bpalms?\b/.test(name), /mosquito/.test(name)].filter(Boolean).length;
  if (programs > 1) return null;
  if (LAWN_SPOT.test(name) && !/fertiliz/.test(name)) return PLANNING_MINUTES.lawnSpot;
  if (lawn) return isRecurring(stop, name) ? PLANNING_MINUTES.recurringLawn : PLANNING_MINUTES.lawnRound;
  const special = specialtyMinutes(stop, name);
  if (special != null) return special;
  if (pest) return pestMinutes(stop, name);
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
  // The row's own flag first: the night search stamps preserveCapacity on
  // every stop of every simulation step (arrival-route.js), and the gate read
  // behind planningTableLive is two process.env reads. In plan mode that read
  // was 4.5 of the 5.4 CPU-seconds the mode added to a 46-visit sample of the
  // 04:10 run (Nov 2 2026, the night the move checks ran out of time).
  if (!stop.preserveCapacity && !planningTableLive()) return null;
  if (stop.memberIds) return Number(stop.estimated_duration_minutes) || null;
  const planned = tableMinutes(stop);
  if (planned != null) return Math.max(planned, deliberateEstimate(stop));
  // A joined label ("Quarterly Pest + Termite Bait Station Service") names no
  // single row, but its stored long estimate is still real work (as before
  // the 2026-11-26 table, when its first program matched and kept it).
  return /\s\+\s/.test(String(stop.service_type || '')) && deliberateEstimate(stop) ? deliberateEstimate(stop) : null;
}

/** Planned minutes for the visit BEING PLACED, or null to keep its caller's
 *  allowance. The table applies when it names the visit's service and the
 *  allowance is the legacy hour or less — the same line deliberateEstimate
 *  draws for the stops on the route, so a visit never plans differently
 *  placed than it does once placed. A longer allowance is real work (add-on
 *  minutes, dead-rodent attic 90, pest + termite 120) and never shrinks.
 *  `combined_services` (find-time.js) marks a prospective visit that holds
 *  several services under one joined label, which names no single table row.
 *  Live in capacity or plan-only mode (planningTableLive), or on the
 *  persisted `preserveCapacity` path. */
function placedVisitMinutes(target, allowanceMinutes, { preserveCapacity = false } = {}) {
  if (!target || target.combined_services === true) return null;
  if (!planningTableLive() && !preserveCapacity) return null;
  const allowance = Number(allowanceMinutes);
  if (!(allowance > 0) || allowance > LEGACY_DEFAULT_MINUTES) return null;
  return tableMinutes(target);
}

/** Planned minutes for the NEW visit a customer books online (the estimate
 *  page, /book, a text booking), for the travel-gap credit the offer and its
 *  booking check share (expected-service-minutes.js `newVisit`; owner
 *  2026-11-09, picker audit option A): every service the table names plans
 *  at the one-time 45, whatever its plan's cadence. A first visit is a full
 *  first service; a "Quarterly" label would otherwise read the recurring 35.
 *  The service's FAMILY decides, never its cadence words: the estimate page's
 *  label ("Lawn Care (Every 6 weeks)", or a bare "Lawn Care"), a combined
 *  hold's mix key ('lawn_care') and the hold row's name must all read alike,
 *  or a booking check could refuse the hour its offer showed. So the name is
 *  probed as recurring (a one-time lawn visit, which the table does not
 *  name, stays on the catalog) with engine-key underscores read as spaces.
 *  Null keeps the catalog: the table not live, a service it does not name,
 *  or an allowance above the legacy hour (real long work never shrinks). */
function newVisitMinutes(name, allowanceMinutes) {
  if (!planningTableLive()) return null;
  const allowance = Number(allowanceMinutes);
  if (!(allowance > 0) || allowance > LEGACY_DEFAULT_MINUTES) return null;
  const family = String(name || '').replace(/_/g, ' ');
  if (tableMinutes({ service_type: family, is_recurring: true }) == null) return null;
  return Math.min(PLANNING_MINUTES.oneTimePest, allowance);
}

module.exports = { PLANNING_MINUTES, plannedWorkMinutes, placedVisitMinutes, newVisitMinutes, planningTableLive };
