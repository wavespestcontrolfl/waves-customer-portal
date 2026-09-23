/**
 * Customer-facing offer grid — the ONE hour list and day-end bound every
 * customer offer surface (the estimate slot picker, /book, public reschedule,
 * public re-service) builds its offers from, and the ONE gate for whether
 * the midday lunch block still removes noon from those offers.
 *
 * Before this module the hourly grid was duplicated byte-for-byte in two
 * places — PREFERRED_WINDOWS in estimate-slot-availability.js and
 * OPEN_DAY_WINDOWS in routes/booking.js — so a grid change could update one
 * copy and silently miss the other. Both now import CUSTOMER_HOUR_GRID from
 * here.
 *
 * Grid (owner ruling 2026-09-23): adds 12:00 PM and 5:00 PM to the prior
 * 09:00–16:00 hourly set. A 5:00 PM start with the standard 60-minute visit
 * ends at 6:00 PM, so CUSTOMER_DAY_END_MINUTES (the customer-facing service
 * day close) moves from 17:00 to 18:00 alongside it — offer/commit parity:
 * a slot that is offered must also be reservable.
 *
 * Staff/optimizer surfaces are deliberately UNCHANGED and do not import this
 * module: admin-schedule-find-time.js and intelligence-bar/schedule-tools.js
 * keep find-time.js's own DAY_END_HOUR default (17), auto-dispatch's
 * candidate-slots.js keeps its own local DAY_CLOSE (17:00), and the admin
 * window-rules.js day bound (20:00) is unrelated. See the picker-windows PR 2
 * report for the full per-site decision.
 */
const { gateEnvValue } = require('../../config/feature-gates');

// Single source for every customer-facing hourly offer surface.
const CUSTOMER_HOUR_GRID = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

// A 17:00 start plus the standard 60-minute visit ends at 18:00 — the
// customer-facing service day close.
const CUSTOMER_DAY_END_HOUR = 18;
const CUSTOMER_DAY_END_MINUTES = CUSTOMER_DAY_END_HOUR * 60;

// The lunch window the gate reserves when it's on. Fixed (not read from
// booking_config.lunch_start/_end): estimate-slot-availability.js and
// slot-reservation.js have no booking_config dependency at all — this is a
// separate, DB-free customer offer engine.
const CUSTOMER_LUNCH_START_MINUTES = 12 * 60;
const CUSTOMER_LUNCH_END_MINUTES = 13 * 60;

/**
 * Lunch block (GATE_BOOKING_LUNCH_BLOCK, owner ruling 2026-09-23). Unset
 * (default) means the 12:00–13:00 window is a normal offerable and
 * reservable hour on every customer-facing surface; 'true' restores the
 * prior behavior (noon reserved for route health, never offered or
 * self-bookable). Read at CALL time — never cache the resolved value — so a
 * flip needs no redeploy, matching every other scheduling gate
 * (scheduling/travel-gap.js, scheduling/policy.js).
 */
function lunchBlockEnabled() {
  return gateEnvValue('GATE_BOOKING_LUNCH_BLOCK');
}

/**
 * The hour grid a synthetic (non-route-derived) offer builder should
 * enumerate — CUSTOMER_HOUR_GRID minus noon while the lunch gate is on.
 * Read at CALL time, like the gate itself: never memoize this array.
 */
function customerOfferGrid() {
  return lunchBlockEnabled() ? CUSTOMER_HOUR_GRID.filter((t) => t !== '12:00') : CUSTOMER_HOUR_GRID;
}

/**
 * Whether a [startMin, endMin) window overlaps the lunch block — false
 * outright when the gate is off, so every caller can use this unconditionally
 * as its one lunch predicate instead of separately checking the gate.
 */
function overlapsLunch(startMin, endMin) {
  return lunchBlockEnabled() && Number.isFinite(startMin) && Number.isFinite(endMin)
    && startMin < CUSTOMER_LUNCH_END_MINUTES && endMin > CUSTOMER_LUNCH_START_MINUTES;
}

module.exports = {
  CUSTOMER_HOUR_GRID,
  CUSTOMER_DAY_END_HOUR,
  CUSTOMER_DAY_END_MINUTES,
  CUSTOMER_LUNCH_START_MINUTES,
  CUSTOMER_LUNCH_END_MINUTES,
  lunchBlockEnabled,
  customerOfferGrid,
  overlapsLunch,
};
