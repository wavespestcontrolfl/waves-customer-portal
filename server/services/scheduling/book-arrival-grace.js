/**
 * Online-booking (/book) arrival grace — the ONE rule the /book offer and the
 * /book commit share (owner-approved 2026-09-29, GATE_BOOK_ARRIVAL_GRACE).
 *
 * Background. The estimate picker has kept a slot the strict drive+buffer
 * travel gap would drop whenever the day's whole-route arrival simulation
 * certifies the technician arrives within SELF_SERVE_ARRIVAL_GRACE_MINUTES of
 * the slot's start (scheduling/policy.js selfServeArrivalGraceMinutes; owner
 * ruling 2026-09-28). /book was left strict because its commit runs a strict
 * pre-verify travel probe (occupancy.js findConflictingVisits `travel`) BEFORE
 * verifyArrivalCapacity — a grace-kept offer would 409 SLOT_TAKEN. This module
 * closes that gap the other way round: the offer and that probe now apply the
 * SAME waiver, and the commit's verifyArrivalCapacity enforces the SAME grace
 * bound, so every offered slot commits and every slot the commit refuses is
 * not offered.
 *
 * The rule (identical to the estimate picker's, applied to EVERY neighbour):
 *   - A real window overlap is never waived (raw windows: the commit's own
 *     SQL overlap probe and travel-gap.js's realOverlap both keep refusing).
 *   - Only the travel BUFFER against the PREVIOUS stop may be waived — the
 *     candidate arriving late inside its own arrival window. The NEXT stop's
 *     side is never waived: the next customer's promised start is not this
 *     customer's to spend.
 *   - Only a previous stop the simulation actually routed THIS technician
 *     through (assigned to the same technician) is waivable: an unassigned
 *     blocker is a fixed overlap to the simulator with no drive modelled to it,
 *     and another technician's stop is on a different route.
 *   - A live estimate hold is never waived (it may evaporate) and EVERY live
 *     hold on the route must clear the strict gap before anything is waived.
 *   - The waiver needs grace > 0 and the simulation's own arrival delay for
 *     THIS slot <= grace (offer: slot.arrival_delay_minutes from find-time;
 *     commit: verifyArrivalCapacity's fit, via arrivalGraceMinutes).
 * Grace 0 (env unset, same-day pick, gate off) is exactly the strict rule.
 */
const { travelGapEnabled, travelGapConflicts, isHoldStop, violatesTravelGap } = require('./travel-gap');
const { capacityEnabled, selfServeArrivalGraceMinutes } = require('./policy');
const { bookArrivalGraceLive } = require('../../config/feature-gates');

function sameTech(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * The grace (minutes) a /book slot on `date` is offered/committed under:
 * 0 unless GATE_BOOK_ARRIVAL_GRACE and capacity mode are live and the
 * self-serve grace reads positive for that date. Callers separately require
 * the build/commit to be an insertion one (bookInsertionOffersLive()).
 */
function bookArrivalGraceMinutes({ date } = {}) {
  if (!bookArrivalGraceLive() || !capacityEnabled()) return 0;
  return selfServeArrivalGraceMinutes({ date });
}

/** True when the slot's simulated arrival delay is within `grace` — the
 * offer-side twin of arrival-route.js's arrivalExceedsGrace (commit). Grace
 * <= 0 imposes no bound (the 120-minute arrival promise stays the only one). */
function delayWithinGrace(arrivalDelayMinutes, grace) {
  if (!(grace > 0)) return true;
  return Number.isFinite(arrivalDelayMinutes) && arrivalDelayMinutes <= grace;
}

/**
 * Offer-side travel-gap verdict: true when the candidate is admitted.
 *   candidate: { startMin, endMin, lat, lng, windowMinutes, expectedMinutes }
 *   stops:     [{ startMin, endMin, lat, lng, windowMinutes, expectedMinutes,
 *                 hold, technician_id }]  (the day's stops for the candidate's
 *                 technician plus unassigned — tech-blind rows are the caller's
 *                 to filter exactly as the strict mirror does)
 *   ctx:       { technicianId, grace, arrivalDelayMinutes }
 * Gate-agnostic beyond travelGapEnabled(): with the travel-gap gate off there
 * is nothing to waive and everything is admitted (same as violatesTravelGap).
 */
function bookGapAdmits(candidate, stops, { technicianId, grace, arrivalDelayMinutes } = {}) {
  if (!travelGapEnabled()) return true;
  const conflicts = travelGapConflicts(candidate, stops);
  if (!conflicts.length) return true;
  if (!(grace > 0) || !delayWithinGrace(arrivalDelayMinutes, grace)) return false;
  const waivable = conflicts.every(({ stop, reason }) => reason === 'travel_gap'
    && !isHoldStop(stop)
    && stop.endMin <= candidate.startMin
    && sameTech(stop.technician_id, technicianId));
  if (!waivable) return false;
  // Every live hold on this route (or unassigned) must clear the STRICT gap:
  // a hold's window is a promise, not a fixed stop, and travelGapConflicts
  // only reports the hold that could become an immediate neighbour.
  return stops.every((stop) => !isHoldStop(stop)
    || !(stop.technician_id == null || sameTech(stop.technician_id, technicianId))
    || !violatesTravelGap(candidate, [stop]));
}

/**
 * Commit-side twin, over the rows findConflictingVisits({ travel }) returned
 * (unchanged, tech-blind): true when EVERY clash is a previous-side travel_gap
 * against a committed stop assigned to this technician — exactly the clashes
 * bookGapAdmits waives at offer time. A travel_gap row never overlaps the
 * candidate, so it sits before it iff it starts before the candidate does
 * (`candidateStartMin`, minutes from midnight).
 * The caller must ALSO run verifyArrivalCapacity with arrivalGraceMinutes =
 * the offer's grace (that is where the arrival-delay bound is enforced) and
 * must only call this when a prepared capacity proof exists.
 */
function bookClashesWaivable(clashes, { technicianId, grace, candidateStartMin } = {}) {
  if (!(grace > 0) || !Number.isFinite(candidateStartMin) || !Array.isArray(clashes) || !clashes.length) return false;
  return clashes.every((row) => {
    const startMin = timeToMin(row.window_start);
    return row.conflict_reason === 'travel_gap'
      && startMin != null && startMin < candidateStartMin
      && !(row.reservation_expires_at != null && row.customer_id == null)
      && sameTech(row.technician_id, technicianId);
  });
}

function timeToMin(value) {
  if (value == null || value === '') return null;
  const [h, m] = String(value).split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
}

module.exports = {
  bookArrivalGraceMinutes,
  delayWithinGrace,
  bookGapAdmits,
  bookClashesWaivable,
};
