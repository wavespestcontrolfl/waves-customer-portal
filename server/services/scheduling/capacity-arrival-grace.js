/**
 * Arrival grace in CAPACITY mode (Codex round 2 on #5310, GATE_SCHEDULING_CAPACITY
 * is live in production). Capacity mode's own occupancy model is
 * verifyArrivalCapacity's route simulation (arrival-route.js) — entirely
 * separate from travel-gap.js/occupancy.js's SQL-overlap model. That
 * simulation only enforces the FIXED 120-minute arrival promise
 * (effectiveWindowRange, route-reorder-window-fit.js) — it has no concept
 * of the narrower, owner-configured self-serve grace bound, so a signed
 * offer could reserve or commit with a real simulated arrival anywhere
 * between grace and the full 120 minutes, silently promising more lateness
 * than grace was meant to allow.
 *
 * enforceCapacityArrivalGrace re-checks the SAME `arrivalDelayMinutes` the
 * simulation already computed (findCapacitySlots' own arrival_delay_minutes
 * stamp, packCapacityEnds' own offer-side filter, and each capacity fit's
 * own field, are all this one value — never re-derived here). Grace 0/dark
 * is a no-op: capacity mode's existing 120-minute bound (via
 * `capacityFit`/`fit.feasible` itself) stays the ONLY bound, byte-identical
 * to before this check existed; this only ADDS a stricter refusal when
 * grace is actually configured for the candidate's own date (decision 2:
 * today is always strict, so grace is already 0 there and this never fires
 * for a same-day capacity commit).
 *
 * A small leaf module rather than living on travel-gap.js or arrival-route.js
 * directly (Codex round 3 on #5310): slot-reservation.js (the new-booking
 * commit path) and rebooker.js (the reschedule commit path) both need it,
 * and neither may require the other (rebooker.js requires slot-reservation
 * indirectly through call-reschedule-apply.js/appointment-reminders.js-style
 * webs elsewhere in the codebase) — a plain module that only reads
 * `capacityError` from arrival-route.js and `selfServeArrivalGraceMinutes`
 * from travel-gap.js (neither of which requires either commit-path module)
 * is free of any cycle risk for either caller.
 *
 * @param {{arrivalDelayMinutes?: number}|null} capacityFit — the fit object
 *   verifyArrivalCapacity returned for this attempt (null when capacity mode
 *   is off for this call — no-op).
 * @param {string} date — the TARGET date being committed (the reservation's
 *   own scheduled_date for a new booking, the destination date for a
 *   reschedule) — never the "today" the caller is running on. Same-day
 *   strict (decision 2) is enforced by selfServeArrivalGraceMinutes reading
 *   this date itself.
 * @throws the same capacityError('arrival_grace') shape (409 SLOT_UNAVAILABLE)
 *   every other capacity refusal in this codebase throws.
 */
const { capacityError } = require('./arrival-route');
const { selfServeArrivalGraceMinutes } = require('./travel-gap');

function enforceCapacityArrivalGrace(capacityFit, date) {
  if (!capacityFit) return;
  const grace = selfServeArrivalGraceMinutes({ date });
  if (grace <= 0) return;
  if (Number.isFinite(capacityFit.arrivalDelayMinutes) && capacityFit.arrivalDelayMinutes > grace) {
    throw capacityError('arrival_grace');
  }
}

module.exports = { enforceCapacityArrivalGrace };
