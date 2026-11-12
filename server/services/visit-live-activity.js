/**
 * Visit day on the Lock Screen: the card's rules
 * (GATE_VISIT_LIVE_ACTIVITY, owner 2026-11-11, "do this first Visit day on the Lock Screen").
 *
 * The card is a picture of the visit, not a message queue. Whatever looks at a visit decides from these
 * rules what its card must show now, so a lost signal only delays the card: the next look repairs it.
 *
 * A STOP is the customer, the saved address, the ET day and the technician: the rule the on-the-way text
 * already uses (one-text-per-day.js), so two services at one address on one day share one card. A visit with
 * no saved address is its own stop.
 *
 * This file holds the rules, all pure: which stop a visit belongs to, what a stop shows, when a card may
 * start, and what a live card must do next. Nothing calls them yet. A card's memory is its
 * live_activity_sessions row (see that migration).
 */
const gates = require('../config/feature-gates');

const MINUTE = 60 * 1000;
// A card starts only within this long of the step it starts in. Later, the news is old.
const START_WINDOW_MS = 20 * MINUTE;
// Production, 90 days to 2026-11-11 (432 completed visits): on the way p99 28 min, longest 54 min; on the
// property p95 96 min, 3% over 2 hours, 2% over 3 hours (mostly visits closed out late).
// After STALE the card reads as out of date; after END the server takes it off the Lock Screen.
const STALE_AFTER_MS = { en_route: 45 * MINUTE, on_property: 120 * MINUTE };
const END_AFTER_MS = { en_route: 90 * MINUTE, on_property: 180 * MINUTE };
// "Service complete" stays on the Lock Screen this long.
const COMPLETE_SHOWN_MS = 15 * MINUTE;
const LIVE_STATES = ['en_route', 'on_property'];

// VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST only ever narrows the gate (the first production test).
function customerAllowed(customerId) {
  const allow = typeof gates.visitLiveActivityAllowlist === 'function' ? gates.visitLiveActivityAllowlist() : null;
  return !allow || allow.has(String(customerId).toLowerCase());
}

function times(visits, column) {
  return visits.map((v) => (v[column] ? new Date(v[column]).getTime() : NaN)).filter(Number.isFinite);
}

function earliest(visits, column) {
  const all = times(visits, column);
  return all.length ? new Date(Math.min(...all)) : null;
}

function latest(visits, column) {
  const all = times(visits, column);
  return all.length ? new Date(Math.max(...all)) : null;
}

// The customer-facing tracker state: the ONE derivation (track-transitions.js), required on use.
function trackState(visit) {
  return require('./track-transitions').customerTrackState(visit);
}

/** Pure: the stop a visit belongs to. `visit.day` is its ET calendar day (YYYY-MM-DD). */
function stopOf(visit) {
  const stop = {
    customerId: visit.customer_id,
    propertyId: visit.property_id || null,
    technicianId: visit.technician_id || null,
    day: visit.day,
    serviceId: visit.id,
  };
  stop.key = stop.propertyId
    ? `stop:${stop.customerId}:${stop.propertyId}:${stop.day}:${stop.technicianId || 'none'}`
    : `visit:${visit.id}`;
  return stop;
}

/**
 * Pure: what a stop shows now, or null when no visit of it is live.
 *   { phase: 'en_route' | 'on_property' | 'complete', visits, since }
 * `memberIds` are the visits a card already showed. A finished visit counts only when it is one of them, so a
 * morning visit that is long finished never makes an afternoon visit at the same address read as arrived.
 * One visit finished while another is still open reads as "arrived": the technician is at the address.
 */
function viewOf(visits, memberIds = []) {
  const members = new Set((memberIds || []).map(String));
  const live = visits.filter((v) => LIVE_STATES.includes(trackState(v)));
  const done = visits.filter((v) => trackState(v) === 'complete' && members.has(String(v.id)));
  if (!live.length) {
    return done.length ? { phase: 'complete', visits: done, since: latest(done, 'completed_at') } : null;
  }
  const shown = visits.filter((v) => live.includes(v) || done.includes(v));
  if (done.length || live.some((v) => trackState(v) === 'on_property')) {
    return { phase: 'on_property', visits: shown, since: earliest(shown, 'arrived_at') };
  }
  return { phase: 'en_route', visits: shown, since: earliest(live, 'en_route_at') };
}

/**
 * Pure: what to do with a live card (`session` is its live_activity_sessions row).
 *   { kind: 'show', since, staleAt }      keep it current
 *   { kind: 'end', reason, dismissAt }    end it; dismissAt is when it leaves the Lock Screen
 */
function targetOf(view, session, now, { live = true, allowed = true } = {}) {
  const endNow = (reason) => ({ kind: 'end', reason, dismissAt: now });
  if (!live) return endNow('gate_off');
  if (!allowed) return endNow('not_on_the_list');
  if (!view) return endNow('visit_not_live');
  if (view.phase === 'complete') {
    return { kind: 'end', reason: 'complete', dismissAt: new Date(now.getTime() + COMPLETE_SHOWN_MS) };
  }
  // A step with no time of its own keeps the time the card already holds for that step.
  const since = new Date(view.since
    || (session.phase === view.phase && session.phase_since)
    || session.started_at || session.created_at);
  if (now.getTime() - since.getTime() >= END_AFTER_MS[view.phase]) return endNow('time_limit');
  return { kind: 'show', since, staleAt: new Date(since.getTime() + STALE_AFTER_MS[view.phase]) };
}

/** Pure: why a card may not start for this view (null = it may). The checks that need no read. */
function startRefusal(stop, view, now) {
  if (!view || !LIVE_STATES.includes(view.phase)) return 'visit_not_live';
  if (!view.since) return 'no_step_time';
  if (now.getTime() - view.since.getTime() > START_WINDOW_MS) return 'too_late';
  if (!customerAllowed(stop.customerId)) return 'not_on_the_list';
  return null;
}

module.exports = {
  stopOf,
  viewOf,
  targetOf,
  startRefusal,
  START_WINDOW_MS,
  STALE_AFTER_MS,
  END_AFTER_MS,
  COMPLETE_SHOWN_MS,
};
