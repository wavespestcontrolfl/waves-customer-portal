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
const db = require('../../models/db');

// Single source for every customer-facing hourly offer surface.
const CUSTOMER_HOUR_GRID = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

// A 17:00 start plus the standard 60-minute visit ends at 18:00 — the
// customer-facing service day close. Fixed FALLBACK only (matches
// booking_config.day_end's post-migration value) — see
// refreshCustomerBookingWindowConfig/currentDayEndMinutes below for the
// actual bound a caller should use.
const CUSTOMER_DAY_END_HOUR = 18;
const CUSTOMER_DAY_END_MINUTES = CUSTOMER_DAY_END_HOUR * 60;

// The lunch window the gate reserves when it's on. Fixed FALLBACK only
// (matches booking_config's own default) — see currentLunchInterval below
// for the actual interval a caller should use.
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

// ---------- one booking_config authority for the lunch interval + day end ----------
//
// Codex r1 P2s on #4663: booking.js (bookingSlotWindow) and the assistant's
// availability engine (services/availability.js) already read
// booking_config.lunch_start/_end and .day_end (falling back to the fixed
// constants above); estimate-slot-availability.js and slot-reservation.js
// used to read ONLY the fixed constants, so an owner who configures a
// different lunch interval or preserves a non-18:00 day_end override (the
// 20260923000001_booking_day_end_18 migration only touches a row that was
// exactly 17:00:00) got offer/commit disagreement between /book and the
// estimate picker. Both now read the same row through the cache below.
//
// The cache exists because overlapsLunch()/customerOfferGrid() and the
// day-end bound are called synchronously, deep inside per-slot loops
// (buildAsapCapacitySlotsForTechs, slotWindowFitsDay, slot-reservation's
// commit checks) — threading an awaited config read through every one of
// those call sites would be a much larger, riskier change than caching the
// one row a request needs. Callers await refreshCustomerBookingWindowConfig()
// ONCE at the top of an offer/commit entry point (getAvailableSlots,
// reserveSlot, commitReservation); every synchronous helper below then reads
// the cached value. A cache miss (nothing awaited yet, e.g. a caller added
// later that forgets to) or a read failure both fall back to the fixed
// constants — the same value booking_config normally holds post-migration —
// so this can only ever be MORE permissive/parity-preserving than the old
// fixed-constant behavior, never less available.
const CUSTOMER_CONFIG_TTL_MS = 60 * 1000;
let cachedBookingWindowConfig = null; // { lunchStartMinutes, lunchEndMinutes, dayEndMinutes, expiresAt }

function parseHHMMMinutes(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

async function refreshCustomerBookingWindowConfig() {
  if (cachedBookingWindowConfig && cachedBookingWindowConfig.expiresAt > Date.now()) return;
  let lunchStartMinutes = CUSTOMER_LUNCH_START_MINUTES;
  let lunchEndMinutes = CUSTOMER_LUNCH_END_MINUTES;
  let dayEndMinutes = CUSTOMER_DAY_END_MINUTES;
  try {
    const config = await db('booking_config').first('lunch_start', 'lunch_end', 'day_end');
    const parsedLunchStart = parseHHMMMinutes(config?.lunch_start);
    const parsedLunchEnd = parseHHMMMinutes(config?.lunch_end);
    const parsedDayEnd = parseHHMMMinutes(config?.day_end);
    if (parsedLunchStart != null) lunchStartMinutes = parsedLunchStart;
    if (parsedLunchEnd != null) lunchEndMinutes = parsedLunchEnd;
    if (parsedDayEnd != null) dayEndMinutes = parsedDayEnd;
  } catch {
    // Config unreadable (mocked test db, transient failure, …) — the fixed
    // constants above are exactly what booking_config holds in the normal
    // case, so this never blocks an offer.
  }
  cachedBookingWindowConfig = { lunchStartMinutes, lunchEndMinutes, dayEndMinutes, expiresAt: Date.now() + CUSTOMER_CONFIG_TTL_MS };
}

// Synchronous — reads whatever refreshCustomerBookingWindowConfig last
// cached (or the fixed constants before anything has been cached yet).
function currentLunchInterval() {
  return cachedBookingWindowConfig
    ? { startMinutes: cachedBookingWindowConfig.lunchStartMinutes, endMinutes: cachedBookingWindowConfig.lunchEndMinutes }
    : { startMinutes: CUSTOMER_LUNCH_START_MINUTES, endMinutes: CUSTOMER_LUNCH_END_MINUTES };
}

// Synchronous — the authoritative customer day-end bound (booking_config.day_end,
// falling back to CUSTOMER_DAY_END_MINUTES). Use this, not the fixed constant,
// for any actual admission check.
function currentDayEndMinutes() {
  return cachedBookingWindowConfig ? cachedBookingWindowConfig.dayEndMinutes : CUSTOMER_DAY_END_MINUTES;
}

/**
 * The hour grid a synthetic (non-route-derived) offer builder should
 * enumerate — CUSTOMER_HOUR_GRID minus any hour overlapping the lunch
 * interval while the lunch gate is on. Read at CALL time, like the gate
 * itself: never memoize this array.
 */
function customerOfferGrid() {
  if (!lunchBlockEnabled()) return CUSTOMER_HOUR_GRID;
  return CUSTOMER_HOUR_GRID.filter((t) => {
    const startMin = parseHHMMMinutes(t);
    return !overlapsLunch(startMin, startMin + 60);
  });
}

/**
 * Whether a [startMin, endMin) window overlaps the lunch block — false
 * outright when the gate is off, so every caller can use this unconditionally
 * as its one lunch predicate instead of separately checking the gate.
 */
function overlapsLunch(startMin, endMin) {
  if (!lunchBlockEnabled() || !Number.isFinite(startMin) || !Number.isFinite(endMin)) return false;
  const { startMinutes, endMinutes } = currentLunchInterval();
  return startMin < endMinutes && endMin > startMinutes;
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
  refreshCustomerBookingWindowConfig,
  currentLunchInterval,
  currentDayEndMinutes,
};
